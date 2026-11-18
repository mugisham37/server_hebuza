import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { conflict } from "../http/errors";

export const DB = Symbol("DB");
export const createDb = (url: string, max: number) =>
  // prepare:false — PgBouncer transaction mode cannot hold named prepared statements.
  drizzle(postgres(url, { max, prepare: false, idle_timeout: 30, connect_timeout: 5, onnotice: () => {} }), { schema });
export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type Versioned = PgTable & { version: PgColumn };

/** Optimistic update: bumps `version`; 409 `conflict` when the row moved past `expectedVersion` (or is gone). */
export async function versioned<T extends Versioned>(tx: Tx, table: T, id: string, expectedVersion: number, patch: PgUpdateSetSource<T>) {
  const pk = Object.values(getTableColumns(table)).find((c) => c.primary);
  if (!pk) throw new Error("versioned(): table has no single-column primary key");
  const rows = await tx.update(table)
    .set({ ...patch, version: sql`${table.version} + 1` } as PgUpdateSetSource<T>)
    .where(and(eq(pk, id), eq(table.version, expectedVersion)))
    .returning();
  if (!rows.length) throw conflict("This record was changed by someone else. Refresh and try again.");
  return rows[0];
}
