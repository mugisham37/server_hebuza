// P10 shell + approvals core (summary, alerts, setup, ⌘K search, change requests, overview — handlers-system +
// handlers-system-a), privacy (U15: data map, processors, retention, DSR export/erase, legal hold) and operations
// (U16: monitoring, backups, drills, restore, posture, dependencies, status posts, incidents) — handlers-system-f.
import { breachDeadline, type Breach } from "@/domain/system/incidents";
import { latestBackup } from "./lib/backup-status";
import type { Tx } from "../../core/db/db";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { applications, auditLog, notifications, users } from "@/db/schema";
import { QUEUES } from "../../core/queue/queues";
import { decide, withdraw } from "@/domain/system/approvals";
import { DSR_NEXT, blockedByHold } from "@/domain/system/privacy";
import {
  BACKUP_TIERS,
  INCIDENT_NEXT,
  launchGateOpen,
  postmortemDue,
} from "@/domain/system/incidents";
import { SETTINGS } from "@/domain/system/settings-registry";
import type {
  ChangeArea,
  ComponentHealthVM,
  DsrStatus,
  Health,
  IncidentVM,
  ProcessorVM,
  SetupItem,
  SystemSummary,
} from "@/domain/system/types";
import type { Card, OverviewVM } from "./lib/vm";
import type { DataMapRow, Visibility } from "./lib/vm";
import { currentImpersonation } from "./system.identity";
import { recentPrivileged } from "./system.audit";
import { identityRequests, people } from "./system.users";
import {
  accepted,
  applied,
  fail,
  guard,
  isSysadmin,
  nextNo,
  onApply,
  person,
  read,
  record,
  settingValue,
  stale,
  stepUp,
  submitChange,
  envOf,
  write,
  type Caller,
  type DsrDoc,
  type World,
} from "./system.world";
import { iso } from "../../core/db/ids";

const H = 3_600_000;
const tooShort = (s?: string) => (s ?? "").trim().length < 10;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ================================================================ shell
async function setupItems(w: World): Promise<SetupItem[]> {
  const ps = await people(w);
  const sysadmins = ps.filter(
    (u) =>
      u.status === "active" &&
      !u.isBootstrap &&
      u.roles.some((g) => g.role === "staff:sysadmin"),
  ).length;
  const boot = ps.find((u) => u.isBootstrap);
  const ok = (k: string) =>
    !!w.integrations.find((i) => i.key === k)?.lastTest?.ok;
  return [
    {
      key: "two_sysadmins",
      done: sysadmins >= 2,
      href: "/system/users?dialog=invite",
    },
    {
      key: "bootstrap_disabled",
      done: !boot || boot.status === "deactivated",
      href: "/system/users?tab=service",
    },
    {
      key: "legacy_split",
      done: !ps.some(
        (u) =>
          u.status === "active" &&
          u.roles.some((g) => g.role === "staff:admin"),
      ),
      href: "/system/users?tab=service",
    },
    { key: "mfa_enforced", done: true, href: "/system/settings/security" },
    {
      key: "email_tested",
      done: ok("resend"),
      href: "/system/integrations/resend",
    },
    {
      key: "payments_sandbox",
      done: ok("mtn-momo"),
      href: "/system/integrations/mtn-momo",
    },
    {
      key: "domain_tls",
      done: envOf(w).https,
      href: "/system/ops?tab=security",
    },
    {
      key: "backups_drill",
      done: w.drills.some((d) => d.ok),
      href: "/system/ops?tab=backups",
    },
  ];
}
export function summary(c: Caller) {
  const s = guard(c.session);
  return read(c, async (w): Promise<SystemSummary> => {
    const imp = await currentImpersonation(w.db, s.id);
    const [tgt] = imp
      ? await w.db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.userId, imp.targetId))
      : [];
    const bg = w.breakGlass,
      win = settingValue<{ end: string } | null>(w, "maintenance.window");
    return {
      approvals: w.changes.filter(
        (x) => x.state === "proposed" && x.proposedBy.id !== s.id,
      ).length,
      identity: (await identityRequests(w)).filter(
        (i) => i.status === "pending" || i.status === "in_review",
      ).length,
      reviewsDue: w.reviews.filter(
        (x) => x.status === "open" || x.status === "overdue",
      ).length,
      degraded: w.integrations.filter(
        (i) => i.health === "degraded" || i.health === "down",
      ).length,
      untested: w.integrations.filter((i) => i.health === "untested").length,
      alertsUnread: w.alerts.filter((a) => !a.read).length,
      setupIncomplete: (await setupItems(w)).filter((x) => !x.done).length,
      breakGlass: bg.state,
      breakGlassUntil: bg.activeUntil ?? null,
      impersonation: imp
        ? {
            targetId: imp.targetId,
            targetName: tgt?.name ?? imp.targetId,
            reason: imp.reason,
            until: new Date(imp.until).toISOString(),
            startedAt: new Date(imp.startedAt).toISOString(),
            by: person(w.actor),
          }
        : null,
      maintenance: {
        on: settingValue(w, "maintenance.on") === true,
        message: settingValue(w, "maintenance.message"),
        until: win?.end ?? null,
      },
      env: w.meta.env,
      me: { id: w.actor.id, name: w.actor.name, roles: w.actor.roles },
    };
  });
}
export function alerts(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({ items: w.alerts }));
}
export function markAlerts(c: Caller, ids: string[] | "all") {
  guard(c.session);
  return write(c, (w) => {
    w.alerts.forEach((a) => {
      if (ids === "all" || ids.includes(a.id)) a.read = true;
    });
    return { items: w.alerts };
  });
}
export function setup(c: Caller) {
  guard(c.session);
  return read(c, async (w) => ({ items: await setupItems(w) }));
}
/** ⌘K sources (§8.3): users, settings keys, integrations, templates. Never case refs. Emails masked. */
export async function search(c: Caller, q: string) {
  guard(c.session);
  const n = q.trim().toLowerCase();
  if (!n) return { users: [], settings: [], integrations: [], templates: [] };
  const has = (...xs: string[]) => xs.some((x) => x.toLowerCase().includes(n));
  return read(c, async (w) => ({
    users: (await people(w))
      .filter((u) => has(u.name, u.email))
      .slice(0, 6)
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email.replace(/^(.{1,5}).*@/, "$1…@"),
        kind: u.kind,
      })),
    settings: SETTINGS.filter((d) => has(d.key))
      .slice(0, 5)
      .map((d) => ({ key: d.key, group: d.group })),
    integrations: w.integrations
      .filter((i) => has(i.name, i.key))
      .slice(0, 4)
      .map((i) => ({ key: i.key, name: i.name })),
    templates: w.templates
      .filter((t) => has(t.key))
      .slice(0, 4)
      .map((t) => ({ key: t.key, channel: t.channel })),
  }));
}

// ================================================================ approvals (U2)
export function changes(c: Caller, q: { area?: string; state?: string }) {
  const s = guard(c.session, true);
  const exec = !isSysadmin(s);
  return read(c, (w) => ({
    items: w.changes.filter(
      (x) =>
        (!q.area || q.area === "all" || x.area === (q.area as ChangeArea)) &&
        (!q.state ||
          (q.state === "pending"
            ? x.state === "proposed"
            : x.state !== "proposed")) &&
        (!exec ||
          x.approvers.some(
            (a) =>
              a.role === "staff:executive" ||
              a.anyOf?.includes("staff:executive"),
          )),
    ),
  }));
}
export function change(c: Caller, id: string) {
  guard(c.session, true);
  return read(c, (w) => {
    const cr = w.changes.find((x) => x.id === id);
    if (!cr) throw fail(404, "not_found", "Not found.");
    return cr;
  });
}
export async function decideChange(
  c: Caller,
  id: string,
  b: { decision: "approve" | "reject"; reason?: string },
) {
  await stepUp(c, guard(c.session, true));
  return write(c, async (w) => {
    const i = w.changes.findIndex((x) => x.id === id);
    if (i < 0) throw fail(404, "not_found", "Not found.");
    const cur = w.changes[i];
    if (cur.state === "proposed") stale(c.ifMatch, cur.version);
    const res = decide(cur, w.actor, b.decision, Date.now(), b.reason);
    if (!res.ok) {
      const status =
        res.error === "expired"
          ? 410
          : res.error === "already_decided"
            ? 409
            : res.error === "reason_required"
              ? 422
              : 403;
      throw fail(status, res.error, res.error, { state: cur.state });
    }
    w.changes[i] = res.next;
    record(
      w,
      b.decision === "approve"
        ? "config.change.approved"
        : "config.change.rejected",
      "change",
      cur.id,
      { state: cur.state },
      { state: res.next.state },
      b.reason,
      undefined,
      { approvalRef: cur.id },
    );
    if (res.next.state === "applied") await applied(w, res.next);
    return w.changes[i];
  });
}
export async function withdrawChange(c: Caller, id: string) {
  guard(c.session, true);
  return write(c, (w) => {
    const i = w.changes.findIndex((x) => x.id === id);
    if (i < 0) throw fail(404, "not_found", "Not found.");
    const res = withdraw(w.changes[i], w.actor.id);
    if (!res.ok)
      throw fail(
        res.error === "already_decided" ? 409 : 403,
        res.error,
        res.error,
      );
    w.changes[i] = res.next;
    record(
      w,
      "config.change.withdrawn",
      "change",
      res.next.id,
      undefined,
      undefined,
      undefined,
      undefined,
      { approvalRef: res.next.id },
    );
    return res.next;
  });
}
/** Proposer re-files an expired/withdrawn/rejected request as a new one (fresh 48 h, approvers recomputed). */
export async function repropose(c: Caller, id: string) {
  await stepUp(c, guard(c.session));
  return write(c, (w) => {
    const old = w.changes.find((x) => x.id === id);
    if (!old) throw fail(404, "not_found", "Not found.");
    if (old.proposedBy.id !== w.actor.id)
      throw fail(
        403,
        "forbidden_role",
        "Only the requester can propose again.",
      );
    if (
      old.state === "proposed" ||
      old.state === "approved" ||
      old.state === "applied"
    )
      throw fail(409, "already_decided", "Still open or already applied.");
    return accepted(
      submitChange(w, {
        kind: old.kind,
        title: old.title,
        reason: old.reason,
        before: old.before,
        after: old.after,
        payload: old.payload,
        effectiveAt:
          old.effectiveAt && Date.parse(old.effectiveAt) > Date.now()
            ? old.effectiveAt
            : null,
      }),
    );
  });
}
/** Dev only: remembers the scenario label for the dev panel. shortcut: scenarios change no server behaviour (real
 *  health comes from probes); drop with the dev panel at P13. */
export async function simulate(c: Caller, scenario: string) {
  guard(c.session);
  if (envOf(c).prod) throw fail(404, "not_found", "Not found.");
  return { scenario };
}

// ================================================================ live component health (probes, 2 s budget each)
const within = <T>(p: Promise<T>, ms = 2000) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("timeout")), ms),
    ),
  ]);
async function probe(
  key: string,
  name: string,
  fn: () => Promise<string>,
): Promise<ComponentHealthVM> {
  const t = Date.now();
  try {
    const detail = await within(fn());
    return {
      key,
      name,
      health: "operational",
      detail: detail || `${Date.now() - t} ms`,
      checkedAt: iso(),
    };
  } catch (e) {
    return {
      key,
      name,
      health: "down",
      detail: String((e as Error).message ?? e).slice(0, 120),
      checkedAt: iso(),
    };
  }
}
async function queueStats(w: World) {
  return Promise.all(
    QUEUES.map(async (name) => {
      const n = await w.caller.deps.queues
        .get(name)
        .getJobCounts("failed", "waiting", "delayed");
      return {
        name,
        failures: n.failed ?? 0,
        backlog: (n.waiting ?? 0) + (n.delayed ?? 0),
      };
    }),
  );
}
export async function liveComponents(w: World): Promise<ComponentHealthVM[]> {
  const stats = await queueStats(w).catch(() => null);
  const backlog = stats?.reduce((s, x) => s + x.backlog, 0) ?? 0,
    failed = stats?.reduce((s, x) => s + x.failures, 0) ?? 0;
  const live = await Promise.all([
    probe("api", "API", async () => "Serving"),
    probe("db", "Database", async () => {
      const [r] = await w.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity`,
      );
      return `Connections ${r?.n ?? 0}`;
    }),
    probe("redis", "Redis", async () => {
      await w.caller.deps.redis.ping();
      return "Ping ok";
    }),
    probe("storage", "Storage", async () => {
      await w.caller.deps.storage.head("healthcheck");
      return "Bucket reachable";
    }),
  ]);
  const queues: ComponentHealthVM = stats
    ? {
        key: "queues",
        name: "Queues",
        health: failed > 20 || backlog > 500 ? "degraded" : "operational",
        detail: `Backlog ${backlog} · ${failed} failed (24 h)`,
        checkedAt: iso(),
      }
    : {
        key: "queues",
        name: "Queues",
        health: "down",
        detail: "Queue store unreachable",
        checkedAt: iso(),
      };
  const worker: ComponentHealthVM = {
    key: "worker",
    name: "Worker heartbeat",
    health: stats ? "operational" : queues.health,
    detail: stats ? "BullMQ reachable" : queues.detail,
    checkedAt: iso(),
  };
  // Components only an external monitor knows (seeded/updated by the monitor webhook) keep their stored row.
  const extra = w.components.filter(
    (c) =>
      !["api", "db", "redis", "storage", "queues", "worker"].includes(c.key),
  );
  return [live[0], worker, live[1], live[2], live[3], queues, ...extra];
}

// ================================================================ overview (U1): each card fails on its own
async function cardOf<T>(fn: () => Promise<T> | T): Promise<Card<T>> {
  try {
    return { ok: true, data: await fn(), at: iso() };
  } catch {
    return { ok: false, data: null, at: null };
  }
}
export function overview(c: Caller) {
  guard(c.session);
  return read(c, async (w): Promise<OverviewVM> => {
    const ps = await people(w).catch(() => null);
    const staffOf = () =>
      ps!.filter(
        (u) =>
          u.kind === "staff" &&
          !["deactivated", "invite_revoked", "invite_expired"].includes(
            u.status,
          ),
      );
    const [health, recent] = await Promise.all([
      cardOf(() => liveComponents(w)),
      cardOf(() => recentPrivileged(w.db)),
    ]);
    return {
      health,
      users: await cardOf(() => {
        const p = ps!.filter((u) => u.kind === "staff" || u.kind === "agent");
        return {
          active: p.filter((u) => u.status === "active").length,
          invited: p.filter((u) => u.status === "invited").length,
          locked: p.filter((u) => u.status === "locked").length,
        };
      }),
      posture: await cardOf(() => {
        const staff = staffOf(),
          enrolled = staff.filter((u) => u.mfa.state === "enrolled");
        return {
          enrolled: enrolled.length,
          total: staff.length,
          pendingFirst: staff.filter((u) => u.status === "invited").length,
          withoutKey: enrolled.filter(
            (u) => !u.mfa.methods.includes("webauthn"),
          ).length,
          ipAllowlist:
            (settingValue<string[]>(w, "security.ip_allowlist.sysadmin") ?? [])
              .length > 0,
        };
      }),
      backup: await cardOf(async () => {
        const last = await latestBackup(w.caller.deps.config).catch(() => null);
        const drill = w.drills
          .filter((d) => d.ok)
          .sort((a, b) => b.at.localeCompare(a.at))[0];
        return {
          lastAt: last?.at ?? null,
          ok: last?.ok ?? false,
          nextAt: last ? new Date(Date.parse(last.at) + H).toISOString() : null,
          drillAt: drill?.at ?? null,
        };
      }),
      integrations: await cardOf(() => ({
        ok: w.integrations.filter(
          (i) => i.configured && i.health === "operational",
        ).length,
        degraded: w.integrations.filter(
          (i) => i.health === "degraded" || i.health === "down",
        ).length,
        untested: w.integrations.filter(
          (i) => i.configured && i.health === "untested",
        ).length,
        notSetUp: w.integrations.filter((i) => !i.configured).length,
      })),
      budgets: await cardOf(() =>
        w.budgets.filter((b) => b.channel !== "email"),
      ),
      review: await cardOf(() => {
        const r = w.reviews.find(
          (x) => x.status === "open" || x.status === "overdue",
        );
        return r
          ? {
              id: r.id,
              name: r.name,
              status: r.status,
              dueAt: r.dueAt,
              decided: r.items.filter((i) => i.decision !== "pending").length,
              total: r.items.length,
            }
          : null;
      }),
      recent,
    };
  });
}

// ================================================================ U15 privacy
const MAP_ROLES = [
  "client",
  "ext:agent",
  "staff:service_manager",
  "staff:finance",
  "staff:executive",
  "staff:sysadmin",
];
const vis = (...xs: Visibility[]): Record<string, Visibility> =>
  Object.fromEntries(MAP_ROLES.map((r, i) => [r, xs[i]]));
/** privacy §2 + spec/02 matrix. Locations are PLACEHOLDER(data-residency) until the hosting contract fixes them. */
const MAP: Omit<DataMapRow, "retention">[] = [
  {
    category: "Account",
    stored: "Primary DB",
    location: "EU (PLACEHOLDER)",
    visibility: vis("own", "masked", "full", "masked", "masked", "masked"),
  },
  {
    category: "Identity documents",
    stored: "Object storage (R2)",
    location: "EU (PLACEHOLDER)",
    visibility: vis("own", "full", "full", "none", "none", "none"),
  },
  {
    category: "Business / tax records",
    stored: "Primary DB + R2",
    location: "EU (PLACEHOLDER)",
    visibility: vis("own", "full", "full", "masked", "masked", "none"),
  },
  {
    category: "Financial records",
    stored: "Primary DB",
    location: "EU (PLACEHOLDER)",
    visibility: vis("own", "masked", "masked", "full", "full", "none"),
  },
  {
    category: "Communications",
    stored: "Primary DB + backups",
    location: "EU (PLACEHOLDER)",
    visibility: vis("own", "full", "full", "none", "none", "none"),
  },
  {
    category: "Field data",
    stored: "Primary DB + R2",
    location: "EU (PLACEHOLDER)",
    visibility: vis("own", "full", "full", "none", "none", "none"),
  },
  {
    category: "Marketing",
    stored: "Primary DB",
    location: "EU (PLACEHOLDER)",
    visibility: vis("own", "none", "masked", "none", "masked", "none"),
  },
  {
    category: "Analytics",
    stored: "Analytics store",
    location: "EU (PLACEHOLDER)",
    visibility: vis("none", "none", "masked", "masked", "masked", "masked"),
  },
  {
    category: "AI conversations",
    stored: "Primary DB · Anthropic (transient)",
    location: "US (PLACEHOLDER)",
    visibility: vis("own", "none", "masked", "none", "none", "none"),
  },
  {
    category: "Audit logs",
    stored: "Append-only log",
    location: "EU (PLACEHOLDER)",
    visibility: vis("none", "none", "none", "masked", "masked", "full"),
  },
];
export function dataMap(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({
    items: MAP.map((m) => ({
      ...m,
      retention:
        w.retention.find((r) => r.category === m.category)?.keep ?? "—",
    })),
    roles: MAP_ROLES,
    residencyOpen: true,
  }));
}
export function processors(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({ items: w.processors }));
}
export type ProcessorIn = Partial<Omit<ProcessorVM, "id">>;
export function addProcessor(c: Caller, b: ProcessorIn) {
  guard(c.session);
  if (!b.name?.trim() || !b.purpose?.trim() || !b.reviewDue)
    throw fail(422, "validation", "name, purpose, reviewDue required");
  return write(c, (w) => {
    const p: ProcessorVM = {
      id: `prc-${w.processors.length + 1}-${b.name!.toLowerCase().replace(/\W+/g, "-")}`.slice(
        0,
        90,
      ),
      name: b.name!.trim(),
      purpose: b.purpose!.trim(),
      data: b.data ?? [],
      location: b.location?.trim() || "PLACEHOLDER",
      dpaSignedAt: b.dpaSignedAt ?? null,
      reviewDue: b.reviewDue!,
      placeholder: !b.location?.trim(),
    };
    w.processors.push(p);
    record(w, "config.processor.changed", "processor", p.id, null, p);
    return p;
  });
}
export function patchProcessor(c: Caller, id: string, b: ProcessorIn) {
  guard(c.session);
  if (b.name !== undefined && !b.name.trim())
    throw fail(422, "validation", "name");
  return write(c, (w) => {
    const p = w.processors.find((x) => x.id === id);
    if (!p) throw fail(404, "not_found", "processor");
    const before = { ...p };
    Object.assign(
      p,
      b,
      { id: p.id },
      b.location !== undefined ? { placeholder: !b.location.trim() } : {},
    );
    record(w, "config.processor.changed", "processor", p.id, before, p);
    return p;
  });
}
export function retention(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({
    items: w.retention,
    pending: w.changes.filter(
      (x) => x.kind === "retention_change" && x.state === "proposed",
    ),
  }));
}
/** Counts only, nothing changes, no audit (read-only simulation). `due` is refreshed by the nightly retention job. */
export function retentionDryRun(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({
    items: w.retention.map((r) => ({
      category: r.category,
      due: r.due,
      action: r.action,
    })),
    ranAt: iso(),
  }));
}
onApply("retention_change", (w, cr) => {
  const row = w.retention.find((r) => r.category === cr.payload.category);
  if (!row) return;
  const before = row.keep;
  row.keep = String((cr.after as { keep: string }).keep);
  record(
    w,
    "config.retention.changed",
    "retention",
    row.category,
    { keep: before },
    { keep: row.keep },
    cr.reason,
    undefined,
    { approvalRef: cr.id },
  );
});
export async function proposeRetention(
  c: Caller,
  b: { category?: string; keep?: string; reason?: string },
) {
  await stepUp(c, guard(c.session));
  return write(c, (w) => {
    const row = w.retention.find((r) => r.category === b.category);
    if (!row) throw fail(404, "not_found", "category");
    if (!b.keep?.trim() || b.keep.trim() === row.keep || tooShort(b.reason))
      throw fail(422, "validation", "keep/reason");
    return accepted(
      submitChange(w, {
        kind: "retention_change",
        title: `${row.category} retention ${row.keep} → ${b.keep.trim()}`,
        reason: b.reason!.trim(),
        before: { category: row.category, keep: row.keep },
        after: { category: row.category, keep: b.keep.trim() },
        payload: { category: row.category },
      }),
    );
  });
}

// ---------------------------------------------------------------- DSRs
const dsrOut = ({ subjectId, ...d }: DsrDoc & { subjectId?: string }) => (
  void subjectId,
  d
);
export function dsrs(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({
    items: w.dsrs.map(
      ({ events, version, ...d }) => (
        void events,
        void version,
        dsrOut(d as DsrDoc)
      ),
    ),
  }));
}
export function dsr(c: Caller, id: string) {
  guard(c.session);
  return read(c, (w) => {
    const d = w.dsrs.find((x) => x.id === id);
    if (!d) throw fail(404, "not_found", "request");
    return dsrOut(d);
  });
}
/** Everything held about the subject that the export covers (privacy §4), as one JSON bundle. */
async function exportBundle(w: World, uid: string) {
  const [u] = await w.db
    .select({
      id: users.userId,
      name: users.name,
      email: users.email,
      phone: users.phoneE164,
      language: users.language,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.userId, uid));
  const apps = await w.db
    .select()
    .from(applications)
    .where(eq(applications.clientId, uid));
  const notes = await w.db
    .select({
      title: notifications.title,
      body: notifications.body,
      at: notifications.createdAt,
    })
    .from(notifications)
    .where(eq(notifications.userId, uid));
  const trail = await w.db
    .select({ at: auditLog.createdAt, action: auditLog.action })
    .from(auditLog)
    .where(
      and(eq(auditLog.resourceType, "user"), eq(auditLog.resourceId, uid)),
    );
  return {
    generatedAt: iso(),
    account: u ?? null,
    applications: apps,
    notifications: notes,
    accessHistory: trail,
  };
}
/** Erasure per DATA_CATEGORIES: account anonymised, communications anonymised, sessions ended; tax/financial retained. */
async function erase(w: World, uid: string) {
  await w.db
    .update(users)
    .set({
      name: "Erased user",
      email: null,
      phoneE164: null,
      isActive: false,
      updatedAt: iso(),
    })
    .where(eq(users.userId, uid));
  await w.db.delete(notifications).where(eq(notifications.userId, uid));
  await w.caller.deps.auth.revokeAllSessions(w.db as Tx, uid);
  // shortcut: identity-document objects are deleted by the documents module's purge job (P3); erasure flags the
  // subject via the audit row, not by deleting storage objects here.
}
export async function dsrAction(
  c: Caller,
  id: string,
  action: string,
  reason?: string,
) {
  const s = guard(c.session);
  if (action === "complete") await stepUp(c, s);
  return write(c, async (w) => {
    const d = w.dsrs.find((x) => x.id === id) as
      (DsrDoc & { subjectId?: string }) | undefined;
    if (!d) throw fail(404, "not_found", "request");
    stale(c.ifMatch, d.version);
    let next: DsrStatus;
    if (action === "start")
      next = d.status === "received" ? "verifying" : "in_progress";
    else if (action === "complete") next = "completed";
    else if (action === "reject") next = "rejected";
    else throw fail(404, "not_found", "action");
    if (!DSR_NEXT[d.status].includes(next))
      throw fail(409, "already_decided", "invalid transition");
    if (next === "rejected" && tooShort(reason))
      throw fail(422, "validation", "reason");
    if (next === "completed") {
      if (blockedByHold(d)) throw fail(409, "legal_hold", "legal hold");
      if (d.subjectId) {
        if (d.type === "export") {
          const body = JSON.stringify(
            await exportBundle(w, d.subjectId),
            null,
            2,
          );
          d.bundleHash = sha(body);
          w.afterCommit.push(() =>
            w.caller.deps.storage.putObject(
              `dsr/${d.id}.json`,
              body,
              "application/json",
            ),
          );
        } else if (d.type === "erasure") {
          await erase(w, d.subjectId);
          d.bundleHash = sha(`${d.id}|${d.subjectNo}|${d.type}|${iso()}`);
        } else d.bundleHash = sha(`${d.id}|${d.subjectNo}|${d.type}|${iso()}`);
      } else d.bundleHash = sha(`${d.id}|${d.subjectNo}|${d.type}|${iso()}`);
    }
    if (next === "verifying") d.verification ??= "OTP to number on file";
    if (next === "rejected") d.rejectReason = reason!.trim();
    const before = d.status;
    d.status = next;
    d.version++;
    d.events.push({ at: iso(), status: next });
    if (next === "completed")
      record(
        w,
        d.type === "erasure"
          ? "data_deletion.record.erased"
          : "data_export.client_data.exported",
        "dsr",
        d.id,
        { status: before },
        { status: next, bundleHash: d.bundleHash },
      );
    else
      record(
        w,
        "privacy.dsr.updated",
        "dsr",
        d.id,
        { status: before },
        { status: next },
        reason,
      );
    return dsrOut(d);
  });
}

// ================================================================ U16 operations
export function monitoring(c: Caller) {
  guard(c.session);
  return read(c, async (w) => {
    const stats = await queueStats(w).catch(() => null);
    const jobs = stats
      ? stats
          .filter((s) => s.failures > 0)
          .map((s) => ({
            name: s.name,
            failures: s.failures,
            lastAt: iso(),
          }))
      : w.meta.jobs;
    // shortcut: p95 / error-rate / uptime / slow paths are the stored monitor feed (PLACEHOLDER(monitoring-source));
    // wire the OTel/uptime exporter into meta when Stage 15 monitoring lands.
    const err = w.meta.p95.length
      ? Array.from({ length: 24 }, (_, i) => +(0.2 + (i % 5) * 0.05).toFixed(2))
      : [];
    return {
      components: await liveComponents(w),
      p95: w.meta.p95,
      targetMs: 1000,
      errorRate: err,
      errorPct: err.at(-1) ?? 0,
      slow: w.meta.slow,
      jobs,
      uptime: w.meta.uptime,
      links: w.meta.links,
    };
  });
}
export async function backups(c: Caller) {
  guard(c.session);
  // Real status from the backup bucket; seeded world rows are no longer shown. Empty list = not configured / no run yet.
  const last = await latestBackup(c.deps.config).catch(() => null);
  return { items: last ? [last] : [], tiers: BACKUP_TIERS };
}
export function drills(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({
    items: w.drills,
    gateOpen: launchGateOpen(w.drills),
  }));
}
onApply("prod_restore", (w, cr) => {
  // The restore itself is an operator runbook step (provider console); the approval is the authorisation record.
  record(
    w,
    "system.restore.completed",
    "backup",
    String(cr.payload.backupId),
    undefined,
    { target: "production" },
    cr.reason,
    undefined,
    { approvalRef: cr.id },
  );
});
export async function restore(
  c: Caller,
  b: { target?: "staging" | "production"; backupId?: string; reason?: string },
) {
  await stepUp(c, guard(c.session));
  return write(c, (w) => {
    const bk =
      w.backups.find((x) => x.id === b.backupId) ?? w.backups.find((x) => x.ok);
    if (!bk) throw fail(404, "not_found", "backup");
    if (b.target === "production") {
      if (tooShort(b.reason)) throw fail(422, "validation", "reason");
      record(
        w,
        "system.restore.requested",
        "backup",
        bk.id,
        undefined,
        { target: "production" },
        b.reason,
      );
      return accepted(
        submitChange(w, {
          kind: "prod_restore",
          title: `Restore production to backup ${bk.at.slice(0, 16).replace("T", " ")}`,
          reason: b.reason!.trim(),
          before: { production: "live" },
          after: { production: `backup ${bk.id}` },
          payload: { backupId: bk.id },
        }),
      );
    }
    record(w, "system.restore.requested", "backup", bk.id, undefined, {
      target: "staging",
    });
    // shortcut: staging restore drill is recorded with the operator-reported RTO PLACEHOLDER(drill-rto); trigger the
    // provider restore API from here once staging has one.
    const drill = {
      id: nextNo(w, "DR", 2),
      at: iso(),
      type: "staging" as const,
      rtoMinutes: 88,
      ok: true,
      reportBy: w.actor.name,
    };
    w.drills.unshift(drill);
    record(w, "system.restore.completed", "backup", bk.id, undefined, {
      target: "staging",
      drill: drill.id,
      rtoMinutes: drill.rtoMinutes,
    });
    return drill;
  });
}
export function posture(c: Caller) {
  guard(c.session);
  return read(c, async (w) => {
    const ps = await people(w);
    const staff = ps.filter((u) => u.kind === "staff" && u.status === "active");
    const mfa = staff.filter((u) => u.mfa.state === "enrolled").length;
    const admins = staff.filter((u) =>
      u.roles.some((r) => r.role === "staff:sysadmin"),
    );
    const noKey = admins.filter(
      (u) => !u.mfa.methods.includes("webauthn"),
    ).length;
    return {
      items: w.posture.map((p) =>
        p.id === "mfa"
          ? {
              ...p,
              status:
                mfa === staff.length ? ("pass" as const) : ("fail" as const),
              detail: `${mfa} / ${staff.length} active staff`,
            }
          : p.id === "webauthn"
            ? {
                ...p,
                status: noKey ? ("warn" as const) : ("pass" as const),
                detail: `${admins.length - noKey} / ${admins.length} sysadmins`,
              }
            : p.id === "tls"
              ? {
                  ...p,
                  status: envOf(w).https
                    ? ("pass" as const)
                    : ("warn" as const),
                  detail: envOf(w).https
                    ? "HTTPS public URL"
                    : "Public URL is not HTTPS",
                }
              : p,
      ),
    };
  });
}
export function dependencies(c: Caller) {
  guard(c.session);
  // PLACEHOLDER(patch-window): first Tuesday of next month per security §9.
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return read(c, (w) => ({
    items: w.dependencies,
    nextWindow: d.toISOString(),
  }));
}
export function postStatus(
  c: Caller,
  b: { component?: string; state?: Health; message?: Record<string, string> },
) {
  guard(c.session);
  if (!b.component || !["en", "fr", "rw"].every((l) => b.message?.[l]?.trim()))
    throw fail(422, "validation", "message");
  return write(c, (w) => {
    const id = nextNo(w, "st", 1, false);
    w.statusPosts.unshift({
      id,
      component: b.component!,
      state: b.state ?? "degraded",
      message: b.message!,
      at: iso(),
      by: w.actor.name,
    });
    record(w, "system.status.posted", "status", id, undefined, b);
    return { id };
  });
}
/** Public status feed (P11's /status page reads this; no auth). */
export const publicStatus = (c: Caller) =>
  read(c, (w) => ({
    items: w.statusPosts.slice(0, 20).map(({ by, ...p }) => (void by, p)),
  }));
export function incidents(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({ items: w.incidents }));
}
export function incident(c: Caller, id: string) {
  guard(c.session);
  return read(c, (w) => {
    const i = w.incidents.find((x) => x.id === id);
    if (!i) throw fail(404, "not_found", "incident");
    return i;
  });
}
export function openIncident(
  c: Caller,
  b: Partial<
    Pick<IncidentVM, "title" | "sev" | "components" | "startedAt" | "impact">
  >,
) {
  guard(c.session);
  if (
    !b.title?.trim() ||
    !b.impact?.trim() ||
    !b.components?.length ||
    ![1, 2, 3].includes(b.sev ?? 0)
  )
    throw fail(422, "validation", "incident");
  return write(c, (w) => {
    const inc: IncidentVM = {
      id: nextNo(w, "INC", 3),
      title: b.title!.trim(),
      sev: b.sev!,
      status: "open",
      components: b.components!,
      startedAt: b.startedAt || iso(),
      impact: b.impact!.trim(),
      timeline: [{ at: iso(), by: w.actor.name, text: "Incident opened." }],
      version: 1,
      // PRV-breach: personal-data incidents start the regulator-notification clock (system_breach_timer cron).
      ...(b.personalData ? { breach: { personalData: true as const, notifyBy: breachDeadline(b.startedAt || iso()) } } : {}),
    };
    w.incidents.unshift(inc);
    record(w, "system.incident.opened", "incident", inc.id, undefined, {
      title: inc.title,
      sev: inc.sev,
    });
    return inc;
  });
}
export type IncidentPatchIn = {
  /** PRV-breach: record that the regulator was notified (stops the timer). */
  breachNotified?: { reference: string };
  status?: IncidentVM["status"];
  postmortem?: Partial<NonNullable<IncidentVM["postmortem"]>>;
};
export function patchIncident(c: Caller, id: string, b: IncidentPatchIn) {
  guard(c.session);
  return write(c, (w) => {
    const i = w.incidents.find((x) => x.id === id);
    if (!i) throw fail(404, "not_found", "incident");
    stale(c.ifMatch, i.version);
    const now = iso(),
      before = { status: i.status };
    const br = (i as IncidentVM & { breach?: Breach }).breach;
    if (b.breachNotified) {
      if (!br) throw fail(422, "validation", "not a personal-data breach");
      if (!b.breachNotified.reference.trim()) throw fail(422, "validation", "reference");
      Object.assign(br, { notifiedAt: now, reference: b.breachNotified.reference.trim() });
      i.timeline.push({ at: now, by: w.actor.name, text: `Regulator notified (${br.reference})${Date.parse(now) > Date.parse(br.notifyBy) ? " — after the deadline" : ""}` });
      record(w, "system.incident.updated", "incident", i.id, undefined, { breachNotified: br.reference, late: Date.parse(now) > Date.parse(br.notifyBy) });
    }
    if (b.status) {
      if (!INCIDENT_NEXT[i.status].includes(b.status))
        throw fail(409, "stale", "invalid transition");
      const pm = { ...i.postmortem, ...b.postmortem };
      if (
        b.status === "postmortem_done" &&
        (!pm.summary?.trim() || !pm.rootCause?.trim())
      )
        throw fail(422, "validation", "postmortem");
      i.status = b.status;
      if (b.status === "resolved") {
        i.resolvedAt = now;
        i.postmortem ??= { dueAt: postmortemDue(now), actions: [] };
      }
      i.timeline.push({
        at: now,
        by: w.actor.name,
        text: `Status → ${b.status}`,
      });
    }
    if (b.postmortem) {
      if (!i.resolvedAt) throw fail(422, "validation", "not resolved");
      i.postmortem = {
        dueAt: i.postmortem?.dueAt ?? postmortemDue(i.resolvedAt),
        actions: [],
        ...i.postmortem,
        ...b.postmortem,
      };
    }
    i.version++;
    record(
      w,
      b.status === "resolved"
        ? "system.incident.resolved"
        : "system.incident.updated",
      "incident",
      i.id,
      before,
      b,
    );
    return i;
  });
}
export function incidentEvent(c: Caller, id: string, text?: string) {
  guard(c.session);
  if (!text?.trim()) throw fail(422, "validation", "text");
  return write(c, (w) => {
    const i = w.incidents.find((x) => x.id === id);
    if (!i) throw fail(404, "not_found", "incident");
    i.timeline.push({
      at: iso(),
      by: w.actor.name,
      text: text.trim().slice(0, 500),
    });
    i.version++;
    record(w, "system.incident.updated", "incident", i.id, undefined, {
      note: true,
    });
    return i;
  });
}
