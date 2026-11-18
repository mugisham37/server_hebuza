import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { Route } from "../../core/http/route";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { ComplianceService } from "./compliance.service";
import {
  HolidaysOut,
  RuleDto,
  RuleOut,
  RulePatchDto,
  RulesOut,
  type RulePatch,
} from "./compliance.dto";
import type { RuleInput } from "@/domain/ops/rules";

const SM = ["staff:service_manager"] as const;

@Controller("admin")
export class ComplianceController {
  constructor(private readonly svc: ComplianceService) {}

  @Get("compliance-calendar")
  @Route({ auth: ["staff:service_manager", "staff:executive"], out: RulesOut })
  list() {
    return this.svc.list();
  }

  @Post("compliance-calendar")
  @Route({
    auth: SM,
    permission: "cal.obligations.update",
    idempotent: true,
    out: RuleOut,
  })
  create(@Body() b: RuleDto, @CurrentUser() me: SessionUser) {
    return this.svc.create(b as RuleInput, me.id);
  }

  @Patch("compliance-calendar/:id")
  @Route({ auth: SM, permission: "cal.obligations.update", out: RuleOut })
  patch(
    @Param("id") id: string,
    @Body() b: RulePatchDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.patch(id, b as RulePatch as Partial<RuleInput>, me.id);
  }

  @Get("public-holidays")
  @Route({ auth: "user", out: HolidaysOut })
  holidays() {
    return this.svc.publicHolidays();
  }
}
