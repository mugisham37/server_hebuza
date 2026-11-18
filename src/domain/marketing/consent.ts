// Send eligibility (plan 10 §2.7, NTF consent rules). Pure. Run when the audience is built AND again at send time.
// Contact.consent holds the latest ledger row per channel (latest row wins); "unknown" never counts as consent.
import type { Channel, Contact, ExcludedReason, Locale } from "@/domain/marketing/types";
import { MKT_POLICY } from "@/domain/policy";

export type Eligibility = { eligible: Contact[]; excluded: Record<ExcludedReason, number> };
export function eligibility(contacts: Contact[], o: { channel: Channel; sentThisWeek?: Record<string, number>; languages?: Locale[]; fallback?: boolean }): Eligibility {
  const excluded: Record<ExcludedReason, number> = { no_consent: 0, opted_out: 0, suppressed: 0, freq_cap: 0, no_address: 0, no_content: 0 };
  const eligible: Contact[] = [];
  for (const c of contacts) {
    const state = c.consent[o.channel];
    const reason: ExcludedReason | null =
      state === "out" ? "opted_out" : state !== "in" ? "no_consent" : c.suppressed ? "suppressed"
      : (o.channel === "email" ? !c.email : !c.phoneE164) ? "no_address"
      : (o.sentThisWeek?.[c.id] ?? 0) >= MKT_POLICY.frequencyCap ? "freq_cap"
      : o.languages && !o.fallback && !o.languages.includes(c.language) ? "no_content" : null;
    if (reason) excluded[reason]++; else eligible.push(c);
  }
  return { eligible, excluded };
}
export const excludedTotal = (e: Partial<Record<ExcludedReason, number>>) => Object.values(e).reduce((a, b) => a + (b ?? 0), 0);
