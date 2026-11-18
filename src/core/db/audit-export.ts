// Daily immutable copy of the hash-chained audit log → R2 bucket `hebuza-audit` (7-year bucket lock).
// One gzip'd JSONL object per UTC day, written once (locked objects can't be overwritten, so an existing day is skipped).
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, asc, gte, lt } from "drizzle-orm";
import { gzipSync } from "node:zlib";
import { auditLog } from "@/db/schema";
import type { Env } from "../config/env";
import { Cron } from "../queue/queues";
import { DB, type Db } from "./db";

@Injectable()
export class AuditExport {
  private readonly log = new Logger("audit-export");
  private readonly s3: S3Client | null;
  private readonly bucket?: string;

  constructor(@Inject(DB) private readonly db: Db, cfg: ConfigService<Env, true>) {
    const key = cfg.get("AUDIT_S3_ACCESS_KEY", { infer: true }), secret = cfg.get("AUDIT_S3_SECRET_KEY", { infer: true });
    this.bucket = cfg.get("AUDIT_S3_BUCKET", { infer: true });
    this.s3 = key && secret && this.bucket
      ? new S3Client({ endpoint: cfg.get("S3_ENDPOINT", { infer: true }), region: cfg.get("S3_REGION", { infer: true }), credentials: { accessKeyId: key, secretAccessKey: secret } })
      : null;
  }

  // 00:30 UTC: export the previous UTC day.
  @Cron("audit.export", "30 0 * * *")
  async exportYesterday() {
    if (!this.s3) return this.log.warn("audit export skipped: AUDIT_S3_* not configured");
    const end = new Date(); end.setUTCHours(0, 0, 0, 0);
    const start = new Date(end.getTime() - 86_400_000);
    const key = `audit/${start.toISOString().slice(0, 10).replaceAll("-", "/")}.jsonl.gz`;
    const exists = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })).then(() => true, () => false);
    if (exists) return;
    const rows = await this.db.select().from(auditLog)
      .where(and(gte(auditLog.createdAt, start.toISOString()), lt(auditLog.createdAt, end.toISOString())))
      .orderBy(asc(auditLog.chainSeq));
    const body = gzipSync(rows.map((r) => JSON.stringify(r)).join("\n"));
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: "application/x-ndjson", ContentEncoding: "gzip", Metadata: { rows: String(rows.length), last_hash: String(rows.at(-1)?.chainHash ?? "") } }));
    this.log.log(`audit export ${key}: ${rows.length} rows`);
  }
}
