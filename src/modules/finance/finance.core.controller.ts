// Finance read models, settings (effective-dated, executive approval), numbering series, payout accounts, change
// history, overview and journal export (reference finance.routes "core" + "overview" sections).
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
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import { ReportsService } from "../reports/reports.service";
import type { JournalBody } from "../reports/lib/types";
import * as core from "./finance.core";
import { one, put, today } from "./finance.store";
import { AcceptedInterceptor, FinRunner } from "./finance.runner";
import * as D from "./finance.dto";

@Controller()
@UseInterceptors(AcceptedInterceptor)
export class FinanceCoreController {
  constructor(
    private readonly r: FinRunner,
    private readonly reports: ReportsService,
  ) {}

  @Get("finance/x/summary")
  @Route({ auth: D.FINX })
  summary() {
    return this.r.read((f) => core.summary(f));
  }
  @Get("finance/x/approvals")
  @Route({ auth: D.FINX })
  approvals(@Query() q: D.ApprovalsQueryDto) {
    return this.r.read((f) => core.approvals(f, q.type));
  }
  @Get("finance/x/notifications")
  @Route({ auth: D.FINX })
  notes() {
    return this.r.read((f) => core.notes(f));
  }
  @Get("finance/x/payables-due")
  @Route({ auth: D.FINX })
  payablesDue() {
    return this.r.read((f) => core.payablesDue(f.db));
  }

  // ---- settings: VAT, terms, deposits, thresholds, WHT, payout day (SET §7)
  @Get("finance/settings")
  @Route({ auth: D.FINX })
  settings() {
    return this.r.read((f) => core.getSettings(f));
  }
  @Patch("finance/settings")
  @Route({ auth: D.FIN, ...D.W })
  propose(@Body() b: D.SettingDto) {
    return this.r.write((f) =>
      core.proposeSetting(f, b as Parameters<typeof core.proposeSetting>[1]),
    );
  }
  @Get("staff/settings/changes")
  @Route({ auth: D.FINX })
  changes() {
    return this.r.read((f) => core.settingChanges(f));
  }
  @Post("staff/settings/changes/:id/decision")
  @Route({ auth: D.EXEC, stepUp: true, ...D.W })
  decide(@Param("id") id: string, @Body() b: D.DecisionDto) {
    return this.r.write((f) => core.decideSetting(f, id, b.decision, b.reason));
  }

  // ---- numbering series + local policies
  @Get("finance/x/settings/numbering")
  @Route({ auth: D.FINX })
  numbering() {
    return this.r.read((f) => core.numbering(f));
  }
  @Get("finance/x/settings/policies")
  @Route({ auth: D.FINX })
  policies() {
    return this.r.read((f) => core.policySettings(f));
  }
  @Post("finance/x/settings/changes")
  @Route({ auth: D.FIN, ...D.W })
  proposeLocal(@Body() b: D.LocalChangeDto) {
    return this.r.write((f) => core.proposeLocal(f, b));
  }
  @Post("finance/x/settings/changes/:id/decision")
  @Route({ auth: D.EXEC, stepUp: true, ...D.W })
  decideLocal(@Param("id") id: string, @Body() b: D.DecisionDto) {
    return this.r.write((f) => core.decideLocal(f, id, b.decision, b.reason));
  }

  // ---- payout accounts
  @Get("finance/x/settings/accounts")
  @Route({ auth: D.FINX })
  accounts() {
    return this.r.read((f) => core.accounts(f));
  }
  @Post("finance/x/settings/accounts")
  @Route({ auth: D.FIN, stepUp: true, ...D.W })
  addAccount(@Body() b: D.AccountDto) {
    return this.r.write((f) => core.addAccount(f, b));
  }
  @Post("finance/x/settings/accounts/:id/callback")
  @Route({ auth: D.FIN, ...D.W })
  callback(@Param("id") id: string) {
    return this.r.write((f) => core.verifyAccount(f, id));
  }
  @Post("finance/x/settings/accounts/:id/reveal")
  @Route({ auth: D.FIN, stepUp: true, limit: "write" })
  reveal(@Param("id") id: string) {
    return this.r.read((f) => core.revealAccount(f, id));
  }

  // ---- history
  @Get("finance/x/settings/history")
  @Route({ auth: D.FINX })
  history(@Query() q: D.HistoryQueryDto) {
    return this.r.read((f) => core.history(f, q));
  }
  @Post("finance/x/settings/history/export")
  @Route({ auth: D.FINX, limit: "write" })
  exportHistory(@Query() q: D.HistoryQueryDto) {
    return this.r.read((f) => core.exportHistory(f, q));
  }

  // ---- overview + journal export (computed by ReportsService)
  @Get("finance/x/overview")
  @Route({ auth: D.FINX })
  overview(@Query() q: D.OverviewQueryDto, @CurrentUser() me: SessionUser) {
    return this.reports.overview(me, q.date?.slice(0, 10) ?? today());
  }
  @Get("finance/x/cash-position")
  @Route({ auth: D.FINX })
  cashPosition() {
    return this.reports.cashPosition();
  }
  /** Saved account mapping for journal exports (shared by the finance team). */
  @Get("finance/exports/journal/map")
  @Route({ auth: D.FINX })
  journalMap() {
    return this.r.read(async (f) => ({ map: (await one<{ id: string; value: Record<string, string> }>(f.db, "config", "journal_map"))?.value ?? null }));
  }
  @Put("finance/exports/journal/map")
  @Route({ auth: D.FIN, limit: "write" })
  saveJournalMap(@Body() b: D.JournalMapDto) {
    return this.r.write(async (f) => {
      const before = (await one<{ id: string; value: Record<string, string> }>(f.db, "config", "journal_map"))?.value ?? null;
      await put(f.db, "config", "journal_map", { id: "journal_map", value: b.map });
      f.rec("setting.journal_map.changed", "config", "journal_map", before, b.map, null, "data");
      return { map: b.map };
    });
  }
  @Post("finance/exports/journal/preview")
  @Route({ auth: D.FINX, limit: "write" })
  journalPreview(@Body() b: D.JournalDto) {
    return this.reports.journalPreview(b as JournalBody);
  }
  @Post("finance/exports/journal")
  @Route({ auth: D.FINX, stepUp: true, idempotent: true, limit: "write" })
  journalExport(@Body() b: D.JournalDto) {
    return this.reports.journalExport(b as JournalBody);
  }
}
