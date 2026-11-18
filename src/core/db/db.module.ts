import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env";
import { AuditService } from "./audit";
import { DB, createDb } from "./db";
import { OutboxService } from "./outbox";
import { TxService } from "./tx";

@Global()
@Module({
  providers: [
    { provide: DB, inject: [ConfigService], useFactory: (c: ConfigService<Env, true>) => createDb(c.get("DATABASE_URL", { infer: true }), c.get("DB_POOL_MAX", { infer: true })) },
    TxService, OutboxService, AuditService,
  ],
  exports: [DB, TxService, OutboxService, AuditService],
})
export class DbModule {}
