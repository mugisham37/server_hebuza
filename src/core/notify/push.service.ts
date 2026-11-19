// F-NTF-18 Web Push (RFC 8030 + VAPID RFC 8292), payload-less so no message encryption is needed: the push only wakes
// the service worker, which reads the newest in-app notification over the authenticated API.
// Dormant until VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (base64url, P-256; `npx web-push generate-vapid-keys` format) are set.
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPrivateKey, sign } from "node:crypto";
import type { Env } from "../config/env";

const b64u = (b: Buffer) => b.toString("base64url");

@Injectable()
export class PushService {
  private readonly log = new Logger("push");
  readonly publicKey?: string;
  private readonly key?: ReturnType<typeof createPrivateKey>;
  private readonly subject: string;
  constructor(c: ConfigService<Env, true>) {
    const pub = c.get("VAPID_PUBLIC_KEY", { infer: true }), priv = c.get("VAPID_PRIVATE_KEY", { infer: true });
    this.subject = c.get("VAPID_SUBJECT", { infer: true }) ?? "mailto:support@hebuza.rw";
    if (!pub || !priv) return;
    const raw = Buffer.from(pub, "base64url"); // 65-byte uncompressed point 0x04|X|Y
    this.key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: priv, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: "jwk" });
    this.publicKey = pub;
  }
  get configured() {
    return !!this.key;
  }

  private vapid(endpoint: string) {
    const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const body = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.subject })));
    const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: this.key!, dsaEncoding: "ieee-p1363" });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${this.publicKey}`;
  }

  /** "ok" | "gone" (subscription expired → delete it) | "failed". */
  async ping(endpoint: string, urgency: "normal" | "high" = "normal"): Promise<"ok" | "gone" | "failed"> {
    if (!this.key) return "failed";
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { authorization: this.vapid(endpoint), ttl: "86400", urgency, "content-length": "0" }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 404 || r.status === 410) return "gone";
      return r.ok ? "ok" : "failed";
    } catch (e) {
      this.log.warn({ event: "push.failed", err: String(e) });
      return "failed";
    }
  }
}
