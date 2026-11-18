import { randomUUID } from "node:crypto";

/** Prefixed opaque id, e.g. `doc_3f2a…` (one helper for every module). */
export const generateId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "")}`;
/** ISO timestamp; defaults to now. */
export const iso = (t: number | Date = Date.now()) => new Date(t).toISOString();
