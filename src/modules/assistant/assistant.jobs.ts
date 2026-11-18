// Assistant worker: KB reindex job (outbox `assistant.reindex {jobId}`), nightly retention purge + draft expiry, daily
// stale-source sweep, weekly eval run (fast model) and a nightly full reindex so CMS/catalogue changes reach retrieval.
import { Injectable, Logger } from "@nestjs/common";
import { Cron, Job } from "../../core/queue/queues";
import { AssistantService } from "./assistant.service";

@Injectable()
export class AssistantJobs {
  private readonly log = new Logger("assistant");
  constructor(private readonly svc: AssistantService) {}

  @Job("assistant.reindex")
  reindex(d: { jobId: string }) {
    return this.svc.runReindex(d.jobId);
  }
  @Cron("assistant.reindex-nightly", "15 2 * * *")
  reindexNightly() {
    return this.svc.reindexAll();
  }
  @Cron("assistant.retention", "30 2 * * *")
  async retention() {
    this.log.log({ event: "assistant.retention", ...(await this.svc.purge()) });
  }
  @Cron("assistant.stale", "0 6 * * *")
  async stale() {
    const count = await this.svc.stale();
    if (count) this.log.log({ event: "kb.sources_stale", count });
  }
  @Cron("assistant.evals.weekly", "0 5 * * 1")
  async evals() {
    this.log.log({ event: "assistant.evals", ...(await this.svc.runEvals("Weekly")) });
  }
}
