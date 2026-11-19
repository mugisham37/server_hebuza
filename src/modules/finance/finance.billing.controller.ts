// Quotations (U5), invoices (U6–U7) and receivables (U11).
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { Route } from "../../core/http/route";
import * as bill from "./finance.billing";
import { AcceptedInterceptor, FinRunner } from "./finance.runner";
import * as D from "./finance.dto";

@Controller("finance")
@UseInterceptors(AcceptedInterceptor)
export class FinanceBillingController {
  constructor(private readonly r: FinRunner) {}

  // ---- quotations
  @Get("quotations")
  @Route({ auth: D.FIN })
  quotes(@Query() q: D.QuotesQueryDto) {
    return this.r.read((f) => bill.listQuotes(f, q));
  }
  @Get("quotations/x/cases")
  @Route({ auth: D.FIN })
  cases() {
    return this.r.read((f) => ({ items: bill.caseOptions(f) }));
  }
  @Get("quotations/:no")
  @Route({ auth: D.FIN })
  quote(@Param("no") no: string) {
    return this.r.read((f) => bill.getQuote(f, no));
  }
  @Get("quotations/:no/pdf")
  @Route({ auth: D.FIN })
  @RawResponse()
  async quotePdf(@Param("no") no: string, @Res() reply: FastifyReply) {
    const pdf = await this.r.read((f) => bill.quotePdf(f, no));
    return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="${no}.pdf"`).send(pdf);
  }
  @Post("quotations")
  @Route({ auth: D.FIN, ...D.W })
  createQuote(@Body() b: D.NewQuoteDto) {
    return this.r.write((f) => bill.createQuote(f, b.caseRef));
  }
  @Patch("quotations/:no")
  @Route({ auth: D.FIN })
  patchQuote(@Param("no") no: string, @Body() b: D.QuotePatchDto) {
    return this.r.write((f) => bill.patchQuote(f, no, b as bill.QuotePatch));
  }
  @Post("quotations/:no/send")
  @Route({ auth: D.FIN, ...D.W })
  send(@Param("no") no: string, @Body() b: D.SendQuoteDto) {
    return this.r.write((f) => bill.sendQuote(f, no, b));
  }
  @Post("quotations/:no/approve")
  @Route({ auth: D.FIN, ...D.W })
  approve(@Param("no") no: string, @Body() b: D.RevDto) {
    return this.r.write((f) => bill.approveQuote(f, no, b));
  }
  @Post("quotations/:no/withdraw")
  @Route({ auth: D.FIN, ...D.W })
  withdraw(@Param("no") no: string, @Body() b: D.RevReasonDto) {
    return this.r.write((f) => bill.withdrawQuote(f, no, b));
  }
  @Post("quotations/:no/revise")
  @Route({ auth: D.FIN, ...D.W })
  revise(@Param("no") no: string) {
    return this.r.write((f) => bill.reviseQuote(f, no));
  }
  @Post("quotations/:no/convert")
  @Route({ auth: D.FIN, ...D.W })
  convert(@Param("no") no: string, @Body() b: D.RevDto) {
    return this.r.write((f) => bill.convertQuote(f, no, b));
  }

  // ---- invoices
  @Get("invoices")
  @Route({ auth: D.FIN })
  invoices(@Query() q: D.InvoicesQueryDto) {
    return this.r.read((f) => bill.listInvoices(f, q));
  }
  @Get("invoices/x/form")
  @Route({ auth: D.FIN })
  form() {
    return this.r.read((f) => bill.invoiceForm(f));
  }
  @Get("invoices/:key")
  @Route({ auth: D.FIN })
  invoice(@Param("key") key: string) {
    return this.r.read((f) => bill.getInvoice(f, key));
  }
  @Post("invoices")
  @Route({ auth: D.FIN, ...D.W })
  createInvoice(@Body() b: D.NewInvoiceDto) {
    return this.r.write((f) => bill.createInvoice(f, b));
  }
  @Patch("invoices/:key")
  @Route({ auth: D.FIN })
  patchInvoice(@Param("key") key: string, @Body() b: D.InvoicePatchDto) {
    return this.r.write((f) => bill.patchInvoice(f, key, b));
  }
  @Post("invoices/:key/issue")
  @Route({ auth: D.FIN, ...D.W })
  issue(@Param("key") key: string, @Body() b: D.RevDto) {
    return this.r.write((f) => bill.issueInvoice(f, key, b));
  }
  @Post("invoices/:key/void")
  @Route({ auth: D.FIN, stepUp: true, ...D.W })
  void(@Param("key") key: string, @Body() b: D.RevReasonDto) {
    return this.r.write((f) => bill.voidInvoice(f, key, b));
  }
  @Post("invoices/:key/apply-credit")
  @Route({ auth: D.FIN, ...D.W })
  applyCredit(@Param("key") key: string, @Body() b: D.ApplyCreditDto) {
    return this.r.write((f) => bill.applyCredit(f, key, b));
  }
  @Post("invoices/:key/ebm")
  @Route({ auth: D.FIN, ...D.W })
  ebm(@Param("key") key: string, @Body() b: D.EbmDto) {
    return this.r.write((f) => bill.recordEbm(f, key, b));
  }
  @Post("invoices/:key/remind")
  @Route({ auth: D.FIN, ...D.W })
  remind(@Param("key") key: string, @Body() b: D.RemindDto) {
    return this.r.write((f) => bill.remind(f, key, b));
  }

  // ---- receivables
  @Get("reports/receivables-ageing")
  @Route({ auth: D.FINX })
  ageing() {
    return this.r.read((f) => bill.receivablesAgeing(f));
  }
  @Get("x/receivables/clients/:id")
  @Route({ auth: D.FINX })
  client(@Param("id") id: string) {
    return this.r.read((f) => bill.receivableClient(f, id));
  }
  @Post("x/receivables/clients/:id/notes")
  @Route({ auth: D.FIN, ...D.W })
  arNote(@Param("id") id: string, @Body() b: D.ArNoteDto) {
    return this.r.write((f) =>
      bill.addArNote(f, id, {
        text: b.text,
        promiseAt: b.promiseAt || undefined,
      }),
    );
  }
}
