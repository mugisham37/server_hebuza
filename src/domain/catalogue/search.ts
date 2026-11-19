// F-CAT-06 catalogue facets: filter + per-facet counts over public service summaries.
export type SearchIn = { q?: string; category?: string; max_price?: number; max_days?: number; engagement?: string; mode?: string };
type Row = {
  category: string;
  from_fee?: number | null;
  engagement_type: string;
  delivery_mode?: string | null;
  turnaround_days_max?: number | null;
  pricing_tiers: { isAvailable: boolean; etaBusinessDays: number }[];
};
export const daysOf = (s: Row) =>
  s.turnaround_days_max ?? Math.min(99, ...s.pricing_tiers.filter((t) => t.isAvailable).map((t) => t.etaBusinessDays));
const tally = (xs: (string | null | undefined)[]) =>
  xs.reduce<Record<string, number>>((m, k) => (k && (m[k] = (m[k] ?? 0) + 1), m), {});
const band = (n: number | null | undefined, edges: number[]) => (n == null ? null : String(edges.find((e) => n <= e) ?? "more"));

/** Each facet counts over the rows matching every *other* filter, so choosing one value never zeroes its siblings. */
export function facetsOf<T extends Row>(rows: T[], f: SearchIn) {
  const ok = (s: T, skip?: keyof SearchIn) =>
    (skip === "category" || !f.category || s.category === f.category) &&
    (skip === "max_price" || !f.max_price || (s.from_fee != null && s.from_fee <= f.max_price)) &&
    (skip === "max_days" || !f.max_days || daysOf(s) <= f.max_days) &&
    (skip === "engagement" || !f.engagement || s.engagement_type === f.engagement) &&
    (skip === "mode" || !f.mode || s.delivery_mode === f.mode);
  const by = (skip: keyof SearchIn, key: (s: T) => string | null | undefined) => tally(rows.filter((s) => ok(s, skip)).map(key));
  return {
    results: rows.filter((s) => ok(s)),
    facets: {
      category: by("category", (s) => s.category),
      engagement_type: by("engagement", (s) => s.engagement_type),
      delivery_mode: by("mode", (s) => s.delivery_mode),
      price: by("max_price", (s) => band(s.from_fee, [20000, 50000, 100000])),
      turnaround: by("max_days", (s) => band(daysOf(s), [3, 7, 14])),
    },
  };
}
