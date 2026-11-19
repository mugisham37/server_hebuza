// Payments route schemas, moved verbatim from the reference route table (+ refund input).
import { z } from "zod";
import { dto } from "../../core/http/dto";

const Initiate = z
  .object({
    application_code: z.string().trim().min(1).max(64).nullish(),
    plan_id: z.string().trim().min(1).max(64).nullish(),
    method: z.string().trim().min(1).max(32),
    phone_number: z.string().trim().max(32).nullish(),
    card_token: z.string().max(256).nullish(),
    operator: z.string().max(16).nullish(),
    payment_request_ref: z.string().max(64).nullish(),
    /** SUB-10: buy the plan for this company (owner/admin). */
    organization_id: z.string().max(64).nullish(),
  })
  .refine((b) => !!b.application_code !== !!b.plan_id, {
    message: "Provide exactly one of application_code or plan_id.",
    path: ["application_code"],
  });
export class InitiateDto extends dto(Initiate) {}

export class BankTransferDto extends dto(
  z.object({
    application_code: z
      .string()
      .trim()
      .min(1, "application_code is required")
      .max(64),
    reference: z.string().trim().max(128).nullish(),
  }),
) {}
export class WebhookDto extends dto(z.record(z.string(), z.unknown())) {}

export const InitiateOut = z.object({
  paymentId: z.string(),
  transactionId: z.string(),
  status: z.string(),
  expiresAt: z.string().nullable(),
  sessionToken: z.string().nullable(),
}).meta({ id: "InitiatePaymentResponse" });
export const StatusOut = z.object({
  transactionId: z.string(),
  status: z.string(),
  paidAt: z.string().nullable(),
}).meta({ id: "PaymentStatusResponse" });
export const ReceiptOut = z.object({
  serviceName: z.string(),
  trackingCode: z.string(),
  amount: z.number().int(),
  governmentFee: z.number().int(),
  vatAmount: z.number().int(),
  method: z.string(),
  transactionId: z.string(),
  receiptNumber: z.string(),
  paidAt: z.string(),
  applicationCode: z.string(),
}).meta({ id: "PaymentReceiptResponse" });
const Invoice = z.object({
  number: z.string(),
  service: z.string(),
  requestCode: z.string().nullable(),
  issuedAt: z.string(),
  dueAt: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.enum(["due", "overdue", "paid", "refund_pending", "refunded"]),
  refundAmount: z.number().int().nullable().optional(),
});
const Receipt = z.object({
  number: z.string(),
  invoiceNumber: z.string(),
  paidAt: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  method: z.string(),
});
const Method = z.object({
  id: z.string(),
  kind: z.enum(["momo", "card"]),
  label: z.string(),
  last4: z.string(),
  primary: z.boolean(),
});
export const InvoicesOut = z.object({
  invoices: z.array(Invoice),
  creditBalance: z.number().int(),
});
export const ReceiptsOut = z.object({ receipts: z.array(Receipt) });
export const MethodsOut = z.object({ methods: z.array(Method) });
export const DeletedOut = z.object({ deleted: z.boolean() });
export const BankOut = z.object({ status: z.literal("pending_verification") });
export const Accepted = z.object({ status: z.literal("ok") });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export class StatementQueryDto extends dto(z.object({ from: Day, to: Day })) {}
export const StatementOut = z.object({
  from: z.string(), to: z.string(), currency: z.string(), opening: z.number().int(), closing: z.number().int(),
  rows: z.array(z.object({ date: z.string(), type: z.enum(["invoice", "payment", "credit_note"]), number: z.string(), detail: z.string(), amount: z.number().int() })),
}).meta({ id: "ClientStatement" });
