import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import type { NavLocation, SiteSettings } from "@/domain/marketing/types";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { AppError, invalid } from "../../core/http/errors";
import { IfMatch, Route } from "../../core/http/route";
import * as D from "./cms.dto";
import { CmsService, type EntryPatch, type VariantIn } from "./cms.service";

const R = D.CMS_ROLES;
const lang = (x: string) => {
  const r = D.Lang.safeParse(x);
  if (!r.success) throw invalid({ lang: "Unknown language." });
  return r.data;
};
const num = (x: string) => {
  const r = z.coerce.number().int().min(0).safeParse(x);
  if (!r.success) throw invalid({ version: "Must be a non-negative integer." });
  return r.data;
};
const navLoc = (x: string): NavLocation => {
  if (x !== "header" && x !== "mobile" && x !== "footer") throw new AppError(404, "not_found", "Not found.");
  return x;
};

@Controller()
export class CmsController {
  constructor(private readonly svc: CmsService) {}

  // ---- entries
  @Get("admin/cms/entries")
  @Route({ auth: R })
  list(@Query() q: D.ListQueryDto) {
    return this.svc.listEntries(q);
  }
  @Post("admin/cms/entries")
  @Route({ auth: R, status: 201, audit: "cms.entry.created" })
  create(@CurrentUser() me: SessionUser, @Body() b: D.CreateDto) {
    return this.svc.createEntry(me, b);
  }
  @Get("admin/cms/entries/:id")
  @Route({ auth: R })
  get(@Param("id") id: string) {
    return this.svc.getEntry(id);
  }
  @Patch("admin/cms/entries/:id")
  @Route({ auth: R, audit: "cms.entry.updated" })
  patch(@CurrentUser() me: SessionUser, @Param("id") id: string, @IfMatch() v: string | null, @Body() b: D.PatchDto) {
    return this.svc.patchEntry(me, id, v, b as EntryPatch);
  }
  @Put("admin/cms/entries/:id/variants/:lang")
  @Route({ auth: R, audit: "cms.variant.saved" })
  putVariant(@CurrentUser() me: SessionUser, @Param("id") id: string, @Param("lang") l: string, @IfMatch() v: string | null, @Body() b: D.VariantDto) {
    return this.svc.putVariant(me, id, lang(l), v, b as VariantIn);
  }
  @Post("admin/cms/entries/:id/duplicate")
  @Route({ auth: R, audit: "cms.entry.duplicated" })
  duplicate(@CurrentUser() me: SessionUser, @Param("id") id: string) {
    return this.svc.duplicateEntry(me, id);
  }
  @Post("admin/cms/entries/:id/lock")
  @Route({ auth: R })
  lock(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.LockDto) {
    return this.svc.lockEntry(me, id, !!b.force);
  }
  @Delete("admin/cms/entries/:id/lock")
  @Route({ auth: R })
  unlock(@CurrentUser() me: SessionUser, @Param("id") id: string) {
    return this.svc.unlockEntry(me, id);
  }
  @Post("admin/cms/entries/:id/submit")
  @Route({ auth: R, audit: "cms.entry.submitted" })
  submit(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.SubmitDto) {
    return this.svc.submit(me, id, b);
  }
  @Post("admin/cms/entries/:id/approve")
  @Route({ auth: R, audit: "cms.entry.approved" })
  approve(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.LangsDto) {
    return this.svc.approve(me, id, b);
  }
  @Post("admin/cms/entries/:id/request-changes")
  @Route({ auth: R, audit: "cms.entry.changes_requested" })
  requestChanges(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.ChangesDto) {
    return this.svc.requestChanges(me, id, b);
  }
  @Post("admin/cms/entries/:id/publish")
  @Route({ auth: R, permission: "cms.publish", idempotent: true, audit: "cms.entry.published" })
  publish(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.PublishDto) {
    return this.svc.publishOrSchedule(me, id, "publish", b);
  }
  @Post("admin/cms/entries/:id/schedule")
  @Route({ auth: R, permission: "cms.publish", audit: "cms.entry.scheduled" })
  schedule(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.ScheduleDto) {
    return this.svc.publishOrSchedule(me, id, "schedule", b);
  }
  @Post("admin/cms/entries/:id/unschedule")
  @Route({ auth: R, permission: "cms.publish", audit: "cms.entry.unscheduled" })
  unschedule(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.LangsDto) {
    return this.svc.unscheduleOrUnpublish(me, id, "unschedule", b);
  }
  @Post("admin/cms/entries/:id/unpublish")
  @Route({ auth: R, permission: "cms.publish", audit: "cms.entry.unpublished" })
  unpublish(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.LangsDto) {
    return this.svc.unscheduleOrUnpublish(me, id, "unpublish", b);
  }
  @Post("admin/cms/entries/:id/archive")
  @Route({ auth: R, permission: "cms.publish", audit: "cms.entry.archived" })
  archive(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.ArchiveDto) {
    return this.svc.archive(me, id, b);
  }
  @Get("admin/cms/entries/:id/versions")
  @Route({ auth: R })
  versions(@Param("id") id: string) {
    return this.svc.listVersions(id);
  }
  @Post("admin/cms/entries/:id/restore/:version")
  @Route({ auth: R, audit: "cms.entry.restored" })
  restore(@CurrentUser() me: SessionUser, @Param("id") id: string, @Param("version") v: string, @Query() q: D.LangQueryDto) {
    return this.svc.restore(me, id, num(v), q.lang);
  }
  @Get("admin/cms/entries/:id/comments")
  @Route({ auth: R })
  comments(@Param("id") id: string) {
    return this.svc.listComments(id);
  }
  @Post("admin/cms/entries/:id/comments")
  @Route({ auth: R, status: 201 })
  addComment(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.CommentDto) {
    return this.svc.addComment(me, id, b);
  }
  @Post("admin/cms/entries/:id/translate")
  @Route({ auth: R, audit: "cms.entry.translated" })
  translate(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.TranslateDto) {
    return this.svc.translate(me, id, b);
  }
  @Get("admin/cms/entries/:id/preview-token")
  @Route({ auth: R, audit: "cms.preview.issued" })
  previewToken(@Param("id") id: string, @Query() q: D.LangQueryDto) {
    return this.svc.previewToken(id, q.lang);
  }
  @Patch("admin/cms/comments/:id")
  @Route({ auth: R })
  resolveComment(@Param("id") id: string, @Body() b: D.ResolveDto) {
    return this.svc.resolveComment(id, b.resolved);
  }
  @Get("admin/cms/review-count")
  @Route({ auth: R, out: D.ReviewCountOut })
  reviewCount(@CurrentUser() me: SessionUser) {
    return this.svc.reviewCount(me);
  }

  // ---- site-wide config (cms.manage)
  @Get("admin/cms/nav/:loc")
  @Route({ auth: R })
  nav(@Param("loc") loc: string) {
    return this.svc.getNav(navLoc(loc));
  }
  @Put("admin/cms/nav/:loc")
  @Route({ auth: R, permission: "cms.manage", audit: "cms.nav.updated" })
  putNav(@Param("loc") loc: string, @Body() b: D.NavDto) {
    return this.svc.putNav(navLoc(loc), b.items);
  }
  @Get("admin/cms/site-settings")
  @Route({ auth: R })
  settings() {
    return this.svc.getSiteSettings();
  }
  @Put("admin/cms/site-settings")
  @Route({ auth: R, permission: "cms.manage", audit: "cms.settings.updated" })
  putSettings(@Body() b: D.SettingsDto) {
    return this.svc.putSiteSettings(b as Partial<SiteSettings>);
  }
  @Get("admin/cms/not-found")
  @Route({ auth: R })
  notFound() {
    return this.svc.listNotFound();
  }
  @Get("admin/cms/redirects")
  @Route({ auth: R })
  redirects() {
    return this.svc.listRedirects();
  }
  @Post("admin/cms/redirects")
  @Route({ auth: R, permission: "cms.manage", audit: "cms.redirect.saved" })
  createRedirect(@CurrentUser() me: SessionUser, @Body() b: D.RedirectDto) {
    return this.svc.saveRedirect(me, null, b);
  }
  @Patch("admin/cms/redirects/:id")
  @Route({ auth: R, permission: "cms.manage", audit: "cms.redirect.saved" })
  updateRedirect(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.RedirectDto) {
    return this.svc.saveRedirect(me, id, b);
  }
  @Delete("admin/cms/redirects/:id")
  @Route({ auth: R, permission: "cms.manage", audit: "cms.redirect.deleted" })
  deleteRedirect(@Param("id") id: string) {
    return this.svc.deleteRedirect(id);
  }

  // ---- public
  @Get("content/entries")
  @Route({ auth: "public", limit: "read" })
  publicEntries() {
    return this.svc.publicEntries();
  }
  @Get("content/site")
  @Route({ auth: "public", limit: "read" })
  site() {
    return this.svc.publicSite();
  }
  @Get("content/manifest")
  @Route({ auth: "public", limit: "read" })
  manifest() {
    return this.svc.manifest();
  }
  @Get("content/rss")
  @Route({ auth: "public", limit: "read" })
  rss(@Query() q: D.RssQueryDto) {
    return this.svc.rss(q.locale);
  }
  @Get("content/preview")
  @Route({ auth: "public", limit: "read" })
  preview(@Query() q: D.PreviewQueryDto) {
    return this.svc.preview(q.token);
  }
  @Post("content/not-found")
  @Route({ auth: "public", limit: "write" })
  recordNotFound(@Body() b: D.NotFoundDto) {
    return this.svc.recordNotFound(b.path);
  }
  @Post("contact")
  @Route({ auth: "public", limit: "auth", out: D.ContactOut })
  contact(@Body() b: D.ContactDto) {
    return this.svc.submitContact(b);
  }
}
