import { describe, expect, it } from "vitest";
import { cashEscalated, confirmCash, decideExpense, expenseTotal, fieldShare, overCap, perVisitFee, withholding } from "./rules";

const H = 3600_000;
describe("expense machine", () => {
  const x = { state: "submitted" as const, claimant: "c", trail: [] };
  it("rejection requires a reason; claimant can't approve own", () => {
    expect(decideExpense(x, { level: 1, decision: "rejected", by: "sm" })).toEqual({ error: "reason_required" });
    expect(decideExpense(x, { level: 1, decision: "approved", by: "c" })).toEqual({ error: "sod_violation" });
  });
  it("level 1 then level 2 by a different person", () => {
    expect(decideExpense(x, { level: 1, decision: "approved", by: "sm" })).toEqual({ state: "sm_approved" });
    expect(decideExpense(x, { level: 2, decision: "approved", by: "f" })).toEqual({ error: "wrong_level" });
    const y = { state: "sm_approved" as const, claimant: "c", trail: [{ step: "sm" as const, byId: "sm" }] };
    expect(decideExpense(y, { level: 2, decision: "approved", by: "sm" })).toEqual({ error: "sod_violation" });
    expect(decideExpense(y, { level: 2, decision: "approved", by: "f" })).toEqual({ state: "finance_approved" });
  });
  it("totals skip rejected/withdrawn; moto cap", () => {
    expect(expenseTotal([{ amount: 5, state: "paid" }, { amount: 7, state: "rejected" }, { amount: 1, state: "queued" }])).toBe(6);
    expect(overCap("moto", 5_001)).toBe(true);
    expect(overCap("moto", 5_000)).toBe(false);
    expect(overCap("food", 99_999)).toBe(false);
  });
});

describe("cash", () => {
  const at = "2026-01-01T00:00:00Z", t0 = Date.parse(at);
  it("escalates unconfirmed cash after 48h", () => {
    expect(cashEscalated({ recordedAt: at, status: "deposited" }, t0 + 48 * H - 1)).toBe(false);
    expect(cashEscalated({ recordedAt: at, status: "deposited" }, t0 + 48 * H)).toBe(true);
    expect(cashEscalated({ recordedAt: at, status: "confirmed" }, t0 + 99 * H)).toBe(false);
  });
  it("needs two distinct confirmers at/above 500k", () => {
    expect(confirmCash({ amount: 100, status: "held" as never, confirmations: [] }, "a")).toEqual({ error: "not_deposited" });
    expect(confirmCash({ amount: 100, status: "deposited", confirmations: [] }, "a")).toEqual({ status: "confirmed", done: true });
    expect(confirmCash({ amount: 500_000, status: "deposited", confirmations: [] }, "a")).toEqual({ status: "deposited", done: false });
    const one = { amount: 500_000, status: "deposited" as const, confirmations: [{ by: "a", at }] };
    expect(confirmCash(one, "a")).toEqual({ error: "same_approver" });
    expect(confirmCash(one, "b")).toEqual({ status: "confirmed", done: true });
  });
});

describe("fees", () => {
  it("per-visit fee table override, field share, WHT external only", () => {
    expect(perVisitFee("x")).toBe(5_000);
    expect(perVisitFee("x", { x: 7_000 })).toBe(7_000);
    expect(fieldShare(10_000)).toBe(3_000);
    expect(withholding(10_000, true)).toBe(1_500);
    expect(withholding(10_000, false)).toBe(0);
  });
});
