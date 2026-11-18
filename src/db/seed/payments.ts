// Payments seed (dev/staging only, port of .ref payments.seed): the demo client's settled payments for the cases
// seedApplications marks paid, each with its balanced ledger journal (same lines PaymentsService.settle posts), and a
// saved card. Idempotent (fixed ids, ON CONFLICT DO NOTHING). Run after seedApplications. The API seeds the full chart.
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { splitVat } from "@/domain/money";
import { POLICY } from "@/domain/policy";
import type * as schema from "../schema";
import { payments } from "../schema/schema";
import { clientPaymentMethods } from "../schema/schema-payments";
import {
  ledgerAccounts,
  ledgerEntries,
  ledgerJournals,
  ledgerPeriods,
} from "../schema/schema-ledger";

type Db = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
const CLIENT = "mock-client";
const PAID = [
  ["HBZ-K2M9QA", 20_000, -1],
  ["HBZ-4K2M9Q", 20_000, -1.5],
] as const;
// Same codes as ACCOUNTS in server ledger.service.ts.
const ACC = [
  { code: "1100", name: "MTN MoMo clearing", type: "asset" },
  { code: "2200", name: "VAT payable", type: "liability" },
  { code: "4100", name: "Service fee revenue", type: "revenue" },
];

export async function seedPayments(db: Db) {
  await db.insert(ledgerAccounts).values(ACC).onConflictDoNothing();
  for (const [code, amount, ago] of PAID) {
    const k = code.slice(4).toLowerCase();
    const at = new Date(Date.now() + ago * 86_400_000);
    const iso = at.toISOString();
    const txId = `txn_seed_${k}`;
    const ins = await db
      .insert(payments)
      .values({
        paymentId: `pay_seed_${k}`,
        applicationCode: code,
        transactionId: txId,
        amountRwf: amount,
        governmentFeeRwf: 0,
        platformFeeRwf: amount,
        vatRate: (POLICY.vatBps / 10_000).toFixed(3),
        currency: "RWF",
        method: "mtn-momo",
        maskedPhone: "******0000",
        status: "succeeded",
        receiptNumber: `RCPT-${txId.slice(-8).toUpperCase()}`,
        providerTransactionId: txId,
        paidAt: iso,
        createdAt: iso,
        updatedAt: iso,
        clientId: CLIENT,
      })
      .onConflictDoNothing()
      .returning({ id: payments.paymentId });
    if (!ins.length) continue;
    const { vat } = splitVat(amount, POLICY.vatBps);
    const periodId = new Date(at.getTime() + 2 * 3_600_000)
      .toISOString()
      .slice(0, 7);
    await db
      .insert(ledgerPeriods)
      .values({ id: periodId })
      .onConflictDoNothing();
    const jid = `jnl_seed_${k}`;
    await db
      .insert(ledgerJournals)
      .values({
        id: jid,
        periodId,
        occurredAt: iso,
        memo: `Payment ${txId} for ${code}`,
        sourceType: "payment",
        sourceId: `pay_seed_${k}`,
      })
      .onConflictDoNothing();
    await db
      .insert(ledgerEntries)
      .values([
        {
          id: `le_seed_${k}_1`,
          journalId: jid,
          accountCode: "1100",
          debitRwf: amount,
          creditRwf: 0,
        },
        {
          id: `le_seed_${k}_2`,
          journalId: jid,
          accountCode: "2200",
          debitRwf: 0,
          creditRwf: vat,
        },
        {
          id: `le_seed_${k}_3`,
          journalId: jid,
          accountCode: "4100",
          debitRwf: 0,
          creditRwf: amount - vat,
        },
      ])
      .onConflictDoNothing();
  }
  await db
    .insert(clientPaymentMethods)
    .values([
      {
        id: "pm_seed_momo",
        clientId: CLIENT,
        kind: "momo",
        label: "MTN MoMo",
        last4: "0000",
        isPrimary: true,
      },
      {
        id: "pm_seed_card",
        clientId: CLIENT,
        kind: "card",
        label: "Visa",
        last4: "4242",
        isPrimary: false,
      },
    ])
    .onConflictDoNothing();
}
