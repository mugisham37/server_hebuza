import { Injectable } from "@nestjs/common";
import { Cron, Job } from "../../core/queue/queues";
import { ReportsService } from "./reports.service";
import { addDays, today } from "./reports.store";

@Injectable()
export class ReportsJobs {
  constructor(private readonly svc: ReportsService) {}

  /** Outbox event `reports.export` {id}, queued on `bulk`. */
  @Job("reports.export")
  export(d: { id: string }) {
    return this.svc.runExport(d.id);
  }

  /** F-RPT-07: nightly daily-facts rollup (yesterday, plus a 7-day catch-up for late postings). */
  @Cron("reports.rollup.nightly", "15 1 * * *")
  nightlyRollup() {
    const t = today();
    return this.svc.rollup(addDays(t, -7), addDays(t, -1));
  }

  /** Outbox event `reports.rollup` {from, to}: on-demand backfill. */
  @Job("reports.rollup")
  rollup(d: { from: string; to: string }) {
    return this.svc.rollup(d.from, d.to);
  }

  /** F-RPT-05: per-user report subscriptions (weekly Mondays / monthly on the 1st), emailed when ready. */
  @Cron("reports.subscriptions", "0 4 * * *")
  subscriptions() {
    return this.svc.runSubscriptions();
  }
}
