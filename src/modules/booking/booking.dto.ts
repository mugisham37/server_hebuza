// Booking route inputs, moved verbatim from the reference route table. Outputs are the projections in the service
// (shapes: @/domain/booking/types); the reference declared them `z.unknown()`, so no `out` filter here.
import { z } from "zod";
import { dto } from "../../core/http/dto";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HM = z.string().regex(/^\d{2}:\d{2}$/);
const Loc = z.enum(["en", "fr", "rw"]);
const Mode = z.enum(["office", "video", "phone", "premises"]);
const Version = z.number().int().nonnegative();
const L3 = z.object({
  en: z.string().max(400),
  fr: z.string().max(400),
  rw: z.string().max(400),
});

export const SM = ["staff:service_manager", "staff:executive"] as const;
export const BOARD = [
  "staff:service_manager",
  "staff:executive",
  "staff:marketing",
] as const;
export const ADVISER = [
  "staff:agent",
  "ext:agent",
  "staff:service_manager",
  "staff:executive",
] as const;
export const CLIENT = ["client"] as const;

export class LangQ extends dto(z.object({ lang: z.string().optional() })) {}
export class TypesQ extends dto(
  z.object({ contact: z.string().max(255).optional() }),
) {}
export class SlotsQ extends dto(
  z.object({ from: Day, to: Day, adviser_id: z.string().max(64).optional() }),
) {}
export class AdvisersQ extends dto(
  z.object({ type: z.string().max(96).optional() }),
) {}
export class HoldDto extends dto(
  z.object({
    type: z.string().max(96),
    starts_at: z.string().max(40),
    adviser_id: z.string().max(64).nullish(),
    release: z.string().max(64).nullish(),
  }),
) {}

export const ConfirmIn = z.object({
  contact: z.object({
    name: z.string().max(255),
    phone: z.string().max(32).optional(),
    email: z.string().max(255).optional(),
  }),
  intake: z.record(z.string(), z.unknown()).optional(),
  consents: z.object({
    privacy: z.boolean(),
    whatsapp: z.boolean().optional(),
  }),
  captcha: z.string().max(4096).optional(),
  language: Loc,
  mode: Mode,
  family: z.string().max(128).nullish(),
  service: z.string().max(128).nullish(),
  source: z.string().max(32).optional(),
  prepay: z.boolean().optional(),
});
export class ConfirmDto extends dto(ConfirmIn) {}
export class PayDto extends dto(
  z.object({
    method: z.enum(["momo", "airtel", "card"]),
    phone: z.string().max(32).optional(),
  }),
) {}
export class CancelDto extends dto(
  z.object({
    reason: z.string().max(1000).optional(),
    refund_choice: z.enum(["refund", "credit"]).optional(),
    version: Version,
  }),
) {}
export class RescheduleDto extends dto(
  z.object({ hold_id: z.string().min(1).max(64), version: Version }),
) {}
export class ResendDto extends dto(
  z.object({
    email: z.string().max(255).optional(),
    phone: z.string().max(32).optional(),
  }),
) {}
export class RequestDto extends dto(
  z.object({
    name: z.string().max(255),
    phone: z.string().max(32),
    email: z.string().max(255).optional(),
    topic: z.string().max(128),
    preferred_times: z.array(z.string().max(64)).max(12).default([]),
    language: Loc,
    consent: z.boolean(),
    captcha: z.string().max(4096).optional(),
  }),
) {}
export class WaitlistDto extends dto(
  z.object({
    type: z.string().max(96),
    date: Day,
    contact: z.string().max(255),
  }),
) {}

export class MyBookingsQ extends dto(
  z.object({
    scope: z.enum(["upcoming", "past"]).default("upcoming"),
    lang: z.string().optional(),
  }),
) {}
export class RangeQ extends dto(
  z.object({ from: Day.optional(), to: Day.optional() }),
) {}
export class NotesDto extends dto(
  z.object({
    outcome_notes: z.string().max(20_000).optional(),
    client_summary: z.string().max(5_000).optional(),
    version: Version,
  }),
) {}
export class OutcomeDto extends dto(
  z.object({
    status: z.enum(["completed", "no_show"]),
    recommended_service_ids: z.array(z.string().max(128)).max(20).default([]),
    send_start_links: z.boolean().default(false),
    version: Version,
  }),
) {}
export class QuoteDto extends dto(
  z.object({
    lines: z
      .array(
        z.object({
          label: z.string().max(255),
          qty: z.number().int(),
          unit: z.number().int(),
        }),
      )
      .max(50),
    send: z.boolean().optional(),
    channels: z.array(z.string().max(16)).optional(),
  }),
) {}
const RuleIn = z.object({
  weekday: z.number().int().min(0).max(6),
  start: HM,
  end: HM,
});
const OverrideIn = z.object({
  id: z.string().max(64),
  date: Day,
  kind: z.enum(["extra", "blocked"]),
  start: HM.optional(),
  end: HM.optional(),
  note: z.string().max(255).optional(),
});
export class AvailabilityDto extends dto(
  z.object({
    rules: z.array(RuleIn).max(70),
    overrides: z.array(OverrideIn).max(400).optional(),
    version: Version,
  }),
) {}

export class AdminListQ extends dto(
  z.object({
    date: Day.optional(),
    adviser: z.string().max(64).optional(),
    type: z.string().max(96).optional(),
    status: z.string().max(32).optional(),
    q: z.string().max(120).optional(),
  }),
) {}
export class AdminPatchDto extends dto(
  z.object({
    action: z.enum(["reassign", "cancel", "override"]),
    adviser_id: z.string().max(64).optional(),
    reason: z.string().max(1000).default(""),
    override: z
      .enum(["late_refund", "waive_no_show", "extra_reschedule"])
      .optional(),
    version: Version,
  }),
) {}
export class AutoReassignDto extends dto(
  z.object({ adviser_id: z.string().max(64) }),
) {}
export class StaffCreateDto extends dto(
  z.object({
    type: z.string().max(96),
    starts_at: z.string().max(40),
    adviser_id: z.string().max(64).nullish(),
    name: z.string().max(255),
    phone: z.string().max(32).optional(),
    email: z.string().max(255).optional(),
    client_id: z.string().max(64).nullish(),
    mode: Mode,
    notes: z.string().max(5000).optional(),
    request_id: z.string().max(16).optional(),
  }),
) {}
export class CloseRequestDto extends dto(
  z.object({
    status: z.literal("closed"),
    close_reason: z.string().max(1000).default(""),
  }),
) {}

export const TypeIn = z.object({
  slug: z.string().max(96).optional(),
  name: L3.optional(),
  description: L3.optional(),
  durationMin: z
    .union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)])
    .optional(),
  modes: z.array(Mode).max(4).optional(),
  price: z.number().int().min(0).optional(),
  bufferBeforeMin: z.number().int().min(0).max(240).optional(),
  bufferAfterMin: z.number().int().min(0).max(240).optional(),
  minNoticeMin: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60)
    .optional(),
  horizonDays: z.number().int().min(1).max(365).optional(),
  maxPerDay: z.number().int().min(1).max(50).optional(),
  familySlugs: z.array(z.string().max(128)).optional(),
  serviceSlugs: z.array(z.string().max(128)).optional(),
  adviserIds: z.array(z.string().max(64)).optional(),
  intakeSchema: z
    .array(
      z.object({
        id: z.string().max(64),
        type: z.enum(["text", "select", "radio", "checkbox"]),
        label: L3,
        options: z.array(z.string().max(255)).optional(),
        required: z.boolean(),
      }),
    )
    .max(30)
    .optional(),
  prepare: z.record(z.string(), z.array(z.string().max(400))).optional(),
  freeOncePerFamily: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export class TypeDto extends dto(TypeIn) {}
export class TypePatchDto extends dto(TypeIn.extend({ version: Version })) {}
