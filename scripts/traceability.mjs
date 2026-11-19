#!/usr/bin/env node
// Builds docs/TRACEABILITY.md: every feature ID in spec/05-modules → status + route/screen evidence (audit docs A–D)
// + tests that name it. Run: node scripts/traceability.mjs [specDir]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { webCallers, filesFor, routes, norm } from "./wiring.mjs";

const SPEC = process.argv[2] ?? "/home/moses/Desktop/cleanup/Project/spec/05-modules";
const ROOT = new URL("..", import.meta.url).pathname;
const walk = (d, ok) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  if (f === "node_modules" || f.startsWith(".")) return [];
  return statSync(p).isDirectory() ? walk(p, ok) : ok(p) ? [p] : [];
});
const ID = /\bF-[A-Z0-9]{2,5}-\d{2}\b/g;

// Spec IDs with their titles (first table cell after the id, or the heading text).
const spec = new Map();
for (const f of walk(SPEC, (p) => p.endsWith(".md")))
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/(F-[A-Z0-9]{2,5}-\d{2})\s*[|:—–-]+\s*\**([^|*\n]{3,80})/);
    if (m && !spec.has(m[1])) spec.set(m[1], { title: m[2].trim(), file: f.split("/").pop() });
  }
// Audit rows: | ID | title | phase | status | evidence |
const audit = new Map();
for (const f of ["A.md", "B.md", "C.md", "D.md"])
  for (const line of readFileSync(join(ROOT, "docs/audit", f), "utf8").split("\n")) {
    const c = line.split("|").map((x) => x.trim());
    if (/^F-[A-Z0-9]+-\d{2}$/.test(c[1] ?? "")) audit.set(c[1], { title: c[2], phase: c[3], status: c[4], evidence: (c[5] ?? "").replace(/\s+/g, " ").slice(0, 300) });
  }
// Tests naming an ID (server unit tests, server authz tests, web e2e/unit).
const tests = new Map();
const testFiles = [
  ...walk(join(ROOT, "src"), (p) => p.endsWith(".test.ts")),
  ...walk(join(ROOT, "test"), (p) => /\.(ts|js)$/.test(p)),
  ...walk(join(ROOT, "../web/e2e"), (p) => p.endsWith(".ts")),
  ...walk(join(ROOT, "../web/src"), (p) => /\.test\.tsx?$/.test(p)),
];
for (const f of testFiles) for (const id of new Set(readFileSync(f, "utf8").match(ID) ?? [])) (tests.get(id) ?? tests.set(id, []).get(id)).push(f.replace(join(ROOT, ".."), "").replace(/^\//, ""));
// Source files naming an ID (routes/screens carry `F-XXX-nn` in comments).
const src = new Map();
for (const f of [...walk(join(ROOT, "src"), (p) => p.endsWith(".ts") && !p.endsWith(".test.ts")), ...walk(join(ROOT, "../web/src"), (p) => /\.tsx?$/.test(p) && !p.includes("schema.d.ts"))])
  for (const id of new Set(readFileSync(f, "utf8").match(ID) ?? [])) (src.get(id) ?? src.set(id, []).get(id)).push(f.replace(join(ROOT, ".."), "").replace(/^\//, ""));

// UI column: web screens for an ID = web app/components files naming it, files the evidence cites by path, and web
// callers of routes the evidence cites. shortcut: route↔ID link comes from evidence text, not controller metadata;
// upgrade when routes carry their F-ID in @Route.
const WEB = join(ROOT, "../web/src");
const webUi = walk(WEB, (p) => /\/(app|components)\/.*\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)).map((f) => f.replace(join(ROOT, "../"), ""));
const calls = webCallers(), allRoutes = routes();
const ctrl = new Map(walk(join(ROOT, "src"), (p) => p.endsWith(".controller.ts")).map((f) => {
  const t = readFileSync(f, "utf8").split("\n");
  const prefix = (t.join("\n").match(/@Controller\(\s*["'`]?([^"'`)]*)/) ?? [])[1] ?? "";
  const rs = t.flatMap((l, i) => { const m = l.match(/@(Get|Post|Put|Patch|Delete)\(\s*["'`]?([^"'`)]*)/); return m ? [{ line: i + 1, method: m[1].toUpperCase(), path: m[2] }] : []; });
  return [f.split("/").pop(), { prefix, routes: rs }];
}));
const uiFor = (id, evidence) => {
  const out = new Set((src.get(id) ?? []).filter((f) => /^web\/src\/(app|components)\//.test(f)));
  // file names (`x.tsx`, `organisms/a/b.tsx`) and route-group paths (`(ops)/ops/assign`, `agent/inbox`), with or without backticks
  for (const [t] of evidence.matchAll(/[\w()[\]./-]+\.tsx\b/g)) webUi.filter((f) => f.endsWith("/" + t.replace(/^.*?(components\/|app\/|W:|WA:)/, ""))).forEach((f) => out.add(f));
  for (const [t] of evidence.matchAll(/\([a-z]+\)\/[\w/[\]-]+|`[a-z][\w-]*\/[\w/[\]-]+`/g)) {
    const bare = t.replace(/`/g, "").replace(/\/$/, "");
    webUi.filter((f) => f.includes("/app/") && f.includes("/" + bare + "/") && f.endsWith("page.tsx")).slice(0, 2).forEach((f) => out.add(f));
  }
  // `ctrl.controller.ts:NN` (or `:NN-MM`, `:NN/MM`) → the @Get/@Post… decorators at/after those lines → their web callers
  for (const [, file, lines] of evidence.matchAll(/([\w.-]+\.controller\.ts):([\d/,-]+)/g)) {
    const c = ctrl.get(file);
    if (c) for (const n of lines.split(/[/,-]/).map(Number).filter(Boolean)) {
      const hit = c.routes.filter((r) => r.line >= n - 6 && r.line <= n + 8).sort((a, b) => Math.abs(a.line - n) - Math.abs(b.line - n))[0];
      if (hit) filesFor(calls, `${hit.method} ${norm(`/api/${c.prefix}/${hit.path}`.replace(/\/+/g, "/").replace(/:([\w]+)/g, "{$1}"))}`).forEach((f) => out.add(f));
    }
  }
  for (const [, p] of evidence.matchAll(/(?:GET|POST|PUT|PATCH|DELETE)?\s*`?\/?((?:api\/)?[a-z_-]+(?:\/[a-z{}:_.-]+)+)/g)) {
    const tail = norm("/" + p.replace(/^api\//, "").replace(/:[a-z_]+/gi, "{x}"));
    for (const r of allRoutes) if (norm(r.path).endsWith(tail)) filesFor(calls, r.key).forEach((f) => out.add(f));
  }
  return [...out];
};

const ids = [...new Set([...spec.keys(), ...audit.keys()])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
const noUi = [];
const rows = ids.map((id) => {
  const a = audit.get(id), s = spec.get(id);
  const code = (src.get(id) ?? []).slice(0, 4).map((p) => `\`${p}\``).join("<br>");
  const ui = uiFor(id, a?.evidence ?? "");
  if (!ui.length) noUi.push(id);
  const uiCell = ui.slice(0, 4).map((p) => `\`${p.replace(/^web\/src\//, "")}\``).join("<br>") + (ui.length > 4 ? ` +${ui.length - 4}` : "");
  const t = (tests.get(id) ?? []).slice(0, 3).map((p) => `\`${p}\``).join("<br>");
  return `| ${id} | ${esc(a?.title ?? s?.title ?? "")} | ${esc(a?.status ?? "not audited")} | ${esc(a?.evidence ?? "")} | ${uiCell} | ${code} | ${t} |`;
});
const by = (st) => ids.filter((id) => (audit.get(id)?.status ?? "not audited") === st).length;
writeFileSync(join(ROOT, "docs/TRACEABILITY.md"), `# Traceability: spec feature → code → test

Generated by \`node scripts/traceability.mjs\` from \`spec/05-modules\`, the audit tables (\`docs/audit/A–D.md\`) and every file
that names the ID. Regenerate after closing gaps; edit the audit rows, not this file.

Totals: ${ids.length} IDs · DONE ${by("DONE")} · PARTIAL ${by("PARTIAL")} · MISSING ${by("MISSING")} · not audited ${by("not audited")} · with a UI file ${ids.length - noUi.length}.\nNo UI file found: ${noUi.join(", ") || "none"}.

| ID | Feature | Status | Evidence (route / screen) | UI (web files) | Code naming the ID | Tests naming the ID |
|---|---|---|---|---|---|---|
${rows.join("\n")}
`);
console.log(`docs/TRACEABILITY.md: ${ids.length} ids, ${noUi.length} without a UI file`);
console.log(noUi.map((id) => `${id} [${audit.get(id)?.status}] ${audit.get(id)?.evidence?.slice(0, 120)}`).join("\n"));
