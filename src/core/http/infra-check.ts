// One-time boot check of infrastructure settings the app relies on; logs WARN (never fails boot) so ops see it in Railway logs.
import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type IORedis from "ioredis";
import { DB, type Db } from "../db/db";
import { REDIS } from "../queue/queue.module";

@Injectable()
export class InfraCheck implements OnApplicationBootstrap {
  private readonly log = new Logger("infra");
  constructor(@Inject(DB) private readonly db: Db, @Inject(REDIS) private readonly redis: IORedis) {}

  async onApplicationBootstrap() {
    // BullMQ loses jobs if Redis evicts keys under memory pressure.
    const policy = await this.redis.config("GET", "maxmemory-policy").then((r) => String((r as string[])[1]), () => "unknown (CONFIG disabled)");
    (policy === "noeviction" ? this.log.log.bind(this.log) : this.log.warn.bind(this.log))(`redis maxmemory-policy=${policy}${policy === "noeviction" ? "" : ", queued jobs can be evicted; set noeviction"}`);
    const [ext] = (await this.db.execute(sql`select extversion from pg_extension where extname = 'vector'`).catch(() => [])) as unknown as { extversion?: string }[];
    (ext?.extversion ? this.log.log.bind(this.log) : this.log.warn.bind(this.log))(
      ext?.extversion ? `pgvector ${ext.extversion} installed (assistant vector search on)` : "pgvector not installed, assistant uses full-text search only",
    );
  }
}
