// ORG (company profiles): organisations, their authorised representatives, and pending invites.
import { pgTable, varchar, timestamp, date, index, primaryKey, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./schema";

export const organizations = pgTable("organizations", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  /** ORG-05: same HBC sequence as people, so CRM history is per party. */
  customerNo: varchar("customer_no", { length: 24 }).unique("uq_organizations_customer_no"),
  legalName: varchar("legal_name", { length: 255 }).notNull(),
  tradeName: varchar("trade_name", { length: 255 }),
  orgType: varchar("org_type", { length: 24 }).notNull(),
  tin: varchar({ length: 9 }),
  rdbNumber: varchar("rdb_number", { length: 64 }),
  registeredOn: date("registered_on"),
  sectorCode: varchar("sector_code", { length: 16 }),
  province: varchar({ length: 64 }),
  district: varchar({ length: 64 }),
  sector: varchar({ length: 64 }),
  cell: varchar({ length: 64 }),
  phone: varchar({ length: 32 }),
  email: varchar({ length: 255 }),
  website: varchar({ length: 255 }),
  sizeBand: varchar("size_band", { length: 16 }),
  verificationStatus: varchar("verification_status", { length: 24 }).default("unverified").notNull(),
  verificationNote: varchar("verification_note", { length: 1000 }),
  verifiedBy: varchar("verified_by", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
  createdBy: varchar("created_by", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [
  // ORG §12: TIN unique among verified companies; unverified duplicates are allowed (SM is alerted).
  uniqueIndex("uq_organizations_verified_tin").on(t.tin).where(sql`verification_status = 'verified' and tin is not null`),
  check("ck_organizations_status", sql`verification_status IN ('unverified','pending_verification','verified','rejected')`),
]);

export const organizationMembers = pgTable("organization_members", {
  organizationId: varchar("organization_id", { length: 64 }).notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.userId, { onDelete: "cascade" }),
  role: varchar({ length: 16 }).notNull(),
  title: varchar({ length: 128 }),
  proofDocumentId: varchar("proof_document_id", { length: 64 }),
  status: varchar({ length: 16 }).notNull(),
  invitedBy: varchar("invited_by", { length: 64 }),
  invitedAt: timestamp("invited_at", { withTimezone: true, mode: "string" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.userId] }),
  index("ix_organization_members_user").on(t.userId),
  check("ck_organization_members_role", sql`role IN ('owner','admin','viewer')`),
  check("ck_organization_members_status", sql`status IN ('active','removed')`),
]);

export const organizationInvites = pgTable("organization_invites", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique("uq_organization_invites_token"),
  organizationId: varchar("organization_id", { length: 64 }).notNull().references(() => organizations.id, { onDelete: "cascade" }),
  contact: varchar({ length: 255 }).notNull(),
  role: varchar({ length: 16 }).notNull(),
  invitedBy: varchar("invited_by", { length: 64 }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("ix_organization_invites_org").on(t.organizationId)]);

/** SUB-10: a subscription owned by a company; it covers requests its active representatives submit for it. */
export const organizationSubscriptions = pgTable("organization_subscriptions", {
  organizationId: varchar("organization_id", { length: 64 }).primaryKey().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  planId: varchar("plan_id", { length: 64 }).notNull(),
  status: varchar({ length: 16 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "string" }).notNull(),
  lastPaymentId: varchar("last_payment_id", { length: 64 }),
  paidBy: varchar("paid_by", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, () => [check("ck_organization_subscriptions_status", sql`status IN ('active','cancelled','expired')`)]);
