// Port of .ref realtime.service (tickets + SSE). Events: relay publishes `rt:<userId>` = {type, payload};
// emit() and the relay (payload.realtime.userId) both log them to a per-user Redis stream (24 h / 500 entries) so Last-Event-ID can replay.
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type IORedis from "ioredis";
import { users } from "@/db/schema";
import { DB, type Db } from "../../core/db/db";
import { AppError } from "../../core/http/errors";
import { REDIS } from "../../core/queue/queue.module";
import { emitRealtime } from "../../core/queue/outbox.relay";

export const TICKET_TTL_S = 60;
export const FOCUS_TTL_S = 120;
const ticketKey = (t: string) => `rt:ticket:${t}`;
const logKey = (u: string) => `rtlog:${u}`; // written by emitRealtime (core/queue/outbox.relay)
type Listener = (frame: string) => void;
type Msg = { id?: string; type: string; payload?: unknown };

/** SSE frame in the shape the web client expects: data: {"type","at",...payload}. */
export const frame = (m: Msg, at = new Date().toISOString()) => {
  const p: Record<string, unknown> = m.payload && typeof m.payload === "object" ? { ...(m.payload as Record<string, unknown>) } : { data: m.payload };
  delete p.realtime;
  return `${m.id ? `id: ${m.id}\n` : ""}data: ${JSON.stringify({ type: m.type, at, ...p })}\n\n`;
};

@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly log = new Logger("realtime");
  private sub?: IORedis;
  private readonly local = new Map<string, Set<Listener>>();

  constructor(@Inject(REDIS) private readonly redis: IORedis, @Inject(DB) private readonly db: Db) {}

  unavailable() {
    return new AppError(503, "unavailable", "Live updates are unavailable right now.");
  }

  async issueTicket(userId: string) {
    const ticket = randomBytes(32).toString("base64url");
    try {
      await this.redis.set(ticketKey(ticket), userId, "EX", TICKET_TTL_S);
    } catch {
      throw this.unavailable(); // client falls back to polling
    }
    return { ticket, expires_in: TICKET_TTL_S };
  }

  async consumeTicket(ticket: string) {
    return ticket ? this.redis.getdel(ticketKey(ticket)) : null;
  }

  isActive(userId: string) {
    return this.db.select({ a: users.isActive }).from(users).where(eq(users.userId, userId)).then((r) => !!r[0]?.a);
  }

  /** What the user is looking at (e.g. an open conversation) so publishers can skip redundant notifications. */
  async setFocus(userId: string, focus: string | null) {
    if (focus) await this.redis.set(`rt:focus:${userId}`, focus, "EX", FOCUS_TTL_S);
    else await this.redis.del(`rt:focus:${userId}`);
  }
  focusOf(userId: string) {
    return this.redis.get(`rt:focus:${userId}`);
  }

  /** Worker or API: replayable event to one user. */
  async emit(userId: string, type: string, payload: unknown) {
    await emitRealtime(this.redis, userId, type, payload);
  }

  /** Frames after lastId (exclusive), from the 24 h log. */
  async replay(userId: string, lastId: string): Promise<string[]> {
    if (!/^\d+-\d+$/.test(lastId)) return [];
    const rows = await this.redis.xrange(logKey(userId), `(${lastId}`, "+", "COUNT", 500);
    return rows.map(([id, f]) => {
      const m = JSON.parse(f[1]) as { type: string; at: string; payload: unknown };
      return frame({ id, type: m.type, payload: m.payload }, m.at);
    });
  }

  /** One pattern subscriber per process (lazy: the worker never opens it), fanned out to local streams. */
  listen(userId: string, fn: Listener) {
    if (!this.sub) {
      this.sub = this.redis.duplicate();
      void this.sub.psubscribe("rt:*").catch((e: unknown) => this.log.error(e));
      this.sub.on("pmessage", (_p, ch, raw) => {
        const set = this.local.get(ch.slice(3)); // rt:room:* has no local key -> dropped (rooms not routed yet)
        if (!set) return;
        try {
          const f = frame(JSON.parse(raw) as Msg);
          for (const l of set) l(f);
        } catch (e) {
          this.log.warn({ event: "realtime.bad_message", err: String(e) });
        }
      });
    }
    const set = this.local.get(userId) ?? new Set<Listener>();
    set.add(fn);
    this.local.set(userId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.local.delete(userId);
    };
  }

  async onModuleDestroy() {
    await this.sub?.quit();
  }
}
