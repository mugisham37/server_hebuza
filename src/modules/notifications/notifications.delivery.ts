// External delivery (F-NTF-01/06/07/08/09/11/12/15): applies the console's event rules, the recipient's preferences,
// quiet hours, templates per language, dedupe, suppression, consent and channel budgets, then records every send in
// notification_deliveries. Each send is its own `notifications.send` job (exponential backoff); a send that fails for
// good falls through to the next channel of the rule's fallback chain.
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  consentLedger,
  notificationDeliveries,
  notificationSuppressions,
  supportTickets,
  users,
} from "@/db/schema";
import {
  DEDUPE_WINDOW_MS,
  UNIT_COST_RWF,
  categoryOf,
  dedupeKey,
  isStartKeyword,
  isStopKeyword,
  planDelivery,
  renderTemplate,
  type ExtChannel,
  type Prefs,
} from "@/domain/notify/delivery";
import { activeVersion, capDecision, extractVars, smsSegments } from "@/domain/system/templates";
import type { BudgetVM, EventRuleVM, TemplateVM } from "@/domain/system/types";
import type { Env } from "../../core/config/env";
import { DB, type Db } from "../../core/db/db";
import { MailService } from "../../core/notify/mail.service";
import { SmsService, maskTo } from "../../core/notify/sms.service";
import { TxService } from "../../core/db/tx";
import { normalizeRoles } from "@/domain/auth/roles";
import type { SessionUser } from "../../core/http/context";
import { addMessage as addTicketMessage, createTicket } from "../applications/support.service";
import { QueueService } from "../../core/queue/queues";
import { settingOf, systemDocs } from "../../core/db/system-records";
import { WhatsappService } from "../../core/notify/whatsapp.service";
import type { NotifyInput } from "./notifications.service";

type Delivery = typeof notificationDeliveries.$inferSelect;
type Recipient = {
  userId: string;
  email: string | null;
  phone: string | null;
  lang: string;
};
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LANGS = ["rw", "en", "fr"] as const;
/** Statuses that count as "already sent" for the dedupe window. */
const LIVE = ["queued", "deferred", "sent", "delivered", "read"];
export const POLICY_VERSION = "2026-01"; // PLACEHOLDER(privacy-policy-version) bump with the published policy
const monthStart = (d = new Date()) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();

@Injectable()
export class DeliveryService {
  private readonly log = new Logger("notify.delivery");
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly wa: WhatsappService,
    private readonly tx: TxService,
    private readonly queues: QueueService,
    private readonly cfg: ConfigService<Env, true>,
  ) {}

  private get appUrl() {
    return this.cfg.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim();
  }

  async dispatched(notificationId: string) {
    const [r] = await this.db.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, notificationId)).limit(1);
    return !!r;
  }

  /** Called by notifications.deliver after the in-app row exists. */
  async dispatch(n: NotifyInput, prefs: Prefs, notificationId: string) {
    const [rules, [u]] = await Promise.all([
      systemDocs<EventRuleVM>(this.db, "rules"),
      this.db
        .select({
          email: users.email,
          phone: users.phoneE164,
          active: users.isActive,
          lang: users.language,
        })
        .from(users)
        .where(eq(users.userId, n.userId)),
    ]);
    if (!u?.active) return;
    const rule = rules.find((r) => r.event === n.kind) ?? null;
    if (!rule && !n.channels?.length) return;
    // F-SET-09: platform quiet hours apply to users who set none of their own.
    if (!prefs.quiet && (await settingOf<boolean>(this.db, "notifications.global_quiet"))) {
      const hh = (n: unknown) => `${String(Number.isInteger(n) ? n : 0).padStart(2, "0")}:00`;
      prefs = { ...prefs, quiet: { on: true, from: hh(await settingOf(this.db, "notifications.quiet_start_hour")), to: hh(await settingOf(this.db, "notifications.quiet_end_hour")) } };
    }
    const plan = planDelivery({
      kind: n.kind,
      requested: n.channels ?? [],
      rule,
      prefs,
      now: new Date(),
    });
    // F-SET-12: WhatsApp off → dropped from the plan (the chain continues with the next channel).
    if (!(await settingOf<boolean>(this.db, "flags.whatsapp_channel"))) {
      plan.parallel = plan.parallel.filter((c) => c !== "whatsapp");
      plan.chain = plan.chain.filter((c) => c !== "whatsapp");
    }
    const to: Recipient = {
      userId: n.userId,
      email: u.email,
      phone: u.phone,
      lang: LANGS.includes(u.lang as never) ? u.lang : "en",
    };
    for (const ch of plan.muted)
      await this.record(n, to, ch, notificationId, {
        status: "skipped",
        lastError: "preference",
      });
    const starts: [ExtChannel, ExtChannel[]][] = [
      ...plan.parallel.map((c): [ExtChannel, ExtChannel[]] => [c, []]),
    ];
    if (plan.chain.length) starts.push([plan.chain[0], plan.chain.slice(1)]);
    for (const [ch, rest] of starts)
      await this.start(n, to, ch, rest, notificationId, plan.deferUntil);
  }

  /** Creates the delivery row for one channel and queues its send; on a pre-send block, falls through the chain. */
  private async start(
    n: NotifyInput,
    to: Recipient,
    ch: ExtChannel,
    rest: ExtChannel[],
    notificationId: string,
    deferUntil: Date | null,
    fallbackFrom?: string,
  ): Promise<void> {
    const next = (id: string) =>
      rest.length
        ? this.start(
            n,
            to,
            rest[0],
            rest.slice(1),
            notificationId,
            deferUntil,
            id,
          )
        : Promise.resolve();
    const address = ch === "email" ? to.email : to.phone;
    const base = { chain: rest, fallbackFrom: fallbackFrom ?? null };
    if (!address)
      return next(
        await this.record(n, to, ch, notificationId, {
          ...base,
          status: "failed",
          lastError: "no_address",
        }),
      );
    if (await this.suppressed(ch, address))
      return next(
        await this.record(
          n,
          to,
          ch,
          notificationId,
          { ...base, status: "suppressed" },
          address,
        ),
      );
    const cat = categoryOf(n.kind);
    if (cat === "news" && !(await this.consented(to.userId, `marketing_${ch}`)))
      return void (await this.record(
        n,
        to,
        ch,
        notificationId,
        { ...base, status: "skipped", lastError: "no_consent" },
        address,
      ));
    const key = dedupeKey(
      to.userId,
      n.kind,
      ch,
      n.data?.vars?.ref ?? n.link ?? n.title,
    );
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const [dup] = await this.db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.dedupeKey, key),
          gte(notificationDeliveries.createdAt, since),
          inArray(notificationDeliveries.status, LIVE),
        ),
      )
      .limit(1);
    if (dup && !fallbackFrom)
      return void (await this.record(
        n,
        to,
        ch,
        notificationId,
        { ...base, status: "duplicate" },
        address,
      ));
    const tpl = await this.template(n.kind, ch);
    if (
      await this.overBudget(
        ch,
        tpl?.category ?? (cat === "news" ? "marketing" : "utility"),
      )
    )
      return next(
        await this.record(
          n,
          to,
          ch,
          notificationId,
          { ...base, status: "capped" },
          address,
        ),
      );
    const payload = this.render(n, to.lang, tpl);
    const id = await this.record(
      n,
      to,
      ch,
      notificationId,
      {
        ...base,
        status: deferUntil ? "deferred" : "queued",
        dedupeKey: key,
        templateKey: tpl?.key ?? null,
        payload,
        scheduledAt: deferUntil?.toISOString() ?? null,
      },
      address,
    );
    await this.queues.add(
      "default",
      "notifications.send",
      { id },
      {
        jobId: id,
        delay: deferUntil
          ? Math.max(0, deferUntil.getTime() - Date.now())
          : undefined,
      },
    );
  }

  private async record(
    n: NotifyInput,
    to: Recipient,
    ch: ExtChannel,
    notificationId: string,
    o: Partial<typeof notificationDeliveries.$inferInsert> & { status: string },
    address?: string,
  ) {
    const now = new Date().toISOString();
    const id = `dlv_${randomUUID()}`;
    await this.db.insert(notificationDeliveries).values({
      id,
      notificationId,
      userId: to.userId,
      kind: n.kind.slice(0, 64),
      channel: ch,
      toMasked: address ? maskTo(address).slice(-64) : "—",
      lang: to.lang,
      createdAt: now,
      updatedAt: now,
      ...o,
    });
    return id;
  }

  private async template(kind: string, ch: ExtChannel) {
    const t = (await systemDocs<TemplateVM>(this.db, "templates")).find(
      (x) => x.event === kind && x.channel === ch,
    );
    const v = t && activeVersion(t);
    return t && v ? { key: t.key, category: t.category, channel: t.channel, version: v } : null;
  }

  private render(
    n: NotifyInput,
    lang: string,
    tpl: Awaited<ReturnType<DeliveryService["template"]>>,
  ) {
    const link = n.link ? `${this.appUrl}${n.link}` : "";
    const vars = {
      title: n.title,
      body: n.body ?? "",
      secure_link: link,
      ...(n.data?.vars ?? {}),
    };
    const langs = tpl?.version.languages;
    const b =
      langs?.[lang as "en"] ?? langs?.en ?? langs?.rw ?? langs?.fr ?? null;
    const subject = b?.subject ? renderTemplate(b.subject, vars) : n.title;
    const text = b
      ? [b.header, b.body, b.footer]
          .filter(Boolean)
          .map((s) => renderTemplate(s!, vars))
          .join("\n\n")
      : [n.title, n.body, link].filter(Boolean).join("\n\n");
    // WhatsApp templates are sent by name with positional body params ({{a}} {{b}} → 1, 2) so Meta can deliver outside the 24 h window.
    const usedLang = langs?.[lang as "en"] ? lang : langs?.en ? "en" : langs?.rw ? "rw" : "fr";
    const wa = tpl && b && tpl.channel === "whatsapp" ? { name: tpl.key, lang: usedLang, params: extractVars(b.body).map((v) => (vars as Record<string, string>)[v] ?? "") } : undefined;
    return {
      subject,
      text,
      html: `<p>${esc(text).replace(/\n/g, "<br>")}</p>`,
      ...(wa && { wa }),
    };
  }

  private async suppressed(ch: ExtChannel, address: string) {
    const chans = ch === "email" ? ["email"] : ["sms", "whatsapp"]; // a STOP on one phone channel stops both
    const [r] = await this.db
      .select({ a: notificationSuppressions.address })
      .from(notificationSuppressions)
      .where(
        and(
          inArray(notificationSuppressions.channel, chans),
          eq(notificationSuppressions.address, address.toLowerCase()),
        ),
      )
      .limit(1);
    return !!r;
  }

  /** Latest ledger row wins; no row = no consent (marketing is opt-in). */
  async consented(subject: string, purpose: string) {
    const [r] = await this.db
      .select({ g: consentLedger.granted })
      .from(consentLedger)
      .where(
        and(
          eq(consentLedger.subject, subject),
          eq(consentLedger.purpose, purpose),
        ),
      )
      .orderBy(desc(consentLedger.createdAt))
      .limit(1);
    return r?.g ?? false;
  }

  /** Channel spend this month (RWF), split marketing vs all. */
  async spend() {
    const rows = await this.db
      .select({
        channel: notificationDeliveries.channel,
        spent: sql<number>`coalesce(sum(${notificationDeliveries.costRwf}), 0)::int`,
        marketing: sql<number>`coalesce(sum(${notificationDeliveries.costRwf}) filter (where ${notificationDeliveries.kind} like 'mkt.%'), 0)::int`,
      })
      .from(notificationDeliveries)
      .where(gte(notificationDeliveries.createdAt, monthStart()))
      .groupBy(notificationDeliveries.channel);
    return new Map(rows.map((r) => [r.channel, r]));
  }

  private async overBudget(
    ch: ExtChannel,
    category: "utility" | "marketing" | "authentication",
  ) {
    const b = (await systemDocs<BudgetVM>(this.db, "budgets")).find(
      (x) => x.channel === ch,
    );
    if (!b) return false;
    const s = (await this.spend()).get(ch);
    return (
      capDecision(
        {
          budget: b.budget,
          spent:
            category === "marketing" ? (s?.marketing ?? 0) : (s?.spent ?? 0),
        },
        category,
      ) === "capped"
    );
  }

  /** `notifications.send` job body. Throws to let BullMQ retry; the last failed attempt falls through the chain. */
  async send(
    id: string,
    job: { attemptsMade: number; opts: { attempts?: number } },
  ) {
    const [d] = await this.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, id));
    if (!d || !["queued", "deferred"].includes(d.status) || !d.payload) return;
    const [u] = await this.db
      .select({ email: users.email, phone: users.phoneE164 })
      .from(users)
      .where(eq(users.userId, d.userId ?? ""));
    const address = d.channel === "email" ? u?.email : u?.phone;
    const now = () => new Date().toISOString();
    try {
      if (!address) throw new Error("no_address");
      if (await this.suppressed(d.channel as ExtChannel, address)) {
        await this.db
          .update(notificationDeliveries)
          .set({ status: "suppressed", updatedAt: now() })
          .where(eq(notificationDeliveries.id, id));
        return;
      }
      const p = d.payload;
      const providerId =
        d.channel === "email"
          ? await this.mail.send({
              to: address,
              subject: p.subject,
              text: p.text,
              html: p.html ?? `<p>${esc(p.text)}</p>`,
              tags: { kind: d.kind.replace(/[^\w-]/g, "_"), delivery: id },
              // F-NTF-03: one-click route to channel preferences (security mail can't be muted, so it carries none).
              ...(categoryOf(d.kind) === "security" ? {} : { headers: { "List-Unsubscribe": `<${this.appUrl}/${d.lang}/settings/notifications>` } }),
            })
          : d.channel === "whatsapp" && this.wa.configured
            ? await this.wa.send({ to: address, text: p.text, template: p.wa })
            : await this.sms.send({ to: address, text: p.text }); // WhatsApp without Cloud API keys relays through SMS
      // F-NTF-05: GSM-7 vs UCS-2 segmenting (Kinyarwanda/French accents switch encoding) drives SMS cost.
      const segments = d.channel === "sms" || (d.channel === "whatsapp" && !this.wa.configured) ? Math.max(1, smsSegments(p.text).segments) : 1;
      await this.db
        .update(notificationDeliveries)
        .set({
          status: "sent",
          provider: d.channel === "email" ? "resend" : d.channel === "whatsapp" && this.wa.configured ? "whatsapp_cloud" : "africastalking",
          providerId: providerId ?? null,
          attempts: d.attempts + 1,
          sentAt: now(),
          updatedAt: now(),
          lastError: null,
          costRwf: UNIT_COST_RWF[d.channel as ExtChannel] * segments,
        })
        .where(eq(notificationDeliveries.id, id));
    } catch (e) {
      const final =
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1) ||
        String(e).includes("no_address");
      await this.db
        .update(notificationDeliveries)
        .set({
          status: final ? "failed" : d.status,
          attempts: d.attempts + 1,
          lastError: String(e).slice(0, 512),
          updatedAt: now(),
        })
        .where(eq(notificationDeliveries.id, id));
      if (!final) throw e;
      this.log.error({
        event: "notification.channel_failed",
        kind: d.kind,
        channel: d.channel,
        err: String(e),
      });
      await this.fallThrough(d);
    }
  }

  private async fallThrough(d: Delivery) {
    const rest = (d.chain ?? []) as ExtChannel[];
    if (!rest.length || !d.userId || !d.payload) return;
    const [u] = await this.db
      .select({ email: users.email, phone: users.phoneE164 })
      .from(users)
      .where(eq(users.userId, d.userId));
    const n: NotifyInput = {
      userId: d.userId,
      kind: d.kind,
      title: d.payload.subject,
      body: d.payload.text,
    };
    await this.start(
      n,
      {
        userId: d.userId,
        email: u?.email ?? null,
        phone: u?.phone ?? null,
        lang: d.lang,
      },
      rest[0],
      rest.slice(1),
      d.notificationId ?? "",
      null,
      d.id,
    );
  }

  /** Provider status callback. Hard bounce / complaint also suppress the address. */
  async providerStatus(
    providerId: string,
    status: "delivered" | "read" | "failed" | "bounced" | "complained",
    reason?: string,
  ) {
    const [d] = await this.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.providerId, providerId))
      .limit(1);
    if (!d) return { matched: false };
    const now = new Date().toISOString();
    const next =
      status === "bounced" || status === "complained" ? "failed" : status;
    await this.db
      .update(notificationDeliveries)
      .set({
        status: next,
        updatedAt: now,
        ...(next === "delivered" || next === "read"
          ? { deliveredAt: d.deliveredAt ?? now }
          : { lastError: (reason ?? status).slice(0, 512) }),
      })
      .where(
        and(
          eq(notificationDeliveries.id, d.id),
          notInArray(
            notificationDeliveries.status,
            next === "delivered" ? ["read"] : [],
          ),
        ),
      );
    if ((status === "bounced" || status === "complained") && d.userId) {
      const [u] = await this.db
        .select({ email: users.email, phone: users.phoneE164 })
        .from(users)
        .where(eq(users.userId, d.userId));
      const address = d.channel === "email" ? u?.email : u?.phone;
      if (address)
        await this.suppress(
          d.channel,
          address,
          status === "bounced" ? "bounce" : "complaint",
          d.provider ?? undefined,
        );
    }
    if (next === "failed") await this.fallThrough(d);
    return { matched: true };
  }

  suppress(channel: string, address: string, reason: string, source?: string) {
    return this.db
      .insert(notificationSuppressions)
      .values({
        channel,
        address: address.toLowerCase(),
        reason,
        source: source ?? null,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing();
  }

  /** Inbound SMS / WhatsApp: STOP / HAGARIKA suppresses the number and records consent withdrawal; START undoes it. */
  async inbound(from: string, text: string, ip?: string) {
    const phone = from.trim();
    const stop = isStopKeyword(text),
      start = !stop && isStartKeyword(text);
    const [u] = await this.db
      .select({ id: users.userId, role: users.role })
      .from(users)
      .where(eq(users.phoneE164, phone))
      .limit(1);
    if (!stop && !start) return this.thread(u, phone, text);
    if (stop)
      for (const ch of ["sms", "whatsapp"])
        await this.suppress(ch, phone, "stop", "inbound");
    else
      await this.db
        .delete(notificationSuppressions)
        .where(
          and(
            eq(notificationSuppressions.address, phone),
            eq(notificationSuppressions.reason, "stop"),
          ),
        );
    for (const purpose of ["marketing_sms", "marketing_whatsapp"])
      await this.recordConsent({
        userId: u?.id ?? null,
        subject: u?.id ?? phone,
        purpose,
        granted: start,
        source: stop ? "stop_keyword" : "start_keyword",
        ip,
      });
    return { action: stop ? ("stopped" as const) : ("started" as const) };
  }

  /** F-NTF-13 / F-MSG-12: any other inbound SMS/WhatsApp from a known client threads into their open support ticket
   *  (or opens one), so the support queue answers it like a web enquiry. Unknown numbers are only logged. */
  private async thread(u: { id: string; role: string } | undefined, phone: string, text: string) {
    if (!u) {
      this.log.log({ event: "notify.inbound_unknown", from: maskTo(phone) });
      return { action: "none" as const };
    }
    const s: SessionUser = { id: u.id, roles: normalizeRoles({ role: u.role }), scopes: {}, sid: "" };
    const body = text.trim().slice(0, 4000);
    return this.tx.runAsSystem(async (db) => {
      const [open] = await db.select({ ref: supportTickets.ref }).from(supportTickets)
        .where(and(eq(supportTickets.userId, u.id), ne(supportTickets.status, "resolved"))).orderBy(desc(supportTickets.updatedAt)).limit(1);
      if (open) await addTicketMessage(db, s, open.ref, body);
      else await createTicket(db, s, `Message from ${maskTo(phone)}`, body, { type: "inbound_sms", contact: phone });
      return { action: "threaded" as const };
    });
  }

  recordConsent(c: {
    userId: string | null;
    subject: string;
    purpose: string;
    granted: boolean;
    source: string;
    ip?: string;
    userAgent?: string;
    policyVersion?: string;
  }) {
    return this.db.insert(consentLedger).values({
      id: `cns_${randomUUID()}`,
      userId: c.userId,
      subject: c.subject.slice(0, 255),
      purpose: c.purpose,
      granted: c.granted,
      source: c.source,
      policyVersion: c.policyVersion ?? POLICY_VERSION,
      ip: c.ip ?? null,
      userAgent: c.userAgent?.slice(0, 255) ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  /** Console list (newest first). */
  list(q: { status?: string; channel?: string; limit?: number }) {
    return this.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          q.status ? eq(notificationDeliveries.status, q.status) : undefined,
          q.channel ? eq(notificationDeliveries.channel, q.channel) : undefined,
        ),
      )
      .orderBy(desc(notificationDeliveries.createdAt))
      .limit(Math.min(q.limit ?? 200, 500));
  }
}

