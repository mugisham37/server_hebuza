// One-off: create (or top up) the owner account that can open every workspace — primary staff:sysadmin plus a
// user_roles grant for each other role. Never overwrites an existing password. Owner enrols TOTP at first sign-in.
// `OWNER_EMAIL=… OWNER_NAME=… OWNER_PHONE=+2507… OWNER_PASSWORD=… node dist/owner-account.js`. Needs DATABASE_URL.
// shortcut: one account holding every role skips separation of duties; split into per-person accounts once staff are hired.
import { hash } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { agentProfiles, staffProfiles, userRoles, users } from "@/db/schema";
import { genId } from "@/modules/auth/auth.rules";

const ROLES = [
  "client",
  "staff:agent",
  "ext:agent",
  "staff:service_manager",
  "staff:finance",
  "staff:marketing",
  "staff:procurement",
  "staff:partner_manager",
  "staff:executive",
] as const; // + primary staff:sysadmin = all 10 workspaces
const {
  DATABASE_URL: url,
  OWNER_EMAIL,
  OWNER_NAME,
  OWNER_PHONE,
  OWNER_PASSWORD: password,
} = process.env;
if (!url || !OWNER_EMAIL || !OWNER_NAME || !password)
  throw new Error(
    "DATABASE_URL, OWNER_EMAIL, OWNER_NAME and OWNER_PASSWORD are required",
  );
if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/.test(password))
  throw new Error(
    "OWNER_PASSWORD must be 12+ chars with upper, lower, digit and symbol",
  );
if (OWNER_PHONE && !/^\+\d{8,15}$/.test(OWNER_PHONE))
  throw new Error("OWNER_PHONE must be E.164, e.g. +250788313582");
const email = OWNER_EMAIL.toLowerCase(), name = OWNER_NAME, pw = password;

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });
async function main() {
  const t = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.roles', 'system', true)`); // FORCE RLS binds the owner too
    let [u] = await tx
      .select({ id: users.userId, role: users.role })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!u) {
      const passwordHash = await hash(pw, {
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      }); // = PasswordService
      [u] = await tx
        .insert(users)
        .values({
          userId: genId("usr"),
          name,
          email,
          phoneE164: OWNER_PHONE ?? null,
          passwordHash,
          role: "staff:sysadmin",
          isActive: true,
          isEmailVerified: true,
          language: "en",
          createdAt: t,
          updatedAt: t,
        })
        .returning({ id: users.userId, role: users.role });
      await tx
        .insert(staffProfiles)
        .values({ userId: u.id, twofaEnabled: false, createdAt: t })
        .onConflictDoNothing();
      console.log(`created ${email} (${u.id})`);
    } else
      console.log(
        `exists ${email} (${u.id}, primary ${u.role}), password left unchanged; adding missing roles`,
      );
    for (const role of [...ROLES, "staff:sysadmin"].filter((r) => r !== u.role))
      await tx
        .insert(userRoles)
        .values({
          userId: u.id,
          role,
          grantedBy: "owner-account",
          grantedAt: t,
        })
        .onConflictDoNothing();
    await tx.insert(agentProfiles).values({ userId: u.id, title: "System admin", clearance: "cleared" }).onConflictDoNothing(); // assignable as an agent
    const got = await tx
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, u.id));
    const all = new Set([u.role, ...got.map((r) => r.role)]);
    if (all.size < ROLES.length + 1)
      throw new Error(`only ${all.size} roles granted`);
    console.log(`roles (${all.size}): ${[...all].join(", ")}`);
  });
}
main()
  .finally(() => client.end())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
