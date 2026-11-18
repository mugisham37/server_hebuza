// Refund requests (SM review → finance adjust → four-eyes/executive approval → execute) and credit notes (U12).
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
import * as rfd from "./finance.refunds";
import { AcceptedInterceptor, FinRunner } from "./finance.runner";
import * as D from "./finance.dto";

@Controller("finance")
@UseInterceptors(AcceptedInterceptor)
export class FinanceRefundsController {
  constructor(private readonly r: FinRunner) {}

  @Get("refund-requests")
  @Route({ auth: D.RFD_READ })
  list(@Query() q: D.RefundsQueryDto) {
    return this.r.read((f) => rfd.listRefunds(f, q));
  }
  @Get("x/refundable-invoices")
  @Route({ auth: D.FIN })
  refundable() {
    return this.r.read((f) => rfd.refundableInvoices(f));
  }
  @Post("refund-requests")
  @Route({ auth: D.FIN, ...D.W })
  create(@Body() b: D.NewRefundDto) {
    return this.r.write((f) => rfd.requestRefund(f, b));
  }
  @Get("refund-requests/:no")
  @Route({ auth: D.RFD_READ })
  get(@Param("no") no: string) {
    return this.r.read((f) => rfd.getRefund(f, no));
  }
  @Post("refund-requests/:no/review")
  @Route({ auth: D.SM, ...D.W })
  review(@Param("no") no: string, @Body() b: D.ReviewRefundDto) {
    return this.r.write((f) => rfd.reviewRefund(f, no, b));
  }
  @Post("refund-requests/:no/adjust")
  @Route({ auth: D.FIN, ...D.W })
  adjust(@Param("no") no: string, @Body() b: D.AdjustRefundDto) {
    return this.r.write((f) => rfd.adjustRefund(f, no, b));
  }
  @Post("refund-requests/:no/approve")
  @Route({ auth: D.FINX, stepUp: true, ...D.W })
  approve(@Param("no") no: string, @Body() b: D.RevDto) {
    return this.r.write((f) => rfd.approveRefund(f, no, b));
  }
  @Post("refund-requests/:no/reject")
  @Route({ auth: D.RFD_READ, ...D.W })
  reject(@Param("no") no: string, @Body() b: D.RejectRefundDto) {
    return this.r.write((f) => rfd.rejectRefund(f, no, b));
  }
  @Post("refund-requests/:no/execute")
  @Route({ auth: D.FIN, stepUp: true, ...D.W })
  execute(@Param("no") no: string, @Body() b: D.ExecuteRefundDto) {
    return this.r.write((f) => rfd.executeRefund(f, no, b));
  }

  @Get("credit-notes")
  @Route({ auth: D.FINX })
  creditNotes() {
    return this.r.read((f) => rfd.creditNotes(f));
  }
  @Get("credit-notes/:no")
  @Route({ auth: D.FINX })
  creditNote(@Param("no") no: string) {
    return this.r.read((f) => rfd.creditNote(f, no));
  }
}
