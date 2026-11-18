// Agent workspace routes (reference agent.routes.tsx, 61 routes) + openapi-only settings/profile/papers/case upload.
// Staff and external agents share the endpoints; row scope (assigned lead/helper, external job scope) is in the service.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { Route } from "../../core/http/route";
import { StorageService } from "../../core/storage/storage.service";
import { ApplicationsService } from "../applications/applications.service";
import { ChatService } from "../chat/chat.service";
import { DocumentsService, FINALIZE_DELAY_MS } from "../documents/documents.service";
import { OutboxService } from "../../core/db/outbox";
import { OpsRunner, Req, type OpsReq } from "../ops/ops.runner";
import type { Ctx } from "../ops/lib/ctx";
import * as a from "./agent.service";
import * as D from "./agent.dto";

const AG = ["staff:agent", "ext:agent"] as const;
const C = "agent/x/cases/:code";

@Controller()
export class AgentController {
  private readonly deps: a.Deps;
  private readonly icsBase: string;
  constructor(
    private readonly o: OpsRunner,
    private readonly docs: DocumentsService,
    apps: ApplicationsService,
    chat: ChatService,
    storage: StorageService,
    config: ConfigService<Env, true>,
    outbox: OutboxService,
  ) {
    this.deps = {
      apps,
      chat,
      storage,
      scan: (db, key) => outbox.add(db, { type: "storage.scan", payload: { key }, runAt: new Date(Date.now() + FINALIZE_DELAY_MS) }),
    };
    this.icsBase = (config.get("API_PUBLIC_URL", { infer: true }) ?? "").replace(/\/$/, "");
  }
  private q<T>(r: OpsReq, fn: (c: Ctx) => Promise<T>) {
    return this.o.run(r, fn);
  }

  // ── core ──
  @Get("agent/x/summary")
  @Route({ auth: AG })
  summary(@Req() r: OpsReq) {
    return this.q(r, (c) => a.summary(c.db, c.session));
  }
  @Put("agent/x/duty")
  @Route({ auth: AG, audit: "agent.duty_changed" })
  duty(@Req() r: OpsReq, @Body() b: D.DutyDto) {
    return this.q(r, (c) => a.setDuty(c, b));
  }
  @Get("agent/x/notifications")
  @Route({ auth: AG })
  notifications(@Req() r: OpsReq) {
    return this.q(r, (c) => a.notifications(c.db, c.session));
  }
  @Get("agent/cases")
  @Route({ auth: AG, permission: "req.case.read" })
  cases(@Req() r: OpsReq) {
    return this.q(r, (c) => a.cases(c.db, c.session));
  }
  @Get("agent/calendar")
  @Route({ auth: AG })
  calendar(@Req() r: OpsReq, @Query() q: D.RangeQueryDto) {
    return this.q(r, (c) => a.calendar(c.db, c.session, q));
  }
  @Get("agent/metrics")
  @Route({ auth: AG })
  metrics(@Req() r: OpsReq) {
    return this.q(r, (c) => a.metrics(c.db, c.session));
  }
  @Post("agent/obligations/:id/:action")
  @Route({
    auth: AG,
    permission: "cal.obligations.update",
    audit: "obligation.action",
  })
  obligation(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Param("action") act: string,
    @Body() b: D.ObligationDto,
  ) {
    return this.q(r, (c) => a.obligationAction(c, id, act, b ?? {}));
  }

  // ── workbench ──
  @Get("agent/cases/:code")
  @Route({ auth: AG, permission: "req.case.read" })
  caseDetail(@Req() r: OpsReq, @Param("code") code: string) {
    return this.q(r, (c) => a.caseDetail(c.db, c.session, code));
  }
  @Patch("agent/cases/:code/status")
  @Route({
    auth: AG,
    permission: "req.status.update",
    idempotent: true,
    audit: "case.status_changed",
    emit: "case.updated",
  })
  status(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.StatusDto,
  ) {
    return this.q(r, (c) => a.changeStatus(this.deps, c, code, b));
  }
  @Post("agent/cases/:code/flag")
  @Route({ auth: AG })
  flag(@Req() r: OpsReq, @Param("code") code: string, @Body() b: D.FlagDto) {
    return this.q(r, (c) => a.flag(c, code, b));
  }
  @Post("agent/cases/:code/propose-due")
  @Route({ auth: AG, idempotent: true })
  proposeDue(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.ProposeDueDto,
  ) {
    return this.q(r, (c) => a.proposeDue(c, code, b));
  }
  @Get("agent/cases/:code/documents")
  @Route({ auth: AG, permission: "req.case.read" })
  documents(@Req() r: OpsReq, @Param("code") code: string) {
    return this.q(r, (c) => a.documents(c.db, c.session, code));
  }
  /** openapi extra: agent uploads a case document (presigned PUT via DocumentsService) after the agent scope check. */
  @Post("agent/cases/:code/documents")
  @Route({
    auth: AG,
    permission: "doc.case.upload",
    audit: "case.document_uploaded",
  })
  async uploadDocument(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.DocUploadDto,
    @CurrentUser() me: SessionUser,
  ) {
    await this.q(r, (c) => a.myCase(c.db, c.session, code, true));
    return this.docs.uploadCase(me, code, b);
  }
  @Patch("agent/cases/:code/documents/:document_id/qc")
  @Route({ auth: AG, permission: "doc.case.qc", audit: "case.document_qc" })
  qc(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Param("document_id") id: string,
    @Body() b: D.QcDto,
  ) {
    return this.q(r, (c) => a.docQc(this.deps, c, code, id, b));
  }
  @Post(`${C}/checklist/:item`)
  @Route({ auth: AG })
  tick(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Param("item") item: string,
    @Body() b: D.DoneDto,
  ) {
    return this.q(r, (c) => a.tickStep(c, code, item, b.done));
  }
  @Post(`${C}/reveal`)
  @Route({ auth: AG, audit: "case.pii_revealed" })
  reveal(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.RevealDto,
  ) {
    return this.q(r, (c) => a.revealField(c, code, b.field));
  }
  @Post(`${C}/outcome`)
  @Route({ auth: AG, permission: "req.outcome.update" })
  outcome(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.OutcomeDto,
  ) {
    return this.q(r, (c) => a.outcome(c, code, b));
  }
  @Post(`${C}/field-visit`)
  @Route({ auth: AG, idempotent: true })
  fieldVisit(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.FieldVisitDto,
  ) {
    return this.q(r, (c) => a.fieldVisit(c, code, b));
  }
  @Post(`${C}/timesheet`)
  @Route({ auth: AG, idempotent: true })
  timesheet(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.TimesheetDto,
  ) {
    return this.q(r, (c) => a.timesheet(c, code, b));
  }
  @Post(`${C}/dispute-response`)
  @Route({ auth: AG })
  dispute(@Req() r: OpsReq, @Param("code") code: string, @Body() b: D.TextDto) {
    return this.q(r, (c) => a.disputeResponse(c, code, b.text));
  }

  // ── offers & deliverables ──
  @Get("agent/x/offers")
  @Route({ auth: AG, permission: "asn.offer.respond" })
  offers(@Req() r: OpsReq, @Query() q: D.OffersQueryDto) {
    return this.q(r, (c) => a.offers(c.db, c.session, q));
  }
  @Post("agent/x/offers/:id/accept")
  @Route({
    auth: AG,
    permission: "asn.offer.respond",
    idempotent: true,
    audit: "offer.accept",
  })
  accept(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.AcceptDto) {
    return this.q(r, (c) => a.acceptOffer(this.deps, c, id, b));
  }
  @Post("agent/x/offers/:id/decline")
  @Route({
    auth: AG,
    permission: "asn.offer.respond",
    idempotent: true,
    audit: "offer.decline",
  })
  decline(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.DeclineDto) {
    return this.q(r, (c) => a.declineOffer(c, id, b));
  }
  @Post("agent/x/offers/:id/undo")
  @Route({ auth: AG, permission: "asn.offer.respond", audit: "offer.undo" })
  undo(@Req() r: OpsReq, @Param("id") id: string) {
    return this.q(r, (c) => a.undoOffer(this.deps, c, id));
  }
  @Get(`${C}/deliverables`)
  @Route({ auth: AG })
  deliverables(@Req() r: OpsReq, @Param("code") code: string) {
    return this.q(r, (c) => a.deliverables(c.db, c.session, code));
  }
  @Post(`${C}/deliverables`)
  @Route({ auth: AG, permission: "dlv.upload", audit: "deliverable.upload" })
  upload(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.DeliverableDto,
  ) {
    return this.q(r, (c) => a.uploadDeliverable(this.deps, c, code, b));
  }
  @Post(`${C}/submit-review`)
  @Route({
    auth: AG,
    permission: "dlv.upload",
    idempotent: true,
    audit: "deliverable.submitted",
  })
  submitReview(@Req() r: OpsReq, @Param("code") code: string) {
    return this.q(r, (c) => a.submitReview(this.deps, c, code));
  }

  // ── inbox, templates, clients ──
  @Get("agent/x/threads")
  @Route({ auth: AG })
  threads(@Req() r: OpsReq, @Query() q: D.ThreadsQueryDto) {
    return this.q(r, (c) => a.threads(c.db, c.session, q));
  }
  @Get("agent/x/threads/:ref")
  @Route({ auth: AG })
  thread(@Req() r: OpsReq, @Param("ref") ref: string) {
    return this.q(r, (c) => a.thread(this.deps, c.db, c.session, ref));
  }
  @Post("agent/x/threads/:ref/read")
  @Route({ auth: AG })
  readThread(@Req() r: OpsReq, @Param("ref") ref: string) {
    return this.q(r, (c) => a.readThread(this.deps, c.db, c.session, ref));
  }
  @Post("agent/x/threads/:ref/messages")
  @Route({ auth: AG, limit: "write", idempotent: true })
  post(@Req() r: OpsReq, @Param("ref") ref: string, @Body() b: D.MsgDto) {
    return a.postThread(this.deps, (fn) => this.q(r, fn), ref, b);
  }
  @Get("agent/x/templates")
  @Route({ auth: AG, permission: "msg.templates.personal" })
  templates(@Req() r: OpsReq) {
    return this.q(r, (c) => a.listTemplates(c.db, c.session));
  }
  @Post("agent/x/templates")
  @Route({ auth: AG, permission: "msg.templates.personal" })
  createTemplate(@Req() r: OpsReq, @Body() b: D.TplDto) {
    return this.q(r, (c) => a.createTemplate(c.db, c.session, b));
  }
  @Put("agent/x/templates/:id")
  @Route({ auth: AG, permission: "msg.templates.personal" })
  updateTemplate(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: D.TplDto,
  ) {
    return this.q(r, (c) => a.updateTemplate(c.db, c.session, id, b));
  }
  @Delete("agent/x/templates/:id")
  @Route({ auth: AG, permission: "msg.templates.personal" })
  deleteTemplate(@Req() r: OpsReq, @Param("id") id: string) {
    return this.q(r, (c) => a.deleteTemplate(c.db, c.session, id));
  }
  @Get("agent/clients")
  @Route({ auth: AG })
  clients(@Req() r: OpsReq) {
    return this.q(r, (c) => a.clients(c.db, c.session));
  }
  @Get("agent/x/clients/:id")
  @Route({ auth: AG })
  client(@Req() r: OpsReq, @Param("id") id: string) {
    return this.q(r, (c) => a.clientOne(c.db, c.session, id));
  }
  @Post("agent/x/clients/:id/notes")
  @Route({ auth: AG })
  clientNote(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.TextDto) {
    return this.q(r, (c) => a.addClientNote(c.db, c.session, id, b.text));
  }

  // ── money ──
  @Get("agent/x/earnings")
  @Route({ auth: AG, permission: "rev.allocations.read" })
  earnings(@Req() r: OpsReq, @Query() q: D.MonthQueryDto) {
    return this.q(r, (c) =>
      a.earnings(
        c.db,
        c.session,
        q.month ?? new Date().toISOString().slice(0, 7),
      ),
    );
  }
  @Get("agent/x/statements")
  @Route({ auth: AG, permission: "rev.allocations.read" })
  statements(@Req() r: OpsReq) {
    return this.q(r, (c) => a.statements(c.db, c.session));
  }
  @Get("agent/x/statements/:month/file")
  @Route({
    auth: AG,
    permission: "rev.allocations.read",
    audit: "agent.statement_downloaded",
  })
  @RawResponse()
  async statementFile(
    @Req() r: OpsReq,
    @Param("month") month: string,
    @Res() reply: FastifyReply,
  ) {
    const pdf = await this.q(r, (c) => a.statementFile(c.db, c.session, month));
    return reply
      .header("content-type", "application/pdf")
      .header(
        "content-disposition",
        `attachment; filename="statement-${month}.pdf"`,
      )
      .send(pdf);
  }
  @Get("agent/x/payouts")
  @Route({ auth: AG, permission: "rev.payouts.read" })
  payouts(@Req() r: OpsReq) {
    return this.q(r, (c) => a.payouts(c.db, c.session));
  }
  @Post("agent/x/allocations/:id/question")
  @Route({ auth: AG, idempotent: true })
  async question(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: D.QuestionDto,
  ) {
    return (await this.q(r, (c) => a.askAllocation(c, id, b ?? {}))).row;
  }
  @Get("agent/x/performance")
  @Route({ auth: AG })
  performance(@Req() r: OpsReq, @Query() q: D.PerfQueryDto) {
    return this.q(r, (c) => a.performance(c.db, c.session, q.range ?? "30d"));
  }

  // ── profile ──
  @Get("agent/x/onboarding")
  @Route({ auth: AG, permission: "wrk.profile.own" })
  onboarding(@Req() r: OpsReq) {
    return this.q(r, (c) => a.onboarding(c.db, c.session));
  }
  @Put("agent/x/onboarding")
  @Route({ auth: AG, permission: "wrk.profile.own" })
  saveOnboarding(@Req() r: OpsReq, @Body() b: D.OnboardingDto) {
    return this.q(r, (c) => a.saveOnboarding(c, b));
  }
  @Post("agent/x/onboarding/submit")
  @Route({
    auth: AG,
    permission: "wrk.profile.own",
    audit: "agent.onboarding_submitted",
  })
  submitOnboarding(@Req() r: OpsReq) {
    return this.q(r, (c) => a.submitOnboarding(c));
  }
  @Get("agent/profile")
  @Route({ auth: AG })
  profile(@Req() r: OpsReq) {
    return this.q(r, (c) => a.profile(c.db, c.session));
  }
  @Patch("agent/profile")
  @Route({ auth: AG, audit: "agent.profile_updated" })
  updateProfile(@Req() r: OpsReq, @Body() b: D.ProfileDto) {
    return this.q(r, (c) => a.updateProfile(c, b));
  }
  @Get("agent/settings")
  @Route({ auth: AG })
  settings(@Req() r: OpsReq) {
    return this.q(r, (c) => a.settings(c.db, c.session));
  }
  @Put("agent/settings")
  @Route({ auth: AG, audit: "agent.settings_updated" })
  setSettings(@Req() r: OpsReq, @Body() b: D.SettingsDto) {
    return this.q(r, (c) => a.setSettings(c, b));
  }
  @Get("agent/papers")
  @Route({ auth: AG })
  papers(@Req() r: OpsReq) {
    return this.q(r, (c) => a.papers(c.db, c.session));
  }
  @Post("agent/papers")
  @Route({ auth: AG, audit: "agent.paper_uploaded" })
  uploadPaper(@Req() r: OpsReq, @Body() b: D.PaperDto) {
    return this.q(r, (c) => a.uploadPaper(this.deps, c, b));
  }
  @Get("agent/papers/:id/file")
  @Route({ auth: AG })
  @RawResponse()
  async paperFile(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Res() reply: FastifyReply,
  ) {
    return reply.redirect(
      await this.q(r, (c) => a.paperUrl(this.deps, c.db, c.session, id)),
      302,
    );
  }
  @Get("agent/skills")
  @Route({ auth: AG })
  skills(@Req() r: OpsReq) {
    return this.q(r, (c) => a.skills(c.db, c.session));
  }
  @Post("agent/x/skills/requests")
  @Route({ auth: AG })
  requestSkills(@Req() r: OpsReq, @Body() b: D.SkillsDto) {
    return this.q(r, (c) => a.requestSkills(c, b));
  }
  @Post("agent/x/skills/requests/cancel")
  @Route({ auth: AG })
  cancelSkills(@Req() r: OpsReq) {
    return this.q(r, (c) => a.cancelSkills(c));
  }
  @Get("agent/x/availability")
  @Route({ auth: AG })
  availability(@Req() r: OpsReq) {
    return this.q(r, (c) => a.availability(c.db, c.session));
  }
  @Put("agent/x/availability")
  @Route({ auth: AG })
  setAvailability(@Req() r: OpsReq, @Body() b: D.AvailDto) {
    return this.q(r, (c) => a.setAvailability(c.db, c.session, b));
  }
  @Get("agent/x/leave")
  @Route({ auth: AG })
  leave(@Req() r: OpsReq) {
    return this.q(r, (c) => a.leave(c.db, c.session));
  }
  @Post("agent/x/leave")
  @Route({ auth: AG, idempotent: true })
  requestLeave(@Req() r: OpsReq, @Body() b: D.LeaveDto) {
    return this.q(r, (c) => a.requestLeave(c, b));
  }
  @Post("agent/x/leave/cancel")
  @Route({ auth: AG })
  cancelLeave(@Req() r: OpsReq) {
    return this.q(r, (c) => a.cancelLeave(c));
  }
  @Get("agent/x/contract")
  @Route({ auth: AG, permission: "wrk.contracts.read" })
  contract(@Req() r: OpsReq) {
    return this.q(r, (c) => a.contract(c.db, c.session));
  }
  @Get("agent/x/notification-matrix")
  @Route({ auth: AG })
  matrix(@Req() r: OpsReq) {
    return this.q(r, (c) => a.matrix(c.db, c.session));
  }
  @Put("agent/x/notification-matrix")
  @Route({ auth: AG })
  setMatrix(@Req() r: OpsReq, @Body() b: D.MatrixDto) {
    return this.q(r, (c) => a.setMatrix(c.db, c.session, b.rows));
  }
  @Get("agent/x/ics")
  @Route({ auth: AG })
  ics(@Req() r: OpsReq) {
    return this.q(r, (c) => a.ics(c.db, c.session, this.icsBase));
  }
  @Post("agent/x/ics/regenerate")
  @Route({ auth: AG, audit: "agent.ics_regenerated" })
  regenerateIcs(@Req() r: OpsReq) {
    return this.q(r, (c) => a.regenerateIcs(c.db, c.session, this.icsBase));
  }
  // Calendar apps fetch the feed without cookies; the unguessable token is the credential.
  @Get("agent/ics/:token")
  @Route({ auth: "public", limit: "read" })
  @RawResponse()
  async icsFeed(@Param("token") token: string, @Res() reply: FastifyReply) {
    const body = await this.o.read((db) => a.icsFeed(db, token));
    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .send(body);
  }
}
