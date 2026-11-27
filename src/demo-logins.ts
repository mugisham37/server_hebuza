// One-off: create the demo sign-in accounts (sign-in roles only, no demo data) and turn on security.demo_logins.
// `node dist/demo-logins.js` (needs DATABASE_URL). Undo: System → Settings → Security → Demo sign-in off, deactivate the mock-* users.
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { staffProfiles, systemRecords, userRoles, users } from "@/db/schema";
import { PERSONAS, SEED_CLIENT_PASSWORD, SEED_STAFF_PASSWORD } from "@/db/seed/auth";

const KEYS = ["client", "client-b", "agent", "ext", "partners", "sysadmin", "sysadmin2"];
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });
async function main() {
  const opts = { memoryCost: 65536, timeCost: 3, parallelism: 1 }; // = PasswordService
  const [clientHash, staffHash] = await Promise.all([hash(SEED_CLIENT_PASSWORD, opts), hash(SEED_STAFF_PASSWORD, opts)]);
  const t = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.roles', 'system', true)`); // FORCE RLS binds the owner too
    for (const p of PERSONAS.filter((x) => KEYS.includes(x.key))) {
      const userId = `mock-${p.key}`, role = p.roles[0], staff = role !== "client";
      const ident = { name: p.name, email: p.email, passwordHash: staff ? staffHash : clientHash, role, isActive: true, isEmailVerified: true };
      await tx.insert(users).values({ userId, ...ident, language: "en", createdAt: t, updatedAt: t })
        .onConflictDoUpdate({ target: users.userId, set: { ...ident, updatedAt: t } });
      if (staff) await tx.insert(staffProfiles).values({ userId, twofaEnabled: false, createdAt: t }).onConflictDoNothing();
      for (const r of p.roles.slice(1))
        await tx.insert(userRoles).values({ userId, role: r, grantedBy: "all-workspaces", grantedAt: t }).onConflictDoNothing();
      console.log(`ready: ${p.email}`);
    }
    const data = { key: "security.demo_logins", value: true, changedBy: "demo-logins script", changedAt: t };
    await tx.insert(systemRecords).values({ kind: "settings", id: "security.demo_logins", pos: Date.now(), data })
      .onConflictDoUpdate({ target: [systemRecords.kind, systemRecords.id], set: { data, updatedAt: t } });
    console.log("security.demo_logins = true");
  });
}
main().finally(() => client.end()).catch((e) => { console.error(e); process.exitCode = 1; });
