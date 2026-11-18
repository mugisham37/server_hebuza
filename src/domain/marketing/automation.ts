// Sequence runtime (plan 10 §2.8). Pure: plans runs from a trigger time and applies exits / consent changes.
import type { AutomationRule, AutomationRun, Channel, ConsentState } from "@/domain/marketing/types";
import { nextAllowed } from "./quiet-hours";
import { MKT_POLICY } from "@/domain/policy";

const DAY = 86_400_000;
type Subject = AutomationRun["subject"];
/** Steps are days after the trigger (day 1 / 3 / 7 / 14). Sends in quiet hours are deferred; no consent or the weekly cap → skipped. */
export function planRuns(rule: AutomationRule, subject: Subject, startAt: string, ctx: { consent: Record<Channel, ConsentState>; sentThisWeek?: number }, idBase: string): AutomationRun[] {
  let sent = ctx.sentThisWeek ?? 0;
  return rule.steps.map((s, i) => {
    const due = new Date(Date.parse(startAt) + s.waitDays * DAY);
    const base = { id: `${idBase}-${i}`, ruleId: rule.id, subject, stepIndex: i };
    if (s.action !== "send_template") return { ...base, status: "waiting" as const, runAt: due.toISOString() };
    const ch = s.params.channel as Channel;
    if (ctx.consent[ch] !== "in") return { ...base, status: "skipped" as const, reason: "no_consent", runAt: due.toISOString() };
    if (sent >= Math.min(rule.frequencyCap, MKT_POLICY.frequencyCap)) return { ...base, status: "skipped" as const, reason: "freq_cap", runAt: due.toISOString() };
    sent++;
    const at = nextAllowed(due);
    return { ...base, status: at.getTime() !== due.getTime() ? ("deferred" as const) : ("waiting" as const), reason: at.getTime() !== due.getTime() ? "quiet_hours" : undefined, runAt: at.toISOString() };
  });
}
/** An exit event (reply, paid, won, lost, unsubscribed) cancels every step still waiting after `at`. */
export const applyExit = (runs: AutomationRun[], subjectId: string, at: string, reason: string): AutomationRun[] =>
  runs.map((r) => r.subject.id === subjectId && (r.status === "waiting" || r.status === "deferred") && r.runAt > at ? { ...r, status: "cancelled", reason } : r);
/** Consent withdrawn: remaining sends on that channel are skipped; tasks still run. */
export const applyConsentChange = (runs: AutomationRun[], rule: AutomationRule, subjectId: string, channel: Channel): AutomationRun[] =>
  runs.map((r) => r.subject.id === subjectId && r.ruleId === rule.id && (r.status === "waiting" || r.status === "deferred") && rule.steps[r.stepIndex]?.params.channel === channel
    ? { ...r, status: "skipped", reason: "no_consent" } : r);
