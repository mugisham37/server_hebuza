// Read-only access to system-console documents (system_records) for other modules: settings, notification rules,
// templates, budgets. Writes stay in the system world (system.world.ts) so they keep the lock + audit.
import { and, eq } from "drizzle-orm";
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
