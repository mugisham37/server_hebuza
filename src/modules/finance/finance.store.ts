// Finance persistence + shared plumbing: the (kind, id) document store, gapless numbering, the signed-in actor,
// audit records (before/after/reason, read back by the history and HistoryTab views), effective-dated settings and
// the party directory (clients, workers, services, cases from users/catalogue/applications) finance prices and pays against.
import { and, eq, inArray, ne, sql as dsql } from "drizzle-orm";
import type { Tx as Exec } from "../../core/db/db";
import { AppError } from "../../core/http/errors";
import type { AuditEntry } from "../../core/db/audit";
import type { SessionUser } from "../../core/http/context";
import type { LedgerService } from "../ledger/ledger.service";
import { applications, clientSubscriptions, services, supportTickets, users } from "@/db/schema";
import { financeRecords, financeSequences } from "@/db/schema";
import { formatNo, type NumberSeries } from "@/domain/finance/numbering";
import type { Role } from "@/domain/auth/roles";
import type {
  FinanceSettingKey,
  SettingChange,
  SettingRow,
  UserRef,
} from "@/domain/finance/types";

// ---------------------------------------------------------------- errors (snake_case errorTypes of error-copy.ts)
const COPY: Record<string, string> = {
  not_found: "Not found.",
  conflict: "This record changed state. Refresh and try again.",
  version_conflict: "This changed meanwhile.",
  validation: "Check the highlighted fields.",
  reason_required: "A reason is required.",
  forbidden: "You can't do this.",
  same_approver: "A different person must approve this.",
  period_locked: "That period is closed. Request a reopen first.",
};
export const fail = (status: number, code: string, message?: string) =>
  new AppError(status, code, message ?? COPY[code] ?? code.replace(/_/g, " "));
export const need = (cond: unknown, status: number, code: string): void => {
  if (!cond) throw fail(status, code);
};
/** Optimistic concurrency on a record `rev` (body `rev` or If-Match). */
export function checkRev(cur: number, sent: unknown) {
  if (typeof sent === "number" && sent !== cur)
    throw fail(409, "version_conflict");
}
/** 202 "Pending approval" (maker-checker accepted, not yet effective); AcceptedInterceptor sets the status. */
export class Accepted<T> {
  constructor(readonly data: T) {}
}
export const accepted = <T>(data: T) => new Accepted(data);

// ---------------------------------------------------------------- time (Africa/Kigali, UTC+2, no DST)
export const DAY = 86_400_000;
export const nowIso = () => new Date().toISOString();
export const today = (t = Date.now()) =>
  new Date(t + 2 * 3_600_000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) =>
  new Date(Date.parse(d.slice(0, 10)) + n * DAY).toISOString().slice(0, 10);
export const year = () => Number(today().slice(0, 4));
export const sum = <T>(xs: T[], f: (x: T) => number) =>
  xs.reduce((s, x) => s + f(x), 0);

// ---------------------------------------------------------------- document store
export type Kind =
  | "client"
  | "worker"
  | "service"
  | "case"
  | "quote"
  | "quote_meta"
  | "invoice"
  | "client_credit"
  | "payment"
  | "import"
  | "line"
  | "period_lock"
  | "mapping"
  | "refund"
  | "credit_note"
  | "ar_note"
  | "rule"
  | "allocation"
  | "adjustment"
  | "fee"
  | "batch"
  | "destination"
  | "setting"
  | "setting_change"
  | "local_change"
  | "config"
  | "account"
  | "report_run"
  | "export_job";

type Doc = { status?: string; state?: string; rev?: number };
const statusOf = (d: Doc) =>
  (d.status ?? d.state ?? null)?.slice(0, 32) ?? null;

export async function all<T>(db: Exec, kind: Kind): Promise<T[]> {
  const rows = await db
    .select({ data: financeRecords.data })
    .from(financeRecords)
    .where(eq(financeRecords.kind, kind));
  return rows.map((r) => r.data as T);
}
export async function where<T>(
  db: Exec,
  kind: Kind,
  f: { status?: string[]; ref?: string },
): Promise<T[]> {
  const rows = await db
    .select({ data: financeRecords.data })
    .from(financeRecords)
    .where(
      and(
        eq(financeRecords.kind, kind),
        f.status ? inArray(financeRecords.status, f.status) : undefined,
        f.ref != null ? eq(financeRecords.ref, f.ref) : undefined,
      ),
    );
  return rows.map((r) => r.data as T);
}
/** One document; `lock` takes FOR UPDATE so concurrent writers of the same record serialise. */
export async function one<T>(
  db: Exec,
  kind: Kind,
  id: string,
  lock = false,
): Promise<T | undefined> {
  const q = db
    .select({ data: financeRecords.data })
    .from(financeRecords)
    .where(and(eq(financeRecords.kind, kind), eq(financeRecords.id, id)));
  const [r] = lock ? await q.for("update") : await q;
  return r?.data as T | undefined;
}
export async function byRef<T>(
  db: Exec,
  kind: Kind,
  ref: string,
  lock = false,
): Promise<T | undefined> {
  const q = db
    .select({ data: financeRecords.data })
    .from(financeRecords)
    .where(and(eq(financeRecords.kind, kind), eq(financeRecords.ref, ref)))
    .limit(1);
  const [r] = lock ? await q.for("update") : await q;
  return r?.data as T | undefined;
}
export async function put(
  db: Exec,
  kind: Kind,
  id: string,
  data: object,
  ref?: string | null,
) {
  const status = statusOf(data as Doc);
  const rev = (data as Doc).rev ?? 1;
  await db
    .insert(financeRecords)
    .values({ kind, id, status, ref: ref ?? null, data, rev })
    .onConflictDoUpdate({
      target: [financeRecords.kind, financeRecords.id],
      set: { status, ref: ref ?? null, data, rev, updatedAt: nowIso() },
    });
}
export const remove = (db: Exec, kind: Kind, id: string) =>
  db
    .delete(financeRecords)
    .where(and(eq(financeRecords.kind, kind), eq(financeRecords.id, id)));

/** Gapless PREFIX-YYYY-NNNNN in the caller's transaction (row lock on the counter; a rollback returns the number). */
export async function nextNo(db: Exec, series: NumberSeries, y = year()) {
  const key = `${series}-${y}`;
  const [r] = await db
    .insert(financeSequences)
    .values({ key, last: 1 })
    .onConflictDoUpdate({
      target: financeSequences.key,
      set: { last: dsql`${financeSequences.last} + 1` },
    })
    .returning({ last: financeSequences.last });
  return formatNo(series, y, r.last);
}
export async function lastUsed(db: Exec, series: string, y = year()) {
  const [r] = await db
    .select({ last: financeSequences.last })
    .from(financeSequences)
    .where(eq(financeSequences.key, `${series}-${y}`));
  return r?.last ?? 0;
}
/** Short sortable id for records without a business number. */
export const rid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------- actor
export type Actor = UserRef & { roles: Role[] };
export async function actorOf(db: Exec, s: SessionUser): Promise<Actor> {
  const [u] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, s.id));
  return { id: s.id, name: u?.name ?? s.id, roles: s.roles };
}
export const isFinanceUser = (a: { roles: readonly Role[] }) =>
  a.roles.includes("staff:finance");
export const isExec = (a: { roles: readonly Role[] }) =>
  a.roles.includes("staff:executive");
export const isSm = (a: { roles: readonly Role[] }) =>
  a.roles.includes("staff:service_manager");
export const isExecOnly = (a: { roles: readonly Role[] }) =>
  !isFinanceUser(a) && isExec(a);
export const refOf = (a: UserRef): UserRef => ({ id: a.id, name: a.name });

// ---------------------------------------------------------------- audit
/** Financial audit entry (AUD §6): `category.action`, entity, before/after, reason. Buffered by `rec` and written by the runner as the last statements of the request tx. */
export const auditEntry = (
  action: string,
  kind: string,
  id: string,
  before: unknown,
  afterV: unknown,
  reason?: string | null,
  category = "financial",
): AuditEntry => ({
  action: `${category}.${action}`,
  entity: kind,
  entityId: id,
  before: before ?? null,
  after: afterV ?? null,
  reason: reason ?? undefined,
});

// ---------------------------------------------------------------- settings (SET §7: effective-dated, executive approval)
/** Business values that are not user-editable settings. Mirrors src/lib/policy.ts (PLACEHOLDERs live there). */
export const POLICY = {
  defaultAgentBps: 3000,
  payoutExecThreshold: null as number | null,
  manualReturnMs: 72 * 3_600_000,
  paymentIntentMs: 3_600_000,
  refundPolicyBps: {
    before_work: 10_000,
    in_progress: 5000,
    submitted: 2500,
    completed: 0,
  } as Record<string, number>,
  reminderOffsets: [-3, 0, 3, 7, 14] as number[],
  lockMs: 15 * 60_000,
};
export const SETTING_DEFAULTS: [FinanceSettingKey, unknown, string][] = [
  ["vat_registered", true, "invoices"],
  ["vat_bps", 1800, "invoices"],
  ["hebuza_tin", "PLACEHOLDER(hebuza-tin)", "invoices"],
  ["invoice_terms_days", 7, "invoices"],
  ["quote_validity_days", 14, "quotes"],
  ["deposit_threshold", 200_000, "quotes"],
  ["deposit_bps", 5000, "quotes"],
  ["manual_confirm_threshold", 500_000, "payments"],
  ["manual_confirm_exec", 1_000_000, "payments"],
  ["refund_exec_limit", 200_000, "refunds"],
  ["wht_bps", 1500, "payouts"],
  ["payout_day", 5, "payouts"],
  ["quote_approval_threshold", 500_000, "quotes"],
  ["licence_fee_monthly", 500, "payouts"],
];
export type Settings = {
  vat_registered: boolean;
  vat_bps: number;
  hebuza_tin: string;
  invoice_terms_days: number;
  quote_validity_days: number;
  deposit_threshold: number;
  deposit_bps: number;
  manual_confirm_threshold: number;
  manual_confirm_exec: number;
  refund_exec_limit: number;
  wht_bps: number;
  payout_day: number;
  quote_approval_threshold: number;
  licence_fee_monthly: number;
  refundPolicy: Record<string, number>;
  reminderOffsets: number[];
};
/** Effective settings today: stored rows, with approved changes whose date arrived applied at read time (never retroactive). */
export async function settings(db: Exec): Promise<Settings> {
  const [rows, changes, cfg] = await Promise.all([
    all<SettingRow>(db, "setting"),
    where<SettingChange>(db, "setting_change", { status: ["approved"] }),
    all<{ id: string; value: unknown }>(db, "config"),
  ]);
  const out = Object.fromEntries(
    SETTING_DEFAULTS.map(([k, v]) => [k, v]),
  ) as Record<string, unknown>;
  for (const r of rows) out[r.key] = r.value;
  const t = today();
  for (const c of changes.sort((a, b) =>
    a.effectiveAt.localeCompare(b.effectiveAt),
  ))
    if (c.effectiveAt <= t) out[c.key] = c.next;
  const c = (id: string) => cfg.find((x) => x.id === id)?.value;
  out.refundPolicy =
    (c("refund_policy") as Record<string, number>) ?? POLICY.refundPolicyBps;
  out.reminderOffsets =
    (c("reminder_offsets") as number[]) ?? POLICY.reminderOffsets;
  return out as Settings;
}
/** lib/finance helpers take a POLICY-shaped object; this is the subset they read. */
export const policyOf = (s: Settings) =>
  ({
    manualConfirmSecondFinance: s.manual_confirm_threshold,
    manualConfirmExec: s.manual_confirm_exec,
    quoteApprovalThreshold: s.quote_approval_threshold,
  }) as never;

// ---------------------------------------------------------------- party directory
// Read from the real tables: clients = users(role client), workers = agents, services = catalogue, cases = applications
// (case ref = application code). A case is disputed while a dispute/complaint ticket on it is not resolved.
// shortcut: loads every row per request; upgrade to per-ref lookups once finance lists page server-side.
export type Client = {
  id: string;
  name: string;
  type: "company" | "individual";
  phone: string;
  email: string;
  language: string;
  flags: string[];
  consent?: Partial<Record<"email" | "whatsapp" | "sms", boolean>>;
};
export type Worker = { id: string; name: string; external?: boolean };
export type Service = { slug: string; name: string; fee?: number | null };
export type Case = {
  ref: string;
  service: string;
  clientId: string;
  status: string;
  assignees: { id: string; role: "lead" | "helper" }[];
  amount: number | null;
  createdAt: string;
  updatedAt: string;
  flags?: string[];
  disputed?: boolean;
};
const DISPUTE_TYPES = ["dispute", "complaint", "billing_dispute"];
async function parties(db: Exec) {
  const [us, svcs, apps, tickets, subs] = await Promise.all([
    db
      .select({ id: users.userId, name: users.name, email: users.email, phone: users.phoneE164, role: users.role, language: users.language })
      .from(users)
      .where(inArray(users.role, ["client", "staff:agent", "ext:agent"])),
    db.select({ slug: services.slug, name: services.name }).from(services),
    db
      .select({
        ref: applications.code, service: applications.serviceSlug, clientId: applications.clientId,
        status: applications.status, agent: applications.assignedAgentId, amount: applications.paymentAmount,
        createdAt: applications.createdAt, updatedAt: applications.updatedAt, completedAt: applications.completedAt,
        urgent: applications.isUrgent,
      })
      .from(applications),
    db
      .select({ caseRef: supportTickets.caseRef })
      .from(supportTickets)
      .where(and(inArray(supportTickets.type, DISPUTE_TYPES), ne(supportTickets.status, "resolved"))),
    db
      .select({ clientId: clientSubscriptions.clientId })
      .from(clientSubscriptions)
      .where(inArray(clientSubscriptions.status, ["active", "past_due"])),
  ]);
  const disputed = new Set(tickets.map((t) => t.caseRef));
  const subscribers = new Set(subs.map((s) => s.clientId));
  const clients: Client[] = us
    .filter((u) => u.role === "client")
    .map((u) => ({
      id: u.id, name: u.name, type: "individual", phone: u.phone ?? "", email: u.email ?? "", language: u.language,
      flags: subscribers.has(u.id) ? ["subscriber"] : [],
    }));
  const workers: Worker[] = us
    .filter((u) => u.role !== "client")
    .map((u) => ({ id: u.id, name: u.name, external: u.role === "ext:agent" }));
  const cases: Case[] = apps
    .filter((a) => a.clientId)
    .map((a) => ({
      ref: a.ref, service: a.service, clientId: a.clientId!, status: a.status,
      assignees: a.agent ? [{ id: a.agent, role: "lead" as const }] : [],
      amount: a.amount, createdAt: a.createdAt,
      // The completion date fixes which revenue rule applies (REV §12).
      updatedAt: a.completedAt ?? a.updatedAt,
      flags: a.urgent ? ["urgent"] : [],
      disputed: disputed.has(a.ref),
    }));
  return { clients, workers, services: svcs as Service[], cases };
}
export type Directory = Awaited<ReturnType<typeof directory>>;
export async function directory(db: Exec) {
  const { clients, workers, services, cases } = await parties(db);
  const cm = new Map(clients.map((c) => [c.id, c])),
    wm = new Map(workers.map((w) => [w.id, w])),
    sm = new Map(services.map((s) => [s.slug, s])),
    km = new Map(cases.map((c) => [c.ref, c]));
  return {
    clients,
    workers,
    services,
    cases,
    client: (id: string) => cm.get(id),
    clientName: (id: string) => cm.get(id)?.name ?? id,
    workerName: (id: string) => wm.get(id)?.name ?? id,
    workerKind: (id: string): "internal" | "external" =>
      wm.get(id)?.external ? "external" : "internal",
    serviceName: (slug: string) => sm.get(slug)?.name ?? slug,
    service: (slug: string) => sm.get(slug),
    caseOf: (ref?: string) => (ref ? km.get(ref) : undefined),
  };
}
export const tail4 = (s: string) => `•••• ${s.replace(/\D/g, "").slice(-4)}`;

// ---------------------------------------------------------------- per-request context
/** Side effects a handler may need; all of them write in the caller's tx (outbox) or are pure. */
export type FinDeps = {
  ledger: LedgerService;
  /** Plain-text mail through the sealed `auth.mail` outbox job. */
  mail: (db: Exec, m: { to: string; subject: string; text: string }, runAt?: Date) => Promise<void>;
  outbox: (db: Exec, type: string, payload: unknown, runAt?: Date) => Promise<void>;
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
  /** Writes an export file to storage and returns a presigned download. */
  publishFile: (name: string, content: string, type: string) => Promise<{ url: string; expiresAt: string; key: string; name: string }>;
};
export type Fin = Awaited<ReturnType<typeof open>>;
/** Actor, effective settings and the party directory for one request; `rec` audits as the actor (in-tx, see runner). */
export async function open(db: Exec, user: SessionUser | "system", deps: FinDeps) {
  const [me, S, D] = await Promise.all([
    user === "system" ? ({ id: "system", name: "System", roles: ["staff:finance"] } as Actor) : actorOf(db, user),
    settings(db),
    directory(db),
  ]);
  const audits: AuditEntry[] = [];
  const rec = (action: string, kind: string, id: string, before: unknown, afterV: unknown, reason?: string | null, category?: string) => {
    audits.push(auditEntry(action, kind, id, before, afterV, reason, category));
  };
  return { db, me, S, D, rec, audits, deps };
}
