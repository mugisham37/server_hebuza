import { expect, it } from "vitest";
import { daysUntil, dueOffset, expiryTitle } from "./expiry";

it("expiry offsets", () => {
  expect(daysUntil("2026-12-19", "2026-11-19")).toBe(30);
  expect(dueOffset("2026-12-19T10:00:00Z", "2026-11-19")).toBe(30);
  expect(dueOffset("2026-12-18", "2026-11-19")).toBeNull();
  expect(dueOffset("2026-11-19", "2026-11-19")).toBe(0);
  expect(expiryTitle("NDA", 7)).toBe("NDA ends in 7 days");
});
