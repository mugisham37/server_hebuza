// P5 ops workspace: the service manager's case views (list, detail, Today), status/assign/claim, intake triage
// (lane A) and the case record + assign flow (lane B). Callable from RSC and from ops.routes.ts.
import { ownOr404 } from "../../core/auth/authorize";
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Exec } from "./lib/ctx";
import type { Ctx } from "./lib/ctx";
import type { Session } from "./lib/ctx";
import { generateId } from "./lib/ctx";
import { AppError, err } from "./lib/ctx";
import { publish } from "./lib/ctx";
import {
  applicationAssignmentHistory,
  applications,
  applicationStatusHistory,
  auditLog,
  payments,
} from "@/db/schema";
import { movesFor, type CaseFacts } from "@/domain/ops/transitions";
import { ineligibleReason } from "@/domain/ops/ranking";
import { resolveRule } from "@/domain/finance/rules";
import type { Rule } from "@/domain/finance/types";
import { all as finAll } from "../finance/finance.store";
import { rankAgents } from "@/domain/ops/ranking";
import { evaluate } from "@/domain/ops/completeness";
import { quoteTotals, type QuoteLine } from "@/domain/ops/quotation";
import { previewNext } from "@/domain/ops/rules";
import type { CaseStatus } from "@/domain/domain/case-status";
import { notify } from "./lib/ctx";
import {
  CLOSED,
  H,
  PAUSED,
  actorName,
  agentOr404,
  agentsAll,
  clientKey,
  clientsOf,
  eventsOf,
  factsOf,
  iso,
  loadCase,
  loadCases,
  logEvent,
  namesOf,
  recGet,
  recList,
  recPut,
  saveCase,
  servicesBySlug,
  type AgentRow,
  type App,
  type CaseRow,
  type ClientInfo,
} from "./lib/store";

type Bundle = {
  clients: Map<string, ClientInfo>;
  names: Map<string, string>;
  svcs: Awaited<ReturnType<typeof servicesBySlug>>;
};

export async function bundle(db: Exec, rows: CaseRow[]): Promise<Bundle> {
  const apps = rows.map((r) => r.app);
  const clients = await clientsOf(db, apps);
  const [names, svcs] = await Promise.all([
    namesOf(db, [
      ...rows.flatMap((r) => [r.app.assignedAgentId, ...r.x.helpers]),
      ...[...clients.values()].map((c) => c.dedicatedAgentId),
    ]),
    servicesBySlug(
      db,
      apps.map((a) => a.serviceSlug),
    ),
  ]);
  return { clients, names, svcs };
}

export const assigneesOf = (r: CaseRow) => [
  ...(r.app.assignedAgentId
    ? [{ id: r.app.assignedAgentId, role: "lead" as const }]
    : []),
  ...r.x.helpers
    .filter((h) => h !== r.app.assignedAgentId)
    .map((id) => ({ id, role: "helper" as const })),
];
const dueOf = (a: App) =>
  a.dueAt ?? a.slaDeadline ?? iso(Date.parse(a.submittedAt) + 3 * 24 * H);

export function facts(r: CaseRow, b: Pick<Bundle, "svcs">): CaseFacts {
  const ev = evaluate(r.x.checklist);
  return {
    status: r.app.status as CaseStatus,
    previous: r.x.previous,
    missingItems: ev.missing.length,
    pricingMode:
      (b.svcs.get(r.app.serviceSlug)?.pricing as CaseFacts["pricingMode"]) ??
      "fixed",
    fee: r.app.paymentAmount,
    paid: r.app.paymentStatus === "paid",
    covered: r.app.paymentStatus === "covered",
    complete: ev.complete,
    assigneeChosen: !!r.app.assignedAgentId,
    deliverablesUploaded: r.x.slots.filter((s) => s.versions.length).length,
  };
}

export function summary(r: CaseRow, b: Bundle) {
  const { app, x } = r;
  const cl = b.clients.get(clientKey(app))!;
  const lead = app.assignedAgentId;
  const due = dueOf(app);
  const ev = evaluate(x.checklist);
  return {
    application_id: app.applicationId,
    code: app.code,
    service_name: b.svcs.get(app.serviceSlug)?.name ?? app.serviceName,
    service_slug: app.serviceSlug,
    status: app.status,
    tier: app.tier,
    submitted_at: app.submittedAt,
    payment_status: app.paymentStatus,
    handler: app.handler,
    ending: app.ending,
    retainer: false,
    client_name: cl.name,
    client_phone: cl.phone,
    has_account: !!app.clientId,
    assignee_id: lead,
    assignee_name: lead ? (b.names.get(lead) ?? null) : null,
    assigned_agent_name: lead ? (b.names.get(lead) ?? null) : null,
    sla_deadline: due,
    sla_breached:
      Date.parse(due) < Date.now() &&
      !CLOSED.includes(app.status as CaseStatus),
    structure_version: 3,
    waiting_days: Math.max(
      0,
      Math.round((Date.now() - Date.parse(app.updatedAt)) / 86_400_000),
    ),
    partner_id: app.assignedPartnerId,
    partner_name: null,
    quote_status: app.quoteStatus,
    dedicated_agent_id: cl.dedicatedAgentId,
    dedicated_agent_name: cl.dedicatedAgentId
      ? (b.names.get(cl.dedicatedAgentId) ?? null)
      : null,
    due_at: due,
    x_ops: {
      flags: x.flags,
      subStatus: x.subStatus,
      previous: x.previous,
      clientId: cl.id,
      clientType: cl.type,
      amount: app.paymentAmount,
      firstResponseDueAt: x.firstResponseDueAt,
      updatedAt: app.updatedAt,
      assignees: assigneesOf(r).map((a) => ({
        ...a,
        name: b.names.get(a.id) ?? a.id,
      })),
      institution: x.institution ?? factsOf(app.serviceSlug).institution,
      submissionRef: x.submissionRef,
      expectedDecision: x.expectedDecision,
      deliverables: x.slots.filter((s) => s.versions.length).length,
      completeness: { done: ev.done, total: ev.total },
      claimedBy: x.claimedBy,
      precheck: {
        ok: x.checklist.filter((i) => i.state === "provided").length,
        warn: x.checklist.filter((i) => i.state === "check").length,
      },
    },
  };
}

// ── lists and detail ───────────────────────────────────────────────────────────────────────────────
export async function listCases(
  db: Exec,
  q: {
    status?: string;
    agent_id?: string;
    payment_status?: string;
    offset?: number;
    limit?: number;
  },
) {
  const conds = [];
  if (q.status) conds.push(inArray(applications.status, q.status.split(",")));
  if (q.payment_status)
    conds.push(eq(applications.paymentStatus, q.payment_status));
  if (q.agent_id)
    conds.push(
      sql`(${applications.assignedAgentId} = ${q.agent_id} or exists (select 1 from ops_case_meta m where m.application_id = ${applications.applicationId} and m.data->'helpers' ? ${q.agent_id}))`,
    );
  const where = conds.length ? and(...conds) : undefined;
  const offset = q.offset ?? 0,
    limit = q.limit ?? 200;
  const [apps, [{ n }]] = await Promise.all([
    db
      .select()
      .from(applications)
      .where(where)
      .orderBy(desc(applications.createdAt))
      .offset(offset)
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(applications)
      .where(where),
  ]);
  const rows = await loadCases(db, apps);
  const b = await bundle(db, rows);
  return {
    applications: rows.map((r) => summary(r, b)),
    total: n,
    offset,
    limit,
  };
}

export async function caseDetail(db: Exec, code: string) {
  const r = await loadCase(db, code);
  const b = await bundle(db, [r]);
  const s = summary(r, b);
  return {
    ...s,
    x_ops: {
      ...s.x_ops,
      checklist: r.x.checklist,
      client: b.clients.get(clientKey(r.app)),
      moves: movesFor(facts(r, b)),
    },
  };
}

async function historyRow(
  db: Exec,
  s: Session,
  app: App,
  status: string,
  note?: string | null,
) {
  await db.insert(applicationStatusHistory).values({
    id: generateId("ash"),
    applicationId: app.applicationId,
    status,
    changedBy: s.id,
    changedByRole: s.role,
    note: note ?? null,
    createdAt: iso(),
  });
}

/** One status change with guards, history, timeline and client notification. */
/** Ops status writes go through the shared machine as "manager" (history, audit and client notification included). */
async function moveTo(ctx: Ctx, r: CaseRow, to: CaseStatus, note: string | null, extra: Omit<CaseFacts, "status"> = {}) {
  await ctx.transition(r.app, to, { ...facts(r, await bundle(ctx.db, [r])), ...extra }, note);
  r.app.status = to;
}

export async function changeStatus(
  ctx: Ctx,
  code: string,
  b: { status: CaseStatus; reason?: string; sub_status?: string },
) {
  const db = ctx.db,
    s = ctx.session!;
  const r = await loadCase(db, code, true);
  const bd = await bundle(db, [r]);
  const move = movesFor(facts(r, bd)).find((m) => m.to === b.status);
  if (!move)
    throw new AppError(
      409,
      "transition_not_allowed",
      "That status change isn't allowed from here.",
    );
  if (move.blocked) throw new AppError(409, "guard_failed", move.blocked);
  if (move.reason && !b.reason?.trim())
    throw new AppError(422, "reason_required", "A reason is required.");
  const from = r.app.status as CaseStatus;
  r.x.undo = { status: from, subStatus: r.x.subStatus, previous: r.x.previous };
  if (b.status === "on_hold" || b.status === "awaiting_client_documents")
    r.x.previous = from;
  r.x.subStatus =
    b.sub_status ?? (b.status === "on_hold" ? (b.reason ?? null) : null);
  const now = iso();
  await saveCase(db, r, {
    status: b.status,
    ...(b.status === "completed_delivered" && { completedAt: now }),
    ...(b.status === "rejected" && {
      rejectedAt: now,
      rejectionReason: b.reason ?? null,
    }),
    ...(b.status === "cancelled" && {
      cancelledAt: now,
      cancellationReason: b.reason ?? null,
    }),
  });
  await historyRow(db, s, r.app, b.status, b.reason);
  await logEvent(db, r.app.applicationId, {
    kind: "status",
    actorId: s.id,
    actorName: await actorName(db, s),
    from,
    to: b.status,
    text: r.x.subStatus,
    ip: ctx.ip,
  });
  if (r.app.clientId)
    await notify(db, {
      userId: r.app.clientId,
      kind: "status",
      title: `Case ${r.app.code} updated`,
      body: b.status,
      href: `/requests/${r.app.code}`,
    });
  ctx.audit = {
    resourceId: r.app.code,
    details: { from, to: b.status, reason: b.reason ?? null },
  };
  await publish(ctx.db, "case.status_changed", {
    actorId: s.id,
    data: { code: r.app.code, from, to: b.status },
  });
  return summary(r, bd);
}

async function setLead(
  db: Exec,
  s: Session,
  r: CaseRow,
  agentId: string | null,
  note?: string,
) {
  const prev = r.app.assignedAgentId;
  if (prev === agentId) return;
  await db.insert(applicationAssignmentHistory).values({
    id: generateId("aah"),
    applicationId: r.app.applicationId,
    previousAgentId: prev,
    newAgentId: agentId,
    performedBy: s.id,
    performedByRole: s.role,
    note: note ?? null,
    createdAt: iso(),
  });
  await saveCase(db, r, {
    assignedAgentId: agentId,
    assignedAt: agentId ? iso() : null,
  });
  const names = await namesOf(db, [agentId, prev, s.id]);
  await logEvent(db, r.app.applicationId, {
    kind: "assignment",
    actorId: s.id,
    actorName: names.get(s.id) ?? "Staff",
    from: prev ? names.get(prev) : null,
    text: agentId ? (names.get(agentId) ?? agentId) : "—",
  });
  if (agentId)
    await notify(db, {
      userId: agentId,
      kind: "assignment",
      title: `Case ${r.app.code} assigned to you`,
      href: `/agent/cases/${r.app.code}`,
    });
}

function assertCapacity(a: AgentRow) {
  if (a.load >= a.cap)
    throw new AppError(409, "agent_at_capacity", `${a.name} is at capacity.`);
}

export async function assign(
  ctx: Ctx,
  code: string,
  b: { agent_id: string; helpers?: string[]; reviewer_id?: string | null },
) {
  const r = await loadCase(ctx.db, code, true);
  const before = { helpers: [...r.x.helpers], reviewer: r.x.reviewerId ?? null };
  const a = await agentsAll(ctx.db, [b.agent_id]).then((x) => x[0]);
  if (!a) throw new AppError(422, "invalid_agent", "Unknown agent.");
  if (r.app.assignedAgentId !== a.id) {
    // Manual assign runs the ranking's eligibility; bypass only through assign-override (reason, audited).
    const contract = (await recList<{ status: string; until: string }>(ctx.db, "contract")).find((c) => c.ownerId === a.id);
    const cl = (await bundle(ctx.db, [r])).clients.get(clientKey(r.app));
    const why = ineligibleReason({ service: r.app.serviceSlug, clientId: cl?.id ?? r.app.clientId ?? "" }, { ...a, contractUntil: contract?.data.until ?? null });
    if (why === "atCap") assertCapacity(a);
    if (why) throw new AppError(409, "agent_ineligible", `${a.name} can't take this case (${why}). Use an override with a reason.`);
  }
  r.x.helpers = (b.helpers ?? []).filter((h) => h !== a.id);
  if (b.reviewer_id !== undefined) {
    if (b.reviewer_id && (b.reviewer_id === a.id || r.x.helpers.includes(b.reviewer_id)))
      throw new AppError(422, "validation", "The reviewer must be someone other than the lead and helpers.");
    r.x.reviewerId = b.reviewer_id;
  }
  await setLead(ctx.db, ctx.session!, r, a.id);
  await saveCase(ctx.db, r);
  // F-ASN-11: new helpers and the reviewer hear about it (the lead is notified by setLead's offer).
  for (const h of r.x.helpers.filter((x) => !before.helpers.includes(x)))
    await notify(ctx.db, { userId: h, kind: "assignment", title: `You're helping on ${r.app.code}`, href: `/agent/cases/${r.app.code}` });
  if (r.x.reviewerId && r.x.reviewerId !== before.reviewer)
    await notify(ctx.db, { userId: r.x.reviewerId, kind: "assignment", title: `You're the reviewer on ${r.app.code}`, href: `/ops/cases/${r.app.code}` });
  ctx.audit = {
    resourceId: r.app.code,
    details: { agent: a.id, helpers: r.x.helpers, reviewer: r.x.reviewerId ?? null },
  };
  return summary(r, await bundle(ctx.db, [r]));
}

export async function claim(ctx: Ctx, code: string) {
  const s = ctx.session!;
  const r = await loadCase(ctx.db, code, true);
  if (r.x.claimedById && r.x.claimedById !== s.id)
    throw new AppError(
      409,
      "claimed",
      `${r.x.claimedBy} is triaging this case.`,
    );
  r.x.claimedById = s.id;
  r.x.claimedBy = await actorName(ctx.db, s);
  const patch: Partial<App> = {};
  if (r.app.status === "received") {
    r.x.undo = {
      status: "received",
      subStatus: r.x.subStatus,
      previous: r.x.previous,
    };
    await moveTo(ctx, r, "under_review", "claimed"); // spec: automatic when the SM opens it
  }
  await saveCase(ctx.db, r, patch);
  return summary(r, await bundle(ctx.db, [r]));
}

export async function suggestions(db: Exec, code: string, external: boolean) {
  const r = await loadCase(db, code);
  const [b, agents] = await Promise.all([bundle(db, [r]), agentsAll(db)]);
  const cl = b.clients.get(clientKey(r.app))!;
  const out = rankAgents(
    {
      service: r.app.serviceSlug,
      clientId: cl.id,
      language: cl.language,
      dedicatedAgentId: cl.dedicatedAgentId,
      includeExternal: external,
    },
    agents,
    iso().slice(0, 10),
  );
  return { suggestions: out.suggestions, ineligible: out.ineligible };
}

export async function clientDetail(db: Exec, id: string) {
  const apps = await db
    .select()
    .from(applications)
    .where(eq(applications.clientId, id))
    .limit(1);
  const c = (
    await clientsOf(db, apps.length ? apps : [{ clientId: id } as App])
  ).get(id);
  if (!c) throw err.notFound("No client.");
  return c;
}

// ── Today ──────────────────────────────────────────────────────────────────────────────────────────
async function openRows(db: Exec) {
  const apps = await db
    .select()
    .from(applications)
    .where(
      sql`${applications.status} not in ('completed_delivered','rejected','cancelled','refunded')`,
    )
    .limit(2000);
  return loadCases(db, apps);
}

export async function today(db: Exec, s: Session) {
  const now = Date.now();
  const rows = await openRows(db);
  const b = await bundle(db, rows);
  const paused = (r: CaseRow) => PAUSED.includes(r.app.status as CaseStatus);
  const overdue = rows.filter(
    (r) => !paused(r) && Date.parse(dueOf(r.app)) < now,
  );
  const atRisk = rows.filter(
    (r) =>
      !paused(r) &&
      Date.parse(dueOf(r.app)) >= now &&
      Date.parse(dueOf(r.app)) - now <= 24 * H,
  );
  const [agents, approvals, reviews, tickets, me] = await Promise.all([
    agentsAll(db),
    recList<{ kind: string }>(db, "approval", { state: "pending" }),
    recList<{ allocation?: { reviewed: boolean } | null }>(db, "review"),
    recList<{ kind: string; status: string }>(db, "ticket"),
    actorName(db, s),
  ]);
  const st = (x: string) => rows.filter((r) => r.app.status === x).length;
  const intakeSpark = await db.execute<{ d: string; n: number }>(sql`
    select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') d, count(*)::int n from applications
    where created_at >= now() - interval '7 days' group by 1 order by 1`);
  const days = Array.from({ length: 7 }, (_, i) =>
    iso(now - (6 - i) * 24 * H).slice(0, 10),
  );
  const spark = days.map((d) => intakeSpark.find((x) => x.d === d)?.n ?? 0);
  // shortcut: only intake has a real 7-day series; the others hold today's value flat, add daily snapshots (ops.jobs) for trends.
  const flat = (n: number) => Array(7).fill(n);
  const complaints = tickets.filter(
    (t) => t.data.kind === "complaint" && t.data.status !== "resolved",
  ).length;
  const unassigned = rows.filter(
    (r) =>
      !r.app.assignedAgentId &&
      ["under_review", "approved_assigned"].includes(r.app.status),
  ).length;
  const dayKey = (d: number) => iso(now + d * 24 * H).slice(0, 10);
  return {
    manager: { id: s.id, name: me, category: null, categoryName: null },
    intake: st("received"),
    awaitingReview: st("awaiting_internal_review"),
    overdue: overdue.map((r) => summary(r, b)),
    atRisk: atRisk.map((r) => summary(r, b)),
    unassigned,
    complaints,
    reviewBreakdown: {
      deliverables: st("awaiting_internal_review"),
      allocations: reviews.filter(
        (r) => r.data.allocation && !r.data.allocation.reviewed,
      ).length,
      dueDates: approvals.filter((a) => a.data.kind === "due").length,
      leave: approvals.filter((a) => a.data.kind === "leave").length,
      skills: approvals.filter((a) => a.data.kind === "skill").length,
    },
    institutions: ["RDB", "RRA", "RSSB"].map((name) => {
      const mine = rows.filter(
        (r) =>
          (r.x.institution ?? factsOf(r.app.serviceSlug).institution) === name,
      );
      return {
        name,
        count: mine.filter(
          (r) => r.app.status === "awaiting_external_institution",
        ).length,
        next:
          mine
            .map((r) => r.x.expectedDecision)
            .filter(Boolean)
            .sort()[0] ?? null,
      };
    }),
    workload: agents.map((a) => ({
      id: a.id,
      name: a.name,
      cap: a.cap,
      days: [0, 1, 2, 3, 4].map(
        (d) =>
          rows.filter(
            (r) =>
              (r.app.assignedAgentId === a.id || r.x.helpers.includes(a.id)) &&
              dueOf(r.app).slice(0, 10) >= dayKey(0) &&
              dueOf(r.app).slice(0, 10) <= dayKey(d + 2),
          ).length,
      ),
    })),
    // shortcut: consultations come from the booking module (P12); empty until it exposes a service call.
    consultations: [] as { time: string; client: string; mode: string }[],
    sparks: {
      intake: spark,
      review: flat(st("awaiting_internal_review")),
      overdue: flat(overdue.length),
      risk: flat(atRisk.length),
      unassigned: flat(unassigned),
      complaints: flat(complaints),
    },
  };
}

// ── lane A: intake, needs-you, duplicates, undo, nudge, saved views ───────────────────────────────────
export async function intakePulse(db: Exec) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(applications)
    .where(eq(applications.status, "received"));
  return { received: n };
}

export async function needsYou(db: Exec) {
  const rows = await openRows(db);
  const done = await db
    .select()
    .from(applications)
    .where(eq(applications.status, "completed_delivered"))
    .orderBy(desc(applications.updatedAt))
    .limit(20);
  const doneRows = await loadCases(db, done);
  const b = await bundle(db, [...rows, ...doneRows]);
  const item = (r: CaseRow, kind: string) => ({
    id: `${kind}-${r.app.code}`,
    kind,
    ref: r.app.code,
    service: b.svcs.get(r.app.serviceSlug)?.name ?? r.app.serviceName,
    client: b.clients.get(clientKey(r.app))!.name,
    dueAt: dueOf(r.app),
    agent: r.app.assignedAgentId
      ? (b.names.get(r.app.assignedAgentId) ?? null)
      : null,
  });
  const st = (x: string) => rows.filter((r) => r.app.status === x);
  const items = [
    ...st("awaiting_internal_review").map((r) => item(r, "review")),
    ...st("under_review")
      .filter((r) => r.x.checklist.some((i) => i.state === "check"))
      .slice(0, 1)
      .map((r) => item(r, "reupload")),
    ...st("under_review")
      .filter((r) => !r.app.assignedAgentId)
      .slice(0, 1)
      .map((r) => item(r, "declined")),
    ...st("awaiting_payment")
      .slice(0, 1)
      .map((r) => item(r, "quote")),
    ...doneRows
      .filter((r) => r.x.dispute)
      .slice(0, 1)
      .map((r) => item(r, "dispute")),
  ];
  return { items: items.slice(0, 7) };
}

export async function recentEvents(db: Exec, code: string) {
  const r = await loadCase(db, code);
  const ev = await eventsOf(db, r.app.applicationId, "ops", 3);
  return {
    events: ev.map((e) => ({
      kind: e.kind,
      code: e.kind === "status" ? "status" : (e.toValue ?? e.kind),
      actor: e.actorName,
      at: e.at,
      status: e.kind === "status" ? (e.toValue ?? undefined) : undefined,
    })),
  };
}

export async function duplicates(db: Exec, code: string) {
  const r = await loadCase(db, code);
  const others = await db
    .select()
    .from(applications)
    .where(
      and(
        ne(applications.code, r.app.code),
        r.app.clientId ? eq(applications.clientId, r.app.clientId) : sql`false`,
      ),
    )
    .orderBy(desc(applications.createdAt))
    .limit(20);
  const m =
    others.find((o) => o.serviceSlug === r.app.serviceSlug) ?? others[0];
  const rows = await loadCases(db, m ? [r.app, m] : [r.app]);
  const b = await bundle(db, rows);
  const card = (x: CaseRow) => {
    const cl = b.clients.get(clientKey(x.app))!;
    return {
      ref: x.app.code,
      status: x.app.status,
      service: b.svcs.get(x.app.serviceSlug)?.name ?? x.app.serviceName,
      client: cl.name,
      phone: cl.phone,
      submittedAt: x.app.createdAt,
      amount: x.app.paymentAmount,
      payment: x.app.paymentStatus,
      documents: x.x.checklist.filter((i) => i.state !== "missing").length,
    };
  };
  return { source: card(rows[0]), match: rows[1] ? card(rows[1]) : null };
}

export async function resolveDuplicate(
  ctx: Ctx,
  code: string,
  b: { action: "merge" | "dismiss" | "reject"; into?: string },
) {
  const db = ctx.db,
    s = ctx.session!;
  const r = await loadCase(db, code, true);
  r.x.undo = {
    status: r.app.status as CaseStatus,
    subStatus: r.x.subStatus,
    previous: r.x.previous,
  };
  r.x.flags = r.x.flags.filter((f) => f !== "duplicate");
  const patch: Partial<App> = {};
  const name = await actorName(db, s);
  if (b.action === "merge") {
    const into = b.into ? await loadCase(db, b.into).catch(() => null) : null;
    if (!into || into.app.code === r.app.code)
      throw new AppError(
        422,
        "invalid_target",
        "Choose the case to merge into.",
      );
    await moveTo(ctx, r, "cancelled", `Merged into ${into.app.code}`);
    patch.cancelledAt = iso();
    patch.cancellationReason = `Merged into ${into.app.code}`;
    r.x.subStatus = `Merged into ${into.app.code}`;
    await logEvent(db, into.app.applicationId, {
      kind: "document",
      actorId: s.id,
      actorName: name,
      to: "merged",
      text: r.app.code,
    });
  } else if (b.action === "reject") {
    await moveTo(ctx, r, "rejected", "Duplicate request");
    patch.rejectedAt = iso();
    patch.rejectionReason = "Duplicate request";
    r.x.subStatus = "Duplicate request";
  }
  await saveCase(db, r, patch);
  await logEvent(db, r.app.applicationId, {
    kind: "system",
    actorId: s.id,
    actorName: name,
    to: b.action === "dismiss" ? "notDuplicate" : b.action,
  });
  ctx.audit = { resourceId: r.app.code, details: b };
  return { ref: r.app.code, status: r.app.status };
}

export async function revert(ctx: Ctx, code: string) {
  const r = await loadCase(ctx.db, code, true);
  const u = r.x.undo;
  if (!u)
    throw new AppError(
      409,
      "nothing_to_undo",
      "There is nothing to undo for this case.",
    );
  r.x.subStatus = u.subStatus;
  r.x.previous = u.previous;
  r.x.undo = null;
  await saveCase(ctx.db, r, { status: u.status });
  await historyRow(ctx.db, ctx.session!, r.app, u.status, "undo");
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "system",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    to: "undone",
  });
  ctx.audit = { resourceId: r.app.code, details: { to: u.status } };
  return { ref: r.app.code, status: r.app.status };
}

export async function nudge(ctx: Ctx, code: string) {
  const r = await loadCase(ctx.db, code);
  const lead = r.app.assignedAgentId;
  if (!lead)
    throw new AppError(409, "no_assignee", "Nobody is assigned to nudge.");
  const names = await namesOf(ctx.db, [lead, ctx.session!.id]);
  await notify(ctx.db, {
    userId: lead,
    kind: "nudge",
    title: `Update needed on ${r.app.code}`,
    body: `${names.get(ctx.session!.id)} asked for an update.`,
    href: `/agent/cases/${r.app.code}`,
  });
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "message",
    actorId: ctx.session!.id,
    actorName: names.get(ctx.session!.id) ?? "Staff",
    to: "nudged",
  });
  return { ref: r.app.code, to: names.get(lead) ?? lead };
}

type View = {
  name: string;
  query: string;
  shared: boolean;
  isDefault: boolean;
};
export async function listViews(db: Exec, s: Session) {
  const [mine, shared] = await Promise.all([
    recList<View>(db, "view", { ownerId: s.id }),
    recList<View>(db, "view", { state: "shared" }),
  ]);
  const all = new Map([...shared, ...mine].map((v) => [v.id, v]));
  return {
    views: [...all.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((v) => ({
        id: v.id,
        ...v.data,
        isDefault: v.ownerId === s.id && v.data.isDefault,
      })),
  };
}
export async function createView(db: Exec, s: Session, b: View) {
  const name = b.name.trim();
  if (!name) throw new AppError(422, "name_required", "Give the view a name.");
  const mine = await recList<View>(db, "view", { ownerId: s.id });
  if (mine.some((v) => v.data.name.toLowerCase() === name.toLowerCase()))
    throw new AppError(
      409,
      "duplicate_name",
      "A view with that name already exists.",
    );
  if (b.isDefault)
    for (const v of mine.filter((v) => v.data.isDefault))
      await recPut(db, "view", { ...v, data: { ...v.data, isDefault: false } });
  const v = await recPut<View>(db, "view", {
    ownerId: s.id,
    state: b.shared ? "shared" : "private",
    data: { ...b, name },
  });
  return { id: v.id, ...v.data };
}
export async function deleteView(db: Exec, s: Session, id: string) {
  const v = await recGet<View>(db, "view", id, true);
  ownOr404(s, v, (x) => x.ownerId, "View");
  await db.execute(
    sql`delete from ops_records where kind = 'view' and id = ${id}`,
  );
  return { deleted: true };
}

// ── lane B: case record ──────────────────────────────────────────────────────────────────────────────
const PRICE_LIST: Record<string, { label: string; unit: number }[]> = {
  "business-plan": [
    { label: "Market analysis", unit: 150000 },
    { label: "Financial projections", unit: 200000 },
    { label: "Bank-ready formatting", unit: 100000 },
    { label: "Executive summary", unit: 60000 },
  ],
  "investment-certificate": [
    { label: "Eligibility review", unit: 300000 },
    { label: "Application dossier", unit: 600000 },
    { label: "RDB follow-up", unit: 300000 },
  ],
};
const DOC_KIND: Record<string, "id" | "image" | "pdf"> = {
  id: "id",
  sh1: "id",
  sh2: "id",
  address: "image",
  payment: "image",
};

export async function record(db: Exec, code: string) {
  const r = await loadCase(db, code);
  const b = await bundle(db, [r]);
  const cl = b.clients.get(clientKey(r.app))!;
  const info = {
    ...(r.app.personalInfo as Record<string, unknown>),
    ...(r.app.serviceData as Record<string, unknown>),
  };
  const rows = Object.entries(info)
    .filter(([, v]) => ["string", "number"].includes(typeof v))
    .slice(0, 24)
    .map(([k, v]) => ({ label: k, value: String(v) }));
  const shareholders = Array.isArray(info.shareholders)
    ? (info.shareholders as { name: string; pct: number }[])
    : [];
  const paid = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.applicationCode, r.app.code),
        eq(payments.status, "succeeded"),
      ),
    );
  const docs = r.x.checklist
    .filter((i) => i.docId)
    .map((i, k) => {
      const kind = DOC_KIND[i.key] ?? "pdf";
      const bad = i.state === "check";
      return {
        id: i.docId!,
        key: i.key,
        label: i.label,
        kind,
        pages: kind === "id" ? 2 : kind === "pdf" ? 3 : 1,
        // shortcut: legibility/type/expiry are placeholders until document OCR (P3 documents.jobs) writes them.
        legibility: bad ? 61 : 98 - (k % 3),
        typeDetected:
          kind === "id"
            ? "National ID"
            : kind === "image"
              ? "Image"
              : "PDF document",
        expiry: null,
        nameOnDoc: cl.name,
        checks: bad ? [{ kind: "blurry" }] : [{ kind: "legible" }],
        state:
          r.x.docs[i.docId!]?.state ??
          (i.state === "rejected" ? "rejected" : null),
        reason: r.x.docs[i.docId!]?.reason ?? null,
        uploadedAt: r.app.submittedAt,
      };
    });
  return {
    groups: [{ key: "request", rows }],
    shareholders,
    docs,
    request: r.x.request,
    quote: r.x.quote,
    priceList: PRICE_LIST[r.app.serviceSlug] ?? [
      {
        label: b.svcs.get(r.app.serviceSlug)?.name ?? r.app.serviceName,
        unit: r.app.paymentAmount ?? 50000,
      },
    ],
    payments: paid.map((p) => ({
      label: p.receiptNumber ?? p.paymentId,
      amount: p.amountRwf,
      method: p.method,
      at: p.paidAt ?? p.createdAt,
    })),
    reuploaded:
      r.x.request &&
      r.app.status === "under_review" &&
      r.x.previous === "awaiting_client_documents"
        ? r.x.request.items.length
        : 0,
  };
}

export async function docDecision(
  ctx: Ctx,
  code: string,
  doc: string,
  b: { decision: "accepted" | "rejected" | null; reason?: string },
) {
  if (b.decision === "rejected" && !b.reason?.trim())
    throw new AppError(422, "reason_required", "A reason is required.");
  const r = await loadCase(ctx.db, code, true);
  const item = r.x.checklist.find((i) => i.docId === doc);
  if (!item) throw err.notFound("No such document.");
  const before = r.x.docs[doc]?.state ?? null;
  r.x.docs[doc] = { state: b.decision, reason: b.reason };
  item.state =
    b.decision === "accepted"
      ? "provided"
      : b.decision === "rejected"
        ? "rejected"
        : "check";
  item.note = b.decision === "rejected" ? b.reason : undefined;
  await saveCase(ctx.db, r);
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "document",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    text: item.label,
    from: before,
    to: b.decision ?? "pending",
  });
  return { state: b.decision };
}

export async function checklistComplete(ctx: Ctx, code: string) {
  const r = await loadCase(ctx.db, code);
  if (
    r.x.checklist.filter((i) => i.required).some((i) => i.state !== "provided")
  )
    throw new AppError(
      409,
      "incomplete",
      "Some required items are not provided yet.",
    );
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "system",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    text: "checklistComplete",
  });
  return { complete: true };
}

export async function documentRequest(
  ctx: Ctx,
  code: string,
  b: {
    items: { key: string; note: string }[];
    due: string;
    channels: string[];
    sub?: string;
  },
) {
  if (!b.items.length)
    throw new AppError(422, "validation", "Choose at least one item.");
  if (!b.channels.length)
    throw new AppError(422, "validation", "Choose at least one channel.");
  const r = await loadCase(ctx.db, code, true);
  const items = b.items.map((i) => ({
    ...i,
    label: r.x.checklist.find((k) => k.key === i.key)?.label ?? i.key,
  }));
  r.x.request = { items, due: b.due, channels: b.channels, sentAt: iso() };
  if (r.app.status !== "awaiting_client_documents") {
    r.x.previous = r.app.status as CaseStatus;
    await moveTo(ctx, r, "awaiting_client_documents", items.map((i) => i.label).join(", "), { missingItems: items.length });
  }
  r.x.subStatus = b.sub ?? null;
  await saveCase(ctx.db, r);
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "message",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    text: items.map((i) => i.label).join(", "),
    to: "request",
  });
  if (r.app.clientId)
    await notify(ctx.db, {
      userId: r.app.clientId,
      kind: "document_request",
      title: `Documents needed for ${r.app.code}`,
      body: items.map((i) => i.label).join(", "),
      href: `/requests/${r.app.code}`,
    });
  return r.x.request;
}

export async function quotation(
  ctx: Ctx,
  code: string,
  b: {
    lines: QuoteLine[];
    discountPct: number;
    discountReason?: string;
    validityDays: number;
    note: string;
    sub?: string;
  },
) {
  const t = quoteTotals(b);
  if (t.errors.length)
    throw new AppError(422, "validation", t.errors.join(","));
  const r = await loadCase(ctx.db, code, true);
  r.x.quote = { ...b, ...t, sentAt: iso() };
  if (r.app.status !== "awaiting_quotation") {
    r.x.previous = r.app.status as CaseStatus;
    await moveTo(ctx, r, "awaiting_quotation", null);
  }
  r.x.subStatus = b.sub ?? null;
  await saveCase(ctx.db, r, {
    paymentAmount: t.total,
    quoteStatus: "sent",
  });
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "payment",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    text: String(t.total),
    to: "quote",
  });
  return r.x.quote;
}

const evOut = (e: Awaited<ReturnType<typeof eventsOf>>[number]) => ({
  id: e.id,
  kind: e.kind,
  actor: e.actorName,
  at: e.at,
  ip: e.ip ?? undefined,
  from: e.fromValue ?? undefined,
  to: e.toValue ?? undefined,
  text: e.text ?? undefined,
  internal: e.internal || undefined,
  client: e.client || undefined,
});
export async function timeline(db: Exec, code: string) {
  const r = await loadCase(db, code);
  return {
    events: (await eventsOf(db, r.app.applicationId, "ops")).map(evOut),
  };
}

export async function viewAs(
  ctx: Ctx,
  code: string,
  b: { reason?: string; note?: string },
) {
  const r = await loadCase(ctx.db, code);
  const reason = [b.reason, b.note].filter(Boolean).join(": ");
  if (!reason.trim())
    throw new AppError(422, "reason_required", "Give a reason.");
  ctx.audit = { resourceId: r.app.code, details: { reason } };
  return {};
}

export async function addNote(ctx: Ctx, code: string, body: string) {
  if (!body.trim())
    throw new AppError(422, "validation", "Write a note first.");
  if (body.length > 2000)
    throw new AppError(
      422,
      "validation",
      "Notes are limited to 2,000 characters.",
    );
  const r = await loadCase(ctx.db, code);
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "note",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    text: body.trim(),
    internal: true,
  });
  return {};
}

/** Audit rows for one entity (append-only audit_log) merged with the case timeline. */
export async function auditLogFor(db: Exec, entity: string | undefined) {
  if (!entity) return { rows: [] };
  const r = await loadCase(db, entity).catch(() => null);
  if (!r) return { rows: [] };
  const [audits, ev] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.resourceId, [r.app.code, r.app.applicationId]))
      .orderBy(desc(auditLog.createdAt))
      .limit(200),
    eventsOf(db, r.app.applicationId, "ops"),
  ]);
  const names = await namesOf(
    db,
    audits.map((a) => a.actorId),
  );
  return {
    rows: [
      ...audits.map((a) => ({
        id: a.id,
        kind: "system",
        actor: (a.actorId && names.get(a.actorId)) ?? "System",
        at: a.createdAt,
        ip: a.ipAddress ?? undefined,
        text: `${a.action}:${String((a.details as Record<string, unknown>)?.reason ?? "")}`,
      })),
      ...ev.filter((e) => e.kind !== "message" || !e.client).map(evOut),
    ].sort((a, b) => b.at.localeCompare(a.at)),
  };
}

export async function auditItems(db: Exec, kind: string, id: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.resourceId, id),
        sql`${auditLog.resourceType} like ${kind + "%"} or ${auditLog.resourceId} = ${id}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(200);
  const names = await namesOf(
    db,
    rows.map((a) => a.actorId),
  );
  return {
    items: rows.map((a) => {
      const d = (a.details ?? {}) as Record<string, unknown>;
      return {
        id: a.id,
        at: a.createdAt,
        actor: (a.actorId && names.get(a.actorId)) ?? "System",
        action: a.action,
        entity: { kind, id },
        before: d.before,
        after: d.after,
        reason: d.reason as string | undefined,
        ip: a.ipAddress ?? "",
      };
    }),
  };
}

// ── lane B: assign flow ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER(internal-cost-pct): internal cost estimate. F-WRK-07: the agent share is finance's rule in force for the service.
async function revenueRule(db: Exec, serviceSlug: string) {
  let bps = 3000; // POLICY.defaultAgentBps when finance has no rule
  try {
    bps = resolveRule(await finAll<Rule>(db, "rule"), { serviceSlug, date: new Date().toISOString() }).agentPct;
  } catch { /* no rule → default */ }
  const agent = Math.round(bps / 100);
  return { agency: 100 - agent, agent };
}
export async function assignContext(db: Exec, code: string) {
  const r = await loadCase(db, code);
  const [agents, b, contracts] = await Promise.all([
    agentsAll(db),
    bundle(db, [r]),
    recList<{ status: string; until: string }>(db, "contract"),
  ]);
  const rows = await openRows(db);
  const fee = r.app.paymentAmount ?? 100000;
  const day = (d: number) => iso(Date.now() + d * 24 * H).slice(0, 10);
  return {
    internalCost: Math.round(fee * 0.4),
    revenueRule: await revenueRule(db, r.app.serviceSlug),
    contracts: Object.fromEntries(
      contracts
        .filter((c) => c.ownerId)
        .map((c) => [
          c.ownerId!,
          { status: c.data.status, until: c.data.until },
        ]),
    ),
    week: Object.fromEntries(
      agents.map((a) => [
        a.id,
        [0, 1, 2, 3, 4].map(
          (d) =>
            rows.filter(
              (x) =>
                x.app.assignedAgentId === a.id &&
                dueOf(x.app).slice(0, 10) <= day(d + 2),
            ).length,
        ),
      ]),
    ),
    language: b.clients.get(clientKey(r.app))!.language,
    location: "Kigali",
  };
}

export async function saveTerms(
  ctx: Ctx,
  code: string,
  b: {
    lead: { id: string; share: number };
    helpers?: { id: string; share: number }[];
    price?: number;
    override?: { agency: number; reason: string };
  },
) {
  const total =
    b.lead.share + (b.helpers ?? []).reduce((s, h) => s + h.share, 0);
  if (b.helpers?.length && total !== 100)
    throw new AppError(422, "validation", "Shares must total 100%.");
  if (b.override && !b.override.reason?.trim())
    throw new AppError(422, "reason_required", "A reason is required.");
  const r = await loadCase(ctx.db, code, true);
  r.x.terms = b;
  await saveCase(ctx.db, r);
  ctx.audit = { resourceId: r.app.code, details: b };
  return b;
}

export async function assignOverride(
  ctx: Ctx,
  code: string,
  b: { agent_id: string; reason: string },
) {
  if (!b.reason?.trim())
    throw new AppError(422, "reason_required", "A reason is required.");
  const r = await loadCase(ctx.db, code, true);
  const a = (await agentsAll(ctx.db, [b.agent_id]))[0];
  if (!a) throw new AppError(422, "invalid_agent", "Unknown agent.");
  r.x.helpers = [];
  await setLead(ctx.db, ctx.session!, r, a.id, `override: ${b.reason}`);
  await saveCase(ctx.db, r);
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "system",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    text: `override:${a.name}:${b.reason}`,
  });
  ctx.audit = { resourceId: r.app.code, details: b };
  return {};
}

const BRIEFS: Record<
  string,
  { name: string; steps: string[]; deliverables: string[] }
> = {
  "company-registration": {
    name: "Company registration — standard brief",
    steps: [
      "Reserve name on RDB portal",
      "Prepare articles of association",
      "Submit application",
      "Upload certificate",
    ],
    deliverables: ["Certificate of incorporation (PDF)", "RDB receipt"],
  },
  default: {
    name: "Standard brief",
    steps: [
      "Review client documents",
      "Prepare the filing",
      "Submit to the institution",
      "Upload the result",
    ],
    deliverables: ["Final document (PDF)", "Institution receipt"],
  },
};
export async function getBrief(db: Exec, code: string) {
  const r = await loadCase(db, code);
  const t = BRIEFS[r.app.serviceSlug] ?? BRIEFS.default;
  return {
    brief: r.x.brief,
    templates: Object.entries(BRIEFS).map(([id, v]) => ({ id, ...v })),
    suggested: {
      template: BRIEFS[r.app.serviceSlug] ? r.app.serviceSlug : "default",
      steps: t.steps.map((s) => ({ text: s, done: false })),
      deliverables: t.deliverables,
      deadline: dueOf(r.app).slice(0, 10),
      priority: r.x.flags.includes("urgent") ? "high" : "normal",
      instructions: "",
      attachments: [],
    },
    clientDeadline: dueOf(r.app),
  };
}
export async function putBrief(
  ctx: Ctx,
  code: string,
  b: {
    steps: { text: string; done: boolean }[];
    deadline: string;
    instructions?: string;
  } & Record<string, unknown>,
) {
  if (!b.steps.length)
    throw new AppError(422, "validation", "Add at least one step.");
  if (!b.deadline) throw new AppError(422, "validation", "Pick a deadline.");
  const r = await loadCase(ctx.db, code, true);
  r.x.brief = b;
  // The agent workbench reads the brief as its instructions and checklist.
  r.x.instructions = b.instructions ?? r.x.instructions;
  r.x.steps = b.steps.map((s, i) => ({
    id: `s${i + 1}`,
    label: s.text,
    done: s.done,
  }));
  await saveCase(ctx.db, r);
  return b;
}

const SCOPE_KEYS = [
  "nationalId",
  "address",
  "shareholderIds",
  "answers",
  "bank",
  "payment",
  "phone",
  "email",
  "history",
];
const defaultScope = () =>
  Object.fromEntries(
    SCOPE_KEYS.map((k) => [
      k,
      {
        lead: true,
        helper: !["bank", "payment"].includes(k),
        external: [
          "nationalId",
          "address",
          "shareholderIds",
          "answers",
        ].includes(k),
      },
    ]),
  );
export async function getScope(db: Exec, code: string) {
  const r = await loadCase(db, code);
  const cl = (await clientsOf(db, [r.app])).get(clientKey(r.app))!;
  return {
    scope: r.x.scope ?? defaultScope(),
    phone: cl.phone,
    email: cl.email,
  };
}
export async function putScope(
  ctx: Ctx,
  code: string,
  scope: Record<string, unknown>,
) {
  const r = await loadCase(ctx.db, code, true);
  r.x.scope = scope;
  await saveCase(ctx.db, r);
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "system",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    text: "scopeSaved",
  });
  return {};
}

// ── offers (shared with the agent's /agent/x/offers) ────────────────────────────────────────────────────
export type OfferData = {
  agentId: string;
  agentName: string;
  state: "sent" | "viewed" | "accepted" | "declined" | "timeout" | "withdrawn";
  sentAt: string;
  expiresAt: string;
  viewedAt?: string;
  endedAt?: string;
  declineReason?: string;
  note?: string;
  summary: string;
  dueAt: string;
  effortH: number;
  eligible: number;
  shared: [number, number];
  skills: string[];
  counter?: {
    due: string;
    reason: string;
    status: "pending" | "accepted" | "declined";
  };
};
/** Expired offers become timeouts at read time (the sweep job persists them; see ops.jobs.ts). */
export const offerNow = (o: OfferData): OfferData =>
  ["sent", "viewed"].includes(o.state) &&
  Date.parse(o.expiresAt) <= Date.now() &&
  o.counter?.status !== "pending"
    ? { ...o, state: "timeout", endedAt: o.expiresAt }
    : o;
const offerOut = (r: { id: string; data: OfferData }) => {
  const o = offerNow(r.data);
  return {
    id: r.id,
    agentId: o.agentId,
    agentName: o.agentName,
    state: o.state,
    sentAt: o.sentAt,
    expiresAt: o.expiresAt,
    viewedAt: o.viewedAt,
    endedAt: o.endedAt,
    declineReason: o.declineReason,
  };
};

export async function listOffers(db: Exec, code: string) {
  const r = await loadCase(db, code);
  const offers = (
    await recList<OfferData>(db, "offer", { ref: r.app.code })
  ).reverse();
  return { offers: offers.map(offerOut) };
}

export async function sendOffer(
  ctx: Ctx,
  code: string,
  agentId: string,
  ttlMinutes = 120,
  reassign?: { from: string | null; note?: string },
) {
  const db = ctx.db;
  const r = await loadCase(db, code, true);
  const a = (await agentsAll(db, [agentId]))[0];
  if (!a) throw new AppError(422, "invalid_agent", "Unknown agent.");
  for (const o of await recList<OfferData>(db, "offer", { ref: r.app.code }))
    if (["sent", "viewed"].includes(offerNow(o.data).state))
      await recPut(db, "offer", {
        ...o,
        state: "withdrawn",
        data: { ...o.data, state: "withdrawn", endedAt: iso() },
      });
    else if (offerNow(o.data).state !== o.data.state)
      await recPut(db, "offer", {
        ...o,
        state: offerNow(o.data).state,
        data: offerNow(o.data),
      });
  const facts = factsOf(r.app.serviceSlug);
  const now = Date.now();
  const o = await recPut<OfferData>(db, "offer", {
    ownerId: a.id,
    ref: r.app.code,
    state: "sent",
    data: {
      agentId: a.id,
      agentName: a.name,
      state: "sent",
      sentAt: iso(now),
      expiresAt: iso(now + ttlMinutes * 60_000),
      summary: String(
        (r.x.brief as { instructions?: string } | null)?.instructions ||
          `${r.app.serviceName}.`,
      ),
      dueAt: dueOf(r.app),
      effortH: 3,
      eligible: r.app.paymentAmount ?? 0,
      shared: [
        r.x.checklist.filter((i) => i.docId).length,
        r.x.checklist.length,
      ],
      skills: facts.institution ? [facts.institution] : [],
    },
  });
  await notify(db, {
    userId: a.id,
    kind: "offer",
    title: `New offer — ${r.app.serviceName}`,
    href: "/agent/offers",
  });
  await logEvent(db, r.app.applicationId, {
    kind: "assignment",
    actorId: ctx.session!.id,
    actorName: await actorName(db, ctx.session!),
    text: a.name,
    to: reassign ? "reassign" : "offer",
    from: reassign?.from ?? null,
  });
  return offerOut(o);
}

export async function reassign(
  ctx: Ctx,
  code: string,
  b: {
    to: string;
    reason: string;
    note?: string;
    handoff?: string;
    revoke: boolean;
    split_pct?: number;
    notify: boolean;
  },
) {
  if (!b.reason)
    throw new AppError(422, "reason_required", "A reason is required.");
  if (b.split_pct !== undefined && (b.split_pct < 0 || b.split_pct > 100))
    throw new AppError(422, "validation", "Split must be 0–100%.");
  const r = await loadCase(ctx.db, code, true);
  const to = (await agentsAll(ctx.db, [b.to]))[0];
  if (!to) throw new AppError(422, "invalid_agent", "Unknown agent.");
  assertCapacity(to);
  const from = r.app.assignedAgentId;
  r.x.helpers = b.revoke || !from ? [] : [from];
  await setLead(
    ctx.db,
    ctx.session!,
    r,
    to.id,
    `${b.reason}${b.note ? `: ${b.note}` : ""}`,
  );
  if (b.handoff)
    r.x.instructions = `${r.x.instructions}\n\nHandoff: ${b.handoff}`.trim();
  await saveCase(ctx.db, r);
  const names = await namesOf(ctx.db, [from]);
  await sendOffer(ctx, code, to.id, 120, {
    from: from ? (names.get(from) ?? null) : null,
  });
  if (b.notify && from)
    await notify(ctx.db, {
      userId: from,
      kind: "assignment",
      title: `${r.app.code} was reassigned`,
      body: b.reason,
    });
  ctx.audit = {
    resourceId: r.app.code,
    details: { from, to: to.id, reason: b.reason, revoke: b.revoke },
  };
  return {};
}

// ── auto-assign rules per service ─────────────────────────────────────────────────────────────────────
type Rules = {
  mode: "roundRobin" | "leastLoaded" | "skill";
  pool: string[];
  cap: number;
  vipApproval: boolean;
  assignMode?: "manual" | "suggest" | "auto";
  threshold?: number;
};
export async function getAutoAssign(db: Exec, slug: string) {
  const [agents, rec] = await Promise.all([
    agentsAll(db),
    recGet<Rules>(db, "auto_assign", `aa:${slug}`),
  ]);
  const r = rec?.data ?? {
    mode: "skill" as const,
    pool: agents
      .filter((a) => a.services.includes(slug) && !a.external)
      .map((a) => a.id),
    cap: 8,
    vipApproval: true,
  };
  return {
    ...r,
    preview: previewNext(r, agents, slug),
    candidates: agents
      .filter((a) => a.services.includes(slug))
      .map((a) => a.id),
  };
}
export async function putAutoAssign(ctx: Ctx, slug: string, b: Rules) {
  if (!b.pool.length)
    throw new AppError(
      422,
      "validation",
      "Pick at least one agent for the pool.",
    );
  if (!(b.cap >= 1 && b.cap <= 20))
    throw new AppError(422, "validation", "Daily cap must be 1–20.");
  await recPut(ctx.db, "auto_assign", { id: `aa:${slug}`, ref: slug, data: b });
  ctx.audit = { resourceId: slug, details: b };
  return b;
}

/** Auto-assign one case per its service rules (called by the intake job). Returns the agent id or null. */
export async function autoAssign(db: Exec, code: string, system: Session) {
  const r = await loadCase(db, code, true);
  if (r.app.assignedAgentId) return r.app.assignedAgentId;
  const rules = await getAutoAssign(db, r.app.serviceSlug);
  // F-ASN-07: per-service manual | suggest | auto; only "auto" assigns, and only at or above the score threshold.
  if ((rules.assignMode ?? "auto") !== "auto") return null;
  // F-ASN-03: an agent whose offer on this case timed out or was declined is not offered it again; the next one is.
  const passed = new Set(
    (await recList<OfferData>(db, "offer", { ref: code }))
      .filter((o) => o.state === "timeout" || o.state === "declined")
      .map((o) => o.ownerId),
  );
  const ranked = (await suggestions(db, code, false)).suggestions.filter(
    (s) => rules.pool.includes(s.agent.id) && !passed.has(s.agent.id) && s.agent.load < Math.min(s.agent.cap, rules.cap),
  );
  const top = ranked[0];
  if (!top || top.score < (rules.threshold ?? 50)) return null;
  const pick = (await agentsAll(db, [top.agent.id]))[0];
  await setLead(db, { ...system, id: pick.managerId ?? pick.id }, r, pick.id, `auto-assign:score ${top.score}`);
  return pick.id;
}

void gte;
void asc;
void agentOr404;
