// Production migration runner (no drizzle-kit in the runtime image): `node dist/migrate.js`, then exits.
// Same journal + `drizzle.__drizzle_migrations` table as `drizzle-kit migrate`, so dev and prod histories agree.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = postgres(url, { max: 1 });
migrate(drizzle(client), { migrationsFolder: process.env.MIGRATIONS_DIR ?? join(__dirname, "../src/db/migrations") })
  .then(() => console.log("migrations applied"))
  .finally(() => client.end())
  .catch((e) => { console.error(e); process.exitCode = 1; });
