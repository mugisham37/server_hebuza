import { expect, it } from "vitest";
import { addBusinessMinutes, clientLaneReadOnly, escalationDue, parseCard, retentionExpired } from "./rules";

it("business minutes skip nights and weekends", () => {
  // Fri 16:00 Kigali (14:00Z) + 120 → Mon 09:00 Kigali (07:00Z)
  expect(addBusinessMinutes(new Date("2026-11-20T14:00:00Z"), 120).toISOString()).toBe("2026-11-23T07:00:00.000Z");
  expect(addBusinessMinutes(new Date("2026-11-19T08:00:00Z"), 60).toISOString()).toBe("2026-11-19T09:00:00.000Z");
});
it("escalation chain", () => {
  const due = "2026-11-19T08:00:00.000Z";
  expect(escalationDue(due, 0, new Date("2026-11-19T07:00:00Z"))).toBeNull();
  expect(escalationDue(due, 0, new Date("2026-11-19T08:00:00Z"))).toBe(1);
  expect(escalationDue(due, 2, new Date("2027-01-01T00:00:00Z"))).toBeNull();
});
it("lane, cards, retention", () => {
  expect(clientLaneReadOnly("2026-10-01T00:00:00Z", Date.parse("2026-11-19T00:00:00Z"))).toBe(true);
  expect(clientLaneReadOnly(null)).toBe(false);
  expect(parseCard("quotation", { title: "Q", quote_ref: "Q1", amount_rwf: 5000 })).toMatchObject({ kind: "quotation" });
  expect(parseCard("quotation", { title: "Q" })).toEqual({ error: "invalid_card" });
  expect(retentionExpired("2010-01-01T00:00:00Z", true)).toBe(false);
  expect(retentionExpired("2010-01-01T00:00:00Z", false)).toBe(true);
});
