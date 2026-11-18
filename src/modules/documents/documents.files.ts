// Upload rules shared by case uploads and the client library (port of .ref documents.files). Bytes never pass through
// the API: the request declares name/type/size, storage enforces the size on the presigned PUT, and the finalize job
// sniffs the real type from the stored object.
import { z } from "zod";

/** PLACEHOLDER(upload-max-mb): the mocks' 10 MB cap. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"] as const;
const PREVIEWABLE = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
export const isPreviewable = (mime: string | null | undefined) => PREVIEWABLE.has(mime ?? "");

/** MIME from magic bytes; the browser's content-type is never trusted. */
export function sniffMime(b: Uint8Array): string | null {
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (s(0, 5) === "%PDF-") return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && s(1, 3) === "PNG") return "image/png";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "image/webp";
  if (s(4, 4) === "ftyp" && /^(heic|heix|mif1|msf1|hevc)$/.test(s(8, 4))) return "image/heic";
  return null;
}

export const sanitizeFilename = (name: string) =>
  (name.split(/[\\/]/).pop() ?? "").trim().replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "upload.bin";

export const UploadIn = z.object({
  filename: z.string().min(1).max(255),
  mime: z.enum(UPLOAD_MIMES, { message: "Upload a PDF, JPEG, PNG, WebP or HEIC file." }),
  size: z.number().int().min(1, "file is required").max(MAX_UPLOAD_BYTES, "File too large."),
});
export const UploadOut = z.object({ url: z.string(), key: z.string(), expiresAt: z.string() });
