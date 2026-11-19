// @Route({...}): one decorator per endpoint carrying the old route-table options (auth, permission, step-up, limit,
// idempotency, If-Match, output schema, audit, emit, status), so every reference route ports 1:1 to a Nest method.
import {
  applyDecorators,
  CallHandler,
  createParamDecorator,
  ExecutionContext,
  HttpCode,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiResponse } from "@nestjs/swagger";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import { concatMap, from, type Observable } from "rxjs";
import type { Role } from "@/domain/auth/roles";
import type { Permission } from "@/domain/auth/permissions";
import {
  Limit,
  Permit,
  Public,
  StepUp,
  type LimitName,
} from "../auth/decorators";
import { Idempotent } from "../db/idempotency";
import { AuditService } from "../db/audit";
import { OutboxService } from "../db/outbox";
import { TxService } from "../db/tx";
import { AppError } from "./errors";
import { toOpenApi } from "./dto";
import type { RequestStore, SessionUser } from "./context";
import { ClsService, ClsServiceManager } from "nestjs-cls";

/** F-AUD-03: a handler with `audit:` calls this with the record as it was, so the decorator audit carries before/after. */
export const auditBefore = (v: unknown) => {
  const c = ClsServiceManager.getClsService<RequestStore>();
  if (c.isActive()) c.set("auditBefore", v);
};

export type RouteOpts = {
  /** "public" = no session; "user" = any signed-in user; Role[] = one of these roles. */
  auth: "public" | "user" | readonly Role[];
  permission?: Permission;
  stepUp?: boolean;
  limit?: LimitName;
  idempotent?: boolean;
  /** Require an If-Match header; read it with @IfMatch(). */
  ifMatch?: boolean;
  /** Output schema: unknown keys are stripped so fields a role may not see never leave the server. */
  out?: z.ZodType;
  /** Audit action recorded after success; entity id = :id/:code param or result.id. */
  audit?: string;
  /** Outbox event published after success (payload = result). */
  emit?: string;
  status?: number;
};

const ROUTE = "route:opts";
type Req = FastifyRequest & {
  user?: SessionUser;
  params: Record<string, string>;
};

export const Route = (o: RouteOpts) =>
  applyDecorators(
    SetMetadata(ROUTE, o),
    UseInterceptors(RouteInterceptor),
    ...(o.auth === "public" ? [Public()] : []),
    ...(o.permission ? [Permit(o.permission)] : []),
    ...(o.stepUp ? [StepUp()] : []),
    ...(o.limit ? [Limit(o.limit)] : []),
    ...(o.idempotent ? [Idempotent()] : []),
    ...(o.status ? [HttpCode(o.status)] : []),
    ApiResponse({ status: o.status ?? "2XX", schema: envelope(o.out) }),
  );

// OpenAPI only: the EnvelopeInterceptor wraps every success body in this shape.
const envelope = (out?: z.ZodType) => ({
  type: "object",
  required: ["success", "message", "errorType", "data"],
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    errorType: { type: "string", nullable: true },
    data: out ? toOpenApi(out, "output") : {},
  },
});

/** Strong If-Match value (quotes and W/ stripped). */
export const IfMatch = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    String(ctx.switchToHttp().getRequest<Req>().headers["if-match"] ?? "")
      .replace(/^W\//, "")
      .replace(/"/g, "") || null,
);

@Injectable()
export class RouteInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tx: TxService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const o = this.reflector.get<RouteOpts>(ROUTE, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<Req>();
    if (
      Array.isArray(o.auth) &&
      !req.user?.roles.some((r) => (o.auth as readonly Role[]).includes(r))
    )
      throw new AppError(403, "forbidden", "Forbidden");
    if (o.ifMatch && !req.headers["if-match"])
      throw new AppError(428, "precondition_required", "Reload and try again.");
    return next
      .handle()
      .pipe(concatMap((res) => from(this.after(o, req, res))));
  }

  private async after(o: RouteOpts, req: Req, res: unknown) {
    const out = o.out ? o.out.parse(res) : res;
    if (o.audit || o.emit) {
      const id =
        req.params?.id ??
        req.params?.code ??
        (out as { id?: string } | null)?.id ??
        "-";
      // shortcut: audit/emit commit after the handler's own tx (not atomic with it); money paths record in-tx via AuditService.
      await this.tx.run(async (t) => {
        if (o.emit) await this.outbox.add(t, { type: o.emit, payload: out });
        if (o.audit)
          await this.audit.record(t, {
            action: o.audit,
            entity: o.audit.split(".")[0],
            entityId: String(id),
            before: this.cls.isActive() ? this.cls.get("auditBefore") : undefined,
            after: out,
          });
      });
    }
    return out;
  }
}
