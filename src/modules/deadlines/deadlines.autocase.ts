// F-CAL-07: at lead time, an obligation without a case gets one, opened through the normal intake
// (ApplicationsService.submit as the client) so pricing, numbering, assignment and notices all apply.
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ClsService } from "nestjs-cls";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { clientObligations, servicePricingTiers, services, users } from "@/db/schema";
import { normalizeRoles } from "@/domain/auth/roles";
import { DB, type Db } from "../../core/db/db";
import type { RequestStore } from "../../core/http/context";
import { ApplicationsService } from "../applications/applications.service";

@Injectable()
export class ObligationCases {
  private readonly log = new Logger("deadlines.autocase");
  constructor(@Inject(DB) private readonly db: Db, private readonly apps: ApplicationsService, private readonly cls: ClsService<RequestStore>) {}

  async run(now = new Date()) {
    const today = now.toISOString().slice(0, 10);
    const due = await this.db.select({ o: clientObligations, slug: services.slug, serviceId: services.serviceId })
      .from(clientObligations).innerJoin(services, eq(services.serviceId, clientObligations.serviceId))
      .where(and(eq(clientObligations.status, "upcoming"), isNull(clientObligations.applicationId), sql`${clientObligations.dueDate} - ${clientObligations.leadDays} <= ${today}::date`))
      .limit(200);
    let created = 0;
    for (const { o, slug, serviceId } of due) {
      const [u] = await this.db.select({ id: users.userId, role: users.role, name: users.name, email: users.email, phone: users.phoneE164, lang: users.language }).from(users).where(eq(users.userId, o.clientId));
      const tiers = await this.db.select({ tier: servicePricingTiers.tier }).from(servicePricingTiers)
        .where(and(eq(servicePricingTiers.serviceId, serviceId), eq(servicePricingTiers.isAvailable, true))).orderBy(asc(servicePricingTiers.tier));
      const tier = tiers.find((t) => t.tier === "standard")?.tier ?? tiers.find((t) => t.tier !== "urgent")?.tier;
      if (!u || !tier) continue;
      try {
        // The job's CLS scope carries the client as the acting user so RLS + intake rules see a normal client submission.
        this.cls.set("user", { id: u.id, roles: normalizeRoles({ role: u.role }), scopes: {}, sid: "" });
        const out = await this.apps.submit(this.cls.get("user"), {
          service_slug: slug, tier, idempotency_key: `obligation:${o.id}`,
          personal_info: { fullName: u.name ?? undefined, email: u.email ?? undefined, phone: u.phone ?? undefined, language: u.lang },
          service_data: { obligation_id: o.id, period: o.periodKey, auto_created: true },
        }, null);
        await this.db.update(clientObligations).set({ applicationId: out.application_id, status: "in_progress", updatedAt: now.toISOString() }).where(eq(clientObligations.id, o.id));
        created++;
      } catch (e) {
        this.log.warn({ event: "obligation.autocase_failed", obligation: o.id, err: String(e) });
      } finally {
        this.cls.set("user", null);
      }
    }
    return created;
  }
}
