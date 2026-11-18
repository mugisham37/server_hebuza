// Client side of finance (moved from account, W2-A skipped them): quotations sent to me, refund requests on my paid invoices.
import type {
  Invoice,
  Payment,
  Quote,
  RefundReason,
} from "@/domain/finance/types";
import { AppError, notFound } from "../../core/http/errors";
import { all, one, put, where, type Fin } from "./finance.store";
import { requestRefund, type R } from "./finance.refunds";

// ---------------------------------------------------------------- client quotations (finance quotes sent to me)
const CLIENT_QUOTE: Partial<
  Record<Quote["status"], "pending" | "accepted" | "declined" | "expired">
> = {
  sent: "pending",
  accepted: "accepted",
  declined: "declined",
  expired: "expired",
  converted: "accepted",
};
export async function myQuotations(f: Fin) {
  const qs = (await all<Quote>(f.db, "quote")).filter(
    (q) => q.clientId === f.me.id && CLIENT_QUOTE[q.status],
  );
  return {
    quotations: qs
      .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
      .map((q) => ({
        number: q.no,
        service: f.D.serviceName(f.D.caseOf(q.caseRef)?.service ?? q.caseRef),
        issuedAt: q.sentAt ?? q.validUntil,
        expiresAt: q.validUntil,
        amount: q.totals.total,
        currency: "RWF",
        status:
          q.status === "sent" &&
          q.validUntil < new Date().toISOString().slice(0, 10)
            ? "expired"
            : CLIENT_QUOTE[q.status]!,
        note: q.responseNote ?? null,
      })),
  };
}
export async function respondQuotation(
  f: Fin,
  no: string,
  action: "accept" | "decline",
  reason?: string,
) {
  const [q] = (
    await where<Quote>(f.db, "quote", { ref: no, status: ["sent"] })
  ).filter((x) => x.clientId === f.me.id);
  if (!q) {
    if (
      (await where<Quote>(f.db, "quote", { ref: no })).some(
        (x) => x.clientId === f.me.id,
      )
    )
      throw new AppError(
        409,
        "conflict",
        "This quotation can no longer be changed.",
      );
    throw notFound("Quotation");
  }
  await one(f.db, "quote", `${q.no}#${q.version}`, true); // row lock: a concurrent staff withdraw waits
  if (action === "decline" && !reason?.trim())
    throw new AppError(422, "validation", "A reason is required.");
  const next: Quote = {
    ...q,
    status: action === "accept" ? "accepted" : "declined",
    respondedAt: new Date().toISOString(),
    responseNote: reason?.trim() || undefined,
    rev: q.rev + 1,
  };
  await put(f.db, "quote", `${q.no}#${q.version}`, next, q.no);
  f.rec(
    `quote.${next.status}`,
    "quote",
    q.no,
    { status: q.status },
    { status: next.status },
    reason ?? null,
  );
  return { updated: true };
}

// ---------------------------------------------------------------- client refunds (finance refund requests on my invoices)
const STAGE: Record<
  R["status"],
  "requested" | "reviewed" | "approved" | "paid" | "partial" | "declined"
> = {
  requested: "requested",
  under_review: "reviewed",
  recommended: "reviewed",
  awaiting_executive: "approved",
  approved: "approved",
  executing: "approved",
  execution_failed: "approved",
  credited: "paid",
  completed_as_credit: "paid",
  refunded: "paid",
  rejected: "declined",
  withdrawn: "declined",
};
const REASON: Record<string, RefundReason> = {
  not_delivered: "service_not_delivered",
  cancelled: "cancelled_before_work",
  duplicate: "duplicate_payment",
  other: "other",
};
async function myPaidInvoices(f: Fin) {
  return (await all<Invoice>(f.db, "invoice")).filter(
    (i) => i.clientId === f.me.id && i.no && i.caseRef && i.amountPaid > 0,
  );
}
export async function refundEligibility(f: Fin) {
  const [invs, pays, rfds] = await Promise.all([
    myPaidInvoices(f),
    all<Payment>(f.db, "payment"),
    all<R>(f.db, "refund"),
  ]);
  return {
    payments: invs.map((i) => {
      const open_ = rfds.some(
        (r) =>
          r.invoiceNo === i.no &&
          ![
            "rejected",
            "withdrawn",
            "refunded",
            "completed_as_credit",
          ].includes(r.status),
      );
      const m = pays.find((p) => p.invoiceNo === i.no)?.method;
      return {
        caseRef: i.caseRef!,
        service: f.D.serviceName(f.D.caseOf(i.caseRef)?.service ?? i.caseRef!),
        paid: i.amountPaid,
        method: m === "card" ? ("card" as const) : ("momo" as const),
        eligible: !open_ && i.amountCredited < i.totals.total,
        reason: open_ ? "A refund for this payment is already open." : null,
      };
    }),
  };
}
export async function myRefunds(f: Fin) {
  const invs = new Set((await myPaidInvoices(f)).map((i) => i.no));
  const rs = (await all<R>(f.db, "refund")).filter((r) =>
    invs.has(r.invoiceNo),
  );
  return {
    refunds: rs
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((r) => ({
        ref: r.no,
        caseRef: r.caseRef,
        amount: r.requested,
        refunded:
          STAGE[r.status] === "paid" ? (r.approved ?? r.requested) : null,
        status:
          r.approved != null &&
          r.approved < r.requested &&
          STAGE[r.status] === "paid"
            ? "partial"
            : STAGE[r.status],
        createdAt: r.at,
        note: null,
      })),
  };
}
export async function createRefund(
  f: Fin,
  b: { caseRef: string; reason: string; details?: string },
) {
  const inv = (await myPaidInvoices(f)).find((i) => i.caseRef === b.caseRef);
  if (!inv)
    throw new AppError(409, "not_eligible", "This payment can't be refunded.");
  const r = await requestRefund(f, {
    invoiceNo: inv.no!,
    reason: REASON[b.reason] ?? "other",
    note: b.details?.trim() || b.reason,
  });
  return { ref: (r as { no: string }).no };
}

