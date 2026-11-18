import { scaled } from "./rate";
import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import type { Env } from "../config/env";

const isRead = (ctx: ExecutionContext) => ["GET", "HEAD"].includes(ctx.switchToHttp().getRequest<{ method: string }>().method);

/** `default` 600/min on every route (override with @Limit / @Throttle); `write` adds 60/min on non-GET/HEAD. */
export const ThrottleModule = ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => ({
    throttlers: [
      { name: "default", ttl: 60_000, limit: scaled(600) },
      { name: "write", ttl: 60_000, limit: scaled(60), skipIf: isRead },
    ],
    storage: new ThrottlerStorageRedisService(config.get("REDIS_URL", { infer: true })),
  }),
});
