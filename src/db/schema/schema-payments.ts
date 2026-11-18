// Payments additions (P4): idempotent webhook event store and a client's saved payment methods.
// Payments themselves stay on the existing `payments` / `payment_splits` tables (schema.ts).
import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  unique,
  index,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./schema";

/** Every accepted webhook, keyed by provider + event key; a replayed event is a no-op (plan §4 webhooks). */
export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    provider: varchar({ length: 16 }).notNull(),
    eventKey: varchar("event_key", { length: 128 }).notNull(),
    transactionId: varchar("transaction_id", { length: 64 }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("uq_payment_webhook_events_key").on(t.provider, t.eventKey)],
);

export const clientPaymentMethods = pgTable(
  "client_payment_methods",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    kind: varchar({ length: 8 }).notNull(),
    label: varchar({ length: 64 }).notNull(),
    last4: varchar({ length: 4 }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("uq_client_payment_methods").on(
      t.clientId,
      t.kind,
      t.label,
      t.last4,
    ),
    index("ix_client_payment_methods_client_id").on(t.clientId),
    check("ck_client_payment_methods_kind", sql`${t.kind} in ('momo','card')`),
    foreignKey({
      columns: [t.clientId],
      foreignColumns: [users.userId],
      name: "fk_client_payment_methods_client_id",
    }).onDelete("cascade"),
  ],
);
