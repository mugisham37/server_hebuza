// P10 users (U3/U4), offboarding, service accounts and identity checks (U10) — port of handlers-system-b.
// Identity is the real `users` row (+ staff_profiles MFA, auth_sessions activity); the system store keeps the IAM
// overlay (extra role grants, lifecycle status, invitation, version). Sessions, trusted devices, forced password reset
// and impersonation are P1 (auth.admin.ts) and stay there.
import type { Tx } from "../../core/db/db";
import { randomBytes } from "node:crypto";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import {
  applications,
  staffProfiles,
  teamAccessRequests,
  users,
} from "@/db/schema";
import { normalizeRoles, ROLES, type Role } from "@/domain/auth/roles";
import { needsApproval, PRIVILEGED_GRANT } from "@/domain/system/approvals";
import {
  INVITE_TTL_MS,
  isLastSysadmin,
  sodConflicts,
  USER_NEXT,
  type UserAction,
} from "@/domain/system/governance";
import { mask } from "@/domain/format";
import type {
  IdentityRequestVM,
  RoleGrant,
  ServiceAccountVM,
  SystemUserVM,
  UserKind,
} from "@/domain/system/types";
import {
  generateId,
  hashToken,
  resetMfa,
} from "./system.identity";
import {
  accepted,
  fail,
  guard,
  onApply,
  record,
  stale,
  stepUp,
  submitChange,
  write,
  read,
  type Caller,
  type Exec,
  type UserMeta,
  type World,
} from "./system.world";
import { iso } from "../../core/db/ids";

const D = 86_400_000;
const ASSIGNABLE: readonly string[] = ROLES.filter(
  (r) => r !== "visitor" && r !== "client",
);
const DONE_CASE = ["closed", "cancelled", "completed", "rejected", "withdrawn"];

// ---------------------------------------------------------------- people loader (users + overlay)
type Row = typeof users.$inferSelect & {
  mfaOn: boolean | null;
  lastSeen: string | null;
  codes: number;
};
async function rows(db: Exec, where?: ReturnType<typeof and>) {
  return (
    await db
      .select({
        u: users,
        mfaOn: staffProfiles.twofaEnabled,
        lastSeen: sql<
          string | null
        >`(select max(s.last_seen_at) from auth_sessions s where s.user_id = ${users.userId})`,
        codes: sql<number>`(select count(*)::int from backup_codes b where b.user_id = ${users.userId} and b.used_at is null)`,
      })
      .from(users)
      .leftJoin(staffProfiles, eq(staffProfiles.userId, users.userId))
      .where(where)
  ).map((r) => ({
    ...r.u,
    mfaOn: r.mfaOn,
    lastSeen: r.lastSeen,
    codes: Number(r.codes),
  })) as Row[];
}

const isoOrNull = (v: string | null) => (v ? new Date(v).toISOString() : null);
export function toVM(r: Row, m: UserMeta | undefined): SystemUserVM {
  const primary = normalizeRoles({ role: r.role });
  const grants: RoleGrant[] = [
    ...primary.map((role) => ({
      role,
      grantedBy: m?.grantedBy ?? m?.createdBy ?? "—",
      grantedAt: new Date(r.createdAt).toISOString(),
      expiresAt: null,
    })),
    ...(m?.extraRoles ?? []).filter((g) => !primary.includes(g.role as Role)),
  ];
  const kind: UserKind = m?.isBootstrap
    ? "service"
    : grants.every((g) => g.role === "client") && grants.length
      ? "client"
      : grants.length &&
          grants.every(
            (g) => g.role === "staff:agent" || g.role === "ext:agent",
          )
        ? "agent"
        : "staff";
  let status = m?.status ?? (r.isActive ? "active" : "deactivated");
  if (!r.isActive && (status === "active" || status === "locked"))
    status = "deactivated";
  return {
    id: r.userId,
    name: r.name,
    email: r.email ?? "",
    phone: r.phoneE164,
    kind,
    roles: grants,
    status,
    mfa: {
      state: r.mfaOn
        ? "enrolled"
        : m?.mfaState === "reset"
          ? "reset"
          : "pending",
      methods: r.mfaOn ? ["totp"] : [],
      backupCodesLeft: r.mfaOn ? r.codes : null,
    },
    lastActiveAt: isoOrNull(r.lastSeen),
    locale: (["rw", "en", "fr"].includes(r.language)
      ? r.language
      : "rw") as SystemUserVM["locale"],
    createdAt: new Date(r.createdAt).toISOString(),
    version: m?.version ?? 1,
    ...(m?.invitation ? { invitation: m.invitation } : {}),
    ...(m?.createdBy ? { createdBy: m.createdBy } : {}),
    ...(m?.managerName ? { managerName: m.managerName } : {}),
    ...(m?.isBootstrap ? { isBootstrap: true } : {}),
  };
}
const metaOf = (w: World, id: string) => w.userMeta.find((m) => m.id === id);
function metaFor(w: World, id: string): UserMeta {
  let m = metaOf(w, id);
  if (!m) {
    m = { id, version: 1 };
    w.userMeta.push(m);
  }
  return m;
}
const bump = (w: World, id: string) => {
  metaFor(w, id).version++;
};

/** Every non-client person (staff, agents, service). Clients are listed on demand (can be many). */
export async function people(w: World): Promise<SystemUserVM[]> {
  const r = await rows(w.db, ne(users.role, "client"));
  return r.map((x) => toVM(x, metaOf(w, x.userId)));
}
export async function userById(w: World, id: string) {
  const [r] = await rows(w.db, eq(users.userId, id));
  return r ? toVM(r, metaOf(w, id)) : undefined;
}
/** Phones masked everywhere for SYS (§10.2); list emails masked too. */
const view = (u: SystemUserVM, list = false): SystemUserVM => ({
  ...u,
  phone: u.phone ? mask(u.phone, 3) : null,
  email: list ? u.email.replace(/^(.{1,5}).*@/, "$1…@") : u.email,
});
async function openCases(db: Exec, id: string) {
  const [r] = await db
    .select({ n: count() })
    .from(applications)
    .where(
      and(
        eq(applications.assignedAgentId, id),
        sql`${applications.status} not in ${DONE_CASE}`,
      ),
    );
  return Number(r?.n ?? 0);
}
async function target(w: World, id: string) {
  const u = await userById(w, id);
  if (!u) throw fail(404, "not_found", "Not found.");
  return u;
}

/** Invite + impersonation expiry is swept by the system cron (system.jobs.ts); reads show it live. */
function liveStatus(u: SystemUserVM, now = Date.now()): SystemUserVM {
  return u.status === "invited" &&
    u.invitation &&
    Date.parse(u.invitation.expiresAt) <= now
    ? { ...u, status: "invite_expired" }
    : u;
}
export function sweepInvites(w: World, now = Date.now()) {
  for (const m of w.userMeta)
    if (
      m.status === "invited" &&
      m.invitation &&
      Date.parse(m.invitation.expiresAt) <= now
    ) {
      m.status = "invite_expired";
      m.version++;
    }
}

const LAST: Record<string, (t: number | null, now: number) => boolean> = {
  "7": (t, n) => t !== null && n - t < 7 * D,
  "30": (t, n) => t !== null && n - t < 30 * D,
  "90": (t, n) => t !== null && n - t >= 90 * D,
  never: (t) => t === null,
};

// ---------------------------------------------------------------- U3 list / U4 detail
export type UserFilter = {
  kind?: UserKind;
  role?: string;
  status?: string;
  mfa?: string;
  last?: string;
  q?: string;
};
export function listUsers(c: Caller, f: UserFilter) {
  guard(c.session);
  return read(c, async (w) => {
    const kind = f.kind ?? "staff",
      now = Date.now(),
      text = (f.q ?? "").trim().toLowerCase();
    const staff = (await people(w)).map((u) => liveStatus(u, now));
    const [{ n: clients }] = await w.db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, "client"));
    const counts: Record<UserKind, number> = {
      staff: 0,
      agent: 0,
      client: Number(clients),
      service: 0,
    };
    staff.forEach((u) => counts[u.kind]++);
    // shortcut: client list capped at 500 newest matches; page with nextCursor when the client base outgrows it.
    const pool =
      kind === "client"
        ? (
            await rows(
              w.db,
              and(
                eq(users.role, "client"),
                text
                  ? sql`(lower(${users.name}) like ${`%${text}%`} or lower(${users.email}) like ${`%${text}%`})`
                  : undefined,
              ),
            )
          )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 500)
            .map((r) => toVM(r, metaOf(w, r.userId)))
        : staff;
    const out = pool.filter(
      (u) =>
        u.kind === kind &&
        (!f.role || u.roles.some((r) => r.role === f.role)) &&
        (!f.status || u.status === f.status) &&
        (!f.mfa || u.mfa.state === f.mfa) &&
        (!f.last ||
          !LAST[f.last] ||
          LAST[f.last](
            u.lastActiveAt ? Date.parse(u.lastActiveAt) : null,
            now,
          )) &&
        (!text ||
          u.name.toLowerCase().includes(text) ||
          u.email.toLowerCase().includes(text) ||
          (u.customerNo ?? "").toLowerCase().includes(text)),
    );
    return {
      rows: out.map((u) => view(u, true)),
      total: out.length,
      counts,
      nextCursor: null,
    };
  });
}
export async function exportUsers(c: Caller) {
  guard(c.session);
  return write(c, async (w) => {
    const n = (await people(w)).length;
    record(w, "data_export.report.exported", "report", "users.csv", undefined, {
      rows: n,
    });
    return { ready: true };
  });
}
export function userDetail(c: Caller, id: string) {
  guard(c.session);
  return read(c, async (w) => {
    const u = await target(w, id);
    const all = await people(w);
    return {
      ...view(liveStatus(u)),
      lastSysadmin: isLastSysadmin(all, u.id),
      openCases: await openCases(w.db, u.id),
    };
  });
}

// ---------------------------------------------------------------- invite (J1)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function createInvited(
  w: World,
  p: { name: string; email: string; phone?: string | null; roles: string[] },
  by: string,
) {
  const id = generateId("usr"),
    now = iso();
  // Unusable password until the invitee sets one through the single-use link (auth set-password flow).
  await w.db.insert(users).values({
    userId: id,
    name: p.name,
    email: p.email,
    phoneE164: p.phone ?? null,
    passwordHash: await w.caller.deps.password.hash(
      randomBytes(32).toString("base64url"),
    ),
    role: p.roles[0],
    isActive: true,
    isEmailVerified: false,
    language: "rw",
    createdAt: now,
    updatedAt: now,
  });
  await w.db
    .insert(staffProfiles)
    .values({ userId: id, twofaEnabled: false, createdAt: now })
    .onConflictDoNothing();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  w.userMeta.push({
    id,
    status: "invited",
    version: 1,
    createdBy: by,
    grantedBy: by,
    invitation: { expiresAt, invitedBy: by },
    extraRoles: p.roles.slice(1).map((role) => ({
      role,
      grantedBy: by,
      grantedAt: now,
      expiresAt: null,
    })),
  });
  const [u] = await w.db.select().from(users).where(eq(users.userId, id));
  await w.caller.deps.auth.issueResetToken(w.db as Tx, u, INVITE_TTL_MS / 1000, "invite"); // mails the set-password link (queued; no-op without a mail key)
  record(w, "access.user.invited", "user", id, undefined, {
    roles: p.roles,
    expiresAt,
  });
  return { userId: id, expiresAt };
}
const emailTaken = async (db: Exec, email: string) =>
  (
    await db
      .select({ id: users.userId })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1)
  )[0];

onApply("invite_privileged", async (w, cr) => {
  const p = cr.payload as {
    name: string;
    email: string;
    phone?: string | null;
    roles: string[];
  };
  if (!(await emailTaken(w.db, p.email.toLowerCase())))
    await createInvited(w, p, cr.proposedBy.name);
});
onApply("role_grant", async (w, cr) => {
  const p = cr.payload as {
    userId: string;
    role: string;
    expiresAt?: string | null;
  };
  const u = await userById(w, p.userId);
  if (!u || u.roles.some((r) => r.role === p.role)) return;
  const m = metaFor(w, u.id);
  m.extraRoles = [
    ...(m.extraRoles ?? []),
    {
      role: p.role,
      grantedBy: cr.proposedBy.name,
      grantedAt: iso(),
      expiresAt: p.expiresAt ?? null,
    },
  ];
  m.version++;
  record(
    w,
    "access.role.granted",
    "user",
    u.id,
    undefined,
    { role: p.role },
    cr.reason,
    undefined,
    { approvalRef: cr.id },
  );
});

export type InviteIn = {
  name?: string;
  email?: string;
  phone?: string;
  roles?: string[];
  reason?: string;
};
export async function invite(c: Caller, b: InviteIn) {
  const s = guard(c.session);
  await stepUp(c, s);
  const name = (b.name ?? "").trim(),
    email = (b.email ?? "").trim().toLowerCase(),
    roles = (b.roles ?? []).filter((r) => ASSIGNABLE.includes(r)),
    reason = (b.reason ?? "").trim();
  if (
    name.length < 2 ||
    !EMAIL.test(email) ||
    !roles.length ||
    (b.phone && !/^\+2507[2389]\d{7}$/.test(b.phone))
  )
    throw fail(422, "validation", "Check the fields.");
  return write(c, async (w) => {
    if (await emailTaken(w.db, email)) {
      const [me] = await w.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.userId, w.actor.id));
      if (me?.email?.toLowerCase() === email)
        throw fail(403, "self_grant", "Can't grant yourself roles.");
      throw fail(409, "email_taken", "Email already has an account.");
    }
    if (sodConflicts(roles).length)
      throw fail(422, "sod_conflict", "Role mix blocked.");
    if (needsApproval(roles)) {
      if (reason.length < 10)
        throw fail(422, "reason_required", "Reason needed.");
      const top =
        roles.find((r) => r === "staff:sysadmin") ??
        roles.find((r) => PRIVILEGED_GRANT.has(r))!;
      return accepted(
        submitChange(w, {
          kind: "invite_privileged",
          title: `Invite ${name} (${roles.join(", ")})`,
          reason,
          before: null,
          after: { name, email, roles },
          payload: { name, email, phone: b.phone ?? null, roles, role: top },
        }),
      );
    }
    return {
      invitation: await createInvited(
        w,
        { name, email, phone: b.phone, roles },
        w.actor.name,
      ),
    };
  });
}
export async function invitationOp(c: Caller, id: string, opRaw: string) {
  guard(c.session);
  const op =
    opRaw === "resend" ? "resend" : opRaw === "revoke" ? "revoke_invite" : null;
  if (!op) throw fail(404, "not_found", "Not found.");
  return write(c, async (w) => {
    const u = liveStatus(await target(w, id));
    const next = USER_NEXT[u.status][op];
    if (!next) throw fail(409, "stale", "Invitation already changed.");
    const m = metaFor(w, id);
    m.status = next;
    if (op === "resend") {
      m.invitation = {
        expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        invitedBy: w.actor.name,
      };
      const [row] = await w.db.select().from(users).where(eq(users.userId, id));
      await w.db
        .update(users)
        .set({ isActive: true, updatedAt: iso() })
        .where(eq(users.userId, id));
      await w.caller.deps.auth.issueResetToken(w.db as Tx, row, INVITE_TTL_MS / 1000, "invite");
      record(w, "access.invitation.resent", "user", id, undefined, {
        expiresAt: m.invitation.expiresAt,
      });
    } else {
      await w.db
        .update(users)
        .set({ isActive: false, updatedAt: iso() })
        .where(eq(users.userId, id));
      record(w, "access.invitation.revoked", "user", id);
    }
    m.version++;
    return view((await userById(w, id))!);
  });
}

// ---------------------------------------------------------------- roles on a user
export type RoleOpIn = {
  action: "grant" | "revoke";
  role: string;
  reason?: string;
  expiresAt?: string | null;
};
export async function changeRole(c: Caller, id: string, b: RoleOpIn) {
  const s = guard(c.session);
  if (id === s.id)
    throw fail(403, "self_grant", "Can't change your own roles.");
  const reason = (b.reason ?? "").trim();
  if (b.action === "grant" && needsApproval([b.role])) await stepUp(c, s);
  return write(c, async (w) => {
    const u = await target(w, id);
    stale(c.ifMatch, u.version);
    const has = u.roles.map((r) => r.role);
    if (b.action === "grant") {
      if (
        !ASSIGNABLE.includes(b.role) ||
        u.kind === "client" ||
        u.kind === "service"
      )
        throw fail(422, "validation", "Role can't be granted here.");
      if (has.includes(b.role)) throw fail(409, "stale", "Already has it.");
      if (sodConflicts([...has, b.role]).length)
        throw fail(422, "sod_conflict", "Role mix blocked.");
      if (reason.length < 10)
        throw fail(422, "reason_required", "Reason needed.");
      if (needsApproval([b.role]))
        return accepted(
          submitChange(w, {
            kind: "role_grant",
            title: `Grant ${b.role} to ${u.name}`,
            reason,
            before: { roles: has },
            after: { roles: [...has, b.role] },
            payload: {
              userId: u.id,
              role: b.role,
              expiresAt: b.expiresAt ?? null,
            },
          }),
        );
      const m = metaFor(w, id);
      m.extraRoles = [
        ...(m.extraRoles ?? []),
        {
          role: b.role,
          grantedBy: w.actor.name,
          grantedAt: iso(),
          expiresAt: b.expiresAt ?? null,
        },
      ];
      m.version++;
      record(
        w,
        "access.role.granted",
        "user",
        id,
        undefined,
        { role: b.role },
        reason,
      );
      return view((await userById(w, id))!);
    }
    if (!has.includes(b.role))
      throw fail(409, "stale", "Role already removed.");
    if (b.role === "staff:sysadmin" && isLastSysadmin(await people(w), id))
      throw fail(409, "last_sysadmin", "Last sysadmin.");
    if (reason.length < 3) throw fail(422, "reason_required", "Reason needed.");
    await removeRole(w, u, b.role);
    record(
      w,
      "access.role.revoked",
      "user",
      id,
      { role: b.role },
      undefined,
      reason,
    );
    await w.caller.deps.auth.revokeAllSessions(w.db as Tx, id, c.session?.sid); // IAM §12: revoking a role revokes sessions
    bump(w, id);
    return view((await userById(w, id))!);
  });
}
/** Drops a grant: from the overlay, or from users.role (promoting the next grant into the column). */
export async function removeRole(w: World, u: SystemUserVM, role: string) {
  const m = metaFor(w, u.id);
  const [row] = await w.db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.userId, u.id));
  if (normalizeRoles({ role: row.role }).includes(role as Role)) {
    const next = (m.extraRoles ?? []).find((g) => g.role !== role);
    if (!next)
      throw fail(
        422,
        "validation",
        "This is the account's only role. Deactivate the account instead.",
      );
    await w.db
      .update(users)
      .set({ role: next.role, updatedAt: iso() })
      .where(eq(users.userId, u.id));
    m.extraRoles = (m.extraRoles ?? []).filter((g) => g !== next);
  } else m.extraRoles = (m.extraRoles ?? []).filter((g) => g.role !== role);
}

// ---------------------------------------------------------------- status (suspend / reactivate / deactivate / unlock)
export async function setStatus(
  c: Caller,
  id: string,
  b: { action: UserAction; reason?: string },
) {
  const s = guard(c.session);
  if (id === s.id) throw fail(403, "self_grant", "Not on your own account.");
  if ((b.reason ?? "").trim().length < 3)
    throw fail(422, "reason_required", "Reason needed.");
  return write(c, async (w) => {
    const u = await target(w, id);
    const next = USER_NEXT[u.status][b.action];
    if (!next) throw fail(409, "stale", "Status already changed.");
    if (
      (b.action === "suspend" || b.action === "deactivate") &&
      isLastSysadmin(await people(w), id)
    )
      throw fail(409, "last_sysadmin", "Last sysadmin.");
    await applyStatus(w, u, next);
    const code =
      b.action === "suspend"
        ? "access.user.suspended"
        : b.action === "deactivate"
          ? "access.user.deactivated"
          : "access.user.reactivated";
    record(
      w,
      code,
      "user",
      id,
      { status: u.status },
      { status: next },
      b.reason,
    );
    return view((await userById(w, id))!);
  });
}
/** Writes the lifecycle state through to users.is_active and ends sessions when access stops. */
export async function applyStatus(
  w: World,
  u: SystemUserVM,
  next: SystemUserVM["status"],
) {
  const m = metaFor(w, u.id);
  m.status = next;
  m.version++;
  const active = next === "active" || next === "invited";
  await w.db
    .update(users)
    .set({ isActive: active, updatedAt: iso() })
    .where(eq(users.userId, u.id));
  if (!active) {
    const n = await w.caller.deps.auth.revokeAllSessions(w.db as Tx, u.id);
    if (n)
      record(
        w,
        "auth.session.revoked",
        "user",
        u.id,
        { sessions: n },
        { sessions: 0 },
      );
  }
}

export async function mfaReset(
  c: Caller,
  id: string,
  accessRequestId?: string,
) {
  await stepUp(c, guard(c.session));
  return write(c, async (w) => {
    const u = await target(w, id);
    const req = (await identityRequests(w)).find(
      (r) =>
        r.id === accessRequestId &&
        r.userId === u.id &&
        r.kind === "two_factor" &&
        r.status === "approved",
    );
    if (!req)
      throw fail(422, "validation", "Needs an approved identity check.");
    await resetMfa(w.db, id);
    metaFor(w, id).mfaState = "reset";
    bump(w, id);
    record(
      w,
      "auth.mfa.reset",
      "user",
      id,
      undefined,
      undefined,
      undefined,
      undefined,
      { approvalRef: req.id },
    );
    return view((await userById(w, id))!);
  });
}
export async function unlock(c: Caller, id: string, accessRequestId?: string) {
  guard(c.session);
  return write(c, async (w) => {
    const u = await target(w, id);
    if (u.status !== "locked") throw fail(409, "stale", "Not locked.");
    await applyStatus(w, u, "active");
    record(
      w,
      accessRequestId
        ? "access.access_request.approved"
        : "access.user.reactivated",
      "user",
      id,
      { status: "locked" },
      { status: "active" },
    );
    return view((await userById(w, id))!);
  });
}

// ---------------------------------------------------------------- offboarding (WRK §6.3)
export async function offboard(
  c: Caller,
  id: string,
  b: { reason?: string; revokeSessions?: boolean },
) {
  const s = guard(c.session);
  await stepUp(c, s);
  if (id === s.id) throw fail(403, "self_grant", "Not on your own account.");
  if ((b.reason ?? "").trim().length < 3)
    throw fail(422, "reason_required", "Reason needed.");
  return write(c, async (w) => {
    const u = await target(w, id);
    if (!USER_NEXT[u.status].deactivate)
      throw fail(409, "stale", "Already deactivated.");
    if (isLastSysadmin(await people(w), id))
      throw fail(409, "last_sysadmin", "Last sysadmin.");
    const m = metaFor(w, id);
    m.status = "deactivated";
    m.version++;
    await w.db
      .update(users)
      .set({ isActive: false, updatedAt: iso() })
      .where(eq(users.userId, id));
    if (b.revokeSessions !== false) await w.caller.deps.auth.revokeAllSessions(w.db as Tx, id);
    const n = await openCases(w.db, id);
    // Open cases go back to the service manager's queue (unassigned); the SM re-routes them.
    const sm = (await people(w)).find(
      (p) =>
        p.status === "active" &&
        p.roles.some((r) => r.role === "staff:service_manager"),
    );
    if (n)
      await w.db
        .update(applications)
        .set({ assignedAgentId: null })
        .where(
          and(
            eq(applications.assignedAgentId, id),
            sql`${applications.status} not in ${DONE_CASE}`,
          ),
        );
    const handoffId = n ? `HO-${id.slice(-4).toUpperCase()}-${n}` : null;
    record(
      w,
      "access.user.deactivated",
      "user",
      id,
      { status: u.status },
      {
        status: "deactivated",
        handoffTo: n ? (sm?.name ?? null) : null,
        openCases: n,
      },
      b.reason,
    );
    return { handoffId, sm: sm?.name ?? "" };
  });
}

// ---------------------------------------------------------------- service accounts (US5)
export function serviceAccounts(c: Caller) {
  guard(c.session);
  return read(c, async (w) => {
    const boot = w.userMeta.find((m) => m.isBootstrap);
    const b = boot ? await userById(w, boot.id) : undefined;
    return { items: w.serviceAccounts, bootstrap: b ? view(b) : null };
  });
}
export async function rotateServiceAccount(c: Caller, id: string) {
  await stepUp(c, guard(c.session));
  return write(c, (w) => {
    const a = w.serviceAccounts.find((x) => x.id === id);
    if (!a) throw fail(404, "not_found", "Not found.");
    const secret = `hbz_svc_${randomBytes(24).toString("hex")}`;
    const before = a.last4;
    a.last4 = secret.slice(-4);
    a.rotatedAt = iso();
    // Only the hash is kept: the secret is shown once to the caller (copy-once dialog).
    w.secrets.set(`svc:${a.id}`, hashToken(secret)); // sha256 only; verified by the service-auth check
    record(
      w,
      "config.integration.credential_rotated",
      "service_account",
      a.id,
      { last4: before },
      { last4: a.last4 },
    );
    return { secret, account: a as ServiceAccountVM };
  });
}

// ---------------------------------------------------------------- U10 identity checks (team_access_requests)
export async function identityRequests(w: World): Promise<IdentityRequestVM[]> {
  const reqs = await w.db
    .select()
    .from(teamAccessRequests)
    .where(inArray(teamAccessRequests.kind, ["two_factor", "unlock"]));
  const emails = [...new Set(reqs.map((r) => r.email.toLowerCase()))];
  const us = emails.length
    ? await w.db
        .select({ id: users.userId, name: users.name, email: users.email })
        .from(users)
        .where(sql`lower(${users.email}) in ${emails}`)
    : [];
  return reqs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const m = w.identityMeta.find((x) => x.id === r.id);
      const u = us.find(
        (x) => x.email?.toLowerCase() === r.email.toLowerCase(),
      );
      const um = u && metaOf(w, u.id);
      return {
        id: r.reference,
        kind: r.kind as IdentityRequestVM["kind"],
        userId: u?.id ?? m?.userId ?? "",
        userName: u?.name ?? r.email,
        managerName: m?.managerName ?? um?.managerName ?? "—",
        reason: r.note ?? "",
        at: new Date(r.createdAt).toISOString(),
        status:
          r.status === "open"
            ? "pending"
            : (r.status as "approved" | "declined"),
        ...(m?.decidedBy ? { decidedBy: m.decidedBy } : {}),
        ...(r.resolvedAt
          ? { decidedAt: new Date(r.resolvedAt).toISOString() }
          : {}),
        ...(m?.declineReason ? { declineReason: m.declineReason } : {}),
      };
    });
}
export function listIdentity(c: Caller) {
  guard(c.session);
  return read(c, async (w) => ({ items: await identityRequests(w) }));
}
export async function decideIdentity(
  c: Caller,
  ref: string,
  op: string,
  b: { checklist?: Record<string, boolean>; reason?: string; note?: string },
) {
  const s = guard(c.session);
  if (op !== "approve" && op !== "decline")
    throw fail(404, "not_found", "Not found.");
  if (op === "approve") await stepUp(c, s);
  return write(c, async (w) => {
    const r = (await identityRequests(w)).find((x) => x.id === ref);
    if (!r) throw fail(404, "not_found", "Not found.");
    if (r.status === "approved" || r.status === "declined")
      throw fail(409, "already_decided", "Already decided.");
    if (r.userId === w.actor.id)
      throw fail(403, "self_approval", "Not your own request.");
    const [row] = await w.db
      .select()
      .from(teamAccessRequests)
      .where(eq(teamAccessRequests.reference, ref));
    const meta = () => {
      let m = w.identityMeta.find((x) => x.id === row.id);
      if (!m) {
        m = { id: row.id };
        w.identityMeta.push(m);
      }
      return m;
    };
    const now = iso();
    if (op === "decline") {
      if ((b.reason ?? "").trim().length < 10)
        throw fail(422, "reason_required", "Reason needed.");
      await w.db
        .update(teamAccessRequests)
        .set({ status: "declined", resolvedBy: w.actor.id, resolvedAt: now })
        .where(eq(teamAccessRequests.id, row.id));
      Object.assign(meta(), {
        decidedBy: w.actor.name,
        declineReason: b.reason!.trim(),
        userId: r.userId,
      });
      record(
        w,
        "access.access_request.declined",
        "access_request",
        r.id,
        undefined,
        { userId: r.userId },
        b.reason,
      );
      return {
        ...r,
        status: "declined" as const,
        decidedBy: w.actor.name,
        decidedAt: now,
        declineReason: b.reason!.trim(),
      };
    }
    const ck = b.checklist ?? {};
    if (
      !["callback", "video", "manager", "reason"].every((k) => ck[k] === true)
    )
      throw fail(422, "validation", "Checklist incomplete.");
    await w.db
      .update(teamAccessRequests)
      .set({ status: "approved", resolvedBy: w.actor.id, resolvedAt: now })
      .where(eq(teamAccessRequests.id, row.id));
    Object.assign(meta(), { decidedBy: w.actor.name, userId: r.userId });
    record(
      w,
      "access.access_request.approved",
      "access_request",
      r.id,
      undefined,
      { userId: r.userId, kind: r.kind, checklist: ck },
      b.note,
    );
    const u = r.userId ? await userById(w, r.userId) : undefined;
    if (u && r.kind === "two_factor") {
      await resetMfa(w.db, u.id);
      metaFor(w, u.id).mfaState = "reset";
      record(
        w,
        "auth.mfa.reset",
        "user",
        u.id,
        undefined,
        undefined,
        undefined,
        undefined,
        { approvalRef: r.id },
      );
    }
    if (u && r.kind === "unlock" && u.status === "locked") {
      await applyStatus(w, u, "active");
      record(
        w,
        "access.user.reactivated",
        "user",
        u.id,
        { status: "locked" },
        { status: "active" },
        undefined,
        undefined,
        { approvalRef: r.id },
      );
    }
    if (u) bump(w, u.id);
    return {
      ...r,
      status: "approved" as const,
      decidedBy: w.actor.name,
      decidedAt: now,
    };
  });
}
