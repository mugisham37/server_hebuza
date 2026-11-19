import { describe, expect, it } from "vitest";
import { slaStepsReached, slaUsedPct } from "./rules";

describe("SLA escalation", () => {
  it("is pause-aware", () => {
    // 10 h SLA + 2 h paused → deadline at 12 h; at 10 h wall-clock 8 h worked = 80 %.
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    expect(slaUsedPct("2026-01-01T00:00:00Z", "2026-01-01T12:00:00Z", 2 * 3_600_000, t0 + 10 * 3_600_000)).toBe(80);
  });
  it("steps", () => expect(slaStepsReached(120)).toEqual([80, 100]));
});
