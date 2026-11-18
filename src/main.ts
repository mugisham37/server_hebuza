import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { envSchema, type Env } from "./core/config/env";

async function bootstrap() {
  const hops = envSchema.shape.TRUST_PROXY.parse(process.env.TRUST_PROXY);
  const adapter = new FastifyAdapter({
    trustProxy: (_addr: string, i: number) => i < hops, // trust exactly `hops` proxies, not `true` (XFF spoofing)
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
  app.useLogger(app.get(Logger));
  const cfg: ConfigService<Env, true> = app.get(ConfigService);

  await app.register(helmet);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 20 } });
  app.enableCors({ origin: cfg.get("WEB_ORIGIN", { infer: true }).split(",").map((o) => o.trim()), credentials: true });
  app.setGlobalPrefix("api", { exclude: ["health", "health/ready"] });
  app.enableShutdownHooks();
  // Field routes take base64 data URLs (25 MB file ≈ 33.4 MB encoded); everything else keeps the 1 MB global.
  // shortcut: one limit for all field routes incl. multi-page scans, move to multipart/presigned uploads if scans outgrow it.
  app.getHttpAdapter().getInstance().addHook("onRoute", (r) => {
    if (/^\/api\/(x_)?field\//.test(r.url)) r.bodyLimit = 40 * 1024 * 1024;
  });

  await app.listen({ port: cfg.get("PORT", { infer: true }), host: "0.0.0.0" });
}
void bootstrap();
