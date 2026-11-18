// Report/overview shapes + payoutLine copied from web/src/lib/finance/{a,money}.ts (those files are client hooks).
// shortcut: duplicate of web lib types, move to @/domain/finance when the Conductor does.
import { applyBps } from "@/domain/money";
import { POLICY } from "@/domain/policy";
import type { Bps, Rwf } from "@/domain/finance/types";
import type { Bucket } from "@/domain/finance/ageing";
import type { Account } from "@/domain/finance/journal";

export const REPORT_KEYS = [
  "fin.revenue",
  "fin.collections",
  "fin.receivables_ageing",
  "fin.reconciliation",
  "fin.refunds_credit_notes",
  "fin.revenue_share",
  "fin.revenue_reconciliation",
  "fin.vat",
  "fin.wht_payable",
  "fin.cash_flow",
  "fin.subscriptions",
  "fin.payables_ageing",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
export const isReportKey = (k: string): k is ReportKey =>
  (REPORT_KEYS as readonly string[]).includes(k);
export type ColKind = "money" | "count" | "pct";
export type ReportCol = { key: string; kind: ColKind; drill: boolean };
export type ReportRow = {
  key: string;
  label: string;
  values: Record<string, number>;
};
export type DrillItem = {
  ref: string;
  href: string;
  date: string;
  party: string;
  state?: string;
  value: number;
};
export type CatalogItem = { key: ReportKey; lastRun: string | null };

export type QueueKey =
  | "proofs"
  | "pending_momo"
  | "allocations"
  | "unmatched"
  | "refunds"
  | "overdue";
export type Overview = {
  date: string;
  execOnly: boolean;
  quiet: boolean;
  tiles: {
    collected: {
      total: Rwf;
      count: number;
      spark: number[];
      delta: number | null;
      href: string;
    };
    pending: { total: Rwf; count: number; href: string };
    unreconciled: {
      total: Rwf;
      count: number;
      hasImport: boolean;
      href: string;
    };
    refunds: { total: Rwf; count: number; href: string };
    allocations: { total: Rwf; count: number; href: string };
  };
  nextPayout: { date: string; projectedNet: Rwf; agents: number };
  ageing: Record<Bucket, Rwf>;
  receivables: Rwf;
  currentPct: number;
  renewals: { due7: number; pastDue: number };
  queues: { key: QueueKey; n: number; href: string }[];
};

export const JOURNAL_FORMATS = [
  "generic_csv",
  "quickbooks",
  "xero",
  "odoo",
] as const;
export type JournalFormat = (typeof JOURNAL_FORMATS)[number];
export type JournalBody = {
  from: string;
  to: string;
  format: JournalFormat;
  map?: Partial<Record<Account, string>>;
};

/** One payout line (REV §12.8/12.9, X-2): WHT on externals, then fees; net < 0 → 0 and carried forward. */
export function payoutLine(o: {
  gross: Rwf;
  adjustments: Rwf;
  fees: Rwf;
  external: boolean;
  whtBps?: Bps;
  carried?: Rwf;
}) {
  const taxable = o.gross + o.adjustments + (o.carried ?? 0);
  const wht =
    o.external && taxable > 0
      ? applyBps(taxable, o.whtBps ?? POLICY.whtBps)
      : 0;
  const fees = o.external ? o.fees : 0;
  const raw = taxable - wht - fees;
  return {
    taxable,
    wht,
    fees,
    net: Math.max(0, raw),
    carryForward: Math.min(0, raw),
  };
}
