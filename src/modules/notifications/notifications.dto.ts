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
