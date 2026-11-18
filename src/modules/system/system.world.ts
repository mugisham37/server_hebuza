// System admin world (P10): loads the system store into one snapshot, runs a business operation on it and writes back
// only the documents that changed (same pattern as procurement.world.ts). Writes hold one transaction-scoped advisory
// lock, so two admin mutations never interleave (no lost approvals, double-applied grants or version races).
// Audit rows are written in the same transaction (AuditService, hash-chained) with actor, role, IP and approval refs.
import { Logger } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import type { ConfigService } from "@nestjs/config";
import type Redis from "ioredis";
import { systemRecords, users } from "@/db/schema";
import type { AuthService } from "../auth/auth.service";
import type { PublicCache } from "../catalogue/cache";
import { normalizeRoles, type Role } from "@/domain/auth/roles";
import type { Db, Tx } from "../../core/db/db";
import type { TxService } from "../../core/db/tx";
import type { AuditService } from "../../core/db/audit";
import type { OutboxEvent, OutboxService } from "../../core/db/outbox";
import type { QueueService } from "../../core/queue/queues";
import type { CryptoService } from "../../core/crypto/crypto.service";
import type { TokenService } from "../../core/auth/tokens";
import type { PasswordService } from "../../core/auth/password";
import type { StorageService } from "../../core/storage/storage.service";
import type { Env } from "../../core/config/env";
import type { SessionUser } from "../../core/http/context";
import { AppError } from "../../core/http/errors";
import { propose, tick, type Approver } from "@/domain/system/approvals";
import { SETTINGS as SETTING_DEFS } from "@/domain/system/settings-registry";
import type {
  AlertVM,
  BackupVM,
  BreakGlassVM,
  BudgetVM,
  ChainReport,
  ChangeKind,
  ChangeRequestVM,
  ComponentHealthVM,
  DeliveryVM,
  DependencyVM,
  DrillVM,
  DsrStatus,
  DsrVM,
  EventRuleVM,
  IncidentVM,
  IntegrationVM,
  MfaState,
  PersonRef,
  PostureVM,
  ProcessorVM,
  RetentionRow,
  ReviewCampaignVM,
  RoleGrant,
  ServiceAccountVM,
  SettingValueVM,
  SodWaiverVM,
  TemplateVM,
  UserStatus,
} from "@/domain/system/types";
import type { LanguageDraft, RoleRowVM } from "./lib/vm";

// ---------------------------------------------------------------- documents
/** IAM overlay on a `users` row: what the FastAPI schema has no column for. */
export type UserMeta = {
  id: string;
  status?: UserStatus;
  extraRoles?: RoleGrant[];
  version: number;
  invitation?: { expiresAt: string; invitedBy: string };
  createdBy?: string;
  managerName?: string;
  isBootstrap?: boolean;
  mfaState?: MfaState;
  grantedBy?: string;
};
export type IdentityMeta = {
  id: string;
  userId?: string;
  managerName?: string;
  decidedBy?: string;
  decidedAt?: string;
  declineReason?: string;
};
export type DsrDoc = DsrVM & {
  version: number;
  events: { at: string; status: DsrStatus }[];
};
export type StatusPost = {
  id: string;
  component: string;
  state: string;
  message: Record<string, string>;
  at: string;
  by: string;
};
export type Meta = {
  counters: Record<string, number>;
  settingsVersion: number;
  rulesVersion: number;
  costsVersion: number;
  templateRev: Record<string, number>;
  payLater: boolean;
  verify: ChainReport | null;
  notifiedAt: string | null;
  p95: number[];
  uptime: { date: string; up: number }[];
  slow: { path: string; p95: number }[];
  jobs: { name: string; failures: number; lastAt: string }[];
  links: { label: string; href: string }[];
  env: "production" | "sandbox" | "staging";
};

const COLS = {
  changes: "id",
  reviews: "id",
  waivers: "id",
  serviceAccounts: "id",
  customRoles: "slug",
  integrations: "key",
  templates: "key",
  rules: "event",
  deliveries: "id",
  budgets: "channel",
  processors: "id",
  retention: "category",
  dsrs: "id",
  components: "key",
  backups: "id",
  drills: "id",
  incidents: "id",
  dependencies: "id",
  posture: "id",
  alerts: "id",
  drafts: "code",
  statusPosts: "id",
  userMeta: "id",
  identityMeta: "id",
  settings: "key",
} as const;
type ColName = keyof typeof COLS;

export type World = {
  changes: ChangeRequestVM[];
  reviews: ReviewCampaignVM[];
  waivers: SodWaiverVM[];
  serviceAccounts: ServiceAccountVM[];
  customRoles: RoleRowVM[];
  integrations: IntegrationVM[];
  templates: TemplateVM[];
  rules: EventRuleVM[];
  deliveries: DeliveryVM[];
  budgets: BudgetVM[];
  processors: ProcessorVM[];
  retention: RetentionRow[];
  dsrs: DsrDoc[];
  components: ComponentHealthVM[];
  backups: BackupVM[];
  drills: DrillVM[];
  incidents: IncidentVM[];
  dependencies: DependencyVM[];
  posture: PostureVM[];
  alerts: AlertVM[];
  drafts: LanguageDraft[];
  statusPosts: StatusPost[];
  userMeta: UserMeta[];
  identityMeta: IdentityMeta[];
  settings: SettingValueVM[];
  breakGlass: BreakGlassVM;
  meta: Meta;
  /** kind "secret": AES-GCM ciphertext of write-only credentials. Never leaves the server. */
  secrets: Map<string, string>;
  audits: AuditRec[];
  afterCommit: (() => Promise<unknown>)[];
  /** Outbox events written in the same tx as the state change. */
  events: OutboxEvent[];
  db: Exec;
  actor: Actor;
  caller: Caller;
};
export type AuditRec = {
  action: string;
  kind: string;
  id: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  by?: Actor;
  extra?: Record<string, unknown>;
};
export type Actor = Approver & { sessionId: string };

export const DEFAULT_META: Meta = {
  counters: {},
  settingsVersion: 1,
  rulesVersion: 1,
  costsVersion: 1,
  templateRev: {},
  payLater: false,
  verify: null,
  notifiedAt: null,
  p95: [],
  uptime: [],
  slow: [],
  jobs: [],
  links: [],
  env: "production",
};
const DEFAULT_BG: BreakGlassVM = { state: "sealed", lastUsedAt: null };

type Loaded = {
  world: World;
  orig: Map<string, string>;
  pos: Map<string, number>;
};

async function load(db: Exec, actor: Actor, caller: Caller): Promise<Loaded> {
  const rows = await db
    .select()
    .from(systemRecords)
    .orderBy(asc(systemRecords.pos));
  const w = {
    ...Object.fromEntries(Object.keys(COLS).map((c) => [c, []])),
    breakGlass: { ...DEFAULT_BG },
    meta: structuredClone(DEFAULT_META),
    secrets: new Map(),
    audits: [],
    afterCommit: [],
    events: [],
    db,
    actor,
    caller,
  } as unknown as World;
  const orig = new Map<string, string>(),
    pos = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.kind}:${r.id}`;
    orig.set(k, JSON.stringify(r.data));
    pos.set(k, r.pos);
    if (r.kind === "single" && r.id === "meta")
      w.meta = { ...w.meta, ...(r.data as Meta) };
    else if (r.kind === "single" && r.id === "break_glass")
      w.breakGlass = r.data as BreakGlassVM;
    else if (r.kind === "secret")
      w.secrets.set(r.id, String((r.data as { enc: string }).enc));
    else if (r.kind in COLS) (w[r.kind as ColName] as unknown[]).push(r.data);
  }
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
  for (const [col, key] of Object.entries(COLS) as [ColName, string][]) {
    const arr = w[col] as unknown as Record<string, string>[];
    const firstOld = arr.findIndex((x) => pos.has(`${col}:${x[key]}`));
    arr.forEach((x, i) => put(col, x[key], x, firstOld > -1 && i < firstOld)); // unshift()ed docs stay in front
  }
  put("single", "meta", w.meta);
  put("single", "break_glass", w.breakGlass);
  for (const [id, enc] of w.secrets) put("secret", id, { enc });
  if (!out.length) return;
  const now = new Date().toISOString();
  await db
    .insert(systemRecords)
    .values(out.map((r) => ({ ...r, updatedAt: now })))
    .onConflictDoUpdate({
      target: [systemRecords.kind, systemRecords.id],
      set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at` },
    });
}

const log = new Logger("system");
/** Post-commit side work (object writes). Fire-and-forget: the state change already committed. */
export function later(fn: () => Promise<unknown>) {
  void fn().catch((e: unknown) =>
    log.error({ err: String(e) }, "system_after_commit_failed"),
  );
}

// ---------------------------------------------------------------- callers
/** Query surface shared by the root client and a transaction. */
export type Exec = Pick<
  Db,
  "select" | "insert" | "update" | "delete" | "execute" | "transaction"
>;
export type Session = SessionUser;
/** Injected services the system logic needs; built once by SystemStore. */
export type SystemDeps = {
  db: Db;
  tx: TxService;
  audit: AuditService;
  outbox: OutboxService;
  crypto: CryptoService;
  tokens: TokenService;
  auth: AuthService;
  cache: PublicCache;
  password: PasswordService;
  storage: StorageService;
  queues: QueueService;
  redis: Redis;
  config: ConfigService<Env, true>;
};
export type Caller = {
  deps: SystemDeps;
  db: Exec;
  session: Session | null;
  ip?: string;
  requestId?: string;
  userAgent?: string;
  ifMatch?: string | null;
  stepUpToken?: string;
};
export const SYSTEM_ACTOR: Actor = {
  id: "system",
  name: "HEBUZA system",
  roles: [],
  sessionId: "",
};

export async function actorOf(c: Caller): Promise<Actor> {
  const s = c.session;
  if (!s) return SYSTEM_ACTOR;
  const [u] = await c.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, s.id))
    .limit(1);
  return { id: s.id, name: u?.name ?? s.id, roles: s.roles, sessionId: s.sid };
}

/** Read-only snapshot (no lock). Proposals past their expiry are shown expired (the cron persists it). */
export async function read<T>(
  c: Caller,
  fn: (w: World) => T | Promise<T>,
): Promise<T> {
  const l = await load(c.db, await actorOf(c), c);
  const now = Date.now();
  l.world.changes = l.world.changes.map((cr) =>
    cr.state === "proposed" ? tick(cr, now) : cr,
  );
  return fn(l.world);
}

/** Serialised mutation: lock → load → run → save → audit rows (same tx) → after-commit work. */
export async function write<T>(
  c: Caller,
  fn: (w: World) => T | Promise<T>,
): Promise<T> {
  const actor = await actorOf(c);
  const run = async (db: Tx) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtext('system_world'))`,
    );
    const l = await load(db, actor, { ...c, db });
    await sweepChanges(l.world);
    const res = await fn(l.world);
    await save(db, l);
    for (const e of l.world.events) await c.deps.outbox.add(db, e);
    for (const a of l.world.audits)
      await c.deps.audit.record(db, {
        action: a.action,
        entity: a.kind,
        entityId: a.id,
        before: a.before ?? null,
        // shortcut: AuditService stores only before/after/reason, so approvalRef/breakGlass/batchId ride in `after`; move to a details field when core/db/audit grows one.
        after: Object.keys(a.extra ?? {}).length
          ? { value: a.after ?? null, ...a.extra }
          : (a.after ?? null),
        reason: a.reason,
      });
    return { res, w: l.world };
  };
  const { res, w } = await (c.session
    ? c.deps.tx.run(run)
    : c.deps.tx.runAsSystem(run));
  for (const job of w.afterCommit) later(job);
  return res;
}
/** Deployment flags the console shows (prod gates dev-only tools; https gates the TLS setup item). */
export const envOf = (x: { caller: Caller } | Caller) => {
  const cfg = ("caller" in x ? x.caller : x).deps.config;
  return {
    prod: cfg.get("NODE_ENV", { infer: true }) === "production",
    https: cfg.get("WEB_ORIGIN", { infer: true }).startsWith("https://"),
  };
};
/** Worker/cron mutation as the system actor. */
export const systemWrite = <T>(
  deps: SystemDeps,
  fn: (w: World) => T | Promise<T>,
) => write({ deps, db: deps.db, session: null }, fn);

/** One catalogue event. `extra` carries approvalRef / breakGlass / batchId. */
export function record(
  w: World,
  action: string,
  kind: string,
  id: string,
  before?: unknown,
  afterV?: unknown,
  reason?: string,
  by?: Actor,
  extra: Record<string, unknown> = {},
) {
  w.audits.push({
    action,
    kind,
    id,
    before,
    after: afterV,
    reason,
    by,
    extra: {
      ...(w.breakGlass.state === "active" ? { breakGlass: true } : {}),
      ...extra,
    },
  });
}

// ---------------------------------------------------------------- guards and errors (mock envelope codes)
export const fail = (status: number, code: string, message?: string, data?: Record<string, unknown>) =>
  new AppError(status, code, message ?? code, undefined, data);
export const invalidFields = (fields: Record<string, string>) =>
  new AppError(422, "validation", "validation", fields);
/** FastAPI-style 422: field errors in `detail`. */
export const invalidDetail = invalidFields;

export const isSysadmin = (a: { roles: readonly string[] }) =>
  a.roles.includes("staff:sysadmin");
export const isExec = (a: { roles: readonly string[] }) =>
  a.roles.includes("staff:executive");
/** 403 forbidden_role unless a sysadmin (or an executive when `exec`). Checked before step-up, as the mocks do. */
export function guard(s: Session | null, exec = false): Session {
  if (!s) throw new AppError(401, "unauthenticated", "Not signed in");
  if (isSysadmin(s) || (exec && isExec(s))) return s;
  throw fail(403, "forbidden_role", "Not available to your role.");
}
/** Conditional step-up (only some branches need it), so it is checked here instead of @Route({ stepUp }). */
export async function stepUp(c: Caller, s: Session) {
  const ok =
    c.stepUpToken &&
    (await c.deps.tokens.verifyStepUp(c.stepUpToken, s).catch(() => false));
  if (!ok)
    throw new AppError(401, "step_up_required", "Confirm it's you to continue");
}
/** If-Match must equal the resource version (409 stale). Absent header = no check (UI sends it where it matters). */
export function stale(ifMatch: string | null | undefined, version: number) {
  if (ifMatch && ifMatch !== "*" && Number(ifMatch) !== version)
    throw fail(409, "stale", "Changed since you loaded it.");
}
/** 202 "Pending approval": unwrapped by AcceptedInterceptor, which sets the status. */
export class Accepted<T> {
  constructor(readonly data: T) {}
}
export const accepted = <T>(data: T) => new Accepted(data);

// ---------------------------------------------------------------- ids, secrets, settings
const YEAR = () => new Date().getUTCFullYear();
export function nextNo(w: World, prefix: string, pad = 4, withYear = true) {
  const n = (w.meta.counters[prefix] = (w.meta.counters[prefix] ?? 0) + 1);
  return withYear
    ? `${prefix}-${YEAR()}-${String(n).padStart(pad, "0")}`
    : `${prefix}-${String(n).padStart(pad, "0")}`;
}
export const nextChangeId = (w: World) => nextNo(w, "CR");
export const setSecret = (w: World, id: string, value: string) =>
  w.secrets.set(id, w.caller.deps.crypto.encrypt(value));
export const getSecret = (w: World, id: string) => {
  const s = w.secrets.get(id);
  return s ? w.caller.deps.crypto.decrypt(s) : undefined;
};

export function settingValue<T = unknown>(w: World, key: string): T {
  const v = w.settings.find((s) => s.key === key);
  return (v ? v.value : SETTING_DEFS.find((d) => d.key === key)?.default) as T;
}
export function settingsMap(w: World): Record<string, SettingValueVM> {
  const out: Record<string, SettingValueVM> = {};
  for (const d of SETTING_DEFS)
    out[d.key] = {
      key: d.key,
      value: d.default,
      changedBy: null,
      changedAt: null,
    };
  for (const s of w.settings) out[s.key] = s;
  return out;
}
export function putSetting(
  w: World,
  key: string,
  value: unknown,
  by: string | null,
  pending?: string,
) {
  const i = w.settings.findIndex((s) => s.key === key);
  const before =
    i >= 0
      ? w.settings[i].value
      : SETTING_DEFS.find((d) => d.key === key)?.default;
  const next: SettingValueVM = {
    key,
    value,
    changedBy: by,
    changedAt: new Date().toISOString(),
    ...(pending ? { pending } : {}),
  };
  if (i >= 0) w.settings[i] = next;
  else w.settings.push(next);
  return before;
}
export const person = (a: PersonRef): PersonRef => ({ id: a.id, name: a.name });

// ---------------------------------------------------------------- approvals engine (core): proposals + appliers
type Applier = (w: World, cr: ChangeRequestVM) => Promise<void> | void;
const APPLIERS = new Map<ChangeKind, Applier>();
/** Domain hook: what happens when a change of this kind is applied (grant the role, write the setting, …). */
export const onApply = (kind: ChangeKind, fn: Applier) =>
  void APPLIERS.set(kind, fn);
export async function applied(w: World, cr: ChangeRequestVM) {
  await APPLIERS.get(cr.kind)?.(w, cr);
  record(
    w,
    "config.change.applied",
    "change",
    cr.id,
    undefined,
    cr.after,
    undefined,
    undefined,
    { approvalRef: cr.id },
  );
}
/** Store a proposal, audit it. Callers return accepted(cr) (202). */
export function submitChange(
  w: World,
  p: Omit<Parameters<typeof propose>[0], "id" | "now" | "by"> & {
    by?: PersonRef;
  },
) {
  const cr = propose({
    ...p,
    id: nextChangeId(w),
    now: Date.now(),
    by: person(p.by ?? w.actor),
  });
  w.changes.unshift(cr);
  record(
    w,
    "config.change.proposed",
    "change",
    cr.id,
    cr.before,
    cr.after,
    cr.reason,
    undefined,
    { approvalRef: cr.id },
  );
  return cr;
}
/** Expire stale proposals, apply approved ones whose effective time came (every write and the minute cron). */
export async function sweepChanges(w: World, now = Date.now()) {
  for (let i = 0; i < w.changes.length; i++) {
    const c = w.changes[i],
      n = tick(c, now);
    if (n === c) continue;
    w.changes[i] = n;
    record(
      w,
      n.state === "expired" ? "config.change.expired" : "config.change.applied",
      "change",
      n.id,
      { state: c.state },
      { state: n.state },
      undefined,
      SYSTEM_ACTOR,
    );
    if (n.state === "applied") await APPLIERS.get(n.kind)?.(w, n);
  }
}

// ---------------------------------------------------------------- shared lookups
export const roleOfSession = (roles: readonly string[]): Role[] =>
  normalizeRoles({ roles });
