// P3 notifications tables. `notifications` / `notification_preferences` mirror FastAPI notifications/models.py
// (they exist in production but not in the locally pulled schema). Additions vs Python, marked "P3":
// `channel` (delivery channel shown on the bell preview) and `data` (typed template vars, e.g. booking notes).
import { pgTable, varchar, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
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
