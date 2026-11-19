// Port of the reference subscriptions.service.ts (client + public + payment side). Query functions kept as-is (taking a
// tx); SubscriptionsService runs them. activateFromPayment / startTrialForClient / coverageFor / assertCanSubmit take the
// caller's tx so payments, auth and booking stay atomic.
// shortcut: admin plan CRUD (/api/admin/subscriptions*) is not ported (none in the reference either); when added, call
// PublicCache.bust("plans") after each write.
import { Injectable } from "@nestjs/common";
import { and, asc, count, eq, gte, inArray, lte } from "drizzle-orm";
import { applications, clientSubscriptions, subscriptionPlans, users } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { AppError } from "../../core/http/errors";
import { PublicCache } from "../catalogue/cache";
import { generateId } from "../../core/db/ids";
import { prorate } from "@/domain/finance/money";

type Exec = Tx;
const err = { notFound: (m: string) => new AppError(404, "not_found", m) };
export const PERIOD_MS = 30 * 86_400_000;
export const TRIAL_PLAN_ID = "pln_trial_default";
/** past_due keeps coverage through the grace window (F-SUB-06). */
const LIVE = new Set(["active", "trial", "past_due"]);
export const GRACE_DAYS = 7;
/** Days relative to period end: renewal reminders before, dunning after (F-SUB-05). */
export const REMINDER_OFFSETS = [-7, -3, 0, 3, 7];
const DAY_MS = 86_400_000;
/** Postgres returns "2026-01-01 10:00:00+00"; the API speaks ISO 8601. */
export const iso = <T extends string | null>(v: T): T => (v ? new Date(v).toISOString() : v) as T;

type Plan = typeof subscriptionPlans.$inferSelect;
type Sub = typeof clientSubscriptions.$inferSelect;

/** Why a plan is or is not listed on /pricing and the client plan page (one rule for both). */
export function planVisibility(
  p: Pick<Plan, "archivedAt" | "isActive" | "kind" | "isPublic">,
) {
  if (p.archivedAt) return "archived" as const;
  if (!p.isActive) return "inactive" as const;
  if (p.kind === "trial") return "trial" as const;
  if (!p.isPublic) return "hidden" as const;
  return "listed" as const;
}

export function unavailableReason(
  p: Pick<Plan, "archivedAt" | "isActive" | "kind" | "amountRwf">,
) {
  if (p.archivedAt) return "archived" as const;
  if (!p.isActive) return "inactive" as const;
  if (p.kind === "trial") return "trial" as const;
  if (p.amountRwf <= 0) return "free" as const;
  return null;
}

export function planOut(p: Plan) {
  const visibility = planVisibility(p);
  return {
    planId: p.planId,
    name: p.name,
    interval: p.interval,
    amountRwf: p.amountRwf,
    isActive: p.isActive,
    kind: p.kind,
    maxApplicationsPerMonth: p.maxApplicationsPerMonth,
    trialDays: p.trialDays,
    description: p.description,
    features: Array.isArray(p.features) ? p.features.map(String) : [],
    badge: p.badge,
    sortOrder: p.sortOrder,
    isPublic: p.isPublic,
    onPricing: visibility === "listed",
    visibility,
    archivedAt: iso(p.archivedAt),
    isSignupTrial: p.planId === TRIAL_PLAN_ID,
    liveSubscribers: null,
    everUsed: null,
  };
}

export const getPlan = (db: Exec, id: string) =>
  db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.planId, id))
    .then((r) => r[0]);

export async function listPublicPlans(db: Exec) {
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.isActive, true),
        eq(subscriptionPlans.isPublic, true),
      ),
    )
    .orderBy(asc(subscriptionPlans.sortOrder), asc(subscriptionPlans.name));
  return {
    plans: rows.filter((p) => planVisibility(p) === "listed").map(planOut),
  };
}

/** Any plan by id: checkout links can sell a hidden plan, never an archived, inactive, trial or free one. */
export async function getPlanForCheckout(db: Exec, id: string) {
  const p = await getPlan(db, id);
  if (!p) throw err.notFound("This plan is no longer available.");
  const reason = unavailableReason(p);
  return {
    plan: planOut(p),
    purchasable: reason === null,
    unavailableReason: reason,
  };
}

/** Where a live subscription goes once its period has ended (null = stays as it is). Pure; unit-tested. */
export function lapseTo(
  s: Pick<Sub, "status" | "currentPeriodEnd" | "cancelAtPeriodEnd">,
  now = Date.now(),
): "past_due" | "expired" | "cancelled" | null {
  const end = Date.parse(s.currentPeriodEnd);
  if (!LIVE.has(s.status) || end >= now) return null;
  if (s.status === "trial") return "expired";
  if (s.status === "past_due") return now > end + GRACE_DAYS * DAY_MS ? "expired" : null;
  return s.cancelAtPeriodEnd ? "cancelled" : "past_due";
}

async function expireIfLapsed(db: Exec, s: Sub | undefined) {
  const to = s && lapseTo(s);
  if (!s || !to) return s;
  const now = new Date().toISOString();
  await db
    .update(clientSubscriptions)
    .set({ status: to, updatedAt: now, ...(to === "cancelled" ? { cancelledAt: now } : {}) })
    .where(eq(clientSubscriptions.subscriptionId, s.subscriptionId));
  return { ...s, status: to, updatedAt: now };
}
/** Coverage holds while live and inside the period, or inside the past_due grace window. */
const covers = (s: Sub, now = Date.now()) =>
  LIVE.has(s.status) &&
  now <= Date.parse(s.currentPeriodEnd) + (s.status === "past_due" ? GRACE_DAYS * DAY_MS : 0);

const byClient = (db: Exec, clientId: string) =>
  db
    .select()
    .from(clientSubscriptions)
    .where(eq(clientSubscriptions.clientId, clientId))
    .then((r) => r[0]);

const usedInPeriod = (db: Exec, clientId: string, s: Sub) =>
  db
    .select({ n: count() })
    .from(applications)
    .where(
      and(
        eq(applications.clientId, clientId),
        gte(applications.submittedAt, s.startedAt),
        lte(applications.submittedAt, s.currentPeriodEnd),
      ),
    )
    .then((r) => r[0].n);

export async function getMine(db: Exec, clientId: string) {
  const s = await expireIfLapsed(db, await byClient(db, clientId));
  if (!s) return { enrolled: false, status: "none" };
  const [plan, agent] = await Promise.all([
    getPlan(db, s.planId),
    s.dedicatedAgentId
      ? db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.userId, s.dedicatedAgentId))
          .then((r) => r[0])
      : undefined,
  ]);
  const day = (iso: string) => Math.floor(Date.parse(iso) / 86_400_000);
  const used = await usedInPeriod(db, clientId, s);
  const cap = plan?.maxApplicationsPerMonth ?? null;
  return {
    enrolled: LIVE.has(s.status),
    subscriptionId: s.subscriptionId,
    status: s.status,
    planName: plan?.name ?? "Plan",
    planKind: plan?.kind ?? "retainer",
    dedicatedAgentName: agent?.name ?? null,
    periodEnd: iso(s.currentPeriodEnd),
    daysRemaining: Math.max(
      0,
      day(s.currentPeriodEnd) - day(new Date().toISOString()),
    ),
    maxApplicationsPerMonth: cap,
    applicationsUsedThisPeriod: used,
    usageWarning: !!cap && used >= cap * 0.8,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    scheduledPlanId: s.scheduledPlanId,
    scheduledPlanName: s.scheduledPlanId ? ((await getPlan(db, s.scheduledPlanId))?.name ?? null) : null,
    pausedUntil: iso(s.pausedUntil),
    graceEndsAt:
      s.status === "past_due"
        ? new Date(Date.parse(s.currentPeriodEnd) + GRACE_DAYS * DAY_MS).toISOString()
        : null,
    amountRwf: plan?.amountRwf ?? null,
  };
}

/** Activate or upgrade after a successful plan payment. A plan archived between paying and settling is honoured. */
export async function activateFromPayment(
  db: Exec,
  a: { clientId: string; planId: string; paidAt: string; paymentId: string },
  audit: AuditService,
) {
  const plan = await getPlan(db, a.planId);
  if (!plan) throw err.notFound("Plan not found.");
  if (plan.kind === "trial")
    throw new AppError(422, "validation", "Trial plans cannot be purchased.");
  const now = new Date();
  let end = new Date(now.getTime() + PERIOD_MS).toISOString();
  const [existing] = await db
    .select()
    .from(clientSubscriptions)
    .where(eq(clientSubscriptions.clientId, a.clientId))
    .for("update");
  let id: string;
  if (!existing) {
    id = generateId("sub");
    await db.insert(clientSubscriptions).values({
      subscriptionId: id,
      clientId: a.clientId,
      planId: plan.planId,
      status: "active",
      startedAt: now.toISOString(),
      currentPeriodEnd: end,
      lastRecordedPaymentAt: a.paidAt,
      note: `Activated via payment ${a.paymentId}.`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  } else {
    id = existing.subscriptionId;
    // This payment already rolled the period: don't roll it again.
    if (
      existing.planId === plan.planId &&
      existing.status === "active" &&
      !!existing.lastRecordedPaymentAt &&
      Date.parse(existing.lastRecordedPaymentAt) === Date.parse(a.paidAt)
    )
      return id;
    // F-SUB-04: paying a renewal of the same plan extends from the period end (no days lost); anything else starts now.
    const prev = await getPlan(db, existing.planId);
    // F-SUB-08: an upgrade paid mid-period (prorated at checkout) keeps the period; the plan changes now.
    const upgrade =
      existing.planId !== plan.planId &&
      existing.status === "active" &&
      (prev?.amountRwf ?? 0) > 0 &&
      plan.amountRwf > (prev?.amountRwf ?? 0) &&
      covers(existing, now.getTime());
    const renewal =
      (existing.planId === plan.planId || existing.scheduledPlanId === plan.planId) &&
      (existing.status === "active" || existing.status === "past_due") &&
      covers(existing, now.getTime());
    if (renewal) end = new Date(Date.parse(existing.currentPeriodEnd) + PERIOD_MS).toISOString();
    else if (upgrade) end = existing.currentPeriodEnd;
    await db
      .update(clientSubscriptions)
      .set({
        planId: plan.planId,
        status: "active",
        // startedAt is the current period's start (usage is counted from it).
        startedAt: renewal ? existing.currentPeriodEnd : upgrade ? existing.startedAt : now.toISOString(),
        scheduledPlanId: null,
        currentPeriodEnd: end,
        lastRecordedPaymentAt: a.paidAt,
        cancelAtPeriodEnd: false,
        cancelReason: null,
        remindersSent: [],
        usageWarnedAt: null,
        note: `${renewal ? "Renewed" : "Upgraded"} via payment ${a.paymentId}.`,
        updatedAt: now.toISOString(),
      })
      .where(eq(clientSubscriptions.subscriptionId, id));
  }
  await audit.record(db, {
    action: "subscription.paid_activate",
    entity: "client_subscription",
    entityId: id,
    after: { client_id: a.clientId, plan_id: plan.planId, payment_id: a.paymentId },
  });
  return id;
}

/** Called by auth (P1) on client signup. No-op when the client already has a row or the trial plan is off. */
export async function startTrialForClient(db: Exec, clientId: string) {
  const plan = await getPlan(db, TRIAL_PLAN_ID);
  if (!plan || !plan.isActive || plan.archivedAt) return null;
  const now = new Date();
  const days = plan.trialDays ?? 30;
  const [row] = await db
    .insert(clientSubscriptions)
    .values({
      subscriptionId: generateId("sub"),
      clientId,
      planId: plan.planId,
      status: "trial",
      startedAt: now.toISOString(),
      currentPeriodEnd: new Date(
        now.getTime() + days * 86_400_000,
      ).toISOString(),
      note: "Auto-started on signup.",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Whether a case is covered by a live plan (nothing owed), and the dedicated agent if any. Partners never are. */
export async function coverageFor(db: Exec, clientId: string, role: string) {
  if (role === "partner") return { covered: false, dedicatedAgentId: null };
  const s = await expireIfLapsed(db, await byClient(db, clientId));
  const live = !!s && covers(s);
  return { covered: live, dedicatedAgentId: live ? s!.dedicatedAgentId : null };
}

/** Only the monthly cap of a LIVE plan blocks a new application (a lapsed plan just means paying per case). */
export async function assertCanSubmit(
  db: Exec,
  clientId: string,
  role: string,
) {
  if (role === "partner") return;
  const s = await expireIfLapsed(db, await byClient(db, clientId));
  if (!s || !LIVE.has(s.status)) return;
  const cap = (await getPlan(db, s.planId))?.maxApplicationsPerMonth;
  if (!cap || cap <= 0) return;
  if ((await usedInPeriod(db, clientId, s)) >= cap)
    throw new AppError(
      422,
      "validation",
      `You have used all ${cap} applications available on your current plan. Upgrade to open another application.`,
    );
}

/** F-SUB-08 checkout amount: an upgrade inside a live paid period pays the prorated difference for the days left. */
export async function checkoutAmount(db: Exec, clientId: string, plan: Plan, now = Date.now()) {
  const s = await byClient(db, clientId);
  if (!s || s.status !== "active" || s.planId === plan.planId || !covers(s, now)) return plan.amountRwf;
  const prev = await getPlan(db, s.planId);
  if (!prev || prev.amountRwf <= 0 || plan.amountRwf <= prev.amountRwf) return plan.amountRwf;
  const left = Math.max(0, Math.ceil((Date.parse(s.currentPeriodEnd) - now) / DAY_MS));
  return Math.max(1, prorate(prev.amountRwf, plan.amountRwf, left, PERIOD_MS / DAY_MS));
}

/** F-SUB-08: downgrade → scheduled for period end; upgrade → the client pays the prorated amount at checkout. */
export async function changePlan(db: Exec, clientId: string, planId: string, audit: AuditService) {
  const s = await expireIfLapsed(db, await byClient(db, clientId));
  const plan = await getPlan(db, planId);
  if (!plan || unavailableReason(plan)) throw err.notFound("This plan is no longer available.");
  if (!s || s.status !== "active" || s.planId === planId)
    return { action: "checkout" as const, planId, amountRwf: plan.amountRwf, effectiveAt: null };
  const prev = await getPlan(db, s.planId);
  if (plan.amountRwf < (prev?.amountRwf ?? 0)) {
    await db.update(clientSubscriptions).set({ scheduledPlanId: planId, updatedAt: new Date().toISOString() })
      .where(eq(clientSubscriptions.subscriptionId, s.subscriptionId));
    await audit.record(db, { action: "subscription.downgrade_scheduled", entity: "client_subscription", entityId: s.subscriptionId, after: { planId, at: s.currentPeriodEnd } });
    return { action: "scheduled" as const, planId, amountRwf: plan.amountRwf, effectiveAt: iso(s.currentPeriodEnd) };
  }
  return { action: "checkout" as const, planId, amountRwf: await checkoutAmount(db, clientId, plan), effectiveAt: null };
}

/** Finance list (F-SUB-09): every subscription with client and plan. */
export async function listForFinance(db: Exec) {
  const rows = await db
    .select({ s: clientSubscriptions, plan: subscriptionPlans.name, amount: subscriptionPlans.amountRwf, client: users.name })
    .from(clientSubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.planId, clientSubscriptions.planId))
    .innerJoin(users, eq(users.userId, clientSubscriptions.clientId))
    .orderBy(asc(clientSubscriptions.currentPeriodEnd));
  return {
    items: rows.map((r) => ({
      subscriptionId: r.s.subscriptionId,
      clientName: r.client,
      planName: r.plan,
      amountRwf: r.amount,
      status: r.s.status,
      periodEnd: iso(r.s.currentPeriodEnd),
      pausedUntil: iso(r.s.pausedUntil),
      cancelAtPeriodEnd: r.s.cancelAtPeriodEnd,
    })),
  };
}

/** F-SUB-09 (finance): pause coverage for `days`; the period end moves by the same days so nothing is lost. */
export async function pause(db: Exec, subscriptionId: string, days: number, actorId: string, audit: AuditService) {
  const [s] = await db.select().from(clientSubscriptions).where(eq(clientSubscriptions.subscriptionId, subscriptionId)).for("update");
  if (!s || s.status !== "active") throw new AppError(409, "conflict", "Only an active plan can be paused.");
  const until = new Date(Date.now() + days * DAY_MS).toISOString();
  const end = new Date(Date.parse(s.currentPeriodEnd) + days * DAY_MS).toISOString();
  await db.update(clientSubscriptions).set({ status: "paused", pausedUntil: until, currentPeriodEnd: end, updatedAt: new Date().toISOString() })
    .where(eq(clientSubscriptions.subscriptionId, subscriptionId));
  await audit.record(db, { action: "subscription.paused", entity: "client_subscription", entityId: subscriptionId, after: { until, by: actorId } });
  return { subscriptionId, status: "paused", pausedUntil: until, periodEnd: end };
}

/** F-SUB-07: cancel at period end (coverage continues) or now (coverage stops, no refund by default); undo before the end. */
export async function cancelMine(
  db: Exec,
  clientId: string,
  b: { when: "period_end" | "now"; reason: string },
  audit: AuditService,
) {
  const s = await expireIfLapsed(db, await byClient(db, clientId));
  if (!s || !LIVE.has(s.status))
    throw new AppError(409, "conflict", "You have no active plan to cancel.");
  const now = new Date().toISOString();
  const set =
    b.when === "now" || s.status === "trial"
      ? { status: "cancelled", cancelledAt: now, currentPeriodEnd: now }
      : { cancelAtPeriodEnd: true };
  await db
    .update(clientSubscriptions)
    .set({ ...set, cancelReason: b.reason, updatedAt: now })
    .where(eq(clientSubscriptions.subscriptionId, s.subscriptionId));
  await audit.record(db, {
    action: "subscription.cancelled",
    entity: "client_subscription",
    entityId: s.subscriptionId,
    before: { status: s.status },
    after: { ...set, when: b.when },
    reason: b.reason,
  });
  return getMine(db, clientId);
}
export async function undoCancel(db: Exec, clientId: string, audit: AuditService) {
  const s = await byClient(db, clientId);
  if (!s?.cancelAtPeriodEnd || !LIVE.has(s.status))
    throw new AppError(409, "conflict", "Nothing to undo.");
  await db
    .update(clientSubscriptions)
    .set({ cancelAtPeriodEnd: false, cancelReason: null, updatedAt: new Date().toISOString() })
    .where(eq(clientSubscriptions.subscriptionId, s.subscriptionId));
  await audit.record(db, { action: "subscription.cancel_undone", entity: "client_subscription", entityId: s.subscriptionId });
  return getMine(db, clientId);
}

type Notify = (db: Exec, n: { userId: string; kind: string; title: string; body?: string; link?: string; data?: { type: string; vars?: Record<string, string> } }) => Promise<void>;

/** Cron: lapse transitions (past_due / cancelled / expired), renewal + dunning reminders, and the 80 % usage warning. */
export async function sweep(db: Exec, notify: Notify, now = Date.now()) {
  const rows = await db
    .select()
    .from(clientSubscriptions)
    .where(inArray(clientSubscriptions.status, [...LIVE]));
  let moved = 0, reminded = 0, warned = 0;
  // F-SUB-09: a pause ends by itself.
  const resumed = await db.update(clientSubscriptions).set({ status: "active", pausedUntil: null, updatedAt: new Date(now).toISOString() })
    .where(and(eq(clientSubscriptions.status, "paused"), lte(clientSubscriptions.pausedUntil, new Date(now).toISOString())))
    .returning({ id: clientSubscriptions.subscriptionId });
  moved += resumed.length;
  for (const s0 of rows) {
    const s = await expireIfLapsed(db, s0);
    if (!s) continue;
    if (s.status !== s0.status) {
      moved++;
      if (s.status === "expired" || s.status === "cancelled")
        await notify(db, { userId: s.clientId, kind: `subscription_${s.status}`, title: s.status === "expired" ? "Your plan has expired" : "Your plan has been cancelled", link: "/billing", data: { type: `subscription.${s.status}` } });
    }
    if (!LIVE.has(s.status)) continue;
    const end = Date.parse(s.currentPeriodEnd);
    const off = Math.floor((now - end) / DAY_MS);
    const sent = (s.remindersSent as string[]) ?? [];
    const key = `${s.currentPeriodEnd.slice(0, 10)}:${off}`;
    if (s.status === "trial") {
      // Trial ending: T-3 and T-1.
      if ((off === -3 || off === -1) && !sent.includes(key)) {
        await notify(db, { userId: s.clientId, kind: "trial_ending", title: `Your free trial ends in ${-off} day${off === -1 ? "" : "s"}`, link: "/pricing", data: { type: "trial.ending", vars: { days: String(-off) } } });
        await db.update(clientSubscriptions).set({ remindersSent: [...sent, key] }).where(eq(clientSubscriptions.subscriptionId, s.subscriptionId));
        reminded++;
      }
      continue;
    }
    const wanted = s.cancelAtPeriodEnd ? off === -3 : REMINDER_OFFSETS.includes(off);
    if (wanted && !sent.includes(key)) {
      const title =
        off < 0 ? `Your plan renews in ${-off} days` : off === 0 ? "Your plan renews today" : `Your plan payment is ${off} days late`;
      await notify(db, { userId: s.clientId, kind: off > 0 ? "subscription_past_due" : "subscription_renewal", title, link: "/billing", data: { type: off > 0 ? "subscription.past_due" : "subscription.renewal", vars: { days: String(Math.abs(off)) } } });
      await db.update(clientSubscriptions).set({ remindersSent: [...sent, key] }).where(eq(clientSubscriptions.subscriptionId, s.subscriptionId));
      reminded++;
    }
    const cap = (await getPlan(db, s.planId))?.maxApplicationsPerMonth;
    if (cap && !s.usageWarnedAt && (await usedInPeriod(db, s.clientId, s)) >= cap * 0.8) {
      await notify(db, { userId: s.clientId, kind: "subscription_usage", title: "You have used 80% of your plan's applications", link: "/billing", data: { type: "subscription.usage_80" } });
      await db.update(clientSubscriptions).set({ usageWarnedAt: new Date(now).toISOString() }).where(eq(clientSubscriptions.subscriptionId, s.subscriptionId));
      warned++;
    }
  }
  return { moved, reminded, warned };
}

/** Subscriptions entering the renewal window (F-SUB-04: `lead` days before period end), for finance's renewal invoices. */
export async function dueForRenewal(db: Exec, leadDays = 7, now = Date.now()) {
  const rows = await db
    .select({ s: clientSubscriptions, p: subscriptionPlans })
    .from(clientSubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.planId, clientSubscriptions.planId))
    .where(
      and(
        inArray(clientSubscriptions.status, ["active", "past_due"]),
        eq(clientSubscriptions.cancelAtPeriodEnd, false),
        lte(clientSubscriptions.currentPeriodEnd, new Date(now + leadDays * DAY_MS).toISOString()),
      ),
    );
  const out = [];
  for (const r of rows) {
    const p = r.s.scheduledPlanId ? ((await getPlan(db, r.s.scheduledPlanId)) ?? r.p) : r.p;
    if (p.amountRwf > 0) out.push({ s: r.s, p });
  }
  return out;
}

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly tx: TxService,
    private readonly audit: AuditService,
    private readonly cache: PublicCache,
  ) {}

  listPublicPlans() {
    return this.cache.get("plans", "public", () => this.tx.run(listPublicPlans));
  }
  getPlanForCheckout(id: string) {
    return this.cache.get("plans", `plan:${id}`, () => this.tx.run((t) => getPlanForCheckout(t, id)));
  }
  /** A lapsed plan is saved as expired on read. */
  getMine(clientId: string) {
    return this.tx.run((t) => getMine(t, clientId));
  }
  // In-tx helpers for other modules (payments, auth signup, booking).
  activateFromPayment(t: Tx, a: Parameters<typeof activateFromPayment>[1]) {
    return activateFromPayment(t, a, this.audit);
  }
  startTrialForClient = startTrialForClient;
  coverageFor = coverageFor;
  assertCanSubmit = assertCanSubmit;
  cancel(clientId: string, b: { when: "period_end" | "now"; reason: string }) {
    return this.tx.run((t) => cancelMine(t, clientId, b, this.audit));
  }
  changePlan(clientId: string, planId: string) {
    return this.tx.run((t) => changePlan(t, clientId, planId, this.audit));
  }
  listForFinance() {
    return this.tx.run(listForFinance);
  }
  pause(subscriptionId: string, days: number, actorId: string) {
    return this.tx.run((t) => pause(t, subscriptionId, days, actorId, this.audit));
  }
  checkoutAmount = checkoutAmount;
  undoCancel(clientId: string) {
    return this.tx.run((t) => undoCancel(t, clientId, this.audit));
  }
}
