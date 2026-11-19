// Phase 7 upload guard (security V12): every presigned PUT is checked here before a URL is issued. The object is
// re-sniffed after upload (documents.finalize); this stops obviously dangerous types and oversize files up front.
/** Active content a browser or OS would execute, and macro-enabled Office files (DOCM/XLSM rejected per settings). */
const BLOCKED = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript", "application/x-javascript",
  "application/x-msdownload", "application/x-msdos-program", "application/x-dosexec", "application/x-executable", "application/x-sh",
  "application/x-bat", "application/java-archive", "application/x-ms-installer", "application/vnd.microsoft.portable-executable",
  "application/vnd.ms-word.document.macroenabled.12", "application/vnd.ms-excel.sheet.macroenabled.12", "application/vnd.ms-powerpoint.presentation.macroenabled.12",
]);
const BLOCKED_EXT = /\.(exe|msi|bat|cmd|com|scr|js|mjs|vbs|ps1|sh|jar|html?|svg|docm|xlsm|pptm|apk)$/i;
/** Per-purpose ceiling in MB (uploads.max_file_mb = 10, uploads.max_message_mb = 25 for chat/voice, CMS media 25). */
const MAX_MB: Record<string, number> = { chat: 25, "cms-media": 25, field: 25, deliverable: 25 };
export const maxBytes = (purpose: string) => (MAX_MB[purpose] ?? 10) * 1024 * 1024;

export function uploadProblem(p: { contentType: string; size: number; purpose: string; filename?: string }): string | null {
  const type = p.contentType.toLowerCase().split(";")[0].trim();
  if (!type || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) return "bad_type";
  if (BLOCKED.has(type) || (p.filename && BLOCKED_EXT.test(p.filename))) return "blocked_type";
  if (!Number.isInteger(p.size) || p.size <= 0) return "bad_size";
  if (p.size > maxBytes(p.purpose)) return "too_large";
  return null;
}
