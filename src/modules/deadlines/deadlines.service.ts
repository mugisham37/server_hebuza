// Port of .ref deadlines.service (Python app/modules/deadlines): Kigali calendar helpers used by applications at submit,
// plus the 07:00 daily run (obligations, missed, SLA breaches, reminders). Dates are "YYYY-MM-DD" Kigali days (UTC+2).
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  agentSettings,
  applications,
  clientObligations,
  clientSubscriptions,
  dedicatedAgentFocus,
  deadlineNotifications,
  serviceDeadlineRules,
  services,
  users,
  complianceRules,
  organizations,
  organizationMembers,
} from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { usersWithRole } from "../../core/db/system-records";
import type { NotifyInput } from "../notifications/notifications.service";
import { generateId } from "../../core/db/ids";

export type Notify = (tx: Tx, n: NotifyInput) => Promise<unknown>;

export const DEFAULT_CASE_LEAD_DAYS = 3;
export const DEFAULT_CASE_OFFSETS = [3, 1] as const;
export const DEFAULT_REMIND_OFFSETS = [7, 3, 1] as const;
export const DEFAULT_QUARTER_MONTHS = [1, 4, 7, 10] as const;
export const OBLIGATION_HORIZON_DAYS = 60;
export const OPEN_OBLIGATION_STATUSES = ["upcoming", "in_progress"] as const;
const LIVE_SUBSCRIPTION_STATUSES = ["active", "trial"];
const TERMINAL_APP_STATUSES = [
  "completed",
  "completed_delivered",
  "rejected",
  "cancelled",
  "refunded",
];
const KIGALI_OFFSET_MS = 2 * 3600_000;

export type Recurrence =
  | { type: "yearly"; month: number; day: number }
  | { type: "monthly"; day: number }
  | { type: "quarterly"; day: number; months?: number[] }
  | { type: "custom"; dates: string[] };

// ── calendar helpers (pure) ───────────────────────────────────────────────────────────────────
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (day: string, n: number) =>
  iso(new Date(utcDay(day).getTime() + n * 864e5));
export const daysBetween = (from: string, to: string) =>
  Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / 864e5);
export const kigaliToday = (now = new Date()) =>
  iso(new Date(now.getTime() + KIGALI_OFFSET_MS));
export const kigaliDate = (moment: string | Date) =>
  kigaliToday(new Date(moment));
/** Last second of that Kigali day, as a UTC ISO instant. */
export const endOfKigaliDay = (day: string) =>
  new Date(utcDay(day).getTime() + 86_399_000 - KIGALI_OFFSET_MS).toISOString();

const clamped = (y: number, m: number, d: number) => {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m - 1, Math.min(d, last))));
};

/** Every date of the rule within [start, end], sorted, de-duplicated. */
export function occurrences(
  rule: Recurrence,
  start: string,
  end: string,
): string[] {
  if (end < start) return [];
  const found = new Set<string>();
  if (rule.type === "custom") {
    for (const d of rule.dates ?? [])
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= start && d <= end) found.add(d);
    return [...found].sort();
  }
  const months =
    rule.type === "yearly"
      ? [rule.month]
      : rule.type === "quarterly"
        ? rule.months?.length
          ? rule.months
          : [...DEFAULT_QUARTER_MONTHS]
        : rule.type === "monthly"
          ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
          : [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++)
    for (const m of months) {
      const c = clamped(y, m, rule.day);
      if (c >= start && c <= end) found.add(c);
    }
  return [...found].sort();
}

/** First date of the rule on or after the day (looks two years ahead). */
export const nextOccurrence = (rule: Recurrence, onOrAfter: string) =>
  occurrences(rule, onOrAfter, addDays(onOrAfter, 731))[0] ?? null;

/** Working days (Mon–Fri) after `start`. */
export function addBusinessDays(start: string, days: number) {
  let cur = start;
  for (let added = 0; added < days;) {
    cur = addDays(cur, 1);
    const wd = utcDay(cur).getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return cur;
}

/** on_track / lead (amber) / due_soon (≤ 1 day) / overdue; "done" when closed, "none" with no date. */
export function deadlineState(
  due: string | null,
  today: string,
  leadDays = DEFAULT_CASE_LEAD_DAYS,
  closed = false,
) {
  if (closed) return "done";
  if (!due) return "none";
  const d = daysBetween(today, due);
  return d < 0
    ? "overdue"
    : d <= 1
      ? "due_soon"
      : d <= leadDays
        ? "lead"
        : "on_track";
}

export function localized(label: unknown, lang = "en") {
  if (!label || typeof label !== "object") return "";
  for (const k of [lang, "en", "fr", "rw"]) {
    const v = (label as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** The working deadline at submission (Python _initial_due): calendar rule → client's date → SLA (null). */
export async function initialDue(
  db: Tx,
  svc: { serviceId: string; deadlineMode: string },
  preferred: string | null,
  now = new Date(),
) {
  if (svc.deadlineMode === "calendar") {
    const rules = await db
      .select({ r: serviceDeadlineRules.recurrence })
      .from(serviceDeadlineRules)
      .where(
        and(
          eq(serviceDeadlineRules.serviceId, svc.serviceId),
          eq(serviceDeadlineRules.active, true),
        ),
      );
    const today = kigaliToday(now);
    const next = rules
      .map((x) => nextOccurrence(x.r as Recurrence, today))
      .filter((d): d is string => !!d)
      .sort()[0];
    if (next) return { dueAt: endOfKigaliDay(next), dueSource: "calendar" };
  }
  if (preferred)
    return { dueAt: endOfKigaliDay(preferred), dueSource: "client" };
  return { dueAt: null, dueSource: "sla" };
}

// ── daily run ─────────────────────────────────────────────────────────────────────────────────
/** Obligations for live dedicated subscriptions, OBLIGATION_HORIZON_DAYS ahead. Idempotent (unique period). */
export async function generateObligations(db: Tx, now: Date) {
  const today = kigaliToday(now);
  const horizon = addDays(today, OBLIGATION_HORIZON_DAYS);
  const subs = await db
    .select()
    .from(clientSubscriptions)
    .where(
      and(
        inArray(clientSubscriptions.status, LIVE_SUBSCRIPTION_STATUSES),
        gte(clientSubscriptions.currentPeriodEnd, now.toISOString()),
        isNotNull(clientSubscriptions.dedicatedAgentId),
      ),
    );
  if (!subs.length) return 0;
  const focus = await db
    .select()
    .from(dedicatedAgentFocus)
    .where(
      inArray(
        dedicatedAgentFocus.subscriptionId,
        subs.map((s) => s.subscriptionId),
      ),
    );
  let created = 0;
  for (const sub of subs) {
    const rows = focus.filter((f) => f.subscriptionId === sub.subscriptionId);
    const cats = rows
      .map((r) => r.categorySlug)
      .filter((c): c is string => !!c);
    const ids = rows.map((r) => r.serviceId).filter((c): c is string => !!c);
    if (!cats.length && !ids.length) continue;
    const svcs = await db
      .select({ id: services.serviceId })
      .from(services)
      .where(
        and(
          eq(services.deadlineMode, "calendar"),
          or(
            ids.length ? inArray(services.serviceId, ids) : undefined,
            cats.length ? inArray(services.category, cats) : undefined,
          ),
        ),
      );
    if (!svcs.length) continue;
    const rules = await db
      .select()
      .from(serviceDeadlineRules)
      .where(
        and(
          inArray(
            serviceDeadlineRules.serviceId,
            svcs.map((s) => s.id),
          ),
          eq(serviceDeadlineRules.active, true),
        ),
      );
    for (const rule of rules)
      for (const day of occurrences(
        rule.recurrence as Recurrence,
        today,
        horizon,
      )) {
        const r = await db
          .insert(clientObligations)
          .values({
            id: generateId("obl"),
            clientId: sub.clientId,
            serviceId: rule.serviceId,
            ruleId: rule.id,
            periodKey: `${rule.id}:${day}`,
            label: rule.label,
            dueDate: day,
            leadDays: rule.leadDays,
            remindOffsets: rule.remindOffsets,
            status: "upcoming",
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          })
          .onConflictDoNothing()
          .returning({ id: clientObligations.id });
        created += r.length;
      }
  }
  return created;
}

/** F-CAL-08: flips overdue obligations to missed, then tells the client (penalty notice), flags the linked case urgent
 *  and alerts the service managers. */
export async function markMissed(db: Tx, now: Date, notify?: Notify) {
  const r = await db
    .update(clientObligations)
    .set({ status: "missed", updatedAt: now.toISOString() })
    .where(
      and(
        eq(clientObligations.status, "upcoming"),
        lt(clientObligations.dueDate, kigaliToday(now)),
      ),
    )
    .returning({ id: clientObligations.id, clientId: clientObligations.clientId, label: clientObligations.label, dueDate: clientObligations.dueDate, applicationId: clientObligations.applicationId });
  if (!notify || !r.length) return r.length;
  const managers = (await usersWithRole(db, ["staff:service_manager"])).map((id) => ({ id }));
  for (const o of r) {
    const label = (o.label as Record<string, string>).en ?? Object.values(o.label as Record<string, string>)[0] ?? "Obligation";
    await notify(db, { userId: o.clientId, kind: "deadline.missed", title: `Missed deadline: ${label}`, body: `The due date ${o.dueDate} has passed. Late filing can bring penalties; reply to us and we will help you file now.`, link: "/dashboard/calendar", channels: ["email", "sms"] });
    if (o.applicationId) await db.update(applications).set({ isUrgent: true }).where(eq(applications.applicationId, o.applicationId));
    for (const m of managers)
      await notify(db, { userId: m.id, kind: "deadline.missed_staff", title: `Client missed: ${label}`, body: `Due ${o.dueDate}.`, link: o.applicationId ? `/ops/cases/${o.applicationId}` : "/ops/compliance-rules", channels: ["email"] });
  }
  return r.length;
}

export async function recordBreaches(db: Tx, now: Date) {
  const r = await db
    .update(applications)
    .set({ slaBreachedAt: now.toISOString() })
    .where(
      and(
        isNull(applications.slaBreachedAt),
        notInArray(applications.status, TERMINAL_APP_STATUSES),
        sql`coalesce(${applications.dueAt}, ${applications.slaDeadline}) < ${now.toISOString()}`,
      ),
    )
    .returning({ id: applications.applicationId });
  return r.length;
}

/** Claim offsets in deadline_notifications (unique per target+offset), so a reminder is never sent twice. */
async function claim(
  db: Tx,
  targetType: string,
  targetId: string,
  offsets: number[],
  now: Date,
) {
  let claimed = false;
  for (const o of offsets) {
    const r = await db
      .insert(deadlineNotifications)
      .values({
        id: generateId("dnt"),
        targetType,
        targetId,
        offsetDays: o,
        sentAt: now.toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: deadlineNotifications.id });
    claimed ||= r.length > 0;
  }
  return claimed;
}

/** One reminder per offset reached (in-app + email), to the case's agent or the client's dedicated agent. */
export async function sendReminders(db: Tx, notify: Notify, now: Date) {
  const today = kigaliToday(now);
  const lookahead = endOfKigaliDay(
    addDays(today, Math.max(...DEFAULT_CASE_OFFSETS)),
  );
  const items: {
    agentId: string;
    type: string;
    offsets: number[];
    targetId: string;
    title: string;
    due: string;
    href: string;
    clientId?: string;
  }[] = [];
  const cases = await db
    .select()
    .from(applications)
    .where(
      and(
        notInArray(applications.status, TERMINAL_APP_STATUSES),
        isNotNull(applications.assignedAgentId),
        sql`coalesce(${applications.dueAt}, ${applications.slaDeadline}) <= ${lookahead}`,
      ),
    );
  for (const a of cases) {
    const dueDay = kigaliDate((a.dueAt ?? a.slaDeadline)!);
    const days = daysBetween(today, dueDay);
    if (days < 0) continue;
    items.push({
      agentId: a.assignedAgentId!,
      type: "case",
      offsets: DEFAULT_CASE_OFFSETS.filter((o) => days <= o),
      targetId: a.applicationId,
      title: `${a.serviceName} (${a.code})`,
      due: dueDay,
      href: `/agent/case/${a.code}`,
    });
  }
  const subs = await db
    .select({
      clientId: clientSubscriptions.clientId,
      agentId: clientSubscriptions.dedicatedAgentId,
    })
    .from(clientSubscriptions)
    .where(
      and(
        inArray(clientSubscriptions.status, LIVE_SUBSCRIPTION_STATUSES),
        isNotNull(clientSubscriptions.dedicatedAgentId),
      ),
    );
  const agentOf = new Map(subs.map((s) => [s.clientId, s.agentId!]));
  if (agentOf.size) {
    const obls = await db
      .select()
      .from(clientObligations)
      .where(
        and(
          inArray(clientObligations.clientId, [...agentOf.keys()]),
          gte(clientObligations.dueDate, today),
          inArray(clientObligations.status, [...OPEN_OBLIGATION_STATUSES]),
        ),
      );
    for (const o of obls) {
      const days = daysBetween(today, o.dueDate);
      const offsets = ((o.remindOffsets as number[]) ?? [])
        .map(Number)
        .filter((x) => days <= x);
      if (offsets.length)
        items.push({
          agentId: agentOf.get(o.clientId)!,
          type: "obligation",
          offsets,
          targetId: o.id,
          title: localized(o.label) || "Deadline",
          due: o.dueDate,
          href: "/agent/calendar",
          clientId: o.clientId,
        });
    }
  }
  if (!items.length) return 0;
  const agentIds = [...new Set(items.map((i) => i.agentId))];
  const optedOut = new Set(
    (
      await db
        .select({ id: agentSettings.userId })
        .from(agentSettings)
        .where(
          and(
            inArray(agentSettings.userId, agentIds),
            eq(agentSettings.notificationSlaAlert, false),
          ),
        )
    ).map((r) => r.id),
  );
  const active = new Set(
    (
      await db
        .select({ id: users.userId })
        .from(users)
        .where(and(inArray(users.userId, agentIds), eq(users.isActive, true)))
    ).map((r) => r.id),
  );
  let sent = 0;
  for (const it of items) {
    if (!active.has(it.agentId) || optedOut.has(it.agentId)) continue;
    if (!(await claim(db, it.type, it.targetId, it.offsets, now))) continue;
    await notify(db, {
      userId: it.agentId,
      kind: "status_update",
      title: `Due ${it.due}: ${it.title}`,
      body: `${it.title} is due on ${it.due}.`,
      link: it.href,
      channels: ["email"],
    });
    sent++;
  }
  // F-CAL-06: the client is reminded too, on every channel; the event rule + their preference matrix ("deadlines")
  // and quiet hours decide which actually go out (notifications delivery).
  for (const it of items.filter((x) => x.clientId)) {
    if (!(await claim(db, "obligation_client", it.targetId, it.offsets, now))) continue;
    await notify(db, {
      userId: it.clientId!,
      kind: "deadline.reminder",
      title: `Reminder: ${it.title} is due ${it.due}`,
      body: `Your ${it.title} deadline is ${it.due}. Reply in your HEBUZA messages if you want us to handle it.`,
      link: "/dashboard/calendar",
      channels: ["email", "sms", "whatsapp"],
    });
    sent++;
  }
  return sent;
}

/** F-CAL-03: rule codes a company profile makes applicable (national calendar, seed COMPLIANCE). */
export function orgRuleCodes(o: { orgType: string; tin: string | null; vatRegistered: boolean; vatPeriod: string; employer: boolean }): string[] {
  const codes: string[] = [];
  if (o.vatRegistered) codes.push(o.vatPeriod === "quarterly" ? "RRA_VAT_QUARTERLY" : "RRA_VAT_MONTHLY");
  if (o.employer) codes.push("RRA_PAYE", "RSSB_CONTRIB");
  if (o.tin && o.orgType !== "sole_proprietor") codes.push("RRA_CIT_ANNUAL", "RRA_CIT_PREPAY", "RDB_ANNUAL_RETURN");
  if (o.tin && o.orgType === "sole_proprietor") codes.push("RRA_PIT_ANNUAL");
  return codes;
}

/** F-CAL-03: obligations from each verified company's compliance profile, owned by the company's owner(s) so they
 *  show on their calendar. Idempotent (unique client + service + period). Rules without a linked service are skipped. */
export async function generateOrgObligations(db: Tx, now: Date) {
  const today = kigaliToday(now);
  const horizon = addDays(today, OBLIGATION_HORIZON_DAYS);
  const orgs = await db.select().from(organizations).where(and(eq(organizations.verificationStatus, "verified"), isNull(organizations.archivedAt)));
  if (!orgs.length) return 0;
  const rules = await db.select().from(complianceRules).where(eq(complianceRules.active, true));
  const svc = new Map((await db.select({ id: services.serviceId, slug: services.slug }).from(services)).map((x) => [x.slug, x.id]));
  let created = 0;
  for (const o of orgs) {
    const codes = new Set(orgRuleCodes(o));
    const owners = await db.select({ id: organizationMembers.userId }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, o.id), eq(organizationMembers.role, "owner"), eq(organizationMembers.status, "active")));
    for (const rule of rules.filter((r) => codes.has(r.code))) {
      const serviceId = rule.serviceSlug ? svc.get(rule.serviceSlug) : undefined;
      if (!serviceId) continue;
      for (const day of occurrences(rule.recurrence as Recurrence, today, horizon))
        for (const ow of owners) {
          const r = await db.insert(clientObligations).values({
            id: generateId("obl"), clientId: ow.id, serviceId, ruleId: null, periodKey: `org:${o.id}:${rule.code}:${day}`,
            label: { ...(rule.label as Record<string, string>), en: `${(rule.label as Record<string, string>).en} · ${o.legalName}` },
            dueDate: day, leadDays: rule.leadDays, remindOffsets: (rule.remindOffsets as number[]).map((x) => Math.abs(x)),
            status: "upcoming", createdAt: now.toISOString(), updatedAt: now.toISOString(),
          }).onConflictDoNothing().returning({ id: clientObligations.id });
          created += r.length;
        }
    }
  }
  return created;
}

/** Everything the 07:00 Kigali cron does. Safe to run more than once. */
export async function runDaily(db: Tx, notify: Notify, now = new Date()) {
  // shortcut: Python also sends the agent daily summary and the admin digest; port with P5 (ops/agent workspace).
  return {
    obligationsCreated: (await generateObligations(db, now)) + (await generateOrgObligations(db, now)),
    obligationsMissed: await markMissed(db, now, notify),
    breachesRecorded: await recordBreaches(db, now),
    remindersSent: await sendReminders(db, notify, now),
  };
}
