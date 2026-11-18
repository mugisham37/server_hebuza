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
