// Marketing report maths (plan 10 §2.4, §2.5). Integers RWF; percentages are display-only, never stored.
export type FunnelStep = { key: "visits" | "leads" | "consultations" | "requests" | "paid"; count: number };

/** Step-to-step % (1 dp) and share of visits; first step has no step %. */
export function funnelRates(steps: FunnelStep[]) {
  const top = steps[0]?.count ?? 0;
  return steps.map((s, i) => ({
    ...s,
    stepPct: i === 0 ? null : pct(s.count, steps[i - 1].count),
    ofVisits: pct(s.count, top),
  }));
}
export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** ROI % to 1 dp; cost 0 → null (UI shows "—"). (365,000 − 57,780) / 57,780 = 531.7 */
export const roi = (revenue: number, cost: number) => (cost > 0 ? Math.round(((revenue - cost) / cost) * 1000) / 10 : null);
/** Cost per lead, half-up to the franc. 120,000 / 812 = 148 */
export const cpl = (cost: number, leads: number) => (leads > 0 ? Math.floor(cost / leads + 0.5) : null);
/** NPS = %promoters(9–10) − %detractors(0–6), integer. */
export function nps(scores: number[]) {
  if (!scores.length) return null;
  const p = scores.filter((s) => s >= 9).length, d = scores.filter((s) => s <= 6).length;
  return Math.round(((p - d) / scores.length) * 100);
}
export const avgRating = (stars: number[]) => (stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10 : null);

/** RFC 4180 CSV with a UTF-8 BOM so Excel opens rw/fr text correctly. */
export function toCsv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

// Self-check of the spec worked examples (runs once at import; cheap).
if (process.env.NODE_ENV !== "production") {
  const ok = roi(365_000, 57_780) === 531.7 && cpl(120_000, 812) === 148 && nps([...Array(60).fill(10), ...Array(32).fill(8), ...Array(8).fill(3)]) === 52
    && toCsv([["a,b", 'x"y']]) === '﻿"a,b","x""y"' && funnelRates([{ key: "visits", count: 24_820 }, { key: "leads", count: 3_120 }])[1].stepPct === 12.6;
  if (!ok) console.error("reports.ts self-check failed");
}
