// PRT institutional partners (spec 05-modules/institutional-partners §8): relationship records, not logins.
import { pgTable, varchar, text, timestamp, date, integer, boolean, bigint, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { applications, users } from "./schema";
import { organizations } from "./schema-org";

const ts = (n: string) => timestamp(n, { withTimezone: true, mode: "string" });
const id = () => varchar({ length: 64 }).primaryKey().notNull();
const partnerId = () => varchar("partner_id", { length: 64 }).notNull().references(() => partners.id, { onDelete: "cascade" });

export const partners = pgTable("partners", {
  id: id(),
  organizationId: varchar("organization_id", { length: 64 }).references(() => organizations.id, { onDelete: "set null" }),
  name: varchar({ length: 255 }).notNull(),
  type: varchar({ length: 24 }).notNull(),
  tier: varchar({ length: 16 }).default("operational").notNull(),
  status: varchar({ length: 16 }).default("prospect").notNull(),
  sector: varchar({ length: 128 }),
  country: varchar({ length: 64 }).default("Rwanda").notNull(),
  website: varchar({ length: 255 }),
  logoUrl: varchar("logo_url", { length: 1024 }),
  shownOnWebsite: boolean("shown_on_website").default(false).notNull(),
  ownerUserId: varchar("owner_user_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  notes: text(),
  lastContactAt: ts("last_contact_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
}, () => [
  check("ck_partners_status", sql`status IN ('prospect','active','dormant','archived')`),
  check("ck_partners_tier", sql`tier IN ('strategic','operational')`),
]);

export const partnerContacts = pgTable("partner_contacts", {
  id: id(), partnerId: partnerId(),
  name: varchar({ length: 255 }).notNull(), title: varchar({ length: 128 }), email: varchar({ length: 255 }), phone: varchar({ length: 32 }),
  language: varchar({ length: 8 }), isPrimary: boolean("is_primary").default(false).notNull(), active: boolean().default(true).notNull(),
  createdAt: ts("created_at").notNull(),
}, (t) => [index("ix_partner_contacts_partner").on(t.partnerId)]);

export const partnerAgreements = pgTable("partner_agreements", {
  id: id(), partnerId: partnerId(),
  kind: varchar({ length: 16 }).notNull(), number: varchar({ length: 64 }), title: varchar({ length: 255 }).notNull(),
  signedOn: date("signed_on"), startOn: date("start_on").notNull(), endOn: date("end_on"),
  renewalTerms: text("renewal_terms"), valueAmount: bigint("value_amount", { mode: "number" }), currency: varchar({ length: 3 }).default("RWF").notNull(),
  /** PRT-09: referral commission in basis points (100 = 1 %), applied to paid invoices of referred clients. */
  commissionBps: integer("commission_bps"),
  status: varchar({ length: 16 }).default("draft").notNull(), isConfidential: boolean("is_confidential").default(false).notNull(),
  fileKey: varchar("file_key", { length: 1024 }), terminationReason: text("termination_reason"), terminatedOn: date("terminated_on"),
  createdAt: ts("created_at").notNull(),
}, (t) => [
  index("ix_partner_agreements_partner").on(t.partnerId),
  check("ck_partner_agreements_dates", sql`end_on IS NULL OR end_on >= start_on`),
  check("ck_partner_agreements_status", sql`status IN ('draft','active','renewed','expired','terminated')`),
]);

export const partnerActions = pgTable("partner_actions", {
  id: id(), partnerId: partnerId(), meetingId: varchar("meeting_id", { length: 64 }), objectiveId: varchar("objective_id", { length: 64 }),
  title: varchar({ length: 255 }).notNull(), deliverable: varchar({ length: 500 }), ownerUserId: varchar("owner_user_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  dueOn: date("due_on"), status: varchar({ length: 16 }).default("open").notNull(), progress: integer().default(0).notNull(),
  createdAt: ts("created_at").notNull(), doneAt: ts("done_at"),
}, (t) => [
  index("ix_partner_actions_partner").on(t.partnerId),
  check("ck_partner_actions_status", sql`status IN ('open','in_progress','done','cancelled')`),
]);

export const partnerMeetings = pgTable("partner_meetings", {
  id: id(), partnerId: partnerId(),
  title: varchar({ length: 255 }).notNull(), startsAt: ts("starts_at").notNull(), endsAt: ts("ends_at"), location: varchar({ length: 500 }),
  agenda: text(), minutes: text(), decisions: text().array().default(sql`'{}'::text[]`).notNull(),
  status: varchar({ length: 16 }).default("scheduled").notNull(), createdAt: ts("created_at").notNull(),
}, (t) => [index("ix_partner_meetings_partner").on(t.partnerId, t.startsAt)]);

export const partnerCorrespondence = pgTable("partner_correspondence", {
  id: id(), partnerId: partnerId(),
  direction: varchar({ length: 8 }).notNull(), kind: varchar({ length: 16 }).notNull(), date: date().notNull(),
  subject: varchar({ length: 255 }).notNull(), summary: text(), fileKey: varchar("file_key", { length: 1024 }), createdAt: ts("created_at").notNull(),
}, (t) => [index("ix_partner_correspondence_partner").on(t.partnerId)]);

export const partnerReferrals = pgTable("partner_referrals", {
  id: id(), partnerId: partnerId(),
  direction: varchar({ length: 8 }).notNull(), clientId: varchar("client_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  applicationId: varchar("application_id", { length: 64 }).references(() => applications.applicationId, { onDelete: "set null" }),
  name: varchar({ length: 255 }).notNull(), status: varchar({ length: 16 }).default("referred").notNull(), createdAt: ts("created_at").notNull(),
}, (t) => [index("ix_partner_referrals_partner").on(t.partnerId)]);

export const partnerCommissions = pgTable("partner_commissions", {
  id: id(), partnerId: partnerId(), agreementId: varchar("agreement_id", { length: 64 }).references(() => partnerAgreements.id, { onDelete: "set null" }),
  referralId: varchar("referral_id", { length: 64 }), applicationId: varchar("application_id", { length: 64 }),
  baseAmount: bigint("base_amount", { mode: "number" }).notNull(), rateBps: integer("rate_bps").notNull(), amount: bigint({ mode: "number" }).notNull(),
  status: varchar({ length: 16 }).default("computed").notNull(), decidedBy: varchar("decided_by", { length: 64 }), decidedAt: ts("decided_at"), note: text(),
  createdAt: ts("created_at").notNull(),
}, (t) => [
  index("ix_partner_commissions_partner").on(t.partnerId),
  check("ck_partner_commissions_status", sql`status IN ('computed','approved','paid','rejected')`),
]);

export const partnerObjectives = pgTable("partner_objectives", {
  id: id(), partnerId: partnerId(),
  title: varchar({ length: 255 }).notNull(), description: text(), period: varchar({ length: 32 }), createdAt: ts("created_at").notNull(),
}, (t) => [index("ix_partner_objectives_partner").on(t.partnerId)]);

export const partnerOpportunities = pgTable("partner_opportunities", {
  id: id(), partnerId: partnerId(),
  title: varchar({ length: 255 }).notNull(), stage: varchar({ length: 16 }).default("idea").notNull(), value: bigint({ mode: "number" }),
  ownerUserId: varchar("owner_user_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }), closedOn: date("closed_on"), createdAt: ts("created_at").notNull(),
}, (t) => [
  index("ix_partner_opportunities_partner").on(t.partnerId),
  check("ck_partner_opportunities_stage", sql`stage IN ('idea','proposal','active','won','lost')`),
]);

export const partnerObligations = pgTable("partner_obligations", {
  id: id(), partnerId: partnerId(),
  agreementId: varchar("agreement_id", { length: 64 }).notNull().references(() => partnerAgreements.id, { onDelete: "cascade" }),
  description: varchar({ length: 1000 }).notNull(), ownerUserId: varchar("owner_user_id", { length: 64 }).references(() => users.userId, { onDelete: "set null" }),
  dueOn: date("due_on"), status: varchar({ length: 16 }).default("open").notNull(), createdAt: ts("created_at").notNull(),
}, (t) => [index("ix_partner_obligations_agreement").on(t.agreementId)]);

export const partnerAgreementFiles = pgTable("partner_agreement_files", {
  id: id(), agreementId: varchar("agreement_id", { length: 64 }).notNull().references(() => partnerAgreements.id, { onDelete: "cascade" }),
  version: integer().notNull(), fileKey: varchar("file_key", { length: 1024 }).notNull(), filename: varchar({ length: 255 }).notNull(),
  uploadedBy: varchar("uploaded_by", { length: 64 }), uploadedAt: ts("uploaded_at").notNull(),
}, (t) => [index("ix_partner_agreement_files_agreement").on(t.agreementId)]);
