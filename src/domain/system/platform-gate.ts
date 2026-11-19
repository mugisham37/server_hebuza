// F-SET-11/12: API-wide maintenance read-only mode for clients/visitors and server-side feature flags. Pure.
import type { FlagKey } from "./settings-registry";

/** Route path (with /api prefix) → the flag that gates it. Admin config paths stay open so the module can be set up. */
export const FLAG_ROUTES: [RegExp, FlagKey][] = [
  [/^\/api\/assistant(\/|$)/, "ai_assistant"],
  [/^\/api\/(bookings|me\/bookings|agent\/bookings|agent\/availability|consultation-(types|requests|advisers))(\/|$)/, "consultation_booking"],
  [/^\/api\/(x_field\/(cash|payments)|finance\/cash)(\/|$)/, "field_cash"],
];
/** Writes clients may still make in maintenance: sign-in/out, webhooks, consent, health. */
const MAINT_OPEN = /^\/api\/(auth|webhooks|payments\/webhooks|consent)(\/|$)/;
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export type Window = { start: string; end: string } | null;
export const inMaintenance = (on: boolean, w: Window, now = Date.now()) =>
  on || (!!w && Date.parse(w.start) <= now && now < Date.parse(w.end));

export function platformGate(p: {
  method: string; path: string; staff: boolean; maintenance: boolean; flags: (k: FlagKey) => boolean;
}): { status: number; code: string } | null {
  const flag = FLAG_ROUTES.find(([re]) => re.test(p.path))?.[1];
  if (flag && !p.flags(flag)) return { status: 404, code: "feature_disabled" };
  if (p.maintenance && !p.staff && !SAFE.has(p.method) && !MAINT_OPEN.test(p.path)) return { status: 503, code: "maintenance" };
  return null;
}
