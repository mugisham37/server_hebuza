// Catalogue tables added by the Next server (P2). The FastAPI-owned catalogue tables stay in schema.ts.
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/** Ops sub-statuses (U17): a named refinement of a canonical case status, shown to staff and optionally to the client. */
export const serviceSubStatuses = pgTable(
  "service_sub_statuses",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    canonical: varchar({ length: 48 }).notNull(),
    name: jsonb().$type<{ rw: string; en: string; fr: string }>().notNull(),
    clientText: jsonb("client_text")
      .$type<{ rw: string; en: string; fr: string }>()
      .notNull(),
    clientVisible: boolean("client_visible").notNull(),
    color: varchar({ length: 16 }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (t) => [
    index("ix_service_sub_statuses_canonical").on(t.canonical, t.sortOrder),
  ],
);

/** F-CAT-10: a proposed pricing change. Finance/executive (not the proposer) approves; it applies at effective_at. */
export const servicePriceChanges = pgTable(
  "service_price_changes",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    serviceId: varchar("service_id", { length: 64 }).notNull(),
    slug: varchar({ length: 128 }).notNull(),
    kind: varchar({ length: 16 }).notNull(), // pricing | tier
    tier: varchar({ length: 32 }),
    body: jsonb().$type<Record<string, unknown>>().notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true, mode: "string" }).notNull(),
    status: varchar({ length: 16 }).notNull(), // pending | approved | rejected | applied | failed
    proposedBy: varchar("proposed_by", { length: 64 }).notNull(),
    proposedByName: varchar("proposed_by_name", { length: 255 }),
    decidedBy: varchar("decided_by", { length: 64 }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    reason: varchar({ length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [index("ix_service_price_changes_status").on(t.status, t.effectiveAt), index("ix_service_price_changes_slug").on(t.slug)],
);
