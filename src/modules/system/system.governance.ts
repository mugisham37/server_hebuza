// P10 roles + custom roles (U5/U6), SoD + waivers (U8), access reviews (U7), break-glass (U9) — port of
// handlers-system-c. Order in every write: role → step-up → If-Match → validation → rules → write → record().
import type { Tx } from "../../core/db/db";
import { ROLES, type Role } from "@/domain/auth/roles";
import { MATRIX, type Scope } from "@/domain/auth/permissions";
import { PRIVILEGED_GRANT } from "@/domain/system/approvals";
import {
  BREAK_GLASS_MINUTES,
  WAIVER_MAX_DAYS,
  canComplete,
  canReview,
  customRoleConflicts,
  isLastSysadmin,
  reviewProgress,
  riskFlags,
  sodConflicts,
  SOD_PAIRS,
  SOD_PROCESS,
} from "@/domain/system/governance";
import type {
  ChangeRequestVM,
  PersonRef,
  ReviewCampaignVM,
  ReviewDecision,
  SystemUserVM,
} from "@/domain/system/types";
import type {
  BreakGlassInput,
  BreakGlassViewVM,
  CampaignRowVM,
  CustomRoleInput,
  RoleDetailVM,
  RoleRowVM,
  WaiverInput,
} from "./lib/vm";
import { auditRows } from "./system.audit";
import { applyStatus, people, removeRole } from "./system.users";
import {
  accepted,
  fail,
  guard,
  invalidFields,
  isExec,
  isSysadmin,
  nextNo,
  onApply,
  person,
  read,
  record,
  settingValue,
  stale,
  stepUp,
  submitChange,
  SYSTEM_ACTOR,
  write,
  type Caller,
  type World,
} from "./system.world";
import { iso } from "../../core/db/ids";

const D = 86_400_000;
const ago = (s: string | null | undefined) => (s ? Date.parse(s) : 0);
const PERM_KEYS = new Set(Object.keys(MATRIX));
const SCOPES: readonly Scope[] = ["all", "own", "org", "scoped"];
const roleSlug = (r: string) =>
  r === "ext:agent" ? "ext-agent" : r.replace(/^staff:/, "");
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 40);
const flagOn = (w: World) => settingValue(w, "flags.custom_roles") === true;

// ---------------------------------------------------------------- roles (U5/U6)
const members = (ps: SystemUserVM[], role: string) =>
  ps.filter(
    (u) => u.status !== "deactivated" && u.roles.some((r) => r.role === role),
  );
const pendingFor = (w: World, slug: string) =>
  w.changes.find(
    (c) =>
      c.kind === "custom_role" &&
      c.state === "proposed" &&
      c.payload.slug === slug,
  ) ?? null;
function allRows(w: World, ps: SystemUserVM[]): RoleRowVM[] {
  const builtin = ROLES.filter((r) => r !== "visitor").map((r): RoleRowVM => {
    const m = members(ps, r);
    const last =
      m
        .flatMap((u) =>
          u.roles.filter((g) => g.role === r).map((g) => g.grantedAt),
        )
        .sort()
        .at(-1) ?? null;
    return {
      slug: roleSlug(r),
      role: r,
      name: r,
      builtin: true,
      privileged: PRIVILEGED_GRANT.has(r),
      members: m.length,
      lastChangedAt: last,
      status: "active",
      pending: false,
      version: 1,
    };
  });
  return [
    ...builtin,
    ...w.customRoles.map((c) => ({
      ...c,
      members: members(ps, c.role).length,
      pending: !!pendingFor(w, c.slug),
    })),
  ];
}
export function listRoles(c: Caller) {
  guard(c.session);
  return read(c, async (w) => ({
    items: allRows(w, await people(w)),
    customEnabled: flagOn(w),
  }));
}
export function roleDetail(c: Caller, slug: string) {
  guard(c.session);
  return read(c, async (w): Promise<RoleDetailVM> => {
    const ps = await people(w);
    const row = allRows(w, ps).find((r) => r.slug === slug);
    if (!row) throw fail(404, "not_found", "Not found.");
    return {
      ...row,
      change: row.builtin ? null : pendingFor(w, row.slug),
      memberList: members(ps, row.role).map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
      })),
    };
  });
}
function validateRole(
  w: World,
  ps: SystemUserVM[],
  b: Partial<CustomRoleInput>,
  selfSlug?: string,
) {
  const f: Record<string, string> = {};
  const name = (b.name ?? "").trim();
  if (!name || name.length > 40) f.name = "name_length";
  else if (
    allRows(w, ps).some(
      (r) =>
        r.slug !== selfSlug &&
        r.status === "active" &&
        (r.name.toLowerCase() === name.toLowerCase() ||
          r.slug === slugify(name)),
    )
  )
    f.name = "name_taken";
  if (!(b.description ?? "").trim() || (b.description ?? "").length > 280)
    f.description = "description_length";
  if (b.base && !(ROLES as readonly string[]).includes(b.base))
    f.base = "base_unknown";
  const perms = Object.entries(b.perms ?? {});
  if (!perms.length) f.perms = "perms_empty";
  if (perms.some(([k, s]) => !PERM_KEYS.has(k) || !SCOPES.includes(s as Scope)))
    f.perms = "perms_invalid";
  if (Object.keys(f).length) throw invalidFields(f);
}
onApply("custom_role", (w, cr) => {
  const p = cr.after as CustomRoleInput & { slug: string };
  const i = w.customRoles.findIndex((c) => c.slug === p.slug);
  const row: RoleRowVM = {
    slug: p.slug,
    role: `custom:${p.slug}`,
    name: p.name,
    builtin: false,
    privileged: Object.keys(p.perms).some((k) => k.startsWith("iam.")),
    members: 0,
    lastChangedAt: iso(),
    status: "active",
    pending: false,
    description: p.description,
    base: p.base,
    perms: p.perms,
    version: i >= 0 ? w.customRoles[i].version + 1 : 1,
  };
  if (i >= 0) w.customRoles[i] = row;
  else w.customRoles.push(row);
  record(
    w,
    i >= 0 ? "config.role.changed" : "config.role.created",
    "role",
    p.slug,
    cr.before,
    cr.after,
    cr.reason,
    undefined,
    { approvalRef: cr.id },
  );
});
export type RoleIn = Partial<CustomRoleInput> & { reason?: string };
export async function proposeRole(c: Caller, b: RoleIn, slug?: string) {
  const s = guard(c.session);
  const flag = await read(c, (w) => flagOn(w));
  if (!flag) throw fail(403, "flag_off", "Custom roles are switched off.");
  await stepUp(c, s);
  return write(c, async (w) => {
    const existing = slug
      ? w.customRoles.find((x) => x.slug === slug)
      : undefined;
    if (slug && !existing) throw fail(404, "not_found", "Not found.");
    if (existing) stale(c.ifMatch, existing.version);
    validateRole(w, await people(w), b, slug);
    const conflicts = customRoleConflicts(Object.keys(b.perms!));
    if (conflicts.length)
      throw fail(
        409,
        "sod_conflict",
        `Conflicts with: ${conflicts.join(", ")}`,
        { conflicts },
      );
    if (slug && pendingFor(w, slug))
      throw fail(
        409,
        "already_pending",
        "A change to this role is already waiting for approval.",
      );
    const sl = slug ?? slugify(b.name!);
    const after = {
      slug: sl,
      name: b.name!.trim(),
      description: b.description!.trim(),
      base: b.base,
      perms: b.perms,
    };
    const before = existing
      ? {
          slug: existing.slug,
          name: existing.name,
          description: existing.description,
          base: existing.base,
          perms: existing.perms,
        }
      : null;
    return accepted(
      submitChange(w, {
        kind: "custom_role",
        title: `${existing ? "Edit" : "Create"} custom role “${after.name}”`,
        reason: (b.reason ?? "").trim() || after.description,
        before,
        after,
        payload: { slug: sl },
      }),
    );
  });
}
export async function retireRole(c: Caller, slug: string) {
  await stepUp(c, guard(c.session));
  return write(c, async (w) => {
    const r = w.customRoles.find((x) => x.slug === slug);
    if (!r)
      throw ROLES.some((x) => roleSlug(x) === slug)
        ? fail(403, "builtin_readonly", "Built-in roles are read-only.")
        : fail(404, "not_found", "Not found.");
    stale(c.ifMatch, r.version);
    const n = members(await people(w), r.role).length;
    if (n)
      throw fail(409, "role_in_use", `${n} member(s) still hold this role.`, { members: n });
    r.status = "retired";
    r.version++;
    r.lastChangedAt = iso();
    record(
      w,
      "config.role.retired",
      "role",
      r.slug,
      { status: "active" },
      { status: "retired" },
    );
    return r;
  });
}

// ---------------------------------------------------------------- SoD (U8)
export async function sodCheck(c: Caller, roles: string) {
  guard(c.session);
  const conflicts = sodConflicts(roles.split(",").filter(Boolean));
  return { ok: !conflicts.length, conflicts };
}
export function sodView(c: Caller) {
  guard(c.session);
  return read(c, async (w) => {
    const weekAgo = new Date(Date.now() - 7 * D).toISOString();
    const ps = await people(w);
    return {
      pairs: [...SOD_PAIRS],
      process: [...SOD_PROCESS],
      waivers: w.waivers,
      pending: w.changes.filter(
        (x) => x.kind === "sod_waiver" && x.state === "proposed",
      ),
      exceptions: (
        await auditRows(
          w.db,
          { action: "access.sod.waiver_approved", from: weekAgo },
          200,
        )
      ).items,
      people: ps
        .filter((u) => u.kind === "staff" && u.status === "active")
        .map((u) => ({
          id: u.id,
          name: u.name,
          roles: u.roles.map((r) => r.role),
        })),
    };
  });
}
onApply("sod_waiver", (w, cr) => {
  const p = cr.after as WaiverInput & { userName: string };
  const exe = cr.decisions.find((d) => d.decision === "approve")?.by;
  w.waivers.unshift({
    id: nextNo(w, "WV", 3, false),
    userId: p.userId,
    userName: p.userName,
    pair: p.pair,
    why: p.why,
    expiresAt: p.expiresAt,
    approvedBy: exe ? person(exe) : person(SYSTEM_ACTOR),
    approvedAt: iso(),
  });
  record(
    w,
    "access.sod.waiver_approved",
    "user",
    p.userId,
    null,
    { pair: p.pair, expiresAt: p.expiresAt },
    p.why,
    undefined,
    { approvalRef: cr.id },
  );
});
export async function proposeWaiver(c: Caller, b: Partial<WaiverInput>) {
  await stepUp(c, guard(c.session));
  return write(c, async (w) => {
    const u = (await people(w)).find((x) => x.id === b.userId);
    const f: Record<string, string> = {};
    if (!u) f.userId = "required";
    if (
      !SOD_PAIRS.some(
        (p) =>
          (p.a === b.pair?.[0] && p.b === b.pair?.[1]) ||
          (p.a === b.pair?.[1] && p.b === b.pair?.[0]),
      )
    )
      f.pair = "required";
    if ((b.why ?? "").trim().length < 10) f.why = "too_short";
    const exp = Date.parse(b.expiresAt ?? "");
    if (!exp || exp <= Date.now()) f.expiresAt = "required";
    else if (exp - Date.now() > WAIVER_MAX_DAYS * D) f.expiresAt = "too_long";
    if (Object.keys(f).length || !u) throw invalidFields(f);
    return accepted(
      submitChange(w, {
        kind: "sod_waiver",
        title: `SoD waiver for ${u.name}`,
        reason: b.why!.trim(),
        before: null,
        after: { ...b, userName: u.name },
        payload: { userId: u.id, pair: b.pair },
      }),
    );
  });
}

// ---------------------------------------------------------------- access reviews (U7)
/** Overdue campaigns escalate to the executive (cron). */
export async function sweepReviews(w: World, now = Date.now()) {
  const due = w.reviews.filter(
    (c) => c.status === "open" && ago(c.dueAt) < now,
  );
  if (!due.length) return;
  const exe = (await people(w)).find(
    (u) =>
      u.status === "active" &&
      u.roles.some((r) => r.role === "staff:executive"),
  );
  for (const c of due) {
    c.status = "overdue";
    c.version++;
    if (exe) c.escalatedTo = person(exe);
  }
}
const live = (c: ReviewCampaignVM, now = Date.now()): ReviewCampaignVM =>
  c.status === "open" && ago(c.dueAt) < now ? { ...c, status: "overdue" } : c;
function campaignRow({ items, ...c }: ReviewCampaignVM): CampaignRowVM {
  const p = reviewProgress({ items });
  const s = (
    c as {
      stats?: {
        total: number;
        kept: number;
        removed: number;
        suspended: number;
      };
    }
  ).stats; // archived campaigns keep totals only
  return {
    ...c,
    ...p,
    ...(s && !items.length ? { total: s.total, done: s.total, pct: 100 } : {}),
    kept:
      s && !items.length
        ? s.kept
        : items.filter((i) => i.decision === "kept").length,
    removed:
      s && !items.length
        ? s.removed
        : items.filter((i) => i.decision === "role_removed").length,
    suspended:
      s && !items.length
        ? s.suspended
        : items.filter((i) => i.decision === "suspended").length,
  };
}
export function listReviews(c: Caller) {
  guard(c.session, true);
  return read(c, (w) => ({
    items: w.reviews.map((r) => campaignRow(live(r))),
  }));
}
export function reviewDetail(c: Caller, id: string) {
  guard(c.session, true);
  return read(c, (w) => {
    const r = w.reviews.find((x) => x.id === id);
    if (!r) throw fail(404, "not_found", "Not found.");
    return live(r);
  });
}
/** Open a new campaign over every staff/agent role grant (quarterly cron, or a sysadmin from the UI). */
export async function openCampaign(w: World, dueDays = 14) {
  const ps = (await people(w)).filter(
    (u) =>
      (u.kind === "staff" || u.kind === "agent") &&
      !u.isBootstrap &&
      u.status !== "deactivated",
  );
  const sys = ps.filter(
    (u) =>
      u.roles.some((r) => r.role === "staff:sysadmin") && u.status === "active",
  );
  const now = Date.now(),
    q = Math.floor(new Date().getUTCMonth() / 3) + 1,
    year = new Date().getUTCFullYear();
  const id = `AR-${year}-Q${q}`;
  if (w.reviews.some((r) => r.id === id)) return null;
  const items = ps
    .flatMap((u) => u.roles.map((r) => ({ u, r })))
    .map(({ u, r }, i) => {
      const reviewer = sys.find((s) => s.id !== u.id) ?? sys[0];
      return {
        id: `ri-${i + 1}`,
        userId: u.id,
        userName: u.name,
        role: r.role,
        lastActiveAt: u.lastActiveAt,
        flags: riskFlags(
          u,
          now,
          w.waivers.filter((x) => x.userId === u.id).length,
        ),
        decision: "pending" as const,
        reviewer: reviewer ? person(reviewer) : person(SYSTEM_ACTOR),
      };
    });
  const c: ReviewCampaignVM = {
    id,
    name: `Q${q} ${year} access review`,
    status: "open",
    openedAt: iso(),
    dueAt: new Date(now + dueDays * D).toISOString(),
    items,
    signOffs: [],
    version: 1,
  };
  w.reviews.unshift(c);
  record(
    w,
    "access.review.opened",
    "access_review",
    id,
    null,
    { items: items.length },
    undefined,
    SYSTEM_ACTOR,
  );
  return c;
}
async function applyDecision(
  w: World,
  c: ReviewCampaignVM,
  itemId: string,
  decision: ReviewDecision,
  ps: SystemUserVM[],
) {
  const it = c.items.find((i) => i.id === itemId);
  if (!it) throw fail(404, "not_found", "Not found.");
  if (!canReview(w.actor.id, it.userId))
    throw fail(403, "self_review", "You can't review your own access.");
  const u = ps.find((x) => x.id === it.userId);
  if (
    u &&
    decision !== "kept" &&
    it.role === "staff:sysadmin" &&
    isLastSysadmin(ps, u.id)
  )
    throw fail(409, "last_sysadmin", "This is the last active sysadmin.");
  const before = it.decision;
  it.decision = decision;
  it.decidedAt = iso();
  if (
    u &&
    decision === "role_removed" &&
    u.roles.some((r) => r.role === it.role)
  ) {
    await removeRole(w, u, String(it.role));
    await w.caller.deps.auth.revokeAllSessions(w.db as Tx, u.id);
    record(
      w,
      "access.role.revoked",
      "user",
      u.id,
      { role: it.role },
      null,
      `Access review ${c.id}`,
    );
  }
  if (u && decision === "suspended" && u.status === "active") {
    await applyStatus(w, u, "suspended");
    record(
      w,
      "access.user.suspended",
      "user",
      u.id,
      { status: "active" },
      { status: "suspended" },
      `Access review ${c.id}`,
    );
  }
  record(
    w,
    "access.review.item_decided",
    "access_review",
    `${c.id}/${it.id}`,
    { decision: before },
    { decision, user: it.userId, role: it.role },
  );
}
export async function decideItem(
  c: Caller,
  id: string,
  itemId: string,
  b: { decision?: ReviewDecision; reviewerId?: string },
) {
  guard(c.session);
  return write(c, async (w) => {
    const r = w.reviews.find((x) => x.id === id);
    if (!r) throw fail(404, "not_found", "Not found.");
    if (r.status === "completed")
      throw fail(409, "already_decided", "This review is closed.");
    stale(c.ifMatch, r.version);
    const ps = await people(w);
    if (b.reviewerId) {
      const it = r.items.find((i) => i.id === itemId);
      const who = ps.find(
        (p) =>
          p.id === b.reviewerId &&
          p.status === "active" &&
          p.roles.some((g) => g.role === "staff:sysadmin"),
      );
      if (!it || !who) throw fail(422, "validation", "Pick a reviewer.");
      if (!canReview(who.id, it.userId))
        throw fail(
          403,
          "self_review",
          "A reviewer can't review their own access.",
        );
      it.reviewer = person(who);
    } else if (
      b.decision &&
      ["kept", "role_removed", "suspended"].includes(b.decision)
    )
      await applyDecision(w, r, itemId, b.decision, ps);
    else throw fail(422, "validation", "Pick a decision.");
    r.version++;
    return r;
  });
}
export async function bulkKeep(c: Caller, id: string, ids: string[]) {
  guard(c.session);
  return write(c, async (w) => {
    const r = w.reviews.find((x) => x.id === id);
    if (!r) throw fail(404, "not_found", "Not found.");
    if (r.status === "completed")
      throw fail(409, "already_decided", "This review is closed.");
    stale(c.ifMatch, r.version);
    const rows = r.items.filter(
      (i) =>
        ids.includes(i.id) &&
        i.decision === "pending" &&
        !i.flags.length &&
        canReview(w.actor.id, i.userId),
    );
    if (!rows.length)
      throw fail(422, "no_low_risk", "None of the selected rows are low-risk.");
    const ps = await people(w);
    for (const i of rows) await applyDecision(w, r, i.id, "kept", ps);
    r.version++;
    return r;
  });
}
export async function signOff(c: Caller, id: string) {
  const s = guard(c.session, true);
  await stepUp(c, s);
  return write(c, (w) => {
    const r = w.reviews.find((x) => x.id === id);
    if (!r) throw fail(404, "not_found", "Not found.");
    stale(c.ifMatch, r.version);
    if (r.items.some((i) => i.decision === "pending"))
      throw fail(409, "items_pending", "Decide every row first.");
    const role = isSysadmin(s) ? "staff:sysadmin" : "staff:executive";
    if (r.signOffs.some((x) => x.role === role))
      throw fail(409, "already_decided", "Already signed off.");
    r.signOffs.push({ role, by: person(w.actor), at: iso() });
    if (canComplete(r)) {
      r.status = "completed";
      record(
        w,
        "access.review.completed",
        "access_review",
        r.id,
        null,
        reviewProgress(r),
      );
    }
    r.version++;
    return r;
  });
}
export async function exportReview(c: Caller, id: string) {
  await stepUp(c, guard(c.session, true));
  return write(c, async (w) => {
    const r = w.reviews.find((x) => x.id === id);
    if (!r) throw fail(404, "not_found", "Not found.");
    const ref = nextNo(w, "ARX");
    // The audit row is the stored record of the export (who, when, which campaign); the screen renders the PDF view.
    record(w, "data_export.report.exported", "access_review", r.id, null, {
      format: "pdf",
      ref,
    });
    return { ref, at: iso() };
  });
}

// ---------------------------------------------------------------- break-glass (U9)
async function bgApprovers(w: World): Promise<(PersonRef & { role: Role })[]> {
  const ps = (await people(w)).filter(
    (u) => u.status === "active" && u.id !== w.breakGlass.request?.by.id,
  );
  const sys = ps.find((u) => u.roles.some((r) => r.role === "staff:sysadmin"));
  const exe = ps.find((u) => u.roles.some((r) => r.role === "staff:executive"));
  return [
    ...(sys ? [{ ...person(sys), role: "staff:sysadmin" as Role }] : []),
    ...(exe ? [{ ...person(exe), role: "staff:executive" as Role }] : []),
  ];
}
export function sweepBreakGlass(w: World, now = Date.now()) {
  const bg = w.breakGlass,
    req = bg.request;
  if (bg.state === "requested" && req) {
    const cr = w.changes.find((c) => c.id === req.changeId);
    if (cr && ["rejected", "withdrawn", "expired"].includes(cr.state)) {
      bg.state = "sealed";
      bg.request = undefined;
    }
  }
  if (bg.state === "active" && ago(bg.activeUntil) <= now) {
    bg.state = "expired";
    bg.endedAt = bg.activeUntil;
    record(
      w,
      "access.break_glass.ended",
      "break_glass",
      req?.id ?? "bg",
      { state: "active" },
      { state: "expired" },
      "Window ran out",
      SYSTEM_ACTOR,
    );
  }
}
const bgView = async (w: World): Promise<BreakGlassViewVM> => ({
  ...w.breakGlass,
  change: w.breakGlass.request
    ? (w.changes.find((c) => c.id === w.breakGlass.request?.changeId) ?? null)
    : null,
  approvers: await bgApprovers(w),
});
onApply("break_glass", (w, cr: ChangeRequestVM) => {
  const minutes = Number(cr.payload.minutes) || 60;
  Object.assign(w.breakGlass, {
    state: "active",
    activeUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
    lastUsedAt: iso(),
    endedAt: undefined,
    reviewNote: undefined,
  });
  // Elevation: the requester holds the sealed emergency grant until activeUntil (auth reads breakGlassGrant()).
  record(
    w,
    "access.break_glass.activated",
    "break_glass",
    String(cr.payload.requestId),
    null,
    { until: w.breakGlass.activeUntil },
    cr.reason,
    undefined,
    { approvalRef: cr.id, breakGlass: true },
  );
});
/** For auth/authz: the user currently holding break-glass elevation (sysadmin + executive approvals done), if any. */
export const breakGlassHolder = (w: World) =>
  w.breakGlass.state === "active" && ago(w.breakGlass.activeUntil) > Date.now()
    ? (w.breakGlass.request?.by.id ?? null)
    : null;

export function breakGlass(c: Caller) {
  guard(c.session, true);
  return read(c, (w) => {
    sweepBreakGlass(w);
    return bgView(w);
  });
}
export async function requestBreakGlass(
  c: Caller,
  b: Partial<BreakGlassInput>,
) {
  await stepUp(c, guard(c.session));
  return write(c, async (w) => {
    sweepBreakGlass(w);
    if (!["sealed", "reviewed"].includes(w.breakGlass.state))
      throw fail(409, "stale", "Break-glass is already in use.");
    const f: Record<string, string> = {};
    if ((b.reason ?? "").trim().length < 10) f.reason = "too_short";
    if (!(BREAK_GLASS_MINUTES as readonly number[]).includes(b.minutes ?? 0))
      f.minutes = "required";
    if (Object.keys(f).length) throw invalidFields(f);
    const reqId = `BG-${Date.now().toString(36).toUpperCase()}`;
    const cr = submitChange(w, {
      kind: "break_glass",
      title: `Break-glass access (${b.minutes! / 60} h)`,
      reason: b.reason!.trim(),
      before: { state: w.breakGlass.state },
      after: { state: "active", minutes: b.minutes },
      payload: {
        minutes: b.minutes,
        requestId: reqId,
        incidentId: b.incidentId || null,
      },
    });
    w.breakGlass.state = "requested";
    w.breakGlass.request = {
      id: reqId,
      by: person(w.actor),
      reason: b.reason!.trim(),
      incidentId: b.incidentId || undefined,
      minutes: b.minutes!,
      at: cr.proposedAt,
      changeId: cr.id,
    };
    return bgView(w);
  });
}
export async function endBreakGlass(c: Caller) {
  guard(c.session, true);
  return write(c, (w) => {
    sweepBreakGlass(w);
    if (w.breakGlass.state !== "active")
      throw fail(409, "already_decided", "Break-glass isn't active.");
    w.breakGlass.state = "ended";
    w.breakGlass.endedAt = iso();
    record(
      w,
      "access.break_glass.ended",
      "break_glass",
      w.breakGlass.request?.id ?? "bg",
      { state: "active" },
      { state: "ended" },
      "Ended early",
    );
    return bgView(w);
  });
}
export async function reviewBreakGlass(c: Caller, note?: string) {
  const s = c.session;
  if (!s || !isExec(s))
    throw fail(
      403,
      "forbidden_role",
      "Only the executive reviews break-glass use.",
    );
  await stepUp(c, s);
  return write(c, (w) => {
    sweepBreakGlass(w);
    if (w.breakGlass.state !== "ended" && w.breakGlass.state !== "expired")
      throw fail(409, "already_decided", "Nothing to review.");
    if ((note ?? "").trim().length < 10)
      throw invalidFields({ note: "too_short" });
    w.breakGlass.state = "reviewed";
    w.breakGlass.reviewNote = note!.trim();
    record(
      w,
      "access.break_glass.reviewed",
      "break_glass",
      w.breakGlass.request?.id ?? "bg",
      null,
      { note: note!.trim() },
    );
    return bgView(w);
  });
}
