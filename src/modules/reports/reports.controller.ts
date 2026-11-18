// Report catalogue (RPT §9): /api/reports/catalog · /{key} · /{key}/drill · POST /{key}/export · /exports/{id}.
// Finance users and executives (D12) only.
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import { DrillQueryDto, ExecSummaryOut, ExportDto, FINX, RunQueryDto } from "./reports.dto";
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
