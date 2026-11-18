// Zod bodies moved verbatim from the reference assistant route table.
import { z } from "zod";
import type { Role } from "@/domain/auth/roles";
import { dto } from "../../core/http/dto";

const Loc = z.enum(["en", "fr", "rw"]);
export const KB_READ = ["staff:service_manager", "staff:executive", "staff:marketing"] as const satisfies readonly Role[];
export const SM = ["staff:service_manager", "staff:executive"] as const satisfies readonly Role[];
export const SETTINGS_READ = ["staff:service_manager", "staff:executive", "staff:marketing", "staff:sysadmin"] as const satisfies readonly Role[];
export const COPILOT = ["staff:agent", "ext:agent", "staff:service_manager", "staff:executive"] as const satisfies readonly Role[];

export class StartDto extends dto(z.object({ lang: Loc, context: z.enum(["public", "portal", "staff_test"]).default("public"), page: z.string().max(255).optional() })) {}
export class MessageDto extends dto(z.object({ text: z.string().min(1).max(4000), lang: Loc })) {}
export class ToolAnswerDto extends dto(z.object({ toolCallId: z.string().max(128), value: z.unknown(), lang: Loc })) {}
export class RatingDto extends dto(z.object({ messageId: z.string().max(64).nullish(), value: z.union([z.literal(1), z.literal(-1)]), comment: z.string().max(1000).optional() })) {}
export class HandoffDto extends dto(
  z.object({ reason: z.enum(["user_request", "risk_topic", "low_confidence", "clarification_failed", "money_owed", "minor", "budget"]) }),
) {}
export class LeadDto extends dto(
  z.object({
    toolCallId: z.string().max(128).optional(),
    name: z.string().max(255),
    phone: z.string().max(32).optional(),
    email: z.string().max(255).optional(),
    topic: z.string().max(255).optional(),
    consent: z.boolean(),
  }),
) {}
export class KbPatchDto extends dto(
  z.object({
    action: z.enum(["approve_facts", "approve_tone", "exclude", "request_changes", "withdraw"]),
    comment: z.string().max(2000).optional(),
    review_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    version: z.number().int().nonnegative(),
  }),
) {}
export class ReindexDto extends dto(z.object({ ids: z.array(z.string().max(128)).max(500).optional() })) {}
export class SessionsQ extends dto(
  z.object({ outcome: z.string().max(24).optional(), lang: z.string().max(4).optional(), handoff: z.enum(["true", "false"]).optional(), rating: z.string().max(4).optional() }),
) {}
export class SettingsDto extends dto(z.object({ enabled: z.boolean(), amount: z.number().int().min(0).max(100_000), version: z.number().int().nonnegative() })) {}
export class CopilotDto extends dto(
  z.object({ case_code: z.string().max(32).optional(), booking_id: z.string().max(64).optional(), text: z.string().max(20_000).optional(), lang: Loc.optional() }),
) {}
