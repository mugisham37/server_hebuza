// Worker liveness: `worker:heartbeat` in Redis (10 s refresh, 30 s TTL), read by the API's WorkerMonitor.
import { hostname } from "node:os";
import { Inject, Injectable, OnModuleInit, OnApplicationShutdown } from "@nestjs/common";
import type IORedis from "ioredis";
import pkg from "../../../package.json";
import { REDIS } from "./queue.module";
import { QUEUES } from "./queues";

export const HEARTBEAT_KEY = "worker:heartbeat";
export const VERSION = process.env.GIT_SHA ? `${pkg.version}+${process.env.GIT_SHA}` : pkg.version;
export type Heartbeat = { version: string; host: string; pid: number; queues: string[]; startedAt: string; at: string };

@Injectable()
export class WorkerHeartbeat implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private readonly startedAt = new Date().toISOString();
  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  // onModuleInit (not bootstrap) so the first beat lands before an inline API's WorkerMonitor first poll.
  async onModuleInit() {
    const beat = () => {
      const hb: Heartbeat = { version: VERSION, host: hostname(), pid: process.pid, queues: [...QUEUES], startedAt: this.startedAt, at: new Date().toISOString() };
      return this.redis.set(HEARTBEAT_KEY, JSON.stringify(hb), "EX", 30).catch(() => null);
    };
    await beat();
    this.timer = setInterval(() => void beat(), 10_000);
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.redis.del(HEARTBEAT_KEY).catch(() => null);
  }
}
