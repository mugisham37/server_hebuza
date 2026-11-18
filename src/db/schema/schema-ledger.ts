// Double-entry ledger core (P4). New tables; the integrator generates the migration from this file.
// Every money event posts one balanced journal; (source_type, source_id) makes posting idempotent.
import {
  pgTable,
  varchar,
  text,
  timestamp,
  bigint,
  index,
  unique,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./schema";

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    code: varchar({ length: 16 }).primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    type: varchar({ length: 16 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "ck_ledger_accounts_type",
      sql`${t.type} in ('asset','liability','equity','revenue','expense')`,
    ),
  ],
);

/** One row per calendar month ('YYYY-MM', Africa/Kigali). Posting locks the row FOR UPDATE; closed refuses. */
export const ledgerPeriods = pgTable(
  "ledger_periods",
  {
    id: varchar({ length: 7 }).primaryKey().notNull(),
    status: varchar({ length: 8 }).notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closedBy: varchar("closed_by", { length: 64 }),
  },
  (t) => [
    check("ck_ledger_periods_status", sql`${t.status} in ('open','closed')`),
    foreignKey({
      columns: [t.closedBy],
      foreignColumns: [users.userId],
      name: "fk_ledger_periods_closed_by",
    }).onDelete("set null"),
  ],
);

export const ledgerJournals = pgTable(
  "ledger_journals",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    periodId: varchar("period_id", { length: 7 }).notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    memo: text().notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceId: varchar("source_id", { length: 128 }).notNull(),
    reversesId: varchar("reverses_id", { length: 64 }),
    createdBy: varchar("created_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("uq_ledger_journals_source").on(t.sourceType, t.sourceId),
    index("ix_ledger_journals_period_id").on(t.periodId),
    foreignKey({
      columns: [t.periodId],
      foreignColumns: [ledgerPeriods.id],
      name: "fk_ledger_journals_period_id",
    }),
    foreignKey({
      columns: [t.reversesId],
      foreignColumns: [t.id],
      name: "fk_ledger_journals_reverses_id",
    }),
    foreignKey({
      columns: [t.createdBy],
      foreignColumns: [users.userId],
      name: "fk_ledger_journals_created_by",
    }).onDelete("set null"),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    journalId: varchar("journal_id", { length: 64 }).notNull(),
    accountCode: varchar("account_code", { length: 16 }).notNull(),
    debitRwf: bigint("debit_rwf", { mode: "number" }).notNull().default(0),
    creditRwf: bigint("credit_rwf", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    index("ix_ledger_entries_journal_id").on(t.journalId),
    index("ix_ledger_entries_account_code").on(t.accountCode),
    check(
      "ck_ledger_entries_one_side",
      sql`${t.debitRwf} >= 0 and ${t.creditRwf} >= 0 and (${t.debitRwf} = 0) <> (${t.creditRwf} = 0)`,
    ),
    foreignKey({
      columns: [t.journalId],
      foreignColumns: [ledgerJournals.id],
      name: "fk_ledger_entries_journal_id",
    }),
    foreignKey({
      columns: [t.accountCode],
      foreignColumns: [ledgerAccounts.code],
      name: "fk_ledger_entries_account_code",
    }),
  ],
);
