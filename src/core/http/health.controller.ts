import { Controller, Get, Inject, Logger } from "@nestjs/common";
import { HealthCheck, HealthCheckService, HealthIndicatorService } from "@nestjs/terminus";
import { sql } from "drizzle-orm";
import type IORedis from "ioredis";
import { DB, type Db } from "../db/db";
import { REDIS } from "../queue/queue.module";
import { WorkerMonitor } from "../queue/worker-monitor";
import { Public } from "../auth/decorators";
import { RawResponse } from "./envelope.interceptor";

@Controller("health")
@Public()
@RawResponse()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly ind: HealthIndicatorService,
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly worker: WorkerMonitor,
  ) {}

  @Get()
  live() { return { status: "ok" }; }

  @Get("ready")
  @HealthCheck()
  async ready() {
    const w = this.worker.snapshot();
    const r = await this.health.check([ // throws 503 when db/redis are down
      () => this.check("db", () => this.db.execute(sql`select 1`)),
      () => this.check("redis", () => this.redis.ping()),
    ]);
    // Worker down keeps 200 so the host doesn't restart a healthy API; it only degrades the status.
    return { ...r, status: w.status === "down" ? "degraded" : r.status, worker: w };
  }

  private async check(key: string, fn: () => Promise<unknown>) {
    const i = this.ind.check(key);
    try { await fn(); return i.up(); } catch (e) { new Logger("health").error({ check: key, err: (e as Error).message }); return i.down(); }
  }
}
