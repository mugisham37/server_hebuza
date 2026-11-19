// PRT §12: a refund on a referred case reverses the partner commission in proportion to the refunded amount.
// Called by finance in the refund's own tx (finance.refunds), so the reversal exists iff the refund commits.
import { eq } from "drizzle-orm";
import { applications, partnerCommissions } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { upsertPayable } from "../finance/finance.cases";
import { reversalOf } from "@/domain/partners/partners";

export async function reversePartnerCommission(db: Tx, caseRef: string, refunded: number) {
  const [a] = await db.select({ id: applications.applicationId }).from(applications).where(eq(applications.code, caseRef));
  if (!a) return;
  const [c] = await db.select().from(partnerCommissions).where(eq(partnerCommissions.applicationId, a.id)).for("update");
  if (!c || c.status === "rejected" || c.status === "reversed") return;
  const cut = reversalOf(c.amount - c.reversedAmount, c.baseAmount, refunded);
  if (cut <= 0) return;
  const left = c.amount - c.reversedAmount - cut;
  const full = left <= 0;
  const at = new Date().toISOString();
  // Not yet approved: just lower (or drop) the figure finance will see; otherwise record what was taken back.
  const patch = c.status === "computed"
    ? (full ? { status: "rejected" } : { amount: c.amount - cut })
    : { reversedAmount: c.reversedAmount + cut, ...(full && { status: "reversed" }) };
  await db.update(partnerCommissions).set({
    ...patch,
    note: [c.note, `Refund on ${caseRef}: −${cut} RWF`].filter(Boolean).join(" · "),
  }).where(eq(partnerCommissions.id, c.id));
  if (c.status === "approved")
    // Not paid yet: shrink (or cancel) the finance payable.
    await upsertPayable(db, { id: `prtcom_${c.id}`, source: "partner_commission", payee: c.partnerId, amount: Math.max(0, left), memo: `Partner commission (reduced by refund on ${caseRef})`, status: full ? "cancelled" : "due", at: c.createdAt });
  if (c.status === "paid")
    // Already paid out: a claw-back line finance recovers from the partner.
    await upsertPayable(db, { id: `prtrev_${c.id}_${at}`, source: "partner_commission", payee: c.partnerId, amount: -cut, memo: `Claw-back: refund on ${caseRef}`, status: "due", at });
}
