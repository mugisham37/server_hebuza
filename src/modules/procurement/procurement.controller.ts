// Procurement HTTP surface (73 reference routes + PO PDF / vendor document file). Role gates mirror the mocks' guard():
// proc = staff:procurement, fin = staff:finance, exec = staff:executive, STAFF = any staff seat except sysadmin.
// Business guards (SoD by user id, limits, step-up for approvals and money, 3-way match) run in the services.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { Role } from "@/domain/auth/roles";
import { Route } from "../../core/http/route";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Proc, ProcurementStore, type RawCaller } from "./procurement.store";
import { EXEC, FIN, PROC, STAFF } from "./procurement.world";
import * as core from "./procurement.service";
import * as vend from "./procurement.vendors";
import * as spend from "./procurement.spend";
import * as bills from "./procurement.bills";
import { statementPdf } from "./procurement.pdf";
import * as D from "./procurement.dto";

const ALL = { auth: [PROC, FIN, EXEC] as Role[] };
const PF: Role[] = [PROC, FIN];
const FE: Role[] = [FIN, EXEC];
const W = (auth: readonly Role[]) => ({ auth, idempotent: true });
const P = "procurement";
const redirect = (reply: FastifyReply, url: string) =>
  reply
    .status(302)
    .header("location", url)
    .header("cache-control", "no-store")
    .send();

@Controller(P)
export class ProcApprovalsController {
  constructor(private readonly s: ProcurementStore) {}
  @Get("summary")
  @Route(ALL)
  summary(@Proc() c: RawCaller) {
    return core.getSummary(this.s.on(c));
  }
  @Get("alerts")
  @Route(ALL)
  alerts(@Proc() c: RawCaller, @Query() q: D.HorizonQueryDto) {
    return core.getAlerts(this.s.on(c), q.horizon);
  }
  @Get("notifications")
  @Route(ALL)
  notes(@Proc() c: RawCaller) {
    return core.getNotes(this.s.on(c));
  }
  @Get("approvals")
  @Route({ auth: FE })
  approvals(@Proc() c: RawCaller, @Query() q: D.TypeQueryDto) {
    return core.getApprovals(this.s.on(c), q.type);
  }
  @Get("settings")
  @Route(ALL)
  settings(@Proc() c: RawCaller) {
    return core.getSettings(this.s.on(c));
  }
  @Post("settings/proposals")
  @Route(W([FIN]))
  propose(@Proc() c: RawCaller, @Body() b: D.ProposalDto) {
    return core.proposeSettings(this.s.on(c), b);
  }
  @Post("settings/proposals/:id/decision")
  @Route({ ...W([EXEC]), limit: "write" })
  decide(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.DecisionDto,
  ) {
    return core.decideProposal(this.s.on(c), id, b);
  }
  @Get("audit")
  @Route(ALL)
  audit(@Proc() c: RawCaller, @Query() q: D.AuditQueryDto) {
    return core.getAudit(this.s.on(c), q.kind, q.id);
  }
}

@Controller(P)
export class ProcSpendController {
  constructor(private readonly s: ProcurementStore) {}
  @Get("reports/payables-ageing")
  @Route(ALL)
  ageing(@Proc() c: RawCaller, @Query() q: D.AsOfQueryDto) {
    return core.payablesAgeing(this.s.on(c), q.asOf);
  }
  @Get("reports/spend")
  @Route(ALL)
  spend(@Proc() c: RawCaller, @Query() q: D.RangeQueryDto) {
    return core.spendReport(this.s.on(c), q);
  }
  @Post("reports/export")
  @Route({ ...W(ALL.auth), limit: "write" })
  exportLog(@Proc() c: RawCaller, @Body() b: D.ExportLogDto) {
    return core.logExport(this.s.on(c), b);
  }
  @Get("x/vendor-options")
  @Route({ auth: STAFF })
  vendorOptions(@Proc() c: RawCaller) {
    return spend.vendorOptions(this.s.on(c));
  }
  @Get("x/pr-context")
  @Route({ auth: STAFF })
  prContext(@Proc() c: RawCaller) {
    return spend.prContext(this.s.on(c));
  }
}

@Controller(P)
export class ProcVendorsController {
  constructor(private readonly s: ProcurementStore) {}
  @Get("vendors")
  @Route(ALL)
  list(@Proc() c: RawCaller, @Query() q: D.VendorQueryDto) {
    return vend.listVendors(this.s.on(c), q);
  }
  @Get("vendors/check-duplicate")
  @Route({ auth: [PROC] })
  dup(@Proc() c: RawCaller, @Query() q: D.VendorDupQueryDto) {
    return vend.checkVendorDuplicate(this.s.on(c), q);
  }
  @Post("vendors")
  @Route(W([PROC]))
  create(@Proc() c: RawCaller, @Body() b: D.VendorDto) {
    return vend.createVendor(this.s.on(c), b);
  }
  @Get("vendors/:id")
  @Route(ALL)
  get(@Proc() c: RawCaller, @Param("id") id: string) {
    return vend.getVendor(this.s.on(c), id);
  }
  @Patch("vendors/:id")
  @Route(W([PROC]))
  update(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.VendorPatchDto,
  ) {
    return vend.updateVendor(this.s.on(c), id, b);
  }
  @Post("vendors/:id/status")
  @Route(W([PROC]))
  status(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.VendorStatusDto,
  ) {
    return vend.setVendorStatus(this.s.on(c), id, b);
  }
  @Post("vendors/:id/bank-changes")
  @Route(W([PROC]))
  bankChange(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.BankChangeDto,
  ) {
    return vend.requestBankChange(this.s.on(c), id, b);
  }
  @Post("vendors/:id/reveal")
  @Route({ ...W(PF), limit: "write" })
  reveal(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.RevealDto,
  ) {
    return vend.reveal(this.s.on(c), id, b);
  }
  @Post("vendors/:id/documents")
  @Route(W([PROC]))
  async addDoc(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.VendorDocDto,
    @CurrentUser() me: SessionUser,
  ) {
    const upload =
      b.filename && b.mime && b.size
        ? await this.s.presign(me, {
            filename: b.filename,
            mime: b.mime,
            size: b.size,
          })
        : undefined;
    return {
      ...(await vend.addVendorDocument(this.s.on(c), id, b, upload)),
      ...(upload && { upload }),
    };
  }
  @Get("vendors/:id/documents/:docId/file")
  @Route(ALL)
  @RawResponse()
  async docFile(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Param("docId") docId: string,
    @Res() reply: FastifyReply,
  ) {
    return redirect(reply, await this.s.vendorDocUrl(this.s.on(c), id, docId));
  }
  @Get("vendors/:id/statement")
  @Route(ALL)
  statement(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Query() q: D.RangeQueryDto,
  ) {
    return vend.vendorStatement(this.s.on(c), id, q);
  }
  @Get("vendors/:id/statement.pdf")
  @Route({ ...ALL, limit: "write" })
  @RawResponse()
  async statementPdf(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Query() q: D.DateRangeDto,
    @Res() reply: FastifyReply,
  ) {
    const d = await vend.vendorStatement(this.s.on(c), id, q);
    return reply
      .header("content-type", "application/pdf")
      .header(
        "content-disposition",
        `inline; filename="statement-${d.vendor.code}-${q.from}-${q.to}.pdf"`,
      )
      .send(statementPdf(d, q.from, q.to));
  }
  @Post("vendors/:id/statement/send")
  @Route(W(PF))
  sendStatement(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.DateRangeDto,
  ) {
    return vend.sendStatement(this.s.on(c), id, b);
  }
  @Get("bank-changes")
  @Route({ auth: [FIN, PROC] })
  bankChanges(@Proc() c: RawCaller) {
    return vend.listBankChanges(this.s.on(c));
  }
  @Post("bank-changes/:id/verify")
  @Route(W([FIN]))
  verifyBank(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.VerifyBankDto,
  ) {
    return vend.verifyBankChange(this.s.on(c), id, b);
  }

  @Get("contracts")
  @Route(ALL)
  contracts(@Proc() c: RawCaller, @Query() q: D.ContractQueryDto) {
    return vend.listContracts(this.s.on(c), q);
  }
  @Post("contracts")
  @Route(W([PROC]))
  createContract(@Proc() c: RawCaller, @Body() b: D.ContractDto) {
    return vend.createContract(this.s.on(c), b);
  }
  @Get("contracts/:id")
  @Route(ALL)
  contract(@Proc() c: RawCaller, @Param("id") id: string) {
    return vend.getContract(this.s.on(c), id);
  }
  @Patch("contracts/:id")
  @Route(W([PROC]))
  updateContract(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.ContractDto,
  ) {
    return vend.updateContract(this.s.on(c), id, b);
  }
  @Post("contracts/:id/renewal")
  @Route(W([PROC]))
  renewal(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.RenewalDto,
  ) {
    return vend.requestRenewal(this.s.on(c), id, b);
  }
  @Post("contracts/:id/renewal/decision")
  @Route(W([EXEC]))
  renewalDecision(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.DecisionDto,
  ) {
    return vend.decideRenewal(this.s.on(c), id, b);
  }
  @Post("contracts/:id/terminate")
  @Route(W([PROC]))
  terminate(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.TerminateDto,
  ) {
    return vend.terminateContract(this.s.on(c), id, b);
  }
  @Post("contracts/:id/snooze")
  @Route(W([PROC, EXEC]))
  snooze(@Proc() c: RawCaller, @Param("id") id: string) {
    return vend.snoozeContract(this.s.on(c), id);
  }
  @Get("x/contract/:ref")
  @Route({ auth: [EXEC] })
  contractForExec(@Proc() c: RawCaller, @Param("ref") ref: string) {
    return vend.contractForExec(this.s.on(c), ref);
  }
}

@Controller(P)
export class ProcDepositsController {
  constructor(private readonly s: ProcurementStore) {}
  @Get("deposits")
  @Route(ALL)
  list(@Proc() c: RawCaller) {
    return vend.listDeposits(this.s.on(c));
  }
  @Post("deposits")
  @Route(W([PROC]))
  create(@Proc() c: RawCaller, @Body() b: D.AdvanceDto) {
    return vend.createAdvance(this.s.on(c), b);
  }
  @Post("deposits/:id/return")
  @Route(W([PROC]))
  ret(@Proc() c: RawCaller, @Param("id") id: string, @Body() b: D.ReturnDto) {
    return vend.returnDeposit(this.s.on(c), id, b);
  }
  @Post("deposits/:id/forfeit")
  @Route(W([PROC]))
  forfeit(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.ReasonDto,
  ) {
    return vend.requestForfeit(this.s.on(c), id, b);
  }
  @Post("deposits/:id/forfeit/decision")
  @Route(W([EXEC]))
  forfeitDecision(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.DecisionDto,
  ) {
    return vend.decideForfeit(this.s.on(c), id, b);
  }
  @Post("deposits/:id/offset")
  @Route(W(PF))
  offset(
    @Proc() c: RawCaller,
    @Param("id") id: string,
    @Body() b: D.OffsetDto,
  ) {
    return vend.offsetAdvance(this.s.on(c), id, b);
  }
}

@Controller(P)
export class ProcRequestsController {
  constructor(private readonly s: ProcurementStore) {}
  @Get("purchase-requests")
  @Route({ auth: STAFF })
  list(@Proc() c: RawCaller, @Query() q: D.PrQueryDto) {
    return spend.listPrs(this.s.on(c), q);
  }
  @Get("purchase-requests/:no")
  @Route({ auth: STAFF })
  get(@Proc() c: RawCaller, @Param("no") no: string) {
    return spend.getPr(this.s.on(c), no);
  }
  @Post("purchase-requests")
  @Route(W(STAFF))
  create(@Proc() c: RawCaller, @Body() b: D.PrDto) {
    return spend.createPr(this.s.on(c), b);
  }
  @Post("purchase-requests/:no/:action")
  @Route(W(STAFF))
  action(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Param("action") a: string,
    @Body() b: D.PrDto,
  ) {
    return spend.prAction(this.s.on(c), no, a, b);
  }
  @Get("x/pr/:no")
  @Route({ auth: FE })
  forApprover(@Proc() c: RawCaller, @Param("no") no: string) {
    return vend.prForApprover(this.s.on(c), no);
  }
}

@Controller(P)
export class ProcOrdersController {
  constructor(private readonly s: ProcurementStore) {}
  @Get("purchase-orders")
  @Route(ALL)
  list(@Proc() c: RawCaller) {
    return spend.listPos(this.s.on(c));
  }
  @Get("purchase-orders/:no")
  @Route({ auth: STAFF })
  get(@Proc() c: RawCaller, @Param("no") no: string) {
    return spend.getPo(this.s.on(c), no);
  }
  @Get("purchase-orders/:no/pdf")
  @Route(ALL)
  @RawResponse()
  async pdf(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Res() reply: FastifyReply,
  ) {
    return redirect(reply, await this.s.poPdfUrl(this.s.on(c), no));
  }
  @Post("purchase-orders")
  @Route(W([PROC]))
  create(@Proc() c: RawCaller, @Body() b: D.PoDto) {
    return spend.createPo(this.s.on(c), b);
  }
  @Post("purchase-orders/:no/:action")
  @Route(W(STAFF))
  action(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Param("action") a: string,
    @Body() b: D.PoActionDto,
  ) {
    return spend.poAction(this.s.on(c), no, a, b);
  }
}

@Controller(P)
export class ProcReceiptsController {
  constructor(private readonly s: ProcurementStore) {}
  @Post("receipts/:no/chase")
  @Route({ ...W([PROC]), limit: "write" })
  chase(@Proc() c: RawCaller, @Param("no") no: string, @Body() b: D.ChaseDto) {
    return spend.chaseReceipt(this.s.on(c), no, b);
  }
  @Get("receipts")
  @Route(ALL)
  list(@Proc() c: RawCaller, @Query() q: D.ReceiptQueryDto) {
    return spend.listReceipts(this.s.on(c), q);
  }
}

@Controller(P)
export class ProcBillsController {
  constructor(private readonly s: ProcurementStore) {}
  @Get("bills")
  @Route(ALL)
  list(@Proc() c: RawCaller) {
    return bills.listBills(this.s.on(c));
  }
  @Get("bills/form-options")
  @Route({ auth: PF })
  formOptions(@Proc() c: RawCaller) {
    return bills.billFormOptions(this.s.on(c));
  }
  @Get("bills/check-duplicate")
  @Route({ auth: PF })
  dup(@Proc() c: RawCaller, @Query() q: D.BillDupQueryDto) {
    return bills.checkBillDuplicate(this.s.on(c), q);
  }
  @Get("bills/recurring-preview")
  @Route({ auth: PF })
  recurringPreview(@Proc() c: RawCaller) {
    return bills.recurringPreview(this.s.on(c));
  }
  @Post("bills/generate-recurring")
  @Route(W(PF))
  generateRecurring(@Proc() c: RawCaller) {
    return bills.generateRecurring(this.s.on(c));
  }
  @Get("bills/:no")
  @Route(ALL)
  get(@Proc() c: RawCaller, @Param("no") no: string) {
    return bills.getBill(this.s.on(c), no);
  }
  @Post("bills")
  @Route(W(PF))
  create(@Proc() c: RawCaller, @Body() b: D.BillDto) {
    return bills.createBill(this.s.on(c), b);
  }
  @Post("bills/:no/correct")
  @Route(W(PF))
  correct(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Body() b: D.CorrectDto,
  ) {
    return bills.correctBill(this.s.on(c), no, b);
  }
  @Post("bills/:no/submit")
  @Route(W(PF))
  submit(@Proc() c: RawCaller, @Param("no") no: string) {
    return bills.submitBill(this.s.on(c), no);
  }
  @Post("bills/:no/approve")
  @Route(W(FE))
  approve(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Body() b: D.OverrideDto,
  ) {
    return bills.approveBill(this.s.on(c), no, b.override);
  }
  @Post("bills/:no/authorise")
  @Route(W(FE))
  authorise(@Proc() c: RawCaller, @Param("no") no: string) {
    return bills.authoriseBill(this.s.on(c), no);
  }
  @Post("bills/:no/reject")
  @Route(W(FE))
  reject(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Body() b: D.ReasonDto,
  ) {
    return bills.rejectBill(this.s.on(c), no, b.reason);
  }
  @Post("bills/:no/dispute")
  @Route(W(PF))
  dispute(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Body() b: D.ReasonDto,
  ) {
    return bills.disputeBill(this.s.on(c), no, b.reason);
  }
  @Post("bills/:no/resolve")
  @Route(W(PF))
  resolve(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Body() b: D.ReasonDto,
  ) {
    return bills.resolveBill(this.s.on(c), no, b.reason);
  }
  @Post("bills/:no/void")
  @Route(W(PF))
  void(@Proc() c: RawCaller, @Param("no") no: string, @Body() b: D.ReasonDto) {
    return bills.voidBill(this.s.on(c), no, b.reason);
  }
  @Post("bills/:no/exception")
  @Route(W([PROC, FIN, EXEC]))
  exception(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Body() b: D.ExceptionDto,
  ) {
    return bills.billException(this.s.on(c), no, b);
  }
  @Post("bills/:no/apply-advance")
  @Route(W(PF))
  applyAdvance(
    @Proc() c: RawCaller,
    @Param("no") no: string,
    @Body() b: D.ApplyAdvanceDto,
  ) {
    return bills.applyAdvanceToBill(this.s.on(c), no, b);
  }

  @Get("payments")
  @Route(ALL)
  payments(@Proc() c: RawCaller) {
    return bills.listPayments(this.s.on(c));
  }
  @Post("payments")
  @Route(W([FIN]))
  pay(@Proc() c: RawCaller, @Body() b: D.PaymentDto) {
    return bills.recordPayment(this.s.on(c), b);
  }
  @Post("payments/:no/remittance")
  @Route(W([FIN]))
  remittance(@Proc() c: RawCaller, @Param("no") no: string) {
    return bills.sendRemittance(this.s.on(c), no);
  }
}

export const PROC_CONTROLLERS = [
  ProcApprovalsController,
  ProcSpendController,
  ProcVendorsController,
  ProcDepositsController,
  ProcRequestsController,
  ProcOrdersController,
  ProcReceiptsController,
  ProcBillsController,
];
