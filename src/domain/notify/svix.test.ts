import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { verifyHubSignature, verifySvix } from "./svix";

it("verifies svix v1 signatures", () => {
  const key = Buffer.from("secret-key-bytes").toString("base64"), body = '{"type":"email.delivered"}', ts = "1763520000";
  const sig = createHmac("sha256", Buffer.from(key, "base64")).update(`msg_1.${ts}.${body}`).digest("base64");
  const h = { id: "msg_1", timestamp: ts, signature: `v1,bad v1,${sig}` };
  expect(verifySvix(`whsec_${key}`, h, body, 1763520000_000)).toBe(true);
  expect(verifySvix(`whsec_${key}`, h, body + " ", 1763520000_000)).toBe(false);
  expect(verifySvix(`whsec_${key}`, h, body, 1763530000_000)).toBe(false);
});

it("verifies Meta hub signatures", () => {
  const sig = `sha256=${createHmac("sha256", "app-secret").update("{}").digest("hex")}`;
  expect(verifyHubSignature("app-secret", sig, "{}")).toBe(true);
  expect(verifyHubSignature("app-secret", sig, "{ }")).toBe(false);
  expect(verifyHubSignature("app-secret", "garbage", "{}")).toBe(false);
});
