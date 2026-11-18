import { Controller, Get, Param } from "@nestjs/common";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import { CheckoutOut, Mine, PlanList } from "./subscriptions.dto";
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
}
