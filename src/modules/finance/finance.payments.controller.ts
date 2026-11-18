// Payments + transfer proofs with the four-eyes manual-confirm chain (U8–U9), statement import, matching and
// provider-day/month periods (U10).
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import { Route } from "../../core/http/route";
import { notFound } from "../../core/http/errors";
import type { Provider } from "@/domain/finance/types";
import * as pay from "./finance.payments";
import { AcceptedInterceptor, FinRunner } from "./finance.runner";
import * as D from "./finance.dto";

type LineAct = (typeof D.LINE_ACTIONS)[number];

@Controller("finance")
@UseInterceptors(AcceptedInterceptor)
export class FinancePaymentsController {
  constructor(private readonly r: FinRunner) {}

  @Get("payments")
  @Route({ auth: D.FIN })
  list(@Query() q: D.PaymentsQueryDto) {
    return this.r.read((f) => pay.listPayments(f, q));
  }
  @Get("x/payments/invoice-options")
  @Route({ auth: D.FIN })
  invoiceOptions(@Query() q: D.QDto) {
    return this.r.read((f) => pay.invoiceOptions(f, q.q));
  }
  @Post("payments/manual")
  @Route({ auth: D.FIN, stepUp: true, ...D.W })
  manual(@Body() b: D.ManualPaymentDto) {
    return this.r.write((f) => pay.recordManual(f, b));
  }
  @Get("payments/:id")
  @Route({ auth: D.FIN })
  get(@Param("id") id: string) {
    return this.r.read((f) => pay.getPayment(f, id));
  }
  @Post("payments/:id/lock")
  @Route({ auth: D.FIN })
  lock(@Param("id") id: string, @Body() b: D.LockDto) {
    return this.r.write((f) => pay.lockPayment(f, id, b.release));
  }
  @Post("payments/:id/confirm")
  @Route({ auth: D.FINX, stepUp: true, ...D.W })
  confirm(@Param("id") id: string, @Body() b: D.ConfirmPaymentDto) {
    return this.r.write((f) => pay.confirmPayment(f, id, b));
  }
  @Post("payments/:id/reject")
  @Route({ auth: D.FIN, ...D.W })
  reject(@Param("id") id: string, @Body() b: D.RevReasonDto) {
    return this.r.write((f) => pay.rejectPayment(f, id, b));
  }
  @Post("payments/:id/verify")
  @Route({ auth: D.FIN, ...D.W })
  verify(@Param("id") id: string) {
    return this.r.write((f) => pay.verifyPayment(f, id));
  }
  @Post("payments/:id/reverse")
  @Route({ auth: D.FIN, stepUp: true, ...D.W })
  reverse(@Param("id") id: string, @Body() b: D.RevReasonDto) {
    return this.r.write((f) => pay.reversePayment(f, id, b));
  }

  // ---- statements + reconciliation
  @Get("statements")
  @Route({ auth: D.FIN })
  statements(@Query() q: D.StatementsQueryDto) {
    return this.r.read((f) => pay.statements(f, q));
  }
  @Get("x/statements/mapping")
  @Route({ auth: D.FIN })
  mapping(@Query() q: D.MappingQueryDto) {
    return this.r.read((f) => pay.mappingOf(f, q.provider));
  }
  @Get("x/statements/sample")
  @Route({ auth: D.FIN })
  sample() {
    return this.r.read((f) => pay.sampleStatement(f));
  }
  @Post("statements/import")
  @Route({ auth: D.FIN, ...D.W })
  import(@Body() b: D.ImportDto) {
    return this.r.write((f) =>
      pay.importStatement(f, {
        ...b,
        rows: b.rows ?? (b.csv ? pay.rowsFromCsv(b.csv, b.mapping) : []),
      }),
    );
  }
  @Get("statements/:id/lines")
  @Route({ auth: D.FIN })
  lines(@Param("id") id: string) {
    return this.r.read((f) => pay.importDetail(f, id));
  }
  @Get("statements/lines/:id/candidates")
  @Route({ auth: D.FIN })
  candidates(@Param("id") id: string) {
    return this.r.read((f) => pay.lineCandidates(f, id));
  }
  @Post("statements/lines/bulk-accept")
  @Route({ auth: D.FIN, ...D.W })
  bulkAccept(@Body() b: D.IdsDto) {
    return this.r.write((f) => pay.bulkAccept(f, b.ids));
  }
  /** match | ignore | fee | flag | refund-proposal */
  @Post("statements/lines/:id/:action")
  @Route({ auth: D.FIN, ...D.W })
  lineAction(
    @Param("id") id: string,
    @Param("action") action: string,
    @Body() b: D.LineActionDto,
  ) {
    if (!D.LINE_ACTIONS.includes(action as LineAct)) throw notFound("Action");
    return this.r.write((f) => pay.lineAction(f, id, action as LineAct, b));
  }
  @Post("periods/:provider/:day/close")
  @Route({ auth: D.FIN, ...D.W })
  close(
    @Param("provider") p: string,
    @Param("day") day: string,
    @Body() b: D.ReasonDto,
  ) {
    return this.r.write((f) =>
      pay.periodAction(f, p as Provider, day, "close", b),
    );
  }
  @Post("periods/:provider/:day/reopen")
  @Route({ auth: D.FIN, stepUp: true, ...D.W })
  reopen(
    @Param("provider") p: string,
    @Param("day") day: string,
    @Body() b: D.ReasonDto,
  ) {
    return this.r.write((f) =>
      pay.periodAction(f, p as Provider, day, "reopen", b),
    );
  }
  @Post("x/recon/verify-pending")
  @Route({ auth: D.FIN, ...D.W })
  verifyPending(@Body() b: D.VerifyPendingDto) {
    return this.r.write((f) => pay.verifyPendingLines(f, b.provider));
  }
}
