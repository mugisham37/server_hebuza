import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ClsService } from "nestjs-cls";
import { Route } from "../../core/http/route";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { CurrentUser } from "../../core/auth/decorators";
import type { RequestStore, SessionUser } from "../../core/http/context";
import { AccountService } from "./account.service";
import { OrgService } from "./org.service";
import * as D from "./account.dto";

const CLIENT = ["client"] as const;
const ORG_STAFF = ["staff:service_manager", "staff:executive", "staff:sysadmin", "staff:finance"] as const;
const CASE_STAFF = ["staff:agent", "staff:service_manager", "staff:executive", "staff:sysadmin"] as const;

// Client quotations/refunds (GET me/quotations, POST me/quotations/:no/:action, GET me/refunds/eligibility,
// GET me/refunds, POST me/refunds) live in the finance module: they run on the finance store + refund workflow.
@Controller()
export class AccountController {
  constructor(private readonly svc: AccountService, private readonly org: OrgService, private readonly cls: ClsService<RequestStore>) {}

  @Get("me/consents") @Route({ auth: CLIENT })
  consents(@CurrentUser() me: SessionUser) { return this.svc.consents(me); }

  @Get("me/consents/history") @Route({ auth: CLIENT })
  consentHistory(@CurrentUser() me: SessionUser) { return this.svc.consentHistory(me); }

  @Put("me/consents") @Route({ auth: CLIENT, limit: "write" })
  setConsents(@Body() b: D.ConsentsDto, @CurrentUser() me: SessionUser) { return this.svc.setConsents(me, b); }

  @Get("me/data-export") @Route({ auth: CLIENT })
  dataExport(@CurrentUser() me: SessionUser) { return this.svc.dataExport(me); }

  @Post("me/data-export") @Route({ auth: CLIENT, limit: "auth" })
  requestExport(@CurrentUser() me: SessionUser) { return this.svc.requestExport(me); }

  @Get("me/deletion-check") @Route({ auth: CLIENT })
  deletionCheck(@CurrentUser() me: SessionUser) { return this.svc.deletionCheck(me); }

  @Get("me/avatar") @Route({ auth: "user" })
  avatar(@CurrentUser() me: SessionUser) { return this.svc.avatar(me); }

  @Post("me/avatar") @Route({ auth: "user", limit: "write" })
  setAvatar(@Body() b: D.AvatarDto, @CurrentUser() me: SessionUser) { return this.svc.setAvatar(me, b); }

  @Delete("me/avatar") @Route({ auth: "user", limit: "write" })
  clearAvatar(@CurrentUser() me: SessionUser) { return this.svc.clearAvatar(me); }

  @Get("me/reminders") @Route({ auth: CLIENT })
  reminders(@CurrentUser() me: SessionUser) { return this.svc.reminders(me); }

  @Put("me/reminders/:id") @Route({ auth: CLIENT, limit: "write" })
  setReminder(@Param("id") id: string, @Body() b: D.ReminderDto, @CurrentUser() me: SessionUser) { return this.svc.setReminder(me, id.slice(0, 96), b); }

  @Get("me/address") @Route({ auth: CLIENT })
  address(@CurrentUser() me: SessionUser) { return this.svc.address(me); }

  @Put("me/address") @Route({ auth: CLIENT, limit: "write" })
  setAddress(@Body() b: D.AddressDto, @CurrentUser() me: SessionUser) { return this.svc.setAddress(me, b); }

  @Get("me/prefill") @Route({ auth: CLIENT, limit: "read" })
  prefill(@Query() q: D.PrefillQueryDto, @CurrentUser() me: SessionUser) { return this.svc.prefill(me, q.party); }

  // ── ORG company profiles ──
  @Get("me/orgs") @Route({ auth: CLIENT })
  orgs(@CurrentUser() me: SessionUser) { return this.org.mine(me); }

  @Post("me/orgs") @Route({ auth: CLIENT, limit: "write" })
  createOrg(@Body() b: D.OrgDto, @CurrentUser() me: SessionUser) { return this.org.create(me, { ...b, email: b.email || null }); }

  @Put("me/orgs/active") @Route({ auth: CLIENT, limit: "write" })
  setActiveOrg(@Body() b: D.ActiveOrgDto, @CurrentUser() me: SessionUser) { return this.org.setActive(me, b.orgId); }

  @Get("organizations/:id") @Route({ auth: CLIENT })
  orgDetail(@Param("id") id: string, @CurrentUser() me: SessionUser) { return this.org.detail(me, id); }

  @Patch("organizations/:id") @Route({ auth: CLIENT, limit: "write" })
  updateOrg(@Param("id") id: string, @Body() b: D.OrgPatchDto, @CurrentUser() me: SessionUser) { return this.org.update(me, id, { ...b, ...(b.email !== undefined && { email: b.email || null }) } as Parameters<OrgService["update"]>[2]); }

  @Get("organizations/:id/documents/:doc/download") @Route({ auth: CLIENT, limit: "read" })
  orgDoc(@Param("id") id: string, @Param("doc") doc: string, @CurrentUser() me: SessionUser) { return this.org.docDownload(me, id, doc); }

  @Post("organizations/:id/verification-request") @Route({ auth: CLIENT, limit: "write", audit: "org.verification_requested" })
  requestOrgVerification(@Param("id") id: string, @CurrentUser() me: SessionUser) { return this.org.requestVerification(me, id); }

  @Post("me/orgs/:id/invites") @Route({ auth: CLIENT, limit: "write" })
  invite(@Param("id") id: string, @Body() b: D.InviteDto, @CurrentUser() me: SessionUser) { return this.org.invite(me, id, b); }

  @Patch("organizations/:id/members/:mid") @Route({ auth: CLIENT, limit: "write" })
  setMember(@Param("id") id: string, @Param("mid") mid: string, @Body() b: D.MemberPatchDto, @CurrentUser() me: SessionUser) { return this.org.setMember(me, id, mid, b); }

  @Delete("me/orgs/:id/members/:mid") @Route({ auth: CLIENT, limit: "write" })
  removeMember(@Param("id") id: string, @Param("mid") mid: string, @CurrentUser() me: SessionUser) { return this.org.removeMember(me, id, mid); }

  @Get("org-invites/:token") @Route({ auth: "public", limit: "read" })
  invitePreview(@Param("token") token: string) { return this.org.invitePreview(token); }

  @Post("org-invites/:token/accept") @Route({ auth: CLIENT, limit: "auth" })
  acceptInvite(@Param("token") token: string, @CurrentUser() me: SessionUser) { return this.org.accept(me, token); }

  @Get("admin/organizations") @Route({ auth: ORG_STAFF })
  adminOrgs(@Query() q: D.OrgAdminQueryDto) { return this.org.adminList(q); }

  @Get("admin/organizations/:id") @Route({ auth: ORG_STAFF })
  adminOrg(@Param("id") id: string) { return this.org.adminDetail(id); }

  @Post("admin/organizations/:id/verify") @Route({ auth: ["staff:service_manager", "staff:sysadmin"], limit: "write" })
  verifyOrg(@Param("id") id: string, @Body() b: D.OrgVerifyDto, @CurrentUser() me: SessionUser) { return this.org.verify(me, id, b); }

  @Post("applications/claim") @Route({ auth: CLIENT, limit: "auth", out: D.ClaimOut })
  claim(@Body() b: D.ClaimDto, @CurrentUser() me: SessionUser) { return this.svc.claim(me, b); }

  @Post("uploads") @Route({ auth: "public", limit: "write" })
  upload(@Body() b: D.UploadDto, @CurrentUser() me: SessionUser | null) { return this.svc.upload(me, this.cls.get("ip"), b); }

  @Get("files/:id/:name") @Route({ auth: "user" }) @RawResponse()
  async file(@Param("id") id: string, @CurrentUser() me: SessionUser, @Res() reply: FastifyReply) {
    return reply.redirect(await this.svc.fileUrl(me, id), 302);
  }

  @Get("admin/applications/:code/documents/:doc/file") @Route({ auth: CASE_STAFF, limit: "read" }) @RawResponse()
  async caseDoc(@Param("code") code: string, @Param("doc") doc: string, @CurrentUser() me: SessionUser, @Res() reply: FastifyReply) {
    return reply.redirect(await this.svc.caseDocUrl(me, code, doc), 302);
  }
}
