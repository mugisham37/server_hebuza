import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  consumeState,
  decide,
  gate,
  landing,
  OAuthErr,
  safeNext,
  verifyIdToken,
} from "./auth.google.rules";

const CLIENT = "client-123.apps.googleusercontent.com";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }],
});
const sign = (
  claims: Record<string, unknown>,
  o: { aud?: string; iss?: string; exp?: number } = {},
) =>
  new SignJWT({
    email: "a@x.rw",
    email_verified: true,
    nonce: "n1",
    name: "Ann",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("g-1")
    .setIssuer(o.iss ?? "https://accounts.google.com")
    .setAudience(o.aud ?? CLIENT)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof OAuthErr ? e.code : `other:${e}`),
  );
const run = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return (e as OAuthErr).code;
  }
};

describe("google id_token", () => {
  it("accepts a valid token (both issuer spellings)", async () => {
    expect(
      await verifyIdToken(await sign({}), jwks, CLIENT, "n1"),
    ).toMatchObject({ sub: "g-1", email: "a@x.rw" });
    expect(
      await code(
        verifyIdToken(
          await sign({}, { iss: "accounts.google.com" }),
          jwks,
          CLIENT,
          "n1",
        ),
      ),
    ).toBe("ok");
  });
  it("rejects wrong aud, wrong issuer, expired, nonce mismatch", async () => {
    expect(
      await code(
        verifyIdToken(await sign({}, { aud: "other" }), jwks, CLIENT, "n1"),
      ),
    ).toBe("failed");
    expect(
      await code(
        verifyIdToken(
          await sign({}, { iss: "https://evil" }),
          jwks,
          CLIENT,
          "n1",
        ),
      ),
    ).toBe("failed");
    expect(
      await code(
        verifyIdToken(
          await sign({}, { exp: Math.floor(Date.now() / 1000) - 600 }),
          jwks,
          CLIENT,
          "n1",
        ),
      ),
    ).toBe("failed");
    expect(
      await code(verifyIdToken(await sign({}), jwks, CLIENT, "other")),
    ).toBe("failed");
  });
  it("rejects an unverified email", async () => {
    expect(
      await code(
        verifyIdToken(
          await sign({ email_verified: false }),
          jwks,
          CLIENT,
          "n1",
        ),
      ),
    ).toBe("email_unverified");
  });
});

describe("state", () => {
  it("is one-time: bad state and replay are state_invalid", async () => {
    const m = new Map([["k", JSON.stringify({ intent: "login" })]]);
    const redis = {
      getdel: async (k: string) => {
        const v = m.get(k) ?? null;
        m.delete(k);
        return v;
      },
    };
    expect(await consumeState(redis, "k")).toMatchObject({ intent: "login" });
    expect(await code(consumeState(redis, "k"))).toBe("state_invalid");
    expect(await code(consumeState(redis, null))).toBe("state_invalid");
  });
  it("next must be a same-site path", () => {
    expect(safeNext("/en/dashboard")).toBe("/en/dashboard");
    for (const n of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "",
      undefined,
    ])
      expect(safeNext(n)).toBeNull();
  });
});

describe("decision", () => {
  const client = (v: boolean) => ({
    userId: "u1",
    role: "client",
    isEmailVerified: v,
  });
  it("existing identity → that user", () =>
    expect(decide("u9", [client(true)])).toEqual({
      kind: "user",
      userId: "u9",
      link: false,
    }));
  it("verified same-email user → link", () =>
    expect(decide(null, [client(true)])).toEqual({
      kind: "user",
      userId: "u1",
      link: true,
    }));
  it("unverified same-email user → link_required", () =>
    expect(decide(null, [client(false)])).toEqual({
      kind: "link_required",
      userId: "u1",
    }));
  it("no user → create", () =>
    expect(decide(null, [])).toEqual({ kind: "create" }));
  it("client preferred over staff with the same email; two open accounts refused", () => {
    expect(
      decide(null, [
        { userId: "s", role: "staff:agent", isEmailVerified: true },
        client(true),
      ]),
    ).toMatchObject({ userId: "u1" });
    expect(
      run(() =>
        decide(null, [
          client(true),
          { userId: "p", role: "partner", isEmailVerified: true },
        ]),
      ),
    ).toBe("not_allowed");
  });
  it("gate: inactive → disabled, role outside auth.google_roles → not_allowed", () => {
    expect(gate({ isActive: false, role: "client" }, ["client"])).toBe(
      "disabled",
    );
    expect(gate({ isActive: true, role: "staff:sysadmin" }, ["client"])).toBe(
      "not_allowed",
    );
    expect(gate({ isActive: true, role: "client" }, ["client"])).toBeNull();
    expect(gate({ isActive: true, role: "partner" }, ["ext:agent"])).toBeNull(); // legacy role normalised
  });
  it("2FA-enrolled user lands on /login/2fa with next; others on next", () => {
    expect(landing("https://w", "en", "/dashboard", true)).toBe("https://w/en/login/2fa?next=%2Fdashboard");
    expect(landing("https://w", "rw", "/dashboard")).toBe("https://w/rw/dashboard");
  });
});
