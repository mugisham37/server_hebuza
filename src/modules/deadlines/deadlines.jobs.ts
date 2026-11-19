import { Injectable, Logger } from "@nestjs/common";
import { TxService } from "../../core/db/tx";
import { Cron } from "../../core/queue/queues";
import { NotificationsService } from "../notifications/notifications.service";
import { ObligationCases } from "./deadlines.autocase";
import { runDaily } from "./deadlines.service";

@Injectable()
export class DeadlinesJobs {
  private readonly log = new Logger("deadlines");
  constructor(private readonly tx: TxService, private readonly notifications: NotificationsService, private readonly autocase: ObligationCases) {}

  /** 07:00 Kigali = 05:00 UTC. One transaction so a crash never leaves claimed-but-unsent reminders. */
  @Cron("deadlines.daily", "0 5 * * *")
  async daily() {
    const r = await this.tx.runAsSystem((t) => runDaily(t, (tx, n) => this.notifications.notify(tx, n)));
    const casesCreated = await this.autocase.run(); // F-CAL-07, after generation so new obligations are covered
    this.log.log({ event: "deadlines.daily", ...r, casesCreated });
    return { ...r, casesCreated };
  }
}
