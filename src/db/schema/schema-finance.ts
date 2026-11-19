// Finance (P6) tables. New; the integrator generates the migration from this file.
// shortcut: finance aggregates (quotes, invoices, payments, refunds, allocations, batches, settings…) are typed JSONB
// documents keyed by (kind, id) with a status/ref index, ported 1:1 from the mock worlds so the contract holds; split the
// hot kinds (invoice, payment, statement_line) into column tables when any kind passes ~100k rows or needs SQL reporting.
import { payments } from "./schema";
import {
  pgTable,
  varchar,
  jsonb,
  integer,
  timestamp,
  index,
  primaryKey,
  doublePrecision,
} from "drizzle-orm/pg-core";

export const financeRecords = pgTable(
  "finance_records",
  {
    kind: varchar({ length: 24 }).notNull(),
    id: varchar({ length: 96 }).notNull(),
    /** Lifecycle state (queue filters); mirrors data.status/state. */
    status: varchar({ length: 32 }),
    /** Secondary business key (invoice/quote number, client id of a note…). */
    ref: varchar({ length: 96 }),
    data: jsonb().notNull(),
    rev: integer().notNull().default(1),
    /** Finance payment ↔ gateway transaction (payments.payment_id); null for other kinds and manual entries. */
    gatewayPaymentId: varchar("gateway_payment_id", { length: 64 }).references(() => payments.paymentId, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_finance_records", columns: [t.kind, t.id] }),
    index("ix_finance_records_kind_status").on(t.kind, t.status),
    index("ix_finance_records_kind_ref").on(t.kind, t.ref),
    index("ix_finance_records_gateway_payment").on(t.gatewayPaymentId),
  ],
);

/** Gapless document numbers per series and year (A-4): `INV-2026` → last issued. Taken with UPDATE … RETURNING in the caller's transaction. */
export const financeSequences = pgTable("finance_sequences", {
  key: varchar({ length: 32 }).primaryKey().notNull(),
  last: integer().notNull().default(0),
});

/** F-RPT-07: one row per closed day and metric (finance facts in RWF/counts), written by the nightly reports.rollup
 *  job and the on-demand backfill. The engine reads these for closed days and live records for today. */
export const rptDailyFacts = pgTable(
  "rpt_daily_facts",
  {
    day: varchar({ length: 10 }).notNull(), // YYYY-MM-DD (Africa/Kigali business day, same as finance `today()`)
    metric: varchar({ length: 32 }).notNull(),
    value: doublePrecision().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [primaryKey({ name: "pk_rpt_daily_facts", columns: [t.day, t.metric] })],
);
