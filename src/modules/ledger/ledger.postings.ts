// Finance postings on the double-entry ledger (port of .ref finance.ledger, F-FIN-13). One balanced journal per money
// event, idempotent on (sourceType, sourceId). Finance/procurement call these inside their own tx.
import type { DocTotals, Method } from "@/domain/finance/types";
import type { Tx } from "../../core/db/db";
import {
  ACCOUNTS as A,
  cashAccount,
  cr,
  dr,
  type Line,
  type LedgerService,
} from "./ledger.service";

async function post(
  l: LedgerService,
  tx: Tx,
  sourceType: string,
  sourceId: string,
  memo: string,
  lines: Line[],
  by?: string | null,
  at?: Date,
) {
  const ls = lines.filter((x) => (x.debit ?? 0) || (x.credit ?? 0));
  if (!ls.length) return null; // nothing moved (zero-amount event): no journal, caller stores no id
  if (ls.length < 2) throw new Error(`unbalanced_posting ${sourceType}:${sourceId}`);
  return (
    await l.post(tx, {
      sourceType,
      sourceId,
      memo,
      lines: ls,
      createdBy: by,
      occurredAt: at,
    })
  ).id;
}
const docLines = (t: DocTotals) => [
  dr(A.receivable.code, t.total),
  cr(A.serviceRevenue.code, t.subtotal),
  cr(A.vatPayable.code, t.vat),
  cr(A.governmentFeesPayable.code, t.passThrough),
];

export const postInvoice = (
  l: LedgerService,
  tx: Tx,
  no: string,
  t: DocTotals,
  by?: string | null,
) => post(l, tx, "fin_invoice", no, `Invoice ${no}`, docLines(t), by);
/** Credit-note totals are negative: the same shape mirrors the invoice. */
export const postCreditNote = (
  l: LedgerService,
  tx: Tx,
  no: string,
  t: DocTotals,
  by?: string | null,
) => post(l, tx, "fin_credit_note", no, `Credit note ${no}`, docLines(t), by);
/** Cash in: applied settles receivable, any excess becomes client credit; provider fee recorded separately. */
export const postPayment = (
  l: LedgerService,
  tx: Tx,
  id: string,
  o: { method: Method; applied: number; credit: number; fee?: number },
  by?: string | null,
) =>
  post(
    l,
    tx,
    "fin_payment",
    id,
    `Payment ${id}`,
    [
      dr(cashAccount(o.method), o.applied + o.credit),
      cr(A.receivable.code, o.applied),
      cr(A.clientCredit.code, o.credit),
      dr(A.providerFees.code, o.fee ?? 0),
      cr(cashAccount(o.method), o.fee ?? 0),
    ],
    by,
  );
export const postCreditApplied = (
  l: LedgerService,
  tx: Tx,
  id: string,
  amount: number,
  by?: string | null,
) =>
  post(
    l,
    tx,
    "fin_credit_applied",
    id,
    `Client credit applied ${id}`,
    [dr(A.clientCredit.code, amount), cr(A.receivable.code, amount)],
    by,
  );
export const reverse = (
  l: LedgerService,
  tx: Tx,
  journalId: string | undefined | null,
  memo: string,
  by?: string | null,
) => (journalId ? l.reverse(tx, journalId, memo, by) : Promise.resolve(null));
/** Refund money out (or kept as client credit). The credit note already moved revenue/VAT; this settles the receivable. */
export const postRefund = (
  l: LedgerService,
  tx: Tx,
  no: string,
  o: { amount: number; method: string; asCredit?: boolean },
  by?: string | null,
) =>
  post(
    l,
    tx,
    "fin_refund",
    no,
    `Refund ${no}`,
    [
      dr(A.receivable.code, o.amount),
      o.asCredit
        ? cr(A.clientCredit.code, o.amount)
        : cr(cashAccount(o.method), o.amount),
    ],
    by,
  );
/** Consultation booking settled (no invoice): cash in, revenue at once. shortcut: price booked as revenue without a VAT split, split when consultations become VAT-invoiced. */
export const postBookingPayment = (
  l: LedgerService,
  tx: Tx,
  txId: string,
  o: { method: string; amount: number },
  by?: string | null,
) =>
  post(l, tx, "bkg_payment", txId, `Booking payment ${txId}`, [
    dr(cashAccount(o.method), o.amount),
    cr(A.serviceRevenue.code, o.amount),
  ], by);
/** Booking refund decided: revenue back to the receivable (money: postRefund then pays it out) or straight to client credit. */
export const postBookingRefund = (
  l: LedgerService,
  tx: Tx,
  no: string,
  o: { amount: number; asCredit: boolean },
  by?: string | null,
) =>
  post(l, tx, "bkg_refund", no, `Booking refund ${no}`, [
    dr(A.serviceRevenue.code, o.amount),
    cr(o.asCredit ? A.clientCredit.code : A.receivable.code, o.amount),
  ], by);
export const postAllocation = (
  l: LedgerService,
  tx: Tx,
  id: string,
  pool: number,
  by?: string | null,
) =>
  post(
    l,
    tx,
    "fin_allocation",
    id,
    `Revenue share ${id}`,
    [dr(A.workerShareExpense.code, pool), cr(A.workerPayable.code, pool)],
    by,
  );
/** Payout line paid: net to the worker, WHT to RRA, licence fees netted as revenue. */
export const postPayoutLine = (
  l: LedgerService,
  tx: Tx,
  id: string,
  o: { net: number; wht: number; fees: number; method: string },
  by?: string | null,
) =>
  post(
    l,
    tx,
    "fin_payout_line",
    id,
    `Payout ${id}`,
    [
      dr(A.workerPayable.code, o.net + o.wht + o.fees),
      cr(cashAccount(o.method), o.net),
      cr(A.whtPayable.code, o.wht),
      cr(A.feeRevenue.code, o.fees),
    ],
    by,
  );
