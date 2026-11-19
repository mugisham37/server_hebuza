// PRT routes (spec institutional-partners §11). Partner managers write; executives read; finance decides commissions.
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Route } from "../../core/http/route";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { AppError } from "../../core/http/errors";
import { CHILDREN, PartnersService, type ChildKind } from "./partners.service";
import * as D from "./partners.dto";

const PM = ["staff:partner_manager"] as const;
const READ = ["staff:partner_manager", "staff:executive"] as const;
const FIN = ["staff:finance", "staff:executive"] as const;
const B = "staff/partners";

/** Validates the child kind + body against its schema (the route is generic over kinds). */
function child(kind: string, body: unknown, partial: boolean) {
  if (!(kind in CHILDREN)) throw new AppError(404, "not_found", "Not found.");
  const schema = D.CHILD_IN[kind as ChildKind];
  const r = (partial ? schema.partial() : schema).safeParse(body);
  if (!r.success) throw new AppError(422, "validation", "Check the highlighted fields.", Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message])));
  return { kind: kind as ChildKind, data: r.data as Record<string, unknown> };
}

@Controller()
export class PartnersController {
  constructor(private readonly svc: PartnersService) {}

  @Get("public/partners") @Route({ auth: "public", limit: "read" })
  publicList() { return this.svc.publicList(); }

  @Get(`${B}/commissions`) @Route({ auth: [...FIN, "staff:partner_manager"] })
  commissions(@Query() q: D.CommissionQueryDto) { return this.svc.commissions(q.status); }

  @Post(`${B}/commissions/:id/decision`) @Route({ auth: ["staff:finance"], limit: "write" })
  decide(@Param("id") id: string, @Body() b: D.CommissionDecisionDto, @CurrentUser() me: SessionUser) { return this.svc.decideCommission(me, id, b); }

  @Get(B) @Route({ auth: READ })
  list(@Query() q: D.PartnerQueryDto) { return this.svc.list(q); }

  @Post(B) @Route({ auth: PM, limit: "write" })
  create(@Body() b: D.PartnerDto, @CurrentUser() me: SessionUser) { return this.svc.create(me, b); }

  @Get(`${B}/:id`) @Route({ auth: READ })
  detail(@Param("id") id: string, @CurrentUser() me: SessionUser) { return this.svc.detail(me, id); }

  @Patch(`${B}/:id`) @Route({ auth: PM, limit: "write" })
  update(@Param("id") id: string, @Body() b: D.PartnerPatchDto) { return this.svc.update(id, b); }

  @Post(`${B}/:id/archive`) @Route({ auth: PM, limit: "write", audit: "partner.archived" })
  archive(@Param("id") id: string) { return this.svc.update(id, { status: "archived" }); }

  @Get(`${B}/:id/history`) @Route({ auth: READ })
  history(@Param("id") id: string) { return this.svc.history(id); }

  @Get(`${B}/:id/meetings/:mid/event.ics`) @Route({ auth: READ }) @RawResponse()
  async ics(@Param("id") id: string, @Param("mid") mid: string, @Res() reply: FastifyReply) {
    const body = await this.svc.ics(id, mid);
    return reply.header("content-type", "text/calendar; charset=utf-8").header("content-disposition", `attachment; filename="meeting-${mid}.ics"`).send(body);
  }

  @Post(`${B}/:id/meetings/:mid/decisions/to-action`) @Route({ auth: PM, limit: "write" })
  toAction(@Param("id") id: string, @Param("mid") mid: string, @Body() b: D.DecisionToActionDto) { return this.svc.decisionToAction(id, mid, b); }

  @Post(`${B}/:id/:kind`) @Route({ auth: PM, limit: "write" })
  add(@Param("id") id: string, @Param("kind") kind: string, @Body() b: D.ChildDto) { const c = child(kind, b, false); return this.svc.addChild(id, c.kind, c.data); }

  @Patch(`${B}/:id/:kind/:cid`) @Route({ auth: PM, limit: "write" })
  edit(@Param("id") id: string, @Param("kind") kind: string, @Param("cid") cid: string, @Body() b: D.ChildDto) { const c = child(kind, b, true); return this.svc.updateChild(id, c.kind, cid, c.data); }

  @Delete(`${B}/:id/:kind/:cid`) @Route({ auth: PM, limit: "write" })
  remove(@Param("id") id: string, @Param("kind") kind: string, @Param("cid") cid: string) { const c = child(kind, {}, true); return this.svc.removeChild(id, c.kind, cid); }
}
