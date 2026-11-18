// Assignment (reference caseRoutes assign/suggestions/agents + lane B assign flow): ranking, terms, offers,
// reassign, per-service auto-assign rules.
import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { Route } from "../../core/http/route";
import * as ops from "./ops.cases";
import { agentsAll } from "./lib/store";
import { OpsRunner, Req, type OpsReq } from "./ops.runner";
import { SM, SMR } from "./ops.roles";
import {
  AssignDto,
  AutoAssignDto,
  BriefDto,
  ExternalQueryDto,
  OfferDto,
  OverrideAssignDto,
  ReassignDto,
  ScopeDto,
  TermsDto,
} from "./ops.dto";

const A = "admin/applications/:code";

@Controller()
export class OpsAssignController {
  constructor(private readonly o: OpsRunner) {}

  @Post(`${A}/assign`)
  @Route({
    auth: SM,
    permission: "asn.assign",
    idempotent: true,
    audit: "case.assigned",
    emit: "case.updated",
  })
  assign(@Req() r: OpsReq, @Param("code") code: string, @Body() b: AssignDto) {
    return this.o.run(r, (c) => ops.assign(c, code, b));
  }
  @Get(`${A}/suggestions`)
  @Route({ auth: SM, permission: "asn.assign" })
  suggestions(@Param("code") code: string, @Query() q: ExternalQueryDto) {
    return this.o.read((db) => ops.suggestions(db, code, q.external === "1"));
  }
  @Get("admin/agents")
  @Route({ auth: SMR, permission: "asn.workload.read" })
  async agents() {
    return { agents: await this.o.read((db) => agentsAll(db)) };
  }
  @Get(`${A}/assign-context`)
  @Route({ auth: SM, permission: "asn.assign" })
  context(@Param("code") code: string) {
    return this.o.read((db) => ops.assignContext(db, code));
  }
  @Post(`${A}/assignment`)
  @Route({ auth: SM, permission: "asn.assign", audit: "case.assignment_terms" })
  terms(@Req() r: OpsReq, @Param("code") code: string, @Body() b: TermsDto) {
    return this.o.run(r, (c) => ops.saveTerms(c, code, b));
  }
  @Post(`${A}/assign-override`)
  @Route({ auth: SM, permission: "asn.assign", audit: "case.assign_override" })
  override(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: OverrideAssignDto,
  ) {
    return this.o.run(r, (c) => ops.assignOverride(c, code, b));
  }
  @Get(`${A}/brief`)
  @Route({ auth: SM })
  brief(@Param("code") code: string) {
    return this.o.read((db) => ops.getBrief(db, code));
  }
  @Put(`${A}/brief`)
  @Route({ auth: SM })
  putBrief(@Req() r: OpsReq, @Param("code") code: string, @Body() b: BriefDto) {
    return this.o.run(r, (c) => ops.putBrief(c, code, b));
  }
  @Get(`${A}/scope`)
  @Route({ auth: SM })
  scope(@Param("code") code: string) {
    return this.o.read((db) => ops.getScope(db, code));
  }
  @Put(`${A}/scope`)
  @Route({ auth: SM, audit: "case.scope_saved" })
  putScope(@Req() r: OpsReq, @Param("code") code: string, @Body() b: ScopeDto) {
    return this.o.run(r, (c) => ops.putScope(c, code, b.scope));
  }
  @Get(`${A}/offers`)
  @Route({ auth: SM })
  offers(@Param("code") code: string) {
    return this.o.read((db) => ops.listOffers(db, code));
  }
  @Post(`${A}/offers`)
  @Route({
    auth: SM,
    permission: "asn.assign",
    idempotent: true,
    audit: "case.offer_sent",
  })
  offer(@Req() r: OpsReq, @Param("code") code: string, @Body() b: OfferDto) {
    return this.o.run(r, (c) =>
      ops.sendOffer(c, code, b.agent_id, b.ttl_minutes),
    );
  }
  @Post(`${A}/reassign`)
  @Route({
    auth: SM,
    permission: "asn.assign",
    idempotent: true,
    audit: "case.reassigned",
  })
  reassign(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: ReassignDto,
  ) {
    return this.o.run(r, (c) => ops.reassign(c, code, b));
  }
  @Get("admin/services/:slug/auto-assign")
  @Route({ auth: SM })
  autoAssign(@Param("slug") slug: string) {
    return this.o.read((db) => ops.getAutoAssign(db, slug));
  }
  @Put("admin/services/:slug/auto-assign")
  @Route({
    auth: SM,
    permission: "asn.assign",
    audit: "service.auto_assign_rules",
  })
  putAutoAssign(
    @Req() r: OpsReq,
    @Param("slug") slug: string,
    @Body() b: AutoAssignDto,
  ) {
    return this.o.run(r, (c) => ops.putAutoAssign(c, slug, b));
  }
}
