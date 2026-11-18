// Identity side effects the system console triggers on other modules' tables (sessions, MFA, reset tokens,
// impersonation). Session revocation and reset links delegate to AuthService (deps.auth).
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  authImpersonations,
  authTrustedDevices,
  backupCodes,
  staffProfiles,
} from "@/db/schema";
import type { Exec } from "./system.world";
import { iso } from "../../core/db/ids";

export { genId as generateId, sha256 as hashToken } from "../auth/auth.rules";

export async function resetMfa(db: Exec, uid: string) {
  await db
    .update(staffProfiles)
    .set({ twofaEnabled: false, totpSecretEncrypted: null })
    .where(eq(staffProfiles.userId, uid));
  await db.delete(backupCodes).where(eq(backupCodes.userId, uid));
  await db.delete(authTrustedDevices).where(eq(authTrustedDevices.userId, uid));
}

export const currentImpersonation = (db: Exec, actorId: string) =>
  db
    .select()
    .from(authImpersonations)
    .where(
      and(
        eq(authImpersonations.actorId, actorId),
        isNull(authImpersonations.endedAt),
        gt(authImpersonations.until, iso()),
      ),
    )
    .then((r) => r[0]);
