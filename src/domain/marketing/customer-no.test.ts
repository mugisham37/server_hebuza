import { describe, expect, it } from "vitest";
import { customerNo, isCustomerNo, luhnDigit } from "./customer-no";

describe("customer no", () => {
  it("luhn", () => { expect(luhnDigit("7992739871")).toBe(3); });
  it("format + verify", () => {
    const c = customerNo(2026, 123);
    expect(c).toMatch(/^HBC-2026-000123-\d$/);
    expect(isCustomerNo(c)).toBe(true);
    expect(isCustomerNo(c.slice(0, -1) + ((Number(c.at(-1)) + 1) % 10))).toBe(false);
  });
});
