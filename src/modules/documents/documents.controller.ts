import { Body, Controller, Query, Req, Delete, Get, Param, Patch, Post, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { Route } from "../../core/http/route";
import * as D from "./documents.dto";
import { DocumentsService } from "./documents.service";

/** Presigned redirect: the browser fetches bytes straight from storage. */
const redirect = (reply: FastifyReply, url: string) => reply.status(302).header("location", url).header("cache-control", "no-store").send();

@Controller()
export class DocumentsController {
  constructor(private readonly svc: DocumentsService) {}

  // ---- library
  @Get("me/documents")
  @Route({ auth: ["client"], permission: "doc.library", out: D.LibListOut })
  list(@CurrentUser() me: SessionUser) {
    return this.svc.list(me);
  }
  /** Declares the file; the client PUTs the bytes to `upload.url` (5 min). */
  @Post("me/documents")
  @Route({ auth: ["client"], permission: "doc.library", out: D.LibUploadOut })
  upload(@Body() b: D.LibUploadDto, @CurrentUser() me: SessionUser) {
    return this.svc.upload(me, b);
  }
  @Patch("me/documents/:id")
  @Route({ auth: ["client"], permission: "doc.library", out: D.LibDoc })
  update(@Param("id") id: string, @Body() b: D.LibPatchDto, @CurrentUser() me: SessionUser) {
    return this.svc.update(me, id, b);
  }
  @Delete("me/documents/:id")
  @Route({ auth: ["client"], permission: "doc.library", out: D.Deleted })
  remove(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.delete(me, id);
  }
  @Post("deliverables/:id/require-signature")
  @Route({ auth: ["staff:agent", "staff:service_manager", "ext:agent"], limit: "write" })
  requireSignature(@Param("id") id: string, @Body() b: D.RequireSignatureDto, @CurrentUser() me: SessionUser) {
    return this.svc.requireSignature(me, id, b.required);
  }
  @Post("me/deliverables/:id/sign")
  @Route({ auth: ["client"], permission: "dlv.download", limit: "write" })
  sign(@Param("id") id: string, @Body() b: D.SignDto, @CurrentUser() me: SessionUser, @Req() req: FastifyRequest) {
    return this.svc.sign(me, id, b, { ip: req.ip ?? null, ua: (req.headers["user-agent"] as string | undefined) ?? null });
  }
  @Get("admin/documents/retention")
  @Route({ auth: ["staff:service_manager", "staff:sysadmin"] })
  retention(@Query("state") state?: string) {
    return this.svc.retentionQueue(state === "decided" ? "decided" : "open");
  }
  @Post("admin/documents/retention/:id/decision")
  @Route({ auth: ["staff:service_manager"], limit: "write", stepUp: true })
  retentionDecision(@Param("id") id: string, @Body() b: D.RetentionDecisionDto, @CurrentUser() me: SessionUser) {
    return this.svc.retentionDecision(me, id, b);
  }
  @Get("d/:token")
  @Route({ auth: ["client"], limit: "auth" })
  redeem(@Param("token") token: string, @CurrentUser() me: SessionUser) {
    return this.svc.redeemToken(me, token.slice(0, 64));
  }
  @Post("me/documents/:id/versions/:v/restore")
  @Route({ auth: ["client"], permission: "doc.library", limit: "write", out: D.LibDoc })
  restore(@Param("id") id: string, @Param("v") v: string, @CurrentUser() me: SessionUser) {
    return this.svc.restoreVersion(me, id, Number.parseInt(v, 10) || 0);
  }
  @Post("me/deliverables/:id/save-to-library")
  @Route({ auth: ["client"], permission: "doc.library", limit: "write", out: D.LibDoc })
  saveToLibrary(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.saveDeliverableToLibrary(me, id);
  }
  @Post("me/documents/:id/attach")
  @Route({ auth: ["client"], permission: "doc.case.upload", out: D.LibDoc })
  attach(@Param("id") id: string, @Body() b: D.AttachDto, @CurrentUser() me: SessionUser) {
    return this.svc.attach(me, id, b.code, b.requirementKey);
  }
  @Get("me/documents/:id/download")
  @Route({ auth: ["client"], permission: "doc.library" })
  @RawResponse()
  async download(@Param("id") id: string, @CurrentUser() me: SessionUser, @Res() reply: FastifyReply) {
    return redirect(reply, await this.svc.libraryUrl(me, id));
  }

  /** Library, case or chat upload: the client confirms its presigned PUT so finalize runs now. */
  @Post("documents/:id/complete")
  @Route({ auth: "user" })
  complete(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.complete(me, id);
  }

  // ---- case uploads
  @Post("applications/:code/documents")
  @Route({ auth: "user", permission: "doc.case.upload", out: D.CaseUploadOut })
  uploadCase(@Param("code") code: string, @Body() b: D.CaseUploadDto, @CurrentUser() me: SessionUser) {
    return this.svc.uploadCase(me, code, b);
  }

  // ---- deliverables
  @Get("me/deliverables")
  @Route({ auth: ["client"], permission: "dlv.download", out: D.DeliverablesOut })
  deliverables(@CurrentUser() me: SessionUser) {
    return this.svc.deliverables(me);
  }
  @Get("deliverables/:id/preview")
  @Route({ auth: "user", permission: "dlv.download" })
  @RawResponse()
  async preview(@Param("id") id: string, @CurrentUser() me: SessionUser, @Res() reply: FastifyReply) {
    const r = await this.svc.deliverablePreview(me, id);
    if ("url" in r) return redirect(reply, r.url);
    return reply.header("content-type", r.type).header("cache-control", "private, no-store").send(r.body);
  }
  @Get("deliverables/:id/download")
  @Route({ auth: "user", permission: "dlv.download" })
  @RawResponse()
  async downloadDeliverable(@Param("id") id: string, @CurrentUser() me: SessionUser, @Res() reply: FastifyReply) {
    return redirect(reply, await this.svc.deliverableUrl(me, id, true));
  }
  @Post("deliverables/:id/receipt")
  @Route({ auth: ["client"], permission: "dlv.download", out: D.Recorded })
  receipt(@Param("id") id: string, @Body() b: D.ReceiptDto, @CurrentUser() me: SessionUser) {
    return this.svc.receipt(me, id, b.ok, b.note);
  }
  @Post("me/deliverables/:code/rating")
  @Route({ auth: ["client"], permission: "dlv.download", out: D.Recorded })
  rate(@Param("code") code: string, @Body() b: D.RatingDto, @CurrentUser() me: SessionUser) {
    return this.svc.rate(me, code, b.stars, { tags: b.tags, comment: b.comment });
  }
  @Get("me/nps")
  @Route({ auth: ["client"], out: D.NpsDue })
  nps(@CurrentUser() me: SessionUser) {
    return this.svc.npsDue(me);
  }
  @Post("me/nps")
  @Route({ auth: ["client"], limit: "write", out: D.Recorded })
  answerNps(@Body() b: D.NpsDto, @CurrentUser() me: SessionUser) {
    return this.svc.answerNps(me, b.score, b.comment);
  }
}
