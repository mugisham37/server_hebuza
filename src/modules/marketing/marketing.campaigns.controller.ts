// Segments, campaigns, budget, message templates, sequences (reference marketing.routes).
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { Route, IfMatch } from "../../core/http/route";
import { AppError } from "../../core/http/errors";
import { Req, type OpsReq } from "../ops/ops.runner";
import * as cmp from "./marketing.campaigns";
import { MarketingRunner } from "./marketing.runner";
import * as D from "./marketing.dto";

const { MKT, MKT_EX, STAFF } = D;
const C = "admin/crm/campaigns";
const A = "admin/crm/automations";
const T = "admin/notification-templates";

@Controller()
export class MarketingCampaignsController {
  private readonly prod: boolean;
  constructor(
    private readonly m: MarketingRunner,
    config: ConfigService<Env, true>,
  ) {
    this.prod = config.get("NODE_ENV", { infer: true }) === "production";
  }

  // ---- segments
  @Get("admin/crm/segments")
  @Route({ auth: MKT_EX })
  segments(@Req() r: OpsReq) {
    return this.m.run(r, (c) => cmp.segments(c));
  }
  @Post("admin/crm/segments/preview")
  @Route({ auth: MKT_EX, limit: "read" })
  preview(@Body() b: D.SegPreviewDto) {
    return this.m.read((db) => cmp.previewSegment(db, b as never));
  }
  @Get("admin/crm/segments/:id")
  @Route({ auth: STAFF })
  segment(@Param("id") id: string) {
    return this.m.read((db) => cmp.segment(db, id));
  }
  @Post("admin/crm/segments")
  @Route({ auth: MKT, audit: "segment.saved" })
  createSegment(@Req() r: OpsReq, @Body() b: D.SegCreateDto) {
    return this.m.run(r, (c) => cmp.createSegment(c, b as never));
  }
  @Patch("admin/crm/segments/:id")
  @Route({ auth: MKT, audit: "segment.saved" })
  patchSegment(@Req() r: OpsReq, @Param("id") id: string, @IfMatch() v: string | null, @Body() b: D.SegPatchDto) {
    return this.m.run(r, (c) => cmp.patchSegment(c, id, v, b as never));
  }
  @Delete("admin/crm/segments/:id")
  @Route({ auth: MKT, audit: "segment.deleted" })
  deleteSegment(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => cmp.deleteSegment(c, id));
  }

  // ---- campaigns
  @Get(C)
  @Route({ auth: MKT_EX })
  campaigns(@Req() r: OpsReq, @Query() q: D.StatusQueryDto) {
    return this.m.run(r, (c) => cmp.campaigns(c, q.status));
  }
  @Post(C)
  @Route({ auth: MKT, audit: "campaign.created" })
  create(@Req() r: OpsReq, @Body() b: D.CampaignDto) {
    return this.m.run(r, (c) => cmp.createCampaign(c, b));
  }
  @Get(`${C}/:id`)
  @Route({ auth: MKT_EX })
  campaign(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => cmp.campaign(c, id));
  }
  @Patch(`${C}/:id`)
  @Route({ auth: MKT })
  patch(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.CampaignDto) {
    return this.m.run(r, (c) => cmp.patchCampaign(c, id, b));
  }
  @Get(`${C}/:id/recipients`)
  @Route({ auth: MKT_EX })
  recipients(@Param("id") id: string, @Query() q: D.StateQueryDto) {
    return this.m.read((db) => cmp.recipients(db, id, q.state));
  }
  @Post(`${C}/:id/recipients/export`)
  @Route({ auth: MKT, limit: "write", audit: "campaign.recipients_exported" })
  exportRecipients(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => cmp.exportRecipients(c, id));
  }
  @Post(`${C}/:id/:action`)
  @Route({ auth: MKT_EX, idempotent: true, emit: "marketing.campaign.changed", audit: "campaign.action" })
  action(@Req() r: OpsReq, @Param("id") id: string, @Param("action") action: string, @Body() b: D.CampaignActionDto) {
    // Executives only approve/reject.
    if (action !== "approve" && action !== "reject" && !r.user.roles.includes("staff:marketing"))
      throw new AppError(403, "forbidden", "You do not have permission to access this resource.");
    return this.m.run(r, (c) => cmp.campaignAction(c, id, action, b));
  }
  @Get("admin/crm/budget")
  @Route({ auth: MKT_EX })
  budget() {
    return this.m.read((db) => cmp.budget(db));
  }

  // ---- templates
  @Get(T)
  @Route({ auth: STAFF })
  templates(@Query() q: D.TemplatesQueryDto) {
    return this.m.read((db) => cmp.templates(db, q));
  }
  @Post(T)
  @Route({ auth: MKT })
  createTemplate(@Req() r: OpsReq, @Body() b: D.TemplateCreateDto) {
    return this.m.run(r, (c) => cmp.createTemplate(c, b));
  }
  @Patch(`${T}/:id`)
  @Route({ auth: MKT })
  patchTemplate(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.TemplatePatchDto) {
    return this.m.run(r, (c) => cmp.patchTemplate(c, id, b));
  }
  @Post(`${T}/:id/submit-provider`)
  @Route({ auth: MKT })
  submitProvider(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => cmp.submitProvider(c, id));
  }
  /** Dev stand-in for Meta's template webhook. */
  @Post(`${T}/:id/simulate`)
  @Route({ auth: MKT })
  simulate(@Param("id") id: string, @Body() b: D.DecisionDto) {
    if (this.prod) throw new AppError(404, "not_found", "Resource not found.");
    return this.m.read((db) => cmp.providerDecision(db, id, b.decision));
  }

  // ---- sequences
  @Get(A)
  @Route({ auth: MKT_EX })
  automations(@Query() q: D.ActiveQueryDto) {
    return this.m.read((db) => cmp.automations(db, !!q.active));
  }
  @Get(`${A}/:id`)
  @Route({ auth: MKT_EX })
  automation(@Param("id") id: string) {
    return this.m.read((db) => cmp.automation(db, id));
  }
  @Get(`${A}/:id/runs`)
  @Route({ auth: MKT_EX })
  runs(@Param("id") id: string) {
    return this.m.read((db) => cmp.runsOf(db, id));
  }
  @Post(A)
  @Route({ auth: MKT })
  createRule(@Req() r: OpsReq, @Body() b: D.RuleDto) {
    return this.m.run(r, (c) => cmp.createRule(c, b as never));
  }
  @Patch(`${A}/:id`)
  @Route({ auth: MKT })
  patchRule(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.RuleDto) {
    return this.m.run(r, (c) => cmp.patchRule(c, id, b as never));
  }
  @Post(`${A}/:id/toggle`)
  @Route({ auth: MKT })
  toggle(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => cmp.toggleRule(c, id));
  }
  @Post(`${A}/:id/enrol`)
  @Route({ auth: MKT })
  enrol(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.EnrolDto) {
    return this.m.run(r, (c) => cmp.enrol(c, id, b.leadIds));
  }
  @Get("admin/crm/inactive-rule")
  @Route({ auth: MKT_EX })
  inactiveRule() {
    return this.m.read((db) => cmp.inactiveRule(db));
  }
}
