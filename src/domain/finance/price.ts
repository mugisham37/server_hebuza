// F-FIN-03 price calculator: the one server function turning service pricing + case answers into document lines.
// Units are ex-VAT; VAT is added per line by docTotals (only fee/surcharge/discount are taxable).
import { splitVat } from "@/domain/money";
import { urgentSurcharge } from "@/domain/catalogue/rules";
import type { Bps, DocLine, I18nText, Rwf } from "@/domain/finance/types";

export type PriceInput = {
  label: I18nText;
  /** Catalogue service fee as listed to clients (VAT-inclusive). */
  feeGross: Rwf;
  urgent?: { kind: string | null; value: number | null } | null;
  governmentFee?: Rwf;
  thirdParty?: { label: I18nText; amount: Rwf }[];
  /** Ex-VAT discount, entered positive. */
  discount?: Rwf;
  vatBps: Bps;
};

export function priceLines(p: PriceInput): DocLine[] {
  const fee = splitVat(Math.max(0, p.feeGross), p.vatBps).net;
  const lines: DocLine[] = [{ kind: "service_fee", label: p.label, qty: 1, unit: fee }];
  const sur = p.urgent ? urgentSurcharge(p.urgent.kind, p.urgent.value, fee) : 0;
  if (sur > 0) lines.push({ kind: "urgent_surcharge", label: { en: "Urgent surcharge", fr: "Supplément urgence", rw: "Inyongera y'ihutirwa" }, qty: 1, unit: sur });
  if (p.governmentFee) lines.push({ kind: "government_fee", label: { en: "Government fee", fr: "Frais publics", rw: "Amafaranga ya Leta" }, qty: 1, unit: p.governmentFee });
  for (const t of p.thirdParty ?? []) if (t.amount > 0) lines.push({ kind: "third_party_cost", label: t.label, qty: 1, unit: t.amount });
  // A discount never takes the taxable part below zero.
  const disc = Math.min(p.discount ?? 0, fee + sur);
  if (disc > 0) lines.push({ kind: "discount", label: { en: "Discount", fr: "Remise", rw: "Igabanywa" }, qty: 1, unit: disc });
  return lines;
}
