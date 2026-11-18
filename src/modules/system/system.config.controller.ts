// Settings, languages, integrations and notification rules/templates/deliveries/budgets (handlers-system-d, -e).
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import { Route } from "../../core/http/route";
import {
  AcceptedInterceptor,
  Sys,
  SystemStore,
  type RawCaller,
} from "./system.store";
import * as cfg from "./system.config";
import type { EventRuleVM, TemplateBody, TemplateVM } from "@/domain/system/types";
import type { Locale } from "@/domain/i18n/config";
import {
  BudgetDto,
  CredentialDto,
  DeliveriesQueryDto,
  EnvDto,
  LanguageDto,
  PayLaterDto,
  ReasonDto,
  RulesDto,
  SettingsPatchDto,
  type SettingsPatchIn,
  TemplateDto,
} from "./system.dto";

const R = { auth: "user" } as const;
const W = { auth: "user", idempotent: true } as const;
const X = "staff/x";

@Controller()
@UseInterceptors(AcceptedInterceptor)
export class SystemConfigController {
  constructor(private readonly s: SystemStore) {}

  @Get("staff/settings")
  @Route(R)
  settings(@Sys() c: RawCaller) {
    return cfg.getSettings(this.s.on(c));
  }
  @Patch("staff/settings")
  @Route(W)
  patchSettings(@Sys() c: RawCaller, @Body() b: SettingsPatchDto) {
    return cfg.patchSettings(this.s.on(c), b as SettingsPatchIn);
  }
  @Post("staff/settings/export")
  @Route({ ...R, limit: "write" })
  exportSettings(@Sys() c: RawCaller) {
    return cfg.exportSettingsJson(this.s.on(c));
  }
  @Get(`${X}/my-ip`)
  @Route(R)
  myIp(@Sys() c: RawCaller) {
    return cfg.myIp(this.s.on(c));
  }
  @Get(`${X}/languages/report`)
  @Route(R)
  languages(@Sys() c: RawCaller) {
    return cfg.languages(this.s.on(c));
  }
  @Post(`${X}/languages`)
  @Route(R)
  addLanguage(@Sys() c: RawCaller, @Body() b: LanguageDto) {
    return cfg.addLanguage(this.s.on(c), b);
  }
  @Get(`${X}/integrations`)
  @Route(R)
  integrations(@Sys() c: RawCaller) {
    return cfg.listIntegrations(this.s.on(c));
  }
  @Post(`${X}/integrations/pay-later`)
  @Route(W)
  payLater(@Sys() c: RawCaller, @Body() b: PayLaterDto) {
    return cfg.setPayLater(this.s.on(c), b.on);
  }
  @Get(`${X}/integrations/:key`)
  @Route(R)
  integration(@Sys() c: RawCaller, @Param("key") key: string) {
    return cfg.integration(this.s.on(c), key);
  }
  @Post(`${X}/integrations/:key/test`)
  @Route(R)
  test(@Sys() c: RawCaller, @Param("key") key: string) {
    return cfg.testIntegration(this.s.on(c), key);
  }
  @Post(`${X}/integrations/:key/credentials`)
  @Route(W)
  credential(
    @Sys() c: RawCaller,
    @Param("key") key: string,
    @Body() b: CredentialDto,
  ) {
    return cfg.setCredential(this.s.on(c), key, b);
  }
  @Patch(`${X}/integrations/:key`)
  @Route(R)
  setEnv(@Sys() c: RawCaller, @Param("key") key: string, @Body() b: EnvDto) {
    return cfg.setEnv(this.s.on(c), key, b.env);
  }

  @Get(`${X}/notifications/rules`)
  @Route(R)
  rules(@Sys() c: RawCaller) {
    return cfg.rules(this.s.on(c));
  }
  @Put(`${X}/notifications/rules`)
  @Route(R)
  putRules(@Sys() c: RawCaller, @Body() b: RulesDto) {
    return cfg.putRules(this.s.on(c), b.items as EventRuleVM[]);
  }
  @Get(`${X}/notifications/templates`)
  @Route(R)
  templates(@Sys() c: RawCaller) {
    return cfg.templates(this.s.on(c));
  }
  @Get(`${X}/notifications/templates/:key`)
  @Route(R)
  template(@Sys() c: RawCaller, @Param("key") key: string) {
    return cfg.template(this.s.on(c), key);
  }
  @Put(`${X}/notifications/templates/:key`)
  @Route(R)
  putTemplate(
    @Sys() c: RawCaller,
    @Param("key") key: string,
    @Body() b: TemplateDto,
  ) {
    return cfg.putTemplate(
      this.s.on(c),
      key,
      b as {
        languages: Record<Locale, TemplateBody | null>;
        category: TemplateVM["category"];
      },
    );
  }
  @Post(`${X}/notifications/templates/:key/:op`)
  @Route(R)
  templateOp(
    @Sys() c: RawCaller,
    @Param("key") key: string,
    @Param("op") op: string,
    @Body() b: ReasonDto,
  ) {
    return cfg.templateOp(this.s.on(c), key, op, b);
  }
  @Get(`${X}/notifications/deliveries`)
  @Route(R)
  deliveries(@Sys() c: RawCaller, @Query() q: DeliveriesQueryDto) {
    return cfg.deliveries(this.s.on(c), q);
  }
  @Get(`${X}/notifications/costs`)
  @Route(R)
  costs(@Sys() c: RawCaller) {
    return cfg.costs(this.s.on(c));
  }
  @Put(`${X}/notifications/costs/:channel`)
  @Route(R)
  budget(
    @Sys() c: RawCaller,
    @Param("channel") channel: string,
    @Body() b: BudgetDto,
  ) {
    return cfg.putBudget(this.s.on(c), channel, b.budget);
  }
}
