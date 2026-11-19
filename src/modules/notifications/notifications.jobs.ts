import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
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
}
