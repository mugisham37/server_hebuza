// F-SET-11/12 enforcement: maintenance (on or scheduled window) makes the API read-only for clients and visitors;
// a disabled feature flag hides its module's routes. Runs after AuthGuard (needs req.user).
import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { inMaintenance, platformGate, type Window } from "@/domain/system/platform-gate";
import { FLAG_KEYS, type FlagKey } from "@/domain/system/settings-registry";
import { DB, type Db } from "../db/db";
import { settingOf } from "../db/system-records";
import { ipAllowed } from "../http/ip-allow";
import { AppError } from "../http/errors";
import type { SessionUser } from "../http/context";

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== "http") return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: SessionUser }>();
    const [on, win, ...flags] = await Promise.all([
      settingOf<boolean>(this.db, "maintenance.on"),
      settingOf<Window>(this.db, "maintenance.window"),
      ...FLAG_KEYS.map((k) => settingOf<boolean>(this.db, `flags.${k}`)),
    ]);
    const flagOn = new Map(FLAG_KEYS.map((k, i) => [k, flags[i] === true]));
    const block = platformGate({
      method: req.method, path: req.routeOptions?.url ?? req.url,
      staff: !!req.user?.roles.some((r) => r.startsWith("staff:")),
      maintenance: inMaintenance(on === true, win),
      flags: (k: FlagKey) => flagOn.get(k) ?? false,
    });
    if (block) throw new AppError(block.status, block.code, block.code === "maintenance" ? "The platform is in maintenance. Try again shortly." : "Not found.");
    // F-IAM-12: sysadmin / finance sessions only from the allowlisted networks (empty list = no restriction).
    for (const [role, key] of [["staff:sysadmin", "security.ip_allowlist.sysadmin"], ["staff:finance", "security.ip_allowlist.finance"]] as const) {
      if (!req.user?.roles.includes(role)) continue;
      const cidrs = (await settingOf<string[]>(this.db, key)) ?? [];
      if (cidrs.length && !ipAllowed(req.ip, cidrs)) throw new AppError(403, "ip_not_allowed", "This role can only be used from the office network.");
    }
    return true;
  }
}
