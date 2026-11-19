// Sysadmin identity actions on another account: sessions, trusted devices, forced password reset, view-as.
import { OutboxService } from "../../core/db/outbox";
import { Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  authImpersonations,
  authSessions,
  authTrustedDevices,
} from "@/db/schema";
import { homeFor, normalizeRoles, type Role } from "@/domain/auth/roles";
import type { SessionUser } from "../../core/http/context";
import { AppError, notFound } from "../../core/http/errors";
import type { Tx } from "../../core/db/db";
import { AuditService } from "../../core/db/audit";
import { AuthService, type Http } from "./auth.service";
import { genId } from "./auth.rules";
import { ACCESS_COOKIE } from "../../core/auth/cookies";
import { iso } from "../../core/db/ids";

// Copied from web lib/system/governance.ts (keep in sync).
const IMPERSONATION_MINUTES = [15, 30] as const;
const PROTECTED_TARGETS: ReadonlySet<Role> = new Set<Role>([
  "staff:finance",
  "staff:executive",
  "staff:sysadmin",
]);
const stale = (m: string) => new AppError(409, "stale", m);

@Injectable()
export class AuthAdminService {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async target(tx: Tx, id: string) {
    const u = await this.auth.getUser(tx, id);
    if (!u) throw notFound("User");
    return u;
  }

  userSessions(me: SessionUser, userId: string) {
    return this.auth.txs.run(async (tx) => ({
      items: (await this.auth.liveSessions(tx, userId)).map((r) => ({
        id: r.id,
        userId: r.userId,
        device: r.device,
        ip: r.ip ?? "",
        city: r.city,
        createdAt: new Date(r.createdAt).toISOString(),
        lastSeenAt: new Date(r.lastSeenAt).toISOString(),
        current: r.id === me.sid,
      })),
    }));
  }

  /** All but the caller's own (step-up enforced by the route). */
  revokeAll(me: SessionUser, userId: string) {
    return this.auth.txs.run(async (tx) => ({
      revoked: await this.auth.revokeAllSessions(tx, userId, me.sid),
    }));
  }

  revokeOne(me: SessionUser, userId: string, sid: string) {
    return this.auth.txs.run(async (tx) => {
      if (!(await this.auth.liveSessions(tx, userId)).some((x) => x.id === sid))
        throw stale("Session already ended.");
      if (sid === me.sid)
        throw new AppError(422, "validation", "Sign out instead.");
      await this.auth.tokens.revokeSession(tx, sid);
      await this.audit.record(tx, {
        action: "auth.session.revoked",
        entity: "session",
        entityId: sid,
      });
      return { revoked: 1 };
    });
  }

  userDevices(userId: string) {
    return this.auth.txs.run(async (tx) => ({
      items: (
        await tx
          .select()
          .from(authTrustedDevices)
          .where(
            and(
              eq(authTrustedDevices.userId, userId),
              gt(authTrustedDevices.trustedUntil, iso()),
            ),
          )
      ).map((d) => ({
        id: d.id,
        userId: d.userId,
        label: d.label,
        addedAt: new Date(d.createdAt).toISOString(),
        lastUsedAt: new Date(d.lastUsedAt).toISOString(),
      })),
    }));
  }

  revokeDevice(userId: string, id: string) {
    return this.auth.txs.run(async (tx) => {
      const r = await tx
        .delete(authTrustedDevices)
        .where(
          and(
            eq(authTrustedDevices.id, id),
            eq(authTrustedDevices.userId, userId),
          ),
        )
        .returning({ id: authTrustedDevices.id });
      if (!r.length) throw stale("Already removed.");
      await this.audit.record(tx, {
        action: "auth.trusted_device.revoked",
        entity: "device",
        entityId: id,
      });
      return {};
    });
  }

  /** Forced reset: ends every session and sends a single-use set-password link (24 h). */
  forcePasswordReset(me: SessionUser, userId: string) {
    return this.auth.txs.run(async (tx) => {
      const u = await this.target(tx, userId);
      if (u.userId === me.id)
        throw new AppError(403, "self_grant", "Not on your own account.");
      await this.auth.revokeAllSessions(tx, u.userId);
      await this.auth.issueResetToken(tx, u, 24 * 3600);
      return {};
    });
  }

  private openFor = (tx: Tx, actorId: string) =>
    tx
      .select()
      .from(authImpersonations)
      .where(
        and(
          eq(authImpersonations.actorId, actorId),
          isNull(authImpersonations.endedAt),
          gt(authImpersonations.until, iso()),
        ),
      )
      .then((r) => r[0]);

  /**
   * View-as: the access cookie becomes a token for the target bound to the actor's sid, expiring at `until`.
   * The actor's refresh cookie is untouched, so refresh/DELETE restores them; the actor = owner of auth_sessions[sid].
   * The token carries `act` (actor id): AuthGuard makes it read-only, audit rows record the actor, refresh re-issues it until `until`.
   */
  startImpersonation(
    h: Http,
    me: SessionUser,
    b: { targetId?: string; reason?: string; minutes?: number },
  ) {
    return this.auth.txs.run(async (tx) => {
      if (await this.actorOf(tx, me)) throw stale("Already impersonating.");
      const u = await this.target(tx, b.targetId ?? "");
      const roles = normalizeRoles({ role: u.role });
      if (roles.some((r) => PROTECTED_TARGETS.has(r)))
        throw new AppError(403, "target_protected", "Protected account.");
      if (!u.isActive)
        throw new AppError(422, "validation", "Only active accounts.");
      const reason = (b.reason ?? "").trim();
      if (reason.length < 10)
        throw new AppError(422, "reason_required", "Reason needed.");
      const minutes = (IMPERSONATION_MINUTES as readonly number[]).includes(
        b.minutes ?? 0,
      )
        ? b.minutes!
        : IMPERSONATION_MINUTES[0];
      if (await this.openFor(tx, me.id)) throw stale("Already impersonating.");
      const until = new Date(Date.now() + minutes * 60_000);
      const id = genId("imp");
      await tx
        .insert(authImpersonations)
        .values({
          id,
          actorId: me.id,
          targetId: u.userId,
          reason,
          startedAt: iso(),
          until: iso(until),
        });
      const a = await this.auth.access(tx, u, me.sid, { act: me.id, until });
      this.auth.setCookie(h.reply, ACCESS_COOKIE, await a.token, a.ttl);
      await this.audit.record(tx, {
        action: "access.impersonation.started",
        entity: "user",
        entityId: u.userId,
        reason,
        after: { minutes, impersonationId: id },
      });
      return { until: iso(until), home: homeFor(roles) };
    });
  }

  /** Real actor behind a view-as token (the sid's owner), or null when `me` is not impersonating. */
  private async actorOf(tx: Tx, me: SessionUser) {
    if (me.act) return me.act;
    const [s] = await tx
      .select({ userId: authSessions.userId })
      .from(authSessions)
      .where(eq(authSessions.id, me.sid));
    return s && s.userId !== me.id ? s.userId : null;
  }

  endImpersonation(h: Http, me: SessionUser) {
    return this.auth.txs.run(async (tx) => {
      const act = await this.actorOf(tx, me);
      if (!act && !me.roles.includes("staff:sysadmin"))
        throw new AppError(
          403,
          "forbidden_role",
          "Not available to your role.",
        );
      const actorId = act ?? me.id;
      const open = await this.openFor(tx, actorId);
      const [row] = await tx
        .update(authImpersonations)
        .set({ endedAt: iso(), endedBy: "user" })
        .where(
          and(
            eq(authImpersonations.actorId, actorId),
            isNull(authImpersonations.endedAt),
          ),
        )
        .returning();
      if (act) {
        const actor = await this.auth.getUser(tx, act);
        if (actor?.isActive)
          this.auth.setCookie(
            h.reply,
            ACCESS_COOKIE,
            await (await this.auth.access(tx, actor, me.sid)).token,
            600,
          );
        else this.auth.setCookie(h.reply, ACCESS_COOKIE, "", 0);
      }
      const hit = open ?? row;
      if (!hit) return { ended: false };
      await this.audit.record(tx, {
        action: "access.impersonation.ended",
        entity: "user",
        entityId: hit.targetId,
      });
      // F-IAM-15: the user is told afterwards that support viewed their account, and why.
      await this.outbox.add(tx, {
        type: "notifications.deliver",
        payload: {
          userId: hit.targetId, kind: "security", channels: ["email"],
          title: "HEBUZA support viewed your account",
          body: `A support team member viewed your account as you on ${hit.startedAt.slice(0, 10)}. Reason: ${hit.reason}. Nothing was changed on your behalf without your request. Contact us if you did not ask for help.`,
          link: "/settings/security",
          data: { type: "security.impersonation_ended", vars: { date: hit.startedAt.slice(0, 10) } },
        },
      });
      return { ended: true, targetId: hit.targetId };
    });
  }
}
