// PRT rules (spec institutional-partners §7, §12): agreement lifecycle, health, commission.
export const PARTNER_TYPES = ["government", "bank", "mfi", "ngo", "embassy", "association", "vendor", "referral", "academic", "other"] as const;
export const AGREEMENT_KINDS = ["mou", "contract", "nda", "sla"] as const;
const DAY = 86_400_000;

/** Effective agreement state; "expiring" is derived (≤ 90 days to end) and never stored. */
export function agreementState(a: { status: string; endOn: string | null }, today: string): string {
  if (a.status !== "active" && a.status !== "renewed") return a.status;
  if (a.endOn && a.endOn < today) return "expired";
  if (a.endOn && Date.parse(a.endOn) - Date.parse(today) <= 90 * DAY) return "expiring";
  return "active";
}

/** Health: red = action overdue > 14 days or an expired agreement; amber = no contact for 90 days; else green. */
export function partnerHealth(
  p: { lastContactAt: string | null; createdAt: string },
  actions: { dueOn: string | null; status: string }[],
  agreements: { status: string; endOn: string | null }[],
  today: string,
): "green" | "amber" | "red" {
  const t = Date.parse(today);
  const overdue = actions.some((a) => a.dueOn && a.status !== "done" && a.status !== "cancelled" && t - Date.parse(a.dueOn) > 14 * DAY);
  const lapsed = agreements.length > 0 && agreements.every((a) => agreementState(a, today) === "expired");
  if (overdue || lapsed) return "red";
  if (t - Date.parse(p.lastContactAt ?? p.createdAt) > 90 * DAY) return "amber";
  return "green";
}

/** Commission in whole RWF, rounded down so HEBUZA never overpays. */
export const commissionOf = (base: number, bps: number) => Math.floor((base * bps) / 10_000);

/** Renewal reminder offsets (days before end_on) that fire on `today`. */
export const RENEWAL_OFFSETS = [90, 30, 7] as const;
export function renewalDue(endOn: string, today: string): number | null {
  const d = Math.round((Date.parse(endOn) - Date.parse(today)) / DAY);
  return (RENEWAL_OFFSETS as readonly number[]).includes(d) ? d : null;
}
