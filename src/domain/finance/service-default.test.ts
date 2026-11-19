import { describe, expect, it } from "vitest";
import { withServiceDefault } from "./rules";
import type { Rule } from "./types";

const rule = (scope: Rule["scope"]) => ({ id: `r-${scope}`, scope, agentPct: 3000 }) as Rule;
describe("withServiceDefault (F-CAT-12)", () => {
  it("overrides agent/global rules only", () => {
    expect(withServiceDefault(rule("global"), "tin", 4000)).toEqual({ agentPct: 4000, ruleId: "catalogue:tin" });
    expect(withServiceDefault(rule("agent"), "tin", 4000).agentPct).toBe(4000);
    expect(withServiceDefault(rule("service"), "tin", 4000)).toEqual({ agentPct: 3000, ruleId: "r-service" });
    expect(withServiceDefault(rule("global"), "tin", null).agentPct).toBe(3000);
  });
});
