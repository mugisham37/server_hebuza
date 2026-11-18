// Referral rules (plan 10 §2.9). Reward is display-only; Finance pays it out.
import type { ReferralState } from "@/domain/marketing/types";

type Party = { userId?: string; phone?: string; email?: string };
const same = (a: Party, b: Party) =>
  (!!a.userId && a.userId === b.userId) || (!!a.phone && a.phone === b.phone) || (!!a.email && a.email?.toLowerCase() === b.email?.toLowerCase());

/** State of a new referral at sign-up: self-referral and existing clients never earn a reward. */
export function classifyReferral(referrer: Party, referee: Party & { wasClient?: boolean }): ReferralState {
  if (same(referrer, referee)) return "rejected_self";
  if (referee.wasClient) return "ineligible";
  return "signed_up";
}
/** Reward owed: one per referee whose first request is paid (rewarded ones already settled). */
export function rewardDue(referrals: { refereeLabel: string; state: ReferralState }[], reward: number) {
  const paid = new Set(referrals.filter((r) => r.state === "paid").map((r) => r.refereeLabel));
  return paid.size * reward;
}
