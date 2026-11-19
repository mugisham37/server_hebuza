// Agent workspace (reference agent.service, contract: web mocks handlers-agent*.ts): duty/summary, my cases + workbench,
// offers, deliverables → review, threads (case chat), templates, clients, earnings, performance, profile/onboarding.
// Scope rule: an agent sees only cases they lead or help on; a case they were moved off is read-only (409
// reassigned) and anything else does not exist (404 not_assigned). Plain functions over the request tx (OpsRunner);
// injected services arrive through `Deps` (status moves → ApplicationsService.transition, chat, storage).
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  applicationAssignmentHistory,
  applicationDocuments,
  applicationMessages,
  applications,
  chatTemplates,
  clientObligations,
  conversationParticipants,
  paymentSplits,
  users,
  applicationFeedback,
  agentProfiles,
  notifications as notificationsT,
} from "@/db/schema";
import { CASE_STATUS_META, normalizeStatus, type CaseStatus } from "@/domain/domain/case-status";
import { AppError, err, generateId, notify, publish, type Ctx, type Exec, type Session } from "../ops/lib/ctx";
import { project } from "../notifications/notifications.service";
import {
  CLOSED,
  H,
  agentsAll,
  clientKey,
  clientsOf,
  eventsOf,
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
  type OpsX,
  type Rec,
} from "../ops/lib/store";
import { offerNow, type OfferData } from "../ops/ops.cases";
import { openApproval, openReview, type Leave, type Review, type Ticket } from "../ops/ops.manage";
import type { ApplicationsService } from "../applications/applications.service";
import { textPdf, type ChatService } from "../chat/chat.service";
import { all as finAll } from "../finance/finance.store";
import type { Alloc, Batch } from "../finance/finance.revenue";
import type { StorageService } from "../../core/storage/storage.service";
import * as work from "./agent.lib";
import { agentMoves, CONFLICTS, DECLINE_REASONS, groupOf, shareOf } from "./agent.lib";

/** `scan`: delayed storage.scan of a presigned upload (infected → quarantined), the documents scan path. */
export type Deps = { apps: ApplicationsService; chat: ChatService; storage: StorageService; scan: (db: Exec, key: string) => Promise<unknown> };

// ── me, gate, scope ─────────────────────────────────────────────────────────────────────────────────────
export async function me(db: Exec, s: Session): Promise<AgentRow> {
  let [a] = await agentsAll(db, [s.id]);
  if (!a) {
    await db
      .insert(agentProfiles)
      .values({ userId: s.id, external: s.roles.includes("ext:agent") })
      .onConflictDoNothing();
    [a] = await agentsAll(db, [s.id]);
  }
  if (!a) throw err.forbidden("No agent profile.");
  if (a.awayUntil && Date.parse(a.awayUntil) < Date.now()) {
    await db
      .update(agentProfiles)
      .set({ duty: "on", awayUntil: null })
      .where(eq(agentProfiles.userId, s.id));
    a.duty = "on";
    a.awayUntil = null;
  }
  return a;
}
const ws = <T>(a: AgentRow, k: string, d: T): T => (a.ws[k] as T) ?? d;
async function setWs(db: Exec, id: string, patch: Record<string, unknown>) {
  await db
    .update(agentProfiles)
    .set({
      ws: sql`${agentProfiles.ws} || ${JSON.stringify(patch)}::jsonb`,
      version: sql`${agentProfiles.version} + 1`,
      updatedAt: iso(),
    })
    .where(eq(agentProfiles.userId, id));
}

/** P0-AGT-2: not-cleared agents can't accept or upload (403); away agents get 409. */
export function gate(a: AgentRow) {
  if (a.clearance !== "cleared")
    throw new AppError(403, "not_cleared", "Your account isn't cleared yet");
  if (a.duty === "away") throw new AppError(409, "away", "You're set as away");
}

const isMine = (r: CaseRow, id: string) =>
  r.app.assignedAgentId === id || r.x.helpers.includes(id);
async function wasMine(db: Exec, appId: string, id: string) {
  const [h] = await db
    .select({ id: applicationAssignmentHistory.id })
    .from(applicationAssignmentHistory)
    .where(
      and(
        eq(applicationAssignmentHistory.applicationId, appId),
        eq(applicationAssignmentHistory.previousAgentId, id),
      ),
    )
    .limit(1);
  return !!h;
}
const isExt = (s: Session) => s.roles.includes("ext:agent" as Session["roles"][number]);
const maskPhone = (p: string) => `${p.slice(0, 6)}•• ••• ${p.slice(-3)}`;
const EXT_FIELD: Record<string, string> = { full_name: "name" };

/** handlers-work-d.ts overlay: strip unshared docs/fields, mask the phone without the client lane, drop internal staff events. */
async function scopeForExt(db: Exec, s: Session, d: Awaited<ReturnType<typeof detail>>) {
  const x = (await work.scoped(db, s.id, d.code))!;
  const sc = x.s;
  const all = d.documents.filter((v) => v.is_active);
  const shown = all.filter((v) => work.docShared(sc, v.requirement_key));
  const phone = d.personal_info.phone;
  return {
    ...d,
    personal_info: { full_name: d.personal_info.full_name, phone: phone && !sc.clientLane ? maskPhone(phone) : phone, email: null },
    documents: shown,
    x_agent: {
      ...d.x_agent,
      readOnly: sc.handback ? "reassigned" : d.x_agent.readOnly,
      answers: d.x_agent.answers.map((a) => {
        const shared = sc.sharedFields.includes(EXT_FIELD[a.key] ?? a.key) && !(a.key === "phone" && !sc.clientLane);
        if (a.key === "phone" && !shared) return { ...a, value: "", masked: phone ? maskPhone(phone) : null, shared: false };
        return shared ? a : { ...a, value: "", masked: null, shared: false };
      }),
      notShared: [...d.x_agent.notShared, ...all.filter((v) => !shown.includes(v)).map((v) => v.requirement_key)],
      events: d.x_agent.events.filter((e) => !e.internal),
    },
  };
}

export async function myCase(
  db: Exec,
  s: Session,
  code: string,
  write = false,
) {
  const r = await loadCase(db, code, write).catch(() => null);
  if (!r)
    throw new AppError(404, "not_assigned", "This case isn't assigned to you.");
  if (isExt(s)) {
    // Externals see a job only while their scope is active (plan §9.2); ended access answers 404 everywhere.
    const x = await work.scoped(db, s.id, r.app.code);
    if (!x?.s.active)
      throw new AppError(404, "not_assigned", "This case isn't assigned to you.");
    if (x.s.handback && write)
      throw new AppError(409, "reassigned", "You handed this job back. It's read-only now.");
    return { r, readOnly: !!x.s.handback };
  }
  if (isMine(r, s.id)) return { r, readOnly: false };
  if (await wasMine(db, r.app.applicationId, s.id)) {
    if (write)
      throw new AppError(
        409,
        "reassigned",
        "This case was reassigned. It's read-only now.",
      );
    return { r, readOnly: true };
  }
  throw new AppError(404, "not_assigned", "This case isn't assigned to you.");
}

async function myRows(db: Exec, s: Session) {
  const apps = await db
    .select()
    .from(applications)
    .where(
      sql`(${applications.assignedAgentId} = ${s.id} or exists (select 1 from ops_case_meta m where m.application_id = ${applications.applicationId} and m.data->'helpers' ? ${s.id}))`,
    )
    .orderBy(desc(applications.updatedAt))
    .limit(500);
  return loadCases(db, apps);
}
const dueOf = (r: CaseRow) =>
  r.app.dueAt ??
  r.app.slaDeadline ??
  iso(Date.parse(r.app.submittedAt) + 3 * 24 * H);
const open = (r: CaseRow) => !CLOSED.includes(r.app.status as CaseStatus);

/** Unread client-lane messages per case for this agent (participant read cursor). */
async function unreadBy(db: Exec, s: Session, rows: CaseRow[]) {
  if (!rows.length) return new Map<string, number>();
  const res = await db.execute<{ id: string; n: number }>(sql`
    select c.application_id id, count(m.*)::int n from conversations c
    join application_messages m on m.conversation_id = c.conversation_id and m.sender_id is distinct from ${s.id} and m.is_system = false
    left join conversation_participants p on p.conversation_id = c.conversation_id and p.user_id = ${s.id}
    where c.application_id in ${rows.map((r) => r.app.applicationId)} and m.seq > coalesce(p.last_read_seq, 0)
    group by 1`);
  return new Map(res.map((x) => [x.id, Number(x.n)]));
}

export function agentCase(
  r: CaseRow,
  b: {
    names: Map<string, string>;
    svcs: Map<string, { name: string }>;
    clients: Awaited<ReturnType<typeof clientsOf>>;
  },
  unread: number,
) {
  const due = dueOf(r),
    left = Date.parse(due) - Date.now();
  const cl = b.clients.get(clientKey(r.app))!;
  return {
    code: r.app.code,
    service_name: b.svcs.get(r.app.serviceSlug)?.name ?? r.app.serviceName,
    client_name: cl.name,
    status: r.app.status,
    tier: r.app.tier,
    submitted_at: r.app.submittedAt,
    sla_state: left < 0 ? "breached" : left < 24 * H ? "at_risk" : "ok",
    sla_deadline: due,
    unread_messages: unread,
    subscriptionStatus: cl.flags.includes("subscriber") ? "active" : "none",
    retainer: false,
    due_at: due,
    due_source: r.app.dueSource,
    deadline_state: left < 0 ? "overdue" : "ok",
    is_urgent: r.app.isUrgent || r.x.flags.includes("urgent"),
    client_preferred_date: r.app.clientPreferredDate,
    x_agent: {
      serviceSlug: r.app.serviceSlug,
      clientId: cl.id,
      docsToCheck: Object.values(r.x.docQc).filter(
        (d) => d.status === "pending",
      ).length,
      checklist: {
        done: r.x.steps.filter((i) => i.done).length,
        total: r.x.steps.length,
      },
      institution: r.x.institution,
      submissionRef: r.x.submissionRef,
      dispute: !!r.x.dispute,
    },
  };
}

async function caseBundle(db: Exec, rows: CaseRow[]) {
  const clients = await clientsOf(
    db,
    rows.map((r) => r.app),
  );
  const [names, svcs] = await Promise.all([
    namesOf(
      db,
      rows.map((r) => r.app.assignedAgentId),
    ),
    servicesBySlug(
      db,
      rows.map((r) => r.app.serviceSlug),
    ),
  ]);
  return { clients, names, svcs };
}

export async function cases(db: Exec, s: Session) {
  const rows = await myRows(db, s);
  const [b, unread] = await Promise.all([
    caseBundle(db, rows),
    unreadBy(db, s, rows),
  ]);
  return {
    cases: rows.map((r) =>
      agentCase(r, b, unread.get(r.app.applicationId) ?? 0),
    ),
  };
}

// ── summary, duty, notifications ────────────────────────────────────────────────────────────────────────
const leaveNow = (l: Leave | null) =>
  !!l &&
  l.status === "approved" &&
  Date.parse(l.from) <= Date.now() &&
  Date.now() <= Date.parse(l.to) + 86_400_000;
async function currentLeave(db: Exec, id: string) {
  const all = await recList<Leave>(db, "leave", { ownerId: id });
  return (
    all
      .map((l) => l.data)
      .find(
        (l) =>
          l.status !== "declined" &&
          l.status !== "cancelled" &&
          l.to >= iso().slice(0, 10),
      ) ?? null
  );
}

export async function summary(db: Exec, s: Session) {
  const a = await me(db, s);
  const rows = (await myRows(db, s)).filter(open);
  const now = Date.now();
  const [offers, unread, leave, mgr] = await Promise.all([
    recList<OfferData>(db, "offer", { ownerId: s.id }),
    unreadBy(db, s, rows),
    currentLeave(db, s.id),
    namesOf(db, [a.managerId]),
  ]);
  return {
    offers: offers.filter((o) =>
      ["sent", "viewed"].includes(offerNow(o.data).state),
    ).length,
    cases: rows.length,
    overdue: rows.filter(
      (r) =>
        groupOf(
          { status: r.app.status as CaseStatus, dueAt: dueOf(r) },
          now,
        ) === "overdue",
    ).length,
    dueToday: rows.filter(
      (r) =>
        groupOf(
          { status: r.app.status as CaseStatus, dueAt: dueOf(r) },
          now,
        ) === "today",
    ).length,
    unread: [...unread.values()].reduce((x, y) => x + y, 0),
    outbox: 0,
    duty: a.duty,
    awayUntil: a.awayUntil,
    leave,
    onLeaveNow: leaveNow(leave),
    clearance: a.clearance,
    ...(isExt(s) ? { external: await work.externalBlock(db, s.id) } : {}),
    me: {
      id: a.id,
      name: a.name,
      title: a.role,
      sharePct: a.shareBps / 10_000,
      manager: a.managerId ? (mgr.get(a.managerId) ?? null) : null,
    },
  };
}

export async function setDuty(
  ctx: Ctx,
  b: { state: "on" | "away"; until?: string | null },
) {
  if (leaveNow(await currentLeave(ctx.db, ctx.session!.id)))
    throw new AppError(409, "on_leave", "You're on approved leave.");
  await ctx.db
    .update(agentProfiles)
    .set({
      duty: b.state,
      awayUntil: b.state === "away" ? (b.until ?? null) : null,
      updatedAt: iso(),
    })
    .where(eq(agentProfiles.userId, ctx.session!.id));
  return summary(ctx.db, ctx.session!);
}

// Generic notification kinds → the agent drawer's 7 categories (the web has an icon per category only).
const NOTE_KIND: Record<string, string> = {
  offer: "offer", review: "review", dispute: "review", due: "deadline", deadline: "deadline", status: "deadline", case: "deadline", assignment: "deadline", flag: "deadline",
  payment: "money", paid: "money", payout: "money", money: "money", earning: "money", contract: "contract", booking: "booking", visit: "booking",
};
const noteKind = (k: string) => NOTE_KIND[k] ?? "client"; // documents, messages, uploads, anything new

export async function notifications(db: Exec, s: Session) {
  const rows = await db.select().from(notificationsT).where(eq(notificationsT.userId, s.id)).orderBy(desc(notificationsT.createdAt)).limit(40);
  const r = { notifications: rows.map(project) };
  // Externals also see derived contract/licence reminders (handlers-work-c); counter decisions arrive via notify().
  const ext = isExt(s) ? await work.externalBlock(db, s.id) : null;
  const derived = !ext
    ? []
    : [
        ...(ext.contractState === "expiring" || ext.contractState === "expired"
          ? [{ id: "n-x-con", kind: "contract", text: ext.contractState === "expired" ? "Contract expired — renew to receive offers" : "Contract expires soon — renew", href: "/work/contract?tab=renewal", at: iso(), read: false }]
          : []),
        ...(ext.licence?.status === "due" || ext.licence?.status === "overdue"
          ? [{ id: "n-x-fee", kind: "money", text: "Licence fee due", href: "/work/contract?tab=licence", at: iso(), read: false }]
          : []),
      ];
  return {
    items: [...derived, ...r.notifications.map((n) => ({
      id: n.id,
      kind: noteKind(n.kind),
      text: n.title,
      href: n.href,
      at: n.created_at,
      read: !!n.read_at,
    }))],
  };
}

// ── workbench (case detail) ─────────────────────────────────────────────────────────────────────────────
const NOT_SHARED = ["bank", "payment"];
function factsOf(r: CaseRow) {
  return {
    status: r.app.status as CaseStatus,
    previous: r.x.previous,
    missingItems:
      r.x.checklist.filter((i) => i.state === "missing").length +
      Object.values(r.x.docQc).filter((d) => d.status === "rejected").length,
    deliverablesUploaded: r.x.slots.filter((x) => x.versions.length).length,
  };
}

async function docsOf(db: Exec, r: CaseRow, clientName: string) {
  const rows = await db
    .select()
    .from(applicationDocuments)
    .where(eq(applicationDocuments.applicationId, r.app.applicationId))
    .orderBy(asc(applicationDocuments.createdAt));
  return rows
    .filter((d) => !NOT_SHARED.includes(d.requirementKey))
    .map((d) => {
      const qc = r.x.docQc[d.documentId];
      return {
        document_id: d.documentId,
        application_id: r.app.code,
        requirement_key: d.requirementKey,
        original_filename: d.originalFilename,
        mime_type: d.mimeType,
        file_size_bytes: d.fileSizeBytes,
        uploaded_by: clientName,
        uploaded_by_role: d.uploadedByRole ?? "client",
        version: d.version,
        qc_status:
          qc?.status ??
          (d.qcStatus as "pending" | "accepted" | "rejected") ??
          "pending",
        qc_notes: qc ? { reason: qc.reason, note: qc.note } : null,
        is_active: d.isActive,
        created_at: d.createdAt,
        source: "upload" as const,
        x_agent: {
          label:
            r.x.checklist.find((i) => i.key === d.requirementKey)?.label ??
            d.requirementKey,
          pages: 1,
          legibility: 95,
          expiry: null,
          nameOnDoc: clientName,
        },
      };
    });
}

async function detail(db: Exec, s: Session, r: CaseRow, readOnly: boolean) {
  const a = await me(db, s);
  const b = await caseBundle(db, [r]);
  const cl = b.clients.get(clientKey(r.app))!;
  const unread = (await unreadBy(db, s, [r])).get(r.app.applicationId) ?? 0;
  const base = agentCase(r, b, unread);
  const eligible = r.app.paymentAmount ?? 0;
  const [docs, ev, hist, mgr] = await Promise.all([
    docsOf(db, r, cl.name),
    eventsOf(db, r.app.applicationId, "agent"),
    eventsOf(db, r.app.applicationId, "ops", 50),
    namesOf(db, [a.managerId]),
  ]);
  const reveal = (
    k: string,
    v: string,
    mask: (v: string) => string | null,
  ) => ({
    key: k,
    label: k === "full_name" ? "fullName" : k,
    value: r.x.revealed.includes(k) || !mask(v) ? v : "",
    masked: v ? mask(v) : null,
    shared: !!v,
  });
  const info = r.app.personalInfo as Record<string, string>;
  return {
    application_id: r.app.applicationId,
    code: r.app.code,
    service_name: base.service_name,
    service_slug: r.app.serviceSlug,
    tier: r.app.tier,
    status: r.app.status,
    personal_info: { full_name: cl.name, phone: cl.phone, email: cl.email },
    service_data: {},
    payment_status: r.app.paymentStatus,
    payment_amount: r.app.paymentAmount,
    handler: r.app.handler,
    ending: r.app.ending,
    status_display: r.app.status,
    sla_deadline: dueOf(r),
    submitted_at: r.app.submittedAt,
    assigned_agent_id: r.app.assignedAgentId,
    assignee_name: readOnly ? null : a.name,
    status_history: hist
      .filter((e) => e.kind === "status")
      .map((e) => ({
        status: e.toValue ?? "",
        changed_by: e.actorName,
        note: e.text,
        created_at: e.at,
      })),
    documents: docs,
    messages: [],
    has_account: !!r.app.clientId,
    partner_client_lane_open: r.app.partnerClientLaneOpen,
    client_id: cl.id,
    retainer: false,
    open_flag: null,
    deadline_mode: r.app.dueSource,
    x_agent: {
      ...base.x_agent,
      readOnly: readOnly ? "reassigned" : null,
      previous: r.x.previous,
      dueAt: dueOf(r),
      slaPaused: [
        "awaiting_client_documents",
        "awaiting_external_institution",
        "on_hold",
      ].includes(r.app.status),
      expectedDecision: r.x.expectedDecision,
      outcome:
        r.x.outcome ??
        (r.app.status === "awaiting_external_institution"
          ? { state: "pending", note: "", at: r.app.updatedAt, evidence: null }
          : null),
      instructions: r.x.instructions,
      manager: a.managerId ? (mgr.get(a.managerId) ?? null) : null,
      instructionsAt: r.app.createdAt,
      checklist: r.x.steps,
      slots: r.x.slots.map((x) => ({
        key: x.key,
        label: x.label,
        required: x.required,
        uploaded: x.versions.length > 0,
      })),
      review: r.x.review?.state ?? null,
      dispute: r.x.dispute,
      timesheet: r.x.timesheet,
      moves: agentMoves(factsOf(r)),
      answers: [
        reveal("full_name", cl.name, () => null),
        reveal("phone", cl.phone, (v) => `•••• ${v.slice(-4)}`),
        reveal(
          "tin",
          String(info.tin ?? info.TIN ?? ""),
          (v) => `••• ••• ${v.slice(-3)}`,
        ),
        reveal("email", cl.email, (v) => `••••@${v.split("@")[1] ?? ""}`),
        {
          key: "address",
          label: "address",
          value: "",
          masked: null,
          shared: false,
        },
        {
          key: "bank",
          label: "bankAccount",
          value: "",
          masked: null,
          shared: false,
        },
      ],
      notShared: r.x.checklist
        .filter((i) => NOT_SHARED.includes(i.key))
        .map((i) => i.label),
      share: {
        eligible,
        pct: a.shareBps / 10_000,
        amount: shareOf(eligible, a.shareBps),
        state: r.app.status === "completed_delivered" ? "approved" : "pending",
      },
      events: ev.map((e) => ({
        id: e.id,
        kind: e.kind,
        text: e.text ?? "",
        actor: e.actorName,
        at: e.at,
        internal: e.internal,
      })),
    },
  };
}

export async function caseDetail(db: Exec, s: Session, code: string) {
  const { r, readOnly } = await myCase(db, s, code);
  const d = await detail(db, s, r, readOnly);
  return isExt(s) ? scopeForExt(db, s, d) : d;
}

async function wlog(
  db: Exec,
  s: Session,
  r: CaseRow,
  kind: string,
  text: string,
  internal = true,
) {
  await logEvent(db, r.app.applicationId, {
    kind,
    feed: "agent",
    actorId: s.id,
    actorName: (await namesOf(db, [s.id])).get(s.id) ?? "Agent",
    text,
    internal,
  });
}

/** Status writer for agent moves: the shared machine via ApplicationsService.transition (history, client notice, audit). */
async function move(
  deps: Deps,
  db: Exec,
  s: Session,
  r: CaseRow,
  to: CaseStatus,
  why: string,
) {
  const from = r.app.status as CaseStatus;
  const { status: _s, ...facts } = factsOf(r);
  await deps.apps.transition(db, s, r.app, to, "assignee", facts, why || null);
  r.app.status = to;
  if (to === "awaiting_client_documents" || to === "on_hold")
    r.x.previous = from;
  await saveCase(db, r);
  await wlog(db, s, r, "status", `Status → ${to}${why ? ` · ${why}` : ""}`);
  await logEvent(db, r.app.applicationId, {
    kind: "status",
    actorId: s.id,
    actorName: (await namesOf(db, [s.id])).get(s.id) ?? "Agent",
    from,
    to,
    text: why || null,
  });
  await publish(db, "case.status_changed", {
    actorId: s.id,
    data: { code: r.app.code, from, to },
  });
}

export async function changeStatus(
  deps: Deps,
  ctx: Ctx,
  code: string,
  b: {
    status: CaseStatus;
    note?: string;
    x_agent?: {
      institution?: string;
      submissionRef?: string;
      submittedOn?: string;
      expectedDecision?: string;
      evidence?: string | null;
    };
  },
) {
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  const m = agentMoves(factsOf(r)).find((x) => x.to === b.status);
  if (!m) throw new AppError(403, "not_allowed", "You can't make this move.");
  if (m.blocked) throw new AppError(409, m.blocked, `Blocked: ${m.blocked}`);
  if (b.status === "on_hold" && !b.note?.trim())
    throw new AppError(422, "reason_required", "Give a reason.");
  if (b.status === "awaiting_external_institution") {
    const i = b.x_agent ?? {};
    if (!i.institution || !i.submissionRef || !i.submittedOn)
      throw new AppError(
        422,
        "institution_required",
        "Institution, submission ref and date are required.",
      );
    r.x.institution = i.institution;
    r.x.submissionRef = i.submissionRef;
    r.x.expectedDecision = i.expectedDecision ?? null;
    r.x.outcome = {
      state: "pending",
      note: "",
      at: iso(),
      evidence: i.evidence ?? null,
    };
  }
  await move(deps, ctx.db, ctx.session!, r, b.status, b.note ?? "");
  ctx.audit = { resourceId: r.app.code, details: { to: b.status } };
  return detail(ctx.db, ctx.session!, r, false);
}

export async function flag(
  ctx: Ctx,
  code: string,
  b: { kind: "attention" | "reassign"; note: string },
) {
  if (!b.note?.trim())
    throw new AppError(422, "note_required", "Pick a reason.");
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  const a = await me(ctx.db, ctx.session!);
  const mgr =
    (await namesOf(ctx.db, [a.managerId])).get(a.managerId ?? "") ??
    "your manager";
  await wlog(
    ctx.db,
    ctx.session!,
    r,
    "note",
    `Flagged to ${mgr} (${b.kind}): ${b.note}`,
  );
  if (a.managerId)
    await notify(ctx.db, {
      userId: a.managerId,
      kind: "flag",
      title: `${a.name} flagged ${r.app.code} (${b.kind})`,
      body: b.note,
      href: `/ops/cases/${r.app.code}`,
    });
  return { code: r.app.code, escalated: true, kind: b.kind };
}

export async function proposeDue(
  ctx: Ctx,
  code: string,
  b: { due_date: string; note: string },
) {
  if (!b.due_date || Date.parse(b.due_date) < Date.now() - 86_400_000)
    throw new AppError(422, "bad_date", "Pick a future date.");
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  const proposed = iso(Date.parse(`${b.due_date.slice(0, 10)}T15:00:00Z`));
  await openApproval(ctx.db, {
    kind: "due",
    agentId: ctx.session!.id,
    reason: b.note,
    ref: r.app.code,
    service: r.app.serviceName,
    currentDue: dueOf(r),
    proposedDue: proposed,
  });
  await wlog(
    ctx.db,
    ctx.session!,
    r,
    "note",
    `Proposed new due date ${b.due_date}${b.note ? ` · ${b.note}` : ""} — waiting for approval`,
  );
  return { id: generateId("msg"), body: b.note, created_at: iso() };
}

export async function documents(db: Exec, s: Session, code: string) {
  const { r } = await myCase(db, s, code);
  const cl = (await clientsOf(db, [r.app])).get(clientKey(r.app))!;
  const sc = isExt(s) ? (await work.scoped(db, s.id, r.app.code))!.s : null;
  return {
    documents: (await docsOf(db, r, cl.name)).filter(
      (d) => d.is_active && (!sc || work.docShared(sc, d.requirement_key)),
    ),
  };
}

export async function docQc(
  deps: Deps,
  ctx: Ctx,
  code: string,
  docId: string,
  b: {
    qc_status: "pending" | "accepted" | "rejected";
    qc_notes?: { reason?: string; note?: string; move?: boolean } | null;
  },
) {
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  const cl = (await clientsOf(ctx.db, [r.app])).get(clientKey(r.app))!;
  const d = (await docsOf(ctx.db, r, cl.name)).find(
    (x) => x.document_id === docId && x.is_active,
  );
  if (!d) throw err.notFound("Document not found.");
  if (isExt(ctx.session!) && !work.docShared((await work.scoped(ctx.db, ctx.session!.id, r.app.code))!.s, d.requirement_key))
    throw err.notFound("Document not found.");
  if (b.qc_status === "rejected" && !b.qc_notes?.reason)
    throw new AppError(422, "reason_required", "A reason is required.");
  r.x.docQc[docId] = {
    status: b.qc_status,
    reason: b.qc_notes?.reason,
    note: b.qc_notes?.note,
  };
  const item = r.x.checklist.find((i) => i.key === d.requirement_key);
  if (item)
    item.state =
      b.qc_status === "accepted"
        ? "provided"
        : b.qc_status === "rejected"
          ? "rejected"
          : "check";
  await ctx.db
    .update(applicationDocuments)
    .set({ qcStatus: b.qc_status })
    .where(eq(applicationDocuments.documentId, docId));
  await saveCase(ctx.db, r);
  await wlog(
    ctx.db,
    ctx.session!,
    r,
    "document",
    b.qc_status === "rejected"
      ? `Re-upload requested: ${d.x_agent.label} (${b.qc_notes?.reason ?? ""})`
      : `${d.x_agent.label} ${b.qc_status}`,
  );
  if (
    b.qc_status === "rejected" &&
    b.qc_notes?.move &&
    agentMoves(factsOf(r)).some(
      (m) => m.to === "awaiting_client_documents" && !m.blocked,
    )
  )
    await move(
      deps,
      ctx.db,
      ctx.session!,
      r,
      "awaiting_client_documents",
      "SLA paused",
    );
  if (b.qc_status === "rejected" && r.app.clientId)
    await notify(ctx.db, {
      userId: r.app.clientId,
      kind: "document_request",
      title: `Please re-upload ${d.x_agent.label}`,
      body: b.qc_notes?.reason,
      href: `/requests/${r.app.code}`,
    });
  return { ...d, qc_status: b.qc_status, qc_notes: b.qc_notes ?? null };
}

export async function tickStep(
  ctx: Ctx,
  code: string,
  item: string,
  done: boolean,
) {
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  const step = r.x.steps.find((x) => x.id === item);
  if (!step) throw err.notFound("Step not found.");
  step.done = done;
  step.doneAt = done ? iso() : undefined;
  await saveCase(ctx.db, r);
  await wlog(
    ctx.db,
    ctx.session!,
    r,
    "system",
    `${done ? "Ticked" : "Unticked"}: ${step.label}`,
  );
  return step;
}

export async function revealField(ctx: Ctx, code: string, field: string) {
  const { r } = await myCase(ctx.db, ctx.session!, code);
  await wlog(ctx.db, ctx.session!, r, "system", `Revealed ${field} (audit)`);
  ctx.audit = { resourceId: r.app.code, details: { field } };
  return { logged: true };
}

export async function outcome(
  ctx: Ctx,
  code: string,
  b: {
    state: NonNullable<OpsX["outcome"]>["state"];
    note?: string;
    evidence?: string | null;
    ref?: string;
    institution?: string;
  },
) {
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  if (r.app.status !== "awaiting_external_institution")
    throw new AppError(
      409,
      "not_at_institution",
      "Record an outcome once the case is at the institution.",
    );
  if (b.state !== "pending" && b.state !== "approved" && !b.note?.trim())
    throw new AppError(422, "note_required", "Add a note.");
  r.x.outcome = {
    state: b.state,
    note: b.note ?? "",
    at: iso(),
    evidence: b.evidence ?? null,
  };
  // REQ-06: the client reads these columns (applications.clientDetail).
  await saveCase(ctx.db, r, {
    externalOutcome: b.state === "more_info" ? "more_info_requested" : b.state,
    externalOutcomeRef: b.ref ?? null,
    externalOutcomeInstitution: b.institution ?? null,
    externalOutcomeAt: r.x.outcome.at,
  });
  await wlog(
    ctx.db,
    ctx.session!,
    r,
    "status",
    `External outcome: ${b.state}${b.note ? ` · ${b.note}` : ""}`,
  );
  return r.x.outcome;
}

export async function fieldVisit(
  ctx: Ctx,
  code: string,
  b: { location: string; purpose: string; date: string },
) {
  if (!b.location?.trim() || !b.purpose?.trim() || !b.date)
    throw new AppError(
      422,
      "fields_required",
      "Location, purpose and date are required.",
    );
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  // The field module (P8) schedules the visit from this request.
  const rec = await recPut(ctx.db, "field_request", {
    ownerId: ctx.session!.id,
    ref: r.app.code,
    state: "requested",
    data: b,
  });
  await publish(ctx.db, "field.visit_requested", {
    actorId: ctx.session!.id,
    data: { id: rec.id, code: r.app.code, ...b },
  });
  await wlog(
    ctx.db,
    ctx.session!,
    r,
    "note",
    `Field visit requested: ${b.location} on ${b.date} · ${b.purpose}`,
  );
  return { id: rec.id, status: "requested" };
}

export async function timesheet(
  ctx: Ctx,
  code: string,
  b: { date: string; minutes: number; activity: string; note?: string },
) {
  if (!(b.minutes > 0 && b.minutes % 15 === 0 && b.minutes <= 24 * 60))
    throw new AppError(422, "bad_minutes", "Use 15-minute steps.");
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  const e = {
    id: generateId("t"),
    date: b.date,
    minutes: b.minutes,
    activity: b.activity,
    note: b.note,
  };
  r.x.timesheet.unshift(e);
  await saveCase(ctx.db, r);
  await wlog(
    ctx.db,
    ctx.session!,
    r,
    "time",
    `Logged ${b.minutes} min · ${b.activity}`,
  );
  return e;
}

export async function disputeResponse(ctx: Ctx, code: string, text: string) {
  if (!text.trim())
    throw new AppError(422, "text_required", "Write a response.");
  const { r } = await myCase(ctx.db, ctx.session!, code, true);
  if (r.x.dispute) r.x.dispute.response = text.trim();
  await saveCase(ctx.db, r);
  await wlog(
    ctx.db,
    ctx.session!,
    r,
    "note",
    `Internal response to dispute: ${text}`,
  );
  const t = (await recList<Ticket>(ctx.db, "ticket", { ref: r.app.code })).find(
    (x) => x.data.kind === "dispute" && x.data.status !== "resolved",
  );
  if (t) {
    t.data.messages.push({
      id: generateId("tm"),
      author: (await me(ctx.db, ctx.session!)).name,
      role: "staff",
      internal: true,
      kind: "text",
      body: text.trim(),
      at: iso(),
    });
    await recPut(ctx.db, "ticket", t);
  }
  return { ok: true };
}

// ── offers ─────────────────────────────────────────────────────────────────────────────────────────────
// Delivered or terminal: nothing left to take on (completed_delivered is non-terminal only for refunds).
const caseClosed = (st: string) => { const n = normalizeStatus(st); return n === "completed_delivered" || CASE_STATUS_META[n].terminal; };
const STATUS_OF: Record<OfferData["state"], string> = {
  sent: "pending",
  viewed: "pending",
  accepted: "accepted",
  declined: "declined",
  timeout: "expired",
  withdrawn: "returned",
};
async function offerVM(db: Exec, a: AgentRow, recs: Rec<OfferData>[]) {
  const apps = recs.length
    ? await db
        .select()
        .from(applications)
        .where(
          inArray(
            applications.code,
            recs.map((r) => r.ref!),
          ),
        )
    : [];
  const byCode = new Map(apps.map((x) => [x.code, x]));
  const [clients, svcs] = await Promise.all([
    clientsOf(db, apps),
    servicesBySlug(
      db,
      apps.map((x) => x.serviceSlug),
    ),
  ]);
  // PLACEHOLDER(show-fee): policy.show_fee (D2) — agents see their share, not the client fee.
  const SHOW_FEE = false;
  return recs
    .filter((o) => byCode.has(o.ref!))
    .map((rec) => {
      const o = offerNow(rec.data),
        app = byCode.get(rec.ref!)!;
      // An offer on a case that already finished can't be taken any more (accepting would try to reopen it).
      const closed = caseClosed(app.status);
      const status =
        o.counter?.status === "pending" ? "pending" : closed && STATUS_OF[o.state] === "pending" ? "returned" : STATUS_OF[o.state];
      return {
        id: rec.id,
        ref: app.code,
        service: svcs.get(app.serviceSlug)?.name ?? app.serviceName,
        clientId: clientKey(app),
        client: clients.get(clientKey(app))?.name ?? "",
        summary: o.summary,
        sentAt: o.sentAt,
        expiresAt: o.expiresAt,
        dueAt: o.dueAt,
        effortH: o.effortH,
        eligible: o.eligible,
        shared: o.shared,
        skills: o.skills,
        status,
        decidedAt: o.endedAt,
        reason: o.declineReason,
        note: o.note,
        counter: o.counter,
        share: shareOf(o.eligible, a.shareBps),
        pct: a.shareBps / 10_000,
        fee: SHOW_FEE ? o.eligible : null,
        started: app.status === "in_progress",
      };
    });
}

export async function offers(
  db: Exec,
  s: Session,
  q: { view?: string; status?: string },
) {
  const a = await me(db, s);
  const recs = await recList<OfferData>(db, "offer", { ownerId: s.id });
  const vm = await offerVM(db, a, recs);
  if (q.view === "strip") {
    const now = Date.now();
    return {
      offers: vm
        .filter((o) => o.status === "pending" && Date.parse(o.expiresAt) > now)
        .sort((x, y) => Date.parse(x.expiresAt) - Date.parse(y.expiresAt))
        .map((o) => ({
          id: o.id,
          ref: o.ref,
          service: o.service,
          client: o.client,
          expiresAt: o.expiresAt,
          dueAt: o.dueAt,
          eligible: o.eligible,
          share: o.share,
        })),
    };
  }
  return { offers: vm.filter((o) => !q.status || o.status === q.status) };
}

async function offerFor(db: Exec, s: Session, id: string) {
  const o = await recGet<OfferData>(db, "offer", id, true);
  if (!o || o.ownerId !== s.id) throw err.notFound("Offer not found");
  return o;
}
function assertPending(o: Rec<OfferData>, mgr: string) {
  const st = offerNow(o.data).state;
  if (st === "timeout")
    throw new AppError(410, "expired", "This offer expired");
  if (st !== "sent" && st !== "viewed")
    throw new AppError(409, "taken", `${mgr} reassigned this offer`);
}

export async function acceptOffer(
  deps: Deps,
  ctx: Ctx,
  id: string,
  b: { conflict?: string; note?: string; start_now?: boolean },
) {
  const db = ctx.db,
    s = ctx.session!;
  const a = await me(db, s);
  const o = await offerFor(db, s, id);
  gate(a);
  assertPending(o, "Your manager");
  if (isExt(s) && b.conflict === "none") {
    const svc = (await loadCase(db, o.ref!)).app.serviceSlug;
    await work.assertCanAccept(db, s.id, svc);
  }
  if (!b.conflict || !(CONFLICTS as readonly string[]).includes(b.conflict))
    throw new AppError(422, "validation", "Choose a conflict answer");
  const name = a.name;
  if (b.conflict !== "none") {
    o.data = {
      ...o.data,
      state: "withdrawn",
      endedAt: iso(),
      declineReason: b.conflict,
      note: b.note,
    };
    await recPut(db, "offer", { ...o, state: o.data.state });
    const r = await loadCase(db, o.ref!, true);
    if (r.app.assignedAgentId === s.id)
      await saveCase(db, r, { assignedAgentId: null, assignedAt: null });
    if (a.managerId)
      await notify(db, {
        userId: a.managerId,
        kind: "offer",
        title: `${name} declared a conflict on ${o.ref}`,
        body: b.note,
        href: `/ops/cases/${o.ref}`,
      });
  } else {
    const r = await loadCase(db, o.ref!, true);
    if (caseClosed(r.app.status)) throw new AppError(409, "taken", "This case is already closed");
    o.data = { ...o.data, state: "accepted", endedAt: iso() };
    // Undo snapshot (8 s window on the client) is kept on the offer.
    (o.data as OfferData & { before?: unknown }).before = {
      lead: r.app.assignedAgentId,
      status: r.app.status,
      dueAt: r.app.dueAt,
      previous: r.x.previous,
    };
    await recPut(db, "offer", { ...o, state: "accepted" });
    if (r.app.assignedAgentId !== s.id) {
      await db
        .insert(applicationAssignmentHistory)
        .values({
          id: generateId("aah"),
          applicationId: r.app.applicationId,
          previousAgentId: r.app.assignedAgentId,
          newAgentId: s.id,
          performedBy: s.id,
          performedByRole: s.role,
          note: "offer accepted",
          createdAt: iso(),
        });
    }
    r.x.previous = r.app.status as CaseStatus;
    const to = b.start_now ? "in_progress" : "approved_assigned";
    // A late case (already in progress / review) keeps its status; only the lead changes.
    if (r.app.status !== to && !LATE_STATES.has(r.app.status))
      await deps.apps.transition(db, s, r.app, to, "assignee", { offer: "accept" });
    await saveCase(db, r, {
      assignedAgentId: s.id,
      assignedAt: iso(),
      ...(LATE_STATES.has(r.app.status) ? {} : { status: to }),
      dueAt: o.data.dueAt,
    });
    await logEvent(db, r.app.applicationId, {
      kind: "assignment",
      actorId: s.id,
      actorName: name,
      text: name,
      to: "accepted",
    });
    const conv = await deps.chat.ensureCaseConversation(db, r.app.applicationId);
    await db
      .insert(conversationParticipants)
      .values({
        conversationId: conv.conversationId,
        userId: s.id,
        role: "agent",
        joinedAt: iso(),
        lastReadSeq: 0,
        lastDeliveredSeq: 0,
      })
      .onConflictDoNothing();
    if (a.managerId)
      await notify(db, {
        userId: a.managerId,
        kind: "offer",
        title: `${name} accepted ${o.ref}`,
        href: `/ops/cases/${o.ref}`,
      });
  }
  ctx.audit = {
    resourceId: id,
    details: { status: o.data.state, conflict: b.conflict },
  };
  return (await offerVM(db, a, [o]))[0];
}

export async function declineOffer(
  ctx: Ctx,
  id: string,
  b: { reason?: string; note?: string },
) {
  const a = await me(ctx.db, ctx.session!);
  const o = await offerFor(ctx.db, ctx.session!, id);
  gate(a);
  assertPending(o, "Your manager");
  if (
    !b.reason ||
    !(DECLINE_REASONS as readonly string[]).includes(b.reason) ||
    (b.reason === "other" && !b.note?.trim())
  )
    throw new AppError(422, "validation", "Reason required");
  o.data = {
    ...o.data,
    state: "declined",
    endedAt: iso(),
    declineReason: b.reason,
    note: b.note,
  };
  await recPut(ctx.db, "offer", { ...o, state: "declined" });
  const r = await loadCase(ctx.db, o.ref!, true);
  if (r.app.assignedAgentId === ctx.session!.id)
    await saveCase(ctx.db, r, { assignedAgentId: null, assignedAt: null }); // back to the ops queue
  if (a.managerId)
    await notify(ctx.db, {
      userId: a.managerId,
      kind: "offer",
      title: `${a.name} declined ${o.ref}`,
      body: b.reason,
      href: `/ops/cases/${o.ref}`,
    });
  ctx.audit = { resourceId: id, details: { reason: b.reason } };
  return (await offerVM(ctx.db, a, [o]))[0];
}

const LATE_STATES = new Set(["in_progress", "awaiting_internal_review", "awaiting_external_institution", "on_hold"]);

export async function undoOffer(deps: Deps, ctx: Ctx, id: string) {
  const a = await me(ctx.db, ctx.session!);
  const o = await offerFor(ctx.db, ctx.session!, id);
  const before = (
    o.data as OfferData & {
      before?: {
        lead: string | null;
        status: string;
        dueAt: string | null;
        previous: CaseStatus | null;
      };
    }
  ).before;
  if (o.data.state !== "accepted" || !before)
    throw err.conflict("Nothing to undo");
  const r = await loadCase(ctx.db, o.ref!, true);
  if (r.app.status !== "approved_assigned")
    throw new AppError(409, "started", "Work already started");
  if (before.status !== r.app.status)
    await deps.apps.transition(ctx.db, ctx.session!, r.app, before.status as CaseStatus, "assignee", { offer: "undo", previous: before.status as CaseStatus });
  r.x.previous = before.previous;
  await saveCase(ctx.db, r, {
    assignedAgentId: before.lead,
    status: before.status,
    dueAt: before.dueAt,
  });
  o.data = { ...o.data, state: "sent", endedAt: undefined };
  delete (o.data as { before?: unknown }).before;
  await recPut(ctx.db, "offer", { ...o, state: "sent" });
  return (await offerVM(ctx.db, a, [o]))[0];
}

// ── deliverables ───────────────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER(no-review-services): services delivered without SM review.
const NO_REVIEW = new Set(["trademark-registration"]);

async function deliv(db: Exec, s: Session, r: CaseRow) {
  const a = await me(db, s);
  const mgr = a.managerId
    ? (await namesOf(db, [a.managerId])).get(a.managerId)
    : null;
  const ev = (await eventsOf(db, r.app.applicationId, "agent"))
    .filter((e) => e.kind === "delivery")
    .reverse();
  return {
    ref: r.app.code,
    status: r.app.status,
    // "uploading" is internal (confirmed at submit-review); the contract only knows uploaded/approved/returned,
    // and the web would show a stuck "Uploading 0%" after a reload.
    slots: r.x.slots.map((x) => ({ ...x, versions: x.versions.map((v) => (v.state === "uploading" ? { ...v, state: "uploaded" as const } : v)) })),
    clientNote: r.x.clientNote,
    review: r.x.review,
    checklist: {
      done: r.x.steps.filter((x) => x.done).length,
      total: r.x.steps.length,
    },
    reviewRequired: !NO_REVIEW.has(r.app.serviceSlug),
    reviewer: { name: mgr ?? "Service manager", category: null },
    events: ev.map((e) => ({
      kind: e.toValue,
      at: e.at,
      v: e.text ?? undefined,
    })),
    share: shareOf(r.app.paymentAmount ?? 0, a.shareBps),
  };
}
const leadOnly = async (db: Exec, s: Session, code: string, write = false) => {
  const { r } = await myCase(db, s, code, write).catch(() => {
    throw err.notFound("This case isn't assigned to you");
  });
  return r;
};

export async function deliverables(db: Exec, s: Session, code: string) {
  return deliv(db, s, await leadOnly(db, s, code));
}

export async function uploadDeliverable(
  deps: Deps,
  ctx: Ctx,
  code: string,
  b: {
    clientNote?: string;
    slot?: string;
    name?: string;
    size?: number;
    type?: string;
  },
) {
  const r = await leadOnly(ctx.db, ctx.session!, code, true);
  if (b.clientNote !== undefined) {
    r.x.clientNote = b.clientNote.slice(0, 2000);
    await saveCase(ctx.db, r);
    return deliv(ctx.db, ctx.session!, r);
  }
  gate(await me(ctx.db, ctx.session!));
  const slot = r.x.slots.find((x) => x.key === b.slot);
  if (!slot || !b.name) throw new AppError(422, "validation", "Unknown slot");
  if (r.x.review?.state === "submitted" || r.x.review?.state === "released")
    throw new AppError(409, "locked", "Locked while in review");
  if (isExt(ctx.session!))
    await work.assertCanDeliver(ctx.db, ctx.session!.id, r.app.code, b.size ?? 0); // service clearance
  if (!b.size || !b.type) throw new AppError(422, "validation", "File size and type are required"); // limits: UploadIn in the DTO
  const v = `v${slot.versions.length + 1}.0`;
  const storageKey = `u/${ctx.session.id}/deliverable/${randomUUID()}-${b.name.replace(/[^\w.-]+/g, "_")}`;
  slot.versions.push({
    v,
    name: b.name,
    size: b.size,
    at: iso(),
    state: "uploading", // → "uploaded" once the stored object is confirmed (submitReview)
    storageKey,
    type: b.type,
  });
  await saveCase(ctx.db, r);
  await deps.scan(ctx.db, storageKey);
  ctx.audit = {
    resourceId: r.app.code,
    details: { slot: slot.key, name: b.name },
  };
  // The browser PUTs the bytes straight to storage with this URL (files never pass through the API).
  return {
    ...(await deliv(ctx.db, ctx.session!, r)),
    upload: await deps.storage.presignPut({
      key: storageKey,
      contentType: b.type,
      size: b.size,
      purpose: "deliverable",
    }),
  };
}

export async function submitReview(deps: Deps, ctx: Ctx, code: string) {
  const s = ctx.session!;
  const r = await leadOnly(ctx.db, s, code, true);
  const a = await me(ctx.db, s);
  gate(a);
  // shortcut: an uploading version is confirmed by the object existing (infected ones are moved to quarantine/ by
  // storage.scan, ~5 min after upload); upgrade to a documents.finalize kind (sniff + scan_status) if deliverables need it.
  for (const x of r.x.slots) {
    const last = x.versions.at(-1);
    if (last?.state === "uploading" && last.storageKey && (await deps.storage.head(last.storageKey))) last.state = "uploaded";
  }
  if (
    r.x.slots.some((x) => x.required && x.versions.at(-1)?.state !== "uploaded" && x.versions.at(-1)?.state !== "approved") ||
    r.x.steps.some((x) => !x.done)
  )
    throw new AppError(422, "blocked", "Required files or checklist missing");
  if (r.x.review?.state === "submitted")
    throw new AppError(409, "locked", "Already in review");
  const v = r.x.slots.find((x) => x.required)?.versions.at(-1)?.v;
  const prior = (await eventsOf(ctx.db, r.app.applicationId, "agent")).some(
    (e) => e.kind === "delivery" && e.toValue === "submitted",
  );
  const evt = (kind: string) =>
    logEvent(ctx.db, r.app.applicationId, {
      kind: "delivery",
      feed: "agent",
      actorId: s.id,
      actorName: a.name,
      to: kind,
      text: v ?? null,
    });
  if (NO_REVIEW.has(r.app.serviceSlug)) {
    await evt("delivered");
    for (const sl of r.x.slots) {
      const last = sl.versions.at(-1);
      if (last) last.state = "approved";
    }
    r.x.review = { state: "released", at: iso() };
    r.x.previous = r.app.status as CaseStatus;
    await releaseDeliverables(ctx.db, r, s.id);
    await deps.apps.transition(ctx.db, null, r.app, "completed_delivered", "system", { deliverablesUploaded: r.x.slots.filter((x) => x.versions.length).length });
    await saveCase(ctx.db, r, {
      status: "completed_delivered",
      completedAt: iso(),
    });
    if (r.app.clientId)
      await notify(ctx.db, {
        userId: r.app.clientId,
        kind: "status",
        title: `${r.app.code} is complete`,
        href: `/requests/${r.app.code}`,
      });
  } else {
    await evt(prior ? "resubmitted" : "submitted");
    r.x.review = { state: "submitted", at: iso() };
    r.x.previous = r.app.status as CaseStatus;
    await deps.apps.transition(ctx.db, s, r.app, "awaiting_internal_review", "assignee", { previous: r.x.previous, deliverablesUploaded: r.x.slots.filter((x) => x.versions.length).length });
    r.app.status = "awaiting_internal_review";
    await saveCase(ctx.db, r);
    await openReview(ctx.db, r, { id: s.id, name: a.name });
    if (a.managerId)
      await notify(ctx.db, {
        userId: a.managerId,
        kind: "review",
        title: `Deliverable submitted — ${r.app.code}`,
        href: "/ops/reviews",
      });
  }
  await publish(ctx.db, "case.status_changed", {
    actorId: s.id,
    data: { code: r.app.code, to: r.app.status },
  });
  ctx.audit = { resourceId: r.app.code };
  return deliv(ctx.db, s, r);
}

// ── threads (the case conversation, agent view) ────────────────────────────────────────────────────────
type XMsg = {
  id: string;
  lane: "client" | "internal";
  kind: string;
  authorId: string;
  author: string;
  body: string;
  at: string;
  mentions?: string[];
  file?: unknown;
  voice?: unknown;
  card?: unknown;
};
function xmsg(
  m: typeof applicationMessages.$inferSelect,
  names: Map<string, string>,
  mentions: Map<string, string[]>,
): XMsg {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const kind = m.isSystem
    ? "system"
    : ["voice", "file", "card"].includes(m.kind)
      ? m.kind
      : p.card
        ? "card"
        : "text";
  return {
    id: m.clientMsgId ?? m.messageId,
    lane: m.lane === "client" ? "client" : "internal",
    kind,
    authorId: m.senderId ?? "sys",
    author: m.senderId ? (names.get(m.senderId) ?? "—") : "HEBUZA",
    body: m.deletedAt ? "" : m.content,
    at: m.createdAt,
    mentions: mentions.get(m.messageId),
    file: p.file,
    voice: p.voice,
    card: p.card,
  };
}

async function threadRows(db: Exec, s: Session, rows: CaseRow[]) {
  if (!rows.length) return [];
  const convs = await db.execute<{
    application_id: string;
    conversation_id: string;
    last_seq: number;
    read: number | null;
  }>(sql`
    select c.application_id, c.conversation_id, c.last_seq, p.last_read_seq read from conversations c
    left join conversation_participants p on p.conversation_id = c.conversation_id and p.user_id = ${s.id}
    where c.application_id in ${rows.map((r) => r.app.applicationId)}`);
  const ids = convs.map((c) => c.conversation_id);
  const lastMsgs = ids.length
    ? await db.execute<
        typeof applicationMessages.$inferSelect & Record<string, unknown>
      >(sql`
    select distinct on (conversation_id) * from application_messages where conversation_id in ${ids} and is_system = false order by conversation_id, seq desc`)
    : [];
  const mentionCounts = ids.length
    ? await db.execute<{ id: string; n: number }>(sql`
    select m.conversation_id id, count(*)::int n from message_mentions x join application_messages m on m.message_id = x.message_id
    where m.conversation_id in ${ids} and x.user_id = ${s.id} group by 1`)
    : [];
  const lastClient = ids.length
    ? await db.execute<{ id: string; at: string; role: string }>(sql`
    select distinct on (conversation_id) conversation_id id, created_at at, sender_role role from application_messages
    where conversation_id in ${ids} and lane = 'client' and is_system = false order by conversation_id, seq desc`)
    : [];
  const b = await caseBundle(db, rows);
  return rows.map((r) => {
    const c = convs.find((x) => x.application_id === r.app.applicationId);
    const l = c
      ? lastMsgs.find(
          (x) => (x.conversation_id ?? x.conversationId) === c.conversation_id,
        )
      : undefined;
    const lc = c
      ? lastClient.find((x) => x.id === c.conversation_id)
      : undefined;
    const cl = b.clients.get(clientKey(r.app))!;
    const waiting = lc?.role === "client";
    return {
      ref: r.app.code,
      clientId: cl.id,
      client: cl.name,
      clientLanguage: cl.language,
      service: b.svcs.get(r.app.serviceSlug)?.name ?? r.app.serviceName,
      status: r.app.status,
      dueAt: dueOf(r),
      preview: (l?.content as string) || "",
      previewLane: (l?.lane as string) === "client" ? "client" : "internal",
      lastAt:
        (l?.created_at as string) ??
        (l?.createdAt as string) ??
        r.app.createdAt,
      unread: c ? Math.max(0, Number(c.last_seq) - Number(c.read ?? 0)) : 0,
      waiting,
      waitingSince: waiting ? lc!.at : null,
      mentions: mentionCounts.find((x) => x.id === c?.conversation_id)?.n ?? 0,
      dispute: !!r.x.dispute,
      readOnly: !open(r),
    };
  });
}

export async function threads(
  db: Exec,
  s: Session,
  q: { q?: string; filter?: string },
) {
  let rows = await myRows(db, s);
  if (isExt(s)) {
    const ok = await Promise.all(rows.map((r) => work.scoped(db, s.id, r.app.code)));
    rows = rows.filter((_, i) => ok[i]?.s.active);
  }
  const all = (await threadRows(db, s, rows)).sort((a, b) =>
    String(b.lastAt).localeCompare(String(a.lastAt)),
  );
  const counts = {
    all: all.length,
    unread: all.filter((t) => t.unread).length,
    waiting: all.filter((t) => t.waiting && !t.readOnly).length,
    mentions: all.filter((t) => t.mentions).length,
  };
  const f = q.filter ?? "all",
    term = (q.q ?? "").toLowerCase();
  const items = all
    .filter((t) =>
      f === "unread"
        ? t.unread
        : f === "waiting"
          ? t.waiting && !t.readOnly
          : f === "mentions"
            ? t.mentions
            : true,
    )
    .filter(
      (t) =>
        !term ||
        [t.client, t.ref, t.preview, t.service].some((x) =>
          x.toLowerCase().includes(term),
        ),
    );
  return { items, counts };
}

export async function thread(deps: Deps, db: Exec, s: Session, ref: string) {
  const { r } = await myCase(db, s, ref).catch(() => {
    throw err.notFound("Not one of your cases.");
  });
  const conv = await deps.chat.ensureCaseConversation(db, r.app.applicationId);
  const ms = await db
    .select()
    .from(applicationMessages)
    .where(eq(applicationMessages.conversationId, conv.conversationId))
    .orderBy(asc(applicationMessages.seq))
    .limit(500);
  const names = await namesOf(
    db,
    ms.map((m) => m.senderId),
  );
  const mm = ms.length
    ? await db.execute<{ message_id: string; user_id: string }>(
        sql`select message_id, user_id from message_mentions where message_id in ${ms.map((m) => m.messageId)}`,
      )
    : [];
  const mentions = new Map<string, string[]>();
  for (const x of mm)
    mentions.set(x.message_id, [
      ...(mentions.get(x.message_id) ?? []),
      x.user_id,
    ]);
  const [row] = await threadRows(db, s, [r]);
  const noClient = isExt(s) && !(await work.scoped(db, s.id, r.app.code))?.s.clientLane;
  return {
    thread: row,
    messages: ms
      .filter((m) => m.lane !== "team" && !(noClient && m.lane === "client"))
      .map((m) => xmsg(m, names, mentions)),
  };
}

export async function readThread(deps: Deps, db: Exec, s: Session, ref: string) {
  const { r } = await myCase(db, s, ref).catch(() => {
    throw err.notFound("Not one of your cases.");
  });
  const conv = await deps.chat.ensureCaseConversation(db, r.app.applicationId);
  await db
    .insert(conversationParticipants)
    .values({
      conversationId: conv.conversationId,
      userId: s.id,
      role: "agent",
      joinedAt: iso(),
      lastReadSeq: conv.lastSeq,
      lastDeliveredSeq: conv.lastSeq,
    })
    .onConflictDoUpdate({
      target: [
        conversationParticipants.conversationId,
        conversationParticipants.userId,
      ],
      set: { lastReadSeq: conv.lastSeq },
    });
  return { updated: 1 };
}

type PostIn = {
  client_msg_id: string;
  lane: "client" | "internal";
  kind: "text" | "voice" | "file" | "card";
  body?: string;
  file?: unknown;
  voice?: unknown;
  card?: unknown;
};
/** ChatService.send owns its tx (seq lock + realtime after commit), so: scope check → send → mark the kind. */
export async function postThread(
  deps: Deps,
  run: <T>(fn: (ctx: Ctx) => Promise<T>) => Promise<T>,
  ref: string,
  b: PostIn,
) {
  const pre = await run(async (ctx) => {
    const s = ctx.session;
    const { r } = await myCase(ctx.db, s, ref).catch(() => {
      throw err.notFound("Not one of your cases.");
    });
    if (!open(r) && b.lane === "client")
      throw new AppError(409, "closed", "This case is closed.");
    if (b.lane === "client" && isExt(s) && !(await work.scoped(ctx.db, s.id, r.app.code))?.s.clientLane)
      throw new AppError(403, "forbidden", "Client lane not enabled.");
    if (b.lane === "internal" && b.kind === "card")
      throw new AppError(422, "invalid", "Cards are client-visible only.");
    const conv = await deps.chat.ensureCaseConversation(ctx.db, r.app.applicationId);
    const body =
      String(b.body ?? "").slice(0, 4000) ||
      (b.kind === "card"
        ? String((b.card as { title?: string })?.title ?? "Card")
        : b.kind === "voice"
          ? "Voice note"
          : String((b.file as { name?: string })?.name ?? "File"));
    // @mentions of the manager by name in internal notes notify them.
    const a = await me(ctx.db, s);
    const mgrName = a.managerId
      ? (await namesOf(ctx.db, [a.managerId])).get(a.managerId)
      : null;
    const mentions =
      a.managerId &&
      mgrName &&
      new RegExp(`@${mgrName.split(" ")[0]}`, "i").test(body)
        ? [a.managerId]
        : [];
    return { s, conv: conv.conversationId, body, name: a.name, mentions };
  });
  const m = await deps.chat.send(pre.s, pre.conv, {
    client_msg_id: b.client_msg_id,
    content: pre.body,
    lane: b.lane,
    mentions: pre.mentions,
  });
  if (b.kind !== "text")
    await run((ctx) =>
      ctx.db
        .update(applicationMessages)
        .set({
          kind: b.kind,
          payload: { file: b.file, voice: b.voice, card: b.card },
        })
        .where(eq(applicationMessages.messageId, m.message_id)),
    );
  return {
    id: b.client_msg_id,
    lane: b.lane,
    kind: b.kind,
    authorId: pre.s.id,
    author: pre.name,
    body: pre.body,
    at: m.created_at,
    file: b.file,
    voice: b.voice,
    card: b.card,
    mentions: pre.mentions,
  };
}

// ── personal templates ──────────────────────────────────────────────────────────────────────────────────
const tpl = (t: typeof chatTemplates.$inferSelect) => ({
  id: t.templateId,
  name: t.title,
  body_rw: t.bodyRw,
  body_en: t.bodyEn,
  body_fr: t.bodyFr,
  updatedAt: t.updatedAt,
});
export async function listTemplates(db: Exec, s: Session) {
  const rows = await db
    .select()
    .from(chatTemplates)
    .where(
      and(
        eq(chatTemplates.isActive, true),
        sql`(${chatTemplates.createdBy} = ${s.id} or ${chatTemplates.scope} = 'all')`,
      ),
    )
    .orderBy(asc(chatTemplates.title));
  return { items: rows.map(tpl) };
}
async function ownTpl(db: Exec, s: Session, id: string) {
  const [t] = await db
    .select()
    .from(chatTemplates)
    .where(eq(chatTemplates.templateId, id))
    .for("update");
  if (!t || t.createdBy !== s.id) throw err.notFound("Template not found");
  return t;
}
export async function createTemplate(
  db: Exec,
  s: Session,
  b: { name?: string; body_rw?: string; body_en?: string; body_fr?: string },
) {
  if (!b.name?.trim()) throw new AppError(422, "invalid", "Name is required.");
  const [t] = await db
    .insert(chatTemplates)
    .values({
      templateId: generateId("tpl"),
      title: b.name.trim(),
      bodyRw: b.body_rw ?? "",
      bodyEn: b.body_en ?? "",
      bodyFr: b.body_fr ?? "",
      scope: "agent",
      createdBy: s.id,
      isActive: true,
    })
    .returning();
  return tpl(t);
}
export async function updateTemplate(
  db: Exec,
  s: Session,
  id: string,
  b: { name?: string; body_rw?: string; body_en?: string; body_fr?: string },
) {
  await ownTpl(db, s, id);
  if (b.name !== undefined && !b.name.trim())
    throw new AppError(422, "invalid", "Name is required.");
  const [t] = await db
    .update(chatTemplates)
    .set({
      ...(b.name && { title: b.name.trim() }),
      ...(b.body_rw !== undefined && { bodyRw: b.body_rw }),
      ...(b.body_en !== undefined && { bodyEn: b.body_en }),
      ...(b.body_fr !== undefined && { bodyFr: b.body_fr }),
      updatedAt: iso(),
    })
    .where(eq(chatTemplates.templateId, id))
    .returning();
  return tpl(t);
}
export async function deleteTemplate(db: Exec, s: Session, id: string) {
  await ownTpl(db, s, id);
  await db
    .update(chatTemplates)
    .set({ isActive: false, updatedAt: iso() })
    .where(eq(chatTemplates.templateId, id));
  return { deleted: 1 };
}

// ── clients served ──────────────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER(bridge-number): HEBUZA switchboard; the client's own number never reaches the agent.
const BRIDGE = "+250 788 300 300";
async function servedRows(db: Exec, s: Session) {
  const mine = await myRows(db, s);
  const splitCodes = (
    await db
      .select({ code: paymentSplits.applicationCode })
      .from(paymentSplits)
      .where(eq(paymentSplits.workerId, s.id))
  ).map((x) => x.code).filter((x): x is string => !!x);
  const extra = splitCodes.length
    ? await loadCases(
        db,
        await db
          .select()
          .from(applications)
          .where(inArray(applications.code, splitCodes)),
      )
    : [];
  return {
    mine,
    all: [
      ...mine,
      ...extra.filter((e) => !mine.some((m) => m.app.code === e.app.code)),
    ],
  };
}
function clientRow(
  id: string,
  cl: Awaited<ReturnType<typeof clientsOf>> extends Map<string, infer V>
    ? V
    : never,
  mine: CaseRow[],
  s: Session,
  svcs: Map<string, { name: string }>,
  lastContact: string | null,
) {
  const cases = mine.filter((r) => clientKey(r.app) === id);
  const op = cases.filter(open);
  const next = [...op].sort((a, b) => dueOf(a).localeCompare(dueOf(b)))[0];
  return {
    clientId: id,
    name: cl.name,
    phone: null,
    planName: cl.flags.includes("subscriber") ? "Subscription" : "Pay per case",
    status: op.length ? "active" : "inactive",
    lastCaseCode: cases[0]?.app.code ?? null,
    openCaseCount: op.length,
    focusCategories: [],
    focusServices: [
      ...new Set(
        cases.map(
          (c) => svcs.get(c.app.serviceSlug)?.name ?? c.app.serviceName,
        ),
      ),
    ],
    x_agent: {
      type: cl.type,
      dedicated: cl.dedicatedAgentId === s.id,
      nextObligation: next
        ? {
            label: svcs.get(next.app.serviceSlug)?.name ?? next.app.serviceName,
            dueAt: dueOf(next),
            ref: next.app.code,
          }
        : null,
      lastContactAt: lastContact,
    },
  };
}
async function lastContacts(db: Exec, rows: CaseRow[]) {
  if (!rows.length) return new Map<string, string>();
  const res = await db.execute<{ id: string; at: string }>(
    sql`select application_id id, max(created_at) at from application_messages where application_id in ${rows.map((r) => r.app.applicationId)} and lane = 'client' and is_system = false group by 1`,
  );
  const byApp = new Map(res.map((x) => [x.id, x.at]));
  const out = new Map<string, string>();
  for (const r of rows) {
    const at = byApp.get(r.app.applicationId);
    const k = clientKey(r.app);
    if (at && (!out.get(k) || out.get(k)! < at)) out.set(k, at);
  }
  return out;
}
export async function clients(db: Exec, s: Session) {
  const { mine, all } = await servedRows(db, s);
  const [cls, svcs, lc] = await Promise.all([
    clientsOf(
      db,
      all.map((r) => r.app),
    ),
    servicesBySlug(
      db,
      all.map((r) => r.app.serviceSlug),
    ),
    lastContacts(db, mine),
  ]);
  return {
    clients: [...cls.keys()].map((id) =>
      clientRow(id, cls.get(id)!, mine, s, svcs, lc.get(id) ?? null),
    ),
  };
}
export async function clientOne(db: Exec, s: Session, id: string) {
  const { mine, all } = await servedRows(db, s);
  if (!all.some((r) => clientKey(r.app) === id))
    throw new AppError(
      403,
      "not_shared",
      "This client isn't on any of your cases.",
    );
  const [cls, svcs, lc, notes] = await Promise.all([
    clientsOf(
      db,
      all.map((r) => r.app),
    ),
    servicesBySlug(
      db,
      all.map((r) => r.app.serviceSlug),
    ),
    lastContacts(db, mine),
    recList<{ text: string; by: string }>(db, "client_note", {
      ref: id,
      ownerId: s.id,
    }),
  ]);
  const cl = cls.get(id)!;
  const cases = mine.filter((r) => clientKey(r.app) === id);
  const activity = cases.length
    ? await db.execute<{
        at: string;
        code: string;
        sender: string | null;
        content: string;
        role: string;
      }>(sql`
    select m.created_at at, a.code, m.sender_id sender, m.content, m.sender_role role from application_messages m join applications a on a.application_id = m.application_id
    where m.application_id in ${cases.map((c) => c.app.applicationId)} and m.lane = 'client' and m.is_system = false order by m.created_at desc limit 12`)
    : [];
  const an = await namesOf(
    db,
    activity.map((x) => x.sender),
  );
  return {
    ...clientRow(id, cl, mine, s, svcs, lc.get(id) ?? null),
    language: cl.language,
    since: cl.since,
    cases: cases.map((c) => ({
      ref: c.app.code,
      service: svcs.get(c.app.serviceSlug)?.name ?? c.app.serviceName,
      status: c.app.status,
      dueAt: dueOf(c),
    })),
    documents: cases.flatMap((c) =>
      c.x.checklist
        .filter((d) => d.docId && !NOT_SHARED.includes(d.key))
        .map((d) => ({
          id: `${c.app.code}-${d.key}`,
          name: d.label,
          ref: c.app.code,
          state: d.state,
        })),
    ),
    obligations: cases
      .filter(open)
      .map((c) => ({
        ref: c.app.code,
        label: svcs.get(c.app.serviceSlug)?.name ?? c.app.serviceName,
        dueAt: dueOf(c),
      }))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
    activity: activity.map((x) => ({
      at: x.at,
      ref: x.code,
      who: x.sender ? (an.get(x.sender) ?? "—") : "HEBUZA",
      text: x.content,
    })),
    notes: notes.map((n) => ({
      id: n.id,
      text: n.data.text,
      at: n.createdAt,
      by: n.data.by,
    })),
    bridge: BRIDGE,
  };
}
export async function addClientNote(
  db: Exec,
  s: Session,
  id: string,
  text: string,
) {
  const { all } = await servedRows(db, s);
  if (!all.some((r) => clientKey(r.app) === id))
    throw new AppError(
      403,
      "not_shared",
      "This client isn't on any of your cases.",
    );
  if (!text?.trim()) throw new AppError(422, "invalid", "Write a note first.");
  const by = (await me(db, s)).name;
  const n = await recPut(db, "client_note", {
    ownerId: s.id,
    ref: id,
    data: { text: text.trim().slice(0, 2000), by },
  });
  return { id: n.id, text: n.data.text, at: n.createdAt, by };
}

// ── earnings (F-REV-11: finance allocations → batches; states match REV: allocated/approved/scheduled/paid/deducted) ──
const monthOf = (x: string) => x.slice(0, 7);
const REV_STATE: Record<string, string> = {
  pending_review: "allocated", reviewed: "allocated", on_hold: "allocated",
  approved_for_payment: "approved", in_batch: "scheduled", paid: "paid", voided: "deducted",
};
async function allocations(db: Exec, s: Session) {
  const [allocs, batches] = await Promise.all([
    finAll<Alloc>(db, "allocation").then((xs) => xs.filter((x) => x.shares.some((sh) => sh.workerId === s.id))),
    finAll<Batch>(db, "batch"),
  ]);
  const codes = allocs.map((x) => x.caseRef).filter((c) => !c.startsWith("PLAN:"));
  const apps = codes.length ? await db.select().from(applications).where(inArray(applications.code, codes)) : [];
  const byCode = new Map(apps.map((a) => [a.code, a]));
  const [cls, svcs, qs] = await Promise.all([
    clientsOf(db, apps),
    servicesBySlug(db, apps.map((a) => a.serviceSlug)),
    recList<{ reason: string; status: string; at: string; ticketRef: string }>(db, "alloc_question", { ownerId: s.id }),
  ]);
  return allocs
    .sort((x, y) => y.frozenAt.localeCompare(x.frozenAt))
    .map((r) => {
      const app = byCode.get(r.caseRef);
      const share = r.shares.find((x) => x.workerId === s.id)!;
      const state = REV_STATE[r.status] ?? "allocated";
      const batch = r.batchNo ? batches.find((b) => b.no === r.batchNo) : undefined;
      const q = qs.find((x) => x.ref === r.id);
      const ded = r.deductions.reduce((t, d) => t + d.amount, 0);
      return {
        id: r.id,
        ref: r.caseRef,
        service: app ? (svcs.get(app.serviceSlug)?.name ?? app.serviceName) : r.caseRef,
        client: app ? (cls.get(clientKey(app))?.name ?? "—") : "—",
        eligible: r.eligible,
        deducted: ded,
        amount: state === "deducted" ? 0 : share.amount,
        state,
        at: r.frozenAt,
        approvedAt: r.approvedBy ? r.frozenAt : null,
        approvedBy: r.approvedBy?.name ?? null,
        mine: app?.assignedAgentId === s.id,
        payout: batch
          ? { date: batch.meta?.[batch.lines.find((l) => l.workerId === s.id)?.id ?? ""]?.paidAt ?? `${batch.period}-01`, ref: batch.no, status: r.status === "paid" ? ("paid" as const) : ("pending" as const) }
          : null,
        question: q
          ? { id: q.id, ref: q.data.ticketRef, reason: q.data.reason, status: q.data.status, at: q.data.at }
          : null,
      };
    });
}
export async function earnings(db: Exec, s: Session, month: string) {
  const a = await me(db, s);
  const all = await allocations(db, s);
  const months = [...new Set(all.map((x) => monthOf(x.at)))].sort().map((m) => {
    const rows = all.filter((x) => monthOf(x.at) === m);
    const sum = (f: (x: (typeof rows)[number]) => boolean) =>
      rows.filter(f).reduce((t, x) => t + x.amount, 0);
    return {
      month: m,
      paid: sum((x) => x.state === "paid"),
      scheduled: sum((x) => x.state === "scheduled"),
      pending: sum((x) =>
        ["allocated", "approved", "adjusted"].includes(x.state),
      ),
      deducted: sum((x) => x.state === "deducted"),
    };
  });
  return {
    month,
    sharePct: a.shareBps / 10_000,
    months,
    rows: all.filter((x) => monthOf(x.at) === month),
  };
}
export async function statements(db: Exec, s: Session) {
  const e = await earnings(db, s, monthOf(iso()));
  const dl = new Set(
    (
      await recList<{ month: string }>(db, "statement_dl", { ownerId: s.id })
    ).map((x) => x.data.month),
  );
  return e.months
    .map((m) => ({
      month: m.month,
      total: m.paid + m.scheduled + m.pending,
      status: dl.has(m.month) ? "downloaded" : "available",
    }))
    .reverse();
}
export async function payouts(db: Exec, s: Session) {
  const a = await me(db, s);
  const items = (await finAll<Batch>(db, "batch"))
    .filter((b) => b.status !== "draft" && b.status !== "rejected")
    .flatMap((b) =>
      b.lines
        .filter((l) => l.workerId === s.id)
        .map((l) => ({
          id: l.id,
          date: b.meta?.[l.id]?.paidAt ?? `${b.period}-01`,
          method: l.method === "bank" ? "Bank" : l.method === "airtel_money" ? "Airtel Money" : "MTN MoMo",
          ref: l.providerRef ?? b.no,
          amount: l.net,
          status: l.status === "paid" ? ("paid" as const) : ("pending" as const),
        })),
    )
    .sort((x, y) => y.date.localeCompare(x.date));
  return {
    items,
    method: ws(a, "payoutMethod", {
      kind: "momo",
      label: "MTN MoMo",
      last4: (a.phone || "").slice(-4),
      verified: false,
    }),
  };
}
export async function askAllocation(
  ctx: Ctx,
  id: string,
  b: { reason?: string; note?: string; file?: string | null },
) {
  const s = ctx.session!;
  const all = await allocations(ctx.db, s);
  const row = all.find((x) => x.id === id);
  if (!row) throw err.notFound("Allocation not found");
  if (
    !b.reason ||
    !["share", "missing", "deduction", "other"].includes(b.reason)
  )
    throw new AppError(422, "validation", "Choose a reason");
  if (b.reason === "other" && !b.note?.trim())
    throw new AppError(422, "validation", "Add a note");
  const [{ n }] = await ctx.db.execute<{ n: number }>(
    sql`select nextval('support_ticket_ref_seq')::int n`,
  );
  const ticketRef = `FIN-${new Date().getUTCFullYear()}-${String(n).padStart(4, "0")}`;
  await recPut(ctx.db, "alloc_question", {
    ownerId: s.id,
    ref: id,
    state: "open",
    data: {
      reason: b.reason,
      note: (b.note ?? "").slice(0, 1000),
      file: b.file ?? null,
      status: "open",
      at: iso(),
      ticketRef,
    },
  });
  await publish(ctx.db, "allocation.questioned", {
    actorId: s.id,
    data: { split: id, ref: row.ref, reason: b.reason },
  });
  return {
    row: (await allocations(ctx.db, s)).find((x) => x.id === id),
    message: "Question sent",
  };
}

// ── performance ─────────────────────────────────────────────────────────────────────────────────────────
const RANGE_DAYS = { "30d": 30, quarter: 91, year: 365 } as const;
export async function performance(
  db: Exec,
  s: Session,
  range: keyof typeof RANGE_DAYS,
) {
  const days = RANGE_DAYS[range],
    since = iso(Date.now() - days * 24 * H);
  const done = await db
    .select()
    .from(applications)
    .where(
      and(
        eq(applications.status, "completed_delivered"),
        gte(applications.completedAt, since),
      ),
    );
  const by = new Map<string, typeof done>();
  for (const a of done)
    if (a.assignedAgentId)
      by.set(a.assignedAgentId, [...(by.get(a.assignedAgentId) ?? []), a]);
  const mine = by.get(s.id) ?? [];
  const median = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };
  const onTimeOf = (xs: typeof done) =>
    xs.length
      ? Math.round(
          (xs.filter((a) => !a.dueAt || a.completedAt! <= a.dueAt).length /
            xs.length) *
            100,
        )
      : 0;
  const tat = (xs: typeof done) =>
    xs.length
      ? +(
          xs.reduce(
            (t, a) =>
              t + (Date.parse(a.completedAt!) - Date.parse(a.submittedAt)),
            0,
          ) /
          xs.length /
          86_400_000
        ).toFixed(1)
      : 0;
  const fb = mine.length
    ? await db
        .select()
        .from(applicationFeedback)
        .where(
          inArray(
            applicationFeedback.applicationId,
            mine.map((a) => a.applicationId),
          ),
        )
    : [];
  const rated = fb.filter((f) => f.rating);
  const rating = rated.length
    ? +(rated.reduce((t, f) => t + f.rating!, 0) / rated.length).toFixed(1)
    : 0;
  const reviews = await recList<Review>(db, "review", { ownerId: s.id });
  const rework = mine.length
    ? Math.round(
        (reviews.filter((r) => r.data.version > 1).length / mine.length) * 100,
      )
    : 0;
  const complaints = (await recList<Ticket>(db, "ticket")).filter(
    (t) =>
      t.data.kind === "complaint" &&
      t.data.owner.id === s.id &&
      t.createdAt >= since,
  ).length;
  const step =
    (range === "30d" ? 7 : range === "quarter" ? 18 : 30) * 86_400_000;
  const trend = Array.from({ length: 5 }, (_, k) => {
    const end = Date.now() - (4 - k) * step;
    const inWin = (a: (typeof done)[number]) =>
      Date.parse(a.completedAt!) <= end &&
      Date.parse(a.completedAt!) > end - step;
    return {
      end: iso(end),
      you: mine.filter(inWin).length,
      median: median([...by.values()].map((xs) => xs.filter(inWin).length)),
    };
  });
  const kpi = (you: number, med: number, f: (k: number) => number) => ({
    you,
    median: med,
    spark: trend.map((_, k) => f(k)),
  });
  const svcs = await servicesBySlug(
    db,
    mine.map((a) => a.serviceSlug),
  );
  const perSvc = new Map<string, typeof done>();
  for (const a of mine)
    perSvc.set(a.serviceSlug, [...(perSvc.get(a.serviceSlug) ?? []), a]);
  const cls = await clientsOf(db, mine);
  return {
    range,
    completed: mine.length,
    sla: 3,
    kpis: {
      completed: kpi(
        mine.length,
        median([...by.values()].map((x) => x.length)),
        (k) => trend[k].you,
      ),
      onTime: kpi(onTimeOf(mine), median([...by.values()].map(onTimeOf)), () =>
        onTimeOf(mine),
      ),
      turnaround: kpi(tat(mine), median([...by.values()].map(tat)), () =>
        tat(mine),
      ),
      rework: kpi(rework, 0, () => rework),
      rating: kpi(rating, 0, () => rating),
      complaints: kpi(complaints, 0, () => complaints),
    },
    trend,
    services: [...perSvc].map(([slug, xs]) => ({
      service: svcs.get(slug)?.name ?? slug,
      cases: xs.length,
      onTime: onTimeOf(xs),
      turnaround: tat(xs),
      rework: 0,
    })),
    feedback: rated.slice(0, 4).map((f) => {
      const a = mine.find((x) => x.applicationId === f.applicationId)!;
      return {
        id: f.applicationId,
        client: cls.get(clientKey(a))?.name ?? "—",
        rating: f.rating!,
        note: f.reviewNote ?? "",
        at: f.ratedAt ?? a.completedAt!,
      };
    }),
  };
}

export async function metrics(db: Exec, s: Session) {
  const p = await performance(db, s, "30d");
  const weeks = await db.execute<{ w: string; n: number }>(
    sql`select to_char(date_trunc('week', completed_at), 'IW') w, count(*)::int n from applications where assigned_agent_id = ${s.id} and completed_at >= now() - interval '6 weeks' group by 1 order by 1`,
  );
  const board = await db.execute<{ id: string; n: number }>(
    sql`select assigned_agent_id id, count(*)::int n from applications where status = 'completed_delivered' and completed_at >= now() - interval '30 days' and assigned_agent_id is not null group by 1 order by 2 desc limit 5`,
  );
  const names = await namesOf(
    db,
    board.map((b) => b.id),
  );
  const initials = (n: string) =>
    n
      .split(/\s+/)
      .map((x) => x[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  return {
    completedCount: p.kpis.completed.you,
    completedDelta: "",
    avgTurnaround: p.kpis.turnaround.you,
    avgTurnaroundDelta: "",
    onTimeSLAPercent: p.kpis.onTime.you,
    clientRating: p.kpis.rating.you,
    ratingsCount: p.feedback.length,
    weeklyBars: weeks.map((w, i, a) => ({
      week: `W${w.w}`,
      count: Number(w.n),
      isCurrent: i === a.length - 1,
    })),
    leaderboard: board.map((b) => ({
      initials: initials(names.get(b.id) ?? "?"),
      name: names.get(b.id) ?? b.id,
      count: Number(b.n),
      isMe: b.id === s.id,
    })),
    retainerCompleted: 0,
    oneOffCompleted: p.kpis.completed.you,
  };
}

// ── calendar + obligations ──────────────────────────────────────────────────────────────────────────────
export async function calendar(
  db: Exec,
  s: Session,
  q: { start?: string; end?: string },
) {
  const a = await me(db, s);
  const rows = (await myRows(db, s)).filter(open);
  const b = await caseBundle(db, rows);
  const now = Date.now();
  const items = rows.map((r) => {
    const cl = b.clients.get(clientKey(r.app))!;
    const due = dueOf(r);
    return {
      kind: "case",
      id: `dl-${r.app.code}`,
      code: r.app.code,
      title: b.svcs.get(r.app.serviceSlug)?.name ?? r.app.serviceName,
      label: { type: "deadline" },
      serviceName: b.svcs.get(r.app.serviceSlug)?.name ?? r.app.serviceName,
      clientId: cl.id,
      clientName: cl.name,
      agentId: a.id,
      agentName: a.name,
      dueDate: due.slice(0, 10),
      dueAt: due,
      state: Date.parse(due) < now ? "overdue" : "upcoming",
      status: r.app.status,
      isUrgent: r.app.isUrgent,
      dueSource: r.app.dueSource,
      leadDays: 0,
      note: null as string | null,
    };
  });
  const clientIds = [
    ...new Set(rows.map((r) => r.app.clientId).filter((x): x is string => !!x)),
  ];
  const obs = clientIds.length
    ? await db
        .select()
        .from(clientObligations)
        .where(inArray(clientObligations.clientId, clientIds))
    : [];
  const cn = await namesOf(
    db,
    obs.map((o) => o.clientId),
  );
  for (const o of obs)
    items.push({
      kind: "obligation",
      id: o.id,
      code:
        rows.find((r) => r.app.applicationId === o.applicationId)?.app.code ??
        (null as unknown as string),
      title: String((o.label as Record<string, string>)?.en ?? o.label),
      label: o.label as { type: string },
      serviceName: String((o.label as Record<string, string>)?.en ?? ""),
      clientId: o.clientId,
      clientName: cn.get(o.clientId) ?? "",
      agentId: a.id,
      agentName: a.name,
      dueDate: o.dueDate,
      dueAt: `${o.dueDate}T15:00:00.000Z`,
      state:
        o.status === "pending" && o.dueDate < iso().slice(0, 10)
          ? "overdue"
          : o.status,
      status: o.status,
      isUrgent: false,
      dueSource: "obligation",
      leadDays: o.leadDays,
      note: o.note,
    });
  const today = iso().slice(0, 10);
  const list = items
    .filter(
      (i) =>
        (!q.start || i.dueDate >= q.start) && (!q.end || i.dueDate <= q.end),
    )
    .sort((x, y) => Date.parse(x.dueAt) - Date.parse(y.dueAt));
  return {
    today,
    start: q.start ?? list[0]?.dueDate ?? today,
    end: q.end ?? list.at(-1)?.dueDate ?? today,
    items: list,
  };
}

export async function obligationAction(
  ctx: Ctx,
  id: string,
  action: string,
  b: { code?: string; reason?: string },
) {
  if (!["done", "skip", "link"].includes(action)) throw err.notFound();
  if (action === "skip" && !b.reason?.trim())
    throw new AppError(422, "reason", "A reason is required.");
  if (action === "link" && !b.code)
    throw new AppError(422, "code", "Choose a case.");
  const [o] = await ctx.db
    .select()
    .from(clientObligations)
    .where(eq(clientObligations.id, id))
    .for("update");
  if (!o) throw err.notFound("Obligation not found.");
  const mine = (await myRows(ctx.db, ctx.session!)).some(
    (r) => r.app.clientId === o.clientId,
  );
  if (!mine) throw err.notFound("Obligation not found.");
  let applicationId: string | null = o.applicationId;
  if (action === "link")
    applicationId = (await myCase(ctx.db, ctx.session!, b.code!)).r.app
      .applicationId;
  const state =
    action === "done" ? "done" : action === "skip" ? "skipped" : "linked";
  await ctx.db
    .update(clientObligations)
    .set({
      status: state === "linked" ? o.status : state,
      applicationId,
      note: b.reason ?? o.note,
      resolvedBy: ctx.session!.id,
      resolvedAt: iso(),
      updatedAt: iso(),
    })
    .where(eq(clientObligations.id, id));
  ctx.audit = { resourceId: id, details: { action, code: b.code ?? null } };
  return { state, code: b.code };
}

// ── profile, onboarding, skills, availability, leave, contract, notifications, ICS ─────────────────────
export async function onboarding(db: Exec, s: Session) {
  const a = await me(db, s);
  const ob = ws<Record<string, unknown> & { agreements?: { signedAt?: string | null } & Record<string, unknown>; profile?: { name: string; email: string; phone: string } & Record<string, unknown> }>(a, "onboarding", {
    step: "profile",
    profile: {
      photo: null,
      name: a.name,
      phone: a.phone.replace(/^\+250/, ""),
      email: a.email,
      linkedin: "",
      website: "",
      languages: a.languages,
      bio: "",
    },
    cv: { education: [], experience: [], expertise: [], years: "" },
    certificates: [],
    payout: {
      method: "bank",
      bank: "",
      account: "",
      accountLast4: "",
      holder: "",
      verification: "none",
    },
    agreements: { nda: false, code: false, signature: "", signedAt: null },
  });
  return {
    ...ob,
    status: a.clearance,
    savedAt: ws<string | null>(a, "onboardingSavedAt", null),
    changes: ws<unknown>(a, "onboardingChanges", null),
  };
}
export async function saveOnboarding(
  ctx: Ctx,
  b: Record<string, unknown> & { payout?: Record<string, unknown> },
) {
  const a = await me(ctx.db, ctx.session!);
  if (a.clearance === "submitted")
    throw new AppError(
      409,
      "locked",
      "Submitted for clearance — wait for review.",
    );
  if (typeof b.payout?.account === "string" && b.payout.account) {
    // Full account numbers are not stored here; finance verifies the payout account (P6) from the event.
    const digits = b.payout.account.replace(/\D/g, "");
    await publish(ctx.db, "payout_account.submitted", {
      actorId: ctx.session!.id,
      data: { last4: digits.slice(-4) },
    });
    b.payout = {
      ...b.payout,
      account: "",
      accountLast4: digits.slice(-4),
      verification: "pending",
    };
  }
  const cur = await onboarding(ctx.db, ctx.session!);
  const { status, savedAt, changes, ...ob } = cur;
  void status;
  void savedAt;
  void changes;
  await setWs(ctx.db, a.id, {
    onboarding: { ...ob, ...b },
    onboardingSavedAt: iso(),
  });
  if (a.clearance === "new")
    await ctx.db
      .update(agentProfiles)
      .set({ clearance: "in_progress" })
      .where(eq(agentProfiles.userId, a.id));
  return onboarding(ctx.db, ctx.session!);
}
export async function submitOnboarding(ctx: Ctx) {
  const a = await me(ctx.db, ctx.session!);
  const ob = await onboarding(ctx.db, ctx.session!);
  if (!(ob.agreements as { signedAt?: string | null })?.signedAt)
    throw new AppError(422, "unsigned", "Sign both agreements first.");
  await ctx.db
    .update(agentProfiles)
    .set({ clearance: "submitted" })
    .where(eq(agentProfiles.userId, a.id));
  await setWs(ctx.db, a.id, { onboardingChanges: null });
  // Workforce verification (P9 wrk.profiles.verify) clears or requests changes.
  await publish(ctx.db, "agent.onboarding_submitted", {
    actorId: a.id,
    data: { agentId: a.id },
  });
  if (a.managerId)
    await notify(ctx.db, {
      userId: a.managerId,
      kind: "onboarding",
      title: `${a.name} submitted onboarding for clearance`,
      href: "/ops/workload",
    });
  return onboarding(ctx.db, ctx.session!);
}
export async function profile(db: Exec, s: Session) {
  const ob = await onboarding(db, s);
  const p = ob.profile as { name: string; email: string; phone: string };
  return {
    name: p.name,
    email: p.email,
    phone: p.phone
      ? p.phone.startsWith("+")
        ? p.phone
        : `+250${p.phone}`
      : null,
  };
}
export async function skills(db: Exec, s: Session) {
  const a = await me(db, s);
  const svcs = await servicesBySlug(db, Object.keys(a.skills));
  const pending = (
    await recList<{ changes: unknown[]; note: string; at: string }>(
      db,
      "skill_request",
      { ownerId: s.id, state: "pending" },
    )
  )[0];
  return {
    agent_id: a.id,
    skills: Object.entries(a.skills).map(([slug, lvl]) => ({
      service_category: svcs.get(slug)?.name ?? slug,
      proficiency_level: Math.max(1, Math.round(lvl * 5)),
    })),
    x_agent: {
      pending: pending
        ? {
            id: pending.id,
            changes: pending.data.changes,
            note: pending.data.note,
            at: pending.data.at,
          }
        : null,
    },
  };
}
export async function requestSkills(
  ctx: Ctx,
  b: {
    changes: { service_category: string; proficiency_level: number }[];
    note: string;
  },
) {
  if (!b.changes?.length)
    throw new AppError(422, "empty", "Choose at least one change.");
  const s = ctx.session!;
  if (
    (
      await recList(ctx.db, "skill_request", {
        ownerId: s.id,
        state: "pending",
      })
    ).length
  )
    throw new AppError(409, "pending", "You already have a pending request.");
  const rec = await recPut(ctx.db, "skill_request", {
    ownerId: s.id,
    state: "pending",
    data: { ...b, at: iso(), status: "pending" },
  });
  await openApproval(ctx.db, {
    kind: "skill",
    agentId: s.id,
    reason: b.note,
    skill: b.changes[0].service_category,
    sourceId: rec.id,
  });
  return skills(ctx.db, s);
}
export async function cancelSkills(ctx: Ctx) {
  const s = ctx.session!;
  for (const r of await recList<Record<string, unknown>>(
    ctx.db,
    "skill_request",
    { ownerId: s.id, state: "pending" },
  )) {
    await recPut(ctx.db, "skill_request", {
      ...r,
      state: "cancelled",
      data: { ...r.data, status: "cancelled" },
    });
    for (const ap of await recList<{ sourceId?: string }>(ctx.db, "approval", {
      ownerId: s.id,
      state: "pending",
    }))
      if (ap.data.sourceId === r.id)
        await recPut(ctx.db, "approval", {
          ...ap,
          state: "declined",
          data: { ...ap.data, state: "declined" },
        });
  }
  return skills(ctx.db, s);
}
const DEFAULT_AVAIL = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { am: true, pm: true }]),
);
export async function availability(db: Exec, s: Session) {
  return ws(await me(db, s), "availability", DEFAULT_AVAIL);
}
export async function setAvailability(
  db: Exec,
  s: Session,
  b: Record<string, { am: boolean; pm: boolean }>,
) {
  await me(db, s);
  await setWs(db, s.id, { availability: b });
  return b;
}
const leaveList = async (db: Exec, s: Session) => ({
  items: (await recList<Leave>(db, "leave", { ownerId: s.id }))
    .filter((l) => l.data.status !== "cancelled")
    .map((l) => ({ id: l.id, ...l.data }))
    .sort((a, b) => b.from.localeCompare(a.from)),
});
export async function leave(db: Exec, s: Session) {
  return leaveList(db, s);
}
export async function requestLeave(
  ctx: Ctx,
  b: { from: string; to: string; reason: string },
) {
  const s = ctx.session!;
  if (!b.from || !b.to || b.to < b.from)
    throw new AppError(
      422,
      "range",
      "The end date must be on or after the start date.",
    );
  if (
    (await recList<Leave>(ctx.db, "leave", { ownerId: s.id })).some(
      (l) => l.data.status === "pending",
    )
  )
    throw new AppError(409, "pending", "You already have a pending request.");
  const impact = (await myRows(ctx.db, s))
    .filter(
      (r) =>
        open(r) &&
        dueOf(r).slice(0, 10) >= b.from &&
        dueOf(r).slice(0, 10) <= b.to,
    )
    .map((r) => r.app.code);
  const rec = await recPut<Leave>(ctx.db, "leave", {
    ownerId: s.id,
    state: "pending",
    data: { from: b.from, to: b.to, reason: b.reason, status: "pending" },
  });
  await openApproval(ctx.db, {
    kind: "leave",
    agentId: s.id,
    reason: b.reason,
    from: b.from,
    to: b.to,
    impact,
    sourceId: rec.id,
  });
  return leaveList(ctx.db, s);
}
export async function cancelLeave(ctx: Ctx) {
  const s = ctx.session!;
  for (const l of await recList<Leave>(ctx.db, "leave", {
    ownerId: s.id,
    state: "pending",
  })) {
    await recPut(ctx.db, "leave", {
      ...l,
      state: "cancelled",
      data: { ...l.data, status: "cancelled" },
    });
    for (const ap of await recList<{ sourceId?: string }>(ctx.db, "approval", {
      ownerId: s.id,
      state: "pending",
    }))
      if (ap.data.sourceId === l.id)
        await recPut(ctx.db, "approval", {
          ...ap,
          state: "declined",
          data: { ...ap.data, state: "declined" },
        });
  }
  return leaveList(ctx.db, s);
}
export async function contract(db: Exec, s: Session) {
  const a = await me(db, s);
  const c = (
    await recList<{
      type?: string;
      start?: string;
      until?: string;
      status?: string;
    }>(db, "contract", { ownerId: s.id })
  )[0];
  return {
    type:
      c?.data.type ?? (a.external ? "External partner" : "Internal partner"),
    sharePct: a.shareBps / 10_000,
    start: c?.data.start ?? null,
    end: c?.data.until ?? null,
  };
}
const DEFAULT_MATRIX = [
  {
    event: "offers",
    inApp: true,
    sms: true,
    whatsapp: false,
    required: ["inApp"],
  },
  {
    event: "clientMessages",
    inApp: true,
    sms: false,
    whatsapp: true,
    required: [],
  },
  {
    event: "deadlines",
    inApp: true,
    sms: true,
    whatsapp: false,
    required: ["inApp", "sms"],
  },
  {
    event: "reviews",
    inApp: true,
    sms: false,
    whatsapp: false,
    required: ["inApp"],
  },
  { event: "payouts", inApp: true, sms: true, whatsapp: false, required: [] },
];
export async function matrix(db: Exec, s: Session) {
  return { rows: ws(await me(db, s), "notificationMatrix", DEFAULT_MATRIX) };
}
export async function setMatrix(
  db: Exec,
  s: Session,
  rows: ({ event: string; required: string[] } & Record<string, unknown>)[],
) {
  await me(db, s);
  // Required channels can't be switched off; events stay the ones the server knows.
  const known = new Map(DEFAULT_MATRIX.map((r) => [r.event, r]));
  const out = (
    rows as unknown as ({ event: string } & Record<string, unknown>)[]
  )
    .filter((r) => known.has(r.event))
    .map((r) => {
      const d = known.get(r.event)!;
      return {
        ...d,
        inApp: !!r.inApp,
        sms: !!r.sms,
        whatsapp: !!r.whatsapp,
        ...Object.fromEntries(d.required.map((c) => [c, true])),
      };
    });
  await setWs(db, s.id, { notificationMatrix: out });
  return { rows: out };
}
/** `base` = public API origin (API_PUBLIC_URL) or "" for a same-origin path. */
export async function ics(db: Exec, s: Session, base: string) {
  const a = await me(db, s);
  let token = ws<string | null>(a, "icsToken", null);
  if (!token) {
    token = generateId("ics").slice(4);
    await setWs(db, s.id, { icsToken: token });
  }
  return { url: `${base}/api/agent/ics/${token}` };
}
export async function regenerateIcs(db: Exec, s: Session, base: string) {
  await setWs(db, s.id, { icsToken: generateId("ics").slice(4) });
  return ics(db, s, base);
}
/** Public feed by token (calendar apps can't send cookies). */
export async function icsFeed(db: Exec, token: string) {
  const [p] = await db
    .select({ id: agentProfiles.userId })
    .from(agentProfiles)
    .where(sql`${agentProfiles.ws}->>'icsToken' = ${token}`);
  if (!p) throw err.notFound();
  const [u] = await db.select().from(users).where(eq(users.userId, p.id));
  // The token is the credential: act as its owner for RLS in this (public, unauthenticated) tx.
  await db.execute(sql`select set_config('app.user_id', ${p.id}, true), set_config('app.roles', ${u.role}, true)`);
  const cal = await calendar(
    db,
    {
      id: p.id,
      role: u.role,
      roles: [u.role as Session["roles"][number]],
      scopes: { agentId: p.id },
      sid: "ics",
    },
    {},
  );
  const esc = (v: string) =>
    v.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  const d = (x: string) => x.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HEBUZA//Agent//EN",
    ...cal.items.flatMap((i) => [
      "BEGIN:VEVENT",
      `UID:${i.id}@hebuza`,
      `DTSTAMP:${d(iso())}`,
      `DTSTART:${d(i.dueAt)}`,
      `SUMMARY:${esc(`${i.title}${i.code ? ` (${i.code})` : ""}`)}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}


// ── contract extras (openapi /api/agent/{settings,profile,papers}; not in the reference route table) ─────────
const DEFAULT_SETTINGS = {
  accepting_cases: true,
  daily_case_cap: null as number | null,
  notification_new_case: true,
  notification_client_reply: true,
  notification_sla_alert: true,
  notification_daily_summary: false,
  monthly_percent: null as number | null,
  one_off_percent: null as number | null,
  payout_phone: null as string | null,
  payout_bank_name: null as string | null,
  payout_bank_account: null as string | null,
  payout_account_name: null as string | null,
};
type Settings = typeof DEFAULT_SETTINGS;
const settingsOf = (a: AgentRow) => ({
  ...DEFAULT_SETTINGS,
  ...ws<Partial<Settings>>(a, "settings", {}),
  is_on_duty: a.duty === "on",
  default_monthly_percent: Math.round(a.shareBps / 100),
  default_one_off_percent: Math.round(a.shareBps / 100),
});
export async function settings(db: Exec, s: Session) {
  return settingsOf(await me(db, s));
}
export async function setSettings(
  ctx: Ctx,
  b: { [K in keyof Settings]?: Settings[K] | null } & { is_on_duty?: boolean | null },
) {
  const a = await me(ctx.db, ctx.session);
  const { is_on_duty, ...rest } = b;
  // null clears a nullable field; on a boolean it means "unchanged".
  const patch: Record<string, unknown> = Object.fromEntries(
    Object.entries(rest).filter(([k, v]) => v !== undefined && !(v === null && typeof DEFAULT_SETTINGS[k as keyof Settings] === "boolean")),
  );
  // Like onboarding: full account numbers are never stored here, only the last 4 (finance verifies payout accounts).
  if (typeof patch.payout_bank_account === "string")
    patch.payout_bank_account = `•••• ${patch.payout_bank_account.replace(/\D/g, "").slice(-4)}`;
  await setWs(ctx.db, a.id, { settings: { ...ws<Partial<Settings>>(a, "settings", {}), ...patch } });
  if (is_on_duty != null) await setDuty(ctx, { state: is_on_duty ? "on" : "away" });
  return settings(ctx.db, ctx.session);
}
export async function updateProfile(ctx: Ctx, b: { name?: string | null; phone?: string | null }) {
  const a = await me(ctx.db, ctx.session);
  const ob = (await onboarding(ctx.db, ctx.session)) as Record<string, unknown> & { profile: Record<string, unknown> };
  if (b.name?.trim())
    await ctx.db.update(users).set({ name: b.name.trim() }).where(eq(users.userId, a.id));
  // shortcut: the phone is a contact field on the agent profile, not the verified login phone (account module owns that).
  await setWs(ctx.db, a.id, {
    onboarding: {
      ...ob,
      profile: {
        ...ob.profile,
        ...(b.name?.trim() && { name: b.name.trim() }),
        ...(b.phone != null && { phone: b.phone.replace(/^\+250/, "") }),
      },
    },
  });
  return profile(ctx.db, ctx.session);
}

type Paper = {
  documentId: string;
  kind: string;
  status: "pending" | "approved" | "rejected";
  originalFilename: string;
  uploadedAt: string;
  reviewNote: string | null;
  key: string;
};
export async function papers(db: Exec, s: Session) {
  const a = await me(db, s);
  const list = await recList<Paper>(db, "agent_paper", { ownerId: s.id });
  const items = list.map(({ data: { key: _k, ...p } }) => p);
  return {
    agentId: a.id,
    name: a.name,
    cleared: a.clearance === "cleared",
    papersStatus: a.clearance === "cleared" ? "approved" : items.some((p) => p.status === "rejected") ? "rejected" : "pending",
    papersRequired: true,
    papers: items,
  };
}
/** JSON + presigned PUT (files never pass through the API), like documents' case uploads. */
export async function uploadPaper(
  deps: Deps,
  ctx: Ctx,
  b: { kind: string; filename: string; mime: string; size: number },
) {
  const s = ctx.session;
  const key = `u/${s.id}/agent-paper/${randomUUID()}`;
  const upload = await deps.storage.presignPut({ key, contentType: b.mime, size: b.size, purpose: "agent-paper" });
  await deps.scan(ctx.db, key);
  const documentId = generateId("pp");
  await recPut<Paper>(ctx.db, "agent_paper", {
    id: documentId,
    ownerId: s.id,
    state: "pending",
    data: {
      documentId,
      kind: b.kind,
      status: "pending",
      originalFilename: b.filename.replace(/[^\w. -]+/g, "_"),
      uploadedAt: iso(),
      reviewNote: null,
      key,
    },
  });
  ctx.audit = { resourceId: documentId };
  return { ...(await papers(ctx.db, s)), upload };
}
export async function paperUrl(deps: Deps, db: Exec, s: Session, id: string) {
  const p = await recGet<Paper>(db, "agent_paper", id);
  if (!p || p.ownerId !== s.id) throw err.notFound("Paper not found.");
  return deps.storage.presignGet(p.data.key, p.data.originalFilename);
}

/** Monthly statement PDF (dependency-free text PDF, as chat transcripts); records the download. */
export async function statementFile(db: Exec, s: Session, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw err.notFound("No statement for this month");
  const e = await earnings(db, s, month);
  const m = e.months.find((x) => x.month === month);
  if (!m) throw err.notFound("No statement for this month");
  const a = await me(db, s);
  const total = m.paid + m.scheduled + m.pending;
  const pdf = textPdf(`Statement ${month}`, [
    a.name,
    ...e.rows.map((r) => `${r.at.slice(0, 10)}  ${r.ref}  ${r.service}  RWF ${r.amount.toLocaleString("en")}`),
    `Total RWF ${total.toLocaleString("en")}`,
  ]);
  await recPut(db, "statement_dl", { id: `sd:${s.id}:${month}`, ownerId: s.id, data: { month } });
  return pdf;
}
