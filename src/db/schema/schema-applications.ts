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
