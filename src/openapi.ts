// Generation-only: builds the OpenAPI doc from controller metadata and writes server/openapi.json.
// preview: true resolves the module graph without instantiating providers, so no Postgres/Redis is needed.
import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { ANY, openapiDefs, openapiExtra } from "./core/http/dto";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

// Placeholders so env validation passes at import; preview mode never connects with them.
for (const k of ["DATABASE_URL", "REDIS_URL", "S3_ENDPOINT"]) process.env[k] ??= "http://localhost";
for (const k of ["WEB_ORIGIN", "JWT_PRIVATE_KEY", "JWT_PUBLIC_KEY", "FIELD_KEY", "BLIND_INDEX_KEY", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "MAIL_FROM"]) process.env[k] ??= "x";

async function main() {
  const { AppModule } = await import("./app.module"); // after the env placeholders above
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { preview: true, logger: false, abortOnError: false });
  app.setGlobalPrefix("api", { exclude: ["health", "health/ready"] });
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("HEBUZA API").setVersion("1").build());
  const schemas = ((doc.components ??= {}).schemas ??= {});
  Object.assign(schemas, openapiDefs);
  for (const [name, extra] of Object.entries(openapiExtra)) if (schemas[name]) Object.assign(schemas[name], extra);
  const json = JSON.stringify(doc, (_k, v) => (v?.type === ANY ? { ...v, type: undefined } : v), 2);
  const out = resolve(__dirname, "../openapi.json");
  writeFileSync(out, json + "\n");
  console.log(`openapi: ${Object.keys(doc.paths).length} paths -> ${out}`);
  await app.close();
}
void main();
