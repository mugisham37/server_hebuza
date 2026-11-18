import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blindIndex, decrypt, encrypt, key32 } from "./crypto";

const key = randomBytes(32);
describe("crypto", () => {
  it("encrypt/decrypt roundtrips with a random IV", () => {
    const a = encrypt(key, "Kigali ✓"), b = encrypt(key, "Kigali ✓");
    expect(a).not.toBe(b);
    expect(decrypt(key, a)).toBe("Kigali ✓");
  });
  it("rejects tampering, wrong key and bad versions", () => {
    const c = encrypt(key, "secret");
    const raw = Buffer.from(c.slice(3), "base64"); raw[raw.length - 1] ^= 1;
    expect(() => decrypt(key, "v1:" + raw.toString("base64"))).toThrow();
    expect(() => decrypt(randomBytes(32), c)).toThrow();
    expect(() => decrypt(key, "v2:" + c.slice(3))).toThrow(/version/);
  });
  it("blindIndex is stable and normalised", () => {
    expect(blindIndex(key, "  A@B.rw ")).toBe(blindIndex(key, "a@b.rw"));
    expect(blindIndex(key, "a@b.rw")).not.toBe(blindIndex(randomBytes(32), "a@b.rw"));
    expect(blindIndex(key, "x")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("key32 requires 32 bytes", () => {
    expect(key32(key.toString("base64"), "K")).toEqual(key);
    expect(() => key32(randomBytes(16).toString("base64"), "K")).toThrow(/32 bytes/);
  });
});
