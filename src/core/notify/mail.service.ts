import { Global, Injectable, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import { SmsService, maskTo } from "./sms.service";

export type Mail = { to: string | string[]; subject: string; html: string; text?: string; tags?: Record<string, string> };

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

  async send(m: Mail): Promise<void> {
    if (!this.resend) {
      if (this.prod) throw new Error("mail: RESEND_API_KEY not configured");
      // Never log bodies: they carry OTPs and links.
      this.log.log({ event: "mail.dev", to: [m.to].flat().map(maskTo), subject: m.subject });
      return;
    }
    const { error } = await this.resend.emails.send({
      from: this.from, to: m.to, subject: m.subject, html: m.html, text: m.text,
      tags: m.tags && Object.entries(m.tags).map(([name, value]) => ({ name, value })),
    });
    if (error) throw new Error(`resend: ${error.message}`); // throw so the queue retries
  }
}

@Global()
@Module({ providers: [MailService, SmsService], exports: [MailService, SmsService] })
export class NotifyModule {}
