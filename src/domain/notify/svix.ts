// Svix webhook signature (Resend): base64 HMAC-SHA256 of `${id}.${timestamp}.${body}` with the base64 key after "whsec_".
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySvix(secret: string, h: { id?: string; timestamp?: string; signature?: string }, body: Buffer | string, now = Date.now()): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  if (Math.abs(now / 1000 - Number(h.timestamp)) > 300) return false; // 5-minute replay window
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const want = createHmac("sha256", key).update(`${h.id}.${h.timestamp}.`).update(body).digest();
  return h.signature.split(" ").some((part) => {
    const [v, sig] = part.split(",");
    const got = v === "v1" && sig ? Buffer.from(sig, "base64") : null;
    return !!got && got.length === want.length && timingSafeEqual(got, want);
  });
}

/** Meta webhooks: `sha256=<hex HMAC-SHA256(app secret, raw body)>`. */
export function verifyHubSignature(secret: string, header: string, body: Buffer | string): boolean {
  const got = Buffer.from(header.replace(/^sha256=/, ""), "hex");
  const want = createHmac("sha256", secret).update(body).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}
