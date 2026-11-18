import { ConfigService } from "@nestjs/config";
import { LoggerModule as PinoModule } from "nestjs-pino";
import type { Env } from "../config/env";

const SECRET = ["authorization", "cookie", "set-cookie", "password", "token", "otp", "nationalId", "tin"];
const paths = [...SECRET.flatMap((k) => [`req.headers.${k}`, `*.${k}`, `*.*.${k}`])];
const mask = (v: unknown) => (typeof v === "string" && v.length > 4 ? `${"*".repeat(v.length - 3)}${v.slice(-3)}` : "***");

export const LoggerModule = PinoModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (c: ConfigService<Env, true>) => ({ pinoHttp: {
    level: c.get("LOG_LEVEL", { infer: true }),
    genReqId: (req) => String(req.headers["x-request-id"] ?? ""), // main.ts genReqId stores Fastify's id here
    redact: { paths, censor: "[redacted]" },
    // phone is masked partially (last 3 digits kept) for support lookups
    formatters: { log: (o) => (o.phone ? { ...o, phone: mask(o.phone) } : o) },
    transport: c.get("NODE_ENV", { infer: true }) === "development" ? { target: "pino-pretty" } : undefined,
  } }),
});
