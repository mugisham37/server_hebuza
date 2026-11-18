// TOTP (authenticator apps) + one-time codes for SMS/email.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { authenticator } from "otplib";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { staffProfiles } from "@/db/schema";
import type { Tx } from "../db/db";

authenticator.options = { window: 1 }; // ±30 s clock drift
const STEP_MS = 30_000;

export const totp = {
  secret: () => authenticator.generateSecret(),
  uri: (account: string, secret: string) => authenticator.keyuri(account, "HEBUZA", secret),
  /** Returns the matched time-step, or null. Persist it with claimTotpStep to block replays. */
  verify: (token: string, secret: string): number | null => {
    if (!/^\d{6}$/.test(token)) return null;
    const delta = authenticator.checkDelta(token, secret);
    return delta === null ? null : Math.floor(Date.now() / STEP_MS) + delta;
  },
};

/** Atomically records `step` as the user's last TOTP step; false when step ≤ last (replay). */
export async function claimTotpStep(tx: Tx, userId: string, step: number) {
  const rows = await tx.update(staffProfiles).set({ totpLastStep: step })
    .where(and(eq(staffProfiles.userId, userId), or(isNull(staffProfiles.totpLastStep), lt(staffProfiles.totpLastStep, step))))
    .returning({ userId: staffProfiles.userId });
  return rows.length > 0;
}

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;

// Keyed so a leaked DB row can't be brute-forced offline.
const pepper = () => {
  const k = process.env.BLIND_INDEX_KEY;
  if (!k) throw new Error("BLIND_INDEX_KEY is not set: OTP hashing needs it as pepper");
  return k;
};
export const hashOtp = (code: string) => createHmac("sha256", pepper()).update(`otp:${code}`).digest("hex");

export function newOtp() {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  return { code, hash: hashOtp(code), expiresAt: new Date(Date.now() + OTP_TTL_MS) };
}

/**
 * Atomic check: spends one attempt only while the row is live (attempts < 5, unexpired), then compares.
 * Table must have `code_hash`, `attempts`, `expires_at` columns (e.g. field_otps, idCol = fieldOtps.visitId).
 * "dead" = missing, expired or locked. On "ok" the caller deletes/consumes the row.
 */
export async function checkOtp(tx: Tx, table: PgTable, idCol: PgColumn, id: string, code: string): Promise<"ok" | "bad" | "dead"> {
  const [row] = await tx.execute<{ hash: string }>(sql`update ${table} set attempts = attempts + 1
    where ${idCol} = ${id} and attempts < ${OTP_MAX_ATTEMPTS} and expires_at > now() returning code_hash as hash`);
  if (!row) return "dead";
  const a = Buffer.from(hashOtp(code), "hex"), b = Buffer.from(row.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}
