// System admin store (P10). Governance and configuration entities that have no FastAPI table (change requests, access
// reviews, waivers, break-glass, integrations, templates, rules, budgets, processors, retention, DSRs, incidents, ops
// read models, settings registry values, per-user IAM overlay) are one JSONB document keyed by (kind, id).
// Identity itself stays in `users` / `staff_profiles` / `auth_sessions`; the audit trail stays in `audit_log`.
// shortcut: document store + one advisory lock serialises system writes; fine for an admin console (tens of writes a
// day). Split hot collections (deliveries) into real tables when notification volume needs indexed queries.
import {
  pgTable,
  varchar,
  bigint,
  jsonb,
  timestamp,
  primaryKey,
  index,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const systemRecords = pgTable(
  "system_records",
  {
    kind: varchar({ length: 24 }).notNull(),
    id: varchar({ length: 96 }).notNull(),
    pos: bigint({ mode: "number" }).notNull(),
    data: jsonb().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.id] }),
    index("ix_system_records_pos").on(t.kind, t.pos),
  ],
);

// Transactional outbox: rows written in the business tx, relayed to BullMQ by the worker.
export const outbox = pgTable(
  "outbox",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    type: varchar({ length: 96 }).notNull(),
    payload: jsonb().notNull(),
    queue: varchar({ length: 16 }).notNull().default("default"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("ix_outbox_pending").on(t.runAt).where(sql`sent_at is null`)],
);

// Idempotency-Key replay store (24 h); expired rows are purged by the worker.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: varchar({ length: 128 }).notNull(),
    userId: varchar("user_id", { length: 64 }).notNull(),
    bodyHash: varchar("body_hash", { length: 64 }).notNull(),
    status: integer(),
    response: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.userId] }), index("ix_idempotency_keys_created_at").on(t.createdAt)],
);
