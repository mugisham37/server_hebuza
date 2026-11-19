// Zod schemas moved verbatim from the reference workforce.routes.ts.
import { z } from "zod";
import type { Role } from "@/domain/auth/roles";
import { dto } from "../../core/http/dto";

export const READ: Role[] = ["staff:service_manager", "staff:executive"];
export const MANAGE: Role[] = ["staff:service_manager"];
const Status = z.enum(["invited", "onboarding", "cleared", "suspended", "terminated"]);

export class CreateDto extends dto(
  z.object({
    firstName: z.string().max(100),
    lastName: z.string().max(100),
    email: z.string().max(200),
    phone: z.string().max(40).default(""),
    type: z.enum(["internal", "external"]),
    field: z.boolean().default(false),
  }),
) {}
/** F-WRK-14 talent directory filters (server-side). */
export class ListQueryDto extends dto(z.object({
  service: z.string().max(128).optional(), language: z.string().max(8).optional(), district: z.string().max(64).optional(),
  available: z.enum(["1"]).optional(), minRating: z.coerce.number().min(0).max(5).optional(), type: z.enum(["internal", "external"]).optional(),
  q: z.string().max(100).optional(),
})) {}
export class DetailQueryDto extends dto(z.object({ reveal: z.string().max(2).optional() })) {}
export class StatusDto extends dto(
  z.object({
    to: Status,
    reason: z.string().max(2000),
    reassignments: z.array(z.object({ ref: z.string().max(40), to: z.string().max(64) })).max(500).optional(),
  }),
) {}
export class ReviewDto extends dto(
  z.object({ period: z.string().max(20), rating: z.number(), goals: z.string().max(4000).optional(), comments: z.string().max(8000), ackRequired: z.boolean().optional() }),
) {}
export class ContractDto extends dto(z.object({
  kind: z.enum(["service_agreement", "sla", "nda", "licence"]),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  noticeDays: z.number().int().min(0).max(365), terms: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
})) {}
export class WorkContactsDto extends dto(z.object({
  email: z.string().trim().email().max(255).optional(), phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/).optional(),
  links: z.record(z.enum(["linkedin", "website", "x", "facebook"]), z.string().trim().url().max(300)).optional(),
})) {}
