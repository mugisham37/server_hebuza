// Finance input schemas (moved verbatim from the reference finance route table + the client quotation/refund routes).
import { z } from "zod";
import type { Role } from "@/domain/auth/roles";
import { dto } from "../../core/http/dto";

export const FIN: Role[] = ["staff:finance"];
export const FINX: Role[] = ["staff:finance", "staff:executive"];
export const EXEC: Role[] = ["staff:executive"];
export const SM: Role[] = ["staff:service_manager"];
export const RFD_READ: Role[] = [
  "staff:finance",
  "staff:executive",
  "staff:service_manager",
];
export const CLIENT: Role[] = ["client"];
/** Money/state write: idempotent + write rate limit (SERIALIZABLE comes from FinRunner.write). */
export const W = { idempotent: true, limit: "write" } as const;

const Str = z.string().trim();
const Rev = z.number().int().optional();
const Reason = z.string().max(2000).optional();
const Locale = z.enum(["rw", "en", "fr"]);
const I18n = z.union([
  z.string().max(300),
  z.record(z.string(), z.string().max(300)),
]);
const DocLine = z.object({
  kind: z.enum([
    "service_fee",
    "urgent_surcharge",
    "government_fee",
    "third_party_cost",
    "discount",
    "other",
  ]),
  label: I18n,
  qty: z.number().int().min(1).max(10_000),
  unit: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  taxable: z.boolean().optional(),
});
const Lines = z.array(DocLine).max(100);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use YYYY-MM-DD.");
const Method = z.enum([
  "mtn_momo",
  "airtel_money",
  "card",
  "bank_transfer",
  "cash",
  "other",
]);
const Provider = z.enum(["mtn_momo", "airtel_money", "card", "bank"]);
const RefundMethod = z.enum([
  "original",
  "mtn_momo",
  "airtel_money",
  "bank",
  "credit",
]);
const Page = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
});
const MappingS = z.object({
  external_ref: Str.max(80),
  amount: Str.max(80),
  fee: Str.max(80).default(""),
  occurred_at: Str.max(80),
});
const Journal = z.object({
  from: Day,
  to: Day,
  format: z.enum(["generic_csv", "quickbooks", "xero", "odoo"]),
  map: z.record(z.string(), z.string().max(32)).default({}),
});

// ---- shared bodies
export class RevDto extends dto(z.object({ rev: Rev })) {}
export class RevReasonDto extends dto(
  z.object({ rev: Rev, reason: Reason, note: Reason }),
) {}
export class ReasonDto extends dto(z.object({ reason: Reason })) {}
export class RevOnlyReasonDto extends dto(
  z.object({ rev: Rev, reason: Reason }),
) {}
export class IdsDto extends dto(
  z.object({
    ids: z.array(Str.max(96)).max(500),
    preview: z.boolean().optional(),
  }),
) {}
export class DecisionDto extends dto(
  z.object({ decision: z.enum(["approve", "reject"]), reason: Reason }),
) {}

// ---- core + settings
export class ApprovalsQueryDto extends dto(
  z.object({ type: Str.max(32).optional() }),
) {}
export class SettingDto extends dto(
  z.object({
    key: Str.max(40),
    value: z.unknown(),
    effectiveAt: Day,
    reason: Str.max(2000),
  }),
) {}
export class LocalChangeDto extends dto(
  z.object({
    area: z.enum(["numbering", "policy"]),
    key: Str.max(40),
    next: z.unknown(),
    effectiveAt: Day,
    reason: Str.max(2000),
  }),
) {}
export class AccountDto extends dto(
  z.object({
    name: Str.min(1).max(120),
    method: z.enum(["bank", "mtn_momo", "airtel_money"]),
    number: Str.max(24),
  }),
) {}
export class HistoryQueryDto extends dto(
  z.object({
    range: Str.max(5).optional(),
    kind: Str.max(32).optional(),
    q: Str.max(200).optional(),
    page: Str.max(6).optional(),
  }),
) {}

// ---- quotations
export class QuotesQueryDto extends dto(
  Page.extend({ state: Str.max(32).optional(), q: Str.max(200).optional() }),
) {}
export class NewQuoteDto extends dto(
  z.object({ caseRef: Str.min(1).max(64) }),
) {}
export class QuotePatchDto extends dto(
  z.object({
    rev: Rev,
    lines: Lines.optional(),
    lang: Locale.optional(),
    validUntil: Day.optional(),
    kind: z.enum(["company", "individual"]).optional(),
    tin: Str.max(20).optional(),
    notes: z.record(Locale, z.string().max(2000)).optional(),
    terms: z.record(Locale, z.string().max(4000)).optional(),
  }),
) {}
export class SendQuoteDto extends dto(
  z.object({
    rev: Rev,
    channels: z.array(Str.max(20)).max(5).optional(),
    message: z.string().max(500).optional(),
  }),
) {}

// ---- invoices + receivables
export class InvoicesQueryDto extends dto(
  Page.extend({
    state: Str.max(32).optional(),
    series: Str.max(16).optional(),
    client: Str.max(64).optional(),
    due: Str.max(8).optional(),
    ebm: Str.max(16).optional(),
    overdue: Str.max(2).optional(),
    q: Str.max(200).optional(),
  }),
) {}
export class NewInvoiceDto extends dto(
  z.object({
    clientId: Str.min(1).max(64),
    caseRef: Str.max(64).optional(),
    series: z.enum(["standard", "deposit", "plan", "credit"]).optional(),
    lines: Lines,
    dueAt: Day,
    lang: Locale.optional(),
    // F-FIN-20: optional display currency; amounts stay RWF, the rate (RWF per unit) is frozen on the invoice.
    fx: z.object({ currency: z.enum(["USD", "EUR", "KES", "UGX", "TZS"]), rate: z.number().positive().max(1_000_000) }).optional(),
    promoCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,32}$/).optional(), // F-CRM-20
  }),
) {}
export class InvoicePatchDto extends dto(
  z.object({
    rev: Rev,
    lines: Lines.optional(),
    dueAt: Day.optional(),
    lang: Locale.optional(),
  }),
) {}
export class ApplyCreditDto extends dto(
  z.object({ rev: Rev, amount: z.number().int().optional() }),
) {}
export class EbmDto extends dto(
  z.object({ rev: Rev, no: Str.max(40).optional() }),
) {}
export class RemindDto extends dto(
  z.object({
    channel: z.enum(["email", "whatsapp", "sms"]),
    lang: Locale.optional(),
    text: z.string().max(2000).optional(),
    template: Str.max(64).optional(),
  }),
) {}
export class ArNoteDto extends dto(
  z.object({
    text: z.string().max(2000).optional(),
    promiseAt: Day.optional().or(z.literal("")),
  }),
) {}

// ---- payments + reconciliation
export class PaymentsQueryDto extends dto(
  z.object({
    tab: Str.max(16).optional(),
    method: Str.max(16).optional(),
    from: Str.max(10).optional(),
    to: Str.max(10).optional(),
    client: Str.max(64).optional(),
    case: Str.max(64).optional(),
    q: Str.max(200).optional(),
    cursor: Str.max(8).optional(),
  }),
) {}
export class QDto extends dto(z.object({ q: Str.max(200).optional() })) {}
export class ManualPaymentDto extends dto(
  z.object({
    invoiceNo: Str.min(1).max(64),
    method: Method,
    amount: z.number().int(),
    bankReference: Str.max(64).optional(),
    receivedAt: Str.min(10).max(40),
    evidenceName: Str.max(200).optional(),
    evidenceUploadId: Str.max(96).optional(), // POST /api/uploads id; preferred over a bare name
    reason: z.string().max(500),
    note: z.string().max(2000).optional(),
    lineId: Str.max(96).optional(),
  }),
) {}
export class LockDto extends dto(
  z.object({ release: z.boolean().optional() }),
) {}
export class ConfirmPaymentDto extends dto(
  z.object({ rev: Rev, bankReference: Str.max(64).optional() }),
) {}
export class StatementsQueryDto extends dto(
  z.object({ provider: Str.max(16).optional(), date: Str.max(10).optional() }),
) {}
export class MappingQueryDto extends dto(
  z.object({ provider: Str.max(16).default("mtn_momo") }),
) {}
export class ImportDto extends dto(
  z.object({
    provider: Provider,
    fileName: Str.max(200),
    fileHash: Str.min(8).max(128),
    mapping: MappingS,
    // Rows parsed client-side from CSV/XLSX, or `csv` text parsed here with the mapping (server-side parser).
    rows: z
      .array(
        z.object({
          externalRef: Str.min(1).max(96),
          amount: z.number().int(),
          fee: z.number().int().default(0),
          occurredAt: Str.min(10).max(40),
          payer: Str.max(40).optional(),
        }),
      )
      .max(20_000)
      .optional(),
    csv: z.string().max(5_000_000).optional(),
  }),
) {}
export const LINE_ACTIONS = [
  "match",
  "ignore",
  "fee",
  "flag",
  "refund-proposal",
] as const;
export class LineActionDto extends dto(
  z.object({
    rev: Rev,
    paymentId: Str.max(96).optional(),
    handling: z
      .enum(["none", "provider_fee", "partial", "exception"])
      .optional(),
    reason: Reason,
    note: Reason,
  }),
) {}
export class VerifyPendingDto extends dto(
  z.object({ provider: Provider.optional() }),
) {}

// ---- refunds
export class RefundsQueryDto extends dto(
  z.object({ tab: Str.max(24).optional(), case: Str.max(64).optional() }),
) {}
export class NewRefundDto extends dto(
  z.object({
    invoiceNo: Str.min(1).max(64),
    reason: z.enum([
      "quality_dispute",
      "cancelled_before_work",
      "duplicate_payment",
      "service_not_delivered",
      "other",
    ]),
    note: z.string().max(2000),
  }),
) {}
export class ReviewRefundDto extends dto(
  z.object({
    decision: z.enum(["recommend", "reject"]),
    amount: z.number().int().optional(),
    note: z.string().max(2000),
    rev: Rev,
  }),
) {}
export class AdjustRefundDto extends dto(
  z.object({
    amount: z.number().int(),
    spent: z.boolean(),
    method: RefundMethod,
    destination: Str.max(32).optional(),
    note: z.string().max(2000),
    rev: Rev,
  }),
) {}
export class RejectRefundDto extends dto(
  z.object({ reason: Str.max(200), note: Reason, rev: Rev }),
) {}
export class ExecuteRefundDto extends dto(
  z.object({
    rev: Rev,
    method: RefundMethod.optional(),
    proofName: Str.max(200).optional(),
    proofUploadId: Str.max(96).optional(), // POST /api/uploads id
  }),
) {}

// ---- revenue
export class AllocationsQueryDto extends dto(
  z.object({
    state: Str.max(32).optional(),
    agent: Str.max(64).optional(),
    period: Str.max(7).optional(),
  }),
) {}
export const ALLOC_ACTIONS = [
  "approve",
  "query",
  "hold",
  "void",
  "release",
  "answer",
] as const;
export class AllocActionDto extends dto(
  z.object({ rev: Rev, reason: Reason, note: Reason, text: Reason }),
) {}
export class RulePreviewQueryDto extends dto(
  z.object({
    scope: Str.max(16).optional(),
    agentId: Str.max(64).optional(),
    serviceSlug: Str.max(96).optional(),
    contractId: Str.max(64).optional(),
    pct: Str.max(6).optional(),
    from: Str.max(10).optional(),
  }),
) {}
export class NewRuleDto extends dto(
  z.object({
    scope: z
      .enum(["global", "service", "agent", "agent_service", "contract"])
      .optional(),
    serviceSlug: Str.max(96).optional(),
    agentId: Str.max(64).optional(),
    contractId: Str.max(64).optional(),
    agentPct: z.number().int().optional(),
    appliesTo: z.enum(["one_off", "subscription", "both"]).optional(),
    from: Day.optional(),
    to: Day.optional(),
    reason: Reason,
  }),
) {}
export class EndRuleDto extends dto(
  z.object({ to: Day.optional(), reason: Reason }),
) {}
export class NewAdjustmentDto extends dto(
  z.object({
    workerId: Str.max(64).optional(),
    amount: z.number().int().optional(),
    reason: z
      .enum(["refund", "correction", "bonus", "clawback", "other"])
      .optional(),
    note: Reason,
    allocationId: Str.max(96).optional(),
  }),
) {}
export class NewFeeDto extends dto(
  z.object({
    workerId: Str.max(64).optional(),
    kind: z.enum(["licensing", "platform", "other"]).optional(),
    amount: z.number().int().optional(),
    month: Str.max(7).optional(),
  }),
) {}

// ---- payouts
export class PreviewQueryDto extends dto(
  z.object({
    period: Str.max(7).optional(),
    run: Str.max(2).optional(),
    excluded: Str.max(4000).optional(),
  }),
) {}
export class ExportQueryDto extends dto(
  z.object({ format: Str.max(10).default("summary") }),
) {}
export class NewBatchDto extends dto(
  z.object({
    period: Str.max(7).optional(),
    run: z.number().int().min(1).max(9).optional(),
    excluded: z.array(Str.max(64)).max(500).optional(),
  }),
) {}
export class PayoutLineDto extends dto(
  z.object({
    ref: Str.max(96).optional(),
    reason: Reason,
    proofDocId: Str.max(96).optional(),
  }),
) {}

// ---- overview + journal export
export class OverviewQueryDto extends dto(z.object({ date: Day.optional() })) {}
export class JournalDto extends dto(Journal) {}

// ---- client (me/*)
export class RespondQuoteDto extends dto(
  z
    .object({ reason: z.string().max(2000).optional() })
    .optional()
    .default({}),
) {}
export class ClientRefundDto extends dto(
  z.object({
    caseRef: z.string().max(32),
    reason: z.enum(["not_delivered", "cancelled", "duplicate", "other"]),
    details: z.string().max(2000).optional(),
    method: z.string().max(16).optional(),
    idempotencyKey: z.string().max(128).optional(),
  }),
) {}
export class DisbursementDto extends dto(
  z.object({ vendorId: Str.min(1).max(64), label: Str.min(1).max(200), amount: z.number().int().positive().max(1_000_000_000), billNo: Str.max(64).optional() }),
) {}
