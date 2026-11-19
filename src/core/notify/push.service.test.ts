import { generateKeyPairSync, verify } from "node:crypto";
import { expect, it } from "vitest";
import { PushService } from "./push.service";

it("signs a VAPID JWT the public key verifies", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pj = publicKey.export({ format: "jwk" }), sj = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(pj.x!, "base64url"), Buffer.from(pj.y!, "base64url")]).toString("base64url");
  const cfg = { get: (k: string) => ({ VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: sj.d, VAPID_SUBJECT: "mailto:t@x" } as Record<string, string>)[k] };
  const s = new PushService(cfg as never);
  expect(s.configured).toBe(true);
  const h = (s as unknown as { vapid(e: string): string }).vapid("https://push.example/abc");
  const [jwt] = h.slice("vapid t=".length).split(", k=");
  const [a, b, sig] = jwt.split(".");
  expect(JSON.parse(Buffer.from(b, "base64url").toString()).aud).toBe("https://push.example");
  expect(verify("sha256", Buffer.from(`${a}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
});
