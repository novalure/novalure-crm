import "server-only";
import type { TenantTransaction } from "../db/tenant-client";
import { knowledgeId } from "../knowledge-center/policy";
import { behaviorEnum, exactBehaviorObject, learningIssues, SharedBehaviorError } from "./catalog";

export function parsePrivateSignal(value: unknown) {
  const input = exactBehaviorObject(value, ["eventId", "issue", "outcome"]);
  return { eventId: knowledgeId(input.eventId, "eventId"), issue: behaviorEnum(input.issue, learningIssues),
    outcome: behaviorEnum(input.outcome, ["pass", "fail"] as const) };
}

/** Fixed existing storage operation; the caller supplies its explicit RLS tx.
 * No callback, session, scope change or general SQL authority is returned. */
export async function insertPrivateSignal(tx: TenantTransaction, workspaceId: string, actorId: string, input: ReturnType<typeof parsePrivateSignal>) {
  const existing = await tx.queryOne<{ issue: string; outcome: string }>(`
      insert into behavior_learning_signals(workspace_id,actor_id,event_id,issue,outcome)
      values($1::uuid,$2::uuid,$3::uuid,$4,$5)
      on conflict(workspace_id,actor_id,event_id) do nothing returning issue,outcome`, [workspaceId, actorId, input.eventId, input.issue, input.outcome]);
  if (existing) return { recorded: true, replayed: false };
  const replay = await tx.queryOne<{ issue: string; outcome: string }>(`
      select issue,outcome from behavior_learning_signals
      where workspace_id=$1::uuid and actor_id=$2::uuid and event_id=$3::uuid`, [workspaceId, actorId, input.eventId]);
  if (!replay || replay.issue !== input.issue || replay.outcome !== input.outcome) throw new SharedBehaviorError("LEARNING_IDEMPOTENCY_CONFLICT");
  return { recorded: true, replayed: true };
}
