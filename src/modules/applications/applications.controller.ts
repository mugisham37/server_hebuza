import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ClsService } from "nestjs-cls";
import { CurrentUser } from "../../core/auth/decorators";
import type { RequestStore, SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import * as D from "./applications.dto";
import { ApplicationsService } from "./applications.service";
import { SupportService } from "./support.service";

@Controller()
export class ApplicationsController {
  constructor(private readonly svc: ApplicationsService, private readonly cls: ClsService<RequestStore>) {}

  @Get("me/dashboard")
  @Route({ auth: ["client"], permission: "req.case.read", out: D.DashboardOut })
  dashboard(@CurrentUser() me: SessionUser) {
    return this.svc.dashboard(me);
  }
  @Get("me/activity")
  @Route({ auth: ["client"], permission: "req.case.read", out: D.ActivityOut })
  activity(@Query() q: D.ActivityQueryDto, @CurrentUser() me: SessionUser) {
    return this.svc.activity(me, q.year);
  }
  @Get("applications")
  @Route({ auth: "user", permission: "req.case.read", out: D.ListOut })
  list(@CurrentUser() me: SessionUser) {
    return this.svc.list(me);
  }
  // Guests may apply (VIS req.submit) unless platform settings say otherwise; the service enforces that. Audited in-tx.
  @Post("applications/submit")
  @Route({ auth: "public", permission: "req.submit", idempotent: true, out: D.SubmitOut })
  submit(@Body() b: D.SubmitDto, @CurrentUser() me: SessionUser | null) {
    return this.svc.submit(me, b, this.cls.get("ip") ?? null);
  }
  @Get("applications/:code")
  @Route({ auth: "user", permission: "req.case.read", out: D.Detail })
  detail(@Param("code") code: string, @CurrentUser() me: SessionUser) {
    return this.svc.detail(me, code);
  }
  @Get("track/:code")
  @Route({ auth: "public", limit: "read", out: D.TrackOut })
  track(@Param("code") code: string) {
    return this.svc.track(code);
  }
  // Contact guessing is the attack: the strict auth window applies per IP.
  @Post("track/:code/verify")
  @Route({ auth: "public", limit: "auth", out: D.VerifyTrackOut })
  verify(@Param("code") code: string, @Body() b: D.VerifyTrackDto) {
    return this.svc.verifyTrack(code, b.contact ?? "");
  }
}

@Controller("support/tickets")
export class SupportController {
  constructor(private readonly svc: SupportService) {}

  @Get()
  @Route({ auth: "user", permission: "fbk.ticket.read", out: D.TicketListOut })
  list(@CurrentUser() me: SessionUser) {
    return this.svc.list(me);
  }
  @Post()
  @Route({ auth: "user", permission: "fbk.ticket.create", out: D.TicketRefOut })
  create(@Body() b: D.TicketCreateDto, @CurrentUser() me: SessionUser) {
    return this.svc.create(me, b);
  }
  @Get(":ref")
  @Route({ auth: "user", permission: "fbk.ticket.read", out: D.TicketOut })
  get(@Param("ref") ref: string, @CurrentUser() me: SessionUser) {
    return this.svc.get(me, ref);
  }
  @Post(":ref/messages")
  @Route({ auth: "user", permission: "fbk.ticket.create", out: D.TicketOut })
  message(@Param("ref") ref: string, @Body() b: D.TicketMessageDto, @CurrentUser() me: SessionUser) {
    return this.svc.message(me, ref, b);
  }
  @Post(":ref/rating")
  @Route({ auth: "user", permission: "fbk.ticket.create", out: D.TicketOut })
  rate(@Param("ref") ref: string, @Body() b: D.TicketRateDto, @CurrentUser() me: SessionUser) {
    return this.svc.rate(me, ref, b);
  }
}
