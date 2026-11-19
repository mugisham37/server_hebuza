// Zod schemas from the reference chat.routes.tsx, widened to the contract (openapi.json /api/chat, /api/admin/chat).
import { z } from "zod";
import type { Role } from "@/domain/auth/roles";
import { dto } from "../../core/http/dto";
import { UploadIn } from "../documents/documents.files";

export const STAFF: Role[] = [
  "staff:agent",
  "ext:agent",
  "staff:service_manager",
  "staff:executive",
  "staff:finance",
  "staff:sysadmin",
  "staff:partner_manager",
  "staff:marketing",
  "staff:procurement",
];
export const SMR: Role[] = ["staff:service_manager", "staff:executive"];
export const SM: Role[] = ["staff:service_manager"];

const id = z.string().max(64);
const seq = z.coerce.number().int().optional();

export class ListQueryDto extends dto(
  z.object({
    kind: z.string().max(24).optional(),
    q: z.string().max(120).optional(),
    filter: z.string().max(24).optional(),
    lane: z.string().max(16).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().max(200).optional(),
  }),
) {}
export class CreateConvDto extends dto(
  z.object({
    kind: z.enum(["direct_staff", "staff_dm"]),
    user_id: id.optional(),
    participant_id: id.nullish(),
  }),
) {}
export class MessagesQueryDto extends dto(
  z.object({
    before: seq,
    after: seq,
    before_seq: seq,
    after_seq: seq,
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
) {}
export class SendDto extends dto(
  z.object({
    client_msg_id: z.string().min(1).max(64),
    content: z.string().max(4000),
    lane: z.enum(["client", "team", "internal"]),
    mentions: z.array(id).max(10).optional(),
    reply_to_id: id.nullish(),
    attachment_ids: z.array(id).max(10).optional(),
    references: z
      .array(z.object({ type: z.string().max(32), ref: z.string().max(64) }))
      .max(10)
      .optional(),
  }),
) {}
export class AttachDto extends dto(UploadIn) {}
export class SeqDto extends dto(
  z.object({ seq: z.number().int().optional() }).optional().default({}),
) {}
export class SearchQueryDto extends dto(
  z.object({ q: z.string().max(120).default("") }),
) {}
export class TypingDto extends dto(
  z
    .object({ lane: z.string().max(16).nullish() })
    .optional()
    .default({}),
) {}
export class MuteDto extends dto(
  z.object({
    until: z.string().datetime().nullish(),
    hours: z
      .number()
      .int()
      .min(0)
      .max(24 * 365)
      .nullish(),
    muted: z.boolean().optional(),
  }),
) {}
export class LaneDto extends dto(z.object({ open: z.boolean() })) {}
export class DisputeDto extends dto(
  z.object({
    category: z.string().max(32),
    note: z.string().trim().min(1).max(2000),
  }),
) {}
export class ResolveDto extends dto(
  z.object({
    resolution_kind: z.string().max(32),
    note: z.string().max(2000).nullish(),
    reassign_agent_id: id.nullish(),
  }),
) {}
export class EditDto extends dto(
  z.object({ content: z.string().trim().min(1).max(4000) }),
) {}
export class ReactDto extends dto(
  z.object({ emoji: z.string().min(1).max(16) }),
) {}
export class CardDto extends dto(
  z.object({
    kind: z.string().max(24),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
) {}
export class ComplaintDto extends dto(z.object({ summary: z.string().trim().min(10).max(2000) })) {}
export class HoldDto extends dto(z.object({ on: z.boolean() })) {}
export class CardActionDto extends dto(z.object({ action: z.enum(["accept", "decline"]) })) {}
export class TemplateDto extends dto(
  z.object({
    title: z.string().trim().min(1).max(120),
    body_rw: z.string().max(4000),
    body_en: z.string().max(4000),
    body_fr: z.string().max(4000),
    scope: z.enum(["all", "global", "agent"]).optional(),
    is_active: z.boolean().optional(),
  }),
) {}
export class TemplatePatchDto extends dto(TemplateDto.schema.partial()) {}
export class RenderQueryDto extends dto(
  z.object({ locale: z.enum(["rw", "en", "fr"]).optional() }),
) {}
export class RenderDto extends dto(z.object({ conversation_id: id })) {}
export class RefQueryDto extends dto(
  z.object({
    q: z.string().max(120).optional(),
    type: z.string().max(32).optional(),
  }),
) {}
export class AdminListQueryDto extends dto(
  z.object({
    handoff: z.string().max(8).optional(),
    unassigned: z.string().max(8).optional(),
    agent_id: id.optional(),
    waiting_hours: z.string().max(8).optional(),
    waiting_on: z.string().max(16).optional(),
    disputes: z.string().max(8).optional(),
    has_internal_notes: z.string().max(8).optional(),
    q: z.string().max(120).optional(),
  }),
) {}
export class LinkDto extends dto(
  z.object({
    code: z.string().max(32).optional(),
    application_code: z.string().max(32).optional(),
  }),
) {}
export class TranscriptQueryDto extends dto(
  z.object({
    include_internal: z.enum(["true", "false"]).optional(),
    format: z.enum(["pdf", "csv"]).optional(),
  }),
) {}

// ---- responses (loose: extra fields pass through; these name what the client portal reads)
const S = z.string(), SN = z.string().nullable();
export const AttachmentOut = z.looseObject({
  id: S, filename: S, mime: S, size: z.number(), lane: S, has_thumbnail: z.boolean(), scan_status: S, created_at: S,
}).meta({ id: "ChatAttachment" });
export const AttachOut = AttachmentOut.extend({
  upload: z.object({ url: S, key: S, expiresAt: S }).nullable(),
}).meta({ id: "ChatAttachUpload" });
export const MessageOut = z.looseObject({
  message_id: S, conversation_id: S, seq: z.number(), client_msg_id: SN, sender_id: SN, sender_name: SN, sender_role: S,
  content: S, lane: S, kind: S, is_system: z.boolean(), mentions: z.array(S),
  reactions: z.array(z.object({ emoji: S, user_ids: z.array(S) })), created_at: S, reply_to_id: SN,
  edited_at: SN, deleted_at: SN, pinned_at: SN, attachments: z.array(z.unknown()), payload: z.unknown(),
}).meta({ id: "ChatMessage" });
const Participant = z.looseObject({ user_id: S, name: S, role: S, last_read_seq: z.number(), last_delivered_seq: z.number() });
export const MessagesOut = z.looseObject({
  conversation_id: S, messages: z.array(MessageOut), has_more_before: z.boolean(), has_more_after: z.boolean(),
  latest_seq: z.number(), lanes: z.array(S), write_lanes: z.array(S), participants: z.array(Participant),
}).meta({ id: "ChatMessagePage" });
const ConvRow = z.looseObject({
  conversation_id: S, kind: S, code: SN, title: SN, client_name: SN, last_message_preview: SN, last_message_at: SN,
  waiting_since: SN, unread: z.number(), has_dispute: z.boolean(), claimed_by: SN, claimed_by_name: SN,
});
export const ConversationListOut = z.looseObject({
  conversations: z.array(ConvRow.extend({ muted: z.boolean() })), unread_total: z.number(), next_cursor: SN,
}).meta({ id: "ChatConversationList" });
export const ConversationOut = ConvRow.extend({
  lanes: z.array(S), write_lanes: z.array(S), latest_seq: z.number(), last_read_seq: z.number(), muted: z.boolean(),
  partner_lane: z.boolean(), application_code: SN,
}).meta({ id: "ChatConversation" });
