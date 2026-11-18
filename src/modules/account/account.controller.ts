import { Body, Controller, Delete, Get, Param, Post, Put, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ClsService } from "nestjs-cls";
import { Route } from "../../core/http/route";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { CurrentUser } from "../../core/auth/decorators";
import type { RequestStore, SessionUser } from "../../core/http/context";
import { AccountService } from "./account.service";
import * as D from "./account.dto";

const CLIENT = ["client"] as const;
const CASE_STAFF = ["staff:agent", "staff:service_manager", "staff:executive", "staff:sysadmin"] as const;

// Client quotations/refunds (GET me/quotations, POST me/quotations/:no/:action, GET me/refunds/eligibility,
// GET me/refunds, POST me/refunds) live in the finance module: they run on the finance store + refund workflow.
@Controller()
export class AccountController {
  constructor(private readonly svc: AccountService, private readonly cls: ClsService<RequestStore>) {}

  @Get("me/consents") @Route({ auth: CLIENT })
  consents(@CurrentUser() me: SessionUser) { return this.svc.consents(me); }

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

  @Get("me/orgs") @Route({ auth: CLIENT })
  orgs(@CurrentUser() me: SessionUser) { return this.svc.orgs(me); }

  @Put("me/orgs/active") @Route({ auth: CLIENT, limit: "write" })
  setActiveOrg(@Body() b: D.ActiveOrgDto, @CurrentUser() me: SessionUser) { return this.svc.setActiveOrg(me, b.orgId); }

  @Post("me/orgs/:id/invites") @Route({ auth: CLIENT, limit: "write", audit: "org.member.invited" })
  invite(@Param("id") id: string, @Body() b: D.InviteDto, @CurrentUser() me: SessionUser) { return this.svc.invite(me, id, b); }

  @Delete("me/orgs/:id/members/:mid") @Route({ auth: CLIENT, limit: "write", audit: "org.member.removed" })
  removeMember(@Param("id") id: string, @Param("mid") mid: string, @CurrentUser() me: SessionUser) { return this.svc.removeMember(me, id, mid); }

  @Post("applications/claim") @Route({ auth: CLIENT, limit: "auth" })
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
