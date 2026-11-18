import { z } from "zod";
import { invalid } from "../http/errors";

export const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuery>;

type Key = readonly (string | number)[];
const encodeCursor = (key: Key) => Buffer.from(JSON.stringify(key)).toString("base64url");

/** Opaque keyset cursor → the last row's sort key(s); null when absent, 422 when malformed. */
export function decodeCursor(c: string | undefined): (string | number)[] | null {
  if (!c) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v;
  } catch { /* fall through to invalid */ }
  throw invalid({ cursor: "Invalid cursor" });
}

/** Fetch limit+1 rows, then call this: trims and builds nextCursor from the last kept row. */
export function page<T>(rows: T[], limit: number, keyOf: (r: T) => Key) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(keyOf(items[items.length - 1])) : null };
}
