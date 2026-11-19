import { Global, Injectable, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import { SmsService, maskTo } from "./sms.service";
import { WhatsappService } from "./whatsapp.service";
import { PushService } from "./push.service";

export type Mail = { to: string | string[]; subject: string; html: string; text?: string; tags?: Record<string, string>; headers?: Record<string, string> };

@Injectable()
export class MailService {
  private readonly log = new Logger("mail");
  private readonly resend?: Resend;
  private readonly from: string;
  private readonly prod: boolean;
  constructor(c: ConfigService) {
    this.prod = c.get<string>("NODE_ENV") === "production";
    const key = c.get<string>("RESEND_API_KEY");
    if (key) this.resend = new Resend(key);
    this.from = c.getOrThrow<string>("MAIL_FROM");
  }

  /** Resolves to the provider message id (undefined in dev without a key). */
  async send(m: Mail): Promise<string | undefined> {
    if (!this.resend) {
      if (this.prod) throw new Error("mail: RESEND_API_KEY not configured");
      // Never log bodies: they carry OTPs and links.
      this.log.log({ event: "mail.dev", to: [m.to].flat().map(maskTo), subject: m.subject });
      return;
    }
    const { data, error } = await this.resend.emails.send({
      from: this.from, to: m.to, subject: m.subject, html: m.html, text: m.text, headers: m.headers,
      tags: m.tags && Object.entries(m.tags).map(([name, value]) => ({ name, value })),
    });
    if (error) throw new Error(`resend: ${error.message}`); // throw so the queue retries
    return data?.id;
  }
}

@Global()
@Module({ providers: [MailService, SmsService, WhatsappService, PushService], exports: [MailService, SmsService, WhatsappService, PushService] })
export class NotifyModule {}
