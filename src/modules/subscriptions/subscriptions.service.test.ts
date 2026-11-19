import { describe, expect, it } from "vitest";
import { lapseTo } from "./subscriptions.service";

const D = 86_400_000;
const end = Date.parse("2027-03-31T00:00:00Z");
const at = (days: number) => end + days * D;
const sub = (status: string, cancelAtPeriodEnd = false) => ({ status, currentPeriodEnd: new Date(end).toISOString(), cancelAtPeriodEnd });

describe("lapseTo (F-SUB-06/07)", () => {
  it("nothing happens inside the period", () => expect(lapseTo(sub("active"), at(-1))).toBeNull());
  it("unpaid active → past_due, then expired after 7 days of grace", () => {
    expect(lapseTo(sub("active"), at(1))).toBe("past_due");
    expect(lapseTo(sub("past_due"), at(6))).toBeNull();
    expect(lapseTo(sub("past_due"), at(8))).toBe("expired");
  });
  it("cancel at period end → cancelled; trial → expired", () => {
    expect(lapseTo(sub("active", true), at(1))).toBe("cancelled");
    expect(lapseTo(sub("trial"), at(1))).toBe("expired");
  });
});
