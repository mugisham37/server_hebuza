import "./core/sentry";
import { makeTrustProxy, originGate } from "./core/http/client-ip";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import type { Env } from "./core/config/env";

async function bootstrap() {
  const adapter = new FastifyAdapter({
    trustProxy: makeTrustProxy(), // our own Railway hops only (core/http/client-ip.ts), never client-forgeable XFF
    bodyLimit: 1_048_576,
    maxParamLength: 300, // default 100 404s long catalogue slugs (some are 120+ chars)
    genReqId: (req: IncomingMessage) => {
      const h = req.headers["x-request-id"];
      const id = typeof h === "string" && /^[\w-]{1,64}$/.test(h) ? h : randomUUID();
      req.headers["x-request-id"] = id; // pino-http + CLS middleware only see the raw req; they read it back from here
      return id;
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });
  // Drop Nest's ~900 boot lines (route table, module loading): Railway rate-limits log bursts and would drop real warnings with them.
  const NOISY = new Set(["RoutesResolver", "RouterExplorer", "InstanceLoader", "LegacyRouteConverter"]);
  const base = app.get(Logger);
  const quiet = (fn: (m: unknown, ...p: unknown[]) => void) => (m: unknown, ...p: unknown[]) => { if (!NOISY.has(String(p.at(-1)))) fn.call(base, m, ...p); };
  app.useLogger({ log: quiet(base.log), warn: base.warn.bind(base), error: base.error.bind(base), debug: quiet(base.debug), verbose: quiet(base.verbose), fatal: base.fatal.bind(base) });
  const cfg: ConfigService<Env, true> = app.get(ConfigService);

  // Phase L origin protection + Cloudflare client IP; no-op while ORIGIN_AUTH_SECRET is unset (core/http/client-ip.ts).
  const originSecret = cfg.get("ORIGIN_AUTH_SECRET", { infer: true });
  app.getHttpAdapter().getInstance().addHook("onRequest", async (req, reply) => {
    const g = originGate({ url: req.url, headers: req.headers, socket: req.raw.socket }, originSecret);
    if (g === "forbidden") return reply.code(403).send({ success: false, message: "Forbidden", errorType: "forbidden", data: null });
    if (g) Object.defineProperty(req, "ip", { value: g });
  });
  await app.register(helmet);
  // Phase 7: API responses carry personal data; never let shared caches/proxies keep them (public catalogue sets its own).
  app.getHttpAdapter().getInstance().addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/") && !reply.hasHeader("cache-control")) void reply.header("cache-control", "no-store");
  });
  await app.register(cookie);
  // Africa's Talking delivery reports + inbound SMS post form-encoded bodies (notifications webhooks).
  app.getHttpAdapter().getInstance().addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16_384 }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 20 } });
  app.enableCors({ origin: cfg.get("WEB_ORIGIN", { infer: true }).split(",").map((o) => o.trim()), credentials: true });
  app.setGlobalPrefix("api", { exclude: ["health", "health/ready"] });
  app.enableShutdownHooks();
  // Field routes take base64 data URLs (25 MB file ≈ 33.4 MB encoded); everything else keeps the 1 MB global.
  // shortcut: one limit for all field routes incl. multi-page scans, move to multipart/presigned uploads if scans outgrow it.
  app.getHttpAdapter().getInstance().addHook("onRoute", (r) => {
    if (/^\/api\/(x_)?field\//.test(r.url)) r.bodyLimit = 40 * 1024 * 1024;
    // Resend (svix) and Meta (X-Hub-Signature-256) sign the exact bytes: keep the raw body for that one route (req.rawBody), parse as usual after.
    if (r.url.endsWith("/webhooks/notify/:token/resend") || (r.url.endsWith("/webhooks/notify/:token/whatsapp") && r.method === "POST"))
      r.preParsing = [async (req: { rawBody?: Buffer }, _reply: unknown, payload: AsyncIterable<Buffer>) => {
        const chunks: Buffer[] = [];
        for await (const c of payload) chunks.push(Buffer.from(c));
        req.rawBody = Buffer.concat(chunks);
        return Readable.from([req.rawBody]);
      }] as never;
  });

  // "::" is dual-stack: Railway private networking is IPv6, public traffic IPv4.
  await app.listen({ port: cfg.get("PORT", { infer: true }), host: "::" });
}
void bootstrap();
