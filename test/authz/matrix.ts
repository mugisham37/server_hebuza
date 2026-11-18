// Authorization matrix: every route × every seeded persona against a running API (default http://localhost:4000).
// Run: npx tsx server/test/authz/matrix.ts   (exit 1 on any violation)
// Writes are only sent where the caller is expected to be refused (anon / role-denied), so a passing run mutates nothing.
import { createHmac } from "node:crypto";
import { can, type Permission } from "@/domain/auth/permissions";
import { normalizeRoles, type Role } from "@/domain/auth/roles";
import {
  SEED_CLIENT_PASSWORD,
  SEED_STAFF_PASSWORD,
  SEED_TOTP_SECRET,
} from "@/db/seed/auth";
import { loadRoutes, type RouteMeta } from "./routes";

const API = process.env.API_URL ?? "http://localhost:4000";
const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const DUMMY = "00000000-0000-4000-8000-000000000000";

type Who = { key: string; jar: string; roles: Role[]; id: string; ip: string };
const STAFF: Record<string, string> = {
  agent: "eric.habimana@hebuza.example",
  ext: "jean-paul.nkurunziza@ingabo.example",
  "ext-member": "chantal.mukamana@ingabo.example",
  sm: "diane.mukamana@hebuza.example",
  finance: "patrick.niyonzima@hebuza.example",
  marketing: "grace.mutesi@hebuza.example",
  procurement: "josiane.uwera@hebuza.example",
  partners: "pm@example.test",
  exec: "alice.mutoni@hebuza.example",
  sysadmin: "innocent.kayitare@hebuza.example",
  field: "emmanuel.mugabo@hebuza.example",
};
const CLIENTS: Record<string, string> = {
  client: "client@example.test",
  "client-b": "client-b@example.test",
  unverified: "new@example.test",
};

export function totp(b32: string, t = Date.now()) {
  const bits = [...b32]
    .map((c) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(c)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export async function call(
  method: string,
  path: string,
  o: {
    jar?: string;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "x-forwarded-for": o.ip ?? "10.77.0.1",
    ...o.headers,
  };
  if (o.jar) headers.cookie = o.jar;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  let r: Response;
  // A live API rate-limits per client IP (forged X-Forwarded-For is ignored); wait out 429s instead of counting them.
  for (let tries = 0; ; tries++) {
    r = await fetch(API + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: "manual" });
    if (r.status !== 429 || tries >= 8) break;
    await new Promise((res) => setTimeout(res, 1000 * Math.max(1, Number(r.headers.get("retry-after")) || 5)));
  }
  const text = await r.text();
  let json: { errorType?: string; data?: unknown } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (ics, rss, sse) */
  }
  return {
    status: r.status,
    json,
    cookies: r.headers.getSetCookie().map((c) => c.split(";")[0]),
  };
}
const merge = (jar: string, add: string[]) =>
  [
    ...new Map(
      [...jar.split("; "), ...add]
        .filter(Boolean)
        .map((c) => [c.split("=")[0], c]),
    ).values(),
  ].join("; ");

export async function clientConversation(jar: string, ip: string) {
  const apps = await call("GET", "/api/applications", { jar, ip });
  const code = (apps.json?.data as { applications: { code: string }[] }).applications[0].code;
  const r = await call("GET", `/api/chat/conversations/by-application/${code}`, { jar, ip }); // opens the case thread if none yet
  return (r.json?.data as { conversation_id: string }).conversation_id;
}

let ipN = 0;
export async function login(key: string): Promise<Who> {
  const ip = `10.77.1.${++ipN}`; // own limiter bucket per persona (TRUST_PROXY honours one XFF hop)
  let jar = "";
  if (CLIENTS[key]) {
    const r = await call("POST", "/api/auth/login", {
      ip,
      body: { identifier: CLIENTS[key], password: SEED_CLIENT_PASSWORD },
    });
    if (r.status >= 300)
      throw new Error(`${key} login ${r.status} ${JSON.stringify(r.json)}`);
    jar = merge(jar, r.cookies);
  } else {
    for (let i = 0; ; i++) {
      const r = await call("POST", "/api/auth/staff/login", {
        ip,
        body: { email: STAFF[key], password: SEED_STAFF_PASSWORD },
      });
      if (r.status >= 300)
        throw new Error(
          `${key} staff login ${r.status} ${JSON.stringify(r.json)}`,
        );
      const v = await call("POST", "/api/auth/mfa/verify", {
        ip,
        jar: merge("", r.cookies),
        body: { code: totp(SEED_TOTP_SECRET) },
      });
      if (v.status < 300) {
        jar = merge(merge(jar, r.cookies), v.cookies);
        break;
      }
      if (i >= 2)
        throw new Error(`${key} mfa ${v.status} ${JSON.stringify(v.json)}`);
      await new Promise((res) =>
        setTimeout(res, 31_000 - (Date.now() % 30_000)),
      ); // TOTP step already used
    }
  }
  const tok = jar.split("; ").find((c) => c.startsWith("hebuza_access="))?.split("=")[1];
  if (!tok) throw new Error(`${key} no access cookie`);
  const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()) as { sub: string; roles: Role[] | Role };
  const u = { id: p.sub, roles: normalizeRoles({ roles: p.roles }) };
  return { key, jar, roles: u.roles, id: u.id, ip };
}

const fill = (p: string) => p.replace(/:[A-Za-z_]+/g, DUMMY);
function allowed(r: RouteMeta, w: Who | null) {
  if (!w) return r.public;
  if (r.roles && !w.roles.some((x) => r.roles!.includes(x))) return false;
  if (
    r.perms?.length &&
    !r.perms.some((p) => can({ id: w.id, roles: w.roles }, p as Permission))
  )
    return false;
  return true;
}

async function pool<T>(items: T[], n: number, f: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await f(items[i++]);
    }),
  );
}

async function main() {
  const routes = (await loadRoutes()).filter(
    (r) => r.method && r.method !== "ALL",
  );
  const keys = [...Object.keys(CLIENTS), ...Object.keys(STAFF)];
  const people: Who[] = [];
  for (const k of keys) people.push(await login(k)); // sequential: one TOTP per user per step
  const bad: string[] = [];
  const info: string[] = [];
  let n = 0;
  const tasks: { r: RouteMeta; w: Who | null }[] = [];
  for (const r of routes)
    for (const w of [null, ...people]) {
      const ok = allowed(r, w);
      if (r.method !== "GET" && ok) continue; // never fire writes that could pass auth
      if (
        r.path.includes("realtime/stream") ||
        (r.path === "/auth/session" && r.method === "DELETE")
      )
        continue; // SSE hangs
      tasks.push({ r, w });
    }
  await pool(tasks, 8, async ({ r, w }) => {
    const path = (r.path.startsWith("/health") ? "" : "/api") + fill(r.path);
    const res = await call(r.method, path, {
      jar: w?.jar,
      ip: w?.ip ?? "10.77.2.1",
      body: r.method === "GET" ? undefined : { __probe: true },
    });
    n++;
    const who = w?.key ?? "anon";
    const tag = `${r.method} ${r.path} as ${who} -> ${res.status} ${res.json?.errorType ?? ""}`;
    const ok = allowed(r, w);
    if (res.status >= 500) bad.push(`5xx ${tag}`);
    else if (!w && !r.public && res.status !== 401)
      bad.push(`anon-not-401 ${tag}`);
    else if (
      w &&
      !ok &&
      res.status !== 403 &&
      !(res.status === 401 && res.json?.errorType === "step_up_required")
    )
      bad.push(`not-403 ${tag}`);
    else if (
      w &&
      ok &&
      res.status === 401 &&
      res.json?.errorType !== "step_up_required"
    )
      bad.push(`signed-in-401 ${tag}`);
    else if (w && ok && res.status === 403) info.push(`allowed-but-403 ${tag}`);
  });
  // Client-only routes: anything under a staff surface must refuse a client even when the guard metadata is silent.
  const STAFF_SURFACE = /^\/(staff|admin|x_field|field|finance|procurement|agent|ops|work|reports)\//;
  for (const w of people.filter((p) => p.roles.every((r) => r === "client")))
    for (const r of routes.filter((x) => x.method === "GET" && STAFF_SURFACE.test(x.path) && x.path !== "/admin/public-holidays" /* public reference data */ && !x.public && allowed(x, w))) {
      const res = await call("GET", "/api" + fill(r.path), { jar: w.jar, ip: w.ip });
      if (![401, 403].includes(res.status)) bad.push(`client-on-staff-surface GET ${r.path} as ${w.key} -> ${res.status}`);
    }
  // IDOR: client-b replays client A's real ids on every GET with a path param; A's 2xx must be B's 403/404.
  const a = people.find((p) => p.key === "client")!, b = people.find((p) => p.key === "client-b")!;
  const ids = new Set<string>();
  for (const p of ["/api/applications", "/api/me/documents", "/api/me/invoices", "/api/chat/conversations", "/api/me/receipts", "/api/me/bookings", "/api/me/deliverables", "/api/me/quotations", "/api/me/refunds"]) {
    const j = JSON.stringify((await call("GET", p, { jar: a.jar, ip: a.ip })).json?.data ?? null);
    for (const m of j.matchAll(/"(?:id|code|number|documentId|conversation_id|application_id|requestCode|reference|invoiceNumber)":"([^"]+)"/g)) ids.add(m[1]);
  }
  let idor = 0;
  for (const r of routes.filter((x) => x.method === "GET" && /:[A-Za-z_]+/.test(x.path) && (x.path.match(/:/g) ?? []).length === 1 && !STAFF_SURFACE.test(x.path)))
    for (const id of ids) {
      const path = "/api" + r.path.replace(/:[A-Za-z_]+/, encodeURIComponent(id));
      const ra = await call("GET", path, { jar: a.jar, ip: a.ip });
      if (ra.status >= 300) continue;
      idor++;
      const rb = await call("GET", path, { jar: b.jar, ip: b.ip });
      const rn = r.public ? await call("GET", path, { ip: "10.77.2.2" }) : null;
      if (rb.status < 300) (r.public ? info : bad).push(`idor GET ${r.path} id=${id.slice(0, 12)}… as client-b -> ${rb.status}${r.public ? " (public route)" : ""}`);
      if (rn && rn.status < 300) info.push(`public-read GET ${r.path} id=${id.slice(0, 12)}… anon -> ${rn.status}`);
    }
  console.log(`idor: ${ids.size} ids of client A, ${idor} readable (route,id) pairs replayed as client-b`);
  console.log(
    `routes=${routes.length} personas=${people.length}+anon requests=${n} violations=${bad.length} allowed-but-403=${info.length}`,
  );
  info.filter((l) => process.env.VERBOSE || !l.startsWith("allowed-but-403")).forEach((l) => console.log("  info", l));
  bad.sort().forEach((l) => console.log("  FAIL", l));
  process.exitCode = bad.length ? 1 : 0;
}
if (require.main === module) void main();
