// Field (P8): day plan + offline bundle, visit lifecycle (accept/decline, geo check-in flags, checklist/notes auto-merge,
// scans, custody receipts + chain, incidents, checkout), MoMo prompts, client OTP, cash with 4-eyes confirm, expenses with
// L1/L2 SoD, earnings, conflicts and the office queues. Port of the reference field.service.ts: functions take a `K`
// (tx + caller + deps); FieldService at the bottom runs each in one TxService transaction, audit rows last.
// Offline outbox: every agent write is replay-safe by (user, client_op_id) in `field_ops` on top of Idempotency-Key;
// a stale write (base_version < office_version) answers 409 `field_conflict` with the server state in `data.conflict`.
import { LedgerService } from "../ledger/ledger.service";
import { holdsRole } from "@/db/holds-role";
import { cashKey, postPayment } from "../ledger/ledger.postings";
import { clientInvoicesForCase } from "../finance/finance.billing";
import { Injectable } from "@nestjs/common";
import { PaymentsService } from "../payments/payments.service";
import { ClsService } from "nestjs-cls";
import { createHash, randomInt } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql as dsql,
} from "drizzle-orm";
import { applications, payments, users } from "@/db/schema";
import {
  fieldAgents,
  fieldCash,
  fieldConflicts,
  fieldCounters,
  fieldCustody,
  fieldExpenses,
  fieldFlagReviews,
  fieldIncidents,
  fieldMomo,
  fieldOps,
  fieldOtps,
  fieldPoolShares,
  fieldReceipts,
  fieldScans,
  fieldSettings,
  fieldVisits,
} from "@/db/schema/schema-field";
import {
  FIELD_POLICY,
  POLICY,
  cashEscalated,
  cashNeedsTwo,
  confirmCash,
  decideExpense,
  fieldShare,
  overCap,
  sumBy,
  withholding,
} from "@/domain/field/rules";
import type {
  CashCollection,
  ConflictPayload,
  CustodyEvent,
  CustodyStage,
  Expense,
  FieldSettings,
  FieldVisit,
  Flag,
  L3,
  MinimalContact,
  Outcome,
  PrepareBundle,
  ReceiptItem,
  VisitPurpose,
} from "@/domain/field/types";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { OutboxService } from "../../core/db/outbox";
import { AuditService, type AuditEntry } from "../../core/db/audit";
import { AppError, forbidden } from "../../core/http/errors";
import type { RequestStore, SessionUser } from "../../core/http/context";
import { CryptoService } from "../../core/crypto/crypto.service";
import { StorageService } from "../../core/storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import { genId } from "../auth/auth.rules";
import type * as D from "./field.dto";

type Deps = {
  storage: StorageService;
  outbox: OutboxService;
  crypto: CryptoService;
  notify: NotificationsService;
};
type K = { db: Tx; s: SessionUser; audits: AuditEntry[]; d: Deps };
type VisitRow = typeof fieldVisits.$inferSelect;
type ExpenseRow = typeof fieldExpenses.$inferSelect;
type CashRow = typeof fieldCash.$inferSelect;
type CustodyRow = typeof fieldCustody.$inferSelect;
type ReceiptRow = typeof fieldReceipts.$inferSelect;
type Body = Record<string, unknown>;

import { iso as nowIso } from "../../core/db/ids";
const isSm = (s: SessionUser) => s.roles.includes("staff:service_manager");
const isFinance = (s: SessionUser) => s.roles.includes("staff:finance");
const isExternal = (s: SessionUser) => s.roles.includes("ext:agent");
const audit = (
  k: K,
  action: string,
  entityId: string,
  details: Record<string, unknown> = {},
) => k.audits.push({ action, entity: "field", entityId, after: details });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

import { distanceM, checkinFlags } from "@/domain/field/geo";
import { minimiseContact } from "@/domain/field/minimise";

// ── settings, refs, names ─────────────────────────────────────────────────────────────────────────
const DEFAULTS: FieldSettings = {
  fieldCashEnabled: false, // F-WRK-21: off by default
  radiusM: FIELD_POLICY.radiusM,
  lowAccuracyM: FIELD_POLICY.lowAccuracyM,
  motoCap: FIELD_POLICY.motoCap,
  perVisitFee: {},
  manualConfirmThreshold: POLICY.manualConfirmSecondFinance,
  momoMinPartial: FIELD_POLICY.momoMinPartial,
  travelKmh: FIELD_POLICY.travelKmh,
};
export async function getFieldSettings(db: Tx): Promise<FieldSettings> {
  const [r] = await db
    .select()
    .from(fieldSettings)
    .where(eq(fieldSettings.id, "default"));
  return { ...DEFAULTS, ...(r?.value as Partial<FieldSettings> | undefined) };
}

// PLACEHOLDER(field-visit-number-format) D-7 · PLACEHOLDER(custody-receipt-number-format) · PLACEHOLDER(expense-number-format)
const FORMATS = {
  visit: (n: number) =>
    `FT-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`,
  receipt: (n: number) =>
    `CR-${new Date().getFullYear()}-${String(n).padStart(6, "0")}`,
  expense: (n: number) =>
    `EX-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`,
  cash: (n: number) =>
    `PR-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`,
  incident: (n: number) =>
    `INC-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`,
} as const;
async function nextRef(db: Tx, name: keyof typeof FORMATS) {
  const [r] = await db
    .insert(fieldCounters)
    .values({ name, value: 1 })
    .onConflictDoUpdate({
      target: fieldCounters.name,
      set: { value: dsql`${fieldCounters.value} + 1` },
    })
    .returning({ value: fieldCounters.value });
  return FORMATS[name](r.value);
}
async function nameOf(db: Tx, id: string) {
  const [u] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, id));
  return u?.name ?? "Unknown";
}
async function namesOf(db: Tx, ids: string[]) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.userId, name: users.name })
    .from(users)
    .where(inArray(users.userId, uniq));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ── media: data URLs from the offline outbox → object storage (+ ClamAV scan), served via /api/x_field/media ──────
const MAX_FILE = 25 * 1024 * 1024;
const MEDIA_TYPES = /^(image\/(jpeg|png|webp|heic)|application\/pdf)$/;
function decodeDataUrl(v: unknown) {
  if (typeof v !== "string") return null;
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(v);
  if (!m) return null;
  if (!MEDIA_TYPES.test(m[1]))
    throw new AppError(422, "bad_type", "Only photos and PDFs can be uploaded.");
  const bytes = m[2]
    ? Buffer.from(m[3], "base64")
    : Buffer.from(decodeURIComponent(m[3]));
  if (bytes.length > MAX_FILE)
    throw new AppError(413, "too_large", "This file is too large.");
  return { type: m[1], bytes };
}
const extOf = (type: string) =>
  type === "application/pdf" ? "pdf" : type.split("/")[1];
async function putMedia(k: K, key: string, f: { type: string; bytes: Buffer }) {
  await k.d.storage.putObject(key, f.bytes, f.type);
  await k.d.outbox.add(k.db, { type: "storage.scan", payload: { key, kind: "field" } });
}
/** Stores a data URL under field/<visitId|u-user>/…; returns the key, or null when nothing was sent. */
async function storeMedia(k: K, scope: string, kind: string, v: unknown) {
  const f = decodeDataUrl(v);
  if (!f) return null;
  const key = `field/${scope}/${kind}-${genId("f").slice(2)}.${extOf(f.type)}`;
  await putMedia(k, key, f);
  return key;
}
const mediaUrl = (key: string | null | undefined) =>
  key ? `/api/x_field/media?key=${encodeURIComponent(key)}` : undefined;

// ── guards ────────────────────────────────────────────────────────────────────────────────────────
async function isFieldAgent(db: Tx, id: string) {
  const [a] = await db
    .select({ id: fieldAgents.userId })
    .from(fieldAgents)
    .where(eq(fieldAgents.userId, id));
  return !!a;
}
/** 401 device_revoked when the office signed the devices out, 403 for non-agents. */
async function requireAgent(k: K) {
  const [a] = await k.db
    .select()
    .from(fieldAgents)
    .where(eq(fieldAgents.userId, k.s.id));
  if (!a)
    throw new AppError(403, "not_field_agent", "Field tools are for field agents");
  if (a.revokedAt)
    throw new AppError(401, "device_revoked", "This device was signed out by HEBUZA");
  return a;
}
const requireSm = (s: SessionUser) => {
  if (!isSm(s)) throw forbidden();
};
const requireFinance = (s: SessionUser) => {
  if (!isFinance(s)) throw forbidden();
};

// ── projection ────────────────────────────────────────────────────────────────────────────────────
const CASH_PURPOSES: VisitPurpose[] = ["pickup", "assisted_application"];
const contactOf = (k: K, enc: string): MinimalContact => {
  try {
    return JSON.parse(k.d.crypto.decrypt(enc)) as MinimalContact;
  } catch {
    return { name: "", phone: "", phoneMasked: "•••", language: "rw" };
  }
};
const iso = (t: string) => new Date(t).toISOString();

function project(k: K, v: VisitRow, st: FieldSettings): FieldVisit {
  const ci = v.checkin as
    (NonNullable<FieldVisit["checkin"]> & { photoKey?: string }) | null;
  const co = v.checkout as NonNullable<FieldVisit["checkout"]> | null;
  return {
    id: v.id,
    ref: v.ref,
    caseRef: v.caseRef,
    serviceId: v.serviceId,
    purpose: v.purpose as VisitPurpose,
    status: v.status as FieldVisit["status"],
    version: v.version,
    title_i18n: v.titleI18n as FieldVisit["title_i18n"],
    todo_i18n: v.todoI18n as FieldVisit["todo_i18n"],
    institution: v.institution ?? undefined,
    address: v.address,
    lat: v.lat,
    lng: v.lng,
    windowStart: iso(v.windowStart),
    windowEnd: iso(v.windowEnd),
    priority: v.priority as "normal" | "high",
    checklist: v.checklist as FieldVisit["checklist"],
    evidenceRequired: v.evidenceRequired as FieldVisit["evidenceRequired"],
    client: contactOf(k, v.clientEnc),
    checkin: ci
      ? {
          at: ci.at,
          fix: ci.fix,
          flags: ci.flags,
          reason: ci.reason,
          distanceM: ci.distanceM ?? null,
          photoUrl: mediaUrl(ci.photoKey),
        }
      : undefined,
    checkout: co
      ? {
          at: co.at,
          fix: co.fix,
          outcome: co.outcome,
          notes: co.notes,
          rescheduleTo: co.rescheduleTo,
        }
      : undefined,
    notes: v.notes,
    custodyOpen: v.custodyOpen,
    cashEnabled:
      st.fieldCashEnabled && CASH_PURPOSES.includes(v.purpose as VisitPurpose),
    offerExpiresAt: v.offerExpiresAt ? iso(v.offerExpiresAt) : undefined,
    cancelledReason: v.cancelledReason ?? undefined,
    changed: (v.changed as FieldVisit["changed"]) ?? undefined,
    collectsDocs: v.collectsDocs,
  };
}

/** Kigali calendar day → [start, end) instants. */
function kigaliDay(date: string) {
  const start = new Date(`${date}T00:00:00+02:00`);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

async function ownVisit(k: K, id: string, lock = false) {
  const q = k.db
    .select()
    .from(fieldVisits)
    .where(and(eq(fieldVisits.id, id), eq(fieldVisits.agentUserId, k.s.id)));
  const [v] = lock ? await q.for("update") : await q;
  if (!v) throw new AppError(404, "not_found", "Not found");
  return v;
}

/** Agents read their own visits; SM, finance and internal (non-field) agents read any (evidence pages). */
async function visitReadable(k: K, visitId: string) {
  const [v] = await k.db
    .select()
    .from(fieldVisits)
    .where(eq(fieldVisits.id, visitId));
  if (!v) throw new AppError(404, "not_found", "Not found");
  if (v.agentUserId === k.s.id || isSm(k.s) || isFinance(k.s)) return v;
  if (k.s.roles.includes("staff:agent") && !(await isFieldAgent(k.db, k.s.id)))
    return v;
  throw new AppError(404, "not_found", "Not found");
}

// ── durable op replay ─────────────────────────────────────────────────────────────────────────────
/** Same client_op_id → the stored response (an offline check-in sent twice is stored once). */
async function once<T>(
  k: K,
  b: Body,
  kind: string,
  fn: () => Promise<T>,
): Promise<T> {
  const opId =
    typeof b.client_op_id === "string" && b.client_op_id
      ? b.client_op_id.slice(0, 128)
      : null;
  if (opId) {
    const [hit] = await k.db
      .select()
      .from(fieldOps)
      .where(and(eq(fieldOps.userId, k.s.id), eq(fieldOps.opId, opId)));
    if (hit) return hit.response as T;
  }
  const out = await fn();
  if (opId)
    await k.db
      .insert(fieldOps)
      .values({ opId, userId: k.s.id, kind, response: out as object })
      .onConflictDoNothing();
  return out;
}

// ── conflicts ─────────────────────────────────────────────────────────────────────────────────────
// shortcut: one office version counter per visit stands in for version vectors; per-field vectors if office and agent
// start editing the same visit fields concurrently.
async function conflictIfStale(
  k: K,
  v: VisitRow,
  b: Body,
  mine: Body,
  needsReview: string[],
  autoMerged: string[] = [],
) {
  const office = {
    status: v.status as FieldVisit["status"],
    version: v.version,
    notes: v.notes,
  };
  if (b.resolution === "escalate") {
    const opId = String(b.client_op_id ?? genId("op"));
    const payload: ConflictPayload = { office, mine, autoMerged, needsReview };
    const ins = await k.db
      .insert(fieldConflicts)
      .values({
        opId,
        visitId: v.id,
        kind: String(mine.kind ?? "status"),
        payload,
      })
      .onConflictDoNothing()
      .returning();
    if (ins.length) audit(k, "field.conflict.escalated", v.ref);
    return;
  }
  const base = typeof b.base_version === "number" ? b.base_version : null;
  if (base !== null && base < v.officeVersion && needsReview.length)
    throw new AppError(409, "field_conflict", "Changed by the office", undefined, {
      conflict: {
        office: { ...office, windowStart: iso(v.windowStart) },
        mine,
        autoMerged,
        needsReview,
      } satisfies ConflictPayload,
    });
}
const cancelledConflict = (v: VisitRow, mine: Body) =>
  new AppError(409, "field_conflict", "Visit cancelled", undefined, {
    conflict: {
      office: {
        status: "cancelled",
        cancelledReason: v.cancelledReason ?? undefined,
      },
      mine,
      autoMerged: [],
      needsReview: ["visit_cancelled"],
    },
  });

/** Office-side edit hook (reschedule, readdress, cancel): bumps office_version so stale agent ops need review. */
export async function officeEditVisit(
  k: K,
  id: string,
  patch: {
    windowStart?: string;
    windowEnd?: string;
    address?: string;
    status?: "cancelled";
    cancelledReason?: string;
    note?: string;
  },
) {
  const [v] = await k.db
    .select()
    .from(fieldVisits)
    .where(eq(fieldVisits.id, id))
    .for("update");
  if (!v) throw new AppError(404, "not_found", "Not found");
  const version = v.version + 1;
  const changed = patch.windowStart
    ? { field: "time", from: v.windowStart, at: nowIso() }
    : patch.address
      ? { field: "address", from: v.address, at: nowIso() }
      : v.changed;
  const [out] = await k.db
    .update(fieldVisits)
    .set({
      version,
      officeVersion: version,
      changed,
      updatedAt: nowIso(),
      ...(patch.windowStart && {
        windowStart: patch.windowStart,
        windowEnd: patch.windowEnd ?? patch.windowStart,
      }),
      ...(patch.address && { address: patch.address }),
      ...(patch.status && {
        status: patch.status,
        cancelledReason: patch.cancelledReason ?? null,
      }),
      ...(patch.note && { notes: [...v.notes, `Office: ${patch.note}`] }),
    })
    .where(eq(fieldVisits.id, id))
    .returning();
  audit(k, "field.visit.office_edited", v.ref, { fields: Object.keys(patch) });
  return project(k, out, await getFieldSettings(k.db));
}

// ── agent: me, day plan, visit, prepare ───────────────────────────────────────────────────────────
async function me(k: K) {
  const [[a], name] = await Promise.all([
    k.db.select().from(fieldAgents).where(eq(fieldAgents.userId, k.s.id)),
    nameOf(k.db, k.s.id),
  ]);
  return {
    id: k.s.id,
    name,
    firstName: name.split(" ")[0],
    isFieldAgent: !!a && !a.revokedAt,
    external: isExternal(k.s),
    districts: a?.districts ?? [],
    manager: a?.managerName ?? "",
  };
}
const visitsBetween = (k: K, start: string, end: string) =>
  k.db
    .select()
    .from(fieldVisits)
    .where(
      and(
        eq(fieldVisits.agentUserId, k.s.id),
        gte(fieldVisits.windowStart, start),
        lt(fieldVisits.windowStart, end),
      ),
    )
    .orderBy(asc(fieldVisits.windowStart));

async function dayPlan(k: K, date: string) {
  await requireAgent(k);
  const { start, end } = kigaliDay(date);
  const [rows, st] = await Promise.all([
    visitsBetween(k, start, end),
    getFieldSettings(k.db),
  ]);
  return rows.map((v) => project(k, v, st));
}
async function getVisit(k: K, id: string) {
  await requireAgent(k);
  return project(k, await ownVisit(k, id), await getFieldSettings(k.db));
}
/** Offline bundle: today + tomorrow, minimised contacts, case summaries, settings (F-WRK-20, 72 h TTL). */
async function prepare(k: K, date: string) {
  await requireAgent(k);
  const { start } = kigaliDay(date);
  const [rows, st] = await Promise.all([
    visitsBetween(
      k,
      start,
      new Date(Date.parse(start) + 2 * 86_400_000).toISOString(),
    ),
    getFieldSettings(k.db),
  ]);
  const refs = [...new Set(rows.map((v) => v.caseRef))];
  const cases = refs.length
    ? await k.db
        .select({
          code: applications.code,
          service: applications.serviceName,
          status: applications.status,
        })
        .from(applications)
        .where(inArray(applications.code, refs))
    : [];
  const byCode = new Map(cases.map((c) => [c.code, c]));
  const at = Date.now();
  const bundle: PrepareBundle = {
    date,
    preparedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + FIELD_POLICY.cacheTtlMs).toISOString(),
    visits: rows.map((v) => project(k, v, st)),
    caseSummaries: refs.map((ref) => ({
      ref,
      service: byCode.get(ref)?.service ?? "",
      status: byCode.get(ref)?.status ?? "",
      nextStep: "Field visit",
    })),
    settings: st,
    bytesEstimate: 0,
  };
  bundle.bytesEstimate = JSON.stringify(bundle).length;
  audit(k, "field.bundle.prepared", k.s.id, { date, visits: rows.length });
  return bundle;
}

// ── agent: offers ─────────────────────────────────────────────────────────────────────────────────
async function acceptOffer(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "visit.accept", async () => {
    const v = await ownVisit(k, id, true);
    const st = await getFieldSettings(k.db);
    if (v.status !== "offered") {
      if (v.status === "scheduled") return project(k, v, st);
      throw new AppError(409, "offer_taken", "This visit was given to someone else");
    }
    if (v.offerExpiresAt && Date.parse(v.offerExpiresAt) < Date.now())
      throw new AppError(409, "offer_expired", "This offer expired");
    const [out] = await k.db
      .update(fieldVisits)
      .set({ status: "scheduled", version: v.version + 1, updatedAt: nowIso() })
      .where(eq(fieldVisits.id, id))
      .returning();
    audit(k, "field.visit.accepted", v.ref);
    return project(k, out, st);
  });
}
async function declineOffer(k: K, id: string, b: D.DeclineDto) {
  await requireAgent(k);
  const reason = (b.reason ?? "").trim();
  if (!reason) throw new AppError(422, "reason_required", "Give a reason.");
  const v = await ownVisit(k, id, true);
  if (v.status !== "offered")
    throw new AppError(409, "offer_taken", "This visit was given to someone else");
  const [out] = await k.db
    .update(fieldVisits)
    .set({ status: "declined", version: v.version + 1, updatedAt: nowIso() })
    .where(eq(fieldVisits.id, id))
    .returning();
  audit(k, "field.visit.declined", v.ref, {
    reason,
    note: b.note ?? undefined,
  });
  return project(k, out, await getFieldSettings(k.db));
}

// ── agent: check-in / work / checkout ─────────────────────────────────────────────────────────────
const CLOCK_SKEW_MS = 10 * 60_000;
const GALLERY_MS = 5 * 60_000;
const num = (x: unknown) =>
  x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null;
const atOf = (b: Body) =>
  typeof b.at === "string" && !Number.isNaN(Date.parse(b.at)) ? b.at : nowIso();
const CLIENT_FLAGS: Flag[] = [
  "far",
  "no_gps",
  "low_accuracy",
  "gallery_suspect",
  "clock_skew",
];

async function checkin(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "visit.checkin", async () => {
    const v = await ownVisit(k, id, true);
    if (v.status === "cancelled")
      throw cancelledConflict(v, { kind: "checkin" });
    await conflictIfStale(k, v, b, { kind: "checkin", status: "in_progress" }, [
      "status",
    ]);
    const st = await getFieldSettings(k.db);
    const lat = num(b.lat),
      lng = num(b.lng),
      acc = num(b.accuracy);
    const hasFix = lat !== null && lng !== null;
    // Distance is recomputed here: the device's number is advisory only.
    const dist =
      hasFix && v.lat !== null && v.lng !== null
        ? distanceM({ lat, lng }, { lat: v.lat, lng: v.lng })
        : num(b.distance_m);
    const photoKey = await storeMedia(k, v.id, "checkin", b.photo);
    const flags = new Set<Flag>(
      checkinFlags(
        {
          distanceM: dist,
          accuracyM: acc,
          noGps: !hasFix,
          hasPhoto: !!photoKey,
        },
        st,
      ),
    );
    for (const f of Array.isArray(b.flags) ? (b.flags as Flag[]) : [])
      if (CLIENT_FLAGS.includes(f)) flags.add(f);
    const at = atOf(b);
    if (Math.abs(Date.parse(at) - Date.now()) > CLOCK_SKEW_MS)
      flags.add("clock_skew");
    if (
      b.file_time != null &&
      b.captured_at &&
      Date.parse(String(b.captured_at)) - Number(b.file_time) > GALLERY_MS
    )
      flags.add("gallery_suspect");
    const list = [...flags];
    const [out] = await k.db
      .update(fieldVisits)
      .set({
        status: "in_progress",
        version: v.version + 1,
        updatedAt: nowIso(),
        checkin: {
          at,
          fix: hasFix ? { lat, lng, accuracyM: acc ?? 0, at } : null,
          photoKey: photoKey ?? undefined,
          flags: list,
          reason:
            typeof b.reason === "string" ? b.reason.slice(0, 500) : undefined,
          distanceM: dist,
        },
      })
      .where(eq(fieldVisits.id, id))
      .returning();
    if (list.length)
      await k.db
        .insert(fieldFlagReviews)
        .values({ id: genId("ffr"), visitId: v.id, flags: list });
    audit(k, "field.visit.checked_in", v.ref, { flags: list, distanceM: dist });
    return { visit: project(k, out, st), flags: list };
  });
}

/** Auto-merge: checklist ticks union, notes append; never a conflict. */
async function work(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(
    k,
    b,
    b.notes_append ? "visit.note" : "visit.checklist",
    async () => {
      const v = await ownVisit(k, id, true);
      const ticks = new Map(
        (
          (Array.isArray(b.checklist) ? b.checklist : []) as {
            id: string;
            done: boolean;
          }[]
        ).map((t) => [String(t.id), !!t.done]),
      );
      const checklist = (v.checklist as FieldVisit["checklist"]).map((c) => ({
        ...c,
        done: c.done || !!ticks.get(c.id),
      }));
      const note =
        typeof b.notes_append === "string"
          ? b.notes_append.trim().slice(0, 2000)
          : "";
      const notes =
        note && !v.notes.includes(note) ? [...v.notes, note] : v.notes;
      const [out] = await k.db
        .update(fieldVisits)
        .set({ checklist, notes, updatedAt: nowIso() })
        .where(eq(fieldVisits.id, id))
        .returning();
      if (b.assisted_confirmed)
        audit(k, "field.visit.assisted_confirmed", v.ref);
      return project(k, out, await getFieldSettings(k.db));
    },
  );
}

async function checkout(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "visit.checkout", async () => {
    const v = await ownVisit(k, id, true);
    const outcome = b.outcome as Outcome;
    if (
      !["completed", "partially_done", "client_absent", "rescheduled"].includes(
        outcome,
      )
    )
      throw new AppError(422, "validation", "Pick an outcome.");
    const lat = num(b.lat),
      lng = num(b.lng),
      acc = num(b.accuracy);
    const hasFix = lat !== null && lng !== null;
    if (outcome === "client_absent" && !hasFix && !b.photo)
      throw new AppError(422, "proof_required", "Add your location or a photo.");
    const to = typeof b.reschedule_to === "string" ? b.reschedule_to : null;
    if (
      outcome === "rescheduled" &&
      (!to || Number.isNaN(Date.parse(to)) || Date.parse(to) < Date.now())
    )
      throw new AppError(422, "validation", "Pick a future time.");
    if (v.status === "cancelled")
      throw cancelledConflict(v, { kind: "checkout", outcome });
    const notesIn =
      typeof b.notes === "string" && b.notes.trim()
        ? b.notes.trim().slice(0, 2000)
        : undefined;
    await conflictIfStale(
      k,
      v,
      b,
      { kind: "checkout", outcome, notes: notesIn },
      ["outcome"],
      notesIn ? ["notes"] : [],
    );
    const photoKey = await storeMedia(k, v.id, "checkout", b.photo);
    const at = atOf(b);
    const status =
      outcome === "client_absent"
        ? "missed"
        : outcome === "rescheduled"
          ? "scheduled"
          : "completed";
    const span = Date.parse(v.windowEnd) - Date.parse(v.windowStart);
    const [out] = await k.db
      .update(fieldVisits)
      .set({
        status,
        version: v.version + 1,
        updatedAt: nowIso(),
        notes:
          notesIn && !v.notes.includes(notesIn)
            ? [...v.notes, notesIn]
            : v.notes,
        checkout: {
          at,
          outcome,
          notes: notesIn,
          rescheduleTo: to ?? undefined,
          fix: hasFix ? { lat, lng, accuracyM: acc ?? 0, at } : null,
          photoKey: photoKey ?? undefined,
        },
        ...(outcome === "rescheduled" &&
          to && {
            windowStart: new Date(to).toISOString(),
            windowEnd: new Date(Date.parse(to) + span).toISOString(),
            checkin: null,
          }),
      })
      .where(eq(fieldVisits.id, id))
      .returning();
    audit(k, "field.visit.checked_out", v.ref, { outcome });
    if (outcome === "client_absent") {
      const c = contactOf(k, v.clientEnc);
      if (c.phone)
        await k.d.outbox.add(k.db, {
          type: "auth.sms",
          queue: "default",
          payload: k.d.crypto.seal(
            {
              to: c.phone,
              text: `HEBUZA: our field agent came for visit ${v.ref} but could not reach you. We will contact you to reschedule.`,
            },
            ["text"],
          ),
        });
    }
    return project(k, out, await getFieldSettings(k.db));
  });
}

// ── agent: scans ──────────────────────────────────────────────────────────────────────────────────
async function uploadScan(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "scan.upload", async () => {
    const v = await ownVisit(k, id);
    const pages = (Array.isArray(b.pages) ? b.pages : []) as {
      data?: unknown;
    }[];
    if (!pages.length) throw new AppError(422, "bad_type", "Add at least one page.");
    const decoded = pages.map((p) => decodeDataUrl(p.data));
    if (decoded.some((x) => !x))
      throw new AppError(422, "bad_type", "Only photos and PDFs can be uploaded.");
    const files = decoded.filter((x): x is NonNullable<typeof x> => !!x);
    const bytes = files.reduce((n, x) => n + x.bytes.length, 0);
    if (bytes > MAX_FILE)
      throw new AppError(413, "too_large", "This scan is too large.");
    const docId = genId("doc");
    const pageKeys: { key: string; type: string }[] = [];
    for (const [i, f] of files.entries()) {
      const key = `field/${v.id}/scan-${docId.slice(4)}-${i}.${extOf(f.type)}`;
      await putMedia(k, key, f);
      pageKeys.push({ key, type: f.type });
    }
    const label =
      String(b.label ?? "Scan")
        .trim()
        .slice(0, 255) || "Scan";
    await k.db
      .insert(fieldScans)
      .values({
        id: docId,
        visitId: v.id,
        label,
        pages: pages.length,
        bytes,
        pageKeys,
        status: "scanning",
        byUserId: k.s.id,
      });
    await k.d.outbox.add(k.db, {
      type: "field.scan.assemble",
      payload: { scanId: docId },
    });
    audit(k, "field.scan.uploaded", v.ref, {
      scan: docId,
      pages: pages.length,
    });
    return {
      ref: docId,
      document_id: docId,
      pdf_url: `/api/x_field/scans/${docId}/pdf`,
      pages: pages.length,
      scan_status: "scanning" as const,
    };
  });
}
async function listScans(k: K, visitId: string) {
  await visitReadable(k, visitId);
  const rows = await k.db
    .select()
    .from(fieldScans)
    .where(eq(fieldScans.visitId, visitId))
    .orderBy(asc(fieldScans.at));
  return rows.map((r) => ({
    id: r.id,
    visitId: r.visitId,
    label: r.label,
    pages: r.pages,
    bytes: r.bytes,
    status: r.status as "scanning" | "available",
    at: iso(r.at),
  }));
}
async function scanPdf(k: K, scanId: string) {
  const [r] = await k.db
    .select()
    .from(fieldScans)
    .where(eq(fieldScans.id, scanId));
  if (!r) throw new AppError(404, "not_found", "Not found");
  await visitReadable(k, r.visitId);
  if (r.scanStatus === "infected") throw new AppError(410, "quarantined", "This file was quarantined.");
  const key = r.pdfKey ?? r.pageKeys[0]?.key;
  if (!key) throw new AppError(404, "not_found", "Not found");
  return k.d.storage.presignGet(key, `${r.label}.pdf`);
}

// ── agent: receipts + custody ─────────────────────────────────────────────────────────────────────
const receiptOut = (r: ReceiptRow) => ({
  id: r.id,
  ref: r.ref,
  localRef: r.localRef,
  visitId: r.visitId,
  direction: r.direction as "collected" | "returned",
  items: r.items as ReceiptItem[],
  clientName: r.clientName,
  signature: r.signature as {
    method: "drawn" | "typed" | "otp";
    signedAt: string;
    locale: L3;
  },
  conditionNotes: r.conditionNotes ?? undefined,
  pdfUrl: `/api/x_field/receipts/${r.id}/pdf`,
  sha256: r.sha256,
  supersedesId: r.supersedesId ?? undefined,
  status: "synced" as const,
  createdAt: iso(r.createdAt),
  agentName: r.agentName,
});

async function pushCustody(k: K, c: CustodyRow, e: CustodyEvent) {
  const events = [...c.events, e];
  await k.db
    .update(fieldCustody)
    .set({ events, stage: e.stage })
    .where(eq(fieldCustody.receiptRef, c.receiptRef));
  return { ...c, events, stage: e.stage };
}
const custodyOut = (c: CustodyRow) => ({
  ref: c.receiptRef,
  receiptRef: c.receiptRef,
  visitId: c.visitId,
  items: c.items,
  events: c.events as CustodyEvent[],
});

async function otpVerifiedRecently(k: K, visitId: string) {
  const [o] = await k.db
    .select()
    .from(fieldOtps)
    .where(eq(fieldOtps.visitId, visitId));
  // Offline OTP receipts replay later; accept a verification from the last day.
  return (
    !!o && o.attempts === -1 && Date.now() - Date.parse(o.sentAt) < 86_400_000
  );
}

async function createReceipt(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "receipt.create", async () => {
    const v = await ownVisit(k, id, true);
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((i) => i as Partial<ReceiptItem>)
      .filter((i) => typeof i.label === "string" && i.label.trim())
      .map((i) => ({
        label: String(i.label).trim().slice(0, 255),
        docKind: String(i.docKind ?? "other").slice(0, 64),
        original: !!i.original,
        pages: Math.max(0, Math.trunc(Number(i.pages) || 0)),
      }));
    if (!items.length) throw new AppError(422, "no_items", "Add at least one item.");
    const direction = b.direction === "returned" ? "returned" : "collected";
    const method = ["drawn", "typed", "otp"].includes(
      String(b.signature_method),
    )
      ? String(b.signature_method)
      : "drawn";
    if (method === "otp" && !(await otpVerifiedRecently(k, v.id)))
      throw new AppError(422, "invalid_code", "Verify the client's code first.");
    const clientName = String(b.client_name ?? "")
      .trim()
      .slice(0, 255);
    if (!clientName) throw new AppError(422, "validation", "Client name is required.");
    const signedAt =
      typeof b.signed_at === "string" && !Number.isNaN(Date.parse(b.signed_at))
        ? b.signed_at
        : nowIso();
    const locale = ["rw", "en", "fr"].includes(String(b.locale_shown))
      ? String(b.locale_shown)
      : "rw";
    let supersedesId: string | null = null;
    if (typeof b.supersedes_id === "string" && b.supersedes_id) {
      const [prev] = await k.db
        .select({ id: fieldReceipts.id })
        .from(fieldReceipts)
        .where(
          and(
            eq(fieldReceipts.visitId, v.id),
            or(
              eq(fieldReceipts.id, b.supersedes_id),
              eq(fieldReceipts.ref, b.supersedes_id),
            ),
          ),
        );
      if (!prev) throw new AppError(404, "not_found", "The receipt being corrected was not found.");
      supersedesId = prev.id;
    }
    const ref = await nextRef(k.db, "receipt");
    const signatureKey = await storeMedia(
      k,
      v.id,
      "signature",
      b.signature_png,
    );
    await storeMedia(k, v.id, "items", b.items_photo);
    const signature = {
      method,
      signedAt,
      locale,
      typedName:
        typeof b.typed_name === "string"
          ? b.typed_name.slice(0, 255)
          : undefined,
      consentTextId:
        typeof b.consent_text_id === "string"
          ? b.consent_text_id.slice(0, 64)
          : undefined,
    };
    const agentName = await nameOf(k.db, k.s.id);
    const [r] = await k.db
      .insert(fieldReceipts)
      .values({
        id: ref.toLowerCase(),
        ref,
        localRef: String(b.local_ref ?? b.client_op_id ?? ref).slice(0, 64),
        visitId: v.id,
        direction,
        items,
        clientName,
        signature,
        signatureKey,
        conditionNotes:
          typeof b.condition_notes === "string"
            ? b.condition_notes.slice(0, 2000)
            : null,
        sha256: sha(
          `${ref}:${JSON.stringify(items)}:${clientName}:${signedAt}`,
        ),
        supersedesId,
        agentUserId: k.s.id,
        agentName,
      })
      .returning();
    const originals = items.filter((i) => i.original).length;
    if (direction === "collected" && originals) {
      await k.db
        .insert(fieldCustody)
        .values({
          receiptRef: ref,
          visitId: v.id,
          items: originals,
          stage: "with_agent",
          events: [{ stage: "with_agent", at: signedAt, by: agentName, ref }],
        });
      await k.db
        .update(fieldVisits)
        .set({ custodyOpen: v.custodyOpen + originals, updatedAt: nowIso() })
        .where(eq(fieldVisits.id, v.id));
    }
    if (direction === "returned") {
      await k.db
        .update(fieldVisits)
        .set({
          custodyOpen: Math.max(0, v.custodyOpen - originals),
          updatedAt: nowIso(),
        })
        .where(eq(fieldVisits.id, v.id));
      const [open] = await k.db
        .select()
        .from(fieldCustody)
        .where(
          and(
            eq(fieldCustody.visitId, v.id),
            ne(fieldCustody.stage, "returned_to_client"),
            ne(fieldCustody.stage, "deposited"),
          ),
        )
        .orderBy(asc(fieldCustody.createdAt))
        .limit(1)
        .for("update");
      if (open)
        await pushCustody(k, open, {
          stage: "returned_to_client",
          at: signedAt,
          by: agentName,
          ref,
        });
    }
    await k.d.outbox.add(k.db, {
      type: "field.receipt.pdf",
      payload: { receiptId: r.id },
    });
    audit(
      k,
      supersedesId ? "field.receipt.superseded" : "field.receipt.signed",
      ref,
      { visit: v.ref, direction, items: items.length },
    );
    return receiptOut(r);
  });
}
async function listReceipts(k: K, visitId: string) {
  await visitReadable(k, visitId);
  return (
    await k.db
      .select()
      .from(fieldReceipts)
      .where(eq(fieldReceipts.visitId, visitId))
      .orderBy(asc(fieldReceipts.createdAt))
  ).map(receiptOut);
}
async function receiptPdf(k: K, id: string) {
  const [r] = await k.db
    .select()
    .from(fieldReceipts)
    .where(eq(fieldReceipts.id, id));
  if (!r) throw new AppError(404, "not_found", "Not found");
  await visitReadable(k, r.visitId);
  if (!r.pdfKey)
    throw new AppError(409, "not_ready", "The receipt PDF is still being made. Try again in a moment.");
  return k.d.storage.presignGet(r.pdfKey, `${r.ref}.pdf`);
}

async function custodyAction(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "custody.handover", async () => {
    const v = await ownVisit(k, id, true);
    const byRef = typeof b.receipt_ref === "string" ? b.receipt_ref : null;
    const [c] = await k.db
      .select()
      .from(fieldCustody)
      .where(
        byRef
          ? and(
              eq(fieldCustody.receiptRef, byRef),
              eq(fieldCustody.visitId, v.id),
            )
          : eq(fieldCustody.visitId, v.id),
      )
      .orderBy(asc(fieldCustody.createdAt))
      .limit(1)
      .for("update");
    if (!c)
      throw new AppError(409, "nothing_in_custody", "Nothing is in your custody for this visit.");
    if (
      ["returned_to_client", "deposited", "lost", "damaged"].includes(c.stage)
    )
      throw new AppError(409, "nothing_in_custody", "This custody chain is closed.");
    const action =
      b.action === "deposit"
        ? "deposit"
        : b.action === "return"
          ? "return"
          : "handover";
    const stage: CustodyStage =
      action === "deposit"
        ? "deposited"
        : action === "return"
          ? "returned_to_client"
          : "with_office";
    const evidenceKey = await storeMedia(k, v.id, "custody", b.evidence);
    const out = await pushCustody(k, c, {
      stage,
      at: nowIso(),
      by: await nameOf(k.db, k.s.id),
      ref:
        typeof b.ref === "string"
          ? b.ref.slice(0, 128)
          : (evidenceKey ?? undefined),
    });
    if (stage !== "with_office")
      await k.db
        .update(fieldVisits)
        .set({
          custodyOpen: Math.max(0, v.custodyOpen - c.items),
          updatedAt: nowIso(),
        })
        .where(eq(fieldVisits.id, v.id));
    audit(
      k,
      `field.custody.${action === "deposit" ? "deposited" : action === "return" ? "returned" : "handover"}`,
      c.receiptRef,
    );
    return custodyOut(out);
  });
}
async function listCustody(k: K, visitId: string) {
  await visitReadable(k, visitId);
  return (
    await k.db
      .select()
      .from(fieldCustody)
      .where(eq(fieldCustody.visitId, visitId))
      .orderBy(asc(fieldCustody.createdAt))
  ).map(custodyOut);
}

async function createIncident(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "incident.create", async () => {
    const v = await ownVisit(k, id, true);
    const desc_ = String(b.description ?? "").trim();
    if (desc_.length < 10 || desc_.length > 1000)
      throw new AppError(422, "validation", "Describe what happened (10–1000 characters).");
    const type = [
      "lost",
      "damaged",
      "client_refused",
      "safety",
      "other",
    ].includes(String(b.type))
      ? String(b.type)
      : "other";
    await storeMedia(k, v.id, "incident", b.photo);
    const ref = await nextRef(k.db, "incident");
    const byName = await nameOf(k.db, k.s.id);
    const [i] = await k.db
      .insert(fieldIncidents)
      .values({
        id: genId("inc"),
        ref,
        visitId: v.id,
        type,
        description: desc_,
        byUserId: k.s.id,
        byName,
      })
      .returning();
    if (type === "lost" || type === "damaged") {
      const open = await k.db
        .select()
        .from(fieldCustody)
        .where(
          and(
            eq(fieldCustody.visitId, v.id),
            inArray(fieldCustody.stage, ["with_agent", "with_office"]),
          ),
        )
        .for("update");
      for (const c of open)
        await pushCustody(k, c, { stage: type, at: nowIso(), by: byName });
    }
    // WRK custody incident: the client hears about it (SMS + in-app, their language); the manager follows up below.
    if (type === "lost" || type === "damaged") {
      const [cl] = await k.db.select({ id: applications.clientId, lang: users.language }).from(applications)
        .leftJoin(users, eq(users.userId, applications.clientId)).where(eq(applications.code, v.caseRef));
      if (cl?.id) {
        const msg = CUSTODY_SMS[(cl.lang as "rw" | "en" | "fr") ?? "rw"] ?? CUSTODY_SMS.rw;
        await k.d.notify.notify(k.db, {
          userId: cl.id, kind: "field.custody_incident", channels: ["sms"],
          title: msg.title, body: msg.body.replace("{ref}", v.caseRef), link: `/requests/${v.caseRef}`,
          data: { type: "wrk.custody_incident", vars: { ref: v.caseRef } },
        });
      }
    }
    const [a] = await k.db
      .select({ m: fieldAgents.managerId })
      .from(fieldAgents)
      .where(eq(fieldAgents.userId, k.s.id));
    if (a?.m)
      await k.d.notify.notify(k.db, {
        userId: a.m,
        kind: "field.incident",
        title: `Field incident on ${v.ref}`,
        body: desc_.slice(0, 200),
        link: `/ops/field?visit=${v.id}`,
      });
    audit(k, "field.incident.created", v.ref, { type });
    return {
      ref: i.ref,
      id: i.id,
      visitId: v.id,
      type,
      description: desc_,
      at: iso(i.at),
      by: byName,
    };
  });
}

// ── agent: MoMo (online only; money lives in `payments`) ──────────────────────────────────────────
const invoiceNo = (code: string) => `INV-${code}`;
const momoState = (status: string | undefined, cancelled: boolean) =>
  cancelled
    ? "cancelled"
    : status === "paid" || status === "succeeded"
      ? "confirmed"
      : !status || status === "pending" || status === "pending_verification"
        ? "pending_provider"
        : status === "expired"
          ? "expired"
          : "failed";

/** Neutral wording for a lost/damaged document in our custody (no blame, a clear next step). */
const CUSTODY_SMS = {
  en: { title: "An update about your documents", body: "HEBUZA: there is an issue with a document we are holding for request {ref}. Our team will contact you today with the next steps. Sorry for the inconvenience." },
  rw: { title: "Amakuru ku nyandiko zawe", body: "HEBUZA: hari ikibazo ku nyandiko tubitse ku busabe {ref}. Itsinda ryacu riraguhamagara uyu munsi rikubwire ibikurikiraho. Tubiseguye." },
  fr: { title: "Information sur vos documents", body: "HEBUZA : un document que nous détenons pour la demande {ref} pose problème. Notre équipe vous contacte aujourd'hui pour la suite. Toutes nos excuses." },
};
async function visitInvoices(k: K, id: string) {
  await requireAgent(k);
  const v = await ownVisit(k, id);
  // The finance case invoice is the balance of record; before finance has invoiced the case, its payable amount.
  const fin = (await clientInvoicesForCase(k.db, v.caseRef))[0];
  if (fin) return fin.balanceDue > 0 ? [{ number: invoiceNo(v.caseRef), balance_due: fin.balanceDue }] : [];
  const rows = await k.db
    .select({
      code: applications.code,
      amount: applications.paymentAmount,
      status: applications.paymentStatus,
    })
    .from(applications)
    .where(eq(applications.code, v.caseRef));
  return rows
    .filter((r) => (r.amount ?? 0) > 0 && r.status !== "paid")
    .map((r) => ({ number: invoiceNo(r.code), balance_due: r.amount ?? 0 }));
}
async function startMomo(k: K, id: string, b: D.MomoDto) {
  await requireAgent(k);
  const v = await ownVisit(k, id);
  const d = b.msisdn.replace(/\D/g, "").replace(/^250/, "0");
  if (!/^07[2389]\d{7}$/.test(d))
    throw new AppError(422, "bad_msisdn", "Enter an MTN or Airtel number.");
  const st = await getFieldSettings(k.db);
  if (!Number.isInteger(b.amount) || b.amount < st.momoMinPartial)
    throw new AppError(422, "validation", `Minimum ${st.momoMinPartial} RWF.`);
  if (b.invoice_no.replace(/^INV-/, "").trim().toUpperCase() !== v.caseRef)
    throw new AppError(404, "not_found", "Invoice not found for this visit.");
  // Validated here; PaymentsService reserves → prompts → settles outside this tx.
  return { agentId: k.s.id, visitId: v.id, code: v.caseRef, invoiceNo: b.invoice_no, phone: `250${d.slice(1)}`, amount: b.amount };
}
async function ownMomo(k: K, txId: string) {
  const [m] = await k.db
    .select()
    .from(fieldMomo)
    .where(eq(fieldMomo.transactionId, txId));
  if (!m || (m.agentUserId !== k.s.id && !isFinance(k.s))) throw new AppError(404, "not_found", "Not found");
  // RLS hides `payments` from agents: the owner reads status through the definer (migration 0013); finance reads directly.
  const [p] = isFinance(k.s)
    ? await k.db.select({ status: payments.status }).from(payments).where(eq(payments.transactionId, txId))
    : await k.db.execute<{ status: string | null }>(dsql`select field_momo_status(${txId}) as status`);
  return { m, status: p?.status ?? undefined };
}
async function momoStatus(k: K, txId: string) {
  const { m, status } = await ownMomo(k, txId);
  const state = momoState(status, !!m.cancelledAt);
  return {
    id: txId,
    state,
    receipt:
      state === "confirmed" ? `RCPT-${txId.slice(-8).toUpperCase()}` : null,
  };
}
async function cancelMomo(k: K, txId: string) {
  const { m, status } = await ownMomo(k, txId);
  if (momoState(status, false) === "pending_provider" && !m.cancelledAt) {
    // The agent stops waiting; a late approval on the phone still settles through the webhook (never lost money).
    await k.db
      .update(fieldMomo)
      .set({ cancelledAt: nowIso() })
      .where(eq(fieldMomo.transactionId, txId));
    return { id: txId, state: "cancelled" };
  }
  const state = momoState(status, !!m.cancelledAt);
  if (state === "confirmed") throw new AppError(409, "settled", "This payment has already been confirmed.");
  return { id: txId, state };
}

// ── agent: client OTP ─────────────────────────────────────────────────────────────────────────────
const OTP_TTL_MS = 10 * 60_000;
const OTP_RESEND_S = 60;
const OTP_MAX_ATTEMPTS = 5;
async function sendOtp(k: K, id: string) {
  await requireAgent(k);
  const v = await ownVisit(k, id);
  const [prev] = await k.db
    .select()
    .from(fieldOtps)
    .where(eq(fieldOtps.visitId, v.id));
  if (prev && Date.now() - Date.parse(prev.sentAt) < OTP_RESEND_S * 1000)
    throw new AppError(429, "rate_limited", "Wait before sending another code.", undefined, {
      retryAfterSeconds: OTP_RESEND_S,
    });
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = {
    visitId: v.id,
    codeHash: sha(`${v.id}:${code}`),
    attempts: 0,
    expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    sentAt: nowIso(),
  };
  await k.db
    .insert(fieldOtps)
    .values(row)
    .onConflictDoUpdate({ target: fieldOtps.visitId, set: row });
  const client = contactOf(k, v.clientEnc);
  if (!client.phone)
    throw new AppError(422, "no_phone", "The client has no phone number on file.");
  await k.d.outbox.add(k.db, {
    type: "auth.sms",
    queue: "critical",
    payload: k.d.crypto.seal(
      {
        to: client.phone,
        text: `HEBUZA code for visit ${v.ref}: ${code}. Valid 10 minutes.`,
      },
      ["text"],
    ),
  });
  audit(k, "field.otp.sent", v.ref);
  return { sentTo: client.phoneMasked, resendInS: OTP_RESEND_S };
}
async function verifyOtp(k: K, id: string, code: string) {
  await requireAgent(k);
  const v = await ownVisit(k, id);
  const [o] = await k.db
    .select()
    .from(fieldOtps)
    .where(eq(fieldOtps.visitId, v.id))
    .for("update");
  if (
    !o ||
    Date.parse(o.expiresAt) < Date.now() ||
    o.attempts >= OTP_MAX_ATTEMPTS ||
    o.attempts < 0
  )
    throw new AppError(422, "invalid_code", "This code is wrong or expired.");
  if (o.codeHash !== sha(`${v.id}:${code.trim()}`)) {
    // Wrong code: the attempt must persist although the request fails, so it is the transaction's only write.
    await k.db
      .update(fieldOtps)
      .set({ attempts: o.attempts + 1 })
      .where(eq(fieldOtps.visitId, v.id));
    return { verified: false as const };
  }
  // Verified: keep the row as proof for a following OTP-signed receipt (attempts = -1 marks success).
  await k.db
    .update(fieldOtps)
    .set({ attempts: -1 })
    .where(eq(fieldOtps.visitId, v.id));
  audit(k, "field.otp.verified", v.ref);
  return { verified: true as const };
}

// ── cash (F-WRK-21, F-FIN-12) ─────────────────────────────────────────────────────────────────────
const cashOut = (c: CashRow): CashCollection & { ref: string } => ({
  ref: c.provisionalNo,
  id: c.id,
  visitId: c.visitId,
  visitRef: c.visitRef,
  agentName: c.agentName,
  invoiceNo: c.invoiceNo,
  amount: c.amountRwf,
  provisionalNo: c.provisionalNo,
  status: c.status as CashCollection["status"],
  recordedAt: iso(c.recordedAt),
  depositRef: c.depositRef ?? undefined,
  confirmations: c.confirmations.map((x) => ({ by: x.by, at: x.at })),
});

async function recordCash(k: K, id: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "cash.record", async () => {
    const v = await ownVisit(k, id);
    const st = await getFieldSettings(k.db);
    if (
      !st.fieldCashEnabled ||
      !CASH_PURPOSES.includes(v.purpose as VisitPurpose)
    )
      throw new AppError(403, "cash_disabled", "Cash collection is off.");
    const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount <= 0)
      throw new AppError(422, "validation", "Enter a whole RWF amount.");
    const invoice = String(b.invoice_no ?? "")
      .trim()
      .slice(0, 64);
    if (!invoice) throw new AppError(422, "validation", "Invoice number is required.");
    await storeMedia(k, v.id, "cash-signature", b.signature);
    const provisionalNo = await nextRef(k.db, "cash");
    const [c] = await k.db
      .insert(fieldCash)
      .values({
        id: genId("cash"),
        provisionalNo,
        visitId: v.id,
        visitRef: v.ref,
        agentUserId: k.s.id,
        agentName: await nameOf(k.db, k.s.id),
        invoiceNo: invoice,
        amountRwf: amount,
        status: "recorded",
      })
      .returning();
    audit(k, "field.cash.recorded", provisionalNo, { amount, invoice });
    return cashOut(c);
  });
}
async function depositCash(k: K, ref: string, b: Body) {
  await requireAgent(k);
  return once(k, b, "cash.deposit", async () => {
    const [c] = await k.db
      .select()
      .from(fieldCash)
      .where(
        and(
          or(eq(fieldCash.provisionalNo, ref), eq(fieldCash.id, ref)),
          eq(fieldCash.agentUserId, k.s.id),
        ),
      )
      .for("update");
    if (!c) throw new AppError(404, "not_found", "Not found");
    if (c.status !== "recorded")
      throw new AppError(409, "conflict", "This cash was already deposited.");
    const depositRef = String(b.deposit_ref ?? "")
      .trim()
      .slice(0, 128);
    if (!depositRef)
      throw new AppError(422, "validation", "Deposit reference is required.");
    await storeMedia(k, c.visitId, "cash-slip", b.slip);
    const [out] = await k.db
      .update(fieldCash)
      .set({ status: "deposited", depositRef })
      .where(eq(fieldCash.id, c.id))
      .returning();
    audit(k, "field.cash.deposited", c.provisionalNo, { depositRef });
    return cashOut(out);
  });
}
async function listCash(k: K) {
  const office = isFinance(k.s) || isSm(k.s);
  const rows = await k.db
    .select()
    .from(fieldCash)
    .where(office ? undefined : eq(fieldCash.agentUserId, k.s.id))
    .orderBy(desc(fieldCash.recordedAt))
    .limit(500);
  return rows.map(cashOut);
}
async function financeCash(k: K) {
  requireFinance(k.s);
  const rows = await k.db
    .select()
    .from(fieldCash)
    .where(ne(fieldCash.status, "confirmed"))
    .orderBy(asc(fieldCash.recordedAt))
    .limit(500);
  const t = Date.now();
  return rows.map((c) => {
    const o = cashOut(c);
    return {
      ...o,
      ageMs: t - Date.parse(o.recordedAt),
      escalated: cashEscalated(o, t),
      needsTwo: cashNeedsTwo(o.amount),
    };
  });
}
async function confirmCashEntry(k: K, id: string, b: D.ConfirmCashDto) {
  requireFinance(k.s);
  if (!b.reason.trim()) throw new AppError(422, "reason_required", "Give a reason.");
  const [c] = await k.db
    .select()
    .from(fieldCash)
    .where(eq(fieldCash.id, id))
    .for("update");
  if (!c) throw new AppError(404, "not_found", "Not found");
  if (c.agentUserId === k.s.id)
    throw new AppError(409, "same_approver", "You can't confirm cash you collected.");
  const r = confirmCash(
    {
      amount: c.amountRwf,
      status: c.status as CashCollection["status"],
      confirmations: c.confirmations,
    },
    k.s.id,
  );
  if ("error" in r)
    throw new AppError(409, r.error === "same_approver" ? "same_approver" : "conflict", r.error === "same_approver"
        ? "A second finance person must confirm."
        : "Only deposited cash can be confirmed.");
  const confirmations = [
    ...c.confirmations,
    {
      by: k.s.id,
      at: nowIso(),
      reason: b.reason.trim().slice(0, 500),
      evidenceId: b.evidence_id ?? undefined,
    },
  ];
  const [out] = await k.db
    .update(fieldCash)
    .set({ status: r.status, confirmations })
    .where(eq(fieldCash.id, id))
    .returning();
  audit(k, "field.cash.confirmed", c.provisionalNo, {
    reason: b.reason,
    done: r.done,
    amount: c.amountRwf,
  });
  return cashOut(out);
}

/** Cron: unconfirmed cash older than 48 h escalates once to every active finance user (F-WRK-21). */
export async function escalateCash(db: Tx, notify: NotificationsService) {
  const cutoff = new Date(
    Date.now() - FIELD_POLICY.cashEscalationMs,
  ).toISOString();
  const rows = await db
    .update(fieldCash)
    .set({ escalatedAt: nowIso() })
    .where(
      and(
        ne(fieldCash.status, "confirmed"),
        lt(fieldCash.recordedAt, cutoff),
        isNull(fieldCash.escalatedAt),
      ),
    )
    .returning();
  if (!rows.length) return 0;
  const fin = await db
    .select({ id: users.userId })
    .from(users)
    .where(and(holdsRole("staff:finance"), eq(users.isActive, true)));
  for (const c of rows)
    for (const f of fin)
      await notify.notify(db, {
        userId: f.id,
        kind: "field.cash.escalated",
        title: `Cash ${c.provisionalNo} unconfirmed for 48 h`,
        body: `${c.amountRwf} RWF collected by ${c.agentName}.`,
        link: "/finance/field",
      });
  return rows.length;
}

// ── expenses (L1 SM, L2 finance; SoD by user id in @/domain/field/rules) ────────────────────
const expenseOut = (x: ExpenseRow): Expense => ({
  id: x.id,
  ref: x.ref,
  localRef: x.localRef,
  visitId: x.visitId,
  visitRef: x.visitRef,
  category: x.category as Expense["category"],
  amount: x.amountRwf,
  receiptUrl: mediaUrl(x.receiptKey),
  noReceiptReason: x.noReceiptReason ?? undefined,
  note: x.note ?? undefined,
  state: x.state as Expense["state"],
  flags: x.flags as Flag[],
  trail: x.trail as Expense["trail"],
  payoutBatch: x.payoutBatch ?? undefined,
  createdAt: iso(x.createdAt),
  claimant: x.claimantId,
  claimantName: x.claimantName,
});

async function myExpenses(k: K) {
  await requireAgent(k);
  return (
    await k.db
      .select()
      .from(fieldExpenses)
      .where(eq(fieldExpenses.claimantId, k.s.id))
      .orderBy(desc(fieldExpenses.createdAt))
      .limit(500)
  ).map(expenseOut);
}
async function createExpense(k: K, b: Body) {
  await requireAgent(k);
  return once(k, b, "expense.create", async () => {
    const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount <= 0)
      throw new AppError(422, "amount_invalid", "Enter a whole RWF amount.");
    const category = String(b.category);
    if (
      !(FIELD_POLICY.expenseCategories as readonly string[]).includes(category)
    )
      throw new AppError(422, "validation", "Pick a category.");
    const reason =
      typeof b.no_receipt_reason === "string"
        ? b.no_receipt_reason.trim().slice(0, 500)
        : "";
    if (!b.receipt && !reason)
      throw new AppError(422, "validation", "Add a receipt photo or say why there is none.");
    const visit =
      typeof b.visit_id === "string" && b.visit_id
        ? await ownVisit(k, b.visit_id)
        : null;
    const st = await getFieldSettings(k.db);
    const receiptKey = await storeMedia(
      k,
      visit?.id ?? `u-${k.s.id}`,
      "expense",
      b.receipt,
    );
    const ref = await nextRef(k.db, "expense");
    const name = await nameOf(k.db, k.s.id);
    const over =
      category === "moto" ? amount > st.motoCap : overCap(category, amount);
    const [x] = await k.db
      .insert(fieldExpenses)
      .values({
        id: ref.toLowerCase(),
        ref,
        localRef: String(b.local_ref ?? b.client_op_id ?? ref).slice(0, 64),
        visitId: visit?.id ?? null,
        visitRef: visit?.ref ?? null,
        category,
        amountRwf: amount,
        receiptKey,
        noReceiptReason: b.receipt ? null : reason,
        note:
          typeof b.note === "string"
            ? b.note.trim().slice(0, 1000) || null
            : null,
        state: "submitted",
        flags: over ? ["over_cap"] : [],
        trail: [{ step: "submitted", by: name, byId: k.s.id, at: nowIso() }],
        claimantId: k.s.id,
        claimantName: name,
      })
      .returning();
    audit(k, "field.expense.submitted", ref, { amount, category });
    return expenseOut(x);
  });
}
async function withdrawExpense(k: K, id: string) {
  await requireAgent(k);
  const [x] = await k.db
    .select()
    .from(fieldExpenses)
    .where(and(eq(fieldExpenses.id, id), eq(fieldExpenses.claimantId, k.s.id)))
    .for("update");
  if (!x) throw new AppError(404, "not_found", "Not found");
  if (x.state !== "submitted")
    throw new AppError(409, "already_decided", "This claim was already decided.");
  const [out] = await k.db
    .update(fieldExpenses)
    .set({ state: "withdrawn", updatedAt: nowIso() })
    .where(eq(fieldExpenses.id, id))
    .returning();
  audit(k, "field.expense.withdrawn", x.ref);
  return expenseOut(out);
}
async function approvalQueue(k: K, level: 1 | 2) {
  if (level === 1) requireSm(k.s);
  else requireFinance(k.s);
  const rows = await k.db
    .select()
    .from(fieldExpenses)
    .where(eq(fieldExpenses.state, level === 1 ? "submitted" : "sm_approved"))
    .orderBy(asc(fieldExpenses.createdAt))
    .limit(500);
  const vids = [
    ...new Set(rows.map((r) => r.visitId).filter((v): v is string => !!v)),
  ];
  const [visits, st] = await Promise.all([
    vids.length
      ? k.db.select().from(fieldVisits).where(inArray(fieldVisits.id, vids))
      : Promise.resolve([] as VisitRow[]),
    getFieldSettings(k.db),
  ]);
  const vm = new Map(visits.map((v) => [v.id, project(k, v, st)]));
  return rows.map((x) => ({
    ...expenseOut(x),
    visit: x.visitId ? (vm.get(x.visitId) ?? null) : null,
  }));
}
async function decideExpenseClaim(k: K, id: string, b: D.DecisionDto) {
  if (b.level === 1) requireSm(k.s);
  else requireFinance(k.s);
  const [x] = await k.db
    .select()
    .from(fieldExpenses)
    .where(eq(fieldExpenses.id, id))
    .for("update");
  if (!x) throw new AppError(404, "not_found", "Not found");
  const trail = x.trail as Expense["trail"];
  const r = decideExpense(
    { state: x.state as Expense["state"], claimant: x.claimantId, trail },
    {
      level: b.level,
      decision: b.decision,
      by: k.s.id,
      reason: b.reason ?? undefined,
    },
  );
  if ("error" in r)
    throw new AppError(r.error === "reason_required" ? 422 : 409, r.error, r.error === "sod_violation"
        ? "A different person must decide this step."
        : r.error);
  const step = {
    step: b.level === 1 ? "sm" : "finance",
    by: await nameOf(k.db, k.s.id),
    byId: k.s.id,
    at: nowIso(),
    decision: b.decision,
    reason: b.reason ?? undefined,
  } as const;
  const [out] = await k.db
    .update(fieldExpenses)
    .set({ state: r.state, trail: [...trail, step], updatedAt: nowIso() })
    .where(eq(fieldExpenses.id, id))
    .returning();
  audit(
    k,
    b.decision === "rejected"
      ? "field.expense.rejected"
      : b.level === 1
        ? "field.expense.approved_l1"
        : "field.expense.approved_l2",
    x.ref,
    { reason: b.reason ?? undefined },
  );
  await k.d.notify.notify(k.db, {
    userId: x.claimantId,
    kind: "field.expense.decided",
    title: `Expense ${x.ref} ${b.decision}`,
    body: b.reason ?? "",
    link: "/field/expenses",
  });
  return expenseOut(out);
}

// ── earnings ──────────────────────────────────────────────────────────────────────────────────────
async function earnings(k: K, month: string) {
  await requireAgent(k);
  const start = new Date(`${month}-01T00:00:00+02:00`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const range = (
    col: typeof fieldVisits.windowStart | typeof fieldExpenses.createdAt,
  ) => and(gte(col, start.toISOString()), lt(col, end.toISOString()));
  const [done, mine, pool, st] = await Promise.all([
    k.db
      .select({ serviceId: fieldVisits.serviceId })
      .from(fieldVisits)
      .where(
        and(
          eq(fieldVisits.agentUserId, k.s.id),
          eq(fieldVisits.status, "completed"),
          range(fieldVisits.windowStart),
        ),
      ),
    k.db
      .select({ amount: fieldExpenses.amountRwf, state: fieldExpenses.state })
      .from(fieldExpenses)
      .where(
        and(
          eq(fieldExpenses.claimantId, k.s.id),
          range(fieldExpenses.createdAt),
        ),
      ),
    k.db
      .select()
      .from(fieldPoolShares)
      .where(
        and(
          eq(fieldPoolShares.agentUserId, k.s.id),
          eq(fieldPoolShares.month, month),
        ),
      ),
    getFieldSettings(k.db),
  ]);
  const xs = mine.map((m) => ({
    amount: m.amount,
    state: m.state as Expense["state"],
  }));
  const fees = done.map(
    (d) =>
      st.perVisitFee[d.serviceId] ??
      st.perVisitFee["*"] ??
      FIELD_POLICY.perVisitFee,
  );
  const count = fees.length;
  const total = fees.reduce((a, b) => a + b, 0);
  const fee = count
    ? Math.round(total / count)
    : (st.perVisitFee["*"] ?? FIELD_POLICY.perVisitFee);
  const external = isExternal(k.s);
  const shares = pool.map((p) => ({
    caseRef: p.caseRef,
    service: p.service,
    pool: p.poolRwf,
    state: p.state as "approved" | "allocated",
    amount: fieldShare(p.poolRwf),
  }));
  const sharesTotal = shares.reduce((a, x) => a + x.amount, 0);
  return {
    month,
    external,
    perVisit: { count, fee, total, wht: withholding(total, external) },
    transport: {
      approved: sumBy(xs, ["finance_approved", "paid"]),
      pending: sumBy(xs, ["submitted", "sm_approved"]),
      paid: sumBy(xs, ["paid"]),
    },
    shares,
    states: {
      invoiced: total + sharesTotal,
      collected: total,
      allocated: sharesTotal,
      approved: sumBy(xs, ["finance_approved"]) + total,
      paid: sumBy(xs, ["paid"]),
    },
  };
}

// ── conflicts ─────────────────────────────────────────────────────────────────────────────────────
const conflictOut = (c: typeof fieldConflicts.$inferSelect) => ({
  opId: c.opId,
  visitId: c.visitId,
  kind: c.kind,
  payload: c.payload as ConflictPayload,
  status: c.status as "open" | "accepted_agent" | "kept_office",
  note: c.note ?? undefined,
  at: iso(c.at),
});
async function resolveConflict(k: K, opId: string, b: D.ResolveDto) {
  if (b.choice === "accept_agent" || b.choice === "keep_office") {
    requireSm(k.s);
    const [c] = await k.db
      .select()
      .from(fieldConflicts)
      .where(eq(fieldConflicts.opId, opId))
      .for("update");
    if (!c) throw new AppError(404, "not_found", "Not found");
    const status =
      b.choice === "accept_agent" ? "accepted_agent" : "kept_office";
    const [out] = await k.db
      .update(fieldConflicts)
      .set({ status, note: b.note ?? null, resolvedBy: k.s.id })
      .where(eq(fieldConflicts.opId, opId))
      .returning();
    audit(k, "field.conflict.resolved", c.visitId, {
      choice: status,
      note: b.note ?? undefined,
    });
    return conflictOut(out);
  }
  // Agent kept the office version: nothing to store beyond the audit trail.
  await requireAgent(k);
  audit(k, "field.conflict.kept_office_by_agent", opId);
  return { opId, choice: "office" };
}
async function listConflicts(k: K, status?: string) {
  requireSm(k.s);
  return (
    await k.db
      .select()
      .from(fieldConflicts)
      .where(status ? eq(fieldConflicts.status, status) : undefined)
      .orderBy(desc(fieldConflicts.at))
      .limit(500)
  ).map(conflictOut);
}

// ── media ─────────────────────────────────────────────────────────────────────────────────────────
/** Field media is visible to the agent who owns the visit/expense and to office roles. */
async function mediaUrlFor(k: K, key: string) {
  const m = /^field\/([^/]+)\//.exec(key);
  if (!m || key.includes("..")) throw new AppError(404, "not_found", "Not found");
  const office =
    isSm(k.s) ||
    isFinance(k.s) ||
    (k.s.roles.includes("staff:agent") && !(await isFieldAgent(k.db, k.s.id)));
  if (!office && m[1] !== `u-${k.s.id}`) {
    const [v] = await k.db
      .select({ a: fieldVisits.agentUserId })
      .from(fieldVisits)
      .where(eq(fieldVisits.id, m[1]));
    if (!v || v.a !== k.s.id) throw new AppError(404, "not_found", "Not found");
  }
  return k.d.storage.presignGet(key);
}

// ── office: queue, evidence, custody receive, create visit ────────────────────────────────────────
async function visitsWithAgents(k: K, ids: string[]) {
  if (!ids.length)
    return {
      vm: new Map<string, FieldVisit>(),
      agents: new Map<string, string>(),
    };
  const [rows, st] = await Promise.all([
    k.db
      .select()
      .from(fieldVisits)
      .where(inArray(fieldVisits.id, [...new Set(ids)])),
    getFieldSettings(k.db),
  ]);
  const names = await namesOf(
    k.db,
    rows.map((r) => r.agentUserId),
  );
  return {
    vm: new Map(rows.map((r) => [r.id, project(k, r, st)])),
    agents: new Map(
      rows.map((r) => [r.id, names.get(r.agentUserId) ?? "Unknown"]),
    ),
  };
}
const flagOut = (f: typeof fieldFlagReviews.$inferSelect) => ({
  visitId: f.visitId,
  flags: f.flags as Flag[],
  reviewed: f.reviewed,
  at: iso(f.at),
});

async function opsQueue(k: K, tab: string) {
  if (!isSm(k.s) && !isFinance(k.s)) throw forbidden();
  if (tab === "flags") {
    const rows = await k.db
      .select()
      .from(fieldFlagReviews)
      .orderBy(asc(fieldFlagReviews.reviewed), desc(fieldFlagReviews.at))
      .limit(500);
    const { vm, agents } = await visitsWithAgents(
      k,
      rows.map((r) => r.visitId),
    );
    return rows.map((f) => ({
      ...flagOut(f),
      visit: vm.get(f.visitId),
      agent: agents.get(f.visitId),
    }));
  }
  if (tab === "conflicts") {
    const rows = await k.db
      .select()
      .from(fieldConflicts)
      .orderBy(desc(fieldConflicts.at))
      .limit(500);
    const { vm, agents } = await visitsWithAgents(
      k,
      rows.map((r) => r.visitId),
    );
    return rows.map((c) => ({
      ...conflictOut(c),
      visit: vm.get(c.visitId),
      agent: agents.get(c.visitId),
    }));
  }
  if (tab === "custody") {
    const rows = await k.db
      .select()
      .from(fieldCustody)
      .where(
        inArray(fieldCustody.stage, [
          "with_agent",
          "with_office",
          "lost",
          "damaged",
        ]),
      )
      .orderBy(asc(fieldCustody.createdAt))
      .limit(500);
    const { vm, agents } = await visitsWithAgents(
      k,
      rows.map((r) => r.visitId),
    );
    const t = Date.now();
    return rows.map((c) => ({
      ...custodyOut(c),
      visit: vm.get(c.visitId),
      agent: agents.get(c.visitId),
      ageMs: t - Date.parse(c.events[0]?.at ?? c.createdAt),
    }));
  }
  if (tab === "visits") {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const rows = await k.db
      .select()
      .from(fieldVisits)
      .where(gte(fieldVisits.windowStart, since))
      .orderBy(asc(fieldVisits.windowStart))
      .limit(500);
    const [st, agents] = await Promise.all([
      getFieldSettings(k.db),
      namesOf(
        k.db,
        rows.map((r) => r.agentUserId),
      ),
    ]);
    return rows.map((v) => ({
      ...project(k, v, st),
      agent: agents.get(v.agentUserId) ?? "Unknown",
    }));
  }
  throw new AppError(422, "validation", "Unknown tab.");
}
async function reviewFlags(k: K, visitId: string) {
  requireSm(k.s);
  await k.db
    .update(fieldFlagReviews)
    .set({ reviewed: true, reviewedBy: k.s.id })
    .where(
      and(
        eq(fieldFlagReviews.visitId, visitId),
        eq(fieldFlagReviews.reviewed, false),
      ),
    );
  return { reviewed: true };
}
async function receiveCustody(k: K, ref: string) {
  requireSm(k.s);
  const [c] = await k.db
    .select()
    .from(fieldCustody)
    .where(eq(fieldCustody.receiptRef, ref))
    .for("update");
  if (!c) throw new AppError(404, "not_found", "Not found");
  let out = c;
  if (c.stage === "with_agent")
    out = await pushCustody(k, c, {
      stage: "with_office",
      at: nowIso(),
      by: await nameOf(k.db, k.s.id),
    });
  else if (c.stage !== "with_office")
    throw new AppError(409, "conflict", "This custody chain is closed.");
  audit(k, "field.custody.received", ref);
  return custodyOut(out);
}
async function visitEvidence(k: K, id: string) {
  const v = await visitReadable(k, id);
  const [st, receipts, custody, scans, incidents, expenses, flags, agent] =
    await Promise.all([
      getFieldSettings(k.db),
      listReceipts(k, id),
      listCustody(k, id),
      listScans(k, id),
      k.db
        .select()
        .from(fieldIncidents)
        .where(eq(fieldIncidents.visitId, id))
        .orderBy(asc(fieldIncidents.at)),
      k.db.select().from(fieldExpenses).where(eq(fieldExpenses.visitId, id)),
      k.db
        .select()
        .from(fieldFlagReviews)
        .where(eq(fieldFlagReviews.visitId, id)),
      nameOf(k.db, v.agentUserId),
    ]);
  audit(k, "field.evidence.viewed", v.ref, { kind: "sensitive_read" });
  return {
    visit: project(k, v, st),
    agent,
    receipts,
    custody,
    scans,
    incidents: incidents.map((i) => ({
      id: i.ref,
      visitId: i.visitId,
      type: i.type,
      description: i.description,
      at: iso(i.at),
      by: i.byName,
    })),
    expenses: expenses.map(expenseOut),
    flags: flags.map(flagOut),
  };
}
async function caseVisits(k: K, ref: string) {
  const [rows, st] = await Promise.all([
    k.db
      .select()
      .from(fieldVisits)
      .where(eq(fieldVisits.caseRef, ref))
      .orderBy(asc(fieldVisits.windowStart)),
    getFieldSettings(k.db),
  ]);
  return rows.map((v) => project(k, v, st));
}

/** F-WRK-17: SM / the case's internal agent requests a visit. */
async function createVisit(k: K, code: string, b: D.CreateVisitDto) {
  const caseCode = code.trim().toUpperCase();
  const [app] = await k.db
    .select()
    .from(applications)
    .where(eq(applications.code, caseCode));
  if (!app) throw new AppError(404, "not_found", "Case not found.");
  if (!isSm(k.s) && app.assignedAgentId !== k.s.id)
    throw new AppError(
      403,
      "forbidden",
      "Only the case's agent or a service manager can request a visit.",
    );
  // Routing: explicit agent; else an active field agent covering the visit's district (fewest open visits);
  // else the least-loaded active field agent.
  let agentId = b.agent_id ?? null;
  if (!agentId) {
    const district = (b.district ?? String((app.personalInfo as Record<string, unknown> | null)?.district ?? "")).trim().toLowerCase();
    const agents = await k.db
      .select({ id: fieldAgents.userId, districts: fieldAgents.districts, at: fieldAgents.createdAt })
      .from(fieldAgents)
      .where(isNull(fieldAgents.revokedAt));
    const open = await k.db
      .select({ id: fieldVisits.agentUserId, n: dsql<number>`count(*)::int` })
      .from(fieldVisits)
      .where(inArray(fieldVisits.status, ["offered", "scheduled", "in_progress"]))
      .groupBy(fieldVisits.agentUserId);
    const load = new Map(open.map((o) => [o.id, Number(o.n)]));
    const local = district ? agents.filter((a) => a.districts.some((d) => d.toLowerCase() === district)) : [];
    const pool = (local.length ? local : agents).sort((x, y) => (load.get(x.id) ?? 0) - (load.get(y.id) ?? 0) || x.at.localeCompare(y.at));
    agentId = pool[0]?.id ?? null;
  }
  if (!agentId) throw new AppError(409, "conflict", "No field agent is available.");
  if (!(await isFieldAgent(k.db, agentId)))
    throw new AppError(422, "validation", "That person is not a field agent.");
  const ws = Date.parse(b.window_start);
  const we = b.window_end ? Date.parse(b.window_end) : ws + 3600_000;
  if (Number.isNaN(ws) || Number.isNaN(we) || we < ws)
    throw new AppError(422, "validation", "Check the visit window.");
  const pi = app.personalInfo as Record<string, unknown> | null;
  const [client] = app.clientId
    ? await k.db
        .select({
          name: users.name,
          phone: users.phoneE164,
          language: users.language,
        })
        .from(users)
        .where(eq(users.userId, app.clientId))
    : [];
  const contact = minimiseContact({
    name: String(client?.name ?? pi?.full_name ?? pi?.name ?? "Client"),
    phone: String(client?.phone ?? pi?.phone ?? pi?.phone_number ?? ""),
    language: String(client?.language ?? "rw"),
  });
  const ref = await nextRef(k.db, "visit");
  const label = (b.title ?? "").trim() || b.purpose;
  const todo = (b.todo ?? "").trim();
  const t3 = (x: string) => ({ en: x, fr: x, rw: x });
  const id = genId("fv");
  const [v] = await k.db
    .insert(fieldVisits)
    .values({
      id,
      ref,
      agentUserId: agentId,
      caseRef: caseCode,
      serviceId: app.serviceSlug,
      purpose: b.purpose,
      status: b.offer ? "offered" : "scheduled",
      titleI18n: t3(label),
      todoI18n: t3(todo),
      institution: b.institution ?? null,
      address: b.address,
      lat: b.lat ?? null,
      lng: b.lng ?? null,
      windowStart: new Date(ws).toISOString(),
      windowEnd: new Date(we).toISOString(),
      priority: b.priority ?? "normal",
      checklist: (b.checklist ?? [])
        .filter((l) => l.trim())
        .map((l, i) => ({
          id: `ck-${id.slice(3, 11)}-${i}`,
          label_i18n: t3(l.trim()),
          required: true,
          done: false,
        })),
      evidenceRequired:
        b.purpose === "site_visit" || b.purpose === "institution_submission"
          ? ["photo"]
          : ["signature"],
      clientEnc: k.d.crypto.encrypt(JSON.stringify(contact)),
      collectsDocs: b.purpose === "pickup" || b.purpose === "dropoff",
      offerExpiresAt: b.offer
        ? new Date(Date.now() + 2 * 3600_000).toISOString()
        : null,
      createdBy: k.s.id,
    })
    .returning();
  await k.d.notify.notify(k.db, {
    userId: agentId,
    kind: "wrk.visit_scheduled",
    title: `New field visit ${ref}`,
    body: label,
    link: `/field/visits/${id}`,
  });
  audit(k, "field.visit.created", ref, { case: caseCode, agent: agentId });
  return project(k, v, await getFieldSettings(k.db));
}

/** Office revoke: every device of this agent is signed out of field tools at its next request. */
async function revokeAgentDevices(k: K, userId: string, on: boolean) {
  requireSm(k.s);
  const [a] = await k.db
    .update(fieldAgents)
    .set({ revokedAt: on ? nowIso() : null })
    .where(eq(fieldAgents.userId, userId))
    .returning();
  if (!a) throw new AppError(404, "not_found", "Not found");
  audit(k, on ? "field.devices.revoked" : "field.devices.restored", userId);
  return { userId, revoked: !!a.revokedAt };
}

@Injectable()
export class FieldService {
  private readonly d: Deps;
  constructor(
    private readonly txs: TxService,
    private readonly auditSvc: AuditService,
    private readonly cls: ClsService<RequestStore>,
    storage: StorageService,
    outbox: OutboxService,
    crypto: CryptoService,
    notify: NotificationsService,
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
  ) {
    this.d = {
      storage,
      outbox,
      crypto,
      notify,
    };
  }

  /** One transaction per call; queued audit rows are written last. */
  private run<T>(fn: (k: K) => Promise<T>): Promise<T> {
    const s = this.cls.get("user");
    if (!s) throw new AppError(401, "unauthenticated", "Sign in");
    return this.txs.run(async (db) => {
      const k: K = { db, s, audits: [], d: this.d };
      const out = await fn(k);
      for (const a of k.audits) await this.auditSvc.record(db, a);
      return out;
    });
  }
  /** Failed OTP attempts must commit although the caller gets 422, so the 422 is thrown after the tx. */
  async verifyOtp(id: string, code: string) {
    const r = await this.run((k) => verifyOtp(k, id, code));
    if (!r.verified)
      throw new AppError(422, "invalid_code", "This code is wrong or expired.");
    return r;
  }

  me = () => this.run(me);
  dayPlan = (date: string) => this.run((k) => dayPlan(k, date));
  getVisit = (id: string) => this.run((k) => getVisit(k, id));
  prepare = (date: string) => this.run((k) => prepare(k, date));
  accept = (id: string, b: Body) => this.run((k) => acceptOffer(k, id, b));
  decline = (id: string, b: D.DeclineDto) =>
    this.run((k) => declineOffer(k, id, b));
  checkin = (id: string, b: Body) => this.run((k) => checkin(k, id, b));
  work = (id: string, b: Body) => this.run((k) => work(k, id, b));
  checkout = (id: string, b: Body) => this.run((k) => checkout(k, id, b));
  uploadScan = (id: string, b: Body) => this.run((k) => uploadScan(k, id, b));
  listScans = (id: string) => this.run((k) => listScans(k, id));
  scanPdf = (id: string) => this.run((k) => scanPdf(k, id));
  createReceipt = (id: string, b: Body) =>
    this.run((k) => createReceipt(k, id, b));
  listReceipts = (id: string) => this.run((k) => listReceipts(k, id));
  receiptPdf = (id: string) => this.run((k) => receiptPdf(k, id));
  custody = (id: string, b: Body) => this.run((k) => custodyAction(k, id, b));
  listCustody = (id: string) => this.run((k) => listCustody(k, id));
  incident = (id: string, b: Body) => this.run((k) => createIncident(k, id, b));
  invoices = (id: string) => this.run((k) => visitInvoices(k, id));
  startMomo = async (id: string, b: D.MomoDto) =>
    this.payments.initiateField(await this.run((k) => startMomo(k, id, b)));
  momoStatus = (id: string) => this.run((k) => momoStatus(k, id));
  cancelMomo = (id: string) => this.run((k) => cancelMomo(k, id));
  sendOtp = (id: string) => this.run((k) => sendOtp(k, id));
  recordCash = (id: string, b: Body) => this.run((k) => recordCash(k, id, b));
  depositCash = (ref: string, b: Body) =>
    this.run((k) => depositCash(k, ref, b));
  listCash = () => this.run(listCash);
  myExpenses = () => this.run(myExpenses);
  createExpense = (b: Body) => this.run((k) => createExpense(k, b));
  withdrawExpense = (id: string) => this.run((k) => withdrawExpense(k, id));
  earnings = (month: string) => this.run((k) => earnings(k, month));
  listConflicts = (status?: string) =>
    this.run((k) => listConflicts(k, status));
  resolveConflict = (opId: string, b: D.ResolveDto) =>
    this.run((k) => resolveConflict(k, opId, b));
  media = (key: string) => this.run((k) => mediaUrlFor(k, key));
  opsQueue = (tab: string) => this.run((k) => opsQueue(k, tab));
  reviewFlags = (visitId: string) => this.run((k) => reviewFlags(k, visitId));
  receiveCustody = (ref: string) => this.run((k) => receiveCustody(k, ref));
  revoke = (userId: string, on: boolean) =>
    this.run((k) => revokeAgentDevices(k, userId, on));
  evidence = (id: string) => this.run((k) => visitEvidence(k, id));
  caseVisits = (ref: string) => this.run((k) => caseVisits(k, ref));
  approvalQueue = (level: 1 | 2) => this.run((k) => approvalQueue(k, level));
  decide = (id: string, b: D.DecisionDto) =>
    this.run((k) => decideExpenseClaim(k, id, b));
  financeCash = () => this.run(financeCash);
  confirmCash = (id: string, b: D.ConfirmCashDto) =>
    this.run(async (k) => {
      const out = await confirmCashEntry(k, id, b);
      // Fully confirmed cash is posted once under its deposit key; finance's manual cash entry for the same deposit
      // uses the same key, so whichever path posts first wins and the other is a no-op (ledger source dedupe).
      if (out.status === "confirmed" && out.depositRef)
        await postPayment(this.ledger, k.db, cashKey(out.depositRef), { method: "cash", applied: out.amount, credit: 0 }, k.s.id);
      return out;
    });
  createVisit = (code: string, b: D.CreateVisitDto) =>
    this.run((k) => createVisit(k, code, b));
  /** Office edit hook for ops (reschedule / readdress / cancel). */
  officeEdit = (id: string, patch: Parameters<typeof officeEditVisit>[2]) =>
    this.run((k) => officeEditVisit(k, id, patch));
}
