// REQ-17: a case follows its refund request: refund_requested while open, refunded once paid out,
// back to the status it had when the request was declined. Called by finance in the refund's own tx.
import { and, eq } from "drizzle-orm";
import { applicationStatusHistory, applications } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { generateId } from "../../core/db/ids";
import { statusEffects } from "./status-effects";

export async function refundCaseStatus(db: Tx, caseRef: string | undefined, event: "requested" | "refunded" | "declined", note?: string) {
  if (!caseRef) return;
  const [a] = await db.select({ id: applications.applicationId, status: applications.status, prev: applications.statusBeforeRefund }).from(applications)
    .where(eq(applications.code, caseRef)).for("update");
  if (!a) return;
  const to = event === "requested" ? (["completed_delivered", "cancelled"].includes(a.status) ? "refund_requested" : null)
    : a.status !== "refund_requested" ? null
    : event === "refunded" ? "refunded" : a.prev ?? "completed_delivered";
  if (!to) return;
  const ts = new Date().toISOString();
  await db.update(applications).set({
    status: to, updatedAt: ts, ...statusEffects(to),
    statusBeforeRefund: event === "requested" ? a.status : null,
  }).where(and(eq(applications.applicationId, a.id), eq(applications.status, a.status)));
  await db.insert(applicationStatusHistory).values({ id: generateId("ash"), applicationId: a.id, status: to, changedBy: null, changedByRole: "system", note: note ?? `Refund ${event}`, createdAt: ts });
}
