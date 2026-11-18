// Ops crons (reference ops.jobs.ts): offer expiry → back to the queue, SLA breach stamping, intake auto-assign.
import { Injectable } from "@nestjs/common";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { applications } from "@/db/schema";
import { TxService } from "../../core/db/tx";
import { Cron } from "../../core/queue/queues";
import { SYSTEM, notify } from "./lib/ctx";
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

  /** Stamp SLA breaches once (paused statuses never breach). */
  @Cron("ops.sla_sweep", "*/10 * * * *")
  slaSweep() {
    return this.tx.runAsSystem((tx) =>
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
