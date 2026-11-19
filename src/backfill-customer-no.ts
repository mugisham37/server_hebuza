// One-off (CRM-01): give every existing client without a customer number one, oldest account first.
// `pnpm tsx src/backfill-customer-no.ts` (needs DATABASE_URL). Safe to re-run: assignCustomerNo skips users that have one.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { users } from "@/db/schema";
import { assignCustomerNo } from "@/core/db/customer-no";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });
async function main() {
  const n = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.roles', 'system', true)`); // FORCE RLS binds the owner too
    const rows = await tx.select({ id: users.userId }).from(users)
      .where(and(eq(users.role, "client"), isNull(users.customerNo))).orderBy(asc(users.createdAt));
    // shortcut: numbers use the current year, not the registration year; fine for a one-time cutover.
    for (const r of rows) await assignCustomerNo(tx, r.id);
    return rows.length;
  });
  console.log(`customer numbers assigned: ${n}`);
}
main().finally(() => client.end()).catch((e) => { console.error(e); process.exitCode = 1; });
