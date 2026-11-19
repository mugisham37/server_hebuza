// Marketing store (P11): CRM, campaigns, sequences, templates, testimonials, referrals, media, links, settings.
// Every marketing entity is one JSONB document keyed by (kind, id), typed by src/lib/marketing/types.ts; `pos` keeps list
// order (new documents get a negative pos so they list first, as the mocks unshift them).
// shortcut: document store with per-row FOR UPDATE locks, fine for an office CRM (tens of thousands of rows); move the
// hot kinds (lead, contact, run) to column tables with SQL filters when a list passes ~50k rows or needs keyset paging.
import {
  pgTable,
  varchar,
  bigint,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

export const mktRecords = pgTable(
  "mkt_records",
  {
    kind: varchar({ length: 24 }).notNull(),
    id: varchar({ length: 128 }).notNull(),
    pos: bigint({ mode: "number" }).notNull(),
    /** Lifecycle state for queue filters and badges (lead stage, campaign status, run status…). */
    status: varchar({ length: 32 }),
    /** Secondary key (lead/contact clientId, link code owner, run rule id…). */
    ref: varchar({ length: 128 }),
    data: jsonb().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_mkt_records", columns: [t.kind, t.id] }),
    index("ix_mkt_records_kind_pos").on(t.kind, t.pos),
    index("ix_mkt_records_kind_status").on(t.kind, t.status),
    index("ix_mkt_records_kind_ref").on(t.kind, t.ref),
  ],
);

/** F-CRM-16 first-party visitor analytics: one row per event, sent only after analytics consent (no IP, no PII). */
export const siteEvents = pgTable(
  "site_events",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    name: varchar({ length: 32 }).notNull(), // page_view | cta_click | search | form_submit
    path: varchar({ length: 512 }).notNull(),
    locale: varchar({ length: 2 }),
    referrer: varchar({ length: 512 }),
    visitor: varchar({ length: 64 }), // first-party anonymous cookie id
    props: jsonb().$type<Record<string, string>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [index("ix_site_events_name_at").on(t.name, t.createdAt)],
);
