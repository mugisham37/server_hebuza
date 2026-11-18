import { Body, Controller, Get, Headers, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { dto } from "../../core/http/dto";
import { z } from "zod";
import { CurrentUser, ImpersonationOk } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { Route } from "../../core/http/route";
import { RealtimeService } from "./realtime.service";

export const HEARTBEAT_MS = 25_000;
export const MAX_STREAM_MS = 30 * 60_000;
const TicketOut = z.object({ ticket: z.string(), expires_in: z.number().int() }).meta({ id: "TicketResponse" });
class FocusDto extends dto(z.object({ focus: z.string().max(128).nullable() })) {}

@Controller("realtime")
export class RealtimeController {
  constructor(private readonly rt: RealtimeService) {}

  // EventSource cannot send headers: the browser trades its cookie session for a single-use 60 s ticket.
  @Post("ticket") @ImpersonationOk() // live updates still work while viewing as someone
  @Route({ auth: "user", limit: "write", out: TicketOut }) // one per page load: the 10/min login bucket starves multi-tab users
  ticket(@CurrentUser() me: SessionUser) {
    return this.rt.issueTicket(me.id);
  }

  @Post("focus")
  @Route({ auth: "user", out: z.object({ ok: z.boolean() }) })
  async focus(@Body() b: FocusDto, @CurrentUser() me: SessionUser) {
    await this.rt.setFocus(me.id, b.focus);
    return { ok: true };
  }

  @Get("stream")
  @Route({ auth: "public" })
  @RawResponse()
  async stream(
    @Query("ticket") ticket: string | undefined,
    @Query("last_event_id") lastQ: string | undefined,
    @Headers("last-event-id") lastH: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    let uid: string | null;
    try {
      uid = await this.rt.consumeTicket(ticket ?? "");
    } catch {
      throw this.rt.unavailable();
    }
    if (!uid || !(await this.rt.isActive(uid)))
      return reply.status(401).header("cache-control", "no-store")
        .send({ success: false, message: "Invalid or expired realtime ticket.", errorType: "unauthorized", data: null });

    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>), // CORS etc. set by hooks
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no",
    });
    const started = Date.now();
    let closed = false;
    const send = (s: string) => {
      if (closed) return;
      // Backpressure: a client that stopped reading is dropped; it reconnects with a fresh ticket.
      if (res.writableLength > 1 << 20) return close();
      res.write(s);
    };
    const unsub = this.rt.listen(uid, send);
    const beat = setInterval(() => {
      void this.rt.isActive(uid).catch(() => false).then((ok) => (!ok || Date.now() - started > MAX_STREAM_MS ? close() : send(": ping\n\n")));
    }, HEARTBEAT_MS);
    function close() {
      if (closed) return;
      closed = true;
      unsub();
      clearInterval(beat);
      res.end();
    }
    req.raw.on("close", close);
    send(": connected\n\n");
    for (const f of await this.rt.replay(uid, lastH ?? lastQ ?? "").catch(() => [])) send(f);
  }
}
