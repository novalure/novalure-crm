import { CrmCommandError, type TenantTransaction } from "../crm-command";

/**
 * Must run after the caller holds the connection/settings row locks. The first
 * locking SELECT may have waited until after the lease expired, and now() is
 * fixed at transaction start in PostgreSQL. This is an additional post-lock
 * check, not a guarantee that the lease remains valid until commit.
 */
export async function assertMailboxLeaseAfterLock(tx: TenantTransaction, input: { id: string; workspaceId: string; userId: string; revision: number; lease: string }) {
  const row = await tx.queryOne<{ revision: number }>(`select revision from crm_mailbox_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and status='connected' and revision=$4 and sync_lease_id=$5::uuid and sync_lease_until>clock_timestamp()`, [input.id, input.workspaceId, input.userId, input.revision, input.lease]);
  if (!row || row.revision !== input.revision) throw new CrmCommandError("MAIL_CONNECTION_CHANGED", "Persönliche Freigabe oder Verbindung geändert. Verspäteter Import wurde verworfen.", 409);
}
