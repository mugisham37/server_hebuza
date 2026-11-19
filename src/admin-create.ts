// One-off: create the first sysadmin (IAM-17: refuses when one exists and never overwrites a password). Never seed production; use this instead.
// `ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… node dist/admin-create.js` (or `pnpm admin:create` in dev). Needs DATABASE_URL.
// The user enrols TOTP at first sign-in (twofa off until then).
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { staffProfiles, users } from "@/db/schema";
import { genId } from "@/modules/auth/auth.rules";

const [email, name, password] = [process.env.ADMIN_EMAIL ?? process.argv[2], process.env.ADMIN_NAME ?? process.argv[3], process.env.ADMIN_PASSWORD];
const url = process.env.DATABASE_URL;
if (!url || !email || !name || !password) throw new Error("DATABASE_URL, ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD are required");
// Staff password rule (12+, upper/lower, digit, symbol) — same as the API's.
if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/.test(password)) throw new Error("ADMIN_PASSWORD must be 12+ chars with upper, lower, digit and symbol");

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });
async function main() {
  const passwordHash = await hash(password!, { memoryCost: 65536, timeCost: 3, parallelism: 1 }); // = PasswordService
  const t = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.roles', 'system', true)`); // FORCE RLS binds the owner too
    const [any] = await tx.select({ id: users.userId }).from(users).where(sql`${users.role} = 'staff:sysadmin'`).limit(1);
    if (any) throw new Error("A sysadmin already exists; reset passwords through the console, not this script");
    const [u] = await tx.insert(users)
      .values({ userId: genId("usr"), name: name!, email: email!.toLowerCase(), passwordHash, role: "staff:sysadmin", isActive: true, isEmailVerified: true, language: "en", createdAt: t, updatedAt: t })
      .onConflictDoNothing()
      .returning({ userId: users.userId });
    if (!u) throw new Error("That email already has an account");
    await tx.insert(staffProfiles).values({ userId: u.userId, twofaEnabled: false, createdAt: t }).onConflictDoNothing();
    console.log(`sysadmin ready: ${email} (${u.userId})`);
  });
}
main().finally(() => client.end()).catch((e) => { console.error(e); process.exitCode = 1; });
