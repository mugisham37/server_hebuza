import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { eq, sql } from "drizzle-orm";
import { pushSubscriptions, users } from "@/db/schema";
import { categoryOf, quietUntil } from "@/domain/notify/delivery";
import { PushService } from "../../core/notify/push.service";
import type { Env } from "../../core/config/env";
import { DB, type Db } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { MailService } from "../../core/notify/mail.service";
import { Cron, Job } from "../../core/queue/queues";
import { RealtimeService } from "../realtime/realtime.service";
import { DeliveryService } from "./notifications.delivery";
import { DIGEST_WINDOW_S, NotificationsService, project, type NotifyInput } from "./notifications.service";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

@Injectable()
export class NotificationsJobs {
  private readonly log = new Logger("notifications");
  constructor(
    private readonly svc: NotificationsService,
    private readonly tx: TxService,
    @Inject(DB) private readonly db: Db,
    private readonly mail: MailService,
    private readonly delivery: DeliveryService,
    private readonly push: PushService,
    private readonly rt: RealtimeService,
    private readonly cfg: ConfigService<Env, true>,
  ) {}

  private get appUrl() {
    return this.cfg.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim();
  }

  @Job("notifications.deliver")
  async deliver(n: NotifyInput, job: { id?: string }) {
    // Row id derives from the job id (ob_<outbox id>), so retries re-use the in-app row (insert … on conflict do nothing).
    const { row, prefs } = await this.tx.runAsSystem(async (tx) => ({ row: await this.svc.insert(tx, n, job.id ? `ntf_${job.id}` : undefined), prefs: await this.svc.prefsOf(tx, n.userId) }));
    await this.rt.emit(n.userId, "notification", { notification: project(row) }).catch((e: unknown) => this.log.warn({ event: "notification.rt_failed", err: String(e) }));
    // F-NTF-18: wake the user's browsers (payload-less) unless they're in quiet hours (security always rings).
    if (this.push.configured && (categoryOf(n.kind) === "security" || !quietUntil(new Date(), prefs.quiet))) {
      const subs = await this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, n.userId));
      for (const s of subs)
        if ((await this.push.ping(s.endpoint, categoryOf(n.kind) === "security" ? "high" : "normal")) === "gone")
          await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
    }
    // A retried job must not plan the external sends twice: one dispatch per in-app row.
    if (await this.delivery.dispatched(row.id)) return;
    await this.delivery.dispatch(n, prefs, row.id);
  }

  /** One external send (F-NTF-11); retried with the default exponential backoff, then falls through the chain. */
  @Job("notifications.send")
  send(d: { id: string }, job: { attemptsMade: number; opts: { attempts?: number } }) {
    return this.delivery.send(d.id, job);
  }

  /** Hourly; safe to run twice: last_digest_at gates repeats. */
  @Cron("notifications.digest", "5 * * * *")
  async digest() {
    const now = new Date();
    const cands = await this.tx.runAsSystem((tx) => this.svc.digestCandidates(tx, now));
    for (const c of cands) {
      const p = await this.tx.runAsSystem((tx) => this.svc.prefsOf(tx, c.userId));
      if (!p.email_enabled || !p.digest_enabled) continue;
      if (p.lastDigestAt && now.getTime() - Date.parse(p.lastDigestAt) < DIGEST_WINDOW_S * 1000) continue;
      const [u] = await this.db.select({ email: users.email, active: users.isActive }).from(users).where(eq(users.userId, c.userId));
      if (!u?.email || !u.active) continue;
      const text = `You have ${c.n} unread updates:\n\n${c.titles.map((t) => `• ${t}`).join("\n")}\n\n${this.appUrl}/notifications`;
      try {
        await this.mail.send({ to: u.email, subject: "You have new updates on Hebuza", text, html: `<p>${esc(text).replace(/\n/g, "<br>")}</p>` });
      } catch (e) {
        this.log.error({ event: "notification.digest_failed", err: String(e) });
        continue;
      }
      await this.tx.runAsSystem((tx) => this.svc.markDigested(tx, c.userId, now.toISOString()));
    }
  }

  /** F-NTF-14: 06:00 Kigali daily digest for staff — unread items from the last 24 h, one email per person. */
  @Cron("notifications.staff_digest", "0 4 * * *")
  async staffDigest() {
    const rows = (await this.db.execute(sql`select n.user_id as id, u.email, count(*)::int as n, (array_agg(n.title order by n.created_at desc))[1:10] as titles
      from notifications n join users u on u.user_id = n.user_id
      where n.read_at is null and n.created_at > now() - interval '24 hours' and u.is_active and u.role like 'staff:%' and u.email is not null
      group by n.user_id, u.email`)) as unknown as { id: string; email: string; n: number; titles: string[] }[]; // cast: execute() rows are untyped
    for (const r of rows) {
      const p = await this.tx.runAsSystem((tx) => this.svc.prefsOf(tx, r.id));
      if (!p.email_enabled || !p.digest_enabled) continue;
      const text = `${r.n} unread in the last 24 hours:\n\n${r.titles.map((t) => `• ${t}`).join("\n")}\n\n${this.appUrl}/notifications`;
      await this.mail.send({ to: r.email, subject: `HEBUZA daily summary: ${r.n} unread`, text, html: `<p>${esc(text).replace(/\n/g, "<br>")}</p>` })
        .catch((e: unknown) => this.log.error({ event: "notification.staff_digest_failed", err: String(e) }));
    }
    return rows.length;
  }
}
