import { z } from "zod";
import { dto } from "../../core/http/dto";

export const MAX_LIMIT = 100;
const NotificationOut = z.object({
  id: z.string(), channel: z.string(), kind: z.string(),
  type: z.string().optional(), vars: z.record(z.string(), z.string()).optional(),
  title: z.string(), body: z.string(), href: z.string(), read_at: z.string().nullable(), created_at: z.string(),
});
export const ListOut = z.object({ notifications: z.array(NotificationOut), unread_count: z.number().int() }).meta({ id: "NotificationListResponse" });
const Matrix = z.record(z.string().max(32), z.record(z.string().max(16), z.boolean()));
const Quiet = z.object({ on: z.boolean(), from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) });
export const PrefsOut = z.object({ email_enabled: z.boolean(), digest_enabled: z.boolean(), matrix: Matrix.optional(), quiet: Quiet.optional() }).meta({ id: "NotificationPreferencesResponse" });
const PrefsIn = z.object({ email_enabled: z.boolean().optional(), digest_enabled: z.boolean().optional(), matrix: Matrix.optional(), quiet: Quiet.optional() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(), unread: z.enum(["true", "false"]).optional() });
const ReadIn = z.object({ ids: z.array(z.string().max(64)).max(500).nullish() });
export const ReadOut = z.object({ updated: z.number().int(), unread_count: z.number().int() });

export class PrefsDto extends dto(PrefsIn) {}
export class ListQueryDto extends dto(ListQuery) {}
export class ReadDto extends dto(ReadIn) {}
export type Prefs = z.infer<typeof PrefsIn>;

// Provider webhooks (F-NTF-11) + inbound STOP (F-NTF-09). Shapes: Resend event JSON; Africa's Talking form posts.
const ResendEvent = z.object({ type: z.string().max(64), data: z.object({ email_id: z.string().max(128) }).loose() }).loose();
const AtStatus = z.object({ id: z.string().max(128), status: z.string().max(32), failureReason: z.string().max(128).optional() }).loose();
const AtInbound = z.object({ from: z.string().max(32), text: z.string().max(1600) }).loose();
const WaEvent = z.object({
  entry: z.array(z.object({ changes: z.array(z.object({ value: z.object({
    statuses: z.array(z.object({ id: z.string().max(128), status: z.string().max(16), errors: z.array(z.object({ title: z.string().max(256).optional() }).loose()).optional() }).loose()).optional(),
    messages: z.array(z.object({ from: z.string().max(32), text: z.object({ body: z.string().max(4096) }).optional() }).loose()).optional(),
  }).loose().optional() }).loose()).optional() }).loose()).max(50).optional(),
}).loose();
export class WaEventDto extends dto(WaEvent) {}
export const WebhookOut = z.object({ ok: z.boolean() });
export class ResendEventDto extends dto(ResendEvent) {}
export class AtStatusDto extends dto(AtStatus) {}
export class AtInboundDto extends dto(AtInbound) {}

// Cookie banner / settings consent (F-CMS-15, F-NTF-09). Anonymous visitors send their banner id.
const ConsentIn = z.object({
  anon_id: z.string().regex(/^[\w-]{8,64}$/).optional(),
  source: z.enum(["cookie_banner", "settings"]),
  policy_version: z.string().max(32).optional(),
  purposes: z.record(z.enum(["cookies_analytics", "cookies_marketing", "marketing_sms", "marketing_email", "marketing_whatsapp"]), z.boolean()),
});
export const ConsentOut = z.object({ recorded: z.number().int() });
export class ConsentDto extends dto(ConsentIn) {}

// F-NTF-17: staff send a one-off message to a client (goes through the normal delivery rules/preferences/consent).
const ManualIn = z.object({
  title: z.string().trim().min(3).max(120), body: z.string().trim().min(1).max(1000),
  channels: z.array(z.enum(["email", "sms", "whatsapp"])).max(3).default([]), link: z.string().max(300).regex(/^\/[\w/?=&.-]*$/).optional(),
});
export class ManualDto extends dto(ManualIn) {}
export const ManualOut = z.object({ queued: z.boolean() });
