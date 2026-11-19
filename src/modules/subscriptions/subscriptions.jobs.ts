// Worker side of subscriptions: client trial on signup (outbox event from auth) and the hourly lifecycle sweep
// (past_due grace, cancel at period end, expiry, renewal/dunning reminders, 80 % usage warning).
import { Injectable, Logger } from "@nestjs/common";
import { TxService } from "../../core/db/tx";
import { OutboxService } from "../../core/db/outbox";
import { Cron, Job } from "../../core/queue/queues";
import { startTrialForClient, sweep } from "./subscriptions.service";

@Injectable()
export class SubscriptionsJobs {
  private readonly log = new Logger("subscriptions");
  constructor(
    private readonly tx: TxService,
    private readonly outbox: OutboxService,
  ) {}

  /** Idempotent: the insert is on-conflict-do-nothing per client. */
  @Job("auth.user.signed_up")
  async signedUp(d: { userId: string; role: string }) {
    if (d.role === "client") await this.tx.runAsSystem((tx) => startTrialForClient(tx, d.userId));
  }

  /** Reminders are recorded per period+offset, so an hourly run sends each once. */
  /** Hourly: lapse transitions, renewal/dunning reminders (T-7..T+7), 80 % usage warning; idempotent per period. */
  @Cron("subscriptions.sweep", "15 * * * *")
  async sweep() {
    const r = await this.tx.runAsSystem((tx) =>
      sweep(tx, (db, n) => this.outbox.add(db, { type: "notifications.deliver", payload: n })),
    );
    this.log.log(`subscriptions.sweep ${JSON.stringify(r)}`);
    return r;
  }
}
