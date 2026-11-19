// Zod schemas moved verbatim from .ref marketing.routes.ts (inline route bodies became the named schemas below).
import { z } from "zod";
import type { Role } from "@/domain/auth/roles";
import { LOCALES, type Locale } from "@/domain/marketing/types";
import { dto } from "../../core/http/dto";

export const MKT: readonly Role[] = ["staff:marketing"];
export const MKT_EX: readonly Role[] = ["staff:marketing", "staff:executive"];
export const MKT_SM: readonly Role[] = ["staff:marketing", "staff:service_manager"];
export const STAFF: readonly Role[] = ["staff:marketing", "staff:service_manager", "staff:executive"];

// ---------------------------------------------------------------- schemas
export const Lang = z.enum(LOCALES as [Locale, ...Locale[]]);
export const Channel = z.enum(["email", "whatsapp", "sms"]);
export const Consent = z.enum(["in", "out", "unknown"]);
export const ConsentMap = z.object({
  email: Consent,
  whatsapp: Consent,
  sms: Consent,
});
export const Source = z.enum([
  "contact_form",
  "booking",
  "ai",
  "quote_request",
  "landing_form",
  "whatsapp",
  "sms",
  "email",
  "manual",
  "csv",
  "event",
  "referral",
]);
export const Stage = z.enum([
  "new",
  "contacted",
  "qualified",
  "quote_sent",
  "won",
  "lost",
  "merged",
]);
export const Lost = z.enum([
  "price",
  "timing",
  "competitor",
  "no_response",
  "not_eligible",
  "other",
]);
export const Iso = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");
export const Id = z.string().trim().min(1).max(128);
export const Ids = z.array(Id).max(5000);
export const Touch = z.object({
  source: z.string().max(80),
  medium: z.string().max(80),
  campaign: z.string().max(120).optional(),
  term: z.string().max(120).optional(),
  content: z.string().max(120).optional(),
  gclid: z.string().max(200).optional(),
  fbclid: z.string().max(200).optional(),
  referrer: z.string().max(512).optional(),
  landing: z.string().max(512),
  at: Iso,
});
// Malformed attribution from a browser never blocks a lead: it is dropped instead.
export const Attribution = z
  .object({ first: Touch.optional().catch(undefined), last: Touch.optional().catch(undefined) })
  .optional()
  .catch(undefined);
type Rule = { field: string; op: string; value: unknown };
export type Group = { join: "and" | "or"; rules: (Rule | Group)[] };
export const SegRule = z.object({
  field: z.enum([
    "service_used",
    "category_interest",
    "sector",
    "district",
    "province",
    "company_size",
    "subscription",
    "last_active_days",
    "ltv",
    "language",
    "obligation",
    "consent_email",
    "consent_whatsapp",
    "consent_sms",
  ]),
  op: z.enum([
    "is",
    "is_not",
    "in",
    "lt",
    "lte",
    "gt",
    "gte",
    "before",
    "after",
    "within_days",
  ]),
  value: z.unknown(),
});
export const SegGroup: z.ZodType<Group> = z.lazy(() =>
  z.object({
    join: z.enum(["and", "or"]),
    rules: z.array(z.union([SegRule, SegGroup])).max(30),
  }),
) as z.ZodType<Group>;
export const TplRef = z.object({
  templateKey: z.string().max(80).optional(),
  subjectA: z.string().max(200).optional(),
  subjectB: z.string().max(200).optional(),
  abSplit: z.number().int().min(0).max(100).optional(),
  body: z.string().max(4000).optional(),
});
export const CampaignIn = z.object({
  name: z.string().trim().max(160).optional(),
  slug: z.string().trim().max(80).optional(),
  channel: Channel.optional(),
  segmentId: Id.optional(),
  templates: z.partialRecord(Lang, TplRef).optional(),
  fallbackLanguage: Lang.optional(),
  scheduledAt: Iso.optional(),
  throttle: z.number().int().min(1).max(10_000).optional(),
});
export const Step = z.object({
  waitDays: z.number().int().min(0).max(365),
  action: z.enum(["send_template", "create_task", "set_stage"]),
  params: z.record(z.string(), z.unknown()),
});
export const RuleIn = z.object({
  name: z.string().trim().max(160).optional(),
  trigger: z
    .enum([
      "quote_sent_no_reply",
      "info_requested_no_reply",
      "consultation_attended_no_case",
      "draft_abandoned_24h",
      "inactive_90d",
      "manual",
    ])
    .optional(),
  steps: z.array(Step).max(20).optional(),
  exit: z
    .array(z.enum(["replied", "paid", "unsubscribed", "won", "lost"]))
    .optional(),
  conditions: SegGroup.optional(),
  frequencyCap: z.number().int().min(1).max(14).optional(),
  active: z.boolean().optional(),
});
export const RangeQ = z.object({
  range: z.enum(["today", "7d", "30d", "90d", "custom"]).optional(),
  from: z.string().max(32).optional(),
  to: z.string().max(32).optional(),
  model: z.enum(["last", "first"]).optional(),
  source: z.string().max(40).optional(),
  service: z.string().max(80).optional(),
  report: z.string().max(40).optional(),
  format: z.enum(["csv", "xlsx", "pdf"]).optional(),
});
export const Social = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  network: z.string().trim().min(1).max(40),
  campaign: z.string().trim().min(1).max(120),
  reach: z.number().int().min(0),
  impressions: z.number().int().min(0),
  engagements: z.number().int().min(0),
  clicks: z.number().int().min(0),
  followers: z.number().int().min(0),
  spend: z.number().int().min(0),
});

export class CampaignDto extends dto(CampaignIn) {}
export class RuleDto extends dto(RuleIn) {}
export class RangeDto extends dto(RangeQ) {}
export class SocialDto extends dto(Social) {}

export class PublicLeadDto extends dto(
  z.object({
    name: z.string().max(120).optional(),
    phone: z.string().max(40).optional(),
    email: z.string().max(254).optional(),
    website: z.string().max(200).optional(),
    service: z.string().max(80).optional(),
    language: Lang.optional(),
    // Landing forms send "in"/"unknown"; older forms send booleans.
    consent: z
      .partialRecord(Channel, z.union([z.boolean(), Consent]))
      .optional()
      .transform((m) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === true || v === "in"])) : undefined)),
    attribution: Attribution,
    campaign: z.string().max(120).optional(),
    businessType: z.string().trim().max(80).optional(),
    landing: z.string().trim().max(200).optional(),
    source: Source.optional(),
  }),
) {}
export class BulkDto extends dto(z.object({ ids: Ids, ownerId: Id.optional(), tag: z.string().trim().min(1).max(40).optional() })) {}
export class IdsDto extends dto(z.object({ ids: Ids })) {}
export class MergeDto extends dto(z.object({ survivorId: Id, ids: Ids.min(1) })) {}
export class ImportDto extends dto(
  z.object({
    rows: z.array(z.record(z.string(), z.string().max(500))).max(5000),
    mapping: z.record(z.string(), z.string().max(120)),
  }),
) {}
export class StaffLeadDto extends dto(
  z.object({
    source: Source,
    name: z.string().trim().min(1).max(120),
    org: z.string().max(160).optional(),
    phone: z.string().max(40).optional(),
    email: z.string().max(254).optional(),
    language: Lang.default("rw"),
    serviceInterest: z.array(z.string().max(80)).max(10).default([]),
    consent: ConsentMap.partial().default({}),
    nextActionAt: Iso.optional(),
    ownerId: Id.optional(),
    force: z.boolean().optional(),
  }),
) {}
export class LeadPatchDto extends dto(
  z.object({
    stage: Stage.optional(),
    lostReason: Lost.optional(),
    lostNote: z.string().max(1000).optional(),
    // null clears a field; the key stays present so the service sees the change ("key in body").
    ownerId: Id.nullable().optional(),
    nextActionAt: Iso.nullable().optional(),
    estimatedValue: z.number().int().min(0).max(1e12).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    serviceInterest: z.array(z.string().max(80)).max(10).optional(),
  }),
) {}
export class ActivityDto extends dto(z.object({ kind: z.enum(["call", "message", "email"]), text: z.string().max(2000).optional() })) {}
export class ConvertDto extends dto(z.object({ mode: z.enum(["link", "invite"]), clientId: Id.optional() })) {}
export class TaskDto extends dto(
  z.object({
    subject: z.object({ type: z.enum(["lead", "customer"]), id: Id, label: z.string().max(160) }),
    kind: z.enum(["call", "email", "meeting", "follow_up"]).optional(),
    title: z.string().trim().min(1).max(200),
    dueAt: Iso,
    assigneeId: Id.optional(),
  }),
) {}
export class TaskPatchDto extends dto(z.object({ done: z.boolean().optional(), title: z.string().max(200).optional(), dueAt: Iso.optional() })) {}
export class NoteDto extends dto(z.object({ body: z.string().trim().min(1, "Write a note.").max(5000), mentions: z.array(Id).max(20).optional() })) {}
export class ReplyDto extends dto(z.object({ body: z.string().max(4000).optional(), template: Id.optional() })) {}
export class ThreadActionDto extends dto(z.object({ value: z.string().max(128).optional() }).passthrough()) {}
export class CustomersQueryDto extends dto(z.object({ lead: Id.optional() })) {}
export class SegPreviewDto extends dto(z.object({ definition: SegGroup, channel: Channel })) {}
export class SegCreateDto extends dto(z.object({ name: z.string().trim().min(1, "name").max(120), definition: SegGroup })) {}
export class SegPatchDto extends dto(z.object({ name: z.string().trim().max(120).optional(), definition: SegGroup.optional() })) {}
export class StatusQueryDto extends dto(z.object({ status: z.string().max(24).optional() })) {}
export class StateQueryDto extends dto(z.object({ state: z.string().max(24).optional() })) {}
export class CampaignActionDto extends dto(
  z
    .object({
      approverId: Id.optional(),
      reason: z.string().max(1000).optional(),
      at: Iso.optional(),
      raiseCap: z.boolean().optional(),
    })
    .passthrough(),
) {}
export class TemplatesQueryDto extends dto(
  z.object({
    category: z.string().max(24).optional(),
    channel: z.string().max(12).optional(),
    status: z.string().max(32).optional(),
  }),
) {}
export class TemplateCreateDto extends dto(
  z.object({
    key: z
      .string()
      .regex(/^[a-z0-9_]+$/, "key")
      .max(80),
    name: z.string().trim().min(1).max(120),
    channel: Channel,
    language: Lang,
    body: z.string().min(1).max(4000),
    subject: z.string().max(200).optional(),
  }),
) {}
export class TemplatePatchDto extends dto(
  z.object({
    body: z.string().min(1).max(4000).optional(),
    subject: z.string().max(200).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  }),
) {}
export class DecisionDto extends dto(z.object({ decision: z.enum(["approve", "reject"]) })) {}
export class ActiveQueryDto extends dto(z.object({ active: z.string().max(5).optional() })) {}
export class EnrolDto extends dto(z.object({ leadIds: Ids })) {}
export class CsvDto extends dto(z.object({ csv: z.string().max(2_000_000) })) {}
export class TestimonialsQueryDto extends dto(z.object({ status: z.enum(["pending", "published", "rejected"]).optional() })) {}
export class TestimonialActionDto extends dto(
  z.object({
    placements: z
      .array(z.enum(["home", "service", "landing"]))
      .max(3)
      .optional(),
    reason: z.string().max(1000).optional(),
    excerpt: z.string().max(2000).optional(),
  }),
) {}
export class ProgrammeDto extends dto(
  z.object({
    active: z.boolean().optional(),
    reward: z.number().int("Whole RWF").min(0).max(10_000_000).optional(),
    channels: z.array(z.enum(["client", "agent"])).optional(),
  }),
) {}
export class MediaUploadDto extends dto(
  z.object({
    filename: z.string().trim().min(1).max(200),
    mime: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
    size: z.number().int().positive().max(50 * 1024 * 1024),
    alt: z.partialRecord(Lang, z.string().max(300)).optional(),
    credit: z.string().max(200).optional(),
    licence: z.string().max(200).optional(),
    replaceId: z.string().max(64).optional(),
  }),
) {}
export const MediaPresignOut = z.object({ id: z.string(), upload: z.object({ url: z.string(), key: z.string(), expiresAt: z.string() }) }).meta({ id: "MediaPresignResponse" });
export class MediaPatchDto extends dto(
  z
    .object({
      alt: z.partialRecord(Lang, z.string().max(300)).optional(),
      credit: z.string().max(200).optional(),
      licence: z.string().max(200).optional(),
      focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
    })
    .passthrough(),
) {}
export class MediaQueryDto extends dto(z.object({ w: z.coerce.number().int().min(1).max(4000).optional() })) {}
export class TrackingDto extends dto(
  z
    .object({
      ga4Id: z.string().max(20).default(""),
      gscToken: z.string().max(200).default(""),
      adsIds: z.array(z.string().max(20)).max(10).default([]),
      pixelId: z.string().max(24).default(""),
    })
    .passthrough(),
) {}
export class SpeedDto extends dto(z.object({ page: z.string().max(300) })) {}
export class RangeStrDto extends dto(z.object({ range: z.string().max(8).optional() })) {}
export class UnsubscribeDto extends dto(z.object({ token: z.string().min(16).max(2000) })) {}

export class SiteEventDto extends dto(z.object({
  name: z.enum(["page_view", "cta_click", "search", "form_submit"]),
  path: z.string().regex(/^\/(?!\/)/).max(512),
  locale: z.enum(["rw", "en", "fr"]).optional(),
  referrer: z.string().max(512).optional(),
  visitor: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  props: z.record(z.string().max(32), z.string().max(200)).refine((o) => Object.keys(o).length <= 10).optional(),
})) {}
export class EventSummaryQueryDto extends dto(z.object({ days: z.coerce.number().int().min(1).max(365).optional() })) {}
export class RecRulesDto extends dto(z.object({ items: z.array(z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), ifUsed: z.string().regex(/^(\*|[a-z0-9]+(-[a-z0-9]+)*)$/).max(128),
  recommend: z.array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(128)).min(1).max(5), active: z.boolean(),
})).max(100) })) {}
export class PromoDto extends dto(z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,32}$/), kind: z.enum(["percent", "amount"]), value: z.number().int().min(1).max(100_000_000),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  maxUses: z.number().int().min(1).optional(), active: z.boolean(), services: z.array(z.string().max(128)).max(50).optional(),
}).refine((p) => p.kind !== "percent" || p.value <= 100, "Percent must be 1–100.")) {}
export class PromoCheckDto extends dto(z.object({ service: z.string().max(128).optional() })) {}
