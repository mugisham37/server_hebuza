// Runs a reference work handler in the request tx (OpsRunner) with the services its plain functions need (Kit).
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, sql } from "drizzle-orm";
import type IORedis from "ioredis";
import { users } from "@/db/schema";
import type { Env } from "../../core/config/env";
import { CryptoService } from "../../core/crypto/crypto.service";
import { OutboxService } from "../../core/db/outbox";
import { REDIS } from "../../core/queue/queue.module";
import { StorageService } from "../../core/storage/storage.service";
import { FINALIZE_DELAY_MS } from "../documents/documents.service";
import { OpsRunner, type OpsReq } from "../ops/ops.runner";
import { WorkforceService } from "../workforce/workforce.service";
import type { Provision } from "./work.join";
import type { Kit, WCtx } from "./work.store";

@Injectable()
export class WorkRunner {
  readonly k: Kit;
  constructor(
    private readonly o: OpsRunner,
    private readonly workforce: WorkforceService,
    crypto: CryptoService,
    storage: StorageService,
    outbox: OutboxService,
    cfg: ConfigService<Env, true>,
    @Inject(REDIS) redis: IORedis,
  ) {
    this.k = {
      crypto,
      storage,
      redis,
      prod: cfg.get("NODE_ENV", { infer: true }) === "production",
      origin: cfg
        .get("WEB_ORIGIN", { infer: true })
        .split(",")[0]
        .trim()
        .replace(/\/$/, ""),
      mail: (db, m) =>
        outbox.add(db, {
          type: "auth.mail",
          queue: "critical",
          payload: crypto.seal(m, ["text"]),
        }),
      scan: (db, key) => outbox.add(db, { type: "storage.scan", payload: { key }, runAt: new Date(Date.now() + FINALIZE_DELAY_MS) }),
    };
  }

  run<T>(r: OpsReq, fn: (c: WCtx) => Promise<T>) {
    return this.o.run(r, (c) => fn({ ...c, k: this.k }));
  }

  /** /join approval: reuse an ext:agent account a failed earlier approval already created, else WorkforceService.create. */
  readonly provision: Provision = async (db, s, b) => {
    const email = b.email.trim().toLowerCase();
    const [u] = await db
      .select({ id: users.userId })
      .from(users)
      .where(
        and(sql`lower(${users.email}) = ${email}`, eq(users.role, "ext:agent")),
      );
    // shortcut: create runs in its own tx (WorkforceService has no tx-taking variant); upgrade when it exposes one.
    return (
      u?.id ??
      (await this.workforce.create(s, { ...b, type: "external", field: false }))
        .id
    );
  };
}
