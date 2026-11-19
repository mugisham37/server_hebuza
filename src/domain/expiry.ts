// F-CAL-11: one expiry/renewal reminder rule for every module (worker contracts, supplier contracts, vault documents,
// obligations): remind on exact day offsets before the end date (Kigali calendar days), once per offset.
export const DEFAULT_EXPIRY_OFFSETS = [60, 30, 7, 0] as const;
/** Whole calendar days from `today` (YYYY-MM-DD) to `end` (ISO date or timestamp); negative when past. */
export const daysUntil = (end: string, today: string) => Math.round((Date.parse(end.slice(0, 10)) - Date.parse(today.slice(0, 10))) / 86_400_000);
/** The offset due today, or null. */
export const dueOffset = (end: string, today: string, offsets: readonly number[] = DEFAULT_EXPIRY_OFFSETS): number | null => {
  const d = daysUntil(end, today);
  return offsets.includes(d) ? d : null;
};
export const expiryTitle = (what: string, days: number) => (days > 0 ? `${what} ends in ${days} days` : days === 0 ? `${what} ends today` : `${what} ended ${-days} days ago`);
