import { describe, expect, it } from "vitest";
import { estimateFee } from "../../modules/assistant/assistant.engine";

const tier = { tier: "standard", label: "Standard", fee: 20000, governmentFee: 5000, eta: "", etaBusinessDays: 3, includes: [], isAvailable: true };
describe("estimateFee (F-AIA-04)", () => {
  it("fixed: totals per available tier", () => {
    expect(estimateFee({ pricing_mode: "fixed", pricing_tiers: [tier], price_bands: [] } as never)).toMatchObject({ mode: "fixed", tiers: [{ totalRwf: 25000 }] });
  });
  it("range: band fee with clamp; asks for amount", () => {
    const s = { pricing_mode: "range", pricing_tiers: [], price_bands: [{ min_amount_rwf: 0, max_amount_rwf: null, fee_type: "percent", fee_percent: 1, min_fee_rwf: 50000, max_fee_rwf: null }] } as never;
    expect(estimateFee(s)).toMatchObject({ mode: "range" });
    expect(estimateFee(s, 1_000_000)).toMatchObject({ platformFeeRwf: 50000 });
    expect(estimateFee(s, 10_000_000)).toMatchObject({ platformFeeRwf: 100000 });
  });
});
