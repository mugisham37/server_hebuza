// Report catalogue (RPT §9): /api/reports/catalog · /{key} · /{key}/drill · POST /{key}/export · /exports/{id}.
// Finance users and executives (D12) only.
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { METRICS } from "@/domain/reports/metrics";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import { BackfillDto, DrillQueryDto, ExecSummaryOut, ExportDto, FINX, RunQueryDto, SubscriptionDto, TargetDto, ViewDto } from "./reports.dto";
import { ReportsService } from "./reports.service";

@Controller("reports")
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get("catalog")
  @Route({ auth: FINX })
  catalog() {
    return this.svc.catalog();
  }
  @Get("exec-summary")
  @Route({ auth: ["staff:executive", "staff:sysadmin"], out: ExecSummaryOut })
  execSummary() {
    return this.svc.execSummary();
  }
  @Post("rollups/backfill")
  @Route({ auth: ["staff:finance", "staff:sysadmin"], limit: "write" })
  backfill(@Body() b: BackfillDto) {
    return this.svc.backfill(b);
  }
  @Get("definitions")
  @Route({ auth: FINX })
  definitions() {
    return { items: Object.entries(METRICS).map(([key, d]) => ({ key, ...d })) };
  }
  @Get("targets")
  @Route({ auth: FINX })
  targets() {
    return this.svc.targets();
  }
  @Put("targets")
  @Route({ auth: ["staff:executive"], limit: "write", audit: "report.target_set" })
  setTarget(@Body() b: TargetDto) {
    return this.svc.setTarget(b);
  }
  @Get(":key/views")
  @Route({ auth: FINX })
  views(@Param("key") key: string, @CurrentUser() me: SessionUser) {
    return this.svc.views(me, key);
  }
  @Post(":key/views")
  @Route({ auth: FINX, limit: "write" })
  saveView(@Param("key") key: string, @Body() b: ViewDto, @CurrentUser() me: SessionUser) {
    return this.svc.saveView(me, key, b);
  }
  @Delete("views/:id")
  @Route({ auth: FINX, limit: "write" })
  deleteView(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.deleteView(me, id);
  }
  @Get("subscriptions")
  @Route({ auth: FINX })
  subscriptions(@CurrentUser() me: SessionUser) {
    return this.svc.subscriptions(me);
  }
  @Post("subscriptions")
  @Route({ auth: FINX, limit: "write", audit: "report.subscribed" })
  subscribe(@Body() b: SubscriptionDto, @CurrentUser() me: SessionUser) {
    return this.svc.subscribe(me, b);
  }
  @Delete("subscriptions/:id")
  @Route({ auth: FINX, limit: "write", audit: "report.unsubscribed" })
  unsubscribe(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.unsubscribe(me, id);
  }
  @Get("exports/:id")
  @Route({ auth: FINX })
  exportJob(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.exportJob(me, id);
  }
  @Get(":key/drill")
  @Route({ auth: FINX })
  drill(@Param("key") key: string, @Query() q: DrillQueryDto) {
    return this.svc.drill(key, q);
  }
  @Get(":key")
  @Route({ auth: FINX })
  report(@Param("key") key: string, @Query() q: RunQueryDto) {
    return this.svc.report(key, q);
  }
  @Post(":key/export")
  @Route({ auth: FINX, idempotent: true, limit: "write" })
  startExport(
    @Param("key") key: string,
    @Body() b: ExportDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.startExport(me, key, b);
  }
}
