// One-off: create the demo sign-in accounts (sign-in roles only, no demo data) and turn on security.demo_logins.
// `node dist/demo-logins.js` (needs DATABASE_URL). Undo: System → Settings → Security → Demo sign-in off, deactivate the mock-* users.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { systemRecords } from "@/db/schema";
import { ensureDemoAccounts } from "@/db/seed/demo-accounts";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });
async function main() {
  const t = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.roles', 'system', true)`); // FORCE RLS binds the owner too
    await ensureDemoAccounts(tx);
    console.log("demo accounts ready");
    const data = { key: "security.demo_logins", value: true, changedBy: "demo-logins script", changedAt: t };
    await tx.insert(systemRecords).values({ kind: "settings", id: "security.demo_logins", pos: Date.now(), data })
      .onConflictDoUpdate({ target: [systemRecords.kind, systemRecords.id], set: { data, updatedAt: t } });
    console.log("security.demo_logins = true");
  });
}
main().finally(() => client.end()).catch((e) => { console.error(e); process.exitCode = 1; });
