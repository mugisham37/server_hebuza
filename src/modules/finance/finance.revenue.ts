// Finance revenue + payouts (U13–U14): allocations (review → approve), revenue rules (effective-dated, executive deviation),
// adjustments (four-eyes), agent fees, payout batches (preview → draft → submit → authorise → execute → paid → close),
// line outcomes and bank/MoMo/WHT export files. Port of src/mocks/handlers-finance-e.ts onto finance_records.
import { createHash } from "node:crypto";
import type { Tx as Exec } from "../../core/db/db";
import { allocate, payoutLine, splitPool } from "@/domain/finance/money";
import {
  adjustmentChain,
  batchChain,
  canSign,
  ruleChain,
  sign,
} from "@/domain/finance/approvals";
import { canMove } from "@/domain/finance/states";
import { isRetroactive, resolveRule, rulesOverlap, withServiceDefault } from "@/domain/finance/rules";
import { eq } from "drizzle-orm";
import { services } from "@/db/schema";
import { batchNo } from "@/domain/finance/numbering";
import type {
  AdjReason,
  Adjustment,
  AgentFee,
  Allocation,
  CreditNote,
  ExportFile,
  PayoutBatch,
  PayoutLine,
  Rule,
  Step,
  UserRef,
} from "@/domain/finance/types";
import type {
  AdjView,
  AllocView,
  BatchView,
  FeeView,
  LineView,
  Preview,
  RuleView,
  Who,
} from "./lib/views";
import {
  POLICY,
  all,
  checkRev,
  fail,
  isExec,
  isFinanceUser,
  need,
  nowIso,
  one,
  put,
  refOf,
  sum,
  today,
  type Actor,
  type Fin,
  where,
} from "./finance.store";
import type { Inv } from "./finance.billing";
import { postAllocation, postPayoutLine } from "../ledger/ledger.postings";

export type Alloc = Allocation & {
  rev?: number;
  last?: { by: string; at: string };
  queryNote?: string;
};
export type RuleRec = Rule & { chain?: Step[] };
export type Adj = Adjustment & {
  chain: Step[];
  createdBy: UserRef;
  at: string;
};
type LineMeta = {
  parts: LineView["parts"];
  carriedIn: number;
  taxable: number;
  failReason?: string;
  paidAt?: string;
  carriedFrom: string[];
  consumed?: boolean;
};
export type Batch = PayoutBatch & {
  /** F-REV-07: MTN disbursement reference while the transfer is in flight. */
  momoRef?: string;
  chain: Step[];
  rev: number;
  last?: { by: string; at: string };
  rejectNote?: string;
  statementsAt?: number;
  meta: Record<string, LineMeta>;
};
export type Dest = PayoutLine["destination"] & {
  id: string;
  method: PayoutLine["method"];
};

const month = (iso: string) => iso.slice(0, 7);
export const saveAlloc = (db: Exec, a: Alloc) =>
  put(db, "allocation", a.id, a, a.caseRef);
const saveRule = (db: Exec, r: RuleRec) => put(db, "rule", r.id, r);
const saveAdj = (db: Exec, a: Adj) =>
  put(db, "adjustment", a.id, a, a.workerId);
const saveFee = (db: Exec, x: AgentFee) => put(db, "fee", x.id, x, x.workerId);
export const saveBatch = (db: Exec, b: Batch) =>
  put(db, "batch", b.no, b, b.period);
const who = (f: Fin, id: string): Who => ({
  id,
  name: f.D.workerName(id),
  kind: f.D.workerKind(id),
});
/** Export file checksum (SHA-256, first 8 hex, uppercase) so finance can match the uploaded bank file. */
const checksum = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 8).toUpperCase();

// ---------------------------------------------------------------- allocations
const allocCan = (a: Allocation, me: Actor) => {
  const fin = isFinanceUser(me),
    exec = isExec(me);
  return {
    approve: (fin || exec) && a.status === "reviewed",
    query: fin && a.status === "reviewed",
    hold: fin && canMove("allocation", a.status, "on_hold"),
    void: fin && canMove("allocation", a.status, "voided"),
    answer: fin && a.question?.status === "open",
  };
};
type RevWorld = { rules: RuleRec[]; invs: Inv[]; cns: CreditNote[] };
async function revWorld(db: Exec): Promise<RevWorld> {
  const [rules, invs, cns] = await Promise.all([
    all<RuleRec>(db, "rule"),
    all<Inv>(db, "invoice"),
    all<CreditNote>(db, "credit_note"),
  ]);
  return { rules, invs, cns };
}
function allocView(f: Fin, w: RevWorld, a: Alloc): AllocView {
  const c = f.D.caseOf(a.caseRef);
  const invs = w.invs.filter((i) => a.invoiceNos.includes(i.no ?? ""));
  const rule = w.rules.find((r) => r.id === a.ruleId);
  const approved = ["approved_for_payment", "in_batch", "paid"].includes(
    a.status,
  );
  const { rev: _r, last: _l, queryNote: _q, ...rest } = a;
  return {
    ...rest,
    serviceName: c ? f.D.serviceName(c.service) : "—",
    clientName: c ? f.D.clientName(c.clientId) : "—",
    completedAt: a.frozenAt,
    shares: a.shares.map((s) => ({ ...s, name: f.D.workerName(s.workerId) })),
    rule: {
      scope: rule?.scope ?? "global",
      from: rule?.from ?? "",
      to: rule?.to,
    },
    credits: sum(
      w.cns.filter((n) => a.invoiceNos.includes(n.invoiceNo)),
      (n) => Math.abs(n.eligible),
    ),
    five: {
      invoiced: sum(invs, (i) => i.totals.total),
      collected: sum(invs, (i) => i.amountPaid),
      allocated: a.pool,
      approved: approved ? a.pool : 0,
      paid: a.status === "paid" ? a.pool : 0,
    },
    rev: a.rev ?? 1,
    last: a.last,
    can: allocCan(a, f.me),
    waitingFor: a.status === "pending_review" ? "Service manager" : undefined,
  } as AllocView;
}
export async function listAllocations(
  f: Fin,
  q: { state?: string; agent?: string; period?: string },
) {
  const [allocs, w] = await Promise.all([
    all<Alloc>(f.db, "allocation"),
    revWorld(f.db),
  ]);
  const inPeriod = allocs.filter(
    (a) => !q.period || month(a.frozenAt) === q.period,
  );
  const items = inPeriod
    .filter(
      (a) =>
        (!q.state || a.status === q.state) &&
        (!q.agent || a.shares.some((s) => s.workerId === q.agent)),
    )
    .sort((x, y) => y.frozenAt.localeCompare(x.frozenAt))
    .map((a) => allocView(f, w, a));
  const tile = (s: Allocation["status"]) => {
    const xs = inPeriod.filter((a) => a.status === s);
    return { amount: sum(xs, (a) => a.pool), n: xs.length };
  };
  return {
    items,
    meta: {
      tiles: {
        pending_review: tile("pending_review"),
        reviewed: tile("reviewed"),
        approved_for_payment: tile("approved_for_payment"),
        paid: tile("paid"),
      },
      periods: [...new Set(allocs.map((a) => month(a.frozenAt)))]
        .sort()
        .reverse(),
      agents: [
        ...new Set(allocs.flatMap((a) => a.shares.map((s) => s.workerId))),
      ]
        .map((id) => ({ id, name: f.D.workerName(id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}
async function approveOne(f: Fin, a: Alloc, reason: string) {
  const before = { status: a.status };
  a.status = "approved_for_payment";
  a.approvedBy = refOf(f.me);
  a.rev = (a.rev ?? 1) + 1;
  a.last = { by: f.me.name, at: nowIso() };
  await saveAlloc(f.db, a);
  await postAllocation(f.deps.ledger,f.db, a.id, a.pool, f.me.id);
  f.rec(
    "allocation.approved",
    "allocation",
    a.id,
    before,
    { status: a.status },
    reason,
  );
}
/** U4 bulk approve; `preview` returns the server total for the confirm dialog. Any non-reviewed pick fails the whole call. */
export async function bulkApprove(
  f: Fin,
  b: { ids: string[]; preview?: boolean },
) {
  const allocs = await all<Alloc>(f.db, "allocation");
  const picked = allocs.filter((x) => b.ids.includes(x.id));
  need(b.ids.length && picked.length === b.ids.length, 422, "validation");
  if (b.preview)
    return { count: picked.length, total: sum(picked, (x) => x.pool) };
  if (picked.some((x) => x.status !== "reviewed"))
    throw fail(
      409,
      picked.some((x) =>
        ["approved_for_payment", "in_batch", "paid"].includes(x.status),
      )
        ? "version_conflict"
        : "not_reviewed",
    );
  const batch = `bulk-${Date.now().toString(36)}`;
  for (const x of picked) await approveOne(f, x, `batch_id=${batch}`);
  return {
    approved: picked.map((x) => x.id),
    total: sum(picked, (x) => x.pool),
    skipped: [] as string[],
  };
}
export type AllocAction =
  "approve" | "query" | "hold" | "void" | "release" | "answer";
export async function allocationAction(
  f: Fin,
  id: string,
  action: AllocAction,
  b: { rev?: number; reason?: string; note?: string; text?: string },
) {
  const al = await one<Alloc>(f.db, "allocation", id, true);
  if (!al) throw fail(404, "not_found");
  checkRev(al.rev ?? 1, b.rev);
  const before = { status: al.status, question: al.question };
  if (action === "answer") {
    need(al.question?.status === "open", 409, "conflict");
    need(b.text?.trim(), 422, "reason_required");
    al.question = { ...al.question!, status: "answered" };
    f.rec(
      "allocation.question.answered",
      "allocation",
      al.id,
      before,
      { question: al.question },
      b.text,
    );
  } else if (action === "approve") {
    need(isFinanceUser(f.me) || isExec(f.me), 403, "forbidden");
    need(al.status === "reviewed", 422, "not_reviewed");
    await approveOne(f, al, b.reason ?? "");
    return allocView(f, await revWorld(f.db), al);
  } else {
    need(isFinanceUser(f.me), 403, "forbidden");
    const to = (
      {
        query: "pending_review",
        hold: "on_hold",
        void: "voided",
        release: "pending_review",
      } as const
    )[action];
    if (action === "release") need(al.status === "on_hold", 409, "conflict");
    else need(canMove("allocation", al.status, to), 409, "conflict");
    need((b.reason ?? b.note)?.trim(), 422, "reason_required");
    al.status = to;
    if (action === "query") {
      al.queryNote = b.note;
      al.reviewedBy = undefined;
    }
    f.rec(
      "allocation.adjusted",
      "allocation",
      al.id,
      before,
      { status: al.status },
      b.reason ?? b.note,
    );
  }
  al.rev = (al.rev ?? 1) + 1;
  al.last = { by: f.me.name, at: nowIso() };
  await saveAlloc(f.db, al);
  return allocView(f, await revWorld(f.db), al);
}

// ---------------------------------------------------------------- rules
const scopeLabel = (f: Fin, r: Rule) =>
  r.scope === "global"
    ? ""
    : r.scope === "service"
      ? f.D.serviceName(r.serviceSlug ?? "")
      : r.scope === "agent"
        ? f.D.workerName(r.agentId ?? "")
        : r.scope === "agent_service"
          ? `${f.D.workerName(r.agentId ?? "")} · ${f.D.serviceName(r.serviceSlug ?? "")}`
          : (r.contractId ?? "");
function ruleView(f: Fin, r: RuleRec): RuleView {
  const chain = r.chain ?? [];
  const proposer = chain[0]?.signedBy?.id ?? "";
  const { chain: _c, ...rest } = r;
  return {
    ...rest,
    label: scopeLabel(f, r),
    agentName: r.agentId ? f.D.workerName(r.agentId) : undefined,
    serviceName: r.serviceSlug ? f.D.serviceName(r.serviceSlug) : undefined,
    chain,
    can: {
      approve:
        r.status === "pending_approval" && isExec(f.me) && f.me.id !== proposer,
      end:
        isFinanceUser(f.me) &&
        r.scope !== "global" &&
        (r.status === "active" || r.status === "scheduled") &&
        !r.to,
    },
  };
}
export async function listRules(f: Fin) {
  const rules = await all<RuleRec>(f.db, "rule");
  return {
    items: rules
      .sort((a, b) => a.from.localeCompare(b.from))
      .map((r) => ruleView(f, r)),
    defaultBps: POLICY.defaultAgentBps,
    services: f.D.services.map((s) => ({ slug: s.slug, name: s.name })),
    agents: f.D.workers.map((a) => ({ id: a.id, name: a.name })),
  };
}
export async function previewRule(
  f: Fin,
  q: {
    scope?: string;
    agentId?: string;
    serviceSlug?: string;
    contractId?: string;
    pct?: string;
    from?: string;
  },
) {
  const rules = await all<RuleRec>(f.db, "rule");
  const cand: Rule = {
    id: "preview",
    scope: (q.scope ?? "service") as Rule["scope"],
    agentId: q.agentId,
    serviceSlug: q.serviceSlug,
    contractId: q.contractId,
    agentPct: Number(q.pct ?? 0),
    appliesTo: "both",
    from: q.from ?? today(),
    status: "scheduled",
  };
  const open = f.D.cases.filter(
    (c) => !["completed_delivered", "closed", "cancelled"].includes(c.status),
  );
  const affected = open.filter((c) => {
    try {
      return (
        resolveRule([...rules, cand], {
          agentId: c.assignees.find((a) => a.role === "lead")?.id,
          serviceSlug: c.service,
          date: cand.from,
        }).id === "preview"
      );
    } catch {
      return false;
    }
  }).length;
  let current: Rule | undefined = rules.find((r) => r.scope === "global");
  try {
    current = resolveRule(rules, {
      agentId: cand.agentId,
      serviceSlug: cand.serviceSlug,
      contractId: cand.contractId,
      date: cand.from,
    });
  } catch {
    /* no override: the global rule applies */
  }
  const ex = allocate(100_000, [], cand.agentPct);
  return {
    affected,
    overlap: rulesOverlap(rules, cand),
    retroactive: isRetroactive(cand.from, today()),
    current: {
      pct: current?.agentPct ?? POLICY.defaultAgentBps,
      label:
        !current || current.scope === "global"
          ? "global"
          : scopeLabel(f, current),
    },
    needsExec: cand.agentPct !== POLICY.defaultAgentBps,
    example: { eligible: 100_000, pool: ex.pool, hebuza: ex.hebuza },
  };
}
export async function createRule(
  f: Fin,
  b: Partial<Rule> & { reason?: string },
) {
  const pct = Number(b.agentPct);
  need(Number.isInteger(pct) && pct >= 0 && pct <= 10_000, 422, "validation");
  need(b.scope && b.scope !== "global" && b.from, 422, "validation");
  need(b.scope !== "service" || b.serviceSlug, 422, "validation");
  need(
    !["agent", "agent_service"].includes(b.scope!) || b.agentId,
    422,
    "validation",
  );
  need(b.scope !== "agent_service" || b.serviceSlug, 422, "validation");
  need(b.scope !== "contract" || b.contractId?.trim(), 422, "validation");
  need(b.reason?.trim(), 422, "reason_required");
  need(!isRetroactive(b.from!, today()), 422, "retroactive");
  const rules = await all<RuleRec>(f.db, "rule");
  const exec = pct !== POLICY.defaultAgentBps;
  const r: RuleRec = {
    id: `r-${Date.now().toString(36)}`,
    scope: b.scope!,
    serviceSlug: b.serviceSlug,
    agentId: b.agentId,
    contractId: b.contractId,
    agentPct: pct,
    appliesTo: b.appliesTo ?? "both",
    from: b.from!.slice(0, 10),
    to: b.to,
    status: exec
      ? "pending_approval"
      : b.from! <= today()
        ? "active"
        : "scheduled",
    note: b.reason,
    chain: sign(ruleChain(pct, POLICY.defaultAgentBps as never), f.me, nowIso()),
  };
  if (rulesOverlap(rules, r)) throw fail(409, "rule_overlap");
  await saveRule(f.db, r);
  f.rec(
    "rate.changed",
    "rule",
    r.id,
    null,
    { scope: r.scope, agentPct: r.agentPct, from: r.from, status: r.status },
    b.reason,
  );
  return ruleView(f, r);
}
/** REV §8: a rule is only ever end-dated; every other field is frozen. */
export async function endRule(
  f: Fin,
  id: string,
  b: { to?: string; reason?: string; [k: string]: unknown },
) {
  const r = await one<RuleRec>(f.db, "rule", id, true);
  if (!r) throw fail(404, "not_found");
  need(
    Object.keys(b).every((k) => k === "to" || k === "reason") && b.to,
    422,
    "validation",
  );
  need(r.scope !== "global", 422, "validation");
  need(!isRetroactive(b.to!, today()) && b.to! >= r.from, 422, "retroactive");
  need(b.reason?.trim(), 422, "reason_required");
  const before = { to: r.to };
  r.to = b.to!.slice(0, 10);
  await saveRule(f.db, r);
  f.rec("rate.changed", "rule", r.id, before, { to: r.to }, b.reason);
  return ruleView(f, r);
}
export async function decideRule(
  f: Fin,
  id: string,
  decision: "approve" | "reject",
  b: { reason?: string },
) {
  const r = await one<RuleRec>(f.db, "rule", id, true);
  if (!r) throw fail(404, "not_found");
  need(r.status === "pending_approval", 409, "conflict");
  need(isExec(f.me), 403, "forbidden");
  const c = canSign(r.chain ?? [], f.me, []);
  if (!c.ok)
    throw fail(
      403,
      c.reason === "same_approver" ? "same_approver" : "forbidden",
    );
  const before = { status: r.status };
  if (decision === "reject") {
    need(b.reason?.trim(), 422, "reason_required");
    r.status = "ended";
    r.to = r.from;
    r.note = b.reason;
  } else {
    r.chain = sign(r.chain ?? [], f.me, nowIso());
    r.status = r.from <= today() ? "active" : "scheduled";
    r.approvedBy = refOf(f.me);
  }
  await saveRule(f.db, r);
  f.rec("rate.changed", "rule", r.id, before, { status: r.status }, b.reason);
  return ruleView(f, r);
}

/**
 * Allocation for a delivered, fully paid, undisputed case (F-REV-03): eligible fee × the rule in force on the completion
 * date, split lead 70 / helper 30. Called by ops when a case is delivered (integrator hook) and idempotent per case.
 */
export async function allocateCase(f: Fin, caseRef: string) {
  const c = f.D.caseOf(caseRef);
  if (!c || c.status !== "completed_delivered" || c.disputed) return null;
  const allocs = await all<Alloc>(f.db, "allocation");
  if (allocs.some((a) => a.caseRef === caseRef && a.status !== "voided"))
    return null;
  const invs = (await all<Inv>(f.db, "invoice")).filter(
    (i) => i.caseRef === caseRef && i.no,
  );
  if (
    !invs.length ||
    !invs.every((i) =>
      ["paid", "paid_by_plan", "void", "credited"].includes(i.status),
    )
  )
    return null;
  const rules = await all<RuleRec>(f.db, "rule");
  const eligible = sum(
    invs.filter((i) => i.status !== "void"),
    (i) => i.totals.eligible,
  );
  const rule = resolveRule(rules, {
    agentId: c.assignees.find((a) => a.role === "lead")?.id,
    serviceSlug: c.service,
    date: c.updatedAt,
  });
  const [svc] = await f.db.select({ bps: services.revenueAgentBps }).from(services).where(eq(services.slug, c.service));
  const eff = withServiceDefault(rule, c.service, svc?.bps);
  const { netBase, pool, hebuza } = allocate(eligible, [], eff.agentPct);
  const split =
    c.assignees.length > 1
      ? c.assignees.map((a) => ({
          workerId: a.id,
          bps: a.role === "lead" ? 7000 : 3000,
        }))
      : c.assignees.map((a) => ({ workerId: a.id, bps: 10_000 }));
  const amounts = splitPool(pool, split);
  const a: Alloc = {
    id: `al-${Date.now().toString(36)}`,
    caseRef,
    invoiceNos: invs.map((i) => i.no!),
    eligible,
    deductions: [],
    netBase,
    ruleId: eff.ruleId,
    agentPct: eff.agentPct,
    pool,
    hebuza,
    shares: split.map((s, i) => ({
      workerId: s.workerId,
      kind: f.D.workerKind(s.workerId),
      pct: s.bps,
      amount: amounts[i].amount,
    })),
    status: "pending_review",
    frozenAt: c.updatedAt,
    rev: 1,
  };
  await saveAlloc(f.db, a);
  f.rec(
    "allocation.created",
    "allocation",
    a.id,
    null,
    { pool, rule: eff.ruleId },
    null,
  );
  return a;
}

// ---------------------------------------------------------------- adjustments + fees
function adjView(f: Fin, a: Adj, allocs: Alloc[]): AdjView {
  const al = a.allocationId
    ? allocs.find((x) => x.id === a.allocationId)
    : undefined;
  return {
    ...a,
    workerName: f.D.workerName(a.workerId),
    caseRef: al?.caseRef,
    chain: a.chain ?? [],
    createdBy: a.createdBy,
    at: a.at,
    can: {
      approve:
        a.status === "proposed" &&
        (a.chain?.length ?? 0) > 0 &&
        canSign(a.chain, f.me, [a.createdBy.id]).ok,
    },
  };
}
export async function listAdjustments(f: Fin) {
  const [adjs, allocs] = await Promise.all([
    all<Adj>(f.db, "adjustment"),
    all<Alloc>(f.db, "allocation"),
  ]);
  return {
    items: adjs
      .sort((x, y) => y.at.localeCompare(x.at))
      .map((a) => adjView(f, a, allocs)),
    workers: f.D.workers.map((a) => who(f, a.id)),
  };
}
export async function createAdjustment(
  f: Fin,
  b: {
    workerId?: string;
    amount?: number;
    reason?: AdjReason;
    note?: string;
    allocationId?: string;
  },
) {
  need(
    b.workerId && f.D.workers.some((a) => a.id === b.workerId),
    422,
    "validation",
  );
  need(Number.isInteger(b.amount) && b.amount !== 0, 422, "validation");
  // Refund-linked adjustments are created by the refund flow (D-16), never by hand.
  need(
    b.reason && ["correction", "bonus", "clawback", "other"].includes(b.reason),
    422,
    "validation",
  );
  need(b.note?.trim(), 422, "reason_required");
  const base: Adjustment = {
    id: `adj-${Date.now().toString(36)}`,
    workerId: b.workerId!,
    amount: b.amount!,
    reason: b.reason!,
    note: b.note!.trim(),
    allocationId: b.allocationId,
    status: "proposed",
  };
  const a: Adj = {
    ...base,
    chain: sign(adjustmentChain(base), f.me, nowIso()),
    createdBy: refOf(f.me),
    at: nowIso(),
  };
  await saveAdj(f.db, a);
  f.rec(
    "allocation.adjusted",
    "adjustment",
    a.id,
    null,
    {
      workerId: a.workerId,
      amount: a.amount,
      reason: a.reason,
      status: a.status,
    },
    a.note,
  );
  return adjView(f, a, []);
}
export async function approveAdjustment(f: Fin, id: string) {
  const a = await one<Adj>(f.db, "adjustment", id, true);
  if (!a) throw fail(404, "not_found");
  need(a.status === "proposed", 409, "conflict");
  const c = canSign(a.chain, f.me, [a.createdBy.id]);
  if (!c.ok)
    throw fail(
      403,
      c.reason === "same_approver" ? "same_approver" : "forbidden",
    );
  a.chain = sign(a.chain, f.me, nowIso());
  a.status = "approved";
  a.approvedBy = refOf(f.me);
  await saveAdj(f.db, a);
  f.rec(
    "allocation.adjusted",
    "adjustment",
    a.id,
    { status: "proposed" },
    { status: a.status },
  );
  return adjView(f, a, []);
}
const feeView = (f: Fin, x: AgentFee): FeeView => ({
  ...x,
  workerName: f.D.workerName(x.workerId),
});
export async function listFees(f: Fin) {
  const fees = await all<AgentFee>(f.db, "fee");
  return {
    items: fees
      .sort((x, y) => y.month.localeCompare(x.month))
      .map((x) => feeView(f, x)),
    workers: f.D.workers.filter((a) => a.external).map((a) => who(f, a.id)),
    monthly: f.S.licence_fee_monthly,
  };
}
export async function createFee(
  f: Fin,
  b: {
    workerId?: string;
    kind?: AgentFee["kind"];
    amount?: number;
    month?: string;
  },
) {
  need(
    b.workerId && f.D.workerKind(b.workerId) === "external",
    422,
    "validation",
  );
  need(
    Number.isInteger(b.amount) &&
      b.amount! > 0 &&
      b.kind &&
      /^\d{4}-\d{2}$/.test(b.month ?? ""),
    422,
    "validation",
  );
  const fees = await all<AgentFee>(f.db, "fee");
  need(
    !fees.some(
      (x) =>
        x.workerId === b.workerId && x.month === b.month && x.kind === b.kind,
    ),
    409,
    "conflict",
  );
  const x: AgentFee = {
    id: `fee-${b.workerId}-${b.kind}-${b.month}`,
    workerId: b.workerId!,
    kind: b.kind!,
    amount: b.amount!,
    month: b.month!,
    status: "due",
  };
  await saveFee(f.db, x);
  f.rec("allocation.adjusted", "fee", x.id, null, { ...x });
  return feeView(f, x);
}
export async function waiveFee(f: Fin, id: string, b: { reason?: string }) {
  const x = await one<AgentFee>(f.db, "fee", id, true);
  if (!x) throw fail(404, "not_found");
  need(x.status === "due", 409, "conflict");
  need(b.reason?.trim(), 422, "reason_required");
  x.status = "waived";
  await saveFee(f.db, x);
  f.rec(
    "allocation.adjusted",
    "fee",
    x.id,
    { status: "due" },
    { status: "waived" },
    b.reason,
  );
  return feeView(f, x);
}

/** Agent-side view (REV AC: an agent sees only their own shares). */
export async function agentMoney(f: Fin, workerId: string) {
  const [allocs, batches, adjs] = await Promise.all([
    all<Alloc>(f.db, "allocation"),
    all<Batch>(f.db, "batch"),
    all<Adj>(f.db, "adjustment"),
  ]);
  return {
    allocations: allocs
      .filter((a) => a.shares.some((s) => s.workerId === workerId))
      .map(({ rev: _r, last: _l, queryNote: _q, ...a }) => ({
        ...a,
        shares: a.shares.filter((s) => s.workerId === workerId),
      })),
    payouts: batches.flatMap((b) =>
      b.lines
        .filter((l) => l.workerId === workerId)
        .map((l) => ({
          batchNo: b.no,
          period: b.period,
          batchStatus: b.status,
          ...lineView(f, b, l),
        })),
    ),
    adjustments: adjs
      .filter((a) => a.workerId === workerId)
      .map(({ chain: _c, createdBy: _b, at: _a, ...a }) => a),
  };
}

// ---------------------------------------------------------------- payouts
function sumTotals(
  lines: {
    status: string;
    gross: number;
    adjustments: number;
    fees: number;
    wht: number;
    net: number;
    carryForward: number;
  }[],
): PayoutBatch["totals"] {
  const live = lines.filter((l) => l.status !== "excluded");
  const s = (
    k: "gross" | "adjustments" | "fees" | "wht" | "net" | "carryForward",
  ) => sum(live, (l) => l[k]);
  return {
    gross: s("gross"),
    adjustments: s("adjustments"),
    fees: s("fees"),
    wht: s("wht"),
    net: s("net"),
    carried: s("carryForward"),
  };
}
function lineView(f: Fin, b: Batch, l: PayoutLine): LineView {
  const m = b.meta?.[l.id];
  return {
    ...l,
    name: f.D.workerName(l.workerId),
    kind: f.D.workerKind(l.workerId),
    taxable: m?.taxable ?? l.gross + l.adjustments,
    carriedIn: m?.carriedIn ?? 0,
    parts: m?.parts ?? { allocations: [], adjustments: [], fees: [] },
    failReason: m?.failReason,
    paidAt: m?.paidAt,
  } as LineView;
}
function batchView(f: Fin, b: Batch, batches: Batch[]): BatchView {
  const prev = batches
    .filter((x) => x.period < b.period && x.status === "closed")
    .sort((x, y) => y.period.localeCompare(x.period))[0];
  const fin = isFinanceUser(f.me),
    isPrep = f.me.id === b.preparedBy.id;
  const sc = canSign(b.chain, f.me, [b.preparedBy.id]);
  const statementsReady =
    b.statementsAt !== undefined && Date.now() > b.statementsAt;
  const {
    chain,
    rev,
    last,
    rejectNote,
    statementsAt: _s,
    meta: _m,
    ...rest
  } = b;
  return {
    ...rest,
    lines: b.lines.map((l) => lineView(f, b, l)),
    chain,
    agents: b.lines.filter((l) => l.status !== "excluded").length,
    rev,
    last,
    vsLast: prev
      ? {
          net: prev.totals.net,
          pct: prev.totals.net
            ? Math.round(
                ((b.totals.net - prev.totals.net) * 100) / prev.totals.net,
              )
            : 0,
        }
      : null,
    rejectNote,
    statements:
      b.status === "closed" && b.statementsAt !== undefined
        ? statementsReady
          ? "ready"
          : "running"
        : undefined,
    can: {
      submit: fin && b.status === "draft",
      authorise: b.status === "submitted" && sc.ok,
      reject: b.status === "submitted" && sc.ok,
      execute: fin && b.status === "authorised",
      mark: fin && b.status === "executing",
      close: fin && (b.status === "paid" || b.status === "partially_paid"),
      exclude: fin && b.status === "draft",
      export:
        (fin || isExec(f.me)) &&
        [
          "authorised",
          "executing",
          "paid",
          "partially_paid",
          "closed",
        ].includes(b.status),
    },
    whyNot:
      b.status !== "submitted"
        ? "status"
        : isPrep
          ? "preparer"
          : sc.ok
            ? undefined
            : "role",
  } as BatchView;
}

type Built = {
  lines: (PayoutLine & { meta: LineMeta })[];
  blockers: Preview["blockers"];
};
async function buildLines(
  f: Fin,
  period: string,
  excluded: string[],
  no: string,
): Promise<Built> {
  const [allocs, adjs, fees, batches, dests] = await Promise.all([
    all<Alloc>(f.db, "allocation"),
    all<Adj>(f.db, "adjustment"),
    all<AgentFee>(f.db, "fee"),
    all<Batch>(f.db, "batch"),
    all<Dest>(f.db, "destination"),
  ]);
  const push = <T>(m: Map<string, T[]>, k: string, v: T) =>
    m.set(k, [...(m.get(k) ?? []), v]);
  const gross = new Map<
    string,
    { id: string; caseRef: string; amount: number }[]
  >();
  for (const a of allocs)
    if (a.status === "approved_for_payment" && month(a.frozenAt) <= period)
      for (const s of a.shares)
        push(gross, s.workerId, {
          id: a.id,
          caseRef: a.caseRef,
          amount: s.amount,
        });
  const adj = new Map<
    string,
    { id: string; amount: number; reason: string }[]
  >();
  for (const a of adjs)
    if (a.status === "approved")
      push(adj, a.workerId, { id: a.id, amount: a.amount, reason: a.reason });
  const feeM = new Map<
    string,
    { id: string; month: string; amount: number }[]
  >();
  for (const x of fees)
    if (
      x.status === "due" &&
      x.month <= period &&
      f.D.workerKind(x.workerId) === "external"
    )
      push(feeM, x.workerId, { id: x.id, month: x.month, amount: x.amount });
  const carry = new Map<string, { id: string; amount: number }[]>();
  for (const b of batches)
    for (const l of b.lines) {
      const m = b.meta?.[l.id];
      if (m?.consumed || b.status !== "closed") continue;
      // Failed line → its pre-tax amount comes back as a positive carry-in; a negative net carries its shortfall.
      if (l.status === "failed")
        push(carry, l.workerId, { id: l.id, amount: m?.taxable ?? l.net });
      else if (l.carryForward < 0)
        push(carry, l.workerId, { id: l.id, amount: l.carryForward });
    }
  const destOf = (id: string) =>
    dests.find((d) => d.id === id) ?? {
      id,
      method: "mtn_momo" as const,
      masked: "•••• 0000",
      verified: false,
    };
  const workers = [
    ...new Set([...gross.keys(), ...adj.keys(), ...carry.keys()]),
  ].sort((x, y) => f.D.workerName(x).localeCompare(f.D.workerName(y)));
  const blockers: Preview["blockers"] = [];
  const lines = workers.map((w, i) => {
    const g = sum(gross.get(w) ?? [], (x) => x.amount),
      ad = sum(adj.get(w) ?? [], (x) => x.amount),
      fe = sum(feeM.get(w) ?? [], (x) => x.amount),
      ci = sum(carry.get(w) ?? [], (x) => x.amount);
    const external = f.D.workerKind(w) === "external";
    const r = payoutLine({
      gross: g,
      adjustments: ad,
      fees: fe,
      external,
      carried: ci,
      whtBps: f.S.wht_bps,
    });
    const d = destOf(w);
    const out = excluded.includes(w);
    if (!out && !d.verified)
      blockers.push({
        workerId: w,
        name: f.D.workerName(w),
        kind: "unverified",
      });
    else if (!out && d.coolingUntil && Date.parse(d.coolingUntil) > Date.now())
      blockers.push({
        workerId: w,
        name: f.D.workerName(w),
        kind: "cooling",
        until: d.coolingUntil,
      });
    return {
      id: `pl-${no}-${i}`,
      workerId: w,
      gross: g,
      adjustments: ad,
      fees: r.fees,
      wht: r.wht,
      net: r.net,
      carryForward: r.carryForward,
      method: d.method,
      destination: {
        masked: d.masked,
        verified: d.verified,
        coolingUntil: d.coolingUntil,
      },
      status: out ? ("excluded" as const) : ("pending" as const),
      meta: {
        parts: {
          allocations: gross.get(w) ?? [],
          adjustments: adj.get(w) ?? [],
          fees: external ? (feeM.get(w) ?? []) : [],
        },
        carriedIn: ci,
        taxable: r.taxable,
        carriedFrom: (carry.get(w) ?? []).map((x) => x.id),
      },
    };
  });
  return { lines, blockers };
}
const periodNo = (period: string, runNo: number) =>
  batchNo(Number(period.slice(0, 4)), Number(period.slice(5, 7)), runNo);

export async function listBatches(f: Fin) {
  const batches = await all<Batch>(f.db, "batch");
  return {
    items: batches
      .sort((x, y) => y.no.localeCompare(x.no))
      .map((b) => batchView(f, b, batches)),
    payoutDay: f.S.payout_day,
  };
}
export async function previewBatch(
  f: Fin,
  q: { period?: string; run?: string; excluded?: string },
): Promise<Preview> {
  const period =
    q.period && /^\d{4}-\d{2}$/.test(q.period) ? q.period : today().slice(0, 7);
  const no = periodNo(period, Number(q.run ?? 1) || 1);
  const d = await buildLines(
    f,
    period,
    (q.excluded ?? "").split(",").filter(Boolean),
    no,
  );
  const lines = d.lines.map(({ meta, ...l }) => ({
    ...l,
    name: f.D.workerName(l.workerId),
    kind: f.D.workerKind(l.workerId),
    taxable: meta.taxable,
    carriedIn: meta.carriedIn,
    parts: meta.parts,
  })) as LineView[];
  const exists = await one<Batch>(f.db, "batch", no);
  return {
    no,
    period,
    exists: exists ? no : null,
    lines,
    totals: sumTotals(lines),
    blockers: d.blockers,
  };
}
async function batchOr404(db: Exec, no: string) {
  const b = await one<Batch>(db, "batch", no, true);
  if (!b) throw fail(404, "not_found");
  return b;
}
export async function getBatch(f: Fin, no: string) {
  const b = await one<Batch>(f.db, "batch", no);
  if (!b) throw fail(404, "not_found");
  return batchView(f, b, await all<Batch>(f.db, "batch"));
}
export async function createBatch(
  f: Fin,
  b: { period?: string; run?: number; excluded?: string[] },
) {
  need(/^\d{4}-\d{2}$/.test(b.period ?? ""), 422, "validation");
  const no = periodNo(b.period!, b.run ?? 1);
  need(!(await one<Batch>(f.db, "batch", no, true)), 409, "conflict");
  const d = await buildLines(f, b.period!, b.excluded ?? [], no);
  need(d.blockers.length === 0, 422, "destination_unverified");
  need(
    d.lines.some((l) => l.status === "pending"),
    422,
    "empty_batch",
  );
  const lines = d.lines.map(({ meta: _m, ...l }) => l);
  const totals = sumTotals(lines);
  const batch: Batch = {
    no,
    period: b.period!,
    status: "draft",
    preparedBy: refOf(f.me),
    totals,
    lines,
    exports: [],
    chain: batchChain(totals.net, POLICY.payoutExecThreshold),
    rev: 1,
    meta: Object.fromEntries(d.lines.map((l) => [l.id, l.meta])),
  };
  await saveBatch(f.db, batch);
  f.rec("payout.prepared", "batch", no, null, {
    status: "draft",
    net: totals.net,
    lines: lines.length,
  });
  return batchView(f, batch, [batch]);
}

async function moveParts(
  f: Fin,
  batch: Batch,
  from: Allocation["status"],
  to: Allocation["status"],
) {
  for (const l of batch.lines)
    if (l.status !== "excluded") {
      const lm = batch.meta[l.id];
      for (const p of lm?.parts.allocations ?? []) {
        const a = await one<Alloc>(f.db, "allocation", p.id, true);
        if (a && a.status === from) {
          a.status = to;
          a.batchNo = to === "in_batch" ? batch.no : undefined;
          await saveAlloc(f.db, a);
        }
      }
      for (const p of lm?.parts.adjustments ?? []) {
        const a = await one<Adj>(f.db, "adjustment", p.id, true);
        if (a) {
          a.status = to === "in_batch" ? "in_batch" : "approved";
          await saveAdj(f.db, a);
        }
      }
    }
}
const bump = (f: Fin, b: Batch) => {
  b.rev++;
  b.last = { by: f.me.name, at: nowIso() };
  b.totals = sumTotals(b.lines);
};
const settleStatus = (b: Batch) => {
  if (b.lines.some((l) => l.status === "pending")) return;
  b.status = b.lines.some((l) => l.status === "failed")
    ? "partially_paid"
    : "paid";
};

export type BatchAction =
  "submit" | "authorise" | "reject" | "execute" | "close";
export async function batchAction(
  f: Fin,
  no: string,
  action: BatchAction,
  b: { rev?: number; reason?: string },
) {
  const batch = await batchOr404(f.db, no);
  checkRev(batch.rev, b.rev);
  const before = { status: batch.status };
  switch (action) {
    case "submit": {
      need(isFinanceUser(f.me), 403, "forbidden");
      need(
        batch.status === "draft" &&
          batch.lines.some((l) => l.status === "pending"),
        422,
        batch.status === "draft" ? "empty_batch" : "conflict",
      );
      need(
        batch.lines.every(
          (l) =>
            l.status === "excluded" ||
            (l.destination.verified &&
              !(
                l.destination.coolingUntil &&
                Date.parse(l.destination.coolingUntil) > Date.now()
              )),
        ),
        422,
        "destination_unverified",
      );
      batch.chain = sign(
        batchChain(batch.totals.net, POLICY.payoutExecThreshold),
        f.me,
        nowIso(),
      );
      batch.preparedBy = refOf(f.me);
      batch.status = "submitted";
      batch.rejectNote = undefined;
      await moveParts(f, batch, "approved_for_payment", "in_batch");
      break;
    }
    case "authorise":
    case "reject": {
      need(batch.status === "submitted", 409, "conflict");
      const c = canSign(batch.chain, f.me, [batch.preparedBy.id]);
      if (!c.ok)
        throw fail(
          403,
          c.reason === "same_approver" ? "same_approver" : "forbidden",
        );
      if (action === "reject") {
        need(b.reason?.trim(), 422, "reason_required");
        f.rec(
          "payout.rejected",
          "batch",
          batch.no,
          before,
          { status: "rejected" },
          b.reason,
        );
        batch.status = "draft";
        batch.rejectNote = b.reason;
        batch.chain = batchChain(batch.totals.net, POLICY.payoutExecThreshold);
        await moveParts(f, batch, "in_batch", "approved_for_payment");
      } else {
        batch.chain = sign(batch.chain, f.me, nowIso());
        if (batch.chain.every((s) => s.signedBy)) {
          batch.status = "authorised";
          batch.authorisedBy = refOf(f.me);
        }
      }
      break;
    }
    case "execute": {
      need(isFinanceUser(f.me), 403, "forbidden");
      need(batch.status === "authorised", 409, "conflict");
      batch.status = "executing";
      break;
    }
    case "close": {
      need(isFinanceUser(f.me), 403, "forbidden");
      need(
        batch.status === "paid" || batch.status === "partially_paid",
        409,
        "conflict",
      );
      const others = await all<Batch>(f.db, "batch");
      for (const l of batch.lines) {
        const lm = batch.meta[l.id];
        for (const id of lm?.carriedFrom ?? []) {
          const src = others.find((x) => x.lines.some((y) => y.id === id));
          if (src && src.no !== batch.no) {
            src.meta[id] = {
              ...(src.meta[id] ?? {
                parts: { allocations: [], adjustments: [], fees: [] },
                carriedIn: 0,
                taxable: 0,
                carriedFrom: [],
              }),
              consumed: true,
            };
            await saveBatch(f.db, src);
          }
        }
        if (l.status !== "paid") continue;
        for (const p of lm?.parts.allocations ?? []) {
          const a = await one<Alloc>(f.db, "allocation", p.id, true);
          if (a?.status === "in_batch") {
            a.status = "paid";
            await saveAlloc(f.db, a);
          }
        }
        for (const p of lm?.parts.adjustments ?? []) {
          const a = await one<Adj>(f.db, "adjustment", p.id, true);
          if (a) {
            a.status = "settled";
            await saveAdj(f.db, a);
          }
        }
        for (const p of lm?.parts.fees ?? []) {
          const x = await one<AgentFee>(f.db, "fee", p.id, true);
          if (x) {
            x.status = "netted";
            await saveFee(f.db, x);
          }
        }
      }
      batch.status = "closed";
      batch.statementsAt = Date.now() + 4_000; // agent statements are rendered by the statements job
      break;
    }
  }
  bump(f, batch);
  await saveBatch(f.db, batch);
  if (action !== "reject")
    f.rec(
      action === "authorise"
        ? "payout.approved"
        : `payout.${action === "submit" ? "submitted" : action === "execute" ? "executing" : "closed"}`,
      "batch",
      batch.no,
      before,
      { status: batch.status },
    );
  return batchView(f, batch, await all<Batch>(f.db, "batch"));
}

export async function lineAction(
  f: Fin,
  id: string,
  action: "exclude" | "paid" | "failed",
  b: { ref?: string; reason?: string; proofDocId?: string },
) {
  const batches = await all<Batch>(f.db, "batch");
  const found = batches.find((x) => x.lines.some((l) => l.id === id));
  if (!found) throw fail(404, "not_found");
  const batch = await batchOr404(f.db, found.no);
  const l = batch.lines.find((x) => x.id === id)!;
  const lm = batch.meta[l.id];
  const before = { status: l.status };
  if (action === "exclude") {
    need(batch.status === "draft" && l.status === "pending", 409, "conflict");
    need(b.reason?.trim(), 422, "reason_required");
    l.status = "excluded";
  } else {
    need(batch.status === "executing", 409, "conflict");
    // Idempotent per line: the same outcome twice returns the batch unchanged.
    if (l.status === action) return batchView(f, batch, batches);
    need(canMove("line", l.status, action), 409, "conflict");
    if (action === "paid") {
      need(b.ref?.trim(), 422, "validation");
      l.status = "paid";
      l.providerRef = b.ref!.trim();
      l.proofDocId = b.proofDocId;
      if (lm) lm.paidAt = nowIso();
      await postPayoutLine(
        f.deps.ledger,
        f.db,
        l.id,
        { net: l.net, wht: l.wht, fees: l.fees, method: l.method },
        f.me.id,
      );
    } else {
      need(b.reason?.trim(), 422, "reason_required");
      l.status = "failed";
      if (lm) lm.failReason = b.reason;
    }
    settleStatus(batch);
  }
  bump(f, batch);
  await saveBatch(f.db, batch);
  f.rec(
    action === "paid"
      ? "payout.paid"
      : action === "failed"
        ? "payout.failed"
        : "payout.line.excluded",
    "batch",
    batch.no,
    { line: l.id, ...before },
    { line: l.id, status: l.status, ref: l.providerRef },
    b.reason,
  );
  return batchView(
    f,
    batch,
    batches.map((x) => (x.no === batch.no ? batch : x)),
  );
}

/**
 * Bank / MoMo / WHT / summary file for an authorised batch. Content is returned inline (the UI saves it) with a checksum.
 * shortcut: every format is CSV text (WHT "pdf", summary "xlsx" names kept for the bank portal mapping); render real
 * PDF/XLSX through core/pdf and an XLSX writer when the bank confirms its template.
 */
export async function exportBatch(f: Fin, no: string, format: string) {
  const b = await batchOr404(f.db, no);
  need(["bank", "momo", "wht", "summary"].includes(format), 422, "validation");
  need(
    ["authorised", "executing", "paid", "partially_paid", "closed"].includes(
      b.status,
    ),
    409,
    "awaiting_executive",
  );
  const kind = format as ExportFile["kind"];
  const live = b.lines.filter((l) => l.status !== "excluded");
  const rows =
    kind === "bank"
      ? live.filter((l) => l.method === "bank")
      : kind === "momo"
        ? live.filter((l) => l.method !== "bank")
        : kind === "wht"
          ? live.filter((l) => l.wht > 0)
          : live;
  const head =
    kind === "wht"
      ? "name,tin,taxable,wht"
      : "name,destination,amount,reference";
  const content = [
    head,
    ...rows.map((l) =>
      kind === "wht"
        ? `${f.D.workerName(l.workerId)},PLACEHOLDER(agent-tin),${b.meta[l.id]?.taxable ?? 0},${l.wht}`
        : `${f.D.workerName(l.workerId)},${l.destination.masked},${l.net},${b.no}`,
    ),
  ].join("\n");
  const ext = kind === "wht" ? "pdf" : kind === "summary" ? "xlsx" : "csv";
  const file: ExportFile = {
    kind,
    name: `${b.no}_${kind.toUpperCase()}.${ext}`,
    checksum: checksum(content),
    at: nowIso(),
  };
  b.exports = [...b.exports.filter((e) => e.kind !== kind), file];
  await saveBatch(f.db, b);
  f.rec(
    "payout.exported",
    "batch",
    b.no,
    null,
    { file: file.name, checksum: file.checksum, rows: rows.length },
    undefined,
    "data",
  );
  return { ...file, content, rows: rows.length };
}

// ---------------------------------------------------------------- F-REV-07 MoMo disbursement (FinanceJobs drives it)
/** Pending MoMo lines of executing batches, with whether a transfer is already in flight. */
export async function momoLines(db: Exec) {
  return (await where<Batch>(db, "batch", { status: ["executing"] })).flatMap((b) =>
    b.lines
      .filter((l) => l.status === "pending" && l.method === "mtn_momo" && l.net > 0)
      .map((l) => ({ batchNo: b.no, lineId: l.id, workerId: l.workerId, net: l.net, momoRef: b.meta[l.id]?.momoRef })),
  );
}
export async function setMomoRef(db: Exec, batchNo: string, lineId: string, ref: string) {
  const b = await batchOr404(db, batchNo);
  (b.meta[lineId] ??= { parts: [], carriedIn: 0, taxable: 0, carriedFrom: [] } as unknown as LineMeta).momoRef = ref;
  await saveBatch(db, b);
}
