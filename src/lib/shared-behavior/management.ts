import "server-only";
import type { AppSession } from "../auth/session";
import { withCrmRead, CrmCommandError } from "../crm-command";
import type { TenantTransactionOptions } from "../db/tenant-client";
import { knowledgeId } from "../knowledge-center/policy";

export const learningRetention = Object.freeze({ status: "OWNER_DEFERRED" as const, automaticDeletion: false });

/** The database revalidates membership; even workspace owners see only their own signals. */
export async function readPrivateLearningHistory(session: AppSession, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, member) => {
    const signals = await tx.query<{ eventId: string; issue: string; outcome: string; createdAt: string }>(`
      select event_id as "eventId",issue,outcome,created_at::text as "createdAt"
      from behavior_learning_signals where workspace_id=$1::uuid and actor_id=$2::uuid
      order by created_at desc,event_id limit 100`, [member.workspaceId, member.userId]);
    const head = await tx.queryOne<{ version: number | null; revision: number }>(
      "select version,revision from behavior_release_head where singleton=true");
    return { signals, head, retention: learningRetention, limit: 100 };
  }, options);
}

/** Explicit deletion only: no guessed age, bulk wildcard, actor selector or shared-history deletion. */
export async function deleteOwnLearningSignal(session: AppSession, eventId: unknown, options: TenantTransactionOptions = {}) {
  const id = knowledgeId(eventId, "eventId");
  return withCrmRead(session, async (tx, member) => {
    if (!member.permissions.includes("crm:write")) throw new CrmCommandError("FORBIDDEN", "Learning write access is required", 403);
    const deleted = await tx.queryOne<{ deleted: boolean }>(`delete from behavior_learning_signals
      where workspace_id=$1::uuid and actor_id=$2::uuid and event_id=$3::uuid returning true as deleted`,
    [member.workspaceId, member.userId, id]);
    // The audit contains neither event IDs nor issue/outcome data. The same transaction must commit both.
    if (deleted) await tx.execute(`insert into audit_logs(workspace_id,actor_user_id,action,entity_type,after)
      values($1::uuid,$2::uuid,'learning.signal.delete','learning', '{"deleted":1}'::jsonb)`, [member.workspaceId, member.userId]);
    return { deleted: deleted?.deleted === true };
  }, options);
}
