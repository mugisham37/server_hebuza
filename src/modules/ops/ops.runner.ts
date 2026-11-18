// Runs one reference ops handler inside the request tx (RLS GUCs set) with the reference ctx shape.
import {
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { ClsService } from "nestjs-cls";
import type { FastifyRequest } from "fastify";
import { TxService } from "../../core/db/tx";
import { TokenService } from "../../core/auth/tokens";
import type { RequestStore, SessionUser } from "../../core/http/context";
import type { Ctx, Exec } from "./lib/ctx";
import { AuditService } from "../../core/db/audit";
import { ApplicationsService } from "../applications/applications.service";

export type OpsReq = FastifyRequest & { user: SessionUser };
/** The raw request (user + headers) the runner needs. */
export const Req = createParamDecorator((_: unknown, c: ExecutionContext) =>
  c.switchToHttp().getRequest<OpsReq>(),
);

const header = (r: OpsReq, n: string) => {
  const v = r.headers[n];
  return typeof v === "string" ? v : null;
};

@Injectable()
export class OpsRunner {
  constructor(
    private readonly tx: TxService,
    private readonly cls: ClsService<RequestStore>,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly apps: ApplicationsService,
  ) {}

  /** Runs the handler, then records any ctx.audit details it set in the same tx. */
  run<T>(r: OpsReq, fn: (ctx: Ctx) => Promise<T>) {
    // Public routes (/join) reach here with no session; give them an empty, role-less one instead of crashing.
    const me: SessionUser = r.user ?? { id: "", sid: "", roles: [], scopes: {} };
    const raw = header(r, "x-step-up-token");
    return this.tx.run(async (db) => {
      const ctx: Ctx = {
        db,
        session: { ...me, role: me.roles[0] ?? "" },
        ip: this.cls.get("ip") ?? null,
        req: { headers: { get: (n) => header(r, n.toLowerCase()) } },
        audit: {},
        stepUp: () =>
          raw
            ? this.tokens.verifyStepUp(raw, me).catch(() => false)
            : Promise.resolve(false),
        transition: (a, to, facts = {}, note = null) => this.apps.transition(db, me, a, to, "manager", facts, note),
      };
      const out = await fn(ctx);
      const { resourceId, details } = ctx.audit;
      if (resourceId || details)
        await this.audit.record(db, { action: `ops.${r.routeOptions?.url ?? r.url}`, entity: "ops", entityId: resourceId ?? "", after: details });
      return out;
    });
  }

  read<T>(fn: (db: Exec) => Promise<T>) {
    return this.tx.run(fn);
  }
}
