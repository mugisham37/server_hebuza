// PDF helpers on pdf-lib: diagonal stamping (preview / per-recipient watermark) and simple documents with an image.
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

// Standard 14 fonts are WinAnsi: drop characters they cannot encode instead of failing the whole document.
const ansi = (s: string) => s.replace(/[–]/g, "-").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

/**
 * Stamp `text` diagonally (and in the footer) on each page. `maxPages` keeps only the first pages (previews).
 * Encrypted or broken PDFs throw; callers fall back to their notice page.
 */
export async function stampPdf(bytes: Uint8Array, text: string, opts: { maxPages?: number; opacity?: number } = {}) {
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const doc = opts.maxPages && src.getPageCount() > opts.maxPages ? await PDFDocument.create() : src;
  if (doc !== src) for (const p of await doc.copyPages(src, [...Array(opts.maxPages).keys()])) doc.addPage(p);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = ansi(text);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(14, Math.min(width, height) / 16);
    const w = font.widthOfTextAtSize(t, size);
    for (const f of [0.3, 0.55, 0.8])
      page.drawText(t, { x: (width - w * 0.7) / 2, y: height * f - w * 0.35, size, font, color: rgb(0.8, 0, 0), opacity: opts.opacity ?? 0.25, rotate: degrees(35) });
    page.drawText(t, { x: 24, y: 14, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
  }
  return doc.save();
}

/** A one-column text document; `image` (PNG/JPEG bytes) is drawn under the text, e.g. a signature. */
export async function textImagePdf(title: string, lines: string[], image?: { bytes: Uint8Array; label: string } | null) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]);
  let y = 800;
  const line = (s: string, f = font, size = 10) => {
    if (y < 60) { page = doc.addPage([595, 842]); y = 800; }
    page.drawText(ansi(s).slice(0, 110), { x: 48, y, size, font: f });
    y -= size + 6;
  };
  line(title, bold, 16);
  y -= 6;
  for (const l of lines) line(l);
  const isPng = !!image && image.bytes[0] === 0x89 && image.bytes[1] === 0x50;
  const isJpg = !!image && image.bytes[0] === 0xff && image.bytes[1] === 0xd8;
  if (image && (isPng || isJpg)) { // other formats (webp/svg) are skipped, not fatal
    const img = isPng ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes);
    const s = img.scaleToFit(240, 100);
    if (y - s.height < 60) { page = doc.addPage([595, 842]); y = 800; }
    y -= 10;
    line(image.label, bold);
    page.drawImage(img, { x: 48, y: y - s.height, width: s.width, height: s.height });
    page.drawLine({ start: { x: 48, y: y - s.height - 4 }, end: { x: 300, y: y - s.height - 4 }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
  }
  return doc.save();
}
