import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import IORedis from "ioredis";
import { QUEUES, QueueService } from "./queues";

export const REDIS = Symbol("REDIS");

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        connection: new IORedis(c.getOrThrow<string>("REDIS_URL"), { maxRetriesPerRequest: null }),
        prefix: "hebuza",
      }),
    }),
    BullModule.registerQueue(...QUEUES.map((name) => ({ name }))),
  ],
  providers: [
    QueueService,
    // Reuses BullMQ's shared IORedis instance (Queues share a passed-in instance; Workers duplicate it for blocking calls).
    // A future SUBSCRIBE needs its own connection (subscriber mode blocks other commands).
    { provide: REDIS, inject: [QueueService], useFactory: (q: QueueService) => q.get("default").client },
  ],
  exports: [QueueService, REDIS],
})
export class QueueModule {}
