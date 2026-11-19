// Ops crons (reference ops.jobs.ts): offer expiry → back to the queue, SLA breach stamping, intake auto-assign.
import { Injectable } from "@nestjs/common";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { applications, deadlineNotifications } from "@/db/schema";
import { slaStepsReached, slaUsedPct } from "@/domain/ops/rules";
import { TxService } from "../../core/db/tx";
import { Cron } from "../../core/queue/queues";
import { SYSTEM, generateId, notify } from "./lib/ctx";
import { iso, loadCase, recList, recPut, saveCase } from "./lib/store";
import { autoAssign, offerNow, type OfferData } from "./ops.cases";

@Injectable()
export class OpsJobs {
  constructor(private readonly tx: TxService) {}

  /** Open offers past their TTL become timeouts and the case goes back to the ops queue. */
  @Cron("ops.offer_expiry", "*/5 * * * *")
  offerExpiry() {
    return this.tx.runAsSystem(async (tx) => {
      for (const o of [
        ...(await recList<OfferData>(tx, "offer", { state: "sent" })),
        ...(await recList<OfferData>(tx, "offer", { state: "viewed" })),
      ]) {
        const now = offerNow(o.data);
        if (now.state !== "timeout") continue;
        await recPut(tx, "offer", { ...o, state: "timeout", data: now });
        const r = await loadCase(tx, o.ref!, true).catch(() => null);
        if (r && r.app.assignedAgentId === o.ownerId && r.app.status !== "in_progress") {
          await saveCase(tx, r, { assignedAgentId: null, assignedAt: null });
          const mgr = await tx.execute<{ id: string }>(
            sql`select manager_id id from agent_profiles where user_id = ${o.ownerId} and manager_id is not null`,
          );
          if (mgr[0])
            await notify(tx, {
              userId: mgr[0].id,
              kind: "offer",
              title: `Offer on ${o.ref} timed out — back in the queue`,
              href: `/ops/cases/${o.ref}`,
            });
        }
      }
    });
  }

  /** Stamp SLA breaches once (paused statuses never breach), then escalate at 80/100/150 % (ASN-08). */
  @Cron("ops.sla_sweep", "*/10 * * * *")
  async slaSweep() {
    await this.tx.runAsSystem((tx) =>
      tx
        .update(applications)
        .set({ slaBreachedAt: iso() })
        .where(
          and(
            isNull(applications.slaBreachedAt),
            lt(sql`coalesce(${applications.dueAt}, ${applications.slaDeadline})`, sql`now()`),
            sql`${applications.status} not in ('completed_delivered','rejected','cancelled','refunded','on_hold','awaiting_client_documents','awaiting_external_institution','awaiting_quotation','awaiting_payment')`,
          ),
        ),
    );
    return this.tx.runAsSystem(async (tx) => {
      const open = await tx
        .select({ id: applications.applicationId, code: applications.code, agent: applications.assignedAgentId, sub: applications.submittedAt, due: sql<string>`coalesce(${applications.dueAt}, ${applications.slaDeadline})`, paused: applications.slaPausedMs })
        .from(applications)
        .where(and(isNull(applications.slaPausedAt), isNotNull(sql`coalesce(${applications.dueAt}, ${applications.slaDeadline})`),
          sql`${applications.status} not in ('completed_delivered','rejected','cancelled','refunded')`));
      let sent = 0;
      for (const a of open) {
        const pct = slaUsedPct(a.sub, a.due, a.paused);
        for (const step of slaStepsReached(pct)) {
          // Claim the step once per case (uq target+offset), so reruns never re-notify.
          const [claimed] = await tx.insert(deadlineNotifications)
            .values({ id: generateId("dln"), targetType: "sla", targetId: a.id, offsetDays: step, sentAt: iso() })
            .onConflictDoNothing().returning({ id: deadlineNotifications.id });
          if (!claimed) continue;
          const to = step === 80 ? (a.agent ? [a.agent] : [])
            : step === 100 ? (await tx.execute<{ id: string }>(sql`select coalesce((select manager_id from agent_profiles where user_id = ${a.agent}), null) id`)).map((r) => r.id).filter(Boolean)
            : [];
          if (step === 100 && !to.length) to.push(...(await tx.execute<{ id: string }>(sql`select user_id id from users where role = 'staff:service_manager' and is_active`)).map((r) => r.id));
          if (step === 150) to.push(...(await tx.execute<{ id: string }>(sql`select user_id id from users where role = 'staff:executive' and is_active`)).map((r) => r.id));
          for (const userId of to)
            await notify(tx, { userId, kind: "sla", title: `${a.code}: ${step}% of SLA used`, href: step === 80 ? `/agent/cases/${a.code}` : `/ops/cases/${a.code}` });
          sent++;
        }
      }
      return { escalations: sent };
    });
  }

  /** Approved, unassigned cases get an agent per their service's auto-assign rules. */
  @Cron("ops.auto_assign", "*/5 * * * *")
  async autoAssign() {
    const rows = await this.tx.runAsSystem((tx) =>
      tx
        .select({ code: applications.code })
        .from(applications)
        .where(and(eq(applications.status, "approved_assigned"), isNull(applications.assignedAgentId)))
        .limit(50),
    );
    for (const r of rows) await this.tx.runAsSystem((tx) => autoAssign(tx, r.code, SYSTEM));
  }
}
