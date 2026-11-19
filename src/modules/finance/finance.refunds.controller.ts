// Refund requests (SM review → finance adjust → four-eyes/executive approval → execute) and credit notes (U12).
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { fail, one } from "./finance.store";
import { invoiceDocPdf, sellerOf } from "./finance.billing";
import type { CreditNote } from "@/domain/finance/types";
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
  @Get("credit-notes/:no/pdf")
  @Route({ auth: D.FINX })
  @RawResponse()
  async creditNotePdf(@Param("no") no: string, @Res() reply: FastifyReply) {
    const pdf = await this.r.read(async (f) => {
      const cn = await one<CreditNote>(f.db, "credit_note", no);
      if (!cn) throw fail(404, "not_found");
      return invoiceDocPdf("Credit note", cn.no, { ...cn, seller: await sellerOf(f.db), caseRef: `Invoice ${cn.invoiceNo}${cn.ebmRef ? ` · EBM ${cn.ebmRef}` : ""}` });
    });
    return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="${no}.pdf"`).send(pdf);
  }
  @Get("credit-notes/:no")
  @Route({ auth: D.FINX })
  creditNote(@Param("no") no: string) {
    return this.r.read((f) => rfd.creditNote(f, no));
  }
}
