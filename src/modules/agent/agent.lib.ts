// Agent rules (core from @/domain/agent/core; shareOf copied from web lib/agent/money) + the work-module
// functions the agent workspace calls (external job scope, accept/deliver guards, summary.external).
import { applyBps } from "@/domain/money";

export { agentMoves, CONFLICTS, DECLINE_REASONS, groupOf, type WorkGroup } from "@/domain/agent/core";
/** Internal agent share in whole RWF (= finance allocate(eligible, [], bps).pool). */
export const shareOf = (eligible: number, shareBps: number) =>
  applyBps(eligible, shareBps);

// ── external partners: the work module owns job scope + accept/deliver guards + summary.external ─────────
export {
  assertCanAccept,
  assertCanDeliver,
  docShared,
  externalBlock,
  scoped,
} from "../work/work.service";
