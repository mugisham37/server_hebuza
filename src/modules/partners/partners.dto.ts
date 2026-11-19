import { z } from "zod";
import { dto } from "../../core/http/dto";
import { AGREEMENT_KINDS, PARTNER_TYPES } from "@/domain/partners/partners";

const s = (n: number) => z.string().trim().max(n);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const PartnerIn = z.object({
  name: s(255).min(2), type: z.enum(PARTNER_TYPES), tier: z.enum(["strategic", "operational"]).optional(),
  status: z.enum(["prospect", "active", "dormant", "archived"]).optional(), sector: s(128).nullish(), country: s(64).optional(),
  website: s(255).nullish(), logoUrl: z.string().url().max(1024).nullish(), shownOnWebsite: z.boolean().optional(),
  ownerUserId: s(64).nullish(), notes: s(5000).nullish(), organizationId: s(64).nullish(),
});
export class PartnerDto extends dto(PartnerIn) {}
export class PartnerPatchDto extends dto(PartnerIn.partial()) {}
export class PartnerQueryDto extends dto(z.object({ status: z.enum(["prospect", "active", "dormant", "archived"]).optional(), type: z.enum(PARTNER_TYPES).optional() })) {}

/** One schema per child kind; PATCH takes the partial. */
export const CHILD_IN = {
  contacts: z.object({ name: s(255).min(2), title: s(128).nullish(), email: z.string().email().max(255).nullish(), phone: s(32).nullish(), language: z.enum(["rw", "en", "fr"]).nullish(), isPrimary: z.boolean().optional(), active: z.boolean().optional() }),
  agreements: z.object({ kind: z.enum(AGREEMENT_KINDS), number: s(64).nullish(), title: s(255).min(2), signedOn: day.nullish(), startOn: day, endOn: day.nullish(), renewalTerms: s(5000).nullish(),
    valueAmount: z.number().int().nonnegative().nullish(), commissionBps: z.number().int().min(0).max(5000).nullish(), status: z.enum(["draft", "active", "renewed", "expired", "terminated"]).optional(),
    isConfidential: z.boolean().optional(), terminationReason: s(2000).nullish(), terminatedOn: day.nullish() }),
  actions: z.object({ title: s(255).min(2), deliverable: s(500).nullish(), ownerUserId: s(64).nullish(), dueOn: day.nullish(), status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(), progress: z.number().int().min(0).max(100).optional() }),
  meetings: z.object({ title: s(255).min(2), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }).nullish(), location: s(500).nullish(), agenda: s(10000).nullish(),
    minutes: s(50000).nullish(), decisions: z.array(s(1000)).max(50).optional(), status: z.enum(["scheduled", "held", "cancelled", "rescheduled"]).optional() }),
  correspondence: z.object({ direction: z.enum(["in", "out"]), kind: z.enum(["letter", "email", "report", "proposal", "other"]), date: day, subject: s(255).min(2), summary: s(5000).nullish() }),
  referrals: z.object({ direction: z.enum(["in", "out"]), name: s(255).min(2), clientId: s(64).nullish(), applicationId: s(64).nullish(), status: z.enum(["referred", "contacted", "converted", "lost"]).optional() }),
} as const;
export const ChildIn = z.record(z.string(), z.unknown());
export class ChildDto extends dto(ChildIn) {}
export class DecisionToActionDto extends dto(z.object({ index: z.number().int().min(0), ownerUserId: s(64).nullish(), dueOn: day.nullish() })) {}
export class CommissionDecisionDto extends dto(z.object({ decision: z.enum(["approved", "rejected", "paid"]), note: s(1000).optional() })) {}
export class CommissionQueryDto extends dto(z.object({ status: z.enum(["computed", "approved", "paid", "rejected"]).optional() })) {}
