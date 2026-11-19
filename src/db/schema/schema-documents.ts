// P3 documents tables (new): released deliverables per case, and the library's expiry date
// (kept beside client_documents so the pulled table stays untouched until the cutover ALTER).
import { pgTable, varchar, timestamp, integer, date, index } from "drizzle-orm/pg-core";
import { applications, clientDocuments, users } from "./schema";

export const deliverables = pgTable("deliverables", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  applicationId: varchar("application_id", { length: 64 }).notNull().references(() => applications.applicationId, { onDelete: "cascade" }),
  title: varchar({ length: 255 }).notNull(),
  storagePath: varchar("storage_path", { length: 1024 }).notNull(),
  mimeType: varchar("mime_type", { length: 128 }).notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  version: integer().default(1).notNull(),
  issuer: varchar({ length: 128 }),
  /** Null until staff release it to the client (dlv.review). */
  releasedAt: timestamp("released_at", { withTimezone: true, mode: "string" }),
  createdBy: varchar("created_by", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_deliverables_application_id").on(t.applicationId)]);

export const clientDocumentExpiry = pgTable("client_document_expiry", {
  documentId: varchar("document_id", { length: 64 }).primaryKey().notNull().references(() => clientDocuments.documentId, { onDelete: "cascade" }),
  expiresOn: date("expires_on").notNull(),
});

/** DLV-06: single-use, 72-hour download links sent with a release (the token is hashed; the holder must also sign in). */
export const downloadTokens = pgTable("download_tokens", {
  tokenHash: varchar("token_hash", { length: 64 }).primaryKey().notNull(),
  deliverableId: varchar("deliverable_id", { length: 64 }).notNull().references(() => deliverables.id, { onDelete: "cascade" }),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.userId, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_download_tokens_deliverable").on(t.deliverableId)]);

/** DOC-09: nightly retention flags → SM decision → crypto-shred (object deleted, metadata tombstoned). */
export const documentRetentionFlags = pgTable("document_retention_flags", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  source: varchar({ length: 16 }).notNull(), // case | deliverable
  sourceId: varchar("source_id", { length: 64 }).notNull(),
  retentionClass: varchar("retention_class", { length: 24 }).notNull(),
  storagePath: varchar("storage_path", { length: 1024 }).notNull(),
  label: varchar({ length: 255 }).notNull(),
  caseCode: varchar("case_code", { length: 32 }),
  anchorAt: timestamp("anchor_at", { withTimezone: true, mode: "string" }).notNull(),
  flaggedAt: timestamp("flagged_at", { withTimezone: true, mode: "string" }).notNull(),
  decision: varchar({ length: 16 }), // shred | keep
  decidedBy: varchar("decided_by", { length: 64 }),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  reason: varchar({ length: 500 }),
  shreddedAt: timestamp("shredded_at", { withTimezone: true, mode: "string" }),
}, (t) => [index("ix_document_retention_flags_open").on(t.decision, t.flaggedAt), index("ix_document_retention_flags_source").on(t.source, t.sourceId)]);
