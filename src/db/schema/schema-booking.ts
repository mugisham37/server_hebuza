// P12 booking tables: consultation types, advisers + availability, bookings (holds are rows with a TTL mirrored in
// Redis), booking payments, callback requests, waitlist, leads captured by booking/assistant, counters and settings.
// Contact PII (phone/email) is Fernet-encrypted; lookups go through contact_key (sha256 of the normalised contact).
import {
  pgTable,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  date,
  primaryKey,
} from "drizzle-orm/pg-core";
import type {
  AvailabilityOverride,
  AvailabilityRule,
  BookingEvent,
  IntakeQuestion,
  Mode,
  ReminderEntry,
} from "@/domain/booking/types";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
const now = (name: string) => ts(name).notNull().defaultNow();
type L3 = { en: string; fr: string; rw: string };

/** Singleton (id = 'default'): PLACEHOLDER business facts (consultation price, office address, token validity…). */
export const bkgSettings = pgTable("bkg_settings", {
  id: varchar({ length: 16 }).primaryKey().notNull(),
  value: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: now("updated_at"),
});

/** Gap-free human refs (BKG-YYYY-NNNN, CB-NNNN), bumped with UPDATE … RETURNING in the caller's transaction. */
export const bkgCounters = pgTable("bkg_counters", {
  name: varchar({ length: 32 }).primaryKey().notNull(),
  value: integer().notNull().default(0),
});

export const bkgTypes = pgTable("bkg_types", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  slug: varchar({ length: 96 }).notNull().unique(),
  name: jsonb().$type<L3>().notNull(),
  description: jsonb().$type<L3>().notNull(),
  durationMin: integer("duration_min").notNull(),
  modes: jsonb().$type<Mode[]>().notNull(),
  price: integer().notNull().default(0),
  bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
  bufferAfterMin: integer("buffer_after_min").notNull().default(0),
  minNoticeMin: integer("min_notice_min").notNull().default(240),
  horizonDays: integer("horizon_days").notNull().default(30),
  maxPerDay: integer("max_per_day").notNull().default(6),
  familySlugs: jsonb("family_slugs").$type<string[]>().notNull().default([]),
  serviceSlugs: jsonb("service_slugs").$type<string[]>().notNull().default([]),
  adviserIds: jsonb("adviser_ids").$type<string[]>().notNull().default([]),
  intakeSchema: jsonb("intake_schema")
    .$type<IntakeQuestion[]>()
    .notNull()
    .default([]),
  prepare: jsonb().$type<Record<string, string[]>>().notNull().default({}),
  freeOncePerFamily: boolean("free_once_per_family").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  version: integer().notNull().default(1),
  updatedAt: now("updated_at"),
});

export const bkgAdvisers = pgTable("bkg_advisers", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  /** The staff user who owns this calendar (null = not yet linked to an account). */
  userId: varchar("user_id", { length: 64 }).unique(),
  name: varchar({ length: 255 }).notNull(),
  title: varchar({ length: 255 }),
  photo: varchar({ length: 255 }),
  priority: integer().notNull().default(9),
  rules: jsonb().$type<AvailabilityRule[]>().notNull().default([]),
  overrides: jsonb().$type<AvailabilityOverride[]>().notNull().default([]),
  leave: jsonb().$type<{ from: string; to: string }[]>().notNull().default([]),
  /** shortcut: calendar-sync busy blocks are stored, not synced (F-BKG-10 P3); fill from Google when OAuth exists. */
  externalBusy: jsonb("external_busy")
    .$type<{ from: string; to: string }[]>()
    .notNull()
    .default([]),
  active: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  updatedAt: now("updated_at"),
});

export const bkgBookings = pgTable(
  "bkg_bookings",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    /** Empty while held; BKG-YYYY-NNNN once confirmed. */
    reference: varchar({ length: 32 }).notNull().default(""),
    typeSlug: varchar("type_slug", { length: 96 }).notNull(),
    typeName: jsonb("type_name").$type<L3>().notNull(),
    price: integer().notNull().default(0),
    adviserId: varchar("adviser_id", { length: 64 }),
    clientId: varchar("client_id", { length: 64 }),
    leadId: varchar("lead_id", { length: 64 }),
    contactName: varchar("contact_name", { length: 255 }).notNull().default(""),
    phoneEnc: text("phone_enc"),
    emailEnc: text("email_enc"),
    phoneMasked: varchar("phone_masked", { length: 64 }),
    emailMasked: varchar("email_masked", { length: 255 }),
    contactKey: varchar("contact_key", { length: 64 }).notNull().default(""),
    whatsapp: boolean().notNull().default(false),
    language: varchar({ length: 4 }).notNull().default("en"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    mode: varchar({ length: 16 }).notNull(),
    location: varchar({ length: 255 }),
    status: varchar({ length: 24 }).notNull(),
    intake: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    familySlug: varchar("family_slug", { length: 128 }),
    serviceSlug: varchar("service_slug", { length: 128 }),
    invoiceRef: varchar("invoice_ref", { length: 48 }),
    holdExpiresAt: ts("hold_expires_at"),
    paid: boolean().notNull().default(false),
    rescheduleCount: integer("reschedule_count").notNull().default(0),
    rescheduledFromId: varchar("rescheduled_from_id", { length: 64 }),
    rescheduledToRef: varchar("rescheduled_to_ref", { length: 32 }),
    cancelReason: text("cancel_reason"),
    cancelledBy: varchar("cancelled_by", { length: 8 }),
    clientSummary: text("client_summary"),
    outcomeNotes: text("outcome_notes"),
    recommended: jsonb().$type<string[]>().notNull().default([]),
    startLinks: jsonb("start_links")
      .$type<{ slug: string; name: string; href: string }[]>()
      .notNull()
      .default([]),
    quoteRef: varchar("quote_ref", { length: 32 }),
    quoteRequest: jsonb("quote_request").$type<{
      lines: { label: string; qty: number; unit: number }[];
      status: "waiting" | "sent";
    } | null>(),
    reminders: jsonb().$type<ReminderEntry[]>().notNull().default([]),
    events: jsonb().$type<BookingEvent[]>().notNull().default([]),
    refund: jsonb().$type<{
      ref: string;
      amount: number;
      kind: "refund" | "credit";
    } | null>(),
    source: varchar({ length: 16 }).notNull().default("web"),
    /** sha256 of the manage-link token; the token itself only travels by email/SMS. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    confirmKey: varchar("confirm_key", { length: 64 }).notNull(),
    joinUrl: varchar("join_url", { length: 255 }),
    lateRefund: boolean("late_refund").notNull().default(false),
    version: integer().notNull().default(1),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    index("ix_bkg_bookings_adviser_start").on(t.adviserId, t.startsAt),
    index("ix_bkg_bookings_start").on(t.startsAt),
    index("ix_bkg_bookings_contact").on(t.contactKey),
    index("ix_bkg_bookings_client").on(t.clientId, t.startsAt),
    index("ix_bkg_bookings_reference").on(t.reference),
    unique("uq_bkg_bookings_token").on(t.tokenHash),
  ],
);

/** One payment attempt per booking+method (F-BKG-06); settles through payments.provider (stub without keys). */
export const bkgPayments = pgTable(
  "bkg_payments",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    bookingId: varchar("booking_id", { length: 64 }).notNull(),
    kind: varchar({ length: 24 }).notNull(),
    amount: integer().notNull(),
    providerRef: varchar("provider_ref", { length: 128 }),
    status: varchar({ length: 24 }).notNull(),
    phoneMasked: varchar("phone_masked", { length: 64 }),
    checkoutUrl: text("checkout_url"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [index("ix_bkg_payments_booking").on(t.bookingId)],
);

export const bkgRequests = pgTable(
  "bkg_requests",
  {
    id: varchar({ length: 16 }).primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    phoneEnc: text("phone_enc").notNull(),
    phoneMasked: varchar("phone_masked", { length: 64 }).notNull(),
    emailEnc: text("email_enc"),
    topic: varchar({ length: 128 }).notNull(),
    preferredTimes: jsonb("preferred_times")
      .$type<string[]>()
      .notNull()
      .default([]),
    language: varchar({ length: 4 }).notNull(),
    status: varchar({ length: 16 }).notNull().default("new"),
    bookingRef: varchar("booking_ref", { length: 32 }),
    closeReason: text("close_reason"),
    createdAt: now("created_at"),
  },
  (t) => [index("ix_bkg_requests_status").on(t.status, t.createdAt)],
);

/** FIFO per (type, date): the first waiter gets the offer when a slot frees (F-BKG-13). */
export const bkgWaitlist = pgTable(
  "bkg_waitlist",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    typeSlug: varchar("type_slug", { length: 96 }).notNull(),
    date: date().notNull(),
    contactKey: varchar("contact_key", { length: 64 }).notNull(),
    contactEnc: text("contact_enc").notNull(),
    offeredAt: ts("offered_at"),
    createdAt: now("created_at"),
  },
  (t) => [
    unique("uq_bkg_waitlist").on(t.typeSlug, t.date, t.contactKey),
    index("ix_bkg_waitlist_day").on(t.typeSlug, t.date, t.createdAt),
  ],
);

/** Leads from booking (no account) and the assistant's capture_lead tool; marketing CRM imports from here. */
export const bkgLeads = pgTable("bkg_leads", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  name: varchar({ length: 255 }).notNull(),
  phoneEnc: text("phone_enc"),
  emailEnc: text("email_enc"),
  source: varchar({ length: 16 }).notNull(),
  language: varchar({ length: 4 }),
  topic: varchar({ length: 255 }),
  createdAt: now("created_at"),
});

/** F-BKG-10 adviser calendar link (Google / Microsoft). Refresh token is field-encrypted; one link per adviser+provider. */
export const bkgCalendarLinks = pgTable("bkg_calendar_links", {
  adviserId: varchar("adviser_id", { length: 64 }).notNull(),
  provider: varchar({ length: 16 }).notNull(), // google | microsoft
  refreshEnc: text("refresh_enc").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.adviserId, t.provider] })]);
