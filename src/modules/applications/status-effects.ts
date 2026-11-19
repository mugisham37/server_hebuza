// REQ-08 + REQ-16: column side effects of any status change, as SQL so they are idempotent and race-free
// (both transitionTx and ops saveCase apply them; UPDATE sees pre-update values, so order inside SET is irrelevant).
import { sql } from "drizzle-orm";
import { CASE_STATUS_META, normalizeStatus } from "@/domain/domain/case-status";

export function statusEffects(to: string) {
  const s = normalizeStatus(to);
  // shortcut: paused time is wall-clock, not business hours; upgrade with the compliance holiday calendar if SLA is contractual.
  const sla = CASE_STATUS_META[s].pausesSla
    ? { slaPausedAt: sql`coalesce(sla_paused_at, now())` }
    : {
        slaDeadline: sql`case when sla_paused_at is null or sla_deadline is null then sla_deadline else sla_deadline + (now() - sla_paused_at) end`,
        slaPausedMs: sql`sla_paused_ms + coalesce((extract(epoch from (now() - sla_paused_at)) * 1000)::bigint, 0)`,
        slaPausedAt: null,
      };
  if (s === "cancelled") return { ...sla, cancelledAt: sql`coalesce(cancelled_at, now())` };
  if (s === "rejected") return { ...sla, rejectedAt: sql`coalesce(rejected_at, now())` };
  if (s !== "completed_delivered") return sla;
  return {
    ...sla,
    completionRecord: sql`coalesce(completion_record, jsonb_build_object(
      'completedAt', now(), 'assignedAgentId', assigned_agent_id, 'assignedPartnerId', assigned_partner_id,
      'handler', handler, 'tier', tier, 'paymentStatus', payment_status, 'paymentAmount', payment_amount,
      'agreedAmountRwf', agreed_amount_rwf, 'hebuzaPercent', hebuza_percent, 'submittedAt', submitted_at,
      'slaDeadline', sla_deadline, 'slaBreachedAt', sla_breached_at,
      'slaPausedMs', sla_paused_ms + coalesce((extract(epoch from (now() - sla_paused_at)) * 1000)::bigint, 0),
      'externalOutcome', external_outcome,
      'messageCount', (select count(*) from application_messages m where m.application_id = applications.application_id),
      'deliverables', (select count(*) from deliverables d where d.application_id = applications.application_id)))`,
  };
}
