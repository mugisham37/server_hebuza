// P3 notifications tables. `notifications` / `notification_preferences` mirror FastAPI notifications/models.py
// (they exist in production but not in the locally pulled schema). Additions vs Python, marked "P3":
// `channel` (delivery channel shown on the bell preview) and `data` (typed template vars, e.g. booking notes).
import { pgTable, varchar, timestamp, boolean, jsonb, index, integer, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./schema";

export const notifications = pgTable("notifications", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.userId, { onDelete: "cascade" }),
  kind: varchar({ length: 48 }).notNull(),
  title: varchar({ length: 255 }).notNull(),
  body: varchar({ length: 1024 }),
  href: varchar({ length: 1024 }),
  conversationId: varchar("conversation_id", { length: 64 }),
  channel: varchar({ length: 16 }).default("in_app").notNull(), // P3
  data: jsonb(), // P3: { type, vars }
  readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [
  index("ix_notifications_user_created").on(t.userId, t.createdAt),
  index("ix_notifications_user_unread").on(t.userId, t.readAt),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  userId: varchar("user_id", { length: 64 }).primaryKey().notNull().references(() => users.userId, { onDelete: "cascade" }),
  emailEnabled: boolean("email_enabled").notNull(),
  digestEnabled: boolean("digest_enabled").notNull(),
  lastDigestAt: timestamp("last_digest_at", { withTimezone: true, mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  channels: jsonb(), // P13: { matrix: category × channel, quiet: { on, from, to } } (F-NTF-03)
});

// F-NTF-11: one row per external send attempt chain (email / sms / whatsapp). Status moves queued → sent → delivered/read
// (provider webhook) or failed; `deferred` (quiet hours), `skipped` (preference), `suppressed`, `capped`, `duplicate`.
export const notificationDeliveries = pgTable("notification_deliveries", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  notificationId: varchar("notification_id", { length: 64 }),
  userId: varchar("user_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  kind: varchar({ length: 64 }).notNull(),
  channel: varchar({ length: 16 }).notNull(),
  toMasked: varchar("to_masked", { length: 64 }).notNull(),
  templateKey: varchar("template_key", { length: 96 }),
  lang: varchar({ length: 8 }).notNull(),
  status: varchar({ length: 16 }).notNull(),
  provider: varchar({ length: 24 }),
  providerId: varchar("provider_id", { length: 128 }),
  attempts: integer().default(0).notNull(),
  lastError: varchar("last_error", { length: 512 }),
  costRwf: integer("cost_rwf").default(0).notNull(),
  /** Remaining fallback chain after this channel (F-NTF-06). */
  chain: jsonb().$type<string[]>(),
  fallbackFrom: varchar("fallback_from", { length: 64 }),
  dedupeKey: varchar("dedupe_key", { length: 255 }),
  payload: jsonb().$type<{ subject: string; text: string; html?: string; wa?: { name: string; lang: string; params: string[] } }>(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "string" }),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [
  index("ix_ntf_deliveries_created").on(t.createdAt),
  index("ix_ntf_deliveries_status").on(t.status, t.createdAt),
  index("ix_ntf_deliveries_dedupe").on(t.dedupeKey, t.createdAt),
  index("ix_ntf_deliveries_provider").on(t.providerId),
  index("ix_ntf_deliveries_notification").on(t.notificationId),
]);

// F-NTF-15: addresses we must not send to (hard bounce, complaint, STOP reply, manual). Keyed by channel + address.
export const notificationSuppressions = pgTable("notification_suppressions", {
  channel: varchar({ length: 16 }).notNull(),
  address: varchar({ length: 255 }).notNull(),
  reason: varchar({ length: 24 }).notNull(), // bounce | complaint | stop | manual
  source: varchar({ length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.channel, t.address] })]);

// F-NTF-09 / F-CMS-15: append-only consent ledger. Current state = latest row per (subject, purpose).
export const consentLedger = pgTable("consent_ledger", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  userId: varchar("user_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  /** user id, phone (E.164), email or anonymous cookie id. */
  subject: varchar({ length: 255 }).notNull(),
  purpose: varchar({ length: 48 }).notNull(), // marketing_sms | marketing_email | marketing_whatsapp | cookies_analytics | cookies_marketing
  granted: boolean().notNull(),
  source: varchar({ length: 32 }).notNull(), // cookie_banner | settings | stop_keyword | start_keyword | crm | signup
  policyVersion: varchar("policy_version", { length: 32 }).notNull(),
  ip: varchar({ length: 64 }),
  userAgent: varchar("user_agent", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_consent_subject_purpose").on(t.subject, t.purpose, t.createdAt)]);

// F-NTF-18: Web Push subscriptions (one per browser). Push messages carry no payload; the service worker fetches the
// newest notification, so nothing personal transits the push service.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.userId, { onDelete: "cascade" }),
  endpoint: varchar({ length: 1024 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_push_subscriptions_user").on(t.userId)]);
