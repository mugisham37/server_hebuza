// Abuse checks against a running API: rate limits, OTP cap, idempotency replay, webhook signature, body limit, CSRF, view-as.
// Run: npx tsx server/test/authz/abuse.ts   (exit 1 on any failed check). Writes one chat message (idempotency check).
import { randomUUID } from "node:crypto";
import { SEED_TOTP_SECRET } from "@/db/seed/auth";
import { call, clientConversation, login, totp } from "./matrix";

const API = process.env.API_URL ?? "http://localhost:4000";
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, got: string) =>
  results.push([name, ok, got]);
const ip = () =>
  `10.88.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function main() {
  // 1. login limiter: 10/min per IP on auth routes → the 11th is 429 (unknown identifier: no account lockout side-effect).
  const lip = ip();
  const codes: number[] = [];
  for (let i = 0; i < 11; i++)
    codes.push(
      (
        await call("POST", "/api/auth/login", {
          ip: lip,
          body: {
            identifier: `nobody-${randomUUID()}@example.test`,
            password: "wrong-pass-1",
          },
        })
      ).status,
    );
  check(
    "login 11th attempt -> 429",
    codes[10] === 429 && codes.slice(0, 10).every((c) => c !== 429),
    codes.join(","),
  );

  // 2. OTP cap: OTP_MAX_ATTEMPTS (5) wrong codes, then even the right path is refused (429/423/400 locked), never 2xx.
  const c = await login("unverified");
  await call("POST", "/api/auth/resend-otp", { jar: c.jar, ip: ip(), body: {} }); // fresh pending code
  const otp: number[] = [];
  for (let i = 0; i < 7; i++)
    otp.push(
      (
        await call("POST", "/api/auth/verify-otp", {
          jar: c.jar,
          ip: ip(),
          body: { code: "000000" },
        })
      ).status,
    );
  check(
    "verify-otp wrong codes never 2xx, capped",
    otp.every((s) => s >= 400) &&
      otp.slice(5).every((s) => [400, 409, 410, 423, 429].includes(s)),
    otp.join(","),
  );

  // 3. idempotency replay: same key + body → same response, one message.
  const a = await login("client");
  const conv = await clientConversation(a.jar, a.ip);
  const key = randomUUID();
  const body = {
    client_msg_id: key.slice(0, 32),
    content: "idempotency check",
    lane: "client",
  };
  const r1 = await call("POST", `/api/chat/conversations/${conv}/messages`, {
    jar: a.jar,
    ip: a.ip,
    body,
    headers: { "idempotency-key": key },
  });
  const r2 = await call("POST", `/api/chat/conversations/${conv}/messages`, {
    jar: a.jar,
    ip: a.ip,
    body,
    headers: { "idempotency-key": key },
  });
  const r3 = await call("POST", `/api/chat/conversations/${conv}/messages`, {
    jar: a.jar,
    ip: a.ip,
    body: { ...body, content: "different" },
    headers: { "idempotency-key": key },
  });
  check(
    "idempotent replay returns same response",
    r1.status < 300 &&
      r2.status === r1.status &&
      JSON.stringify(r1.json) === JSON.stringify(r2.json),
    `${r1.status}/${r2.status}`,
  );
  check(
    "same key, different body -> 409/422",
    [409, 422].includes(r3.status),
    String(r3.status),
  );
  check(
    "idempotent route without key -> 400",
    (
      await call("POST", `/api/chat/conversations/${conv}/messages`, {
        jar: a.jar,
        ip: a.ip,
        body,
      })
    ).status === 400,
    "",
  );

  // 4. webhook with a bad signature → 401.
  const wh = await call("POST", "/api/payments/webhooks/flutterwave", {
    ip: ip(),
    body: {
      event: "charge.completed",
      data: { tx_ref: "x", status: "successful" },
    },
    headers: { "verif-hash": "bad", origin: "https://evil.example" },
  });
  check(
    "flutterwave webhook bad signature -> 401",
    wh.status === 401,
    `${wh.status} ${wh.json?.errorType}`,
  );
  const mm = await call("POST", "/api/payments/webhooks/momo?sig=bad", {
    ip: ip(),
    body: { referenceId: "x", status: "SUCCESSFUL" },
  });
  check(
    "momo webhook bad signature -> 401 (dev PAYMENTS_STUB accepts unsigned; prod boot refuses stub)",
    mm.status === 401 || process.env.PAYMENTS_STUB_EXPECTED === "1",
    `${mm.status} ${mm.json?.errorType}`,
  );

  // 5. oversized body → 413 in the envelope.
  const big = await fetch(`${API}/api/contact`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": ip(),
    },
    body: JSON.stringify({ message: "x".repeat(2_000_000) }),
  });
  const bj = (await big.json().catch(() => null)) as {
    success?: boolean;
    errorType?: string;
  } | null;
  check(
    "2 MB body -> 413 envelope",
    big.status === 413 && bj?.success === false && !!bj.errorType,
    `${big.status} ${JSON.stringify(bj).slice(0, 80)}`,
  );

  // 6. CSRF: cookie-authenticated POST from a foreign Origin → 403.
  const cs = await call("POST", "/api/notifications/read", {
    jar: a.jar,
    ip: a.ip,
    body: {},
    headers: { origin: "https://evil.example" },
  });
  check(
    "foreign Origin POST -> 403 csrf",
    cs.status === 403 && cs.json?.errorType === "csrf",
    `${cs.status} ${cs.json?.errorType}`,
  );

  // 7. view-as is read-only: sysadmin step-up → impersonate client → any write is 403 impersonation_read_only.
  const s = await login("sysadmin");
  let su = await call("POST", "/api/auth/mfa/step-up", {
    jar: s.jar,
    ip: s.ip,
    body: { code: totp(SEED_TOTP_SECRET) },
  });
  if (su.status >= 300) {
    await new Promise((r) => setTimeout(r, 31_000 - (Date.now() % 30_000)));
    su = await call("POST", "/api/auth/mfa/step-up", {
      jar: s.jar,
      ip: s.ip,
      body: { code: totp(SEED_TOTP_SECRET) },
    });
  }
  const token = (su.json?.data as { token?: string } | null)?.token ?? "";
  const imp = await call("POST", "/api/staff/impersonate", {
    jar: s.jar,
    ip: s.ip,
    body: { targetId: a.id, reason: "abuse check", minutes: 5 },
    headers: { "x-step-up-token": token, "idempotency-key": randomUUID() },
  });
  const jar = [
    ...new Map(
      [...s.jar.split("; "), ...imp.cookies].map((x) => [x.split("=")[0], x]),
    ).values(),
  ].join("; ");
  const w = await call("POST", `/api/chat/conversations/${conv}/messages`, {
    jar,
    ip: s.ip,
    body: { ...body, client_msg_id: "va" },
    headers: { "idempotency-key": randomUUID() },
  });
  check(
    "view-as write -> 403 impersonation_read_only",
    imp.status < 300 &&
      w.status === 403 &&
      w.json?.errorType === "impersonation_read_only",
    `start ${imp.status} ${imp.json?.errorType ?? ""} write ${w.status} ${w.json?.errorType}`,
  );
  await call("DELETE", "/api/staff/impersonate", { jar, ip: s.ip });

  for (const [n, ok, got] of results)
    console.log(`${ok ? "PASS" : "FAIL"} ${n}  [${got}]`);
  process.exitCode = results.every((r) => r[1]) ? 0 : 1;
}
void main();
