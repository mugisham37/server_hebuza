// Marketing shell, insights/reports, social metrics, testimonials & feedback, referrals, content lane (media library,
// tracking, site health, landing/knowledge insights) and the public short-link resolvers (reference marketing.routes).
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import type { FastifyReply } from "fastify";
import { outbox } from "@/db/schema";
import { Route } from "../../core/http/route";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { StorageService } from "../../core/storage/storage.service";
import { Req, type OpsReq } from "../ops/ops.runner";
import * as ins from "./marketing.insights";
import * as con from "./marketing.content";
import { type Exec } from "./marketing.store";
import { MarketingRunner } from "./marketing.runner";
import * as D from "./marketing.dto";

const { MKT, MKT_EX, MKT_SM, STAFF } = D;

@Controller()
export class MarketingInsightsController {
  private readonly log = new Logger("marketing");
  private readonly web: string;
  constructor(
    private readonly m: MarketingRunner,
    private readonly storage: StorageService,
    config: ConfigService<Env, true>,
  ) {
    this.web = String(config.get("WEB_ORIGIN", { infer: true }) ?? "").split(",")[0].trim();
  }

  // ---- shell
  @Get("admin/mkt/shell")
  @Route({ auth: STAFF })
  shell(@Req() r: OpsReq) {
    return this.m.run(r, (c) => con.shell(c));
  }
  @Get("admin/mkt/notifications")
  @Route({ auth: STAFF })
  notifications() {
    return this.m.read((db) => con.notifications(db));
  }
  @Get("admin/mkt/staff")
  @Route({ auth: STAFF })
  staff() {
    return this.m.read((db) => con.staff(db));
  }

  // ---- insights
  @Get("admin/mkt/summary")
  @Route({ auth: MKT_EX, permission: "rpt.marketing" })
  summary(@Query() q: D.RangeDto) {
    return this.m.read((db) => ins.summary(db, q));
  }
  @Get("admin/crm/analytics/:tab")
  @Route({ auth: MKT_EX, permission: "rpt.marketing" })
  analytics(@Param("tab") tab: string, @Query() q: D.RangeDto) {
    return this.m.read((db) => ins.analytics(db, tab, q));
  }
  @Get("admin/reports/export")
  @Route({ auth: MKT_EX, permission: "rpt.marketing", limit: "write", audit: "report.exported" })
  exportReport(@Req() r: OpsReq, @Query() q: D.RangeDto) {
    return this.m.run(r, (c) => ins.exportReport(c, q));
  }
  @Post("admin/crm/social-metrics/import")
  @Route({ auth: MKT })
  importSocial(@Req() r: OpsReq, @Body() b: D.CsvDto) {
    return this.m.run(r, (c) => ins.importSocial(c, b.csv));
  }
  @Post("admin/crm/social-metrics/import/:id/confirm")
  @Route({ auth: MKT, idempotent: true, audit: "social.imported" })
  confirmSocial(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => ins.confirmSocial(c, id));
  }
  @Post("admin/crm/social-metrics")
  @Route({ auth: MKT })
  addSocial(@Req() r: OpsReq, @Body() b: D.SocialDto) {
    return this.m.run(r, (c) => ins.addSocial(c, b));
  }

  // ---- testimonials & feedback
  @Get("admin/fbk/testimonials")
  @Route({ auth: MKT_SM })
  testimonials(@Query() q: D.TestimonialsQueryDto) {
    return this.m.read((db) => ins.testimonials(db, q.status));
  }
  @Post("admin/fbk/testimonials/:id/:action")
  @Route({ auth: MKT, audit: "testimonial.action" })
  testimonial(@Req() r: OpsReq, @Param("id") id: string, @Param("action") action: string, @Body() b: D.TestimonialActionDto) {
    return this.m.run(r, (c) => ins.testimonialAction(c, id, action, b));
  }
  @Get("admin/fbk/analytics")
  @Route({ auth: STAFF })
  feedback(@Query() q: D.RangeDto) {
    return this.m.read((db) => ins.feedback(db, q));
  }

  // ---- referrals
  @Get("admin/crm/referrals/programme")
  @Route({ auth: MKT })
  programme() {
    return this.m.read((db) => ins.programme(db));
  }
  @Patch("admin/crm/referrals/programme")
  @Route({ auth: MKT, audit: "referral.programme_changed" })
  saveProgramme(@Req() r: OpsReq, @Body() b: D.ProgrammeDto) {
    return this.m.run(r, (c) => ins.saveProgramme(c, b));
  }
  @Get("admin/crm/referrals")
  @Route({ auth: MKT })
  referrals() {
    return this.m.read((db) => ins.referrals(db));
  }

  // ---- content lane: media, tracking, health
  @Get("admin/cms/media")
  @Route({ auth: MKT_SM })
  media() {
    return this.m.read((db) => con.media(db));
  }
  /** Step 1: JSON {filename, mime, size, alt?, credit?, licence?, replaceId?} → presigned PUT to staging. */
  @Post("admin/cms/media")
  @Route({ auth: MKT, out: D.MediaPresignOut })
  presignMedia(@Req() r: OpsReq, @Body() b: D.MediaUploadDto) {
    return this.m.run(r, (c) => con.presignMedia(c, this.storage, b));
  }
  /** Step 2: after the PUT, sniff + re-encode the staged object into the library. */
  @Post("admin/cms/media/:id/complete")
  @Route({ auth: MKT, audit: "media.uploaded" })
  completeMedia(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => con.completeMedia(c, this.storage, id));
  }
  @Patch("admin/cms/media/:id")
  @Route({ auth: MKT })
  patchMedia(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.MediaPatchDto) {
    return this.m.run(r, (c) => con.patchMedia(c, id, b));
  }
  @Delete("admin/cms/media/:id")
  @Route({ auth: MKT, audit: "media.deleted" })
  deleteMedia(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => con.deleteMedia(c, id));
  }
  @Get("media/:id")
  @Route({ auth: "public", limit: "read" })
  @RawResponse()
  async mediaFile(@Param("id") id: string, @Query() q: D.MediaQueryDto, @Res() reply: FastifyReply) {
    const to = await this.m.read((db) => con.mediaRedirect(db, this.storage, id, q.w));
    return reply.status(302).header("location", to.startsWith("/") ? `${this.web}${to}` : to).header("cache-control", "private, max-age=240").send();
  }
  @Get("admin/mkt/tracking")
  @Route({ auth: MKT })
  tracking() {
    return this.m.read((db) => con.tracking(db));
  }
  @Put("admin/mkt/tracking")
  @Route({ auth: MKT, audit: "tracking.changed" })
  saveTracking(@Req() r: OpsReq, @Body() b: D.TrackingDto) {
    return this.m.run(r, (c) => con.saveTracking(c, b));
  }
  @Get("admin/mkt/health")
  @Route({ auth: MKT })
  health() {
    return this.m.read((db) => con.health(db));
  }
  @Post("admin/mkt/health/speed")
  @Route({ auth: MKT })
  speed(@Req() r: OpsReq, @Body() b: D.SpeedDto) {
    return this.m.run(r, (c) => con.runSpeed(c, b.page, this.web));
  }
  @Get("admin/mkt/landing/:id/performance")
  @Route({ auth: MKT_SM })
  landing(@Param("id") id: string, @Query() q: D.RangeStrDto) {
    return this.m.read((db) => con.landingPerformance(db, id, q.range));
  }
  @Get("admin/mkt/knowledge/insights")
  @Route({ auth: MKT_SM })
  knowledge() {
    return this.m.read((db) => con.knowledgeInsights(db));
  }

  // ---- short links (web /r/:code and /c/:code call these, then redirect to `url`)
  @Get("links/c/:code")
  @Route({ auth: "public", limit: "read" })
  campaignLink(@Param("code") code: string) {
    return this.link(code, con.resolveCampaignLink);
  }
  @Get("links/r/:code")
  @Route({ auth: "public", limit: "read" })
  referralLink(@Param("code") code: string) {
    return this.link(code, con.resolveReferralLink);
  }

  /** Resolve read-only; the click is counted by the worker (outbox `marketing.link_click`). Errors never strand a visitor. */
  private async link(code: string, resolve: (db: Exec, code: string, base: string) => Promise<{ to: string; click: con.LinkClick | null }>) {
    try {
      return await this.m.read(async (db) => {
        const { to, click } = await resolve(db, code, this.web);
        if (click) await db.insert(outbox).values({ type: "marketing.link_click", payload: click, queue: "bulk" });
        return { url: to };
      });
    } catch (e) {
      this.log.warn({ event: "mkt.link_failed", code, err: String(e) });
      return { url: `${this.web}/` };
    }
  }
}
