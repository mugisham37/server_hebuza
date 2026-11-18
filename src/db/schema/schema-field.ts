// P8 field tables: visits, custody receipts + chain, scans, incidents, expenses, cash, MoMo prompts, office reviews,
// the durable per-op log (offline outbox idempotency outlives the 24 h Redis key) and the agent roster.
import {
  pgTable,
  varchar,
  text,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
const now = (name: string) => ts(name).notNull().defaultNow();

/** Who is a field agent (F-WRK-20). revoked_at signs every device out (401 device_revoked). */
export const fieldAgents = pgTable("field_agents", {
  userId: varchar("user_id", { length: 64 }).primaryKey().notNull(),
  agentRef: varchar("agent_ref", { length: 64 }).notNull(),
  districts: jsonb().$type<string[]>().notNull().default([]),
  managerId: varchar("manager_id", { length: 64 }),
  managerName: varchar("manager_name", { length: 255 }),
  revokedAt: ts("revoked_at"),
  createdAt: now("created_at"),
});

/** Singleton (id = 'default') overriding FIELD_POLICY defaults; PLACEHOLDER values live here. */
export const fieldSettings = pgTable("field_settings", {
  id: varchar({ length: 16 }).primaryKey().notNull(),
  value: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: now("updated_at"),
});

/** Gap-free human refs (FT-/CR-/EX-/PR-), bumped with UPDATE … RETURNING inside the caller's transaction. */
export const fieldCounters = pgTable("field_counters", {
  name: varchar({ length: 32 }).primaryKey().notNull(),
  value: integer().notNull().default(0),
});

export const fieldVisits = pgTable(
  "field_visits",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    ref: varchar({ length: 32 }).notNull(),
    agentUserId: varchar("agent_user_id", { length: 64 }).notNull(),
    caseRef: varchar("case_ref", { length: 64 }).notNull(),
    serviceId: varchar("service_id", { length: 128 }).notNull(),
    purpose: varchar({ length: 32 }).notNull(),
    status: varchar({ length: 16 }).notNull(),
    version: integer().notNull().default(1),
    /** Highest version produced by an office edit: an agent op based below it needs review. */
    officeVersion: integer("office_version").notNull().default(0),
    titleI18n: jsonb("title_i18n").$type<Record<string, string>>().notNull(),
    todoI18n: jsonb("todo_i18n").$type<Record<string, string>>().notNull(),
    institution: varchar({ length: 255 }),
    address: varchar({ length: 512 }).notNull(),
    lat: doublePrecision(),
    lng: doublePrecision(),
    windowStart: ts("window_start").notNull(),
    windowEnd: ts("window_end").notNull(),
    priority: varchar({ length: 8 }).notNull().default("normal"),
    checklist: jsonb().$type<unknown[]>().notNull().default([]),
    evidenceRequired: jsonb("evidence_required")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Fernet(JSON MinimalContact): name, phone, language only (F-DOC-06). */
    clientEnc: text("client_enc").notNull(),
    checkin: jsonb().$type<Record<string, unknown> | null>(),
    checkout: jsonb().$type<Record<string, unknown> | null>(),
    notes: jsonb().$type<string[]>().notNull().default([]),
    custodyOpen: integer("custody_open").notNull().default(0),
    collectsDocs: boolean("collects_docs").notNull().default(false),
    offerExpiresAt: ts("offer_expires_at"),
    cancelledReason: text("cancelled_reason"),
    changed: jsonb().$type<Record<string, unknown> | null>(),
    createdBy: varchar("created_by", { length: 64 }),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    unique("uq_field_visits_ref").on(t.ref),
    index("ix_field_visits_agent_window").on(t.agentUserId, t.windowStart),
    index("ix_field_visits_case_ref").on(t.caseRef),
    check(
      "ck_field_visits_status",
      sql`${t.status} in ('offered','scheduled','in_progress','completed','missed','cancelled','declined')`,
    ),
  ],
);

export const fieldReceipts = pgTable(
  "field_receipts",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    ref: varchar({ length: 32 }).notNull(),
    localRef: varchar("local_ref", { length: 64 }).notNull(),
    visitId: varchar("visit_id", { length: 64 }).notNull(),
    direction: varchar({ length: 16 }).notNull(),
    items: jsonb().$type<unknown[]>().notNull(),
    clientName: varchar("client_name", { length: 255 }).notNull(),
    signature: jsonb().$type<Record<string, unknown>>().notNull(),
    signatureKey: varchar("signature_key", { length: 255 }),
    conditionNotes: text("condition_notes"),
    pdfKey: varchar("pdf_key", { length: 255 }),
    sha256: varchar({ length: 64 }).notNull(),
    supersedesId: varchar("supersedes_id", { length: 64 }),
    agentUserId: varchar("agent_user_id", { length: 64 }).notNull(),
    agentName: varchar("agent_name", { length: 255 }).notNull(),
    createdAt: now("created_at"),
  },
  (t) => [
    unique("uq_field_receipts_ref").on(t.ref),
    index("ix_field_receipts_visit").on(t.visitId),
  ],
);

/** One chain per collected receipt; events are append-only. */
export const fieldCustody = pgTable(
  "field_custody",
  {
    receiptRef: varchar("receipt_ref", { length: 32 }).primaryKey().notNull(),
    visitId: varchar("visit_id", { length: 64 }).notNull(),
    items: integer().notNull(),
    stage: varchar({ length: 24 }).notNull(),
    events: jsonb()
      .$type<{ stage: string; at: string; by: string; ref?: string }[]>()
      .notNull(),
    createdAt: now("created_at"),
  },
  (t) => [
    index("ix_field_custody_visit").on(t.visitId),
    index("ix_field_custody_stage").on(t.stage),
  ],
);

export const fieldIncidents = pgTable(
  "field_incidents",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    ref: varchar({ length: 32 }).notNull(),
    visitId: varchar("visit_id", { length: 64 }).notNull(),
    type: varchar({ length: 32 }).notNull(),
    description: text().notNull(),
    byUserId: varchar("by_user_id", { length: 64 }).notNull(),
    byName: varchar("by_name", { length: 255 }).notNull(),
    at: now("at"),
  },
  (t) => [index("ix_field_incidents_visit").on(t.visitId)],
);

export const fieldScans = pgTable(
  "field_scans",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    visitId: varchar("visit_id", { length: 64 }).notNull(),
    label: varchar({ length: 255 }).notNull(),
    pages: integer().notNull(),
    bytes: integer().notNull(),
    pageKeys: jsonb("page_keys")
      .$type<{ key: string; type: string }[]>()
      .notNull(),
    pdfKey: varchar("pdf_key", { length: 255 }),
    status: varchar({ length: 16 }).notNull(),
    /** pending | clean | infected — worst page result (storage.scan). */
    scanStatus: varchar("scan_status", { length: 16 }).default("pending").notNull(),
    byUserId: varchar("by_user_id", { length: 64 }).notNull(),
    at: now("at"),
  },
  (t) => [index("ix_field_scans_visit").on(t.visitId)],
);

export const fieldExpenses = pgTable(
  "field_expenses",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    ref: varchar({ length: 32 }).notNull(),
    localRef: varchar("local_ref", { length: 64 }).notNull(),
    visitId: varchar("visit_id", { length: 64 }),
    visitRef: varchar("visit_ref", { length: 32 }),
    category: varchar({ length: 16 }).notNull(),
    amountRwf: integer("amount_rwf").notNull(),
    receiptKey: varchar("receipt_key", { length: 255 }),
    noReceiptReason: text("no_receipt_reason"),
    note: text(),
    state: varchar({ length: 24 }).notNull(),
    flags: jsonb().$type<string[]>().notNull().default([]),
    trail: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
    payoutBatch: varchar("payout_batch", { length: 32 }),
    claimantId: varchar("claimant_id", { length: 64 }).notNull(),
    claimantName: varchar("claimant_name", { length: 255 }).notNull(),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    unique("uq_field_expenses_ref").on(t.ref),
    index("ix_field_expenses_claimant").on(t.claimantId, t.createdAt),
    index("ix_field_expenses_state").on(t.state),
    check("ck_field_expenses_amount", sql`${t.amountRwf} > 0`),
  ],
);

export const fieldCash = pgTable(
  "field_cash",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    provisionalNo: varchar("provisional_no", { length: 32 }).notNull(),
    visitId: varchar("visit_id", { length: 64 }).notNull(),
    visitRef: varchar("visit_ref", { length: 32 }).notNull(),
    agentUserId: varchar("agent_user_id", { length: 64 }).notNull(),
    agentName: varchar("agent_name", { length: 255 }).notNull(),
    invoiceNo: varchar("invoice_no", { length: 64 }).notNull(),
    amountRwf: integer("amount_rwf").notNull(),
    status: varchar({ length: 16 }).notNull(),
    depositRef: varchar("deposit_ref", { length: 128 }),
    confirmations: jsonb()
      .$type<
        { by: string; at: string; reason?: string; evidenceId?: string }[]
      >()
      .notNull()
      .default([]),
    escalatedAt: ts("escalated_at"),
    recordedAt: now("recorded_at"),
  },
  (t) => [
    unique("uq_field_cash_provisional").on(t.provisionalNo),
    index("ix_field_cash_status").on(t.status),
    check("ck_field_cash_amount", sql`${t.amountRwf} > 0`),
  ],
);

/** A field MoMo prompt; the money itself is a row in `payments` (settled by the payments module). */
export const fieldMomo = pgTable(
  "field_momo",
  {
    transactionId: varchar("transaction_id", { length: 64 })
      .primaryKey()
      .notNull(),
    idemKey: varchar("idem_key", { length: 128 }),
    visitId: varchar("visit_id", { length: 64 }).notNull(),
    invoiceNo: varchar("invoice_no", { length: 64 }).notNull(),
    agentUserId: varchar("agent_user_id", { length: 64 }).notNull(),
    cancelledAt: ts("cancelled_at"),
    createdAt: now("created_at"),
  },
  (t) => [index("ix_field_momo_invoice").on(t.invoiceNo)],
);

export const fieldOtps = pgTable("field_otps", {
  visitId: varchar("visit_id", { length: 64 }).primaryKey().notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  attempts: integer().notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  sentAt: now("sent_at"),
});

export const fieldFlagReviews = pgTable(
  "field_flag_reviews",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    visitId: varchar("visit_id", { length: 64 }).notNull(),
    flags: jsonb().$type<string[]>().notNull(),
    reviewed: boolean().notNull().default(false),
    reviewedBy: varchar("reviewed_by", { length: 64 }),
    at: now("at"),
  },
  (t) => [index("ix_field_flag_reviews_open").on(t.reviewed, t.at)],
);

export const fieldConflicts = pgTable(
  "field_conflicts",
  {
    opId: varchar("op_id", { length: 128 }).primaryKey().notNull(),
    visitId: varchar("visit_id", { length: 64 }).notNull(),
    kind: varchar({ length: 32 }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: varchar({ length: 16 }).notNull().default("open"),
    note: text(),
    resolvedBy: varchar("resolved_by", { length: 64 }),
    at: now("at"),
  },
  (t) => [index("ix_field_conflicts_status").on(t.status, t.at)],
);

/** Durable outbox replay: (user, client_op_id) → the first successful response. */
export const fieldOps = pgTable(
  "field_ops",
  {
    opId: varchar("op_id", { length: 128 }).notNull(),
    userId: varchar("user_id", { length: 64 }).notNull(),
    kind: varchar({ length: 32 }).notNull(),
    response: jsonb().notNull(),
    at: now("at"),
  },
  (t) => [unique("uq_field_ops").on(t.userId, t.opId)],
);

/** Case-pool shares owed to a field agent (F-REV-05); Finance (P6) will own the pool itself. */
export const fieldPoolShares = pgTable(
  "field_pool_shares",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    agentUserId: varchar("agent_user_id", { length: 64 }).notNull(),
    caseRef: varchar("case_ref", { length: 64 }).notNull(),
    service: varchar({ length: 255 }).notNull(),
    poolRwf: integer("pool_rwf").notNull(),
    state: varchar({ length: 16 }).notNull(),
    month: varchar({ length: 7 }).notNull(),
  },
  (t) => [index("ix_field_pool_shares_agent_month").on(t.agentUserId, t.month)],
);
