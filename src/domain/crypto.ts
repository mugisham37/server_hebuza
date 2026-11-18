// Server-only (node:crypto): field encryption + blind index shared by server CryptoService and the db seed.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export const key32 = (b64: string, name: string) => {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error(`${name} must be 32 bytes base64`);
  return k;
};

/** `v1:` + base64(iv[12] | tag[16] | ciphertext), AES-256-GCM. */
export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decrypt(key: Buffer, cipher: string): string {
  if (!cipher.startsWith("v1:")) throw new Error("unknown ciphertext version");
  const raw = Buffer.from(cipher.slice(3), "base64");
  if (raw.length < 28) throw new Error("ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

export const blindIndex = (key: Buffer, value: string) =>
  createHmac("sha256", key).update(value.normalize("NFC").trim().toLowerCase()).digest("hex");
