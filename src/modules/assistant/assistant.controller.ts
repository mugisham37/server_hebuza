import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { Route } from "../../core/http/route";
import * as D from "./assistant.dto";
import { AssistantService } from "./assistant.service";

// Shapes are @/domain/booking/types (AssistantStatus, KbSource, AiTranscript, …); no `out` schema like the reference.
@Controller()
export class AssistantController {
  constructor(private readonly svc: AssistantService) {}

  // ── public / client
  @Get("assistant/status")
  @Route({ auth: "public", limit: "read" })
  status() {
    return this.svc.status();
  }
  @Post("assistant/sessions")
  @Route({ auth: "public", limit: "write" })
  start(@Body() b: D.StartDto) {
    return this.svc.startSession(b);
  }
  @Get("assistant/sessions")
  @Route({ auth: ["client"] })
  recent(@CurrentUser() me: SessionUser) {
    return this.svc.recentSessions(me);
  }
  @Post("assistant/sessions/:id/messages")
  @Route({ auth: "public", limit: "write" })
  @RawResponse()
  message(@Param("id") id: string, @Body() b: D.MessageDto, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    return this.svc.message(id, b, req, reply);
  }
  @Post("assistant/sessions/:id/tool-answers")
  @Route({ auth: "public", limit: "write" })
  @RawResponse()
  toolAnswer(@Param("id") id: string, @Body() b: D.ToolAnswerDto, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    return this.svc.toolAnswer(id, b, req, reply);
  }
  @Post("assistant/sessions/:id/rating")
  @Route({ auth: "public", limit: "write" })
  rate(@Param("id") id: string, @Body() b: D.RatingDto) {
    return this.svc.rate(id, b);
  }
  @Post("assistant/sessions/:id/handoff")
  @Route({ auth: "public", limit: "write" })
  handoff(@Param("id") id: string, @Body() b: D.HandoffDto) {
    return this.svc.handoff(id, b);
  }
  @Post("assistant/sessions/:id/lead")
  @Route({ auth: "public", limit: "auth" })
  lead(@Param("id") id: string, @Body() b: D.LeadDto) {
    return this.svc.lead(id, b);
  }
  @Get("assistant/drafts/:id")
  @Route({ auth: "public", limit: "read" })
  draft(@Param("id") id: string) {
    return this.svc.draft(id);
  }

  // ── staff AI
  @Get("admin/kb-sources")
  @Route({ auth: D.KB_READ })
  kbList(@CurrentUser() me: SessionUser) {
    return this.svc.kbList(me);
  }
  // Static segment before :id so "reindex" never matches the id route.
  @Post("admin/kb-sources/reindex")
  @Route({ auth: D.SM })
  reindex(@CurrentUser() me: SessionUser, @Body() b: D.ReindexDto) {
    return this.svc.reindexStart(me, b);
  }
  @Get("admin/kb-sources/reindex/:job")
  @Route({ auth: D.SM })
  reindexStatus(@Param("job") job: string) {
    return this.svc.reindexStatus(job);
  }
  @Get("admin/kb-sources/:id")
  @Route({ auth: D.KB_READ })
  kbOne(@CurrentUser() me: SessionUser, @Param("id") id: string) {
    return this.svc.kbOne(me, id);
  }
  @Patch("admin/kb-sources/:id")
  @Route({ auth: D.KB_READ })
  kbPatch(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: D.KbPatchDto) {
    return this.svc.kbPatch(me, id, b);
  }
  @Get("admin/assistant/sessions")
  @Route({ auth: D.KB_READ })
  sessions(@Query() q: D.SessionsQ) {
    return this.svc.adminSessions(q);
  }
  @Get("admin/assistant/sessions/:id")
  @Route({ auth: D.KB_READ })
  transcript(@Param("id") id: string) {
    return this.svc.transcript(id);
  }
  @Get("admin/assistant/unanswered")
  @Route({ auth: D.KB_READ })
  unanswered() {
    return this.svc.unanswered();
  }
  @Get("admin/assistant/evals/runs")
  @Route({ auth: D.KB_READ })
  evalRuns() {
    return this.svc.evalRuns();
  }
  @Post("admin/assistant/evals/run")
  @Route({ auth: D.SM, limit: "auth" })
  runEvals() {
    return this.svc.runEvals();
  }
  @Get("admin/assistant/settings")
  @Route({ auth: D.SETTINGS_READ })
  settings(@CurrentUser() me: SessionUser) {
    return this.svc.getSettings(me);
  }
  @Put("admin/assistant/settings")
  @Route({ auth: ["staff:sysadmin"] })
  putSettings(@Body() b: D.SettingsDto) {
    return this.svc.putSettings(b);
  }
  @Get("admin/assistant/handoffs")
  @Route({ auth: D.SM })
  handoffs() {
    return this.svc.handoffs();
  }
  @Post("admin/assistant/handoffs/:id/claim")
  @Route({ auth: D.SM })
  claim(@CurrentUser() me: SessionUser, @Param("id") id: string) {
    return this.svc.claim(me, id);
  }
  @Post("assistant/copilot/:kind")
  @Route({ auth: D.COPILOT })
  copilot(@CurrentUser() me: SessionUser, @Param("kind") kind: string, @Body() b: D.CopilotDto) {
    return this.svc.copilot(me, kind, b);
  }
}
