import { describe, expect, it } from "vitest";
import { lapseTo } from "./subscriptions.service";

const D = 86_400_000, end = "2027-03-31T00:00:00.000Z", t = Date.parse(end);
const s = (status: string, cancelAtPeriodEnd = false) => ({ status, currentPeriodEnd: end, cancelAtPeriodEnd });

describe("lapseTo (F-SUB-06/07)", () => {
  it("stays put inside the period", () => expect(lapseTo(s("active"), t - D)).toBeNull());
  it("active → past_due, then expired after 7 days grace", () => {
    expect(lapseTo(s("active"), t + D)).toBe("past_due");
    expect(lapseTo(s("past_due"), t + 6 * D)).toBeNull();
    expect(lapseTo(s("past_due"), t + 8 * D)).toBe("expired");
  });
  it("cancel at period end → cancelled; trial → expired", () => {
    expect(lapseTo(s("active", true), t + 1)).toBe("cancelled");
    expect(lapseTo(s("trial"), t + 1)).toBe("expired");
  });
});
