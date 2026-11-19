import { describe, expect, it } from "vitest";
import { auditHash, verifySignature } from "./signature";

const r = { deliverableId: "d", fileSha256: "f".repeat(64), signerId: "u", signerName: "A B", method: "typed" as const, imageSha256: null, signedAt: "2026-01-01T00:00:00.000Z" };
describe("signature hash", () => {
  it("is stable and tamper-evident", () => {
    const h = auditHash(r);
    expect(verifySignature(r, h)).toBe(true);
    expect(verifySignature({ ...r, signerName: "C" }, h)).toBe(false);
  });
});
