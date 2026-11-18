// Nest wiring for the system console: collects the injected services the world engine needs (SystemDeps), turns a
// request into a Caller (@Sys()), and maps accepted(...) results to 202 "Pending approval".
import {
  CallHandler,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import { map } from "rxjs";
import { DB, type Db } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { CryptoService } from "../../core/crypto/crypto.service";
import { TokenService } from "../../core/auth/tokens";
import { AuthService } from "../auth/auth.service";
import { PublicCache } from "../catalogue/cache";
import { PasswordService } from "../../core/auth/password";
import { StorageService } from "../../core/storage/storage.service";
import { QueueService } from "../../core/queue/queues";
import { REDIS } from "../../core/queue/queue.module";
import type { Env } from "../../core/config/env";
import type { SessionUser } from "../../core/http/context";
import { Accepted, type Caller, type SystemDeps } from "./system.world";

@Injectable()
export class SystemStore {
  readonly deps: SystemDeps;
  constructor(
    @Inject(DB) db: Db,
    tx: TxService,
    audit: AuditService,
    outbox: OutboxService,
    crypto: CryptoService,
    tokens: TokenService,
    auth: AuthService,
    cache: PublicCache,
    password: PasswordService,
    storage: StorageService,
    queues: QueueService,
    @Inject(REDIS) redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.deps = {
      db,
      tx,
      audit,
      outbox,
      crypto,
      tokens,
      auth,
      cache,
      password,
      storage,
      queues,
      redis,
      config,
    };
  }

  /** Completes a request's @Sys() caller with the injected services. */
  on(raw: RawCaller): Caller {
    return { ...raw, deps: this.deps, db: this.deps.db };
  }
}

type Req = FastifyRequest & { user?: SessionUser };
const header = (r: Req, h: string) => {
  const v = r.headers[h];
  return typeof v === "string" ? v : undefined;
};

/** Caller without deps; controllers finish it with `store.caller(raw)`. */
export type RawCaller = Omit<Caller, "deps" | "db">;
export const Sys = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RawCaller => {
    const r = ctx.switchToHttp().getRequest<Req>();
    return {
      session: r.user ?? null,
      ip: r.ip,
      requestId: String(r.id ?? ""),
      userAgent: header(r, "user-agent")?.slice(0, 200),
      ifMatch:
        header(r, "if-match")?.replace(/^W\//, "").replace(/"/g, "") || null,
      stepUpToken: header(r, "x-step-up-token"),
    };
  },
);

/** Unwraps accepted(x) into x with HTTP 202. */
@Injectable()
export class AcceptedInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      map((res: unknown) => {
        if (!(res instanceof Accepted)) return res;
        void ctx.switchToHttp().getResponse<FastifyReply>().status(202);
        return res.data as unknown;
      }),
    );
  }
}
