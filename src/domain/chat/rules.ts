// Chat rules (MSG F-MSG-05/13/15/18). Pure.
import { z } from "zod";
import { POLICY } from "../policy";

// ---- F-MSG-18: the client lane turns read-only 30 days after the case closes; a new message goes to support.
export const CLIENT_LANE_GRACE_DAYS = 30;
export const clientLaneReadOnly = (closedAt: string | null | undefined, now = Date.now()) =>
  !!closedAt && now - Date.parse(closedAt) > CLIENT_LANE_GRACE_DAYS * 86_400_000;

// ---- F-MSG-05: typed cards. Each kind has a payload shape and (for some) a client action.
const ref = z.string().min(1).max(64);
export const CARD_SCHEMAS = {
  appointment: z.object({ title: z.string().max(200), start: z.string(), end: z.string().optional(), location: z.string().max(200).optional() }).loose(),
  payment_request: z.object({ title: z.string().max(200), amount_rwf: z.number().int().positive(), invoice_ref: ref.optional(), href: z.string().max(512).optional() }),
  document_request: z.object({ title: z.string().max(200), requirement_key: z.string().max(128), note: z.string().max(1000).optional() }),
  quotation: z.object({ title: z.string().max(200), quote_ref: ref, amount_rwf: z.number().int().positive(), valid_until: z.string().optional() }),
  deliverable_ready: z.object({ title: z.string().max(200), deliverable_id: ref }),
  visit_checkin: z.object({ title: z.string().max(200), visit_id: ref, at: z.string(), location: z.string().max(200).optional() }),
} as const;
export type CardKind = keyof typeof CARD_SCHEMAS;
export const CARD_ACTIONS: Partial<Record<CardKind, readonly string[]>> = { quotation: ["accept", "decline"] };

export function parseCard(kind: string, payload: unknown): { kind: CardKind; payload: Record<string, unknown> } | { error: string } {
  const s = CARD_SCHEMAS[kind as CardKind];
  if (!s) return { error: "unknown_card" };
  const r = s.safeParse(payload);
  return r.success ? { kind: kind as CardKind, payload: r.data as Record<string, unknown> } : { error: "invalid_card" };
}

// ---- F-MSG-13: first-response SLA for support enquiries, counted in business hours (Mon–Fri, Kigali).
/** PLACEHOLDER(support-first-response-minutes) business minutes until a first staff reply is due. */
export const FIRST_RESPONSE_MIN = 120;
/** Escalation chain: each level fires when the previous level's window also passes without a reply. */
export const ESCALATION_CHAIN = ["staff:service_manager", "staff:executive"] as const;
const KIGALI_MS = 2 * 3600_000;

/** `minutes` business minutes after `from` (business hours POLICY.businessHours, weekends skipped). */
export function addBusinessMinutes(from: Date, minutes: number, hours: readonly [number, number] = POLICY.businessHours): Date {
  const [open, close] = hours;
  let t = new Date(from.getTime() + KIGALI_MS); // Kigali wall clock in UTC fields
  let left = minutes;
  for (let guard = 0; guard < 400 && left > 0; guard++) {
    const day = t.getUTCDay(), h = t.getUTCHours() + t.getUTCMinutes() / 60;
    if (day === 0 || day === 6 || h >= close) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, open));
      continue;
    }
    if (h < open) { t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), open)); continue; }
    const step = Math.min(left, Math.round((close - h) * 60));
    t = new Date(t.getTime() + step * 60_000);
    left -= step;
  }
  return new Date(t.getTime() - KIGALI_MS);
}
/** Level due now (0 = none) given when the SLA started and the current level. */
export const escalationDue = (slaDueAt: string, level: number, now: Date, hours: readonly [number, number] = POLICY.businessHours) => {
  if (level >= ESCALATION_CHAIN.length) return null;
  const due = level === 0 ? new Date(slaDueAt) : addBusinessMinutes(new Date(slaDueAt), FIRST_RESPONSE_MIN * level, hours);
  return now >= due ? level + 1 : null;
};

// ---- F-MSG-15: retention.
/** PLACEHOLDER(chat-retention-years) spec setting chat_retention_years. */
export const CHAT_RETENTION_YEARS = 7;
export const retentionExpired = (closedAt: string | null, legalHold: boolean, now = Date.now()) =>
  !legalHold && !!closedAt && now - Date.parse(closedAt) > CHAT_RETENTION_YEARS * 365.25 * 86_400_000;

/** F-SET-05: business hours from the console settings (start < end, else the policy default). */
export const businessHours = (start: unknown, end: unknown): readonly [number, number] =>
  Number.isInteger(start) && Number.isInteger(end) && (start as number) < (end as number) ? [start as number, end as number] : POLICY.businessHours;
