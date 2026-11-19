// Zod schemas moved verbatim from the reference subscriptions.routes.ts.
import { z } from "zod";
import { dto } from "../../core/http/dto";
export const Plan = z
  .object({
    planId: z.string(),
    name: z.string(),
    interval: z.string(),
    amountRwf: z.number().int(),
    isActive: z.boolean(),
    kind: z.string(),
    maxApplicationsPerMonth: z.number().int().nullable(),
    trialDays: z.number().int().nullable(),
    description: z.string().nullable(),
    features: z.array(z.string()),
    badge: z.string().nullable(),
    sortOrder: z.number().int(),
    isPublic: z.boolean(),
    onPricing: z.boolean(),
    visibility: z.enum(["listed", "inactive", "hidden", "trial", "archived"]),
    archivedAt: z.string().nullable(),
    isSignupTrial: z.boolean(),
    liveSubscribers: z.number().int().nullable(),
    everUsed: z.boolean().nullable(),
  })
  .meta({ id: "SubscriptionPlanResponse" });
export const PlanList = z
  .object({ plans: z.array(Plan) })
  .meta({ id: "SubscriptionPlanListResponse" });

export const Mine = z
  .object({
    enrolled: z.boolean(),
    subscriptionId: z.string().optional(),
    status: z.string(),
    planName: z.string().optional(),
    planKind: z.string().optional(),
    dedicatedAgentName: z.string().nullable().optional(),
    periodEnd: z.string().optional(),
    daysRemaining: z.number().int().optional(),
    maxApplicationsPerMonth: z.number().int().nullable().optional(),
    applicationsUsedThisPeriod: z.number().int().optional(),
    usageWarning: z.boolean().optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    graceEndsAt: z.string().nullable().optional(),
    amountRwf: z.number().int().nullable().optional(),
    scheduledPlanId: z.string().nullable().optional(),
    pausedUntil: z.string().nullable().optional(),
  })
  .meta({ id: "MySubscriptionResponse" });
export const CheckoutOut = z.object({
  plan: Plan,
  purchasable: z.boolean(),
  unavailableReason: z.enum(["archived", "inactive", "trial", "free"]).nullable(),
});
export class CancelDto extends dto(
  z.object({ when: z.enum(["period_end", "now"]).default("period_end"), reason: z.string().trim().min(1).max(500) }),
) {}
export class ChangePlanDto extends dto(z.object({ planId: z.string().trim().min(1).max(64) })) {}
export const ChangeOut = z.object({
  action: z.enum(["checkout", "scheduled"]),
  planId: z.string(),
  amountRwf: z.number().int(),
  effectiveAt: z.string().nullable(),
});
export class PauseDto extends dto(z.object({ days: z.number().int().min(1).max(90) })) {}
export const PauseOut = z.object({ subscriptionId: z.string(), status: z.string(), pausedUntil: z.string(), periodEnd: z.string() });
