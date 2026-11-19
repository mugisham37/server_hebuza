import { ConfigService } from "@nestjs/config";
import { LoggerModule as PinoModule } from "nestjs-pino";
import type { Env } from "../config/env";

const SECRET = ["authorization", "cookie", "set-cookie", "password", "token", "otp", "nationalId", "tin", "secret", "apiKey", "code", "refreshToken", "accessToken", "cardToken", "card_token", "x-step-up-token", "x-hub-signature-256", "svix-signature", "x-origin-auth"];
/** Phase 7: capability tokens ride in some URLs (webhooks, ICS feeds, booking manage links, invites, query `sig`/`token`). */
export const scrubUrl = (u: string) =>
  u.replace(/\/(webhooks\/notify|obligations\/ics|agent\/ics|bookings\/manage|org-invite|invite|unsubscribe)\/[^/?]+/g, "/$1/[redacted]")
    .replace(/([?&](?:sig|token|code|key|t)=)[^&]+/gi, "$1[redacted]");
const paths = [...SECRET.flatMap((k) => [`req.headers["${k}"]`, `*["${k}"]`, `*.*["${k}"]`])];
const mask = (v: unknown) => (typeof v === "string" && v.length > 4 ? `${"*".repeat(v.length - 3)}${v.slice(-3)}` : "***");

export const LoggerModule = PinoModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (c: ConfigService<Env, true>) => ({ pinoHttp: {
    level: c.get("LOG_LEVEL", { infer: true }),
    genReqId: (req) => String(req.headers["x-request-id"] ?? ""), // main.ts genReqId stores Fastify's id here
    redact: { paths, censor: "[redacted]" },
    serializers: { req: (r: { url?: string } & Record<string, unknown>) => ({ ...r, url: r.url ? scrubUrl(r.url) : r.url }) },
    // phone is masked partially (last 3 digits kept) for support lookups
    formatters: { log: (o) => (o.phone ? { ...o, phone: mask(o.phone) } : o) },
    transport: c.get("NODE_ENV", { infer: true }) === "development" ? { target: "pino-pretty" } : undefined,
  } }),
});
