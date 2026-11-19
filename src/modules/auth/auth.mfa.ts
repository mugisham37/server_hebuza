// Staff MFA: TOTP enrolment with backup codes, the /login/2fa challenge (pre_2fa cookie → session), trusted devices
// and step-up. Secret: staff_profiles.totp_secret_encrypted (CryptoService). Backup codes: backup_codes (Argon2id).
import { PasswordService } from "../../core/auth/password";
import { NO_TRUST_ROLES } from "./auth.service";
import { Inject, Injectable } from "@nestjs/common";
import type IORedis from "ioredis";
import QRCode from "qrcode";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authTrustedDevices, backupCodes, staffProfiles } from "@/db/schema";
import type { SessionUser } from "../../core/http/context";
import { AppError, conflict } from "../../core/http/errors";
import type { Tx } from "../../core/db/db";
import { AuditService } from "../../core/db/audit";
import { CryptoService } from "../../core/crypto/crypto.service";
import { claimTotpStep, totp } from "../../core/auth/otp";
import { STEP_UP_TTL_S } from "../../core/auth/tokens";
import { REDIS } from "../../core/queue/queue.module";
import { authErr, AuthService, DEVICE_COOKIE, type Http } from "./auth.service";
import {
  backupCode,
  deviceLabel,
  genId,
  isStaffRole,
  normalizeBackup,
  opaqueToken,
  sha256,
} from "./auth.rules";
import { iso } from "../../core/db/ids";

export const MFA = {
  backupCount: 10,
  maxFailures: 5,
  failureWindowS: 900,
  trustDays: 30,
};

@Injectable()
export class MfaService {
  constructor(
    private readonly auth: AuthService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly passwords: PasswordService,
  ) {}

  private profile = (tx: Tx, uid: string) =>
    tx
      .select()
      .from(staffProfiles)
      .where(eq(staffProfiles.userId, uid))
      .then((r) => r[0]);

  private async failure(uid: string) {
    const k = `auth:mfa:fail:${uid}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, MFA.failureWindowS);
    return n >= MFA.maxFailures
      ? authErr.locked(iso(new Date(Date.now() + MFA.failureWindowS * 1000)))
      : authErr.badCode();
  }
  private async assertNotLocked(uid: string) {
    if (Number(await this.redis.get(`auth:mfa:fail:${uid}`)) >= MFA.maxFailures)
      throw authErr.locked(
        iso(new Date(Date.now() + MFA.failureWindowS * 1000)),
      );
  }

  /** TOTP (replay-guarded step) or a single-use backup code. A wrong code is counted in its own tx-free Redis counter. */
  async checkSecondFactor(tx: Tx, uid: string, code: string, backup: boolean) {
    await this.assertNotLocked(uid);
    const p = await this.profile(tx, uid);
    if (!p?.twofaEnabled || !p.totpSecretEncrypted)
      throw authErr.validation(
        "Two-factor sign-in isn't set up on this account.",
      );
    if (backup) {
      // F-IAM-07: Argon2id hashes (legacy sha256 rows still verify until the set is regenerated).
      const plain = normalizeBackup(code);
      const open = await tx.select({ id: backupCodes.id, h: backupCodes.codeHash }).from(backupCodes)
        .where(and(eq(backupCodes.userId, uid), isNull(backupCodes.usedAt)));
      let match: string | undefined;
      for (const c of open)
        if (c.h.startsWith("$argon2") ? await this.passwords.verify(c.h, plain) : c.h === sha256(plain)) { match = c.id; break; }
      const [hit] = match
        ? await tx.update(backupCodes).set({ usedAt: iso() })
            .where(and(eq(backupCodes.id, match), isNull(backupCodes.usedAt))).returning({ id: backupCodes.id })
        : [];
      if (!hit) throw await this.failure(uid);
    } else {
      const step = totp.verify(
        code.trim(),
        this.crypto.decrypt(p.totpSecretEncrypted),
      );
      if (step == null || !(await claimTotpStep(tx, uid, step)))
        throw await this.failure(uid);
    }
    await this.redis.del(`auth:mfa:fail:${uid}`);
  }

  private async issueBackupCodes(tx: Tx, uid: string) {
    const list = Array.from({ length: MFA.backupCount }, backupCode);
    await tx.delete(backupCodes).where(eq(backupCodes.userId, uid));
    const hashes = await Promise.all(list.map((c) => this.passwords.hash(normalizeBackup(c))));
    await tx
      .insert(backupCodes)
      .values(
        list.map((_c, i) => ({
          id: genId("bkc"),
          userId: uid,
          codeHash: hashes[i],
          createdAt: iso(),
        })),
      );
    return list;
  }

  status(h: Http, me: SessionUser) {
    return this.auth.txs.run(async (tx) => ({
      enrolled: !!(await this.profile(tx, me.id))?.twofaEnabled,
      trustedDevice: !!(await this.auth.trustedDeviceFor(tx, h, me.id)),
    }));
  }

  /** Starts (or restarts, while unconfirmed) enrolment: new secret stored encrypted, inactive until verified. */
  enrol(me: SessionUser) {
    return this.auth.txs.run(async (tx) => {
      const u = await this.auth.getUser(tx, me.id);
      if (!u || !isStaffRole(u.role))
        throw new AppError(
          403,
          "forbidden",
          "Two-factor sign-in is for team accounts.",
        );
      if ((await this.profile(tx, me.id))?.twofaEnabled)
        throw conflict(
          "Two-factor sign-in is already on. Ask an administrator to reset it.",
        );
      const secret = totp.secret();
      const enc = this.crypto.encrypt(secret);
      await tx
        .insert(staffProfiles)
        .values({
          userId: me.id,
          totpSecretEncrypted: enc,
          twofaEnabled: false,
          createdAt: iso(),
        })
        .onConflictDoUpdate({
          target: staffProfiles.userId,
          set: { totpSecretEncrypted: enc, totpLastStep: null },
        });
      const svg = await QRCode.toString(totp.uri(u.email ?? u.userId, secret), { type: "svg", margin: 1 });
      return {
        secret,
        qrSvg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, // <img src>
        periodS: 30,
      };
    });
  }

  async enrolVerify(me: SessionUser, code: string) {
    await this.assertNotLocked(me.id);
    const r = await this.auth.txs.run(async (tx) => {
      const p = await this.profile(tx, me.id);
      if (!p?.totpSecretEncrypted)
        throw authErr.validation("Start set-up first.");
      if (p.twofaEnabled) throw conflict("Two-factor sign-in is already on.");
      const step = totp.verify(
        code.trim(),
        this.crypto.decrypt(p.totpSecretEncrypted),
      );
      if (step == null || !(await claimTotpStep(tx, me.id, step))) return null;
      await tx
        .update(staffProfiles)
        .set({ twofaEnabled: true })
        .where(eq(staffProfiles.userId, me.id));
      const list = await this.issueBackupCodes(tx, me.id);
      await this.audit.record(tx, {
        action: "auth.mfa.enrolled",
        entity: "user",
        entityId: me.id,
      });
      return { backupCodes: list };
    });
    if (!r) throw await this.failure(me.id);
    return r;
  }

  /** /login/2fa: finishes a pre_2fa sign-in (or re-verifies a signed-in user). Optionally trusts this device. */
  async verify(
    h: Http,
    me: SessionUser | null,
    b: {
      code: string;
      backup?: boolean;
      trust?: boolean;
      trustDevice?: boolean;
    },
  ) {
    const pre = await this.auth.readPre2fa(h.req);
    const uid = pre ?? me?.id;
    if (!uid) throw authErr.unauth("Sign in again.");
    return this.auth.txs.run(async (tx) => {
      await this.checkSecondFactor(tx, uid, b.code, !!b.backup);
      const u = await this.auth.getUser(tx, uid);
      if (!u || !u.isActive) throw authErr.disabled();
      if (pre) await this.auth.startSession(tx, h, u);
      if (
        (b.trust ?? b.trustDevice) &&
        !NO_TRUST_ROLES.has(u.role) &&
        !(await this.auth.trustedDeviceFor(tx, h, uid))
      ) {
        const token = opaqueToken("dvc");
        await tx.insert(authTrustedDevices).values({
          id: genId("dev"),
          userId: uid,
          tokenHash: sha256(token),
          label: deviceLabel(h.req.headers["user-agent"] ?? null),
          place: null,
          trustedUntil: iso(new Date(Date.now() + MFA.trustDays * 86400_000)),
          createdAt: iso(),
          lastUsedAt: iso(),
        });
        this.auth.setCookie(
          h.reply,
          DEVICE_COOKIE,
          token,
          MFA.trustDays * 86400,
        );
      }
      return { verified: true as const };
    });
  }

  /** Fresh second factor → step-up JWT (UI sends it back as X-Step-Up-Token; AuthGuard verifies it). */
  stepUp(
    me: SessionUser,
    b: { code: string; backup?: boolean; action?: string },
  ) {
    return this.auth.txs.run(async (tx) => {
      await this.checkSecondFactor(tx, me.id, b.code, !!b.backup);
      await this.audit.record(tx, {
        action: "auth.step_up",
        entity: "user",
        entityId: me.id,
        reason: b.action,
      });
      return {
        token: await this.auth.tokens.signStepUp(me),
        expiresAt: iso(new Date(Date.now() + STEP_UP_TTL_S * 1000)),
      };
    });
  }

  regenerateBackupCodes(me: SessionUser) {
    return this.auth.txs.run(async (tx) => {
      if (!(await this.profile(tx, me.id))?.twofaEnabled)
        throw authErr.validation(
          "Two-factor sign-in isn't set up on this account.",
        );
      const list = await this.issueBackupCodes(tx, me.id);
      await this.audit.record(tx, {
        action: "auth.mfa.backup_codes_regenerated",
        entity: "user",
        entityId: me.id,
      });
      return { backupCodes: list };
    });
  }

  listDevices(h: Http, me: SessionUser) {
    const mine = h.req.cookies?.[DEVICE_COOKIE];
    const mh = mine ? sha256(mine) : null;
    return this.auth.txs.run(async (tx) => ({
      devices: (
        await tx
          .select()
          .from(authTrustedDevices)
          .where(
            and(
              eq(authTrustedDevices.userId, me.id),
              gt(authTrustedDevices.trustedUntil, iso()),
            ),
          )
      ).map((d) => ({
        id: d.id,
        label: d.label,
        place: d.place ?? "",
        lastSeen: new Date(d.lastUsedAt).toISOString(),
        current: d.tokenHash === mh,
      })),
    }));
  }

  /** Removing the device you're on is refused silently (sign out instead). */
  revokeDevice(h: Http, me: SessionUser, id: string) {
    const mine = h.req.cookies?.[DEVICE_COOKIE];
    return this.auth.txs.run(async (tx) => {
      const [d] = await tx
        .select()
        .from(authTrustedDevices)
        .where(
          and(
            eq(authTrustedDevices.id, id),
            eq(authTrustedDevices.userId, me.id),
          ),
        );
      if (d && d.tokenHash !== (mine ? sha256(mine) : null))
        await tx
          .delete(authTrustedDevices)
          .where(eq(authTrustedDevices.id, id));
      return { ok: true };
    });
  }

  /** Admin MFA reset (system users module): clears secret, codes and trusted devices. */
  async resetMfa(tx: Tx, uid: string) {
    await tx
      .update(staffProfiles)
      .set({
        twofaEnabled: false,
        totpSecretEncrypted: null,
        totpLastStep: null,
      })
      .where(eq(staffProfiles.userId, uid));
    await tx.delete(backupCodes).where(eq(backupCodes.userId, uid));
    await tx
      .delete(authTrustedDevices)
      .where(eq(authTrustedDevices.userId, uid));
  }
}
