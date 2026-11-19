import { randomUUID } from "node:crypto";
import { consentLedger } from "@/db/schema/schema-notifications";
import { siteEvents } from "@/db/schema/schema-marketing";
import { recommend, type RecRule } from "@/domain/marketing/recommend";
import { and as dand, eq as deq, gte, sql as dsqlx } from "drizzle-orm";
import { POLICY_VERSION } from "../notifications/notifications.delivery";
// P11 CRM services (port of src/mocks/handlers-marketing-crm.ts): lead capture from every channel, the lead pipeline
// (stage machine, merge, convert, bulk, import, export), tasks, notes, the unified inbox and the customer 360.
// Callable from routes, jobs and Server Components (Caller = { db, session }).
import { outbox } from "@/db/schema";
import type { Exec } from "./marketing.store";
import { canMove, isOpen } from "@/domain/marketing/lead-machine";
import { duplicatesOf, toE164, validEmail } from "@/domain/marketing/dedupe";
import { matchLead, revenueOf } from "@/domain/marketing/conversion";
import { maskPhone, toCsv } from "@/domain/marketing/export";
import { MKT_POLICY } from "@/domain/marketing/policy";
import type {
  Campaign,
  Channel,
  ConsentState,
  Contact,
  CrmNote,
  CrmTask,
  InboxThread,
  Lead,
  LeadActivity,
  LeadSource,
  Locale,
  MsgTemplate,
  Touch,
} from "@/domain/marketing/types";
import type {
  ConsentEvent,
  Customer360,
  CustomerRow,
  ImportRow,
  LeadKpi,
  LeadPatch,
  NewLead,
  TimelineEvent,
} from "./lib/crm-types";
import {
  type Caller,
  actorId,
  auditReason,
  casesOf,
  get,
  leadNo,
  list,
  mktError,
  notFound,
  nextNo,
  paidInvoices,
  pushNote,
  put,
  record,
  remove,
  seqId,
  staffList,
  staffOf,
} from "./marketing.store";

const D = 86_400_000;
const nowIso = () => new Date().toISOString();
const unk = (): Record<Channel, ConsentState> => ({
  email: "unknown",
  whatsapp: "unknown",
  sms: "unknown",
});

// ---------------------------------------------------------------- persistence helpers
export const saveLead = (db: Exec, l: Lead) =>
  put(db, {
    kind: "lead",
    id: l.id,
    data: l,
    status: l.stage,
    ref: l.clientId ?? null,
  });
const saveThread = (db: Exec, t: InboxThread) =>
  put(db, {
    kind: "thread",
    id: t.id,
    data: t,
    status: t.unread ? "unread" : "read",
    ref: t.leadId ?? null,
  });
const saveTask = (db: Exec, t: CrmTask) =>
  put(db, {
    kind: "task",
    id: t.id,
    data: t,
    status: t.done ? "done" : "open",
    ref: t.subject.id,
  });
const bump = (l: Lead) => {
  l.updatedAt = nowIso();
  l.version++;
};
export const liveLeads = async (db: Exec) =>
  (await list<Lead>(db, "lead")).filter((l) => l.stage !== "merged");

async function act(
  c: Caller,
  leadId: string,
  kind: LeadActivity["kind"],
  text: string,
) {
  const a: LeadActivity = {
    id: await seqId(c.db, "ac"),
    leadId,
    kind,
    text,
    by: actorId(c),
    at: nowIso(),
  };
  await put(c.db, { kind: "activity", id: a.id, data: a, ref: leadId });
  return a;
}

function kpi(ls: Lead[]): LeadKpi {
  const n = (s: Lead["stage"]) => ls.filter((l) => l.stage === s).length;
  const m = new Date();
  m.setUTCDate(1);
  m.setUTCHours(0, 0, 0, 0);
  const month = m.toISOString();
  return {
    total: ls.length,
    new: n("new"),
    contacted: n("contacted"),
    qualified: n("qualified"),
    quote_sent: n("quote_sent"),
    lost: n("lost"),
    wonMonth: ls.filter((l) => l.stage === "won" && l.updatedAt >= month)
      .length,
  };
}

/** Round-robin owner among marketing staff (counter in the store, so it rotates across instances). */
async function roundRobin(db: Exec) {
  const m = (await staffList(db)).filter((s) => s.role === "marketing");
  if (!m.length) return undefined;
  return m[(await nextNo(db, "rr-owner", 0)) % m.length].id;
}

// ---------------------------------------------------------------- capture
export type LeadIn = {
  name: string;
  org?: string;
  phone?: string;
  email?: string;
  language?: Locale;
  serviceInterest?: string[];
  source: LeadSource;
  consent?: Partial<Record<Channel, ConsentState>>;
  attribution?: { first?: Touch; last?: Touch };
  campaign?: string;
  businessType?: string;
  landing?: string;
  ownerId?: string;
  nextActionAt?: string;
};

/** Creates a lead from any channel (public form, staff sheet, inbox, import, assistant). Never auto-merges. */
export async function createLead(c: Caller, b: LeadIn): Promise<Lead> {
  const now = nowIso();
  const campaignSlug =
    b.campaign ??
    b.attribution?.last?.campaign ??
    b.attribution?.first?.campaign;
  const cmp = campaignSlug
    ? (await list<{ id: string; slug: string }>(c.db, "campaign")).find(
        (x) => x.slug === campaignSlug || x.id === campaignSlug,
      )
    : undefined;
  const lead: Lead = {
    id: await leadNo(c.db),
    name: b.name.trim().slice(0, 120),
    org: b.org?.trim() || undefined,
    phoneE164: toE164(b.phone) ?? undefined,
    email: b.email?.trim().toLowerCase() || undefined,
    language: b.language ?? "rw",
    serviceInterest: b.serviceInterest ?? [],
    source: b.source,
    firstTouch: b.attribution?.first,
    lastTouch: b.attribution?.last ?? b.attribution?.first,
    stage: "new",
    ownerId: b.ownerId ?? (await roundRobin(c.db)),
    nextActionAt: b.nextActionAt ?? new Date(Date.now() + D).toISOString(),
    consent: { ...unk(), ...b.consent },
    campaignId: cmp?.id,
    businessType: b.businessType,
    landing: b.landing,
    tags: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  await saveLead(c.db, lead);
  await act(c, lead.id, "created", `source:${b.source}`);
  for (const ch of Object.keys(lead.consent) as Channel[])
    if (lead.consent[ch] !== "unknown")
      await logConsent(c.db, lead.id, {
        channel: ch,
        state: lead.consent[ch],
        at: now,
        source: b.source,
      });
  await record(c, "lead.created", lead.id, { source: b.source });
  await pushNote(c.db, {
    kind: "lead",
    text: `New lead assigned: ${lead.name}`,
    href: `/marketing/leads?lead=${lead.id}`,
  });
  return lead;
}

async function logConsent(db: Exec, leadId: string, e: ConsentEvent) {
  await put(db, {
    kind: "consent",
    id: await seqId(db, "ce"),
    data: { ...e, leadId },
    ref: leadId,
  });
}

export type PublicLeadIn = {
  name?: string;
  phone?: string;
  email?: string;
  website?: string;
  service?: string;
  language?: Locale;
  consent?: Partial<Record<Channel, boolean>>;
  attribution?: { first?: Touch; last?: Touch };
  campaign?: string;
  businessType?: string;
  landing?: string;
  source?: LeadSource;
};
/** POST /api/leads (landing forms, quote requests, the assistant). Honeypot → pretend success, store nothing. */
export async function capturePublic(c: Caller, b: PublicLeadIn) {
  if (b.website) return { received: true };
  // Subscribe-only forms (newsletter, status page) collect just a contact; it doubles as the lead name.
  const name = b.name?.trim() || b.email || b.phone;
  if (!name || (!toE164(b.phone) && !b.email))
    throw mktError(
      422,
      "validation",
      null,
      "Name and a phone or email are required.",
    );
  if (!validEmail(b.email))
    throw mktError(422, "validation", null, "Invalid email.");
  const consent = Object.fromEntries(
    (["email", "whatsapp", "sms"] as Channel[]).map((ch) => [
      ch,
      b.consent?.[ch] ? "in" : "unknown",
    ]),
  ) as Record<Channel, ConsentState>;
  const source: LeadSource =
    b.source === "ai" || b.source === "quote_request"
      ? b.source
      : "landing_form";
  const lead = await createLead(c, {
    name,
    phone: b.phone,
    email: b.email,
    language: b.language,
    serviceInterest: b.service ? [b.service] : [],
    source,
    consent,
    attribution: b.attribution,
    campaign: b.campaign,
    businessType: b.businessType,
    landing: b.landing,
  });
  // F-CMS-08 / NTF-09: opt-ins from public forms (newsletter, regulatory-updates subscribe) go to the consent ledger.
  const subject = toE164(b.phone) ?? b.email!;
  const purposes = (["email", "whatsapp", "sms"] as Channel[]).filter((ch) => consent[ch] === "in");
  if (purposes.length)
    await c.db.insert(consentLedger).values(purposes.map((ch) => ({
      id: `cns_${randomUUID()}`, userId: null, subject: (ch === "email" ? b.email ?? subject : subject).slice(0, 255),
      purpose: `marketing_${ch}`, granted: true, source: "crm", policyVersion: POLICY_VERSION, createdAt: new Date().toISOString(),
    })));
  return { received: true, ref: lead.id };
}

/** Lead side effect of another module's public form (contact P2, bookings P12). `contact` is a phone or an email. */
export async function captureFrom(
  db: Exec,
  source: "contact_form" | "booking" | "assistant",
  p: {
    name: string;
    contact?: string;
    phone?: string;
    email?: string;
    service?: string;
    attribution?: { first?: Touch; last?: Touch };
  },
) {
  const email = p.email ?? (p.contact?.includes("@") ? p.contact : undefined);
  const phone =
    p.phone ?? (p.contact && !p.contact.includes("@") ? p.contact : undefined);
  if (!p.name.trim() || (!toE164(phone) && !email) || !validEmail(email))
    return null;
  const c: Caller = { db, session: null };
  // An open lead for the same person gets the new touch as an activity instead of a duplicate.
  const m = matchLead(
    { phoneE164: toE164(phone) ?? undefined, email },
    await liveLeads(db),
  );
  if (m.mode === "single") {
    await act(c, m.lead.id, "form", `source:${source}`);
    return m.lead;
  }
  return createLead(c, {
    name: p.name,
    phone,
    email,
    source,
    serviceInterest: p.service ? [p.service] : [],
    attribution: p.attribution,
  });
}

// ---------------------------------------------------------------- leads
export async function leadsList(db: Exec) {
  const items = await liveLeads(db);
  return { items, kpi: kpi(items) };
}

async function mustLead(db: Exec, id: string, lock = false) {
  const l = await get<Lead>(db, "lead", id, lock);
  if (!l) throw notFound("Lead");
  return l;
}

export async function leadDetail(c: Caller, id: string) {
  const l = await mustLead(c.db, id);
  const [activities, tasks, notes, consentLog, pool, paid] = await Promise.all([
    list<LeadActivity>(c.db, "activity", { ref: id }),
    list<CrmTask>(c.db, "task", { ref: id }),
    list<CrmNote>(c.db, "note", { ref: id }),
    list<ConsentEvent & { leadId: string }>(c.db, "consent", { ref: id }),
    liveLeads(c.db),
    paidInvoices(c.db),
  ]);
  const last = [l.updatedAt, ...activities.map((a) => a.at)].sort().at(-1)!;
  const retention = new Date(last);
  retention.setUTCMonth(
    retention.getUTCMonth() + MKT_POLICY.leadRetentionMonths,
  );
  const seed = (Object.keys(l.consent) as Channel[]).map((ch) => ({
    channel: ch,
    state: l.consent[ch],
    at: l.createdAt,
    source: l.source,
  }));
  return {
    lead: l,
    activities: activities.sort((a, b) => b.at.localeCompare(a.at)),
    tasks,
    notes,
    duplicates: duplicatesOf(l, pool, l.id),
    consentHistory: [
      ...consentLog
        .map(({ leadId: _, ...e }) => e)
        .sort((a, b) => b.at.localeCompare(a.at)),
      ...seed,
    ],
    retentionAt: retention.toISOString(),
    revenue: revenueOf(l.clientId, paid),
  };
}

export async function createStaffLead(c: Caller, b: NewLead) {
  if (b.phone && !toE164(b.phone))
    throw mktError(422, "validation", null, "Invalid phone.");
  if (!b.phone && !b.email)
    throw mktError(422, "validation", null, "A phone or email is required.");
  if (!validEmail(b.email))
    throw mktError(422, "validation", null, "Invalid email.");
  if (!b.nextActionAt)
    throw mktError(422, "NEXT_ACTION_REQUIRED", null, "Next action required.");
  if (b.ownerId && !staffOf(await staffList(c.db), b.ownerId))
    throw mktError(422, "validation", null, "Owner must be staff.");
  const duplicates = duplicatesOf(
    { phoneE164: toE164(b.phone), email: b.email },
    await liveLeads(c.db),
  );
  if (duplicates.length && !b.force) return { duplicates };
  return { lead: await createLead(c, { ...b }), duplicates };
}

/** PATCH body: null clears ownerId / nextActionAt / estimatedValue. */
export type LeadPatchIn = Omit<LeadPatch, "ownerId" | "nextActionAt" | "estimatedValue"> & { ownerId?: string | null; nextActionAt?: string | null; estimatedValue?: number | null };
export async function patchLead(c: Caller, id: string, ifMatch: string | null, b: LeadPatchIn) {
  const l = await mustLead(c.db, id, true);
  const staff = await staffList(c.db);
  if (ifMatch != null && Number(ifMatch) !== l.version)
    throw mktError(
      409,
      "VERSION_CONFLICT",
      { lead: l, by: staffOf(staff, l.ownerId)?.name },
      "VERSION_CONFLICT",
    );
  if (b.stage && b.stage !== l.stage) {
    const chk = canMove(l, b.stage, {
      lostReason: b.lostReason,
      nextActionAt: b.nextActionAt ?? undefined,
    });
    if (!chk.ok) throw mktError(422, chk.code, { why: chk.why }, chk.why);
    const from = l.stage;
    l.stage = b.stage;
    if (b.stage === "lost") {
      l.lostReason = b.lostReason;
      l.lostNote = b.lostNote;
      l.nextActionAt = undefined;
      await exitRuns(c.db, l.id, "lost");
    }
    if (from === "lost") {
      l.lostReason = undefined;
      l.lostNote = undefined;
      await act(c, l.id, "reopened", "Reopened");
    }
    if (from === "new" && b.stage !== "lost") l.firstResponseAt ??= nowIso();
    await act(c, l.id, "stage", `${from} → ${b.stage}`);
    await record(c, "lead.stage_changed", l.id, {
      from,
      to: b.stage,
      reason: b.lostReason,
    });
  }
  if ("nextActionAt" in b) {
    if (!b.nextActionAt && isOpen(l.stage))
      throw mktError(
        422,
        "NEXT_ACTION_REQUIRED",
        null,
        "Next action required.",
      );
    l.nextActionAt = b.nextActionAt || undefined;
  }
  if ("ownerId" in b) {
    if (b.ownerId && !staffOf(staff, b.ownerId))
      throw mktError(422, "validation", null, "Owner must be staff.");
    l.ownerId = b.ownerId || undefined;
  }
  if ("estimatedValue" in b)
    l.estimatedValue =
      b.estimatedValue && b.estimatedValue > 0
        ? Math.round(b.estimatedValue)
        : undefined;
  if (b.tags) l.tags = [...new Set(b.tags)];
  if (b.serviceInterest) l.serviceInterest = b.serviceInterest;
  bump(l);
  await saveLead(c.db, l);
  return l;
}

export async function logActivity(
  c: Caller,
  id: string,
  b: { kind: "call" | "message" | "email"; text?: string },
) {
  const l = await mustLead(c.db, id, true);
  const a = await act(c, l.id, b.kind, b.text?.trim() || b.kind);
  if (l.stage === "new") {
    l.stage = "contacted";
    l.firstResponseAt ??= nowIso();
    await act(c, l.id, "stage", "new → contacted");
  }
  bump(l);
  await saveLead(c.db, l);
  return a;
}

export async function bulk(
  c: Caller,
  b: { ids: string[]; ownerId?: string; tag?: string },
) {
  if (b.ownerId && !staffOf(await staffList(c.db), b.ownerId))
    throw mktError(422, "validation", null, "Owner must be staff.");
  let n = 0;
  for (const id of b.ids) {
    const l = await get<Lead>(c.db, "lead", id, true);
    if (!l) continue;
    if (b.ownerId) l.ownerId = b.ownerId;
    if (b.tag && !l.tags.includes(b.tag)) l.tags.push(b.tag);
    bump(l);
    await saveLead(c.db, l);
    n++;
  }
  await record(c, "lead.bulk_updated", "bulk", {
    count: n,
    ownerId: b.ownerId,
    tag: b.tag,
  });
  return { updated: n };
}

/** Masked CSV (crm.export_full is not granted to marketing, §10.1); the reason travels in X-Audit-Reason. */
export async function exportLeads(c: Caller, ids: string[]) {
  const reason = auditReason(c.req);
  if (!reason) throw mktError(422, "reason_required", null, "Give a reason.");
  const staff = await staffList(c.db);
  const rows = (
    await Promise.all(ids.map((id) => get<Lead>(c.db, "lead", id)))
  ).filter(Boolean) as Lead[];
  const csv = toCsv(
    ["id", "name", "org", "phone", "stage", "source", "owner", "created"],
    rows.map((l) => [
      l.id,
      l.name,
      l.org,
      maskPhone(l.phoneE164),
      l.stage,
      l.source,
      staffOf(staff, l.ownerId)?.name,
      l.createdAt,
    ]),
  );
  await record(
    c,
    "lead.exported",
    "bulk",
    { count: rows.length, masked: true },
    reason,
  );
  return { csv, count: rows.length, masked: true };
}

export async function merge(
  c: Caller,
  b: { survivorId: string; ids: string[] },
) {
  const s = await mustLead(c.db, b.survivorId, true);
  for (const id of b.ids.filter((x) => x !== s.id)) {
    const l = await get<Lead>(c.db, "lead", id, true);
    if (!l || l.stage === "merged") continue;
    l.stage = "merged";
    l.mergedIntoId = s.id;
    l.nextActionAt = undefined;
    bump(l);
    await saveLead(c.db, l);
    s.email ??= l.email;
    s.phoneE164 ??= l.phoneE164;
    s.org ??= l.org;
    s.firstTouch = [s.firstTouch, l.firstTouch]
      .filter(Boolean)
      .sort((a, z) => a!.at.localeCompare(z!.at))[0];
    s.serviceInterest = [
      ...new Set([...s.serviceInterest, ...l.serviceInterest]),
    ];
    s.tags = [...new Set([...s.tags, ...l.tags])];
    // Consent: the strongest recorded state wins per channel ("out" beats "in": an opt-out is never undone by a merge).
    for (const ch of Object.keys(s.consent) as Channel[])
      if (
        l.consent[ch] === "out" ||
        (l.consent[ch] === "in" && s.consent[ch] === "unknown")
      )
        s.consent[ch] = l.consent[ch];
    for (const a of await list<LeadActivity>(c.db, "activity", { ref: l.id }))
      await put(c.db, {
        kind: "activity",
        id: a.id,
        data: { ...a, leadId: s.id },
        ref: s.id,
      });
    for (const t of await list<CrmTask>(c.db, "task", { ref: l.id }))
      await saveTask(c.db, {
        ...t,
        subject: { ...t.subject, id: s.id, label: s.name },
      });
    for (const n of await list<CrmNote>(c.db, "note", { ref: l.id }))
      await put(c.db, {
        kind: "note",
        id: n.id,
        data: { ...n, subject: { ...n.subject, id: s.id } },
        ref: s.id,
      });
    await act(c, s.id, "merged", `Merged ${l.id}`);
  }
  bump(s);
  await saveLead(c.db, s);
  await record(c, "lead.merged", s.id, { ids: b.ids });
  return s;
}

const yesNo = (v?: string): ConsentState => {
  const s = (v ?? "").trim().toLowerCase();
  return ["yes", "y", "1", "true", "yego", "oui"].includes(s)
    ? "in"
    : ["no", "n", "0", "false", "oya", "non"].includes(s)
      ? "out"
      : "unknown";
};

export async function importPreview(
  c: Caller,
  b: { rows: Record<string, string>[]; mapping: Record<string, string> },
) {
  const col = (r: Record<string, string>, f: string) =>
    b.mapping[f] ? r[b.mapping[f]] : undefined;
  const seen = new Set<string>();
  const pool = await liveLeads(c.db);
  const out: ImportRow[] = b.rows.map((r, i) => {
    const phone = toE164(col(r, "phone")),
      email = col(r, "email")?.trim().toLowerCase() || undefined;
    const errors: string[] = [];
    if (!col(r, "name")?.trim()) errors.push("name");
    if (col(r, "phone") && !phone) errors.push("phone");
    if (!phone && !email) errors.push("contact");
    if (email && !validEmail(email)) errors.push("email");
    const key = phone ?? email ?? `row${i}`;
    const dupInFile = seen.has(key);
    seen.add(key);
    const dup = duplicatesOf({ phoneE164: phone, email }, pool)[0];
    return {
      i: i + 1,
      errors,
      dupInFile,
      dupInCrm: dup?.id,
      data: {
        name: col(r, "name")?.trim() ?? "",
        phone: phone ?? col(r, "phone"),
        email,
        org: col(r, "org"),
        service: col(r, "service"),
        consent: {
          email: yesNo(col(r, "consent_email")),
          whatsapp: yesNo(col(r, "consent_whatsapp")),
          sms: yesNo(col(r, "consent_sms")),
        },
      },
    };
  });
  const jobId = await seqId(c.db, "imp");
  await put(c.db, {
    kind: "import",
    id: jobId,
    data: { rows: out, by: actorId(c), at: nowIso() },
    ref: actorId(c),
  });
  return { jobId, rows: out };
}

export async function importConfirm(c: Caller, job: string) {
  const imp = await get<{ rows: ImportRow[]; by: string }>(
    c.db,
    "import",
    job,
    true,
  );
  if (!imp || imp.by !== actorId(c)) throw notFound("Import");
  const good = imp.rows.filter(
    (r) => !r.errors.length && !r.dupInFile && !r.dupInCrm,
  );
  for (const r of good)
    await createLead(c, {
      ...r.data,
      serviceInterest: r.data.service ? [r.data.service] : [],
      source: "csv",
    });
  await remove(c.db, "import", job);
  await record(c, "lead.imported", job, {
    created: good.length,
    skipped: imp.rows.length - good.length,
  });
  return { created: good.length, skipped: imp.rows.length - good.length };
}

/** Link to an existing client or send an account invitation. `won` is set only by a paid invoice (§2.4). */
export async function convert(
  c: Caller,
  id: string,
  b: { mode: "link" | "invite"; clientId?: string },
) {
  const l = await mustLead(c.db, id, true);
  if (b.mode === "link") {
    const ct = b.clientId
      ? (await list<Contact>(c.db, "contact", { ref: b.clientId }))[0]
      : undefined;
    if (!ct) throw mktError(422, "validation", null, "Pick a client.");
    l.clientId = ct.clientId;
    l.customerId = ct.customerId;
    await act(c, l.id, "converted", `Linked to ${ct.name}`);
  } else {
    if (
      l.consent.email !== "in" &&
      l.consent.whatsapp !== "in" &&
      l.consent.sms !== "in"
    )
      throw mktError(
        422,
        "CONSENT_REQUIRED",
        null,
        "No channel to send the invitation.",
      );
    // shortcut: the invitation is recorded, not delivered; P13 sends it through the auth invite flow once marketing may create client accounts.
    await act(c, l.id, "converted", "Account invitation sent");
  }
  if (
    l.clientId &&
    isOpen(l.stage) &&
    (await paidInvoices(c.db)).some((i) => i.clientId === l.clientId)
  ) {
    l.stage = "won";
    l.nextActionAt = undefined;
    await exitRuns(c.db, l.id, "paid");
  }
  bump(l);
  await saveLead(c.db, l);
  await record(c, "lead.converted", l.id, b);
  return l;
}

/** Conversion rule (cron + after payments): open leads linked to a client with a paid invoice become `won`. */
export async function sweepWon(db: Exec) {
  const paid = await paidInvoices(db);
  const payers = new Set(paid.map((p) => p.clientId));
  let n = 0;
  for (const l of await list<Lead>(db, "lead", {
    status: ["new", "contacted", "qualified", "quote_sent"],
  })) {
    if (!l.clientId || !payers.has(l.clientId)) continue;
    const cur = await get<Lead>(db, "lead", l.id, true);
    if (!cur || !isOpen(cur.stage)) continue;
    cur.stage = "won";
    cur.nextActionAt = undefined;
    bump(cur);
    await saveLead(db, cur);
    await act({ db, session: null }, cur.id, "converted", "First invoice paid");
    await exitRuns(db, cur.id, "paid");
    n++;
  }
  return n;
}

/** Retention (Q-PRV-03): leads without activity for N months are erased with their trail. */
export async function purgeStale(db: Exec) {
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - MKT_POLICY.leadRetentionMonths);
  const iso = cutoff.toISOString();
  let n = 0;
  for (const l of await list<Lead>(db, "lead")) {
    if (l.updatedAt >= iso || l.clientId) continue;
    const acts = await list<LeadActivity>(db, "activity", { ref: l.id });
    if (acts.some((a) => a.at >= iso)) continue;
    for (const a of acts) await remove(db, "activity", a.id);
    for (const k of ["task", "note", "consent"] as const)
      for (const x of await list<{ id: string }>(db, k, { ref: l.id }))
        await remove(db, k, x.id);
    await remove(db, "lead", l.id);
    n++;
  }
  return n;
}

/** Sequence exit events cancel every step still waiting for that subject. */
export async function exitRuns(db: Exec, subjectId: string, reason: string) {
  const { AutomationRunsExit } = await import("./marketing.campaigns");
  await AutomationRunsExit(db, subjectId, reason);
}

// ---------------------------------------------------------------- tasks & notes
export async function myTasks(c: Caller) {
  const me = actorId(c);
  return {
    items: (await list<CrmTask>(c.db, "task")).filter(
      (t) => t.assigneeId === me || !t.assigneeId,
    ),
  };
}

export async function createTask(
  c: Caller,
  b: {
    subject: CrmTask["subject"];
    kind?: CrmTask["kind"];
    title: string;
    dueAt: string;
    assigneeId?: string;
  },
) {
  if (b.assigneeId && !staffOf(await staffList(c.db), b.assigneeId))
    throw mktError(422, "validation", null, "Assignee must be staff.");
  const t: CrmTask = {
    id: await seqId(c.db, "tk"),
    subject: b.subject,
    kind: b.kind ?? "follow_up",
    title: b.title.trim(),
    dueAt: b.dueAt,
    assigneeId: b.assigneeId ?? actorId(c),
    done: false,
  };
  await saveTask(c.db, t);
  if (b.subject.type === "lead")
    await act(c, b.subject.id, "task", `Task: ${t.title}`);
  return t;
}

export async function patchTask(
  c: Caller,
  id: string,
  b: { done?: boolean; title?: string; dueAt?: string },
) {
  const t = await get<CrmTask>(c.db, "task", id, true);
  if (!t) throw notFound("Task");
  if (b.done != null) {
    t.done = b.done;
    t.doneAt = b.done ? nowIso() : undefined;
  }
  if (b.title?.trim()) t.title = b.title.trim();
  if (b.dueAt) t.dueAt = b.dueAt;
  await saveTask(c.db, t);
  return t;
}

export async function addNote(
  c: Caller,
  type: "lead" | "customer",
  id: string,
  b: { body: string; mentions?: string[] },
) {
  const staff = await staffList(c.db);
  const n: CrmNote = {
    id: await seqId(c.db, "nt"),
    subject: { type, id },
    body: b.body.trim(),
    by: actorId(c),
    at: nowIso(),
    mentions: (b.mentions ?? []).filter((m) => staffOf(staff, m)),
  };
  await put(c.db, { kind: "note", id: n.id, data: n, ref: id });
  if (type === "lead") await act(c, id, "note", "Note added");
  for (const m of n.mentions)
    if (m !== actorId(c))
      await pushNote(c.db, {
        kind: "task",
        text: `You were mentioned in a note`,
        href:
          type === "lead"
            ? `/marketing/leads?lead=${id}`
            : `/marketing/customers/${id}`,
      });
  return n;
}

// ---------------------------------------------------------------- inbox
export async function inbox(db: Exec) {
  return {
    items: (await list<InboxThread>(db, "thread")).sort((a, b) =>
      b.lastInboundAt.localeCompare(a.lastInboundAt),
    ),
  };
}

async function mustThread(db: Exec, id: string) {
  const t = await get<InboxThread>(db, "thread", id, true);
  if (!t) throw notFound("Thread");
  return t;
}

/** WhatsApp outside the 24-hour window needs an approved template. Delivery goes through the provider job (no-op without keys). */
export async function reply(
  c: Caller,
  id: string,
  b: { body?: string; template?: string },
) {
  const t = await mustThread(c.db, id);
  const outside = Date.now() - Date.parse(t.lastInboundAt) > D;
  if (t.channel === "whatsapp" && outside && !b.template)
    throw mktError(
      422,
      "TEMPLATE_REQUIRED",
      null,
      "Outside the 24-hour window.",
    );
  const tpl = b.template
    ? await get<MsgTemplate>(c.db, "template", b.template)
    : null;
  if (b.template && (!tpl || tpl.status !== "active"))
    throw mktError(422, "TEMPLATE_NOT_ACTIVE", null, "Template not active.");
  const body = tpl?.body ?? b.body?.trim();
  if (!body) throw mktError(422, "validation", null, "Write a message.");
  t.messages.push({
    id: `m${t.messages.length + 1}`,
    dir: "out",
    body,
    at: nowIso(),
    by: actorId(c),
    template: tpl?.key,
  });
  t.unread = 0;
  await saveThread(c.db, t);
  await c.db.insert(outbox).values({ type: "marketing.reply", payload: { threadId: t.id, channel: t.channel, body }, queue: "default" });
  if (t.leadId) {
    const l = await get<Lead>(c.db, "lead", t.leadId, true);
    if (l?.stage === "new") {
      l.stage = "contacted";
      l.firstResponseAt ??= nowIso();
      bump(l);
      await saveLead(c.db, l);
      await act(c, l.id, "message", "Replied from the inbox");
    }
  }
  return t;
}

export async function threadAction(
  c: Caller,
  id: string,
  action: string,
  b: { value?: string },
) {
  const t = await mustThread(c.db, id);
  if (action === "read") t.unread = 0;
  else if (action === "assign") {
    if (!staffOf(await staffList(c.db), b.value))
      throw mktError(422, "validation", null, "Staff only");
    t.assigneeId = b.value;
  } else if (action === "tag") {
    if (b.value?.trim() && !t.tags.includes(b.value.trim()))
      t.tags.push(b.value.trim());
  } else if (action === "lead") {
    if (b.value) {
      if (!(await get<Lead>(c.db, "lead", b.value))) throw notFound("Lead");
      t.leadId = b.value;
    } else if (t.leadId) {
      return { ...t, lead: await get<Lead>(c.db, "lead", t.leadId) };
    } else {
      const src: LeadSource = t.channel === "web" ? "contact_form" : t.channel;
      const lead = await createLead(c, { name: t.contactName, source: src });
      t.leadId = lead.id;
      await saveThread(c.db, t);
      return { ...t, lead };
    }
  } else throw notFound("Action");
  await saveThread(c.db, t);
  return t;
}

/** Inbound message (provider webhook or contact form): opens or extends a thread. STOP keywords opt the sender out. */
export async function inbound(
  db: Exec,
  m: {
    channel: InboxThread["channel"];
    from: string;
    name?: string;
    body: string;
    subject?: string;
  },
) {
  const threads = await list<InboxThread>(db, "thread");
  const now = nowIso();
  let t = threads.find(
    (x) =>
      x.channel === m.channel &&
      (x.contactName === m.from || x.contactName === m.name),
  );
  if (!t)
    t = {
      id: await seqId(db, "th"),
      channel: m.channel,
      contactName: m.name ?? m.from,
      subject: m.subject,
      preview: "",
      unread: 0,
      lastInboundAt: now,
      tags: [],
      messages: [],
    };
  t.messages.push({
    id: `m${t.messages.length + 1}`,
    dir: "in",
    body: m.body,
    at: now,
  });
  t.preview = m.body.slice(0, 120);
  t.unread++;
  t.lastInboundAt = now;
  if (
    /^\s*(stop|hagarika|arret|arrêt)\s*$/i.test(m.body) &&
    !t.tags.includes("opt-out")
  )
    t.tags.push("opt-out");
  await saveThread(db, t);
  if (t.leadId) await exitRuns(db, t.leadId, "replied");
  return t;
}

// ---------------------------------------------------------------- customers (marketing view)
const customerRow = (
  c: Contact,
  leads: Lead[],
  paid: Awaited<ReturnType<typeof paidInvoices>>,
): CustomerRow => ({
  id: c.clientId ?? c.id,
  name: c.name,
  org: c.org,
  customerId: c.customerId,
  language: c.language,
  sector: c.sector,
  lastActiveAt: c.lastActiveAt,
  consent: c.consent,
  lifetime: revenueOf(c.clientId, paid),
  phoneMasked: maskPhone(c.phoneE164),
  leads: leads.filter((l) => l.clientId && l.clientId === c.clientId).length,
});

/** `leadId` adds `match` (phone/email/both) per row, so the convert dialog can preselect the client the lead already is. */
export async function customers(db: Exec, leadId?: string) {
  const [cs, leads, paid] = await Promise.all([
    list<Contact>(db, "contact", { status: ["customer"] }),
    list<Lead>(db, "lead"),
    paidInvoices(db),
  ]);
  const l = leadId ? leads.find((x) => x.id === leadId) : undefined;
  const matchOf = (c: Contact) => {
    if (!l) return undefined;
    const ph = !!l.phoneE164 && l.phoneE164 === c.phoneE164, em = !!l.email && l.email === c.email?.toLowerCase();
    return ph && em ? "both" : ph ? "phone" : em ? "email" : undefined;
  };
  return { items: cs.map((c) => ({ ...customerRow(c, leads, paid), match: matchOf(c) })) };
}

export async function customer360(c: Caller, id: string): Promise<Customer360> {
  const ct = (await list<Contact>(c.db, "contact", { ref: id }))[0];
  if (!ct) throw notFound("Customer");
  const [allLeads, paidAll, cases, threads, tasksAll, notesAll, activities] =
    await Promise.all([
      list<Lead>(c.db, "lead"),
      paidInvoices(c.db),
      casesOf(c.db, id),
      list<InboxThread>(c.db, "thread"),
      list<CrmTask>(c.db, "task"),
      list<CrmNote>(c.db, "note"),
      list<LeadActivity>(c.db, "activity"),
    ]);
  const paid = paidAll.filter((i) => i.clientId === id);
  const leads = allLeads.filter((l) => l.clientId === id);
  const leadIds = new Set(leads.map((l) => l.id));
  const kase = cases.map((k) => ({
    ref: k.ref,
    service: k.service,
    status: k.status,
    at: k.at,
  }));
  const timeline: TimelineEvent[] = [
    ...leads.flatMap((l) => [
      ...(l.firstTouch
        ? [
            {
              id: `ft-${l.id}`,
              kind: "visit" as const,
              title: `Visit from ${l.firstTouch.source}${l.firstTouch.campaign ? ` · ${l.firstTouch.campaign}` : ""}`,
              at: l.firstTouch.at,
            },
          ]
        : []),
      ...(l.lastTouch && l.lastTouch.at !== l.firstTouch?.at
        ? [
            {
              id: `lt-${l.id}`,
              kind: "campaign" as const,
              title: `Clicked ${l.lastTouch.source} · ${l.lastTouch.campaign ?? ""}`,
              at: l.lastTouch.at,
            },
          ]
        : []),
      {
        id: `lf-${l.id}`,
        kind: "form" as const,
        title: `Lead ${l.id} created`,
        at: l.createdAt,
        meta: l.source,
      },
      ...activities
        .filter((a) => a.leadId === l.id && a.kind !== "created")
        .map((a) => ({
          id: a.id,
          kind: (a.kind === "note"
            ? "note"
            : a.kind === "converted"
              ? "account"
              : "message") as TimelineEvent["kind"],
          title: a.text,
          at: a.at,
        })),
    ]),
    ...kase.map((k) => ({
      id: `cs-${k.ref}`,
      kind: "case" as const,
      title: `Request ${k.ref} · ${k.service}`,
      at: k.at,
      meta: k.status,
    })),
    ...paid.map((i) => ({
      id: `pi-${i.no}`,
      kind: "payment" as const,
      title: `Invoice ${i.no} paid`,
      at: i.paidAt,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const now = Date.now();
  const spark = Array.from({ length: 6 }, (_, k) =>
    paid
      .filter((i) => Date.parse(i.paidAt) <= now - (5 - k) * 30 * D)
      .reduce((s, i) => s + i.total, 0),
  );
  const lead = leads[0];
  const candidates = allLeads
    .filter(
      (l) =>
        !l.clientId &&
        isOpen(l.stage) &&
        ((ct.phoneE164 && l.phoneE164 === ct.phoneE164) ||
          (ct.email && l.email === ct.email)),
    )
    .map((l) => ({
      id: l.id,
      name: l.name,
      by: (l.phoneE164 === ct.phoneE164 && l.email === ct.email
        ? "both"
        : l.phoneE164 === ct.phoneE164
          ? "phone"
          : "email") as "phone" | "email" | "both",
    }));
  await record(c, "consent.viewed_history", id, {});
  return {
    ...customerRow(ct, allLeads, paidAll),
    lifetime: paid.reduce((s, i) => s + i.total, 0),
    district: ct.district,
    size: ct.size,
    subscription: ct.subscription,
    ownerId: lead?.ownerId,
    spark,
    timeline,
    cases: kase,
    comms: threads
      .filter(
        (t) => t.contactName === ct.name || (t.leadId && leadIds.has(t.leadId)),
      )
      .map((t) => ({
        id: t.id,
        channel: t.channel,
        subject: t.subject ?? t.channel,
        at: t.lastInboundAt,
        dir: "in" as const,
      })),
    tasks: tasksAll.filter(
      (t) => t.subject.id === id || leadIds.has(t.subject.id),
    ),
    notes: notesAll.filter(
      (n) => n.subject.id === id || leadIds.has(n.subject.id),
    ),
    firstTouch: lead?.firstTouch,
    lastTouch: lead?.lastTouch,
    // F-CRM-11: editor-managed rules (marketing → customers → recommendation rules).
    recommended: recommend(ct.servicesUsed, await list<RecRule>(c.db, "rec_rule")),
    related: {
      cases: kase.length,
      messages: timeline.filter((t) => t.kind === "message").length,
      ratings: 0,
      campaigns: leads.filter((l) => l.campaignId).length,
    },
    leadIds: leads.map((l) => l.id),
    candidates,
  };
}

// ---------------------------------------------------------------- unsubscribe (campaign footer link)
/** Opt a contact out of one channel (token-verified by the caller); counts it on the campaign. Idempotent. */
export async function unsubscribe(
  db: Exec,
  t: { contactId: string; channel: Channel; campaignId?: string },
) {
  const m = await get<Contact>(db, "contact", t.contactId, true);
  if (!m) {
    // F-CRM-12 reminders go to leads (non-clients): opt the lead out instead.
    const l = await get<Lead>(db, "lead", t.contactId, true);
    if (!l) throw notFound("Contact");
    if (l.consent[t.channel] !== "out") {
      l.consent = { ...l.consent, [t.channel]: "out" };
      await saveLead(db, l);
      await record({ db, session: null }, "consent.unsubscribed", l.id, { channel: t.channel, campaignId: t.campaignId });
    }
    return { unsubscribed: true };
  }
  if (m.consent[t.channel] === "out") return { unsubscribed: true };
  m.consent = { ...m.consent, [t.channel]: "out" };
  await put(db, { kind: "contact", id: m.id, data: m, status: m.clientId ? "customer" : null, ref: m.clientId ?? null });
  const cp = t.campaignId ? await get<Campaign>(db, "campaign", t.campaignId, true) : undefined;
  if (cp) {
    cp.stats = { ...cp.stats, unsubscribed: cp.stats.unsubscribed + 1 };
    await put(db, { kind: "campaign", id: cp.id, data: cp, status: cp.status, ref: cp.slug });
  }
  await record({ db, session: null }, "consent.unsubscribed", m.id, { channel: t.channel, campaignId: t.campaignId });
  return { unsubscribed: true };
}

export type UnsubToken = { contactId: string; channel: Channel; campaignId?: string };
/** Footer token: CryptoService ciphertext (AES-GCM, so it can't be forged or altered), base64url. No expiry: opt-outs must always work. */
export const unsubToken = (crypto: { encrypt(s: string): string }, t: UnsubToken) =>
  Buffer.from(crypto.encrypt(JSON.stringify(t))).toString("base64url");
export function readUnsubToken(crypto: { decrypt(s: string): string }, raw: string): UnsubToken {
  try {
    const t = JSON.parse(crypto.decrypt(Buffer.from(raw, "base64url").toString())) as UnsubToken;
    if (typeof t.contactId === "string" && ["email", "whatsapp", "sms"].includes(t.channel)) return t;
  } catch {
    // fall through: any tampering or garbage is the same 422
  }
  throw mktError(422, "invalid_token", null, "This link is not valid.");
}

// ---------------------------------------------------------------- F-CRM-16 first-party analytics
export async function recordEvent(c: Caller, b: { name: string; path: string; locale?: string; referrer?: string; visitor?: string; props?: Record<string, string> }) {
  // Strip query strings: they can carry tokens or personal data.
  const path = b.path.split("?")[0].slice(0, 512);
  const referrer = b.referrer ? b.referrer.split("?")[0].slice(0, 512) : null;
  // F-CRM-15: mirror consented events to GA4 via Measurement Protocol when configured (job no-ops otherwise).
  if (process.env.GA4_API_SECRET && b.visitor)
    await c.db.insert(outbox).values({ type: "marketing.ga4_event", payload: { name: b.name, path, visitor: b.visitor, locale: b.locale ?? null }, queue: "bulk" });
  await c.db.insert(siteEvents).values({ id: `ev_${randomUUID()}`, name: b.name, path, locale: b.locale ?? null, referrer, visitor: b.visitor ?? null, props: b.props ?? null, createdAt: new Date().toISOString() });
  return { ok: true };
}
/** Totals per event and top pages over the last `days`, plus unique visitors. */
export async function eventSummary(c: Caller, days: number) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [byName, topPages, [uv]] = await Promise.all([
    c.db.select({ name: siteEvents.name, n: dsqlx<number>`count(*)::int` }).from(siteEvents).where(gte(siteEvents.createdAt, since)).groupBy(siteEvents.name),
    c.db.select({ path: siteEvents.path, n: dsqlx<number>`count(*)::int` }).from(siteEvents)
      .where(dand(gte(siteEvents.createdAt, since), deq(siteEvents.name, "page_view"))).groupBy(siteEvents.path).orderBy(dsqlx`count(*) desc`).limit(20),
    c.db.select({ n: dsqlx<number>`count(distinct ${siteEvents.visitor})::int` }).from(siteEvents).where(gte(siteEvents.createdAt, since)),
  ]);
  return { days, events: byName, topPages, visitors: uv?.n ?? 0 };
}

// ---------------------------------------------------------------- F-BKG-11 booking outcome → CRM stage
/** A completed consultation qualifies the matching open lead (by phone/email) and adds the recommended services. */
export async function bookingOutcome(c: Caller, b: { phone?: string; email?: string; status: string; services: string[] }) {
  if (b.status !== "completed" || (!b.phone && !b.email)) return { moved: false };
  const phone = toE164(b.phone);
  const email = b.email?.toLowerCase();
  const l = (await list<Lead>(c.db, "lead")).find((x) => ["new", "contacted"].includes(x.stage) && ((phone && x.phoneE164 === phone) || (email && x.email?.toLowerCase() === email)));
  if (!l) return { moved: false };
  await patchLead(c, l.id, null, {
    stage: "qualified",
    serviceInterest: [...new Set([...l.serviceInterest, ...b.services])],
    nextActionAt: l.nextActionAt ?? new Date(Date.now() + 2 * 864e5).toISOString(), // qualified leads need a next action
  } as LeadPatchIn);
  return { moved: true, leadId: l.id };
}

// ---------------------------------------------------------------- F-CRM-11 recommendation rules (editor)
export const listRecRules = async (c: Caller) => ({ items: await list<RecRule>(c.db, "rec_rule") });
/** Replaces the whole rule list (small, ordered; the editor saves it in one go). */
export async function saveRecRules(c: Caller, items: RecRule[]) {
  const old = await list<RecRule>(c.db, "rec_rule");
  for (const r of old) if (!items.some((x) => x.id === r.id)) await remove(c.db, "rec_rule", r.id);
  for (const [i, r] of items.entries()) await put(c.db, { kind: "rec_rule", id: r.id, data: r, pos: i });
  await record(c, "lead.rec_rules_saved", "rec_rule", { n: items.length });
  return { items };
}
