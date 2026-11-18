// Worker side of subscriptions: client trial on signup (outbox event from auth) and the daily expiry sweep.
import { Injectable, Logger } from "@nestjs/common";
import { TxService } from "../../core/db/tx";
import { Cron, Job } from "../../core/queue/queues";
import { expireOverdue, startTrialForClient } from "./subscriptions.service";

@Injectable()
export class SubscriptionsJobs {
  private readonly log = new Logger("subscriptions");
  constructor(private readonly tx: TxService) {}

  /** Idempotent: the insert is on-conflict-do-nothing per client. */
  @Job("auth.user.signed_up")
  async signedUp(d: { userId: string; role: string }) {
    if (d.role === "client") await this.tx.runAsSystem((tx) => startTrialForClient(tx, d.userId));
  }

  @Cron("subscriptions.expire", "30 0 * * *")
  async expire() {
    const n = await this.tx.runAsSystem((tx) => expireOverdue(tx));
    this.log.log(`subscriptions.expire ${n}`);
    return n;
  }
}
