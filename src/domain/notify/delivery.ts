// Notification delivery rules (NTF F-NTF-01/06/07/08/12/15): which external channels a notification goes out on,
// in what order, and when. Pure; the worker (notifications.jobs.ts) applies the plan and records each send.
import type { EventRuleVM } from "../system/types";

export type ExtChannel = "email" | "sms" | "whatsapp";
export const EXT_CHANNELS: readonly ExtChannel[] = ["email", "sms", "whatsapp"];
/** Same categories as the client preference matrix (web settings-channels.tsx). `security` is never muted. */
export type Category =
  | "requests"
  | "documents"
  | "payments"
  | "messages"
  | "deadlines"
  | "news"
  | "security";

const CATEGORY_PREFIX: [RegExp, Category][] = [
  [/^(auth|access|security)\b/, "security"],
  [/^(fin|payment|invoice|refund|receipt|quotation|offer)\b/, "payments"],
  [/^(document|deliverable|upload)\b/, "documents"],
  [/^(message|chat|mention|admin_reply|ticket)\b/, "messages"],
  [/^(deadline|obligation|compliance|cal)\b/, "deadlines"],
  [/^(mkt|news|campaign)\b/, "news"],
];
export const categoryOf = (kind: string): Category =>
  CATEGORY_PREFIX.find(([re]) => re.test(kind))?.[1] ?? "requests";

export type Quiet = { on: boolean; from: string; to: string };
export type Prefs = {
  email_enabled: boolean;
  matrix?: Record<string, Record<string, boolean>>;
  quiet?: Quiet;
};

/** Kigali is UTC+2 all year (no DST). */
const KIGALI_MS = 2 * 3600_000;
const mins = (hhmm: string) =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** End of the quiet window `now` falls in (Kigali wall clock), else null. Windows may wrap midnight (22:00–07:00). */
export function quietUntil(now: Date, q?: Quiet | null): Date | null {
  if (!q?.on || q.from === q.to) return null;
  const local = new Date(now.getTime() + KIGALI_MS);
  const m = local.getUTCHours() * 60 + local.getUTCMinutes();
  const from = mins(q.from),
    to = mins(q.to);
  const inside = from < to ? m >= from && m < to : m >= from || m < to;
  if (!inside) return null;
  const end = new Date(local);
  end.setUTCHours(Math.floor(to / 60), to % 60, 0, 0);
  if (end <= local) end.setUTCDate(end.getUTCDate() + 1);
  return new Date(end.getTime() - KIGALI_MS);
}

export type Plan = {
  /** Sent now, independently. */
  parallel: ExtChannel[];
  /** Ordered fallback: the first is sent; each next one only when the previous fails for good. */
  chain: ExtChannel[];
  /** Channels removed by the recipient's preferences (recorded as `skipped`). */
  muted: ExtChannel[];
  deferUntil: Date | null;
};

/** Rule (system console) decides the channels when one exists for the event, else the caller's list. Preferences
 *  then mute per category, except security events. Quiet hours defer unless the event is critical / rule says send. */
export function planDelivery(p: {
  kind: string;
  requested: readonly ExtChannel[];
  rule?: EventRuleVM | null;
  prefs: Prefs;
  now: Date;
}): Plan {
  const { rule, prefs } = p;
  const wanted = rule
    ? EXT_CHANNELS.filter((c) => rule.channels[c])
    : [...new Set(p.requested)];
  const cat = rule?.security ? "security" : categoryOf(p.kind);
  const allowed = (c: ExtChannel) =>
    cat === "security" ||
    (prefs.matrix?.[cat]?.[c] !== false &&
      (c !== "email" || prefs.email_enabled));
  const kept = wanted.filter(allowed);
  const chain = (rule?.chain ?? []).filter((c): c is ExtChannel =>
    kept.includes(c as ExtChannel),
  );
  const urgent =
    rule?.critical || rule?.quietHours === "send" || cat === "security";
  return {
    parallel: kept.filter((c) => !chain.includes(c)),
    chain,
    muted: wanted.filter((c) => !allowed(c)),
    deferUntil: urgent ? null : quietUntil(p.now, prefs.quiet),
  };
}

/** `{{name}}` substitution; unknown vars render empty (lint blocks undeclared vars at template save). */
export const renderTemplate = (s: string, vars: Record<string, string>) =>
  s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");

/** Same event to the same recipient on the same channel within this window is sent once (F-NTF-15). */
export const DEDUPE_WINDOW_MS = 10 * 60_000;
export const dedupeKey = (
  userId: string,
  kind: string,
  channel: ExtChannel,
  ref: string,
) => `${userId}:${kind}:${channel}:${ref}`.slice(0, 255);

/** PLACEHOLDER(channel-unit-cost) RWF per message until provider invoices give real rates. */
export const UNIT_COST_RWF: Record<ExtChannel, number> = {
  email: 0,
  sms: 15,
  whatsapp: 40,
};

/** Opt-out keywords (en/rw/fr) on an inbound SMS/WhatsApp reply (F-NTF-09). */
const STOP_WORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "hagarika",
  "reka",
  "arret",
  "arrêt",
  "arreter",
  "arrêter",
]);
export const isStopKeyword = (text: string) =>
  STOP_WORDS.has(
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}]/gu, ""),
  );
const START_WORDS = new Set(["start", "unstop", "tangira", "subscribe"]);
export const isStartKeyword = (text: string) =>
  START_WORDS.has(
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}]/gu, ""),
  );
