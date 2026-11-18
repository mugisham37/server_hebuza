// API side of the worker heartbeat: logs transitions (WARN down / INFO up), version skew, and feeds /health/ready + /api/status.
import { Global, Inject, Injectable, Module, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { count, isNull } from "drizzle-orm";
import { outbox } from "@/db/schema";
import type IORedis from "ioredis";
import { DB, type Db } from "../db/db";
import { REDIS } from "./queue.module";
import { QUEUES, QueueService } from "./queues";
import { HEARTBEAT_KEY, VERSION, type Heartbeat } from "./worker-heartbeat";

export type WorkerState = { status: "up" | "down" | "off"; lastSeen: string | null; backlog: number | null };
const REPEAT_MS = 5 * 60_000;

@Injectable()
export class WorkerMonitor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("worker-monitor");
  private timer?: NodeJS.Timeout;
  private state: WorkerState = { status: "off", lastSeen: null, backlog: null };
  private warnedAt = 0;
  private skewed?: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly queues: QueueService,
    private readonly config: ConfigService,
  ) {}

  snapshot(): WorkerState { return this.state; }

  async onApplicationBootstrap() {
    if (this.config.get("WORKER_MODE") === "off") return;
    await this.poll(true);
    this.timer = setInterval(() => void this.poll(false), 15_000);
  }

  onApplicationShutdown() { clearInterval(this.timer); }

  private async poll(boot: boolean) {
    try {
      const raw = await this.redis.get(HEARTBEAT_KEY);
      const hb = raw ? (JSON.parse(raw) as Heartbeat) : null;
      const prev = this.state.status;
      if (hb) {
        this.state = { status: "up", lastSeen: hb.at, backlog: null };
        if (boot) this.log.log(`worker present: ${hb.host} pid ${hb.pid} v${hb.version}`);
        else if (prev === "down") this.log.log(`worker online: ${hb.host} pid ${hb.pid} v${hb.version}`);
        if (hb.version !== VERSION && this.skewed !== hb.version) this.log.warn(`worker version ${hb.version} != api ${VERSION} (half-finished deploy?)`);
        this.skewed = hb.version !== VERSION ? hb.version : undefined;
        return;
      }
      const [{ n }] = await this.db.select({ n: count() }).from(outbox).where(isNull(outbox.sentAt));
      const waiting = await Promise.all(QUEUES.map(async (q) => [q, await this.queues.get(q).getWaitingCount()] as const));
      this.state = { status: "down", lastSeen: this.state.lastSeen, backlog: n };
      if (boot) this.log.log("no worker detected at boot (WORKER_MODE=separate: run `node dist/worker.js`)");
      if (prev !== "down" || Date.now() - this.warnedAt >= REPEAT_MS) {
        this.warnedAt = Date.now();
        this.log.warn(`worker offline: emails, notifications, scans, schedules are paused (outbox ${n} unsent; waiting ${waiting.map(([q, c]) => `${q}=${c}`).join(" ")})`);
      }
    } catch (e) {
      this.log.error({ msg: "worker monitor poll failed", err: (e as Error).message });
    }
  }
}

@Global()
@Module({ providers: [WorkerMonitor], exports: [WorkerMonitor] })
export class WorkerMonitorModule {}

