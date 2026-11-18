import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT → close workers (drain active jobs), stop relay
  Logger.log("worker started", "worker");
}

main().catch((e: unknown) => {
  Logger.error(e, "worker");
  process.exit(1);
});
