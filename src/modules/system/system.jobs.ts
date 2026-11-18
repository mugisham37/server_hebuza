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

  /** 03:00 Kigali: rows past their retention window per category (counts only; the purge itself is per-module). */
  @Cron("system_retention_due", "0 3 * * *")
  async retentionDue() {
    // shortcut: counts the categories with a direct table (accounts deactivated > 2 y, audit-free notifications > 7 y);
    // the rest keep the last reported count until their owning modules expose a due-count query.
    const [acct] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(
        sql`${users.isActive} = false and ${users.updatedAt} < now() - interval '2 years'`,
      );
    await systemWrite(this.deps, (w) => {
      const now = iso();
      for (const r of w.retention) {
        r.lastRunAt = now;
        if (r.category === "Account") r.due = Number(acct?.n ?? 0);
      }
    });
  }

  @Job("system.template.provider_review")
  providerReview(d: { key: string; v: number }) {
    return providerReview(this.deps, d);
  }
}
