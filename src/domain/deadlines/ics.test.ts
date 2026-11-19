import { expect, it } from "vitest";
import { obligationsIcs } from "./ics";

it("all-day events with escaped text", () => {
  const s = obligationsIcs([{ id: "o1", title: "VAT; Q4, return", dueDate: "2026-12-31", status: "upcoming" }], new Date("2026-11-19T00:00:00Z"));
  expect(s).toContain("DTSTART;VALUE=DATE:20261231");
  expect(s).toContain("DTEND;VALUE=DATE:20270101");
  expect(s).toContain("SUMMARY:VAT\\; Q4\\, return");
});
