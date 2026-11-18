// CMS worker: minute sweep publishes due scheduled variants / marks overdue regulatory updates stale, and the
// `cms.revalidate` job tells the web app which cache tags to drop (POST <first WEB_ORIGIN>/hooks/revalidate, HMAC-signed).
import { createHmac } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { OutboxService } from "../../core/db/outbox";
import { TxService } from "../../core/db/tx";
import { Cron, Job } from "../../core/queue/queues";
import { PublicCache } from "../catalogue/cache";
import { sweepSchedule } from "./cms.service";

@Injectable()
export class CmsJobs {
  private readonly log = new Logger("cms");
  constructor(
    private readonly txs: TxService,
    private readonly outbox: OutboxService,
    private readonly cache: PublicCache,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Cron("cms.sweep-schedule", "* * * * *")
  async sweep() {
    const tags = await this.txs.runAsSystem(async (tx) => {
      const tags = await sweepSchedule(tx);
      if (tags.length) await this.outbox.add(tx, { type: "cms.revalidate", payload: { tags } });
      return tags;
    });
    if (tags.length) await this.cache.bust("cms");
  }

  /** Header `x-revalidate-signature: t=<unix ms>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`; web rejects stale t (replay window). */
  @Job("cms.revalidate")
  async revalidate(d: { tags: string[] }) {
    const secret = this.config.get("REVALIDATE_SECRET", { infer: true });
    if (!secret) return this.log.warn({ event: "cms.revalidate.no_secret", tags: d.tags }); // pages refresh on their cacheLife instead
    const origin = this.config.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim();
    const body = JSON.stringify({ tags: d.tags });
    const t = Date.now();
    const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const r = await fetch(`${origin}/hooks/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-signature": `t=${t},v1=${sig}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`revalidate ${r.status}`); // retried with backoff
  }
}
