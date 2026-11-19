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
import { CryptoService } from "../../core/crypto/crypto.service";
import { StorageService } from "../../core/storage/storage.service";
import type { Tx } from "../../core/db/db";
import { open, where, type Fin } from "./finance.store";
import { finDeps } from "./finance.runner";
import { caseSettled, planSettled, renewalInvoices, scheduledReminders, syncCases } from "./finance.cases";
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
    crypto: CryptoService,
    storage: StorageService,
  ) {
    this.deps = finDeps(outbox, crypto, storage, ledger);
  }
  private readonly deps: ReturnType<typeof finDeps>;

  /** Finance handler as the system actor; its audits land in the same tx. */
  private sys<T>(fn: (f: Fin) => Promise<T>) {
    return this.txs.runAsSystem(async (db: Tx) => {
      const f = await open(db, "system", this.deps);
      const out = await fn(f);
      for (const e of f.audits) await this.audit.record(db, e);
      return out;
    });
  }

  /** Gateway settle → case/plan invoice mirror, client credit, REV-03 allocation. Idempotent per payment id. */
  @Job("finance.payment.settled")
  paymentSettled(d: { applicationCode?: string | null; planId?: string | null; clientId?: string | null; paymentId: string; amount: number }) {
    return this.sys(async (f) => {
      if (d.planId && d.clientId) await planSettled(f, { clientId: d.clientId, paymentId: d.paymentId, amount: d.amount });
      else if (d.applicationCode) await caseSettled(f, { applicationCode: d.applicationCode, paymentId: d.paymentId, amount: d.amount });
    });
  }

  @Cron("finance.cases.sync", "*/10 * * * *")
  async casesSync() {
    const r = await this.sys((f) => syncCases(f));
    if (r.made || r.allocated) this.log.log(`cases sync: ${r.made} invoices, ${r.allocated} allocations`);
  }

  /** 08:00 Africa/Kigali: F-FIN-16 reminders and F-SUB-04 renewal invoices. */
  @Cron("finance.invoices.remind", "0 6 * * *")
  async remindAndRenew() {
    const made = await this.sys((f) => renewalInvoices(f));
    const sent = await this.sys((f) => scheduledReminders(f));
    this.log.log(`renewal invoices ${made}, reminders ${sent}`);
  }

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
