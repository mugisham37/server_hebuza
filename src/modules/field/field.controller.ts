// Field routes (reference field.routes.ts, 46 routes): agent side under /api/field + /api/x_field, office queues,
// finance cash confirm and the case "request a visit". Agent writes are idempotent (Idempotency-Key + client_op_id).
import { Body, Controller, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { AppError } from "../../core/http/errors";
import { Route } from "../../core/http/route";
import * as D from "./field.dto";
import { FieldService } from "./field.service";

const AGENT_WRITE = { auth: D.FIELD, idempotent: true, limit: "write" } as const;
const redirect = (reply: FastifyReply, url: string) => reply.status(302).header("location", url).header("cache-control", "no-store").send();

@Controller()
export class FieldController {
  constructor(private readonly svc: FieldService) {}

  // ── agent side
  @Get("x_field/me") @Route({ auth: D.FIELD }) me() { return this.svc.me(); }
  @Get("field/visits") @Route({ auth: D.FIELD }) visits(@Query() q: D.DateQ) { return this.svc.dayPlan(q.date); }
  @Get("x_field/visits/:id") @Route({ auth: D.FIELD }) visit(@Param("id") id: string) { return this.svc.getVisit(id); }
  @Get("x_field/prepare") @Route({ auth: D.FIELD }) prepare(@Query() q: D.DateQ) { return this.svc.prepare(q.date); }

  @Post("x_field/visits/:id/accept") @Route(AGENT_WRITE) accept(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.accept(id, b); }
  @Post("x_field/visits/:id/decline") @Route({ auth: D.FIELD, limit: "write" }) decline(@Param("id") id: string, @Body() b: D.DeclineDto) { return this.svc.decline(id, b); }
  @Post("field/visits/:id/checkin") @Route(AGENT_WRITE) checkin(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.checkin(id, b); }
  @Patch("x_field/visits/:id/work") @Route(AGENT_WRITE) work(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.work(id, b); }
  @Post("field/visits/:id/checkout") @Route(AGENT_WRITE) checkout(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.checkout(id, b); }

  @Post("x_field/visits/:id/scans") @Route({ ...AGENT_WRITE, status: 201 }) scan(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.uploadScan(id, b); }
  @Get("x_field/visits/:id/scans") @Route({ auth: D.FIELD }) scans(@Param("id") id: string) { return this.svc.listScans(id); }
  @Get("x_field/scans/:id/pdf") @Route({ auth: D.FIELD }) @RawResponse()
  async scanPdf(@Param("id") id: string, @Res() reply: FastifyReply) { return redirect(reply, await this.svc.scanPdf(id)); }

  @Post("field/visits/:id/receipts") @Route({ ...AGENT_WRITE, status: 201 }) receipt(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.createReceipt(id, b); }
  @Get("x_field/visits/:id/receipts") @Route({ auth: D.FIELD }) receipts(@Param("id") id: string) { return this.svc.listReceipts(id); }
  @Get("x_field/receipts/:id/pdf") @Route({ auth: D.FIELD }) @RawResponse()
  async receiptPdf(@Param("id") id: string, @Res() reply: FastifyReply) { return redirect(reply, await this.svc.receiptPdf(id)); }
  @Patch("x_field/receipts/:id") @Route({ auth: D.FIELD })
  receiptImmutable(): never { throw new AppError(409, "receipt_immutable", "Signed receipts can't be changed. Correct with a new receipt."); }

  @Post("x_field/visits/:id/custody") @Route(AGENT_WRITE) custody(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.custody(id, b); }
  @Get("x_field/visits/:id/custody") @Route({ auth: D.FIELD }) custodyList(@Param("id") id: string) { return this.svc.listCustody(id); }
  @Post("x_field/visits/:id/incidents") @Route({ ...AGENT_WRITE, status: 201 }) incident(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.incident(id, b); }

  @Get("x_field/visits/:id/invoices") @Route({ auth: D.FIELD }) invoices(@Param("id") id: string) { return this.svc.invoices(id); }
  @Post("x_field/visits/:id/momo") @Route({ auth: D.FIELD, limit: "write", idempotent: true, status: 201 }) momo(@Param("id") id: string, @Body() b: D.MomoDto) { return this.svc.startMomo(id, b); }
  @Get("x_field/payments/:id") @Route({ auth: D.FIELD }) momoStatus(@Param("id") id: string) { return this.svc.momoStatus(id); }
  @Post("x_field/payments/:id/cancel") @Route({ auth: D.FIELD }) momoCancel(@Param("id") id: string) { return this.svc.cancelMomo(id); }

  @Post("x_field/visits/:id/otp") @Route({ auth: D.FIELD, limit: "auth" }) otp(@Param("id") id: string) { return this.svc.sendOtp(id); }
  @Post("x_field/visits/:id/otp/verify") @Route({ auth: D.FIELD, limit: "auth" }) otpVerify(@Param("id") id: string, @Body() b: D.OtpVerifyDto) { return this.svc.verifyOtp(id, b.code); }

  @Post("field/visits/:id/cash") @Route({ ...AGENT_WRITE, status: 201 }) cash(@Param("id") id: string, @Body() b: D.AnyDto) { return this.svc.recordCash(id, b); }
  @Post("x_field/cash/:ref/deposit") @Route(AGENT_WRITE) deposit(@Param("ref") ref: string, @Body() b: D.AnyDto) { return this.svc.depositCash(ref, b); }
  @Get("x_field/cash") @Route({ auth: D.FIELD }) cashList() { return this.svc.listCash(); }

  @Get("x_field/expenses") @Route({ auth: D.FIELD }) expenses() { return this.svc.myExpenses(); }
  @Post("x_field/expenses") @Route({ ...AGENT_WRITE, status: 201 }) expense(@Body() b: D.AnyDto) { return this.svc.createExpense(b); }
  @Post("x_field/expenses/:id/withdraw") @Route({ auth: D.FIELD, limit: "write" }) withdraw(@Param("id") id: string) { return this.svc.withdrawExpense(id); }

  @Get("x_field/earnings") @Route({ auth: D.FIELD }) earnings(@Query() q: D.EarningsQ) { return this.svc.earnings(q.month ?? new Date().toISOString().slice(0, 7)); }

  @Get("x_field/conflicts") @Route({ auth: D.SM }) conflicts(@Query() q: D.ConflictsQ) { return this.svc.listConflicts(q.status); }
  @Post("x_field/conflicts/:opId/resolve") @Route({ auth: D.FIELD, limit: "write" }) resolve(@Param("opId") opId: string, @Body() b: D.ResolveDto) { return this.svc.resolveConflict(opId, b); }

  @Get("x_field/media") @Route({ auth: D.FIELD }) @RawResponse()
  async media(@Query() q: D.MediaQ, @Res() reply: FastifyReply) { return redirect(reply, await this.svc.media(q.key)); }

  // ── office side (SM + finance)
  @Get("x_field/ops/queue") @Route({ auth: D.OFFICE }) queue(@Query() q: D.QueueQ) { return this.svc.opsQueue(q.tab); }
  @Post("x_field/ops/flags/:visitId/review") @Route({ auth: D.SM, audit: "field.flags.reviewed" }) review(@Param("visitId") visitId: string) { return this.svc.reviewFlags(visitId); }
  @Post("x_field/ops/custody/:ref/receive") @Route({ auth: D.SM }) receive(@Param("ref") ref: string) { return this.svc.receiveCustody(ref); }
  @Post("x_field/ops/agents/:userId/revoke") @Route({ auth: D.SM }) revoke(@Param("userId") userId: string, @Body() b: D.RevokeDto) { return this.svc.revoke(userId, b.on); }
  @Get("x_field/ops/visits/:id/evidence") @Route({ auth: D.EVIDENCE }) evidence(@Param("id") id: string) { return this.svc.evidence(id); }
  @Get("x_field/ops/case/:ref/visits") @Route({ auth: D.EVIDENCE }) caseVisits(@Param("ref") ref: string) { return this.svc.caseVisits(ref); }
  @Get("x_field/approvals/expenses") @Route({ auth: D.OFFICE }) approvals(@Query() q: D.LevelQ) { return this.svc.approvalQueue(Number(q.level) as 1 | 2); }
  @Post("x_field/expenses/:id/decision") @Route({ auth: D.OFFICE, limit: "write", idempotent: true }) decide(@Param("id") id: string, @Body() b: D.DecisionDto) { return this.svc.decide(id, b); }
  @Get("x_field/finance/cash") @Route({ auth: D.FIN }) financeCash() { return this.svc.financeCash(); }
  @Post("finance/cash/:id/confirm") @Route({ auth: D.FIN, limit: "write", idempotent: true }) confirm(@Param("id") id: string, @Body() b: D.ConfirmCashDto) { return this.svc.confirmCash(id, b); }
  @Post("staff/cases/:code/visits") @Route({ auth: D.REQUESTERS, limit: "write", idempotent: true, status: 201 })
  createVisit(@Param("code") code: string, @Body() b: D.CreateVisitDto) { return this.svc.createVisit(code, b); }
}
