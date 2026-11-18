// Worker side of documents: finalize presigned uploads (type sniff, scan hook, EXIF strip + thumbnail, activation) and
// the daily orphan clean-up (port of .ref documents.jobs process_attachment + cleanup_orphan_documents).
import { Injectable, Logger } from "@nestjs/common";
import sharp from "sharp";
import { TxService } from "../../core/db/tx";
import { Cron, Job, QueueService } from "../../core/queue/queues";
import { StorageService } from "../../core/storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import { sniffMime } from "./documents.files";
import {
  activateCaseUpload,
  finalizeTarget,
  markOrphaned,
  orphanVersions,
  rejectUpload,
  type FinalizeJob,
} from "./documents.service";

export const THUMB_PX = 320;

/** Re-encode images without metadata (EXIF/GPS) and make a JPEG thumbnail. */
export async function processImage(bytes: Uint8Array) {
  const img = sharp(bytes, { failOn: "error" }).rotate(); // apply EXIF orientation, then metadata is dropped on output
  const [clean, thumb] = await Promise.all([
    img.clone().toBuffer(),
    img.clone().resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer(),
  ]);
  return { clean, thumb };
}

@Injectable()
export class DocumentsJobs {
  private readonly log = new Logger("documents");
  constructor(
    private readonly tx: TxService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
  ) {}

  @Job("documents.finalize")
  async finalize(j: FinalizeJob) {
    const t = await this.tx.runAsSystem((db) => finalizeTarget(db, j));
    if (!t) return { status: "gone" };
    const head = await this.storage.head(t.key);
    const bytes = head ? new Uint8Array(Buffer.concat(await (await this.storage.getStream(t.key)).toArray())) : null;
    if (!bytes || sniffMime(bytes) !== t.mime) {
      if (bytes) await this.storage.delete(t.key);
      await this.tx.runAsSystem((db) => rejectUpload(db, j));
      this.log.warn({ event: "documents.upload_rejected", key: t.key, reason: bytes ? "type_mismatch" : "missing" });
      return { status: "rejected" };
    }
    await this.queue.add("default", "storage.scan", { key: t.key, kind: j.kind, id: j.id });
    if (t.mime.startsWith("image/"))
      try {
        const { clean, thumb } = await processImage(bytes);
        // shortcut: HEIC needs a libheif-enabled sharp build; without it the original is kept and only the thumb is tried.
        if (t.mime !== "image/heic") await this.storage.putObject(t.key, clean, t.mime);
        await this.storage.putObject(`${t.key}.thumb.jpg`, thumb, "image/jpeg");
      } catch (e) {
        this.log.warn({ event: "documents.process_failed", key: t.key, err: String(e) });
      }
    if (j.kind === "case") await this.tx.runAsSystem((db) => activateCaseUpload(db, this.notifications, j));
    return { status: "ok" };
  }

  @Cron("documents.orphans", "30 3 * * *")
  async orphans() {
    const rows = await this.tx.runAsSystem((db) => orphanVersions(db));
    let deleted = 0;
    for (const r of rows) {
      try {
        await this.storage.delete(r.path);
      } catch (e) {
        this.log.warn({ event: "documents.orphan_delete_failed", path: r.path, err: String(e) }); // retried tomorrow
        continue;
      }
      await this.tx.runAsSystem((db) => markOrphaned(db, r.id));
      deleted++;
    }
    return deleted;
  }
}
