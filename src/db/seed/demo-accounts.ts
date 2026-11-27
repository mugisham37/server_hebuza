// Demo sign-in accounts only (sign-in roles, no demo data). Created when System → Settings → Security → Demo sign-in is turned on.
import { hash } from "@node-rs/argon2";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema";
import { staffProfiles, userRoles, users } from "../schema";
import { PERSONAS, SEED_CLIENT_PASSWORD, SEED_STAFF_PASSWORD } from "./auth";

const KEYS = ["client", "client-b", "agent", "ext", "partners", "sysadmin", "sysadmin2"];
export async function ensureDemoAccounts(tx: Pick<PostgresJsDatabase<typeof schema>, "insert">) {
  const opts = { memoryCost: 65536, timeCost: 3, parallelism: 1 }; // = PasswordService
  const [clientHash, staffHash] = await Promise.all([hash(SEED_CLIENT_PASSWORD, opts), hash(SEED_STAFF_PASSWORD, opts)]);
  const t = new Date().toISOString();
  for (const p of PERSONAS.filter((x) => KEYS.includes(x.key))) {
    const userId = `mock-${p.key}`, role = p.roles[0], staff = role !== "client";
    const ident = { name: p.name, email: p.email, passwordHash: staff ? staffHash : clientHash, role, isActive: true, isEmailVerified: true };
    await tx.insert(users).values({ userId, ...ident, language: "en", createdAt: t, updatedAt: t })
      .onConflictDoUpdate({ target: users.userId, set: { ...ident, updatedAt: t } });
    if (staff) await tx.insert(staffProfiles).values({ userId, twofaEnabled: false, createdAt: t }).onConflictDoNothing();
    for (const r of p.roles.slice(1))
      await tx.insert(userRoles).values({ userId, role: r, grantedBy: "all-workspaces", grantedAt: t }).onConflictDoNothing();
  }
}
