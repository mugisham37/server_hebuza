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

import { addPeriod } from "./subscriptions.service";
describe("addPeriod (F-SUB-11)", () => {
  it("clamps month end in Kigali time and adds a year", () => {
    expect(addPeriod("2027-01-30T22:00:00.000Z", "month")).toBe("2027-02-27T22:00:00.000Z"); // Jan 31 00:00 Kigali → Feb 28
    expect(addPeriod("2027-03-15T10:00:00.000Z", "year")).toBe("2028-03-15T10:00:00.000Z");
  });
});
