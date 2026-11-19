import { Body, Controller, Get, Headers, Ip, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { verifySvix } from "@/domain/notify/svix";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { safeEqual } from "../../core/crypto/crypto.service";
import { AppError } from "../../core/http/errors";
import { Webhook } from "../../core/auth/decorators";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import {
  AtInboundDto, AtStatusDto, ConsentDto, ConsentOut, ListOut, ListQueryDto, PrefsDto, PrefsOut, ReadDto, ReadOut, ResendEventDto, WebhookOut,
} from "./notifications.dto";
import { DeliveryService } from "./notifications.delivery";
import { NotificationsService } from "./notifications.service";

@Controller()
export class NotificationsController {
  constructor(
    private readonly svc: NotificationsService,
    private readonly delivery: DeliveryService,
    private readonly cfg: ConfigService<Env, true>,
  ) {}

  /** Webhook URLs carry NOTIFY_WEBHOOK_TOKEN; unset or wrong → 404 so the endpoints are invisible. */
  private gate(token: string) {
    const want = this.cfg.get("NOTIFY_WEBHOOK_TOKEN", { infer: true });
    if (!want || !safeEqual(token, want)) throw new AppError(404, "not_found", "Not found.");
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

  /** Inbound SMS (Africa's Talking incoming-message callback): STOP / HAGARIKA opt-out, START opt-in. */
  @Post("webhooks/notify/:token/africastalking/inbound")
  @Webhook()
  @Route({ auth: "public", out: WebhookOut })
  async atInbound(@Param("token") token: string, @Body() b: AtInboundDto, @Ip() ip: string) {
    this.gate(token);
    await this.delivery.inbound(b.from, b.text, ip);
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
