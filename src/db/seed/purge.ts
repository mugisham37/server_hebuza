// `pnpm db:purge-demo` — remove demo/seed data from a target DB; real users and reference data (catalogue, plans, CMS) stay.
// Dry run by default: everything runs in one transaction, the counts are printed and the transaction is rolled back.
// `--apply` commits. Idempotent (a second run finds nothing). Demo users = seed personas: ids `mock-%` or emails on
// the reserved .test/.example domains. Rows owned by them are deleted through every FK to users, children first.
// Run as `system` (FORCE RLS binds the owner too). Production needs ALLOW_PURGE=production as a deliberate opt-in.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const apply = process.argv.includes("--apply");
if (
  apply &&
  process.env.NODE_ENV === "production" &&
  process.env.ALLOW_PURGE !== "production"
)
  throw new Error(
    "refusing to purge production without ALLOW_PURGE=production",
  );

const DEMO_USERS = `select user_id from users where user_id like 'mock-%' or email ~* '\\.(test|example)$' or email ~* '@[^@]*\\.example$'`;
// finance/ops documents seeded from the mock worlds carry the demo ids inside jsonb.
const JSONB_OWNED: [table: string, cond: string][] = [
  [
    "finance_records",
    `data->>'clientId' in (${DEMO_USERS}) or data->>'workerId' in (${DEMO_USERS}) or (kind in ('client','worker','service','case'))`,
  ],
  ["ops_records", `owner_id in (${DEMO_USERS})`],
];

const sql = postgres(url, { max: 1, onnotice: () => {} });
type Fk = { tbl: string; col: string };
const counts = new Map<string, number>();
const add = (t: string, n: number) => counts.set(t, (counts.get(t) ?? 0) + n);

const run = async () => {
  await sql
    .begin(async (tx) => {
      await tx`select set_config('app.roles', 'system', true)`;
      const fks = await tx<Fk[]>`
        select c.conrelid::regclass::text tbl, a.attname col
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and c.confrelid = 'users'::regclass`;
      const targets: [string, string][] = [
        ...JSONB_OWNED,
        ...fks.map((f): [string, string] => [
          f.tbl,
          `"${f.col}" in (${DEMO_USERS})`,
        ]),
      ];
      // Delete in passes; a statement blocked by another FK is retried after its children are gone.
      for (let pass = 0, progress = true; progress && pass < 20; pass++) {
        progress = false;
        for (const [t, cond] of targets) {
          await tx.unsafe("savepoint p");
          try {
            const r = await tx.unsafe(`delete from ${t} where ${cond}`);
            await tx.unsafe("release savepoint p");
            if (r.count) (add(t, r.count), (progress = true));
          } catch (e) {
            await tx.unsafe("rollback to savepoint p");
            if ((e as { code?: string }).code !== "23503") throw e; // only FK ordering is retried
          }
        }
      }
      const r = await tx.unsafe(
        `delete from users where user_id in (${DEMO_USERS})`,
      );
      add("users", r.count);
      for (const [t, n] of [...counts].sort())
        console.log(
          `${apply ? "deleted" : "would delete"} ${String(n).padStart(6)}  ${t}`,
        );
      if (!counts.size) console.log("nothing to purge");
      if (!apply) throw new DryRun();
    })
    .catch((e: unknown) => {
      if (!(e instanceof DryRun)) throw e;
      console.log("dry run: rolled back (pass --apply to commit)");
    });
  await sql.end();
};
class DryRun extends Error {}
void run().catch(async (e: unknown) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
