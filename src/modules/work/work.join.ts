// Port of .ref work.join: /join public worker application, status lookup by email OTP, info-requested resubmit, and the
// SM review queue (/ops/workforce/applications). No account exists until approval; approval provisions the worker
// (WorkforceService.create → invite link) and, for firms, the firm record.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { agentProfiles, services, users } from "@/db/schema";
import { POLICY } from "@/domain/policy";
import { AppError, err, type Exec, type Session } from "../ops/lib/ctx";
import { recGet, recList, recPut, recSeq } from "../ops/lib/store";
import { contractTemplate, freshExt, iso, saveExt, saveFirm, saveRates, type Application, type FirmRec, type WCtx } from "./work.store";
import type { Draft } from "./work.dto";

/** Creates the ext:agent account + profile + invite (WorkforceService.create, its own tx); returns the user id. */
export type Provision = (db: Exec, s: Session, b: { firstName: string; lastName: string; email: string; phone: string }) => Promise<string>;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export type JoinRec = {
  app: Application;
  email: string;
  draft: Partial<Draft>;
  ops: string[];
  userId?: string;
};
type Decision = "approve" | "reject" | "request_info" | "expire_invite";
const OPEN = ["received", "under_review", "info_requested"];
const OTP_TTL_S = 600; // PLACEHOLDER(join-otp-ttl)
const OTP_TRIES = 5;
export const COOKIE = "hebuza_join";
export const COOKIE_TTL_S = 30 * 60;

export async function publicServices(db: Exec) {
  return {
    items: await db
      .select({ slug: services.slug, name: services.name })
      .from(services)
      .where(eq(services.status, "published"))
      .orderBy(asc(services.name)),
  };
}

async function nextRef(db: Exec) {
  const y = new Date().getFullYear();
  const id = `work_join_seq:${y}`;
  const n = await recSeq(db, "work_seq", id);
  return `${POLICY.applicationRefPrefix}-${y}-${String(n).padStart(4, "0")}`; // PLACEHOLDER(application-ref-format)
}
const load = async (db: Exec, ref: string, lock = false) =>
  (await recGet<JoinRec>(db, "work_app", ref.trim().toUpperCase(), lock))
    ?.data ?? null;
const save = (db: Exec, r: JoinRec) =>
  recPut(db, "work_app", {
    id: r.app.ref,
    ownerId: r.email,
    state: r.app.status,
    data: r,
  });
const view = (r: JoinRec) => ({
  ...r.app,
  email: r.email,
  draft:
    r.app.status === "info_requested"
      ? Object.fromEntries(
          (r.app.flaggedFields ?? []).map((k) => [
            k,
            r.draft[k as keyof Draft] ?? "",
          ]),
        )
      : {},
});

export async function submit(
  ctx: WCtx,
  b: { draft: Draft; client_op_id: string },
) {
  const d = b.draft;
  const email = d.email.trim().toLowerCase();
  // Serialises submits per email so the replay/duplicate checks below can't race.
  await ctx.db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"work_app:" + email}))`,
  );
  const same = await recList<JoinRec>(ctx.db, "work_app", { ownerId: email });
  const replay = same.find((r) => r.data.ops.includes(b.client_op_id));
  if (replay) return { ref: replay.data.app.ref }; // idempotent double submit
  const [acct] = await ctx.db
    .select({ id: users.userId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (acct) throw new AppError(409, "already_user", "Account exists");
  const dup = same.find(
    (r) =>
      r.data.app.status !== "rejected" &&
      r.data.app.status !== "invite_expired",
  );
  if (dup) throw new AppError(409, "already_applied", dup.data.app.ref);
  if (!d.consentPrivacy || !d.consentAccuracy || !d.services.length)
    throw new AppError(422, "validation", "Invalid");
  const ref = await nextRef(ctx.db);
  const name = d.kind === "firm" ? d.firmName : d.name;
  await save(ctx.db, {
    app: { ref, status: "received", kind: d.kind, name, submittedAt: iso() },
    email,
    draft: d,
    ops: [b.client_op_id],
  });
  ctx.audit = { resourceId: ref, details: { kind: d.kind } };
  return { ref };
}

const otpKey = (ref: string, email: string) =>
  `work:join:otp:${ref}:${hashToken(email)}`;
export async function sendOtp(ctx: WCtx, ref: string, email: string) {
  const R = ref.trim().toUpperCase();
  const e = email.trim().toLowerCase();
  const redis = ctx.k.redis;
  const r = await load(ctx.db, R);
  // Never reveal whether the ref exists: same answer either way, code only goes to a matching record.
  if (r && r.email === e) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await redis.setex(
      otpKey(R, e),
      OTP_TTL_S,
      JSON.stringify({ code, tries: OTP_TRIES }),
    );
    await ctx.k.mail(ctx.db, {
      to: e,
      subject: `Your HEBUZA application code`,
      text: `Your code for application ${R} is ${code}. It expires in ${OTP_TTL_S / 60} minutes.`,
    });
  }
  return { sent: true as const };
}
export async function verify(
  ctx: WCtx,
  ref: string,
  b: { email: string; code: string },
) {
  const R = ref.trim().toUpperCase();
  const e = b.email.trim().toLowerCase();
  const redis = ctx.k.redis;
  const raw = await redis.get(otpKey(R, e));
  const c = raw ? (JSON.parse(raw) as { code: string; tries: number }) : null;
  if (!c || c.code !== b.code) {
    if (c) {
      c.tries -= 1;
      if (c.tries <= 0) await redis.del(otpKey(R, e));
      else
        await redis.setex(
          otpKey(R, e),
          Math.max(await redis.ttl(otpKey(R, e)), 1),
          JSON.stringify(c),
        );
    }
    throw new AppError(422, "invalid_code", "Wrong code");
  }
  await redis.del(otpKey(R, e));
  const r = await load(ctx.db, R);
  if (!r || r.email !== e) throw err.notFound("Not found");
  const token = randomBytes(24).toString("base64url");
  await redis.setex(
    `work:join:sess:${hashToken(token)}`,
    COOKIE_TTL_S,
    `${R}|${e}`,
  );
  return { view: view(r), token };
}
/** The OTP-verified cookie must match ref + email (the body alone never authorises an edit). */
export async function verified(ctx: WCtx, ref: string, email: string) {
  const tok = ctx.req.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  const v = tok
    ? await ctx.k.redis.get(`work:join:sess:${hashToken(decodeURIComponent(tok))}`)
    : null;
  if (v !== `${ref.trim().toUpperCase()}|${email.trim().toLowerCase()}`)
    throw err.notFound("Not found");
}
export async function resubmit(
  ctx: WCtx,
  ref: string,
  b: { email: string; patch: Partial<Draft> },
) {
  await verified(ctx, ref, b.email);
  const r = await load(ctx.db, ref, true);
  if (!r || r.email !== b.email.trim().toLowerCase())
    throw err.notFound("Not found");
  if (r.app.status !== "info_requested")
    throw new AppError(409, "locked", "Not editable");
  const allowed = new Set(r.app.flaggedFields ?? []);
  for (const [k, v] of Object.entries(b.patch))
    if (allowed.has(k)) (r.draft as Record<string, unknown>)[k] = v;
  r.app = {
    ...r.app,
    status: "under_review",
    flaggedFields: [],
    decisionNote: undefined,
  };
  await save(ctx.db, r);
  ctx.audit = { resourceId: r.app.ref };
  return view(r);
}

// ── ops review ────────────────────────────────────────────────────────────────────────────────────────
export async function list(db: Exec) {
  const rows = await recList<JoinRec>(db, "work_app", {}, 1000);
  return {
    items: rows
      .map((r) => ({ ...r.data.app, email: r.data.email }))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
  };
}
export async function get(db: Exec, ref: string) {
  const r = await load(db, ref);
  if (!r) throw err.notFound("Not found");
  return { ...r.app, email: r.email, draft: r.draft };
}
export async function decide(
  ctx: WCtx,
  ref: string,
  b: { decision: Decision; note?: string; fields?: string[] },
  provision: Provision,
) {
  const r = await load(ctx.db, ref, true);
  if (!r) throw err.notFound("Not found");
  if (!OPEN.includes(r.app.status))
    throw new AppError(409, "conflict", "Already decided");
  if (
    b.decision !== "approve" &&
    b.decision !== "expire_invite" &&
    !b.note?.trim()
  )
    throw new AppError(422, "reason_required", "Reason required");
  if (b.decision === "request_info" && !b.fields?.length)
    throw new AppError(422, "validation", "Pick fields");
  const status = (
    {
      approve: "approved",
      reject: "rejected",
      request_info: "info_requested",
      expire_invite: "invite_expired",
    } as const
  )[b.decision];
  r.app = {
    ...r.app,
    status,
    flaggedFields:
      status === "info_requested"
        ? b.fields?.length
          ? b.fields
          : ["regNumber", "expertise"]
        : [],
    decisionNote:
      b.note?.trim() ||
      (status === "rejected"
        ? "We don't have enough work in your services right now."
        : status === "info_requested"
          ? "Please confirm your registration number and describe your experience."
          : undefined),
  };
  if (status === "approved" && !r.userId)
    r.userId = await onboard(ctx, r, provision);
  await save(ctx.db, r);
  await ctx.k.mail(ctx.db, {
    to: r.email,
    subject: `Your HEBUZA application ${r.app.ref}`,
    text: `There's an update on your application ${r.app.ref}: ${status.replace("_", " ")}.\n${r.app.decisionNote ?? ""}\nCheck it here: ${ctx.k.origin}/join/status?ref=${r.app.ref}`,
  });
  ctx.audit = {
    resourceId: r.app.ref,
    details: { decision: b.decision, reason: b.note?.trim() },
  };
  return { ...r.app, email: r.email, draft: r.draft };
}
/** Approval: account + profile + invite (workforce.provision), external workspace, firm and starting rate card. */
async function onboard(ctx: WCtx, r: JoinRec, provision: Provision) {
  const d = r.draft;
  const name = (d.name || r.app.name).trim();
  const [first, ...rest] = name.split(/\s+/);
  const p = {
    id: await provision(ctx.db, ctx.session, {
      firstName: first ?? r.app.name,
      lastName: rest.join(" ") || "-",
      email: r.email,
      phone: d.phone ? `+250${d.phone.replace(/\D/g, "").slice(-9)}` : "",
    }),
    name,
  };
  await ctx.db
    .update(agentProfiles)
    .set({
      services: d.services ?? [],
      cap: Number(d.maxJobs) || 3,
      title: d.kind === "firm" ? "Firm admin" : "External agent",
      updatedAt: iso(),
    })
    .where(eq(agentProfiles.userId, p.id));
  const e = freshExt();
  e.onboarding.services = {
    slugs: d.services ?? [],
    maxJobs: Number(d.maxJobs) || 3,
    days: [...new Set((d.grid ?? []).map((g) => g.split("-")[0]))],
  };
  e.contract = (["nda", "sla", "service_agreement"] as const).map((k) =>
    contractTemplate(k, d.start || undefined),
  );
  const names = new Map(
    (await publicServices(ctx.db)).items.map((s) => [s.slug, s.name]),
  );
  const rows = (d.services ?? []).flatMap((slug) => {
    const rate = d.rates?.[slug];
    const v = Number(rate?.value);
    if (!rate || !Number.isInteger(v) || v <= 0 || rate.mode === "hourly")
      return [];
    return [
      {
        serviceId: slug,
        serviceName: names.get(slug) ?? slug,
        ...(rate.mode === "pct" ? { bps: v * 100 } : { flat: v }),
        from: (d.start || iso()).slice(0, 10),
        status: "approved" as const,
      },
    ];
  });
  if (d.kind === "firm") {
    const firmId = `firm_${p.id.slice(4, 20)}`;
    const f: FirmRec = {
      name: d.firmName || r.app.name,
      account: "",
      adminId: p.id,
      members: [
        {
          id: p.id,
          name: p.name,
          email: r.email,
          role: "admin",
          services: d.services ?? [],
        },
      ],
      removals: {},
    };
    await saveFirm(ctx.db, firmId, f);
    e.firmId = firmId;
    e.firmRole = "admin";
    await saveRates(ctx.db, firmId, rows);
  } else await saveRates(ctx.db, p.id, rows);
  await saveExt(ctx.db, p.id, e);
  return p.id;
}
