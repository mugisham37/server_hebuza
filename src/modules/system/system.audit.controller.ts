// Audit viewer: filtered list, sensitive reads, chain integrity + verification, export, single entry (handlers-system-e).
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { Route } from "../../core/http/route";
import { Sys, SystemStore, type RawCaller } from "./system.store";
import * as aud from "./system.audit";
import { AuditExportDto, AuditQueryDto } from "./system.dto";

const R = { auth: "user" } as const;

@Controller("staff/audit")
export class SystemAuditController {
  constructor(private readonly s: SystemStore) {}

  @Get()
  @Route(R)
  list(@Sys() c: RawCaller, @Query() q: AuditQueryDto) {
    return aud.listAudit(this.s.on(c), q);
  }
  @Get("sensitive")
  @Route(R)
  sensitive(@Sys() c: RawCaller) {
    return aud.sensitive(this.s.on(c));
  }
  @Get("integrity")
  @Route(R)
  integrity(@Sys() c: RawCaller) {
    return aud.integrity(this.s.on(c));
  }
  @Post("integrity/verify")
  @Route({ ...R, limit: "write" })
  verify(@Sys() c: RawCaller) {
    return aud.verifyNow(this.s.on(c));
  }
  @Get("integrity/report")
  @Route(R)
  report(@Sys() c: RawCaller) {
    return aud.integrityReport(this.s.on(c));
  }
  @Post("export")
  @Route({ ...R, idempotent: true, limit: "write" })
  export(
    @Sys() c: RawCaller,
    @Query() q: AuditQueryDto,
    @Body() b: AuditExportDto,
  ) {
    return aud.exportAudit(this.s.on(c), b.format, q);
  }
  @Get("entries/:id")
  @Route(R)
  entry(@Sys() c: RawCaller, @Param("id") id: string) {
    return aud.entry(this.s.on(c), id);
  }
  @Post("entries/:id/verify")
  @Route(R)
  verifyEntry(@Sys() c: RawCaller, @Param("id") id: string) {
    return aud.verifyEntry(this.s.on(c), id);
  }
}
