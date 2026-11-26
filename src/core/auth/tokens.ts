import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { REDIS } from "../queue/queue.module";
type RedisLike = { get(k: string): Promise<string | null>; set(k: string, v: string, mode: "EX", ttl: number): Promise<unknown> };
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, importPKCS8, importSPKI, generateKeyPair, exportJWK, calculateJwkThumbprint, type JWK, type CryptoKey } from "jose";
import { and, eq, isNull, sql } from "drizzle-orm";
import { authSessions, platformSettings, refreshTokens, users } from "@/db/schema";
import { settingOf } from "../db/system-records";
import { normalizeRoles } from "@/domain/auth/roles";
import type { Env } from "../config/env";
import type { SessionUser } from "../http/context";
import { AppError } from "../http/errors";
import type { Tx } from "../db/db";
import { TxService } from "../db/tx";

export const ACCESS_TTL_S = 600;
export const REFRESH_TTL_S = 30 * 86_400;
export const STEP_UP_TTL_S = 300;
const ISS = "hebuza", AUD = "hebuza-api", ALG = "EdDSA";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const unauth = (msg = "Not signed in") => new AppError(401, "unauthenticated", msg);

@Injectable()
export class TokenService implements OnModuleInit {
  private readonly log = new Logger(TokenService.name);
  private priv!: CryptoKey;
  private pub!: CryptoKey;
  /** SEC-rotation: tokens signed by the outgoing key verify until they expire (JWT_PUBLIC_KEY_PREVIOUS). */
  private prevPub?: CryptoKey;
  private jwk!: JWK;
  private prevJwk?: JWK;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly txs: TxService,
    @Optional() @Inject(REDIS) private readonly redis?: Promise<RedisLike> | RedisLike,
  ) {}

  /** Revoked sessions: their still-valid access tokens are refused until they would have expired anyway. */
  async denySessions(sids: string[]) {
    if (!sids.length || !this.redis) return;
    try {
      const r = await this.redis;
      await Promise.all(sids.map((sid) => r.set(`auth:deny:${sid}`, "1", "EX", ACCESS_TTL_S)));
    } catch (e) {
      this.log.error(`session denylist write failed: ${(e as Error).message}`);
    }
  }
  /** Fail-open only when Redis is unreachable (logged): the token is still signed and short-lived. */
  private async denied(sid: string) {
    if (!this.redis) return false;
    try {
      return (await (await this.redis).get(`auth:deny:${sid}`)) === "1";
    } catch (e) {
      this.log.warn(`session denylist unavailable, allowing: ${(e as Error).message}`);
      return false;
    }
  }

  async onModuleInit() {
    const pem = this.config.get("JWT_PRIVATE_KEY", { infer: true });
    if (pem.includes("BEGIN")) {
      this.priv = await importPKCS8(pem.replace(/\\n/g, "\n"), ALG);
      this.pub = await importSPKI(this.config.get("JWT_PUBLIC_KEY", { infer: true }).replace(/\\n/g, "\n"), ALG, { extractable: true });
    } else if (this.config.get("NODE_ENV", { infer: true }) !== "production") {
      this.log.warn("!!! JWT_PRIVATE_KEY is not a PEM, using an EPHEMERAL dev keypair; all sessions die on restart !!!");
      ({ privateKey: this.priv, publicKey: this.pub } = await generateKeyPair(ALG, { extractable: true }));
    } else throw new Error("JWT_PRIVATE_KEY must be an Ed25519 PKCS8 PEM in production");
    const jwk = await exportJWK(this.pub);
    this.jwk = { ...jwk, kid: await calculateJwkThumbprint(jwk), alg: ALG, use: "sig" };
    const prev = this.config.get("JWT_PUBLIC_KEY_PREVIOUS", { infer: true });
    if (prev?.includes("BEGIN")) {
      this.prevPub = await importSPKI(prev.replace(/\\n/g, "\n"), ALG, { extractable: true });
      const pj = await exportJWK(this.prevPub);
      this.prevJwk = { ...pj, kid: await calculateJwkThumbprint(pj), alg: ALG, use: "sig" };
    }
  }

  jwks() {
    return { keys: this.prevJwk ? [this.jwk, this.prevJwk] : [this.jwk] };
  }

  private sign(claims: Record<string, unknown>, sub: string, ttl: number) {
    return new SignJWT(claims).setProtectedHeader({ alg: ALG, kid: this.jwk.kid })
      .setIssuer(ISS).setAudience(AUD).setSubject(sub).setIssuedAt().setExpirationTime(`${ttl}s`).sign(this.priv);
  }

  private async verify(token: string, typ: string) {
    const opts = { issuer: ISS, audience: AUD, algorithms: [ALG] };
    const { payload } = await jwtVerify(token, this.pub, opts)
      .catch((e: unknown) => (this.prevPub ? jwtVerify(token, this.prevPub, opts) : Promise.reject(e)))
      .catch(() => {
        throw unauth();
      });
    if (payload.typ !== typ || typeof payload.sub !== "string" || typeof payload.sid !== "string") throw unauth();
    return payload as typeof payload & { sub: string; sid: string };
  }

  signAccess(u: SessionUser, ttl = ACCESS_TTL_S) {
    return this.sign({ typ: "access", roles: u.roles, scopes: u.scopes, sid: u.sid, stepUpAt: u.stepUpAt, act: u.act, mfa_enrolled: u.mfa, mfa_required: u.mfaRequired, active_role: u.activeRole }, u.id, ttl);
  }

  /** Signature + claims, then the revoked-session denylist (checked once per request by the guard). */
  async verifyAccess(token: string): Promise<SessionUser> {
    const p = await this.verify(token, "access");
    if (typeof p.sid === "string" && (await this.denied(p.sid))) throw unauth("Session revoked");
    const scopes = (p.scopes ?? {}) as SessionUser["scopes"];
    return { id: p.sub, sid: p.sid, roles: normalizeRoles({ roles: p.roles }), scopes, stepUpAt: typeof p.stepUpAt === "number" ? p.stepUpAt : undefined, act: typeof p.act === "string" ? p.act : undefined, mfa: typeof p.mfa_enrolled === "boolean" ? p.mfa_enrolled : undefined, mfaRequired: typeof p.mfa_required === "boolean" ? p.mfa_required : undefined, activeRole: typeof p.active_role === "string" ? (p.active_role as SessionUser["roles"][number]) : undefined };
  }

  /** Issued by the auth module after a fresh second factor; checked by AuthGuard on step-up routes. */
  signStepUp(u: SessionUser) {
    return this.sign({ typ: "step_up", sid: u.sid }, u.id, STEP_UP_TTL_S);
  }

  async verifyStepUp(token: string, u: SessionUser) {
    const p = await this.verify(token, "step_up");
    return p.sub === u.id && p.sid === u.sid;
  }

  /** Returns the raw opaque token (only its sha256 is stored). Family id = auth_sessions.id = sid. */
  async issueRefresh(tx: Tx, userId: string, sid: string, familyId = sid) {
    return (await this.insertRefresh(tx, userId, familyId)).raw;
  }

  private async insertRefresh(tx: Tx, userId: string, familyId: string) {
    const raw = randomBytes(32).toString("base64url");
    const id = randomUUID(), now = new Date();
    await tx.insert(refreshTokens).values({
      id, userId, familyId, tokenHash: sha256(raw),
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + REFRESH_TTL_S * 1000).toISOString(),
    });
    return { raw, id };
  }

  /** One-time use: a replayed token revokes the whole family (theft signal). */
  async rotateRefresh(tx: Tx, raw: string) {
    const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(raw))).for("update");
    if (!row) throw unauth();
    // Two tabs refreshing together: the loser re-reads the cookie the winner just set, so a fresh rotation isn't theft.
    if (row.replacedByTokenId && row.lastUsedAt && Date.now() - Date.parse(row.lastUsedAt) < 10_000) throw unauth("Refreshed elsewhere");
    if (row.revokedAt || row.replacedByTokenId) {
      // Own tx: the caller's tx rolls back on the throw below, the revocation must still commit.
      await this.txs.run((t) => this.revokeSession(t, row.familyId));
      throw new AppError(401, "refresh_reuse", "Session revoked");
    }
    const [session] = await tx.select({ revokedAt: authSessions.revokedAt }).from(authSessions).where(eq(authSessions.id, row.familyId));
    if (!session || session.revokedAt || Date.parse(row.expiresAt) <= Date.now()) throw unauth("Session expired");
    if ((await this.sessionEndsAt(tx, row.familyId)).getTime() <= Date.now()) {
      await this.revokeSession(tx, row.familyId);
      throw unauth("Session expired");
    }
    const next = await this.insertRefresh(tx, row.userId, row.familyId);
    const now = new Date().toISOString();
    await tx.update(refreshTokens).set({ revokedAt: now, lastUsedAt: now, replacedByTokenId: next.id }).where(eq(refreshTokens.id, row.id));
    await tx.update(authSessions).set({ lastSeenAt: now }).where(eq(authSessions.id, row.familyId));
    return { refresh: next.raw, userId: row.userId, sid: row.familyId, endsAt: await this.sessionEndsAt(tx, row.familyId) };
  }

  /**
   * IAM-11: a session ends at the earlier of idle (last seen + platform session_timeout_minutes) and absolute
   * lifetime (created + 24 h clients / 8 h staff).
   * Idle counts from the last activity ping (real input in the web app), so background polling never keeps a session alive.
   */
  async sessionEndsAt(tx: Tx, sid: string): Promise<Date> {
    const [r] = await tx.select({ created: authSessions.createdAt, seen: sql<string>`coalesce(${authSessions.lastActivityAt}, ${authSessions.createdAt})`, role: users.role })
      .from(authSessions).innerJoin(users, eq(users.userId, authSessions.userId)).where(eq(authSessions.id, sid));
    if (!r) return new Date(0);
    // Per-role policy from the console (security.idle_minutes.*, registry defaults 30/30/60); the legacy platform value
    // is the fallback when the console has none. Sysadmin absolute lifetime is 4 h (security.absolute_hours.sysadmin).
    const kind = r.role === "staff:sysadmin" ? "sysadmin" : r.role.startsWith("staff:") || r.role === "ext:agent" ? "staff" : "client";
    const [p] = await tx.select({ m: platformSettings.sessionTimeoutMinutes }).from(platformSettings).limit(1);
    const idleMin = (await settingOf<number>(tx, `security.idle_minutes.${kind}`)) ?? p?.m ?? 60;
    const idle = Date.parse(r.seen) + idleMin * 60_000;
    const abs = Date.parse(r.created) + ({ sysadmin: 4, staff: 8, client: 24 } as const)[kind] * 3_600_000;
    return new Date(Math.min(idle, abs));
  }

  /** IAM-11: the user did something (throttled ping from the web app). */
  async touchActivity(tx: Tx, sid: string) {
    await tx.update(authSessions).set({ lastActivityAt: new Date().toISOString() }).where(and(eq(authSessions.id, sid), isNull(authSessions.revokedAt)));
  }

  async revokeSession(tx: Tx, sid: string) {
    const now = new Date().toISOString();
    await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.familyId, sid), isNull(refreshTokens.revokedAt)));
    await tx.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.id, sid), isNull(authSessions.revokedAt)));
    await this.denySessions([sid]);
  }
}
