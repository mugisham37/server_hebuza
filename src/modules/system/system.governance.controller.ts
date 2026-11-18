// Roles, separation of duties, access reviews and break-glass (reference handlers-system-c).
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
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
import * as gov from "./system.governance";
import {
  BreakGlassDto,
  BulkKeepDto,
  LooseDto,
  NoteDto,
  ReviewItemDto,
  SodCheckQueryDto,
  WaiverDto,
} from "./system.dto";

const R = { auth: "user" } as const;
const W = { auth: "user", idempotent: true } as const;
const X = "staff/x";

@Controller()
@UseInterceptors(AcceptedInterceptor)
export class SystemGovernanceController {
  constructor(private readonly s: SystemStore) {}

  @Get(`${X}/roles`)
  @Route(R)
  roles(@Sys() c: RawCaller) {
    return gov.listRoles(this.s.on(c));
  }
  @Get(`${X}/roles/:slug`)
  @Route(R)
  role(@Sys() c: RawCaller, @Param("slug") slug: string) {
    return gov.roleDetail(this.s.on(c), slug);
  }
  @Post(`${X}/roles`)
  @Route(W)
  propose(@Sys() c: RawCaller, @Body() b: LooseDto) {
    return gov.proposeRole(this.s.on(c), b as gov.RoleIn);
  }
  @Patch(`${X}/roles/:slug`)
  @Route(W)
  edit(@Sys() c: RawCaller, @Param("slug") slug: string, @Body() b: LooseDto) {
    return gov.proposeRole(this.s.on(c), b as gov.RoleIn, slug);
  }
  @Post(`${X}/roles/:slug/retire`)
  @Route(W)
  retire(@Sys() c: RawCaller, @Param("slug") slug: string) {
    return gov.retireRole(this.s.on(c), slug);
  }
  @Get(`${X}/sod/check`)
  @Route(R)
  sodCheck(@Sys() c: RawCaller, @Query() q: SodCheckQueryDto) {
    return gov.sodCheck(this.s.on(c), q.roles ?? "");
  }
  @Get(`${X}/sod`)
  @Route(R)
  sod(@Sys() c: RawCaller) {
    return gov.sodView(this.s.on(c));
  }
  @Post(`${X}/sod/waivers`)
  @Route(W)
  waiver(@Sys() c: RawCaller, @Body() b: WaiverDto) {
    return gov.proposeWaiver(this.s.on(c), b);
  }
  @Get(`${X}/access-reviews`)
  @Route(R)
  reviews(@Sys() c: RawCaller) {
    return gov.listReviews(this.s.on(c));
  }
  @Get(`${X}/access-reviews/:id`)
  @Route(R)
  review(@Sys() c: RawCaller, @Param("id") id: string) {
    return gov.reviewDetail(this.s.on(c), id);
  }
  @Patch(`${X}/access-reviews/:id/items/:itemId`)
  @Route(W)
  decideItem(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Body() b: ReviewItemDto,
  ) {
    return gov.decideItem(this.s.on(c), id, itemId, b);
  }
  @Post(`${X}/access-reviews/:id/bulk-keep`)
  @Route(W)
  bulkKeep(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Body() b: BulkKeepDto,
  ) {
    return gov.bulkKeep(this.s.on(c), id, b.ids);
  }
  @Post(`${X}/access-reviews/:id/sign-off`)
  @Route(W)
  signOff(@Sys() c: RawCaller, @Param("id") id: string) {
    return gov.signOff(this.s.on(c), id);
  }
  @Post(`${X}/access-reviews/:id/export`)
  @Route({ ...W, limit: "write" })
  exportReview(@Sys() c: RawCaller, @Param("id") id: string) {
    return gov.exportReview(this.s.on(c), id);
  }
  @Get(`${X}/break-glass`)
  @Route(R)
  breakGlass(@Sys() c: RawCaller) {
    return gov.breakGlass(this.s.on(c));
  }
  @Post(`${X}/break-glass`)
  @Route(W)
  requestBreakGlass(@Sys() c: RawCaller, @Body() b: BreakGlassDto) {
    return gov.requestBreakGlass(
      this.s.on(c),
      b as Parameters<typeof gov.requestBreakGlass>[1],
    );
  }
  @Post(`${X}/break-glass/end`)
  @Route(W)
  endBreakGlass(@Sys() c: RawCaller) {
    return gov.endBreakGlass(this.s.on(c));
  }
  @Post(`${X}/break-glass/review`)
  @Route(W)
  reviewBreakGlass(@Sys() c: RawCaller, @Body() b: NoteDto) {
    return gov.reviewBreakGlass(this.s.on(c), b.note);
  }
}
