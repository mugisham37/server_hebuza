// Port of the reference subscriptions.service.ts (client + public + payment side). Query functions kept as-is (taking a
// tx); SubscriptionsService runs them. activateFromPayment / startTrialForClient / coverageFor / assertCanSubmit take the
// caller's tx so payments, auth and booking stay atomic.
// shortcut: admin plan CRUD (/api/admin/subscriptions*) is not ported (none in the reference either); when added, call
// PublicCache.bust("plans") after each write.
import { Injectable } from "@nestjs/common";
import { and, asc, count, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { applications, clientSubscriptions, subscriptionPlans, users } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { AppError } from "../../core/http/errors";
import { PublicCache } from "../catalogue/cache";
import { generateId } from "../../core/db/ids";

type Exec = Tx;
const err = { notFound: (m: string) => new AppError(404, "not_found", m) };
export const PERIOD_MS = 30 * 86_400_000;
export const TRIAL_PLAN_ID = "pln_trial_default";
const LIVE = new Set(["active", "trial"]);
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

const lapsed = (s: Sub, now = Date.now()) =>
  LIVE.has(s.status) && Date.parse(s.currentPeriodEnd) < now;

async function expireIfLapsed(db: Exec, s: Sub | undefined) {
  if (!s || !lapsed(s)) return s;
  const now = new Date().toISOString();
  await db
    .update(clientSubscriptions)
    .set({ status: "expired", updatedAt: now })
    .where(eq(clientSubscriptions.subscriptionId, s.subscriptionId));
  return { ...s, status: "expired", updatedAt: now };
}

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
    maxApplicationsPerMonth: plan?.maxApplicationsPerMonth ?? null,
    applicationsUsedThisPeriod: await usedInPeriod(db, clientId, s),
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
  const end = new Date(now.getTime() + PERIOD_MS).toISOString();
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
    await db
      .update(clientSubscriptions)
      .set({
        planId: plan.planId,
        status: "active",
        startedAt: now.toISOString(),
        currentPeriodEnd: end,
        lastRecordedPaymentAt: a.paidAt,
        note: `Upgraded via payment ${a.paymentId}.`,
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
  const live =
    !!s && LIVE.has(s.status) && Date.parse(s.currentPeriodEnd) >= Date.now();
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

/** Cron: mark every lapsed live plan expired. */
export async function expireOverdue(db: Exec) {
  const now = new Date().toISOString();
  const r = await db
    .update(clientSubscriptions)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        inArray(clientSubscriptions.status, [...LIVE]),
        lt(clientSubscriptions.currentPeriodEnd, now),
      ),
    )
    .returning({ id: clientSubscriptions.subscriptionId });
  return r.length;
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
  expireOverdue = expireOverdue;
}
