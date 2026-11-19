import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { stampPdf, textImagePdf } from "./pdf";

describe("pdf", () => {
  it("builds, stamps and trims pages", async () => {
    const base = await textImagePdf("T — é", Array.from({ length: 300 }, (_, i) => `line ${i}`));
    expect((await PDFDocument.load(base)).getPageCount()).toBeGreaterThan(2);
    const out = await stampPdf(base, "PREVIEW — HEBUZA — HBZ-1", { maxPages: 2 });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });
});
