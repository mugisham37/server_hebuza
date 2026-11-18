// Oversight (reference lanes C/D): workload + capacity, workforce approvals, SLA, deliverable reviews, tickets.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { Route } from "../../core/http/route";
import * as m from "./ops.manage";
import { OpsRunner, Req, type OpsReq } from "./ops.runner";
import { SM, SMR } from "./ops.roles";
import {
  AllocationDto,
  ApprovalDecisionDto,
  CapDto,
  DueDto,
  EscalateDto,
  RebalanceDto,
  ReviewCommentDto,
  ReviewDecisionDto,
  ReviewOverrideDto,
  TabQueryDto,
  TicketActionDto,
  TicketDto,
  TicketsQueryDto,
  WeekQueryDto,
} from "./ops.dto";

@Controller()
export class OpsOversightController {
  constructor(private readonly o: OpsRunner) {}

  @Get("admin/ops/workload")
  @Route({ auth: SMR, permission: "asn.workload.read" })
  workload(@Query() q: WeekQueryDto) {
    return this.o.read((db) => m.workload(db, q.week ?? 0));
  }
  @Get("admin/ops/workload/:id")
  @Route({ auth: SMR, permission: "asn.workload.read" })
  workloadOf(@Param("id") id: string) {
    return this.o.read((db) => m.workloadOf(db, id));
  }
  @Patch("admin/agents/:id/settings")
  @Route({ auth: SM, stepUp: true, audit: "capacity_cap.change" })
  cap(@Req() r: OpsReq, @Param("id") id: string, @Body() b: CapDto) {
    return this.o.run(r, (c) => m.setCap(c, id, b));
  }
  @Post("admin/ops/rebalance")
  @Route({
    auth: SM,
    permission: "asn.assign",
    idempotent: true,
    audit: "workload.rebalanced",
  })
  rebalance(@Req() r: OpsReq, @Body() b: RebalanceDto) {
    return this.o.run(r, (c) => m.rebalance(c, b));
  }
  @Get("admin/ops/approvals")
  @Route({ auth: SMR })
  approvals() {
    return this.o.read((db) => m.listApprovals(db));
  }
  @Post("admin/ops/approvals/:id")
  @Route({ auth: SM, audit: "workforce.approval_decided" })
  decide(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: ApprovalDecisionDto,
  ) {
    return this.o.run(r, (c) => m.decideApproval(c, id, b.decision));
  }
  @Get("admin/ops/sla/health")
  @Route({ auth: SMR, permission: "rpt.operations" })
  slaHealth() {
    return this.o.read((db) => m.slaHealth(db));
  }
  @Get("admin/ops/sla/rules")
  @Route({ auth: SMR })
  slaRules() {
    return this.o.read((db) => m.slaRules(db));
  }
  @Patch("admin/applications/:code/due")
  @Route({ auth: SM, audit: "case.due_changed" })
  due(@Req() r: OpsReq, @Param("code") code: string, @Body() b: DueDto) {
    return this.o.run(r, (c) => m.setDue(c, code, b));
  }
  @Patch("admin/oversight/cases/:code/escalate")
  @Route({ auth: SMR, audit: "case.escalated" })
  escalate(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: EscalateDto,
  ) {
    return this.o.run(r, (c) => m.escalate(c, code, b ?? {}));
  }

  // ── reviews ──
  @Get("admin/ops/reviews")
  @Route({ auth: SMR, permission: "dlv.review" })
  reviews(@Query() q: TabQueryDto) {
    return this.o.read((db) => m.listReviews(db, q.tab ?? "mine"));
  }
  @Get("admin/ops/reviews/:id")
  @Route({ auth: SMR, permission: "dlv.review" })
  review(@Req() r: OpsReq, @Param("id") id: string) {
    return this.o.run(r, (c) => m.reviewDetail(c.db, c.session, id));
  }
  @Post("admin/ops/reviews/:id/comments")
  @Route({ auth: SM, permission: "dlv.review" })
  comment(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: ReviewCommentDto,
  ) {
    return this.o.run(r, (c) => m.reviewComment(c, id, b));
  }
  @Post("admin/ops/reviews/:id/decision")
  @Route({
    auth: SM,
    permission: "dlv.review",
    idempotent: true,
    audit: "review.decided",
  })
  async reviewDecision(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: ReviewDecisionDto,
  ) {
    return (await this.o.run(r, (c) => m.reviewDecision(c, id, b))).item;
  }
  @Post("admin/ops/reviews/:id/override")
  @Route({ auth: SM, stepUp: true, audit: "payment_gate.override" })
  reviewOverride(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: ReviewOverrideDto,
  ) {
    return this.o.run(r, (c) => m.reviewOverride(c, id, b));
  }
  @Post("admin/ops/reviews/:id/second-approval")
  @Route({ auth: SM, permission: "dlv.review" })
  second(@Req() r: OpsReq, @Param("id") id: string) {
    return this.o.run(r, (c) => m.requestSecond(c, id));
  }
  @Post("admin/ops/reviews/:id/second-approve")
  @Route({ auth: SMR, audit: "review.second_approve" })
  secondApprove(@Req() r: OpsReq, @Param("id") id: string) {
    return this.o.run(r, (c) => m.secondApprove(c, id));
  }
  @Post("admin/ops/reviews/:id/allocation")
  @Route({
    auth: SM,
    permission: "rev.allocations.review",
    audit: "allocation.review",
  })
  allocation(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: AllocationDto,
  ) {
    return this.o.run(r, (c) => m.reviewAllocation(c, id, b));
  }

  // ── tickets ──
  @Get("admin/ops/tickets")
  @Route({ auth: SMR, permission: "fbk.ticket.read" })
  tickets(@Query() q: TicketsQueryDto) {
    return this.o.read((db) => m.listTickets(db, q.tab ?? "complaints"));
  }
  @Post("admin/ops/tickets")
  @Route({
    auth: SM,
    permission: "fbk.ticket.create",
    idempotent: true,
    audit: "ticket.opened",
  })
  async open(@Req() r: OpsReq, @Body() b: TicketDto) {
    return {
      ref: (await this.o.run(r, (c) => m.openTicket(c.db, c.session, b))).ref,
    };
  }
  @Get("admin/ops/tickets/:ref")
  @Route({ auth: SMR, permission: "fbk.ticket.read" })
  ticket(@Param("ref") ref: string) {
    return this.o.read((db) => m.ticketDetail(db, ref));
  }
  @Post("admin/ops/tickets/:ref/actions")
  @Route({
    auth: SM,
    permission: "fbk.ticket.resolve",
    idempotent: true,
    audit: "ticket.action",
  })
  action(
    @Req() r: OpsReq,
    @Param("ref") ref: string,
    @Body() b: TicketActionDto,
  ) {
    return this.o.run(r, (c) => m.ticketAction(c, ref, b, c.stepUp));
  }
}
