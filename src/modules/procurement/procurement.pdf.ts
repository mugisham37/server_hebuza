// Supplier statement + purchase order PDFs: dependency-free text PDFs (chat's textPdf), no React in the API.
import { textPdf } from "../chat/chat.service";
import type { PurchaseOrder } from "@/domain/procurement/types";

const rwf = (n: number) => `RWF ${n.toLocaleString("en-US")}`;

type Statement = {
  vendor: { code: string; legalName: string };
  opening: number;
  billed: number;
  paid: number;
  closing: number;
  rows: { date: string; ref: string; text: string; debit: number; credit: number }[];
};

export const statementPdf = (d: Statement, from: string, to: string) =>
  textPdf(`Statement · ${d.vendor.legalName} (${d.vendor.code}) · ${from} – ${to}`, [
    `Opening ${rwf(d.opening)} · Billed ${rwf(d.billed)} · Paid ${rwf(d.paid)} · Closing ${rwf(d.closing)}`,
    "",
    ...d.rows.map(
      (r) =>
        `${r.date.slice(0, 10)}  ${r.ref}  ${r.text}  ${r.debit ? `Dr ${rwf(r.debit)}` : ""}${r.credit ? `Cr ${rwf(r.credit)}` : ""}`,
    ),
  ]);

export const poPdf = (po: PurchaseOrder, vendorName: string) =>
  textPdf(`Purchase order ${po.no} · ${vendorName}`, [
    `Deliver to: ${po.deliveryAddress}`,
    `Needed by: ${po.neededBy} · Payment terms: ${po.paymentTermsDays} days`,
    `Issued by ${po.issuedBy.name} on ${po.issuedAt.slice(0, 10)}`,
    "",
    ...po.lines.map((l) => `${l.qty} x ${l.description} @ ${rwf(l.unitPrice)} = ${rwf(l.total)}`),
    "",
    `Subtotal ${rwf(po.subtotal)} · VAT ${rwf(po.vat)} · Total ${rwf(po.total)}`,
    `Please quote ${po.no} on your invoice.`,
  ]);
