// `pnpm db:reset` step 1: drop everything (app schema + drizzle's migration log) so migrate + seed
// rebuild from zero. Dev/e2e only.
import postgres from "postgres";

if (process.env.NODE_ENV === "production") throw new Error("refusing to reset production");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = postgres(url, { max: 1, onnotice: () => {} });
await db.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await db.end();
