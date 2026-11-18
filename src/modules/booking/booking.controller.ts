// Booking routes (reference booking.routes.ts). Versions travel in the body (the UI sends `version`, not If-Match);
// non-owned bookings answer 404, never 403.
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import * as D from "./booking.dto";
import { BookingService } from "./booking.service";

@Controller()
export class BookingController {
  constructor(private readonly svc: BookingService) {}

  // ── public
  @Get("consultation-types")
  @Route({ auth: "public", limit: "read" })
  types(@Query() q: D.TypesQ) {
    return this.svc.listTypes(q.contact);
  }
  @Get("consultation-types/:slug")
  @Route({ auth: "public", limit: "read" })
  type(@Param("slug") slug: string) {
    return this.svc.getType(slug);
  }
  @Get("consultation-types/:slug/slots")
  @Route({ auth: "public", limit: "read" })
  slots(@Param("slug") slug: string, @Query() q: D.SlotsQ) {
    return this.svc.slots(slug, q);
  }
  @Get("consultation-advisers")
  @Route({ auth: "public", limit: "read" })
  advisers(@Query() q: D.AdvisersQ) {
    return this.svc.advisers(q.type);
  }
  @Post("bookings/hold")
  @Route({ auth: "public", limit: "auth", idempotent: true })
  hold(@Body() b: D.HoldDto) {
    return this.svc.hold(b);
  }
  @Get("bookings/:id/hold")
  @Route({ auth: "public" })
  holdStatus(@Param("id") id: string) {
    return this.svc.holdStatus(id);
  }
  @Delete("bookings/:id/hold")
  @Route({ auth: "public" })
  releaseHold(@Param("id") id: string) {
    return this.svc.releaseHold(id);
  }
  @Post("bookings/:id/confirm")
  @Route({ auth: "public", limit: "auth", idempotent: true })
  confirm(@Param("id") id: string, @Body() b: D.ConfirmDto) {
    return this.svc.confirm(id, b);
  }
  @Post("bookings/:id/pay")
  @Route({ auth: "public", limit: "auth", idempotent: true })
  pay(@Param("id") id: string, @Body() b: D.PayDto) {
    return this.svc.pay(id, b);
  }
  @Get("bookings/pay/:tx")
  @Route({ auth: "public" })
  payStatus(@Param("tx") tx: string) {
    return this.svc.payStatus(tx);
  }
  @Get("bookings/public/:ref")
  @Route({ auth: "public", limit: "read" })
  byConfirmKey(
    @Param("ref") ref: string,
    @Headers("x-confirm-key") key: string | undefined,
    @Query() q: D.LangQ,
  ) {
    return this.svc.byConfirmKey(ref, key, q.lang);
  }
  @Get("bookings/manage/:token")
  @Route({ auth: "public", limit: "read" })
  manageView(@Param("token") tk: string, @Query() q: D.LangQ) {
    return this.svc.manageView(tk, q.lang);
  }
  @Post("bookings/manage/:token/cancel")
  @Route({ auth: "public", idempotent: true })
  manageCancel(@Param("token") tk: string, @Body() b: D.CancelDto) {
    return this.svc.manageCancel(tk, b);
  }
  @Post("bookings/manage/:token/reschedule")
  @Route({ auth: "public", idempotent: true })
  manageReschedule(@Param("token") tk: string, @Body() b: D.RescheduleDto) {
    return this.svc.manageReschedule(tk, b);
  }
  @Get("bookings/manage/:token/join")
  @Route({ auth: "public" })
  manageJoin(@Param("token") tk: string) {
    return this.svc.manageJoin(tk);
  }
  @Post("bookings/manage/resend")
  @Route({ auth: "public", limit: "auth" })
  resend(@Body() b: D.ResendDto) {
    return this.svc.resend(b);
  }
  @Post("consultation-requests")
  @Route({ auth: "public", limit: "auth", idempotent: true })
  createRequest(@Body() b: D.RequestDto) {
    return this.svc.createRequest(b);
  }
  @Post("bookings/waitlist")
  @Route({ auth: "public", limit: "auth" })
  waitlist(@Body() b: D.WaitlistDto) {
    return this.svc.joinWaitlist(b);
  }

  // ── client portal
  @Get("me/bookings")
  @Route({ auth: D.CLIENT })
  myBookings(@CurrentUser() me: SessionUser, @Query() q: D.MyBookingsQ) {
    return this.svc.myBookings(me, q);
  }
  @Get("me/bookings/:id")
  @Route({ auth: D.CLIENT })
  myBooking(
    @CurrentUser() me: SessionUser,
    @Param("id") id: string,
    @Query() q: D.LangQ,
  ) {
    return this.svc.myBooking(me, id, q.lang);
  }
  @Post("me/bookings/:id/cancel")
  @Route({ auth: D.CLIENT, idempotent: true })
  myCancel(
    @CurrentUser() me: SessionUser,
    @Param("id") id: string,
    @Body() b: D.CancelDto,
  ) {
    return this.svc.myCancel(me, id, b);
  }
  @Post("me/bookings/:id/reschedule")
  @Route({ auth: D.CLIENT, idempotent: true })
  myReschedule(
    @CurrentUser() me: SessionUser,
    @Param("id") id: string,
    @Body() b: D.RescheduleDto,
  ) {
    return this.svc.myReschedule(me, id, b);
  }
  @Get("me/bookings/:id/join")
  @Route({ auth: D.CLIENT })
  myJoin(@CurrentUser() me: SessionUser, @Param("id") id: string) {
    return this.svc.myJoin(me, id);
  }

  // ── adviser
  @Get("agent/bookings")
  @Route({ auth: D.ADVISER })
  adviserBookings(@CurrentUser() me: SessionUser, @Query() q: D.RangeQ) {
    return this.svc.adviserBookings(me, q);
  }
  @Get("agent/bookings/:id")
  @Route({ auth: D.ADVISER })
  room(@CurrentUser() me: SessionUser, @Param("id") id: string) {
    return this.svc.room(me, id);
  }
  @Get("agent/bookings/:id/join")
  @Route({ auth: D.ADVISER })
  staffJoin(@CurrentUser() me: SessionUser, @Param("id") id: string) {
    return this.svc.staffJoin(me, id);
  }
  @Patch("agent/bookings/:id/notes")
  @Route({ auth: D.ADVISER })
  notes(
    @CurrentUser() me: SessionUser,
    @Param("id") id: string,
    @Body() b: D.NotesDto,
  ) {
    return this.svc.saveNotes(me, id, b);
  }
  @Patch("agent/bookings/:id/outcome")
  @Route({ auth: D.ADVISER, idempotent: true })
  outcome(
    @CurrentUser() me: SessionUser,
    @Param("id") id: string,
    @Body() b: D.OutcomeDto,
  ) {
    return this.svc.outcome(me, id, b);
  }
  @Post("agent/bookings/:id/quote-request")
  @Route({ auth: D.ADVISER, idempotent: true })
  quote(
    @CurrentUser() me: SessionUser,
    @Param("id") id: string,
    @Body() b: D.QuoteDto,
  ) {
    return this.svc.quoteRequest(me, id, b);
  }
  @Get("agent/availability")
  @Route({ auth: D.ADVISER })
  availability(@CurrentUser() me: SessionUser) {
    return this.svc.myAvailability(me);
  }
  @Put("agent/availability")
  @Route({ auth: D.ADVISER })
  setAvailability(
    @CurrentUser() me: SessionUser,
    @Body() b: D.AvailabilityDto,
  ) {
    return this.svc.setAvailability(me, b);
  }

  // ── service manager
  @Get("admin/bookings")
  @Route({ auth: D.BOARD })
  adminList(@Query() q: D.AdminListQ) {
    return this.svc.adminList(q);
  }
  @Get("admin/bookings/analytics")
  @Route({ auth: D.BOARD })
  analytics() {
    return this.svc.analytics();
  }
  @Get("admin/bookings/:id")
  @Route({ auth: D.BOARD }) // marketing reads the board but not rooms → 404
  adminRoom(@CurrentUser() me: SessionUser, @Param("id") id: string) {
    return this.svc.room(me, id, true);
  }
  @Patch("admin/bookings/:id")
  @Route({ auth: D.SM, idempotent: true })
  adminPatch(@Param("id") id: string, @Body() b: D.AdminPatchDto) {
    return this.svc.adminPatch(id, b);
  }
  @Post("admin/bookings/auto-reassign")
  @Route({ auth: D.SM })
  autoReassign(@Body() b: D.AutoReassignDto) {
    return this.svc.autoReassign(b.adviser_id);
  }
  @Post("admin/bookings")
  @Route({ auth: D.SM, idempotent: true })
  staffCreate(@Body() b: D.StaffCreateDto) {
    return this.svc.staffCreate(b);
  }
  @Get("admin/consultation-requests")
  @Route({ auth: D.SM })
  requests() {
    return this.svc.listRequests();
  }
  @Patch("admin/consultation-requests/:id")
  @Route({ auth: D.SM })
  closeRequest(@Param("id") id: string, @Body() b: D.CloseRequestDto) {
    return this.svc.closeRequest(id, b);
  }
  @Get("admin/consultation-types")
  @Route({ auth: D.BOARD })
  typesAdmin(@CurrentUser() me: SessionUser) {
    return this.svc.typesAdmin(me);
  }
  @Post("admin/consultation-types")
  @Route({ auth: D.SM })
  createType(@Body() b: D.TypeDto) {
    return this.svc.createType(b);
  }
  @Patch("admin/consultation-types/:id")
  @Route({ auth: D.BOARD })
  patchType(
    @CurrentUser() me: SessionUser,
    @Param("id") id: string,
    @Body() b: D.TypePatchDto,
  ) {
    return this.svc.patchType(me, id, b);
  }
}
