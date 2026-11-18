import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply } from "fastify";
import type { Env } from "../config/env";
import { ACCESS_TTL_S, REFRESH_TTL_S } from "./tokens";

export const ACCESS_COOKIE = "hebuza_access";
export const REFRESH_COOKIE = "hebuza_refresh";
const REFRESH_PATH = "/api/auth";

@Injectable()
export class CookieService {
  private readonly secure: boolean;
  constructor(config: ConfigService<Env, true>) {
    this.secure = config.get("NODE_ENV", { infer: true }) === "production";
  }

  set(reply: FastifyReply, access: string, refresh: string) {
    const base = { httpOnly: true, secure: this.secure, sameSite: "lax" } as const;
    reply.setCookie(ACCESS_COOKIE, access, { ...base, path: "/", maxAge: ACCESS_TTL_S });
    reply.setCookie(REFRESH_COOKIE, refresh, { ...base, path: REFRESH_PATH, maxAge: REFRESH_TTL_S });
  }

  clear(reply: FastifyReply) {
    reply.clearCookie(ACCESS_COOKIE, { path: "/" });
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
  }
}
