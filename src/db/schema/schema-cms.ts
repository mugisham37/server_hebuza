// CMS content store (P2), replacing src/mocks/cms-store.ts. Entries keep the editor's CmsEntry document in `doc`
// (blocks, variants, meta move together and are validated by src/lib/marketing/cms/rules.ts); the columns beside it
// are what queries, locks and uniqueness need.
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  varchar,
  text,
} from "drizzle-orm/pg-core";
import type {
  CmsEntry,
  CmsVersion,
  NavNode,
  SiteSettings,
} from "@/domain/marketing/types";

export const cmsEntries = pgTable(
  "cms_entries",
  {
    id: varchar({ length: 96 }).primaryKey().notNull(),
    type: varchar({ length: 32 }).notNull(),
    key: varchar({ length: 160 }).notNull(),
    version: integer().notNull(),
    archived: boolean().notNull(),
    doc: jsonb().$type<CmsEntry>().notNull(),
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
    unique("uq_cms_entries_type_key").on(t.type, t.key),
    index("ix_cms_entries_updated").on(t.updatedAt),
  ],
);

export const cmsVersions = pgTable(
  "cms_versions",
  {
    entryId: varchar("entry_id", { length: 96 })
      .notNull()
      .references(() => cmsEntries.id, { onDelete: "cascade" }),
    language: varchar({ length: 4 }).notNull(),
    version: integer().notNull(),
    at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    by: varchar({ length: 255 }).notNull(),
    summary: varchar({ length: 255 }).notNull(),
    snapshot: jsonb().$type<CmsVersion["snapshot"]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.language, t.version] })],
);

export const cmsComments = pgTable(
  "cms_comments",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    entryId: varchar("entry_id", { length: 96 })
      .notNull()
      .references(() => cmsEntries.id, { onDelete: "cascade" }),
    blockId: varchar("block_id", { length: 96 }),
    language: varchar({ length: 4 }),
    by: varchar({ length: 255 }).notNull(),
    body: text().notNull(),
    at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    resolved: boolean().notNull(),
  },
  (t) => [index("ix_cms_comments_entry").on(t.entryId)],
);

export const cmsRedirects = pgTable(
  "cms_redirects",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    from: varchar("from_path", { length: 512 }).notNull(),
    to: varchar("to_path", { length: 512 }).notNull(),
    code: integer().notNull(),
    hits: integer().notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (t) => [unique("uq_cms_redirects_from").on(t.from)],
);

export const cmsNotFound = pgTable("cms_not_found", {
  path: varchar({ length: 512 }).primaryKey().notNull(),
  hits: integer().notNull(),
  lastAt: timestamp("last_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

export const cmsNav = pgTable("cms_nav", {
  location: varchar({ length: 16 }).primaryKey().notNull(),
  items: jsonb().$type<NavNode[]>().notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

export const cmsSiteSettings = pgTable("cms_site_settings", {
  id: varchar({ length: 16 }).primaryKey().notNull(),
  doc: jsonb().$type<SiteSettings>().notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

export const cmsLocks = pgTable("cms_locks", {
  entryId: varchar("entry_id", { length: 96 })
    .primaryKey()
    .notNull()
    .references(() => cmsEntries.id, { onDelete: "cascade" }),
  holder: varchar({ length: 255 }).notNull(),
  since: timestamp({ withTimezone: true, mode: "string" }).notNull(),
});

/** TKT-YYYY-NNNNN references for /api/contact (stored as contact_inquiries.id, so that table needs no new column). */
export const contactRefSeq = pgSequence("contact_ref_seq", { startWith: 142 });
