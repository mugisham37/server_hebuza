import { describe, expect, it } from "vitest";
import { ineligibleReason, type Agent } from "./ranking";

const a: Agent = { id: "a", name: "A", services: ["s"], skills: {}, load: 0, cap: 3, onTime: 1, rating: 5, languages: [] };
const c = { service: "s", clientId: "c" };
describe("ineligibleReason", () => {
  it("eligible", () => expect(ineligibleReason(c, a, "2026-01-10")).toBeNull());
  it("leave / clearance / authorisation / contract", () => {
    expect(ineligibleReason(c, { ...a, onLeaveUntil: "2026-01-12" }, "2026-01-10")).toBe("onLeave");
    expect(ineligibleReason(c, { ...a, cleared: false }, "2026-01-10")).toBe("notCleared");
    expect(ineligibleReason({ ...c, service: "x" }, a, "2026-01-10")).toBe("notAuthorised");
    expect(ineligibleReason(c, { ...a, contractUntil: "2026-01-01" }, "2026-01-10")).toBe("contractExpired");
  });
});
