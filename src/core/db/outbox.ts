import { Injectable } from "@nestjs/common";
import { outbox } from "@/db/schema";
import type { Tx } from "./db";

export type OutboxEvent = { type: string; payload: unknown; queue?: "critical" | "default" | "bulk"; runAt?: Date };

@Injectable()
export class OutboxService {
  /** Enqueue inside the business tx so the job exists iff the tx commits. */
  async add(tx: Tx, e: OutboxEvent) {
    await tx.insert(outbox).values({ type: e.type, payload: e.payload ?? null, queue: e.queue ?? "default", runAt: e.runAt });
  }
}
