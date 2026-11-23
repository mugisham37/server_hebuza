import { describe, expect, it } from "vitest";
import { demoLoginsEnabled } from "./platform.service";

describe("demoLoginsEnabled", () => {
  it("is on only for staging", () => {
    expect(demoLoginsEnabled({ RAILWAY_ENVIRONMENT_NAME: "staging" })).toBe(true);
    expect(demoLoginsEnabled({ ALLOW_SEED: "staging" })).toBe(true);
    expect(demoLoginsEnabled({ ALLOW_SEED: "staging", RAILWAY_ENVIRONMENT_NAME: "production" })).toBe(false);
    expect(demoLoginsEnabled({})).toBe(false);
  });
});
