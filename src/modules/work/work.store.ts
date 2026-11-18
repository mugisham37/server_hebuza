// Port of .ref work.store: external-agent persistence. Everything an external worker owns that has no column elsewhere
// lives in typed ops_records rows, one per concern, so writers serialise on the row (SELECT … FOR UPDATE):
//   work_ext   wx:<userId>          status, firm link, service clearance, contract docs, licence, credentials,
//                                     onboarding (PII encrypted with CryptoService), payout destination, history, invoices
//   work_firm  <firmId>             firm name/account, admin, members + pending invites, removal requests
//   work_rates wr:<ownerId>          rate card (owner = firm id, or the worker for sole traders)
//   work_scope ws:<userId>:<ref>     what one external may see on one job (+ access end, hand back)
//   work_instr wi:<ref>              instruction versions for a job
//   work_access wa:<userId>:<opId>   document access requests (id = client op id → idempotent)
//   work_app   <REF>                 /join applications (ownerId = applicant email)
// shortcut: ops_records rows instead of dedicated tables; split into tables when firms/applications need relational reporting.
import { eq } from "drizzle-orm";
import type IORedis from "ioredis";
import { agentProfiles, users } from "@/db/schema";
import { POLICY } from "@/domain/policy";
import { applyBps, payout as payoutOf } from "@/domain/money";
import type { CryptoService } from "../../core/crypto/crypto.service";
import type { StorageService } from "../../core/storage/storage.service";
import { AppError, err, type Ctx, type Exec, type Session } from "../ops/lib/ctx";
import { recGet, recPut } from "../ops/lib/store";

/** Request-scoped services the plain functions need (built by WorkRunner). */
export type Kit = {
  crypto: CryptoService;
  storage: StorageService;
  redis: IORedis;
  prod: boolean;
  origin: string;
  /** Sealed mail through the auth.mail outbox job. */
  mail: (db: Exec, m: { to: string; subject: string; text: string }) => Promise<unknown>;
  /** Delayed storage.scan of a presigned upload once its PUT window has passed. */
  scan: (db: Exec, key: string) => Promise<unknown>;
};
export type WCtx = Ctx & { k: Kit };

// ── shared types (were web lib/work/api.ts) ──────────────────────────────────────────────────────────
export type WorkerStatus = "onboarding" | "pending_verification" | "changes_requested" | "cleared" | "suspended" | "terminated";
export type ServiceClearance = "cleared" | "not_cleared" | "pending";
export type LicenceInvoice = { number: string; period: string; amount: number; due: string; status: "due" | "paid" | "overdue" | "netted" | "waived" };
export type External = {
  status: WorkerStatus;
  firmRole: "admin" | "member" | null;
  firm: string | null;
  contractEnd: string | null;
  contractState: "active" | "expiring" | "expired" | "notice_given" | "pending_signature";
  licence: LicenceInvoice | null;
  services: { slug: string; name: string; state: ServiceClearance; reason?: string }[];
  lastPayout: { amount: number; at: string } | null;
  manager: string;
  todo: string[];
};
export type Application = {
  ref: string;
  status: "received" | "under_review" | "info_requested" | "approved" | "rejected" | "invite_expired" | "converted";
  kind: "individual" | "firm";
  name: string;
  submittedAt: string;
  flaggedFields?: string[];
  decisionNote?: string;
};
export type Credential = {
  id: string;
  kind: "degree" | "certificate" | "license" | "professional_body";
  title: string;
  issuer: string;
  number: string;
  issuedOn: string;
  expiresOn: string | null;
  status: "pending" | "verified" | "rejected" | "expired";
  note?: string;
  fileName: string;
  services: string[];
};
export type ContractDoc = {
  id: string;
  kind: "service_agreement" | "sla" | "nda" | "licence";
  title: string;
  version: number;
  status: "pending_signature" | "active" | "expiring" | "expired" | "renewed" | "terminated";
  start: string;
  end: string | null;
  noticeDays: number;
  terms: string[];
  signedAt?: string;
  evidence?: { ip: string; sha256: string; typedName: string };
};
export type RateCardRow = { serviceId: string; serviceName: string; bps?: number; flat?: number; from: string; status: "approved" | "proposed" | "rejected"; reason?: string };
export type Statement = {
  month: string;
  number: string;
  gross: number;
  adjustments: number;
  licence: number;
  taxable: number;
  wht: number;
  net: number;
  carry: number;
  status: "ready" | "generating";
  jobs: { ref: string; service: string; eligible: number; rate: string; share: number }[];
};

// ── money (were web lib/agent/money.ts + core.ts) ────────────────────────────────────────────────────
export const expectedEarning = (eligible: number, r: { bps?: number; flat?: number }) => r.flat ?? applyBps(eligible, r.bps ?? 0);
/** Monthly statement for an external: WHT on (gross + adjustments), then the monthly licence; negative net carries. */
export const statementOf = (o: { gross: number; adjustments: number; licence?: number; carriedIn?: number }) => {
  const p = payoutOf({ gross: o.gross + o.adjustments, shareBps: 10_000, external: true, licence: o.licence, carriedIn: o.carriedIn });
  return { taxable: p.share, wht: p.wht, licence: p.licence, net: p.net, carry: -p.carryForward };
};
export const signatureMatches = (typed: string, name: string) =>
  typed.trim().replace(/\s+/g, " ").toLowerCase() === name.trim().replace(/\s+/g, " ").toLowerCase() && typed.trim().length > 1;

export const D = 86_400_000;
import { iso } from "../../core/db/ids";
export { iso };
export const dayIso = (ms = Date.now()) => iso(ms).slice(0, 10);
export const monthOf = (s: string) => s.slice(0, 7);
export const maskEnd = (v: string) => (v ? `•••• ${v.slice(-4)}` : "");
export const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

// ── types ─────────────────────────────────────────────────────────────────────────────────────────────
export type Slot = "id_front" | "id_back" | "selfie";
export type SlotState = {
  status: "empty" | "uploaded" | "rejected";
  fileName?: string;
  note?: string;
  key?: string;
};
export type Onboarding = {
  identity: {
    idType: "national_id" | "passport";
    idEnc: string;
    slots: Record<Slot, SlotState>;
  };
  payout: {
    method: "momo" | "airtel" | "bank" | null;
    bank: string;
    accountEnc: string;
    name: string;
    tinEnc: string;
  };
  services: { slugs: string[]; maxJobs: number; days: string[] };
  savedAt: string | null;
  submittedAt: string | null;
  changes: { items: string[]; note: string } | null;
};
export type Hist = {
  id: string;
  at: string;
  kind:
    "signed" | "renewed" | "notice" | "rate" | "version" | "licence" | "payout";
  text: string;
  by: string;
};
export type PayoutDest = {
  method: "momo" | "airtel" | "bank";
  label: string;
  last4: string;
  status: "verified" | "pending_verification" | "failed";
  coolingUntil: string | null;
};
export type WorkInvoice = {
  id: string;
  number: string;
  period: string;
  amount: number;
  fileName: string;
  status: "received" | "accepted" | "rejected";
  note?: string;
  at: string;
  key?: string;
};
export type Cred = Credential & { key?: string };
export type ExtState = {
  status: WorkerStatus;
  firmId: string | null;
  firmRole: "admin" | "member" | null;
  services: {
    slug: string;
    name: string;
    state: ServiceClearance;
    reason?: string;
  }[];
  contract: ContractDoc[];
  licence: LicenceInvoice[];
  credentials: Cred[];
  notice: { at: string; lastDay: string; reason: string } | null;
  onboarding: Onboarding;
  payoutDest: PayoutDest | null;
  history: Hist[];
  invoices: WorkInvoice[];
  seq: number;
};
export type FirmMemberRec = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  services: string[];
  invited?: boolean;
};
export type FirmRec = {
  name: string;
  account: string;
  adminId: string;
  members: FirmMemberRec[];
  removals: Record<string, { reason: string; at: string }>;
};
export type JobScopeRec = {
  sharedDocKeys: string[];
  sharedFields: string[];
  clientLane: boolean;
  active: boolean;
  accessEndedAt?: string;
  accessEndedReason?: "closed" | "reassigned" | "handback" | "terminated";
  handback?: { reason: string; note?: string; at: string };
};
export type AccessReq = {
  id: string;
  ref: string;
  reason: string;
  note?: string;
  status: "pending" | "granted" | "denied";
  at: string;
};

// ── policy (PLACEHOLDER values live in lib policy; read once here) ─────────────────────────────────────
export const WORK = {
  noticeDays: POLICY.contractNoticeDays,
  renewalDays: 365, // PLACEHOLDER(renewal-term)
  renewWindowDays: 60, // PLACEHOLDER(renewal-window)
  expiringDays: 30, // PLACEHOLDER(contract-expiring-days)
  licenceMonthly: POLICY.licenceFeeMonthly,
  licenceDueDay: 5, // PLACEHOLDER(licence-due-day)
  whtBps: POLICY.whtBps,
  defaultBps: POLICY.defaultAgentBps,
  payoutDay: POLICY.payoutDay,
  coolingMs: POLICY.destinationCoolingMs,
  tinDigits: POLICY.tinDigits,
  capMax: POLICY.capMax,
  qualificationMaxMb: POLICY.qualificationMaxMb,
  deliverableMaxMb: POLICY.deliverableMaxMb,
  kycMaxMb: 10,
  invoiceMaxMb: 10,
  ratePropDelayDays: 7, // PLACEHOLDER(rate-change-effective-days)
  /** Docs an external sees by default on a job (checklist keys); everything else needs an access request. */
  defaultSharedDocs: ["form", "id", "address", "sh1"], // PLACEHOLDER(external-default-docs)
  defaultSharedFields: ["name", "service", "tin"],
  neverShared: ["bank", "payment"],
};
export const tinOk = (t: string) =>
  new RegExp(`^\\d{${WORK.tinDigits}}$`).test(t);

// ── PII ───────────────────────────────────────────────────────────────────────────────────────────────
export const enc = (k: Kit, v: string) => (v ? k.crypto.encrypt(v) : "");
export const dec = (k: Kit, v: string) => {
  if (!v) return "";
  try {
    return k.crypto.decrypt(v);
  } catch {
    return "";
  }
};

// ── defaults ──────────────────────────────────────────────────────────────────────────────────────────
const TERMS: Record<ContractDoc["kind"], string[]> = {
  service_agreement: [
    "You deliver the services listed in your rate card to HEBUZA's standards and deadlines.",
    "You are paid your agreed share of the eligible fee once the client's payment is confirmed and the job is completed.",
    "Withholding tax is deducted from every payout; the monthly licence fee is netted after withholding tax.",
    "Either side may end the agreement with written notice; open jobs are reassigned.",
  ],
  nda: [
    "Client information is used only for the job it was shared for.",
    "You do not copy, forward or keep client documents after a job closes.",
    "Downloads are watermarked with your name and logged.",
  ],
  sla: [
    "Respond to offers within the offer window.",
    "Reply to the team lane within one business day.",
    "Ask for an extension before a deadline, not after.",
  ],
  licence: [
    "A monthly platform licence fee applies while the agreement is active.",
  ],
};
export function contractTemplate(
  kind: ContractDoc["kind"],
  start = dayIso(),
): ContractDoc {
  const title = {
    service_agreement: "Service agreement",
    nda: "Non-disclosure agreement",
    sla: "Service level agreement",
    licence: "Licence",
  }[kind];
  return {
    id: `doc-${kind === "service_agreement" ? "sa" : kind}`,
    kind,
    title,
    version: 1,
    status: "pending_signature",
    start,
    end:
      kind === "service_agreement"
        ? dayIso(Date.parse(start) + WORK.renewalDays * D)
        : null,
    noticeDays: kind === "service_agreement" ? WORK.noticeDays : 0,
    terms: TERMS[kind],
  };
}
export const freshOnboarding = (): Onboarding => ({
  identity: {
    idType: "national_id",
    idEnc: "",
    slots: {
      id_front: { status: "empty" },
      id_back: { status: "empty" },
      selfie: { status: "empty" },
    },
  },
  payout: { method: null, bank: "", accountEnc: "", name: "", tinEnc: "" },
  services: {
    slugs: [],
    maxJobs: 3,
    days: ["mon", "tue", "wed", "thu", "fri"],
  },
  savedAt: null,
  submittedAt: null,
  changes: null,
});
export const freshExt = (): ExtState => ({
  status: "onboarding",
  firmId: null,
  firmRole: null,
  services: [],
  contract: (["nda", "sla", "service_agreement"] as const).map((k) =>
    contractTemplate(k),
  ),
  licence: [],
  credentials: [],
  notice: null,
  onboarding: freshOnboarding(),
  payoutDest: null,
  history: [],
  invoices: [],
  seq: 0,
});

// ── load / save ───────────────────────────────────────────────────────────────────────────────────────
const extId = (uid: string) => `wx:${uid}`;
export async function loadExt(
  db: Exec,
  uid: string,
  lock = false,
): Promise<ExtState> {
  const r = await recGet<ExtState>(db, "work_ext", extId(uid), lock);
  return r ? { ...freshExt(), ...r.data } : freshExt();
}
/** Persist + mirror the external status into agent_profiles.clearance (the P5 accept/upload gate). */
export async function saveExt(db: Exec, uid: string, e: ExtState) {
  await recPut(db, "work_ext", {
    id: extId(uid),
    ownerId: uid,
    state: e.status,
    ref: e.firmId,
    data: e,
  });
  const clearance = (
    {
      onboarding: "in_progress",
      pending_verification: "submitted",
      changes_requested: "changes_requested",
      cleared: "cleared",
      suspended: "submitted",
      terminated: "submitted",
    } as const
  )[e.status];
  await db
    .update(agentProfiles)
    .set({ clearance, updatedAt: iso() })
    .where(eq(agentProfiles.userId, uid));
}
export function hist(
  e: ExtState,
  kind: Hist["kind"],
  text: string,
  by: string,
) {
  e.seq += 1;
  e.history.unshift({
    id: `h${e.seq}-${Date.now().toString(36)}`,
    at: iso(),
    kind,
    text,
    by,
  });
}

export async function loadFirm(db: Exec, id: string | null, lock = false) {
  if (!id) return null;
  const r = await recGet<FirmRec>(db, "work_firm", id, lock);
  return r ? r.data : null;
}
export const saveFirm = (db: Exec, id: string, f: FirmRec) =>
  recPut(db, "work_firm", { id, ownerId: f.adminId, data: f });

export const rateOwner = (uid: string, e: ExtState) => e.firmId ?? uid;
export async function loadRates(db: Exec, owner: string, lock = false) {
  const r = await recGet<{ rows: RateCardRow[] }>(
    db,
    "work_rates",
    `wr:${owner}`,
    lock,
  );
  return r?.data.rows ?? [];
}
export const saveRates = (db: Exec, owner: string, rows: RateCardRow[]) =>
  recPut(db, "work_rates", {
    id: `wr:${owner}`,
    ownerId: owner,
    data: { rows },
  });
export const rateFor = (
  rows: RateCardRow[],
  slug: string,
): { bps?: number; flat?: number } => {
  const r = rows.find((x) => x.serviceId === slug && x.status === "approved");
  return r
    ? r.flat !== undefined
      ? { flat: r.flat }
      : { bps: r.bps }
    : { bps: WORK.defaultBps };
};
export const rateLabel = (r: { bps?: number; flat?: number }) =>
  r.flat !== undefined ? "flat" : `${(r.bps ?? 0) / 100}%`;

export async function userOf(db: Exec, uid: string) {
  const [u] = await db.select().from(users).where(eq(users.userId, uid));
  return u ?? null;
}

// ── actor ─────────────────────────────────────────────────────────────────────────────────────────────
export type Actor = { uid: string; name: string; email: string; e: ExtState };
/** The signed-in external worker (ext:agent only). `lock` for writers. */
export async function actor(
  db: Exec,
  s: Session,
  lock = false,
): Promise<Actor> {
  if (!s.roles.includes("ext:agent"))
    throw err.forbidden("External agents only");
  const u = await userOf(db, s.id);
  if (!u) throw new AppError(401, "unauthenticated", "Sign in again.");
  return {
    uid: s.id,
    name: u.name,
    email: u.email ?? "",
    e: await loadExt(db, s.id, lock),
  };
}
export const adminOnly = (a: Actor) => {
  if (a.e.firmRole === "member")
    throw new AppError(403, "forbidden", "Firm admin only");
};
export const notSuspended = (a: Actor) => {
  if (a.e.status === "suspended" || a.e.status === "terminated")
    throw new AppError(403, "suspended", "Access suspended");
};
export const notYours = () => err.notFound("Not found");

