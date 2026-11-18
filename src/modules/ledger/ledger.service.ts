// Double-entry ledger core (port of .ref ledger.service + finance.ledger). LedgerService.post is the ONLY writer of
// ledger_journals/ledger_entries: balanced, integer RWF, append-only (corrections are reversals), period-locked.
// Callers pass their open transaction so the journal commits with the business change.
import { Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  ledgerAccounts,
  ledgerEntries,
  ledgerJournals,
  ledgerPeriods,
} from "@/db/schema";
import { DB, type Db, type Tx } from "../../core/db/db";
import { AppError, notFound } from "../../core/http/errors";

const A = (
  code: string,
  name: string,
  type: "asset" | "liability" | "equity" | "revenue" | "expense",
) => ({ code, name, type });
/** Chart of accounts. Codes are stable; finance's additions (FIN_ACCOUNTS in the reference) are merged here. */
export const ACCOUNTS = {
  momoClearing: A("1100", "MTN MoMo clearing", "asset"),
  cardClearing: A("1110", "Card (Flutterwave) clearing", "asset"),
  bank: A("1120", "Bank account", "asset"),
  airtelClearing: A("1130", "Airtel Money clearing", "asset"),
  otherClearing: A("1190", "Other collections clearing", "asset"),
  receivable: A("1200", "Accounts receivable", "asset"),
  supplierAdvances: A("1300", "Supplier advances and deposits", "asset"),
  supplierPayable: A("2150", "Accounts payable (suppliers)", "liability"),
  governmentFeesPayable: A("2100", "Government fees payable", "liability"),
  vatPayable: A("2200", "VAT payable", "liability"),
  whtPayable: A("2250", "WHT payable (RRA)", "liability"),
  workerPayable: A("2300", "Agent and partner shares payable", "liability"),
  clientCredit: A("2350", "Client credit balances", "liability"),
  clientRefundDue: A("2400", "Client overpayments (refund due)", "liability"),
  serviceRevenue: A("4100", "Service fee revenue", "revenue"),
  subscriptionRevenue: A("4200", "Subscription revenue", "revenue"),
  feeRevenue: A("4300", "Agent licence fees", "revenue"),
  workerShareExpense: A("5100", "Agent and partner share", "expense"),
  procurementExpense: A("5200", "Procurement expense", "expense"),
  depositLosses: A("5210", "Supplier deposit deductions and forfeits", "expense"),
  providerFees: A("6100", "Payment provider fees", "expense"),
} as const;

export type Line = { account: string; debit?: number; credit?: number };
export type JournalInput = {
  sourceType: string;
  sourceId: string;
  memo: string;
  occurredAt?: Date;
  createdBy?: string | null;
  lines: Line[];
  reversesId?: string | null;
};

const id = (p: string) => `${p}_${randomUUID().replace(/-/g, "")}`;

/** Kigali month of a timestamp (UTC+2, no DST). */
export const periodOf = (d: Date) =>
  new Date(d.getTime() + 2 * 3_600_000).toISOString().slice(0, 7);

/** Signed helpers: > 0 debit, < 0 credit (deductions / credit notes land on the right side). */
export const dr = (account: string, v: number): Line =>
  v >= 0 ? { account, debit: v } : { account, credit: -v };
export const cr = (account: string, v: number): Line => dr(account, -v);

/** Whole non-negative RWF, one positive side per line, ≥ 2 lines, debits = credits > 0. Returns the total. */
export function assertBalanced(lines: Line[]) {
  if (lines.length < 2)
    throw new RangeError("a journal needs at least two lines");
  let d = 0,
    c = 0;
  for (const l of lines) {
    const debit = l.debit ?? 0,
      credit = l.credit ?? 0;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit))
      throw new RangeError(`line ${l.account}: amounts must be whole RWF`);
    if (debit < 0 || credit < 0 || (debit === 0) === (credit === 0))
      throw new RangeError(
        `line ${l.account} must have exactly one positive side`,
      );
    d += debit;
    c += credit;
  }
  if (d !== c)
    throw new RangeError(`unbalanced journal: debits ${d} ≠ credits ${c}`);
  return d;
}

/** Drops zero lines (a fee of 0 posts nothing) and merges duplicates per account and side. */
export function compact(lines: Line[]): Line[] {
  const m = new Map<string, Line>();
  for (const l of lines)
    for (const side of ["debit", "credit"] as const) {
      const v = l[side] ?? 0;
      if (!v) continue;
      const k = `${l.account}:${side}`;
      m.set(k, { account: l.account, [side]: (m.get(k)?.[side] ?? 0) + v });
    }
  return [...m.values()];
}

/** Cash/clearing account for a payment method (stored kinds and finance Method names). */
export const cashAccount = (method: string) => {
  const m = method.toLowerCase().replace(/_/g, "-");
  return m === "mtn-momo"
    ? ACCOUNTS.momoClearing.code
    : m === "airtel-money"
      ? ACCOUNTS.airtelClearing.code
      : m === "card"
        ? ACCOUNTS.cardClearing.code
        : m === "bank-transfer" || m === "bank"
          ? ACCOUNTS.bank.code
          : ACCOUNTS.otherClearing.code;
};

@Injectable()
export class LedgerService implements OnApplicationBootstrap {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The chart is code-owned: make sure every account exists (ledger tables carry no RLS). */
  async onApplicationBootstrap() {
    await this.db
      .insert(ledgerAccounts)
      .values(Object.values(ACCOUNTS).map((a) => ({ ...a })))
      .onConflictDoNothing();
  }

  private async lockOpenPeriod(
    tx: Tx,
    periodId: string,
    mode: "share" | "update",
  ) {
    await tx
      .insert(ledgerPeriods)
      .values({ id: periodId })
      .onConflictDoNothing();
    const [p] = await tx
      .select()
      .from(ledgerPeriods)
      .where(eq(ledgerPeriods.id, periodId))
      .for(mode);
    if (p.status !== "open")
      throw new AppError(
        409,
        "period_locked",
        "That period is closed. Request a reopen first.",
      );
  }

  /**
   * Posts one balanced journal. Idempotent on (sourceType, sourceId): a repeat returns the existing journal id and
   * writes nothing, so webhook replays and job retries never double-post. A closed period → 409 `period_locked`.
   */
  async post(
    tx: Tx,
    j: JournalInput,
  ): Promise<{ id: string; created: boolean }> {
    const lines = compact(j.lines);
    assertBalanced(lines);
    const at = j.occurredAt ?? new Date();
    const periodId = periodOf(at);
    // FOR SHARE: posts don't serialize each other, closePeriod's FOR UPDATE still excludes them.
    await this.lockOpenPeriod(tx, periodId, "share");
    const jid = id("jnl");
    const ins = await tx
      .insert(ledgerJournals)
      .values({
        id: jid,
        periodId,
        occurredAt: at.toISOString(),
        memo: j.memo,
        sourceType: j.sourceType,
        sourceId: j.sourceId,
        reversesId: j.reversesId ?? null,
        createdBy: j.createdBy ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: ledgerJournals.id });
    if (!ins.length) {
      const [have] = await tx
        .select({ id: ledgerJournals.id })
        .from(ledgerJournals)
        .where(
          and(
            eq(ledgerJournals.sourceType, j.sourceType),
            eq(ledgerJournals.sourceId, j.sourceId),
          ),
        );
      return { id: have.id, created: false };
    }
    await tx
      .insert(ledgerEntries)
      .values(
        lines.map((l) => ({
          id: id("le"),
          journalId: jid,
          accountCode: l.account,
          debitRwf: l.debit ?? 0,
          creditRwf: l.credit ?? 0,
        })),
      );
    return { id: jid, created: true };
  }

  /** Journal posted for a source, if any. */
  async journalOf(tx: Tx, sourceType: string, sourceId: string) {
    const [j] = await tx
      .select({ id: ledgerJournals.id })
      .from(ledgerJournals)
      .where(
        and(
          eq(ledgerJournals.sourceType, sourceType),
          eq(ledgerJournals.sourceId, sourceId),
        ),
      );
    return j?.id ?? null;
  }

  /** Mirror-image journal dated now (the original period may be closed). Idempotent per original. */
  async reverse(
    tx: Tx,
    journalId: string,
    memo: string,
    createdBy?: string | null,
  ) {
    const rows = await tx
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.journalId, journalId));
    if (!rows.length) throw notFound("Journal");
    return this.post(tx, {
      sourceType: "reversal",
      sourceId: journalId,
      memo,
      createdBy,
      reversesId: journalId,
      lines: rows.map((r) => ({
        account: r.accountCode,
        debit: r.creditRwf,
        credit: r.debitRwf,
      })),
    });
  }

  /** Signed balance in the account's normal direction (assets/expenses debit-positive, the rest credit-positive). */
  async balance(tx: Tx, code: string) {
    const [r] = await tx
      .select({
        type: ledgerAccounts.type,
        d: sql<string>`coalesce(sum(${ledgerEntries.debitRwf}), 0)`,
        c: sql<string>`coalesce(sum(${ledgerEntries.creditRwf}), 0)`,
      })
      .from(ledgerAccounts)
      .leftJoin(
        ledgerEntries,
        eq(ledgerEntries.accountCode, ledgerAccounts.code),
      )
      .where(eq(ledgerAccounts.code, code))
      .groupBy(ledgerAccounts.type);
    if (!r) throw notFound("Account");
    const net = Number(r.d) - Number(r.c);
    return r.type === "asset" || r.type === "expense" ? net : -net;
  }

  /** Debit and credit totals over every entry; equal in a healthy ledger. */
  async trialBalance(tx: Tx) {
    const [r] = await tx
      .select({
        d: sql<string>`coalesce(sum(${ledgerEntries.debitRwf}), 0)`,
        c: sql<string>`coalesce(sum(${ledgerEntries.creditRwf}), 0)`,
      })
      .from(ledgerEntries);
    return { debits: Number(r.d), credits: Number(r.c) };
  }

  async closePeriod(tx: Tx, periodId: string, by: string | null) {
    await this.lockOpenPeriod(tx, periodId, "update");
    await tx
      .update(ledgerPeriods)
      .set({
        status: "closed",
        closedAt: new Date().toISOString(),
        closedBy: by,
      })
      .where(eq(ledgerPeriods.id, periodId));
  }

  async reopenPeriod(tx: Tx, periodId: string) {
    await tx
      .update(ledgerPeriods)
      .set({ status: "open", closedAt: null, closedBy: null })
      .where(eq(ledgerPeriods.id, periodId));
  }
}
