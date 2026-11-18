import { Inject, Injectable } from "@nestjs/common";
import { ClsService } from "nestjs-cls";
import { sql } from "drizzle-orm";
import type { RequestStore } from "../http/context";
import { DB, type Db, type Tx } from "./db";

const RETRYABLE = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected
export type TxOpts = { isolation?: "serializable" };
const pgCode = (e: unknown): unknown => (e instanceof Error ? ((e as { code?: unknown }).code ?? pgCode(e.cause)) : undefined);

@Injectable()
export class TxService {
  constructor(@Inject(DB) private readonly db: Db, private readonly ctx: ClsService<RequestStore>) {}

  /** Runs fn in a transaction with RLS GUCs set from the request user. */
  run<T>(fn: (tx: Tx) => Promise<T>, opts: TxOpts = {}): Promise<T> {
    const user = this.ctx.isActive() ? this.ctx.get("user") : null;
    return this.exec(fn, user?.id ?? "", user?.roles.join(",") ?? "", opts);
  }

  /** Worker/cron only: role `system` bypasses ownership RLS. Throws inside an HTTP request. */
  runAsSystem<T>(fn: (tx: Tx) => Promise<T>, opts: TxOpts = {}): Promise<T> {
    if (this.ctx.isActive() && this.ctx.get("http")) throw new Error("runAsSystem() is not allowed in an HTTP request");
    return this.exec(fn, "", "system", opts);
  }

  /**
   * Money txs need role `system` (payments RLS) from HTTP too; authorisation is enforced in code before the call.
   * Only for SERIALIZABLE money writes — never as a way around ownership RLS for reads.
   */
  runMoney<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.exec(fn, "", "system", { isolation: "serializable" });
  }

  private async exec<T>(fn: (tx: Tx) => Promise<T>, userId: string, roles: string, opts: TxOpts): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.user_id', ${userId}, true), set_config('app.roles', ${roles}, true)`);
          return fn(tx);
        }, opts.isolation ? { isolationLevel: opts.isolation } : undefined);
      } catch (e) {
        if (attempt >= 3 || !RETRYABLE.has(String(pgCode(e)))) throw e;
      }
    }
  }
}
