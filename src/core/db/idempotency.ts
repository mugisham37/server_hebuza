import { createHash } from "node:crypto";
import { CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor, SetMetadata, UseInterceptors, applyDecorators } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ClsService } from "nestjs-cls";
import type { FastifyRequest } from "fastify";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { from, of, switchMap, map, catchError, throwError, type Observable } from "rxjs";
import { idempotencyKeys } from "@/db/schema";
import { AppError, conflict } from "../http/errors";
import type { RequestStore } from "../http/context";
import { canonical } from "./audit";
import { DB, type Db } from "./db";

const IDEMPOTENT = "idempotent";
const TTL = sql`now() - interval '24 hours'`;
const STALE = sql`now() - interval '60 seconds'`; // in-flight claim older than this = crashed, reclaimable

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly log = new Logger("idempotency");
  constructor(@Inject(DB) private readonly db: Db, private readonly ctx: ClsService<RequestStore>, private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(IDEMPOTENT, context.getHandler())) return next.handle();
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key || key.length > 128) throw new AppError(400, "validation", "Idempotency-Key header is required.");
    const userId = this.ctx.get("user")?.id ?? `anon:${req.ip}`;
    const bodyHash = createHash("sha256").update(canonical(req.body)).digest("hex");
    const where = and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId));

    return from(this.claim(key, userId, bodyHash)).pipe(switchMap((replay) => replay ? of(replay.response) : next.handle().pipe(
      switchMap((response) => from(this.db.update(idempotencyKeys).set({ status: 200, response: response ?? null }).where(where)
        .catch((e: unknown) => this.log.error({ event: "idempotency.save_failed", key, err: (e as Error).message }))).pipe(map(() => response))),
      // Client errors free the key for a corrected retry; 5xx/unknown leave it in flight, reclaimable after 60 s.
      catchError((e: unknown) => e instanceof AppError && e.status < 500
        ? from(this.db.delete(idempotencyKeys).where(where)).pipe(switchMap(() => throwError(() => e)))
        : throwError(() => e)),
    )));
  }

  /** Claims the key, or returns the stored response; 409 on body mismatch or while the first call is in flight. */
  private async claim(key: string, userId: string, bodyHash: string) {
    const where = and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId));
    await this.db.delete(idempotencyKeys).where(and(where, or(lt(idempotencyKeys.createdAt, TTL), and(isNull(idempotencyKeys.status), lt(idempotencyKeys.createdAt, STALE)))));
    const [claimed] = await this.db.insert(idempotencyKeys).values({ key, userId, bodyHash }).onConflictDoNothing().returning();
    if (claimed) return null;
    const [prev] = await this.db.select().from(idempotencyKeys).where(where);
    if (!prev) return null; // shortcut: lost a race with expiry purge, runs unguarded once; fine at 24 h TTL
    if (prev.bodyHash !== bodyHash) throw conflict("Idempotency-Key was already used with a different request.");
    if (prev.status === null) throw conflict("A request with this Idempotency-Key is still in progress.");
    return { response: prev.response };
  }
}

/** Requires an `Idempotency-Key` header; repeats within 24 h replay the first response. */
export const Idempotent = () => applyDecorators(SetMetadata(IDEMPOTENT, true), UseInterceptors(IdempotencyInterceptor));
