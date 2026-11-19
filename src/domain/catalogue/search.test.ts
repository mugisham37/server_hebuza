import { describe, expect, it } from "vitest";
import { facetsOf } from "./search";

const row = (category: string, fee: number | null, eta: number, engagement_type = "application") => ({
  category, from_fee: fee, engagement_type, delivery_mode: "online", turnaround_days_max: null, pricing_tiers: [{ isAvailable: true, etaBusinessDays: eta }],
});
const rows = [row("tax", 10000, 2), row("tax", 60000, 10), row("business", 30000, 5, "consultation")];

describe("facetsOf", () => {
  it("filters and counts each facet ignoring its own filter", () => {
    const r = facetsOf(rows, { category: "tax", max_price: 50000 });
    expect(r.results).toHaveLength(1);
    expect(r.facets.category).toEqual({ tax: 1, business: 1 }); // price filter applies, category doesn't
    expect(r.facets.price).toEqual({ "20000": 1, "100000": 1 }); // category filter applies, price doesn't
  });
  it("uses tier ETA when no turnaround is set", () => {
    expect(facetsOf(rows, { max_days: 5 }).results).toHaveLength(2);
    expect(facetsOf(rows, { engagement: "consultation" }).results.map((r) => r.category)).toEqual(["business"]);
  });
});
