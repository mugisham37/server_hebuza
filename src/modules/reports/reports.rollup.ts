// F-RPT-07 pre-aggregation: daily finance facts. `dailyFacts` is pure over an RCtx; `factsBetween` serves a range
// from rpt_daily_facts for closed days and live records for today (or any closed day not rolled up yet).
import { and, gte, lte, sql } from "drizzle-orm";
import { rptDailyFacts } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { CONFIRMED, d10, issued, type RCtx } from "./reports.engine";
import { addDays, nowIso, today } from "./reports.store";

export const FACTS = [
  "invoiced",
  "vat",
  "collected",
  "refunds",
  "initiated",
  "failed",
] as const;
export type Fact = (typeof FACTS)[number];
export type DayFacts = Record<Fact, number>;
const zero = (): DayFacts => ({
  invoiced: 0,
  vat: 0,
  collected: 0,
  refunds: 0,
  initiated: 0,
  failed: 0,
});

/** Facts per day for days in [from, to] (same definitions as fin.revenue / fin.collections). */
export function dailyFacts(
  c: RCtx,
  from: string,
  to: string,
): Map<string, DayFacts> {
  const out = new Map<string, DayFacts>();
  const at = (d: string) => {
    const k = d10(d);
    if (k < from || k > to) return null;
    return out.get(k) ?? out.set(k, zero()).get(k)!;
  };
  for (const i of issued(c)) {
    const f = at(i.issuedAt!);
    if (f) {
      f.invoiced += i.totals.total;
      f.vat += i.totals.vat;
    }
  }
  for (const cn of c.data.cns) {
    const f = at(cn.issuedAt);
    if (f) f.refunds += Math.abs(cn.totals.total);
  }
  for (const p of c.data.pays) {
    const f = at(p.at);
    if (!f) continue;
    f.initiated += 1;
    if (CONFIRMED.has(p.state))
      f.collected += p.amountReceived ?? p.amountExpected;
    if (p.state === "failed" || p.state === "expired") f.failed += 1;
  }
  return out;
}

/** Upsert facts for every closed day in [from, to] (days with no activity get zero rows so reads know they are done). */
export async function writeRollup(db: Tx, c: RCtx, from: string, to: string) {
  const last = addDays(today(), -1);
  const end = to > last ? last : to;
  if (from > end) return { days: 0 };
  const facts = dailyFacts(c, from, end);
  const rows: (typeof rptDailyFacts.$inferInsert)[] = [];
  const at = nowIso();
  for (let d = from; d <= end; d = addDays(d, 1)) {
    const f = facts.get(d) ?? zero();
    for (const m of FACTS)
      rows.push({ day: d, metric: m, value: f[m], computedAt: at });
  }
  for (let i = 0; i < rows.length; i += 1000)
    await db
      .insert(rptDailyFacts)
      .values(rows.slice(i, i + 1000))
      .onConflictDoUpdate({
        target: [rptDailyFacts.day, rptDailyFacts.metric],
        set: {
          value: sql`excluded.value`,
          computedAt: sql`excluded.computed_at`,
        },
      });
  return { days: rows.length / FACTS.length };
}

/** Σ facts over [from, to]: rollup rows for closed days, live for today and any day not rolled up. */
export async function factsBetween(
  db: Tx,
  c: RCtx,
  from: string,
  to: string,
): Promise<DayFacts> {
  const rows = await db
    .select()
    .from(rptDailyFacts)
    .where(and(gte(rptDailyFacts.day, from), lte(rptDailyFacts.day, to)));
  const t = zero();
  const done = new Set<string>();
  for (const r of rows)
    if (r.day < today() && (FACTS as readonly string[]).includes(r.metric)) {
      t[r.metric as Fact] += r.value;
      done.add(r.day);
    }
  for (const [d, f] of dailyFacts(c, from, to))
    if (!done.has(d)) for (const m of FACTS) t[m] += f[m];
  return t;
}
