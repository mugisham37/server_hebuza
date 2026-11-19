import { describe, expect, it } from "vitest";
import { agreementState, commissionOf, partnerHealth, renewalDue, reversalOf } from "./partners";

const today = "2026-06-01";
describe("partners", () => {
  it("agreement state", () => {
    expect(agreementState({ status: "active", endOn: "2026-05-01" }, today)).toBe("expired");
    expect(agreementState({ status: "active", endOn: "2026-07-01" }, today)).toBe("expiring");
    expect(agreementState({ status: "active", endOn: null }, today)).toBe("active");
    expect(agreementState({ status: "draft", endOn: null }, today)).toBe("draft");
  });
  it("health", () => {
    const p = { lastContactAt: "2026-05-20", createdAt: "2026-01-01" };
    expect(partnerHealth(p, [], [], today)).toBe("green");
    expect(partnerHealth({ ...p, lastContactAt: "2026-01-01" }, [], [], today)).toBe("amber");
    expect(partnerHealth(p, [{ dueOn: "2026-05-01", status: "open" }], [], today)).toBe("red");
  });
  it("commission + renewal", () => {
    expect(commissionOf(100_001, 250)).toBe(2500);
    expect(renewalDue("2026-07-01", today)).toBe(30);
    expect(renewalDue("2026-07-02", today)).toBeNull();
  });
});

describe("reversal", () => {
  it("proportional, capped", () => {
    expect(reversalOf(2500, 100_000, 50_000)).toBe(1250);
    expect(reversalOf(2500, 100_000, 200_000)).toBe(2500);
    expect(reversalOf(0, 100_000, 10)).toBe(0);
  });
});
