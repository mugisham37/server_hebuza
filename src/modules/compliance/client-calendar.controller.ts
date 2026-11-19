// F-CAL-04: the client's own compliance calendar (list + private ICS feed URL + the feed calendar apps poll).
import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply } from "fastify";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { complianceRules } from "@/db/schema/schema-ops";
import { z } from "zod";
import { clientObligations } from "@/db/schema";
import { obligationsIcs } from "@/domain/deadlines/ics";
import { CurrentUser } from "../../core/auth/decorators";
import type { Env } from "../../core/config/env";
import { CryptoService, safeEqual } from "../../core/crypto/crypto.service";
import { DB, type Db } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { RawResponse } from "../../core/http/envelope.interceptor";
import type { SessionUser } from "../../core/http/context";
import { AppError } from "../../core/http/errors";
import { Route } from "../../core/http/route";

const Item = z.object({ id: z.string(), label: z.record(z.string(), z.string()), due_date: z.string(), status: z.string(), application_id: z.string().nullable(), rule_code: z.string().nullable() });
export const CalendarOut = z.object({ items: z.array(Item), ics_url: z.string() }).meta({ id: "ClientCalendarResponse" });
const title = (l: unknown) => { const o = (l ?? {}) as Record<string, string>; return o.en ?? o.rw ?? o.fr ?? "Deadline"; };

@Controller()
export class ClientCalendarController {
  constructor(
    private readonly tx: TxService,
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly cfg: ConfigService<Env, true>,
  ) {}

  /** Token = user id + keyed HMAC: unguessable, stable, revoked by rotating BLIND_INDEX_KEY. */
  private token(userId: string) {
    return `${userId}.${this.crypto.blindIndex(`ics:${userId}`).slice(0, 32)}`;
  }

  @Get("me/obligations")
  @Route({ auth: ["client"], out: CalendarOut })
  async list(@CurrentUser() me: SessionUser) {
    const rows = await this.tx.run((t) => t.select().from(clientObligations)
      .where(and(eq(clientObligations.clientId, me.id), gte(clientObligations.dueDate, sql`current_date - 90`))).orderBy(asc(clientObligations.dueDate)));
    const ruleIds = [...new Set(rows.map((r) => r.ruleId).filter((x): x is string => !!x))];
    const codes = new Map(ruleIds.length ? (await this.tx.run((t) => t.select({ id: complianceRules.id, code: complianceRules.code }).from(complianceRules).where(inArray(complianceRules.id, ruleIds)))).map((r) => [r.id, r.code]) : []);
    const base = (this.cfg.get("API_PUBLIC_URL", { infer: true }) || this.cfg.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim()).replace(/\/$/, "");
    return {
      items: rows.map((r) => ({ id: r.id, label: r.label as Record<string, string>, due_date: String(r.dueDate), status: r.status, application_id: r.applicationId, rule_code: (r.ruleId && codes.get(r.ruleId)) || null })),
      ics_url: `${base}/api/me/obligations/ics/${this.token(me.id)}`,
    };
  }

  // Calendar apps fetch without cookies; the token is the credential.
  @Get("me/obligations/ics/:token")
  @Route({ auth: "public", limit: "read" })
  @RawResponse()
  async ics(@Param("token") token: string, @Res() reply: FastifyReply) {
    const userId = token.split(".")[0] ?? "";
    if (!userId || !safeEqual(token, this.token(userId))) throw new AppError(404, "not_found", "Not found.");
    const rows = await this.db.select().from(clientObligations).where(and(eq(clientObligations.clientId, userId), gte(clientObligations.dueDate, sql`current_date - 30`)));
    return reply.header("content-type", "text/calendar; charset=utf-8")
      .send(obligationsIcs(rows.map((r) => ({ id: r.id, title: title(r.label), dueDate: String(r.dueDate), status: r.status }))));
  }
}
