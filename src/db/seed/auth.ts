// Dev/staging users = the MSW personas (web mocks personas), ids `mock-<key>` so persona-signed test tokens resolve.
// Idempotent. Demo credentials only — the seed runner must refuse production. Hashing/encryption are passed in by the
// runner (server PasswordService.hash + CryptoService.encrypt) so this package stays dependency-free.
import { createHash } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema";
import { authSessions, authTrustedDevices, refreshTokens, staffProfiles, users } from "../schema";

export const SEED_CLIENT_PASSWORD = "Demo-pass-1";
export const SEED_STAFF_PASSWORD = "Demo-pass-staff-1!"; // meets the staff rule (12+, upper/lower, digit, symbol)
export const SEED_TOTP_SECRET = "JBSWY3DPEHPK3PXP"; // the secret the enrolment mock shows; add it to any authenticator
const DEMO_PHONE = "+250788000000";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const isStaff = (role: string) => role.startsWith("staff:") || role === "ext:agent";

const PERSONAS: { key: string; name: string; email: string; roles: string[] }[] = [
  { key: "client", name: "Demo Client", email: "client@example.test", roles: ["client"] },
  { key: "unverified", name: "Demo New Client", email: "new@example.test", roles: ["client"] },
  { key: "agent", name: "Eric Habimana", email: "eric.habimana@hebuza.example", roles: ["staff:agent"] },
  { key: "ext", name: "Jean-Paul Nkurunziza", email: "jean-paul.nkurunziza@ingabo.example", roles: ["ext:agent"] },
  { key: "sm", name: "Diane Mukamana", email: "diane.mukamana@hebuza.example", roles: ["staff:service_manager"] },
  { key: "finance", name: "Patrick Niyonzima", email: "patrick.niyonzima@hebuza.example", roles: ["staff:finance"] },
  { key: "finance2", name: "Solange Mukeshimana", email: "solange.mukeshimana@hebuza.example", roles: ["staff:finance"] },
  { key: "marketing", name: "Grace Mutesi", email: "grace.mutesi@hebuza.example", roles: ["staff:marketing"] },
  { key: "procurement", name: "Josiane Uwera", email: "josiane.uwera@hebuza.example", roles: ["staff:procurement"] },
  { key: "partners", name: "Demo Partner Manager", email: "pm@example.test", roles: ["staff:partner_manager"] },
  { key: "exec", name: "Alice Mutoni", email: "alice.mutoni@hebuza.example", roles: ["staff:executive", "staff:service_manager"] },
  { key: "sysadmin", name: "Innocent Kayitare", email: "innocent.kayitare@hebuza.example", roles: ["staff:sysadmin"] },
  { key: "sysadmin2", name: "Yvonne Uwamahoro", email: "yvonne.uwamahoro@hebuza.example", roles: ["staff:sysadmin"] },
  { key: "field", name: "Emmanuel Mugabo", email: "emmanuel.mugabo@hebuza.example", roles: ["staff:agent"] },
  { key: "client-b", name: "Demo Client B", email: "client-b@example.test", roles: ["client"] },
  { key: "ext-member", name: "Chantal Mukamana", email: "chantal.mukamana@ingabo.example", roles: ["ext:agent"] },
];

export type SeedAuthDeps = { hash: (pw: string) => Promise<string>; encrypt: (plain: string) => string };

export async function seedAuth(db: PostgresJsDatabase<typeof schema>, deps: SeedAuthDeps) {
  const [clientHash, staffHash] = await Promise.all([deps.hash(SEED_CLIENT_PASSWORD), deps.hash(SEED_STAFF_PASSWORD)]);
  const t = "2026-01-01T00:00:00Z";
  for (const p of PERSONAS) {
    const role = p.roles[0]; // shortcut: one stored role (exec loses staff:service_manager) until role grants are seeded
    const staff = isStaff(role);
    const ident = { name: p.name, email: p.email, phoneE164: p.key === "client" ? DEMO_PHONE : null, passwordHash: staff ? staffHash : clientHash, role };
    await db.insert(users)
      .values({ userId: `mock-${p.key}`, ...ident, isActive: true, isEmailVerified: p.key !== "unverified", language: staff ? "en" : "rw", createdAt: t, updatedAt: t })
      .onConflictDoUpdate({ target: users.userId, set: ident }); // other seeds may create the persona bare; auth owns identity fields
    if (staff) {
      const totpSecretEncrypted = deps.encrypt(SEED_TOTP_SECRET); // re-encrypt: FIELD_KEY may differ from a previous run
      await db.insert(staffProfiles).values({ userId: `mock-${p.key}`, totpSecretEncrypted, twofaEnabled: true, createdAt: t })
        .onConflictDoUpdate({ target: staffProfiles.userId, set: { totpSecretEncrypted, twofaEnabled: true, totpLastStep: null } });
    }
  }
  // Sessions / trusted devices like the settings mocks. Reset to live on every run.
  const day = 86_400_000, ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const future = new Date(Date.now() + 30 * day).toISOString();
  for (const x of [
    { id: "rtf_seed_client_1", device: "Chrome · Android", city: "Kigali", seen: 0.2 },
    { id: "rtf_seed_client_2", device: "Safari · iPhone", city: "Musanze", seen: 50 },
  ]) {
    const row = { id: x.id, userId: "mock-client", device: x.device, ip: "41.186.20.10", city: x.city, createdAt: ago(x.seen + 24), lastSeenAt: ago(x.seen), revokedAt: null };
    await db.insert(authSessions).values(row).onConflictDoUpdate({ target: authSessions.id, set: { revokedAt: null, lastSeenAt: row.lastSeenAt } });
    const rt = { id: x.id.replace("rtf", "rti"), userId: row.userId, familyId: x.id, tokenHash: sha256(`seed:${x.id}`), expiresAt: future, createdAt: row.createdAt, revokedAt: null };
    await db.insert(refreshTokens).values(rt).onConflictDoUpdate({ target: refreshTokens.id, set: { revokedAt: null, replacedByTokenId: null, expiresAt: future } });
  }
  for (const label of ["Chrome · Linux", "Safari · iPhone"]) {
    const id = `dev_seed_sm_${label.split(" ")[0].toLowerCase()}`;
    await db.insert(authTrustedDevices)
      .values({ id, userId: "mock-sm", tokenHash: sha256(`seed:${id}`), label, place: "Kigali", trustedUntil: future, createdAt: ago(24 * 20), lastUsedAt: ago(3) })
      .onConflictDoUpdate({ target: authTrustedDevices.id, set: { trustedUntil: future } });
  }
}
