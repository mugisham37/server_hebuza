import { ClsModule, ClsService, ClsStore } from "nestjs-cls";
import type { IncomingMessage } from "node:http";
import type { Role } from "@/domain/auth/roles";

export type SessionUser = { id: string; roles: Role[]; scopes: { orgId?: string; partnerId?: string; agentId?: string }; stepUpAt?: number; sid: string; /** real actor id while viewing as this user (read-only) */ act?: string };
export interface RequestStore extends ClsStore { user: SessionUser | null; requestId: string; ip: string; locale: string; http?: boolean }
export type RequestContext = ClsService<RequestStore>;

const LOCALES = ["en", "fr", "rw"];
const pickLocale = (req: IncomingMessage) => {
  const raw = /(?:^|;\s*)hebuza_locale=([^;]*)/.exec(req.headers.cookie ?? "")?.[1] ?? req.headers["accept-language"]?.split(",")[0];
  const l = raw?.slice(0, 2).toLowerCase();
  return l && LOCALES.includes(l) ? l : "en";
};

/** Client ip as Fastify computes it for `trustProxy: <hops>`: walk that many proxies back from the socket through X-Forwarded-For. */
const clientIp = (req: IncomingMessage) => {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const chain = [req.socket.remoteAddress ?? "", ...xff.reverse()];
  return chain[Math.min(Number(process.env.TRUST_PROXY ?? 1), chain.length - 1)];
};

// Fastify hands Nest middleware the raw IncomingMessage (no req.id/ip/cookies), so read everything from headers/socket.
// requestId: main.ts genReqId writes the final id back into x-request-id.
export const ContextModule = ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    setup: (cls: ClsService, req: IncomingMessage) => {
      cls.set("requestId", String(req.headers["x-request-id"] ?? ""));
      cls.set("ip", clientIp(req));
      cls.set("locale", pickLocale(req));
      cls.set("user", null);
      cls.set("http", true);
    },
  },
});
