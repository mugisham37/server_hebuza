// Minimal load probe (k6 isn't installed here): N concurrent workers for D seconds per scenario, p50/p95/p99 + errors.
// Rotates X-Forwarded-For so the per-IP limiter doesn't turn the run into a 429 benchmark (TRUST_PROXY=1 locally).
// Run: npx tsx server/test/load.ts   [LOAD_SECONDS=20 LOAD_CONC=20]
// shortcut: no ramp/arrival-rate model, port to k6 scenarios (BUILD-PLAN §5 targets) for staging runs.
import { randomUUID } from "node:crypto";
import { clientConversation, login } from "./authz/matrix";

const API = process.env.API_URL ?? "http://localhost:4000";
const SECS = Number(process.env.LOAD_SECONDS ?? 20);
const CONC = Number(process.env.LOAD_CONC ?? 20);

async function run(
  name: string,
  req: (i: number) => {
    method: string;
    path: string;
    jar?: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  const lat: number[] = [];
  const codes: Record<number, number> = {};
  const end = Date.now() + SECS * 1000;
  let n = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (Date.now() < end) {
        const r = req(n++);
        const t = performance.now();
        const res = await fetch(API + r.path, {
          method: r.method,
          headers: {
            origin: "http://localhost:3000",
            "x-forwarded-for": `10.99.${n % 250}.${(n >> 8) % 250}`,
            ...(r.jar ? { cookie: r.jar } : {}),
            ...(r.body ? { "content-type": "application/json" } : {}),
            ...r.headers,
          },
          body: r.body ? JSON.stringify(r.body) : undefined,
        });
        await res.arrayBuffer();
        lat.push(performance.now() - t);
        codes[res.status] = (codes[res.status] ?? 0) + 1;
      }
    }),
  );
  lat.sort((a, b) => a - b);
  const p = (q: number) =>
    lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(0);
  const errs = Object.entries(codes)
    .filter(([c]) => Number(c) >= 400)
    .reduce((s, [, v]) => s + v, 0);
  console.log(
    `${name.padEnd(28)} reqs=${lat.length} rps=${(lat.length / SECS).toFixed(0)} p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms errors=${errs} ${JSON.stringify(codes)}`,
  );
}

async function main() {
  const client = await login("client");
  const sm = await login("sm");
  const conv = await clientConversation(client.jar, client.ip);
  await run("GET /services (public)", () => ({
    method: "GET",
    path: "/api/services",
  }));
  await run("GET /services/:slug (public)", () => ({
    method: "GET",
    path: "/api/services/company-registration",
  }));
  await run("GET /applications (client)", () => ({
    method: "GET",
    path: "/api/applications",
    jar: client.jar,
  }));
  await run("GET /admin/applications (SM)", () => ({
    method: "GET",
    path: "/api/admin/applications",
    jar: sm.jar,
  }));
  await run("POST chat send (client)", () => {
    const k = randomUUID();
    return {
      method: "POST",
      path: `/api/chat/conversations/${conv}/messages`,
      jar: client.jar,
      body: {
        client_msg_id: k.slice(0, 32),
        content: "load test",
        lane: "client",
      },
      headers: { "idempotency-key": k },
    };
  });
}
void main();
