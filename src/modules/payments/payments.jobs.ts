// Worker side of payments: delayed reconcile per prompt, the reconcile sweep (lost callbacks), the daily ledger
// trial-balance check, and the `payment.settled` consumer (booking settle, plan activation).
import { Injectable } from "@nestjs/common";
import { TxService } from "../../core/db/tx";
import { Cron, Job } from "../../core/queue/queues";
import { BookingService } from "../booking/booking.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { PaymentsService, type Settled } from "./payments.service";

@Injectable()
export class PaymentsJobs {
  constructor(
    private readonly svc: PaymentsService,
    private readonly txs: TxService,
    private readonly booking: BookingService,
    private readonly subs: SubscriptionsService,
  ) {}

  /** Two minutes after a prompt goes out. */
  @Job("payments.reconcile")
  reconcile(d: { transactionId: string }) {
    return this.svc.reconcile(d.transactionId).then(() => undefined);
  }

  @Cron("payments.reconcile-sweep", "*/5 * * * *")
  sweep() {
    return this.svc.reconcileSweep();
  }

  @Cron("ledger.trial-balance", "0 3 * * *")
  trialBalance() {
    return this.svc.checkLedger();
  }

  /** Idempotent consumers: booking re-reads its own row; activateFromPayment skips a payment it already applied. */
  @Job("payment.settled")
  async settled(d: Settled) {
    if (d.booking) return void (await this.booking.settle(d.transactionId));
    const { planId, clientId, paidAt, paymentId } = d;
    if (planId && clientId && paidAt && paymentId)
      await this.txs.runAsSystem((tx) =>
        this.subs.activateFromPayment(tx, {
          clientId,
          planId,
          paidAt,
          paymentId,
        }),
      );
  }
}
