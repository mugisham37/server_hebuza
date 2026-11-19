// P1 auth tables that FastAPI never had. DDL for the integrator's migration is in the P1 report;
// refresh_tokens / password_reset_tokens / backup_codes / staff_profiles stay in schema.ts (pulled).
import { pgTable, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./schema";

const ts = (n: string) => timestamp(n, { withTimezone: true, mode: "string" });

/** One row per sign-in = one refresh-token family (refresh_tokens.family_id). Drives "your sessions" lists. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(), // = refresh family id
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    device: varchar({ length: 128 }).notNull(),
    ip: varchar({ length: 64 }),
    city: varchar({ length: 64 }),
    createdAt: ts("created_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    /** IAM-11: last real user input (web activity ping); the idle timeout counts from here, not from token refreshes. */
    lastActivityAt: ts("last_activity_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("ix_auth_sessions_user_id").on(t.userId)],
);

/** "Remember this device" after MFA. The cookie holds a random token; only its sha256 is stored. */
export const authTrustedDevices = pgTable(
  "auth_trusted_devices",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    label: varchar({ length: 128 }).notNull(),
    place: varchar({ length: 64 }),
    trustedUntil: ts("trusted_until").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at").notNull(),
  },
  (t) => [index("ix_auth_trusted_devices_user_id").on(t.userId)],
);

/** View-as sessions (F-IAM-15). At most one open row per actor (ended_at null). */
export const authImpersonations = pgTable(
  "auth_impersonations",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    actorId: varchar("actor_id", { length: 64 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    targetId: varchar("target_id", { length: 64 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    reason: varchar({ length: 500 }).notNull(),
    startedAt: ts("started_at").notNull(),
    until: ts("until").notNull(),
    endedAt: ts("ended_at"),
    endedBy: varchar("ended_by", { length: 16 }),
  },
  (t) => [index("ix_auth_impersonations_actor_id").on(t.actorId)],
);
