// F-AUD-02: every literal audit code in the source must map to a category (catalogue, category prefix or PREFIX_CATEGORY).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { knownCode } from "./audit-catalogue";

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });

it("all emitted audit codes are catalogued", () => {
  const re = /(?:audit:\s*|audit\.record\([^,]+,\s*\{\s*action:\s*|record\(\s*w,\s*)"([a-z_]+\.[a-z_.]+)"/g;
  const codes = new Set<string>();
  for (const f of walk(join(__dirname, "../../modules"))) for (const m of readFileSync(f, "utf8").matchAll(re)) codes.add(m[1]);
  expect(codes.size).toBeGreaterThan(50);
  expect([...codes].filter((c) => !knownCode(c))).toEqual([]);
});
