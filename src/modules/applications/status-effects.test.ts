import { describe, expect, it } from "vitest";
import { statusEffects } from "./status-effects";

describe("statusEffects", () => {
  it("pauses on a pausesSla status", () => expect(Object.keys(statusEffects("on_hold"))).toEqual(["slaPausedAt"]));
  it("resumes elsewhere", () => expect(statusEffects("in_progress")).toMatchObject({ slaPausedAt: null }));
  it("freezes the completion record", () => expect(statusEffects("completed_delivered")).toHaveProperty("completionRecord"));
});
