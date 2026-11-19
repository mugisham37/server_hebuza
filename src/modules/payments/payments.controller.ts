import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { CurrentUser, Webhook } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import * as D from "./payments.dto";
import { PaymentsService } from "./payments.service";

@Controller()
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  // Guests may pay for a guest application; the service scopes everything else. Same Idempotency-Key = same payment.
  @Post("payments/initiate")
  @Route({
    auth: "public",
    limit: "write",
    idempotent: true,
    out: D.InitiateOut,
  })
  initiate(@Body() b: D.InitiateDto, @CurrentUser() me: SessionUser | null) {
    return this.svc.initiate(me ?? null, b);
  }
  // The transaction id is a 128-bit random token; status reveals nothing else.
  @Get("payments/:transaction_id/status")
  @Route({ auth: "public", limit: "read", out: D.StatusOut })
  status(@Param("transaction_id") id: string) {
    return this.svc.status(id);
  }
  @Get("payments/:transaction_id")
  @Route({ auth: "public", limit: "read", out: D.StatusOut })
  get(@Param("transaction_id") id: string) {
    return this.svc.status(id);
  }
  @Post("payments/bank-transfer")
  @Route({
    auth: ["client"],
    permission: "fin.payment.initiate",
    idempotent: true,
    out: D.BankOut,
  })
  bankTransfer(@Body() b: D.BankTransferDto, @CurrentUser() me: SessionUser) {
    return this.svc.declareBankTransfer(me, b);
  }
  @Get("applications/:code/payment/receipt")
  @Route({ auth: ["client"], out: D.ReceiptOut })
  receipt(@Param("code") code: string, @CurrentUser() me: SessionUser) {
    return this.svc.receipt(me, code);
  }

  // Gateway callbacks: public + no CSRF; signature checked in the service, replays absorbed by the event store.
  @Post("payments/webhooks/momo")
  @Webhook()
  @Route({ auth: "public", out: D.Accepted })
  async momo(@Body() b: D.WebhookDto, @Query("sig") sig?: string) {
    await this.svc.momoWebhook(b, sig);
    return { status: "ok" as const };
  }
  @Post("payments/webhooks/flutterwave")
  @Webhook()
  @Route({ auth: "public", out: D.Accepted })
  async flutterwave(
    @Body() b: D.WebhookDto,
    @Headers("verif-hash") sig?: string,
  ) {
    await this.svc.flutterwaveWebhook(b, sig);
    return { status: "ok" as const };
  }

  @Get("me/invoices")
  @Route({
    auth: ["client"],
    permission: "fin.invoice.read",
    out: D.InvoicesOut,
  })
  invoices(@CurrentUser() me: SessionUser) {
    return this.svc.myInvoices(me.id);
  }
  @Get("me/invoices/:no/pdf")
  @Route({ auth: ["client"], permission: "fin.invoice.read" })
  @RawResponse()
  async invoicePdf(@Param("no") no: string, @CurrentUser() me: SessionUser, @Res() reply: FastifyReply) {
    const pdf = await this.svc.invoicePdf(me.id, no);
    return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="${no}.pdf"`).send(pdf);
  }
  @Get("me/receipts/:no/pdf")
  @Route({ auth: ["client"], permission: "fin.invoice.read" })
  @RawResponse()
  async receiptPdf(@Param("no") no: string, @CurrentUser() me: SessionUser, @Res() reply: FastifyReply) {
    const pdf = await this.svc.receiptPdf(me.id, no);
    return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="${no}.pdf"`).send(pdf);
  }
  @Get("me/receipts")
  @Route({
    auth: ["client"],
    permission: "fin.invoice.read",
    out: D.ReceiptsOut,
  })
  receipts(@CurrentUser() me: SessionUser) {
    return this.svc.myReceipts(me.id);
  }
  @Get("me/payment-methods")
  @Route({ auth: ["client"], out: D.MethodsOut })
  methods(@CurrentUser() me: SessionUser) {
    return this.svc.myMethods(me.id);
  }
  @Delete("me/payment-methods/:id")
  @Route({ auth: ["client"], out: D.DeletedOut })
  deleteMethod(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.deleteMethod(me.id, id);
  }
}
