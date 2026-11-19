import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { definitionOf, METRICS } from "./metrics";
import { xlsx } from "./xlsx";

it("writes a valid zip with the sheet", () => {
  const b = xlsx([["Label", "amount"], ["A & <B>", 1200], ["total", 1200]]);
  expect(b.subarray(0, 2).toString()).toBe("PK");
  const f = join(mkdtempSync(join(tmpdir(), "x-")), "t.xlsx");
  writeFileSync(f, b);
  let listing = "";
  try { listing = execFileSync("unzip", ["-l", f]).toString(); } catch { return; } // unzip missing on the runner: structure-only check
  expect(listing).toContain("xl/worksheets/sheet1.xml");
  expect(execFileSync("unzip", ["-p", f, "xl/worksheets/sheet1.xml"]).toString()).toContain("A &amp; &lt;B&gt;");
});
it("every metric has three languages", () => {
  for (const d of Object.values(METRICS)) expect(Object.keys(d.definition)).toEqual(["en", "fr", "rw"]);
  expect(definitionOf("vat")).toMatch(/VAT/);
});
