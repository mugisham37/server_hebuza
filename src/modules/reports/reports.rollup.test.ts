// F-RPT-07: daily facts match the fin.revenue / fin.collections definitions and stay inside the range.
import { expect, it } from "vitest";
import { dailyFacts } from "./reports.rollup";
import type { RCtx } from "./reports.engine";

it("buckets invoices, credit notes and payments by day", () => {
  const c = { data: {
    invs: [
      { no: "I1", status: "issued", issuedAt: "2026-11-01T09:00:00Z", totals: { total: 1180, vat: 180 } },
      { no: "I2", status: "draft", issuedAt: "2026-11-01T09:00:00Z", totals: { total: 999, vat: 0 } },
      { no: "I3", status: "issued", issuedAt: "2026-10-31T09:00:00Z", totals: { total: 50, vat: 0 } },
    ],
    cns: [{ issuedAt: "2026-11-01T10:00:00Z", totals: { total: -100 } }],
    pays: [
      { at: "2026-11-02T08:00:00Z", state: "confirmed", amountReceived: 1180, amountExpected: 1180 },
      { at: "2026-11-02T08:00:00Z", state: "failed", amountReceived: null, amountExpected: 500 },
    ],
  } } as unknown as RCtx;
  const f = dailyFacts(c, "2026-11-01", "2026-11-02");
  expect(f.get("2026-11-01")).toMatchObject({ invoiced: 1180, vat: 180, refunds: 100 });
  expect(f.get("2026-11-02")).toMatchObject({ collected: 1180, initiated: 2, failed: 1 });
  expect(f.has("2026-10-31")).toBe(false);
});
