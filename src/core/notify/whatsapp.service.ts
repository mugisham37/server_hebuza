// WhatsApp Business Cloud API (F-NTF-04). Dormant until WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set; then the
// delivery job sends WhatsApp through it instead of relaying via SMS.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env";

/** Meta language codes for our locales. PLACEHOLDER(wa-rw-code) Kinyarwanda is "rw_RW" in Meta's list; verify per template. */
const WA_LANG: Record<string, string> = { en: "en", fr: "fr", rw: "rw_RW" };

@Injectable()
export class WhatsappService {
  private readonly token?: string;
  private readonly phoneId?: string;
  constructor(c: ConfigService<Env, true>) {
    this.token = c.get("WHATSAPP_ACCESS_TOKEN", { infer: true });
    this.phoneId = c.get("WHATSAPP_PHONE_NUMBER_ID", { infer: true });
  }
  get configured() {
    return !!(this.token && this.phoneId);
  }

  /** Approved template (works any time) when given, else free-form text (only inside the 24 h customer-service window;
   *  outside it Meta rejects and the fallback chain moves on). Resolves to the WhatsApp message id. */
  async send(m: { to: string; text: string; template?: { name: string; lang: string; params: string[] } }): Promise<string | undefined> {
    if (!this.configured) throw new Error("whatsapp: not configured");
    const r = await fetch(`https://graph.facebook.com/v21.0/${this.phoneId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: m.to.replace(/^\+/, ""),
        ...(m.template
          ? { type: "template", template: { name: m.template.name, language: { code: WA_LANG[m.template.lang] ?? "en" },
              components: m.template.params.length ? [{ type: "body", parameters: m.template.params.map((text) => ({ type: "text", text })) }] : [] } }
          : { type: "text", text: { body: m.text.slice(0, 4096) } }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => null)) as { messages?: { id: string }[]; error?: { message?: string } } | null;
    if (!r.ok || !j?.messages?.[0]) throw new Error(`whatsapp: ${r.status} ${j?.error?.message ?? "no message id"}`);
    return j.messages[0].id;
  }
}
