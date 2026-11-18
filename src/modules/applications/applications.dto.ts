// Zod schemas moved verbatim from the reference applications.routes.ts + applications.support.ts.
import { z } from "zod";
import { dto } from "../../core/http/dto";

const Status = z.string();
export const Summary = z.object({
  application_id: z.string(), code: z.string(), service_name: z.string(), service_slug: z.string(), status: Status, tier: z.string(),
  submitted_at: z.string(), payment_status: z.string(), handler: z.string(), ending: z.string(), retainer: z.boolean(),
  assigned_agent_name: z.string().nullable(),
});
export const Need = z.object({
  id: z.string(), kind: z.enum(["document", "payment"]), code: z.string(), service: z.string(), label: z.string(),
  dueAt: z.string().nullable(), done: z.boolean().optional(), amount: z.number().int().optional(),
});
export const PaymentLine = z.object({
  id: z.string(), label: z.string(), amount: z.number().int(), code: z.string(), service: z.string(),
  status: z.enum(["paid", "due"]), paidAt: z.string().nullable(), dueAt: z.string().nullable(),
});
export const Detail = Summary.extend({
  personal_info: z.record(z.string(), z.unknown()), service_data: z.record(z.string(), z.unknown()),
  payment_amount: z.number().int().nullable(), status_display: z.string(), assignee_name: z.string().nullable(), outcome: z.string(),
  needs: z.array(Need), payments: z.array(PaymentLine),
  timeline: z.array(z.object({ id: z.string(), title: z.string(), state: z.enum(["done", "current", "upcoming"]), at: z.string().nullable() })),
  deliverables: z.array(z.object({ id: z.string(), name: z.string(), size: z.number().int(), released: z.boolean(), at: z.string() })),
}).meta({ id: "ClientApplicationDetail" });

const PersonalInfo = z.object({
  fullName: z.string().max(255).optional(), nationalId: z.string().max(32).optional(), dob: z.string().max(32).optional(),
  phone: z.string().max(32).optional(), email: z.string().max(255).optional(), whatsapp: z.boolean().nullish(),
  language: z.string().max(8).nullish(), consent: z.boolean().nullish(),
}).catchall(z.unknown());
export const SubmitIn = z.object({
  service_slug: z.string().min(1).max(128), tier: z.string().min(1).max(32), personal_info: PersonalInfo,
  service_data: z.record(z.string(), z.unknown()).nullish(), idempotency_key: z.string().min(8).max(128).nullish(),
  is_urgent: z.boolean().optional(), preferred_date: z.iso.date().nullish(),
});
export const SubmitOut = z.object({
  application_id: z.string(), code: z.string(), service_name: z.string(), tier: z.string(), payment_required: z.boolean(),
  ending: z.string(), replayed: z.boolean(), notified: z.array(z.string()), matches_account: z.boolean(),
}).meta({ id: "SubmitApplicationResponse" });

export const TrackOut = z.object({
  code: z.string(), service_name: z.string(), status: z.string(), current_step_number: z.number().int(), current_step_title: z.string().nullable(),
  estimated_completion: z.string().nullable(), submitted_at: z.string(), updated_at: z.string(),
}).meta({ id: "TrackerResponse" });
export const TrackDetail = z.object({
  timeline: z.array(z.object({ title: z.string(), at: z.string(), note: z.string().optional(), state: z.enum(["done", "current", "todo"]) })),
  needed: z.array(z.object({ kind: z.enum(["upload", "pay"]), label: z.string(), amount: z.number().int().optional() })),
  payment: z.object({ paid: z.number().int(), due: z.number().int(), method: z.string(), receipt: z.string().optional() }),
  institution: z.object({ name: z.string(), decision: z.string() }),
  documents: z.array(z.object({ name: z.string(), verified: z.boolean() })),
});

export class SubmitDto extends dto(SubmitIn) {}
export type SubmitInput = z.infer<typeof SubmitIn>;

export const DashboardOut = z.object({ needs: z.array(Need), requests: z.array(Summary), paymentsDue: z.array(PaymentLine), unread: z.number().int() }).meta({ id: "ClientDashboard" });
export class ActivityQueryDto extends dto(z.object({ year: z.string().regex(/^\d{4}$/).optional() })) {}
export const ActivityOut = z.object({ items: z.array(z.object({ id: z.string(), at: z.string(), kind: z.string(), title: z.string(), slug: z.string().optional(), ref: z.string().nullable(), amount: z.number().int().nullable() })) });
export const ListOut = z.object({ applications: z.array(Summary) }).meta({ id: "ApplicationListResponse" });
export class VerifyTrackDto extends dto(z.object({ contact: z.string().max(255).optional() })) {}
export const VerifyTrackOut = z.object({ token: z.string(), expires_in: z.number().int(), detail: TrackDetail });

// ---- support tickets
export const TicketOut = z
  .object({
    ref: z.string(),
    subject: z.string(),
    status: z.enum(["open", "waiting", "resolved"]),
    type: z.string().nullable(),
    contact: z.string().nullable(),
    caseRef: z.string().nullable(),
    createdAt: z.string(),
    messages: z.array(
      z.object({
        id: z.string(),
        from: z.enum(["me", "support"]),
        body: z.string(),
        at: z.string(),
      }),
    ),
    rating: z
      .object({ score: z.number().int(), comment: z.string() })
      .nullable(),
  })
  .meta({ id: "SupportTicket" });

export const TicketListOut = z.object({ tickets: z.array(TicketOut) });
export const TicketRefOut = z.object({ ref: z.string() });
/** The help screens' contract uses 400 validation_error (handlers-c4), not the pipeline's 422: bodies are loose, checked in the service. */
export class LooseDto extends dto(z.record(z.string(), z.unknown())) {}
// Fields all optional/loose so the service keeps its 400 validation_error; named so the contract types them.
export class TicketCreateDto extends dto(z.looseObject({ subject: z.string().optional(), message: z.string().optional(), type: z.string().optional(), contact: z.string().optional(), caseRef: z.string().optional() })) {}
export class TicketMessageDto extends dto(z.looseObject({ body: z.string().optional() })) {}
export class TicketRateDto extends dto(z.looseObject({ score: z.number().optional(), comment: z.string().optional() })) {}
