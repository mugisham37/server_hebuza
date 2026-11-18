// Worker-only: discovers @Job/@Cron handlers and runs one BullMQ Worker per queue.
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { Worker, type Job as BullJob } from "bullmq";
import { ClsService } from "nestjs-cls";
import type { RequestStore } from "../http/context";
import { CRON_META, JOB_META, QUEUES, QueueService } from "./queues";

type Handler = (data: unknown, job: BullJob) => Promise<unknown>;

@Injectable()
export class JobExplorer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("queue");
  private readonly workers: Worker[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly queues: QueueService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  async onApplicationBootstrap() {
    const handlers = new Map<string, Handler>();
    const owners = new Map<string, unknown>(); // inline mode: a jobs class provided by both the HTTP and the worker module is one handler
    const crons: { name: string; pattern: string }[] = [];
    for (const w of this.discovery.getProviders()) {
      const inst: unknown = w.instance;
      if (!inst || typeof inst !== "object") continue;
      const proto = Object.getPrototypeOf(inst) as Record<string, unknown>;
      for (const m of this.scanner.getAllMethodNames(proto)) {
        const fn = proto[m];
        if (typeof fn !== "function") continue;
        const job = this.reflector.get<string | undefined>(JOB_META, fn);
        const cron = this.reflector.get<{ name: string; pattern: string } | undefined>(CRON_META, fn);
        const name = job ?? cron?.name;
        if (!name) continue;
        if (owners.get(name) === proto) continue;
        if (handlers.has(name)) throw new Error(`duplicate job handler: ${name}`);
        owners.set(name, proto);
        handlers.set(name, (fn as Handler).bind(inst));
        if (cron) crons.push(cron);
      }
    }

    const conn = this.queues.get("default").opts.connection;
    const prefix = this.queues.get("default").opts.prefix;
    for (const q of QUEUES) {
      const worker = new Worker(
        q,
        async (job) => {
          const h = handlers.get(job.name);
          if (!h) throw new Error(`no handler for job ${job.name}`);
          return this.cls.run(() => {
            this.cls.set("user", null);
            this.cls.set("requestId", String(job.id));
            return h(job.data, job);
          });
        },
        { connection: conn, prefix, concurrency: q === "bulk" ? 2 : 10 },
      );
      worker.on("failed", (job, err) => {
        if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
          this.log.error({ event: "queue.dlq", queue: q, job: job.name, id: job.id, err: err.message });
      });
      worker.on("error", (err) => this.log.error(err));
      this.workers.push(worker);
    }

    for (const c of crons)
      await this.queues.get("default").upsertJobScheduler(c.name, { pattern: c.pattern }, { name: c.name });
    this.log.log(`workers up: ${handlers.size} handlers, ${crons.length} crons`);
  }

  async onApplicationShutdown() {
    await Promise.all(this.workers.map((w) => w.close())); // waits for active jobs to finish
  }
}
