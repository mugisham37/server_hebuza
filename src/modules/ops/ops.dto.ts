// Zod inputs moved verbatim from the reference ops.routes.ts (+ the admin-people extras).
// shortcut: outputs stay untyped like the reference (`out: z.any()`); tighten per screen when OpenAPI types are generated.
import { z } from "zod";
import { CASE_STATUSES } from "@/domain/domain/case-status";
import { dto } from "../../core/http/dto";

const Code = z.string().max(32);
const reason = z.string().trim().max(2000);
const Id = z.string().max(64);

export class CasesQueryDto extends dto(
  z.object({
    status: z.string().max(400).optional(),
    agent_id: Id.optional(),
    payment_status: z.string().max(32).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
) {}
export class StatusDto extends dto(
  z.object({
    status: z.enum(CASE_STATUSES),
    reason: reason.optional(),
    sub_status: z.string().max(200).optional(),
    resume_at: z.string().max(40).optional(),
  }),
) {}
export class AssignDto extends dto(
  z.object({ agent_id: Id, helpers: z.array(Id).max(5).optional() }),
) {}
export class ExternalQueryDto extends dto(
  z.object({ external: z.string().optional() }),
) {}
export class DuplicateDto extends dto(
  z.object({
    action: z.enum(["merge", "dismiss", "reject"]),
    into: Code.optional(),
  }),
) {}
export class ViewDto extends dto(
  z.object({
    name: z.string().max(80),
    query: z.string().max(2000),
    shared: z.boolean().default(false),
    isDefault: z.boolean().default(false),
  }),
) {}
export class DocDecisionDto extends dto(
  z.object({
    decision: z.enum(["accepted", "rejected"]).nullable(),
    reason: reason.optional(),
  }),
) {}
export class DocRequestDto extends dto(
  z.object({
    items: z
      .array(z.object({ key: Id, note: z.string().max(500).default("") }))
      .max(30),
    due: z.string().max(40),
    channels: z.array(z.string().max(16)).max(4),
    sub: z.string().max(200).optional(),
  }),
) {}
export class QuotationDto extends dto(
  z.object({
    lines: z
      .array(
        z.object({
          label: z.string().max(200),
          qty: z.number().int().min(1),
          unit: z.number().int().min(0),
        }),
      )
      .min(1)
      .max(50),
    discountPct: z.number().min(0).max(100),
    discountReason: z.string().max(500).optional(),
    validityDays: z.number().int().min(1).max(365),
    note: z.string().max(2000),
    sub: z.string().max(200).optional(),
  }),
) {}
export class ViewAsDto extends dto(
  z.object({
    reason: z.string().max(200).optional(),
    note: z.string().max(500).optional(),
  }),
) {}
export class NoteDto extends dto(z.object({ body: z.string().max(4000) })) {}
export class EntityQueryDto extends dto(z.object({ entity: Id.optional() })) {}
const Share = z.object({ id: Id, share: z.number().min(0).max(100) });
export class TermsDto extends dto(
  z.object({
    lead: Share,
    helpers: z.array(Share).max(5).optional(),
    price: z.number().int().min(0).optional(),
    override: z
      .object({
        agency: z.number().min(0).max(100),
        reason: z.string().max(500),
      })
      .optional(),
  }),
) {}
export class OverrideAssignDto extends dto(
  z.object({ agent_id: Id, reason: z.string().max(500) }),
) {}
export class BriefDto extends dto(
  z.looseObject({
    steps: z
      .array(z.object({ text: z.string().max(300), done: z.boolean() }))
      .max(30),
    deadline: z.string().max(40),
    instructions: z.string().max(4000).optional(),
  }),
) {}
export class ScopeDto extends dto(
  z.object({ scope: z.record(z.string(), z.record(z.string(), z.boolean())) }),
) {}
export class OfferDto extends dto(
  z.object({
    agent_id: Id,
    ttl_minutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .optional(),
  }),
) {}
export class ReassignDto extends dto(
  z.object({
    to: Id,
    reason: z.string().max(200),
    note: z.string().max(1000).optional(),
    handoff: z.string().max(2000).optional(),
    revoke: z.boolean(),
    split_pct: z.number().optional(),
    notify: z.boolean(),
  }),
) {}
export class AutoAssignDto extends dto(
  z.object({
    mode: z.enum(["roundRobin", "leastLoaded", "skill"]),
    pool: z.array(Id).max(100),
    cap: z.number().int(),
    vipApproval: z.boolean(),
  }),
) {}

// lane C/D
export class WeekQueryDto extends dto(
  z.object({ week: z.coerce.number().int().min(-52).max(52).optional() }),
) {}
export class CapDto extends dto(
  z.object({
    daily_case_cap: z.number().int().optional(), // max concurrent open cases (historic name)
    new_per_day: z.number().int().min(1).max(100).nullable().optional(), // F-WRK-09 daily intake limit; null clears it
    reason: z.string().max(500).optional(),
  }),
) {}
export class RebalanceDto extends dto(
  z.object({ from: Id, to: Id, refs: z.array(Code).max(100) }),
) {}
export class ApprovalDecisionDto extends dto(
  z.object({ decision: z.enum(["approve", "decline", "pending"]) }),
) {}
export class DueDto extends dto(
  z.object({
    due_date: z.string().max(10),
    note: z.string().max(500).optional(),
  }),
) {}
export class EscalateDto extends dto(
  z
    .object({
      reason: z.string().max(500).optional(),
      note: z.string().max(1000).optional(),
    })
    .optional()
    .default({}),
) {}
export class TabQueryDto extends dto(
  z.object({ tab: z.string().max(16).optional() }),
) {}
export class ReviewCommentDto extends dto(
  z.object({
    fileId: z.string().max(128),
    body: z.string().max(2000),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
  }),
) {}
export class ReviewDecisionDto extends dto(
  z.object({
    decision: z.enum(["approve", "approve_release", "return", "reopen"]),
    note: z.string().max(2000).optional(),
    due: z.string().max(10).optional(),
  }),
) {}
export class ReviewOverrideDto extends dto(
  z.object({
    reason: z.string().max(200),
    note: z.string().max(1000).optional(),
    proof: z.string().max(500).nullable(),
  }),
) {}
export class AllocationDto extends dto(
  z.object({
    shares: z
      .array(
        z.object({
          id: Id,
          name: z.string().max(255),
          pct: z.number().int().min(0).max(100),
        }),
      )
      .min(1)
      .max(10),
    reason: z.string().max(500).default(""),
  }),
) {}
export class TicketsQueryDto extends dto(
  z.object({
    tab: z.enum(["complaints", "disputes", "enquiries", "resolved"]).optional(),
  }),
) {}
export class TicketDto extends dto(
  z.object({
    kind: z.enum(["complaint", "dispute", "enquiry"]),
    category: z.string().max(32),
    caseRef: Code,
    note: z.string().trim().min(1).max(4000),
  }),
) {}
export class TicketActionDto extends dto(
  z.looseObject({
    action: z.enum([
      "message",
      "refund",
      "credit",
      "reassign",
      "escalate",
      "resolve",
      "confirm",
      "reopen",
      "severity",
    ]),
    body: z.string().max(4000).optional(),
    reason: z.string().max(1000).optional(),
    amount: z.number().int().optional(),
    agentId: Id.optional(),
    note: z.string().max(1000).optional(),
    summary: z.string().max(2000).optional(),
    rootCause: Id.optional(),
    preventive: z.string().max(2000).optional(),
  }),
) {}

export class AssignmentBlockDto extends dto(
  z.object({ agentId: Id, clientId: Id, reason: z.string().trim().min(3).max(500) }),
) {}
export class AssignmentBlockQueryDto extends dto(z.object({ agentId: Id.optional(), clientId: Id.optional() })) {}
export class EnquiryActionDto extends dto(
  z.object({ action: z.enum(["assign", "reply", "close", "convert"]), agentId: z.string().max(64).optional(), body: z.string().max(4000).optional() }),
) {}
