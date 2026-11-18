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

  // shortcut: reference had no scheduled reports; fixed weekly fin.revenue CSV to finance users until report subscriptions exist.
  @Cron("reports.scheduled", "0 6 * * 1")
  scheduled() {
    return this.svc.scheduledExports();
  }
}
