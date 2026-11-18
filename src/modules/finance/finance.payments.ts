// Finance payments + reconciliation (U8–U10): payment queue, transfer proofs, manual confirm with the X-4 four-eyes chain,
// provider verify, reversal, statement import + matcher, line actions, provider-day/month close and reopen.
// Port of src/mocks/handlers-finance-c.ts onto finance_records; every settle posts to the ledger.
import type { Tx as Exec } from "../../core/db/db";
import { and, eq, inArray } from "drizzle-orm";
import { payments } from "@/db/schema";
import {
  canSign,
  chainComplete,
  manualChain,
  refundChain,
  sign,
} from "@/domain/finance/approvals";
import { applyPayment, refundSuggestion } from "@/domain/finance/money";
import { parseCsv } from "@/domain/finance/csv";
import {
  closeBlockers,
  countBy,
  difference,
  matchLines,
  type LineIn,
  type LineResult,
  type PaymentIn,
} from "@/domain/finance/recon";
import type {
  Allocation,
  MatchState,
  Method,
  Payment,
  PaymentState,
  PeriodLock,
  Provider,
  RefundRequest,
  StatementImport,
  StatementLine,
} from "@/domain/finance/types";
import type {
  Blocker,
  DayCell,
  ImportDetail,
  ImportRow,
  ImportRowIn,
  InvoiceOption,
  LineCandidate,
  LineRow,
  Mapping,
  PayTab,
  PaymentDetail,
  PaymentList,
  PaymentRow,
  PlatformRow,
  ProofCandidate,
  ProviderCard,
  ReconOverview,
} from "./lib/views";
import {
  DAY,
  POLICY,
  accepted,
  all,
  checkRev,
  fail,
  need,
  nextNo,
  nowIso,
  one,
  policyOf,
  put,
  refOf,
  rid,
  sum,
  today,
  where,
  type Fin,
} from "./finance.store";
import {
  addClientCredit,
  clientCredit,
  invoiceByKey,
  saveInv,
  stripPayment,
  type Inv,
} from "./finance.billing";
import { postPayment, reverse } from "../ledger/ledger.postings";
import { ownUpload } from "../account/account.service";

export type Pay = Payment & {
  journalId?: string;
  lockAt?: number;
  evidence?: string;
  /** /api/uploads id of the evidence file (downloaded via /api/files/:id/:name). */
  evidenceFileId?: string;
  sample?: boolean;
  /** Split recorded by settle(): what went onto the invoice vs. to client credit; reversal undoes exactly these. */
  applied?: number;
  credit?: number;
  /** Client bank transfer on `payments`: finance only signs; PaymentsService.settle posts (one cash source of truth). */
  gatewayPaymentId?: string;
};
type Line = StatementLine & {
  rev?: number;
  payer?: string;
  diff?: number;
  by?: { name: string; at: string };
};
type Imp = StatementImport & { at: string; fileName: string };

const PROVIDERS: Provider[] = ["mtn_momo", "airtel_money", "card", "bank"];
const dayOf = (iso: string) => iso.slice(0, 10);
export const providerOf = (m: Method): Provider | null =>
  m === "bank_transfer"
    ? "bank"
    : m === "mtn_momo" || m === "airtel_money" || m === "card"
      ? m
      : null;
const refOfP = (p: Payment) => p.providerRef ?? p.bankReference;
export const savePay = (db: Exec, p: Pay) =>
  put(db, "payment", p.id, p, p.invoiceNo);
const saveLine = (db: Exec, l: Line) => put(db, "line", l.id, l, l.importId);
const saveImp = (db: Exec, i: Imp) => put(db, "import", i.id, i, i.provider);

// ---------------------------------------------------------------- loading
type World = { pays: Pay[]; imps: Imp[]; lines: Line[]; locks: PeriodLock[] };
async function world(db: Exec): Promise<World> {
  const [pays, imps, lines, locks] = await Promise.all([
    all<Pay>(db, "payment"),
    all<Imp>(db, "import"),
    all<Line>(db, "line"),
    all<PeriodLock>(db, "period_lock"),
  ]);
  imps.sort((a, b) => b.at.localeCompare(a.at));
  return { pays, imps, lines, locks };
}
const lockOf = (
  w: World,
  provider: Provider,
  day: string,
): PeriodLock["state"] =>
  w.locks.find((l) => l.provider === provider && l.day === day)?.state ??
  "open";
export const isLockedIn = (
  w: { locks: PeriodLock[] },
  provider: Provider,
  day: string,
) =>
  lockOf(w as World, provider, day) === "closed" ||
  lockOf(w as World, provider, day.slice(0, 7)) === "closed";
const importOf = (w: World, l: StatementLine) =>
  w.imps.find((i) => i.id === l.importId)!;
const needsYou = (l: StatementLine) =>
  l.match === "unmatched" ||
  l.match === "suggested" ||
  l.match === "duplicate" ||
  (l.match === "exception" && !l.reason?.trim());
const windowPayments = (
  w: World,
  provider: Provider,
  from: string,
  to: string,
) =>
  w.pays.filter(
    (p) =>
      providerOf(p.method) === provider &&
      dayOf(p.at) >= dayOf(from) &&
      dayOf(p.at) <= dayOf(to),
  );
const asIn = (p: Payment): PaymentIn => ({
  id: p.id,
  ref: refOfP(p),
  amount: p.amountReceived ?? p.amountExpected,
  at: p.at,
  method: p.method,
  confirmed: p.state === "confirmed" || p.state === "confirmed_late",
  duplicate: p.duplicate,
});
const resultsOf = (lines: Line[]): LineResult[] =>
  lines.map((l) => ({
    lineId: l.id,
    match: l.match,
    paymentId: l.paymentId,
    diff: l.diff,
    reason: l.reason,
  }));
const platformUnmatched = (w: World, imp: StatementImport) =>
  windowPayments(w, imp.provider, imp.from, imp.to).filter(
    (p) =>
      (p.state === "confirmed" || p.state === "confirmed_late") &&
      !p.reconciliationId,
  );

export async function periodLocks(db: Exec) {
  return { locks: await all<PeriodLock>(db, "period_lock") };
}

// ---------------------------------------------------------------- settle (shared with refunds/recon)
/** Confirms a payment: receipt number, invoice applied (excess → client credit), ledger posted. Returns the audit "before". */
export async function settle(
  f: Fin,
  p: Pay,
  amount: number,
  source: "webhook" | "poll" | "finance",
  late = false,
) {
  const inv = await invoiceByKey(f.db, p.invoiceNo, true);
  const before = {
    state: p.state,
    invoice: inv && { status: inv.status, balanceDue: inv.balanceDue },
  };
  p.state = late ? "confirmed_late" : "confirmed";
  p.amountReceived = amount;
  p.receiptNo ??= await nextNo(f.db, "RCPT");
  p.verify = undefined;
  p.lockedBy = undefined;
  p.lockAt = undefined;
  p.rev++;
  p.events.push({
    at: nowIso(),
    kind: p.state,
    source,
    by: source === "finance" ? refOf(f.me) : undefined,
  });
  let applied = amount,
    credit = 0;
  if (inv) {
    const r = applyPayment(inv, amount);
    applied = r.applied;
    credit = r.credit;
    p.applied = r.applied;
    p.credit = r.credit;
    inv.amountPaid += r.applied;
    inv.balanceDue -= r.applied;
    inv.status = r.status === "issued" ? inv.status : r.status;
    inv.rev++;
    if (r.credit) {
      p.events.push({
        at: nowIso(),
        kind: "credit_created",
        source: "system",
        note: String(r.credit),
      });
      if (inv.status === "paid" && r.applied === 0) p.duplicate = true;
      await addClientCredit(f.db, inv.clientId, r.credit);
    }
    await saveInv(f.db, inv);
  }
  p.journalId =
    (await postPayment(
      f.deps.ledger,
      f.db,
      p.id,
      { method: p.method, applied, credit, fee: p.providerFee },
      f.me.id,
    )) ?? undefined;
  await savePay(f.db, p);
  return before;
}

// ---------------------------------------------------------------- views
function attention(p: Payment) {
  return (
    !!p.duplicate ||
    p.state === "confirmed_late" ||
    p.state === "expired" ||
    (p.state === "pending_provider" &&
      Date.parse(p.at) + 3_600_000 < Date.now())
  );
}
const TAB_OF: Record<PayTab, (p: Payment) => boolean> = {
  all: () => true,
  pending: (p) => p.state === "initiated" || p.state === "pending_provider",
  verification: (p) =>
    p.state === "proof_submitted" || p.state === "under_verification",
  failed: (p) => p.state === "failed" || p.state === "rejected",
  expired: (p) => p.state === "expired",
  reversed: (p) => p.state === "reversed",
  attention,
};
const rowOf = (f: Fin, p: Payment): PaymentRow => ({
  id: p.id,
  at: p.at,
  method: p.method,
  ref: refOfP(p),
  clientName: f.D.clientName(p.clientId),
  invoiceNo: p.invoiceNo,
  caseRef: p.caseRef,
  amount: p.amountReceived ?? p.amountExpected,
  fee: p.providerFee,
  state: p.state,
  verify: p.verify,
  attention: attention(p),
  duplicate: p.duplicate,
});
const lockFresh = (p: Pay) =>
  !!p.lockedBy && (p.lockAt ?? 0) + POLICY.lockMs > Date.now();

async function detailOf(f: Fin, p: Pay, w?: World): Promise<PaymentDetail> {
  const W = w ?? (await world(f.db));
  const inv = await invoiceByKey(f.db, p.invoiceNo);
  const amount = p.amountReceived ?? p.amountExpected;
  const ref = refOfP(p)?.toUpperCase();
  const candidates: ProofCandidate[] =
    p.method === "bank_transfer"
      ? W.lines
          .filter(
            (l) =>
              importOf(W, l)?.provider === "bank" &&
              (l.externalRef.toUpperCase() === ref ||
                (l.amount === amount && l.match !== "matched")),
          )
          .slice(0, 5)
          .map((l) => ({
            lineId: l.id,
            importId: l.importId,
            externalRef: l.externalRef,
            amount: l.amount,
            at: l.occurredAt,
            exactAmount: l.amount === amount,
            refFound: l.externalRef.toUpperCase() === ref,
          }))
      : [];
  const firstSig = p.chain?.find((s) => s.at)?.at;
  const alloc = p.caseRef
    ? (await all<Allocation>(f.db, "allocation")).find(
        (a) => a.caseRef === p.caseRef,
      )
    : undefined;
  const applied = Math.min(amount, inv?.amountPaid ?? 0);
  return {
    payment: { ...stripPayment(p), clientName: f.D.clientName(p.clientId) },
    invoice: inv
      ? {
          no: inv.no!,
          total: inv.totals.total,
          balanceDue: inv.balanceDue,
          amountPaid: inv.amountPaid,
          status: inv.status,
        }
      : null,
    diff: amount - (inv?.balanceDue ?? 0),
    over: Math.max(0, amount - (inv?.balanceDue ?? 0)),
    candidates,
    returnAt:
      firstSig && p.state === "under_verification"
        ? new Date(Date.parse(firstSig) + POLICY.manualReturnMs).toISOString()
        : undefined,
    lockUntil: lockFresh(p)
      ? new Date((p.lockAt ?? 0) + POLICY.lockMs).toISOString()
      : undefined,
    evidenceHref: p.evidenceFileId && p.evidence ? `/api/files/${p.evidenceFileId}/${encodeURIComponent(p.evidence)}` : undefined,
    evidence:
      p.evidence ??
      (p.proofDocId ? `${p.bankReference ?? p.id}.pdf` : undefined),
    impact: {
      invoiceNo: p.invoiceNo,
      balanceAfter: (inv?.balanceDue ?? 0) + applied,
      allocation: !!alloc,
      paidOut: alloc?.status === "paid",
    },
  } as PaymentDetail;
}
function lineView(f: Fin, w: World, l: Line): LineRow {
  const imp = importOf(w, l);
  const p = l.paymentId ? w.pays.find((x) => x.id === l.paymentId) : undefined;
  return {
    ...l,
    rev: l.rev ?? 1,
    payer: l.payer,
    diff: l.diff,
    by: l.by,
    day: dayOf(l.occurredAt),
    locked: isLockedIn(w, imp.provider, dayOf(l.occurredAt)),
    payment: p && {
      id: p.id,
      invoiceNo: p.invoiceNo,
      clientName: f.D.clientName(p.clientId),
      amount: p.amountReceived ?? p.amountExpected,
      state: p.state,
    },
  } as LineRow;
}
const platformView = (f: Fin, p: Payment): PlatformRow => ({
  id: p.id,
  at: p.at,
  ref: refOfP(p),
  invoiceNo: p.invoiceNo,
  clientName: f.D.clientName(p.clientId),
  amount: p.amountReceived ?? p.amountExpected,
  state: p.state,
});

// ---------------------------------------------------------------- payments
export async function listPayments(
  f: Fin,
  q: {
    tab?: string;
    method?: string;
    from?: string;
    to?: string;
    client?: string;
    case?: string;
    q?: string;
    cursor?: string;
  },
): Promise<PaymentList> {
  const pays = await all<Pay>(f.db, "payment");
  const s = q.q?.toLowerCase();
  const base = pays.filter(
    (p) =>
      (!q.method || p.method === q.method) &&
      (!q.from || dayOf(p.at) >= q.from) &&
      (!q.to || dayOf(p.at) <= q.to) &&
      (!q.client || p.clientId === q.client) &&
      (!q.case || p.caseRef === q.case) &&
      (!s ||
        [
          refOfP(p),
          p.invoiceNo,
          p.caseRef,
          f.D.clientName(p.clientId),
          p.id,
        ].some((v) => v?.toLowerCase().includes(s))),
  );
  const counts = Object.fromEntries(
    Object.entries(TAB_OF).map(([k, fn]) => [k, base.filter(fn).length]),
  ) as Record<PayTab, number>;
  const rows = base
    .filter(TAB_OF[(q.tab ?? "all") as PayTab] ?? TAB_OF.all)
    .sort((a, b) => b.at.localeCompare(a.at));
  const off = Math.max(0, Number(q.cursor ?? 0) || 0);
  return {
    items: rows.slice(off, off + 20).map((p) => rowOf(f, p)),
    meta: {
      counts,
      total: rows.length,
      amount: sum(rows, (p) => p.amountReceived ?? p.amountExpected),
      fee: sum(rows, (p) => p.providerFee ?? 0),
      next: off + 20 < rows.length ? String(off + 20) : null,
    },
  };
}
export async function invoiceOptions(
  f: Fin,
  q?: string,
): Promise<{ items: InvoiceOption[] }> {
  const s = q?.toLowerCase() ?? "";
  const invs = await where<Inv>(f.db, "invoice", {
    status: ["issued", "partially_paid"],
  });
  return {
    items: invs
      .filter((i) => i.no && i.balanceDue > 0)
      .filter(
        (i) =>
          !s ||
          [i.no, i.caseRef, i.billTo.name].some((v) =>
            v?.toLowerCase().includes(s),
          ),
      )
      .slice(0, 20)
      .map((i) => ({
        no: i.no!,
        client: i.billTo.name,
        balance: i.balanceDue,
        caseRef: i.caseRef,
      })),
  };
}
async function payOr404(db: Exec, id: string) {
  const p = await one<Pay>(db, "payment", id, true);
  if (!p) throw fail(404, "not_found");
  return p;
}
export async function getPayment(f: Fin, id: string) {
  const p = await one<Pay>(f.db, "payment", id);
  if (!p) throw fail(404, "not_found");
  return detailOf(f, p);
}
const refUsed = (w: World, ref: string | undefined, exceptId?: string) => {
  const r = ref?.trim().toUpperCase();
  return (
    !!r &&
    w.pays.some((p) => p.id !== exceptId && refOfP(p)?.toUpperCase() === r)
  );
};

/** Cash already on `payments` (gateway/client transfer) must not be recorded again as a finance manual payment. */
async function gatewayRefUsed(db: Exec, ref: string | undefined) {
  const r = ref?.trim();
  if (!r) return false;
  const hit = await db
    .select({ id: payments.paymentId })
    .from(payments)
    .where(
      and(
        eq(payments.providerTransactionId, r),
        inArray(payments.status, ["succeeded", "pending_verification", "pending"]),
      ),
    )
    .limit(1);
  return hit.length > 0;
}

export type ManualIn = {
  invoiceNo: string;
  method: Method;
  amount: number;
  bankReference?: string;
  receivedAt: string;
  evidenceName?: string;
  evidenceUploadId?: string;
  reason: string;
  note?: string;
  lineId?: string;
};
export async function recordManual(f: Fin, b: ManualIn) {
  const up = b.evidenceUploadId ? await ownUpload(f.db, f.me.id, b.evidenceUploadId) : undefined;
  if (up) b = { ...b, evidenceName: up.name };
  const inv = await invoiceByKey(f.db, b.invoiceNo);
  need(
    inv &&
      Number.isInteger(b.amount) &&
      b.amount > 0 &&
      b.receivedAt &&
      b.evidenceName,
    422,
    "validation",
  );
  need(b.reason?.trim(), 422, "reason_required");
  if (inv!.balanceDue <= 0) throw fail(409, "invoice_settled");
  const w = await world(f.db);
  if (refUsed(w, b.bankReference) || (await gatewayRefUsed(f.db, b.bankReference)))
    throw fail(409, "duplicate_reference");
  const prov = providerOf(b.method);
  if (prov && isLockedIn(w, prov, dayOf(b.receivedAt)))
    throw fail(409, "period_locked");
  const p: Pay = {
    id: rid("pay-m"),
    invoiceNo: inv!.no!,
    caseRef: inv!.caseRef,
    clientId: inv!.clientId,
    method: b.method,
    state: "under_verification",
    amountExpected: b.amount,
    bankReference: b.bankReference?.trim() || undefined,
    chain: manualChain(b.amount, policyOf(f.S)),
    makerId: f.me.id,
    events: [
      {
        at: nowIso(),
        kind: "recorded",
        source: "finance",
        by: refOf(f.me),
        note: [b.reason, b.note].filter(Boolean).join(" · "),
      },
    ],
    at: new Date(b.receivedAt).toISOString(),
    rev: 1,
    evidence: b.evidenceName,
    evidenceFileId: up?.id,
  };
  await savePay(f.db, p);
  w.pays.unshift(p);
  if (b.lineId) {
    const l = w.lines.find((x) => x.id === b.lineId);
    if (l) {
      l.match = "exception";
      l.paymentId = p.id;
      l.reason = `manual_payment:${p.id}`;
      await touchLine(f, w, l);
    }
  }
  f.rec(
    "payment.manual.recorded",
    "payment",
    p.id,
    null,
    { state: p.state, amount: b.amount, method: b.method, invoice: inv!.no },
    b.reason,
  );
  return accepted(await detailOf(f, p, w));
}

export async function lockPayment(f: Fin, id: string, release?: boolean) {
  const p = await payOr404(f.db, id);
  const who = refOf(f.me);
  if (release) {
    if (p.lockedBy?.id === who.id) {
      p.lockedBy = undefined;
      p.lockAt = undefined;
      if (
        p.state === "under_verification" &&
        !p.chain?.some((s) => s.signedBy) &&
        p.makerId !== who.id &&
        p.proofDocId
      )
        p.state = "proof_submitted";
      await savePay(f.db, p);
    }
    return detailOf(f, p);
  }
  if (p.state !== "proof_submitted" && p.state !== "under_verification")
    return detailOf(f, p);
  if (lockFresh(p) && p.lockedBy?.id !== who.id) return detailOf(f, p); // someone else is verifying
  const before = { state: p.state };
  p.lockedBy = who;
  p.lockAt = Date.now();
  if (p.state === "proof_submitted") {
    p.state = "under_verification";
    p.rev++;
    p.events.push({
      at: nowIso(),
      kind: "under_verification",
      source: "finance",
      by: who,
    });
    f.rec("payment.verification.started", "payment", p.id, before, {
      state: p.state,
    });
  }
  await savePay(f.db, p);
  return detailOf(f, p);
}

/** Hands a decided client bank transfer to PaymentsService (outbox, same tx): settle/fail there, never posted here. */
async function decideGateway(f: Fin, p: Pay, approve: boolean) {
  if (approve) {
    p.state = "confirmed";
    p.amountReceived = p.amountExpected;
    p.lockedBy = undefined;
    p.lockAt = undefined;
    p.events.push({ at: nowIso(), kind: "confirmed", source: "finance", by: refOf(f.me) });
    await savePay(f.db, p);
    f.rec("payment.confirmed.manual", "payment", p.id, null, { state: p.state });
  }
  await f.deps.outbox(f.db, "finance.bank_transfer.decide", {
    paymentId: p.gatewayPaymentId,
    approve,
    actorId: f.me.id,
    makerId: p.makerId,
  });
}

/** X-4 four-eyes: each call signs the next step; the last signature settles (200), earlier ones answer 202. */
export async function confirmPayment(
  f: Fin,
  id: string,
  b: { rev?: number; bankReference?: string },
) {
  const p = await payOr404(f.db, id);
  checkRev(p.rev, b.rev);
  need(
    p.state === "proof_submitted" || p.state === "under_verification",
    409,
    "conflict",
  );
  if (
    lockFresh(p) &&
    p.lockedBy?.id !== f.me.id &&
    !p.chain?.some((s) => s.signedBy)
  )
    throw fail(409, "conflict");
  const w = await world(f.db);
  if (b.bankReference && refUsed(w, b.bankReference, p.id))
    throw fail(409, "duplicate_reference");
  const prov = providerOf(p.method);
  if (prov && isLockedIn(w, prov, dayOf(p.at)))
    throw fail(409, "period_locked");
  const chain = p.chain ?? manualChain(p.amountExpected, policyOf(f.S));
  const c = canSign(chain, f.me, p.makerId ? [p.makerId] : []);
  if (!c.ok)
    throw fail(
      c.reason === "complete" ? 409 : 403,
      c.reason === "complete" ? "conflict" : c.reason,
    );
  if (b.bankReference) p.bankReference = b.bankReference.trim();
  p.chain = sign(chain, f.me, nowIso());
  p.state = "under_verification";
  p.rev++;
  p.events.push({
    at: nowIso(),
    kind: "signed",
    source: "finance",
    by: refOf(f.me),
  });
  f.rec(
    "payment.confirm.signed",
    "payment",
    p.id,
    { signed: c.index },
    { signed: c.index + 1 },
  );
  if (!chainComplete(p.chain)) {
    await savePay(f.db, p);
    return accepted(await detailOf(f, p, w));
  }
  if (p.gatewayPaymentId) {
    await decideGateway(f, p, true);
    return detailOf(f, p);
  }
  const before = await settle(f, p, p.amountExpected, "finance");
  f.rec("payment.confirmed.manual", "payment", p.id, before, {
    state: p.state,
    receipt: p.receiptNo,
  });
  return detailOf(f, p);
}

export async function rejectPayment(
  f: Fin,
  id: string,
  b: { reason?: string; note?: string; rev?: number },
) {
  const p = await payOr404(f.db, id);
  checkRev(p.rev, b.rev);
  need(b.reason?.trim(), 422, "reason_required");
  need(
    p.state === "proof_submitted" || p.state === "under_verification",
    409,
    "conflict",
  );
  const before = { state: p.state };
  p.state = "rejected";
  p.lockedBy = undefined;
  p.lockAt = undefined;
  p.rev++;
  p.events.push({
    at: nowIso(),
    kind: "rejected",
    source: "finance",
    by: refOf(f.me),
    note: [b.reason, b.note].filter(Boolean).join(" · "),
  });
  await savePay(f.db, p);
  if (p.gatewayPaymentId) await decideGateway(f, p, false);
  f.rec(
    "payment.rejected",
    "payment",
    p.id,
    before,
    { state: p.state },
    b.reason,
  );
  return detailOf(f, p);
}

/**
 * Verify-now on a pending/expired provider payment.
 * shortcut: finance payments are not yet linked to the P4 gateway transaction, so "verify" accepts the provider's
 * success only when a statement line carries the payment's reference; otherwise it is unchanged. Upgrade: call
 * payments.service reconcile(transactionId) once finance payments carry the P4 transaction id.
 */
export async function verifyPayment(f: Fin, id: string) {
  const p = await payOr404(f.db, id);
  if (p.state !== "pending_provider" && p.state !== "expired")
    return { result: "unchanged" as const, payment: await detailOf(f, p) };
  const lines = await all<Line>(f.db, "line");
  const ref = refOfP(p);
  const proof = lines.find(
    (l) =>
      ((ref && l.externalRef === ref) || l.suggestionId === p.id) &&
      l.match !== "matched" &&
      !l.paymentId &&
      l.amount >= p.amountExpected,
  );
  if (!proof)
    return { result: "unchanged" as const, payment: await detailOf(f, p) };
  const late = p.state === "expired";
  const before = await settle(f, p, proof.amount, "poll", late);
  proof.match = "matched";
  proof.paymentId = p.id;
  proof.rev = (proof.rev ?? 0) + 1;
  await saveLine(f.db, proof);
  f.rec(
    late ? "payment.status.overridden" : "payment.confirmed",
    "payment",
    p.id,
    before,
    { state: p.state },
    late ? "late_success" : "verify_now",
  );
  return { result: p.state, payment: await detailOf(f, p) };
}

export async function reversePayment(
  f: Fin,
  id: string,
  b: { reason?: string; note?: string; rev?: number },
) {
  const p = await payOr404(f.db, id);
  checkRev(p.rev, b.rev);
  need(b.reason?.trim(), 422, "reason_required");
  need(
    (p.state === "confirmed" || p.state === "confirmed_late") && !p.gatewayPaymentId, // gateway cash: refund via finance.refunds
    409,
    "conflict",
  );
  const inv = await invoiceByKey(f.db, p.invoiceNo, true);
  // credit already spent cannot be clawed back silently
  if (inv && p.credit)
    need((await clientCredit(f.db, inv.clientId)) >= p.credit, 409, "conflict");
  const before = {
    state: p.state,
    invoice: inv && { status: inv.status, balanceDue: inv.balanceDue },
  };
  p.state = "reversed";
  p.rev++;
  p.events.push({
    at: nowIso(),
    kind: "reversed",
    source: "finance",
    by: refOf(f.me),
    note: b.reason,
  });
  if (inv) {
    // shortcut: payments settled before applied/credit were stored fall back to the old min() guess, drop once all live payments carry the split
    const back = Math.min(
      p.applied ?? p.amountReceived ?? p.amountExpected,
      inv.amountPaid,
    );
    inv.amountPaid -= back;
    inv.balanceDue += back;
    inv.status =
      inv.balanceDue <= 0
        ? "paid"
        : inv.amountPaid > 0
          ? "partially_paid"
          : "issued";
    inv.rev++;
    await saveInv(f.db, inv);
    if (p.credit) {
      await addClientCredit(f.db, inv.clientId, -p.credit);
    }
  }
  await reverse(
    f.deps.ledger,
    f.db,
    p.journalId ?? (await f.deps.ledger.journalOf(f.db, "fin_payment", p.id)),
    `Reversal of payment ${p.id}: ${b.reason}`,
    f.me.id,
  );
  await savePay(f.db, p);
  f.rec(
    "payment.status.overridden",
    "payment",
    p.id,
    before,
    {
      state: p.state,
      invoice: inv && { status: inv.status, balanceDue: inv.balanceDue },
    },
    b.reason,
  );
  return detailOf(f, p);
}

/** FIN sweep: provider-pending past the intent TTL → expired (cron). */
export async function expirePending(db: Exec, now = Date.now()) {
  const hit = (
    await where<Pay>(db, "payment", { status: ["pending_provider"] })
  ).filter((p) => Date.parse(p.at) + POLICY.paymentIntentMs < now);
  for (const p of hit) {
    p.state = "expired";
    p.rev++;
    p.events.push({
      at: new Date(now).toISOString(),
      kind: "expired",
      source: "system",
    });
    await savePay(db, p);
  }
  return hit.length;
}
/** 72 h manual-confirm return (FIN X-4): a half-signed chain goes back to the queue unsigned (cron). */
export async function returnStaleVerifications(db: Exec, now = Date.now()) {
  const hit = (
    await where<Pay>(db, "payment", { status: ["under_verification"] })
  ).filter(
    (p) =>
      p.chain?.some((s) => s.signedBy) &&
      !chainComplete(p.chain) &&
      Date.parse(p.chain.find((s) => s.at)!.at!) + POLICY.manualReturnMs < now,
  );
  for (const p of hit) {
    p.state = "proof_submitted";
    p.chain = manualChain(p.amountExpected);
    p.lockedBy = undefined;
    p.lockAt = undefined;
    p.rev++;
    p.events.push({
      at: new Date(now).toISOString(),
      kind: "returned_to_queue",
      source: "system",
    });
    await savePay(db, p);
  }
  return hit.length;
}

// ---------------------------------------------------------------- statements + reconciliation
async function touchLine(f: Fin, w: World, l: Line) {
  l.rev = (l.rev ?? 1) + 1;
  l.by = { name: f.me.name, at: nowIso() };
  await saveLine(f.db, l);
  const imp = importOf(w, l);
  if (imp) {
    imp.counts = countBy(
      w.lines
        .filter((x) => x.importId === imp.id)
        .map((x) => ({ lineId: x.id, match: x.match })),
    );
    await saveImp(f.db, imp);
  }
}

function overview(
  f: Fin,
  w: World,
  provider: Provider,
  date: string,
): ReconOverview {
  const provLines = w.lines.filter(
    (l) => importOf(w, l)?.provider === provider,
  );
  const days: DayCell[] = Array.from({ length: 7 }, (_, k) => {
    const d = new Date(Date.parse(date) - (6 - k) * DAY)
      .toISOString()
      .slice(0, 10);
    const ls = provLines.filter((l) => dayOf(l.occurredAt) === d);
    return {
      day: d,
      lines: ls.length,
      needs: ls.filter(needsYou).length,
      lock: isLockedIn(w, provider, d) ? "closed" : lockOf(w, provider, d),
    };
  });
  const providers: ProviderCard[] = PROVIDERS.map((pv) => {
    const last = w.imps.find((i) => i.provider === pv);
    const ls = last ? w.lines.filter((l) => l.importId === last.id) : [];
    return {
      provider: pv,
      lastImport: last && {
        id: last.id,
        at: last.at,
        by: last.importedBy.name,
      },
      pct: ls.length
        ? Math.round(
            (ls.filter(
              (l) =>
                l.match === "matched" ||
                l.match === "ignored" ||
                (l.match === "exception" && l.reason),
            ).length /
              ls.length) *
              1000,
          ) / 10
        : null,
      needs: ls.filter(needsYou).length,
    };
  });
  const dayLines = provLines.filter((l) => dayOf(l.occurredAt) === date);
  const blockers: Blocker[] = closeBlockers(resultsOf(dayLines)).map((r) => {
    const l = w.lines.find((x) => x.id === r.lineId)!;
    return {
      lineId: l.id,
      ref: l.externalRef,
      match: l.match,
      importId: l.importId,
    };
  });
  const month = date.slice(0, 7);
  const openDays = new Set(
    provLines
      .filter(
        (l) =>
          l.occurredAt.startsWith(month) &&
          !isLockedIn(w, provider, dayOf(l.occurredAt)),
      )
      .map((l) => dayOf(l.occurredAt)),
  );
  const imp = dayLines[0] ? importOf(w, dayLines[0]) : undefined;
  return {
    providers,
    days,
    month: {
      month,
      state: lockOf(w, provider, month),
      blockers: openDays.size,
    },
    selected: {
      provider,
      day: date,
      lock: isLockedIn(w, provider, date)
        ? "closed"
        : lockOf(w, provider, date),
      lines: dayLines.length,
      needs: dayLines.filter(needsYou).length,
      difference: imp ? difference(dayLines, resultsOf(dayLines), [], []) : 0,
      blockers,
      importId: imp?.id,
    },
    imports: w.imps.filter((i) => i.provider === provider) as ImportRow[],
  };
}
export async function statements(
  f: Fin,
  q: { provider?: string; date?: string },
) {
  const w = await world(f.db);
  const provider = (
    PROVIDERS.includes(q.provider as Provider) ? q.provider : "mtn_momo"
  ) as Provider;
  const fallback =
    w.lines
      .filter((l) => importOf(w, l)?.provider === provider)
      .map((l) => dayOf(l.occurredAt))
      .sort()
      .at(-1) ?? today();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? "") ? q.date! : fallback;
  return overview(f, w, provider, date);
}
export async function mappingOf(f: Fin, provider: string) {
  return {
    mapping:
      (await one<{ id: string; mapping: Mapping }>(f.db, "mapping", provider))
        ?.mapping ?? null,
  };
}
/** Demo statement for the import dialog (dev/staging): the seeded sample MoMo day as CSV, 1 exception · 1 suggested · 1 unknown. */
export async function sampleStatement(f: Fin) {
  const sample = (await all<Pay>(f.db, "payment"))
    .filter((p) => p.sample)
    .sort((a, b) => a.at.localeCompare(b.at));
  const rows = sample
    .filter((p) => p.state === "confirmed")
    .map((p, i) => [
      refOfP(p) ?? p.id,
      p.amountExpected,
      p.providerFee ?? 0,
      p.at,
      `2507••••${String(100 + i).slice(-3)}`,
    ]);
  const pend = sample.find((p) => p.state === "pending_provider");
  const exc = sample.find((p) => p.amountExpected === 40_000);
  const day = sample[0]?.at.slice(0, 10) ?? today();
  const tag = day.replaceAll("-", "").slice(2);
  if (exc) {
    const r = rows.find((x) => x[0] === refOfP(exc));
    if (r) {
      r[1] = 40_400;
      r[2] = 404;
    }
  }
  if (pend)
    rows.push([
      `MP${tag}.1212`,
      pend.amountExpected,
      Math.round(pend.amountExpected / 100),
      pend.at,
      "2507••••312",
    ]);
  rows.push([
    `MP${tag}.9001`,
    9_500,
    95,
    new Date(Date.parse(`${day}T19:00:00Z`)).toISOString(),
    "2507••••901",
  ]);
  return {
    fileName: `mtn-${day}.csv`,
    csv: [
      "Reference,Amount,Fee,Date,Payer",
      ...rows.map((r) => r.join(",")),
    ].join("\n"),
  };
}

/** Matcher over one import: exact ref+amount, ref with other amount → exception, unique same-amount ±1 day → suggested. */
export async function runImport(
  db: Exec,
  w: World,
  provider: Provider,
  rows: ImportRowIn[],
  o: {
    fileName: string;
    fileHash: string;
    at: string;
    by: { id: string; name: string };
  },
) {
  const from = rows.reduce(
    (m, r) => (r.occurredAt < m ? r.occurredAt : m),
    rows[0].occurredAt,
  );
  const to = rows.reduce(
    (m, r) => (r.occurredAt > m ? r.occurredAt : m),
    rows[0].occurredAt,
  );
  const imp: Imp = {
    id: rid("imp"),
    provider,
    from: dayOf(from),
    to: dayOf(to),
    rows: rows.length,
    fileHash: o.fileHash,
    importedBy: o.by,
    counts: countBy([]),
    at: o.at,
    fileName: o.fileName,
  };
  const lines: Line[] = rows.map((r, i) => ({
    id: `${imp.id}-${i}`,
    importId: imp.id,
    externalRef: r.externalRef,
    amount: r.amount,
    fee: r.fee,
    occurredAt: new Date(r.occurredAt).toISOString(),
    match: "unmatched",
    rev: 1,
    payer: r.payer,
  }));
  w.imps.unshift(imp);
  // Payments already explained by another line never match twice.
  const pool = windowPayments(w, provider, imp.from, imp.to).filter(
    (p) =>
      !p.reconciliationId &&
      [
        "confirmed",
        "confirmed_late",
        "pending_provider",
        "expired",
        "proof_submitted",
        "under_verification",
      ].includes(p.state),
  );
  const { results } = matchLines(lines as LineIn[], pool.map(asIn));
  for (const [i, r] of results.entries()) {
    const l = lines[i];
    l.match = r.match;
    l.paymentId = r.paymentId;
    l.reason = r.reason;
    l.diff = r.diff;
    const p = r.paymentId
      ? w.pays.find((x) => x.id === r.paymentId)
      : undefined;
    // A line naming a payment the platform has not confirmed yet is a suggestion (missed webhook / proof in review).
    if (p && r.match === "matched" && !asIn(p).confirmed) l.match = "suggested";
    if (l.match === "suggested") l.suggestionId = r.paymentId;
    if (p && (l.match === "matched" || l.match === "duplicate")) {
      p.reconciliationId = l.id;
      await savePay(db, p);
    }
    await saveLine(db, l);
  }
  w.lines.push(...lines);
  imp.counts = countBy(lines.map((l) => ({ lineId: l.id, match: l.match })));
  await saveImp(db, imp);
  return imp;
}

export type ImportIn = {
  provider: Provider;
  fileName: string;
  fileHash: string;
  mapping: Mapping;
  rows: ImportRowIn[];
};
export async function importStatement(f: Fin, b: ImportIn) {
  need(PROVIDERS.includes(b.provider) && b.rows.length, 422, "validation");
  need(
    b.mapping?.external_ref && b.mapping.amount && b.mapping.occurred_at,
    422,
    "mapping_required",
  );
  const w = await world(f.db);
  if (w.imps.some((i) => i.fileHash === b.fileHash))
    throw fail(409, "duplicate_file");
  if (b.rows.some((r) => isLockedIn(w, b.provider, dayOf(r.occurredAt))))
    throw fail(409, "period_locked");
  await put(f.db, "mapping", b.provider, {
    id: b.provider,
    mapping: b.mapping,
  });
  const imp = await runImport(f.db, w, b.provider, b.rows, {
    fileName: b.fileName,
    fileHash: b.fileHash,
    at: nowIso(),
    by: refOf(f.me),
  });
  f.rec("recon.statement.imported", "import", imp.id, null, {
    provider: imp.provider,
    rows: imp.rows,
    counts: imp.counts,
  });
  return imp as ImportRow;
}

/** CSV text + mapping → import rows; amounts must be whole RWF. */
export function rowsFromCsv(csv: string, m: Mapping): ImportRowIn[] {
  const [head, ...data] = parseCsv(csv);
  const ix = (k: string) =>
    head.findIndex((h) => h.trim().toLowerCase() === k.trim().toLowerCase());
  const [ref, amt, fee, at] = [
    ix(m.external_ref),
    ix(m.amount),
    m.fee ? ix(m.fee) : -1,
    ix(m.occurred_at),
  ];
  if (ref < 0 || amt < 0 || at < 0) throw fail(422, "mapping_required");
  const num = (v: string) => Number(v.replace(/[\s,]/g, ""));
  return data.map((r) => {
    const amount = num(r[amt] ?? ""),
      f = fee >= 0 ? num(r[fee] ?? "0") : 0,
      t = Date.parse(r[at] ?? "");
    if (
      !r[ref]?.trim() ||
      !Number.isInteger(amount) ||
      !Number.isInteger(f) ||
      Number.isNaN(t)
    )
      throw fail(422, "validation");
    return {
      externalRef: r[ref].trim(),
      amount,
      fee: f,
      occurredAt: new Date(t).toISOString(),
    };
  });
}

export async function importDetail(f: Fin, id: string): Promise<ImportDetail> {
  const w = await world(f.db);
  const imp = w.imps.find((i) => i.id === id);
  if (!imp) throw fail(404, "not_found");
  const lines = w.lines
    .filter((l) => l.importId === id)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const plat = platformUnmatched(w, imp);
  const pays = windowPayments(w, imp.provider, imp.from, imp.to).filter(
    (p) => p.state === "confirmed" || p.state === "confirmed_late",
  );
  const results = resultsOf(lines);
  return {
    import: imp,
    lines: lines.map((l) => lineView(f, w, l)),
    platform: plat.map((p) => platformView(f, p)),
    totals: {
      statement: sum(lines, (l) => l.amount),
      platform: sum(pays, (p) => p.amountReceived ?? p.amountExpected),
      difference: difference(
        lines,
        results,
        pays.map(asIn),
        plat.map((p) => p.id),
      ),
    },
    counts: countBy(results),
  };
}
export async function lineCandidates(
  f: Fin,
  id: string,
): Promise<{ items: LineCandidate[] }> {
  const w = await world(f.db);
  const l = w.lines.find((x) => x.id === id);
  if (!l) throw fail(404, "not_found");
  const imp = importOf(w, l);
  const t = Date.parse(l.occurredAt);
  const items = w.pays
    .filter(
      (p) =>
        providerOf(p.method) === imp.provider &&
        !p.reconciliationId &&
        Math.abs(Date.parse(p.at) - t) <= 3 * DAY &&
        (
          [
            "confirmed",
            "confirmed_late",
            "pending_provider",
            "expired",
          ] as PaymentState[]
        ).includes(p.state),
    )
    .map((p) => ({
      id: p.id,
      invoiceNo: p.invoiceNo,
      clientName: f.D.clientName(p.clientId),
      amount: p.amountReceived ?? p.amountExpected,
      at: p.at,
      state: p.state,
      diff: l.amount - (p.amountReceived ?? p.amountExpected),
    }))
    .sort(
      (a, b) =>
        Math.abs(a.diff) - Math.abs(b.diff) ||
        (a.id === l.suggestionId ? -1 : 0),
    )
    .slice(0, 12);
  return { items };
}
export async function bulkAccept(f: Fin, ids: string[]) {
  const w = await world(f.db);
  let done = 0;
  for (const id of ids) {
    const l = w.lines.find((x) => x.id === id);
    if (
      !l ||
      l.match !== "suggested" ||
      !l.suggestionId ||
      isLockedIn(w, importOf(w, l).provider, dayOf(l.occurredAt))
    )
      continue;
    const p = w.pays.find((x) => x.id === l.suggestionId);
    if (
      !p ||
      p.amountExpected !== l.amount ||
      p.state === "proof_submitted" ||
      p.state === "under_verification"
    )
      continue;
    if (p.state === "pending_provider" || p.state === "expired")
      await settle(f, p, l.amount, "poll", p.state === "expired");
    l.match = "matched";
    l.paymentId = p.id;
    p.reconciliationId = l.id;
    await savePay(f.db, p);
    await touchLine(f, w, l);
    done++;
    f.rec(
      "recon.line.matched",
      "statement_line",
      l.id,
      { match: "suggested" },
      { match: "matched", payment: p.id },
      "bulk_accept",
    );
  }
  return { done, skipped: ids.length - done };
}

export type LineActionIn = {
  rev?: number;
  paymentId?: string;
  handling?: "none" | "provider_fee" | "partial" | "exception";
  reason?: string;
  note?: string;
};
export async function lineAction(
  f: Fin,
  id: string,
  action: "match" | "ignore" | "fee" | "flag" | "refund-proposal",
  b: LineActionIn,
) {
  const w = await world(f.db);
  const l = w.lines.find((x) => x.id === id);
  if (!l) throw fail(404, "not_found");
  if (isLockedIn(w, importOf(w, l).provider, dayOf(l.occurredAt)))
    throw fail(409, "period_locked");
  checkRev(l.rev ?? 1, b.rev);
  const before = { match: l.match, payment: l.paymentId, reason: l.reason };
  if (action === "match") {
    const p = b.paymentId
      ? w.pays.find((x) => x.id === b.paymentId)
      : undefined;
    need(p, 422, "validation");
    if (p!.reconciliationId && p!.reconciliationId !== l.id)
      throw fail(409, "conflict");
    if (p!.state === "proof_submitted" || p!.state === "under_verification")
      throw fail(409, "four_eyes_required");
    const diff = l.amount - (p!.amountReceived ?? p!.amountExpected);
    const h = b.handling ?? "none";
    need(diff === 0 || h !== "none", 422, "validation");
    need(h !== "exception" || b.note?.trim(), 422, "reason_required");
    if (p!.state === "pending_provider" || p!.state === "expired")
      await settle(
        f,
        p!,
        h === "partial" ? l.amount : p!.amountExpected,
        "poll",
        p!.state === "expired",
      );
    if (h === "provider_fee") p!.providerFee = Math.abs(diff);
    l.paymentId = p!.id;
    p!.reconciliationId = l.id;
    l.match = h === "exception" ? "exception" : "matched";
    l.reason = h === "exception" ? b.note : h === "none" ? undefined : h;
    l.diff = h === "exception" ? diff : undefined;
    await savePay(f.db, p!);
    await touchLine(f, w, l);
    f.rec(
      "recon.line.matched",
      "statement_line",
      l.id,
      before,
      { match: l.match, payment: p!.id, handling: h },
      b.note,
    );
  } else if (action === "ignore") {
    need(b.reason?.trim(), 422, "reason_required");
    l.match = "ignored";
    l.reason = [b.reason, b.note].filter(Boolean).join(" · ");
    await touchLine(f, w, l);
    f.rec(
      "recon.line.ignored",
      "statement_line",
      l.id,
      before,
      { match: l.match },
      l.reason,
    );
  } else if (action === "fee") {
    l.match = "ignored";
    l.reason = "provider_fee";
    await touchLine(f, w, l);
    f.rec(
      "recon.line.ignored",
      "statement_line",
      l.id,
      before,
      { match: l.match, reason: "provider_fee" },
      "provider_fee",
    );
  } else if (action === "flag") {
    need(b.note?.trim(), 422, "reason_required");
    l.match = "exception";
    l.reason = b.note;
    await touchLine(f, w, l);
    f.rec(
      "recon.line.flagged",
      "statement_line",
      l.id,
      before,
      { match: l.match },
      b.note,
    );
  } else {
    const p = l.paymentId
      ? w.pays.find((x) => x.id === l.paymentId)
      : undefined;
    const inv = p && (await invoiceByKey(f.db, p.invoiceNo));
    if (l.match !== "duplicate" || !p || !inv) throw fail(409, "conflict");
    const refunds = await all<RefundRequest>(f.db, "refund");
    if (
      refunds.some(
        (r) =>
          r.paymentId === p.id && !["rejected", "withdrawn"].includes(r.status),
      )
    )
      throw fail(409, "refund_open");
    const s = refundSuggestion(
      inv,
      "duplicate",
      f.S.refundPolicy,
      true,
      f.S.vat_bps,
    );
    const no = await nextNo(f.db, "RFD");
    const r: RefundRequest = {
      no,
      caseRef: inv.caseRef ?? "",
      invoiceNo: inv.no!,
      paymentId: p.id,
      reason: "duplicate_payment",
      stage: "duplicate",
      requested: s.total,
      method: "original",
      status: "requested",
      chain: refundChain(s.total, { execLimit: f.S.refund_exec_limit }),
      requestedBy: refOf(f.me),
      impact: [],
      auto: "duplicate",
      at: nowIso(),
      rev: 1,
    };
    await put(
      f.db,
      "refund",
      no,
      {
        ...r,
        eligiblePart: s.eligiblePart,
        passThroughRefunded: s.passThrough,
      },
      inv.no,
    );
    l.match = "exception";
    l.reason = `refund_proposed:${no}`;
    await touchLine(f, w, l);
    f.rec(
      "refund.proposed",
      "refund",
      no,
      null,
      { status: "requested", amount: s.total, line: l.id },
      "duplicate_payment",
    );
    return { line: lineView(f, w, l), refundNo: no };
  }
  return { line: lineView(f, w, l) };
}

export async function periodAction(
  f: Fin,
  provider: Provider,
  day: string,
  action: "close" | "reopen",
  b: { reason?: string },
) {
  need(
    PROVIDERS.includes(provider) && /^\d{4}-\d{2}(-\d{2})?$/.test(day),
    422,
    "validation",
  );
  const w = await world(f.db);
  const month = day.length === 7;
  const before = { state: lockOf(w, provider, day) };
  const set = async (state: PeriodLock["state"], reason?: string) => {
    const lock: PeriodLock = { provider, day, state, by: refOf(f.me), reason };
    const i = w.locks.findIndex(
      (x) => x.provider === provider && x.day === day,
    );
    if (i >= 0) w.locks[i] = lock;
    else w.locks.push(lock);
    await put(f.db, "period_lock", `${provider}:${day}`, lock, provider);
  };
  if (action === "close") {
    need(before.state !== "closed", 409, "conflict");
    const ls = w.lines.filter(
      (l) =>
        importOf(w, l)?.provider === provider &&
        (month ? l.occurredAt.startsWith(day) : dayOf(l.occurredAt) === day),
    );
    need(
      ls.length && !closeBlockers(resultsOf(ls)).length,
      409,
      "unresolved_lines",
    );
    need(
      !month || ls.every((l) => isLockedIn(w, provider, dayOf(l.occurredAt))),
      409,
      "unresolved_lines",
    );
    await set("closed");
    f.rec("recon.period.closed", "period", `${provider}:${day}`, before, {
      state: "closed",
    });
  } else {
    need(b.reason?.trim(), 422, "reason_required");
    need(before.state === "closed", 409, "conflict");
    await set("reopened", b.reason);
    f.rec(
      "recon.period.reopened",
      "period",
      `${provider}:${day}`,
      before,
      { state: "reopened" },
      b.reason,
    );
  }
  return overview(f, w, provider, month ? `${day}-01` : day);
}

/** Verify-now over suggested lines whose reference names a provider-pending payment (missed webhook). */
export async function verifyPendingLines(f: Fin, provider?: Provider) {
  const w = await world(f.db);
  let n = 0;
  for (const l of w.lines.filter(
    (x) =>
      x.match === "suggested" &&
      (!provider || importOf(w, x)?.provider === provider),
  )) {
    const p = l.suggestionId
      ? w.pays.find((x) => x.id === l.suggestionId)
      : undefined;
    if (
      !p ||
      p.state !== "pending_provider" ||
      isLockedIn(w, importOf(w, l).provider, dayOf(l.occurredAt))
    )
      continue;
    const ref = refOfP(p);
    if (!ref || ref !== l.externalRef) continue; // amount-only suggestions need a person (Accept)
    const before = await settle(f, p, l.amount, "poll");
    l.match = "matched";
    l.paymentId = p.id;
    p.reconciliationId = l.id;
    await savePay(f.db, p);
    await touchLine(f, w, l);
    n++;
    f.rec(
      "payment.confirmed",
      "payment",
      p.id,
      before,
      { state: p.state },
      "verify_now",
    );
  }
  return { confirmed: n };
}

export const NEEDS: MatchState[] = [
  "unmatched",
  "suggested",
  "exception",
  "duplicate",
];
