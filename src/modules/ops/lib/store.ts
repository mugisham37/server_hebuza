// P5 shared data access for ops + agent: one case = `applications` row + ops_case_meta.data (OpsX), plus the
// people (users + agent_profiles / ops_client_profiles) the ops and agent screens name.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Exec } from "./ctx";
import type { Session } from "./ctx";
import { generateId } from "./ctx";
import { err } from "./ctx";
import {
  applications,
  complianceHolidays,
  services,
  users,
  agentProfiles,
  opsCaseEvents,
  opsCaseMeta,
  opsClientProfiles,
  opsRecords,
  deliverables,
  assignmentBlocks,
  downloadTokens,
} from "@/db/schema";
import { createHash, randomBytes } from "node:crypto";
import { notify } from "./ctx";
import { statusEffects } from "@/modules/applications/status-effects";
import type { CaseStatus } from "@/domain/domain/case-status";
import type { ChecklistItem } from "@/domain/ops/completeness";
import type { Agent } from "@/domain/ops/ranking";

export type App = typeof applications.$inferSelect;
export type Flag =
  | "urgent"
  | "vip"
  | "subscriber"
  | "ai"
  | "partner"
  | "duplicate"
  | "dedicated";

export type AgentStep = {
  id: string;
  label: string;
  done: boolean;
  doneAt?: string;
};
export type DeliverableVersion = {
  v: string;
  name: string;
  size: number;
  at: string;
  state: "uploading" | "uploaded" | "returned" | "approved";
  comment?: string;
  storageKey?: string;
  type?: string;
};
export type DeliverableSlot = {
  key: string;
  label: string;
  required: boolean;
  /** DLV-10: the released file must be signed by the client. */
  signature?: boolean;
  versions: DeliverableVersion[];
};
export type TimeEntry = {
  id: string;
  date: string;
  minutes: number;
  activity: string;
  note?: string;
};

/** Everything ops/agent know about a case that `applications` has no column for. */
export type OpsX = {
  flags: Flag[];
  subStatus: string | null;
  previous: CaseStatus | null;
  claimedById: string | null;
  claimedBy: string | null;
  checklist: ChecklistItem[];
  institution: string | null;
  submissionRef: string | null;
  expectedDecision: string | null;
  firstResponseDueAt: string | null;
  helpers: string[];
  /** F-ASN-11: per-case reviewer (checks deliverables before release); lead = assigned agent, helpers above. */
  reviewerId?: string | null;
  docs: Record<
    string,
    { state: "accepted" | "rejected" | null; reason?: string }
  >;
  request: {
    items: { key: string; label: string; note: string }[];
    due: string;
    channels: string[];
    sentAt: string;
  } | null;
  quote: Record<string, unknown> | null;
  brief: Record<string, unknown> | null;
  scope: Record<string, unknown> | null;
  terms: Record<string, unknown> | null;
  undo: {
    status: CaseStatus;
    subStatus: string | null;
    previous: CaseStatus | null;
  } | null;
  // agent workbench
  instructions: string;
  steps: AgentStep[];
  slots: DeliverableSlot[];
  clientNote: string;
  review: null | {
    state: "submitted" | "returned" | "approved" | "released";
    at: string;
    comments?: { slot: string; text: string; by: string; at: string }[];
  };
  timesheet: TimeEntry[];
  dispute: null | {
    id: string;
    text: string;
    openedAt: string;
    response?: string;
  };
  outcome: null | {
    state: "pending" | "approved" | "rejected" | "more_info";
    note: string;
    at: string;
    evidence: string | null;
  };
  fieldVisit: null | Record<string, unknown>;
  docQc: Record<
    string,
    {
      status: "pending" | "accepted" | "rejected";
      reason?: string;
      note?: string;
    }
  >;
  revealed: string[];
  unread: number;
};

const STEPS: Record<string, string[]> = {
  "vat-declaration": [
    "Collect sales book",
    "Reconcile EBM receipts",
    "File on RRA e-Tax",
    "Upload filing receipt",
  ],
  "company-registration": [
    "Check shareholder IDs",
    "Reserve company name",
    "Submit on RDB portal",
    "Upload certificate",
  ],
  "trademark-registration": [
    "Run trademark search",
    "Prepare class list",
    "File with RDB IP office",
    "Upload filing receipt",
  ],
  default: [
    "Review client documents",
    "Prepare the filing",
    "Submit to the institution",
    "Upload the result",
  ],
};
const SLOTS: Record<string, [string, string, boolean][]> = {
  "vat-declaration": [
    ["return", "VAT return (PDF)", true],
    ["receipt", "RRA filing receipt (PDF)", true],
    ["note", "Cover note to client", false],
  ],
  default: [
    ["certificate", "Final document", true],
    ["note", "Cover note to client", false],
  ],
};
const DEFAULT_CHECKLIST: [string, string, boolean][] = [
  ["form", "Application form", true],
  ["id", "National ID (client)", true],
  ["address", "Proof of business address", true],
  ["payment", "Payment proof", true],
];

export function defaultX(app: Pick<App, "serviceSlug" | "isUrgent">): OpsX {
  const steps = STEPS[app.serviceSlug] ?? STEPS.default;
  return {
    flags: app.isUrgent ? ["urgent"] : [],
    subStatus: null,
    previous: null,
    claimedById: null,
    claimedBy: null,
    checklist: DEFAULT_CHECKLIST.map(([key, label, required]) => ({
      key,
      label,
      required,
      state: "missing",
      docId: null,
    })),
    institution: null,
    submissionRef: null,
    expectedDecision: null,
    firstResponseDueAt: null,
    helpers: [],
    docs: {},
    request: null,
    quote: null,
    brief: null,
    scope: null,
    terms: null,
    undo: null,
    instructions: "",
    steps: steps.map((label, i) => ({ id: `s${i + 1}`, label, done: false })),
    slots: (SLOTS[app.serviceSlug] ?? SLOTS.default).map(
      ([key, label, required]) => ({ key, label, required, versions: [] }),
    ),
    clientNote: "",
    review: null,
    timesheet: [],
    dispute: null,
    outcome: null,
    fieldVisit: null,
    docQc: {},
    revealed: [],
    unread: 0,
  };
}

export type CaseRow = { app: App; x: OpsX; version: number };

export const CLOSED: CaseStatus[] = [
  "completed_delivered",
  "rejected",
  "cancelled",
  "refunded",
];
export const PAUSED: CaseStatus[] = [
  "on_hold",
  "awaiting_client_documents",
  "awaiting_external_institution",
  "awaiting_quotation",
  "awaiting_payment",
];
export const isOpen = (s: string) => !CLOSED.includes(s as CaseStatus);

/** Load one case by code; `lock` takes the row locks every writer needs (applications then meta, always in that order). */
export async function loadCase(
  db: Exec,
  code: string,
  lock = false,
): Promise<CaseRow> {
  const q = db
    .select()
    .from(applications)
    .where(eq(applications.code, code.toUpperCase()));
  const [app] = lock ? await q.for("update") : await q;
  if (!app) throw err.notFound("No case with that reference.");
  const mq = db
    .select()
    .from(opsCaseMeta)
    .where(eq(opsCaseMeta.applicationId, app.applicationId));
  const [m] = lock ? await mq.for("update") : await mq;
  return {
    app,
    x: { ...defaultX(app), ...((m?.data as Partial<OpsX>) ?? {}) },
    version: m?.version ?? 0,
  };
}

export async function loadCases(db: Exec, apps: App[]): Promise<CaseRow[]> {
  if (!apps.length) return [];
  const metas = await db
    .select()
    .from(opsCaseMeta)
    .where(
      inArray(
        opsCaseMeta.applicationId,
        apps.map((a) => a.applicationId),
      ),
    );
  const by = new Map(metas.map((m) => [m.applicationId, m]));
  return apps.map((app) => {
    const m = by.get(app.applicationId);
    return {
      app,
      x: { ...defaultX(app), ...((m?.data as Partial<OpsX>) ?? {}) },
      version: m?.version ?? 0,
    };
  });
}

/** Persist the case: meta upsert (version + 1) and the application columns ops owns. */
export async function saveCase(
  db: Exec,
  c: CaseRow,
  appPatch: Partial<App> = {},
) {
  const now = new Date().toISOString();
  if (Object.keys(appPatch).length) {
    await db
      .update(applications)
      .set({ ...appPatch, updatedAt: now, ...(appPatch.status && appPatch.status !== c.app.status ? statusEffects(appPatch.status) : {}) })
      .where(eq(applications.applicationId, c.app.applicationId));
    Object.assign(c.app, appPatch, { updatedAt: now });
  }
  await db
    .insert(opsCaseMeta)
    .values({
      applicationId: c.app.applicationId,
      code: c.app.code,
      data: c.x,
      version: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: opsCaseMeta.applicationId,
      set: {
        data: c.x,
        version: sql`${opsCaseMeta.version} + 1`,
        updatedAt: now,
      },
    });
  c.version += 1;
}

export type EventIn = {
  kind: string;
  actorId?: string | null;
  actorName: string;
  from?: string | null;
  to?: string | null;
  text?: string | null;
  ip?: string | null;
  internal?: boolean;
  client?: boolean;
  feed?: "ops" | "agent";
};
export const logEvent = (db: Exec, applicationId: string, e: EventIn) =>
  db.insert(opsCaseEvents).values({
    id: generateId("cev"),
    applicationId,
    kind: e.kind,
    feed: e.feed ?? "ops",
    actorId: e.actorId ?? null,
    actorName: e.actorName,
    fromValue: e.from ?? null,
    toValue: e.to ?? null,
    text: e.text ?? null,
    ip: e.ip ?? null,
    internal: !!e.internal,
    client: !!e.client,
  });

export const eventsOf = (
  db: Exec,
  applicationId: string,
  feed?: "ops" | "agent",
  limit = 200,
) =>
  db
    .select()
    .from(opsCaseEvents)
    .where(
      feed
        ? and(
            eq(opsCaseEvents.applicationId, applicationId),
            eq(opsCaseEvents.feed, feed),
          )
        : eq(opsCaseEvents.applicationId, applicationId),
    )
    .orderBy(desc(opsCaseEvents.at))
    .limit(limit);

// ── people ───────────────────────────────────────────────────────────────────────────────────────
export async function namesOf(db: Exec, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.userId, name: users.name })
    .from(users)
    .where(inArray(users.userId, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function actorName(db: Exec, s: Session) {
  return (await namesOf(db, [s.id])).get(s.id) ?? "Staff";
}

export type ClientInfo = {
  id: string;
  name: string;
  type: "individual" | "company";
  phone: string;
  email: string;
  language: string;
  since: string;
  past: number;
  flags: string[];
  dedicatedAgentId: string | null;
};

export async function clientsOf(
  db: Exec,
  apps: App[],
): Promise<Map<string, ClientInfo>> {
  const ids = [
    ...new Set(apps.map((a) => a.clientId).filter((x): x is string => !!x)),
  ];
  const out = new Map<string, ClientInfo>();
  const [us, ps, past] = ids.length
    ? await Promise.all([
        db.select().from(users).where(inArray(users.userId, ids)),
        db
          .select()
          .from(opsClientProfiles)
          .where(inArray(opsClientProfiles.userId, ids)),
        db
          .select({ id: applications.clientId, n: sql<number>`count(*)::int` })
          .from(applications)
          .where(
            and(
              inArray(applications.clientId, ids),
              eq(applications.status, "completed_delivered"),
            ),
          )
          .groupBy(applications.clientId),
      ])
    : [[], [], []];
  const pBy = new Map(ps.map((p) => [p.userId, p]));
  const pastBy = new Map(past.map((p) => [p.id, p.n]));
  for (const u of us) {
    const p = pBy.get(u.userId);
    out.set(u.userId, {
      id: u.userId,
      name: u.name,
      type: (p?.type as ClientInfo["type"]) ?? "individual",
      phone: u.phoneE164 ?? "",
      email: u.email ?? "",
      language: u.language,
      since: p?.since ?? u.createdAt.slice(0, 4),
      past: pastBy.get(u.userId) ?? 0,
      flags: (p?.flags as string[]) ?? [],
      dedicatedAgentId: p?.dedicatedAgentId ?? null,
    });
  }
  // Guest cases (no account): fall back to the submitted personal info.
  for (const a of apps)
    if (a.personalInfo && (!a.clientId || !out.has(a.clientId))) { // no row/info → unknown id → caller 404s
      const info = a.personalInfo as Record<string, string>;
      const id = a.clientId ?? `guest-${a.code}`;
      if (!out.has(id))
        out.set(id, {
          id,
          name: info.fullName ?? info.full_name ?? "Client",
          type: "individual",
          phone: info.phone ?? "",
          email: info.email ?? "",
          language: "rw",
          since: a.createdAt.slice(0, 4),
          past: 0,
          flags: [],
          dedicatedAgentId: null,
        });
    }
  return out;
}
export const clientKey = (a: App) => a.clientId ?? `guest-${a.code}`;

export type AgentRow = Agent & {
  role: string;
  skillsLabel: string[];
  status: "available" | "leave" | "parttime";
  shareBps: number;
  managerId: string | null;
  duty: string;
  awayUntil: string | null;
  clearance: string;
  ws: Record<string, unknown>;
  version: number;
  email: string;
  phone: string;
};

/** All agents with live load (open cases where they lead or help). */
export async function agentsAll(db: Exec, ids?: string[]): Promise<AgentRow[]> {
  const rows = await db
    .select({ p: agentProfiles, u: users })
    .from(agentProfiles)
    .innerJoin(users, eq(users.userId, agentProfiles.userId))
    .where(
      ids
        ? inArray(agentProfiles.userId, ids.length ? ids : ["-"])
        : eq(users.isActive, true),
    );
  if (!rows.length) return [];
  const loads = await db.execute<{ id: string; n: number }>(sql`
    select a.assigned_agent_id as id, count(*)::int as n from applications a
    where a.assigned_agent_id is not null and a.status not in ('completed_delivered','rejected','cancelled','refunded')
    group by 1
    union all
    select h.id, count(*)::int from ops_case_meta m
      cross join lateral jsonb_array_elements_text(coalesce(m.data->'helpers','[]'::jsonb)) as h(id)
      join applications a on a.application_id = m.application_id
    where a.status not in ('completed_delivered','rejected','cancelled','refunded') group by 1`);
  const load = new Map<string, number>();
  for (const r of loads) load.set(r.id, (load.get(r.id) ?? 0) + Number(r.n));
  // F-WRK-09: assignments taken today (Kigali day) for the daily cap.
  const todays = await db.execute<{ id: string; n: number }>(sql`
    select assigned_agent_id id, count(*)::int n from applications
    where assigned_agent_id is not null and (assigned_at at time zone 'Africa/Kigali')::date = (now() at time zone 'Africa/Kigali')::date
    group by 1`);
  const today_n = new Map(todays.map((r) => [r.id, Number(r.n)]));
  // ASN-09: restrictions feed ranking/assign eligibility as `conflictWith`.
  const blocks = new Map<string, string[]>();
  for (const b of await db.select({ a: assignmentBlocks.agentId, c: assignmentBlocks.clientId }).from(assignmentBlocks).where(inArray(assignmentBlocks.agentId, rows.map((r) => r.u.userId))))
    (blocks.get(b.a) ?? blocks.set(b.a, []).get(b.a)!).push(b.c);
  const today = new Date().toISOString().slice(0, 10);
  return rows.map(({ p, u }) => ({
    id: u.userId,
    name: u.name,
    email: u.email ?? "",
    phone: u.phoneE164 ?? "",
    external: p.external,
    location: p.location ?? undefined,
    services: p.services as string[],
    skills: p.skills as Record<string, number>,
    load: load.get(u.userId) ?? 0,
    cap: p.cap,
    onLeaveUntil:
      p.onLeaveUntil && p.onLeaveUntil >= today ? p.onLeaveUntil : null,
    cleared: p.clearance === "cleared",
    onTime: p.onTimeBps / 10_000,
    rating: p.ratingX10 / 10,
    languages: p.languages as string[],
    conflictWith: blocks.get(u.userId) ?? [],
    cost: p.costRwf ?? undefined,
    role: p.title,
    skillsLabel: p.skillsLabel as string[],
    status: p.status as AgentRow["status"],
    shareBps: p.shareBps,
    managerId: p.managerId,
    duty: p.duty,
    dailyCap: p.dailyCap,
    assignedToday: today_n.get(u.userId) ?? 0,
    awayUntil: p.awayUntil,
    clearance: p.clearance,
    ws: p.ws as Record<string, unknown>,
    version: p.version,
  }));
}

export async function agentOr404(db: Exec, id: string) {
  const [a] = await agentsAll(db, [id]);
  if (!a) throw err.notFound("Agent not found.");
  return a;
}

// ── service facts ─────────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER(service-institution, service-sla-days): neither lives on `services`; read from here until the
// catalogue gains the columns (P2 follow-up).
const FACTS: Record<string, { institution: string | null; slaDays: number }> = {
  "company-registration": { institution: "RDB", slaDays: 3 },
  "vat-declaration": { institution: "RRA", slaDays: 2 },
  "paye-monthly-filing": { institution: "RRA", slaDays: 2 },
  "tax-clearance-certificate": { institution: "RRA", slaDays: 3 },
  "business-plan": { institution: null, slaDays: 5 },
  "trademark-registration": { institution: "RDB", slaDays: 10 },
  "investment-certificate": { institution: "RDB", slaDays: 10 },
};
export const factsOf = (slug: string) =>
  FACTS[slug] ?? { institution: null, slaDays: 3 };

export async function servicesBySlug(db: Exec, slugs: string[]) {
  const list = [...new Set(slugs)];
  const rows = list.length
    ? await db
        .select({
          slug: services.slug,
          name: services.name,
          pricing: services.pricingMode,
        })
        .from(services)
        .where(inArray(services.slug, list))
    : [];
  return new Map(rows.map((r) => [r.slug, r]));
}

// ── typed record store ────────────────────────────────────────────────────────────────────────────
export type Rec<T> = {
  id: string;
  kind: string;
  ownerId: string | null;
  ref: string | null;
  state: string | null;
  data: T;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export async function recList<T>(
  db: Exec,
  kind: string,
  f: { ownerId?: string; ref?: string; state?: string; refs?: string[] } = {},
  limit = 500,
) {
  const conds = [eq(opsRecords.kind, kind)];
  if (f.ownerId) conds.push(eq(opsRecords.ownerId, f.ownerId));
  if (f.ref) conds.push(eq(opsRecords.ref, f.ref));
  if (f.state) conds.push(eq(opsRecords.state, f.state));
  if (f.refs)
    conds.push(inArray(opsRecords.ref, f.refs.length ? f.refs : ["-"]));
  return (await db
    .select()
    .from(opsRecords)
    .where(and(...conds))
    .orderBy(desc(opsRecords.createdAt))
    .limit(limit)) as Rec<T>[];
}

export async function recGet<T>(
  db: Exec,
  kind: string,
  id: string,
  lock = false,
) {
  const q = db
    .select()
    .from(opsRecords)
    .where(and(eq(opsRecords.kind, kind), eq(opsRecords.id, id)));
  const [r] = lock ? await q.for("update") : await q;
  return (r as Rec<T> | undefined) ?? null;
}

export async function recPut<T>(
  db: Exec,
  kind: string,
  r: {
    id?: string;
    ownerId?: string | null;
    ref?: string | null;
    state?: string | null;
    data: T;
  },
) {
  const now = new Date().toISOString();
  const id = r.id ?? generateId(kind.slice(0, 4));
  const [row] = await db
    .insert(opsRecords)
    .values({
      id,
      kind,
      ownerId: r.ownerId ?? null,
      ref: r.ref ?? null,
      state: r.state ?? null,
      data: r.data as object,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: opsRecords.id,
      set: {
        ownerId: r.ownerId ?? null,
        ref: r.ref ?? null,
        state: r.state ?? null,
        data: r.data as object,
        version: sql`${opsRecords.version} + 1`,
        updatedAt: now,
      },
    })
    .returning();
  return row as Rec<T>;
}

/** Atomic counter in the record store: one upsert, so concurrent first calls never both get 1. */
export async function recSeq(db: Exec, kind: string, id: string) {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(opsRecords)
    .values({ id, kind, data: { n: 1 }, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: opsRecords.id,
      set: {
        data: sql`jsonb_build_object('n', coalesce((${opsRecords.data}->>'n')::int, 0) + 1)`,
        version: sql`${opsRecords.version} + 1`,
        updatedAt: now,
      },
    })
    .returning({ data: opsRecords.data });
  return (row.data as { n: number }).n;
}

/** Every id of one kind, paged by keyset — for sweeps that must not cap or hold one long transaction. */
export async function* recIds(db: Exec, kind: string, page = 500) {
  let after = "";
  for (;;) {
    const rows = await db
      .select({ id: opsRecords.id })
      .from(opsRecords)
      .where(and(eq(opsRecords.kind, kind), sql`${opsRecords.id} > ${after}`))
      .orderBy(opsRecords.id)
      .limit(page);
    for (const r of rows) yield r.id;
    if (rows.length < page) return;
    after = rows[rows.length - 1].id;
  }
}

export const recDelete = (db: Exec, kind: string, id: string) =>
  db
    .delete(opsRecords)
    .where(and(eq(opsRecords.kind, kind), eq(opsRecords.id, id)))
    .returning({ id: opsRecords.id });

export { iso } from "../../../core/db/ids";
export const H = 3600_000;

/** Public-holiday days from last year on (same query as the compliance module). */
export async function holidays(db: Exec) {
  const rows = await db
    .select({ day: complianceHolidays.day })
    .from(complianceHolidays)
    .where(gte(complianceHolidays.day, `${new Date().getUTCFullYear() - 1}-01-01`));
  return new Set(rows.map((r) => r.day));
}

/**
 * DLV-01/04/09: on release, every slot's approved latest version becomes a client-visible `deliverables` row
 * (the client "Results" tab reads only that table). Idempotent per slot+version. Downloads stay locked while a
 * balance is due (documents.service checks the payment gate), so release never leaks unpaid work.
 */
export async function releaseDeliverables(db: Exec, c: CaseRow, by: string | null) {
  const now = new Date().toISOString();
  const rows = c.x.slots.flatMap((sl) => {
    const v = sl.versions.at(-1);
    if (!v?.storageKey || v.state !== "approved") return [];
    return [{
      id: `dlv_${c.app.applicationId}_${sl.key}_${v.v}`.slice(0, 64),
      applicationId: c.app.applicationId,
      title: sl.label || v.name,
      storagePath: v.storageKey,
      mimeType: v.type ?? "application/octet-stream",
      fileSizeBytes: v.size,
      version: sl.versions.length,
      issuer: "HEBUZA",
      releasedAt: now,
      createdBy: by,
      createdAt: now,
      signatureRequired: !!sl.signature,
    }];
  });
  if (!rows.length) return 0;
  const added = await db.insert(deliverables).values(rows).onConflictDoNothing({ target: deliverables.id }).returning({ id: deliverables.id, title: deliverables.title });
  // DLV-06: one single-use 72 h link per newly released file, sent by email/WhatsApp through the notification pipeline.
  if (c.app.clientId)
    for (const d of added) {
      const token = randomBytes(24).toString("base64url");
      await db.insert(downloadTokens).values({ tokenHash: createHash("sha256").update(token).digest("hex"), deliverableId: d.id, userId: c.app.clientId, expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(), createdAt: now });
      await notify(db, { userId: c.app.clientId, kind: "deliverable", title: `${c.app.code}: ${d.title} is ready`, body: "This download link works once and expires in 72 hours.", href: `/d/${token}`, channels: ["email", "whatsapp"] });
    }
  return rows.length;
}
