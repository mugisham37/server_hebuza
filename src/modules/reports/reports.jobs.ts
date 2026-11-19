import { Injectable } from "@nestjs/common";
import { Cron, Job } from "../../core/queue/queues";
import { ReportsService } from "./reports.service";

@Injectable()
export class ReportsJobs {
  constructor(private readonly svc: ReportsService) {}

  /** Outbox event `reports.export` {id}, queued on `bulk`. */
  @Job("reports.export")
  export(d: { id: string }) {
    return this.svc.runExport(d.id);
  }

  /** F-RPT-05: per-user report subscriptions (weekly Mondays / monthly on the 1st), emailed when ready. */
  @Cron("reports.subscriptions", "0 4 * * *")
  subscriptions() {
    return this.svc.runSubscriptions();
  }
}
