// Booking (P12): consultation types, adviser availability, the slot engine (pure rules in @/domain/booking/rules),
// holds, confirm/pay/reschedule/cancel/no-show, manage-by-token, callbacks, waitlist, the SM board and analytics.
// Port of the reference booking.service.ts: the functions keep their shape and take a `K` (tx + caller + deps); the
// BookingService class at the bottom runs each in one TxService transaction and records the queued audit rows last.
// Holds are serialised per Kigali day by `pg_advisory_xact_lock` inside the tx, so two holds can never claim one slot.
import { agentProfiles } from "@/db/schema/schema-ops";
import { PaymentsService } from "../payments/payments.service";
import { LedgerService } from "../ledger/ledger.service";
import { postBookingPayment } from "../ledger/ledger.postings";
import type { Kind } from "../payments/payments.provider";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { ClsService } from "nestjs-cls";
import { createHash, randomBytes } from "node:crypto";
import { generateId, iso } from "../../core/db/ids";
import type IORedis from "ioredis";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql as dsql,
} from "drizzle-orm";
import { auditLog, users } from "@/db/schema";
import {
  bkgAdvisers,
  bkgBookings,
  bkgCounters,
  bkgLeads,
  bkgPayments,
  bkgRequests,
  bkgSettings,
  bkgTypes,
  bkgWaitlist,
} from "@/db/schema/schema-booking";
import {
  ACTIVE,
  BKG,
  addDays,
  at,
  can,
  cancelOutcome,
  computeSlots,
  dayOf,
  isEmail,
  isPhone,
  joinState,
  nearest,
  pickAdviser,
  planReminders,
  shouldAutoNoShow,
  type SlotAdviser,
  type SlotInput,
} from "@/domain/booking/rules";
import type {
  AdminBookings,
  Availability,
  AvailabilityOverride,
  AvailabilityRule,
  Booking,
  BookingAnalytics,
  BookingStatus,
  CallbackRequest,
  ConsultationType,
  Hold,
  Mode,
  SlotsResponse,
  StaffBooking,
} from "@/domain/booking/types";
import type { Locale } from "@/domain/i18n/config";
import { mask } from "@/domain/format";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { OutboxService } from "../../core/db/outbox";
import { AuditService, type AuditEntry } from "../../core/db/audit";
import { AppError } from "../../core/http/errors";
import type { RequestStore, SessionUser } from "../../core/http/context";
import { CryptoService } from "../../core/crypto/crypto.service";
import { REDIS } from "../../core/queue/queue.module";
import { CatalogueService } from "../catalogue/catalogue.service";
import type * as D from "./booking.dto";

type TypeRow = typeof bkgTypes.$inferSelect;
type AdvRow = typeof bkgAdvisers.$inferSelect;
export type Row = typeof bkgBookings.$inferSelect;
const MIN = 60_000;
const H = 60 * MIN;

type Deps = {
  crypto: CryptoService;
  outbox: OutboxService;
  catalogue: CatalogueService;
  prod: boolean;
  turnstile?: string;
  payments: PaymentsService;
  ledger: LedgerService;
  webBase: string;
};
/** One command: its tx, caller and the audit rows recorded at the end of the tx. */
type K = {
  db: Tx;
  session: SessionUser | null;
  ip: string;
  d: Deps;
  audits: AuditEntry[];
};

// ── settings (PLACEHOLDER business facts live in bkg_settings, never in code paths) ───────────────
export const BKG_DEFAULTS = {
  consultationPrice: 20_000, // PLACEHOLDER(consultation-price) D-1
  noShowPrepayment: 20_000, // PLACEHOLDER(no-show-prepayment) D-21
  officeAddress: "HEBUZA office, Sonatube — Kicukiro, Kigali", // PLACEHOLDER(office-address) D-15
  manageTokenValidityH: 24, // PLACEHOLDER(manage-token-validity) D-18, hours after the session ends
  // F-BKG-07: Jitsi Meet rooms work from the URL alone (no account/API); the random suffix makes them unguessable.
  videoBase: "https://meet.jit.si/",
  payWindowMin: 2,
};
type BkgSettings = typeof BKG_DEFAULTS;
async function settings(db: Tx): Promise<BkgSettings> {
  const [r] = await db
    .select()
    .from(bkgSettings)
    .where(eq(bkgSettings.id, "default"));
  return { ...BKG_DEFAULTS, ...((r?.value ?? {}) as Partial<BkgSettings>) };
}

// ── shared helpers (contact hashing/masking, roles) ───────────────────────────────────────────────
const has = (s: SessionUser | null, ...roles: string[]) =>
  !!s && s.roles.some((r) => roles.includes(r));
const isSM = (s: SessionUser | null) =>
  has(s, "staff:service_manager", "staff:executive");
const clientOf = (s: SessionUser | null) => (has(s, "client") ? s!.id : null);
export const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const normPhone = (p: string) => p.replace(/\D/g, "").slice(-9);
/** Stable per-person key for limits and no-show counts: the account id, else a hash of phone (last 9) or email. */
export const contactKey = (c: {
  clientId?: string | null;
  phone?: string | null;
  email?: string | null;
}) =>
  c.clientId ??
  sha(c.phone ? normPhone(c.phone) : (c.email ?? "").trim().toLowerCase());
const maskPhone = (p?: string | null) => (p ? mask(p, 3) : undefined);
const maskEmail = (e?: string | null) =>
  e ? e.replace(/^(.)[^@]*(@.*)$/, "$1•••$2") : undefined;
const enc = (k: K, v?: string | null) => (v ? k.d.crypto.encrypt(v) : null);
const dec = (k: K, v?: string | null) => {
  if (!v) return undefined;
  try {
    return k.d.crypto.decrypt(v);
  } catch {
    return undefined;
  }
};
export const lang = (v: unknown): Locale =>
  v === "fr" || v === "rw" || v === "en" ? v : "en";

function auditLater(
  k: K,
  action: string,
  entityId: string,
  x: { reason?: string; before?: unknown; after?: unknown } = {},
) {
  k.audits.push({ action, entity: action.split(".")[0], entityId, ...x });
}
const emit = (k: K, type: string, payload: Record<string, unknown>) =>
  k.d.outbox.add(k.db, { type, payload });
/** Client message (worker job `booking.notify`); the manage-link token is sealed in the outbox row. */
const notify = (k: K, kind: string, bookingId: string, token?: string) =>
  emit(
    k,
    "booking.notify",
    k.d.crypto.seal({ kind, bookingId, token }, ["token"]),
  );
const offerLater = (k: K, typeSlug: string, date: string) =>
  emit(k, "booking.waitlist.offer", { typeSlug, date });
/** Refund/credit execution is finance's: it consumes `booking.refund_requested` and books the RFD. */
const refundRequested = (
  k: K,
  r: Row,
  refund: { ref: string; amount: number; kind: string },
) =>
  emit(k, "booking.refund_requested", {
    bookingId: r.id,
    reference: r.reference,
    refund,
  });

async function nextSeq(db: Tx, name: string) {
  const [r] = await db
    .insert(bkgCounters)
    .values({ name, value: 1 })
    .onConflictDoUpdate({
      target: bkgCounters.name,
      set: { value: dsql`${bkgCounters.value} + 1` },
    })
    .returning({ value: bkgCounters.value });
  return r.value;
}
const year = () => new Date().getFullYear();
const newRef = async (db: Tx) =>
  `BKG-${year()}-${String(await nextSeq(db, `bkg-${year()}`)).padStart(4, "0")}`;
const refundRef = async (db: Tx) =>
  `RFD-${year()}-${String(await nextSeq(db, `rfd-${year()}`)).padStart(4, "0")}`;
const token = () => randomBytes(24).toString("base64url");
const fail = (status: number, type: string, data?: Record<string, unknown>) =>
  new AppError(status, type, type, undefined, data);
const notFound = () => new AppError(404, "not_found", "Not found");
const forbidden = () => new AppError(403, "forbidden", "Forbidden");
const validation = (fields?: Record<string, string>) =>
  new AppError(422, "validation", "validation", fields);
const stale = (v: number) =>
  new AppError(409, "conflict", "Stale version", undefined, { version: v });

// ── projections ───────────────────────────────────────────────────────────────────────────────────
function typeOut(t: TypeRow, requiresPrepayment?: boolean): ConsultationType {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    durationMin: t.durationMin as ConsultationType["durationMin"],
    modes: t.modes,
    price: t.price,
    currency: "RWF",
    bufferBeforeMin: t.bufferBeforeMin,
    bufferAfterMin: t.bufferAfterMin,
    minNoticeMin: t.minNoticeMin,
    horizonDays: t.horizonDays,
    maxPerDay: t.maxPerDay,
    familySlugs: t.familySlugs,
    serviceSlugs: t.serviceSlugs,
    adviserIds: t.adviserIds,
    intakeSchema: t.intakeSchema,
    prepare: t.prepare as ConsultationType["prepare"],
    freeOncePerFamily: t.freeOncePerFamily,
    isActive: t.isActive,
    version: t.version,
    ...(requiresPrepayment !== undefined ? { requiresPrepayment } : {}),
  };
}
const slotAdviser = (a: AdvRow): SlotAdviser => ({
  id: a.id,
  priority: a.priority,
  rules: a.rules,
  overrides: a.overrides,
  leave: a.leave,
  active: a.active,
});
const pubAdviser = (a: AdvRow | undefined | null) =>
  a
    ? {
        id: a.id,
        name: a.name,
        photo: a.photo ?? undefined,
        title: a.title ?? undefined,
      }
    : null;

/** Effective status: overdue confirmations read as no_show and lapsed holds as expired before the sweep writes it. */
function effStatus(
  r: Pick<Row, "status" | "endsAt" | "holdExpiresAt" | "paid">,
  now = Date.now(),
): BookingStatus {
  const s = r.status as BookingStatus;
  if (shouldAutoNoShow({ status: s, endsAt: r.endsAt }, now)) return "no_show";
  if (
    (s === "held" || s === "pending_payment") &&
    r.holdExpiresAt &&
    Date.parse(r.holdExpiresAt) < now &&
    !r.paid
  )
    return "expired";
  return s;
}

type ViewCtx = {
  types: Map<string, TypeRow>;
  advisers: Map<string, AdvRow>;
  noShows: Map<string, number>;
};
async function viewCtx(db: Tx, rows: Row[]): Promise<ViewCtx> {
  const keys = [...new Set(rows.map((r) => r.contactKey).filter(Boolean))];
  const types = await db.select().from(bkgTypes);
  const advisers = await db.select().from(bkgAdvisers);
  const ns = keys.length
    ? await db
        .select({ k: bkgBookings.contactKey, n: dsql<number>`count(*)::int` })
        .from(bkgBookings)
        .where(
          and(
            inArray(bkgBookings.contactKey, keys),
            eq(bkgBookings.status, "no_show"),
          ),
        )
        .groupBy(bkgBookings.contactKey)
    : [];
  return {
    types: new Map(types.map((t) => [t.slug, t])),
    advisers: new Map(advisers.map((a) => [a.id, a])),
    noShows: new Map(ns.map((x) => [x.k, x.n])),
  };
}

function view(
  k: K,
  r: Row,
  x: ViewCtx,
  actor: "client" | "staff" = "client",
  locale: Locale = "en",
  now = Date.now(),
): Booking | StaffBooking {
  const status = effStatus(r, now);
  const g = {
    status,
    startsAt: r.startsAt,
    rescheduleCount: r.rescheduleCount,
    paid: r.paid,
    price: r.price,
  };
  const res = can("reschedule", g, "client", now);
  const cnl = can("cancel", g, "client", now);
  const base: Booking = {
    id: r.id,
    reference: r.reference,
    typeSlug: r.typeSlug,
    typeName: r.typeName,
    price: r.price,
    adviser: pubAdviser(r.adviserId ? x.advisers.get(r.adviserId) : null),
    clientId: r.clientId,
    leadId: r.leadId,
    contact: {
      name: r.contactName,
      phoneMasked: r.phoneMasked ?? undefined,
      emailMasked: r.emailMasked ?? undefined,
    },
    language: r.language as Locale,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    mode: r.mode as Mode,
    location: r.location,
    status,
    intakeAnswers: r.intake,
    familySlug: r.familySlug,
    serviceSlug: r.serviceSlug,
    invoiceRef: r.invoiceRef,
    holdExpiresAt: r.holdExpiresAt,
    paid: r.paid,
    rescheduleCount: r.rescheduleCount,
    rescheduledFromId: r.rescheduledFromId,
    rescheduledToRef: r.rescheduledToRef,
    cancelReason: r.cancelReason,
    cancelledBy: r.cancelledBy as Booking["cancelledBy"],
    clientSummary: r.clientSummary,
    recommendedServiceSlugs: r.recommended,
    startLinks: status === "completed" ? r.startLinks : [],
    quoteRef: r.quoteRef,
    reminders: r.reminders,
    events: r.events,
    version: r.version,
    noShowCount: x.noShows.get(r.contactKey) ?? 0,
    refund: r.refund ?? null,
    prepare:
      (
        x.types.get(r.typeSlug)?.prepare as Record<string, string[]> | undefined
      )?.[locale] ?? [],
    can: {
      reschedule: res.ok,
      cancel: cnl.ok,
      join:
        status === "confirmed" ? joinState(r.startsAt, r.endsAt, now) : "ended",
      reason: !res.ok ? res.reason : !cnl.ok ? cnl.reason : undefined,
    },
  };
  if (actor === "client") return base;
  return {
    ...base,
    outcomeNotes: r.outcomeNotes,
    contactFull: {
      name: r.contactName,
      phone: dec(k, r.phoneEnc),
      email: dec(k, r.emailEnc),
    },
    source: r.source as StaffBooking["source"],
    quoteRequest: r.quoteRequest ?? null,
  };
}
const viewOne = async (
  k: K,
  r: Row,
  actor: "client" | "staff" = "client",
  locale: Locale = "en",
) => view(k, r, await viewCtx(k.db, [r]), actor, locale);
async function viewMany(
  k: K,
  rows: Row[],
  actor: "client" | "staff",
  locale: Locale = "en",
) {
  const x = await viewCtx(k.db, rows);
  return rows.map((r) => view(k, r, x, actor, locale));
}

// ── loaders ───────────────────────────────────────────────────────────────────────────────────────
async function typeBySlug(db: Tx, slug: string) {
  const [t] = await db.select().from(bkgTypes).where(eq(bkgTypes.slug, slug));
  return t ?? null;
}
async function byId(db: Tx, id: string, lock = false) {
  const q = db.select().from(bkgBookings).where(eq(bkgBookings.id, id));
  const [r] = lock ? await q.for("update") : await q;
  return r ?? null;
}
async function byToken(db: Tx, tk: string, lock = false) {
  const q = db
    .select()
    .from(bkgBookings)
    .where(eq(bkgBookings.tokenHash, sha(tk)));
  const [r] = lock ? await q.for("update") : await q;
  return r ?? null;
}
async function save(db: Tx, id: string, patch: Partial<Row>) {
  const [r] = await db
    .update(bkgBookings)
    .set({ ...patch, updatedAt: iso(Date.now()) })
    .where(eq(bkgBookings.id, id))
    .returning();
  return r;
}
async function noShowsOf(db: Tx, key: string) {
  const [r] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(bkgBookings)
    .where(
      and(eq(bkgBookings.contactKey, key), eq(bkgBookings.status, "no_show")),
    );
  return r?.n ?? 0;
}
async function adviserOfUser(db: Tx, s: SessionUser | null) {
  if (!s) return null;
  const [a] = await db
    .select()
    .from(bkgAdvisers)
    .where(eq(bkgAdvisers.userId, s.id));
  return a ?? null;
}
/** F-BKG-02: an adviser on workforce leave (agent_profiles.status = leave, until on_leave_until) gets no slots. */
async function advisersOf(db: Tx, t: TypeRow) {
  if (!t.adviserIds.length) return [];
  const rows = await db.select().from(bkgAdvisers).where(inArray(bkgAdvisers.id, t.adviserIds));
  const userIds = rows.map((r) => r.userId).filter((x): x is string => !!x);
  if (!userIds.length) return rows;
  const away = await db.select({ id: agentProfiles.userId, until: agentProfiles.onLeaveUntil }).from(agentProfiles)
    .where(and(inArray(agentProfiles.userId, userIds), eq(agentProfiles.status, "leave")));
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => {
    const w = away.find((x) => x.id === r.userId);
    return w ? { ...r, leave: [...r.leave, { from: today, to: w.until ?? "9999-12-31" }] } : r;
  });
}

// ── slot engine glue ──────────────────────────────────────────────────────────────────────────────
async function slotInput(
  db: Tx,
  t: TypeRow,
  from: string,
  to: string,
  adviserId: string | null,
  o: { ignoreId?: string; advisers?: AdvRow[]; now?: number } = {},
): Promise<SlotInput> {
  const now = o.now ?? Date.now();
  const advisers = o.advisers ?? (await advisersOf(db, t));
  const ids = advisers.map((a) => a.id);
  const rows = ids.length
    ? await db
        .select({
          id: bkgBookings.id,
          adviserId: bkgBookings.adviserId,
          startsAt: bkgBookings.startsAt,
          endsAt: bkgBookings.endsAt,
          status: bkgBookings.status,
          holdExpiresAt: bkgBookings.holdExpiresAt,
          paid: bkgBookings.paid,
        })
        .from(bkgBookings)
        .where(
          and(
            inArray(bkgBookings.adviserId, ids),
            inArray(bkgBookings.status, ACTIVE),
            gte(bkgBookings.startsAt, at(addDays(from, -1), "00:00")),
            lt(bkgBookings.startsAt, at(addDays(to, 2), "00:00")),
          ),
        )
    : [];
  return {
    durationMin: t.durationMin,
    bufferBeforeMin: t.bufferBeforeMin,
    bufferAfterMin: t.bufferAfterMin,
    minNoticeMin: t.minNoticeMin,
    horizonDays: t.horizonDays,
    maxPerDay: t.maxPerDay,
    advisers: advisers.map(slotAdviser),
    adviserId,
    bookings: rows
      .filter((b) => b.id !== o.ignoreId)
      .map((b) => ({
        adviserId: b.adviserId,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        status: effStatus(b, now),
      })),
    externalBusy: advisers.flatMap((a) =>
      a.externalBusy.map((x) => ({ adviserId: a.id, ...x })),
    ),
    from,
    to,
  };
}

async function listTypes(k: K, contact?: string | null) {
  const key = contact
    ? contactKey({
        phone: contact.includes("@") ? null : contact,
        email: contact.includes("@") ? contact : null,
      })
    : (clientOf(k.session) ?? undefined);
  const ns = key ? await noShowsOf(k.db, key) : 0;
  const rows = await k.db
    .select()
    .from(bkgTypes)
    .where(eq(bkgTypes.isActive, true))
    .orderBy(asc(bkgTypes.durationMin), asc(bkgTypes.slug));
  return rows.map((t) =>
    typeOut(t, !!key && t.price === 0 && ns >= BKG.noShowLimit),
  );
}
async function getType(k: K, slug: string) {
  const t = await typeBySlug(k.db, slug);
  if (!t || !t.isActive) throw notFound();
  const key = clientOf(k.session);
  return typeOut(
    t,
    !!key && t.price === 0 && (await noShowsOf(k.db, key)) >= BKG.noShowLimit,
  );
}
async function slotsFor(
  db: Tx,
  slug: string,
  from: string,
  to: string,
  adviserId: string | null,
  now = Date.now(),
): Promise<SlotsResponse> {
  const t = await typeBySlug(db, slug);
  if (!t) throw notFound();
  if (to < from || Date.parse(to) - Date.parse(from) > 62 * 86_400_000)
    throw validation();
  const advisers = await advisersOf(db, t);
  const slots = computeSlots(
    await slotInput(db, t, from, to, adviserId, { advisers, now }),
    now,
  );
  let next = slots[0]?.startsAt ?? null;
  if (!next) {
    const end = addDays(dayOf(now), t.horizonDays + 1);
    if (to < end)
      next =
        computeSlots(
          await slotInput(db, t, addDays(to, 1), end, adviserId, {
            advisers,
            now,
          }),
          now,
        )[0]?.startsAt ?? null;
  }
  return { tz: "Africa/Kigali", slots, nextAvailable: next, waitlist: true };
}
async function listAdvisers(db: Tx, slug: string | null) {
  const t = slug ? await typeBySlug(db, slug) : null;
  const rows = await db
    .select()
    .from(bkgAdvisers)
    .where(eq(bkgAdvisers.active, true))
    .orderBy(asc(bkgAdvisers.priority));
  return rows
    .filter((a) => !t || t.adviserIds.includes(a.id))
    .map((a) => pubAdviser(a)!);
}

// ── holds ─────────────────────────────────────────────────────────────────────────────────────────
const dayLock = (db: Tx, day: string) =>
  db.execute(dsql`select pg_advisory_xact_lock(hashtext(${"bkg:" + day}))`);

/** Holds a slot for BKG.holdMin minutes. Serialised per Kigali day by an advisory lock; the DB row is the claim. */
async function hold(
  db: Tx,
  t: TypeRow,
  startsAt: string,
  adviserId: string | null,
  o: { ignoreId?: string; minNoticeMin?: number } = {},
  now = Date.now(),
) {
  const minNotice = o.minNoticeMin ?? t.minNoticeMin;
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) throw validation();
  if (start < now + minNotice * MIN || start > now + t.horizonDays * 24 * H)
    throw fail(422, "outside_window");
  const day = dayOf(startsAt);
  await dayLock(db, day);
  const advisers = await advisersOf(db, t);
  const inp = await slotInput(db, t, day, day, adviserId, {
    ignoreId: o.ignoreId,
    advisers,
    now,
  });
  inp.minNoticeMin = minNotice;
  const slot = computeSlots(inp, now).find(
    (x) => x.startsAt === new Date(start).toISOString(),
  );
  if (!slot) {
    const near = computeSlots(
      {
        ...(await slotInput(db, t, day, addDays(day, 3), adviserId, {
          ignoreId: o.ignoreId,
          advisers,
          now,
        })),
        minNoticeMin: minNotice,
      },
      now,
    ).filter((x) => x.startsAt !== startsAt);
    throw fail(409, "slot_taken", { nearest: nearest(near, startsAt) });
  }
  const adviser = adviserId ?? pickAdviser(slot, inp.advisers, inp.bookings);
  const s = await settings(db);
  const exp = iso(now + BKG.holdMin * MIN);
  const [r] = await db
    .insert(bkgBookings)
    .values({
      id: generateId("bk"),
      typeSlug: t.slug,
      typeName: t.name,
      price: t.price,
      adviserId: adviser,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      mode: t.modes[0] ?? "video",
      status: "held",
      holdExpiresAt: exp,
      events: [{ at: iso(now), kind: "booked" }],
      tokenHash: sha(token()),
      confirmKey: token(),
      joinUrl: `${s.videoBase}hbz-${randomBytes(12).toString("base64url")}`,
    })
    .returning();
  const h: Hold = {
    bookingId: r.id,
    holdExpiresAt: exp,
    adviserId: adviser,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    typeSlug: t.slug,
  };
  return { hold: h, row: r };
}

async function holdPublic(k: K, b: D.HoldDto) {
  const t = await typeBySlug(k.db, b.type);
  if (!t || !t.isActive) throw notFound();
  if (b.release) {
    const old = await byId(k.db, b.release, true);
    if (old?.status === "held") await save(k.db, old.id, { status: "expired" });
  }
  const { hold: h } = await hold(k.db, t, b.starts_at, b.adviser_id ?? null);
  auditLater(k, "booking.held", h.bookingId);
  return h;
}
async function holdStatus(db: Tx, id: string) {
  const r = await byId(db, id);
  if (!r) throw notFound();
  if (
    r.status !== "held" ||
    (r.holdExpiresAt && Date.parse(r.holdExpiresAt) < Date.now())
  )
    throw fail(410, "hold_expired");
  return {
    bookingId: r.id,
    holdExpiresAt: r.holdExpiresAt,
    adviserId: r.adviserId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    typeSlug: r.typeSlug,
  };
}
async function releaseHold(db: Tx, id: string) {
  const r = await byId(db, id, true);
  if (!r || r.status !== "held") throw notFound();
  await save(db, id, { status: "expired" });
  return { released: true };
}

// ── captcha ───────────────────────────────────────────────────────────────────────────────────────
/** Cloudflare's always-pass test secret: local/test runs exercise the same siteverify path as production. */
const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
async function verifyCaptcha(k: K, tokenIn: string | undefined) {
  if (!tokenIn) return false;
  const secret = k.d.turnstile ?? (k.d.prod ? undefined : TURNSTILE_TEST_SECRET);
  if (!secret) {
    new Logger("booking").error("captcha_rejected_no_secret: set TURNSTILE_SECRET_KEY"); // fail closed in production
    return false;
  }
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret,
          response: tokenIn,
          remoteip: k.ip,
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}

// ── confirm / pay ─────────────────────────────────────────────────────────────────────────────────
type Source = StaffBooking["source"];
async function newLead(
  k: K,
  o: {
    name: string;
    phone?: string | null;
    email?: string | null;
    source: string;
    language?: string;
    topic?: string | null;
  },
) {
  const id = generateId("lead");
  await k.db
    .insert(bkgLeads)
    .values({
      id,
      name: o.name,
      phoneEnc: enc(k, o.phone),
      emailEnc: enc(k, o.email),
      source: o.source,
      language: o.language ?? null,
      topic: o.topic ?? null,
    });
  // Marketing CRM mirrors leads from this event (dedupes against open leads); bkg_leads keeps the booking-side record.
  await emit(
    k,
    "booking.lead_captured",
    k.d.crypto.seal(
      {
        leadId: id,
        name: o.name,
        phone: o.phone ?? undefined,
        email: o.email ?? undefined,
        source: "booking",
      },
      ["phone", "email"],
    ),
  );
  return id;
}

/** Finalises a held booking: free → confirmed, paid → pending_payment with an invoice ref. */
async function finalize(
  k: K,
  r: Row,
  o: {
    name: string;
    phone?: string;
    email?: string;
    clientId: string | null;
    intake: Record<string, unknown>;
    whatsapp: boolean;
    language: Locale;
    mode: Mode;
    family: string | null;
    service: string | null;
    source: Source;
    prepay?: boolean;
    staff?: boolean;
  },
  now = Date.now(),
) {
  const s = await settings(k.db);
  const reference = await newRef(k.db);
  const price = r.price || (o.prepay ? s.noShowPrepayment : 0);
  const tk = token();
  const leadId = o.clientId
    ? null
    : await newLead(k, {
        name: o.name,
        phone: o.phone,
        email: o.email,
        source: o.source === "assistant" ? "ai" : "booking",
        language: o.language,
      });
  const paidStep = price > 0 && !o.staff;
  const channel = o.whatsapp ? "whatsapp" : o.phone ? "sms" : "email";
  const row = await save(k.db, r.id, {
    reference,
    contactName: o.name,
    phoneEnc: enc(k, o.phone),
    emailEnc: enc(k, o.email),
    phoneMasked: maskPhone(o.phone) ?? null,
    emailMasked: maskEmail(o.email) ?? null,
    contactKey: contactKey({
      clientId: o.clientId,
      phone: o.phone,
      email: o.email,
    }),
    clientId: o.clientId,
    leadId,
    intake: o.intake,
    whatsapp: o.whatsapp,
    language: o.language,
    mode: o.mode,
    location: o.mode === "office" ? s.officeAddress : null,
    familySlug: o.family,
    serviceSlug: o.service,
    source: o.source,
    price,
    tokenHash: sha(tk),
    invoiceRef: price > 0 ? `INV-BKG-${reference.slice(-4)}` : null,
    status: paidStep ? "pending_payment" : "confirmed",
    holdExpiresAt: paidStep
      ? iso(
          Math.max(
            Date.parse(r.holdExpiresAt ?? iso(now)),
            now + BKG.holdMin * MIN,
          ),
        )
      : null,
    reminders: paidStep ? [] : planReminders(r.startsAt, now, channel, now),
    events: paidStep
      ? r.events
      : [...r.events, { at: iso(now), kind: "confirmed" }],
    version: r.version + 1,
  });
  if (!paidStep) await notify(k, "confirmed", r.id, tk);
  return { row, token: tk };
}

async function confirm(k: K, id: string, b: D.ConfirmDto) {
  const db = k.db;
  const r = await byId(db, id, true);
  if (!r) throw notFound();
  if (
    r.status !== "held" ||
    (r.holdExpiresAt && Date.parse(r.holdExpiresAt) < Date.now())
  )
    throw fail(410, "hold_expired");
  const cid = clientOf(k.session);
  const fields: Record<string, string> = {};
  if (!b.contact.name.trim()) fields.name = "required";
  if (!b.contact.phone && !b.contact.email && !cid) fields.contact = "required";
  if (b.contact.phone && !isPhone(b.contact.phone, true))
    fields.phone = "invalid";
  if (b.contact.email && !isEmail(b.contact.email)) fields.email = "invalid";
  if (!b.consents.privacy) fields.privacy = "required";
  if (Object.keys(fields).length)
    throw new AppError(422, "validation", "validation", fields, { fields });
  if (!cid && !(await verifyCaptcha(k, b.captcha)))
    throw fail(422, "captcha_failed");
  const t = (await typeBySlug(db, r.typeSlug))!;
  if (!t.modes.includes(b.mode))
    throw new AppError(
      422,
      "validation",
      "validation",
      { mode: "invalid" },
      { fields: { mode: "invalid" } },
    );
  const key = contactKey({
    clientId: cid,
    phone: b.contact.phone,
    email: b.contact.email,
  });
  if (t.price === 0) {
    const [up] = await db
      .select()
      .from(bkgBookings)
      .where(
        and(
          eq(bkgBookings.contactKey, key),
          eq(bkgBookings.price, 0),
          eq(bkgBookings.status, "confirmed"),
          gte(bkgBookings.startsAt, iso(Date.now())),
        ),
      )
      .limit(1);
    if (up)
      throw fail(409, "free_limit_upcoming", {
        date: up.startsAt,
        masked: up.phoneMasked ?? up.emailMasked,
      });
    if (t.freeOncePerFamily && b.family) {
      const [used] = await db
        .select({ id: bkgBookings.id })
        .from(bkgBookings)
        .where(
          and(
            eq(bkgBookings.contactKey, key),
            eq(bkgBookings.typeSlug, t.slug),
            eq(bkgBookings.familySlug, b.family),
            eq(bkgBookings.status, "completed"),
          ),
        )
        .limit(1);
      if (used) throw fail(409, "free_used_family", { family: b.family });
    }
    if ((await noShowsOf(db, key)) >= BKG.noShowLimit && !b.prepay)
      throw fail(409, "prepayment_required");
  }
  const { row, token: tk } = await finalize(k, r, {
    name: b.contact.name.trim(),
    phone: b.contact.phone,
    email: b.contact.email,
    clientId: cid,
    intake: b.intake ?? {},
    whatsapp: !!b.consents.whatsapp,
    language: b.language,
    mode: b.mode,
    family: b.family ?? null,
    service: b.service ?? null,
    source:
      b.source === "assistant"
        ? "assistant"
        : b.source === "campaign"
          ? "campaign"
          : "web",
    prepay: b.prepay,
  });
  auditLater(k, "booking.confirmed", row.reference, {
    after: { status: row.status },
  });
  return {
    booking: await viewOne(k, row, "client", b.language),
    confirmKey: row.confirmKey,
    invoiceRef: row.invoiceRef,
    leadId: row.leadId,
    // The manage token travels by email/SMS; dev returns it so the flow can link straight to it.
    devManageToken: k.d.prod ? undefined : tk,
  };
}

const OPEN_PAY = ["initiating", "pending", "succeeded"];
/** Starts (or resumes) the booking's one live payment; a retry or second tab gets the same transaction back. */
async function pay(k: K, id: string, b: D.PayDto) {
  if (b.method !== "card" && (!b.phone || !isPhone(b.phone, true)))
    throw new AppError(
      422,
      "validation",
      "validation",
      { phone: "invalid" },
      { fields: { phone: "invalid" } },
    );
  const kind =
    b.method === "card"
      ? "card"
      : b.method === "airtel"
        ? "airtel-money"
        : "mtn-momo";
  const s = await settings(k.db);
  const r = await byId(k.db, id, true);
  if (!r || effStatus(r) !== "pending_payment")
    throw new AppError(409, "conflict", "conflict");
  const [live] = await k.db
    .select()
    .from(bkgPayments)
    .where(
      and(
        eq(bkgPayments.bookingId, r.id),
        inArray(bkgPayments.status, OPEN_PAY),
        gt(bkgPayments.expiresAt, iso(Date.now())),
      ),
    )
    .orderBy(desc(bkgPayments.createdAt))
    .limit(1);
  if (live)
    return {
      transactionId: live.id,
      expiresAt: live.expiresAt,
      checkoutUrl: live.checkoutUrl ?? null,
    };
  const txId = generateId("bkp");
  const expiresAt = iso(Date.now() + s.payWindowMin * MIN);
  // Reserve the row ("initiating", so a retry resumes it); the gateway is called after this tx commits.
  await k.db.insert(bkgPayments).values({
    id: txId,
    bookingId: r.id,
    kind,
    amount: r.price,
    status: "initiating",
    phoneMasked: maskPhone(b.phone) ?? null,
    expiresAt,
  });
  return {
    start: {
      transactionId: txId,
      kind: kind as Kind,
      amountRwf: r.price,
      phone: b.method === "card" ? null : (b.phone ?? null),
      returnUrl: `${k.d.webBase}/book/confirmed/${r.reference}`,
      reference: r.reference,
      expiresAt,
    },
  };
}
type PayStart = NonNullable<Awaited<ReturnType<typeof pay>>["start"]>;
/** Gateway answer for a reserved payment (new tx); null = gateway failed, the row is closed as failed. */
async function payInitiated(
  k: K,
  st: PayStart,
  method: string,
  initiated: Awaited<ReturnType<PaymentsService["initiateBooking"]>> | null,
) {
  await k.db
    .update(bkgPayments)
    .set(
      initiated
        ? {
            status: initiated.status,
            providerRef: initiated.providerReference ?? null,
            checkoutUrl: initiated.sessionToken ?? null,
            updatedAt: iso(Date.now()),
          }
        : { status: "failed", updatedAt: iso(Date.now()) },
    )
    .where(and(eq(bkgPayments.id, st.transactionId), eq(bkgPayments.status, "initiating")));
  if (!initiated) return null;
  auditLater(k, "booking.payment_started", st.reference, { after: { method } });
  return {
    transactionId: st.transactionId,
    expiresAt: st.expiresAt,
    checkoutUrl: initiated.sessionToken ?? null,
  };
}

/** Confirms if paid in time, else confirms when the slot is still free, else expires with an automatic refund (spec §13). */
async function markPaid(k: K, r: Row, txId: string, now = Date.now()) {
  const db = k.db;
  if (r.paid) {
    const by = r.events.find((e) => e.kind === "paid")?.note;
    if (!by || by === txId) return r; // the paying tx (or a pre-txId legacy row) re-polled
    // A second successful charge for an already-paid booking: refund it, never keep it.
    const refund = {
      ref: await refundRef(db),
      amount: r.price,
      kind: "refund" as const,
    };
    await db
      .update(bkgPayments)
      .set({ status: "refunded", updatedAt: iso(now) })
      .where(eq(bkgPayments.id, txId));
    auditLater(k, "booking.duplicate_payment_refunded", r.reference, {
      after: { transactionId: txId, refund },
    });
    await refundRequested(k, r, refund);
    return r;
  }
  const late =
    r.status === "expired" ||
    (r.holdExpiresAt && Date.parse(r.holdExpiresAt) < now);
  if (late || r.lateRefund) {
    const t = (await typeBySlug(db, r.typeSlug))!;
    const day = dayOf(r.startsAt);
    // Same per-day lock as hold(): a concurrent hold can't take the slot between this check and the confirm.
    await dayLock(db, day);
    const free =
      !r.lateRefund &&
      Date.parse(r.startsAt) > now &&
      computeSlots(
        {
          ...(await slotInput(db, t, day, day, r.adviserId, {
            ignoreId: r.id,
            now,
          })),
          minNoticeMin: 0,
        },
        now,
      ).some((x) => x.startsAt === r.startsAt);
    if (!free) {
      const refund = {
        ref: await refundRef(db),
        amount: r.price,
        kind: "refund" as const,
      };
      const row = await save(db, r.id, {
        status: "expired",
        paid: true,
        lateRefund: true,
        refund,
        events: [
          ...r.events,
          { at: iso(now), kind: "paid", note: txId },
          { at: iso(now), kind: "expired", note: "late payment refunded" },
        ],
        version: r.version + 1,
      });
      auditLater(k, "booking.late_payment_refunded", r.reference, {
        after: { refund },
      });
      await refundRequested(k, r, refund);
      return row;
    }
  }
  const channel = r.whatsapp ? "whatsapp" : r.phoneEnc ? "sms" : "email";
  const tk = token();
  const row = await save(db, r.id, {
    paid: true,
    status: "confirmed",
    holdExpiresAt: null,
    tokenHash: sha(tk),
    reminders: planReminders(r.startsAt, now, channel, now),
    events: [
      ...r.events,
      { at: iso(now), kind: "paid", note: txId },
      { at: iso(now), kind: "confirmed" },
    ],
    version: r.version + 1,
  });
  await notify(k, "confirmed", r.id, tk);
  auditLater(k, "booking.paid", r.reference, { after: { amount: r.price } });
  return row;
}

/** Settles one booking payment (UI poll, webhooks via BookingService.settle, and the sweep). */
async function payStatus(k: K, txId: string) {
  const db = k.db;
  const [p] = await db
    .select()
    .from(bkgPayments)
    .where(eq(bkgPayments.id, txId))
    .for("update");
  if (!p) throw notFound();
  let status = p.status;
  if ((status === "pending" || status === "initiating") && p.providerRef)
    status =
      (await k.d.payments.bookingStatus(p.kind as Kind, p.providerRef, p.amount)) ?? status;
  if (status === "pending" || status === "initiating") {
    if (Date.parse(p.expiresAt) + 10 * MIN < Date.now()) status = "expired";
  }
  if (status !== p.status) {
      await db
        .update(bkgPayments)
        .set({ status, updatedAt: iso(Date.now()) })
        .where(eq(bkgPayments.id, p.id));
  }
  if (status === "succeeded") {
    // Every captured charge is booked (idempotent per txId), so late/duplicate refunds reverse against it.
    await postBookingPayment(k.d.ledger, db, p.id, { method: p.kind, amount: p.amount });
    const r = (await byId(db, p.bookingId, true))!;
    const row = await markPaid(k, r, p.id);
    // F-BKG-06: a client's paid consultation is invoiced in finance (worker job; idempotent per payment id).
    if (row.clientId && row.status !== "expired")
      await emit(k, "finance.booking.settled", { clientId: row.clientId, reference: row.reference, paymentId: p.id, amount: p.amount, label: `Consultation ${row.reference}` });
    return {
      status: row.status === "expired" ? "late_refunded" : "success",
      reference: row.reference,
    };
  }
  if (status === "refunded")
    return {
      status: "success",
      reference: (await byId(db, p.bookingId))!.reference,
    };
  if (["failed", "insufficient_funds", "expired"].includes(status))
    return { status: "failed" };
  return { status: "pending" };
}

// ── public reads by confirm key / manage token ────────────────────────────────────────────────────
async function byConfirmKey(
  k: K,
  ref: string,
  key: string | undefined,
  locale: Locale,
) {
  const [r] = await k.db
    .select()
    .from(bkgBookings)
    .where(eq(bkgBookings.reference, ref))
    .orderBy(desc(bkgBookings.createdAt))
    .limit(1);
  if (!r || !key || key !== r.confirmKey) throw notFound();
  return viewOne(k, r, "client", locale);
}
async function managed(db: Tx, tk: string, lock = false) {
  const r = await byToken(db, tk, lock);
  if (!r || !r.reference) throw notFound();
  const s = await settings(db);
  if (Date.now() > Date.parse(r.endsAt) + s.manageTokenValidityH * H)
    throw fail(410, "token_expired");
  return r;
}

// ── cancel / reschedule / join (shared by manage link and client portal) ─────────────────────────
async function cancelRow(
  k: K,
  r: Row,
  by: "client" | "staff",
  o: { reason?: string; refundChoice?: "refund" | "credit" },
  now = Date.now(),
) {
  const out = cancelOutcome(r, by, now);
  const refund =
    out.refund > 0
      ? {
          ref: await refundRef(k.db),
          amount: out.refund,
          kind:
            o.refundChoice === "credit"
              ? ("credit" as const)
              : ("refund" as const),
        }
      : null;
  const row = await save(k.db, r.id, {
    status: by === "client" ? "cancelled_by_client" : "cancelled_by_staff",
    cancelledBy: by,
    cancelReason: o.reason ?? null,
    refund: refund ?? r.refund ?? null,
    events: [...r.events, { at: iso(now), kind: "cancelled", note: o.reason }],
    version: r.version + 1,
  });
  auditLater(k, "booking.cancelled", r.reference, {
    reason: o.reason,
    after: { refund },
  });
  if (refund) await refundRequested(k, r, refund);
  await notify(k, "cancelled", r.id);
  await offerLater(k, r.typeSlug, dayOf(r.startsAt));
  return row;
}
function guarded(r: Row, action: "cancel" | "reschedule", version: number) {
  if (version !== r.version) throw stale(r.version);
  const g = can(action, { ...r, status: effStatus(r) }, "client", Date.now());
  if (!g.ok) throw fail(409, g.reason);
}
async function cancelBy(k: K, r: Row, b: D.CancelDto) {
  guarded(r, "cancel", b.version);
  const row = await cancelRow(k, r, "client", {
    reason: b.reason,
    refundChoice: b.refund_choice,
  });
  return { booking: await viewOne(k, row), refund: row.refund ?? null };
}
async function rescheduleBy(k: K, old: Row, b: D.RescheduleDto) {
  guarded(old, "reschedule", b.version);
  const h = await byId(k.db, b.hold_id, true);
  if (
    !h ||
    h.status !== "held" ||
    (h.holdExpiresAt && Date.parse(h.holdExpiresAt) < Date.now())
  )
    throw fail(410, "hold_expired");
  if (h.typeSlug !== old.typeSlug) throw fail(422, "type_mismatch");
  const now = Date.now();
  const ref = await newRef(k.db);
  // The live manage link follows the new booking: retire the old hash first (unique index).
  await save(k.db, old.id, {
    status: "rescheduled",
    rescheduledToRef: ref,
    tokenHash: sha(token()),
    version: old.version + 1,
  });
  const row = await save(k.db, h.id, {
    reference: ref,
    contactName: old.contactName,
    phoneEnc: old.phoneEnc,
    emailEnc: old.emailEnc,
    phoneMasked: old.phoneMasked,
    emailMasked: old.emailMasked,
    clientId: old.clientId,
    leadId: old.leadId,
    intake: old.intake,
    whatsapp: old.whatsapp,
    language: old.language,
    mode: old.mode,
    location: old.location,
    familySlug: old.familySlug,
    serviceSlug: old.serviceSlug,
    contactKey: old.contactKey,
    price: old.price,
    paid: old.paid,
    invoiceRef: old.invoiceRef,
    rescheduleCount: old.rescheduleCount + 1,
    rescheduledFromId: old.id,
    status: "confirmed",
    holdExpiresAt: null,
    tokenHash: old.tokenHash,
    source: old.source,
    confirmKey: old.confirmKey,
    events: [
      ...old.events,
      { at: iso(now), kind: "rescheduled", note: old.reference },
    ],
    reminders: planReminders(
      h.startsAt,
      now,
      old.whatsapp ? "whatsapp" : old.phoneEnc ? "sms" : "email",
      now,
    ),
  });
  auditLater(k, "booking.rescheduled", old.reference, { after: { to: ref } });
  await notify(k, "rescheduled", row.id);
  await offerLater(k, old.typeSlug, dayOf(old.startsAt));
  return viewOne(k, row);
}
function joinFor(r: Row) {
  const st = effStatus(r);
  const j =
    st === "confirmed" ? joinState(r.startsAt, r.endsAt, Date.now()) : "ended";
  if (j === "locked") throw new AppError(403, "too_early", "too_early");
  if (j === "ended") throw new AppError(403, "ended", "ended");
  return { url: r.mode === "video" ? r.joinUrl : null, expiresAt: r.endsAt };
}

/** Re-sends manage links for this contact's upcoming bookings. Always the same answer: no enumeration. */
async function resend(k: K, b: D.ResendDto) {
  if (b.email ?? b.phone) {
    const key = contactKey({ phone: b.phone, email: b.email });
    const rows = await k.db
      .select({ id: bkgBookings.id })
      .from(bkgBookings)
      .where(
        and(
          eq(bkgBookings.contactKey, key),
          inArray(bkgBookings.status, ["confirmed", "pending_payment"]),
          gte(bkgBookings.endsAt, iso(Date.now())),
        ),
      );
    for (const r of rows) {
      const tk = token();
      await k.db
        .update(bkgBookings)
        .set({ tokenHash: sha(tk) })
        .where(eq(bkgBookings.id, r.id));
      await notify(k, "manage_link", r.id, tk);
    }
  }
  return { sent: true };
}

// ── callbacks + waitlist ──────────────────────────────────────────────────────────────────────────
async function createRequest(k: K, b: D.RequestDto) {
  if (!b.name.trim() || !isPhone(b.phone, true) || !b.consent || !b.topic)
    throw validation();
  if (b.email && !isEmail(b.email)) throw validation();
  if (!clientOf(k.session) && !(await verifyCaptcha(k, b.captcha)))
    throw fail(422, "captcha_failed");
  const id = `CB-${String(await nextSeq(k.db, "cb")).padStart(4, "0")}`;
  await k.db.insert(bkgRequests).values({
    id,
    name: b.name.trim(),
    phoneEnc: enc(k, b.phone)!,
    phoneMasked: maskPhone(b.phone)!,
    emailEnc: enc(k, b.email),
    topic: b.topic,
    preferredTimes: b.preferred_times,
    language: b.language,
  });
  auditLater(k, "consultation_request.created", id);
  return { id };
}
const requestOut = (
  k: K,
  r: typeof bkgRequests.$inferSelect,
): CallbackRequest => ({
  id: r.id,
  name: r.name,
  phone: dec(k, r.phoneEnc) ?? "",
  phoneMasked: r.phoneMasked,
  email: dec(k, r.emailEnc),
  topic: r.topic,
  preferredTimes: r.preferredTimes,
  language: r.language as Locale,
  status: r.status as CallbackRequest["status"],
  createdAt: r.createdAt,
  bookingRef: r.bookingRef ?? undefined,
  closeReason: r.closeReason ?? undefined,
});
// shortcut: newest 500 callback requests, no paging (reference contract); add keyset paging if the queue grows.
const listRequests = async (k: K) =>
  (
    await k.db
      .select()
      .from(bkgRequests)
      .orderBy(desc(bkgRequests.createdAt))
      .limit(500)
  ).map((r) => requestOut(k, r));
async function closeRequest(k: K, id: string, b: D.CloseRequestDto) {
  if (!b.close_reason.trim()) throw fail(422, "reason_required");
  const [r] = await k.db
    .update(bkgRequests)
    .set({ status: "closed", closeReason: b.close_reason.trim() })
    .where(eq(bkgRequests.id, id))
    .returning();
  if (!r) throw notFound();
  auditLater(k, "consultation_request.closed", id, { reason: b.close_reason });
  return requestOut(k, r);
}
async function joinWaitlist(k: K, b: D.WaitlistDto) {
  const t = await typeBySlug(k.db, b.type);
  if (!t) throw notFound();
  const c = b.contact.trim();
  const email = c.includes("@");
  if (email ? !isEmail(c) : !isPhone(c, true)) throw validation();
  const key = contactKey({ phone: email ? null : c, email: email ? c : null });
  const ins = await k.db
    .insert(bkgWaitlist)
    .values({
      id: generateId("wl"),
      typeSlug: t.slug,
      date: b.date,
      contactKey: key,
      contactEnc: enc(k, c)!,
    })
    .onConflictDoNothing()
    .returning({ id: bkgWaitlist.id });
  if (!ins.length) throw fail(409, "already_waiting");
  return { id: ins[0].id };
}
/** FIFO offer: the oldest un-offered waiter for (type, date) gets the freed slot link (job, after a cancel/expiry). */
async function offerWaitlist(k: K, typeSlug: string, date: string) {
  const t = await typeBySlug(k.db, typeSlug);
  if (!t) return null;
  const s = await slotsFor(k.db, typeSlug, date, date, null);
  if (!s.slots.length) return null;
  const [w] = await k.db
    .select()
    .from(bkgWaitlist)
    .where(
      and(
        eq(bkgWaitlist.typeSlug, typeSlug),
        eq(bkgWaitlist.date, date),
        isNull(bkgWaitlist.offeredAt),
      ),
    )
    .orderBy(asc(bkgWaitlist.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  if (!w) return null;
  await k.db
    .update(bkgWaitlist)
    .set({ offeredAt: iso(Date.now()) })
    .where(eq(bkgWaitlist.id, w.id));
  return {
    contact: dec(k, w.contactEnc),
    type: t,
    date,
    slots: s.slots.slice(0, 3),
  };
}

// ── client portal ─────────────────────────────────────────────────────────────────────────────────
async function myBookings(
  k: K,
  s: SessionUser,
  scope: "upcoming" | "past",
  locale: Locale,
) {
  const rows = await k.db
    .select()
    .from(bkgBookings)
    .where(and(eq(bkgBookings.clientId, s.id), ne(bkgBookings.reference, "")))
    .orderBy(asc(bkgBookings.startsAt));
  const now = Date.now();
  const live = (b: Booking) =>
    Date.parse(b.endsAt) >= now &&
    ["confirmed", "pending_payment"].includes(b.status);
  const out = (await viewMany(k, rows, "client", locale)).filter((b) =>
    scope === "past" ? !live(b) : live(b),
  );
  return scope === "past" ? out.reverse() : out;
}
async function mine(db: Tx, s: SessionUser, id: string, lock = false) {
  const r = await byId(db, id, lock);
  if (!r || !r.reference || r.clientId !== s.id) throw notFound(); // not own → 404, never 403
  return r;
}

// ── adviser ───────────────────────────────────────────────────────────────────────────────────────
async function staffRow(db: Tx, s: SessionUser, id: string, lock = false) {
  const r = await byId(db, id, lock);
  if (!r || !r.reference) throw notFound();
  if (isSM(s)) return r;
  const me = await adviserOfUser(db, s);
  if (!me || r.adviserId !== me.id) throw notFound();
  return r;
}
async function adviserBookings(
  k: K,
  s: SessionUser,
  from?: string,
  to?: string,
) {
  const me = await adviserOfUser(k.db, s);
  if (!me) throw forbidden();
  const f = from ?? dayOf(Date.now());
  const t = to ?? addDays(f, 7);
  const rows = await k.db
    .select()
    .from(bkgBookings)
    .where(
      and(
        eq(bkgBookings.adviserId, me.id),
        ne(bkgBookings.reference, ""),
        gte(bkgBookings.startsAt, at(f, "00:00")),
        lt(bkgBookings.startsAt, at(addDays(t, 1), "00:00")),
      ),
    )
    .orderBy(asc(bkgBookings.startsAt));
  return viewMany(k, rows, "staff");
}
/** Audit rows for these resource ids, newest first, as the UI's AuditEvent. */
async function historyOf(db: Tx, kind: string, ids: string[]) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(or(...ids.filter(Boolean).map((i) => eq(auditLog.resourceId, i))))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);
  const actorIds = [
    ...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x)),
  ];
  const names = new Map(
    actorIds.length
      ? (
          await db
            .select({ id: users.userId, name: users.name })
            .from(users)
            .where(inArray(users.userId, actorIds))
        ).map((u) => [u.id, u.name])
      : [],
  );
  return rows.map((r) => {
    const d = (r.details ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      at: r.createdAt,
      actor:
        (r.actorId && names.get(r.actorId)) ||
        (r.actorId ? (r.actorRole ?? "staff") : "system"),
      action: r.action,
      entity: { kind, id: r.resourceId ?? "" },
      before: d.before,
      after: d.after,
      reason: typeof d.reason === "string" ? d.reason : undefined,
      ip: r.ipAddress ?? "",
    };
  });
}
async function room(k: K, s: SessionUser, id: string, smOnly = false) {
  if (smOnly && !isSM(s)) throw notFound();
  const r = await staffRow(k.db, s, id);
  const prevRows = r.contactKey
    ? await k.db
        .select()
        .from(bkgBookings)
        .where(
          and(
            eq(bkgBookings.contactKey, r.contactKey),
            ne(bkgBookings.id, r.id),
            ne(bkgBookings.reference, ""),
          ),
        )
        .orderBy(desc(bkgBookings.startsAt))
        .limit(20)
    : [];
  const v = (await viewOne(k, r, "staff")) as StaffBooking;
  return {
    ...v,
    previous: prevRows.map((b) => ({
      reference: b.reference,
      startsAt: b.startsAt,
      status: effStatus(b),
      typeName: b.typeName,
    })),
    history: await historyOf(k.db, "booking", [r.reference, r.id]),
  };
}
async function saveNotes(k: K, s: SessionUser, id: string, b: D.NotesDto) {
  const r = await staffRow(k.db, s, id, true);
  if (b.version !== r.version) throw stale(r.version);
  const row = await save(k.db, r.id, {
    ...(b.outcome_notes !== undefined ? { outcomeNotes: b.outcome_notes } : {}),
    ...(b.client_summary !== undefined
      ? { clientSummary: b.client_summary }
      : {}),
    version: r.version + 1,
  });
  return { version: row.version, savedAt: row.updatedAt };
}
async function startLinks(k: K, slugs: string[]) {
  const svc = (await k.d.catalogue.listPublicServices()).services;
  return slugs.map((slug) => ({
    slug,
    name: svc.find((x) => x.slug === slug)?.name_en ?? slug,
    href: `/apply/${slug}?from=booking`,
  }));
}
async function outcome(k: K, s: SessionUser, id: string, b: D.OutcomeDto) {
  const r = await staffRow(k.db, s, id, true);
  if (b.version !== r.version) throw stale(r.version);
  const g = can(
    "outcome",
    { ...r, status: r.status as BookingStatus },
    "staff",
    Date.now(),
  );
  if (!g.ok) throw fail(409, g.reason);
  const rec = b.recommended_service_ids;
  const row = await save(k.db, r.id, {
    status: b.status,
    recommended: rec,
    startLinks: b.send_start_links ? await startLinks(k, rec) : [],
    version: r.version + 1,
    events: [
      ...r.events,
      {
        at: iso(Date.now()),
        kind: b.status === "completed" ? "completed" : "no_show",
      },
    ],
  });
  auditLater(k, "booking.outcome", r.reference, {
    after: { status: b.status, services: rec },
  });
  if (b.status === "completed" && b.send_start_links && rec.length)
    await notify(k, "next_steps", r.id);
  // F-BKG-11: the CRM moves the matching lead to "qualified" (marketing worker); contact sealed in the outbox row.
  if (b.status === "completed")
    await emit(k, "booking.outcome_recorded", k.d.crypto.seal({ phone: dec(k, r.phoneEnc) ?? undefined, email: dec(k, r.emailEnc) ?? undefined, status: b.status, services: rec }, ["phone", "email"]) as Record<string, unknown>);
  return viewOne(k, row, "staff");
}
async function quoteRequest(k: K, s: SessionUser, id: string, b: D.QuoteDto) {
  const r = await staffRow(k.db, s, id, true);
  if (
    !b.lines.length ||
    b.lines.some((l) => !l.label.trim() || l.qty < 1 || l.unit < 0)
  )
    throw validation();
  // D-5: advisers draft → SM sends; SM sends directly. QUO-YYYY-NNNNN numbering (A-4).
  const send = isSM(s) && !!b.send;
  const quoteRef = send
    ? `QUO-${year()}-${String(await nextSeq(k.db, `quo-${year()}`)).padStart(5, "0")}`
    : r.quoteRef;
  const row = await save(k.db, r.id, {
    quoteRef,
    quoteRequest: { lines: b.lines, status: send ? "sent" : "waiting" },
    version: r.version + 1,
  });
  auditLater(k, "booking.quote_requested", r.reference, {
    after: { send, total: b.lines.reduce((a, l) => a + l.qty * l.unit, 0) },
  });
  return viewOne(k, row, "staff");
}

// ── availability ──────────────────────────────────────────────────────────────────────────────────
const availabilityOut = (a: AdvRow): Availability => ({
  adviserId: a.id,
  rules: a.rules,
  overrides: a.overrides,
  leave: a.leave.map((l) => ({ ...l, label: "Approved leave" })),
  version: a.version,
});
async function myAvailability(k: K, s: SessionUser) {
  const me = await adviserOfUser(k.db, s);
  if (!me) throw forbidden();
  return availabilityOut(me);
}
async function setAvailability(k: K, s: SessionUser, b: D.AvailabilityDto) {
  const me = await adviserOfUser(k.db, s);
  if (!me) throw forbidden();
  const [locked] = await k.db
    .select()
    .from(bkgAdvisers)
    .where(eq(bkgAdvisers.id, me.id))
    .for("update");
  if (b.version !== locked.version) throw stale(locked.version);
  if (b.rules.some((r) => r.start >= r.end)) throw validation();
  const [a] = await k.db
    .update(bkgAdvisers)
    .set({
      rules: b.rules as AvailabilityRule[],
      ...(b.overrides
        ? { overrides: b.overrides as AvailabilityOverride[] }
        : {}),
      version: locked.version + 1,
      updatedAt: iso(Date.now()),
    })
    .where(eq(bkgAdvisers.id, me.id))
    .returning();
  auditLater(k, "availability.updated", me.id);
  // Bookings now outside availability stay (never auto-cancelled) and come back as warnings.
  const upcoming = await k.db
    .select()
    .from(bkgBookings)
    .where(
      and(
        eq(bkgBookings.adviserId, me.id),
        eq(bkgBookings.status, "confirmed"),
        gte(bkgBookings.startsAt, iso(Date.now())),
      ),
    );
  const sa = slotAdviser(a);
  const affected = upcoming.filter((r) => {
    const day = dayOf(r.startsAt);
    return !computeSlots(
      {
        durationMin: Math.round(
          (Date.parse(r.endsAt) - Date.parse(r.startsAt)) / MIN,
        ),
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        minNoticeMin: 0,
        horizonDays: 365,
        maxPerDay: 99,
        advisers: [sa],
        bookings: [],
        externalBusy: [],
        from: day,
        to: day,
        adviserId: a.id,
      },
      Date.parse(r.startsAt) - MIN,
    ).some((x) => x.startsAt === r.startsAt);
  });
  return {
    ...availabilityOut(a),
    warnings: await viewMany(k, affected, "staff"),
  };
}

// ── service manager board ─────────────────────────────────────────────────────────────────────────
async function adminList(
  k: K,
  q: D.AdminListQ,
  now = Date.now(),
): Promise<AdminBookings> {
  const db = k.db;
  const conds = [ne(bkgBookings.reference, "")];
  if (q.date)
    conds.push(
      gte(bkgBookings.startsAt, at(q.date, "00:00")),
      lt(bkgBookings.startsAt, at(addDays(q.date, 1), "00:00")),
    );
  if (q.adviser) conds.push(eq(bkgBookings.adviserId, q.adviser));
  if (q.type) conds.push(eq(bkgBookings.typeSlug, q.type));
  if (q.q)
    conds.push(
      dsql`(${bkgBookings.reference} || ' ' || ${bkgBookings.contactName}) ilike ${"%" + q.q.replace(/[%_\\]/g, "") + "%"}`,
    );
  // shortcut: board capped at 1000 rows (reference contract has no cursor); add keyset paging when volume needs it.
  const rows = await db
    .select()
    .from(bkgBookings)
    .where(and(...conds))
    .orderBy(asc(bkgBookings.startsAt))
    .limit(1000);
  const x = await viewCtx(db, rows);
  const views = rows
    .map((r) => view(k, r, x, "staff", "en", now) as StaffBooking)
    .filter((b) => !q.status || b.status === q.status);
  const today = dayOf(now);
  const advisers = [...x.advisers.values()].sort(
    (a, b) => a.priority - b.priority,
  );
  const future = await db
    .select()
    .from(bkgBookings)
    .where(
      and(
        eq(bkgBookings.status, "confirmed"),
        gte(bkgBookings.startsAt, iso(now)),
      ),
    );
  const onLeave = (a: AdvRow, day: string) =>
    a.leave.some((l) => day >= l.from && day <= l.to);
  return {
    bookings: views,
    advisers: advisers.map((a) => ({
      id: a.id,
      name: a.name,
      deactivated: !a.active,
      onLeave: onLeave(a, today),
      load: rows.filter(
        (b) => b.adviserId === a.id && ACTIVE.includes(effStatus(b, now)),
      ).length,
    })),
    alerts: advisers
      .map((a) => ({
        adviserId: a.id,
        name: a.name,
        count: future.filter(
          (b) =>
            b.adviserId === a.id &&
            (!a.active || onLeave(a, dayOf(b.startsAt))),
        ).length,
        why: (a.active ? "leave" : "deactivated") as "leave" | "deactivated",
      }))
      .filter((y) => y.count > 0),
  };
}
async function adviserFree(db: Tx, adviserId: string, r: Row) {
  const t = await typeBySlug(db, r.typeSlug);
  const [a] = await db
    .select()
    .from(bkgAdvisers)
    .where(eq(bkgAdvisers.id, adviserId));
  if (!t || !a) return false;
  const day = dayOf(r.startsAt);
  await dayLock(db, day);
  const inp = await slotInput(db, t, day, day, adviserId, {
    ignoreId: r.id,
    advisers: [a],
  });
  return computeSlots(
    { ...inp, minNoticeMin: 0, horizonDays: 365 },
    Math.min(Date.now(), Date.parse(r.startsAt) - MIN),
  ).some((x) => x.startsAt === r.startsAt);
}
async function reassignRow(k: K, r: Row, adviserId: string, reason: string) {
  const advisers = new Map(
    (await k.db.select().from(bkgAdvisers)).map((a) => [a.id, a]),
  );
  const from = r.adviserId ? advisers.get(r.adviserId)?.name : undefined;
  const to = advisers.get(adviserId)?.name;
  const row = await save(k.db, r.id, {
    adviserId,
    version: r.version + 1,
    events: [
      ...r.events,
      { at: iso(Date.now()), kind: "reassigned", note: `${from} → ${to}` },
    ],
  });
  auditLater(k, "booking.reassigned", r.reference, {
    reason,
    before: { adviser: from },
    after: { adviser: to },
  });
  await notify(k, "reassigned", r.id);
  return row;
}
async function adminPatch(k: K, id: string, b: D.AdminPatchDto) {
  if (!b.reason.trim()) throw fail(422, "reason_required");
  const r = await byId(k.db, id, true);
  if (!r || !r.reference) throw notFound();
  if (b.version !== r.version) throw stale(r.version);
  let row: Row = r;
  if (b.action === "reassign") {
    if (!b.adviser_id || !(await adviserFree(k.db, b.adviser_id, r)))
      throw fail(409, "slot_taken");
    row = await reassignRow(k, r, b.adviser_id, b.reason);
  } else if (b.action === "cancel") {
    if (!ACTIVE.includes(effStatus(r))) throw fail(409, "terminal");
    row = await cancelRow(k, r, "staff", { reason: b.reason });
  } else {
    const st = effStatus(r);
    const patch: Partial<Row> = { version: r.version + 1 };
    if (b.override === "waive_no_show" && st === "no_show")
      patch.status = "completed";
    if (b.override === "extra_reschedule")
      patch.rescheduleCount = Math.max(0, r.rescheduleCount - 1);
    if (
      b.override === "late_refund" &&
      st === "cancelled_by_client" &&
      !r.refund &&
      r.paid
    ) {
      patch.refund = {
        ref: await refundRef(k.db),
        amount: r.price,
        kind: "refund",
      };
      await refundRequested(k, r, patch.refund);
    }
    row = await save(k.db, r.id, patch);
    auditLater(k, "booking.override", r.reference, {
      reason: b.reason,
      after: { kind: b.override },
    });
  }
  return viewOne(k, row, "staff");
}
async function autoReassign(k: K, adviserId: string) {
  const [a] = await k.db
    .select()
    .from(bkgAdvisers)
    .where(eq(bkgAdvisers.id, adviserId));
  if (!a) throw notFound();
  const rows = await k.db
    .select()
    .from(bkgBookings)
    .where(
      and(
        eq(bkgBookings.adviserId, adviserId),
        eq(bkgBookings.status, "confirmed"),
        gte(bkgBookings.startsAt, iso(Date.now())),
      ),
    )
    .for("update");
  const all = await k.db.select().from(bkgAdvisers);
  const moved: string[] = [];
  const unresolved: string[] = [];
  for (const b of rows.filter(
    (b) =>
      !a.active ||
      a.leave.some(
        (l) => dayOf(b.startsAt) >= l.from && dayOf(b.startsAt) <= l.to,
      ),
  )) {
    const t = await typeBySlug(k.db, b.typeSlug);
    const cand: string[] = [];
    for (const id of t?.adviserIds ?? [])
      if (id !== adviserId && (await adviserFree(k.db, id, b))) cand.push(id);
    if (!cand.length) {
      unresolved.push(b.reference);
      continue;
    }
    const day = dayOf(b.startsAt);
    const load = await k.db
      .select({
        adviserId: bkgBookings.adviserId,
        startsAt: bkgBookings.startsAt,
        endsAt: bkgBookings.endsAt,
        status: bkgBookings.status,
      })
      .from(bkgBookings)
      .where(
        and(
          inArray(bkgBookings.adviserId, cand),
          gte(bkgBookings.startsAt, at(day, "00:00")),
          lt(bkgBookings.startsAt, at(addDays(day, 1), "00:00")),
        ),
      );
    const best = pickAdviser(
      { startsAt: b.startsAt, endsAt: b.endsAt, adviserIds: cand },
      all.map(slotAdviser),
      load.map((x) => ({ ...x, status: x.status as BookingStatus })),
    );
    await reassignRow(k, b, best, "Auto-reassign: adviser unavailable");
    moved.push(b.reference);
  }
  return { moved, unresolved };
}
async function staffCreate(k: K, b: D.StaffCreateDto) {
  const t = await typeBySlug(k.db, b.type);
  if (!t || !b.name.trim()) throw validation();
  if (b.phone && !isPhone(b.phone, true))
    throw new AppError(
      422,
      "validation",
      "validation",
      { phone: "invalid" },
      { fields: { phone: "invalid" } },
    );
  if (b.email && !isEmail(b.email))
    throw new AppError(
      422,
      "validation",
      "validation",
      { email: "invalid" },
      { fields: { email: "invalid" } },
    );
  // Staff may book inside the client notice window, never in the past.
  const { row } = await hold(k.db, t, b.starts_at, b.adviser_id ?? null, {
    minNoticeMin: 0,
  });
  const { row: done } = await finalize(k, row, {
    name: b.name.trim(),
    phone: b.phone,
    email: b.email,
    clientId: b.client_id ?? null,
    intake: b.notes ? { notes: b.notes } : {},
    whatsapp: false,
    language: "en",
    mode: b.mode,
    family: null,
    service: null,
    source: "staff",
    staff: true, // staff bookings are invoiced later through finance
  });
  auditLater(k, "booking.created_by_staff", done.reference);
  if (b.request_id) {
    const [req] = await k.db
      .update(bkgRequests)
      .set({ status: "scheduled", bookingRef: done.reference })
      .where(eq(bkgRequests.id, b.request_id))
      .returning();
    if (req)
      auditLater(k, "consultation_request.scheduled", req.id, {
        after: { booking: done.reference },
      });
  }
  return viewOne(k, done, "staff");
}

// ── consultation types admin ──────────────────────────────────────────────────────────────────────
async function typesAdmin(k: K, s: SessionUser) {
  const types = await k.db.select().from(bkgTypes).orderBy(asc(bkgTypes.slug));
  const advisers = await k.db
    .select()
    .from(bkgAdvisers)
    .orderBy(asc(bkgAdvisers.priority));
  return {
    types: types.map((t) => typeOut(t)),
    advisers: advisers.map((a) => ({ id: a.id, name: a.name })),
    canEdit: isSM(s) ? ("all" as const) : ("copy" as const),
  };
}
const TYPE_KEYS = [
  "slug",
  "name",
  "description",
  "durationMin",
  "modes",
  "price",
  "bufferBeforeMin",
  "bufferAfterMin",
  "minNoticeMin",
  "horizonDays",
  "maxPerDay",
  "familySlugs",
  "serviceSlugs",
  "adviserIds",
  "intakeSchema",
  "prepare",
  "freeOncePerFamily",
  "isActive",
] as const;
const typeCols = (b: D.TypeDto): Partial<TypeRow> =>
  Object.fromEntries(
    TYPE_KEYS.filter((key) => b[key] !== undefined).map((key) => [key, b[key]]),
  );
async function createType(k: K, b: D.TypeDto) {
  if (
    !b.slug ||
    !/^[a-z0-9-]{2,96}$/.test(b.slug) ||
    !b.name ||
    !b.description ||
    !b.durationMin ||
    !b.modes?.length
  )
    throw validation();
  if (await typeBySlug(k.db, b.slug)) throw validation({ slug: "taken" });
  const [t] = await k.db
    .insert(bkgTypes)
    .values({
      ...typeCols(b),
      id: `ct-${b.slug}`,
      slug: b.slug,
      name: b.name,
      description: b.description,
      durationMin: b.durationMin,
      modes: b.modes,
      version: 1,
    })
    .returning();
  auditLater(k, "consultation_type.updated", t.slug, { after: typeOut(t) });
  return typeOut(t);
}
async function patchType(k: K, s: SessionUser, id: string, b: D.TypePatchDto) {
  const [t] = await k.db
    .select()
    .from(bkgTypes)
    .where(eq(bkgTypes.id, id))
    .for("update");
  if (!t) throw notFound();
  if (b.version !== t.version) throw stale(t.version);
  // Marketing edits copy only (bkg.type.copy); the slug never changes (links and history key on it).
  const patch = isSM(s)
    ? typeCols(b)
    : typeCols({ name: b.name, description: b.description });
  delete patch.slug;
  const [n] = await k.db
    .update(bkgTypes)
    .set({ ...patch, version: t.version + 1, updatedAt: iso(Date.now()) })
    .where(eq(bkgTypes.id, id))
    .returning();
  auditLater(k, "consultation_type.updated", t.slug, {
    before: typeOut(t),
    after: typeOut(n),
  });
  return typeOut(n);
}

// ── analytics ─────────────────────────────────────────────────────────────────────────────────────
async function analytics(db: Tx, now = Date.now()): Promise<BookingAnalytics> {
  const rows = await db
    .select()
    .from(bkgBookings)
    .where(
      and(
        ne(bkgBookings.reference, ""),
        gte(bkgBookings.startsAt, iso(now - 90 * 86_400_000)),
      ),
    );
  const advisers = await db.select().from(bkgAdvisers);
  const st = rows.map((r) => ({ r, s: effStatus(r, now) }));
  const attended = st.filter((x) => x.s === "completed").length;
  const noShow = st.filter((x) => x.s === "no_show").length;
  const past = attended + noShow || 1;
  const lead = rows
    .map((r) => (Date.parse(r.startsAt) - Date.parse(r.createdAt)) / 86_400_000)
    .filter((d) => d >= 0);
  // Utilisation: booked minutes ÷ available minutes over the last 30 days across active advisers.
  let avail = 0;
  for (let d = addDays(dayOf(now), -30); d < dayOf(now); d = addDays(d, 1))
    for (const a of advisers.filter((y) => y.active)) {
      if (a.leave.some((l) => d >= l.from && d <= l.to)) continue;
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      for (const r of a.rules.filter((y) => y.weekday === wd))
        avail +=
          (Date.parse(`1970-01-01T${r.end}:00Z`) -
            Date.parse(`1970-01-01T${r.start}:00Z`)) /
          MIN;
    }
  const used = st
    .filter(
      (x) =>
        ["completed", "no_show", "confirmed"].includes(x.s) &&
        Date.parse(x.r.startsAt) >= now - 30 * 86_400_000 &&
        Date.parse(x.r.startsAt) < now,
    )
    .reduce(
      (a, x) => a + (Date.parse(x.r.endsAt) - Date.parse(x.r.startsAt)) / MIN,
      0,
    );
  const freeDone = st.filter((x) => x.s === "completed" && x.r.price === 0);
  const converted = freeDone.filter(
    (x) =>
      x.r.quoteRef ||
      x.r.startLinks.length ||
      rows.some(
        (y) =>
          y.contactKey === x.r.contactKey &&
          y.price > 0 &&
          y.paid &&
          y.startsAt > x.r.startsAt,
      ),
  ).length;
  const count = (f: (r: Row) => string) =>
    Object.entries(
      rows.reduce<Record<string, number>>(
        (m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m),
        {},
      ),
    )
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  const names = new Map(advisers.map((a) => [a.id, a.name]));
  return {
    funnel: [
      { label: "Booked", value: rows.length },
      { label: "Attended", value: attended },
      {
        label: "Paid work ≤ 30 d",
        value: rows.filter((r) => r.quoteRef || r.startLinks.length).length,
      },
    ],
    showUp: Math.round((attended / past) * 100),
    noShow: Math.round((noShow / past) * 100),
    leadTimeDays: lead.length
      ? Math.round(lead.reduce((a, b) => a + b, 0) / lead.length)
      : 0,
    utilisation: avail ? Math.min(100, Math.round((used / avail) * 100)) : 0,
    freeToPaid: freeDone.length
      ? Math.round((converted / freeDone.length) * 100)
      : 0,
    revenue: rows
      .filter(
        (r) => r.paid && r.price && !(r.refund && r.refund.kind === "refund"),
      )
      .reduce((s, r) => s + r.price, 0),
    byType: count((r) => r.typeName.en),
    byAdviser: count((r) => (r.adviserId && names.get(r.adviserId)) || "—"),
    bySource: count((r) => r.source),
  };
}

// ── sweeps (cron) ─────────────────────────────────────────────────────────────────────────────────
/** Writes what effStatus already shows: auto no-show and lapsed holds; queues waitlist offers for freed days. */
async function sweep(k: K, now = Date.now()) {
  const noShow = await k.db
    .update(bkgBookings)
    .set({
      status: "no_show",
      events: dsql`${bkgBookings.events} || ${JSON.stringify([{ at: iso(now), kind: "no_show", note: "auto" }])}::jsonb`,
      updatedAt: iso(now),
    })
    .where(
      and(
        eq(bkgBookings.status, "confirmed"),
        lt(bkgBookings.endsAt, iso(now - BKG.autoNoShowMin * MIN)),
      ),
    )
    .returning({ ref: bkgBookings.reference });
  const expired = await k.db
    .update(bkgBookings)
    .set({
      status: "expired",
      events: dsql`${bkgBookings.events} || ${JSON.stringify([{ at: iso(now), kind: "expired" }])}::jsonb`,
      updatedAt: iso(now),
    })
    .where(
      and(
        inArray(bkgBookings.status, ["held", "pending_payment"]),
        eq(bkgBookings.paid, false),
        lt(bkgBookings.holdExpiresAt, iso(now)),
      ),
    )
    .returning({
      typeSlug: bkgBookings.typeSlug,
      startsAt: bkgBookings.startsAt,
      reference: bkgBookings.reference,
    });
  for (const r of noShow)
    if (r.ref)
      auditLater(k, "booking.no_show", r.ref, { after: { auto: true } });
  const freed = new Set(
    expired
      .filter((e) => e.reference)
      .map((e) => `${e.typeSlug}|${dayOf(e.startsAt)}`),
  );
  for (const f of freed) {
    const [typeSlug, date] = f.split("|");
    await offerLater(k, typeSlug, date);
  }
  return { noShow: noShow.length, freed: freed.size };
}
/** Due reminders (planned/deferred with at ≤ now) for confirmed bookings: marked sent and queued as `booking.notify`. */
async function dueReminders(k: K, now = Date.now()) {
  const rows = await k.db
    .select()
    .from(bkgBookings)
    .where(
      and(
        eq(bkgBookings.status, "confirmed"),
        gte(bkgBookings.startsAt, iso(now)),
        lt(bkgBookings.startsAt, iso(now + 26 * H)),
      ),
    )
    .for("update", { skipLocked: true });
  let n = 0;
  for (const r of rows) {
    const due = r.reminders.filter(
      (x) =>
        (x.status === "planned" || x.status === "deferred") &&
        Date.parse(x.at) <= now,
    );
    if (!due.length) continue;
    await k.db
      .update(bkgBookings)
      .set({
        reminders: r.reminders.map((x) =>
          due.includes(x) ? { ...x, status: "sent" as const } : x,
        ),
        events: [
          ...r.events,
          ...due.map((d) => ({
            at: iso(now),
            kind: "reminder" as const,
            note: d.kind,
          })),
        ],
      })
      .where(eq(bkgBookings.id, r.id));
    // the adviser sees adviser_15m on the today board; no message to the client
    if (due.some((d) => d.kind !== "adviser_15m")) {
      await notify(k, "reminder", r.id);
      n++;
    }
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
@Injectable()
export class BookingService {
  private readonly d: Deps;
  constructor(
    private readonly txs: TxService,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestStore>,
    @Inject(REDIS) private readonly redis: IORedis,
    outbox: OutboxService,
    crypto: CryptoService,
    catalogue: CatalogueService,
    config: ConfigService<Env, true>,
    payments: PaymentsService,
    ledger: LedgerService,
  ) {
    this.d = {
      crypto,
      outbox,
      catalogue,
      prod: config.get("NODE_ENV", { infer: true }) === "production",
      turnstile: config.get("TURNSTILE_SECRET_KEY", { infer: true }) || undefined,
      payments,
      ledger,
      webBase: config.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim().replace(/\/$/, ""),
    };
  }

  /** One transaction per call; queued audit rows are written last (the chain lock is held until commit). */
  run<T>(fn: (k: K) => Promise<T>, system = false): Promise<T> {
    const body = async (db: Tx) => {
      const k: K = {
        db,
        session: this.cls.isActive() ? (this.cls.get("user") ?? null) : null,
        ip: this.cls.isActive() ? (this.cls.get("ip") ?? "") : "",
        d: this.d,
        audits: [],
      };
      const out = await fn(k);
      for (const a of k.audits) await this.audit.record(db, a);
      return out;
    };
    return system ? this.txs.runAsSystem(body) : this.txs.run(body);
  }

  /** Per-key hourly cap for the no-enumeration endpoints (resend, callbacks), on top of the per-minute limiter. */
  private async hourly(name: string, max: number) {
    const who = this.cls.get("user")?.id ?? this.cls.get("ip");
    const key = `bkg:rl:${name}:${who}`;
    let n = 0;
    try {
      n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, 3600);
    } catch {
      return; // fail-open: Redis down must not block callbacks
    }
    if (n > max)
      throw new AppError(429, "rate_limited", "Too many requests", undefined, {
        retryAfter: 3600,
      });
  }

  // public
  listTypes = (contact?: string) => this.run((k) => listTypes(k, contact));
  getType = (slug: string) => this.run((k) => getType(k, slug));
  slots = (slug: string, q: D.SlotsQ) =>
    this.run((k) => slotsFor(k.db, slug, q.from, q.to, q.adviser_id || null));
  advisers = (type?: string) =>
    this.run((k) => listAdvisers(k.db, type || null));
  hold = (b: D.HoldDto) => this.run((k) => holdPublic(k, b));
  holdStatus = (id: string) => this.run((k) => holdStatus(k.db, id));
  releaseHold = (id: string) => this.run((k) => releaseHold(k.db, id));
  confirm = (id: string, b: D.ConfirmDto) => this.run((k) => confirm(k, id, b));
  /** Reserve (tx) → gateway (no tx) → record the answer (tx), same split as PaymentsService. */
  pay = async (id: string, b: D.PayDto) => {
    const r = await this.run((k) => pay(k, id, b));
    const st = r.start;
    if (!st) return r as { transactionId: string; expiresAt: string; checkoutUrl: string | null };
    const { transactionId, kind, amountRwf, phone, returnUrl } = st;
    const initiated = await this.d.payments
      .initiateBooking({ transactionId, kind, amountRwf, phone, returnUrl })
      .catch(async (e: unknown) => {
        await this.run((k) => payInitiated(k, st, b.method, null));
        throw e;
      });
    return (await this.run((k) => payInitiated(k, st, b.method, initiated)))!;
  };
  payStatus = (txId: string) => this.run((k) => payStatus(k, txId));
  /** Payment webhook entry (payments module): the payload is only a nudge, payStatus re-reads state. */
  settle = (txId: string) =>
    this.payStatus(txId).catch((e: unknown) =>
      new Logger(BookingService.name).warn(
        `bkg_settle_failed ${txId}: ${String(e)}`,
      ),
    );
  byConfirmKey = (ref: string, key: string | undefined, l?: string) =>
    this.run((k) => byConfirmKey(k, ref, key, lang(l)));
  manageView = (tk: string, l?: string) =>
    this.run(async (k) =>
      viewOne(k, await managed(k.db, tk), "client", lang(l)),
    );
  manageCancel = (tk: string, b: D.CancelDto) =>
    this.run(async (k) => cancelBy(k, await managed(k.db, tk, true), b));
  manageReschedule = (tk: string, b: D.RescheduleDto) =>
    this.run(async (k) => rescheduleBy(k, await managed(k.db, tk, true), b));
  manageJoin = (tk: string) =>
    this.run(async (k) => joinFor(await managed(k.db, tk)));
  async resend(b: D.ResendDto) {
    await this.hourly("resend", 5);
    return this.run((k) => resend(k, b));
  }
  async createRequest(b: D.RequestDto) {
    await this.hourly("cb", 5);
    return this.run((k) => createRequest(k, b));
  }
  joinWaitlist = (b: D.WaitlistDto) => this.run((k) => joinWaitlist(k, b));

  // client portal
  myBookings = (s: SessionUser, q: D.MyBookingsQ) =>
    this.run((k) => myBookings(k, s, q.scope, lang(q.lang)));
  myBooking = (s: SessionUser, id: string, l?: string) =>
    this.run(async (k) =>
      viewOne(k, await mine(k.db, s, id), "client", lang(l)),
    );
  myCancel = (s: SessionUser, id: string, b: D.CancelDto) =>
    this.run(async (k) => cancelBy(k, await mine(k.db, s, id, true), b));
  myReschedule = (s: SessionUser, id: string, b: D.RescheduleDto) =>
    this.run(async (k) => rescheduleBy(k, await mine(k.db, s, id, true), b));
  myJoin = (s: SessionUser, id: string) =>
    this.run(async (k) => joinFor(await mine(k.db, s, id)));

  // adviser
  adviserBookings = (s: SessionUser, q: D.RangeQ) =>
    this.run((k) => adviserBookings(k, s, q.from, q.to));
  room = (s: SessionUser, id: string, smOnly = false) =>
    this.run((k) => room(k, s, id, smOnly));
  staffJoin = (s: SessionUser, id: string) =>
    this.run(async (k) => joinFor(await staffRow(k.db, s, id)));
  saveNotes = (s: SessionUser, id: string, b: D.NotesDto) =>
    this.run((k) => saveNotes(k, s, id, b));
  outcome = (s: SessionUser, id: string, b: D.OutcomeDto) =>
    this.run((k) => outcome(k, s, id, b));
  quoteRequest = (s: SessionUser, id: string, b: D.QuoteDto) =>
    this.run((k) => quoteRequest(k, s, id, b));
  myAvailability = (s: SessionUser) => this.run((k) => myAvailability(k, s));
  setAvailability = (s: SessionUser, b: D.AvailabilityDto) =>
    this.run((k) => setAvailability(k, s, b));

  // service manager
  adminList = (q: D.AdminListQ) => this.run((k) => adminList(k, q));
  analytics = () => this.run((k) => analytics(k.db));
  adminPatch = (id: string, b: D.AdminPatchDto) =>
    this.run((k) => adminPatch(k, id, b));
  autoReassign = (adviserId: string) =>
    this.run((k) => autoReassign(k, adviserId));
  staffCreate = (b: D.StaffCreateDto) => this.run((k) => staffCreate(k, b));
  listRequests = () => this.run((k) => listRequests(k));
  closeRequest = (id: string, b: D.CloseRequestDto) =>
    this.run((k) => closeRequest(k, id, b));
  typesAdmin = (s: SessionUser) => this.run((k) => typesAdmin(k, s));
  createType = (b: D.TypeDto) => this.run((k) => createType(k, b));
  patchType = (s: SessionUser, id: string, b: D.TypePatchDto) =>
    this.run((k) => patchType(k, s, id, b));

  // worker (runAsSystem)
  /** Payments captured but never polled (tab closed after paying): settle them before the sweep expires their holds. */
  openPayments = () =>
    this.run(
      (k) =>
        k.db
          .select({ id: bkgPayments.id })
          .from(bkgPayments)
          .innerJoin(bkgBookings, eq(bkgBookings.id, bkgPayments.bookingId))
          .where(
            and(
              inArray(bkgPayments.status, [
                "initiating",
                "pending",
                "succeeded",
              ]),
              eq(bkgBookings.status, "pending_payment"),
            ),
          )
          .limit(200),
      true,
    ); // shortcut: 200 per tick, page if volume exceeds it
  sweep = () => this.run((k) => sweep(k), true);
  dueReminders = () => this.run((k) => dueReminders(k), true);
  offerWaitlist = (typeSlug: string, date: string) =>
    this.run((k) => offerWaitlist(k, typeSlug, date), true);
  /** Booking + decrypted contact for a message job. */
  forMessage = (id: string) =>
    this.run(async (k) => {
      const r = await byId(k.db, id);
      return (
        r && {
          row: r,
          phone: dec(k, r.phoneEnc),
          email: dec(k, r.emailEnc),
          language: lang(r.language),
        }
      );
    }, true);
}
