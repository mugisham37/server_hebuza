import { expect, it } from "vitest";
import { scrubUrl } from "./logger";

it("scrubs capability tokens from logged URLs", () => {
  expect(scrubUrl("/api/webhooks/notify/abc123/resend")).toBe("/api/webhooks/notify/[redacted]/resend");
  expect(scrubUrl("/api/me/obligations/ics/u1.deadbeef")).toBe("/api/me/obligations/ics/[redacted]");
  expect(scrubUrl("/api/payments/webhooks/momo?sig=xyz&x=1")).toBe("/api/payments/webhooks/momo?sig=[redacted]&x=1");
  expect(scrubUrl("/api/services?limit=20")).toBe("/api/services?limit=20");
});
