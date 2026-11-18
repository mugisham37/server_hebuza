import { describe, expect, it } from "vitest";
import { bandFee, bandsProblem, selectBand, type BandIn } from "./rules";

const bands: BandIn[] = [
  { min_amount_rwf: 0, max_amount_rwf: 1_000_000, fee_type: "flat", fee_rwf: 20_000 },
  { min_amount_rwf: 1_000_000, max_amount_rwf: null, fee_type: "percent", fee_percent: 2.5, min_fee_rwf: 30_000, max_fee_rwf: 100_000 },
];
describe("catalogue bands", () => {
  it("selectBand uses [min, max) regardless of input order", () => {
    expect(selectBand([...bands].reverse(), 999_999)).toBe(bands[0]);
    expect(selectBand(bands, 1_000_000)).toBe(bands[1]);
    expect(selectBand([bands[0]], 1_000_000)).toBeNull();
  });
  it("bandFee: flat, percent half-up, min/max clamps", () => {
    expect(bandFee(bands[0], 5)).toBe(20_000);
    expect(bandFee(bands[1], 2_000_000)).toBe(50_000);
    expect(bandFee(bands[1], 1_000_000)).toBe(30_000); // 25,000 → min
    expect(bandFee(bands[1], 10_000_000)).toBe(100_000); // 250,000 → max
    expect(bandFee({ min_amount_rwf: 0, fee_type: "percent", fee_percent: 1.5 }, 101)).toBe(2); // 1.515 → 2
    expect(bandFee({ min_amount_rwf: 0, fee_type: "percent", fee_percent: 0.5 }, 100)).toBe(1); // 0.5 → 1
  });
  it("bandsProblem accepts contiguous bands, rejects bad starts", () => {
    expect(bandsProblem(bands)).toBeNull();
    expect(bandsProblem([])).toMatch(/at least one/);
    expect(bandsProblem([{ ...bands[0], min_amount_rwf: 5 }])).toMatch(/start at 0/);
  });
});
