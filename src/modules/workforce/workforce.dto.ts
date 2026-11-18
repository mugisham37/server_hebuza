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
