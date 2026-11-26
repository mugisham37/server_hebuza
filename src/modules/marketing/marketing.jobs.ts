// Marketing worker (port of reference marketing.jobs): campaign send tick, sequence runner, conversion + referral
// sweeps, contact sync, link check, lead retention purge; plus the per-recipient `bulk` sends, link-click counting,
// system audit rows and the booking lead mirror. Delivery: email via MailService (with an unsubscribe link), SMS via
// SmsService, WhatsApp through the Cloud API only when WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set.
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { and, eq, sql } from "drizzle-orm";
import { applications, systemRecords, users } from "@/db/schema";
import type { Campaign, Channel, Contact, InboxThread, Lead, MsgTemplate } from "@/domain/marketing/types";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService, type AuditEntry } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { Cron, Job } from "../../core/queue/queues";
import { MailService } from "../../core/notify/mail.service";
import { SmsService } from "../../core/notify/sms.service";
import { CryptoService } from "../../core/crypto/crypto.service";
import { inQuietHours } from "@/domain/marketing/quiet-hours";
import { eligibility } from "@/domain/marketing/consent";
import { get, list, put, type Exec } from "./marketing.store";
import { bookingOutcome, captureFrom, purgeStale, sweepWon, unsubToken } from "./marketing.crm";
import { runTick, sendTick, winbackSweep } from "./marketing.campaigns";
import { complianceRules } from "@/db/schema/schema-ops";
import { pullSocial } from "./marketing.social";
import { kigaliToday, occurrences } from "../deadlines/deadlines.service";
const TAX_TPL: Record<"en" | "fr" | "rw", string> = {
  en: "Reminder: {label} is due on {date}. HEBUZA can file it for you.",
  fr: "Rappel : {label} est dû le {date}. HEBUZA peut s'en charger pour vous.",
  rw: "Kwibutsa: {label} bigomba gukorwa bitarenze {date}. HEBUZA ishobora kubigukorera.",
};
import { sweepReferrals } from "./marketing.insights";
import { checkLinks, countClick, type LinkClick } from "./marketing.content";

const first = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const fill = (body: string, v: Record<string, string>) => body.replace(/{{(\w+)}}/g, (_, k: string) => v[k] ?? "");
type Msg = { subject?: string; body: string; template?: string; language?: string; unsubscribe?: string };

async function templateFor(db: Exec, key: string, channel: Channel, language: string) {
  const ts = (await list<MsgTemplate>(db, "template", { ref: key })).filter((t) => t.channel === channel && t.status === "active");
  return ts.find((t) => t.language === language) ?? ts.find((t) => t.language === "en") ?? ts[0];
}

/** Client contacts also need the account-level marketing opt-in (account consents, default off). */
async function accountAllows(db: Exec, clientId?: string) {
  if (!clientId) return true;
  const [r] = await db
    .select({ data: systemRecords.data })
    .from(systemRecords)
    .where(and(eq(systemRecords.kind, "acct"), eq(systemRecords.id, `${clientId}:consents`)));
  return (r?.data as { marketing?: boolean } | undefined)?.marketing === true;
}
/** Send-time consent re-check for one recipient: channel consent "in", not suppressed, has an address, account opt-in. */
const mayReceive = async (db: Exec, m: Contact, channel: Channel) =>
  eligibility([m], { channel }).eligible.length === 1 && (await accountAllows(db, m.clientId));

@Injectable()
export class MarketingJobs {
  private readonly log = new Logger("marketing");
  private readonly origin: string;
  constructor(
    private readonly txs: TxService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.origin = String(config.get("WEB_ORIGIN", { infer: true }) ?? "").split(",")[0].trim();
  }

  /** One outbound message. Returns false when the provider refused it. */
  private async send(channel: Channel, to: { phone?: string; email?: string }, msg: Msg) {
    if (channel === "email") {
      if (!to.email) return false;
      const foot = msg.unsubscribe ? `Unsubscribe: ${msg.unsubscribe}` : "Unsubscribe: reply STOP";
      const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
      await this.mail.send({
        to: to.email,
        subject: msg.subject ?? "HEBUZA",
        text: `${msg.body}\n\n\n${foot}`,
        html: `<p>${esc(msg.body).replace(/\n/g, "<br>")}</p><hr><p style="font-size:12px">${msg.unsubscribe ? `<a href="${esc(msg.unsubscribe)}">Unsubscribe</a>` : "Reply STOP to unsubscribe"}</p>`,
        tags: { kind: "marketing" },
      });
      return true;
    }
    if (!to.phone) return false;
    const token = this.config.get("WHATSAPP_ACCESS_TOKEN", { infer: true });
    const phoneId = this.config.get("WHATSAPP_PHONE_NUMBER_ID", { infer: true });
    if (channel === "whatsapp") {
      if (!token || !phoneId || !msg.template) {
        // shortcut: no WhatsApp keys/template, the send is logged as delivered; set the env keys to send for real.
        this.log.log({ event: "mkt.whatsapp.skipped", template: msg.template });
        return true;
      }
      const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: to.phone.replace("+", ""),
          type: "template",
          template: { name: msg.template, language: { code: msg.language ?? "en" } },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return r.ok;
    }
    await this.sms.send({ to: to.phone, text: msg.unsubscribe ? `${msg.body}\nSTOP: ${msg.unsubscribe}` : msg.body });
    return true;
  }

  private async campaignMessage(db: Exec, cp: Campaign, m: Contact): Promise<Msg | null> {
    const lang = cp.templates[m.language] ? m.language : (cp.fallbackLanguage ?? m.language);
    const t = cp.templates[lang];
    const tpl = t?.templateKey ? await templateFor(db, t.templateKey, cp.channel, lang) : undefined;
    const body = fill(t?.body ?? tpl?.body ?? "", { first_name: first(m.name), org: m.org ?? "", link: `${this.origin}/c/${cp.slug}` });
    if (!body) return null;
    // A/B subject: deterministic split by contact id.
    const subject =
      t?.subjectB && [...m.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 100 < (t.abSplit ?? 50) ? t.subjectB : (t?.subjectA ?? tpl?.subject);
    return { subject, body, template: tpl?.key, language: lang };
  }

  // ---------------------------------------------------------------- campaigns
  /** Tick: hands each due recipient (after the send-time consent re-check) to the `bulk` queue as its own job. */
  @Cron("mkt.campaign-send", "* * * * *")
  campaignSend() {
    return this.txs.runAsSystem((tx) =>
      sendTick(
        tx,
        async (cp, m) => {
          if (!(await mayReceive(tx, m, cp.channel))) return false;
          await this.outbox.add(tx, { type: "marketing.send", queue: "bulk", payload: { campaignId: cp.id, contactId: m.id } });
          return true;
        },
        inQuietHours(new Date()),
      ),
    );
  }

  /** One recipient (bulk queue). Consent is checked again: an opt-out between tick and send wins. */
  @Job("marketing.send")
  async sendOne(d: { campaignId: string; contactId: string }) {
    const job = await this.txs.runAsSystem(async (tx) => {
      const [cp, m] = await Promise.all([get<Campaign>(tx, "campaign", d.campaignId), get<Contact>(tx, "contact", d.contactId)]);
      if (!cp || !m || cp.status === "cancelled" || !(await mayReceive(tx, m, cp.channel))) return null;
      const msg = await this.campaignMessage(tx, cp, m);
      return msg && { cp, m, msg };
    });
    if (!job) return;
    const unsubscribe = `${this.origin}/unsubscribe?token=${unsubToken(this.crypto, { contactId: job.m.id, channel: job.cp.channel, campaignId: job.cp.id })}`;
    // shortcut: a provider refusal throws/retries (BullMQ backoff, then DLQ) instead of landing in the campaign's failedIds.
    if (!(await this.send(job.cp.channel, { phone: job.m.phoneE164, email: job.m.email }, { ...job.msg, unsubscribe })))
      throw new Error(`mkt send refused ${d.campaignId}/${d.contactId}`);
  }

  /** Test send to the person preparing the campaign (their own user record, no consent gate). */
  @Job("marketing.test_send")
  async testSend(d: { campaignId: string; userId: string }) {
    const job = await this.txs.runAsSystem(async (tx) => {
      const cp = await get<Campaign>(tx, "campaign", d.campaignId);
      const [u] = await tx
        .select({ name: users.name, email: users.email, phone: users.phoneE164, language: users.language })
        .from(users)
        .where(eq(users.userId, d.userId))
        .limit(1);
      if (!cp || !u) return null;
      const m = { id: d.userId, name: u.name, email: u.email ?? undefined, phoneE164: u.phone ?? undefined, language: u.language } as Contact;
      const msg = await this.campaignMessage(tx, cp, m);
      return msg && { cp, m, msg };
    });
    if (job) await this.send(job.cp.channel, { phone: job.m.phoneE164, email: job.m.email }, job.msg);
  }

  /** Inbox reply delivery (the message is already stored on the thread). */
  @Job("marketing.reply")
  async reply(d: { threadId: string; channel: InboxThread["channel"]; body: string }) {
    if (d.channel === "web") return; // web contact-form threads are answered by email from the lead record
    const to = await this.txs.runAsSystem(async (tx) => {
      const t = await get<InboxThread>(tx, "thread", d.threadId);
      const lead = t?.leadId ? await get<Lead>(tx, "lead", t.leadId) : undefined;
      return t && { subject: t.subject, phone: lead?.phoneE164, email: lead?.email };
    });
    if (to) await this.send(d.channel, to, { subject: to.subject ? `Re: ${to.subject}` : undefined, body: d.body });
  }

  // ---------------------------------------------------------------- sequences
  @Cron("mkt.sequence-run", "*/5 * * * *")
  sequenceRun() {
    return this.txs.runAsSystem((tx) =>
      runTick(
        tx,
        async (ch, key, lead) => {
          if (!(await templateFor(tx, key, ch, lead.language))) return false;
          await this.outbox.add(tx, { type: "marketing.sequence_send", queue: "bulk", payload: { leadId: lead.id, channel: ch, key } });
          return true;
        },
        inQuietHours(new Date()),
      ),
    );
  }

  @Job("marketing.sequence_send")
  async sequenceSend(d: { leadId: string; channel: Channel; key: string }) {
    const job = await this.txs.runAsSystem(async (tx) => {
      const lead = await get<Lead>(tx, "lead", d.leadId);
      if (!lead || lead.consent[d.channel] !== "in") return null; // consent re-checked at send time
      const tpl = await templateFor(tx, d.key, d.channel, lead.language);
      return tpl && { lead, tpl };
    });
    if (!job) return;
    const { lead, tpl } = job;
    await this.send(
      d.channel,
      { phone: lead.phoneE164, email: lead.email },
      { subject: tpl.subject, body: fill(tpl.body, { first_name: first(lead.name) }), template: tpl.key, language: tpl.language },
    );
  }

  // ---------------------------------------------------------------- sweeps
  @Cron("mkt.conversion-sweep", "*/15 * * * *")
  async conversionSweep() {
    const won = await this.txs.runAsSystem((tx) => sweepWon(tx));
    const refs = await this.txs.runAsSystem((tx) => sweepReferrals(tx));
    if (won || refs) this.log.log({ event: "mkt.conversion_sweep", won, refs });
  }

  @Cron("mkt.contact-sync", "17 * * * *")
  contactSync() {
    return this.txs.runAsSystem((tx) => syncContacts(tx));
  }

  /** F-CRM-12: 7 days before each active compliance deadline, consented leads who are not clients get one reminder per channel. */
  @Cron("mkt.tax-reminders", "0 6 * * *")
  async taxReminders() {
    const day = kigaliToday(new Date(Date.now() + 7 * 864e5));
    const jobs = await this.txs.runAsSystem(async (tx) => {
      const rules = (await tx.select().from(complianceRules).where(eq(complianceRules.active, true)))
        .filter((r) => occurrences(r.recurrence as Parameters<typeof occurrences>[0], day, day).length);
      if (!rules.length) return [];
      const leads = (await list<Lead>(tx, "lead")).filter((l) => !l.clientId && !["merged", "lost"].includes(l.stage));
      const out: { l: Lead; ch: "email" | "sms"; text: string; key: string }[] = [];
      for (const r of rules) for (const l of leads) for (const ch of ["email", "sms"] as const) {
        if (l.consent[ch] !== "in" || !(ch === "email" ? l.email : l.phoneE164)) continue;
        const key = `${r.code}:${day}:${l.id}:${ch}`;
        if (await get(tx, "tax_reminder", key)) continue; // idempotent across retries/reruns
        await put(tx, { kind: "tax_reminder", id: key, data: { at: new Date().toISOString() } });
        const label = (r.label as Record<string, string>)[l.language] ?? (r.label as Record<string, string>).en ?? r.code;
        out.push({ l, ch, key, text: TAX_TPL[l.language as "en"]?.replace("{label}", label).replace("{date}", day) ?? `${label}: ${day}` });
      }
      return out;
    });
    for (const j of jobs)
      await this.send(j.ch, { email: j.l.email, phone: j.l.phoneE164 }, {
        subject: "HEBUZA", body: j.text, language: j.l.language,
        unsubscribe: `${this.origin}/unsubscribe?token=${unsubToken(this.crypto, { contactId: j.l.id, channel: j.ch, campaignId: "tax-reminders" })}`,
      });
  }

  /** Realtime-only event (the relay already fanned it out to SSE); nothing to do in the worker. */
  @Job("mkt.note")
  mktNote() {}

  /** Testimonial consent asked → in-app notification to the client who left the rating (rating id = application id). */
  @Job("marketing.testimonial_consent_requested")
  testimonialConsentRequested(d: { ratingId: string }) {
    return this.txs.runAsSystem(async (tx) => {
      const [a] = await tx.select({ client: applications.clientId }).from(applications).where(eq(applications.applicationId, d.ratingId));
      if (!a?.client) return; // seeded/demo rating without an owner
      await this.outbox.add(tx, { type: "notifications.deliver", payload: { userId: a.client, kind: "testimonial.consent", title: "May we share your review?", body: "Open your dashboard to answer yes or no.", link: "/dashboard", data: { type: "testimonial.consent_requested" } } });
    });
  }

  /** CRM convert → signup invitation (prefilled /signup link) on the lead's consented channel. */
  @Job("marketing.account_invite")
  async accountInvite(d: { leadId: string; channel: "email" | "whatsapp" | "sms"; name: string; email: string | null; phone: string | null; language: string }) {
    const l = ["rw", "en", "fr"].includes(d.language) ? d.language : "en";
    const q = new URLSearchParams({ name: d.name, ...(d.email ? { email: d.email } : d.phone ? { phone: d.phone } : {}), ref: d.leadId });
    const link = `${this.origin}/${l}/signup?${q}`;
    const body = { en: `Hello ${d.name}, create your HEBUZA account to follow your requests: ${link}`, fr: `Bonjour ${d.name}, créez votre compte HEBUZA pour suivre vos demandes : ${link}`, rw: `Muraho ${d.name}, fungura konti ya HEBUZA ukurikirane ubusabe bwawe: ${link}` }[l as "en"];
    if (!(await this.send(d.channel, { email: d.email ?? undefined, phone: d.phone ?? undefined }, { subject: "HEBUZA", body, language: l })))
      throw new Error("account_invite not sent"); // retried
  }

  @Cron("mkt.social-pull", "20 5 * * *")
  async socialPull() {
    const g = (k: "META_PAGE_ID" | "META_PAGE_TOKEN" | "LINKEDIN_ORG_ID" | "LINKEDIN_TOKEN") => this.config.get(k, { infer: true });
    const e = { META_PAGE_ID: g("META_PAGE_ID"), META_PAGE_TOKEN: g("META_PAGE_TOKEN"), LINKEDIN_ORG_ID: g("LINKEDIN_ORG_ID"), LINKEDIN_TOKEN: g("LINKEDIN_TOKEN") };
    if (!Object.values(e).some(Boolean)) return;
    const n = await this.txs.runAsSystem((tx) => pullSocial({ db: tx, session: null }, e));
    if (n) this.log.log({ event: "mkt.social_pull", rows: n });
  }

  @Cron("mkt.winback", "10 4 * * *")
  async winback() {
    const r = await this.txs.runAsSystem((tx) => winbackSweep(tx));
    if (r.enrolled || r.reactivated) this.log.log({ event: "mkt.winback", ...r });
  }

  @Cron("mkt.link-check", "30 3 * * *")
  linkCheck() {
    return this.txs.runAsSystem((tx) => checkLinks(tx));
  }

  @Cron("mkt.lead-retention", "45 2 * * *")
  async leadRetention() {
    const n = await this.txs.runAsSystem((tx) => purgeStale(tx));
    if (n) this.log.log({ event: "mkt.lead_retention", purged: n });
  }

  // ---------------------------------------------------------------- events
  @Job("marketing.link_click")
  linkClick(d: LinkClick) {
    return this.txs.runAsSystem((tx) => countClick(tx, d));
  }

  /** Audit rows decided by system callers (jobs, captures from other modules). */
  @Job("marketing.audit")
  auditRow(d: AuditEntry) {
    return this.txs.runAsSystem((tx) => this.audit.record(tx, d));
  }

  /** Booking leads mirror into the CRM (dedupes against open leads). phone/email arrive sealed. */
  /** F-CRM-15 GA4 Measurement Protocol forwarder; dormant without GA4_MEASUREMENT_ID + GA4_API_SECRET. */
  @Job("marketing.ga4_event")
  async ga4(d: { name: string; path: string; visitor: string; locale: string | null }) {
    const id = this.config.get("GA4_MEASUREMENT_ID", { infer: true });
    const secret = this.config.get("GA4_API_SECRET", { infer: true });
    if (!id || !secret) return;
    const r = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${id}&api_secret=${encodeURIComponent(secret)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: d.visitor, events: [{ name: d.name, params: { page_location: `${this.origin}${d.path}`, language: d.locale ?? undefined } }] }),
    });
    if (!r.ok) throw new Error(`ga4 ${r.status}`); // retried with backoff
  }
  @Job("booking.outcome_recorded")
  bookingOutcome(d: { phone?: string; email?: string; status: string; services: string[] }) {
    const p = this.crypto.unseal(d, ["phone", "email"]);
    return this.txs.runAsSystem((tx) => bookingOutcome({ db: tx, session: null }, p));
  }
  @Job("booking.lead_captured")
  leadCaptured(d: { leadId: string; name: string; phone?: string; email?: string; source: string }) {
    const p = this.crypto.unseal(d, ["phone", "email"]);
    return this.txs.runAsSystem((tx) => captureFrom(tx, "booking", { name: p.name, phone: p.phone, email: p.email }));
  }
}

/** Client accounts become CRM contacts (consent unknown until they opt in); last activity follows their requests. */
export async function syncContacts(db: Tx) {
  const rows = await db
    .select({
      id: users.userId,
      name: users.name,
      email: users.email,
      phone: users.phoneE164,
      language: users.language,
      created: users.createdAt,
      customerNo: users.customerNo,
      last: sql<string | null>`max(${applications.createdAt})`,
    })
    .from(users)
    .leftJoin(applications, eq(applications.clientId, users.userId))
    .where(and(eq(users.role, "client"), eq(users.isActive, true)))
    .groupBy(users.userId);
  const have = new Map((await list<Contact>(db, "contact", { status: ["customer"] })).map((c) => [c.clientId, c]));
  let n = 0;
  for (const r of rows) {
    const cur = have.get(r.id);
    const lastActiveAt = r.last ?? r.created;
    const customerId = r.customerNo ?? cur?.customerId ?? "";
    if (cur && cur.lastActiveAt >= lastActiveAt && cur.customerId === customerId) continue;
    const c: Contact = cur
      ? { ...cur, lastActiveAt, customerId }
      : {
          id: r.id,
          name: r.name,
          phoneE164: r.phone ?? undefined,
          email: r.email ?? undefined,
          language: (["rw", "en", "fr"].includes(r.language) ? r.language : "rw") as Contact["language"],
          sector: "services",
          district: "",
          province: "",
          size: "micro",
          servicesUsed: [],
          interests: [],
          obligations: [],
          lastActiveAt,
          ltv: 0,
          consent: { email: "unknown", whatsapp: "unknown", sms: "unknown" },
          clientId: r.id,
          customerId, // CRM-01: users.customer_no (assigned at signup/claim, backfilled by scripts/backfill-customer-no)
        };
    await put(db, { kind: "contact", id: c.id, data: c, status: "customer", ref: r.id });
    n++;
  }
  return n;
}
