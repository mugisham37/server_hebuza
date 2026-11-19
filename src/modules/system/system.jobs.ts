// P10 crons: approvals/invites/break-glass/review sweep (every minute), nightly audit-chain verification (alerts the
// console on a broken link), quarterly access-review campaign, nightly retention due counts, impersonation expiry.
import { and, isNull, lte, sql } from "drizzle-orm";
import { Injectable, Logger } from "@nestjs/common";
import { authImpersonations, users } from "@/db/schema";
import { Cron, Job } from "../../core/queue/queues";
import { SystemStore } from "./system.store";
import { providerReview } from "./system.config";
import { verifyAll, storeVerify } from "./system.audit";
import {
  openCampaign,
  sweepBreakGlass,
  sweepReviews,
} from "./system.governance";
import { sweepInvites } from "./system.users";
import "./system.ops"; // registers the retention / restore appliers
import { record, systemWrite, SYSTEM_ACTOR } from "./system.world";
import { iso } from "../../core/db/ids";
import type { IncidentVM } from "@/domain/system/types";
import type { Breach } from "@/domain/system/incidents";


@Injectable()
export class SystemJobs {
  private readonly log = new Logger("system.jobs");
  constructor(private readonly store: SystemStore) {}
  private get deps() {
    return this.store.deps;
  }

  /** Expire proposals, apply due approved changes (write() sweeps), expire invites, break-glass and overdue reviews. */
  @Cron("system_sweep", "* * * * *")
  sweep() {
    return systemWrite(this.deps, async (w) => {
      sweepInvites(w);
      sweepBreakGlass(w);
      await sweepReviews(w);
      // View-as sessions past their window are closed and audited (the token itself expires on its own).
      const ended = await w.db
        .update(authImpersonations)
        .set({ endedAt: iso(), endedBy: "expiry" })
        .where(
          and(
            isNull(authImpersonations.endedAt),
            lte(authImpersonations.until, iso()),
          ),
        )
        .returning();
      for (const e of ended)
        record(
          w,
          "access.impersonation.ended",
          "user",
          e.targetId,
          undefined,
          { endedBy: "expiry" },
          undefined,
          SYSTEM_ACTOR,
        );
    });
  }

  /** 02:30 Kigali: walk the whole audit chain; a broken link raises the danger alert (F-AUD-04). */
  @Cron("system_audit_verify", "30 2 * * *")
  async auditVerify() {
    const rep = await verifyAll(this.deps.db);
    await systemWrite(this.deps, (w) => storeVerify(w, rep));
    if (!rep.ok) this.log.error(`audit_chain_broken at ${rep.brokenAt}`);
  }

  /** First day of each quarter, 06:00: open the access-review campaign (F-IAM-23). */
  @Cron("system_access_review", "0 6 1 1,4,7,10 *")
  accessReview() {
    return systemWrite(this.deps, (w) => openCampaign(w));
  }

  /** 03:00 Kigali, PRV-retention: count rows past retention per category and, when PRIVACY_PURGE_ENABLED=true, purge
   *  them. Categories under a legal hold (`legal: true`, e.g. tax/financial 10 y) are only counted, never touched.
   *  Communications are archived by chat.retention; identity documents follow case closure in the documents module. */
  @Cron("system_retention_due", "0 3 * * *")
  async retentionDue() {
    const db = this.deps.db;
    const enforce = this.deps.config.get("PRIVACY_PURGE_ENABLED", { infer: true }) === true;
    const rules = (await db.execute(sql`select data from system_records where kind = 'retention'`)) as unknown as { data: { category: string; legal: boolean } }[]; // cast: execute() rows are untyped
    const legal = new Set(rules.filter((r) => r.data.legal).map((r) => r.data.category));
    // Account: deactivated > 2 y with no open case → anonymised (row kept for audit/financial references).
    const accountWhere = sql`u.is_active = false and u.updated_at < now() - interval '2 years' and u.name <> 'Deleted user'
      and not exists (select 1 from applications a where a.client_id = u.user_id and a.completed_at is null and a.status not in ('cancelled','rejected','completed_delivered'))`;
    const [acct] = (await db.execute(sql`select count(*)::int as n from users u where ${accountWhere}`)) as unknown as { n: number }[];
    // Communications: in-app notifications > 7 y; delivery payloads (message bodies) minimised after 90 days.
    const [ntf] = (await db.execute(sql`select count(*)::int as n from notifications where created_at < now() - interval '7 years'`)) as unknown as { n: number }[];
    let purged = 0;
    if (enforce) {
      if (!legal.has("Account"))
        purged += ((await db.execute(sql`update users u set name = 'Deleted user', email = null, phone_e164 = null, updated_at = now() where ${accountWhere} returning 1`)) as unknown as unknown[]).length;
      if (!legal.has("Communications")) {
        purged += ((await db.execute(sql`delete from notifications where created_at < now() - interval '7 years' returning 1`)) as unknown as unknown[]).length;
        await db.execute(sql`update notification_deliveries set payload = null where payload is not null and created_at < now() - interval '90 days' and status not in ('queued','deferred')`);
      }
    }
    await systemWrite(this.deps, (w) => {
      const now = iso();
      for (const r of w.retention) {
        r.lastRunAt = now;
        if (r.category === "Account") r.due = enforce && !r.legal ? 0 : Number(acct?.n ?? 0);
        if (r.category === "Communications") r.due = enforce && !r.legal ? 0 : Number(ntf?.n ?? 0);
      }
      if (purged) record(w, "data_deletion.record.erased", "retention", "daily", undefined, { purged, at: now });
    });
    this.log.log({ event: "privacy.retention", enforce, accountDue: acct?.n ?? 0, notificationsDue: ntf?.n ?? 0, purged });
  }

  /** Hourly, PRV-breach: incidents flagged as personal-data breaches must be notified to the regulator within the
   *  window; warn at 24 h left, raise a danger alert when overdue. */
  @Cron("system_breach_timer", "10 * * * *")
  breachTimer(now = Date.now()) {
    return systemWrite(this.deps, (w) => {
      for (const inc of w.incidents) {
        const b = (inc as IncidentVM & { breach?: Breach }).breach;
        if (!b || b.notifiedAt) continue;
        const left = Date.parse(b.notifyBy) - now;
        const code = left <= 0 ? "breach_overdue" : left <= 24 * 3600_000 ? "breach_due_24h" : null;
        if (!code || w.alerts.some((a) => a.code === `${code}:${inc.id}`)) continue;
        w.alerts.unshift({
          id: `al_${inc.id}_${code}`, kind: "security", code: `${code}:${inc.id}`,
          title: left <= 0 ? `Breach ${inc.id}: regulator notification overdue` : `Breach ${inc.id}: notify the regulator within 24 h`,
          detail: `Deadline ${b.notifyBy}`, at: iso(), href: `/system/ops/incidents/${inc.id}`, read: false, tone: left <= 0 ? "danger" : "warning",
        });
      }
    });
  }

  @Job("system.template.provider_review")
  providerReview(d: { key: string; v: number }) {
    return providerReview(this.deps, d);
  }
}
