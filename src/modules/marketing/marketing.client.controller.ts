// Client side of marketing: testimonial consent prompt (F-FBK-07 / spec "consent before publishing a quote").
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { applications } from "@/db/schema";
import type { Testimonial } from "@/domain/marketing/types";
import { CurrentUser } from "../../core/auth/decorators";
import { TxService } from "../../core/db/tx";
import { dto } from "../../core/http/dto";
import type { SessionUser } from "../../core/http/context";
import { AppError } from "../../core/http/errors";
import { Route } from "../../core/http/route";
import { testimonialConsent } from "./marketing.insights";
import { list } from "./marketing.store";

class ConsentDto extends dto(z.object({ consent: z.boolean() })) {}

@Controller()
export class MarketingClientController {
  constructor(private readonly txs: TxService) {}

  /** Application ids the caller owns (RLS-scoped read), then marketing rows via the system role. */
  private async mine(me: SessionUser) {
    return new Set((await this.txs.run((tx) => tx.select({ id: applications.applicationId }).from(applications).where(eq(applications.clientId, me.id)))).map((a) => a.id));
  }

  @Get("me/testimonial-requests")
  @Route({ auth: ["client"] })
  async requests(@CurrentUser() me: SessionUser) {
    const ids = await this.mine(me);
    const ts = await this.txs.runAsSystem((tx) => list<Testimonial>(tx, "testimonial"));
    return { items: ts.filter((t) => t.consentRequested && ids.has(t.ratingId)).map((t) => ({ id: t.id, quote: t.excerpt ?? t.quote, stars: t.stars, service: t.serviceSlug })) };
  }

  @Post("me/testimonial-requests/:id")
  @Route({ auth: ["client"], limit: "write", audit: "testimonial.consent_answered" })
  async answer(@CurrentUser() me: SessionUser, @Param("id") id: string, @Body() b: ConsentDto) {
    const ids = await this.mine(me);
    return this.txs.runAsSystem(async (tx) => {
      const t = (await list<Testimonial>(tx, "testimonial")).find((x) => x.id === id);
      if (!t || !ids.has(t.ratingId)) throw new AppError(404, "not_found", "Not found.");
      const r = await testimonialConsent(tx, id, b.consent);
      return { id: r.id, consent: r.consent };
    });
  }
}
