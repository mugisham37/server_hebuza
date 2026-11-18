// Finance background work: refund disbursement (gateway via PaymentsService), bank-transfer decisions, booking refunds (outbox `booking.refund_requested`), the
// payments sweep (provider-pending → expired, stale half-signed confirms → queue) and effective-dated settings.
import { Injectable, Logger } from "@nestjs/common";
import { PaymentsService } from "../payments/payments.service";
import { LedgerService } from "../ledger/ledger.service";
import { postBookingRefund } from "../ledger/ledger.postings";
import { Cron, Job } from "../../core/queue/queues";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { where } from "./finance.store";
import { expirePending, returnStaleVerifications } from "./finance.payments";
import { bookingRefund, claimDisbursement, failStaleClaims, settleDisbursement, type BookingRefund, type R } from "./finance.refunds";
import { applyDueSettings } from "./finance.core";

@Injectable()
export class FinanceJobs {
  private readonly log = new Logger("finance");
  constructor(
    private readonly txs: TxService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
  ) {}

  /** Claim (tx) → gateway refund via PaymentsService (no tx) → outcome (tx). No gateway refund ⇒ execution_failed with the reason. */
  @Job("finance.refund.disburse")
  async disburse(d: { no: string }) {
    const c = await this.txs.runAsSystem((db) => claimDisbursement(db, d.no));
    if (!c) return;
    const out = await this.payments.disburseRefund(c);
    const r = await this.txs.runAsSystem(async (db) => {
      const r = await settleDisbursement(db, this.ledger, d.no, out);
      if (r)
        await this.audit.record(db, {
          action: r.status === "refunded" ? "financial.refund.paid" : "financial.refund.execution_failed",
          entity: "refund", entityId: r.no, after: { status: r.status }, reason: r.failReason,
        });
      return r;
    });
    if (r?.status === "execution_failed") this.log.warn(`refund_manual_payout_required ${d.no}: ${r.failReason}`);
  }

  @Cron("finance.refunds.sweep", "*/5 * * * *")
  async refundsSweep() {
    const stale = await this.txs.runAsSystem((db) => failStaleClaims(db, this.ledger));
    if (stale) this.log.error(`refund_outcome_unknown ${stale} refund(s) moved to execution_failed`);
    const rs = await this.txs.runAsSystem((db) => where<R>(db, "refund", { status: ["executing"] }));
    for (const r of rs)
      if (!r.disburseClaimedAt)
        await this.disburse({ no: r.no }).catch((e: unknown) => this.log.error(`refund_disburse_failed ${r.no}: ${String(e)}`));
  }

  /** Last finance signature on a client bank transfer → PaymentsService settles (journal, case, receipt) or fails it. */
  @Job("finance.bank_transfer.decide")
  async bankTransferDecide(d: { paymentId: string; approve: boolean; actorId: string; makerId?: string }) {
    await this.payments.decideBankTransfer(d.paymentId, d.approve, d.actorId, d.makerId);
  }

  @Cron("finance.payments.sweep", "*/5 * * * *")
  async paymentsSweep() {
    const [expired, returned] = await this.txs.runAsSystem(async (db) => [await expirePending(db), await returnStaleVerifications(db)]);
    if (expired || returned) this.log.log(`payments sweep: ${expired} expired, ${returned} returned`);
  }

  /** 00:05 Africa/Kigali (UTC+2). */
  @Cron("finance.settings.apply", "5 22 * * *")
  applySettings() {
    return this.txs.runAsSystem((db) => applyDueSettings(db));
  }

  /** Booking refund/credit decided by the booking policy → finance refund record (idempotent on the RFD ref). */
  @Job("booking.refund_requested")
  bookingRefund(d: BookingRefund) {
    return this.txs.runAsSystem(async (db) => {
      const r = await bookingRefund(db, d);
      if (!r) return;
      await postBookingRefund(this.ledger, db, r.no, { amount: r.approved ?? r.requested, asCredit: r.status === "completed_as_credit" });
      if (r.status === "executing") await this.outbox.add(db, { type: "finance.refund.disburse", payload: { no: r.no } });
      await this.audit.record(db, { action: "financial.refund.booked", entity: "refund", entityId: r.no, after: { status: r.status, amount: r.requested, booking: d.reference } });
    });
  }
}
