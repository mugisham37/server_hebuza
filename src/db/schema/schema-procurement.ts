// Procurement store (P7). Every procurement entity (vendor, contract, PR, PO, GRN, bill, payment, advance, budget,
// settings proposal, bank change, secret) is one JSONB document keyed by (kind, id); `pos` keeps list order.
// shortcut: document store + one advisory lock serialises procurement writes, fine for an office's volume (hundreds to
// low thousands of rows); upgrade to per-entity tables with row locks when spend volume or write concurrency grows.
import {
  pgTable,
  varchar,
  bigint,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

export const procurementRecords = pgTable(
  "procurement_records",
  {
    kind: varchar({ length: 24 }).notNull(),
    id: varchar({ length: 64 }).notNull(),
    pos: bigint({ mode: "number" }).notNull(),
    data: jsonb().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.id] }),
    index("ix_procurement_records_pos").on(t.kind, t.pos),
  ],
);
