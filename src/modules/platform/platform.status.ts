// Public status page probe: live component health, cached 15 s in Redis so the page cannot hammer the backends.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";
import type IORedis from "ioredis";
import type { z } from "zod";
import { DB, type Db } from "../../core/db/db";
import { REDIS } from "../../core/queue/queue.module";
import { QUEUES, QueueService } from "../../core/queue/queues";
import { WorkerMonitor } from "../../core/queue/worker-monitor";
import { StorageService } from "../../core/storage/storage.service";
import type { StatusOut } from "./platform.dto";

type Status = z.infer<typeof StatusOut>;
type C = Status["components"][number];
const KEY = "cache:status";
const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))]);

@Injectable()
export class StatusService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly queues: QueueService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly worker: WorkerMonitor,
  ) {}

  async get(): Promise<Status> {
    const hit = await this.redis.get(KEY).catch(() => null);
    if (hit) return JSON.parse(hit) as Status;
    const v = await this.probe();
    await this.redis.set(KEY, JSON.stringify(v), "EX", 15).catch(() => null);
    return v;
  }

  private async probe(): Promise<Status> {
    // shortcut: no uptime history store yet, so uptime is null and days is empty; add a daily rollup table to fill them.
    const c = async (key: string, name: string, fn: () => Promise<{ state?: C["state"]; detail: string }>): Promise<C> => {
      try { const r = await within(fn()); return { key, name, state: r.state ?? "operational", detail: r.detail, uptime: null, days: [] }; }
      catch { return { key, name, state: "outage", detail: "Unreachable", uptime: null, days: [] }; }
    };
    const has = (...k: string[]) => k.every((x) => !!this.config.get(x));
    const components = await Promise.all([
      c("api", "API", async () => ({ detail: "Serving" })),
      c("database", "Database", async () => { await this.db.execute(sql`select 1`); return { detail: "Reachable" }; }),
      c("redis", "Redis", async () => { await this.redis.ping(); return { detail: "Reachable" }; }),
      c("queues", "Queues", async () => {
        const n = await Promise.all(QUEUES.map((q) => this.queues.get(q).getJobCounts("failed", "waiting", "delayed")));
        const backlog = n.reduce((s, x) => s + (x.waiting ?? 0) + (x.delayed ?? 0), 0), failed = n.reduce((s, x) => s + (x.failed ?? 0), 0);
        return { state: failed > 20 || backlog > 500 ? "degraded" : "operational", detail: `Backlog ${backlog} · ${failed} failed` };
      }),
      (async (): Promise<C> => {
        const w = this.worker.snapshot();
        const down = w.status === "down";
        return { key: "worker", name: "Background processing", state: down ? "degraded" : "operational", uptime: null, days: [], since: down ? w.lastSeen : null,
          detail: down ? `Background processing delayed${w.backlog ? ` (${w.backlog} waiting)` : ""}` : w.status === "off" ? "Not monitored" : "Running" };
      })(),
      c("storage", "Storage", async () => { await this.storage.head("healthcheck"); return { detail: "Reachable" }; }),
      c("payments", "Payments", async () => {
        const gw = [has("MTN_MOMO_SUBSCRIPTION_KEY", "MTN_MOMO_API_USER", "MTN_MOMO_API_KEY") && "MTN MoMo", has("AIRTEL_CLIENT_ID", "AIRTEL_CLIENT_SECRET") && "Airtel Money"].filter(Boolean);
        return { state: gw.length ? "operational" : "degraded", detail: gw.length ? `Configured: ${gw.join(", ")}` : "No gateway configured" };
      }),
    ]);
    // shortcut: incidents are not published from the ops incident records yet; wire them when ops exposes public incidents.
    return { updatedAt: new Date().toISOString(), components, incidents: [] };
  }
}
