// WhatsApp Business Cloud API (F-NTF-04). Dormant until WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set; then the
// delivery job sends WhatsApp through it instead of relaying via SMS.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env";

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

  /** Free-form text (allowed inside the 24 h customer-service window). Resolves to the WhatsApp message id. */
  // shortcut: outside the 24 h window Meta requires an approved template message; the send fails and the fallback chain moves to SMS. Send `type: "template"` once templates sync with Meta.
  async send(m: { to: string; text: string }): Promise<string | undefined> {
    if (!this.configured) throw new Error("whatsapp: not configured");
    const r = await fetch(`https://graph.facebook.com/v21.0/${this.phoneId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: m.to.replace(/^\+/, ""), type: "text", text: { body: m.text.slice(0, 4096) } }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => null)) as { messages?: { id: string }[]; error?: { message?: string } } | null;
    if (!r.ok || !j?.messages?.[0]) throw new Error(`whatsapp: ${r.status} ${j?.error?.message ?? "no message id"}`);
    return j.messages[0].id;
  }
}
