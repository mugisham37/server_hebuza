import { describe, expect, it } from "vitest";
import { addVat, applyBps, payout, splitVat, withinTolerance } from "./money";
import { roundHalfUp } from "./finance/money";

describe("money", () => {
  it("applyBps rounds half away from zero, symmetric", () => {
    expect(applyBps(10_000, 1800)).toBe(1800);
    expect(applyBps(25, 2000)).toBe(5);
    expect(applyBps(5, 1000)).toBe(1); // 0.5 → 1
    expect(applyBps(-5, 1000)).toBe(-1);
    expect(applyBps(0, 1800)).toBe(0);
  });
  it("roundHalfUp is symmetric", () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4)).toBe(2);
  });
  it("splitVat/addVat roundtrip and net+vat = gross", () => {
    expect(splitVat(118_000)).toEqual({ net: 100_000, vat: 18_000 });
    expect(addVat(100_000)).toBe(118_000);
    for (const g of [1, 99, 12_345, 999_999]) {
      const { net, vat } = splitVat(g);
      expect(net + vat).toBe(g);
    }
  });
  it("tolerance is max(2%, 5000)", () => {
    expect(withinTolerance(100_000, 95_000)).toBe(true);
    expect(withinTolerance(100_000, 94_999)).toBe(false);
    expect(withinTolerance(1_000_000, 980_000)).toBe(true);
    expect(withinTolerance(1_000_000, 979_999)).toBe(false);
  });
  it("payout: WHT then licence for external; negative carried forward", () => {
    expect(payout({ gross: 100_000, shareBps: 3000, external: false })).toEqual({ share: 30_000, wht: 0, licence: 0, net: 30_000, carryForward: 0 });
    expect(payout({ gross: 100_000, shareBps: 3000, external: true, licence: 500 })).toMatchObject({ wht: 4_500, net: 25_000 });
    expect(payout({ gross: 0, shareBps: 3000, external: true, licence: 500 })).toMatchObject({ net: 0, carryForward: -500 });
  });
});
