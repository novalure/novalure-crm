import "server-only";

import type { AppSession } from "@/lib/auth/session";
import { canUseBrokerProjectEditScope } from "@/lib/broker-flow/access-policy";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import type { TenantTransaction } from "@/lib/db/tenant-client";

export type FunnelAccessRecord = Readonly<{
  ownerUserId: string | null;
  projectId: string | null;
}>;

export class FunnelAccessError extends Error {
  constructor(message = "Funnel is not available in the permitted record scope") {
    super(message);
    this.name = "FunnelAccessError";
  }
}

export function canManageWorkspaceFunnels(session: AppSession) {
  return canViewAllWorkspaceContacts(session);
}

async function hasLockedProjectEditGrant(input: {
  projectId: string | null;
  session: AppSession;
  transaction: TenantTransaction;
}) {
  if (
    !input.projectId ||
    !canUseBrokerProjectEditScope(input.session)
  ) {
    return false;
  }

  const grant = await input.transaction.queryOne<{ allowed: boolean }>(
    `
      select true as allowed
      from project_pipeline_permissions permission
      where permission.workspace_id = $1::uuid
        and permission.project_id = $2::uuid
        and permission.user_id = $3::uuid
        and permission.can_edit_deals = true
      for share of permission
    `,
    [input.session.workspaceId, input.projectId, input.session.userId],
  );

  return grant?.allowed === true;
}

/**
 * Funnel access is deliberately narrower than the broad funnel product
 * capability. A non-manager needs either direct record ownership or an
 * explicit, positive project pipeline grant for an eligible project-sales
 * role. The grant row is locked for the rest of the tenant transaction so a
 * concurrent revocation cannot race a protected mutation.
 */
export async function canAccessFunnelInTransaction(input: {
  record: FunnelAccessRecord;
  session: AppSession;
  transaction: TenantTransaction;
}) {
  if (canManageWorkspaceFunnels(input.session)) return true;
  if (input.record.ownerUserId === input.session.userId) return true;
  return hasLockedProjectEditGrant({
    projectId: input.record.projectId,
    session: input.session,
    transaction: input.transaction,
  });
}

/** A new funnel has no existing owner boundary, so its target project must be
 * managed workspace-wide or covered by an explicit project-edit grant. */
export async function canCreateFunnelInProjectInTransaction(input: {
  projectId: string | null;
  session: AppSession;
  transaction: TenantTransaction;
}) {
  if (canManageWorkspaceFunnels(input.session)) return true;
  return hasLockedProjectEditGrant(input);
}

export function canAssignFunnelOwner(input: {
  currentOwnerUserId?: string | null;
  nextOwnerUserId: string;
  session: AppSession;
}) {
  // `undefined` denotes a create. An existing NULL owner is materially
  // different: claiming that unowned record is still an owner reassignment.
  const currentOwnerUserId = input.currentOwnerUserId === undefined
    ? input.session.userId
    : input.currentOwnerUserId;
  return currentOwnerUserId === input.nextOwnerUserId || canManageWorkspaceFunnels(input.session);
}
