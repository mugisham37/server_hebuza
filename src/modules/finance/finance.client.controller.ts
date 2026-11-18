// Client portal: my quotations (accept/decline) and refund requests on my paid invoices (reference account.routes).
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Route } from "../../core/http/route";
import { notFound } from "../../core/http/errors";
import * as cl from "./finance.client";
import { FinRunner } from "./finance.runner";
import * as D from "./finance.dto";

@Controller("me")
export class FinanceClientController {
  constructor(private readonly r: FinRunner) {}

  @Get("quotations")
  @Route({ auth: D.CLIENT })
  quotations() {
    return this.r.read((f) => cl.myQuotations(f));
  }
  /** accept | decline */
  @Post("quotations/:no/:action")
  @Route({ auth: D.CLIENT, ...D.W })
  respond(
    @Param("no") no: string,
    @Param("action") action: string,
    @Body() b: D.RespondQuoteDto,
  ) {
    if (action !== "accept" && action !== "decline") throw notFound("Action");
    return this.r.write((f) => cl.respondQuotation(f, no, action, b?.reason));
  }
  @Get("refunds/eligibility")
  @Route({ auth: D.CLIENT })
  eligibility() {
    return this.r.read((f) => cl.refundEligibility(f));
  }
  @Get("refunds")
  @Route({ auth: D.CLIENT })
  refunds() {
    return this.r.read((f) => cl.myRefunds(f));
  }
  @Post("refunds")
  @Route({ auth: D.CLIENT, ...D.W })
  create(@Body() b: D.ClientRefundDto) {
    return this.r.write((f) => cl.createRefund(f, b));
  }
}
