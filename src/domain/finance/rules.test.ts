import { describe, expect, it } from "vitest";
import { canExecute, canSign, manualChain, refundChain, sign } from "./approvals";
import { applyPayment, depositSplit, docTotals, exceedsRefundable, refundSuggestion } from "./money";
import type { DocLine } from "./types";

const fin = (id: string) => ({ id, roles: ["staff:finance"] as const });
const exec = (id: string) => ({ id, roles: ["staff:executive"] as const });

describe("approval chains (4-eyes / SoD)", () => {
  it("manualChain scales with amount", () => {
    expect(manualChain(100_000).map((s) => s.role)).toEqual(["finance"]);
    expect(manualChain(500_000).map((s) => s.role)).toEqual(["finance", "finance_second"]);
    expect(manualChain(1_000_001).map((s) => s.role)).toEqual(["finance", "finance_second", "executive"]);
  });
  it("refundChain adds executive over limit or on destination change", () => {
    expect(refundChain(200_000).map((s) => s.role)).toEqual(["service_manager", "finance"]);
    expect(refundChain(200_001).at(-1)?.role).toBe("executive");
    expect(refundChain(1_000, { destinationChanged: true }).at(-1)?.reason).toBe("destinationChanged");
  });
  it("maker can never sign; one person signs at most one step", () => {
    let chain = manualChain(600_000);
    expect(canSign(chain, fin("maker"), ["maker"])).toEqual({ ok: false, reason: "same_approver" });
    expect(canSign(chain, exec("e1"))).toEqual({ ok: false, reason: "forbidden" });
    expect(canSign(chain, fin("f1"))).toEqual({ ok: true, index: 0 });
    chain = sign(chain, { id: "f1", name: "F1" }, "t");
    expect(canSign(chain, fin("f1"))).toEqual({ ok: false, reason: "same_approver" });
    expect(canSign(chain, fin("f2"))).toEqual({ ok: true, index: 1 });
    chain = sign(chain, { id: "f2", name: "F2" }, "t");
    expect(canSign(chain, fin("f3"))).toEqual({ ok: false, reason: "complete" });
    expect(canExecute(chain, fin("f1"))).toBe(false);
    expect(canExecute(chain, fin("f3"))).toBe(true);
  });
});

const lines: DocLine[] = [
  { kind: "service_fee", label: "Fee", qty: 1, unit: 100_000 },
  { kind: "discount", label: "Disc", qty: 1, unit: 10_000 },
  { kind: "government_fee", label: "Gov", qty: 1, unit: 50_000 },
];
describe("finance money", () => {
  it("docTotals: VAT only on taxable lines, discount negative", () => {
    expect(docTotals(lines)).toEqual({ subtotal: 90_000, vat: 16_200, passThrough: 50_000, total: 156_200, eligible: 90_000 });
  });
  it("deposit only at/above threshold", () => {
    expect(depositSplit(199_999)).toBeNull();
    expect(depositSplit(200_000)).toEqual({ deposit: 100_000, balance: 100_000 });
  });
  it("applyPayment: partial, exact, overpay → credit", () => {
    expect(applyPayment({ balanceDue: 100 }, 40)).toEqual({ applied: 40, credit: 0, status: "partially_paid" });
    expect(applyPayment({ balanceDue: 100 }, 150)).toEqual({ applied: 100, credit: 50, status: "paid" });
  });
  it("refund suggestion and refundable cap", () => {
    expect(refundSuggestion({ lines }, "in_progress")).toMatchObject({ eligiblePart: 45_000, vat: 8_100, passThrough: 0, total: 53_100 });
    expect(refundSuggestion({ lines }, "duplicate", undefined, false).total).toBe(156_200);
    expect(exceedsRefundable(100, 156_200, 156_100)).toBe(false);
    expect(exceedsRefundable(101, 156_200, 156_100)).toBe(true);
  });
});
