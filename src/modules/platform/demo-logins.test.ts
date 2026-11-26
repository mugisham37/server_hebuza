import { describe, expect, it } from "vitest";
import { demoLoginsEnabled } from "./platform.service";

describe("demoLoginsEnabled", () => {
  it("is on for staging and local development, never production", () => {
    expect(demoLoginsEnabled({ RAILWAY_ENVIRONMENT_NAME: "staging" })).toBe(true);
    expect(demoLoginsEnabled({ ALLOW_SEED: "staging" })).toBe(true);
    expect(demoLoginsEnabled({ ALLOW_SEED: "staging", RAILWAY_ENVIRONMENT_NAME: "production" })).toBe(false);
    expect(demoLoginsEnabled({ NODE_ENV: "development" })).toBe(true); // local npm run dev
    expect(demoLoginsEnabled({ NODE_ENV: "production" })).toBe(false); // a production build, wherever it runs
    expect(demoLoginsEnabled({ NODE_ENV: "development", RAILWAY_ENVIRONMENT_NAME: "production" })).toBe(false);
    expect(demoLoginsEnabled({ NODE_ENV: "development", RAILWAY_ENVIRONMENT_NAME: "preview" })).toBe(false); // other Railway envs
  });
});
