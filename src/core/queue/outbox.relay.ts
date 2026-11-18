// Worker-only: moves committed outbox rows into BullMQ (+ optional realtime fan-out).
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type IORedis from "ioredis";
import { and, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { idempotencyKeys, outbox } from "@/db/schema";
import { DB, type Db } from "../db/db";
import { REDIS } from "./queue.module";
import { Cron, QUEUES, QueueService, type QueueName } from "./queues";

type Realtime = { userId?: string; roomId?: string };

/** Replayable per-user event: append to the `rtlog:<uid>` stream (500 entries / 24 h, read by Last-Event-ID replay), then PUBLISH `rt:<uid>`. */
export async function emitRealtime(redis: IORedis, userId: string, type: string, payload: unknown) {
  const key = `rtlog:${userId}`; // not under rt:* so it never collides with channel names
  const id = await redis.xadd(key, "MAXLEN", "~", "500", "*", "m", JSON.stringify({ type, at: new Date().toISOString(), payload }));
  await redis.expire(key, 86_400);
  await redis.publish(`rt:${userId}`, JSON.stringify({ id, type, payload }));
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("outbox");
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queues: QueueService,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  onApplicationBootstrap() {
    const tick = () => {
      this.running = this.drain()
        .catch((e: unknown) => this.log.error(e))
        .finally(() => { if (!this.stopped) this.timer = setTimeout(tick, 1_000); });
    };
    tick();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  @Cron("outbox.purge", "15 3 * * *")
  async purge() {
    await this.db.delete(outbox).where(and(isNotNull(outbox.sentAt), lt(outbox.sentAt, sql`now() - interval '7 days'`)));
    await this.db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, sql`now() - interval '24 hours'`));
  }

  private async drain() {
    const pubs: { rt: Realtime; type: string; payload: unknown }[] = [];
    await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(outbox)
        .where(and(isNull(outbox.sentAt), lte(outbox.runAt, new Date())))
        .orderBy(outbox.id).limit(100).for("update", { skipLocked: true });
      for (const r of rows) {
        const queue: QueueName = QUEUES.includes(r.queue as QueueName) ? (r.queue as QueueName) : "default";
        await this.queues.add(queue, r.type, r.payload, { jobId: `ob_${r.id}` }); // jobId dedups re-relay after a crash
        const rt = (r.payload as { realtime?: Realtime } | null)?.realtime;
        if (rt) pubs.push({ rt, type: r.type, payload: r.payload });
      }
      if (rows.length) await tx.update(outbox).set({ sentAt: new Date() }).where(inArray(outbox.id, rows.map((r) => r.id)));
    });
    // After commit: a rolled-back batch must not have announced anything.
    for (const { rt, type, payload } of pubs) {
      if (rt.userId) await emitRealtime(this.redis, rt.userId, type, payload);
      if (rt.roomId) await this.redis.publish(`rt:room:${rt.roomId}`, JSON.stringify({ type, payload }));
    }
  }
}
