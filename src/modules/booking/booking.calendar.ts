// F-BKG-10 adviser calendar sync (Google Calendar / Microsoft Graph). OAuth code flow → encrypted refresh token;
// confirmed bookings are pushed as events. Each provider is dormant until its client id + secret are set.
import { Controller, Get, Inject, Param, Query, Res } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { bkgAdvisers, bkgCalendarLinks } from "@/db/schema/schema-booking";
import { CurrentUser } from "../../core/auth/decorators";
import type { Env } from "../../core/config/env";
import { CryptoService } from "../../core/crypto/crypto.service";
import { DB, type Db } from "../../core/db/db";
import { RawResponse } from "../../core/http/envelope.interceptor";
import type { SessionUser } from "../../core/http/context";
import { AppError } from "../../core/http/errors";
import { Route } from "../../core/http/route";
import { ADVISER } from "./booking.dto";

type Provider = "google" | "microsoft";
const P = {
  google: { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/calendar.events", extra: "&access_type=offline&prompt=consent" },
  microsoft: { auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", scope: "offline_access Calendars.ReadWrite", extra: "" },
} as const;
const isProvider = (p: string): p is Provider => p === "google" || p === "microsoft";

@Injectable()
export class CalendarSync {
  constructor(@Inject(DB) private readonly db: Db, private readonly crypto: CryptoService, private readonly cfg: ConfigService<Env, true>) {}

  creds(p: Provider) {
    const id = this.cfg.get(p === "google" ? "GOOGLE_OAUTH_CLIENT_ID" : "MS_OAUTH_CLIENT_ID", { infer: true });
    const secret = this.cfg.get(p === "google" ? "GOOGLE_OAUTH_CLIENT_SECRET" : "MS_OAUTH_CLIENT_SECRET", { infer: true });
    return id && secret ? { id, secret } : null;
  }
  redirect(p: Provider) {
    const base = (this.cfg.get("API_PUBLIC_URL", { infer: true }) || this.cfg.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim()).replace(/\/$/, "");
    return `${base}/api/calendar-sync/${p}/callback`;
  }
  private async token(p: Provider, body: Record<string, string>) {
    const c = this.creds(p)!;
    const r = await fetch(P[p].token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...body }) });
    if (!r.ok) throw new Error(`${p} token ${r.status}`);
    return (await r.json()) as { access_token: string; refresh_token?: string };
  }
  async link(p: Provider, adviserId: string, code: string) {
    const t = await this.token(p, { grant_type: "authorization_code", code, redirect_uri: this.redirect(p) });
    if (!t.refresh_token) throw new AppError(422, "validation", "The provider did not grant offline access.");
    const refreshEnc = this.crypto.encrypt(t.refresh_token);
    await this.db.insert(bkgCalendarLinks).values({ adviserId, provider: p, refreshEnc, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: [bkgCalendarLinks.adviserId, bkgCalendarLinks.provider], set: { refreshEnc } });
  }
  /** Push one booking to every linked calendar of its adviser. Throws (job retries) on provider errors. */
  async push(adviserId: string, ev: { ref: string; title: string; startsAt: string; endsAt: string; joinUrl?: string | null }) {
    for (const l of await this.db.select().from(bkgCalendarLinks).where(eq(bkgCalendarLinks.adviserId, adviserId))) {
      const p = l.provider as Provider;
      if (!this.creds(p)) continue;
      const { access_token } = await this.token(p, { grant_type: "refresh_token", refresh_token: this.crypto.decrypt(l.refreshEnc) });
      const desc = `HEBUZA ${ev.ref}${ev.joinUrl ? `\n${ev.joinUrl}` : ""}`;
      const [url, body] = p === "google"
        ? ["https://www.googleapis.com/calendar/v3/calendars/primary/events", { summary: ev.title, description: desc, start: { dateTime: ev.startsAt }, end: { dateTime: ev.endsAt }, ...(ev.joinUrl && { location: ev.joinUrl }) }]
        : ["https://graph.microsoft.com/v1.0/me/events", { subject: ev.title, body: { contentType: "text", content: desc }, start: { dateTime: ev.startsAt.slice(0, 19), timeZone: "UTC" }, end: { dateTime: ev.endsAt.slice(0, 19), timeZone: "UTC" }, ...(ev.joinUrl && { location: { displayName: ev.joinUrl } }) }];
      const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${p} event ${r.status}`);
    }
  }
}

@Controller()
export class CalendarSyncController {
  constructor(private readonly sync: CalendarSync, @Inject(DB) private readonly db: Db, private readonly crypto: CryptoService) {}

  private async adviserOf(u: SessionUser) {
    const [a] = await this.db.select({ id: bkgAdvisers.id }).from(bkgAdvisers).where(eq(bkgAdvisers.userId, u.id));
    if (!a) throw new AppError(404, "not_found", "No adviser calendar for this account.");
    return a.id;
  }
  @Get("me/calendar-sync")
  @Route({ auth: ADVISER })
  async status(@CurrentUser() u: SessionUser) {
    const id = await this.adviserOf(u);
    const links = await this.db.select({ provider: bkgCalendarLinks.provider }).from(bkgCalendarLinks).where(eq(bkgCalendarLinks.adviserId, id));
    return { providers: (["google", "microsoft"] as const).map((p) => ({ provider: p, available: !!this.sync.creds(p), linked: links.some((l) => l.provider === p) })) };
  }
  @Get("me/calendar-sync/:provider/start")
  @Route({ auth: ADVISER })
  async start(@CurrentUser() u: SessionUser, @Param("provider") p: string) {
    if (!isProvider(p) || !this.sync.creds(p)) throw new AppError(404, "not_found", "Calendar provider not configured.");
    const state = Buffer.from(this.crypto.encrypt(JSON.stringify({ a: await this.adviserOf(u), exp: Date.now() + 10 * 60_000 }))).toString("base64url");
    const c = this.sync.creds(p)!;
    return { url: `${P[p].auth}?client_id=${encodeURIComponent(c.id)}&response_type=code&redirect_uri=${encodeURIComponent(this.sync.redirect(p))}&scope=${encodeURIComponent(P[p].scope)}&state=${state}${P[p].extra}` };
  }
  /** Provider redirect target; the sealed state carries the adviser (no session cookie needed). */
  @Get("calendar-sync/:provider/callback")
  @Route({ auth: "public", limit: "auth" })
  @RawResponse()
  async callback(@Param("provider") p: string, @Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    let s: { a: string; exp: number };
    try { s = JSON.parse(this.crypto.decrypt(Buffer.from(String(state), "base64url").toString())); } catch { throw new AppError(400, "bad_request", "Invalid state."); }
    if (!isProvider(p) || !code || s.exp < Date.now()) throw new AppError(400, "bad_request", "This link expired; start again.");
    await this.sync.link(p, s.a, String(code));
    return res.redirect("/en/agent/calendar?calendar=linked", 302);
  }
}
