// View shapes the finance UI reads, copied from the type parts of web/src/lib/finance/{b,c,d,e,f}.ts (those files are client hooks).
// shortcut: duplicate of web view types, move to @/domain/finance when the Conductor does.
import type { Locale } from "@/domain/i18n/config";
import type {
  Adjustment, AgentFee, Allocation, CreditNote, Invoice, MatchState, Method, Payment, PaymentState, PayoutBatch, PayoutLine,
  Provider, Quote, RefundRequest, Rule, Rwf, Share, StatementImport, StatementLine, Step, UserRef,
} from "@/domain/finance/types";
import type { Bucket } from "@/domain/finance/ageing";

// ---- billing (b)

export type BillKind = "company" | "individual";
export type QuoteRec = Quote & {
  clientName: string; service: string; kind: BillKind; notes: Record<Locale, string>; terms: Record<Locale, string>;
  deposit: { deposit: number; balance: number } | null; invoiceNos?: string[];
};
export type QuoteRow = QuoteRec;
export type QuoteDetail = {
  versions: QuoteRec[]; history: { v: number; status: string; at: string; note?: string }[];
  changedBy?: UserRef; changedAt?: string; threshold: number; validityDays: number;
};
export type CaseOption = { ref: string; clientId: string; clientName: string; service: string };
export type BReminder = { at: string; channel: "email" | "whatsapp" | "sms"; by: string; auto?: boolean };
export type InvoiceRow = Invoice & { key: string; clientName: string; ebmRequired: boolean };
export type InvoiceDetail = {
  invoice: InvoiceRow; payments: Payment[]; creditNotes: CreditNote[]; credit: number; reminders: BReminder[]; lang: Locale;
  quoteNo?: string; changedBy?: UserRef; changedAt?: string; statement: { at: string; label: string; amount: number }[]; confirmedPayments: boolean;
};
// ---- payments (c)
export type PayTab = "all" | "pending" | "verification" | "failed" | "expired" | "reversed" | "attention";
export type PaymentRow = {
  id: string; at: string; method: Method; ref?: string; clientName: string; invoiceNo: string; caseRef?: string;
  amount: number; fee?: number; state: PaymentState; verify?: Payment["verify"]; attention: boolean; duplicate?: boolean;
};
export type PaymentList = { items: PaymentRow[]; meta: { counts: Record<PayTab, number>; total: number; amount: number; fee: number; next: string | null } };
export type ProofCandidate = { lineId: string; importId: string; externalRef: string; amount: number; at: string; exactAmount: boolean; refFound: boolean };
export type PaymentDetail = {
  payment: Payment & { clientName: string };
  invoice: { no: string; total: number; balanceDue: number; amountPaid: number; status: string } | null;
  /** Received − balance due (negative = partial). */ diff: number;
  /** Part of the amount that becomes client credit if confirmed. */ over: number;
  candidates: ProofCandidate[]; returnAt?: string; lockUntil?: string; evidence?: string;
  impact: { invoiceNo: string; balanceAfter: number; allocation: boolean; paidOut: boolean };
};
export type InvoiceOption = { no: string; client: string; balance: number; caseRef?: string };
export type ProviderCard = { provider: Provider; lastImport?: { id: string; at: string; by: string }; pct: number | null; needs: number };
export type Lock = "open" | "closed" | "reopened";
export type DayCell = { day: string; lines: number; needs: number; lock: Lock };
export type ImportRow = StatementImport & { at: string; fileName: string };
export type Blocker = { lineId: string; ref: string; match: MatchState; importId: string };
export type ReconOverview = {
  providers: ProviderCard[]; days: DayCell[]; month: { month: string; state: Lock; blockers: number };
  selected: { provider: Provider; day: string; lock: Lock; lines: number; needs: number; difference: number; blockers: Blocker[]; importId?: string };
  imports: ImportRow[];
};
export type LineRow = StatementLine & {
  rev: number; payer?: string; day: string; locked: boolean; diff?: number; by?: { name: string; at: string };
  payment?: { id: string; invoiceNo: string; clientName: string; amount: number; state: PaymentState };
};
export type PlatformRow = { id: string; at: string; ref?: string; invoiceNo: string; clientName: string; amount: number; state: PaymentState };
export type ImportDetail = { import: ImportRow; lines: LineRow[]; platform: PlatformRow[]; totals: { statement: number; platform: number; difference: number }; counts: Record<MatchState, number> };
export type LineCandidate = { id: string; invoiceNo: string; clientName: string; amount: number; at: string; state: PaymentState; diff: number };
export type Mapping = Record<"external_ref" | "amount" | "fee" | "occurred_at", string>;
export type ImportRowIn = { externalRef: string; amount: number; fee: number; occurredAt: string; payer?: string };
// ---- receivables + refunds (d)
export type Channel = "email" | "whatsapp" | "sms";
export type DReminder = { at: string; channel: Channel; lang: Locale; by: string; scheduledFor?: string };
export type ArClient = {
  clientId: string; name: string; language: Locale; outstanding: number; buckets: Record<Bucket, number>; oldestDays: number;
  bucket: Bucket; credit: number; invoices: number; lastReminder?: DReminder; promise?: { at: string; note: string };
};
export type ArSummary = { asOf: string; total: number; overdue31: number; due0_30: number; over90: number; buckets: Record<Bucket, number>; clients: ArClient[] };
export type ArInvoice = Invoice & { bucket: Bucket; days: number; reminders: DReminder[] };
export type ArNote = { id: string; at: string; by: string; text: string; promiseAt?: string };
export type ArClientDetail = {
  client: { id: string; name: string; type: string; phone: string; email: string; language: Locale; consent: Record<Channel, boolean> };
  summary: ArClient; invoices: ArInvoice[]; payments: Payment[]; credits: CreditNote[]; notes: ArNote[];
};
export type RefundTab = "awaiting_me" | "requested" | "in_review" | "awaiting_executive" | "executing" | "completed" | "rejected" | "credit_notes";
export type RefundRow = RefundRequest & {
  clientName: string; tier: "finance" | "executive"; mine: boolean; eligiblePart: number; passThroughRefunded: number;
  changedFrom?: number; adjustedBy?: UserRef; rejectReason?: string; failReason?: string; note?: string;
  updatedBy?: string; updatedAt?: string; execStartedAt?: string; proofDocId?: string;
};
export type ImpactRow = { workerId: string; name: string; allocated: number; reversal: number; net: number; paidOut: boolean; voided: boolean };
export type RefundDetail = {
  refund: RefundRow; invoice: Invoice; policy: Record<string, number>; refundable: number; limit: number; impact: ImpactRow[];
  payer: { masked: string }; creditNote: CreditNote | null; locked: boolean;
  can: { sign: boolean; signReason?: "complete" | "same_approver" | "forbidden"; execute: boolean; adjust: boolean; reject: boolean; review: boolean };
};
export type CreditNoteDetail = CreditNote & { clientName: string; refund?: RefundRow; invoiceTotal: number; outcome: "balance" | "credit" | "refund" };
// ---- revenue + payouts (e)
export type Who = { id: string; name: string; kind: "internal" | "external" | "field" };
export type Five = { invoiced: Rwf; collected: Rwf; allocated: Rwf; approved: Rwf; paid: Rwf };
export type LastChange = { by: string; at: string };
export type AllocView = Omit<Allocation, "shares"> & {
  serviceName: string; clientName: string; completedAt: string; shares: (Share & { name: string })[];
  rule: { scope: Rule["scope"]; from: string; to?: string }; credits: Rwf; five: Five; rev: number; last?: LastChange;
  can: { approve: boolean; query: boolean; hold: boolean; void: boolean; answer: boolean };
  waitingFor?: string;
};
export type AllocTiles = Record<"pending_review" | "reviewed" | "approved_for_payment" | "paid", { amount: Rwf; n: number }>;
export type RuleView = Rule & { label: string; agentName?: string; serviceName?: string; chain: Step[]; can: { approve: boolean; end: boolean } };
export type AdjView = Adjustment & { workerName: string; caseRef?: string; chain: Step[]; createdBy: { id: string; name: string }; at: string; can: { approve: boolean } };
export type FeeView = AgentFee & { workerName: string };
export type LineView = PayoutLine & {
  name: string; kind: "internal" | "external"; taxable: Rwf; carriedIn: Rwf;
  parts: { allocations: { id: string; caseRef: string; amount: Rwf }[]; adjustments: { id: string; amount: Rwf; reason: string }[]; fees: { id: string; month: string; amount: Rwf }[] };
  failReason?: string; paidAt?: string;
};
export type Totals = PayoutBatch["totals"];
export type BatchView = Omit<PayoutBatch, "lines"> & {
  lines: LineView[]; chain: Step[]; agents: number; rev: number; last?: LastChange;
  vsLast: { net: Rwf; pct: number } | null; rejectNote?: string; statements?: "running" | "ready";
  can: { submit: boolean; authorise: boolean; reject: boolean; execute: boolean; mark: boolean; close: boolean; exclude: boolean; export: boolean };
  whyNot?: "preparer" | "role" | "status";
};
export type Preview = {
  no: string; period: string; exists: string | null; lines: LineView[]; totals: Totals;
  blockers: { workerId: string; name: string; kind: "unverified" | "cooling"; until?: string }[];
};

// ---- settings (f)
export type LocalChange = {
  id: string; area: "numbering" | "policy"; key: string; old: unknown; next: unknown; effectiveAt: string;
  status: "proposed" | "approved" | "applied" | "rejected"; proposedBy: UserRef; approvedBy?: UserRef; reason: string; at: string;
};
export type NumberingRow = { series: string; prefix: string; reset: "yearly" | "monthly"; next: string | null; last: string | null };
export type FinAccount = {
  id: string; name: string; method: "bank" | "mtn_momo" | "airtel_money"; masked: string; status: "pending_callback" | "verified";
  addedBy: UserRef; verifiedBy?: UserRef; payoutLockedUntil?: string;
};
export type HistoryRow = {
  id: string; at: string; actor: string; action: string; kind: string; record: string; field: string | null; before: unknown; after: unknown; reason: string | null;
};
export type Policies = { refundPolicy: Record<string, number>; reminderOffsets: number[]; changes: LocalChange[] };
