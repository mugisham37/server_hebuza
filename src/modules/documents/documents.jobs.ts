// Worker side of documents: finalize presigned uploads (type sniff, scan hook, EXIF strip + thumbnail, activation) and
// the daily orphan clean-up (port of .ref documents.jobs process_attachment + cleanup_orphan_documents).
import { Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { applicationDocuments, clientDocuments } from "@/db/schema";
import { classifyText } from "@/domain/documents/classify";
import sharp from "sharp";
import { TxService } from "../../core/db/tx";
import { Cron, Job, QueueService } from "../../core/queue/queues";
import { StorageService } from "../../core/storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import { sniffMime } from "./documents.files";
import { classOf, expired } from "@/domain/documents/retention";
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
    if (j.kind !== "chat" && this.cfg.get("OCR_ENDPOINT", { infer: true }) && (t.mime === "application/pdf" || t.mime.startsWith("image/")))
      await this.queue.add("bulk", "documents.ocr", { kind: j.kind, id: j.id, key: t.key, mime: t.mime });
    return { status: "ok" };
  }

  /** F-DOC-12: OCR + kind suggestion. Provider errors retry with backoff; the result is advisory (staff QC decides). */
  @Job("documents.ocr")
  async ocr(j: { kind: "case" | "library"; id: string; key: string; mime: string }) {
    const url = this.cfg.get("OCR_ENDPOINT", { infer: true });
    if (!url) return { status: "off" };
    const bytes = Buffer.concat(await (await this.storage.getStream(j.key)).toArray());
    const token = this.cfg.get("OCR_TOKEN", { infer: true });
    const r = await fetch(url, { method: "POST", headers: { "content-type": j.mime, ...(token && { authorization: `Bearer ${token}` }) }, body: bytes, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`ocr: ${r.status}`);
    const text = String(((await r.json()) as { text?: string }).text ?? "");
    const ocr = { excerpt: text.slice(0, 2000), guess: classifyText(text), at: new Date().toISOString() };
    await this.tx.runAsSystem((db) =>
      j.kind === "case"
        ? db.update(applicationDocuments).set({ ocr }).where(eq(applicationDocuments.documentId, j.id))
        : db.update(clientDocuments).set({ ocr }).where(eq(clientDocuments.documentId, j.id)));
    return { status: "ok", kind: ocr.guess.kind };
  }

  /** F-DOC-06: vault documents expiring in exactly 60 or 30 days (or today) → reminder to the owner, once per day mark. */
  @Cron("documents.expiry", "0 5 * * *")
  async expiry() {
    return this.tx.runAsSystem(async (db) => {
      const due = (await db.execute(sql`select e.document_id as id, d.client_id as client, coalesce(d.label, d.original_filename) as name, e.expires_on::text as expires,
          (e.expires_on - current_date) as days
        from client_document_expiry e join client_documents d on d.document_id = e.document_id
        where d.is_active and (e.expires_on - current_date) in (60, 30, 0)`)) as unknown as { id: string; client: string; name: string; expires: string; days: number }[]; // cast: execute() rows are untyped
      for (const r of due)
        await this.notifications.notify(db, {
          userId: r.client, kind: "document.expiring",
          title: r.days === 0 ? `${r.name} expires today` : `${r.name} expires in ${r.days} days`,
          body: `Upload a renewed copy before ${r.expires} so your next requests aren't held up.`,
          link: "/documents", channels: ["email", "sms"],
          data: { type: "document.expiring", vars: { ref: `${r.id}:${r.days}`, name: r.name, days: String(r.days) } },
        });
      return due.length;
    });
  }

  /** DOC-09: flag closed-case documents and deliverables past their class's retention for an SM decision (nothing is deleted here). */
  @Cron("documents.retention", "45 2 * * *")
  async retention() {
    return this.tx.runAsSystem(async (db) => {
      const rows = (await db.execute(sql`
        select 'case' as source, d.document_id as id, d.requirement_key as kind, d.storage_path as path, d.original_filename as label, a.code,
               coalesce(a.completed_at, a.cancelled_at, a.rejected_at, a.updated_at)::text as anchor
          from application_documents d join applications a on a.application_id = d.application_id
          where d.removed_at is null and a.status in ('completed_delivered','cancelled','rejected','refunded')
        union all
        select 'deliverable', v.id, null, v.storage_path, v.title, a.code, coalesce(v.released_at, v.created_at)::text
          from deliverables v join applications a on a.application_id = v.application_id
          where v.storage_path not like 'shredded/%'`)) as unknown as { source: "case" | "deliverable"; id: string; kind: string | null; path: string; label: string; code: string; anchor: string }[]; // cast: execute() rows are untyped
      let flagged = 0;
      for (const r of rows) {
        const cls = classOf(r.source, r.kind);
        if (!expired(cls, r.anchor)) continue;
        const res = await db.execute(sql`insert into document_retention_flags (id, source, source_id, retention_class, storage_path, label, case_code, anchor_at, flagged_at)
          select ${`ret_${r.source}_${r.id}`.slice(0, 64)}, ${r.source}, ${r.id}, ${cls}, ${r.path}, ${r.label.slice(0, 255)}, ${r.code}, ${r.anchor}::timestamptz, now()
          on conflict (id) do nothing`);
        flagged += res.count ?? 0;
      }
      if (flagged)
        for (const u of (await db.execute(sql`select user_id as id from users where role = 'staff:service_manager' and is_active`)) as unknown as { id: string }[]) // cast: execute() rows are untyped
          await this.notifications.notify(db, { userId: u.id, kind: "documents.retention", title: `${flagged} documents reached their retention period`, link: "/ops/retention" });
      return { flagged };
    });
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
