import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import { ContractDto, CreateDto, DetailQueryDto, ListQueryDto, MANAGE, READ, ReviewDto, StatusDto } from "./workforce.dto";
import { WorkforceService } from "./workforce.service";

@Controller("staff/workers")
export class WorkforceController {
  constructor(private readonly svc: WorkforceService) {}

  @Get() @Route({ auth: READ })
  list(@Query() q: ListQueryDto) { return this.svc.list(q); }

  @Post() @Route({ auth: MANAGE, permission: "wrk.profiles.manage", limit: "write", idempotent: true, status: 201 })
  create(@Body() b: CreateDto, @CurrentUser() me: SessionUser) { return this.svc.create(me, b); }

  /** ?reveal=1 with an `x-reveal-reason` header = audited private-field read (service managers only). */
  @Get(":id") @Route({ auth: READ })
  get(@Param("id") id: string, @Query() q: DetailQueryDto, @Headers("x-reveal-reason") reason: string | undefined, @CurrentUser() me: SessionUser) {
    return q.reveal === "1" ? this.svc.reveal(me, id, decodeURIComponent(reason ?? "")) : this.svc.get(id);
  }

  @Post(":id/status") @Route({ auth: MANAGE, permission: "wrk.profiles.manage", limit: "write", idempotent: true })
  status(@Param("id") id: string, @Body() b: StatusDto, @CurrentUser() me: SessionUser) { return this.svc.setStatus(me, id, b); }

  @Post(":id/contracts") @Route({ auth: MANAGE, permission: "wrk.profiles.manage", limit: "write", idempotent: true, status: 201 })
  contract(@Param("id") id: string, @Body() b: ContractDto, @CurrentUser() me: SessionUser) { return this.svc.issueContract(me, id, b); }

  @Get(":id/reviews") @Route({ auth: READ })
  reviews(@Param("id") id: string) { return this.svc.reviews(id); }

  @Post(":id/reviews") @Route({ auth: MANAGE, limit: "write", idempotent: true, status: 201 })
  addReview(@Param("id") id: string, @Body() b: ReviewDto, @CurrentUser() me: SessionUser) { return this.svc.addReview(me, id, b); }

  @Get(":id/history") @Route({ auth: READ })
  history(@Param("id") id: string) { return this.svc.history(id); }

  @Get(":id/assignees") @Route({ auth: READ })
  assignees(@Param("id") id: string) { return this.svc.assignees(id); }
}
