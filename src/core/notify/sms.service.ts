import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env";

export const maskTo = (s: string) =>
  s.length > 4 ? `${"*".repeat(s.length - 3)}${s.slice(-3)}` : "***";

export type Sms = { to: string; text: string };
export interface SmsDriver {
  send(m: Sms): Promise<void>;
}

/** Africa's Talking (Rwanda: MTN + Airtel). SMS_PROVIDER=africastalking + AT_USERNAME + AT_API_KEY [+ AT_SENDER_ID]. */
const africasTalking = (
  username: string,
  apiKey: string,
  from?: string,
): SmsDriver => ({
  async send(m) {
    const host =
      username === "sandbox"
        ? "api.sandbox.africastalking.com"
        : "api.africastalking.com";
    const body = new URLSearchParams({
      username,
      to: m.to,
      message: m.text,
      ...(from && { from }),
    });
    const r = await fetch(`https://${host}/version1/messaging`, {
      method: "POST",
      headers: {
        apiKey,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => null)) as {
      SMSMessageData?: { Recipients?: { status?: string }[] };
    } | null;
    const status = j?.SMSMessageData?.Recipients?.[0]?.status;
    // Throwing lets the queue retry (with backoff) and dead-letter on persistent failure.
    if (!r.ok || status !== "Success")
      throw new Error(
        `sms: africastalking ${r.status} ${status ?? "no recipient status"}`,
      );
  },
});

@Injectable()
export class SmsService {
  private readonly log = new Logger("sms");
  private readonly driver: SmsDriver;
  constructor(c: ConfigService<Env, true>) {
    const provider = c.get("SMS_PROVIDER", { infer: true });
    const user = c.get("AT_USERNAME", { infer: true }),
      key = c.get("AT_API_KEY", { infer: true });
    if (provider === "africastalking" && user && key) {
      this.driver = africasTalking(
        user,
        key,
        c.get("AT_SENDER_ID", { infer: true }),
      );
      return;
    }
    if (provider)
      this.log.warn(
        `SMS_PROVIDER=${provider} is missing its credentials; SMS is off`,
      );
    const prod = c.get("NODE_ENV", { infer: true }) === "production";
    // Never log the text: it carries OTPs.
    this.driver = {
      send: async (m) => {
        if (prod) throw new Error("sms: no SMS driver configured");
        this.log.log({
          event: "sms.dev",
          to: maskTo(m.to),
          chars: m.text.length,
        });
      },
    };
  }
  send(m: Sms) {
    return this.driver.send(m);
  }
}
