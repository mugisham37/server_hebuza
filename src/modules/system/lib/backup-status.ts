// Real backup status (BDR-monitor): server/backup/backup.sh writes status/LATEST-<env>.json to the backup bucket.
// Dormant (returns null) until BACKUP_STATUS_* are set; read-only token scoped to the status/ prefix is enough.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ConfigService } from "@nestjs/config";
import type { Env } from "../../../core/config/env";
import type { BackupVM } from "@/domain/system/types";

type Status = { at: string; tier: string; key: string; bytes: number };
let client: S3Client | null | undefined;

/** "2026-11-19T010001Z" (backup.sh TS) → ISO. */
const isoOf = (ts: string) => ts.replace(/T(\d{2})(\d{2})(\d{2})Z$/, "T$1:$2:$3Z");

export async function latestBackup(cfg: ConfigService<Env, true>): Promise<BackupVM | null> {
  const endpoint = cfg.get("BACKUP_STATUS_ENDPOINT", { infer: true }), bucket = cfg.get("BACKUP_STATUS_BUCKET", { infer: true });
  const id = cfg.get("BACKUP_STATUS_ACCESS_KEY", { infer: true }), secret = cfg.get("BACKUP_STATUS_SECRET_KEY", { infer: true });
  if (!endpoint || !bucket || !id || !secret) return null;
  client ??= new S3Client({ endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId: id, secretAccessKey: secret } });
  const env = cfg.get("BACKUP_STATUS_ENV", { infer: true }) ?? "production";
  const o = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `status/LATEST-${env}.json` }));
  const s = JSON.parse(await o.Body!.transformToString()) as Status;
  const at = isoOf(s.at);
  // The job runs daily: a status older than 26 h means the last run failed or never ran.
  const fresh = Date.now() - Date.parse(at) < 26 * 3600_000;
  return { id: s.key, tier: s.tier as BackupVM["tier"], at, sizeMb: Math.round((s.bytes / 1_048_576) * 10) / 10, ok: fresh && s.bytes > 1024, encrypted: s.key.endsWith(".age"), location: `r2://${bucket}/${s.key}` };
}
