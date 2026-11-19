// Worker side of auth: sends the mails/SMS the service queued through the outbox, and nightly housekeeping.
import { Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Cron, Job } from "../../core/queue/queues";
import { MailService } from "../../core/notify/mail.service";
import { SmsService } from "../../core/notify/sms.service";
import { TxService } from "../../core/db/tx";
import { CryptoService } from "../../core/crypto/crypto.service";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

@Injectable()
export class AuthJobs {
  private readonly log = new Logger(AuthJobs.name);
  constructor(private readonly mail: MailService, private readonly sms: SmsService, private readonly txs: TxService, private readonly crypto: CryptoService) {}

  @Job("auth.mail")
  sendMail(sealed: { to: string; subject: string; text: string }) {
    const d = this.crypto.unseal(sealed, ["text"]);
    return this.mail.send({ to: d.to, subject: d.subject, text: d.text, html: `<p>${esc(d.text).replace(/\n/g, "<br>")}</p>`, tags: { module: "auth" } });
  }

  @Job("auth.sms")
  sendSms(d: { to: string; text: string }) {
    return this.sms.send(this.crypto.unseal(d, ["text"]));
  }

  /**
   * IAM-20: anonymise accounts whose 14-day cooling-off ended. Accounts that gained open cases meanwhile wait.
   * Finance records are kept (legal retention, invoices 10 years) but pseudonymised: the billed name becomes the
   * customer ID and contact details are dropped; company invoices (organizationId) keep the company as billed party.
   */
  @Cron("auth.deletion_sweep", "30 3 * * *")
  async deletionSweep() {
    const r = await this.txs.runAsSystem(async (tx) => {
      const gone = await tx.execute<{ id: string; no: string | null }>(sql`update users u set name = 'Deleted user',
          email = case when email is null then null else 'deleted+' || user_id || '@invalid.local' end,
          phone_e164 = null, is_email_verified = false, is_active = false, deletion_scheduled_at = null, updated_at = now()
        where deletion_scheduled_at <= now()
          and not exists (select 1 from applications a where a.client_id = u.user_id
            and a.status not in ('completed_delivered','cancelled','rejected','refunded'))
        returning user_id as id, customer_no as no`);
      for (const g of gone) {
        const alias = g.no ? `Former client ${g.no}` : "Former client";
        await tx.execute(sql`update finance_records set data = jsonb_set(data #- '{billTo,email}' #- '{billTo,address}', '{billTo,name}', to_jsonb(${alias}::text))
          where data->>'clientId' = ${g.id} and data ? 'billTo' and not (data ? 'organizationId')`);
        await tx.execute(sql`update applications set personal_info = jsonb_build_object('fullName', ${alias}::text) where client_id = ${g.id}`);
      }
      return gone.length;
    });
    this.log.log(`auth.deletion_sweep anonymised=${r}`);
    return { anonymised: r };
  }

  /** Expired/revoked refresh tokens, used/expired reset links, dead sessions, stale devices, old login_attempts. */
  @Cron("auth.cleanup", "15 3 * * *")
  async cleanup() {
    const r = await this.txs.runAsSystem(async (tx) => {
      const n = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).count ?? 0;
      return {
        refresh: await n(sql`delete from refresh_tokens where expires_at < now() - interval '1 day' or revoked_at < now() - interval '7 days'`),
        resets: await n(sql`delete from password_reset_tokens where expires_at < now() - interval '7 days' or used_at < now() - interval '7 days'`),
        sessions: await n(sql`delete from auth_sessions s where (s.revoked_at < now() - interval '30 days') or not exists (select 1 from refresh_tokens r where r.family_id = s.id)`),
        devices: await n(sql`delete from auth_trusted_devices where trusted_until < now()`),
        impersonations: await n(sql`update auth_impersonations set ended_at = until, ended_by = 'expiry' where ended_at is null and until < now()`),
        attempts: await n(sql`delete from login_attempts where attempted_at < now() - interval '90 days'`),
      };
    });
    this.log.log(`auth.cleanup ${JSON.stringify(r)}`);
    return r;
  }
}
