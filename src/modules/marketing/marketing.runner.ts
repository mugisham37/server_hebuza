// Runs one reference marketing handler inside the request tx with the reference Caller shape; domain audit rows the
// handler records are written with AuditService as the last statements of the same tx.
import { Injectable } from "@nestjs/common";
import { ClsService } from "nestjs-cls";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { TxService } from "../../core/db/tx";
import { AuditService, type AuditEntry } from "../../core/db/audit";
import type { RequestStore } from "../../core/http/context";
import type { OpsReq } from "../ops/ops.runner";
import type { Caller, Exec } from "./marketing.store";

@Injectable()
export class MarketingRunner {
  constructor(
    private readonly tx: TxService,
    private readonly cls: ClsService<RequestStore>,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  run<T>(r: OpsReq | null, fn: (c: Caller) => Promise<T>) {
    return this.tx.run(async (db) => {
      const audits: AuditEntry[] = [];
      const me = r?.user;
      const res = await fn({
        db,
        session: me ? { ...me, role: me.roles[0] ?? "" } : null,
        ip: this.cls.get("ip") ?? null,
        req: { headers: { get: (n) => { const v = r?.headers[n.toLowerCase()]; return typeof v === "string" ? v : null; } } },
        audits,
        prod: this.config.get("NODE_ENV", { infer: true }) === "production",
      });
      for (const e of audits) await this.audit.record(db, e);
      return res;
    });
  }

  read<T>(fn: (db: Exec) => Promise<T>) {
    return this.tx.run(fn);
  }
}
