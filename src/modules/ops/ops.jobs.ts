// Ops crons (reference ops.jobs.ts): offer expiry → back to the queue, SLA breach stamping, intake auto-assign.
import { Injectable } from "@nestjs/common";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { agentProfiles, applicationFeedback, applications, deadlineNotifications } from "@/db/schema";
import { openTicket, type Ticket } from "./ops.manage";
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
              title: `Offer on ${o.ref} timed out, back in the queue`,
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

  /** F-FBK-10: agent quality from real outcomes (90 days) → ranking inputs. rating = CSAT avg − 0.5 per complaint per 10 cases. */
  @Cron("ops.quality_scores", "20 1 * * *")
  qualityScores() {
    return this.tx.runAsSystem(async (tx) => {
      const rows = await tx.execute<{ id: string; n: number; on_time: number; csat: number | null; complaints: number }>(sql`
        select a.assigned_agent_id id, count(*)::int n,
          avg(case when a.due_at is null or a.completed_at <= a.due_at then 1 else 0 end)::float on_time,
          avg(f.rating)::float csat,
          (select count(*)::int from ops_records r where r.kind = 'ticket' and r.data->>'kind' = 'complaint'
             and r.data->'owner'->>'id' = a.assigned_agent_id and r.updated_at > now() - interval '90 days') complaints
        from applications a left join application_feedback f on f.application_id = a.application_id
        where a.status = 'completed_delivered' and a.assigned_agent_id is not null and a.completed_at > now() - interval '90 days'
        group by a.assigned_agent_id`);
      for (const r of rows) {
        const csat = r.csat == null ? null : Math.max(0, Math.min(5, r.csat - 0.5 * ((r.complaints * 10) / Math.max(1, r.n))));
        await tx.update(agentProfiles)
          .set({ onTimeBps: Math.round(r.on_time * 10_000), ...(csat == null ? {} : { ratingX10: Math.round(csat * 10) }) })
          .where(eq(agentProfiles.userId, r.id));
      }
      return { updated: rows.length };
    });
  }

  /** F-FBK-06: a ticket past its response target escalates to service managers; still unanswered 24 h later, to executives. */
  @Cron("ops.ticket_escalation", "*/15 * * * *")
  ticketEscalation() {
    return this.tx.runAsSystem(async (tx) => {
      const open = (await recList<Ticket>(tx, "ticket")).filter((t) => !["resolved", "confirming"].includes(t.data.status) && !t.data.responded);
      let sent = 0;
      for (const rec of open) {
        const t = rec.data;
        const late = Date.now() - Date.parse(t.responseDueAt);
        for (const [level, role, after] of [[1, "staff:service_manager", 0], [2, "staff:executive", 24 * 3_600_000]] as const) {
          if (late < after) continue;
          const [claimed] = await tx.insert(deadlineNotifications)
            .values({ id: generateId("dln"), targetType: "ticket_escalation", targetId: t.ref, offsetDays: level, sentAt: iso() })
            .onConflictDoNothing().returning({ id: deadlineNotifications.id });
          if (!claimed) continue;
          if (level === 1 && t.status !== "escalated") {
            t.status = "escalated";
            t.escalatedAt = iso();
            t.activity.unshift({ at: iso(), text: "Escalated automatically: response target missed" });
            await recPut(tx, "ticket", { ...rec, state: t.status, data: t });
          }
          const to = await tx.execute<{ id: string }>(sql`select user_id id from users where role = ${role} and is_active`);
          for (const u of to) await notify(tx, { userId: u.id, kind: "ticket", title: `${t.ref} unanswered past its target`, href: `/ops/tickets/${t.ref}` });
          sent++;
        }
      }
      return { escalations: sent };
    });
  }

  /** F-FBK-01: rating reminders D+2 and D+7 after the first release, only while the case is unrated. */
  @Cron("ops.rating_reminders", "0 8 * * *")
  ratingReminders() {
    return this.tx.runAsSystem(async (tx) => {
      const due = await tx.execute<{ id: string; code: string; client: string; d: number }>(sql`
        select a.application_id id, a.code, a.client_id client, floor(extract(epoch from now() - min(dl.released_at)) / 86400)::int d
        from applications a join deliverables dl on dl.application_id = a.application_id and dl.released_at is not null
        left join application_feedback f on f.application_id = a.application_id
        where a.client_id is not null and f.rating is null
        group by a.application_id, a.code, a.client_id
        having floor(extract(epoch from now() - min(dl.released_at)) / 86400) in (2, 7)`);
      let sent = 0;
      for (const r of due) {
        const [claimed] = await tx.insert(deadlineNotifications)
          .values({ id: generateId("dln"), targetType: "rating_reminder", targetId: r.id, offsetDays: r.d, sentAt: iso() })
          .onConflictDoNothing().returning({ id: deadlineNotifications.id });
        if (!claimed) continue;
        await notify(tx, { userId: r.client, kind: "rating", title: `How did we do on ${r.code}?`, href: `/requests/${r.code}` });
        sent++;
      }
      return { sent };
    });
  }

  /** F-WRK-05: engagement contract expiry reminders at 60/30/7/0 days to the worker and service managers (once each). */
  @Cron("ops.contract_expiry", "0 7 * * *")
  contractExpiry() {
    return this.tx.runAsSystem(async (tx) => {
      const contracts = await recList<{ status: string; until: string }>(tx, "contract", {}, 5000);
      const sms = await tx.execute<{ id: string }>(sql`select user_id id from users where role = 'staff:service_manager' and is_active`);
      let sent = 0;
      for (const c of contracts) {
        if (!c.ownerId || !c.data.until || c.data.status === "terminated") continue;
        const days = Math.ceil((Date.parse(c.data.until.slice(0, 10)) - Date.parse(iso().slice(0, 10))) / 86_400_000);
        if (![60, 30, 7, 0].includes(days)) continue;
        const [claimed] = await tx.insert(deadlineNotifications)
          .values({ id: generateId("dln"), targetType: "contract_expiry", targetId: c.id, offsetDays: days, sentAt: iso() })
          .onConflictDoNothing().returning({ id: deadlineNotifications.id });
        if (!claimed) continue;
        const title = days ? `Engagement contract ends in ${days} days` : "Engagement contract ends today";
        await notify(tx, { userId: c.ownerId, kind: "contract", title, href: "/work/contract" });
        for (const u of sms) await notify(tx, { userId: u.id, kind: "contract", title: `${title} (${c.ownerId})`, href: `/ops/workforce/${c.ownerId}` });
        sent++;
      }
      return { sent };
    });
  }

  /** F-FBK-08: a rating of 2 or less opens a high-priority complaint and alerts service managers (once per case). */
  @Cron("ops.low_rating", "*/10 * * * *")
  lowRatings() {
    return this.tx.runAsSystem(async (tx) => {
      const low = await tx
        .select({ id: applications.applicationId, code: applications.code, rating: applicationFeedback.rating, comment: applicationFeedback.ratingComment })
        .from(applicationFeedback)
        .innerJoin(applications, eq(applications.applicationId, applicationFeedback.applicationId))
        .where(and(lt(applicationFeedback.rating, 3), sql`${applicationFeedback.ratedAt} > now() - interval '7 days'`));
      let opened = 0;
      for (const a of low) {
        const [claimed] = await tx.insert(deadlineNotifications)
          .values({ id: generateId("dln"), targetType: "low_rating", targetId: a.id, offsetDays: 0, sentAt: iso() })
          .onConflictDoNothing().returning({ id: deadlineNotifications.id });
        if (!claimed) continue;
        const t = await openTicket(tx, SYSTEM, {
          kind: "complaint", category: "low_rating", caseRef: a.code, priority: "high", byClient: true,
          note: `Rated ${a.rating}/5${a.comment ? `: ${a.comment}` : ""}`,
        });
        const sms = await tx.execute<{ id: string }>(sql`select user_id id from users where role = 'staff:service_manager' and is_active`);
        for (const r of sms)
          await notify(tx, { userId: r.id, kind: "ticket", title: `Low rating (${a.rating}/5) on ${a.code}`, href: `/ops/tickets/${t.ref}` });
        opened++;
      }
      return { opened };
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
