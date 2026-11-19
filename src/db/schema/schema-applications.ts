// P3 applications tables (new): staff document requests ("needs"), the client's review/rating of a case's
// deliverables, and help-desk tickets.
import { pgTable, pgSequence, varchar, text, timestamp, integer, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { applications, users } from "./schema";

export const documentRequests = pgTable("document_requests", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  applicationId: varchar("application_id", { length: 64 }).notNull().references(() => applications.applicationId, { onDelete: "cascade" }),
  requirementKey: varchar("requirement_key", { length: 128 }).notNull(),
  label: varchar({ length: 255 }).notNull(),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }),
  requestedBy: varchar("requested_by", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true, mode: "string" }),
  fulfilledByDocumentId: varchar("fulfilled_by_document_id", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_document_requests_application_id").on(t.applicationId)]);

export const applicationFeedback = pgTable("application_feedback", {
  applicationId: varchar("application_id", { length: 64 }).primaryKey().notNull().references(() => applications.applicationId, { onDelete: "cascade" }),
  review: varchar({ length: 32 }),
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
  rating: integer(),
  ratedAt: timestamp("rated_at", { withTimezone: true, mode: "string" }),
  ratingTags: text("rating_tags").array(),
  ratingComment: text("rating_comment"),
}, () => [
  check("ck_application_feedback_review", sql`review IS NULL OR review IN ('accepted','changes_requested')`),
  check("ck_application_feedback_rating", sql`rating IS NULL OR rating BETWEEN 1 AND 5`),
]);

export const supportTicketRefSeq = pgSequence("support_ticket_ref_seq", { startWith: 1 });

export const supportTickets = pgTable("support_tickets", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  ref: varchar({ length: 32 }).notNull().unique("uq_support_tickets_ref"),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.userId, { onDelete: "cascade" }),
  subject: varchar({ length: 200 }).notNull(),
  status: varchar({ length: 16 }).notNull(),
  type: varchar({ length: 40 }),
  contact: varchar({ length: 255 }),
  caseRef: varchar("case_ref", { length: 64 }),
  ratingScore: integer("rating_score"),
  ratingComment: text("rating_comment"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [
  index("ix_support_tickets_user_created").on(t.userId, t.createdAt),
  check("ck_support_tickets_status", sql`status IN ('open','waiting','resolved')`),
]);

export const supportTicketMessages = pgTable("support_ticket_messages", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  ticketId: varchar("ticket_id", { length: 64 }).notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
  authorId: varchar("author_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  /** "me" = the ticket owner, "support" = staff. */
  side: varchar({ length: 16 }).notNull(),
  body: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_support_ticket_messages_ticket").on(t.ticketId, t.createdAt)]);

/** REQ-02/03: one basket submission = one group (RG-YYYY-NNNNNN) holding N cases (applications.group_id). */
export const requestGroupRefSeq = pgSequence("request_group_ref_seq", { startWith: 1 });
export const requestGroups = pgTable("request_groups", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  code: varchar({ length: 32 }).notNull().unique("uq_request_groups_code"),
  clientId: varchar("client_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  totalAmountRwf: integer("total_amount_rwf").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_request_groups_client").on(t.clientId)]);

/** CRM-01: gapless customer numbers per registration year. */
export const customerSequences = pgTable("customer_sequences", {
  year: integer().primaryKey().notNull(),
  n: integer().notNull(),
});

/** REQ-10: one-time code sent to a guest case's phone before a signed-in client may claim it. */
export const applicationClaimOtps = pgTable("application_claim_otps", {
  applicationId: varchar("application_id", { length: 64 }).primaryKey().notNull().references(() => applications.applicationId, { onDelete: "cascade" }),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.userId, { onDelete: "cascade" }),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  attempts: integer().default(0).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }).notNull(),
});

/** ASN-09: "never assign this agent to this client" (conflict declarations and SM restrictions). */
export const assignmentBlocks = pgTable("assignment_blocks", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  agentId: varchar("agent_id", { length: 64 }).notNull().references(() => users.userId, { onDelete: "cascade" }),
  clientId: varchar("client_id", { length: 64 }).notNull().references(() => users.userId, { onDelete: "cascade" }),
  reason: varchar({ length: 500 }).notNull(),
  createdBy: varchar("created_by", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_assignment_blocks_agent").on(t.agentId), index("ix_assignment_blocks_client").on(t.clientId)]);
