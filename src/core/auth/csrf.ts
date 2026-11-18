import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import { AppError } from "../http/errors";
import { NO_CSRF } from "./decorators";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cookie auth + SameSite=Lax still needs an Origin check for state-changing requests. */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowed: Set<string>;
  constructor(private readonly reflector: Reflector, config: ConfigService<Env, true>) {
    this.allowed = new Set(config.get("WEB_ORIGIN", { infer: true }).split(",").map((o) => o.trim()));
  }

  canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== "http") return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE.has(req.method) || this.reflector.getAllAndOverride<boolean>(NO_CSRF, [ctx.getHandler(), ctx.getClass()])) return true;
    // Browsers never attach Authorization cross-site on their own, so bearer-only calls aren't CSRF-able.
    if (req.headers.authorization?.startsWith("Bearer ") && !req.headers.cookie) return true;
    const src = req.headers.origin ?? req.headers.referer;
    let origin: string | null = null;
    try { origin = src ? new URL(src).origin : null; } catch { /* malformed → reject */ }
    if (!origin || !this.allowed.has(origin)) throw new AppError(403, "csrf", "Cross-site request blocked");
    return true;
  }
}
