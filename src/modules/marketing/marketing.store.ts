// Marketing data access (port of reference marketing.store): the mkt_records document store, staff directory, id
// counters, the marketing notification feed, audit, and the cross-module reads marketing needs.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { financeRecords, mktRecords, outbox, users } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import type { AuditEntry } from "../../core/db/audit";
import { AppError } from "../../core/http/errors";
import type { SessionUser } from "../../core/http/context";
import type { MktNote, PaidInvoice, Staff } from "@/domain/marketing/types";
import { MKT_POLICY, type MktPolicy } from "@/domain/marketing/policy";

export type Exec = Tx;
export type Session = SessionUser & { role: string };
export type Kind =
  | "lead"
  | "promo" // F-CRM-20 promo codes (id = code)
  | "tax_reminder" // F-CRM-12 sent-marker (rule:date:lead:channel)
  | "rec_rule" // F-CRM-11 recommendation rules
  | "activity"
  | "task"
  | "note"
  | "consent"
  | "contact"
  | "segment"
  | "template"
  | "campaign"
  | "cmpx"
  | "automation"
  | "run"
  | "testimonial"
  | "referrer"
  | "referral"
  | "thread"
  | "feed"
  | "import"
  | "social"
  | "social_preview"
  | "rating"
  | "media"
  | "media_upload"
  | "link"
  | "setting"
  | "counter";

/** What every service takes (MarketingRunner builds it per request; jobs pass { db, session: null }). */
export type Caller = {
  db: Exec;
  session: Session | null;
  ip?: string | null;
  req?: { headers: { get(name: string): string | null } };
  /** Domain audit rows; the runner writes them with AuditService at the end of the request tx. */
  audits?: AuditEntry[];
  /** NODE_ENV === "production" (dev-only actions refuse). */
  prod?: boolean;
};

/** Business rule failure → the mocks' envelope (`errorType` = code, details ride in `data`). */
export const mktError = (
  status: number,
  code: string,
  data: Record<string, unknown> | null = null,
  message = code,
) => new AppError(status, code, message, undefined, data ?? undefined);
export const notFound = (what: string) =>
  new AppError(404, "not_found", `${what} not found.`);

// ---------------------------------------------------------------- document store
type Row = {
  kind: Kind;
  id: string;
  status?: string | null;
  ref?: string | null;
};

export async function list<T>(
  db: Exec,
  kind: Kind,
  f: { status?: string[]; ref?: string } = {},
): Promise<T[]> {
  const rows = await db
    .select({ data: mktRecords.data })
    .from(mktRecords)
    .where(
      and(
        eq(mktRecords.kind, kind),
        f.status ? inArray(mktRecords.status, f.status) : undefined,
        f.ref != null ? eq(mktRecords.ref, f.ref) : undefined,
      ),
    )
    .orderBy(asc(mktRecords.pos));
  return rows.map((r) => r.data as T);
}

/** One document; `lock` takes FOR UPDATE so concurrent writers of the same record serialise. */
export async function get<T>(
  db: Exec,
  kind: Kind,
  id: string,
  lock = false,
): Promise<T | undefined> {
  const q = db
    .select({ data: mktRecords.data })
    .from(mktRecords)
    .where(and(eq(mktRecords.kind, kind), eq(mktRecords.id, id)));
  const [r] = lock ? await q.for("update") : await q;
  return r?.data as T | undefined;
}

/** Upsert. New rows list first (negative, time-ordered pos) unless `pos` is given (seeds). */
export async function put(db: Exec, r: Row & { data: unknown; pos?: number }) {
  await db
    .insert(mktRecords)
    .values({
      kind: r.kind,
      id: r.id,
      data: r.data,
      status: r.status ?? null,
      ref: r.ref ?? null,
      updatedAt: new Date().toISOString(),
      pos:
        r.pos ??
        sql`-(extract(epoch from clock_timestamp()) * 1000000)::bigint`,
    })
    .onConflictDoUpdate({
      target: [mktRecords.kind, mktRecords.id],
      set: {
        data: sql`excluded.data`,
        status: sql`excluded.status`,
        ref: sql`excluded.ref`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

export async function remove(db: Exec, kind: Kind, id: string) {
  await db
    .delete(mktRecords)
    .where(and(eq(mktRecords.kind, kind), eq(mktRecords.id, id)));
}

export async function count(db: Exec, kind: Kind, status?: string[]) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mktRecords)
    .where(
      and(
        eq(mktRecords.kind, kind),
        status ? inArray(mktRecords.status, status) : undefined,
      ),
    );
  return r?.n ?? 0;
}

/** Atomic counter (`LD-2026-00441` style ids): one UPSERT … RETURNING, safe across instances. */
export async function nextNo(db: Exec, key: string, start: number) {
  const rows = await db.execute<{ n: number }>(sql`
    insert into mkt_records (kind, id, pos, data) values ('counter', ${key}, 0, jsonb_build_object('n', ${start + 1}::int))
    on conflict (kind, id) do update set data = jsonb_build_object('n', (mkt_records.data->>'n')::int + 1), updated_at = now()
    returning (data->>'n')::int as n`);
  return Number(rows[0].n);
}
export const year = () => new Date().getUTCFullYear();
export const leadNo = async (db: Exec) =>
  `LD-${year()}-${String(await nextNo(db, `LD-${year()}`, 0)).padStart(5, "0")}`;
export const campaignNo = async (db: Exec) =>
  `CP-${year()}-${String(await nextNo(db, `CP-${year()}`, 0)).padStart(3, "0")}`;
export const seqId = async (db: Exec, prefix: string) =>
  `${prefix}-${await nextNo(db, prefix, 0)}`;

/** Typed settings document with defaults (programme, tracking, spend, health…). */
export async function setting<T extends object>(
  db: Exec,
  id: string,
  defaults: T,
  lock = false,
): Promise<T> {
  return {
    ...defaults,
    ...((await get<Partial<T>>(db, "setting", id, lock)) ?? {}),
  };
}
export const saveSetting = (db: Exec, id: string, data: object) =>
  put(db, { kind: "setting", id, data, pos: 0 });

// ---------------------------------------------------------------- staff
export const MKT = "staff:marketing" as const;
export const SM = "staff:service_manager" as const;
export const EXEC = "staff:executive" as const;
const STAFF_ROLES = [MKT, SM, EXEC];
const COLORS: Record<Staff["role"], string> = {
  marketing: "#C7D7FD",
  service_manager: "#FEE6AA",
  executive: "#CCE4FF",
};
const roleOf = (roles: readonly string[]): Staff["role"] | null =>
  roles.includes(MKT)
    ? "marketing"
    : roles.includes(EXEC)
      ? "executive"
      : roles.includes(SM)
        ? "service_manager"
        : null;

/** Marketing, service-manager and executive seats: the people the CRM can assign, mention and name. */
export async function staffList(db: Exec): Promise<Staff[]> {
  const rows = await db
    .select({ id: users.userId, name: users.name, role: users.role })
    .from(users)
    .where(and(inArray(users.role, STAFF_ROLES), eq(users.isActive, true)))
    .orderBy(asc(users.name));
  return rows.map((r) => {
    const role = roleOf([r.role])!;
    return { id: r.id, name: r.name, role, color: COLORS[role] };
  });
}
export const staffOf = (staff: Staff[], id?: string) =>
  id ? staff.find((s) => s.id === id) : undefined;

/** The caller as marketing staff (null for roles outside the CRM). */
export async function meOf(c: Caller): Promise<Staff | null> {
  const s = c.session;
  const role = s && roleOf(s.roles);
  if (!s || !role) return null;
  const [u] = await c.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, s.id))
    .limit(1);
  return { id: s.id, name: u?.name ?? s.id, role, color: COLORS[role] };
}
export const actorId = (c: Caller) => c.session?.id ?? "system";

// ---------------------------------------------------------------- feed + audit
export async function pushNote(
  db: Exec,
  n: Omit<MktNote, "id" | "at" | "read">,
) {
  const id = await seqId(db, "n");
  await put(db, {
    kind: "feed",
    id,
    data: {
      ...n,
      id,
      at: new Date().toISOString(),
      read: false,
    } satisfies MktNote,
    status: "unread",
  });
}

/** Domain audit entry. Requests: written in-tx by the runner. Jobs/system callers: outbox `marketing.audit` (worker writes it). */
export async function record(
  c: Caller,
  action: string,
  resourceId: string,
  details: Record<string, unknown> = {},
  reason?: string,
) {
  const e: AuditEntry = { action, entity: action.split(".")[0], entityId: resourceId, after: details, reason };
  if (c.audits) c.audits.push(e);
  else await c.db.insert(outbox).values({ type: "marketing.audit", payload: e, queue: "default" });
}

/** X-Audit-Reason header (URI-encoded by the client). */
export const auditReason = (req?: Caller["req"]) => {
  try {
    return decodeURIComponent(req?.headers.get("x-audit-reason") ?? "").trim();
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------- cross-module reads
/** Paid invoices (finance P6 store): totals only, never lines. */
export async function paidInvoices(db: Exec): Promise<PaidInvoice[]> {
  const rows = await db
    .select({ data: financeRecords.data, at: financeRecords.updatedAt })
    .from(financeRecords)
    .where(
      and(
        eq(financeRecords.kind, "invoice"),
        inArray(financeRecords.status, ["paid", "paid_by_plan"]),
      ),
    );
  // Checkout payments (payments table) are invoiced as INV-<code>; finance-store invoices win on the same number.
  const paid = (await db.execute<{ no: string; client_id: string; code: string; total: number; paid_at: string }>(
    sql`select no, client_id, code, total, paid_at::text from marketing_paid_payments()`,
  )) as unknown as { no: string; client_id: string; code: string; total: number; paid_at: string }[];
  const fin = rows.flatMap((r) => {
    const i = r.data as {
      no?: string | null;
      clientId: string;
      caseRef?: string;
      totals: { total: number };
      issuedAt?: string;
      paidAt?: string;
    };
    return i.no
      ? [
          {
            no: i.no,
            clientId: i.clientId,
            caseRef: i.caseRef,
            total: i.totals.total,
            paidAt: i.paidAt ?? i.issuedAt ?? r.at,
          },
        ]
      : [];
  });
  const seen = new Set(fin.map((i) => i.no));
  return [
    ...fin,
    ...paid
      .filter((p) => !seen.has(p.no))
      .map((p) => ({ no: p.no, clientId: p.client_id, caseRef: p.code, total: p.total, paidAt: p.paid_at })),
  ];
}

/** A client's requests as marketing may see them: reference, service, status (no case details). */
export async function casesOf(db: Exec, clientId: string) {
  // SECURITY DEFINER (migration 0010): marketing has no row access to applications.
  const r = await db.execute<{ ref: string; service: string; status: string; at: string }>(
    sql`select code as ref, service_name as service, status, created_at::text as at from marketing_client_cases(${clientId})`,
  );
  return [...r];
}

export async function countRequests(db: Exec, fromIso: string, toIso?: string) {
  const r = await db.execute<{ n: number }>(
    sql`select marketing_request_count(${fromIso}::timestamptz, ${toIso ?? null}::timestamptz)::int as n`,
  );
  return [...r][0]?.n ?? 0;
}

// ---------------------------------------------------------------- policy
/** PLACEHOLDER business values: defaults from src/lib/marketing/policy.ts, overridden by the "policy" settings document. */
export async function policy(db: Exec): Promise<MktPolicy> {
  return setting<MktPolicy>(db, "policy", MKT_POLICY);
}
