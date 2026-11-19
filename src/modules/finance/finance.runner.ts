// Runs one reference finance handler: opens the Fin context (actor, effective settings, party directory) in the request
// tx and writes the handler's buffered audit entries as the last statements of that same tx. Money writes run
// SERIALIZABLE (retried on 40001/40P01); reads run in a plain TxService tx.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { ClsService } from "nestjs-cls";
import type { FastifyReply } from "fastify";
import { map, type Observable } from "rxjs";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { CryptoService } from "../../core/crypto/crypto.service";
import { StorageService } from "../../core/storage/storage.service";
import { AppError } from "../../core/http/errors";
import type { RequestStore } from "../../core/http/context";
import { LedgerService } from "../ledger/ledger.service";
import {
  Accepted,
  DAY,
  open,
  rid,
  type Fin,
  type FinDeps,
} from "./finance.store";

/** Side-effect ports for finance handlers (request runner and worker jobs share them). */
export const finDeps = (outbox: OutboxService, crypto: CryptoService, storage: StorageService, ledger: LedgerService): FinDeps => ({
  ledger,
  encrypt: (s) => crypto.encrypt(s),
  decrypt: (s) => crypto.decrypt(s),
  mail: (db, m, runAt) => outbox.add(db, { type: "auth.mail", queue: "critical", payload: crypto.seal(m, ["text"]), runAt }),
  outbox: (db, type, payload, runAt) => outbox.add(db, { type, payload, runAt }),
  publishFile: async (name, content, type) => {
    const key = `exports/${rid("f")}/${name}`;
    await storage.putObject(key, `\uFEFF${content}`, `${type}; charset=utf-8`);
    return { url: await storage.presignGet(key, name), expiresAt: new Date(Date.now() + DAY).toISOString(), key, name };
  },
});

@Injectable()
export class FinRunner {
  readonly deps: FinDeps;
  constructor(
    private readonly txs: TxService,
    private readonly cls: ClsService<RequestStore>,
    private readonly audit: AuditService,
    outbox: OutboxService,
    crypto: CryptoService,
    storage: StorageService,
    ledger: LedgerService,
  ) {
    this.deps = finDeps(outbox, crypto, storage, ledger);
  }

  private user() {
    const u = this.cls.get("user");
    if (!u)
      throw new AppError(401, "unauthenticated", "Authentication required.");
    return u;
  }

  private async within<T>(db: Tx, fn: (f: Fin) => Promise<T> | T) {
    const f = await open(db, this.user(), this.deps);
    const out = await fn(f);
    for (const e of f.audits) await this.audit.record(db, e);
    return out;
  }

  /** Read-only handler (audits still recorded in-tx, e.g. a reveal). */
  read<T>(fn: (f: Fin) => Promise<T> | T): Promise<T> {
    return this.txs.run((db) => this.within(db, fn));
  }

  /** Money write: SERIALIZABLE tx with the request's RLS GUCs. */
  write<T>(fn: (f: Fin) => Promise<T> | T): Promise<T> {
    this.user();
    return this.txs.run((db) => this.within(db, fn), { isolation: "serializable" });
  }
}

/** Maps a handler's `accepted(data)` (maker-checker pending) to HTTP 202 with `data` in the envelope. */
@Injectable()
export class AcceptedInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((res: unknown) => {
        if (!(res instanceof Accepted)) return res;
        ctx.switchToHttp().getResponse<FastifyReply>().status(202);
        return res.data;
      }),
    );
  }
}
