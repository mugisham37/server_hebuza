import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export const maskTo = (s: string) => (s.length > 4 ? `${"*".repeat(s.length - 3)}${s.slice(-3)}` : "***");

export type Sms = { to: string; text: string };
export interface SmsDriver { send(m: Sms): Promise<void> }

// shortcut: only the log driver exists, add a real driver keyed by SMS_PROVIDER when a provider is chosen.
@Injectable()
export class SmsService {
  private readonly log = new Logger("sms");
  private readonly driver: SmsDriver;
  constructor(c: ConfigService) {
    const provider = c.get<string>("SMS_PROVIDER");
    if (provider) this.log.warn(`SMS_PROVIDER=${provider} has no driver; logging instead`);
    const prod = c.get<string>("NODE_ENV") === "production";
    // Never log the text: it carries OTPs.
    this.driver = { send: async (m) => {
      if (prod) throw new Error("sms: no SMS driver configured");
      this.log.log({ event: "sms.dev", to: maskTo(m.to), chars: m.text.length });
    } };
  }
  send(m: Sms) {
    return this.driver.send(m);
  }
}
