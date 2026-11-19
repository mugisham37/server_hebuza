// Port of .ref auth.service.ts onto the Nest core: argon2 (PasswordService), sessions = auth_sessions row + refresh
// family (TokenService), cookies (CookieService), mail/SMS through the outbox (auth.jobs.ts sends them).
// Error types follow the MSW contract: unauthorized, locked(423), suspended(403), conflict, invalid_code(400),
// expired(410), invalid_token(400).
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ClsService } from "nestjs-cls";
import type { FastifyReply, FastifyRequest } from "fastify";
import type IORedis from "ioredis";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  authImpersonations,
  authSessions,
  authTrustedDevices,
  loginAttempts,
  passwordResetTokens,
  refreshTokens,
  staffProfiles,
  teamAccessRequests,
  termsAcceptances,
  users,
} from "@/db/schema";
import { normalizeRoles } from "@/domain/auth/roles";
import type { Env } from "../../core/config/env";
import type { RequestStore, SessionUser } from "../../core/http/context";
import { AppError, notFound } from "../../core/http/errors";
import { DB, type Db, type Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { OutboxService } from "../../core/db/outbox";
import { AuditService } from "../../core/db/audit";
import { PasswordService } from "../../core/auth/password";
import { TokenService, ACCESS_TTL_S } from "../../core/auth/tokens";
import {
  CookieService,
  REFRESH_COOKIE,
} from "../../core/auth/cookies";
import { hashOtp, newOtp, OTP_TTL_MS } from "../../core/auth/otp";
import { REDIS } from "../../core/queue/queue.module";
import { CryptoService, safeEqual } from "../../core/crypto/crypto.service";
import {
  deviceLabel,
  genId,
  inferType,
  isStaffRole,
  maskEmail,
  maskIdentifier,
  normalizeIdentifier,
  normalizePhone,
  opaqueToken,
  sha256,
  staffPasswordError,
  type IdentifierType,
} from "./auth.rules";
import { iso } from "../../core/db/ids";
import { assignCustomerNo } from "../../core/db/customer-no";

export const CFG = {
  otpMaxAttempts: 3,
  otpResendCooldownS: 30,
  lockoutMax: 5,
  lockoutWindowS: 900,
  resetTtlS: 3600,
};
export const PRE2FA_COOKIE = "hebuza_pre2fa";
export const DEVICE_COOKIE = "hebuza_device";
const OPEN_ROLES = ["client", "partner"];
export type User = typeof users.$inferSelect;
export type Http = { req: FastifyRequest; reply: FastifyReply };

export const authErr = {
  creds: (left?: number) =>
    new AppError(
      401,
      "unauthorized",
      left != null && left > 0
        ? `Phone, email or password is incorrect. ${left} ${left === 1 ? "try" : "tries"} left.`
        : "Phone, email or password is incorrect.",
    ),
  locked: (until: string) =>
    new AppError(423, "locked", "Too many attempts. Try again in 15 minutes.", undefined, { lockoutUntil: until }),
  disabled: () =>
    new AppError(
      403,
      "suspended",
      "This account has been deactivated. Contact your administrator.",
    ),
  exists: (m = "An account already exists.") =>
    new AppError(409, "conflict", m),
  badCode: (left?: number) =>
    new AppError(
      400,
      "invalid_code",
      left
        ? `That code didn't match. ${left} ${left === 1 ? "try" : "tries"} left.`
        : "That code didn't match.",
    ),
  codeExpired: () =>
    new AppError(410, "expired", "That code has expired. Ask for a new one."),
  badReset: () =>
    new AppError(
      400,
      "invalid_token",
      "This reset link is invalid or has expired.",
    ),
  validation: (m: string) => new AppError(422, "validation", m),
  unauth: (m = "Not signed in.") => new AppError(401, "unauthenticated", m),
};

export function sessionModel(u: User, expiresAt: Date | null) {
  return {
    userId: u.userId,
    name: u.name,
    email: u.email ?? u.phoneE164 ?? "",
    phone: u.phoneE164,
    role: u.role,
    roles: normalizeRoles({ role: u.role }),
    isEmailVerified: u.isEmailVerified,
    language: u.language,
    customerNo: u.customerNo ?? null,
    createdAt: new Date(u.createdAt).toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}
const label = (role: string) =>
  role === "partner" ? "partner" : isStaffRole(role) ? "team" : "client";

@Injectable()
export class AuthService {
  private dummy?: Promise<string>;
  readonly secure: boolean;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: IORedis,
    readonly txs: TxService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    readonly pw: PasswordService,
    readonly tokens: TokenService,
    readonly cookies: CookieService,
    private readonly cls: ClsService<RequestStore>,
    private readonly config: ConfigService<Env, true>,
    private readonly crypto: CryptoService,
  ) {
    this.secure = config.get("NODE_ENV", { infer: true }) === "production";
  }

  private get ip() {
    return this.cls.get("ip") || "unknown";
  }

  // ── helpers shared with mfa/admin ──
  setCookie(
    reply: FastifyReply,
    name: string,
    value: string,
    maxAgeS: number,
    path = "/",
  ) {
    if (maxAgeS <= 0) reply.clearCookie(name, { path });
    else
      reply.setCookie(name, value, {
        httpOnly: true,
        secure: this.secure,
        sameSite: "lax",
        path,
        maxAge: maxAgeS,
      });
  }
  getUser = (tx: Tx | Db, id: string) =>
    tx
      .select()
      .from(users)
      .where(eq(users.userId, id))
      .then((r) => r[0]);
  private usersBy = (tx: Tx, type: IdentifierType, v: string) =>
    tx
      .select()
      .from(users)
      .where(type === "email" ? eq(users.email, v) : eq(users.phoneE164, v));
  // Equal time when the account doesn't exist so timing doesn't reveal it.
  private burn = async (p: string) =>
    this.pw.verify(await (this.dummy ??= this.pw.hash("timing-equaliser")), p);

  async mfaEnrolled(tx: Tx, userId: string) {
    const [p] = await tx
      .select({ on: staffProfiles.twofaEnabled })
      .from(staffProfiles)
      .where(eq(staffProfiles.userId, userId));
    return !!p?.on;
  }

  /**
   * The one place a token principal is built (sign-in, refresh, view-as): roles = users.role ∪ unexpired system grants
   * (system_records userMeta.extraRoles), scopes from partner/agent profiles + the active organisation.
   * `view` = { act, until } for a view-as token: carries the actor id and expires with the impersonation window.
   */
  async access(tx: Tx, u: User, sid: string, view?: { act: string; until: Date }) {
    const id = u.userId;
    const [r] = (await tx.execute(sql`select
      (select data->'extraRoles' from system_records where kind = 'userMeta' and id = ${id}) as grants,
      (select data->>'activeOrgId' from system_records where kind = 'acct' and id = ${id + ":orgs"}) as org,
      exists (select 1 from partner_profiles where user_id = ${id}) as partner,
      coalesce((select twofa_enabled from staff_profiles where user_id = ${id}), false) as mfa,
      exists (select 1 from agent_profiles where user_id = ${id}) or exists (select 1 from field_agents where user_id = ${id} and revoked_at is null) as agent`)) as unknown as {
      grants: { role: string; expiresAt: string | null }[] | null; org: string | null; partner: boolean; agent: boolean; mfa: boolean;
    }[]; // cast: execute() rows are untyped
    const grants = (r?.grants ?? []).filter((g) => !g.expiresAt || Date.parse(g.expiresAt) > Date.now()).map((g) => g.role);
    const su: SessionUser = {
      id, sid, act: view?.act,
      roles: normalizeRoles({ roles: [u.role, ...grants] }),
      scopes: { ...(r?.org && { orgId: r.org }), ...(r?.partner && { partnerId: id }), ...(r?.agent && { agentId: id }) },
      mfa: !!r?.mfa, // the web proxy sends un-enrolled staff to 2FA setup (fails closed in production without this claim)
    };
    const ttl = view ? Math.max(1, Math.min(ACCESS_TTL_S, Math.floor((view.until.getTime() - Date.now()) / 1000))) : ACCESS_TTL_S;
    return { su, ttl, token: this.tokens.signAccess(su, ttl), expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  /** New sign-in: auth_sessions row (= refresh family) first, then refresh + access cookies. */
  async startSession(tx: Tx, h: Http, u: User) {
    const sid = genId("rtf");
    await tx.insert(authSessions).values({
      id: sid,
      userId: u.userId,
      device: deviceLabel(h.req.headers["user-agent"] ?? null),
      ip: this.ip === "unknown" ? null : this.ip,
      createdAt: iso(),
      lastSeenAt: iso(),
    });
    const refresh = await this.tokens.issueRefresh(tx, u.userId, sid);
    const a = await this.access(tx, u, sid);
    this.cookies.set(h.reply, await a.token, refresh);
    this.setCookie(h.reply, PRE2FA_COOKIE, "", 0);
    return { sid, accessExpiresAt: a.expiresAt };
  }

  async revokeAllSessions(tx: Tx, userId: string, keep?: string) {
    const live = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          keep ? ne(authSessions.id, keep) : undefined,
        ),
      );
    await tx
      .update(refreshTokens)
      .set({ revokedAt: iso() })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
          keep ? ne(refreshTokens.familyId, keep) : undefined,
        ),
      );
    if (live.length)
      await tx
        .update(authSessions)
        .set({ revokedAt: iso() })
        .where(
          inArray(
            authSessions.id,
            live.map((s) => s.id),
          ),
        );
    return live.length;
  }

  liveSessions(tx: Tx, userId: string) {
    return tx
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          sql`exists (select 1 from refresh_tokens r where r.family_id = ${authSessions.id} and r.revoked_at is null and r.expires_at > now())`,
        ),
      )
      .orderBy(sql`${authSessions.lastSeenAt} desc`);
  }

  /** Mail when the account has an email, else SMS. Sent by auth.jobs.ts after commit. */
  async notify(
    tx: Tx,
    u: Pick<User, "email" | "phoneE164">,
    subject: string,
    text: string,
  ) {
    if (u.email)
      await this.outbox.add(tx, {
        type: "auth.mail",
        queue: "critical",
        payload: this.crypto.seal({ to: u.email, subject, text }, ["text"]), // text carries the OTP code / reset link
      });
    else if (u.phoneE164)
      await this.outbox.add(tx, {
        type: "auth.sms",
        queue: "critical",
        payload: this.crypto.seal({ to: u.phoneE164, text }, ["text"]),
      });
  }

  /** Reset link, or with `purpose: "invite"` the first set-password link of a new account (invite wording). */
  async issueResetToken(tx: Tx, u: User, ttlS = CFG.resetTtlS, purpose: "reset" | "invite" = "reset") {
    const token = opaqueToken("rst");
    await tx.insert(passwordResetTokens).values({
      id: genId("prt"),
      userId: u.userId,
      tokenHash: sha256(token),
      purpose,
      expiresAt: iso(new Date(Date.now() + ttlS * 1000)),
      createdAt: iso(),
    });
    const base = this.config
      .get("WEB_ORIGIN", { infer: true })
      .split(",")[0]
      .trim()
      .replace(/\/$/, "");
    const link = isStaffRole(u.role)
      ? `${base}/team/set-password/${token}`
      : `${base}/reset?token=${token}&audience=${label(u.role)}`;
    const ttl = ttlS >= 86400 ? `${Math.round(ttlS / 86400)} day(s)` : `${Math.round(ttlS / 3600)} hour(s)`;
    if (purpose === "invite")
      await this.notify(
        tx,
        u,
        `You're invited to Hebuza`,
        `An account has been created for you on Hebuza (${label(u.role)}).\nSet your password to get started:\n${link}\nThis invitation expires in ${ttl} and can only be used once. If you weren't expecting it, ignore this email.`,
      );
    else
      await this.notify(
        tx,
        u,
        `Reset your Hebuza ${label(u.role)} password`,
        `Use this link to choose a new password for your Hebuza ${label(u.role)} account only:\n${link}\nIt expires in ${ttl} and can only be used once.`,
      );
    return token;
  }

  // ── client OTP (Redis, hashed; attempts counted atomically with INCR) ──
  // shortcut: Redis rather than core checkOtp (no user-OTP table); add an auth_otps table if OTPs must survive a Redis flush.
  private otpKey = (uid: string) => `auth:otp:${uid}`;
  private async sendOtp(tx: Tx, u: User) {
    const o = newOtp();
    const ttl = Math.round(OTP_TTL_MS / 1000);
    await this.redis
      .multi()
      .set(this.otpKey(u.userId), o.hash, "EX", ttl)
      .del(`${this.otpKey(u.userId)}:n`)
      .exec();
    await this.notify(
      tx,
      u,
      `Your Hebuza ${label(u.role)} verification code`,
      `Your verification code is ${o.code}.\nThis code is for your Hebuza ${label(u.role)} account only. It expires in ${ttl / 60} minutes. Do not share it with anyone.`,
    );
  }
  private async checkClientOtp(uid: string, code: string) {
    const k = this.otpKey(uid);
    const stored = await this.redis.get(k);
    if (!stored) throw authErr.codeExpired();
    const n = await this.redis.incr(`${k}:n`);
    if (n === 1)
      await this.redis.expire(`${k}:n`, Math.round(OTP_TTL_MS / 1000));
    if (n > CFG.otpMaxAttempts) throw authErr.codeExpired();
    if (!safeEqual(hashOtp(code), stored)) {
      if (n >= CFG.otpMaxAttempts) await this.redis.del(k);
      throw authErr.badCode(CFG.otpMaxAttempts - n);
    }
    await this.redis.del(k, `${k}:n`);
  }

  // ── lockout ──
  private lockKeys(door: string) {
    const k = `${sha256(door)}:${sha256(this.ip)}`;
    return {
      attempts: `auth:lockout:attempts:${k}`,
      until: `auth:lockout:until:${k}`,
    };
  }
  private async assertNotLocked(door: string) {
    const until = await this.redis.get(this.lockKeys(door).until);
    if (until) throw authErr.locked(until);
  }
  /** Records the failure in its own tx (survives the throw) and returns the error to throw. */
  private async loginFailure(door: string, identifier: string) {
    await this.txs.run((tx) =>
      tx.insert(loginAttempts).values({
        id: genId("lat"),
        identifier,
        ipAddress: this.ip,
        success: false,
        attemptedAt: iso(),
      }),
    );
    const k = this.lockKeys(door);
    const n = await this.redis.incr(k.attempts);
    if (n === 1) await this.redis.expire(k.attempts, CFG.lockoutWindowS);
    if (n >= CFG.lockoutMax) {
      const until = iso(new Date(Date.now() + CFG.lockoutWindowS * 1000));
      await this.redis.setex(k.until, CFG.lockoutWindowS, until);
      return authErr.locked(until);
    }
    return authErr.creds(CFG.lockoutMax - n);
  }

  /** IAM-16: refuse passwords seen in public breaches (HIBP, fail-open), then hash. */
  private async newHash(pw: string) {
    if (await this.pw.isBreached(pw))
      throw authErr.validation("This password appears in a known data breach. Choose another one.");
    return this.pw.hash(pw);
  }

  // ── flows ──
  async signup(
    h: Http,
    b: {
      name: string;
      identifier: string;
      identifierType?: IdentifierType;
      password: string;
      language: "en" | "rw" | "fr";
      audience?: "client" | "partner";
    },
  ) {
    const type = b.identifierType ?? inferType(b.identifier);
    const id = normalizeIdentifier(type, b.identifier);
    if (!id)
      throw authErr.validation(
        type === "email"
          ? "Enter a valid email address."
          : "Enter a valid Rwanda phone number.",
      );
    const role = b.audience === "partner" ? "partner" : "client";
    // shortcut: partner organisation profile ships with the partner module.
    if (role === "partner")
      throw authErr.validation(
        "Partner sign-up opens with the partner programme.",
      );
    const passwordHash = await this.newHash(b.password);
    return this.txs.run(async (tx) => {
      if ((await this.usersBy(tx, type, id)).some((u) => u.role === role))
        throw authErr.exists(
          `A ${role} account with this ${type === "email" ? "email" : "phone number"} already exists.`,
        );
      const t = iso();
      const [u] = await tx
        .insert(users)
        .values({
          userId: genId("usr"),
          name: b.name.trim(),
          email: type === "email" ? id : null,
          phoneE164: type === "phone" ? id : null,
          passwordHash,
          role,
          isActive: true,
          isEmailVerified: false,
          language: b.language,
          createdAt: t,
          updatedAt: t,
        })
        .returning();
      await assignCustomerNo(tx, u.userId);
      await tx.insert(termsAcceptances).values({
        id: genId("terms"),
        userId: u.userId,
        policyVersion: "2026-05-auth-bootstrap",
        acceptedAt: t,
      });
      // Subscriptions module starts the client trial from this event (was startTrialForClient in-process).
      await this.outbox.add(tx, {
        type: "auth.user.signed_up",
        payload: { userId: u.userId, role },
      });
      await tx.insert(loginAttempts).values({
        id: genId("lat"),
        identifier: id,
        ipAddress: this.ip,
        success: true,
        attemptedAt: t,
      });
      const s = await this.startSession(tx, h, u);
      await this.sendOtp(tx, u);
      return {
        session: sessionModel(u, s.accessExpiresAt),
        maskedEmail: maskIdentifier(u.email, u.phoneE164),
      };
    });
  }

  /** One door for clients, partners and staff. */
  async login(
    h: Http,
    b: {
      identifier: string;
      identifierType?: IdentifierType;
      password: string;
      rememberMe?: boolean;
      audience?: "client" | "partner";
    },
  ) {
    const type = b.identifierType ?? inferType(b.identifier);
    const id = normalizeIdentifier(type, b.identifier);
    const door = id
      ? b.audience
        ? `${b.audience}:${id}`
        : id
      : b.identifier.trim().toLowerCase();
    await this.assertNotLocked(door);
    if (!id) {
      await this.burn(b.password);
      throw await this.loginFailure(door, b.identifier.slice(0, 255));
    }
    const matches = await this.txs.run((tx) => this.usersBy(tx, type, id));
    let candidates = matches.filter(
      (u) =>
        OPEN_ROLES.includes(u.role) && (!b.audience || u.role === b.audience),
    );
    if (!candidates.length && !b.audience)
      candidates = matches.filter((u) => isStaffRole(u.role));
    if (candidates.length > 1)
      throw authErr.validation(
        "This email is used for more than one account. Sign in from the client or partner page.",
      );
    const u = candidates[0];
    if (
      !u
        ? (await this.burn(b.password), true)
        : !(await this.pw.verify(u.passwordHash, b.password))
    )
      throw await this.loginFailure(door, id);
    if (!u.isActive) throw authErr.disabled();
    const k = this.lockKeys(door);
    await this.redis.del(k.attempts, k.until);
    return this.txs.run(async (tx) => {
      await tx.insert(loginAttempts).values({
        id: genId("lat"),
        identifier: id,
        ipAddress: this.ip,
        success: true,
        attemptedAt: iso(),
      });
      if (
        isStaffRole(u.role) &&
        (await this.mfaEnrolled(tx, u.userId)) &&
        !(await this.trustedDeviceFor(tx, h, u.userId))
      ) {
        // Password ok, second factor pending: a 5-min pre_2fa handle only; POST /api/auth/mfa/verify finishes.
        const t = opaqueToken("p2f");
        await this.redis.setex(`auth:pre2fa:${sha256(t)}`, 300, u.userId);
        this.setCookie(h.reply, PRE2FA_COOKIE, t, 300);
        return {
          session: sessionModel(u, null),
          maskedEmail: maskIdentifier(u.email, u.phoneE164),
          mfaRequired: true,
        };
      }
      const s = await this.startSession(tx, h, u);
      if (!u.isEmailVerified && !isStaffRole(u.role)) await this.sendOtp(tx, u);
      return {
        session: sessionModel(u, s.accessExpiresAt),
        maskedEmail: maskIdentifier(u.email, u.phoneE164),
      };
    });
  }

  async staffLogin(h: Http, b: { email: string; password: string }) {
    const r = await this.login(h, {
      identifier: b.email,
      identifierType: "email",
      password: b.password,
    });
    if (!isStaffRole(r.session.role)) {
      this.cookies.clear(h.reply);
      throw authErr.creds();
    }
    return r;
  }

  async readPre2fa(req: FastifyRequest) {
    const t = req.cookies?.[PRE2FA_COOKIE];
    return t
      ? ((await this.redis.getdel(`auth:pre2fa:${sha256(t)}`)) ?? null)
      : null;
  }

  async trustedDeviceFor(tx: Tx, h: Pick<Http, "req">, userId: string) {
    const t = h.req.cookies?.[DEVICE_COOKIE];
    if (!t) return null;
    const [d] = await tx
      .select()
      .from(authTrustedDevices)
      .where(
        and(
          eq(authTrustedDevices.tokenHash, sha256(t)),
          eq(authTrustedDevices.userId, userId),
          gt(authTrustedDevices.trustedUntil, iso()),
        ),
      );
    if (d)
      await tx
        .update(authTrustedDevices)
        .set({ lastUsedAt: iso() })
        .where(eq(authTrustedDevices.id, d.id));
    return d ?? null;
  }

  async verifyClientOtp(me: SessionUser, code: string) {
    await this.checkClientOtp(me.id, code);
    const [u] = await this.txs.run((tx) =>
      tx
        .update(users)
        .set({ isEmailVerified: true, updatedAt: iso() })
        .where(eq(users.userId, me.id))
        .returning(),
    );
    if (!u) throw authErr.unauth();
    return { verified: true };
  }

  async resendOtp(me: SessionUser) {
    if (
      !(await this.redis.set(
        `auth:otp:resend:${me.id}`,
        "1",
        "EX",
        CFG.otpResendCooldownS,
        "NX",
      ))
    )
      throw new AppError(
        429,
        "rate_limited",
        `Try again in ${CFG.otpResendCooldownS} seconds.`,
      );
    await this.txs.run(async (tx) => {
      const u = await this.getUser(tx, me.id);
      if (!u) throw authErr.unauth();
      await this.sendOtp(tx, u);
    });
    return { verified: false };
  }

  forgotPassword(b: {
    identifier: string;
    identifierType?: IdentifierType;
    audience?: "client" | "partner";
  }) {
    const type = b.identifierType ?? inferType(b.identifier);
    const id = normalizeIdentifier(type, b.identifier);
    const masked = (v: string) =>
      type === "email" ? maskEmail(v) : maskIdentifier(null, v);
    if (!id) return { maskedEmail: masked(b.identifier.trim()) };
    // Staff never self-serve a reset; an ambiguous door sends nothing. The response is identical either way.
    return this.txs.run(async (tx) => {
      const open = (await this.usersBy(tx, type, id)).filter(
        (u) =>
          OPEN_ROLES.includes(u.role) && (!b.audience || u.role === b.audience),
      );
      if (open.length === 1 && open[0].isActive)
        await this.issueResetToken(tx, open[0]);
      return { maskedEmail: masked(id) };
    });
  }

  private async resetRow(tx: Tx, token: string, lock = false) {
    const q = tx
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, sha256(token)));
    const [r] = await (lock ? q.for("update") : q);
    if (!r || r.usedAt || !["invite", "reset"].includes(r.purpose))
      return { bad: "missing" as const };
    if (Date.parse(r.expiresAt) <= Date.now())
      return { bad: "expired" as const };
    return { r };
  }

  async resetPassword(b: {
    token: string;
    password: string;
    confirmPassword?: string;
  }) {
    if (b.confirmPassword != null && b.confirmPassword !== b.password)
      throw authErr.validation("Passwords do not match.");
    const hash = await this.newHash(b.password);
    return this.txs.run(async (tx) => {
      const x = await this.resetRow(tx, b.token, true);
      if (!x.r) throw authErr.badReset();
      const u = await this.getUser(tx, x.r.userId);
      if (!u) throw authErr.badReset();
      if (!u.isActive) throw authErr.disabled();
      if (isStaffRole(u.role)) {
        const e = staffPasswordError(b.password);
        if (e) throw authErr.validation(e);
      }
      await tx
        .update(users)
        .set({ passwordHash: hash, updatedAt: iso() })
        .where(eq(users.userId, u.userId));
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: iso() })
        .where(eq(passwordResetTokens.id, x.r.id));
      await this.revokeAllSessions(tx, u.userId);
      await this.audit.record(tx, {
        action: "auth.password.reset",
        entity: "user",
        entityId: u.userId,
      });
      return { verified: true };
    });
  }

  setPasswordPreview(token: string) {
    return this.txs.run(async (tx) => {
      const x = await this.resetRow(tx, token);
      if (x.bad === "expired")
        throw new AppError(410, "expired", "This invitation expired.");
      const u = x.r && (await this.getUser(tx, x.r.userId));
      if (!x.r || !u || !isStaffRole(u.role)) throw notFound("This link");
      if (!u.isActive) throw authErr.disabled();
      return {
        name: u.name,
        email: u.email ?? "",
        role:
          u.role === "staff:admin" || u.role === "staff:sysadmin"
            ? ("admin" as const)
            : ("agent" as const),
        issuedBy: "Your admin", // shortcut: password_reset_tokens has no issued_by column.
        issuedAt: new Date(x.r.createdAt).toISOString(),
        expiresAt: new Date(x.r.expiresAt).toISOString(),
      };
    });
  }

  async setPassword(
    token: string,
    b: { name?: string; phone?: string; password: string },
  ) {
    const e = staffPasswordError(b.password);
    const hash = e ? "" : await this.newHash(b.password);
    return this.txs.run(async (tx) => {
      const x = await this.resetRow(tx, token, true);
      if (x.bad === "expired")
        throw new AppError(410, "expired", "This invitation expired.");
      const u = x.r && (await this.getUser(tx, x.r.userId));
      if (!x.r || !u || !isStaffRole(u.role)) throw notFound("This link");
      if (!u.isActive) throw authErr.disabled();
      if (e) throw authErr.validation(e);
      const phone = b.phone?.trim() ? normalizePhone(b.phone) : u.phoneE164;
      if (b.phone?.trim() && !phone)
        throw authErr.validation("Enter a valid Rwanda phone number.");
      if (phone && phone !== u.phoneE164) {
        const [taken] = await tx
          .select({ id: users.userId })
          .from(users)
          .where(
            and(
              eq(users.phoneE164, phone),
              eq(users.role, u.role),
              ne(users.userId, u.userId),
            ),
          );
        if (taken)
          throw authErr.validation(
            `${phone} is already on another account. Use a different number.`,
          );
      }
      await tx
        .update(users)
        .set({
          name: b.name?.trim() || u.name,
          phoneE164: phone,
          passwordHash: hash,
          updatedAt: iso(),
        })
        .where(eq(users.userId, u.userId));
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: iso() })
        .where(eq(passwordResetTokens.id, x.r.id));
      await this.revokeAllSessions(tx, u.userId);
      await this.audit.record(tx, {
        action: "auth.password.set",
        entity: "user",
        entityId: u.userId,
      });
      return { ok: true };
    });
  }

  async createTeamAccessRequest(
    h: Http,
    b: {
      email: string;
      kind: "password" | "unlock" | "two_factor" | "other";
      note?: string | null;
    },
  ) {
    const email = b.email.trim().toLowerCase();
    // 4-digit references collide; the unique index is the real guard, so retry.
    for (let i = 0; i < 5; i++) {
      const reference = `REQ-${1000 + Math.floor(Math.random() * 9000)}`;
      const r = await this.txs.run((tx) =>
        tx
          .insert(teamAccessRequests)
          .values({
            id: genId("tar"),
            reference,
            email,
            kind: b.kind,
            note: b.note ?? null,
            status: "open",
            userAgent: h.req.headers["user-agent"]?.slice(0, 512) ?? null,
            createdAt: iso(),
          })
          .onConflictDoNothing()
          .returning({ id: teamAccessRequests.id }),
      );
      if (r.length) return { reference, maskedEmail: maskEmail(email) };
    }
    throw new AppError(500, "internal", "Internal server error");
  }

  /** GET /api/auth/session: valid access → session; otherwise rotate the refresh cookie. */
  async currentSession(h: Http, me: SessionUser | null) {
    if (me) {
      const u = await this.txs.run((tx) => this.getUser(tx, me.id));
      if (!u || !u.isActive) throw authErr.unauth();
      return { session: sessionModel(u, null) };
    }
    const raw = h.req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw authErr.unauth();
    try {
      return await this.txs.run(async (tx) => {
        const r = await this.tokens.rotateRefresh(tx, raw);
        const actor = await this.getUser(tx, r.userId);
        if (!actor || !actor.isActive) throw authErr.unauth();
        // A live view-as window survives refresh: the access token stays the target's, read-only, until `until`.
        const [imp] = await tx.select().from(authImpersonations)
          .where(and(eq(authImpersonations.actorId, actor.userId), isNull(authImpersonations.endedAt), gt(authImpersonations.until, iso())));
        const target = imp && (await this.getUser(tx, imp.targetId));
        const u = target && target.isActive ? target : actor;
        const a = await this.access(tx, u, r.sid, u === actor ? undefined : { act: actor.userId, until: new Date(imp!.until) });
        this.cookies.set(h.reply, await a.token, r.refresh);
        return { session: sessionModel(u, a.expiresAt) };
      });
    } catch (e) {
      this.cookies.clear(h.reply);
      throw e;
    }
  }

  async signOut(h: Http, me: SessionUser | null) {
    const raw = h.req.cookies?.[REFRESH_COOKIE];
    await this.txs.run(async (tx) => {
      const [row] = raw
        ? await tx
            .select({ familyId: refreshTokens.familyId })
            .from(refreshTokens)
            .where(eq(refreshTokens.tokenHash, sha256(raw)))
        : [];
      const sid = row?.familyId ?? me?.sid;
      if (sid) await this.tokens.revokeSession(tx, sid);
    });
    this.cookies.clear(h.reply);
    this.setCookie(h.reply, PRE2FA_COOKIE, "", 0);
    return { signedOut: true };
  }

  private async activeUser(tx: Tx, me: SessionUser) {
    const u = await this.getUser(tx, me.id);
    if (!u || !u.isActive) throw authErr.unauth();
    return u;
  }

  async changePassword(
    me: SessionUser,
    b: {
      currentPassword: string;
      newPassword: string;
      confirmPassword?: string;
    },
  ) {
    if (b.confirmPassword != null && b.confirmPassword !== b.newPassword)
      throw authErr.validation("Passwords do not match.");
    if (b.currentPassword === b.newPassword)
      throw authErr.validation(
        "New password must differ from the current password.",
      );
    if (b.newPassword.length < 10)
      throw authErr.validation("Password must be at least 10 characters.");
    const hash = await this.newHash(b.newPassword);
    return this.txs.run(async (tx) => {
      const u = await this.activeUser(tx, me);
      if (!(await this.pw.verify(u.passwordHash, b.currentPassword)))
        throw new AppError(
          400,
          "invalid_password",
          "Current password is incorrect.",
        );
      if (isStaffRole(u.role)) {
        const e = staffPasswordError(b.newPassword);
        if (e) throw authErr.validation(e);
      }
      await tx
        .update(users)
        .set({ passwordHash: hash, updatedAt: iso() })
        .where(eq(users.userId, u.userId));
      await this.revokeAllSessions(tx, u.userId, me.sid); // keep this device signed in
      await this.audit.record(tx, {
        action: "auth.password.changed",
        entity: "user",
        entityId: u.userId,
      });
      return { changed: true };
    });
  }

  updateProfile(
    me: SessionUser,
    b: { name?: string | null; phone?: string | null },
  ) {
    return this.txs.run(async (tx) => {
      const u = await this.activeUser(tx, me);
      const set: Partial<User> = {};
      if (b.name != null) {
        if (!b.name.trim()) throw authErr.validation("Name cannot be empty.");
        set.name = b.name.trim();
      }
      if (b.phone != null) {
        const phone = b.phone.trim() ? normalizePhone(b.phone) : null;
        if (b.phone.trim() && !phone)
          throw authErr.validation("Enter a valid Rwanda phone number.");
        if (phone) {
          const [taken] = await tx
            .select({ id: users.userId })
            .from(users)
            .where(
              and(
                eq(users.phoneE164, phone),
                eq(users.role, u.role),
                ne(users.userId, u.userId),
              ),
            );
          if (taken)
            throw authErr.exists("That phone number is already in use.");
        }
        set.phoneE164 = phone;
      }
      if (!Object.keys(set).length)
        throw authErr.validation("No changes requested.");
      const [n] = await tx
        .update(users)
        .set({ ...set, updatedAt: iso() })
        .where(eq(users.userId, u.userId))
        .returning();
      await this.audit.record(tx, {
        action: "auth.profile_update",
        entity: "user",
        entityId: u.userId,
        after: set,
      });
      return { session: sessionModel(n, null) };
    });
  }

  /** Soft delete: deactivate and scrub PII; work history stays. `openCases` = AccountService.openCaseRefs. */
  async deleteAccount(
    h: Http,
    me: SessionUser,
    b: { password: string },
    openCases: (tx: Tx, uid: string) => Promise<string[]>,
  ) {
    const r = await this.txs.run(async (tx) => {
      const u = await this.activeUser(tx, me);
      if (!(await this.pw.verify(u.passwordHash, b.password)))
        throw authErr.creds();
      if ((await openCases(tx, u.userId)).length)
        throw new AppError(
          409,
          "deletion_blocked",
          "Active requests block deletion.",
        );
      await tx
        .update(users)
        .set({
          name: "Deleted user",
          email: u.email ? `deleted+${u.userId}@invalid.local` : null,
          phoneE164: null,
          isEmailVerified: false,
          isActive: false,
          updatedAt: iso(),
        })
        .where(eq(users.userId, u.userId));
      await this.revokeAllSessions(tx, u.userId);
      await this.audit.record(tx, {
        action: "auth.account.deleted",
        entity: "user",
        entityId: u.userId,
      });
      return { deleted: true };
    });
    this.cookies.clear(h.reply);
    return r;
  }

  mySessions(me: SessionUser) {
    return this.txs.run(async (tx) => ({
      sessions: (await this.liveSessions(tx, me.id)).map((r) => ({
        id: r.id,
        device: r.device,
        place: r.city ?? "Unknown location", // shortcut: no geo-IP lookup
        lastActive: new Date(r.lastSeenAt).toISOString(),
        current: r.id === me.sid,
      })),
    }));
  }

  /** "others" ends every session but this one; the current one is never ended here. */
  revokeMySession(me: SessionUser, id: string) {
    return this.txs.run(async (tx) => {
      if (id === "others") await this.revokeAllSessions(tx, me.id, me.sid);
      else if (id !== me.sid) {
        const [row] = await tx
          .select({ id: authSessions.id })
          .from(authSessions)
          .where(and(eq(authSessions.id, id), eq(authSessions.userId, me.id)));
        if (row) {
          await this.tokens.revokeSession(tx, row.id);
          await this.audit.record(tx, {
            action: "auth.session.revoked",
            entity: "session",
            entityId: row.id,
          });
        }
      }
      return { revoked: true };
    });
  }
}
