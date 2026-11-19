// Port of .ref work.service: external-agent workspace (/work): onboarding + KYC + credentials, contract/rates/licence/payout
// destination, statements/payouts/invoices, firm team, scoped job access. Plain functions over the request tx (WCtx from
// WorkRunner); every write takes the worker's row lock first. No case status changes happen here (those go through
// ApplicationsService.transition in the agent/ops modules).
import { settings as finSettings } from "../finance/finance.store";
import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentProfiles, applicationDocuments, applicationMessages, applications, financeRecords, services, users } from "@/db/schema";
import { all as finAll } from "../finance/finance.store";
import type { Alloc } from "../finance/finance.revenue";
import { StorageService } from "../../core/storage/storage.service";
import { AppError, err, notify, type Exec, type Session } from "../ops/lib/ctx";
import { CLOSED, clientKey, clientsOf, loadCase, logEvent, recGet, recList, recPut, recSeq, saveCase, servicesBySlug, type CaseRow } from "../ops/lib/store";
import type { OfferData } from "../ops/ops.cases";
import {
  D,
  WORK,
  actor,
  adminOnly,
  dayIso,
  dec,
  enc,
  expectedEarning,
  hist,
  iso,
  loadExt,
  loadFirm,
  loadRates,
  maskEnd,
  monthOf,
  notSuspended,
  notYours,
  rateFor,
  rateLabel,
  rateOwner,
  saveExt,
  saveFirm,
  saveRates,
  signatureMatches,
  statementOf,
  tinOk,
  type AccessReq,
  type Actor,
  type ExtState,
  type External,
  type FirmRec,
  type JobScopeRec,
  type PayoutDest,
  type RateCardRow,
  type Slot,
  type Statement,
  type WCtx,
  type WorkInvoice,
} from "./work.store";

const log = new Logger("work");
/** The finance payout batch fields this module reads (finance module owns the record). */
type Batch = {
  no: string;
  period: string;
  lines: { id: string; workerId: string; status: string; method: string; destination: { masked: string }; providerRef?: string | null; net: number }[];
};
const OB_ITEMS = [
  "identity",
  "credentials",
  "agreements",
  "payout",
  "services",
  "review",
] as const;
type ObItem = (typeof OB_ITEMS)[number];
const SIGN_KINDS = ["nda", "sla", "service_agreement"];
const fileKey = (uid: string, area: string) => StorageService.key(uid, `work-${area}`);
/** Presigned PUT + delayed storage.scan (infected → quarantined), the same scan path as documents uploads. */
async function uploadUrl(ctx: WCtx, key: string, type: string, size: number) {
  try {
    const url = (await ctx.k.storage.presignPut({ key, contentType: type, size, purpose: "work" })).url;
    await ctx.k.scan(ctx.db, key);
    return url;
  } catch (e) {
    log.warn(`work_presign_failed ${String(e)}`);
    return null;
  }
}

async function managerOf(db: Exec, uid: string) {
  const [r] = await db
    .select({ id: users.userId, name: users.name })
    .from(agentProfiles)
    .innerJoin(users, eq(users.userId, agentProfiles.managerId))
    .where(eq(agentProfiles.userId, uid));
  return r ?? { id: null as string | null, name: "Service manager" };
}
async function catalogue(db: Exec) {
  return db
    .select({ slug: services.slug, name: services.name })
    .from(services)
    .where(eq(services.status, "published"))
    .orderBy(asc(services.name));
}

// ── summary.external ──────────────────────────────────────────────────────────────────────────────────
export function contractState(e: ExtState): External["contractState"] {
  if (e.notice) return "notice_given";
  const sa = e.contract.find((d) => d.kind === "service_agreement");
  if (sa?.status === "pending_signature" && !sa.signedAt)
    return "pending_signature";
  const end = sa?.end ?? null;
  if (!end) return "active";
  const days = Math.ceil((Date.parse(end) - Date.now()) / D);
  return days < 0
    ? "expired"
    : days <= WORK.expiringDays
      ? "expiring"
      : "active";
}
function obDone(e: ExtState): Record<ObItem, boolean> {
  const o = e.onboarding;
  return {
    identity:
      !!o.identity.idEnc &&
      Object.values(o.identity.slots).every((s) => s.status === "uploaded"),
    credentials: e.credentials.some(
      (c) => c.status !== "rejected" && c.status !== "expired",
    ),
    agreements: e.contract
      .filter((d) => SIGN_KINDS.includes(d.kind))
      .every((d) => !!d.signedAt),
    payout:
      !!o.payout.method && !!o.payout.accountEnc && !!o.payout.name.trim(),
    services: o.services.slugs.length > 0,
    review: !!o.submittedAt,
  };
}
/** summary.external (plan §9.1). Integrator: merged into /api/agent/x/summary for ext:agent sessions. */
export async function externalBlock(db: Exec, uid: string): Promise<External> {
  const e = await loadExt(db, uid);
  const firm = await loadFirm(db, e.firmId);
  const sa = e.contract.find((d) => d.kind === "service_agreement");
  const d = obDone(e);
  const pay = await payoutsOf(db, uid, e);
  const last = pay.items.find((p) => p.status === "paid");
  return {
    status: e.status,
    firmRole: e.firmRole,
    firm: firm?.name ?? null,
    contractEnd: sa?.end ?? null,
    contractState: contractState(e),
    licence:
      e.licence.find((l) => l.status === "due" || l.status === "overdue") ??
      e.licence.at(-1) ??
      null,
    services: e.services,
    lastPayout: last ? { amount: last.amount, at: last.date } : null,
    manager: (await managerOf(db, uid)).name,
    todo:
      e.status === "onboarding" || e.status === "changes_requested"
        ? OB_ITEMS.filter((k) => !d[k])
        : [],
  };
}

/** Offer-accept guard for externals (B16). Integrator: call from agent.acceptOffer before accepting. */
export async function assertCanAccept(
  db: Exec,
  uid: string,
  serviceSlug: string,
) {
  const e = await loadExt(db, uid);
  if (e.status !== "cleared") return; // agent gate() answers not_cleared
  if (contractState(e) === "expired")
    throw new AppError(409, "contract_expired", "Contract expired");
  const s = e.services.find((x) => x.slug === serviceSlug);
  if (s && s.state !== "cleared")
    throw new AppError(409, "service_not_cleared", "Not cleared for this service");
}

// ── onboarding (lane B) ───────────────────────────────────────────────────────────────────────────────
async function obView(c: WCtx, a: Actor) {
  const db = c.db;
  const e = a.e;
  const o = e.onboarding;
  const d = obDone(e);
  const state = (k: ObItem) =>
    o.changes?.items.includes(k)
      ? "rejected"
      : e.status === "cleared"
        ? "verified"
        : e.status === "pending_verification" && (d[k] || k === "review")
          ? "submitted"
          : d[k]
            ? "done"
            : k === "identity" &&
                (o.identity.idEnc ||
                  Object.values(o.identity.slots).some(
                    (s) => s.status !== "empty",
                  ))
              ? "in_progress"
              : "todo";
  const strip = <T extends { key?: string }>(x: T) => {
    const { key: _k, ...rest } = x;
    return rest;
  };
  return {
    status: e.status,
    signer: a.name,
    manager: (await managerOf(db, a.uid)).name,
    items: OB_ITEMS.map((k) => ({
      key: k,
      state: state(k),
      note: o.changes?.items.includes(k) ? o.changes.note : undefined,
    })),
    identity: {
      idType: o.identity.idType,
      idNumberMasked: maskEnd(dec(c.k, o.identity.idEnc)),
      slots: Object.fromEntries(
        Object.entries(o.identity.slots).map(([k, v]) => [k, strip(v)]),
      ),
    },
    payout: {
      method: o.payout.method,
      bank: o.payout.bank,
      account: maskEnd(dec(c.k, o.payout.accountEnc)),
      name: o.payout.name,
      tin: maskEnd(dec(c.k, o.payout.tinEnc)),
    },
    services: o.services,
    catalogue: await catalogue(db),
    docs: e.contract.filter((x) => SIGN_KINDS.includes(x.kind)),
    credentials: e.credentials.map(strip),
    savedAt: o.savedAt,
    submittedAt: o.submittedAt,
    changes: o.changes,
  };
}
export async function onboarding(c: WCtx) {
  return obView(c, await actor(c.db, c.session));
}
const obLocked = (a: Actor) => {
  if (a.e.status === "pending_verification")
    throw new AppError(409, "locked", "Submitted for verification");
};
export async function saveOnboarding(
  ctx: WCtx,
  b: {
    step: "identity" | "payout" | "services";
    data: Record<string, unknown>;
  },
) {
  const a = await actor(ctx.db, ctx.session, true);
  obLocked(a);
  const o = a.e.onboarding;
  if (b.step === "identity") {
    const v = b.data as {
      idType?: "national_id" | "passport";
      idNumber?: string;
    };
    if (v.idType) o.identity.idType = v.idType;
    if (v.idNumber !== undefined && !v.idNumber.startsWith("••••")) {
      const n = v.idNumber.replace(/\s/g, "");
      if (o.identity.idType === "national_id" && n && !/^\d{16}$/.test(n))
        throw new AppError(422, "validation", "National ID has 16 digits");
      if (n.length > 32) throw new AppError(422, "validation", "ID number too long");
      o.identity.idEnc = enc(ctx.k, n);
    }
  }
  if (b.step === "payout") {
    const v = b.data as {
      method?: "momo" | "airtel" | "bank" | null;
      bank?: string;
      account?: string;
      name?: string;
      tin?: string;
    };
    const keep = (nv: string | undefined) =>
      nv === undefined || nv.startsWith("••••");
    if (v.tin && !keep(v.tin) && !tinOk(v.tin))
      throw new AppError(422, "validation", "TIN format");
    if (v.method !== undefined) o.payout.method = v.method;
    if (v.bank !== undefined) o.payout.bank = v.bank.slice(0, 120);
    if (v.name !== undefined) o.payout.name = v.name.slice(0, 120);
    if (!keep(v.account))
      o.payout.accountEnc = enc(ctx.k, v.account!.replace(/\s/g, "").slice(0, 34));
    if (!keep(v.tin)) o.payout.tinEnc = enc(ctx.k, v.tin!);
  }
  if (b.step === "services") {
    const v = b.data as { slugs?: string[]; maxJobs?: number; days?: string[] };
    if (
      v.maxJobs !== undefined &&
      (!Number.isInteger(v.maxJobs) || v.maxJobs < 1 || v.maxJobs > WORK.capMax)
    )
      throw new AppError(422, "validation", "Max jobs out of range");
    if (v.slugs) {
      const known = new Set((await catalogue(ctx.db)).map((x) => x.slug));
      o.services.slugs = [...new Set(v.slugs.filter((x) => known.has(x)))];
    }
    if (v.maxJobs !== undefined) o.services.maxJobs = v.maxJobs;
    if (v.days)
      o.services.days = v.days.filter((x) =>
        ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(x),
      );
  }
  o.savedAt = iso();
  await saveExt(ctx.db, a.uid, a.e);
  return obView(ctx, a);
}
export async function kycUpload(
  ctx: WCtx,
  b: { slot: Slot; fileName: string; size: number; type: string },
) {
  const a = await actor(ctx.db, ctx.session, true);
  obLocked(a);
  if (b.size > WORK.kycMaxMb * 1024 * 1024)
    throw new AppError(413, "too_large", `Max ${WORK.kycMaxMb} MB`);
  if (!/^image\/|^application\/pdf$/.test(b.type))
    throw new AppError(415, "unsupported_type", "Image or PDF only");
  const key = fileKey(a.uid, "kyc");
  a.e.onboarding.identity.slots[b.slot] = {
    status: "uploaded",
    fileName: b.fileName,
    key,
  };
  a.e.onboarding.savedAt = iso();
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = { resourceId: a.uid, details: { slot: b.slot } };
  return {
    ...(await obView(ctx, a)),
    upload: { url: await uploadUrl(ctx, key, b.type, b.size), key },
  };
}
export async function signOnboarding(
  ctx: WCtx,
  docId: string,
  b: { typedName: string; readPct: number; agree: boolean },
) {
  const a = await actor(ctx.db, ctx.session, true);
  await signDoc(ctx, a, docId, b);
  return obView(ctx, a);
}
export async function submitOnboarding(ctx: WCtx) {
  const a = await actor(ctx.db, ctx.session, true);
  if (a.e.status === "pending_verification")
    throw new AppError(409, "locked", "Already submitted");
  if (a.e.status === "cleared") throw new AppError(409, "locked", "Already cleared");
  const d = obDone(a.e);
  if (!OB_ITEMS.filter((k) => k !== "review").every((k) => d[k]))
    throw new AppError(422, "validation", "Complete every item first");
  a.e.onboarding.submittedAt = iso();
  a.e.onboarding.changes = null;
  a.e.status = "pending_verification";
  await saveExt(ctx.db, a.uid, a.e);
  const m = await managerOf(ctx.db, a.uid);
  if (m.id)
    await notify(ctx.db, {
      userId: m.id,
      kind: "workforce",
      title: `${a.name} submitted onboarding for verification`,
      href: `/ops/workforce/${a.uid}`,
    });
  ctx.audit = { resourceId: a.uid };
  return obView(ctx, a);
}
/** SM decision on a submitted onboarding (ops; also the dev "Simulate decision"). */
export async function decideOnboarding(
  ctx: WCtx,
  uid: string,
  b: { decision: "approve" | "changes"; items?: string[]; note?: string },
) {
  const e = await loadExt(ctx.db, uid, true);
  const o = e.onboarding;
  if (b.decision === "changes") {
    const items = (b.items?.length ? b.items : ["identity"]).filter((k) =>
      (OB_ITEMS as readonly string[]).includes(k),
    );
    e.status = "changes_requested";
    o.changes = {
      items,
      note: b.note?.trim() || "Please review the flagged items and resubmit.",
    };
    o.submittedAt = null;
    if (items.includes("identity"))
      o.identity.slots.id_front = {
        ...o.identity.slots.id_front,
        status: "rejected",
        note: o.changes.note,
      };
  } else {
    e.status = "cleared";
    o.changes = null;
    for (const c of e.credentials)
      if (c.status === "pending") c.status = "verified";
    const names = new Map(
      (await catalogue(ctx.db)).map((x) => [x.slug, x.name]),
    );
    for (const slug of o.services.slugs)
      if (!e.services.some((s) => s.slug === slug))
        e.services.push({
          slug,
          name: names.get(slug) ?? slug,
          state: "pending",
        });
    const covered = new Set(
      e.credentials
        .filter((c) => c.status === "verified")
        .flatMap((c) => c.services),
    );
    for (const s of e.services)
      if (o.services.slugs.includes(s.slug) || covered.has(s.slug))
        Object.assign(s, { state: "cleared", reason: undefined });
    const acct = dec(ctx.k, o.payout.accountEnc);
    if (o.payout.method && acct)
      e.payoutDest = {
        method: o.payout.method,
        label: {
          momo: "MTN MoMo",
          airtel: "Airtel Money",
          bank: "Bank transfer",
        }[o.payout.method],
        last4: acct.slice(-4),
        status: "verified",
        coolingUntil: null,
      };
    await ctx.db
      .update(agentProfiles)
      .set({
        services: o.services.slugs,
        cap: o.services.maxJobs,
        updatedAt: iso(),
      })
      .where(eq(agentProfiles.userId, uid));
  }
  await saveExt(ctx.db, uid, e);
  await notify(ctx.db, {
    userId: uid,
    kind: "workforce",
    title:
      b.decision === "approve"
        ? "You're cleared — offers can now reach you"
        : "Changes requested on your onboarding",
    href: "/work/onboarding",
  });
  ctx.audit = { resourceId: uid, details: { decision: b.decision } };
}

// ── credentials ───────────────────────────────────────────────────────────────────────────────────────
const credsOut = (e: ExtState) => ({
  items: e.credentials.map(({ key: _k, ...c }) => c),
});
export async function credentials(db: Exec, s: Session) {
  return credsOut((await actor(db, s)).e);
}
export async function addCredential(
  ctx: WCtx,
  b: {
    kind?: "degree" | "certificate" | "license" | "professional_body";
    title?: string;
    issuer?: string;
    number?: string;
    issuedOn?: string;
    expiresOn?: string;
    fileName?: string;
    size?: number;
    type?: string;
    services?: string[];
  },
) {
  const a = await actor(ctx.db, ctx.session, true);
  if (!b.expiresOn) throw new AppError(422, "validation", "Expiry date required");
  if (!b.title?.trim() || !b.issuer?.trim() || !b.number?.trim() || !b.fileName)
    throw new AppError(422, "validation", "Missing fields");
  if ((b.size ?? 0) > WORK.qualificationMaxMb * 1024 * 1024)
    throw new AppError(413, "too_large", "Too large");
  const key = fileKey(a.uid, "credentials");
  const id = `cr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  a.e.credentials.unshift({
    id,
    kind: b.kind ?? "certificate",
    title: b.title.trim(),
    issuer: b.issuer.trim(),
    number: maskEnd(b.number.trim()),
    issuedOn: b.issuedOn ?? "",
    expiresOn: b.expiresOn,
    status: "pending",
    fileName: b.fileName,
    services: b.services ?? [],
    key,
  });
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = { resourceId: id };
  return {
    ...credsOut(a.e),
    upload: { url: await uploadUrl(ctx, key, b.type!, b.size!), key },
  };
}
export async function replaceCredential(
  ctx: WCtx,
  id: string,
  b: {
    expiresOn?: string;
    issuedOn?: string;
    fileName?: string;
    size?: number;
    type?: string;
  },
) {
  const a = await actor(ctx.db, ctx.session, true);
  const c = a.e.credentials.find((x) => x.id === id);
  if (!c) throw notYours();
  if (!b.expiresOn || !b.fileName)
    throw new AppError(422, "validation", "Expiry date and file required");
  if ((b.size ?? 0) > WORK.qualificationMaxMb * 1024 * 1024)
    throw new AppError(413, "too_large", "Too large");
  const key = fileKey(a.uid, "credentials");
  Object.assign(c, {
    expiresOn: b.expiresOn,
    issuedOn: b.issuedOn ?? c.issuedOn,
    fileName: b.fileName,
    status: "pending",
    note: undefined,
    key,
  });
  for (const s of a.e.services)
    if (c.services.includes(s.slug) && s.state === "not_cleared")
      Object.assign(s, { state: "pending", reason: undefined });
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = { resourceId: id };
  return {
    ...credsOut(a.e),
    upload: { url: await uploadUrl(ctx, key, b.type!, b.size!), key },
  };
}

// ── contract, rates, licence, payout destination (lane F) ─────────────────────────────────────────────
async function signDoc(
  ctx: WCtx,
  a: Actor,
  docId: string,
  b: { typedName: string; readPct: number; agree: boolean },
) {
  const d = a.e.contract.find((x) => x.id === docId);
  if (!d) throw notYours();
  if (d.status !== "pending_signature")
    throw new AppError(409, "already_signed", "Already signed");
  if (b.readPct < 100 || !b.agree)
    throw new AppError(422, "validation", "Read and agree first");
  if (!signatureMatches(b.typedName, a.name))
    throw new AppError(422, "name_mismatch", "Name mismatch");
  const at = iso();
  const sha256 = createHash("sha256")
    .update(
      JSON.stringify({
        id: d.id,
        version: d.version,
        terms: d.terms,
        signer: a.uid,
        typedName: b.typedName.trim(),
        at,
      }),
    )
    .digest("hex");
  Object.assign(d, {
    status: "active",
    signedAt: at,
    evidence: { ip: ctx.ip ?? "", sha256, typedName: b.typedName.trim() },
  });
  hist(a.e, "signed", `${d.title} v${d.version} signed`, a.name);
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = { resourceId: d.id, details: { sha256, version: d.version } };
  return d;
}
async function contractView(db: Exec, a: Actor) {
  const e = a.e;
  const all = await loadRates(db, rateOwner(a.uid, e));
  const rates = all.filter(
    (r) =>
      e.firmRole !== "member" || e.services.some((s) => s.slug === r.serviceId),
  );
  let payout = e.payoutDest;
  if (!payout && e.firmRole === "member") {
    const firm = await loadFirm(db, e.firmId);
    payout = {
      method: "bank",
      label: "Paid to firm account",
      last4: (firm?.account ?? "").slice(-4),
      status: "verified",
      coolingUntil: null,
    };
  }
  if (
    payout?.coolingUntil &&
    Date.parse(payout.coolingUntil) < Date.now() &&
    payout.status === "pending_verification"
  )
    payout = { ...payout };
  return {
    contract: e.contract,
    rates,
    licence: e.licence,
    revenue: {
      bps: WORK.defaultBps,
      licenceMonthly: WORK.licenceMonthly,
      whtBps: WORK.whtBps,
    },
    history: e.history,
    notice: e.notice,
    payout: payout ?? {
      method: "momo",
      label: "Not set",
      last4: "",
      status: "failed",
      coolingUntil: null,
    },
    firmRole: e.firmRole,
  };
}
export async function contract(db: Exec, s: Session) {
  return contractView(db, await actor(db, s));
}
export async function signContract(
  ctx: WCtx,
  docId: string,
  b: { typedName: string; readPct: number; agree: boolean },
) {
  return signDoc(ctx, await actor(ctx.db, ctx.session, true), docId, b);
}
export async function renew(ctx: WCtx) {
  const a = await actor(ctx.db, ctx.session, true);
  adminOnly(a);
  notSuspended(a);
  const d = a.e.contract.find((x) => x.kind === "service_agreement");
  if (!d?.end) throw new AppError(409, "not_renewable", "No end date");
  if ((Date.parse(d.end) - Date.now()) / D > WORK.renewWindowDays)
    throw new AppError(409, "not_renewable", "Too early");
  d.end = dayIso(
    Math.max(Date.parse(d.end), Date.now()) + WORK.renewalDays * D,
  );
  d.status = "active";
  hist(a.e, "renewed", `Service agreement renewed until ${d.end}`, a.name);
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = { resourceId: d.id, details: { end: d.end } };
  return { end: d.end };
}
export async function giveNotice(ctx: WCtx, reason: string) {
  const a = await actor(ctx.db, ctx.session, true);
  adminOnly(a);
  notSuspended(a);
  if (a.e.notice) throw new AppError(409, "notice_exists", "Notice exists");
  if (!reason?.trim()) throw new AppError(422, "reason_required", "Reason required");
  const lastDay = dayIso(Date.now() + WORK.noticeDays * D);
  a.e.notice = { at: iso(), lastDay, reason: reason.trim() };
  hist(a.e, "notice", `Notice given — last day ${lastDay}`, a.name);
  await saveExt(ctx.db, a.uid, a.e);
  const m = await managerOf(ctx.db, a.uid);
  if (m.id)
    await notify(ctx.db, {
      userId: m.id,
      kind: "workforce",
      title: `${a.name} gave notice (last day ${lastDay})`,
      href: `/ops/workforce/${a.uid}`,
    });
  ctx.audit = {
    resourceId: a.uid,
    details: { reason: reason.trim(), lastDay },
  };
  return a.e.notice;
}
export async function requestRate(
  ctx: WCtx,
  b: { serviceId: string; bps?: number; flat?: number; reason: string },
) {
  const a = await actor(ctx.db, ctx.session, true);
  adminOnly(a);
  notSuspended(a);
  if ((b.bps === undefined) === (b.flat === undefined))
    throw new AppError(422, "validation", "Exactly one of % or flat");
  const v = (b.bps ?? b.flat)!;
  if (!Number.isInteger(v) || v <= 0 || (b.bps !== undefined && b.bps > 10_000))
    throw new AppError(422, "validation", "Invalid rate");
  if (!b.reason?.trim()) throw new AppError(422, "reason_required", "Reason required");
  const owner = rateOwner(a.uid, a.e);
  const rows = await loadRates(ctx.db, owner, true);
  const cur = rows.find(
    (r) => r.serviceId === b.serviceId && r.status === "approved",
  );
  if (!cur) throw err.notFound("Unknown service");
  if (rows.some((r) => r.serviceId === b.serviceId && r.status === "proposed"))
    throw new AppError(409, "conflict", "Already proposed");
  const row: RateCardRow = {
    serviceId: b.serviceId,
    serviceName: cur.serviceName,
    bps: b.bps,
    flat: b.flat,
    from: dayIso(Date.now() + WORK.ratePropDelayDays * D),
    status: "proposed",
    reason: b.reason.trim(),
  };
  await saveRates(ctx.db, owner, [...rows, row]);
  hist(
    a.e,
    "rate",
    `Proposed ${cur.serviceName}: ${b.flat !== undefined ? `flat RWF ${b.flat}` : `${b.bps! / 100}%`}`,
    a.name,
  );
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = { resourceId: b.serviceId, details: { ...row } };
  return row;
}
/** Finance/SM decision on a proposed rate (ops; also the dev simulate). */
export async function decideRate(
  ctx: WCtx,
  owner: string,
  serviceId: string,
  approve: boolean,
  by: string,
) {
  const rows = await loadRates(ctx.db, owner, true);
  const p = rows.find(
    (r) => r.serviceId === serviceId && r.status === "proposed",
  );
  if (!p) throw err.notFound("No proposal");
  const next = approve
    ? rows.filter(
        (r) => !(r.serviceId === serviceId && r.status === "approved"),
      )
    : rows;
  p.status = approve ? "approved" : "rejected";
  await saveRates(ctx.db, owner, next);
  const holders = await recList<ExtState>(ctx.db, "work_ext", {}, 5000);
  for (const h of holders.filter(
    (x) => x.ownerId === owner || x.data.firmId === owner,
  )) {
    hist(
      h.data,
      "rate",
      `${p.serviceName} rate ${approve ? "approved by Finance" : "change declined"}`,
      by,
    );
    await saveExt(ctx.db, h.ownerId!, { ...h.data });
  }
  ctx.audit = { resourceId: serviceId, details: { approve } };
  return p;
}
export async function licence(
  ctx: WCtx,
  number: string,
  how: "pay" | "net",
  phone?: string,
) {
  const a = await actor(ctx.db, ctx.session, true);
  adminOnly(a);
  notSuspended(a);
  const inv = a.e.licence.find((l) => l.number === number);
  if (!inv) throw notYours();
  if (!["due", "overdue"].includes(inv.status))
    throw new AppError(409, "already_paid", "Already settled");
  if (how === "pay") {
    if (!/^\+?250\s?7\d(\s?\d){7}$/.test(phone?.trim() ?? ""))
      throw new AppError(422, "validation", "Phone");
    // shortcut: no MoMo collection for licence fees yet — dev settles at once, production asks to net instead;
    // upgrade to payments.initiatePayment(collection) + webhook settle when licence collection is approved.
    if (ctx.k.prod)
      throw new AppError(503, "unavailable",
        "MoMo payment of the licence fee isn't available yet. Choose “Net from payout”.",
      );
    inv.status = "paid";
  } else inv.status = "netted";
  hist(
    a.e,
    "licence",
    `${inv.number} ${inv.status === "paid" ? "paid by MoMo" : "netted from next payout"}`,
    a.name,
  );
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = { resourceId: inv.number, details: { status: inv.status } };
  return inv;
}
export async function setPayoutDestination(
  ctx: WCtx,
  b: {
    method: PayoutDest["method"];
    account: string;
    name: string;
    otp: string;
  },
) {
  const a = await actor(ctx.db, ctx.session, true);
  adminOnly(a);
  notSuspended(a);
  // shortcut: the route's session step-up is the strong factor; the 6-digit code is format-checked only until an
  // SMS provider (PLACEHOLDER(sms-provider)) can deliver a destination-change OTP.
  if (!/^\d{6}$/.test(b.otp) || b.otp === "000000")
    throw new AppError(422, "invalid_code", "Wrong code");
  const digits = b.account.replace(/\D/g, "");
  if (digits.length < 8 || !b.name.trim())
    throw new AppError(422, "validation", "Account");
  const p: PayoutDest = {
    method: b.method,
    label: { momo: "MTN MoMo", airtel: "Airtel Money", bank: "Bank transfer" }[
      b.method
    ],
    last4: digits.slice(-4),
    status: "pending_verification",
    coolingUntil: iso(Date.now() + WORK.coolingMs),
  };
  a.e.payoutDest = p;
  a.e.onboarding.payout = {
    ...a.e.onboarding.payout,
    method: b.method,
    accountEnc: enc(ctx.k, digits),
    name: b.name.trim(),
  };
  hist(
    a.e,
    "payout",
    `Payout destination change requested (${p.label} •••• ${p.last4})`,
    a.name,
  );
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = {
    resourceId: a.uid,
    details: { method: p.method, last4: p.last4 },
  };
  return p;
}
export async function decideDestination(
  ctx: WCtx,
  uid: string,
  verify: boolean,
) {
  const e = await loadExt(ctx.db, uid, true);
  if (!e.payoutDest) throw err.notFound("No destination");
  e.payoutDest.status = verify ? "verified" : "failed";
  if (verify) e.payoutDest.coolingUntil = null;
  await saveExt(ctx.db, uid, e);
  ctx.audit = { resourceId: uid, details: { verify } };
  return e.payoutDest;
}
export async function contractPdfData(db: Exec, s: Session, docId: string) {
  const a = await actor(db, s);
  const d = a.e.contract.find((x) => x.id === docId);
  if (!d) throw notYours();
  return { a, d };
}
export async function licencePdfData(db: Exec, s: Session, number: string) {
  const a = await actor(db, s);
  const l = a.e.licence.find((x) => x.number === number);
  if (!l) throw notYours();
  return { a, l };
}

// ── statements, payouts, invoices (lane E) ────────────────────────────────────────────────────────────
/** F-REV-11: the worker's shares of finance allocations (voided ones dropped), one row per worker × allocation. */
async function splitsOf(db: Exec, ids: string[]) {
  if (!ids.length) return [];
  const want = new Set(ids);
  const allocs = await finAll<Alloc>(db, "allocation");
  return allocs
    .filter((a) => a.status !== "voided")
    .flatMap((a) =>
      a.shares
        .filter((sh) => want.has(sh.workerId))
        .map((sh) => ({
          workerId: sh.workerId,
          applicationCode: a.caseRef.startsWith("PLAN:") ? null : a.caseRef,
          frozenAt: a.frozenAt,
          baseAmountRwf: a.eligible,
          workerAmountRwf: sh.amount,
        })),
    )
    .sort((x, y) => x.frozenAt.localeCompare(y.frozenAt));
}
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 3);
export async function statementsOf(
  db: Exec,
  uid: string,
  name: string,
  e: ExtState,
): Promise<Statement[]> {
  const rows = await splitsOf(db, [uid]);
  const apps = rows.length
    ? await db
        .select({
          code: applications.code,
          slug: applications.serviceSlug,
          name: applications.serviceName,
        })
        .from(applications)
        .where(
          inArray(
            applications.code,
            rows.map((r) => r.applicationCode).filter((x): x is string => !!x),
          ),
        )
    : [];
  const appBy = new Map(apps.map((x) => [x.code, x]));
  const rates = await loadRates(db, rateOwner(uid, e));
  const months = [
    ...new Set([
      ...rows.map((r) => monthOf(r.frozenAt)),
      ...e.licence.map((l) => l.period),
    ]),
  ].sort();
  let carry = 0;
  return months.map((m) => {
    const mine = rows.filter((r) => monthOf(r.frozenAt) === m);
    const gross = mine.reduce((t, r) => t + r.workerAmountRwf, 0);
    const lic = e.licence.find((l) => l.period === m);
    const licenceAmt =
      e.firmRole === "member"
        ? 0
        : lic && ["due", "overdue", "netted"].includes(lic.status)
          ? lic.amount
          : 0;
    // shortcut: refund clawbacks (finance adjustments) aren't read yet — adjustments 0; upgrade with finance allocations.
    const st = statementOf({
      gross,
      adjustments: 0,
      licence: licenceAmt,
      carriedIn: -carry,
    });
    carry = st.carry;
    return {
      month: m,
      number: `ST-${m}-${initials(name)}`, // PLACEHOLDER(statement-ref-format)
      gross,
      adjustments: 0,
      licence: st.licence,
      taxable: st.taxable,
      wht: st.wht,
      net: st.net,
      carry: st.carry,
      status: "ready" as const,
      jobs: mine.map((r) => {
        const app = r.applicationCode
          ? appBy.get(r.applicationCode)
          : undefined;
        return {
          ref: r.applicationCode ?? "",
          service: app?.name ?? r.applicationCode ?? "",
          eligible: r.baseAmountRwf,
          rate: rateLabel(rateFor(rates, app?.slug ?? "")),
          share: r.workerAmountRwf,
        };
      }),
    };
  });
}
export async function statements(db: Exec, s: Session) {
  const a = await actor(db, s);
  return [...(await statementsOf(db, a.uid, a.name, a.e))].reverse();
}
export async function statement(db: Exec, s: Session, month: string) {
  const a = await actor(db, s);
  const st = (await statementsOf(db, a.uid, a.name, a.e)).find(
    (x) => x.month === month,
  );
  if (!st) throw err.notFound("No statement for this month");
  return { a, st };
}

type WorkPayout = {
  id: string;
  month: string;
  date: string;
  method: string;
  ref: string;
  amount: number;
  status: "paid" | "pending" | "failed";
};
const METHOD: Record<string, string> = {
  mtn_momo: "MTN MoMo",
  airtel_money: "Airtel Money",
  bank: "Bank",
};
export async function payoutsOf(db: Exec, uid: string, e: ExtState) {
  if (e.firmRole === "member")
    return {
      items: [] as WorkPayout[],
      paidToFirm: (await loadFirm(db, e.firmId))?.name ?? null,
    };
  const batches = (await db.select({ data: financeRecords.data }).from(financeRecords).where(eq(financeRecords.kind, "batch"))).map((r) => r.data as Batch);
  const items: WorkPayout[] = [];
  for (const b of batches)
    for (const l of b.lines.filter(
      (x) => x.workerId === uid && x.status !== "excluded",
    )) {
      const [y, mo] = b.period.split("-").map(Number);
      items.push({
        id: `${b.no}:${l.id}`,
        month: b.period,
        date: new Date(Date.UTC(y, mo, WORK.payoutDay, 10)).toISOString(),
        method: `${METHOD[l.method] ?? l.method} ${l.destination.masked}`,
        ref: l.providerRef ?? "—",
        amount: l.net,
        status:
          l.status === "paid"
            ? "paid"
            : l.status === "failed"
              ? "failed"
              : "pending",
      });
    }
  return {
    items: items.sort((x, y) => y.month.localeCompare(x.month)),
    paidToFirm: null as string | null,
  };
}
export async function payouts(db: Exec, s: Session) {
  const a = await actor(db, s);
  return payoutsOf(db, a.uid, a.e);
}
const invOut = ({ key: _k, ...i }: WorkInvoice) => i;
export async function invoices(db: Exec, s: Session) {
  const a = await actor(db, s);
  return {
    items: a.e.invoices.map(invOut),
    required: a.e.firmRole === "admin",
  };
}
export async function uploadInvoice(
  ctx: WCtx,
  b: {
    number?: string;
    period?: string;
    amount?: number;
    fileName?: string;
    size?: number;
    type?: string;
  },
) {
  const a = await actor(ctx.db, ctx.session, true);
  if (a.e.firmRole === "member")
    throw new AppError(403, "forbidden", "Firm invoices come from the firm admin");
  if ((b.size ?? 0) > WORK.invoiceMaxMb * 1024 * 1024)
    throw new AppError(413, "too_large", "Max 10 MB");
  if (b.type && b.type !== "application/pdf")
    throw new AppError(415, "unsupported_type", "PDF only");
  if (
    !b.number?.trim() ||
    !/^\d{4}-\d{2}$/.test(b.period ?? "") ||
    !(Number(b.amount) > 0) ||
    !b.fileName
  )
    throw new AppError(
      422,
      "validation",
      "Number, period, amount and file are required",
    );
  if (a.e.invoices.some((x) => x.number === b.number!.trim()))
    throw new AppError(409, "duplicate_reference", "Invoice number already uploaded");
  const key = fileKey(a.uid, "invoices");
  const inv: WorkInvoice = {
    id: `inv-${Date.now().toString(36)}`,
    number: b.number.trim(),
    period: b.period!,
    amount: Math.round(Number(b.amount)),
    fileName: b.fileName,
    status: "received",
    at: iso(),
    key,
  };
  a.e.invoices.unshift(inv);
  await saveExt(ctx.db, a.uid, a.e);
  ctx.audit = { resourceId: inv.number };
  return {
    ...invOut(inv),
    upload: { url: await uploadUrl(ctx, key, "application/pdf", b.size!), key },
  };
}
export async function decideInvoice(
  ctx: WCtx,
  uid: string,
  decision: "accepted" | "rejected",
  id?: string,
  note?: string,
) {
  const e = await loadExt(ctx.db, uid, true);
  const inv = e.invoices.find((x) =>
    id ? x.id === id : x.status === "received",
  );
  if (!inv) throw err.notFound("No received invoice");
  inv.status = decision;
  if (decision === "rejected")
    inv.note =
      note?.trim() ||
      "Amount doesn't match the statement net — please reissue.";
  await saveExt(ctx.db, uid, e);
  ctx.audit = { resourceId: inv.number, details: { decision } };
  return invOut(inv);
}

// ── firm team (lane G) ────────────────────────────────────────────────────────────────────────────────
async function firmOfAdmin(db: Exec, s: Session, lock = false) {
  const a = await actor(db, s);
  if (a.e.firmRole !== "admin" || !a.e.firmId) throw notYours();
  const f = await loadFirm(db, a.e.firmId, lock);
  if (!f) throw notYours();
  return { a, f, id: a.e.firmId };
}
async function firmJobs(db: Exec, f: FirmRec, owner: string) {
  const ids = f.members.filter((m) => !m.invited).map((m) => m.id);
  const apps = ids.length
    ? await db
        .select()
        .from(applications)
        .where(inArray(applications.assignedAgentId, ids))
        .orderBy(desc(applications.updatedAt))
        .limit(500)
    : [];
  const [cls, svcs, rates] = await Promise.all([
    clientsOf(db, apps),
    servicesBySlug(
      db,
      apps.map((x) => x.serviceSlug),
    ),
    loadRates(db, owner),
  ]);
  return apps.map((c) => {
    const m = f.members.find((x) => x.id === c.assignedAgentId)!;
    return {
      ref: c.code,
      service: svcs.get(c.serviceSlug)?.name ?? c.serviceName,
      serviceSlug: c.serviceSlug,
      client: cls.get(clientKey(c))?.name ?? "",
      status: c.status,
      dueAt: c.dueAt ?? c.slaDeadline ?? c.submittedAt,
      assigneeId: m.id,
      assignee: m.name,
      earning: expectedEarning(
        c.agreedAmountRwf ?? c.paymentAmount ?? 0,
        rateFor(rates, c.serviceSlug),
      ),
      open: !(CLOSED as string[]).includes(c.status),
    };
  });
}
export async function firm(db: Exec, s: Session) {
  const { f, id } = await firmOfAdmin(db, s);
  const jobs = await firmJobs(db, f, id);
  const exts = await Promise.all(
    f.members.map((m) => (m.invited ? null : loadExt(db, m.id))),
  );
  const members = f.members.map((m, i) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    status: m.invited ? ("onboarding" as const) : exts[i]!.status,
    services: m.services,
    activeJobs: jobs.filter((j) => j.open && j.assigneeId === m.id).length,
    removalRequested: !!f.removals[m.id],
  }));
  const splits = await splitsOf(
    db,
    f.members.filter((m) => !m.invited).map((m) => m.id),
  );
  const adminPay = await payoutsOf(db, f.adminId, {
    ...(exts[f.members.findIndex((m) => m.id === f.adminId)] ??
      (await loadExt(db, f.adminId))),
    firmRole: "admin",
  });
  const months = [...new Set(splits.map((x) => monthOf(x.frozenAt)))]
    .sort()
    .reverse();
  const payouts = months.map((month) => {
    const rows = splits.filter((x) => monthOf(x.frozenAt) === month);
    const by = new Map<string, number>();
    for (const r of rows)
      by.set(r.workerId!, (by.get(r.workerId!) ?? 0) + r.workerAmountRwf);
    const paid = adminPay.items.find(
      (p) => p.month === month && p.status === "paid",
    );
    return {
      month,
      gross: rows.reduce((t, r) => t + r.workerAmountRwf, 0),
      status: paid ? ("paid" as const) : ("pending" as const),
      ref: paid?.ref ?? null,
      breakdown: [...by.entries()].map(([mid, amount]) => ({
        id: mid,
        name: f.members.find((m) => m.id === mid)?.name ?? mid,
        amount,
      })),
    };
  });
  return { org: f.name, account: f.account, members, jobs, payouts };
}
export async function inviteMember(
  ctx: WCtx,
  b: { name: string; email: string; phone?: string; services: string[] },
) {
  const { a, f, id } = await firmOfAdmin(ctx.db, ctx.session, true);
  notSuspended(a);
  const email = b.email.trim().toLowerCase();
  if (
    !b.name?.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !b.services?.length
  )
    throw new AppError(422, "validation", "Invalid");
  if (f.members.some((m) => m.email.toLowerCase() === email))
    throw new AppError(409, "already_member", "Already a member");
  const m = {
    id: `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: b.name.trim(),
    email,
    role: "member" as const,
    services: b.services,
    invited: true,
  };
  f.members.push(m);
  await saveFirm(ctx.db, id, f);
  // The SM onboards the member (workforce create → invite email); notify them so nothing waits silently.
  const mgr = await managerOf(ctx.db, a.uid);
  if (mgr.id)
    await notify(ctx.db, {
      userId: mgr.id,
      kind: "workforce",
      title: `${f.name} invited ${m.name} (${email})`,
      href: "/ops/workforce",
    });
  ctx.audit = { resourceId: m.id, details: { firm: id } };
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    status: "onboarding" as const,
    activeJobs: 0,
    services: m.services,
  };
}
export async function requestRemoval(
  ctx: WCtx,
  memberId: string,
  reason: string,
) {
  const { a, f, id } = await firmOfAdmin(ctx.db, ctx.session, true);
  if (!f.members.some((m) => m.id === memberId && m.role === "member"))
    throw notYours();
  if (!reason?.trim()) throw new AppError(422, "reason_required", "Reason required");
  f.removals[memberId] = { reason: reason.trim(), at: iso() };
  await saveFirm(ctx.db, id, f);
  const mgr = await managerOf(ctx.db, a.uid);
  if (mgr.id)
    await notify(ctx.db, {
      userId: mgr.id,
      kind: "workforce",
      title: `${f.name} asked to remove a member`,
      href: `/ops/workforce/${memberId}`,
    });
  ctx.audit = { resourceId: memberId, details: { reason: reason.trim() } };
  return { requested: true };
}
export async function assignInternally(
  ctx: WCtx,
  code: string,
  memberId: string,
) {
  const { a, f } = await firmOfAdmin(ctx.db, ctx.session);
  notSuspended(a);
  const ids = f.members.filter((m) => !m.invited).map((m) => m.id);
  const r = await loadCase(ctx.db, code, true).catch(() => null);
  if (!r || !r.app.assignedAgentId || !ids.includes(r.app.assignedAgentId))
    throw notYours();
  const m = f.members.find((x) => x.id === memberId && !x.invited);
  if (!m) throw notYours();
  const me = await loadExt(ctx.db, m.id);
  if (me.status !== "cleared" || !m.services.includes(r.app.serviceSlug))
    throw new AppError(409, "member_not_cleared", "Member not cleared");
  const before = r.app.assignedAgentId;
  await saveCase(ctx.db, r, { assignedAgentId: m.id, assignedAt: iso() });
  await logEvent(ctx.db, r.app.applicationId, {
    kind: "assignment",
    actorId: a.uid,
    actorName: a.name,
    from: before,
    to: m.name,
    text: "firm reassignment",
  });
  ctx.audit = { resourceId: r.app.code, details: { before, after: m.id } };
  return { ref: r.app.code, assigneeId: m.id };
}

// ── scoped job access (lane D) ────────────────────────────────────────────────────────────────────────
const scopeId = (uid: string, ref: string) => `ws:${uid}:${ref}`;
const isMine = (r: CaseRow, uid: string) =>
  r.app.assignedAgentId === uid || r.x.helpers.includes(uid);
type Scoped = { r: CaseRow; s: JobScopeRec; known: boolean };
/** null = never this worker's job (404). Access ends when the case closes or moves to someone else. */
export async function scoped(
  db: Exec,
  uid: string,
  ref: string,
  lock = false,
): Promise<Scoped | null> {
  const r = await loadCase(db, ref, lock).catch(() => null);
  if (!r) return null;
  const rec = await recGet<JobScopeRec>(
    db,
    "work_scope",
    scopeId(uid, r.app.code),
    lock,
  );
  const mine = isMine(r, uid);
  if (!mine && !rec) return null;
  const s: JobScopeRec = rec?.data ?? {
    sharedDocKeys: WORK.defaultSharedDocs,
    sharedFields: WORK.defaultSharedFields,
    clientLane: !!r.app.partnerClientLaneOpen,
    active: true,
  };
  if (s.active && !mine)
    Object.assign(s, {
      active: false,
      accessEndedAt: s.accessEndedAt ?? r.app.updatedAt,
      accessEndedReason: s.handback ? "handback" : "reassigned",
    });
  if (s.active && (CLOSED as string[]).includes(r.app.status))
    Object.assign(s, {
      active: false,
      accessEndedAt: r.app.completedAt ?? r.app.updatedAt,
      accessEndedReason: "closed",
    });
  return { r, s, known: !!rec };
}
const saveScope = (db: Exec, uid: string, ref: string, s: JobScopeRec) =>
  recPut(db, "work_scope", {
    id: scopeId(uid, ref),
    ownerId: uid,
    ref,
    state: s.active ? "active" : "ended",
    data: s,
  });
async function activeScope(db: Exec, uid: string, ref: string, lock = false) {
  const x = await scoped(db, uid, ref, lock);
  if (!x?.s.active) throw notYours();
  return x;
}
async function docRows(db: Exec, r: CaseRow) {
  return db
    .select()
    .from(applicationDocuments)
    .where(
      and(
        eq(applicationDocuments.applicationId, r.app.applicationId),
        eq(applicationDocuments.isActive, true),
      ),
    );
}
export const docShared = (s: JobScopeRec, requirementKey: string) =>
  !WORK.neverShared.includes(requirementKey) &&
  s.sharedDocKeys.includes(requirementKey);

type Version = { v: number; text: string; by: string; at: string };
async function versionsOf(db: Exec, r: CaseRow) {
  const rec = await recGet<{ items: Version[] }>(
    db,
    "work_instr",
    `wi:${r.app.code}`,
  );
  const mgr = r.app.assignedAgentId
    ? (await managerOf(db, r.app.assignedAgentId)).name
    : "Service manager";
  const items: Version[] = rec?.data.items ?? [
    {
      v: 1,
      text: `Prepare the ${r.app.serviceName.toLowerCase()} from the shared documents.`,
      by: mgr,
      at: r.app.createdAt,
    },
  ];
  // Ops edits the live brief (OpsX.instructions); surface an edit as the next version without a write on read.
  const live = r.x.instructions?.trim();
  if (live && live !== items.at(-1)!.text)
    items.push({
      v: items.length + 1,
      text: live,
      by: mgr,
      at: r.app.updatedAt,
    });
  return items;
}
export async function addInstructionVersion(
  ctx: WCtx,
  ref: string,
  text: string,
  by: string,
) {
  const r = await loadCase(ctx.db, ref, true);
  const items = await versionsOf(ctx.db, r);
  items.push({ v: items.length + 1, text, by, at: iso() });
  await recPut(ctx.db, "work_instr", {
    id: `wi:${r.app.code}`,
    ref: r.app.code,
    data: { items },
  });
  r.x.instructions = text;
  await saveCase(ctx.db, r);
  return { v: items.length };
}

export async function scopeView(db: Exec, s: Session, ref: string) {
  const a = await actor(db, s);
  const x = await scoped(db, a.uid, ref);
  if (!x) throw notYours();
  const docs = await docRows(db, x.r);
  const rates = await loadRates(db, rateOwner(a.uid, a.e));
  const r = rateFor(rates, x.r.app.serviceSlug);
  const eligible = x.r.app.agreedAmountRwf ?? x.r.app.paymentAmount ?? 0;
  return {
    sharedDocIds: x.s.sharedDocKeys.map((k) => `doc-${k}`),
    sharedFields: x.s.sharedFields,
    lockedDocs: docs.filter((d) => !docShared(x.s, d.requirementKey)).length,
    clientLane: x.s.clientLane,
    active: x.s.active,
    instructionsVersion: (await versionsOf(db, x.r)).length,
    agreed: { amount: expectedEarning(eligible, r), ...r },
    accessEndedAt: x.s.accessEndedAt,
    accessEndedReason: x.s.accessEndedReason,
    handback: x.s.handback
      ? { reason: x.s.handback.reason, at: x.s.handback.at }
      : undefined,
  };
}
export async function instructions(db: Exec, s: Session, ref: string) {
  const a = await actor(db, s);
  const x = await scoped(db, a.uid, ref);
  if (!x) throw notYours();
  return { items: [...(await versionsOf(db, x.r))].reverse() };
}
export async function accessRequests(db: Exec, s: Session, ref: string) {
  const a = await actor(db, s);
  const x = await scoped(db, a.uid, ref);
  if (!x) throw notYours();
  return {
    items: (
      await recList<AccessReq>(db, "work_access", {
        ownerId: a.uid,
        ref: x.r.app.code,
      })
    ).map((r) => r.data),
  };
}
export async function requestAccess(
  ctx: WCtx,
  ref: string,
  b: { reason: string; note?: string; client_op_id: string },
) {
  const a = await actor(ctx.db, ctx.session);
  const x = await activeScope(ctx.db, a.uid, ref);
  if (!b.reason || (b.reason === "other" && !b.note?.trim()))
    throw new AppError(422, "validation", "Reason required.");
  const id = `wa:${a.uid}:${b.client_op_id}`;
  const dup = await recGet<AccessReq>(ctx.db, "work_access", id);
  if (dup) return dup.data;
  const open = await recList<AccessReq>(ctx.db, "work_access", {
    ownerId: a.uid,
    ref: x.r.app.code,
    state: "pending",
  });
  if (open.length) throw new AppError(409, "already_requested", "Already requested.");
  const r: AccessReq = {
    id: b.client_op_id,
    ref: x.r.app.code,
    reason: b.reason,
    note: b.note?.trim() || undefined,
    status: "pending",
    at: iso(),
  };
  await recPut(ctx.db, "work_access", {
    id,
    ownerId: a.uid,
    ref: x.r.app.code,
    state: "pending",
    data: r,
  });
  await logEvent(ctx.db, x.r.app.applicationId, {
    kind: "note",
    feed: "agent",
    actorId: a.uid,
    actorName: a.name,
    text: `You requested access to unshared documents (${b.reason}).`,
  });
  const mgr = await managerOf(ctx.db, a.uid);
  if (mgr.id)
    await notify(ctx.db, {
      userId: mgr.id,
      kind: "access",
      title: `${a.name} requested more documents on ${x.r.app.code}`,
      href: `/ops/cases/${x.r.app.code}`,
    });
  ctx.audit = { resourceId: x.r.app.code, details: { reason: b.reason } };
  return r;
}
/** SM grants/denies an access request (ops; also the dev simulate). Granting shares every checklist doc but bank/payment. */
export async function decideAccess(
  ctx: WCtx,
  uid: string,
  opId: string,
  grant: boolean,
  by: string,
) {
  const rec = await recGet<AccessReq>(
    ctx.db,
    "work_access",
    `wa:${uid}:${opId}`,
    true,
  );
  if (!rec) throw notYours();
  const r = rec.data;
  if (r.status !== "pending") throw err.conflict("Already decided");
  r.status = grant ? "granted" : "denied";
  await recPut(ctx.db, "work_access", { ...rec, state: r.status, data: r });
  const x = await scoped(ctx.db, uid, r.ref, true);
  if (x && grant) {
    const keys = (await docRows(ctx.db, x.r))
      .map((d) => d.requirementKey)
      .filter((k) => !WORK.neverShared.includes(k));
    x.s.sharedDocKeys = [
      ...new Set([
        ...x.s.sharedDocKeys,
        ...keys,
        ...x.r.x.checklist
          .map((i) => i.key)
          .filter((k) => !WORK.neverShared.includes(k)),
      ]),
    ];
    await saveScope(ctx.db, uid, r.ref, x.s);
  }
  if (x)
    await logEvent(ctx.db, x.r.app.applicationId, {
      kind: "note",
      feed: "agent",
      actorName: by,
      text: `Access request ${r.status} by ${by}.`,
    });
  await notify(ctx.db, {
    userId: uid,
    kind: "access",
    title: `Document access ${r.status} on ${r.ref}`,
    href: `/work/jobs/${r.ref}`,
  });
  ctx.audit = { resourceId: r.ref, details: { status: r.status } };
  return r;
}
export async function setClientLane(ctx: WCtx, uid: string, ref: string) {
  const x = await scoped(ctx.db, uid, ref, true);
  if (!x) throw notYours();
  x.s.clientLane = !x.s.clientLane;
  await saveScope(ctx.db, uid, x.r.app.code, x.s);
  return x.s;
}
export async function handback(
  ctx: WCtx,
  ref: string,
  b: { reason: string; note?: string },
) {
  const a = await actor(ctx.db, ctx.session);
  const x = await activeScope(ctx.db, a.uid, ref, true);
  if (
    !b.reason ||
    ((b.reason === "other" || b.reason === "scope_changed") && !b.note?.trim())
  )
    throw new AppError(422, "reason_required", "Give a reason.");
  if (!x.s.handback) {
    x.s.handback = {
      reason: b.reason,
      note: b.note?.trim() || undefined,
      at: iso(),
    };
    await saveScope(ctx.db, a.uid, x.r.app.code, x.s);
    await logEvent(ctx.db, x.r.app.applicationId, {
      kind: "note",
      feed: "agent",
      actorId: a.uid,
      actorName: a.name,
      text: `You asked to hand back this job (${b.reason}).`,
    });
    await logEvent(ctx.db, x.r.app.applicationId, {
      kind: "assignment",
      actorId: a.uid,
      actorName: a.name,
      text: `Hand back requested: ${b.reason}${b.note ? ` — ${b.note}` : ""}`,
    });
    const mgr = await managerOf(ctx.db, a.uid);
    if (mgr.id)
      await notify(ctx.db, {
        userId: mgr.id,
        kind: "assignment",
        title: `${a.name} handed back ${x.r.app.code}`,
        href: `/ops/cases/${x.r.app.code}`,
      });
  }
  ctx.audit = { resourceId: x.r.app.code, details: { reason: b.reason } };
  return scopeView(ctx.db, ctx.session, x.r.app.code);
}
/** Access ends when the SM reassigns (ops reassign calls this; also the dev simulate). */
export async function endAccess(
  ctx: WCtx,
  uid: string,
  ref: string,
  unassign: boolean,
) {
  const x = await scoped(ctx.db, uid, ref, true);
  if (!x) throw notYours();
  if (unassign && x.r.app.assignedAgentId === uid)
    await saveCase(ctx.db, x.r, { assignedAgentId: null, assignedAt: null });
  x.s.active = false;
  x.s.accessEndedAt = iso();
  x.s.accessEndedReason = x.s.handback ? "handback" : "reassigned";
  await saveScope(ctx.db, uid, x.r.app.code, x.s);
  return x.s;
}
export async function download(ctx: WCtx, ref: string, docId: string) {
  const a = await actor(ctx.db, ctx.session);
  const x = await activeScope(ctx.db, a.uid, ref);
  const [d] = await ctx.db
    .select()
    .from(applicationDocuments)
    .where(
      and(
        eq(applicationDocuments.applicationId, x.r.app.applicationId),
        eq(applicationDocuments.documentId, docId),
        eq(applicationDocuments.isActive, true),
        isNull(applicationDocuments.removedAt),
      ),
    );
  if (!d || !docShared(x.s, d.requirementKey))
    throw new AppError(403, "forbidden", "Not shared with you.");
  if (d.scanStatus === "infected") throw new AppError(410, "quarantined", "This file was quarantined.");
  if (d.scanStatus !== "clean") throw new AppError(409, "scanning", "This file is still being checked.");
  const at = iso();
  await logEvent(ctx.db, x.r.app.applicationId, {
    kind: "document",
    feed: "agent",
    actorId: a.uid,
    actorName: a.name,
    text: `You downloaded ${d.originalFilename} (watermarked)`,
  });
  ctx.audit = { resourceId: x.r.app.code, details: { doc: d.documentId } };
  // shortcut: the watermark is the client overlay + this audited log; per-file stamping needs a PDF/image
  // stamper (no pdf-lib dependency yet) — upgrade by stamping into a derived object before presigning.
  return {
    url: await ctx.k.storage.presignGet(d.storagePath, d.originalFilename),
    watermark: { name: a.name, ref: x.r.app.code, at },
  };
}
export async function contributions(db: Exec, s: Session, ref: string) {
  const a = await actor(db, s);
  const x = await scoped(db, a.uid, ref);
  if (!x) throw notYours();
  const msgs = await db
    .select({
      id: applicationMessages.messageId,
      body: applicationMessages.content,
      at: applicationMessages.createdAt,
    })
    .from(applicationMessages)
    .where(
      and(
        eq(applicationMessages.applicationId, x.r.app.applicationId),
        eq(applicationMessages.senderId, a.uid),
        sql`${applicationMessages.deletedAt} is null`,
      ),
    )
    .orderBy(asc(applicationMessages.createdAt))
    .limit(500);
  return {
    messages: msgs,
    // shortcut: deliverable versions carry no uploader id; every version on a job this worker led is theirs.
    uploads: x.r.x.slots.flatMap((sl) =>
      sl.versions.map((v) => ({
        slot: sl.label,
        name: v.name,
        v: v.v,
        at: v.at,
      })),
    ),
  };
}
/** Deliverable guard for externals (B16, 25 MB). Integrator: call from agent.uploadDeliverable for ext:agent. */
export async function assertCanDeliver(
  db: Exec,
  uid: string,
  ref: string,
  size: number,
) {
  const x = await scoped(db, uid, ref);
  if (!x?.s.active) throw notYours();
  const e = await loadExt(db, uid);
  if (
    e.services.find((s) => s.slug === x.r.app.serviceSlug)?.state ===
    "not_cleared"
  )
    throw new AppError(409, "service_not_cleared", "Not cleared for this service.");
  if (size > WORK.deliverableMaxMb * 1024 * 1024)
    throw new AppError(
      422,
      "too_large",
      `File is larger than ${WORK.deliverableMaxMb} MB`,
    );
}

/** Workforce create of an external: link them to a firm that invited this email (member keeps the firm's rate card). */
export async function attachInvitedMember(
  db: Exec,
  uid: string,
  email: string,
) {
  const e = email.trim().toLowerCase();
  for (const r of await recList<FirmRec>(db, "work_firm", {}, 2000)) {
    const m = r.data.members.find((x) => x.invited && x.email === e);
    if (!m) continue;
    const f = (await loadFirm(db, r.id, true))!;
    const mm = f.members.find((x) => x.invited && x.email === e)!;
    if (f.removals[mm.id]) f.removals[uid] = f.removals[mm.id];
    delete f.removals[mm.id];
    Object.assign(mm, { id: uid, invited: undefined });
    await saveFirm(db, r.id, f);
    const x = await loadExt(db, uid, true);
    Object.assign(x, { firmId: r.id, firmRole: "member" });
    await saveExt(db, uid, x);
    return r.id;
  }
  return null;
}

/** Offboarding: end every job scope this worker still holds. */
export async function endAllAccess(
  db: Exec,
  uid: string,
  reason: JobScopeRec["accessEndedReason"],
) {
  for (const r of await recList<JobScopeRec>(
    db,
    "work_scope",
    { ownerId: uid, state: "active" },
    2000,
  ))
    await recPut(db, "work_scope", {
      ...r,
      state: "ended",
      data: {
        ...r.data,
        active: false,
        accessEndedAt: iso(),
        accessEndedReason: reason,
      },
    });
}

// ── counter-proposal (lane C) ─────────────────────────────────────────────────────────────────────────
type CounterOffer = OfferData & { pausedMs?: number };
export async function counter(
  ctx: WCtx,
  id: string,
  b: { due?: string; reason?: string },
) {
  const a = await actor(ctx.db, ctx.session);
  const o = await recGet<CounterOffer>(ctx.db, "offer", id, true);
  if (!o || o.ownerId !== a.uid) throw err.notFound("Offer not found");
  const d = o.data;
  if (Date.parse(d.expiresAt) <= Date.now() || d.state === "timeout")
    throw new AppError(409, "expired", "This offer expired");
  if (d.state !== "sent" && d.state !== "viewed")
    throw new AppError(409, "taken", "Your manager reassigned this offer");
  if (d.counter?.status === "pending")
    throw new AppError(409, "already_countered", "Counter already sent");
  if (!b.reason?.trim() || !b.due || !(Date.parse(b.due) > Date.parse(d.dueAt)))
    throw new AppError(422, "validation", "Pick a later deadline and give a reason");
  d.pausedMs = Date.parse(d.expiresAt) - Date.now();
  d.expiresAt = iso(Date.now() + 365 * D); // TTL paused while countered
  d.counter = { due: b.due, reason: b.reason.trim(), status: "pending" };
  await recPut(ctx.db, "offer", { ...o, data: d });
  const mgr = await managerOf(ctx.db, a.uid);
  if (mgr.id)
    await notify(ctx.db, {
      userId: mgr.id,
      kind: "offer",
      title: `${a.name} proposed a later deadline on ${o.ref}`,
      href: `/ops/cases/${o.ref}`,
    });
  ctx.audit = {
    resourceId: id,
    details: { due: b.due, reason: b.reason.trim() },
  };
  return {
    id,
    ref: o.ref,
    status: "pending",
    sentAt: d.sentAt,
    expiresAt: d.expiresAt,
    dueAt: d.dueAt,
    eligible: d.eligible,
    counter: d.counter,
  };
}
export async function decideCounter(ctx: WCtx, id: string, accept: boolean) {
  const o = await recGet<CounterOffer>(ctx.db, "offer", id, true);
  if (!o || o.data.counter?.status !== "pending")
    throw new AppError(409, "conflict", "No pending counter");
  const d = o.data;
  d.counter = { ...d.counter!, status: accept ? "accepted" : "declined" };
  if (accept) d.dueAt = d.counter.due;
  d.expiresAt = iso(Date.now() + (d.pausedMs ?? 3600_000));
  delete d.pausedMs;
  await recPut(ctx.db, "offer", { ...o, data: d });
  await notify(ctx.db, {
    userId: o.ownerId!,
    kind: "offer",
    title: `Counter-proposal ${d.counter.status}`,
    href: `/work/offers?offer=${id}`,
  });
  ctx.audit = { resourceId: id, details: { status: d.counter.status } };
  return {
    id,
    ref: o.ref,
    status: "pending",
    expiresAt: d.expiresAt,
    dueAt: d.dueAt,
    counter: d.counter,
  };
}


// ── workforce sync (W3-C create/status call these in their tx) ──────────────────────────────────────────
/** Workforce created an external: open their work_ext record and link them to a firm that invited this email. */
export async function onExternalCreated(db: Exec, uid: string, email: string) {
  await saveExt(db, uid, await loadExt(db, uid, true));
  return attachInvitedMember(db, uid, email);
}
/** Workforce status change of an external: mirror it into work_ext; termination ends every job scope. */
export async function onExternalStatus(
  db: Exec,
  uid: string,
  to: "invited" | "onboarding" | "cleared" | "suspended" | "terminated",
) {
  const e = await loadExt(db, uid, true);
  e.status = to === "invited" ? "onboarding" : to;
  await saveExt(db, uid, e);
  if (to === "terminated") await endAllAccess(db, uid, "terminated");
}

// ── crons (work.jobs.ts runs these per work_ext row, one short tx each) ─────────────────────────────────
/** Monthly: raise next month's licence invoice for every cleared firm admin / sole trader; mark past-due overdue. */
export async function licenceRow(tx: Exec, owner: string, e: ExtState, now: number) {
  const period = monthOf(iso(now + 20 * D)); // raised ~10 days before the period starts
  let dirty = false;
  let n = 0;
  for (const l of e.licence)
    if (l.status === "due" && Date.parse(l.due) < now) {
      l.status = "overdue";
      dirty = true;
    }
  if (e.status === "cleared" && e.firmRole !== "member" && !e.notice && !e.licence.some((l) => l.period === period)) {
    const y = period.slice(0, 4);
    const seq = await recSeq(tx, "work_seq", `work_licence_seq:${y}`);
    e.licence.push({
      number: `INV-${y}-L${String(seq).padStart(5, "0")}`, // PLACEHOLDER(licence-invoice-format)
      period,
      // F-WRK-08: the effective finance setting (approved, effective-dated) — the same figure payouts net off.
      amount: (await finSettings(tx)).licence_fee_monthly ?? WORK.licenceMonthly,
      due: `${period}-${String(WORK.licenceDueDay).padStart(2, "0")}`,
      status: "due",
    });
    n = 1;
    dirty = true;
  }
  if (dirty) await saveExt(tx, owner, e);
  return n;
}
/** Daily: expire credentials past their date and pull the services they covered back to not_cleared. */
export async function credentialRow(tx: Exec, owner: string, e: ExtState, now: number) {
  const gone = e.credentials.filter((c) => c.status === "verified" && c.expiresOn && Date.parse(c.expiresOn) < now);
  if (!gone.length) return 0;
  for (const c of gone)
    Object.assign(c, { status: "expired", note: "Expired — upload the renewed certificate to be cleared again." });
  const still = new Set(e.credentials.filter((c) => c.status === "verified").flatMap((c) => c.services));
  for (const s of e.services)
    if (gone.some((c) => c.services.includes(s.slug)) && !still.has(s.slug))
      Object.assign(s, { state: "not_cleared", reason: "credentialExpired" });
  await saveExt(tx, owner, e);
  await notify(tx, {
    userId: owner,
    kind: "workforce",
    title: "A credential expired — upload the renewal",
    href: "/work/profile?tab=credentials",
  });
  return gone.length;
}
