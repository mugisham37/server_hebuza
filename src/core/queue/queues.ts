import { Injectable, SetMetadata } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { JobsOptions, Queue } from "bullmq";

export const QUEUES = ["critical", "default", "bulk"] as const;
export type QueueName = (typeof QUEUES)[number];

export const JOB_META = "hebuza:job";
export const CRON_META = "hebuza:cron";
/** Handles jobs named `name` (any queue). Discovered only in the worker process. */
export const Job = (name: string) => SetMetadata(JOB_META, name);
/** Repeatable job on the `default` queue; the decorated method is its handler. */
export const Cron = (name: string, pattern: string) => SetMetadata(CRON_META, { name, pattern });

export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { count: 1_000, age: 86_400 },
  removeOnFail: { count: 10_000 }, // failed set is the dead-letter store
};

@Injectable()
export class QueueService {
  private readonly byName: Record<QueueName, Queue>;
  constructor(
    @InjectQueue("critical") critical: Queue,
    @InjectQueue("default") def: Queue,
    @InjectQueue("bulk") bulk: Queue,
  ) {
    this.byName = { critical, default: def, bulk };
  }
  get(queue: QueueName): Queue {
    return this.byName[queue];
  }
  add(queue: QueueName, name: string, data: unknown, opts?: JobsOptions) {
    return this.byName[queue].add(name, data, { ...DEFAULT_JOB_OPTS, ...opts });
  }
}
