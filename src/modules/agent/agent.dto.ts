// Zod inputs moved verbatim from the reference agent.routes.tsx (+ the openapi-only settings/profile/papers/doc upload).
// shortcut: outputs stay untyped like the reference (`out: z.any()`); tighten per screen when OpenAPI types are generated.
import { z } from "zod";
import { CASE_STATUSES } from "@/domain/domain/case-status";
import { dto } from "../../core/http/dto";
import { UploadIn } from "../documents/documents.files";

const Code = z.string().max(32);

export class DutyDto extends dto(
  z.object({
    state: z.enum(["on", "away"]),
    until: z.string().max(40).nullish(),
  }),
) {}
export class RangeQueryDto extends dto(
  z.object({
    start: z.string().max(10).optional(),
    end: z.string().max(10).optional(),
  }),
) {}
export class ObligationDto extends dto(
  z
    .object({ code: Code.optional(), reason: z.string().max(500).optional() })
    .optional()
    .default({}),
) {}
export class StatusDto extends dto(
  z.object({
    status: z.enum(CASE_STATUSES),
    note: z.string().max(2000).optional(),
    x_agent: z
      .object({
        institution: z.string().max(64).optional(),
        submissionRef: z.string().max(128).optional(),
        submittedOn: z.string().max(40).optional(),
        expectedDecision: z.string().max(40).optional(),
        evidence: z.string().max(500).nullish(),
      })
      .optional(),
  }),
) {}
export class FlagDto extends dto(
  z.object({
    kind: z.enum(["attention", "reassign"]),
    note: z.string().max(1000),
  }),
) {}
export class ProposeDueDto extends dto(
  z.object({
    due_date: z.string().max(40),
    note: z.string().max(1000).default(""),
  }),
) {}
export class QcDto extends dto(
  z.object({
    qc_status: z.enum(["pending", "accepted", "rejected"]),
    qc_notes: z
      .object({
        reason: z.string().max(200).optional(),
        note: z.string().max(1000).optional(),
        move: z.boolean().optional(),
      })
      .nullish(),
  }),
) {}
export class DocUploadDto extends dto(
  UploadIn.extend({ need_id: z.string().max(64).nullish(), requirement_key: z.string().max(128).nullish() }),
) {}
export class DoneDto extends dto(z.object({ done: z.boolean() })) {}
export class RevealDto extends dto(z.object({ field: z.string().max(32) })) {}
export class OutcomeDto extends dto(
  z.object({
    state: z.enum(["pending", "approved", "rejected", "more_info"]),
    note: z.string().max(2000).optional(),
    evidence: z.string().max(500).nullish(),
    ref: z.string().max(128).optional(),
    institution: z.string().max(255).optional(),
  }),
) {}
export class FieldVisitDto extends dto(
  z.object({
    location: z.string().max(200),
    purpose: z.string().max(500),
    date: z.string().max(40),
  }),
) {}
export class TimesheetDto extends dto(
  z.object({
    date: z.string().max(40),
    minutes: z.number().int(),
    activity: z.string().max(64),
    note: z.string().max(500).optional(),
  }),
) {}
export class TextDto extends dto(z.object({ text: z.string().max(4000) })) {}

export class OffersQueryDto extends dto(
  z.object({
    view: z.string().max(16).optional(),
    status: z.string().max(16).optional(),
  }),
) {}
export class AcceptDto extends dto(
  z.object({
    conflict: z.string().max(16).optional(),
    note: z.string().max(1000).optional(),
    start_now: z.boolean().optional(),
  }),
) {}
export class DeclineDto extends dto(
  z.object({
    reason: z.string().max(32).optional(),
    note: z.string().max(1000).optional(),
  }),
) {}
export class DeliverableDto extends dto(
  z.object({
    clientNote: z.string().max(4000).optional(),
    slot: z.string().max(64).optional(),
    name: z.string().max(255).optional(),
    size: UploadIn.shape.size.optional(),
    type: UploadIn.shape.mime.optional(),
    signature: z.boolean().optional(),
  }),
) {}

export class ThreadsQueryDto extends dto(
  z.object({
    q: z.string().max(120).optional(),
    filter: z.string().max(16).optional(),
  }),
) {}
export class MsgDto extends dto(
  z.object({
    client_msg_id: z.string().min(1).max(64),
    lane: z.enum(["client", "internal"]),
    kind: z.enum(["text", "voice", "file", "card"]),
    body: z.string().max(4000).optional(),
    file: z
      .object({ name: z.string().max(255), size: z.number().int().min(0) })
      .optional(),
    voice: z
      .object({
        seconds: z.number().min(0).max(600),
        src: z.string().max(2000).optional(),
        mime: z.string().max(64).optional(),
      })
      .optional(),
    card: z
      .object({
        // doc_request/status = legacy free-text cards; the rest are typed (domain/chat/rules CARD_SCHEMAS, F-MSG-05).
        type: z.enum(["doc_request", "appointment", "status", "document_request", "payment_request", "quotation", "deliverable_ready", "visit_checkin"]),
        title: z.string().max(200),
        detail: z.string().max(1000),
        data: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
) {}
export class TplDto extends dto(
  z.object({
    id: z.string().max(64).optional(),
    name: z.string().max(120).optional(),
    body_rw: z.string().max(4000).optional(),
    body_en: z.string().max(4000).optional(),
    body_fr: z.string().max(4000).optional(),
  }),
) {}

export class MonthQueryDto extends dto(
  z.object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, "Invalid month")
      .optional(),
  }),
) {}
export class QuestionDto extends dto(
  z
    .object({
      reason: z.string().max(16).optional(),
      note: z.string().max(1000).optional(),
      file: z.string().max(500).nullish(),
    })
    .optional()
    .default({}),
) {}
export class PerfQueryDto extends dto(
  z.object({ range: z.enum(["30d", "quarter", "year"]).optional() }),
) {}

export class OnboardingDto extends dto(z.record(z.string(), z.unknown())) {}
export class SkillsDto extends dto(
  z.object({
    changes: z
      .array(
        z.object({
          service_category: z.string().max(128),
          proficiency_level: z.number().int().min(1).max(5),
        }),
      )
      .max(20),
    note: z.string().max(1000).default(""),
  }),
) {}
export class AvailDto extends dto(
  z.record(z.string().max(3), z.object({ am: z.boolean(), pm: z.boolean() })),
) {}
export class LeaveDto extends dto(
  z.object({
    from: z.string().max(10),
    to: z.string().max(10),
    reason: z.string().max(500).default(""),
  }),
) {}
export class MatrixDto extends dto(
  z.object({
    rows: z
      .array(
        z.looseObject({
          event: z.string().max(32),
          required: z.array(z.string().max(16)),
        }),
      )
      .max(20),
  }),
) {}

export class SettingsDto extends dto(
  z.object({
    accepting_cases: z.boolean().nullish(),
    daily_case_cap: z.number().int().min(0).max(50).nullish(),
    notification_new_case: z.boolean().nullish(),
    notification_client_reply: z.boolean().nullish(),
    notification_sla_alert: z.boolean().nullish(),
    notification_daily_summary: z.boolean().nullish(),
    is_on_duty: z.boolean().nullish(),
    monthly_percent: z.number().int().min(0).max(100).nullish(),
    one_off_percent: z.number().int().min(0).max(100).nullish(),
    payout_phone: z.string().max(32).nullish(),
    payout_bank_name: z.string().max(120).nullish(),
    payout_bank_account: z.string().max(64).nullish(),
    payout_account_name: z.string().max(120).nullish(),
  }),
) {}
export class ProfileDto extends dto(
  z.object({
    name: z.string().max(120).nullish(),
    phone: z.string().max(32).nullish(),
  }),
) {}
export class PaperDto extends dto(
  z.object({
    kind: z.string().max(64),
    ...UploadIn.shape,
  }),
) {}
