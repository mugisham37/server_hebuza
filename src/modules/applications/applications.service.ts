// Port of .ref applications.service (client side: submit, list, detail, track) plus the client aggregates
// (/me/dashboard, /me/activity). Query functions take the caller's tx (RLS applies); ApplicationsService runs them.
// Status changes go through `transition()` → the shared machine in @/domain/ops/transitions.
import { statusEffects } from "./status-effects";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomInt, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  applicationDocuments,
  applicationFeedback,
  applicationStatusHistory,
  applications,
  clientSubscriptions,
  conversationParticipants,
  conversations,
  documentRequests,
  deliverables,
  payments,
  servicePricingTiers,
  serviceStructureVersions,
  services,
  subscriptionPlans,
  users,
} from "@/db/schema";
import { can } from "@/domain/auth/permissions";
import {
  CASE_STATUS_META,
  normalizeStatus,
  type CaseStatus,
} from "@/domain/domain/case-status";
import { clientCancelMode, movesFor, type Actor, type CaseFacts } from "@/domain/ops/transitions";
import { openApproval, type Approval } from "../ops/ops.manage";
import { recList } from "../ops/lib/store";
import type { Env } from "../../core/config/env";
import { CryptoService } from "../../core/crypto/crypto.service";
import type { Tx } from "../../core/db/db";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { TxService } from "../../core/db/tx";
import type { SessionUser } from "../../core/http/context";
import { AppError } from "../../core/http/errors";
import { NotificationsService } from "../notifications/notifications.service";
import { PlatformService } from "../platform/platform.service";
import {
  addBusinessDays,
  addDays,
  endOfKigaliDay,
  initialDue,
  kigaliToday,
} from "../deadlines/deadlines.service";
import type { SubmitInput } from "./applications.dto";
import { generateId } from "../../core/db/ids";

const err = {
  notFound: (m: string) => new AppError(404, "not_found", m),
  conflict: (m: string) => new AppError(409, "conflict", m),
  forbidden: (m = "Forbidden") => new AppError(403, "forbidden", m),
};
const roleOf = (s: SessionUser) => s.roles[0] ?? "client";

/** A jsonb row (SQL column names) → the table's TS row shape. Used for SECURITY DEFINER lookups (migration 0006). */
function fromJson<T extends PgTable>(table: T, o: Record<string, unknown>): T["$inferSelect"] {
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(getTableColumns(table))) out[k] = o[c.name] ?? null;
  return out as T["$inferSelect"];
}

export type App = typeof applications.$inferSelect;

/** PLACEHOLDER(payment-due-days): days after submission a fee is shown as due (mocks: 3). */
export const PAYMENT_DUE_DAYS = 3;
export const STEPS = [
  "Request received",
  "Under review",
  "Documents checked",
  "Submitted to institution",
  "Delivered",
] as const;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAID = "succeeded";

// ── pure rules ────────────────────────────────────────────────────────────────────────────────
export const generateTrackingCode = () =>
  `HBZ-${Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("")}`;

/** Rwandan numbers only (Python phonenumbers RW region): mobile 7x and fixed 2x, returned as E.164. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[\s\-().]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("250")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  // shortcut: prefix check, not the full numbering plan; swap for libphonenumber-js if numbers outside 7x/2x appear.
  return /^(7[2389]\d{7}|2[0-9]\d{7})$/.test(d) ? `+250${d}` : null;
}

/** NIDA national ID: 16 digits, first digit 1 (citizen), 2 (refugee) or 3 (foreign resident). */
export const isValidNationalId = (s: string) => /^[123]\d{15}$/.test(s);

/** Progress step 0..5 on the client timeline (5 = all done). */
export function stepOf(s: CaseStatus): number {
  switch (s) {
    case "completed_delivered":
    case "refund_requested":
    case "refunded":
      return 5;
    case "in_progress":
    case "awaiting_internal_review":
    case "awaiting_external_institution":
      return 3;
    case "awaiting_client_documents":
      return 2;
    case "received":
      return 0;
    default:
      return 1;
  }
}

export const isTerminal = (s: CaseStatus) => CASE_STATUS_META[s].terminal;

/** What the client has paid and still owes. Legacy "paid" rows with no payment record count as fully paid. */
export function money(
  a: Pick<App, "paymentAmount" | "paymentStatus">,
  paidSum: number,
) {
  const total = a.paymentAmount ?? 0;
  const paid = a.paymentStatus === "paid" && paidSum === 0 ? total : paidSum;
  return {
    total,
    paid,
    balance: a.paymentStatus === "paid" ? 0 : Math.max(0, total - paid),
  };
}

export function timeline(
  a: Pick<App, "status" | "submittedAt">,
  history: { status: string; createdAt: string }[],
) {
  const at = stepOf(normalizeStatus(a.status));
  const reached = (i: number) =>
    i === 0
      ? a.submittedAt
      : (history
          .filter((h) => stepOf(normalizeStatus(h.status)) >= i)
          .map((h) => h.createdAt)
          .sort()[0] ?? null);
  return STEPS.map((title, i) => ({
    title,
    state: (i < at ? "done" : i === at ? "current" : "upcoming") as
      "done" | "current" | "upcoming",
    at: i <= at ? reached(i) : null,
  }));
}

// ── access ────────────────────────────────────────────────────────────────────────────────────
/** Owner, assignee or an all-cases role; anything else reads as 404 (no existence oracle). */
export function assertCanRead(s: SessionUser | null, a: App) {
  const ok =
    !!s &&
    can({ id: s.id, roles: s.roles }, "req.case.read", {
      ownerId: a.clientId,
      assigneeIds: [a.assignedAgentId, a.assignedPartnerId].filter(
        (x): x is string => !!x,
      ),
    });
  if (!ok) throw err.notFound("Application not found");
}

export async function appByCode(
  db: Tx,
  code: string,
  opts: { forUpdate?: boolean } = {},
) {
  const q = db
    .select()
    .from(applications)
    .where(eq(applications.code, code.trim().toUpperCase()));
  const [a] = opts.forUpdate ? await q.for("update") : await q;
  return a ?? null;
}

/** Cross-owner lookup for the public tracker / guest replay (SECURITY DEFINER, migration 0006). */
export async function publicApp(db: Tx, code: string | null, key: string | null = null) {
  const [r] = await db.execute<{ j: Record<string, unknown> | null }>(
    sql`select public_application(${code?.trim().toUpperCase() ?? null}, ${key}) as j`,
  );
  return r?.j ? fromJson(applications, r.j) : null;
}

export async function readableApp(db: Tx, s: SessionUser | null, code: string) {
  const a = await appByCode(db, code);
  if (!a) throw err.notFound("Application not found");
  assertCanRead(s, a);
  return a;
}

// ── batched loaders (no N+1) ──────────────────────────────────────────────────────────────────
type PaidRow = { code: string; id: string; amount: number; paidAt: string | null; method: string; receipt: string | null };
/** Public tracker: the case's paid rows through the definer function (payments RLS). */
async function publicPaidRows(db: Tx, code: string) {
  const rows = (await db.execute<{ j: Record<string, unknown> }>(sql`select public_paid_payments(${code}) as j`))
    .map((r) => fromJson(payments, r.j))
    .map((p): PaidRow => ({ code: p.applicationCode, id: p.paymentId, amount: p.amountRwf, paidAt: p.paidAt, method: p.method, receipt: p.receiptNumber }));
  return new Map([[code, rows]]);
}

export async function paidRows(db: Tx, codes: string[]) {
  if (!codes.length)
    return new Map<
      string,
      {
        id: string;
        amount: number;
        paidAt: string | null;
        method: string;
        receipt: string | null;
      }[]
    >();
  const rows = await db
    .select({
      code: payments.applicationCode,
      id: payments.paymentId,
      amount: payments.amountRwf,
      paidAt: payments.paidAt,
      method: payments.method,
      receipt: payments.receiptNumber,
    })
    .from(payments)
    .where(
      and(inArray(payments.applicationCode, codes), eq(payments.status, PAID)),
    )
    .orderBy(asc(payments.paidAt));
  const m = new Map<string, typeof rows>();
  for (const r of rows) m.set(r.code, [...(m.get(r.code) ?? []), r]);
  return m;
}

const userNames = async (db: Tx, ids: (string | null)[]) => {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map<string, string>();
  return new Map(
    (
      await db
        .select({ id: users.userId, name: users.name })
        .from(users)
        .where(inArray(users.userId, want))
    ).map((r) => [r.id, r.name]),
  );
};

async function hasRetainer(db: Tx, clientId: string) {
  const [r] = await db
    .select({ n: count() })
    .from(clientSubscriptions)
    .innerJoin(
      subscriptionPlans,
      eq(subscriptionPlans.planId, clientSubscriptions.planId),
    )
    .where(
      and(
        eq(clientSubscriptions.clientId, clientId),
        inArray(clientSubscriptions.status, ["active", "trial"]),
        eq(subscriptionPlans.kind, "retainer"),
      ),
    );
  return r.n > 0;
}

// ── projections ───────────────────────────────────────────────────────────────────────────────
export const summary = (
  a: App,
  agentName: string | null,
  retainer: boolean,
) => ({
  application_id: a.applicationId,
  code: a.code,
  service_name: a.serviceName,
  service_slug: a.serviceSlug,
  status: normalizeStatus(a.status),
  tier: a.tier,
  submitted_at: a.submittedAt,
  payment_status: a.paymentStatus,
  handler: a.handler,
  ending: a.ending,
  retainer,
  assigned_agent_name: agentName,
});

const dueFor = (a: App) =>
  addDays(a.submittedAt.slice(0, 10), PAYMENT_DUE_DAYS) + "T23:59:59.000Z";

function needsFor(
  a: App,
  reqs: (typeof documentRequests.$inferSelect)[],
  balance: number,
) {
  const st = normalizeStatus(a.status);
  if (isTerminal(st)) return [];
  return [
    ...reqs
      .filter((r) => !r.fulfilledAt || st === "awaiting_client_documents")
      .map((r) => ({
        id: r.id,
        kind: "document" as const,
        code: a.code,
        service: a.serviceName,
        label: r.label,
        dueAt: r.dueAt,
        done: !!r.fulfilledAt,
      })),
    ...(balance > 0 && a.ending === "payable"
      ? [
          {
            id: `${a.code}-pay`,
            kind: "payment" as const,
            code: a.code,
            service: a.serviceName,
            label: "Service fee",
            amount: balance,
            dueAt: dueFor(a),
          },
        ]
      : []),
  ];
}

function paymentsFor(
  a: App,
  rows: { id: string; amount: number; paidAt: string | null }[],
  balance: number,
) {
  const m = money(
    a,
    rows.reduce((s, r) => s + r.amount, 0),
  );
  const base = { label: "Service fee", code: a.code, service: a.serviceName };
  const paid = rows.length
    ? rows.map((r) => ({
        id: r.id,
        ...base,
        amount: r.amount,
        status: "paid" as const,
        paidAt: r.paidAt,
        dueAt: null,
      }))
    : m.paid > 0
      ? [
          {
            id: `${a.code}-p1`,
            ...base,
            amount: m.paid,
            status: "paid" as const,
            paidAt: a.submittedAt,
            dueAt: null,
          },
        ]
      : [];
  return [
    ...paid,
    ...(balance > 0
      ? [
          {
            id: `${a.code}-due`,
            ...base,
            amount: balance,
            status: "due" as const,
            paidAt: null,
            dueAt: dueFor(a),
          },
        ]
      : []),
  ];
}

/** Everything the client pages need for a set of cases, in a fixed number of queries. */
async function loadCaseBundle(db: Tx, apps: App[], pub = false) {
  const ids = apps.map((a) => a.applicationId);
  const [paid, reqs, names] = await Promise.all([
    pub ? publicPaidRows(db, apps[0].code) : paidRows(db, apps.map((a) => a.code)),
    ids.length
      ? db
          .select()
          .from(documentRequests)
          .where(inArray(documentRequests.applicationId, ids))
          .orderBy(asc(documentRequests.createdAt))
      : [],
    userNames(
      db,
      apps.map((a) => a.assignedAgentId),
    ),
  ]);
  return apps.map((a) => {
    const pr = paid.get(a.code) ?? [];
    const { balance } = money(
      a,
      pr.reduce((s, r) => s + r.amount, 0),
    );
    return {
      a,
      pr,
      balance,
      reqs: reqs.filter((r) => r.applicationId === a.applicationId),
      agent: a.assignedAgentId ? (names.get(a.assignedAgentId) ?? null) : null,
    };
  });
}

const clientApps = (db: Tx, clientId: string) =>
  db
    .select()
    .from(applications)
    .where(eq(applications.clientId, clientId))
    .orderBy(desc(applications.submittedAt));

// ── client reads ──────────────────────────────────────────────────────────────────────────────
export async function listClientApplications(db: Tx, s: SessionUser) {
  const [apps, retainer] = await Promise.all([
    clientApps(db, s.id),
    hasRetainer(db, s.id),
  ]);
  const names = await userNames(
    db,
    apps.map((a) => a.assignedAgentId),
  );
  return {
    applications: apps.map((a) =>
      summary(
        a,
        a.assignedAgentId ? (names.get(a.assignedAgentId) ?? null) : null,
        retainer,
      ),
    ),
  };
}

/** Unread case conversations for the dashboard badge (chat tables, read-only here). */
export async function unreadConversations(db: Tx, userId: string) {
  const [r] = await db
    .select({ n: count() })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversations.conversationId, conversationParticipants.conversationId),
    )
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt),
        gt(conversations.lastSeq, conversationParticipants.lastReadSeq),
      ),
    );
  return r.n;
}

export async function dashboard(db: Tx, s: SessionUser) {
  const [apps, retainer, unread] = await Promise.all([
    clientApps(db, s.id),
    hasRetainer(db, s.id),
    unreadConversations(db, s.id),
  ]);
  const bundle = await loadCaseBundle(db, apps);
  return {
    // Documents before payments (what blocks the work first), newest case first within each kind.
    needs: bundle.flatMap((b) => needsFor(b.a, b.reqs, b.balance)).sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "document" ? -1 : 1)),
    requests: bundle.map((b) => summary(b.a, b.agent, retainer)),
    paymentsDue: bundle
      .flatMap((b) => paymentsFor(b.a, b.pr, b.balance))
      .filter((p) => p.status === "due"),
    unread,
  };
}

/** External outcome as the client sees it: the agent's recorded outcome (REQ-06), else derived from status. */
const outcomeOf = (s: CaseStatus, a?: App) =>
  a?.externalOutcome ?? (s === "completed_delivered"
    ? "approved"
    : s === "rejected"
      ? "rejected"
      : s === "in_progress" || s === "awaiting_external_institution"
        ? "pending"
        : "none");

export async function clientDetail(db: Tx, s: SessionUser | null, code: string) {
  const a = await readableApp(db, s, code);
  const [[b], history, files, retainer] = await Promise.all([
    loadCaseBundle(db, [a]),
    db
      .select({
        status: applicationStatusHistory.status,
        createdAt: applicationStatusHistory.createdAt,
      })
      .from(applicationStatusHistory)
      .where(eq(applicationStatusHistory.applicationId, a.applicationId)),
    db
      .select()
      .from(deliverables)
      .where(
        and(
          eq(deliverables.applicationId, a.applicationId),
          isNotNull(deliverables.releasedAt),
        ),
      )
      .orderBy(asc(deliverables.createdAt)),
    a.clientId ? hasRetainer(db, a.clientId) : false,
  ]);
  const st = normalizeStatus(a.status);
  return {
    ...summary(a, b.agent, retainer),
    personal_info: a.personalInfo as Record<string, unknown>,
    service_data: a.serviceData as Record<string, unknown>,
    // The balance while one is due; the full total once paid (the receipt headline) — flow mock contract.
    payment_amount:
      a.paymentAmount == null ? null : b.balance || a.paymentAmount,
    status_display: st
      .replace(/_/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase()),
    assignee_name: b.agent,
    outcome: outcomeOf(st, a),
    outcome_ref: a.externalOutcomeRef,
    outcome_institution: a.externalOutcomeInstitution,
    outcome_at: a.externalOutcomeAt,
    cancel_mode: clientCancelMode(st),
    needs: needsFor(a, b.reqs, b.balance),
    payments: paymentsFor(a, b.pr, b.balance),
    timeline: timeline(a, history).map((t, i) => ({
      id: `${a.code}-s${i}`,
      ...t,
    })),
    deliverables: files.map((f) => ({
      id: f.id,
      name: f.title,
      size: f.fileSizeBytes,
      released: true,
      at: f.releasedAt!,
    })),
  };
}

// ── submit ────────────────────────────────────────────────────────────────────────────────────
const ALIASES: Record<string, string[]> = {
  fullName: ["fullName", "full_name", "name"],
  nationalId: ["nationalId", "national_id", "nid"],
  dob: ["dob", "date_of_birth", "birth_date"],
  phone: ["phone", "mobile", "phone_number"],
  email: ["email"],
};

// loc ["body", "personal_info.<field>"] (the filter's detail shape); reference sent ["body","personal_info",field].
const validationAt = (field: string, msg: string) =>
  new AppError(422, "validation", msg, { [`personal_info.${field}`]: msg });

/** Identity from personal_info, filled from the admin-designed answers when the wizard did not collect it. */
export function coalesceIdentity(
  pi: SubmitInput["personal_info"],
  sd: Record<string, unknown>,
) {
  const info: Record<string, unknown> = { ...pi };
  for (const [field, keys] of Object.entries(ALIASES)) {
    const cur = info[field];
    if (typeof cur === "string" && cur.trim()) continue;
    const hit = keys.map((k) => sd[k]).find((v) => typeof v === "string" && v.trim());
    if (typeof hit === "string") info[field] = hit.trim();
  }
  const fullName = String(info.fullName ?? "").trim();
  if (fullName.length < 2) throw validationAt("fullName", "Full name is required.");
  const phone = normalizePhone(String(info.phone ?? ""));
  if (!phone)
    throw validationAt("phone", info.phone ? "Invalid phone number." : "Mobile phone number is required.");
  const nid = String(info.nationalId ?? "").trim();
  if (nid && !isValidNationalId(nid)) throw validationAt("nationalId", "This national ID isn't valid.");
  return { ...info, fullName, phone, nationalId: nid, email: typeof info.email === "string" ? info.email.trim() : "" };
}

function replay(a: App, input: SubmitInput, s: SessionUser | null) {
  // Only the same person gets an earlier submission back (Python _replay_submission).
  const same = s
    ? a.clientId === s.id
    : !a.clientId &&
      normalizePhone(String((a.personalInfo as Record<string, unknown>)?.phone ?? "")) ===
        normalizePhone(String(input.personal_info.phone ?? input.service_data?.phone ?? ""));
  if (!same) throw err.conflict("This submission key was already used.");
  return {
    application_id: a.applicationId,
    code: a.code,
    service_name: a.serviceName,
    tier: a.tier,
    payment_required: a.paymentStatus === "pending" && !!a.paymentAmount,
    ending: a.ending,
    replayed: true,
    notified: [] as string[],
    matches_account: false,
  };
}

/** Owner or guest lookup by idempotency key (guests cannot read applications directly). */
const byKey = (db: Tx, s: SessionUser | null, key: string) =>
  s
    ? db.select().from(applications).where(eq(applications.idempotencyKey, key)).then((r) => r[0] ?? null)
    : publicApp(db, null, key);

type Settings = { guestApps: boolean; acceptNewApps: boolean; maintenanceMode: boolean };

/** Validates, prices and inserts the case (+ history). Side effects (notify, mail) are left to the caller's tx. */
export async function submitTx(db: Tx, s: SessionUser | null, input: SubmitInput, ip: string | null, settings: Settings) {
  if (s) {
    const [u] = await db.select({ v: users.isEmailVerified }).from(users).where(eq(users.userId, s.id));
    if (!u?.v) throw new AppError(403, "unverified", "Verify your account first.");
  }
  if (settings.maintenanceMode)
    throw new AppError(422, "validation", "The platform is in maintenance mode. Submissions are paused.");
  if (!settings.acceptNewApps)
    throw new AppError(422, "validation", "New application submissions are currently disabled.");
  if (!s && !settings.guestApps) throw new AppError(422, "validation", "Sign in to submit an application.");

  const key = input.idempotency_key?.trim() || null;
  if (key) {
    const prev = await byKey(db, s, key);
    if (prev) return { out: replay(prev, input, s), info: null, svc: null };
  }

  const [svc] = await db
    .select()
    .from(services)
    .where(and(eq(services.slug, input.service_slug), eq(services.status, "published")));
  if (!svc) throw err.notFound("Service not found.");
  const handler = svc.handler || "agent";
  if (handler === "partner" && !s)
    throw new AppError(
      422,
      "validation",
      "Create an account or sign in before requesting this service. The price is agreed with you, so we need somewhere to send it.",
    );

  let tierName = input.tier.trim().toLowerCase();
  const urgent = !!input.is_urgent || tierName === "urgent";
  if (urgent) tierName = "urgent";
  const [tier] = await db
    .select()
    .from(servicePricingTiers)
    .where(and(eq(servicePricingTiers.serviceId, svc.serviceId), eq(servicePricingTiers.tier, tierName)));
  if (!tier?.isAvailable)
    throw new AppError(
      422,
      "validation",
      urgent ? "Urgent handling is not available for this service." : "Selected pricing tier is not available.",
    );

  const now = new Date();
  const today = kigaliToday(now);
  const preferred = input.preferred_date ?? null;
  if (preferred) {
    const earliest = addBusinessDays(today, tier.etaBusinessDays);
    if (preferred < earliest)
      throw new AppError(
        422,
        "validation",
        `The earliest date we can promise is ${earliest} (${tier.etaBusinessDays} working days).`,
      );
    if (preferred > addDays(today, 730))
      throw new AppError(422, "validation", "Choose a date within the next two years.");
  }
  const [structure] = await db
    .select({ id: serviceStructureVersions.id })
    .from(serviceStructureVersions)
    .where(and(eq(serviceStructureVersions.serviceId, svc.serviceId), eq(serviceStructureVersions.status, "published")))
    .orderBy(desc(serviceStructureVersions.version))
    .limit(1);
  if (!structure) throw new AppError(422, "validation", "Service is not ready for applications.");

  const serviceData: Record<string, unknown> = { ...(input.service_data ?? {}) };
  // shortcut: answers are not yet validated against the structure definition (Python validate_service_data); lands with the catalogue builder.
  const info = coalesceIdentity(input.personal_info, serviceData);
  serviceData.full_name ??= info.fullName;
  serviceData.phone ??= info.phone;

  // The fee is always worked out here; nothing fee-like from the client is read.
  const fee = tier.platformFee + tier.governmentFee;
  // shortcut: "range" pricing and plan coverage are quoted by hand / paid like everyone else until pricing bands + subscriptions coverage land.
  const quoted = handler === "agent" && (svc.pricingMode === "quote" || svc.pricingMode === "range");
  const priced =
    handler === "partner"
      ? { ending: "partner", required: false, amount: null, status: "negotiating" }
      : quoted
        ? { ending: "quote", required: false, amount: null, status: "negotiating" }
        : fee > 0
          ? { ending: "payable", required: true, amount: fee, status: "pending" }
          : { ending: "covered", required: false, amount: 0, status: "paid" };
  const due = await initialDue(db, svc, preferred, now);
  const ts = now.toISOString();
  let code = generateTrackingCode();
  for (let i = 0; i < 5 && (await publicApp(db, code)); i++) code = generateTrackingCode();

  const row: typeof applications.$inferInsert = {
    applicationId: generateId("app"),
    code,
    serviceId: svc.serviceId,
    structureVersionId: structure.id,
    serviceSlug: svc.slug,
    serviceName: svc.name,
    tier: tier.tier,
    status: "received",
    handler,
    ending: priced.ending,
    clientId: s?.id ?? null,
    quoteStatus: handler === "partner" || priced.ending === "quote" ? "waiting" : null,
    personalInfo: info,
    serviceData,
    paymentStatus: priced.status,
    paymentAmount: priced.amount,
    submissionIp: ip,
    idempotencyKey: key,
    slaDeadline: endOfKigaliDay(addBusinessDays(today, tier.etaBusinessDays)),
    dueAt: due.dueAt,
    dueSource: due.dueSource,
    clientPreferredDate: preferred,
    isUrgent: urgent,
    partnerClientLaneOpen: false,
    submittedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  };
  // No RETURNING: guests may insert (policy guest_insert) but not read the row back.
  // A racing identical submit loses on uq_applications_idempotency_key; hand back what the winner created.
  await db.insert(applications).values(row).onConflictDoNothing();
  const mine = await publicApp(db, code);
  if (mine?.applicationId !== row.applicationId) {
    const prev = key ? await byKey(db, s, key) : null;
    if (prev) return { out: replay(prev, input, s), info: null, svc: null };
    throw err.conflict("Please try again.");
  }
  await db.insert(applicationStatusHistory).values({
    id: generateId("ash"),
    applicationId: row.applicationId!,
    status: "received",
    changedBy: s?.id ?? null,
    changedByRole: s ? roleOf(s) : "guest",
    note: "Application submitted.",
    createdAt: ts,
  });

  // shortcut: dedicated-agent routing and the guest-match flag (Python _route_to_dedicated/_raise_flag) arrive with ops.
  let matches = false;
  if (!s) {
    const [hit] = await db
      .select({ n: count() })
      .from(users)
      .where(
        and(
          eq(users.role, "client"),
          or(eq(users.phoneE164, info.phone), info.email ? eq(users.email, info.email.toLowerCase()) : undefined),
        ),
      );
    matches = hit.n > 0;
  }
  return {
    out: {
      application_id: row.applicationId!,
      code,
      service_name: svc.name,
      tier: tier.tier,
      payment_required: priced.required,
      ending: priced.ending,
      replayed: false,
      notified: [] as string[],
      matches_account: matches,
    },
    info,
    svc,
  };
}

// ── status changes (the shared machine) ───────────────────────────────────────────────────────
/**
 * Move a case through @/domain/ops/transitions (never re-implemented here). `facts` = what the guards need
 * beyond the status. Optimistic: the update only applies if the status is still the one the facts were built on.
 */
export async function transitionTx(
  db: Tx,
  me: SessionUser | null,
  a: App,
  to: CaseStatus,
  actor: Actor,
  facts: Omit<CaseFacts, "status"> = {},
  note: string | null = null,
) {
  const from = normalizeStatus(a.status);
  const move = movesFor({ ...facts, status: from }, actor).find((m) => m.to === to);
  if (!move) throw new AppError(409, "invalid_transition", `Cannot move from ${from} to ${to}.`, undefined, { from, to });
  if (move.blocked) throw new AppError(409, "transition_blocked", "This move is blocked.", undefined, { guard: move.blocked });
  if (move.reason && !note?.trim()) throw new AppError(422, "validation", "A reason is required.", { reason: "A reason is required." });
  const ts = new Date().toISOString();
  const done = await db
    .update(applications)
    .set({ status: to, updatedAt: ts, ...(to === "completed_delivered" ? { completedAt: ts } : {}), ...statusEffects(to) })
    .where(and(eq(applications.applicationId, a.applicationId), eq(applications.status, a.status)))
    .returning({ id: applications.applicationId });
  if (!done.length) throw err.conflict("The case changed meanwhile. Reload and try again.");
  await db.insert(applicationStatusHistory).values({
    id: generateId("ash"),
    applicationId: a.applicationId,
    status: to,
    changedBy: me?.id ?? null,
    changedByRole: me ? roleOf(me) : "system",
    note,
    createdAt: ts,
  });
  return { from, to };
}

// ── /me/activity ──────────────────────────────────────────────────────────────────────────────
export async function activity(db: Tx, s: SessionUser, year?: string) {
  const apps = await db
    .select()
    .from(applications)
    .where(eq(applications.clientId, s.id));
  if (!apps.length) return { items: [] };
  const byId = new Map(apps.map((a) => [a.applicationId, a]));
  const byCode = new Map(apps.map((a) => [a.code, a]));
  const [hist, paid, dl] = await Promise.all([
    db
      .select()
      .from(applicationStatusHistory)
      .where(
        and(
          inArray(applicationStatusHistory.applicationId, [...byId.keys()]),
          inArray(applicationStatusHistory.status, [
            "completed",
            "completed_delivered",
          ]),
        ),
      ),
    paidRows(db, [...byCode.keys()]),
    db
      .select()
      .from(deliverables)
      .where(
        and(
          inArray(deliverables.applicationId, [...byId.keys()]),
          isNotNull(deliverables.releasedAt),
        ),
      ),
  ]);
  type Item = {
    id: string;
    at: string;
    kind: string;
    title: string;
    slug?: string;
    ref: string | null;
    amount: number | null;
  };
  const items: Item[] = [
    ...hist.map((h) => {
      const a = byId.get(h.applicationId)!;
      return {
        id: h.id,
        at: h.createdAt,
        kind: "request",
        title: `${a.serviceName} completed`,
        slug: a.serviceSlug,
        ref: a.code,
        amount: null,
      };
    }),
    ...[...paid].flatMap(([code, rows]) =>
      rows.map((p) => ({
        id: p.id,
        at: p.paidAt ?? "",
        kind: "payment",
        title: `Payment for ${byCode.get(code)!.serviceName}`,
        slug: byCode.get(code)!.serviceSlug, // every row can offer "Request again"
        ref: code,
        amount: p.amount,
      })),
    ),
    ...dl.map((d) => ({
      id: d.id,
      at: d.releasedAt!,
      kind: "document",
      title: `${d.title} delivered`,
      slug: byId.get(d.applicationId)!.serviceSlug,
      ref: byId.get(d.applicationId)!.code,
      amount: null,
    })),
  ];
  // shortcut: account events (password changes…) come from the audit log once P1 exposes a client-safe view of it.
  return {
    items: items
      .filter((i) => i.at && (!year || i.at.startsWith(year)))
      .sort((x, y) => y.at.localeCompare(x.at)),
  };
}

// ── public tracker ────────────────────────────────────────────────────────────────────────────
const trackStatus = (st: CaseStatus) =>
  st === "completed_delivered"
    ? "completed"
    : isTerminal(st)
      ? st
      : CASE_STATUS_META[st].waitingOnClient
        ? "action_needed"
        : "in_progress";

export async function track(db: Tx, code: string) {
  const a = /^HBZ-[A-Z0-9]{6}$/i.test(code.trim())
    ? await publicApp(db, code)
    : null;
  if (!a) throw err.notFound("Not found."); // same copy for unknown and malformed codes (no existence oracle)
  const st = normalizeStatus(a.status);
  const history = await db
    .select({
      status: applicationStatusHistory.status,
      createdAt: applicationStatusHistory.createdAt,
    })
    .from(applicationStatusHistory)
    .where(eq(applicationStatusHistory.applicationId, a.applicationId));
  const step = Math.min(stepOf(st), STEPS.length - 1);
  return {
    code: a.code,
    service_name: a.serviceName,
    status: trackStatus(st),
    current_step_number: step + 1,
    current_step_title: stepOf(st) >= STEPS.length ? null : STEPS[step],
    estimated_completion: (a.dueAt ?? a.slaDeadline)?.slice(0, 10) ?? null,
    submitted_at: a.submittedAt,
    updated_at: [a.updatedAt, ...history.map((h) => h.createdAt)]
      .sort()
      .at(-1)!,
  };
}

const sameContact = (contact: string, ...known: unknown[]) => {
  const c = contact.replace(/\s/g, "").toLowerCase();
  if (!c) return false;
  const phone = normalizePhone(c);
  return known.some(
    (k) =>
      typeof k === "string" &&
      k &&
      (k.toLowerCase() === c || (!!phone && normalizePhone(k) === phone)),
  );
};

const METHOD_LABEL: Record<string, string> = {
  momo: "MoMo",
  mtn_momo: "MoMo",
  card: "Card",
  bank_transfer: "Bank transfer",
  airtel: "Airtel Money",
};

/** Phone or email on the case unlocks the detail view (no account needed). */
export async function verifyTrack(db: Tx, code: string, contact: string) {
  const a = await publicApp(db, code);
  const pi = (a?.personalInfo ?? {}) as Record<string, unknown>;
  const [owner] = a?.clientId
    ? await db
        .select({ email: users.email, phone: users.phoneE164 })
        .from(users)
        .where(eq(users.userId, a.clientId))
    : [];
  if (
    !a ||
    !sameContact(contact, pi.phone, pi.email, owner?.email, owner?.phone)
  )
    throw new AppError(403, "forbidden", "Does not match.");
  const st = normalizeStatus(a.status);
  const [[b], history, docs] = await Promise.all([
    loadCaseBundle(db, [a], true),
    db
      .select({
        status: applicationStatusHistory.status,
        createdAt: applicationStatusHistory.createdAt,
      })
      .from(applicationStatusHistory)
      .where(eq(applicationStatusHistory.applicationId, a.applicationId)),
    db
      .select({
        key: applicationDocuments.requirementKey,
        qc: applicationDocuments.qcStatus,
      })
      .from(applicationDocuments)
      .where(
        and(
          eq(applicationDocuments.applicationId, a.applicationId),
          // Active versions plus fresh uploads still awaiting QC, so the client sees what they just sent.
          sql`(${applicationDocuments.isActive} or (${applicationDocuments.qcStatus} = 'pending' and ${applicationDocuments.replacedBy} is null and ${applicationDocuments.removedAt} is null))`,
        ),
      ),
  ]);
  const m = money(
    a,
    b.pr.reduce((s2, r) => s2 + r.amount, 0),
  );
  const last = b.pr.at(-1);
  const openReqs = b.reqs.filter((r) => !r.fulfilledAt);
  return {
    // shortcut: an opaque, unstored token — nothing consumes it yet; store it in Redis when a follow-up endpoint needs it.
    token: randomUUID(),
    expires_in: 600,
    detail: {
      timeline: timeline(a, history).map((t) => ({
        title: t.title,
        at: t.at ?? "",
        state: (t.state === "upcoming" ? "todo" : t.state) as "done" | "current" | "todo",
        ...(t.state === "current" && openReqs.length
          ? {
              note: `${openReqs.length} document${openReqs.length > 1 ? "s" : ""} missing`,
            }
          : {}),
      })),
      needed: [
        ...openReqs.map((r) => ({ kind: "upload" as const, label: r.label })),
        ...(b.balance > 0
          ? [{ kind: "pay" as const, label: "Balance", amount: b.balance }]
          : []),
      ],
      payment: {
        paid: m.paid,
        due: b.balance,
        method: last ? (METHOD_LABEL[last.method] ?? last.method) : "",
        ...(last?.receipt ? { receipt: last.receipt } : {}),
      },
      // shortcut: the institution is not modelled per case yet (PLACEHOLDER(case-institution)); the service category stands in.
      institution: {
        name:
          (
            await db
              .select({ c: services.category })
              .from(services)
              .where(eq(services.serviceId, a.serviceId))
          )[0]?.c.toUpperCase() ?? "",
        decision:
          st === "completed_delivered"
            ? "Approved"
            : st === "rejected"
              ? "Rejected"
              : stepOf(st) >= 3
                ? "Pending"
                : "Not submitted yet",
      },
      documents: docs.map((d) => ({
        name: d.key
          .replace(/[_-]/g, " ")
          .replace(/^\w/, (c) => c.toUpperCase()),
        verified: d.qc === "accepted",
      })),
    },
  };
}

// ── deliverable review (client side) ──────────────────────────────────────────────────────────
export async function recordFeedback(
  db: Tx,
  applicationId: string,
  patch: Partial<typeof applicationFeedback.$inferInsert>,
) {
  await db
    .insert(applicationFeedback)
    .values({ applicationId, ...patch })
    .onConflictDoUpdate({
      target: applicationFeedback.applicationId,
      set: patch,
    });
}

// ── service ───────────────────────────────────────────────────────────────────────────────────
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly tx: TxService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly crypto: CryptoService,
    private readonly notifications: NotificationsService,
    private readonly platform: PlatformService,
    private readonly cfg: ConfigService<Env, true>,
  ) {}

  private get origin() {
    return this.cfg.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim();
  }

  dashboard(s: SessionUser) {
    return this.tx.run((db) => dashboard(db, s));
  }
  activity(s: SessionUser, year?: string) {
    return this.tx.run((db) => activity(db, s, year));
  }
  list(s: SessionUser) {
    return this.tx.run((db) => listClientApplications(db, s));
  }
  detail(s: SessionUser, code: string) {
    return this.tx.run((db) => clientDetail(db, s, code));
  }
  track(code: string) {
    return this.tx.run((db) => track(db, code));
  }

  /** REQ-11: the owner cancels before work starts, or asks a manager to (ops approvals, kind "cancel") once it has. */
  cancel(s: SessionUser, code: string, reason: string) {
    return this.tx.run(async (db) => {
      const a = await appByCode(db, code, { forUpdate: true });
      if (!a || a.clientId !== s.id) throw err.notFound("Application not found");
      const mode = clientCancelMode(normalizeStatus(a.status));
      if (mode === "cancel") {
        await this.transition(db, s, a, "cancelled", "client", { workStarted: false }, reason);
        await db.update(applications).set({ cancellationReason: reason }).where(eq(applications.applicationId, a.applicationId));
        // shortcut: a paid case needs a refund request (RFD); finance owns that flow, ops sees the cancelled+paid case meanwhile.
        return { state: "cancelled" as const };
      }
      if (mode === "request") {
        const open = (await recList<Approval>(db, "approval")).some((r) => r.data.kind === "cancel" && r.data.ref === a.code && r.data.state === "pending");
        if (!open) await openApproval(db, { kind: "cancel", agentId: s.id, reason, ref: a.code, service: a.serviceName });
        await this.audit.record(db, { action: "application.cancel_requested", entity: "application", entityId: a.applicationId, reason });
        return { state: "requested" as const };
      }
      throw new AppError(409, "invalid_transition", "This request can no longer be cancelled.");
    });
  }
  verifyTrack(code: string, contact: string) {
    return this.tx.run((db) => verifyTrack(db, code, contact));
  }

  /** For other modules: the case if `me` may read it (owner, assignee, all-cases role), else 404. Runs in the caller's tx. */
  getForActor(db: Tx, me: SessionUser, code: string, opts: { forUpdate?: boolean } = {}) {
    return appByCode(db, code, opts).then((a) => {
      if (!a) throw err.notFound("Application not found");
      assertCanRead(me, a);
      return a;
    });
  }

  /** For other modules: status change through the shared machine + audit + client notification, in the caller's tx. */
  async transition(
    db: Tx,
    me: SessionUser | null,
    a: App,
    to: CaseStatus,
    actor: Actor,
    facts: Omit<CaseFacts, "status"> = {},
    note: string | null = null,
  ) {
    const r = await transitionTx(db, me, a, to, actor, facts, note);
    if (a.clientId)
      await this.notifications.notify(db, {
        userId: a.clientId,
        kind: "status_update",
        title: `${a.serviceName} · ${a.code}`,
        body: CASE_STATUS_META[to].waitingOnClient ? "Your request needs your action." : `Status: ${to.replace(/_/g, " ")}.`,
        link: `/requests/${a.code}`,
      });
    await this.audit.record(db, { action: "application.status_changed", entity: "application", entityId: a.applicationId, before: { status: r.from }, after: { status: to }, reason: note ?? undefined });
    return r;
  }

  async submit(s: SessionUser | null, input: SubmitInput, ip: string | null) {
    const settings = await this.platform.getPublicSettings();
    return this.tx.run(async (db) => {
      const r = await submitTx(db, s, input, ip, settings);
      if (!r.info || !r.svc) return r.out;
      const { code } = r.out;
      if (s)
        await this.notifications.notify(db, {
          userId: s.id,
          kind: "status_update",
          title: `Request received · ${code}`,
          body: `${r.svc.name} is with our team.`,
          link: `/requests/${code}`,
        });
      const email = r.info.email.includes("@") ? r.info.email : null;
      if (email) {
        // Reuses the auth mail job (sealed text: the tracking code unlocks the case with the contact).
        await this.outbox.add(db, {
          type: "auth.mail",
          queue: "critical",
          payload: this.crypto.seal(
            {
              to: email,
              subject: `Your Hebuza tracking code: ${code}`,
              text: `Hello ${r.info.fullName},\n\nYour ${r.svc.name} application is with our team. Keep this tracking code to follow it at any time: ${code}\n\n${this.origin}/track/${code}`,
            },
            ["text"],
          ),
        });
        r.out.notified.push("email");
      }
      await this.audit.record(db, { action: "application.submitted", entity: "application", entityId: r.out.application_id, after: { code } });
      return r.out;
    });
  }
}
