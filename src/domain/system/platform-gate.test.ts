import { expect, it } from "vitest";
import { inMaintenance, platformGate } from "./platform-gate";

const g = (o: Partial<Parameters<typeof platformGate>[0]>) =>
  platformGate({ method: "POST", path: "/api/applications", staff: false, maintenance: false, flags: () => true, ...o });

it("maintenance blocks client writes only", () => {
  expect(g({ maintenance: true })?.code).toBe("maintenance");
  expect(g({ maintenance: true, method: "GET" })).toBeNull();
  expect(g({ maintenance: true, staff: true })).toBeNull();
  expect(g({ maintenance: true, path: "/api/auth/login" })).toBeNull();
});
it("flags gate their routes", () => {
  expect(g({ path: "/api/assistant/sessions", flags: () => false })?.code).toBe("feature_disabled");
  expect(g({ path: "/api/admin/assistant/kb", flags: () => false })).toBeNull();
});
it("scheduled window", () => {
  const w = { start: "2026-11-19T10:00:00Z", end: "2026-11-19T12:00:00Z" };
  expect(inMaintenance(false, w, Date.parse("2026-11-19T11:00:00Z"))).toBe(true);
  expect(inMaintenance(false, w, Date.parse("2026-11-19T13:00:00Z"))).toBe(false);
});
