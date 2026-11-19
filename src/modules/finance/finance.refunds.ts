// Finance refunds + credit notes (U12): request, SM review, finance adjust, approve chain (four-eyes by user id, executive
// above the limit or on a changed destination), credit note, allocation impact, execution and disbursement.
// Port of the refund half of src/mocks/handlers-finance-d.ts onto finance_records.
import { reversePartnerCommission } from "../partners/partners.reversal";
import { refundCaseStatus } from "../applications/refund-status";
import { ownUpload } from "../account/account.service";
import type { Tx as Exec } from "../../core/db/db";
import { splitVat } from "@/domain/money";
import {
  creditNoteLines,
  docTotals,
  exceedsRefundable,
  refundSuggestion,
  reversal,
} from "@/domain/finance/money";
import {
  canExecute,
  canSign,
  chainComplete,
  refundChain,
  sign,
} from "@/domain/finance/approvals";
import { canMove } from "@/domain/finance/states";
import type {
  Adjustment,
  Allocation,
  CreditNote,
  Invoice,
  PeriodLock,
  RefundMethod,
  RefundReason,
  RefundRequest,
  UserRef,
} from "@/domain/finance/types";
import type {
  CreditNoteDetail,
  ImpactRow,
  RefundDetail,
  RefundRow,
  RefundTab,
} from "./lib/views";
import {
  all,
  checkRev,
  fail,
  isExec,
  isFinanceUser,
  isSm,
  need,
  nextNo,
  nowIso,
  one,
  put,
  refOf,
  tail4,
  today,
  where,
  type Actor,
  type Fin,
} from "./finance.store";
import {
  addClientCredit,
  invOr404,
  invoiceByKey,
  plainInvoice,
  saveInv,
  type Inv,
} from "./finance.billing";
import { postCreditNote, postRefund } from "../ledger/ledger.postings";
import type { LedgerService } from "../ledger/ledger.service";

export type R = RefundRequest & {
  disburseClaimedAt?: string;
  eligiblePart?: number;
  passThroughRefunded?: number;
  note?: string;
  rejectReason?: string;
  adjustedBy?: UserRef;
  changedFrom?: number;
  updatedBy?: string;
  updatedAt?: string;
  execStartedAt?: string;
  failReason?: string;
  proofDocId?: string;
};
export const saveRefund = (db: Exec, r: R) =>
  put(db, "refund", r.no, r, r.invoiceNo);
const OPEN = [
  "requested",
  "under_review",
  "recommended",
  "awaiting_executive",
  "approved",
  "credited",
  "executing",
  "execution_failed",
];

/** Case status → refund policy key (spec RFD §12): no work 100%, assigned 90%, in progress 50%, internal review or
 *  with an external institution up to 25%, delivered 0 (a quality-dispute decision overrides through review/adjust). */
export const stageOf = (status?: string) => {
  const s = status ?? "completed_delivered";
  if (s === "approved_assigned") return "assigned";
  if (s === "in_progress") return "in_progress";
  if (s === "completed_delivered") return "completed";
  if (s === "awaiting_internal_review" || s === "awaiting_external_institution") return "submitted";
  return /^(received|under_review|awaiting_)/.test(s) ? "before_work" : "submitted";
};
/** Split a VAT-inclusive refund amount back into eligible part (+ pass-through when unspent). */
export function partsOf(
  inv: Invoice,
  amount: number,
  spent: boolean,
  vatBps: number,
) {
  const passThroughRefunded = spent
    ? 0
    : Math.min(amount, inv.totals.passThrough);
  return {
    eligiblePart: splitVat(amount - passThroughRefunded, vatBps).net,
    passThroughRefunded,
  };
}
const destChanged = (r: R) => !!r.destination?.changed;
const amountOf = (r: R) => r.approved ?? r.recommended ?? r.requested;
/** Money already paid back (or on its way) on an invoice/case, excluding refund `except`; credit refunds move no cash. */
async function cashRefunded(db: Exec, key: { invoiceNo?: string; caseRef?: string }, except: string) {
  const rs = await where<R>(db, "refund", { status: ["approved", "credited", "executing", "execution_failed", "refunded"] });
  return rs
    .filter((x) => x.no !== except && x.method !== "credit" && (key.invoiceNo ? x.invoiceNo === key.invoiceNo : x.caseRef === key.caseRef))
    .reduce((s, x) => s + amountOf(x), 0);
}
/** Credit-note refunds: ≤ invoice total − credits; money out also ≤ cash paid − earlier cash refunds. */
async function overRefund(db: Exec, r: R, method: RefundMethod, amount: number, inv: { totals: { total: number }; amountCredited: number; amountPaid: number }) {
  return (
    exceedsRefundable(amount, inv.totals.total, inv.amountCredited) ||
    (method !== "credit" && amount > inv.amountPaid - (await cashRefunded(db, { invoiceNo: r.invoiceNo }, r.no)))
  );
}
const tierOf = (r: R): RefundRow["tier"] =>
  r.chain.some((s) => s.role === "executive") ? "executive" : "finance";
const signCheck = (r: R, a: Actor) =>
  canSign(r.chain, a, [
    r.requestedBy.id,
    ...(r.adjustedBy ? [r.adjustedBy.id] : []),
  ]);
const awaitingFinance = (r: R) =>
  r.status === "recommended" || r.status === "awaiting_executive";
const mine = (r: R, a: Actor) => awaitingFinance(r) && signCheck(r, a).ok;
const touch = (f: Fin, r: R) => {
  r.rev++;
  r.updatedBy = f.me.name;
  r.updatedAt = nowIso();
};

function view(f: Fin, r: R, invs: Map<string, Inv>): RefundRow {
  const inv = invs.get(r.invoiceNo);
  return {
    ...(r as RefundRow),
    clientName: f.D.clientName(inv?.clientId ?? ""),
    tier: tierOf(r),
    mine: mine(r, f.me),
    eligiblePart: r.eligiblePart ?? 0,
    passThroughRefunded: r.passThroughRefunded ?? 0,
  };
}
async function invMap(db: Exec) {
  return new Map(
    (await all<Inv>(db, "invoice")).filter((i) => i.no).map((i) => [i.no!, i]),
  );
}
const TAB: Record<
  Exclude<RefundTab, "credit_notes" | "awaiting_me">,
  RefundRequest["status"][]
> = {
  requested: ["requested"],
  in_review: ["under_review"],
  awaiting_executive: ["awaiting_executive"],
  executing: ["approved", "credited", "executing", "execution_failed"],
  completed: ["refunded", "completed_as_credit"],
  rejected: ["rejected", "withdrawn"],
};
const inTab = (r: R, t: RefundTab, a: Actor) =>
  t === "awaiting_me"
    ? mine(r, a)
    : t === "credit_notes"
      ? false
      : TAB[t].includes(r.status);
async function locked(db: Exec) {
  return (await all<PeriodLock>(db, "period_lock")).some(
    (l) => l.day === today() && l.state === "closed",
  );
}
async function refundOr404(db: Exec, no: string) {
  const r = await one<R>(db, "refund", no, true);
  if (!r) throw fail(404, "not_found");
  return r;
}

async function impactOf(
  db: Exec,
  f: Fin,
  r: R,
  inv: Invoice,
): Promise<ImpactRow[]> {
  const al = (await all<Allocation>(db, "allocation")).find(
    (a) => a.caseRef === r.caseRef,
  );
  if (!al) return [];
  const full = amountOf(r) >= inv.totals.total;
  return al.shares.map((s) => {
    // Full refund before payout voids the allocation instead of adjusting it (plan U12 what-if).
    const voided = full && al.status !== "paid";
    const rev = voided
      ? -s.amount
      : Math.round(
          reversal(r.eligiblePart ?? 0, al.agentPct) * (s.pct / 10_000),
        );
    return {
      workerId: s.workerId,
      name: f.D.workerName(s.workerId),
      allocated: s.amount,
      reversal: rev,
      net: s.amount + rev,
      paidOut: al.status === "paid",
      voided,
    };
  });
}
async function issueCreditNote(
  f: Fin,
  r: R,
  inv: Inv,
  when: string,
): Promise<CreditNote> {
  const lines = creditNoteLines(
    {
      eligiblePart: r.eligiblePart ?? 0,
      passThrough: r.passThroughRefunded ?? 0,
    },
    `Credit · ${r.no}`,
  );
  const totals = docTotals(lines, f.S.vat_bps);
  const cn: CreditNote = {
    no: await nextNo(f.db, "CN"),
    invoiceNo: inv.no!,
    refundNo: r.no,
    lines,
    totals,
    eligible: totals.eligible,
    issuedBy: refOf(f.me),
    issuedAt: when,
  };
  await put(f.db, "credit_note", cn.no, cn, inv.no);
  inv.amountCredited += -totals.total;
  inv.status = "credited";
  inv.rev++;
  await saveInv(f.db, inv);
  await postCreditNote(f.deps.ledger,f.db, cn.no, totals, f.me.id);
  return cn;
}
/** Allocation side effects once approved (REV F-RFD-05, D-16 adjustments inherit the refund approval). */
async function applyImpact(f: Fin, r: R, inv: Invoice) {
  const al = (await all<Allocation>(f.db, "allocation")).find(
    (a) => a.caseRef === r.caseRef,
  );
  if (!al) return;
  const rows = await impactOf(f.db, f, r, inv);
  if (rows.some((x) => x.voided)) {
    const before = { status: al.status };
    al.status = "voided";
    await put(f.db, "allocation", al.id, al, al.caseRef);
    f.rec(
      "allocation.adjusted",
      "allocation",
      al.id,
      before,
      { status: al.status },
      r.no,
    );
    return;
  }
  for (const x of rows) {
    if (!x.reversal) continue;
    const adj: Adjustment & { chain: never[]; createdBy: UserRef; at: string } =
      {
        id: `adj-${r.no}-${x.workerId}`,
        workerId: x.workerId,
        allocationId: al.id,
        refundNo: r.no,
        amount: x.reversal,
        reason: "refund",
        note: r.no,
        status: "approved",
        chain: [],
        createdBy: refOf(f.me),
        at: nowIso(),
      };
    await put(f.db, "adjustment", adj.id, adj, x.workerId);
    f.rec(
      "allocation.adjusted",
      "allocation",
      al.id,
      { share: x.allocated },
      { reversal: x.reversal, refundNo: r.no },
      r.no,
    );
  }
}

// ---------------------------------------------------------------- reads
export async function listRefunds(f: Fin, q: { tab?: string; case?: string }) {
  const [refunds, invs, cns] = await Promise.all([
    all<R>(f.db, "refund"),
    invMap(f.db),
    all<CreditNote>(f.db, "credit_note"),
  ]);
  const tab = (q.tab ?? "awaiting_me") as RefundTab;
  const tabs: RefundTab[] = [
    "awaiting_me",
    "requested",
    "in_review",
    "awaiting_executive",
    "executing",
    "completed",
    "rejected",
  ];
  const counts = Object.fromEntries(
    tabs.map((t) => [t, refunds.filter((r) => inTab(r, t, f.me)).length]),
  ) as Record<RefundTab, number>;
  counts.credit_notes = cns.length;
  const items = (
    q.case
      ? refunds.filter((r) => r.caseRef === q.case)
      : refunds.filter((r) => inTab(r, tab, f.me))
  ).sort((x, y) => y.at.localeCompare(x.at));
  return { items: items.map((r) => view(f, r, invs)), counts };
}
export async function refundableInvoices(f: Fin) {
  const [invs, refunds] = await Promise.all([
    all<Inv>(f.db, "invoice"),
    all<R>(f.db, "refund"),
  ]);
  return {
    items: invs
      .filter(
        (i) =>
          i.no &&
          i.amountPaid > 0 &&
          i.totals.total - i.amountCredited > 0 &&
          !refunds.some(
            (r) =>
              r.invoiceNo === i.no &&
              ![
                "rejected",
                "withdrawn",
                "refunded",
                "completed_as_credit",
              ].includes(r.status),
          ),
      )
      .map((i) => ({
        no: i.no!,
        clientName: f.D.clientName(i.clientId),
        refundable: i.totals.total - i.amountCredited,
      })),
  };
}
async function detail(f: Fin, r: R): Promise<RefundDetail> {
  const inv = await invOr404(f.db, r.invoiceNo, false);
  const check = signCheck(r, f.me);
  const open = [
    "requested",
    "under_review",
    "recommended",
    "awaiting_executive",
  ].includes(r.status);
  const cns = await where<CreditNote>(f.db, "credit_note", { ref: inv.no! });
  const a = f.me;
  return {
    refund: view(f, r, new Map([[inv.no!, inv]])),
    invoice: plainInvoice(inv),
    policy: f.S.refundPolicy,
    refundable: inv.totals.total - inv.amountCredited,
    limit: f.S.refund_exec_limit,
    impact: await impactOf(f.db, f, r, inv),
    payer: { masked: tail4(f.D.client(inv.clientId)?.phone ?? "") },
    creditNote: cns.find((c) => c.refundNo === r.no) ?? null,
    locked: await locked(f.db),
    can: {
      sign: awaitingFinance(r) && check.ok,
      signReason: check.ok ? undefined : check.reason,
      execute:
        (r.status === "credited" || r.status === "execution_failed") &&
        canExecute(r.chain, a),
      adjust: isFinanceUser(a) && r.status === "recommended",
      reject:
        open &&
        (isFinanceUser(a) ||
          (isExec(a) && r.status === "awaiting_executive") ||
          (isSm(a) && r.status !== "recommended")),
      review:
        isSm(a) && (r.status === "requested" || r.status === "under_review"),
    },
  };
}
export async function getRefund(f: Fin, no: string) {
  const r = await one<R>(f.db, "refund", no);
  if (!r) throw fail(404, "not_found");
  return detail(f, r);
}
const rowOf = async (f: Fin, r: R) =>
  view(
    f,
    r,
    new Map([[r.invoiceNo, (await invoiceByKey(f.db, r.invoiceNo))!]]),
  );

// ---------------------------------------------------------------- writes
export async function requestRefund(
  f: Fin,
  b: { invoiceNo: string; reason: RefundReason; note: string },
) {
  const inv = await invoiceByKey(f.db, b.invoiceNo, true);
  if (!inv?.no || !inv.caseRef) throw fail(404, "not_found");
  need(b.reason && b.note?.trim(), 422, "reason_required");
  need(inv.amountPaid > 0, 422, "validation");
  const refunds = await where<R>(f.db, "refund", { ref: inv.no });
  if (refunds.some((r) => OPEN.includes(r.status)))
    throw fail(409, "refund_open");
  const stage =
    b.reason === "duplicate_payment"
      ? "duplicate"
      : stageOf(f.D.caseOf(inv.caseRef)?.status);
  const s = refundSuggestion(inv, stage, f.S.refundPolicy, true, f.S.vat_bps);
  const amount = Math.min(s.total, inv.totals.total - inv.amountCredited);
  const client = f.D.client(inv.clientId);
  const r: R = {
    no: await nextNo(f.db, "RFD"),
    caseRef: inv.caseRef,
    invoiceNo: inv.no,
    reason: b.reason,
    stage,
    requested: amount,
    method: "original",
    destination: { masked: tail4(client?.phone ?? ""), changed: false },
    status: "requested",
    chain: refundChain(amount, { execLimit: f.S.refund_exec_limit }),
    requestedBy: refOf(f.me),
    impact: [],
    at: nowIso(),
    rev: 1,
    eligiblePart: s.eligiblePart,
    passThroughRefunded: s.passThrough,
    note: b.note.trim(),
  };
  await saveRefund(f.db, r);
  await refundCaseStatus(f.db, r.caseRef, "requested", r.no);
  f.rec(
    "refund.requested",
    "refund",
    r.no,
    null,
    { amount, onBehalfOf: client?.name },
    b.note,
  );
  return rowOf(f, r);
}

/** SM recommendation (ops panel). Signs the first chain step. */
export async function reviewRefund(
  f: Fin,
  no: string,
  b: {
    decision: "recommend" | "reject";
    amount?: number;
    note: string;
    rev?: number;
  },
) {
  const r = await refundOr404(f.db, no);
  checkRev(r.rev, b.rev);
  if (r.status === "requested") r.status = "under_review";
  const to = b.decision === "reject" ? "rejected" : "recommended";
  need(canMove("refund", r.status, to), 409, "conflict");
  need(b.note?.trim(), 422, "reason_required");
  const before = { status: r.status, recommended: r.recommended };
  if (to === "recommended") {
    const inv = await invOr404(f.db, r.invoiceNo, false);
    const amount = Math.round(b.amount ?? r.requested);
    if (amount <= 0 || (await overRefund(f.db, r, r.method, amount, inv)))
      throw fail(422, "exceeds_refundable");
    r.recommended = amount;
    Object.assign(
      r,
      partsOf(inv, amount, (r.passThroughRefunded ?? 0) === 0, f.S.vat_bps),
    );
    r.chain = sign(
      refundChain(amount, {
        destinationChanged: destChanged(r),
        execLimit: f.S.refund_exec_limit,
      }),
      f.me,
      nowIso(),
    );
  } else r.rejectReason = b.note.trim();
  r.status = to;
  touch(f, r);
  await saveRefund(f.db, r);
  if (to === "rejected") await refundCaseStatus(f.db, r.caseRef, "declined", r.no);
  f.rec(
    `refund.${to}`,
    "refund",
    r.no,
    before,
    { status: r.status, recommended: r.recommended },
    b.note,
  );
  return rowOf(f, r);
}

/** Finance edits amount/method/destination → chain re-runs; the editor becomes a maker and can no longer sign. */
export async function adjustRefund(
  f: Fin,
  no: string,
  b: {
    amount: number;
    spent: boolean;
    method: RefundMethod;
    destination?: string;
    note: string;
    rev?: number;
  },
) {
  const r = await refundOr404(f.db, no);
  checkRev(r.rev, b.rev);
  need(r.status === "recommended", 409, "conflict");
  need(b.note?.trim(), 422, "reason_required");
  const inv = await invOr404(f.db, r.invoiceNo, false);
  const amount = Math.round(Number(b.amount));
  if (!(amount > 0) || (await overRefund(f.db, r, b.method, amount, inv)))
    throw fail(422, "exceeds_refundable");
  const before = {
    amount: r.recommended,
    method: r.method,
    destination: r.destination?.masked,
  };
  const dest = b.destination?.replace(/\D/g, "");
  need(!dest || dest.length >= 9, 422, "validation");
  if (r.recommended !== amount) r.changedFrom = r.changedFrom ?? r.recommended;
  r.recommended = amount;
  r.method = b.method;
  if (dest) r.destination = { masked: `•••• ${dest.slice(-4)}`, changed: true };
  Object.assign(r, partsOf(inv, amount, b.spent, f.S.vat_bps));
  // The SM recommendation stays; finance/executive signatures are cleared — an edited amount is a new decision.
  const fresh = refundChain(amount, {
    destinationChanged: destChanged(r),
    execLimit: f.S.refund_exec_limit,
  });
  r.chain = fresh.map((s, i) =>
    i === 0 && r.chain[0]?.signedBy ? r.chain[0] : s,
  );
  r.adjustedBy = refOf(f.me);
  r.note = b.note.trim();
  touch(f, r);
  await saveRefund(f.db, r);
  f.rec(
    "refund.adjusted",
    "refund",
    r.no,
    before,
    {
      amount,
      method: r.method,
      destination: r.destination?.masked,
      chain: r.chain.map((s) => s.role).join(" → "),
    },
    b.note,
  );
  return rowOf(f, r);
}

export async function approveRefund(f: Fin, no: string, b: { rev?: number }) {
  const r = await refundOr404(f.db, no);
  checkRev(r.rev, b.rev);
  need(awaitingFinance(r), 409, "conflict");
  if (await locked(f.db)) throw fail(409, "period_locked");
  const c = signCheck(r, f.me);
  if (!c.ok)
    throw fail(
      403,
      c.reason === "same_approver" ? "same_approver" : "forbidden",
    );
  const inv = await invOr404(f.db, r.invoiceNo);
  if (await overRefund(f.db, r, r.method, amountOf(r), inv))
    throw fail(422, "exceeds_refundable");
  const before = { status: r.status };
  const when = nowIso();
  r.chain = sign(r.chain, f.me, when);
  if (!chainComplete(r.chain)) {
    r.status = "awaiting_executive";
    touch(f, r);
    await saveRefund(f.db, r);
    f.rec("refund.needs_executive", "refund", r.no, before, {
      status: r.status,
    });
    return rowOf(f, r);
  }
  r.status = "approved";
  r.approved = amountOf(r);
  f.rec("refund.approved", "refund", r.no, before, {
    status: r.status,
    approved: r.approved,
  });
  const cn = await issueCreditNote(f, r, inv, when);
  r.creditNoteNo = cn.no;
  r.status = "credited";
  f.rec("credit_note.issued", "credit_note", cn.no, null, {
    total: cn.totals.total,
    refundNo: r.no,
  });
  await applyImpact(f, r, inv);
  if (r.method === "credit") {
    r.status = "completed_as_credit";
    await refundCaseStatus(f.db, r.caseRef, "refunded", r.no);
    await reversePartnerCommission(f.db, r.caseRef, r.approved ?? 0);
    await addClientCredit(f.db, inv.clientId, r.approved);
    await postRefund(
      f.deps.ledger,
      f.db,
      r.no,
      { amount: r.approved, method: "credit", asCredit: true },
      f.me.id,
    );
    f.rec(
      "refund.completed_as_credit",
      "refund",
      r.no,
      { status: "credited" },
      { status: r.status },
    );
  }
  touch(f, r);
  await saveRefund(f.db, r);
  return rowOf(f, r);
}

export async function rejectRefund(
  f: Fin,
  no: string,
  b: { reason: string; note?: string; rev?: number },
) {
  const r = await refundOr404(f.db, no);
  checkRev(r.rev, b.rev);
  need(
    ["requested", "under_review", "recommended", "awaiting_executive"].includes(
      r.status,
    ),
    409,
    "conflict",
  );
  need(b.reason, 422, "reason_required");
  // Executives reject only at their step; SMs only before the recommendation.
  need(
    isFinanceUser(f.me) ||
      (isExec(f.me) && r.status === "awaiting_executive") ||
      (isSm(f.me) &&
        r.status !== "recommended" &&
        r.status !== "awaiting_executive"),
    403,
    "forbidden",
  );
  const before = { status: r.status };
  r.status = "rejected";
  r.rejectReason = [b.reason, b.note].filter(Boolean).join(" · ");
  touch(f, r);
  await saveRefund(f.db, r);
  await refundCaseStatus(f.db, r.caseRef, "declined", r.no);
  f.rec(
    "refund.rejected",
    "refund",
    r.no,
    before,
    { status: r.status },
    r.rejectReason,
  );
  return rowOf(f, r);
}

/** The executor is a finance user who signed nothing; bank needs a proof, wallets go to the disbursement job. */
export async function executeRefund(
  f: Fin,
  no: string,
  b: { rev?: number; method?: RefundMethod; proofName?: string; proofUploadId?: string },
) {
  const up = b.proofUploadId ? await ownUpload(f.db, f.me.id, b.proofUploadId) : undefined;
  if (up) b = { ...b, proofName: up.name };
  const r = await refundOr404(f.db, no);
  checkRev(r.rev, b.rev);
  if (!canExecute(r.chain, f.me)) throw fail(403, "same_approver");
  need(
    r.status === "credited" || r.status === "execution_failed",
    409,
    "conflict",
  );
  need(b.method !== "credit", 422, "validation");
  need(b.method !== "bank" || b.proofName, 422, "validation");
  const before = { status: r.status, method: r.method };
  r.method = b.method ?? r.method;
  r.executedBy = refOf(f.me);
  if (r.method === "bank") {
    r.status = "refunded";
    r.proofDocId = up?.id ?? `doc-${b.proofName}`;
    r.failReason = undefined;
    await postRefund(
      f.deps.ledger,
      f.db,
      r.no,
      { amount: amountOf(r), method: "bank" },
      f.me.id,
    );
    await reversePartnerCommission(f.db, r.caseRef, amountOf(r));
    await refundCaseStatus(f.db, r.caseRef, "refunded", r.no);
    f.rec("refund.paid", "refund", r.no, before, {
      status: r.status,
      proof: b.proofName,
    });
  } else {
    r.status = "executing";
    r.execStartedAt = nowIso();
    r.failReason = undefined;
    f.rec("refund.executing", "refund", r.no, before, {
      status: r.status,
      method: r.method,
    });
  }
  touch(f, r);
  await saveRefund(f.db, r);
  if (r.status === "executing") {
    await f.deps.outbox(f.db, "finance.refund.disburse", { no: r.no }, new Date(Date.now() + 5000));
  }
  return rowOf(f, r);
}

/** Gateway outcome of a disbursement (PaymentsService.disburseRefund). */
export type Disbursed =
  | { status: "refunded"; transactionId: string; kind: string }
  | { status: "manual"; reason: string };
/** Claim taken before the gateway call; a claim older than this has an unknown outcome. */
export const CLAIM_STALE_MS = 15 * 60_000;

/**
 * Claims an executing refund for exactly one gateway call (row lock + claim stamp), so the job and the sweep can't
 * both pay it. Null = not executing or already claimed.
 */
export async function claimDisbursement(db: Exec, no: string) {
  const r = await one<R>(db, "refund", no, true);
  if (!r || r.status !== "executing" || r.disburseClaimedAt) return null;
  r.disburseClaimedAt = nowIso();
  r.rev++;
  r.updatedAt = nowIso();
  await saveRefund(db, r);
  return { ref: r.no, caseRef: r.caseRef, amount: amountOf(r), refunded: await cashRefunded(db, { caseRef: r.caseRef }, r.no) };
}

/** Records the gateway outcome: refunded (ledger: receivable → gateway clearing) or execution_failed with the reason. */
export async function settleDisbursement(db: Exec, ledger: LedgerService, no: string, out: Disbursed) {
  const r = await one<R>(db, "refund", no, true);
  if (!r || r.status !== "executing") return null;
  r.disburseClaimedAt = undefined;
  if (out.status === "refunded") {
    r.status = "refunded";
    r.failReason = undefined;
    r.note = [r.note, `Gateway refund on ${out.transactionId}`].filter(Boolean).join(" · ");
    await postRefund(ledger, db, r.no, { amount: amountOf(r), method: out.kind }, null);
    await reversePartnerCommission(db, r.caseRef, amountOf(r));
    await refundCaseStatus(db, r.caseRef, "refunded", r.no);
  } else {
    r.status = "execution_failed";
    r.failReason = out.reason;
  }
  r.rev++;
  r.updatedAt = nowIso();
  await saveRefund(db, r);
  return r;
}

/** Sweep: a claim that never came back (crash mid-call) must not be retried blind — finance checks the gateway first. */
export async function failStaleClaims(db: Exec, ledger: LedgerService) {
  const rs = await where<R>(db, "refund", { status: ["executing"] });
  const stale = rs.filter((r) => r.disburseClaimedAt && Date.now() - Date.parse(r.disburseClaimedAt) > CLAIM_STALE_MS);
  for (const x of stale)
    await settleDisbursement(db, ledger, x.no, {
      status: "manual",
      reason: "Gateway refund outcome unknown (no answer). Check the gateway before paying out manually.",
    });
  return stale.length;
}

// ---------------------------------------------------------------- credit notes
export async function creditNotes(f: Fin) {
  const [cns, invs, refunds] = await Promise.all([
    all<CreditNote>(f.db, "credit_note"),
    invMap(f.db),
    all<R>(f.db, "refund"),
  ]);
  return {
    items: cns
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
      .map((cn) => cnView(f, cn, invs, refunds)),
  };
}
export async function creditNote(f: Fin, no: string) {
  const cn = await one<CreditNote>(f.db, "credit_note", no);
  if (!cn) throw fail(404, "not_found", "No such credit note.");
  const [invs, refunds] = await Promise.all([
    invMap(f.db),
    all<R>(f.db, "refund"),
  ]);
  return cnView(f, cn, invs, refunds);
}
function cnView(
  f: Fin,
  cn: CreditNote,
  invs: Map<string, Inv>,
  refunds: R[],
): CreditNoteDetail {
  const inv = invs.get(cn.invoiceNo);
  const r = refunds.find((x) => x.no === cn.refundNo);
  return {
    ...cn,
    clientName: f.D.clientName(inv?.clientId ?? ""),
    refund: r && view(f, r, invs),
    invoiceTotal: inv?.totals.total ?? 0,
    outcome:
      r?.method === "credit"
        ? "credit"
        : r && r.status !== "credited"
          ? "refund"
          : "balance",
  };
}

// ---------------------------------------------------------------- booking refunds (outbox `booking.refund_requested`)
export type BookingRefund = {
  bookingId: string;
  reference: string;
  refund: { ref: string; amount: number; kind: "refund" | "credit" };
};
/**
 * Books a consultation refund the booking policy already decided (no invoice: caseRef/invoiceNo = booking reference).
 * Idempotent on the RFD ref. Money refunds go to disbursement; credits complete at once.
 * Returns the stored refund, or null when it was already booked.
 */
export async function bookingRefund(db: Exec, d: BookingRefund) {
  if (await one<R>(db, "refund", d.refund.ref, true)) return null;
  const credit = d.refund.kind === "credit";
  const r: R = {
    no: d.refund.ref,
    caseRef: d.reference,
    invoiceNo: d.reference,
    reason: "cancelled_before_work",
    stage: "before_work",
    requested: d.refund.amount,
    approved: d.refund.amount,
    method: credit ? "credit" : "original",
    destination: { masked: "", changed: false },
    status: credit ? "completed_as_credit" : "executing",
    chain: [],
    requestedBy: { id: "system", name: "Booking" },
    impact: [],
    auto: "cancelled",
    at: nowIso(),
    rev: 1,
    note: `Booking ${d.reference}`,
    ...(credit ? {} : { execStartedAt: nowIso() }),
  };
  await saveRefund(db, r);
  return r;
}
