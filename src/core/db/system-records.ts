// Read-only access to system-console documents (system_records) for other modules: settings, notification rules,
// templates, budgets. Writes stay in the system world (system.world.ts) so they keep the lock + audit.
import { and, eq, sql } from "drizzle-orm";
import { normalizeRoles } from "@/domain/auth/roles";
import { systemRecords } from "@/db/schema";
import { SETTINGS } from "@/domain/system/settings-registry";
import type { Db } from "./db";

type Reader = Pick<Db, "select">;

export async function systemDocs<T>(db: Reader, kind: string): Promise<T[]> {
  const rows = await db
    .select({ data: systemRecords.data })
    .from(systemRecords)
    .where(eq(systemRecords.kind, kind))
    .orderBy(systemRecords.pos);
  return rows.map((r) => r.data as T);
}

const cache = new Map<string, { at: number; v: unknown }>();
/** PLACEHOLDER(settings-cache-ttl) guards read settings on every request; 10 s staleness across instances is accepted. */
const TTL_MS = 10_000;

/** Current value of a registry setting (console value, else the registry default). */
export async function settingOf<T>(
  db: Reader,
  key: string,
  now = Date.now(),
): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.v as T;
  const [r] = await db
    .select({ data: systemRecords.data })
    .from(systemRecords)
    .where(and(eq(systemRecords.kind, "settings"), eq(systemRecords.id, key)));
  const v = r
    ? (r.data as { value: unknown }).value
    : SETTINGS.find((d) => d.key === key)?.default;
  cache.set(key, { at: now, v });
  return v as T;
}

/** Active users holding any of `roles`: users.role (legacy names normalised) ∪ unexpired console grants
 *  (userMeta.extraRoles) — the same resolution as AuthService.access. */
export async function usersWithRole(db: Pick<Db, "execute">, roles: readonly string[]): Promise<string[]> {
  const rows = (await db.execute(sql`select u.user_id as id, u.role, m.data->'extraRoles' as grants
    from users u left join system_records m on m.kind = 'userMeta' and m.id = u.user_id
    where u.is_active and (u.role like 'staff:%' or m.data ? 'extraRoles')`)) as unknown as { id: string; role: string; grants: { role: string; expiresAt: string | null }[] | null }[]; // cast: execute() rows are untyped
  const now = Date.now();
  return rows.filter((r) => normalizeRoles({ roles: [r.role, ...(r.grants ?? []).filter((g) => !g.expiresAt || Date.parse(g.expiresAt) > now).map((g) => g.role)] })
    .some((x) => roles.includes(x))).map((r) => r.id);
}
