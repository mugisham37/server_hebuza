import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentUser } from "../../core/auth/decorators";
import { TokenService } from "../../core/auth/tokens";
import type { SessionUser } from "../../core/http/context";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { AppError } from "../../core/http/errors";
import { Route } from "../../core/http/route";
import * as D from "./chat.dto";
import { ChatService, textPdf } from "./chat.service";


@Controller()
export class ChatController {
  constructor(
    private readonly svc: ChatService,
    private readonly tokens: TokenService,
  ) {}

  // ── conversations ──
  @Get("chat/conversations")
  @Route({ auth: "user", out: D.ConversationListOut })
  list(@Query() q: D.ListQueryDto, @CurrentUser() me: SessionUser) {
    return this.svc.myConversations(me, q);
  }

  @Post("chat/conversations")
  @Route({ auth: D.STAFF, limit: "write" })
  create(@Body() b: D.CreateConvDto, @CurrentUser() me: SessionUser) {
    const other = b.participant_id ?? b.user_id;
    if (!other)
      throw new AppError(422, "validation", "Pick someone to message.", {
        participant_id: "Required",
      });
    return this.svc.staffDm(me, other);
  }

  @Get("chat/conversations/by-application/:code")
  @Route({ auth: "user", out: D.ConversationOut })
  byApp(@Param("code") code: string, @CurrentUser() me: SessionUser) {
    return this.svc.byApplication(me, code);
  }

  @Get("chat/conversations/:id")
  @Route({ auth: "user", out: D.ConversationOut })
  one(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.conversation(me, id);
  }

  @Get("chat/conversations/:id/messages")
  @Route({ auth: "user", out: D.MessagesOut })
  messages(
    @Param("id") id: string,
    @Query() q: D.MessagesQueryDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.listMessages(me, id, q);
  }

  @Post("chat/conversations/:id/messages")
  @Route({
    auth: "user",
    limit: "write",
    idempotent: true,
    emit: "chat.message_sent",
    out: D.MessageOut,
  })
  send(
    @Param("id") id: string,
    @Body() b: D.SendDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.send(me, id, b);
  }

  /** JSON {filename,mime,size} → presigned PUT; the client confirms via POST /api/documents/:id/complete. */
  @Post("chat/conversations/:id/attachments")
  @Route({ auth: "user", limit: "write", out: D.AttachOut })
  attach(@Param("id") id: string, @Body() b: D.AttachDto, @CurrentUser() me: SessionUser) {
    return this.svc.attach(me, id, b);
  }

  @Get("chat/attachments/:id")
  @Route({ auth: "user" })
  @RawResponse()
  async attachment(
    @Param("id") id: string,
    @CurrentUser() me: SessionUser,
    @Res() reply: FastifyReply,
  ) {
    return reply.redirect(await this.svc.attachmentUrl(me, id), 302);
  }

  @Post("chat/conversations/:id/read")
  @Route({ auth: "user" })
  read(
    @Param("id") id: string,
    @Body() b: D.SeqDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.markRead(me, id, b.seq);
  }

  @Post("chat/conversations/:id/delivered")
  @Route({ auth: "user" })
  delivered(
    @Param("id") id: string,
    @Body() b: D.SeqDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.markDelivered(me, id, b.seq);
  }

  @Get("chat/conversations/:id/search")
  @Route({ auth: "user" })
  search(
    @Param("id") id: string,
    @Query() q: D.SearchQueryDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.search(me, id, q.q);
  }

  @Get("chat/conversations/:id/pinned")
  @Route({ auth: "user" })
  pinned(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.pinned(me, id);
  }

  @Post("chat/conversations/:id/typing")
  @Route({ auth: "user" })
  typing(
    @Param("id") id: string,
    @Body() b: D.TypingDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.typing(me, id, b.lane);
  }

  @Post("chat/conversations/:id/mute")
  @Route({ auth: "user" })
  mute(
    @Param("id") id: string,
    @Body() b: D.MuteDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.mute(me, id, b);
  }

  @Post("chat/conversations/:id/join")
  @Route({ auth: D.SMR })
  join(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.join(me, id);
  }

  @Post("chat/conversations/:id/leave")
  @Route({ auth: D.STAFF })
  leave(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.leave(me, id);
  }

  @Post("chat/conversations/:id/partner-lane")
  @Route({ auth: D.STAFF })
  partnerLane(
    @Param("id") id: string,
    @Body() b: D.LaneDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.partnerLane(me, id, b.open);
  }

  @Post("chat/conversations/:id/cards")
  @Route({ auth: D.STAFF, limit: "write" })
  card(
    @Param("id") id: string,
    @Body() b: D.CardDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.card(me, id, b);
  }

  @Post("chat/messages/:id/card-action")
  @Route({ auth: ["client"], limit: "write", audit: "chat.card.answered" })
  cardAction(@Param("id") id: string, @Body() b: D.CardActionDto, @CurrentUser() me: SessionUser) {
    return this.svc.cardAction(me, id, b.action);
  }

  @Post("chat/conversations/:id/legal-hold")
  @Route({ auth: D.STAFF, limit: "write", audit: "chat.legal_hold.changed" })
  legalHold(@Param("id") id: string, @Body() b: D.HoldDto, @CurrentUser() me: SessionUser) {
    return this.svc.setLegalHold(me, id, b.on);
  }

  // ── disputes ──
  @Get("chat/conversations/:id/dispute")
  @Route({ auth: "user" })
  dispute(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.disputeOf(me, id);
  }

  @Post("chat/conversations/:id/disputes")
  @Route({ auth: "user", idempotent: true })
  openDispute(
    @Param("id") id: string,
    @Body() b: D.DisputeDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.openDispute(me, id, b);
  }

  @Post("chat/disputes/:id/resolve")
  @Route({ auth: D.SM, permission: "fbk.ticket.resolve", idempotent: true })
  resolve(
    @Param("id") id: string,
    @Body() b: D.ResolveDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.closeDispute(me, id, b);
  }

  // ── messages ──
  @Patch("chat/messages/:id")
  @Route({ auth: "user", limit: "write" })
  edit(
    @Param("id") id: string,
    @Body() b: D.EditDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.edit(me, id, b.content);
  }

  @Delete("chat/messages/:id")
  @Route({ auth: "user", limit: "write" })
  remove(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.remove(me, id);
  }

  @Get("chat/messages/:id/history")
  @Route({ auth: "user" })
  history(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.history(me, id);
  }

  @Post("chat/messages/:id/reactions")
  @Route({ auth: "user", limit: "write" })
  react(
    @Param("id") id: string,
    @Body() b: D.ReactDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.react(me, id, b.emoji);
  }

  @Post("chat/messages/:id/pin")
  @Route({ auth: D.STAFF })
  pin(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.pin(me, id, true);
  }

  @Delete("chat/messages/:id/pin")
  @Route({ auth: D.STAFF })
  unpin(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.pin(me, id, false);
  }

  @Get("chat/messages/:id/event.ics")
  @Route({ auth: "user" })
  @RawResponse()
  async ics(
    @Param("id") id: string,
    @CurrentUser() me: SessionUser,
    @Res() reply: FastifyReply,
  ) {
    const body = await this.svc.ics(me, id);
    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", `attachment; filename="event-${id}.ics"`)
      .send(body);
  }

  // ── mentions, references, templates ──
  @Get("chat/mention-candidates/:id")
  @Route({ auth: D.STAFF })
  mentions(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.mentionCandidates(me, id);
  }

  @Get("chat/reference-candidates/:id")
  @Route({ auth: "user" })
  references(
    @Param("id") id: string,
    @Query() q: D.RefQueryDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.referenceCandidates(me, id, q);
  }

  @Get("chat/templates")
  @Route({ auth: D.STAFF })
  templates(@Query() q: D.RefQueryDto, @CurrentUser() me: SessionUser) {
    return this.svc.templates(me, q.q);
  }

  @Post("chat/templates")
  @Route({ auth: D.STAFF, limit: "write" })
  createTemplate(@Body() b: D.TemplateDto, @CurrentUser() me: SessionUser) {
    return this.svc.createTemplate(me, b);
  }

  @Patch("chat/templates/:id")
  @Route({ auth: D.STAFF, limit: "write" })
  updateTemplate(
    @Param("id") id: string,
    @Body() b: D.TemplatePatchDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.updateTemplate(me, id, b);
  }

  @Delete("chat/templates/:id")
  @Route({ auth: D.STAFF, limit: "write" })
  deleteTemplate(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.deleteTemplate(me, id);
  }

  @Post("chat/templates/:id/render")
  @Route({ auth: D.STAFF })
  render(
    @Param("id") id: string,
    @Query() q: D.RenderQueryDto,
    @Body() b: D.RenderDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.svc.renderTemplate(me, id, b.conversation_id, q.locale);
  }

  // ── ops console ── (static "counts" route is declared before ":id")
  @Get("admin/chat/conversations/counts")
  @Route({ auth: D.SMR, permission: "msg.console" })
  counts(@CurrentUser() me: SessionUser) {
    return this.svc.adminCounts(me);
  }

  @Get("admin/chat/conversations")
  @Route({ auth: D.SMR, permission: "msg.console" })
  adminList(@Query() q: D.AdminListQueryDto, @CurrentUser() me: SessionUser) {
    return this.svc.adminList(me, q);
  }

  @Get("admin/chat/metrics")
  @Route({ auth: D.SMR, permission: "msg.console" })
  metrics(@CurrentUser() me: SessionUser) {
    return this.svc.adminMetrics(me);
  }

  @Get("admin/chat/conversations/:id")
  @Route({ auth: D.SMR, permission: "msg.console" })
  adminOne(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.adminOne(me, id);
  }

  @Post("admin/chat/conversations/:id/claim")
  @Route({ auth: D.SM, permission: "msg.console" })
  claim(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.svc.adminClaim(me, id);
  }

  @Post("admin/chat/conversations/:id/link")
  @Route({ auth: D.SM, permission: "msg.console" })
  link(
    @Param("id") id: string,
    @Body() b: D.LinkDto,
    @CurrentUser() me: SessionUser,
  ) {
    const code = b.code ?? b.application_code;
    if (!code)
      throw new AppError(422, "validation", "Give an application code.", {
        code: "Required",
      });
    return this.svc.adminLink(me, id, code);
  }

  @Get("admin/chat/conversations/:id/transcript.pdf")
  @Route({ auth: D.SMR, permission: "msg.transcript.export" })
  @RawResponse()
  async transcript(
    @Param("id") id: string,
    @Query() q: D.TranscriptQueryDto,
    @Req() req: FastifyRequest,
    @CurrentUser() me: SessionUser,
    @Res() reply: FastifyReply,
  ) {
    const internal = q.include_internal === "true";
    // Internal notes leave the system only after step-up (spec §2.7).
    const raw = req.headers["x-step-up-token"];
    if (
      internal &&
      !(
        typeof raw === "string" &&
        (await this.tokens.verifyStepUp(raw, me).catch(() => false))
      )
    )
      throw new AppError(
        401,
        "step_up_required",
        "Confirm it's you to continue",
      );
    const format = q.format ?? "pdf";
    const t = await this.svc.transcript(me, id, internal, format);
    if (format === "csv") {
      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const csv = [
        "time,lane,sender,content",
        ...t.lines.map((l) =>
          [l.at, l.lane, esc(l.sender), esc(l.content)].join(","),
        ),
      ].join("\n");
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${t.name}.csv"`)
        .send(csv);
    }
    const pdf = textPdf(
      t.title,
      t.lines.map(
        (l) =>
          `${l.at.slice(0, 16).replace("T", " ")} · ${l.lane} · ${l.sender}: ${l.content}`,
      ),
    );
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `attachment; filename="${t.name}.pdf"`)
      .send(pdf);
  }
}
