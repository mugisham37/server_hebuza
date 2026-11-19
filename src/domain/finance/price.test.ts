import { describe, expect, it } from "vitest";
import { docTotals } from "./money";
import { priceLines } from "./price";

describe("priceLines (F-FIN-03)", () => {
  it("spec worked example: fee 50k ex-VAT, urgent 20%, disbursement 10k → 80,800, eligible 60,000", () => {
    const lines = priceLines({ label: "Company registration", feeGross: 59_000, urgent: { kind: "percent", value: 20 }, thirdParty: [{ label: "Notary", amount: 10_000 }], vatBps: 1800 });
    expect(lines.map((l) => l.kind)).toEqual(["service_fee", "urgent_surcharge", "third_party_cost"]);
    expect(docTotals(lines, 1800)).toMatchObject({ subtotal: 60_000, vat: 10_800, passThrough: 10_000, total: 80_800, eligible: 60_000 });
  });
  it("government fee passes through; discount is capped at the taxable part", () => {
    const lines = priceLines({ label: "x", feeGross: 11_800, governmentFee: 5_000, discount: 50_000, vatBps: 1800 });
    expect(docTotals(lines, 1800)).toMatchObject({ subtotal: 0, vat: 0, passThrough: 5_000, total: 5_000 });
  });
  it("no surcharge when the case is not urgent or the service has none", () => {
    expect(priceLines({ label: "x", feeGross: 1_180, urgent: { kind: null, value: null }, vatBps: 1800 })).toHaveLength(1);
  });
});
