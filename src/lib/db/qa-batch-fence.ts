import type { TenantTransaction } from "@/lib/db/tenant-client";

/**
 * Serializes reset and mutation transactions without mutating the append-only
 * batch row or requiring UPDATE privilege on it.
 */
export async function lockQaBatchFence(transaction: TenantTransaction, batchId: string) {
  await transaction.execute(
    `select pg_advisory_xact_lock(hashtextextended('novalure.qa_batch:' || $1::text, 0))`,
    [batchId],
  );
}

export async function hasExecutedQaBatchAudit(
  transaction: TenantTransaction,
  input: { batchId: string; workspaceId: string },
) {
  const audit = await transaction.queryOne<{ id: string }>(
    `
      select id
      from qa_reset_audit_events
      where batch_id = $1::uuid
        and workspace_id = $2::uuid
        and mode = 'execute'
        and outcome = 'executed'
      limit 1
    `,
    [input.batchId, input.workspaceId],
  );
  return Boolean(audit);
}
