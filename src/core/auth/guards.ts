import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { can, STEP_UP as STEP_UP_PERMS, type Permission } from "@/domain/auth/permissions";
import type { RequestContext, SessionUser } from "../http/context";
import { ClsService } from "nestjs-cls";
import { AppError } from "../http/errors";
import { TokenService } from "./tokens";
import { ACCESS_COOKIE } from "./cookies";
import { IMPERSONATION_OK, PERMIT, PUBLIC, STEP_UP } from "./decorators";

type Req = FastifyRequest & { user?: SessionUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokenService, private readonly cls: ClsService) {}

  async canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== "http") return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, targets);
    const req = ctx.switchToHttp().getRequest<Req>();

    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const token = bearer ?? req.cookies?.[ACCESS_COOKIE];
    const user = token ? await this.tokens.verifyAccess(token).catch(() => null) : null;
    req.user = user ?? undefined;
    (this.cls as RequestContext).set("user", user);

    if (user?.act && req.method !== "GET" && req.method !== "HEAD" && !meta<boolean>(IMPERSONATION_OK))
      throw new AppError(403, "impersonation_read_only", "View-as is read-only.");
    const perms = meta<Permission[]>(PERMIT);
    if (!user && !meta<boolean>(PUBLIC)) throw new AppError(401, "unauthenticated", "Not signed in");
    if (perms?.length && !perms.some((p) => can(user && { id: user.id, roles: user.roles }, p))) throw new AppError(403, "forbidden", "Forbidden");

    if (meta<boolean>(STEP_UP) || perms?.some((p) => STEP_UP_PERMS.has(p))) {
      const raw = req.headers["x-step-up-token"];
      const ok = user && typeof raw === "string" && (await this.tokens.verifyStepUp(raw, user).catch(() => false));
      if (!ok) throw new AppError(401, "step_up_required", "Confirm it's you to continue");
    }
    return true;
  }
}
