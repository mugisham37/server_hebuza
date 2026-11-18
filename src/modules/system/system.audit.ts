// P10 audit (U13): list with filters + keyset paging, entry, per-entry and full-chain verification, signed integrity
// report, sensitive-read log, hash-stamped export — port of handlers-system-e (audit half), over the real hash-chained
// audit_log (core/audit.ts). Non-sysadmin finance/executive callers get the resource-scoped feed finance screens use.
import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  gt,
  isNotNull,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { auditLog, users } from "@/db/schema";
import { GENESIS, linkHash } from "../../core/db/audit";
import {
  AUDIT_CATALOGUE,
  categoryOf,
  isPrivileged,
} from "@/domain/system/audit-catalogue";
import { redact } from "@/domain/system/audit";
import type { AuditCategory, AuditEntryVM, ChainReport } from "@/domain/system/types";
import {
  fail,
  guard,
  isExec,
  isSysadmin,
  nextNo,
  read,
  record,
  stepUp,
  write,
  type Caller,
  type Exec,
  type World,
} from "./system.world";

const PAGE = 50;
/** PLACEHOLDER(sensitive-volume) downloads per actor per 10 min before "unusual volume". */
const UNUSUAL_AT = 100;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = typeof auditLog.$inferSelect & { actorName: string | null };
type ChainLink = { seq: number; prev: string; hash: string };
type AuditFields = Parameters<typeof linkHash>[2];

// ---------------------------------------------------------------- row → VM
const chainOf = (r: {
  chainSeq: number | null;
  chainPrev: string | null;
  chainHash: string | null;
}): ChainLink | undefined =>
  r.chainSeq == null
    ? undefined
    : { seq: r.chainSeq, prev: r.chainPrev ?? "", hash: r.chainHash ?? "" };
export function toEntry(r: Row): AuditEntryVM {
  const d = (r.details ?? {}) as Record<string, unknown>;
  const {
    _chain,
    actorName,
    before,
    after,
    reason,
    category,
    requestId,
    userAgent,
    sessionId,
    impersonatorId,
    approvalRef,
    breakGlass,
    batchId,
    ...extra
  } = d;
  void _chain; // legacy copy in details (pre-0004 rows); the columns are authoritative
  const c = chainOf(r);
  return {
    id: r.id,
    at: new Date(r.createdAt).toISOString(),
    actorId: r.actorId,
    actorLabel: String(
      actorName ?? r.actorName ?? (r.actorId ? r.actorId : "HEBUZA system"),
    ),
    actorRole: r.actorRole ?? (r.actorId ? "staff" : "system"),
    impersonatorId: (impersonatorId as string) ?? null,
    category: (category as AuditCategory) ?? categoryOf(r.action),
    action: r.action,
    resourceType: r.resourceType,
    resourceId: r.resourceId ?? "",
    details: {
      before: before ?? undefined,
      after: after ?? undefined,
      reason: (reason as string) ?? undefined,
      ...(Object.keys(extra).length ? { extra } : {}),
    },
    ip: r.ipAddress ?? "",
    userAgent: String(userAgent ?? ""),
    requestId: String(requestId ?? ""),
    sessionId: String(sessionId ?? ""),
    ...(batchId ? { batchId: String(batchId) } : {}),
    ...(breakGlass ? { breakGlass: true } : {}),
    ...(approvalRef ? { approvalRef: String(approvalRef) } : {}),
    prevHash: c?.prev ?? "",
    hash: c?.hash ?? "",
  };
}
const clean = (e: AuditEntryVM): AuditEntryVM => ({
  ...e,
  details: redact(e.details) as AuditEntryVM["details"],
});
const fields = (r: typeof auditLog.$inferSelect): AuditFields => ({
  id: r.id,
  actorId: r.actorId,
  actorRole: r.actorRole,
  action: r.action,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  details: r.details as Record<string, unknown>,
  ipAddress: r.ipAddress,
  kind: r.kind,
  createdAt: r.createdAt,
});

// ---------------------------------------------------------------- filters (query params + `key:value` tokens in q)
export type AuditFilter = Partial<
  Record<
    | "category"
    | "actor"
    | "action"
    | "resource_type"
    | "resource_id"
    | "ip"
    | "from"
    | "to"
    | "privileged"
    | "q"
    | "cursor"
    | "subject",
    string
  >
>;
const CODES_BY_CAT = (cat: string) =>
  Object.entries(AUDIT_CATALOGUE)
    .filter(([, c]) => c === cat)
    .map(([k]) => k);
const PRIV_RE =
  "^(access\\.(role|user|break_glass|impersonation|sod)|config\\.(change|setting|integration|role|retention))";
function where(
  f: AuditFilter & { resource_any?: string; free?: string[] },
): SQL | undefined {
  const x: (SQL | undefined)[] = [];
  const toks = (f.q ?? "").trim().split(/\s+/).filter(Boolean),
    free: string[] = [...(f.free ?? [])];
  const g = { ...f } as Record<string, string | undefined>;
  for (const t of toks) {
    const m = /^(action|actor|entity|resource|ip|category):(.+)$/.exec(t);
    if (!m) {
      free.push(t.toLowerCase());
      continue;
    }
    if (m[1] === "entity" || m[1] === "resource") {
      const [ty, id] = m[2].split(":");
      if (id) {
        g.resource_type = ty;
        g.resource_id = id;
      } else g.resource_any = ty;
    } else g[m[1]] = m[2];
  }
  if (g.category) {
    const codes = CODES_BY_CAT(g.category);
    x.push(
      or(
        sql`${auditLog.details}->>'category' = ${g.category}`,
        codes.length ? inArray(auditLog.action, codes) : undefined,
        sql`${auditLog.action} like ${`${g.category}.%`}`,
      ),
    );
  }
  if (g.actor)
    x.push(
      or(
        eq(auditLog.actorId, g.actor),
        sql`lower(coalesce(${auditLog.details}->>'actorName', ${users.name}, '')) like ${`%${g.actor.toLowerCase()}%`}`,
      ),
    );
  if (g.action) x.push(sql`${auditLog.action} like ${`${g.action}%`}`);
  if (g.resource_type) x.push(eq(auditLog.resourceType, g.resource_type));
  if (g.resource_id) x.push(eq(auditLog.resourceId, g.resource_id));
  if (g.resource_any)
    x.push(
      or(
        eq(auditLog.resourceType, g.resource_any),
        sql`${auditLog.resourceId} like ${`%${g.resource_any}%`}`,
      ),
    );
  if (g.subject)
    x.push(
      or(eq(auditLog.resourceId, g.subject), eq(auditLog.actorId, g.subject)),
    );
  if (g.ip) x.push(sql`${auditLog.ipAddress} like ${`${g.ip}%`}`);
  if (g.from) x.push(gte(auditLog.createdAt, g.from));
  if (g.to)
    x.push(
      lte(
        auditLog.createdAt,
        g.to.length === 10 ? `${g.to}T23:59:59.999Z` : g.to,
      ),
    );
  if (g.privileged) x.push(sql`${auditLog.action} ~ ${PRIV_RE}`);
  for (const w of free)
    x.push(
      sql`lower(${auditLog.action} || ' ' || coalesce(${auditLog.details}->>'actorName', ${users.name}, '') || ' ' || ${auditLog.resourceType} || ':' || coalesce(${auditLog.resourceId}, '') || ' ' || ${auditLog.id}) like ${`%${w}%`}`,
    );
  return x.length ? and(...x) : undefined;
}

/** Newest first; cursor = `${createdAt}|${id}` of the last row on the previous page. */
export async function auditRows(db: Exec, f: AuditFilter, limit = PAGE) {
  const base = where(f);
  const cur = f.cursor?.split("|");
  const page =
    cur?.length === 2
      ? and(
          base,
          sql`(${auditLog.createdAt}, ${auditLog.id}) < (${cur[0]}::timestamptz, ${cur[1]})`,
        )
      : base;
  const rows = await db
    .select({ a: auditLog, actorName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.userId, auditLog.actorId))
    .where(page)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit + 1);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .leftJoin(users, eq(users.userId, auditLog.actorId))
    .where(base);
  const items = rows
    .slice(0, limit)
    .map((r) => toEntry({ ...r.a, actorName: r.actorName }));
  const last = rows[limit - 1];
  return {
    items,
    next:
      rows.length > limit && last
        ? `${new Date(last.a.createdAt).toISOString()}|${last.a.id}`
        : null,
    total: Number(n),
  };
}

// ---------------------------------------------------------------- chain
async function lastLink(db: Exec) {
  const [r] = await db
    .select({
      seq: auditLog.chainSeq,
      hash: auditLog.chainHash,
      at: auditLog.createdAt,
      id: auditLog.id,
    })
    .from(auditLog)
    .where(isNotNull(auditLog.chainSeq))
    .orderBy(desc(auditLog.chainSeq))
    .limit(1);
  const [first] = await db
    .select({ at: auditLog.createdAt })
    .from(auditLog)
    .where(isNotNull(auditLog.chainSeq))
    .orderBy(asc(auditLog.chainSeq))
    .limit(1);
  return {
    entries: r?.seq ?? 0,
    hash: r?.hash ?? GENESIS,
    from: first ? new Date(first.at).toISOString() : "",
    to: r ? new Date(r.at).toISOString() : "",
  };
}
/** Walks the whole chain in seq order, 5 000 rows at a time (constant memory). */
export async function verifyAll(db: Exec): Promise<ChainReport> {
  let prev = GENESIS,
    after = 0,
    checked = 0;
  for (;;) {
    const batch = await db
      .select()
      .from(auditLog)
      .where(gt(auditLog.chainSeq, after))
      .orderBy(asc(auditLog.chainSeq))
      .limit(5000);
    if (!batch.length) break;
    for (const r of batch) {
      const c = chainOf(r)!;
      if (c.prev !== prev || linkHash(prev, c.seq, fields(r)) !== c.hash)
        return {
          ok: false,
          checked,
          brokenAt: r.id,
          at: new Date().toISOString(),
        };
      prev = c.hash;
      after = c.seq;
      checked++;
    }
  }
  return { ok: true, checked, at: new Date().toISOString() };
}
async function chainSummary(w: World) {
  const l = await lastLink(w.db);
  const rep = w.meta.verify;
  return {
    state: rep && !rep.ok ? ("broken" as const) : ("verified" as const),
    entries: l.entries,
    hash: l.hash,
    ...(rep?.brokenAt ? { brokenAt: rep.brokenAt } : {}),
  };
}
/** Store the report; a broken chain raises one danger alert (and stays raised until a clean run). */
export function storeVerify(w: World, rep: ChainReport) {
  w.meta.verify = rep;
  if (rep.ok) {
    w.meta.notifiedAt = null;
    return;
  }
  if (w.meta.notifiedAt) return;
  w.meta.notifiedAt = new Date().toISOString();
  w.alerts.unshift({
    id: `al-chain-${Date.now()}`,
    kind: "security",
    code: "audit.chain_broken",
    title: "Audit chain broken",
    detail: `First broken entry ${rep.brokenAt} · executive notified`,
    at: w.meta.notifiedAt,
    href: "/system/audit/integrity",
    read: false,
    tone: "danger",
  });
}
async function integrityOf(w: World) {
  const l = await lastLink(w.db);
  return {
    report: w.meta.verify,
    entries: l.entries,
    lastHash: l.hash,
    from: l.from,
    to: l.to,
    notifiedAt: w.meta.notifiedAt,
  };
}

// ---------------------------------------------------------------- endpoints
export async function listAudit(c: Caller, f: AuditFilter) {
  const s = c.session;
  if (s && !isSysadmin(s) && (isExec(s) || s.roles.includes("staff:finance"))) {
    // Finance/executive drawers (handlers-finance): one resource's history in the shared AuditEvent shape.
    if (!f.resource_type || !f.resource_id)
      throw fail(
        422,
        "validation",
        "resource_type and resource_id are required.",
      );
    const { items } = await auditRows(
      c.db,
      {
        resource_type: f.resource_type,
        resource_id: f.resource_id,
        action: f.category ? `${f.category}.` : undefined,
      },
      200,
    );
    return {
      items: items.map((e) => ({
        id: e.id,
        at: e.at,
        actor: e.actorLabel,
        action: e.action,
        entity: { kind: e.resourceType, id: e.resourceId },
        before: e.details.before,
        after: e.details.after,
        reason: e.details.reason,
        ip: e.ip,
      })),
    };
  }
  guard(s);
  return read(c, async (w) => {
    const p = await auditRows(w.db, f);
    return { ...p, items: p.items.map(clean), chain: await chainSummary(w) };
  });
}
export async function sensitive(c: Caller) {
  guard(c.session);
  // Sensitive reads only (document downloads, exports, private-field reveals), newest 2 000 for the volume check.
  const rows = await c.db
    .select({ a: auditLog, actorName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.userId, auditLog.actorId))
    .where(
      sql`${auditLog.action} ~ '^(document_access|data_export)\\.|^workforce\\.private_field\\.revealed$'`,
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(2000);
  const items = rows.map((r) => toEntry({ ...r.a, actorName: r.actorName }));
  let unusual: { who: string; n: number; at: string } | null = null;
  const dl = items.filter(
    (r) => r.action === "document_access.document.downloaded",
  );
  for (const r of dl) {
    const t = Date.parse(r.at);
    const n = dl.filter(
      (x) =>
        x.actorId === r.actorId && Math.abs(Date.parse(x.at) - t) <= 5 * 60_000,
    ).length;
    if (n > UNUSUAL_AT && (!unusual || n > unusual.n))
      unusual = { who: r.actorLabel, n, at: r.at };
  }
  return {
    items: items.slice(0, 200).map(clean),
    unusual,
    threshold: UNUSUAL_AT,
  };
}
export function integrity(c: Caller) {
  guard(c.session);
  return read(c, integrityOf);
}
export async function verifyNow(c: Caller) {
  guard(c.session);
  const rep = await verifyAll(c.db);
  return write(c, async (w) => {
    storeVerify(w, rep);
    return integrityOf(w);
  });
}
export async function integrityReport(c: Caller) {
  guard(c.session);
  const rep = (await read(c, (w) => w.meta.verify)) ?? (await verifyAll(c.db));
  const l = await lastLink(c.db);
  const body = [
    `verified_at,${rep.at}`,
    `result,${rep.ok ? "ok" : "broken"}`,
    `checked,${rep.checked}`,
    `total,${l.entries}`,
    `broken_at,${rep.brokenAt ?? ""}`,
    `last_hash,${l.hash}`,
  ].join("\n");
  return { content: `${body}\nsha256,${sha(body)}`, sha256: sha(body) };
}
const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: AuditEntryVM[]) =>
  [
    "id,at,actor,role,impersonator,action,category,resource,ip,request_id,approval_ref,hash",
    ...rows.map((r) =>
      [
        r.id,
        r.at,
        r.actorLabel,
        r.actorRole,
        r.impersonatorId ?? "",
        r.action,
        r.category,
        `${r.resourceType}:${r.resourceId}`,
        r.ip,
        r.requestId,
        r.approvalRef ?? "",
        r.hash,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
/** PLACEHOLDER(audit-export-max-rows) inline exports stop at 10 000 rows; larger windows narrow the filter. */
const EXPORT_MAX = 10_000;
export async function exportAudit(
  c: Caller,
  format: "csv" | "pdf",
  f: AuditFilter,
) {
  await stepUp(c, guard(c.session));
  const rows = (await auditRows(c.db, f, EXPORT_MAX)).items.map(clean);
  // shortcut: "pdf" is the printable text rendering the screen prints; a react-pdf render job when exports grow.
  const content =
    format === "csv"
      ? toCsv(rows)
      : rows
          .map(
            (r) =>
              `${r.at}  ${r.actorLabel}  ${r.action}  ${r.resourceType}:${r.resourceId}  ${r.ip}`,
          )
          .join("\n");
  const hash = sha(content);
  return write(c, (w) => {
    const id = nextNo(w, "EXP", 4, false);
    const filters =
      new URLSearchParams(
        Object.entries(f).filter(([, v]) => v) as [string, string][],
      ).toString() || "none";
    record(w, "data_export.audit.exported", "audit_export", id, undefined, {
      rows: rows.length,
      format,
      filters,
      sha256: hash,
    });
    w.alerts.unshift({
      id: `al-exp-${id}`,
      kind: "security",
      code: "data_export.audit.exported",
      title: "Export ready",
      detail: `${rows.length} rows · SHA-256 ${hash.slice(0, 8)}…`,
      at: new Date().toISOString(),
      href: "/system/audit/sensitive",
      read: false,
      tone: rows.length >= 1000 ? "warning" : "info",
    });
    return { id, rows: rows.length, sha256: hash, format, content };
  });
}
async function entryRow(db: Exec, id: string) {
  const [r] = await db
    .select({ a: auditLog, actorName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.userId, auditLog.actorId))
    .where(eq(auditLog.id, id));
  if (!r) throw fail(404, "not_found", "Not found.");
  return r;
}
export async function entry(c: Caller, id: string) {
  guard(c.session);
  const r = await entryRow(c.db, id);
  return clean(toEntry({ ...r.a, actorName: r.actorName }));
}
/** One link: prev matches the previous row's hash and the row re-hashes to its stored hash. */
export async function verifyEntry(c: Caller, id: string) {
  guard(c.session);
  const { a } = await entryRow(c.db, id);
  const ch = chainOf(a);
  if (!ch) return { ok: false };
  const [prev] =
    ch.seq > 1
      ? await c.db
          .select({ hash: auditLog.chainHash })
          .from(auditLog)
          .where(eq(auditLog.chainSeq, ch.seq - 1))
      : [];
  const prevHash = ch.seq > 1 ? prev?.hash : GENESIS;
  return {
    ok:
      !!prevHash &&
      ch.prev === prevHash &&
      linkHash(prevHash, ch.seq, fields(a)) === ch.hash,
  };
}
/** Recent privileged changes for the overview card. */
export async function recentPrivileged(db: Exec, n = 5) {
  const { items } = await auditRows(db, { privileged: "1" }, n);
  return items.map((e) => ({
    id: e.id,
    at: e.at,
    actorLabel: e.actorLabel,
    action: e.action,
    category: e.category,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
  }));
}
export { isPrivileged };

/** U4 activity tab: the latest 40 events by or about one user. */
export async function userActivity(c: Caller, id: string) {
  guard(c.session);
  return { items: (await auditRows(c.db, { subject: id }, 40)).items };
}
