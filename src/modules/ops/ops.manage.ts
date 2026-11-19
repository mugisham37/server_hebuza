// P5 ops lanes C–D: workload + capacity, workforce approvals, SLA, deliverable reviews (payment gate, second
// approval, revenue allocation) and tickets/complaints/disputes. Same store as ops.service.ts.
import { sql } from "drizzle-orm";
import type { Exec } from "./lib/ctx";
import type { Ctx } from "./lib/ctx";
import type { Session } from "./lib/ctx";
import { generateId } from "./lib/ctx";
import { AppError, err } from "./lib/ctx";
import { publish } from "./lib/ctx";
import { agentProfiles, assignmentBlocks, users } from "@/db/schema";
import { applications } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CaseStatus } from "@/domain/domain/case-status";
import { notify } from "./lib/ctx";
import {

  H,
  PAUSED,
  actorName,
  agentOr404,
  agentsAll,
  clientsOf,

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
  releaseDeliverables,
  servicesBySlug,
  type AgentRow,
  type CaseRow,
  type Rec,
} from "./lib/store";
import { holidays } from "./lib/store";

const dueOf = (r: CaseRow) =>
  r.app.dueAt ??
  r.app.slaDeadline ??
  iso(Date.parse(r.app.submittedAt) + 3 * 24 * H);
const plus = (days: number) => iso(Date.now() + days * 24 * H).slice(0, 10);

async function openRowsOf(db: Exec, agentIds?: string[]) {
  const apps = await db
    .select()
    .from(applications)
    .where(
      sql`${applications.status} not in ('completed_delivered','rejected','cancelled','refunded')${agentIds ? sql` and (${applications.assignedAgentId} in ${agentIds.length ? agentIds : ["-"]} or exists (select 1 from ops_case_meta m where m.application_id = ${applications.applicationId} and m.data->'helpers' ?| array[${sql.join(agentIds.map((a) => sql`${a}`), sql`,`)}]::text[]))` : sql``}`,
    )
    .limit(3000);
  return loadCases(db, apps);
}
const involves = (r: CaseRow, id: string) =>
  r.app.assignedAgentId === id || r.x.helpers.includes(id);

// ── workload ────────────────────────────────────────────────────────────────────────────────────────────
const weekStart = (offset: number) => {
  const d = new Date(Date.now() + 2 * H);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offset * 7);
  return d.getTime() - 2 * H;
};
function row(a: AgentRow, rows: CaseRow[], week = 0) {
  const mine = rows.filter((r) => involves(r, a.id)),
    now = Date.now(),
    ws = weekStart(week);
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    external: !!a.external,
    skillsLabel: a.skillsLabel,
    status: a.onLeaveUntil ? "leave" : a.status,
    onLeaveUntil: a.onLeaveUntil ?? null,
    load: a.load,
    cap: a.cap,
    dueWeek: mine.filter(
      (r) =>
        Date.parse(dueOf(r)) >= ws && Date.parse(dueOf(r)) < ws + 7 * 24 * H,
    ).length,
    overdue: mine.filter(
      (r) =>
        !PAUSED.includes(r.app.status as CaseStatus) &&
        Date.parse(dueOf(r)) < now,
    ).length,
    onTime: a.onTime,
    rating: a.rating,
    days: [0, 1, 2, 3, 4].map((d) =>
      a.onLeaveUntil
        ? 0
        : mine.filter((r) => {
            const t = Date.parse(dueOf(r));
            return t >= ws + d * 24 * H && t < ws + (d + 1) * 24 * H;
          }).length,
    ),
    services: a.services,
  };
}

export async function workload(db: Exec, week = 0) {
  const [agents, rows] = await Promise.all([agentsAll(db), openRowsOf(db)]);
  return {
    agents: agents.map((a) => row(a, rows, week)),
    weekStart: iso(weekStart(week)),
  };
}

export async function workloadOf(db: Exec, id: string) {
  const a = await agentOr404(db, id);
  const [rows, leave, done] = await Promise.all([
    openRowsOf(db, [id]),
    recList<Leave>(db, "leave", { ownerId: id }),
    db.execute<{ d: string; n: number }>(
      sql`select to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') d, count(*)::int n from applications where assigned_agent_id = ${id} and completed_at >= now() - interval '30 days' group by 1`,
    ),
  ]);
  const svcs = await servicesBySlug(db, [
    ...Object.keys(a.skills),
    ...rows.map((r) => r.app.serviceSlug),
  ]);
  return {
    ...row(a, rows),
    skills: Object.entries(a.skills).map(([slug, level]) => ({
      name: svcs.get(slug)?.name ?? slug,
      level,
    })),
    cases: rows.map((r) => ({
      ref: r.app.code,
      service: svcs.get(r.app.serviceSlug)?.name ?? r.app.serviceName,
      serviceSlug: r.app.serviceSlug,
      status: r.app.status,
      dueAt: dueOf(r),
    })),
    spark: Array.from(
      { length: 30 },
      (_, i) => done.find((x) => x.d === plus(i - 29))?.n ?? 0,
    ),
    leave: leave
      .filter(
        (l) => l.data.status !== "declined" && l.data.status !== "cancelled",
      )
      .map((l) => ({
        from: l.data.from,
        to: l.data.to,
        state: l.data.status === "approved" ? "approved" : "pending",
      })),
  };
}

// PLACEHOLDER(daily-cap-max): src/lib/policy.ts capMax
export const CAP_MAX = 20;
export async function setCap(
  ctx: Ctx,
  id: string,
  b: { daily_case_cap?: number; reason?: string },
) {
  const reason =
    b.reason ?? decodeURIComponent(ctx.req.headers.get("x-audit-reason") ?? "");
  const a = await agentOr404(ctx.db, id);
  if (!b.daily_case_cap || b.daily_case_cap < 1 || b.daily_case_cap > CAP_MAX)
    throw new AppError(422, "validation", `Cap must be 1–${CAP_MAX}.`);
  if (!reason.trim())
    throw new AppError(422, "reason_required", "Give a reason.");
  await ctx.db
    .update(agentProfiles)
    .set({
      cap: b.daily_case_cap,
      version: sql`${agentProfiles.version} + 1`,
      updatedAt: iso(),
    })
    .where(eq(agentProfiles.userId, id));
  ctx.audit = {
    resourceId: id,
    details: {
      before: { cap: a.cap },
      after: { cap: b.daily_case_cap },
      reason,
    },
  };
  return { daily_case_cap: b.daily_case_cap };
}

export async function rebalance(
  ctx: Ctx,
  b: { from: string; to: string; refs: string[] },
) {
  const [from, to] = await Promise.all([
    agentsAll(ctx.db, [b.from]),
    agentsAll(ctx.db, [b.to]),
  ]);
  if (!from[0] || !to[0]) throw err.notFound("Agent not found.");
  const moved: string[] = [];
  for (const ref of b.refs) {
    const r = await loadCase(ctx.db, ref, true).catch(() => null);
    if (!r) continue;
    if (r.app.assignedAgentId === b.from) {
      await saveCase(ctx.db, r, { assignedAgentId: b.to, assignedAt: iso() });
    } else if (r.x.helpers.includes(b.from)) {
      r.x.helpers = r.x.helpers.map((h) => (h === b.from ? b.to : h));
      await saveCase(ctx.db, r);
    } else continue;
    await logEvent(ctx.db, r.app.applicationId, {
      kind: "assignment",
      actorId: ctx.session!.id,
      actorName: await actorName(ctx.db, ctx.session!),
      from: from[0].name,
      text: to[0].name,
      to: "rebalance",
    });
    moved.push(r.app.code);
  }
  if (moved.length)
    await notify(ctx.db, {
      userId: b.to,
      kind: "assignment",
      title: `${moved.length} case(s) moved to you`,
      href: "/agent/cases",
    });
  ctx.audit = { resourceId: b.from, details: { to: b.to, moved } };
  return { moved };
}

// ── workforce approvals (leave, skill, due-date change) ─────────────────────────────────────────────────
export type Leave = {
  from: string;
  to: string;
  reason: string;
  status: "pending" | "approved" | "declined" | "cancelled";
  approvalId?: string;
};
export type Approval = {
  kind: "leave" | "skill" | "due" | "cancel";
  /** For "cancel" this is the requesting client. */
  agentId: string;
  agentName: string;
  state: "pending" | "approved" | "declined";
  submittedAt: string;
  reason: string;
  from?: string;
  to?: string;
  impact?: string[];
  skill?: string;
  certificate?: string;
  ref?: string;
  service?: string;
  currentDue?: string;
  proposedDue?: string;
  sourceId?: string;
};
const approvalOut = (r: Rec<Approval>) => ({
  id: r.id,
  ...r.data,
  state: r.data.state,
});

export async function listApprovals(db: Exec) {
  return {
    approvals: (await recList<Approval>(db, "approval")).map(approvalOut),
  };
}

export async function decideApproval(
  ctx: Ctx,
  id: string,
  decision: "approve" | "decline" | "pending",
) {
  const db = ctx.db;
  const p = await recGet<Approval>(db, "approval", id, true);
  if (!p) throw err.notFound("Request not found.");
  const state =
    decision === "approve"
      ? "approved"
      : decision === "decline"
        ? "declined"
        : "pending";
  const a = p.data;
  if (a.kind === "due" && a.ref) {
    const r = await loadCase(db, a.ref, true);
    await saveCase(db, r, {
      dueAt: state === "approved" ? a.proposedDue! : a.currentDue!,
      dueSource: "manual",
      dueSetBy: ctx.session!.id,
    });
  }
  if (a.kind === "leave" && a.sourceId) {
    const l = await recGet<Leave>(db, "leave", a.sourceId, true);
    if (l)
      await recPut(db, "leave", {
        ...l,
        state,
        data: { ...l.data, status: state },
      });
    if (state === "approved")
      await db
        .update(agentProfiles)
        .set({ onLeaveUntil: a.to!, status: "leave" })
        .where(eq(agentProfiles.userId, a.agentId));
  }
  if (a.kind === "skill" && a.sourceId) {
    const sr = await recGet<Record<string, unknown>>(
      db,
      "skill_request",
      a.sourceId,
      true,
    );
    if (sr)
      await recPut(db, "skill_request", {
        ...sr,
        state,
        data: { ...sr.data, status: state },
      });
    if (state === "approved" && a.skill) {
      const [ap] = await db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.userId, a.agentId))
        .for("update");
      if (ap) {
        const services = [...new Set([...(ap.services as string[]), a.skill])];
        await db
          .update(agentProfiles)
          .set({
            services,
            skills: { ...(ap.skills as object), [a.skill]: 0.6 },
          })
          .where(eq(agentProfiles.userId, a.agentId));
      }
    }
  }
  // REQ-11: an approved client cancellation request cancels the case as manager (refund follows via RFD).
  if (a.kind === "cancel" && a.ref && state === "approved" && p.state === "pending") {
    const r = await loadCase(db, a.ref, true);
    await ctx.transition(r.app, "cancelled", {}, `Client request: ${a.reason}`);
    await saveCase(db, r, { cancellationReason: a.reason });
  }
  const out = await recPut<Approval>(db, "approval", {
    ...p,
    state,
    data: { ...a, state },
  });
  if (state !== "pending")
    await notify(db, {
      userId: a.agentId,
      kind: "approval",
      title: a.kind === "cancel" ? `Your cancellation request for ${a.ref} was ${state}` : `Your ${a.kind} request was ${state}`,
      href: a.kind === "cancel" ? `/requests/${a.ref}` : "/agent/profile",
    });
  ctx.audit = { resourceId: id, details: { kind: a.kind, state } };
  return approvalOut(out);
}

/** Agent side creates the approval row; the agent module calls this. */
export async function openApproval(
  db: Exec,
  a: Omit<Approval, "state" | "submittedAt" | "agentName">,
) {
  const name = (await namesOf(db, [a.agentId])).get(a.agentId) ?? a.agentId;
  return recPut<Approval>(db, "approval", {
    ownerId: a.agentId,
    ref: a.ref ?? null,
    state: "pending",
    data: { ...a, agentName: name, state: "pending", submittedAt: iso() },
  });
}

// ── SLA ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function slaHealth(db: Exec) {
  const rows = await openRowsOf(db);
  const breaches = rows.filter(
    (r) =>
      !PAUSED.includes(r.app.status as CaseStatus) &&
      Date.parse(dueOf(r)) < Date.now(),
  ).length;
  const trend = await db.execute<{ d: string; met: number; n: number }>(sql`
    select to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') d,
      count(*) filter (where completed_at <= coalesce(due_at, sla_deadline, completed_at))::int met, count(*)::int n
    from applications where completed_at >= now() - interval '30 days' group by 1 order by 1`);
  const [first] = await db.execute<{ ms: number | null }>(sql`
    select avg(extract(epoch from (e.at - a.submitted_at)) * 1000)::bigint ms from applications a
    join lateral (select min(at) at from ops_case_events where application_id = a.application_id and kind in ('message','status') and actor_id is not null and actor_id <> coalesce(a.client_id,'')) e on true
    where a.submitted_at >= now() - interval '30 days' and e.at is not null`);
  const met = trend.reduce((s, t) => s + Number(t.met), 0),
    n = trend.reduce((s, t) => s + Number(t.n), 0);
  return {
    metPct: n ? Math.round((met / n) * 100) : 100,
    avgFirstResponseMs: Number(first?.ms ?? 0),
    breaches,
    trend: Array.from({ length: 30 }, (_, i) => {
      const t = trend.find((x) => x.d === plus(i - 29));
      return t && Number(t.n)
        ? Math.round((Number(t.met) / Number(t.n)) * 100)
        : 100;
    }),
  };
}

export async function slaRules(db: Exec) {
  const rows = await db.execute<{ slug: string; name: string }>(
    sql`select slug, name from services where status = 'published' order by name`,
  );
  const hol = [...(await holidays(db))].filter((d) => d >= plus(0)).sort();
  // PLACEHOLDER(first-response-hours): 4 business hours until settings expose it.
  return {
    rules: rows.map((s) => ({
      service: s.slug,
      name: s.name,
      firstResponseH: 4,
      completionDays: factsOf(s.slug).slaDays,
      pauses: PAUSED,
    })),
    holidays: hol,
  };
}

export async function setDue(
  ctx: Ctx,
  code: string,
  b: { due_date: string; note?: string },
) {
  const t = Date.parse(`${b.due_date}T15:00:00Z`); // 17:00 Kigali
  if (!b.due_date || Number.isNaN(t) || t < Date.now())
    throw new AppError(422, "validation", "Pick a future date.");
  const r = await loadCase(ctx.db, code, true);
  const before = r.app.dueAt;
  await saveCase(ctx.db, r, {
    dueAt: iso(t),
    dueSource: "manual",
    dueSetBy: ctx.session!.id,
  });
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "system",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    from: before,
    to: iso(t),
    text: b.note ?? "due",
  });
  ctx.audit = {
    resourceId: r.app.code,
    details: { before, after: iso(t), note: b.note ?? null },
  };
  return { code: r.app.code, due_at: iso(t) };
}

export async function escalate(
  ctx: Ctx,
  code: string,
  b: { reason?: string; note?: string },
) {
  const r = await loadCase(ctx.db, code, true);
  if (!r.x.flags.includes("urgent")) r.x.flags.push("urgent");
  await saveCase(ctx.db, r, { isUrgent: true });
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "system",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    to: "escalated",
    text: b.reason ?? b.note ?? null,
  });
  ctx.audit = { resourceId: r.app.code, details: b };
  return { escalated: true };
}

// ── deliverable reviews ─────────────────────────────────────────────────────────────────────────────────
export type Review = {
  ref: string;
  deliverable: string;
  authorId: string;
  authorName: string;
  version: number;
  submittedAt: string;
  reviewDueAt: string;
  secondLevel: boolean;
  state: "awaiting" | "returned" | "approved";
  files: {
    id: string;
    name: string;
    kind: "pdf" | "image";
    versions: { v: number; pages: string[]; storageKey?: string }[];
  }[];
  comments: {
    id: string;
    fileId: string;
    author: string;
    body: string;
    at: string;
    page: number;
    x: number;
    y: number;
  }[];
  requirements: { id: string; label: string; met: boolean }[];
  chain: {
    name: string;
    role: string;
    state: "approved" | "pending" | "requested" | "waiting";
  }[];
  override: { reason: string; by: string; at: string } | null;
  allocation: {
    fee: number;
    deductions: { label: string; amount: number }[];
    agentPct: number;
    shares: { id: string; name: string; pct: number }[];
    reviewed: boolean;
  } | null;
  returned: { to: string; due: string } | null;
  firstBy?: string;
  pending?: string;
};
// PLACEHOLDER(second-level-threshold): reviews of cases at or above this fee need a second approver.
export const SECOND_LEVEL_RWF = 500_000;
const outstanding = (r: CaseRow) =>
  r.app.paymentStatus === "paid" || r.app.paymentStatus === "covered"
    ? 0
    : r.app.paymentStatus === "partial"
      ? Math.round((r.app.paymentAmount ?? 0) / 2)
      : (r.app.paymentAmount ?? 0);

async function reviewItems(db: Exec, recs: Rec<Review>[]) {
  const rows = await loadCases(
    db,
    await db
      .select()
      .from(applications)
      .where(
        inArray(applications.code, recs.map((r) => r.data.ref).concat("-")),
      ),
  );
  const by = new Map(rows.map((r) => [r.app.code, r]));
  const svcs = await servicesBySlug(
    db,
    rows.map((r) => r.app.serviceSlug),
  );
  return recs
    .filter((r) => by.has(r.data.ref))
    .map((rec) => {
      const c = by.get(rec.data.ref)!,
        v = rec.data;
      return {
        id: rec.id,
        ref: v.ref,
        service: svcs.get(c.app.serviceSlug)?.name ?? c.app.serviceName,
        deliverable: v.deliverable,
        authorId: v.authorId,
        authorName: v.authorName,
        version: v.version,
        submittedAt: v.submittedAt,
        reviewDueAt: v.reviewDueAt,
        payment: c.app.paymentStatus,
        outstanding: v.override ? 0 : outstanding(c),
        amount: c.app.paymentAmount ?? 0,
        secondLevel: v.secondLevel,
        state: v.state,
      };
    });
}

export async function listReviews(db: Exec, tab: string) {
  const all = await recList<Review>(db, "review");
  const state =
    tab === "returned"
      ? "returned"
      : tab === "approved"
        ? "approved"
        : "awaiting";
  const count = (s: Review["state"]) =>
    all.filter((r) => r.data.state === s).length;
  return {
    items: await reviewItems(
      db,
      all.filter((r) => r.data.state === state),
    ),
    counts: {
      mine: count("awaiting"),
      returned: count("returned"),
      approved: count("approved"),
    },
  };
}

async function reviewOr404(db: Exec, id: string, lock = false) {
  const r = await recGet<Review>(db, "review", id, lock);
  if (!r) throw err.notFound("Review not found.");
  return r;
}

export async function reviewDetail(db: Exec, s: Session, id: string) {
  const rec = await reviewOr404(db, id);
  const [item] = await reviewItems(db, [rec]);
  const v = rec.data;
  return {
    ...item,
    viewerId: s.id,
    files: v.files,
    comments: v.comments,
    requirements: v.requirements,
    chain: v.chain,
    gate: {
      blocked: item.outstanding > 0 && !v.override,
      override: v.override,
    },
    allocation: v.allocation,
    returned: v.returned,
  };
}

export async function reviewComment(
  ctx: Ctx,
  id: string,
  b: { fileId: string; body: string; page: number; x: number; y: number },
) {
  if (!b.body.trim()) throw new AppError(422, "validation", "Write a comment.");
  const rec = await reviewOr404(ctx.db, id, true);
  rec.data.comments.push({
    ...b,
    id: generateId("cm"),
    author: await actorName(ctx.db, ctx.session!),
    at: iso(),
  });
  await recPut(ctx.db, "review", rec);
  return { ok: true };
}

/** Moves the case and the agent's workbench review state together. */
async function applyToCase(
  ctx: Ctx,
  ref: string,
  status: CaseStatus,
  review: "returned" | "approved" | "released",
  comment?: string,
) {
  const r = await loadCase(ctx.db, ref, true);
  const now = iso();
  r.x.review = {
    state: review,
    at: now,
    comments: comment
      ? [
          ...(r.x.review?.comments ?? []),
          {
            slot: "*",
            text: comment,
            by: await actorName(ctx.db, ctx.session!),
            at: now,
          },
        ]
      : r.x.review?.comments,
  };
  if (review === "returned")
    for (const sl of r.x.slots) {
      const last = sl.versions.at(-1);
      if (last) last.state = "returned";
    }
  if (review !== "returned")
    for (const sl of r.x.slots) {
      const last = sl.versions.at(-1);
      if (last) last.state = "approved";
    }
  if (review === "released") await releaseDeliverables(ctx.db, r, ctx.session!.id);
  await saveCase(ctx.db, r, {
    status,
    ...(status === "completed_delivered" && { completedAt: now }),
  });
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "status",
    actorId: ctx.session!.id,
    actorName: await actorName(ctx.db, ctx.session!),
    to: status,
    text: comment ?? null,
  });
  if (r.app.assignedAgentId)
    await notify(ctx.db, {
      userId: r.app.assignedAgentId,
      kind: "review",
      title: `Review ${review} — ${r.app.code}`,
      body: comment,
      href: `/agent/cases/${r.app.code}?tab=deliverables`,
    });
  if (status === "completed_delivered" && r.app.clientId)
    await notify(ctx.db, {
      userId: r.app.clientId,
      kind: "status",
      title: `${r.app.code} is complete`,
      href: `/requests/${r.app.code}`,
    });
  await publish(ctx.db, "case.status_changed", {
    actorId: ctx.session!.id,
    data: { code: r.app.code, to: status },
  });
}

export async function reviewDecision(
  ctx: Ctx,
  id: string,
  b: { decision: string; note?: string; due?: string },
) {
  const rec = await reviewOr404(ctx.db, id, true);
  const v = rec.data,
    me = ctx.session!.id;
  const c = await loadCase(ctx.db, v.ref);
  let message = "OK";
  if (b.decision === "reopen") {
    v.state = "awaiting";
    v.returned = null;
    v.chain[0].state = "pending";
    await applyToCase(
      ctx,
      v.ref,
      "awaiting_internal_review",
      "returned",
      b.note,
    );
  } else {
    if (v.authorId === me)
      throw new AppError(403, "own_work", "You can't approve your own work.");
    if (b.decision === "return") {
      v.state = "returned";
      v.returned = { to: v.authorName, due: b.due ?? plus(3) };
      await applyToCase(ctx, v.ref, "in_progress", "returned", b.note);
    } else {
      if (b.decision === "approve_release" && outstanding(c) > 0 && !v.override)
        throw new AppError(409, "payment_gate", "Release blocked: unpaid.");
      if (v.secondLevel && v.chain[1]?.state !== "approved") {
        v.chain[0].state = "approved";
        v.firstBy = me;
        v.pending = b.decision;
        if (v.chain[1].state === "waiting") v.chain[1].state = "requested";
        message = "Waiting for second approval";
      } else {
        v.chain[0].state = "approved";
        v.state = "approved";
        await applyToCase(
          ctx,
          v.ref,
          b.decision === "approve_release"
            ? "completed_delivered"
            : "awaiting_internal_review",
          b.decision === "approve_release" ? "released" : "approved",
          b.note,
        );
      }
    }
  }
  await recPut(ctx.db, "review", { ...rec, state: v.state, data: v });
  ctx.audit = {
    resourceId: v.ref,
    details: { decision: b.decision, note: b.note ?? null },
  };
  const [item] = await reviewItems(ctx.db, [{ ...rec, data: v }]);
  return { item, message };
}

export async function reviewOverride(
  ctx: Ctx,
  id: string,
  b: { reason: string; note?: string; proof: string | null },
) {
  const reason = [
    b.reason,
    b.note ?? decodeURIComponent(ctx.req.headers.get("x-audit-reason") ?? ""),
  ]
    .filter(Boolean)
    .join(": ");
  if (b.reason === "paid_offline" && !b.proof)
    throw new AppError(422, "validation", "Attach the payment proof.");
  if (!b.reason.trim())
    throw new AppError(422, "reason_required", "Give a reason.");
  const rec = await reviewOr404(ctx.db, id, true);
  rec.data.override = {
    reason: b.reason,
    by: await actorName(ctx.db, ctx.session!),
    at: iso(),
  };
  await recPut(ctx.db, "review", rec);
  ctx.audit = {
    resourceId: rec.data.ref,
    details: {
      before: { blocked: true },
      after: { blocked: false, proof: b.proof },
      reason,
    },
  };
  return { ok: true };
}

export async function requestSecond(ctx: Ctx, id: string) {
  const rec = await reviewOr404(ctx.db, id, true);
  if (!rec.data.chain[1])
    throw err.notFound("No second level for this review.");
  rec.data.chain[1].state = "requested";
  await recPut(ctx.db, "review", rec);
  return { ok: true };
}

export async function secondApprove(ctx: Ctx, id: string) {
  const rec = await reviewOr404(ctx.db, id, true);
  const v = rec.data;
  if (
    !v.chain[1] ||
    v.chain[0].state !== "approved" ||
    v.chain[1].state !== "requested"
  )
    throw err.conflict("Nothing waiting for a second approval.");
  if (ctx.session!.id === v.firstBy)
    throw new AppError(
      409,
      "same_approver",
      "A different person must approve this.",
    );
  v.chain[1] = {
    ...v.chain[1],
    name: await actorName(ctx.db, ctx.session!),
    state: "approved",
  };
  v.state = "approved";
  await applyToCase(
    ctx,
    v.ref,
    v.pending === "approve_release"
      ? "completed_delivered"
      : "awaiting_internal_review",
    v.pending === "approve_release" ? "released" : "approved",
  );
  await recPut(ctx.db, "review", { ...rec, state: v.state, data: v });
  ctx.audit = { resourceId: v.ref, details: { decision: v.pending } };
  return (await reviewItems(ctx.db, [rec]))[0];
}

export async function reviewAllocation(
  ctx: Ctx,
  id: string,
  b: { shares: { id: string; name: string; pct: number }[]; reason: string },
) {
  const rec = await reviewOr404(ctx.db, id, true);
  if (!rec.data.allocation) throw err.notFound("No allocation.");
  if (b.shares.reduce((s, x) => s + x.pct, 0) !== 100)
    throw new AppError(422, "validation", "Shares must add up to 100%.");
  const reason =
    b.reason || decodeURIComponent(ctx.req.headers.get("x-audit-reason") ?? "");
  if (!reason.trim())
    throw new AppError(422, "reason_required", "Give a reason.");
  const before = rec.data.allocation.shares;
  rec.data.allocation.shares = b.shares;
  rec.data.allocation.reviewed = true;
  await recPut(ctx.db, "review", rec);
  // Finance (P6) books the allocation from this event; the agent earnings view reads the review record.
  await publish(ctx.db, "allocation.reviewed", {
    actorId: ctx.session!.id,
    data: { ref: rec.data.ref, shares: b.shares },
  });
  ctx.audit = {
    resourceId: rec.data.ref,
    details: { before, after: b.shares, reason },
  };
  return { ok: true };
}

/** Called by the agent module when an agent submits deliverables. */
export async function openReview(
  db: Exec,
  r: CaseRow,
  author: { id: string; name: string },
) {
  const existing = (
    await recList<Review>(db, "review", { ref: r.app.code })
  )[0];
  const files = r.x.slots
    .filter((s) => s.versions.length)
    .map((s) => ({
      id: `f-${r.app.code}-${s.key}`,
      name: s.versions.at(-1)!.name,
      kind: (/\.(png|jpe?g|heic)$/i.test(s.versions.at(-1)!.name)
        ? "image"
        : "pdf") as "pdf" | "image",
      versions: s.versions.map((v, i) => ({
        v: i + 1,
        pages: [] as string[],
        storageKey: v.storageKey,
      })),
    }));
  const fee = r.app.paymentAmount ?? 0;
  const high = fee >= SECOND_LEVEL_RWF;
  const sm = await db.execute<{ name: string }>(
    sql`select u.name from agent_profiles p join users u on u.user_id = p.manager_id where p.user_id = ${author.id}`,
  );
  const data: Review = {
    ref: r.app.code,
    deliverable: files[0]?.name ?? "Deliverable",
    authorId: author.id,
    authorName: author.name,
    version: (existing?.data.version ?? 0) + 1,
    submittedAt: iso(),
    reviewDueAt: iso(Date.now() + 4 * H),
    secondLevel: high,
    state: "awaiting",
    files,
    comments: existing?.data.comments ?? [],
    requirements: [
      { id: "r1", label: "Matches the brief's scope", met: true },
      { id: "r2", label: "Client name and TIN correct", met: true },
      { id: "r3", label: "All requested documents included", met: true },
    ],
    chain: [
      {
        name: sm[0]?.name ?? "Service manager",
        role: "Service Manager",
        state: "pending",
      },
      ...(high
        ? [
            {
              name: "Senior manager",
              role: "Second level",
              state: "waiting" as const,
            },
          ]
        : []),
    ],
    override: existing?.data.override ?? null,
    // PLACEHOLDER(allocation-rules): deduction rates until Finance confirms them.
    allocation: {
      fee,
      deductions: [
        { label: "Institution fee", amount: Math.round(fee * 0.1) },
        { label: "Mobile money charges", amount: Math.round(fee * 0.015) },
      ],
      agentPct: 60,
      shares: [{ id: author.id, name: author.name, pct: 100 }],
      reviewed: false,
    },
    returned: null,
  };
  return recPut<Review>(db, "review", {
    id: existing?.id,
    ownerId: author.id,
    ref: r.app.code,
    state: "awaiting",
    data,
  });
}

// ── tickets, complaints, disputes ───────────────────────────────────────────────────────────────────────
export type TicketMsg = {
  id: string;
  author: string;
  role: "client" | "staff";
  internal: boolean;
  kind: "text" | "call";
  body: string;
  at: string;
};
export type Ticket = {
  ref: string;
  kind: "complaint" | "dispute" | "enquiry";
  category: string;
  client: string;
  clientId: string | null;
  caseRef: string;
  service: string;
  paid: number;
  priority: "high" | "medium" | "low";
  status: string;
  owner: { id: string; name: string };
  responseDueAt: string;
  responded: boolean;
  escalatedAt: string | null;
  disputeId: string | null;
  conversationId: string | null;
  satisfaction: number | null;
  messages: TicketMsg[];
  files: { name: string; size: string }[];
  activity: { at: string; text: string }[];
  history: { ref: string; category: string; status: string }[];
  refundRequest: { amount: number; reason: string; status: string } | null;
  credits: number;
  resolution: { summary: string; rootCause: string; preventive: string } | null;
};
type TicketTab = "complaints" | "disputes" | "enquiries" | "resolved";
const tabOf = (t: Ticket): TicketTab =>
  t.status === "resolved"
    ? "resolved"
    : t.kind === "dispute"
      ? "disputes"
      : t.kind === "enquiry"
        ? "enquiries"
        : "complaints";
const strip = (t: Ticket) => {
  const {
    messages,
    files,
    activity,
    history,
    refundRequest,
    credits,
    resolution,
    clientId,
    ...rest
  } = t;
  void [
    messages,
    files,
    activity,
    history,
    refundRequest,
    credits,
    resolution,
    clientId,
  ];
  return rest;
};
// PLACEHOLDER(ticket-response-minutes, apology-credit-rwf): until support settings exist.
const RESPONSE_MIN = { high: 120, medium: 240, low: 1440 } as const;
export const APOLOGY_CREDIT_RWF = 5000;

export async function listTickets(db: Exec, tab: TicketTab) {
  const all = await recList<Ticket>(db, "ticket");
  const counts = { complaints: 0, disputes: 0, enquiries: 0, resolved: 0 };
  all.forEach((t) => counts[tabOf(t.data)]++);
  return {
    items: all.filter((t) => tabOf(t.data) === tab).map((t) => strip(t.data)),
    counts,
  };
}

async function ticketByRef(db: Exec, ref: string, lock = false) {
  const t = await recGet<Ticket>(db, "ticket", `tkt:${ref}`, lock);
  if (!t) throw err.notFound("Ticket not found");
  return t;
}
async function withHistory(db: Exec, t: Ticket) {
  const same = t.clientId
    ? await recList<Ticket>(db, "ticket", { ownerId: t.clientId })
    : [];
  return {
    ...t,
    history: same
      .filter((x) => x.data.ref !== t.ref)
      .map((x) => ({
        ref: x.data.ref,
        category: x.data.category,
        status: x.data.status,
      })),
  };
}
export async function ticketDetail(db: Exec, ref: string) {
  return withHistory(db, (await ticketByRef(db, ref)).data);
}

/** Opens a ticket on a case (staff on the client's behalf, or a client dispute from chat). */
export async function openTicket(
  db: Exec,
  s: Session,
  b: {
    kind: Ticket["kind"];
    category: string;
    caseRef: string;
    note: string;
    priority?: Ticket["priority"];
    conversationId?: string | null;
    byClient?: boolean;
  },
) {
  const r = await loadCase(db, b.caseRef.toUpperCase());
  const [cl] = [...(await clientsOf(db, [r.app])).values()];
  const [{ n }] = await db.execute<{ n: number }>(
    sql`select nextval('support_ticket_ref_seq')::int n`,
  );
  const ref = `TKT-${new Date().getUTCFullYear()}-${String(n).padStart(5, "0")}`;
  const owner = r.app.assignedAgentId ?? s.id;
  const names = await namesOf(db, [owner, s.id]);
  const svcs = await servicesBySlug(db, [r.app.serviceSlug]);
  const priority = b.priority ?? "medium";
  const now = iso();
  const t: Ticket = {
    ref,
    kind: b.kind,
    category: b.category,
    client: cl.name,
    clientId: r.app.clientId,
    caseRef: r.app.code,
    service: svcs.get(r.app.serviceSlug)?.name ?? r.app.serviceName,
    paid: r.app.paymentStatus === "paid" ? (r.app.paymentAmount ?? 0) : 0,
    priority,
    status: "open",
    owner: { id: owner, name: names.get(owner) ?? "Staff" },
    responseDueAt: iso(Date.now() + RESPONSE_MIN[priority] * 60_000),
    responded: false,
    escalatedAt: null,
    disputeId: b.kind === "dispute" ? `dsp-${ref}` : null,
    conversationId: b.conversationId ?? null,
    satisfaction: null,
    messages: [
      {
        id: `${ref}-1`,
        author: b.byClient ? cl.name : (names.get(s.id) ?? "Staff"),
        role: b.byClient ? "client" : "staff",
        internal: false,
        kind: "text",
        body: b.note,
        at: now,
      },
    ],
    files: [],
    activity: [
      {
        at: now,
        text: `Opened by ${b.byClient ? cl.name : (names.get(s.id) ?? "Staff")}`,
      },
    ],
    history: [],
    refundRequest: null,
    credits: 0,
    resolution: null,
  };
  await recPut<Ticket>(db, "ticket", {
    id: `tkt:${ref}`,
    ownerId: r.app.clientId,
    ref: r.app.code,
    state: t.status,
    data: t,
  });
  if (b.kind === "dispute") {
    r.x.dispute = { id: t.disputeId!, text: b.note, openedAt: now };
    await saveCase(db, r);
  }
  if (owner !== s.id)
    await notify(db, {
      userId: owner,
      kind: "ticket",
      title: `New ${b.kind} on ${r.app.code}`,
      href: `/ops/tickets/${ref}`,
    });
  return t;
}

export async function ticketAction(
  ctx: Ctx,
  ref: string,
  b: Record<string, unknown> & { action: string },
  stepUpOk: () => Promise<boolean>,
) {
  const rec = await ticketByRef(ctx.db, ref, true);
  const t = rec.data,
    stamp = iso(),
    me = await actorName(ctx.db, ctx.session!);
  const log = (text: string) => t.activity.unshift({ at: stamp, text });
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  switch (b.action) {
    case "message":
      if (!str("body").trim())
        throw new AppError(422, "validation", "Write a message.");
      t.messages.push({
        id: generateId("tm"),
        author: me,
        role: "staff",
        internal: !!b.internal,
        kind: b.kind === "call" ? "call" : "text",
        body: str("body"),
        at: stamp,
      });
      if (!b.internal) {
        t.responded = true;
        if (t.clientId)
          await notify(ctx.db, {
            userId: t.clientId,
            kind: "ticket",
            title: `Reply on ${t.ref}`,
            body: str("body").slice(0, 200),
            href: "/help",
          });
      }
      break;
    case "refund": {
      if (!(await stepUpOk())) throw err.stepUp();
      const amount = Number(b.amount);
      if (!Number.isInteger(amount) || amount <= 0 || amount > t.paid)
        throw new AppError(
          422,
          "validation",
          "Refund exceeds the amount paid.",
        );
      t.refundRequest = { amount, reason: str("reason"), status: "pending" };
      // Finance (P6) owns the refund approval chain; it picks the request up from this event.
      await publish(ctx.db, "refund.requested", {
        actorId: ctx.session!.id,
        data: {
          ticket: t.ref,
          caseRef: t.caseRef,
          amount,
          reason: str("reason"),
        },
      });
      log(`Refund request RWF ${amount.toLocaleString("en")} sent to Finance`);
      break;
    }
    case "credit":
      if (t.credits) throw err.conflict("Credit already given.");
      t.credits = APOLOGY_CREDIT_RWF;
      log(`Apology credit RWF ${APOLOGY_CREDIT_RWF.toLocaleString("en")}`);
      break;
    case "reassign": {
      const id = str("agentId");
      const name = (await namesOf(ctx.db, [id])).get(id);
      if (!name) throw new AppError(422, "invalid_agent", "Unknown agent.");
      t.owner = { id, name };
      await notify(ctx.db, {
        userId: id,
        kind: "ticket",
        title: `Ticket ${t.ref} assigned to you`,
        href: `/ops/tickets/${t.ref}`,
      });
      log(`Reassigned to ${name}`);
      break;
    }
    case "escalate":
      t.status = "escalated";
      t.escalatedAt = stamp;
      log(
        `Escalated to senior management${str("note") ? `: ${str("note")}` : ""}`,
      );
      break;
    case "resolve":
      if (!t.responded) throw err.conflict("Reply to the client first.");
      t.resolution = {
        summary: str("summary"),
        rootCause: str("rootCause"),
        preventive: str("preventive"),
      };
      t.status = b.askConfirm ? "confirming" : "resolved";
      log(b.askConfirm ? "Resolved, awaiting client confirmation" : "Resolved");
      if (t.kind === "dispute" && t.status === "resolved")
        await clearDispute(ctx.db, t.caseRef);
      break;
    case "confirm":
      t.status = b.ok ? "resolved" : "open";
      t.satisfaction = b.ok ? Number(b.score) || null : null;
      log(
        b.ok
          ? `Client confirmed (${b.score}/5)`
          : "Client says not fixed; reopened",
      );
      break;
    case "reopen":
      t.status = "open";
      t.resolution = null;
      log("Reopened");
      break;
    default:
      throw new AppError(422, "validation", "Unknown action");
  }
  await recPut(ctx.db, "ticket", { ...rec, state: t.status, data: t });
  ctx.audit = { resourceId: t.ref, details: { action: b.action } };
  return withHistory(ctx.db, t);
}

async function clearDispute(db: Exec, caseRef: string) {
  const r = await loadCase(db, caseRef, true);
  if (!r.x.dispute) return;
  r.x.dispute = null;
  await saveCase(db, r);
}

export async function resolveDispute(
  ctx: Ctx,
  disputeId: string,
  b: { resolution_kind: string; note?: string },
) {
  const rec = await ticketByRef(ctx.db, disputeId.replace(/^dsp-/, ""), true);
  const t = rec.data,
    now = iso();
  t.status = "resolved";
  t.resolution = {
    summary: b.note ?? b.resolution_kind,
    rootCause: b.resolution_kind,
    preventive: "",
  };
  t.activity.unshift({
    at: now,
    text: `Dispute resolved (${b.resolution_kind})`,
  });
  await recPut(ctx.db, "ticket", { ...rec, state: "resolved", data: t });
  await clearDispute(ctx.db, t.caseRef);
  ctx.audit = { resourceId: disputeId, details: b };
  return {
    dispute_id: disputeId,
    kind: "dispute",
    status: "resolved",
    breached: Date.parse(t.responseDueAt) < Date.now() && !t.responded,
    created_at: t.messages[0]?.at ?? now,
    resolved_at: now,
    resolution_kind: b.resolution_kind,
    resolution_note: b.note ?? null,
  };
}

export const ticketsOpen = async (db: Exec) =>
  (await recList<Ticket>(db, "ticket")).map((t) => t.data);

// ── ASN-09 assignment restrictions ("never assign agent X to client Y") ─────────────────────────────
export async function listBlocks(db: Exec, q: { agentId?: string; clientId?: string }) {
  const rows = await db.select().from(assignmentBlocks)
    .where(and(q.agentId ? eq(assignmentBlocks.agentId, q.agentId) : undefined, q.clientId ? eq(assignmentBlocks.clientId, q.clientId) : undefined))
    .orderBy(desc(assignmentBlocks.createdAt));
  const names = await namesOf(db, [...new Set(rows.flatMap((r) => [r.agentId, r.clientId]))]);
  return { blocks: rows.map((r) => ({ ...r, agentName: names.get(r.agentId) ?? r.agentId, clientName: names.get(r.clientId) ?? r.clientId })) };
}
export async function addBlock(ctx: Ctx, b: { agentId: string; clientId: string; reason: string }) {
  // The SM may type the client's customer ID (HBC-…) or user id.
  const [cl] = await ctx.db.select({ id: users.userId }).from(users)
    .where(and(eq(users.role, "client"), sql`(${users.userId} = ${b.clientId} or ${users.customerNo} = ${b.clientId.trim().toUpperCase()})`));
  if (!cl) throw new AppError(422, "unknown_client", "No client with that customer ID.");
  const id = generateId("blk");
  await ctx.db.insert(assignmentBlocks).values({ id, ...b, clientId: cl.id, createdBy: ctx.session!.id, createdAt: iso() });
  ctx.audit = { resourceId: id, details: b };
  return listBlocks(ctx.db, { agentId: b.agentId });
}
export async function removeBlock(ctx: Ctx, id: string) {
  const [r] = await ctx.db.delete(assignmentBlocks).where(eq(assignmentBlocks.id, id)).returning();
  if (!r) throw err.notFound("Restriction not found.");
  ctx.audit = { resourceId: id, details: { agentId: r.agentId, clientId: r.clientId } };
  return { removed: true };
}
