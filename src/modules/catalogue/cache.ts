// Read-through Redis cache for public reads (catalogue, plans, public settings). One hash per namespace so a write
// drops the whole namespace in one DEL; the TTL bounds staleness from writes that bypass bust() (other modules, SQL).
import { Inject, Injectable, Logger } from "@nestjs/common";
import type IORedis from "ioredis";
import { REDIS } from "../../core/queue/queue.module";

export type CacheNs = "catalogue" | "plans" | "platform" | "cms";
const TTL_S = 60;

@Injectable()
export class PublicCache {
  private readonly log = new Logger(PublicCache.name);
  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  async get<T>(ns: CacheNs, field: string, load: () => Promise<T>): Promise<T> {
    const key = `cache:${ns}`;
    const hit = await this.redis.hget(key, field).catch(() => null);
    if (hit) return JSON.parse(hit) as T;
    const v = await load();
    await this.redis.multi().hset(key, field, JSON.stringify(v)).expire(key, TTL_S, "NX").exec().catch(() => null);
    return v;
  }

  /** Call after the write committed. A failed DEL only leaves data stale for ≤ TTL. */
  async bust(ns: CacheNs) {
    await this.redis.del(`cache:${ns}`).catch((e: unknown) => this.log.warn(`cache bust ${ns}: ${String(e)}`));
  }
}
