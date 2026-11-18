// Field route inputs, moved verbatim from the reference route table. Agent writes come from the offline outbox as
// passthrough bodies (data URLs, client_op_id, base_version) validated in the service. Outputs are the service
// projections (shapes: @/domain/field/types); the reference declared them `z.unknown()`, so no `out` filter.
import { z } from "zod";
import { dto } from "../../core/http/dto";

export const SM = ["staff:service_manager"] as const;
// Agent-side field surface: field agents (internal + external) and their service managers — never clients.
export const FIELD = ["staff:agent", "ext:agent", "staff:service_manager"] as const;
export const FIN = ["staff:finance"] as const;
export const OFFICE = ["staff:service_manager", "staff:finance"] as const;
export const EVIDENCE = ["staff:service_manager", "staff:finance", "staff:agent"] as const;
export const REQUESTERS = ["staff:service_manager", "staff:agent"] as const;

export const AnyBody = z.record(z.string(), z.unknown());
export class AnyDto extends dto(AnyBody) {}
export class DateQ extends dto(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })) {}
export class DeclineDto extends dto(z.object({ reason: z.string().max(200).nullish(), note: z.string().max(1000).nullish() })) {}
export class MomoDto extends dto(z.object({ invoice_no: z.string().trim().min(1).max(64), msisdn: z.string().max(32), amount: z.coerce.number() })) {}
export class OtpVerifyDto extends dto(z.object({ code: z.coerce.string().max(12) })) {}
export class EarningsQ extends dto(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() })) {}
export class ConflictsQ extends dto(z.object({ status: z.enum(["open", "accepted_agent", "kept_office"]).optional() })) {}
export class ResolveDto extends dto(z.object({ choice: z.string().max(32), note: z.string().max(1000).nullish() })) {}
export class MediaQ extends dto(z.object({ key: z.string().min(1).max(512) })) {}
export class QueueQ extends dto(z.object({ tab: z.string().max(16).default("flags") })) {}
export class RevokeDto extends dto(z.object({ on: z.boolean().default(true) })) {}
export class LevelQ extends dto(z.object({ level: z.enum(["1", "2"]) })) {}
export class DecisionDto extends dto(
  z.object({
    level: z.coerce.number().pipe(z.union([z.literal(1), z.literal(2)])),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().max(1000).nullish(),
  }),
) {}
export class ConfirmCashDto extends dto(
  z.object({ reason: z.string().max(500).default(""), evidence_id: z.string().max(128).nullish(), deposit_ref: z.string().max(128).nullish() }),
) {}
export class CreateVisitDto extends dto(
  z.object({
    purpose: z.enum(["pickup", "dropoff", "institution_submission", "site_visit", "meeting", "assisted_application"]),
    title: z.string().max(200).nullish(),
    todo: z.string().max(2000).nullish(),
    address: z.string().trim().min(1).max(512),
    institution: z.string().max(255).nullish(),
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
    window_start: z.string().min(1),
    window_end: z.string().nullish(),
    checklist: z.array(z.string().max(200)).max(30).nullish(),
    agent_id: z.string().max(64).nullish(),
    priority: z.enum(["normal", "high"]).nullish(),
    offer: z.boolean().nullish(),
  }),
) {}
