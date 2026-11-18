// Service-manager case workspace (reference ops.routes caseRoutes + lanes A/B): case list/detail, status, claim,
// intake triage, saved views, case record, quotation, notes, staff bell feed.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { Route } from "../../core/http/route";
import { NotificationsService } from "../notifications/notifications.service";
import * as ops from "./ops.cases";
import { OpsRunner, Req, type OpsReq } from "./ops.runner";
import { SM, SMR } from "./ops.roles";
import {
  CasesQueryDto,
  DocDecisionDto,
  DocRequestDto,
  DuplicateDto,
  EntityQueryDto,
  NoteDto,
  QuotationDto,
  StatusDto,
  ViewAsDto,
  ViewDto,
} from "./ops.dto";

const A = "admin/applications/:code";

@Controller()
export class OpsCasesController {
  constructor(
    private readonly o: OpsRunner,
    private readonly notifications: NotificationsService,
  ) {}

  @Get("admin/applications")
  @Route({ auth: SMR, permission: "req.case.read" })
  list(@Query() q: CasesQueryDto) {
    return this.o.read((db) => ops.listCases(db, q));
  }
  @Get(A)
  @Route({ auth: SMR, permission: "req.case.read" })
  detail(@Param("code") code: string) {
    return this.o.read((db) => ops.caseDetail(db, code));
  }
  @Post(`${A}/status`)
  @Route({
    auth: SM,
    permission: "req.status.update",
    idempotent: true,
    audit: "case.status_changed",
    emit: "case.updated",
  })
  status(@Req() r: OpsReq, @Param("code") code: string, @Body() b: StatusDto) {
    return this.o.run(r, (c) => ops.changeStatus(c, code, b));
  }
  @Post(`${A}/claim`)
  @Route({ auth: SM, permission: "req.intake.review" })
  claim(@Req() r: OpsReq, @Param("code") code: string) {
    return this.o.run(r, (c) => ops.claim(c, code));
  }
  @Get("admin/ops/today")
  @Route({ auth: SMR, permission: "req.case.read" })
  today(@Req() r: OpsReq) {
    return this.o.run(r, (c) => ops.today(c.db, c.session));
  }
  @Get("admin/clients/:id")
  @Route({ auth: SMR, permission: "clp.profiles.read" })
  client(@Param("id") id: string) {
    return this.o.read((db) => ops.clientDetail(db, id));
  }
  /** Staff bell feed: the shared notifications store, staff side. */
  @Get("ops/x/notifications")
  @Route({ auth: SMR })
  async bell(@Req() r: OpsReq) {
    const n = await this.notifications.list(r.user.id, { limit: 30 });
    return {
      items: n.notifications.map((x) => ({
        id: x.id,
        kind: x.kind,
        text: x.title,
        href: x.href,
        at: x.created_at,
        read: !!x.read_at,
      })),
    };
  }

  // ── lane A: intake ──
  @Get("admin/ops/intake/pulse")
  @Route({ auth: SM })
  pulse() {
    return this.o.read((db) => ops.intakePulse(db));
  }
  @Get("admin/ops/needs-you")
  @Route({ auth: SMR })
  needsYou() {
    return this.o.read((db) => ops.needsYou(db));
  }
  @Get(`${A}/recent-events`)
  @Route({ auth: SMR, permission: "req.case.read" })
  recent(@Param("code") code: string) {
    return this.o.read((db) => ops.recentEvents(db, code));
  }
  @Get(`${A}/duplicates`)
  @Route({ auth: SM, permission: "req.intake.review" })
  duplicates(@Param("code") code: string) {
    return this.o.read((db) => ops.duplicates(db, code));
  }
  @Post(`${A}/duplicate`)
  @Route({
    auth: SM,
    permission: "req.intake.review",
    idempotent: true,
    audit: "case.duplicate_resolved",
  })
  duplicate(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: DuplicateDto,
  ) {
    return this.o.run(r, (c) => ops.resolveDuplicate(c, code, b));
  }
  @Post(`${A}/revert`)
  @Route({
    auth: SM,
    permission: "req.status.update",
    audit: "case.status_undone",
  })
  revert(@Req() r: OpsReq, @Param("code") code: string) {
    return this.o.run(r, (c) => ops.revert(c, code));
  }
  @Post(`${A}/nudge`)
  @Route({ auth: SM, limit: "write" })
  nudge(@Req() r: OpsReq, @Param("code") code: string) {
    return this.o.run(r, (c) => ops.nudge(c, code));
  }
  @Get("admin/ops/views")
  @Route({ auth: SMR })
  views(@Req() r: OpsReq) {
    return this.o.run(r, (c) => ops.listViews(c.db, c.session));
  }
  @Post("admin/ops/views")
  @Route({ auth: SMR })
  createView(@Req() r: OpsReq, @Body() b: ViewDto) {
    return this.o.run(r, (c) => ops.createView(c.db, c.session, b));
  }
  @Delete("admin/ops/views/:id")
  @Route({ auth: SMR })
  deleteView(@Req() r: OpsReq, @Param("id") id: string) {
    return this.o.run(r, (c) => ops.deleteView(c.db, c.session, id));
  }

  // ── lane B: case record ──
  @Get(`${A}/record`)
  @Route({ auth: SMR, permission: "req.case.read" })
  record(@Param("code") code: string) {
    return this.o.read((db) => ops.record(db, code));
  }
  @Post(`${A}/documents/:doc/decision`)
  @Route({
    auth: SM,
    permission: "doc.case.qc",
    audit: "case.document_decided",
  })
  docDecision(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Param("doc") doc: string,
    @Body() b: DocDecisionDto,
  ) {
    return this.o.run(r, (c) => ops.docDecision(c, code, doc, b));
  }
  @Post(`${A}/checklist/complete`)
  @Route({ auth: SM, permission: "req.intake.review" })
  checklist(@Req() r: OpsReq, @Param("code") code: string) {
    return this.o.run(r, (c) => ops.checklistComplete(c, code));
  }
  @Post(`${A}/document-request`)
  @Route({
    auth: SM,
    permission: "req.status.update",
    idempotent: true,
    audit: "case.documents_requested",
  })
  docRequest(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: DocRequestDto,
  ) {
    return this.o.run(r, (c) => ops.documentRequest(c, code, b));
  }
  @Post(`${A}/quotation`)
  @Route({
    auth: SM,
    permission: "fin.quote.send",
    idempotent: true,
    audit: "case.quote_sent",
  })
  quotation(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: QuotationDto,
  ) {
    return this.o.run(r, (c) => ops.quotation(c, code, b));
  }
  @Get(`${A}/timeline`)
  @Route({ auth: SMR, permission: "req.case.read" })
  timeline(@Param("code") code: string) {
    return this.o.read((db) => ops.timeline(db, code));
  }
  @Post(`${A}/view-as`)
  @Route({ auth: SM, audit: "view_as.start" })
  viewAs(@Req() r: OpsReq, @Param("code") code: string, @Body() b: ViewAsDto) {
    return this.o.run(r, (c) => ops.viewAs(c, code, b));
  }
  @Post(`${A}/notes`)
  @Route({ auth: SM })
  note(@Req() r: OpsReq, @Param("code") code: string, @Body() b: NoteDto) {
    return this.o.run(r, (c) => ops.addNote(c, code, b.body));
  }
  @Get("admin/audit-log")
  @Route({ auth: [...SMR, "staff:sysadmin"], permission: "aud.read" })
  auditLog(@Query() q: EntityQueryDto) {
    return this.o.read((db) => ops.auditLogFor(db, q.entity));
  }
  @Get("admin/ops/audit/:kind/:id")
  @Route({ auth: [...SMR, "staff:sysadmin"], permission: "aud.read" })
  auditItems(@Param("kind") kind: string, @Param("id") id: string) {
    return this.o.read((db) => ops.auditItems(db, kind, id));
  }
}
