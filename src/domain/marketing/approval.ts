// Campaign approval rules (spec CRM, D-03, D-10). Pure.
import { MKT_POLICY } from "@/domain/policy";
import type { Staff } from "@/domain/marketing/types";

export const approvalNeeded = (recipients: number, est: number, overBudget = false) =>
  recipients > MKT_POLICY.approvalRecipients || est > MKT_POLICY.approvalCost || overBudget;
export type ApproveCheck = { ok: true } | { ok: false; reason: "self" | "role" };
/** Marketing (not the creator) or an executive. */
export function canApprove(by: Staff | null, createdBy: string): ApproveCheck {
  if (!by || (by.role !== "marketing" && by.role !== "executive")) return { ok: false, reason: "role" };
  return by.id === createdBy ? { ok: false, reason: "self" } : { ok: true };
}
