// Marketing CRM (reference marketing.routes: public capture, leads, tasks & notes, inbox, customers) + unsubscribe.
import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Route, IfMatch } from "../../core/http/route";
import { CryptoService } from "../../core/crypto/crypto.service";
import { AppError } from "../../core/http/errors";
import { Req, type OpsReq } from "../ops/ops.runner";
import * as crm from "./marketing.crm";
import { MarketingRunner } from "./marketing.runner";
import * as D from "./marketing.dto";

const { MKT, STAFF } = D;

@Controller()
export class MarketingCrmController {
  constructor(
    private readonly m: MarketingRunner,
    private readonly crypto: CryptoService,
  ) {}

  @Post("leads")
  @Route({ auth: "public", limit: "auth" })
  capture(@Req() r: OpsReq, @Body() b: D.PublicLeadDto) {
    return this.m.run(r.user ? r : null, (c) => crm.capturePublic(c, b));
  }

  /** Campaign footer link (web /unsubscribe page posts the token). */
  @Post("marketing/unsubscribe")
  @Route({ auth: "public", limit: "auth" })
  unsubscribe(@Body() b: D.UnsubscribeDto) {
    const t = crm.readUnsubToken(this.crypto, b.token);
    return this.m.run(null, (c) => crm.unsubscribe(c.db, t));
  }

  // ---- leads
  @Get("admin/crm/leads")
  @Route({ auth: STAFF, permission: "crm.leads.read" })
  leads() {
    return this.m.read((db) => crm.leadsList(db));
  }
  @Post("admin/crm/leads/bulk")
  @Route({ auth: MKT, audit: "lead.bulk_updated" })
  bulk(@Req() r: OpsReq, @Body() b: D.BulkDto) {
    return this.m.run(r, (c) => crm.bulk(c, b));
  }
  @Post("admin/crm/leads/export")
  @Route({ auth: MKT, limit: "write", audit: "lead.exported" })
  exportLeads(@Req() r: OpsReq, @Body() b: D.IdsDto) {
    return this.m.run(r, (c) => crm.exportLeads(c, b.ids));
  }
  @Post("admin/crm/leads/merge")
  @Route({ auth: MKT, audit: "lead.merged" })
  merge(@Req() r: OpsReq, @Body() b: D.MergeDto) {
    return this.m.run(r, (c) => crm.merge(c, b));
  }
  @Post("admin/crm/leads/import")
  @Route({ auth: MKT })
  importPreview(@Req() r: OpsReq, @Body() b: D.ImportDto) {
    return this.m.run(r, (c) => crm.importPreview(c, b));
  }
  @Post("admin/crm/leads/import/:job/confirm")
  @Route({ auth: MKT, idempotent: true, audit: "lead.imported" })
  importConfirm(@Req() r: OpsReq, @Param("job") job: string) {
    return this.m.run(r, (c) => crm.importConfirm(c, job));
  }
  @Post("admin/crm/leads")
  @Route({ auth: MKT })
  create(@Req() r: OpsReq, @Body() b: D.StaffLeadDto) {
    return this.m.run(r, (c) =>
      crm.createStaffLead(c, {
        ...b,
        consent: { email: "unknown", whatsapp: "unknown", sms: "unknown", ...b.consent },
        nextActionAt: b.nextActionAt ?? "",
      }),
    );
  }
  @Get("admin/crm/leads/:id")
  @Route({ auth: STAFF, permission: "crm.leads.read" })
  lead(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => crm.leadDetail(c, id));
  }
  @Patch("admin/crm/leads/:id")
  @Route({ auth: MKT })
  patch(@Req() r: OpsReq, @Param("id") id: string, @IfMatch() v: string | null, @Body() b: D.LeadPatchDto) {
    return this.m.run(r, (c) => crm.patchLead(c, id, v, b as crm.LeadPatchIn));
  }
  @Post("admin/crm/leads/:id/activity")
  @Route({ auth: MKT })
  activity(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.ActivityDto) {
    return this.m.run(r, (c) => crm.logActivity(c, id, b));
  }
  @Post("admin/crm/leads/:id/convert")
  @Route({ auth: MKT, idempotent: true, audit: "lead.converted" })
  convert(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.ConvertDto) {
    return this.m.run(r, (c) => crm.convert(c, id, b));
  }

  // ---- tasks & notes
  @Get("admin/crm/tasks")
  @Route({ auth: MKT })
  tasks(@Req() r: OpsReq) {
    return this.m.run(r, (c) => crm.myTasks(c));
  }
  @Post("admin/crm/tasks")
  @Route({ auth: MKT })
  createTask(@Req() r: OpsReq, @Body() b: D.TaskDto) {
    return this.m.run(r, (c) => crm.createTask(c, b));
  }
  @Patch("admin/crm/tasks/:id")
  @Route({ auth: MKT })
  patchTask(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.TaskPatchDto) {
    return this.m.run(r, (c) => crm.patchTask(c, id, b));
  }
  @Post("admin/crm/:type/:id/notes")
  @Route({ auth: MKT })
  note(@Req() r: OpsReq, @Param("type") type: string, @Param("id") id: string, @Body() b: D.NoteDto) {
    if (type !== "lead" && type !== "customer") throw new AppError(404, "not_found", "Resource not found.");
    return this.m.run(r, (c) => crm.addNote(c, type, id, b));
  }

  // ---- inbox
  @Get("admin/crm/inbox")
  @Route({ auth: MKT })
  inbox() {
    return this.m.read((db) => crm.inbox(db));
  }
  @Post("admin/crm/inbox/:id/reply")
  @Route({ auth: MKT })
  reply(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.ReplyDto) {
    return this.m.run(r, (c) => crm.reply(c, id, b));
  }
  @Post("admin/crm/inbox/:id/:action")
  @Route({ auth: MKT })
  threadAction(@Req() r: OpsReq, @Param("id") id: string, @Param("action") action: string, @Body() b: D.ThreadActionDto) {
    return this.m.run(r, (c) => crm.threadAction(c, id, action, b));
  }

  // ---- customers
  @Get("admin/crm/customers")
  @Route({ auth: STAFF })
  customers(@Query() q: D.CustomersQueryDto) {
    return this.m.read((db) => crm.customers(db, q.lead));
  }
  @Get("admin/crm/customers/:id")
  @Route({ auth: STAFF })
  customer(@Req() r: OpsReq, @Param("id") id: string) {
    return this.m.run(r, (c) => crm.customer360(c, id));
  }
}
