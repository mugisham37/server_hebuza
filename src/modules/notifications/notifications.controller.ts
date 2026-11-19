import { Body, Controller, Delete, Get, Headers, Ip, Param, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import { verifyHubSignature, verifySvix } from "@/domain/notify/svix";
import type { FastifyReply } from "fastify";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { safeEqual } from "../../core/crypto/crypto.service";
import { AppError } from "../../core/http/errors";
import { Webhook } from "../../core/auth/decorators";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import {
  AtInboundDto, AtStatusDto, ConsentDto, ConsentOut, ListOut, ListQueryDto, PrefsDto, PrefsOut, ReadDto, ReadOut, ResendEventDto, WaEventDto, WebhookOut, ManualDto, ManualOut, PushKeyOut, PushSubDto,
} from "./notifications.dto";
import { DeliveryService } from "./notifications.delivery";
import { TxService } from "../../core/db/tx";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { validPushEndpoint } from "@/domain/notify/delivery";
import { PushService } from "../../core/notify/push.service";
import { pushSubscriptions, users } from "@/db/schema";
import { NotificationsService } from "./notifications.service";

@Controller()
export class NotificationsController {
  constructor(
    private readonly svc: NotificationsService,
    private readonly delivery: DeliveryService,
    private readonly cfg: ConfigService<Env, true>,
    private readonly tx: TxService,
    private readonly push: PushService,
  ) {}

  /** Webhook URLs carry NOTIFY_WEBHOOK_TOKEN; unset or wrong → 404 so the endpoints are invisible. */
  private gate(token: string) {
    const want = [this.cfg.get("NOTIFY_WEBHOOK_TOKEN", { infer: true }), this.cfg.get("NOTIFY_WEBHOOK_TOKEN_PREVIOUS", { infer: true })].filter((x): x is string => !!x);
    if (!want.some((w) => safeEqual(token, w))) throw new AppError(404, "not_found", "Not found."); // previous token accepted during rotation
  }

  /** URL token + (when RESEND_WEBHOOK_SECRET is set) the svix signature over the raw body kept by main.ts for this route. */
  @Post("webhooks/notify/:token/resend")
  @Webhook()
  @Route({ auth: "public", out: WebhookOut })
  async resend(@Param("token") token: string, @Body() b: ResendEventDto, @Req() req: { rawBody?: Buffer; headers: Record<string, string | string[] | undefined> }) {
    this.gate(token);
    const secret = this.cfg.get("RESEND_WEBHOOK_SECRET", { infer: true });
    const h = (k: string) => { const v = req.headers[k]; return typeof v === "string" ? v : undefined; };
    if (secret && !verifySvix(secret, { id: h("svix-id"), timestamp: h("svix-timestamp"), signature: h("svix-signature") }, req.rawBody ?? ""))
      throw new AppError(401, "bad_signature", "Bad signature.");
    const map = { "email.delivered": "delivered", "email.opened": "read", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed" } as const;
    const st = map[b.type as keyof typeof map];
    if (st) await this.delivery.providerStatus(b.data.email_id, st, b.type);
    return { ok: true };
  }

  @Post("webhooks/notify/:token/africastalking/status")
  @Webhook()
  @Route({ auth: "public", out: WebhookOut })
  async atStatus(@Param("token") token: string, @Body() b: AtStatusDto) {
    this.gate(token);
    if (b.status === "Success") await this.delivery.providerStatus(b.id, "delivered");
    else if (b.status === "Failed" || b.status === "Rejected") await this.delivery.providerStatus(b.id, "failed", b.failureReason ?? b.status);
    return { ok: true };
  }

  /** Meta subscription handshake. */
  @Get("webhooks/notify/:token/whatsapp")
  @Route({ auth: "public" })
  @RawResponse()
  waVerify(@Param("token") token: string, @Query() q: Record<string, string>, @Res() reply: FastifyReply) {
    this.gate(token);
    const want = this.cfg.get("WHATSAPP_VERIFY_TOKEN", { infer: true });
    if (q["hub.mode"] !== "subscribe" || !want || !safeEqual(q["hub.verify_token"] ?? "", want)) throw new AppError(403, "forbidden", "Forbidden");
    return reply.type("text/plain").send(q["hub.challenge"] ?? "");
  }

  /** WhatsApp Cloud API: message statuses (sent/delivered/read/failed) and inbound replies (STOP/HAGARIKA). */
  @Post("webhooks/notify/:token/whatsapp")
  @Webhook()
  @Route({ auth: "public", out: WebhookOut })
  async wa(@Param("token") token: string, @Body() b: WaEventDto, @Req() req: { rawBody?: Buffer; headers: Record<string, string | string[] | undefined> }, @Ip() ip: string) {
    this.gate(token);
    const secret = this.cfg.get("WHATSAPP_APP_SECRET", { infer: true });
    const sig = req.headers["x-hub-signature-256"];
    if (secret && !verifyHubSignature(secret, typeof sig === "string" ? sig : "", req.rawBody ?? ""))
      throw new AppError(401, "bad_signature", "Bad signature.");
    for (const e of b.entry ?? [])
      for (const ch of e.changes ?? []) {
        for (const st of ch.value?.statuses ?? [])
          if (st.status === "delivered" || st.status === "read" || st.status === "failed")
            await this.delivery.providerStatus(st.id, st.status, st.errors?.[0]?.title);
        for (const m of ch.value?.messages ?? [])
          if (m.text?.body) await this.delivery.inbound(`+${m.from.replace(/^\+/, "")}`, m.text.body, ip);
      }
    return { ok: true };
  }

  /** Inbound SMS (Africa's Talking incoming-message callback): STOP / HAGARIKA opt-out, START opt-in. */
  @Post("webhooks/notify/:token/africastalking/inbound")
  @Webhook()
  @Route({ auth: "public", out: WebhookOut })
  async atInbound(@Param("token") token: string, @Body() b: AtInboundDto, @Ip() ip: string) {
    this.gate(token);
    await this.delivery.inbound(b.from, b.text, ip);
    return { ok: true };
  }

  /** F-NTF-17: manual message to one client from the client profile (service managers). */
  @Post("staff/clients/:id/notify")
  @Route({ auth: ["staff:service_manager", "staff:executive"], limit: "write", audit: "notifications.manual_sent", out: ManualOut })
  async manual(@Param("id") id: string, @Body() b: ManualDto, @CurrentUser() me: SessionUser) {
    await this.tx.run(async (tx) => {
      const [u] = await tx.select({ role: users.role }).from(users).where(eq(users.userId, id));
      if (!u || u.role !== "client") throw new AppError(404, "not_found", "Client not found.");
      await this.svc.notify(tx, { userId: id, kind: "manual.message", title: b.title, body: b.body, link: b.link ?? "/notifications", channels: b.channels, data: { type: "manual.message", vars: { ref: `${me.id}:${Date.now()}` } } });
    });
    return { queued: true };
  }

  /** F-NTF-18: VAPID public key for PushManager.subscribe (null = push not configured). */
  @Get("push/vapid-key")
  @Route({ auth: "public", out: PushKeyOut })
  vapidKey() {
    return { publicKey: this.push.publicKey ?? null };
  }
  @Post("me/push-subscriptions")
  @Route({ auth: "user", limit: "write", out: WebhookOut })
  async subscribePush(@Body() b: PushSubDto, @CurrentUser() me: SessionUser) {
    if (!validPushEndpoint(b.endpoint)) throw new AppError(422, "validation", "Unsupported push service.");
    await this.tx.run((tx) => tx.insert(pushSubscriptions).values({ id: `psh_${randomUUID()}`, userId: me.id, endpoint: b.endpoint, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: me.id } }));
    return { ok: true };
  }
  @Delete("me/push-subscriptions")
  @Route({ auth: "user", limit: "write", out: WebhookOut })
  async unsubscribePush(@Body() b: PushSubDto, @CurrentUser() me: SessionUser) {
    await this.tx.run((tx) => tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, b.endpoint), eq(pushSubscriptions.userId, me.id))));
    return { ok: true };
  }

  /** Cookie banner + marketing toggles: one ledger row per purpose (F-CMS-15, F-NTF-09). */
  @Post("consent")
  @Route({ auth: "public", limit: "write", out: ConsentOut })
  async consent(@Body() b: ConsentDto, @CurrentUser() me: SessionUser | null, @Ip() ip: string, @Headers("user-agent") ua?: string) {
    const subject = me?.id ?? b.anon_id;
    if (!subject) throw new AppError(422, "validation", "anon_id required when signed out.");
    const rows = Object.entries(b.purposes);
    for (const [purpose, granted] of rows)
      await this.delivery.recordConsent({ userId: me?.id ?? null, subject, purpose, granted, source: b.source, ip, userAgent: ua, policyVersion: b.policy_version });
    return { recorded: rows.length };
  }

  @Get("notifications")
  @Route({ auth: "user", permission: "ntf.own", out: ListOut })
  list(@Query() q: ListQueryDto, @CurrentUser() me: SessionUser) {
    return this.svc.list(me.id, { limit: q.limit, unread: q.unread === "true" });
  }

  @Post("notifications/read")
  @Route({ auth: "user", permission: "ntf.own", out: ReadOut })
  read(@Body() b: ReadDto, @CurrentUser() me: SessionUser) {
    return this.svc.markRead(me.id, b.ids);
  }

  @Get(["me/notification-preferences", "notifications/preferences"]) // second path = Python alias
  @Route({ auth: "user", permission: "ntf.own", out: PrefsOut })
  prefs(@CurrentUser() me: SessionUser) {
    return this.svc.preferences(me.id);
  }

  @Put("me/notification-preferences")
  @Route({ auth: "user", permission: "ntf.own", out: PrefsOut, audit: "notifications.preferences.updated" })
  putPrefs(@Body() b: PrefsDto, @CurrentUser() me: SessionUser) {
    return this.svc.updatePreferences(me.id, b);
  }

  @Patch("notifications/preferences") // Python alias
  @Route({ auth: "user", permission: "ntf.own", out: PrefsOut, audit: "notifications.preferences.updated" })
  patchPrefs(@Body() b: PrefsDto, @CurrentUser() me: SessionUser) {
    return this.svc.updatePreferences(me.id, b);
  }
}
