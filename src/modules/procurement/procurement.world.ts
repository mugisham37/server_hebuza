// Procurement world (P7): loads the procurement store into one in-memory snapshot, runs a business operation on it,
// and writes back only the documents that changed (runtime store engine over `procurement_records`, same pattern as
// system.world.ts — kept as runtime code, not seed). Writes take one transaction-scoped advisory lock, so two
// procurement mutations never interleave (no lost updates on balances, budgets or bill amounts). Audit rows, outbox
// events (mail, PO PDF) and ledger journals commit in the same transaction as the state change.
import { asc, eq, sql } from "drizzle-orm";
import { procurementRecords, users } from "@/db/schema";
import type { Role } from "@/domain/auth/roles";
import type { Db, Tx } from "../../core/db/db";
import type { TxService } from "../../core/db/tx";
import type { AuditService } from "../../core/db/audit";
import type { OutboxEvent, OutboxService } from "../../core/db/outbox";
import type { CryptoService } from "../../core/crypto/crypto.service";
import type { TokenService } from "../../core/auth/tokens";
import type { StorageService } from "../../core/storage/storage.service";
import type { SessionUser } from "../../core/http/context";
import { AppError } from "../../core/http/errors";
import { genId as generateId } from "../auth/auth.rules";
import {
  ACCOUNTS,
  cashAccount,
  type JournalInput,
  type LedgerService,
} from "../ledger/ledger.service";
import {
  ageingBucket,
  budgetMeter,
  contractStatus,
  daysBetween,
  DEFAULT_LIMITS,
  noticeDeadline,
} from "@/domain/procurement/rules";
import type {
  Advance,
  ApprovalLimits,
  BankChange,
  Bill,
  BudgetCategory,
  Contract,
  GoodsReceipt,
  ProcAlert,
  ProcApproval,
  ProcNote,
  ProcSummary,
  PurchaseOrder,
  PurchaseRequest,
  SettingsProposal,
  UserRef,
  Vendor,
  VendorPayment,
} from "@/domain/procurement/types";

// ---------------------------------------------------------------- roles
export const PROC = "staff:procurement" as const;
export const FIN = "staff:finance" as const;
export const EXEC = "staff:executive" as const;
/** "Any staff" for PR raising/receiving (mock guard("staff")): every staff seat except sysadmin. */
export const STAFF: Role[] = [
  "staff:agent",
  "staff:service_manager",
  "staff:finance",
  "staff:marketing",
  "staff:procurement",
  "staff:partner_manager",
  "staff:executive",
] as Role[];

export type Actor = UserRef & { roles: readonly string[]; sessionId: string };
export const isProc = (a: Actor) => a.roles.includes(PROC);
export const isFin = (a: Actor) => a.roles.includes(FIN);
export const isExec = (a: Actor) => a.roles.includes(EXEC);
export const ref = (a: Actor): UserRef => ({ id: a.id, name: a.name });

/** Business rule failure → the mocks' envelope (`errorType` = code, data carried through). */
export const procError = (
  status: number,
  code: string,
  data?: Record<string, unknown>,
) =>
  new AppError(status, code, code, undefined, data);

// ---------------------------------------------------------------- ledger
/** Accounts procurement posts to (ledger chart; cash side = ledger cashAccount(method)). */
export const ACC = {
  advances: ACCOUNTS.supplierAdvances,
  payable: ACCOUNTS.supplierPayable,
  expense: ACCOUNTS.procurementExpense,
  depositLoss: ACCOUNTS.depositLosses,
} as const;
export { cashAccount as cashAcc };

// ---------------------------------------------------------------- world
type Meta = {
  counters: Record<string, number>;
  clockOffset: number;
  dueSoonDays: number;
};
export type AuditRec = {
  action: string;
  kind: string;
  id: string;
  before: unknown;
  after: unknown;
  reason?: string;
};
type Secret = { enc: string; hash: string };

export type World = {
  vendors: Vendor[];
  bankChanges: BankChange[];
  contracts: Contract[];
  prs: PurchaseRequest[];
  pos: PurchaseOrder[];
  grns: GoodsReceipt[];
  bills: Bill[];
  payments: VendorPayment[];
  advances: Advance[];
  budgets: BudgetCategory[];
  proposals: SettingsProposal[];
  limits: ApprovalLimits;
  meta: Meta;
  /** kind "secret": id → { enc (AES-GCM), hash (blind index) }. Never leaves the server. */
  secrets: Map<string, Secret>;
  audits: AuditRec[];
  /** Outbound mail (PO to supplier, remittance advice, statement) → sealed `auth.mail` outbox rows. */
  mails: { to: string; subject: string; text: string }[];
  events: OutboxEvent[];
  journals: JournalInput[];
  actor: Actor;
  deps: ProcDeps;
};

/** Collection name → record kind. Order of `COLS` is the load/save order. */
const COLS = {
  vendors: "vendor",
  bankChanges: "bank_change",
  contracts: "contract",
  prs: "pr",
  pos: "po",
  grns: "grn",
  bills: "bill",
  payments: "payment",
  advances: "advance",
  budgets: "budget",
  proposals: "proposal",
} as const;
type ColName = keyof typeof COLS;
const keyOf = (col: ColName, x: { id?: string; code?: string }) =>
  String(col === "budgets" ? x.code : x.id);

const DEFAULT_META: Meta = {
  counters: {},
  clockOffset: 0,
  dueSoonDays: 5 /* PLACEHOLDER(bill-due-soon-days) */,
};

type Loaded = {
  world: World;
  orig: Map<string, string>;
  pos: Map<string, number>;
};

export type Exec = Pick<Db, "select" | "insert" | "execute">;

async function load(db: Exec, actor: Actor, deps: ProcDeps): Promise<Loaded> {
  const rows = await db
    .select()
    .from(procurementRecords)
    .orderBy(asc(procurementRecords.pos));
  const w: World = {
    vendors: [],
    bankChanges: [],
    contracts: [],
    prs: [],
    pos: [],
    grns: [],
    bills: [],
    payments: [],
    advances: [],
    budgets: [],
    proposals: [],
    limits: {
      ...DEFAULT_LIMITS,
      reminderOffsets: [...DEFAULT_LIMITS.reminderOffsets],
    },
    meta: { ...DEFAULT_META, counters: {} },
    secrets: new Map(),
    audits: [],
    mails: [],
    events: [],
    journals: [],
    actor,
    deps,
  };
  const byKind = Object.fromEntries(
    Object.entries(COLS).map(([c, k]) => [k, c]),
  ) as Record<string, ColName>;
  const orig = new Map<string, string>(),
    pos = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.kind}:${r.id}`;
    orig.set(k, JSON.stringify(r.data));
    pos.set(k, r.pos);
    if (r.kind === "settings" && r.id === "limits")
      w.limits = { ...w.limits, ...(r.data as ApprovalLimits) };
    else if (r.kind === "settings" && r.id === "meta")
      w.meta = { ...w.meta, ...(r.data as Meta) };
    else if (r.kind === "secret") w.secrets.set(r.id, r.data as Secret);
    else if (byKind[r.kind]) (w[byKind[r.kind]] as unknown[]).push(r.data);
  }
  refresh(w);
  return { world: w, orig, pos };
}

async function save(db: Exec, { world: w, orig, pos }: Loaded) {
  const out: { kind: string; id: string; pos: number; data: unknown }[] = [];
  let min = Math.min(0, ...pos.values()),
    max = Math.max(0, ...pos.values());
  const put = (kind: string, id: string, data: unknown, front = false) => {
    const k = `${kind}:${id}`,
      s = JSON.stringify(data);
    if (orig.get(k) === s) return;
    out.push({ kind, id, data, pos: pos.get(k) ?? (front ? --min : ++max) });
  };
  for (const [col, kind] of Object.entries(COLS) as [ColName, string][]) {
    const arr = w[col] as { id?: string; code?: string }[];
    // New documents placed before every existing one were unshift()ed: keep them at the front of the list.
    const firstOld = arr.findIndex((x) => pos.has(`${kind}:${keyOf(col, x)}`));
    arr.forEach((x, i) =>
      put(kind, keyOf(col, x), x, firstOld > -1 && i < firstOld),
    );
  }
  put("settings", "limits", w.limits);
  put("settings", "meta", w.meta);
  for (const [id, v] of w.secrets) put("secret", id, v);
  if (!out.length) return;
  const at = new Date().toISOString();
  await db
    .insert(procurementRecords)
    .values(out.map((r) => ({ ...r, updatedAt: at })))
    .onConflictDoUpdate({
      target: [procurementRecords.kind, procurementRecords.id],
      set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at` },
    });
}

/** Injected services the procurement logic needs; built once by ProcurementStore. */
export type ProcDeps = {
  db: Db;
  tx: TxService;
  audit: AuditService;
  outbox: OutboxService;
  crypto: CryptoService;
  tokens: TokenService;
  storage: StorageService;
  ledger: LedgerService;
  prod: boolean;
};
export type Caller = {
  deps: ProcDeps;
  db: Exec;
  session: SessionUser | null;
  ip?: string;
  ifMatch?: string | null;
  stepUpToken?: string;
};

export async function actorOf(c: Caller): Promise<Actor> {
  const s = c.session;
  if (!s) return { id: "system", name: "System", roles: [], sessionId: "" };
  const [u] = await c.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, s.id))
    .limit(1);
  return { id: s.id, name: u?.name ?? s.id, roles: s.roles, sessionId: s.sid };
}

/** Read-only snapshot. */
export async function read<T>(c: Caller, fn: (w: World) => T): Promise<T> {
  return fn((await load(c.db, await actorOf(c), c.deps)).world);
}

/** Serialised mutation: step-up → lock → load → run → refresh → save → journals, mail, events, audit (same tx). */
export async function write<T>(
  c: Caller,
  fn: (w: World) => T,
  o: { stepUp?: boolean } = {},
): Promise<T> {
  const actor = await actorOf(c);
  if (
    o.stepUp &&
    !(
      c.session &&
      c.stepUpToken &&
      (await c.deps.tokens
        .verifyStepUp(c.stepUpToken, c.session)
        .catch(() => false))
    )
  )
    throw new AppError(401, "step_up_required", "Confirm it's you first.");
  const run = async (db: Tx) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtext('procurement_world'))`,
    );
    const l = await load(db, actor, c.deps);
    const out = fn(l.world);
    refresh(l.world);
    await save(db, l);
    const { audits, mails, events, journals } = l.world;
    for (const j of journals)
      await c.deps.ledger.post(db, {
        ...j,
        createdBy: actor.id === "system" ? null : actor.id,
      });
    for (const m of mails)
      await c.deps.outbox.add(db, {
        type: "auth.mail",
        payload: c.deps.crypto.seal(m, ["text"]),
      });
    for (const e of events) await c.deps.outbox.add(db, e);
    for (const a of audits)
      await c.deps.audit.record(db, {
        action: a.action,
        entity: a.kind,
        entityId: a.id,
        before: a.before ?? null,
        after: a.after ?? null,
        reason: a.reason,
      });
    return out;
  };
  return c.session ? c.deps.tx.run(run) : c.deps.tx.runAsSystem(run);
}

/** Same as write() but for the worker: no actor, no step-up. */
export const systemWrite = <T>(deps: ProcDeps, fn: (w: World) => T) =>
  write({ deps, db: deps.db, session: null }, fn);

/** One audit row per mutation (mock record()). */
export const record = (
  w: World,
  action: string,
  kind: string,
  id: string,
  before: unknown,
  afterV: unknown,
  reason?: string,
) => w.audits.push({ action, kind, id, before, after: afterV, reason });

/** One balanced ledger journal, posted in the write's tx. */
export const journal = (
  w: World,
  sourceId: string,
  memo: string,
  debit: { code: string },
  credit: { code: string },
  amount: number,
) => {
  if (amount > 0)
    w.journals.push({
      sourceType: "procurement",
      sourceId,
      memo,
      lines: [
        { account: debit.code, debit: amount },
        { account: credit.code, credit: amount },
      ],
    });
};

/** 409 stale_version when If-Match is sent and differs (§4 Conflict). */
export function checkVersion(
  ifMatch: string | null | undefined,
  current: { version: number },
) {
  if (
    ifMatch &&
    ifMatch !== "*" &&
    Number(ifMatch.replace(/^W\//, "").replace(/"/g, "")) !== current.version
  )
    throw procError(409, "stale_version", { version: current.version });
}
// ---------------------------------------------------------------- clock, numbering, ids, secrets
export const now = (w: World) => Date.now() + (w.meta.clockOffset || 0);
export const nowIso = (w: World) => new Date(now(w)).toISOString();
export const today = (w: World) => nowIso(w).slice(0, 10);
export const uid = (p: string) => generateId(p);
/** R-17 numbering PLACEHOLDER(proc-numbering): PREFIX-YEAR-0001; vendors V-0001. Counters live in the meta document. */
export function nextNo(w: World, prefix: string, pad = 4) {
  const n = (w.meta.counters[prefix] = (w.meta.counters[prefix] ?? 0) + 1);
  return prefix === "V"
    ? `V-${String(n).padStart(4, "0")}`
    : `${prefix}-${today(w).slice(0, 4)}-${String(n).padStart(pad, "0")}`;
}
export const blind = (w: World, value: string) =>
  w.deps.crypto.blindIndex(value);
export const setSecret = (w: World, id: string, value: string) =>
  w.secrets.set(id, { enc: w.deps.crypto.encrypt(value), hash: blind(w, value) });
export const secretHash = (w: World, id: string) => w.secrets.get(id)?.hash;
export function getSecret(w: World, id: string) {
  const s = w.secrets.get(id);
  return s ? w.deps.crypto.decrypt(s.enc) : undefined;
}

// ---------------------------------------------------------------- lookups
export const vendorOf = (w: World, id: string) =>
  w.vendors.find((x) => x.id === id || x.code === id);
export const vendorName = (w: World, id?: string) =>
  id ? (vendorOf(w, id)?.legalName ?? id) : "";
export const contractOf = (w: World, idOrRef: string) =>
  w.contracts.find((c) => c.id === idOrRef || c.ref === idOrRef);
export const liveStatus = (w: World, c: Contract) =>
  contractStatus(c, today(w));
export const poOf = (w: World, no: string) =>
  w.pos.find((x) => x.no === no || x.id === no);
export const billOf = (w: World, no: string) =>
  w.bills.find((b) => b.no === no || b.id === no);
export const advanceOf = (w: World, no: string) =>
  w.advances.find((a) => a.no === no || a.id === no);
export const budgetOf = (w: World, code: string) =>
  w.budgets.find((b) => b.code === code);
export const prOf = (w: World, no: string) =>
  w.prs.find((p) => p.no === no || p.id === no);
export const meterFor = (w: World, code: string, adding = 0) => {
  const b = budgetOf(w, code);
  return b ? budgetMeter(b, adding, w.limits) : null;
};
export { noticeDeadline };

// ---------------------------------------------------------------- derived figures
export const isLocked = (w: World, vd: Vendor) =>
  vd.bankStatus === "unverified" ||
  (!!vd.lockUntil && Date.parse(vd.lockUntil) > now(w));
export const OPEN = new Set([
  "submitted",
  "matched",
  "match_exception",
  "approved",
  "authorised",
  "partially_paid",
  "disputed",
]);

/** Recomputes vendor balances/open bills/last payment, lock expiry and deposit return_due. Runs on every load and save. */
export function refresh(w: World) {
  for (const vd of w.vendors) {
    const mine = w.bills.filter(
      (b) => b.vendorId === vd.id && OPEN.has(b.status),
    );
    vd.openBills = mine.length;
    vd.balance = mine.reduce((s, b) => s + b.payable - b.amountPaid, 0);
    const last = w.payments
      .filter((p) => p.vendorId === vd.id)
      .map((p) => p.paidAt)
      .sort()
      .at(-1);
    if (last) vd.lastPaymentAt = last;
    else delete vd.lastPaymentAt;
    const bc = w.bankChanges.filter((c) => c.vendorId === vd.id).at(-1);
    if (
      bc?.status === "verified" &&
      vd.lockUntil &&
      Date.parse(vd.lockUntil) <= now(w)
    )
      delete vd.lockUntil;
  }
  for (const a of w.advances)
    if (a.kind === "deposit" && a.status === "held" && a.returnDueOn) {
      const c = a.contractRef ? contractOf(w, a.contractRef) : undefined;
      if (c && (c.status === "terminated" || today(w) > c.endOn))
        a.status = "return_due";
    }
}

export function alerts(w: World, horizon = 90, t = today(w)): ProcAlert[] {
  const out: ProcAlert[] = [];
  const within = (on: string) => daysBetween(t, on) <= horizon;
  for (const c of w.contracts) {
    const s = contractStatus(c, t);
    if (s !== "active" && s !== "expiring") continue;
    const vn = vendorName(w, c.vendorId);
    if (within(c.endOn))
      out.push({
        id: `a-end-${c.id}`,
        kind: "contract_end",
        on: c.endOn,
        title: `${c.title} — ${vn}`,
        ref: c.ref,
        href: `/procurement/contracts/${c.id}?renew=1`,
        days: daysBetween(t, c.endOn),
        amount: c.amount,
      });
    const nd = noticeDeadline(c);
    if (nd >= t && within(nd))
      out.push({
        id: `a-notice-${c.id}`,
        kind: "notice",
        on: nd,
        title: `Notice deadline — ${c.title}`,
        ref: c.ref,
        href: `/procurement/contracts/${c.id}`,
        days: daysBetween(t, nd),
      });
    if (c.frequency === "monthly" && c.dueDay) {
      const x = new Date(`${t}T00:00:00Z`);
      const due = new Date(
        Date.UTC(
          x.getUTCFullYear(),
          x.getUTCMonth() + (x.getUTCDate() > c.dueDay ? 1 : 0),
          c.dueDay,
        ),
      )
        .toISOString()
        .slice(0, 10);
      if (c.kind === "lease" && due <= c.endOn && within(due))
        out.push({
          id: `a-rent-${c.id}`,
          kind: "rent_due",
          on: due,
          title: `Rent due — ${c.title}`,
          ref: c.ref,
          href: `/procurement/contracts/${c.id}?tab=bills`,
          days: daysBetween(t, due),
          amount: c.amount,
        });
    }
  }
  for (const b of w.bills)
    if (OPEN.has(b.status) && b.status !== "disputed") {
      const days = daysBetween(t, b.dueOn);
      if (days < 0)
        out.push({
          id: `a-od-${b.id}`,
          kind: "bill_overdue",
          on: b.dueOn,
          title: `Overdue — ${vendorName(w, b.vendorId)} ${b.vendorInvoiceNo}`,
          ref: b.no,
          href: `/procurement/bills/${b.no}`,
          days,
          amount: b.payable - b.amountPaid,
        });
      else if (within(b.dueOn))
        out.push({
          id: `a-due-${b.id}`,
          kind: "bill_due",
          on: b.dueOn,
          title: `${vendorName(w, b.vendorId)} — ${b.vendorInvoiceNo}`,
          ref: b.no,
          href: `/procurement/bills/${b.no}`,
          days,
          amount: b.payable - b.amountPaid,
        });
    }
  for (const a of w.advances)
    if (
      a.kind === "deposit" &&
      a.returnDueOn &&
      ["held", "return_due", "partially_returned"].includes(a.status) &&
      within(a.returnDueOn)
    )
      out.push({
        id: `a-dep-${a.id}`,
        kind: "deposit_return",
        on: a.returnDueOn,
        title: `Deposit return — ${vendorName(w, a.vendorId)}`,
        ref: a.no,
        href: `/procurement/deposits?item=${a.no}`,
        days: daysBetween(t, a.returnDueOn),
        amount: a.remaining,
      });
  for (const vd of w.vendors)
    for (const doc of vd.documents)
      if (doc.expiresOn && within(doc.expiresOn) && doc.expiresOn >= t)
        out.push({
          id: `a-doc-${doc.id}`,
          kind: "document",
          on: doc.expiresOn,
          title: `${doc.name} — ${vd.legalName}`,
          ref: vd.code,
          href: `/procurement/suppliers/${vd.id}?tab=documents`,
          days: daysBetween(t, doc.expiresOn),
        });
  for (const c of w.bankChanges)
    if (c.status === "requested")
      out.push({
        id: `a-bank-${c.id}`,
        kind: "bank_change",
        on: c.requestedAt.slice(0, 10),
        title: `Bank details changed — ${vendorName(w, c.vendorId)}`,
        ref: vendorOf(w, c.vendorId)?.code ?? "",
        href: `/procurement/suppliers/${c.vendorId}`,
        days: 0,
      });
  return out.sort((x, y) => x.on.localeCompare(y.on));
}

/** Unified approvals queue (GET /approvals). blockedSelf = shown but locked by segregation. */
export function approvalsFor(w: World, a: Actor = w.actor): ProcApproval[] {
  const items: ProcApproval[] = [];
  const exec = isExec(a),
    fin = isFin(a);
  const fallbackMaker: UserRef = { id: "system", name: "Procurement" };
  for (const p of w.prs)
    if (
      p.status === "submitted" &&
      ((p.route === "finance" && fin) || exec) &&
      (p.route === "executive" ? exec : true)
    )
      items.push({
        id: p.id,
        kind: "pr",
        ref: p.no,
        title: p.title,
        amount: p.estimatedTotal,
        reasons: p.routeReasons,
        maker: p.requester,
        at: p.submittedAt ?? p.createdAt,
        href:
          exec && !fin
            ? `/exec/approvals?type=pr&item=${p.no}`
            : `/finance/payables?tab=approve&item=${p.no}`,
        blockedSelf: p.requester.id === a.id,
        vendorName: vendorName(w, p.vendorId),
      });
  for (const b of w.bills) {
    const v = vendorOf(w, b.vendorId);
    const mk = {
      ref: b.no,
      title: `${vendorName(w, b.vendorId)} · ${b.vendorInvoiceNo}`,
      vendorName: vendorName(w, b.vendorId),
      amount: b.total,
      maker: b.preparedBy ?? fallbackMaker,
      locked: v && isLocked(w, v) ? (v.lockUntil ?? "pending") : undefined,
    };
    const approvable =
      b.status === "matched" ||
      b.status === "submitted" ||
      (b.status === "match_exception" && b.match?.exceptionApproved);
    if (
      approvable &&
      ((b.route === "finance" && fin) || (b.route === "executive" && exec))
    )
      items.push({
        id: b.id,
        kind: "bill_approve",
        reasons: b.routeReasons,
        at: b.preparedAt ?? b.createdAt,
        href:
          b.route === "executive"
            ? `/exec/approvals?type=bills&item=${b.no}`
            : `/finance/payables?tab=approve&item=${b.no}`,
        blockedSelf: b.preparedBy?.id === a.id,
        ...mk,
      });
    if (
      b.status === "match_exception" &&
      b.match?.exceptionRequested &&
      !b.match.exceptionApproved &&
      exec
    )
      items.push({
        id: `${b.id}-x`,
        kind: "exception",
        reasons: ["match_exception"],
        at: b.preparedAt ?? b.createdAt,
        href: `/exec/approvals?type=exceptions&item=${b.no}`,
        ...mk,
      });
    if (b.status === "approved") {
      const execStep = b.total > w.limits.financeMax;
      if ((execStep && exec) || (!execStep && fin))
        items.push({
          id: `${b.id}-a`,
          kind: "bill_authorise",
          reasons: execStep ? ["over_limit"] : [],
          at: b.approvedAt ?? b.createdAt,
          href: execStep
            ? `/exec/approvals?type=bills&item=${b.no}`
            : `/finance/payables?tab=authorise&item=${b.no}`,
          blockedSelf: b.approvedBy?.id === a.id || b.preparedBy?.id === a.id,
          ...mk,
        });
    }
  }
  if (exec) {
    for (const c of w.contracts)
      if (c.renewal?.status === "requested")
        items.push({
          id: `${c.id}-r`,
          kind: "renewal",
          ref: c.ref,
          title: c.title,
          vendorName: vendorName(w, c.vendorId),
          amount: c.renewal.amount,
          reasons: [],
          maker: { id: c.ownerId, name: c.renewal.by },
          at: c.renewal.at,
          href: `/exec/approvals?type=renewals&item=${c.ref}`,
        });
    for (const p of w.proposals)
      if (p.status === "pending")
        items.push({
          id: p.id,
          kind: "settings",
          ref: p.id,
          title: "Procurement limits and budgets",
          reasons: [],
          maker: p.by,
          at: p.at,
          href: `/exec/approvals?type=settings&item=${p.id}`,
          blockedSelf: p.by.id === a.id,
        });
    for (const x of w.advances)
      if (x.forfeit?.status === "requested")
        items.push({
          id: `${x.id}-f`,
          kind: "forfeit",
          ref: x.no,
          title: `Forfeit deposit — ${vendorName(w, x.vendorId)}`,
          vendorName: vendorName(w, x.vendorId),
          amount: x.remaining,
          reasons: [],
          maker: { id: "", name: x.forfeit.by },
          at: nowIso(w),
          href: `/exec/approvals?type=exceptions&item=${x.no}`,
        });
  }
  if (fin)
    for (const c of w.bankChanges)
      if (c.status === "requested")
        items.push({
          id: c.id,
          kind: "bank",
          ref: vendorOf(w, c.vendorId)?.code ?? c.vendorId,
          title: `Bank details — ${vendorName(w, c.vendorId)}`,
          vendorName: vendorName(w, c.vendorId),
          reasons: [],
          maker: c.requestedBy,
          at: c.requestedAt,
          href: `/finance/payables?tab=bank&item=${c.id}`,
          blockedSelf: c.requestedBy.id === a.id,
        });
  return items.sort((x, y) => x.at.localeCompare(y.at));
}

export function summary(w: World, a: Actor = w.actor): ProcSummary {
  const t = today(w);
  const al = alerts(w, 90, t);
  const live = (b: Bill) => OPEN.has(b.status) && b.status !== "disputed";
  const dueWeek = w.bills.filter(
    (b) => live(b) && b.dueOn >= t && daysBetween(t, b.dueOn) <= 7,
  );
  const overdue = w.bills.filter((b) => live(b) && b.dueOn < t);
  const lease = w.contracts
    .filter(
      (c) =>
        c.kind === "lease" &&
        ["active", "expiring"].includes(contractStatus(c, t)),
    )
    .sort((x, y) => x.endOn.localeCompare(y.endOn))[0];
  const leaseDays = lease ? daysBetween(t, lease.endOn) : undefined;
  const budgetTotal = w.budgets.reduce((s, b) => s + b.annualBudget, 0);
  const used = w.budgets.reduce((s, b) => s + b.actual, 0);
  const prOpen = w.prs.filter(
    (p) => p.status === "submitted" || p.status === "approved",
  ).length;
  const exceptions = w.bills.filter(
    (b) => b.status === "match_exception" || b.status === "draft",
  ).length;
  const appr = approvalsFor(w, a).filter((i) => !i.blockedSelf);
  const ends = (n: number) =>
    w.contracts.filter(
      (c) =>
        ["active", "expiring"].includes(contractStatus(c, t)) &&
        daysBetween(t, c.endOn) <= n,
    ).length;
  return {
    tiles: {
      contracts60: ends(60),
      contracts90: ends(90),
      billsDueWeek: dueWeek.reduce((s, b) => s + b.payable - b.amountPaid, 0),
      billsDueWeekCount: dueWeek.length,
      overdue: overdue.reduce((s, b) => s + b.payable - b.amountPaid, 0),
      overdueCount: overdue.length,
      notInvoiced: w.grns.filter((g) => !g.invoiced && !g.reverses).length,
      depositsOutstanding: w.advances
        .filter(
          (x) =>
            x.kind === "deposit" &&
            ["held", "return_due", "partially_returned"].includes(x.status),
        )
        .reduce((s, x) => s + x.remaining, 0),
      budgetUsedPct: budgetTotal ? Math.round((used * 100) / budgetTotal) : 0,
      awaitingApproval: w.prs.filter((p) => p.status === "submitted").length, // F-RPT-09
    },
    banner: {
      leaseDays:
        leaseDays !== undefined && leaseDays <= 90 ? leaseDays : undefined,
      leaseRef: lease?.ref,
      billsDue: dueWeek.length,
      requests: prOpen,
    },
    balances: [...w.vendors]
      .filter((x) => x.balance > 0)
      .sort((x, y) => y.balance - x.balance)
      .slice(0, 5)
      .map((x) => ({ vendorId: x.id, name: x.legalName, balance: x.balance })),
    obligations: al.filter((x) => x.kind !== "bank_change").slice(0, 5),
    checklist: {
      landlord: w.vendors.some(
        (x) => x.type === "landlord" && x.status === "active",
      ),
      lease: w.contracts.some((c) => c.kind === "lease"),
      budgets: w.budgets.length > 0,
      limits: w.limits.financeMax > 0,
    },
    badges: {
      requests: w.prs.filter((p) => p.status === "approved").length,
      bills: exceptions,
      deposits: w.advances.filter(
        (x) => x.status === "return_due" && x.returnDueOn && x.returnDueOn < t,
      ).length,
      payables: appr.filter((i) => i.href.startsWith("/finance")).length,
      execApprovals: appr.filter((i) => i.href.startsWith("/exec")).length,
    },
    firstRun: w.vendors.length === 0,
  };
}

/** Bell items per seat, derived from alerts + queue. */
export function notesFor(w: World, a: Actor = w.actor): ProcNote[] {
  const out: ProcNote[] = [];
  const t = today(w);
  if (isProc(a)) {
    for (const x of alerts(w, 60, t))
      out.push({
        id: `n-${x.id}`,
        kind: x.kind,
        text: x.title,
        ref: x.ref,
        href: x.href,
        at: `${x.on}T06:00:00.000Z`,
        read: false,
      });
    for (const b of w.bills)
      if (b.status === "match_exception")
        out.push({
          id: `n-mx-${b.id}`,
          kind: "bill_exception",
          text: `Match exception — ${b.no}`,
          ref: b.no,
          href: `/procurement/bills/${b.no}?tab=match`,
          at: b.preparedAt ?? b.createdAt,
          read: false,
        });
    for (const p of w.prs)
      if (p.status === "approved")
        out.push({
          id: `n-pr-${p.id}`,
          kind: "pr_decided",
          text: `Approved — ${p.title}`,
          ref: p.no,
          href: `/procurement/requests/${p.no}`,
          at: p.decisions.at(-1)?.at ?? p.createdAt,
          read: true,
        });
  }
  if (isFin(a) || isExec(a)) {
    for (const i of approvalsFor(w, a))
      if (!i.blockedSelf)
        out.push({
          id: `n-${i.id}`,
          kind: i.kind,
          text: i.title,
          ref: i.ref,
          href: i.href,
          at: i.at,
          read: false,
        });
    for (const x of alerts(w, 30, t))
      if (
        x.kind === "bill_overdue" ||
        x.kind === "deposit_return" ||
        (x.kind === "bill_due" && x.days <= w.meta.dueSoonDays)
      )
        out.push({
          id: `n-${x.id}`,
          kind: x.kind,
          text: x.title,
          ref: x.ref,
          href: isFin(a) ? `/finance/payables?tab=pay` : x.href,
          at: `${x.on}T06:00:00.000Z`,
          read: false,
        });
  }
  return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 30);
}

/** Bucket figures for the ageing report (R-12). */
export const ageing = (w: World, asOf = today(w)) =>
  w.bills
    .filter((b) => OPEN.has(b.status) && b.payable - b.amountPaid > 0)
    .map((b) => ({
      bill: b,
      bucket: ageingBucket(b.dueOn, asOf),
      open: b.payable - b.amountPaid,
    }));

/** Contract reminders whose date has come and that were not sent yet (daily job marks them sent). */
export function dueReminders(w: World) {
  const t = today(w),
    out: { c: Contract; key: string }[] = [];
  for (const c of w.contracts)
    if (["active", "expiring"].includes(contractStatus(c, t)))
      for (const r of c.reminders)
        if (!r.sentAt && r.on <= t) out.push({ c, key: r.key });
  return out;
}
