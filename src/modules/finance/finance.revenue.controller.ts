// Revenue recognition (allocations, effective-dated rules with executive deviation, four-eyes adjustments, agent
// fees — U13) and payout batches (preview → draft → submit → authorise → execute → paid → close — U14).
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import { Route } from "../../core/http/route";
import { notFound } from "../../core/http/errors";
import * as rev from "./finance.revenue";
import { AcceptedInterceptor, FinRunner } from "./finance.runner";
import * as D from "./finance.dto";

const FIN_ALLOC = ["query", "hold", "void", "release", "answer"] as const;
const DECISIONS = ["approve", "reject"] as const;

@Controller("finance")
@UseInterceptors(AcceptedInterceptor)
export class FinanceRevenueController {
  constructor(private readonly r: FinRunner) {}

  // ---- allocations
  @Get("revenue/allocations")
  @Route({ auth: D.FINX })
  allocations(@Query() q: D.AllocationsQueryDto) {
    return this.r.read((f) => rev.listAllocations(f, q));
  }
  @Post("revenue/allocations/bulk-approve")
  @Route({ auth: D.FINX, ...D.W })
  bulkApprove(@Body() b: D.IdsDto) {
    return this.r.write((f) => rev.bulkApprove(f, b));
  }
  @Post("revenue/allocations/:id/approve")
  @Route({ auth: D.FINX, ...D.W })
  approveAlloc(@Param("id") id: string, @Body() b: D.AllocActionDto) {
    return this.r.write((f) => rev.allocationAction(f, id, "approve", b));
  }
  /** query | hold | void | release | answer */
  @Post("revenue/allocations/:id/:action")
  @Route({ auth: D.FIN, ...D.W })
  allocAction(
    @Param("id") id: string,
    @Param("action") action: string,
    @Body() b: D.AllocActionDto,
  ) {
    const a = FIN_ALLOC.find((x) => x === action);
    if (!a) throw notFound("Action");
    return this.r.write((f) => rev.allocationAction(f, id, a, b));
  }

  // ---- rules
  @Get("revenue/rules/preview")
  @Route({ auth: D.FINX })
  previewRule(@Query() q: D.RulePreviewQueryDto) {
    return this.r.read((f) => rev.previewRule(f, q));
  }
  @Get("revenue/rules")
  @Route({ auth: D.FINX })
  rules() {
    return this.r.read((f) => rev.listRules(f));
  }
  @Post("revenue/rules")
  @Route({ auth: D.FIN, ...D.W })
  createRule(@Body() b: D.NewRuleDto) {
    return this.r.write((f) => rev.createRule(f, b));
  }
  @Patch("revenue/rules/:id")
  @Route({ auth: D.FIN, ...D.W })
  endRule(@Param("id") id: string, @Body() b: D.EndRuleDto) {
    return this.r.write((f) => rev.endRule(f, id, { ...b }));
  }
  /** approve | reject (executive deviation) */
  @Post("revenue/rules/:id/:decision")
  @Route({ auth: D.EXEC, stepUp: true, ...D.W })
  decideRule(
    @Param("id") id: string,
    @Param("decision") decision: string,
    @Body() b: D.ReasonDto,
  ) {
    const d = DECISIONS.find((x) => x === decision);
    if (!d) throw notFound("Action");
    return this.r.write((f) => rev.decideRule(f, id, d, b));
  }

  // ---- adjustments + fees
  @Get("revenue/adjustments")
  @Route({ auth: D.FINX })
  adjustments() {
    return this.r.read((f) => rev.listAdjustments(f));
  }
  @Post("revenue/adjustments")
  @Route({ auth: D.FIN, ...D.W })
  createAdjustment(@Body() b: D.NewAdjustmentDto) {
    return this.r.write((f) => rev.createAdjustment(f, b));
  }
  @Post("revenue/adjustments/:id/approve")
  @Route({ auth: D.FINX, stepUp: true, ...D.W })
  approveAdjustment(@Param("id") id: string) {
    return this.r.write((f) => rev.approveAdjustment(f, id));
  }
  @Get("revenue/fees")
  @Route({ auth: D.FINX })
  fees() {
    return this.r.read((f) => rev.listFees(f));
  }
  @Post("revenue/fees")
  @Route({ auth: D.FIN, ...D.W })
  createFee(@Body() b: D.NewFeeDto) {
    return this.r.write((f) => rev.createFee(f, b));
  }
  @Post("revenue/fees/:id/waive")
  @Route({ auth: D.FIN, ...D.W })
  waiveFee(@Param("id") id: string, @Body() b: D.ReasonDto) {
    return this.r.write((f) => rev.waiveFee(f, id, b));
  }
  @Get("revenue/x/agent/:workerId")
  @Route({ auth: D.FINX })
  agent(@Param("workerId") id: string) {
    return this.r.read((f) => rev.agentMoney(f, id));
  }

  // ---- payouts
  @Get("payouts/batches")
  @Route({ auth: D.FINX })
  batches() {
    return this.r.read((f) => rev.listBatches(f));
  }
  @Get("payouts/preview")
  @Route({ auth: D.FINX })
  preview(@Query() q: D.PreviewQueryDto) {
    return this.r.read((f) => rev.previewBatch(f, q));
  }
  @Get("payouts/batches/:no")
  @Route({ auth: D.FINX })
  batch(@Param("no") no: string) {
    return this.r.read((f) => rev.getBatch(f, no));
  }
  @Get("payouts/batches/:no/export")
  @Route({ auth: D.FINX })
  export(@Param("no") no: string, @Query() q: D.ExportQueryDto) {
    return this.r.write((f) => rev.exportBatch(f, no, q.format));
  }
  @Post("payouts/batches")
  @Route({ auth: D.FIN, ...D.W })
  createBatch(@Body() b: D.NewBatchDto) {
    return this.r.write((f) => rev.createBatch(f, b));
  }
  @Post("payouts/batches/:no/submit")
  @Route({ auth: D.FIN, ...D.W })
  submit(@Param("no") no: string, @Body() b: D.RevOnlyReasonDto) {
    return this.r.write((f) => rev.batchAction(f, no, "submit", b));
  }
  @Post("payouts/batches/:no/authorise")
  @Route({ auth: D.FINX, stepUp: true, ...D.W })
  authorise(@Param("no") no: string, @Body() b: D.RevOnlyReasonDto) {
    return this.r.write((f) => rev.batchAction(f, no, "authorise", b));
  }
  @Post("payouts/batches/:no/reject")
  @Route({ auth: D.FINX, ...D.W })
  rejectBatch(@Param("no") no: string, @Body() b: D.RevOnlyReasonDto) {
    return this.r.write((f) => rev.batchAction(f, no, "reject", b));
  }
  /** Money leaves: step-up (reference had none; payouts are in the STEP_UP set). */
  @Post("payouts/batches/:no/execute")
  @Route({ auth: D.FIN, stepUp: true, ...D.W })
  execute(@Param("no") no: string, @Body() b: D.RevOnlyReasonDto) {
    return this.r.write((f) => rev.batchAction(f, no, "execute", b));
  }
  @Post("payouts/batches/:no/close")
  @Route({ auth: D.FIN, ...D.W })
  closeBatch(@Param("no") no: string, @Body() b: D.RevOnlyReasonDto) {
    return this.r.write((f) => rev.batchAction(f, no, "close", b));
  }
  @Post("payouts/lines/:id/exclude")
  @Route({ auth: D.FIN, ...D.W })
  exclude(@Param("id") id: string, @Body() b: D.PayoutLineDto) {
    return this.r.write((f) => rev.lineAction(f, id, "exclude", b));
  }
  @Post("payouts/lines/:id/paid")
  @Route({ auth: D.FIN, stepUp: true, ...D.W })
  paid(@Param("id") id: string, @Body() b: D.PayoutLineDto) {
    return this.r.write((f) => rev.lineAction(f, id, "paid", b));
  }
  @Post("payouts/lines/:id/failed")
  @Route({ auth: D.FIN, ...D.W })
  failed(@Param("id") id: string, @Body() b: D.PayoutLineDto) {
    return this.r.write((f) => rev.lineAction(f, id, "failed", b));
  }
}
