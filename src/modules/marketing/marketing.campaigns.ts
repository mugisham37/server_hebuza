// P11 audience and outreach (port of src/mocks/handlers-marketing-campaigns.ts): segments with live counts, campaigns
// (wizard, approval with separation of duties, schedule, send job with consent re-check and budget cap), message
// templates (Meta approval states) and sequences (automation rules + runs).
import { outbox } from "@/db/schema";
import type { Exec } from "./marketing.store";
import { evaluate } from "@/domain/marketing/segment";
import { eligibility, type Eligibility } from "@/domain/marketing/consent";
import {
  budgetState,
  estimate,
  pausePoint,
  unitCost,
} from "@/domain/marketing/cost";
import { approvalNeeded, canApprove } from "@/domain/marketing/approval";
import { planRuns } from "@/domain/marketing/automation";
import { maskPhone, toCsv } from "@/domain/marketing/export";
import type {
  AutomationRule,
  AutomationRun,
  Campaign,
  CampaignStats,
  Channel,
  Contact,
  ExcludedReason,
  Lead,
  Locale,
  MsgTemplate,
  SegGroup,
  Segment,
} from "@/domain/marketing/types";
import {
  type Caller,
  actorId,
  auditReason,
  campaignNo,
  get,
  list,
  meOf,
  mktError,
  notFound,
  policy,
  pushNote,
  put,
  record,
  remove,
  saveSetting,
  seqId,
  setting,
  staffList,
  staffOf,
} from "./marketing.store";

const nowIso = () => new Date().toISOString();
const D = 86_400_000;

// ---------------------------------------------------------------- state beside the Campaign document
export type CampaignExtra = {
  sendStartedAt?: number;
  spentAtStart?: number;
  budgetApproved?: boolean;
  consentDelta?: number;
  testSends: number;
  timeline: { status: string; at: string; by?: string; note?: string }[];
  /** Contact ids frozen at send start (send-time consent re-check), and the ones the provider refused. */
  queue: string[];
  /** Next queue index the send job hands to the provider. */
  cursor: number;
  failedIds: string[];
  /** contact id → last marketing send (ms), for the weekly frequency cap. */
  sentLog: Record<string, number>;
};
const zero: CampaignStats = {
  queued: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  read: 0,
  clicked: 0,
  replied: 0,
  leads: 0,
  converted: 0,
  revenue: 0,
  failed: 0,
  unsubscribed: 0,
};

export const saveCampaign = (db: Exec, c: Campaign) =>
  put(db, {
    kind: "campaign",
    id: c.id,
    data: c,
    status: c.status,
    ref: c.slug,
  });
const saveExtra = (db: Exec, id: string, x: CampaignExtra) =>
  put(db, { kind: "cmpx", id, data: x });
async function extraOf(db: Exec, c: Campaign): Promise<CampaignExtra> {
  return (
    (await get<CampaignExtra>(db, "cmpx", c.id)) ?? {
      testSends: 0,
      queue: [],
      cursor: 0,
      failedIds: [],
      sentLog: {},
      timeline: [
        { status: "draft", at: c.createdAt, by: c.createdBy },
        ...(c.approvedAt
          ? [{ status: "approved", at: c.approvedAt, by: c.approvedBy }]
          : []),
        ...(!["draft", "approved", "pending_approval"].includes(c.status)
          ? [{ status: c.status, at: c.scheduledAt ?? c.createdAt }]
          : []),
      ],
    }
  );
}
const push = (x: CampaignExtra, status: string, by?: string, note?: string) =>
  x.timeline.push({ status, at: nowIso(), by, note });

// ---------------------------------------------------------------- audience
export const contacts = (db: Exec) => list<Contact>(db, "contact");
const langsOf = (c: Campaign) =>
  (Object.keys(c.templates) as Locale[]).filter(
    (l) =>
      c.templates[l]?.templateKey ||
      c.templates[l]?.body ||
      c.templates[l]?.subjectA,
  );
const smsText = (c: Campaign) =>
  Object.values(c.templates)
    .map((t) => t?.body ?? "")
    .join("");
const languages = (xs: Contact[]) => {
  const out: Record<Locale, number> = { rw: 0, en: 0, fr: 0 };
  xs.forEach((x) => out[x.language]++);
  return out;
};
const sample = (xs: Contact[]) =>
  xs
    .slice(0, 10)
    .map((x) => ({
      id: x.id,
      name: x.name,
      phone: maskPhone(x.phoneE164),
      language: x.language,
      consent: x.consent,
    }));

/** Marketing messages sent per contact in the last 7 days (frequency cap, across campaigns). */
async function sentThisWeek(db: Exec): Promise<Record<string, number>> {
  const since = Date.now() - 7 * D;
  const out: Record<string, number> = {};
  for (const x of await list<
    CampaignExtra & { sentLog?: Record<string, number> }
  >(db, "cmpx"))
    for (const [id, at] of Object.entries(x.sentLog ?? {}))
      if (at >= since) out[id] = (out[id] ?? 0) + 1;
  return out;
}

function eligibleFor(
  c: Campaign,
  seg: Segment | undefined,
  all: Contact[],
  week: Record<string, number>,
): Eligibility & { count: number } {
  const members = seg ? evaluate(seg.definition, all) : [];
  const langs = langsOf(c);
  return {
    ...eligibility(members, {
      channel: c.channel,
      languages: langs.length ? langs : undefined,
      fallback: !!c.fallbackLanguage,
      sentThisWeek: week,
    }),
    count: members.length,
  };
}

// ---------------------------------------------------------------- budget
type Spend = { month: string; amount: number };
const thisMonth = () => nowIso().slice(0, 7);
export async function spend(db: Exec, lock = false): Promise<Spend> {
  const s = await setting<Spend>(
    db,
    "spend",
    { month: thisMonth(), amount: 0 },
    lock,
  );
  return s.month === thisMonth() ? s : { month: thisMonth(), amount: 0 };
}
export async function budget(db: Exec, est = 0) {
  const [s, p] = await Promise.all([spend(db), policy(db)]);
  return {
    spent: s.amount,
    cap: p.budgetCap,
    estimate: est,
    state: budgetState(s.amount, est, p.budgetCap),
  };
}

// ---------------------------------------------------------------- view
type Ctx = {
  all: Contact[];
  segs: Segment[];
  week: Record<string, number>;
  staff: Awaited<ReturnType<typeof staffList>>;
  meId: string;
  spent: number;
  cap: number;
};
async function viewCtx(c: Caller): Promise<Ctx> {
  const [all, segs, week, staff, s, p] = await Promise.all([
    contacts(c.db),
    list<Segment>(c.db, "segment"),
    sentThisWeek(c.db),
    staffList(c.db),
    spend(c.db),
    policy(c.db),
  ]);
  return {
    all,
    segs,
    week,
    staff,
    meId: actorId(c),
    spent: s.amount,
    cap: p.budgetCap,
  };
}

async function view(db: Exec, c: Campaign, k: Ctx) {
  const x = await extraOf(db, c);
  const e = eligibleFor(
    c,
    k.segs.find((s) => s.id === c.segmentId),
    k.all,
    k.week,
  );
  const est = estimate(c.channel, e.eligible.length, smsText(c));
  const sending = c.status === "sending" || c.status === "sent";
  const b = {
    spent: k.spent,
    cap: k.cap,
    estimate: sending ? 0 : est,
    state: budgetState(k.spent, sending ? 0 : est, k.cap),
  };
  const p = await policy(db);
  return {
    ...c,
    estimate: sending ? c.estimate : est,
    live: {
      count: e.count,
      eligible: e.eligible.length,
      excluded: e.excluded,
      languages: languages(e.eligible),
    },
    budget: b,
    approvalNeeded: approvalNeeded(e.eligible.length, est, b.state === "block"),
    approvalReason: (e.eligible.length > p.approvalRecipients
      ? "recipients"
      : b.state === "block"
        ? "budget"
        : est > p.approvalCost
          ? "cost"
          : null) as "recipients" | "budget" | "cost" | null,
    timeline: x.timeline,
    consentDelta: x.consentDelta ?? 0,
    budgetApproved: !!x.budgetApproved,
    segmentName: k.segs.find((s) => s.id === c.segmentId)?.name ?? c.segmentId,
    createdByName: staffOf(k.staff, c.createdBy)?.name,
    approvedByName: staffOf(k.staff, c.approvedBy)?.name,
    approverName: staffOf(k.staff, c.approverId)?.name,
    mine: c.createdBy === k.meId,
    unitCost: unitCost(c.channel, smsText(c)),
  };
}
export type CampaignView = Awaited<ReturnType<typeof view>>;

// ---------------------------------------------------------------- segments
export async function segments(c: Caller) {
  const [segs, all, staff] = await Promise.all([
    list<Segment>(c.db, "segment"),
    contacts(c.db),
    staffList(c.db),
  ]);
  return {
    items: segs.map((s) => ({
      ...s,
      lastCount: evaluate(s.definition, all).length,
      createdByName: staffOf(staff, s.createdBy)?.name,
    })),
  };
}
export async function segment(db: Exec, id: string) {
  const s = await get<Segment>(db, "segment", id);
  if (!s) throw notFound("Segment");
  return { ...s, lastCount: evaluate(s.definition, await contacts(db)).length };
}
export async function previewSegment(
  db: Exec,
  b: { definition: SegGroup; channel: Channel },
) {
  const members = evaluate(b.definition, await contacts(db));
  const e = eligibility(members, {
    channel: b.channel,
    sentThisWeek: await sentThisWeek(db),
  });
  return {
    count: members.length,
    eligible: e.eligible.length,
    excluded: e.excluded,
    sample: sample(members),
    languages: languages(members),
  };
}
export async function createSegment(
  c: Caller,
  b: { name: string; definition: SegGroup },
) {
  const s: Segment = {
    id: `SG-${await seqId(c.db, "SG")}`.replace("SG-SG-", "SG-"),
    name: b.name.trim(),
    definition: b.definition,
    lastCount: evaluate(b.definition, await contacts(c.db)).length,
    createdBy: actorId(c),
    updatedAt: nowIso(),
    version: 1,
  };
  await put(c.db, { kind: "segment", id: s.id, data: s, pos: Date.now() });
  await record(c, "segment.saved", s.id);
  return s;
}
export async function patchSegment(
  c: Caller,
  id: string,
  ifMatch: string | null,
  b: { name?: string; definition?: SegGroup },
) {
  const s = await get<Segment>(c.db, "segment", id, true);
  if (!s) throw notFound("Segment");
  if (ifMatch != null && Number(ifMatch) !== s.version)
    throw mktError(409, "VERSION_CONFLICT", { version: s.version }, "version");
  if (b.name?.trim()) s.name = b.name.trim();
  if (b.definition) s.definition = b.definition;
  Object.assign(s, {
    version: s.version + 1,
    updatedAt: nowIso(),
    lastCount: evaluate(s.definition, await contacts(c.db)).length,
  });
  await put(c.db, { kind: "segment", id: s.id, data: s });
  await record(c, "segment.saved", s.id);
  return s;
}
export async function deleteSegment(c: Caller, id: string) {
  if (!(await get<Segment>(c.db, "segment", id, true)))
    throw notFound("Segment");
  const busy = (await list<Campaign>(c.db, "campaign")).some(
    (x) => x.segmentId === id && !["sent", "cancelled"].includes(x.status),
  );
  if (busy) throw mktError(409, "IN_USE", null, "Used by a campaign");
  await remove(c.db, "segment", id);
  await record(c, "segment.deleted", id);
  return { deleted: true };
}

// ---------------------------------------------------------------- campaigns
export async function campaigns(c: Caller, status?: string) {
  const k = await viewCtx(c);
  const items = await list<Campaign>(
    c.db,
    "campaign",
    status ? { status: [status] } : {},
  );
  return {
    items: await Promise.all(items.map((x) => view(c.db, x, k))),
    budget: {
      spent: k.spent,
      cap: k.cap,
      estimate: 0,
      state: budgetState(k.spent, 0, k.cap),
    },
  };
}
async function mustCampaign(db: Exec, id: string, lock = false) {
  const c = await get<Campaign>(db, "campaign", id, lock);
  if (!c) throw notFound("Campaign");
  return c;
}
export async function campaign(c: Caller, id: string) {
  return view(c.db, await mustCampaign(c.db, id), await viewCtx(c));
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 80);
export type CampaignIn = Partial<
  Pick<
    Campaign,
    | "name"
    | "slug"
    | "channel"
    | "segmentId"
    | "templates"
    | "fallbackLanguage"
    | "scheduledAt"
    | "throttle"
  >
>;

export async function createCampaign(c: Caller, b: CampaignIn) {
  const id = await campaignNo(c.db);
  const p = await policy(c.db);
  const slug = slugify(b.slug || b.name || id);
  if ((await list<Campaign>(c.db, "campaign")).some((x) => x.slug === slug))
    throw mktError(409, "conflict", { field: "slug" }, "Slug already used.");
  const firstSeg = (await list<Segment>(c.db, "segment"))[0]?.id ?? "";
  const cp: Campaign = {
    id,
    name: b.name?.trim() || id,
    slug,
    channel: b.channel ?? "whatsapp",
    segmentId: b.segmentId ?? firstSeg,
    templates: b.templates ?? {},
    fallbackLanguage: b.fallbackLanguage,
    throttle: b.throttle ?? p.throttle,
    status: "draft",
    createdBy: actorId(c),
    createdAt: nowIso(),
    estimate: 0,
    version: 1,
    stats: zero,
  };
  await saveCampaign(c.db, cp);
  // Every campaign gets its tracked link hbz.rw/c/{slug} (U13).
  await put(c.db, {
    kind: "link",
    id: slug,
    data: {
      code: slug,
      target: "/",
      campaign: slug,
      campaignId: id,
      clicks: 0,
      createdAt: nowIso(),
    },
    ref: id,
  });
  await record(c, "campaign.created", id);
  return campaign(c, id);
}

export async function patchCampaign(c: Caller, id: string, b: CampaignIn) {
  const cp = await mustCampaign(c.db, id, true);
  if (cp.status !== "draft")
    throw mktError(409, "conflict", null, "Only drafts can change");
  if (b.slug && slugify(b.slug) !== cp.slug) {
    const slug = slugify(b.slug);
    if (
      (await list<Campaign>(c.db, "campaign")).some(
        (x) => x.slug === slug && x.id !== id,
      )
    )
      throw mktError(409, "conflict", { field: "slug" }, "Slug already used.");
    await remove(c.db, "link", cp.slug);
    await put(c.db, {
      kind: "link",
      id: slug,
      data: {
        code: slug,
        target: "/",
        campaign: slug,
        campaignId: id,
        clicks: 0,
        createdAt: nowIso(),
      },
      ref: id,
    });
    cp.slug = slug;
  }
  for (const key of [
    "name",
    "channel",
    "segmentId",
    "templates",
    "fallbackLanguage",
    "scheduledAt",
    "throttle",
  ] as const)
    if (key in b) (cp as Record<string, unknown>)[key] = b[key];
  cp.version++;
  await saveCampaign(c.db, cp);
  return campaign(c, id);
}

async function startSending(
  db: Exec,
  cp: Campaign,
  x: CampaignExtra,
  by?: string,
) {
  const k: Ctx = {
    all: await contacts(db),
    segs: await list<Segment>(db, "segment"),
    week: await sentThisWeek(db),
    staff: [],
    meId: "",
    spent: 0,
    cap: 0,
  };
  const e = eligibleFor(
    cp,
    k.segs.find((s) => s.id === cp.segmentId),
    k.all,
    k.week,
  ); // send-time consent re-check
  const approved = cp.segmentSnapshot?.eligible ?? e.eligible.length;
  x.consentDelta = Math.max(0, approved - e.eligible.length);
  x.queue = e.eligible.map((m) => m.id);
  x.cursor = 0;
  x.failedIds = [];
  x.sendStartedAt = Date.now();
  x.spentAtStart = (await spend(db)).amount;
  cp.stats = { ...zero, queued: x.queue.length };
  cp.estimate = estimate(cp.channel, x.queue.length, smsText(cp));
  cp.status = "sending";
  push(x, "sending", by);
}

export async function campaignAction(
  c: Caller,
  id: string,
  action: string,
  body: Record<string, unknown>,
) {
  const cp = await mustCampaign(c.db, id, true);
  const x = await extraOf(c.db, cp);
  const me = await meOf(c);
  const k = await viewCtx(c);
  const v = await view(c.db, cp, k);
  const by = actorId(c);
  const keys = Object.values(cp.templates)
    .map((t) => t?.templateKey)
    .filter(Boolean) as string[];
  const tplRows = (await list<MsgTemplate>(c.db, "template")).filter(
    (t) => keys.includes(t.key) && t.channel === cp.channel,
  );
  const p = await policy(c.db);
  switch (action) {
    case "submit": {
      if (cp.status !== "draft") throw mktError(409, "conflict");
      if (!langsOf(cp).length)
        throw mktError(422, "validation", { field: "content" });
      if (tplRows.some((t) => t.category !== "marketing"))
        throw mktError(422, "TEMPLATE_CATEGORY");
      if (
        cp.channel === "whatsapp" &&
        (!tplRows.length || tplRows.some((t) => t.status !== "active"))
      )
        throw mktError(422, "TEMPLATE_NOT_ACTIVE");
      cp.segmentSnapshot = {
        count: v.live.count,
        eligible: v.live.eligible,
        excluded: v.live.excluded,
      };
      if (v.approvalNeeded) {
        const approverId = String(body.approverId ?? "");
        if (!approverId || approverId === cp.createdBy)
          throw mktError(403, "SOD_SELF_APPROVAL");
        const approver = staffOf(k.staff, approverId);
        if (
          !approver ||
          (approver.role !== "marketing" && approver.role !== "executive")
        )
          throw mktError(422, "validation", { field: "approverId" });
        cp.approverId = approverId;
        cp.status = "pending_approval";
        cp.rejectedReason = undefined;
        push(x, "pending_approval", by);
        await pushNote(c.db, {
          kind: "approval",
          text: `Campaign waiting for approval: ${cp.name}`,
          href: `/marketing/campaigns/${cp.id}`,
        });
      } else {
        cp.status = "approved";
        push(x, "approved", by);
      }
      await record(c, "campaign.submitted", cp.id, cp.segmentSnapshot);
      break;
    }
    case "approve":
    case "reject": {
      if (cp.status !== "pending_approval") throw mktError(409, "conflict");
      const ck = canApprove(me, cp.createdBy);
      if (!ck.ok)
        throw mktError(
          403,
          ck.reason === "self" ? "SOD_SELF_APPROVAL" : "forbidden",
        );
      if (action === "reject") {
        const reason = String(body.reason ?? "").trim();
        if (!reason) throw mktError(422, "reason_required");
        cp.status = "draft";
        cp.rejectedReason = reason;
        push(x, "rejected", by, reason);
        await record(c, "campaign.rejected", cp.id, {}, reason);
        break;
      }
      cp.status = "approved";
      cp.approvedBy = me!.id;
      cp.approvedAt = nowIso();
      if (v.budget.state === "block") x.budgetApproved = true; // the approver accepts going over the monthly cap
      push(x, "approved", by);
      await record(c, "campaign.approved", cp.id);
      if (cp.scheduledAt) {
        cp.status = "scheduled";
        push(x, "scheduled", by);
      }
      break;
    }
    case "schedule": {
      if (cp.status !== "approved" && cp.status !== "draft")
        throw mktError(409, "conflict");
      const at = body.at ? String(body.at) : undefined;
      if (
        at &&
        (Number.isNaN(Date.parse(at)) ||
          Date.parse(at) < Date.now() + p.minScheduleMinutes * 60_000)
      )
        throw mktError(422, "validation", { field: "at" });
      cp.scheduledAt = at;
      if (cp.status === "approved") {
        if (at) {
          cp.status = "scheduled";
          push(x, "scheduled", by);
        } else await startSending(c.db, cp, x, by);
      }
      break;
    }
    case "send":
      if (cp.status !== "approved" && cp.status !== "scheduled")
        throw mktError(409, "conflict");
      await startSending(c.db, cp, x, by);
      await record(c, "campaign.send_started", cp.id, { queued: cp.stats.queued });
      break;
    case "pause":
      if (cp.status !== "sending") throw mktError(409, "conflict");
      cp.status = "paused";
      cp.pausedReason = "user";
      push(x, "paused", by, "user");
      await record(c, "campaign.paused", cp.id);
      break;
    case "resume":
      if (cp.status !== "paused") throw mktError(409, "conflict");
      if (cp.pausedReason === "budget_cap" && !body.raiseCap)
        throw mktError(422, "BUDGET_CAP");
      if (body.raiseCap) {
        x.budgetApproved = true;
        await record(c, "campaign.budget_override", cp.id);
      }
      cp.status = "sending";
      cp.pausedReason = undefined;
      x.sendStartedAt ??= Date.now();
      push(x, "sending", by, "resumed");
      break;
    case "cancel":
      if (["sent", "cancelled"].includes(cp.status))
        throw mktError(409, "conflict");
      cp.status = "cancelled";
      push(x, "cancelled", by);
      await record(c, "campaign.cancelled", cp.id);
      break;
    case "retry-failed": {
      if (!x.failedIds.length) break;
      // Failed recipients go back to the end of the queue; the send job retries them at the next tick.
      const back = x.failedIds.length;
      x.queue.push(...x.failedIds);
      x.failedIds = [];
      cp.stats = { ...cp.stats, failed: 0, queued: cp.stats.queued + back };
      if (cp.status === "sent") cp.status = "sending";
      push(x, "retry", by, String(back));
      break;
    }
    case "test-send": {
      x.testSends++;
      await c.db.insert(outbox).values({ type: "marketing.test_send", payload: { campaignId: cp.id, userId: by }, queue: "default" });
      break;
    }
    case "simulate-consent": {
      // Dev only: 7 of the audience withdraw consent after approval (demonstrates the send-time re-check).
      if (c.prod !== false) throw notFound("Action"); // dev only; unknown env counts as production
      const e = eligibleFor(
        cp,
        k.segs.find((s) => s.id === cp.segmentId),
        k.all,
        k.week,
      ).eligible.slice(0, 7);
      for (const m of e)
        await put(c.db, {
          kind: "contact",
          id: m.id,
          data: { ...m, consent: { ...m.consent, [cp.channel]: "out" } },
          status: m.clientId ? "customer" : null,
          ref: m.clientId ?? null,
        });
      break;
    }
    default:
      throw notFound("Action");
  }
  cp.version++;
  await saveCampaign(c.db, cp);
  await saveExtra(c.db, cp.id, x);
  return campaign(c, cp.id);
}

/** Masked recipients CSV (reason in X-Audit-Reason, audited). */
export async function exportRecipients(c: Caller, id: string) {
  const reason = auditReason(c.req);
  if (!reason) throw mktError(422, "reason_required", null, "Give a reason.");
  const { items, total } = await recipients(c.db, id, undefined, Infinity);
  await record(c, "campaign.recipients_exported", id, { count: total, masked: true }, reason);
  return { csv: toCsv(["name", "phone", "language", "state"], items.map((r) => [r.name, r.phone, r.language, r.state])), count: total, masked: true };
}

export async function recipients(db: Exec, id: string, state?: string, limit = 200) {
  const cp = await mustCampaign(db, id);
  const x = await extraOf(db, cp);
  const failed = new Set(x.failedIds);
  const sentIds = x.queue.slice(0, x.cursor);
  const byId = new Map((await contacts(db)).map((m) => [m.id, m]));
  const rows = sentIds.flatMap((cid) => {
    const m = byId.get(cid);
    return m
      ? [
          {
            id: m.id,
            name: m.name,
            phone: maskPhone(m.phoneE164),
            language: m.language,
            state: failed.has(cid) ? "failed" : "delivered",
          },
        ]
      : [];
  });
  return {
    items: rows.filter((r) => !state || r.state === state).slice(0, limit),
    total: rows.length,
  };
}

/** Send job tick: starts due schedules, sends up to `throttle` messages per campaign, pauses at the budget cap. */
export async function sendTick(
  db: Exec,
  deliver: (cp: Campaign, m: Contact) => Promise<boolean>,
  quiet: boolean,
) {
  for (const cp0 of await list<Campaign>(db, "campaign", {
    status: ["scheduled", "sending"],
  })) {
    const cp = await get<Campaign>(db, "campaign", cp0.id, true);
    if (!cp) continue;
    const x = await extraOf(db, cp);
    if (cp.status === "scheduled") {
      if (!cp.scheduledAt || Date.parse(cp.scheduledAt) > Date.now()) continue;
      await startSending(db, cp, x);
    }
    if (cp.status !== "sending" || quiet) {
      await saveCampaign(db, cp);
      await saveExtra(db, cp.id, x);
      continue;
    }
    const s = await spend(db, true);
    const p = await policy(db);
    const unit = unitCost(cp.channel, smsText(cp));
    const room = x.budgetApproved
      ? Infinity
      : pausePoint(s.amount, unit, p.budgetCap);
    const byId = new Map((await contacts(db)).map((m) => [m.id, m]));
    let paid = 0,
      cost = 0;
    while (x.cursor < x.queue.length && paid < cp.throttle && paid < room) {
      const cid = x.queue[x.cursor++];
      const m = byId.get(cid);
      if (m && (await deliver(cp, m))) {
        cp.stats.sent++;
        cp.stats.delivered++;
        cost += unit;
        paid++;
        x.sentLog[cid] = Date.now();
      } else x.failedIds.push(cid);
    }
    cp.stats.failed = x.failedIds.length;
    if (cost) await saveSetting(db, "spend", { month: thisMonth(), amount: s.amount + cost });
    if (x.cursor >= x.queue.length) {
      cp.status = "sent";
      push(x, "sent");
      await record({ db, session: null }, "campaign.sent", cp.id, { sent: cp.stats.sent, failed: cp.stats.failed });
      await pushNote(db, { kind: "campaign", text: `Campaign finished: ${cp.name}`, href: `/marketing/campaigns/${cp.id}?tab=results` });
    } else if (paid >= room) {
      cp.status = "paused";
      cp.pausedReason = "budget_cap";
      push(x, "paused", undefined, "budget_cap");
      await record({ db, session: null }, "campaign.paused", cp.id, { reason: "budget_cap" });
      await pushNote(db, { kind: "budget", text: `Paused at budget cap: ${cp.name}`, href: `/marketing/campaigns/${cp.id}` });
    }
    cp.version++;
    await saveCampaign(db, cp);
    await saveExtra(db, cp.id, x);
  }
}

// ---------------------------------------------------------------- templates
const vars = (body: string) =>
  [...body.matchAll(/{{(\w+)}}/g)].map((m) => m[1]);
export const saveTemplate = (db: Exec, t: MsgTemplate) =>
  put(db, {
    kind: "template",
    id: t.id,
    data: t,
    status: t.status,
    ref: t.key,
  });

export async function templates(
  db: Exec,
  f: { category?: string; channel?: string; status?: string },
) {
  return {
    items: (await list<MsgTemplate>(db, "template")).filter(
      (t) =>
        (!f.category || t.category === f.category) &&
        (!f.channel || t.channel === f.channel) &&
        (!f.status || t.status === f.status),
    ),
  };
}
async function mustTemplate(db: Exec, id: string) {
  const t = await get<MsgTemplate>(db, "template", id, true);
  if (!t) throw notFound("Template");
  return t;
}
export async function patchTemplate(
  c: Caller,
  id: string,
  b: { body?: string; subject?: string; name?: string },
) {
  const t = await mustTemplate(c.db, id);
  if (b.body != null) {
    t.body = b.body;
    t.variables = vars(b.body);
  }
  if (b.subject != null) t.subject = b.subject;
  if (b.name != null) t.name = b.name;
  // A changed WhatsApp template must be approved by Meta again.
  if (t.status === "rejected" || t.status === "active") {
    t.status = t.channel === "whatsapp" ? "draft" : "active";
    t.providerReason = undefined;
  }
  t.version++;
  t.updatedAt = nowIso();
  await saveTemplate(c.db, t);
  await record(c, "template.changed", t.id);
  return t;
}
export async function createTemplate(
  c: Caller,
  b: Pick<MsgTemplate, "key" | "name" | "channel" | "language" | "body"> & {
    subject?: string;
  },
) {
  const id = `tp-${b.key}-${b.channel}-${b.language}`;
  const finalId = (await get(c.db, "template", id))
    ? `${id}-${await seqId(c.db, "tpv")}`
    : id;
  const t: MsgTemplate = {
    ...b,
    id: finalId,
    category: "marketing",
    variables: vars(b.body),
    status: b.channel === "whatsapp" ? "draft" : "active",
    version: 1,
    updatedAt: nowIso(),
  };
  await saveTemplate(c.db, t);
  await record(c, "template.created", t.id);
  return t;
}
/** Submits a WhatsApp template to Meta. shortcut: no WhatsApp Business API key yet, so it waits in pending until the provider webhook (or the dev decision) lands. */
export async function submitProvider(c: Caller, id: string) {
  const t = await mustTemplate(c.db, id);
  t.status = "pending_provider_approval";
  t.updatedAt = nowIso();
  await saveTemplate(c.db, t);
  await record(c, "template.submitted", t.id);
  return t;
}
/** Meta's decision (provider webhook; dev "simulate" in non-production). */
export async function providerDecision(
  db: Exec,
  id: string,
  decision: "approve" | "reject",
  reason?: string,
) {
  const t = await mustTemplate(db, id);
  t.status = decision === "approve" ? "active" : "rejected";
  t.providerReason =
    decision === "reject"
      ? (reason ??
        "PLACEHOLDER(meta-rejection-reason): content flagged as promotional without an opt-out.")
      : undefined;
  t.updatedAt = nowIso();
  await saveTemplate(db, t);
  if (decision === "reject")
    await pushNote(db, {
      kind: "template",
      text: `Template rejected by Meta: ${t.name}`,
      href: "/marketing/templates?status=rejected",
    });
  return t;
}

// ---------------------------------------------------------------- sequences
const saveRule = (db: Exec, a: AutomationRule) =>
  put(db, {
    kind: "automation",
    id: a.id,
    data: a,
    status: a.active ? "active" : "inactive",
  });
export const saveRun = (db: Exec, r: AutomationRun) =>
  put(db, {
    kind: "run",
    id: r.id,
    data: r,
    status: r.status,
    ref: r.subject.id,
  });
const waitingOf = (runs: AutomationRun[], id: string, deferred = true) =>
  runs.filter(
    (r) =>
      r.ruleId === id &&
      (r.status === "waiting" || (deferred && r.status === "deferred")),
  ).length;

export async function automations(db: Exec, active?: boolean) {
  const [rules, runs, all, p] = await Promise.all([
    list<AutomationRule>(db, "automation"),
    list<AutomationRun>(db, "run", { status: ["waiting", "deferred"] }),
    contacts(db),
    policy(db),
  ]);
  return {
    items: rules
      .filter((a) => !active || a.active)
      .map((a) => ({ ...a, waiting: waitingOf(runs, a.id) })),
    excludedNoWa: all.filter((m) => m.consent.whatsapp !== "in").length,
    inactiveDays: p.inactiveDays,
  };
}
async function mustRule(db: Exec, id: string, lock = false) {
  const a = await get<AutomationRule>(db, "automation", id, lock);
  if (!a) throw notFound("Sequence");
  return a;
}
export async function automation(db: Exec, id: string) {
  const a = await mustRule(db, id);
  return {
    ...a,
    waiting: waitingOf(
      await list<AutomationRun>(db, "run", { status: ["waiting"] }),
      a.id,
      false,
    ),
  };
}
export async function runsOf(db: Exec, id: string) {
  return {
    items: (await list<AutomationRun>(db, "run")).filter(
      (r) => r.ruleId === id,
    ),
  };
}
export type RuleIn = Partial<
  Pick<
    AutomationRule,
    "name" | "trigger" | "steps" | "exit" | "conditions" | "frequencyCap"
  >
>;
export async function createRule(c: Caller, b: RuleIn) {
  const p = await policy(c.db);
  const a: AutomationRule = {
    id: `sq-n${await seqId(c.db, "SQ")}`.replace("sq-nSQ-", "sq-n"),
    name: b.name?.trim() || "New sequence",
    trigger: b.trigger ?? "manual",
    steps: b.steps ?? [],
    exit: b.exit ?? ["replied", "won", "lost", "unsubscribed"],
    active: false,
    frequencyCap: Math.min(b.frequencyCap ?? p.frequencyCap, p.frequencyCap),
    enrolled: 0,
    converted: 0,
    exited: 0,
    updatedAt: nowIso(),
    conditions: b.conditions,
  };
  await saveRule(c.db, a);
  await record(c, "sequence.created", a.id);
  return a;
}
export async function patchRule(c: Caller, id: string, b: RuleIn) {
  const a = await mustRule(c.db, id, true);
  if (a.system)
    throw mktError(403, "forbidden", null, "Owned by Service Management");
  const p = await policy(c.db);
  for (const key of ["name", "trigger", "steps", "exit", "conditions"] as const)
    if (key in b) (a as Record<string, unknown>)[key] = b[key];
  if (b.frequencyCap != null)
    a.frequencyCap = Math.min(b.frequencyCap, p.frequencyCap);
  a.updatedAt = nowIso();
  await saveRule(c.db, a);
  await record(c, "sequence.changed", a.id);
  return a;
}
export async function toggleRule(c: Caller, id: string) {
  const a = await mustRule(c.db, id, true);
  if (a.system) throw notFound("Sequence");
  a.active = !a.active;
  a.updatedAt = nowIso();
  if (!a.active)
    for (const r of await list<AutomationRun>(c.db, "run", {
      status: ["waiting", "deferred"],
    }))
      if (r.ruleId === a.id)
        await saveRun(c.db, { ...r, status: "cancelled", reason: "paused" });
  await saveRule(c.db, a);
  await record(c, a.active ? "sequence.activated" : "sequence.paused", a.id);
  return a;
}
export async function enrol(c: Caller, id: string, leadIds: string[]) {
  const a = await mustRule(c.db, id, true);
  if (a.system) throw notFound("Sequence");
  const runs = await list<AutomationRun>(c.db, "run", {
    status: ["waiting", "deferred"],
  });
  const week = await sentThisWeek(c.db);
  let n = 0;
  for (const lid of leadIds) {
    const l = await get<Lead>(c.db, "lead", lid);
    if (!l || runs.some((r) => r.ruleId === a.id && r.subject.id === lid))
      continue;
    for (const r of planRuns(
      a,
      { type: "lead", id: lid, label: l.name },
      nowIso(),
      { consent: l.consent, sentThisWeek: week[lid] ?? 0 },
      `ar-${a.id}-${lid}-${Date.now()}`,
    ))
      await saveRun(c.db, r);
    n++;
  }
  a.enrolled += n;
  await saveRule(c.db, a);
  await record(c, "sequence.enrolled", a.id, { count: n });
  return { enrolled: n };
}

/** Exit events (reply, paid, won, lost, unsubscribed) cancel waiting steps of rules listing that exit. */
export async function AutomationRunsExit(
  db: Exec,
  subjectId: string,
  reason: string,
) {
  const rules = new Map(
    (await list<AutomationRule>(db, "automation")).map((a) => [a.id, a]),
  );
  const touched = new Set<string>();
  for (const r of await list<AutomationRun>(db, "run", { ref: subjectId })) {
    if (r.status !== "waiting" && r.status !== "deferred") continue;
    const rule = rules.get(r.ruleId);
    if (!rule?.exit.includes(reason as AutomationRule["exit"][number]))
      continue;
    await saveRun(db, { ...r, status: "cancelled", reason });
    touched.add(r.ruleId);
  }
  for (const id of touched) {
    const a = rules.get(id)!;
    a.exited++;
    if (reason === "paid" || reason === "won") a.converted++;
    await saveRule(db, a);
  }
}

/** Sequence runner tick: executes due steps (send → provider job, create_task, set_stage). Sends wait out quiet hours. */
export async function runTick(
  db: Exec,
  deliver: (channel: Channel, template: string, lead: Lead) => Promise<boolean>,
  quiet: boolean,
) {
  const rules = new Map(
    (await list<AutomationRule>(db, "automation")).map((a) => [a.id, a]),
  );
  const now = nowIso();
  for (const r0 of await list<AutomationRun>(db, "run", {
    status: ["waiting", "deferred"],
  })) {
    if (r0.runAt > now) continue;
    const r = await get<AutomationRun>(db, "run", r0.id, true);
    if (!r || (r.status !== "waiting" && r.status !== "deferred")) continue;
    const rule = rules.get(r.ruleId);
    const step = rule?.steps[r.stepIndex];
    if (!rule?.active || !step) {
      await saveRun(db, { ...r, status: "cancelled", reason: "rule_inactive" });
      continue;
    }
    const lead =
      r.subject.type === "lead"
        ? await get<Lead>(db, "lead", r.subject.id, true)
        : undefined;
    if (
      r.subject.type === "lead" &&
      (!lead ||
        lead.stage === "won" ||
        lead.stage === "lost" ||
        lead.stage === "merged")
    ) {
      await saveRun(db, {
        ...r,
        status: "cancelled",
        reason: lead?.stage ?? "gone",
      });
      continue;
    }
    if (step.action === "send_template") {
      if (quiet) continue;
      const ch = step.params.channel as Channel;
      if (!lead || lead.consent[ch] !== "in") {
        await saveRun(db, { ...r, status: "skipped", reason: "no_consent" });
        continue;
      }
      const ok = await deliver(ch, String(step.params.template ?? ""), lead);
      await saveRun(db, {
        ...r,
        status: ok ? "executed" : "skipped",
        reason: ok ? undefined : "provider_failed",
      });
    } else if (step.action === "create_task" && lead) {
      const id = await seqId(db, "tk");
      await put(db, {
        kind: "task",
        id,
        data: {
          id,
          subject: { type: "lead", id: lead.id, label: lead.name },
          kind: (step.params.kind as string) ?? "follow_up",
          title: String(step.params.title ?? rule.name),
          dueAt: now,
          assigneeId: lead.ownerId ?? "",
          done: false,
        },
        status: "open",
        ref: lead.id,
      });
      await saveRun(db, { ...r, status: "executed" });
    } else if (step.action === "set_stage" && lead) {
      const to = step.params.stage as Lead["stage"];
      if (to === "lost") {
        lead.lostReason =
          (step.params.reason as Lead["lostReason"]) ?? "no_response";
        lead.nextActionAt = undefined;
      }
      lead.stage = to;
      lead.updatedAt = now;
      lead.version++;
      await put(db, {
        kind: "lead",
        id: lead.id,
        data: lead,
        status: lead.stage,
        ref: lead.clientId ?? null,
      });
      await saveRun(db, { ...r, status: "executed" });
    } else await saveRun(db, { ...r, status: "executed" });
  }
}

/** Win-back rule panel: who counts as inactive and how many we may reach per channel. */
export async function inactiveRule(db: Exec) {
  const p = await policy(db);
  const xs = (await contacts(db)).filter(
    (m) => Date.now() - Date.parse(m.lastActiveAt) > p.inactiveDays * D,
  );
  const by = (ch: Channel) => xs.filter((m) => m.consent[ch] === "in").length;
  return {
    days: p.inactiveDays,
    count: xs.length,
    consent: { email: by("email"), whatsapp: by("whatsapp"), sms: by("sms") },
    sequenceId: "sq-inactive",
    templates: await list<MsgTemplate>(db, "template", { ref: "winback_90" }),
  };
}

/** F-CRM-14 daily: newly inactive, consented customers join the win-back sequence; ones active again leave it (reactivated). */
export async function winbackSweep(db: Exec) {
  const p = await policy(db);
  const all = await contacts(db);
  const leads = await list<Lead>(db, "lead");
  const leadOf = (clientId?: string) => leads.find((l) => clientId && l.clientId === clientId && l.stage !== "merged");
  const inactive = (m: (typeof all)[number]) => Date.now() - Date.parse(m.lastActiveAt) > p.inactiveDays * D;
  // shortcut: one win-back run per lead ever; allow a new spell (e.g. after 12 months) if marketing asks.
  const had = new Set((await list<AutomationRun>(db, "run")).filter((r) => r.ruleId === "sq-inactive").map((r) => r.subject.id));
  const ids = all.filter((m) => inactive(m) && Object.values(m.consent).includes("in")).flatMap((m) => leadOf(m.clientId)?.id ?? []).filter((id) => !had.has(id));
  let enrolled = 0;
  try { if (ids.length) enrolled = (await enrol({ db, session: null }, "sq-inactive", ids)).enrolled; } catch { /* rule missing or system-managed: nothing to enrol */ }
  const runs = await list<AutomationRun>(db, "run", { status: ["waiting", "deferred"] });
  let reactivated = 0;
  for (const m of all.filter((x) => !inactive(x))) {
    const l = leadOf(m.clientId);
    if (l && runs.some((r) => r.ruleId === "sq-inactive" && r.subject.id === l.id)) { await AutomationRunsExit(db, l.id, "reactivated"); reactivated++; }
  }
  return { enrolled, reactivated };
}

export type { ExcludedReason };
