import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ClsService } from "nestjs-cls";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { auditLog, users } from "@/db/schema";
import type { RequestStore } from "../http/context";
import type { Tx } from "./db";

export const GENESIS = "0".repeat(64);

/** Stable JSON: sorted keys at every depth, so jsonb key reordering can't break a hash. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

type AuditRow = Omit<typeof auditLog.$inferInsert, "chainSeq" | "chainPrev" | "chainHash">;
// createdAt hashed as epoch ms: the DB returns timestamps in its own text format. Verifiers reuse this.
export const linkHash = (prev: string, seq: number, r: AuditRow) =>
  createHash("sha256").update(prev).update(canonical({ ...r, createdAt: Date.parse(r.createdAt), seq })).digest("hex");

export type AuditEntry = { action: string; entity: string; entityId: string; before?: unknown; after?: unknown; reason?: string };

@Injectable()
export class AuditService {
  /** Actor display name, looked up once per tx (history views show names, not ids). */
  private readonly names = new WeakMap<Tx, Map<string, string | null>>();
  constructor(private readonly ctx: ClsService<RequestStore>) {}

  private async actorName(tx: Tx, id: string | null) {
    if (!id) return null;
    let m = this.names.get(tx);
    if (!m) this.names.set(tx, (m = new Map()));
    if (!m.has(id)) {
      const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.userId, id));
      m.set(id, u?.name ?? null);
    }
    return m.get(id) ?? null;
  }

  /** Appends a hash-chained row in the caller's tx (rolls back with it). Call it last in the tx: the chain lock is held until commit. */
  async record(tx: Tx, e: AuditEntry) {
    // Serialise chain writers across instances; lock is released at commit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit_log_chain'))`);
    const [last] = await tx.select({ seq: auditLog.chainSeq, hash: auditLog.chainHash }).from(auditLog)
      .where(isNotNull(auditLog.chainSeq)).orderBy(desc(auditLog.chainSeq)).limit(1);
    const user = this.ctx.isActive() ? this.ctx.get("user") : null;
    const actorId = user?.act ?? user?.id ?? null;
    const actorName = await this.actorName(tx, actorId);
    const row: AuditRow = {
      id: `aud_${randomUUID()}`, actorId, actorRole: user?.act ? null : (user?.roles[0] ?? null), action: e.action,
      resourceType: e.entity, resourceId: e.entityId, details: { before: e.before, after: e.after, reason: e.reason, ...(actorName && { actorName }), ...(user?.act && { impersonatorId: user.act, viewAs: user.id }) },
      ipAddress: this.ctx.isActive() ? (this.ctx.get("ip") ?? null) : null, kind: user ? "admin" : "system",
      createdAt: new Date().toISOString(),
    };
    const prev = last?.hash ?? GENESIS;
    const seq = (last?.seq ?? 0) + 1;
    await tx.insert(auditLog).values({ ...row, chainSeq: seq, chainPrev: prev, chainHash: linkHash(prev, seq, row) });
  }
}
