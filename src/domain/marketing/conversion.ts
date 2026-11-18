// Conversion rule (plan 10 §2.4): match an open lead by phone then email; >1 match → needs merge; won on first paid invoice.
import { normEmail } from "./dedupe";
import type { Lead, PaidInvoice } from "@/domain/marketing/types";
import { isOpen } from "./lead-machine";

export type Match = { mode: "none" } | { mode: "single"; lead: Lead; by: "phone" | "email" | "both" } | { mode: "needs_merge"; leads: Lead[] };
export function matchLead(person: { phoneE164?: string; email?: string }, leads: Lead[]): Match {
  const open = leads.filter((l) => isOpen(l.stage));
  const byPhone = person.phoneE164 ? open.filter((l) => l.phoneE164 === person.phoneE164) : [];
  const byEmail = person.email ? open.filter((l) => normEmail(l.email) === normEmail(person.email)) : [];
  const hits = byPhone.length ? byPhone : byEmail;
  if (!hits.length) return { mode: "none" };
  if (hits.length > 1) return { mode: "needs_merge", leads: hits };
  const both = byPhone.length && byEmail.some((l) => l.id === hits[0].id);
  return { mode: "single", lead: hits[0], by: both ? "both" : byPhone.length ? "phone" : "email" };
}
/** Revenue attributed to a converted client: Σ paid invoice totals (integers RWF). */
export const revenueOf = (clientId: string | undefined, paid: PaidInvoice[]) => (clientId ? paid.filter((i) => i.clientId === clientId).reduce((s, i) => s + i.total, 0) : 0);
export const isWon = (clientId: string | undefined, paid: PaidInvoice[]) => !!clientId && paid.some((i) => i.clientId === clientId);
