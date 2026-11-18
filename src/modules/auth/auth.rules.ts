// Pure auth rules (no I/O): identifiers, masking, password policy, backup codes. TOTP lives in core/auth/otp.ts.
import { createHash, randomBytes, randomInt } from "node:crypto";

export type IdentifierType = "email" | "phone";
export const inferType = (id: string): IdentifierType =>
  id.includes("@") ? "email" : "phone";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** RW mobile numbers to E.164 (+2507[2389]XXXXXXX); null when invalid.
 *  shortcut: Rwanda mobile ranges only (no libphonenumber), add the dep if landlines/foreign numbers must sign in. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[\s\-().]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("250")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^7[2389]\d{7}$/.test(d) ? `+250${d}` : null;
}
export function normalizeIdentifier(
  type: IdentifierType,
  raw: string,
): string | null {
  const v = raw.trim();
  if (type === "email") return EMAIL.test(v) ? v.toLowerCase() : null;
  return normalizePhone(v);
}

/** Same output as Python mask_email / mask_phone. */
export function maskEmail(email: string) {
  const i = email.indexOf("@");
  const local = i < 0 ? email : email.slice(0, i);
  const domain = i < 0 ? "" : email.slice(i + 1);
  return domain
    ? `${local.slice(0, 2)}•••@${domain}`
    : `${local.slice(0, 2)}•••`;
}
export function maskPhone(phone: string) {
  const d = phone.replace(/\D/g, "");
  return d.length < 4 ? "+250 ••• •••" : `+250 ${d.slice(-9, -7)} ••• •••`;
}
export const maskIdentifier = (email: string | null, phone: string | null) =>
  email ? maskEmail(email) : phone ? maskPhone(phone) : "your account";

export const isStaffRole = (role: string) =>
  role.startsWith("staff:") || role === "ext:agent";
/** Python app/core/passwords.py staff_password_error. */
export function staffPasswordError(p: string): string | null {
  if (p.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p))
    return "Password must include upper and lower case letters.";
  if (!/\d/.test(p)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(p)) return "Password must include a symbol.";
  return null;
}

export const opaqueToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const genId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;

const BC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
/** XXXX-XXXX, the shape the /login/2fa backup field validates. */
export const backupCode = () =>
  Array.from({ length: 2 }, () =>
    Array.from({ length: 4 }, () => BC[randomInt(BC.length)]).join(""),
  ).join("-");
export const normalizeBackup = (c: string) => c.trim().toUpperCase();

/** "Chrome · Windows" from a User-Agent (good enough for a sessions list). */
export function deviceLabel(ua: string | null) {
  if (!ua) return "Unknown device";
  const b = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const o = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iPhone"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return [b, o].filter(Boolean).join(" · ") || ua.slice(0, 60);
}
