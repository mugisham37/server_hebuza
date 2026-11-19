#!/usr/bin/env node
// Route → web caller wiring: every openapi path+method vs. web/src callers (`api.METHOD("/api/...")`, chained `.METHOD(`,
// string-method helpers `fx("POST", "/api/...")`, plus GET links written as `/api/...` literals for downloads).
// Prints uncalled routes by tag, minus EXCLUDE (non-UI routes). Run: node scripts/wiring.mjs [--json].
// Also imported by traceability.mjs (webCallers / filesFor).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB = join(ROOT, "../web/src");

// Legitimately non-UI routes: machines, not people, call these.
export const EXCLUDE = [
  [/^\/health/, "health probe"],
  [/\/metrics\b/, "metrics scrape"],
  [/webhook/i, "provider webhook"],
  [/\/callback\b|\/oauth\//i, "oauth / provider callback"],
  [/\.ics$|\/ics\b|\/feed\b|\/rss$/, "calendar / rss feed"],
  [/\/(cron|internal|jobs?)\//, "cron / internal"],
  [/\/(track|pixel|beacon|open|click)(\/|$)|\/t\/|\/links\/[cr]\/|^\/api\/events$|\/not-found$/, "public tracking beacon / redirect"],
  [/\/(ipn|notify-url|momo|mtn|stripe|flutterwave)\b/i, "payment provider callback"],
  [/\/realtime\/(stream|focus)$/, "SSE transport (EventSource, not the typed client)"],
  [/\/content\/(manifest|preview)$/, "Next middleware / draft-mode fetch"],
  [/\/reports\/rollups\/backfill$/, "ops one-shot (rollup backfill), run by ops tooling not users"],
];

// Triaged 2026-11-19: no new UI, reason given. Not deleted. "wired:" = called in a way the scanner can't see.
export const KNOWN = {
  "GET /api/chat/conversations/{id}": "dup: by-application/{code} + admin/chat/conversations/{id}",
  "POST /api/chat/conversations/{id}/cards": "server-created by finance/booking/deliverable flows",
  "POST /api/content/feedback": "wired: molecules/site/library.tsx raw fetch",
  "POST /api/contact": "wired: lib/forms/public-forms.ts raw fetch (needs 429/422 status)",
  "GET /api/admin/mkt/events/summary": "dup: reports traffic via analytics route",
  "GET /api/admin/crm/budget": "dup: campaigns list returns budget",
  "GET /api/promos/{code}": "dup: invoice create validates promoCode",
  "GET /api/media/{id}": "wired: server-built img src URLs",
  "POST /api/staff/work/cases/{code}/instructions": "dup: ops brief editor",
  "GET /api/agent/profile": "legacy: agent/x/onboarding", "PATCH /api/agent/profile": "legacy: agent/x/onboarding",
  "GET /api/agent/settings": "legacy: agent/x/notification-matrix", "PUT /api/agent/settings": "legacy: agent/x/notification-matrix",
  "GET /api/agent/papers": "legacy: work/x/credentials", "POST /api/agent/papers": "legacy: work/x/credentials",
  "GET /api/agent/papers/{id}/file": "legacy: work/x/credentials",
  "POST /api/agent/cases/{code}/documents": "dup: agent/x/cases/{code}/deliverables",
  "GET /api/x_field/scans/{id}/pdf": "wired: server-returned pdf_url", "GET /api/x_field/receipts/{id}/pdf": "wired: server-returned pdfUrl",
  "GET /api/x_field/media": "wired: server-returned ?key= URLs", "PATCH /api/x_field/receipts/{id}": "guard: always 409 (signed receipts immutable)",
  "GET /api/x_field/cash": "dup: local outbox + x_field/finance/cash", "GET /api/x_field/conflicts": "dup: x_field/ops/queue?tab=conflicts",
  "POST /api/x_field/ops/agents/{userId}/revoke": "no spec screen; suspend worker revokes sessions",
  "GET /api/finance/revenue/x/agent/{workerId}": "no spec screen; allocations + payout batches",
  "GET /api/notifications/preferences": "alias: me/notification-preferences", "PATCH /api/notifications/preferences": "alias: me/notification-preferences",
  "GET /api/service-subcategories": "public services carry their subcategory",
  "GET /api/admin/services/{slug}/structure/published": "dup: structure/versions/{v}",
  "GET /api/plans/{plan_id}": "dup: me/subscription/plans", "GET /api/admin/settings": "dup: system settings screens",
  "POST /api/auth/staff/login": "wrapper of auth/login", "GET /api/auth/invite/{token}": "deprecated alias of set-password/{token}",
  "POST /api/auth/sign-out": "alias of DELETE auth/session", "GET /api/status/updates": "dup: /api/status",
  "GET /api/admin/public-holidays": "dup: admin/ops/sla/rules", "POST /api/deliverables/{id}/require-signature": "dup: agent/x deliverables {signature}",
  "GET /api/admin/clients/{id}": "dup: client record on ops case rows", "GET /api/admin/ops/audit/{kind}/{id}": "dup: admin/audit-log?entity=",
  "GET /api/payments/{transaction_id}": "dup: payments/{id}/status", "GET /api/staff/settings/changes": "dup: finance/settings returns changes",
  "GET /api/procurement/vendors/{id}/documents/{docId}/file": "wired: <a href> per vendor document",
};

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !f.endsWith("schema.d.ts") ? [p] : [];
});
// `${expr}` in web code may stand for a literal segment (`/${action}`) → "*"; `{param}` → "{p}".
// Web params named for an action (`{action}`, `{decision}`…) also stand for literal route segments.
export const norm = (p) => p.replace(/\$\{[^}]+\}|\{(action|decision|result|kind)\}/g, "*").replace(/\{[^}]+\}/g, "{p}").replace(/\?.*$/, "").replace(/\/$/, "");
const segMatch = (pat, key) => {
  const [pm, pp] = pat.split(" "), [km, kp] = key.split(" ");
  const a = pp.split("/"), b = kp.split("/");
  return pm === km && a.length === b.length && a.every((s, i) => s === b[i] || s === "*" || (s === "{p}" && b[i] === "{p}"));
};

/** Map "METHOD /path" (normalised) → web files calling it. */
export function webCallers() {
  const m = new Map();
  const add = (k, f) => (m.get(k) ?? m.set(k, new Set()).get(k)).add(f.replace(join(ROOT, "../"), ""));
  for (const f of walk(WEB)) {
    const s = readFileSync(f, "utf8");
    for (const [, meth, p] of s.matchAll(/\.(GET|POST|PUT|PATCH|DELETE)\(\s*["'`](\/api\/[^"'`]+)["'`]/g)) add(`${meth} ${norm(p)}`, f);
    for (const [, meth, p] of s.matchAll(/["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*["'`](\/api\/[^"'`]+)["'`]/g)) add(`${meth} ${norm(p)}`, f);
    for (const [, p] of s.matchAll(/publicGet\b[^(]*\(\s*["'`](\/[^"'`]+)["'`]/g)) add(`GET ${norm("/api" + p)}`, f); // server-side public fetch
    for (const [, p] of s.matchAll(/[`"'](\/api\/[^`"'\s]+)[`"']/g)) add(`GET ${norm(p)}`, f); // href/src downloads
  }
  return m;
}
/** Web files whose calls match a route key (exact, or through `${}` wildcards). */
export const filesFor = (calls, key) => {
  const out = new Set(calls.get(key) ?? []);
  for (const [pat, fs] of calls) if (pat.includes("*") && segMatch(pat, key)) fs.forEach((f) => out.add(f));
  return [...out];
};

export function routes() {
  const o = JSON.parse(readFileSync(join(ROOT, "openapi.json"), "utf8"));
  return Object.entries(o.paths).flatMap(([p, ms]) => Object.entries(ms).map(([meth, op]) => ({
    method: meth.toUpperCase(), path: p, tag: op.tags?.[0] ?? "?", key: `${meth.toUpperCase()} ${norm(p)}`,
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // self-check: `${action}` matches a literal segment, never a different prefix
  if (!segMatch(`POST ${norm("/api/x/{n}/${a}")}`, `POST ${norm("/api/x/{no}/void")}`) || segMatch("GET /api/x/*", "GET /api/y/z")) throw new Error("matcher broken");
  const calls = webCallers(), all = routes();
  const out = { total: all.length, withUi: 0, excluded: [], uncalled: {} };
  for (const r of all) {
    const ex = EXCLUDE.find(([re]) => re.test(r.path));
    if (filesFor(calls, r.key).length) out.withUi++;
    else if (KNOWN[`${r.method} ${r.path}`]) (out.triaged ??= []).push(`${r.method} ${r.path} — ${KNOWN[`${r.method} ${r.path}`]}`);
    else if (ex) out.excluded.push(`${r.method} ${r.path} — ${ex[1]}`);
    else (out.uncalled[r.tag] ??= []).push(`${r.method} ${r.path}`);
  }
  // Reverse: exported organisms/molecules/lib hooks no other web file references (never mounted / never used).
  const files = walk(WEB), texts = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const corpus = [...texts.values()].join("\n");
  out.orphans = files.filter((f) => /\/(components\/(organisms|molecules)|lib)\//.test(f) && !/\.test\.tsx?$|\/lib\/api\//.test(f)).flatMap((f) =>
    [...texts.get(f).matchAll(/export (?:async )?(?:function|const) ((?:use)?[A-Z]\w*|use\w+)/g)].map((m) => m[1])
      .filter((n) => (corpus.match(new RegExp(`\\b${n}\\b`, "g")) ?? []).length === 1) // only its own declaration: never mounted or called
      .map((n) => `${f.replace(join(ROOT, "../web/src/"), "")}: ${n}`));
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    const n = Object.values(out.uncalled).flat().length;
    console.log(`routes ${out.total} · with UI ${out.withUi} · excluded ${out.excluded.length} · triaged ${out.triaged?.length ?? 0} · uncalled ${n}\n`);
    console.log("Excluded:\n  " + out.excluded.join("\n  ") + "\n");
    console.log(`Triaged, no new UI (${out.triaged?.length ?? 0}):\n  ${(out.triaged ?? []).join("\n  ")}\n`);
    console.log(`Unreferenced exports (${out.orphans.length}):\n  ${out.orphans.join("\n  ")}\n`);
    for (const [t, rs] of Object.entries(out.uncalled)) console.log(`${t} (${rs.length})\n  ${rs.join("\n  ")}`);
  }
}
