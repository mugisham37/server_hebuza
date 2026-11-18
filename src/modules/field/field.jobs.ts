// Field worker: custody receipt PDFs, scan page → PDF assembly, 48 h cash escalation (F-WRK-21).
import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { fieldReceipts, fieldScans, fieldVisits } from "@/db/schema/schema-field";
import type { ReceiptItem } from "@/domain/field/types";
import { Cron, Job } from "../../core/queue/queues";
import { TxService } from "../../core/db/tx";
import { StorageService } from "../../core/storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import { textPdf } from "../chat/chat.service";
import { escalateCash } from "./field.service";

@Injectable()
export class FieldJobs {
  constructor(private readonly txs: TxService, private readonly storage: StorageService, private readonly notify: NotificationsService) {}

  // shortcut: text-only PDF (no drawn signature image); render the signature when a PDF library with images lands.
  @Job("field.receipt.pdf")
  receiptPdf({ receiptId }: { receiptId: string }) {
    return this.txs.runAsSystem(async (db) => {
      const [r] = await db.select().from(fieldReceipts).where(eq(fieldReceipts.id, receiptId));
      if (!r || r.pdfKey) return;
      const [v] = await db.select({ ref: fieldVisits.ref, caseRef: fieldVisits.caseRef }).from(fieldVisits).where(eq(fieldVisits.id, r.visitId));
      const sig = r.signature as { method: string; signedAt: string; locale: string; typedName?: string };
      const items = r.items as ReceiptItem[];
      const pdf = textPdf(`Custody receipt ${r.ref}`, [
        `${r.direction === "returned" ? "Returned to" : "Collected from"}: ${r.clientName}`,
        `Visit ${v?.ref ?? r.visitId} · Case ${v?.caseRef ?? ""}`,
        `Agent: ${r.agentName}`,
        `Signed ${new Date(sig.signedAt).toISOString()} (${sig.method}${sig.typedName ? `: ${sig.typedName}` : ""}, ${sig.locale})`,
        "",
        ...items.map((i, n) => `${n + 1}. ${i.label} — ${i.docKind}${i.original ? " (original)" : " (copy)"}, ${i.pages} page(s)`),
        "",
        ...(r.conditionNotes ? [`Condition: ${r.conditionNotes}`] : []),
        ...(r.supersedesId ? [`Corrects receipt ${r.supersedesId}`] : []),
        `SHA-256 ${r.sha256}`,
      ]);
      const key = `field/${r.visitId}/receipt-${r.ref}.pdf`;
      await this.storage.putObject(key, pdf, "application/pdf");
      await db.update(fieldReceipts).set({ pdfKey: key }).where(eq(fieldReceipts.id, r.id));
    });
  }

  // shortcut: a single uploaded PDF is the document; image pages are served page 1 first (scanPdf falls back to
  // pageKeys[0]) until an image-capable PDF builder exists in the worker.
  @Job("field.scan.assemble")
  assemble({ scanId }: { scanId: string }) {
    return this.txs.runAsSystem(async (db) => {
      const [s] = await db.select().from(fieldScans).where(eq(fieldScans.id, scanId));
      if (!s || s.status === "available") return;
      const pdf = s.pageKeys.length === 1 && s.pageKeys[0].type === "application/pdf" ? s.pageKeys[0].key : null;
      await db.update(fieldScans).set({ pdfKey: pdf, status: "available" }).where(eq(fieldScans.id, scanId));
    });
  }

  @Cron("field.cash.escalate", "0 * * * *")
  escalate() {
    return this.txs.runAsSystem((db) => escalateCash(db, this.notify));
  }
}
