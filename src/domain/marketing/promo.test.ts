import { describe, expect, it } from "vitest";
import { checkPromo, promoDiscount, type Promo } from "./promo";

const p: Promo = { code: "LAUNCH", kind: "percent", value: 20, from: "2026-11-01", to: "2026-11-30", maxUses: 2, uses: 0, active: true };
describe("promo (F-CRM-20)", () => {
  it("checks window, cap and scope", () => {
    expect(checkPromo(p, "2026-11-10")).toEqual({ ok: true });
    expect(checkPromo(p, "2026-12-01")).toEqual({ ok: false, why: "expired" });
    expect(checkPromo({ ...p, uses: 2 }, "2026-11-10")).toEqual({ ok: false, why: "used_up" });
    expect(checkPromo({ ...p, services: ["tin"] }, "2026-11-10", "vat")).toEqual({ ok: false, why: "not_applicable" });
  });
  it("discount is capped at the base", () => {
    expect(promoDiscount(p, 50000)).toBe(10000);
    expect(promoDiscount({ ...p, kind: "amount", value: 90000 }, 50000)).toBe(50000);
  });
});
