import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, importPKCS8, importSPKI, generateKeyPair, exportJWK, calculateJwkThumbprint, type JWK, type CryptoKey } from "jose";
import { and, eq, isNull } from "drizzle-orm";
import { authSessions, refreshTokens } from "@/db/schema";
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
  private jwk!: JWK;

  constructor(private readonly config: ConfigService<Env, true>, private readonly txs: TxService) {}

  async onModuleInit() {
    const pem = this.config.get("JWT_PRIVATE_KEY", { infer: true });
    if (pem.includes("BEGIN")) {
      this.priv = await importPKCS8(pem.replace(/\\n/g, "\n"), ALG);
      this.pub = await importSPKI(this.config.get("JWT_PUBLIC_KEY", { infer: true }).replace(/\\n/g, "\n"), ALG, { extractable: true });
    } else if (this.config.get("NODE_ENV", { infer: true }) !== "production") {
      this.log.warn("!!! JWT_PRIVATE_KEY is not a PEM — using an EPHEMERAL dev keypair; all sessions die on restart !!!");
      ({ privateKey: this.priv, publicKey: this.pub } = await generateKeyPair(ALG, { extractable: true }));
    } else throw new Error("JWT_PRIVATE_KEY must be an Ed25519 PKCS8 PEM in production");
    const jwk = await exportJWK(this.pub);
    this.jwk = { ...jwk, kid: await calculateJwkThumbprint(jwk), alg: ALG, use: "sig" };
  }

  jwks() {
    return { keys: [this.jwk] };
  }

  private sign(claims: Record<string, unknown>, sub: string, ttl: number) {
    return new SignJWT(claims).setProtectedHeader({ alg: ALG, kid: this.jwk.kid })
      .setIssuer(ISS).setAudience(AUD).setSubject(sub).setIssuedAt().setExpirationTime(`${ttl}s`).sign(this.priv);
  }

  private async verify(token: string, typ: string) {
    const { payload } = await jwtVerify(token, this.pub, { issuer: ISS, audience: AUD, algorithms: [ALG] }).catch(() => {
      throw unauth();
    });
    if (payload.typ !== typ || typeof payload.sub !== "string" || typeof payload.sid !== "string") throw unauth();
    return payload as typeof payload & { sub: string; sid: string };
  }

  signAccess(u: SessionUser, ttl = ACCESS_TTL_S) {
    return this.sign({ typ: "access", roles: u.roles, scopes: u.scopes, sid: u.sid, stepUpAt: u.stepUpAt, act: u.act }, u.id, ttl);
  }

  // shortcut: access tokens are stateless, so a revoked session keeps access ≤ 10 min; add a Redis sid denylist if that window matters.
  async verifyAccess(token: string): Promise<SessionUser> {
    const p = await this.verify(token, "access");
    const scopes = (p.scopes ?? {}) as SessionUser["scopes"];
    return { id: p.sub, sid: p.sid, roles: normalizeRoles({ roles: p.roles }), scopes, stepUpAt: typeof p.stepUpAt === "number" ? p.stepUpAt : undefined, act: typeof p.act === "string" ? p.act : undefined };
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
    const next = await this.insertRefresh(tx, row.userId, row.familyId);
    const now = new Date().toISOString();
    await tx.update(refreshTokens).set({ revokedAt: now, lastUsedAt: now, replacedByTokenId: next.id }).where(eq(refreshTokens.id, row.id));
    await tx.update(authSessions).set({ lastSeenAt: now }).where(eq(authSessions.id, row.familyId));
    return { refresh: next.raw, userId: row.userId, sid: row.familyId };
  }

  async revokeSession(tx: Tx, sid: string) {
    const now = new Date().toISOString();
    await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.familyId, sid), isNull(refreshTokens.revokedAt)));
    await tx.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.id, sid), isNull(authSessions.revokedAt)));
  }
}
