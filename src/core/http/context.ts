import { clientIpFromChain, xffChain } from "./client-ip";
import { ClsModule, ClsService, ClsStore } from "nestjs-cls";
import type { IncomingMessage } from "node:http";
import type { Role } from "@/domain/auth/roles";

export type SessionUser = { id: string; roles: Role[]; scopes: { orgId?: string; partnerId?: string; agentId?: string }; stepUpAt?: number; sid: string; /** real actor id while viewing as this user (read-only) */ act?: string; /** 2FA enrolled (→ `mfa_enrolled` claim) */ mfa?: boolean; /** policy forces setup (→ `mfa_required` claim) */ mfaRequired?: boolean; /** F-IAM-01 the role chosen in the switcher (→ `active_role`) */ activeRole?: Role };
export interface RequestStore extends ClsStore { user: SessionUser | null; requestId: string; ip: string; locale: string; http?: boolean; ua?: string; /** F-AUD-03: state before a @Route-audited change (set via auditBefore) */ auditBefore?: unknown }
export type RequestContext = ClsService<RequestStore>;

const LOCALES = ["en", "fr", "rw"];
const pickLocale = (req: IncomingMessage) => {
  const raw = /(?:^|;\s*)hebuza_locale=([^;]*)/.exec(req.headers.cookie ?? "")?.[1] ?? req.headers["accept-language"]?.split(",")[0];
  const l = raw?.slice(0, 2).toLowerCase();
  return l && LOCALES.includes(l) ? l : "en";
};

const clientIp = (req: IncomingMessage) => clientIpFromChain(xffChain(req.socket.remoteAddress, req.headers["x-forwarded-for"]));

// Fastify hands Nest middleware the raw IncomingMessage (no req.id/ip/cookies), so read everything from headers/socket.
// requestId: main.ts genReqId writes the final id back into x-request-id.
export const ContextModule = ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    setup: (cls: ClsService, req: IncomingMessage) => {
      cls.set("requestId", String(req.headers["x-request-id"] ?? ""));
      cls.set("ip", clientIp(req));
      cls.set("ua", String(req.headers["user-agent"] ?? "").slice(0, 255));
      cls.set("locale", pickLocale(req));
      cls.set("user", null);
      cls.set("http", true);
    },
  },
});
