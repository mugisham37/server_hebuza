import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import { FinSubList, CancelDto, ChangeOut, ChangePlanDto, CheckoutOut, Mine, PauseDto, PauseOut, PlanList } from "./subscriptions.dto";
import { SubscriptionsService } from "./subscriptions.service";

@Controller()
export class SubscriptionsController {
  constructor(private readonly svc: SubscriptionsService) {}

  @Get("plans")
  @Route({ auth: "public", limit: "read", out: PlanList })
  plans() {
    return this.svc.listPublicPlans();
  }
  @Get("plans/:plan_id")
  @Route({ auth: "public", limit: "read", out: CheckoutOut })
  plan(@Param("plan_id") id: string) {
    return this.svc.getPlanForCheckout(id);
  }
  @Get("me/subscription")
  @Route({ auth: ["client"], out: Mine })
  mine(@CurrentUser() me: SessionUser) {
    return this.svc.getMine(me.id);
  }
  @Get("me/subscription/plans")
  @Route({ auth: ["client"], out: PlanList })
  upgradePlans() {
    return this.svc.listPublicPlans();
  }
  @Post("me/subscription/cancel")
  @Route({ auth: ["client"], limit: "write", out: Mine })
  cancel(@Body() b: CancelDto, @CurrentUser() me: SessionUser) {
    return this.svc.cancel(me.id, b);
  }
  @Post("me/subscription/undo-cancel")
  @Route({ auth: ["client"], limit: "write", out: Mine })
  undoCancel(@CurrentUser() me: SessionUser) {
    return this.svc.undoCancel(me.id);
  }
  @Post("me/subscription/change")
  @Route({ auth: ["client"], limit: "write", out: ChangeOut })
  change(@Body() b: ChangePlanDto, @CurrentUser() me: SessionUser) {
    return this.svc.changePlan(me.id, b.planId);
  }
  @Get("finance/subscriptions")
  @Route({ auth: ["staff:finance"], out: FinSubList })
  finList() {
    return this.svc.listForFinance();
  }
  @Post("finance/subscriptions/:id/pause")
  @Route({ auth: ["staff:finance"], limit: "write", out: PauseOut })
  pause(@Param("id") id: string, @Body() b: PauseDto, @CurrentUser() me: SessionUser) {
    return this.svc.pause(id, b.days, me.id);
  }
}
