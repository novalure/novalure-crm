import "server-only";

import type { AppSession } from "../auth/session";
import { withCrmRead } from "../crm-command";
import type { TenantTransactionOptions } from "../db/tenant-client";
import { knowledgeId } from "../knowledge-center/policy";
import { behaviorEnum, compileSharedBehavior, exactBehaviorObject, learningIssues, parseBehaviorRelease, SharedBehaviorError, suggestBehaviorRules } from "./catalog";

/** Internal instrumentation boundary. No HTTP endpoint is installed by this package. */
export async function recordPrivateLearningSignal(session: AppSession, value: unknown, options: TenantTransactionOptions = {}) {
  const input = exactBehaviorObject(value, ["eventId", "issue", "outcome"]);
  const eventId = knowledgeId(input.eventId, "eventId");
  const issue = behaviorEnum(input.issue, learningIssues);
  const outcome = behaviorEnum(input.outcome, ["pass", "fail"] as const);
  return withCrmRead(session, async (tx, member) => {
    if (!member.permissions.includes("crm:write")) throw new SharedBehaviorError("LEARNING_WRITE_FORBIDDEN");
    const existing = await tx.queryOne<{ issue: string; outcome: string }>(`
      insert into behavior_learning_signals(workspace_id,actor_id,event_id,issue,outcome)
      values($1::uuid,$2::uuid,$3::uuid,$4,$5)
      on conflict(workspace_id,actor_id,event_id) do nothing returning issue,outcome`, [member.workspaceId, member.userId, eventId, issue, outcome]);
    if (existing) return { recorded: true, replayed: false };
    const replay = await tx.queryOne<{ issue: string; outcome: string }>(`
      select issue,outcome from behavior_learning_signals
      where workspace_id=$1::uuid and actor_id=$2::uuid and event_id=$3::uuid`, [member.workspaceId, member.userId, eventId]);
    if (!replay || replay.issue !== issue || replay.outcome !== outcome) throw new SharedBehaviorError("LEARNING_IDEMPOTENCY_CONFLICT");
    return { recorded: true, replayed: true };
  }, options);
}

/** Evidence stays private even from another owner in the same workspace. */
export async function suggestPrivateBehaviorImprovements(session: AppSession, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, member) => {
    const counts = await tx.query<{ issue: string; failures: number }>(`
      select issue,least(count(*),1000000)::integer as failures from behavior_learning_signals
      where workspace_id=$1::uuid and actor_id=$2::uuid and outcome='fail'
        and created_at >= now()-interval '30 days'
      group by issue order by issue`, [member.workspaceId, member.userId]);
    // No counts, event IDs, actor IDs or tenant IDs in a cross-scope candidate.
    return suggestBehaviorRules(counts);
  }, options);
}

/** Reads only the published, immutable selection; no candidate or evidence access. */
export async function loadSharedBehavior(session: AppSession, target: unknown, options: TenantTransactionOptions = {}) {
  // Validate before any database work, including when no release is published.
  compileSharedBehavior(null, target);
  return withCrmRead(session, async tx => {
    const row = await tx.queryOne<{ version: number; ruleIds: string[]; targets: string[] }>(`
      select r.version,r.rule_ids as "ruleIds",r.targets
      from behavior_release_head h join behavior_releases r on r.version=h.version where h.singleton=true`);
    const release = row ? parseBehaviorRelease({ contractVersion: "shared-behavior-v1", version: row.version, selection: { ruleIds: row.ruleIds, targets: row.targets } }) : null;
    return compileSharedBehavior(release, target);
  }, options);
}
