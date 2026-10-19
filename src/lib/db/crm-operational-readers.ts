import type { AppSession } from "@/lib/auth/session";
import { resolveWorkspaceMembershipAccess } from "@/lib/auth/session";
import type { AppPermission } from "@/lib/auth/permissions";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { hasProductCapability } from "@/lib/product-model";

export type OperationalReadScope = Readonly<{ projectId?: string; botId?: string }>;
type Snapshot = Record<string, unknown>;
export type ChannelHistory = {
  source: "database";
  channelAccounts: Array<{ id: string; active: boolean; accountLabel: string | null; channel: string; externalAccountId: string | null; provider: string; setupStatus: string; updatedAt: string }>;
  recentWebhookEvents: Array<{ id: string; channel: string; externalMessageId: string | null; contactRef: string | null; eventType: string; status: string; receivedAt: string; normalizedMessage: { text?: string } }>;
};
export type ActionHistory = {
  source: "database";
  documentSends: Array<{ id: string; channel: string; documentName: string; status: string; createdAt: string; sentAt: string | null; conversationId: string | null; conversationTitle: string | null; contactId: string | null; contactEmail: string | null; contactName: string | null; contactPhone: string | null; mediaAssetId: string | null; mediaAssetName: string | null; mediaAssetMimeType: string | null; mediaAssetIsPublic: boolean | null; mediaAssetHasActivePublicShare: boolean; mediaAssetUrl: string | null; metadata: Record<string, unknown> }>;
  meetingBookings: Array<{ id: string; contactEmail: string; contactName: string; createdAt: string; endsAt: string; startsAt: string; slug: string; status: string; title: string }>;
  meetingBookingsAvailable: boolean;
  metrics: { openDocuments: number; openMeetings: number | null };
};
export type ApprovalHistory = { source: "database"; status: string; approvals: Array<{ id: string; entityType: string; entityId: string | null; action: string; summary: string; status: string; createdAt: string; payload: Record<string, unknown> }> };
export type CalendarConnectionSnapshot = { provider: "google" | "microsoft"; accountLabel: string | null; connected: boolean; expiresAt: string | null; scopes: string[]; error: string | null };
export type CalendarConnections = { source: "database"; google: CalendarConnectionSnapshot; microsoft: CalendarConnectionSnapshot };

function validateSnapshot(snapshot: Snapshot, functionName: string) {
  const fields = functionName === "crm_read_bot_channels" ? ["channelAccounts", "recentWebhookEvents"] :
    functionName === "crm_read_bot_actions" ? ["documentSends", "meetingBookings"] : ["approvals"];
  if (functionName === "crm_read_calendar_connections") {
    if (snapshot.source !== "database") throw new Error("Calendar read contract unavailable");
    for (const provider of ["google", "microsoft"]) {
      const item = snapshot[provider] as CalendarConnectionSnapshot | undefined;
      if (!item || item.provider !== provider || typeof item.connected !== "boolean" || !Array.isArray(item.scopes)) throw new Error("Calendar read contract unavailable");
    }
  } else if (snapshot.source !== "database" || fields.some(field => !Array.isArray(snapshot[field]))) {
    throw new Error("Operational read contract unavailable");
  }
}

async function readSnapshot(session: AppSession, scope: OperationalReadScope, permission: AppPermission, functionName: string,
  status: string | undefined, options: TenantTransactionOptions) {
  if (scope.projectId) assertCrmUuid(scope.projectId, "projectId");
  if (scope.botId) assertCrmUuid(scope.botId, "botId");
  return withCrmRead(session, async (tx: TenantTransaction, fresh: AppSession) => {
    const access = resolveWorkspaceMembershipAccess(fresh);
    if (!access.permissions.includes(permission) || fresh.serviceIdentity ||
      (permission === "calendar:sync" && !hasProductCapability(fresh.productRole, "calendar:manage"))) {
      throw new CrmCommandError("FORBIDDEN", "Read access is not granted", 403);
    }
    if (scope.projectId) await assertProjectGrant(tx, fresh, scope.projectId);
    // Function names are server constants. All caller values remain parameters.
    const params = permission === "calendar:sync" ? [fresh.workspaceId] :
      [fresh.workspaceId, scope.projectId ?? null, scope.botId ?? null, ...(status ? [status] : [])];
    const placeholders = params.map((_, i) => `$${i + 1}::${i === 3 ? "text" : "uuid"}`).join(",");
    const row = await tx.queryOne<{ snapshot: Snapshot }>(`select ${functionName}(${placeholders}) as snapshot`, params);
    if (!row?.snapshot || typeof row.snapshot !== "object" || Array.isArray(row.snapshot)) {
      throw new Error("Operational read contract unavailable");
    }
    validateSnapshot(row.snapshot, functionName);
    return row.snapshot;
  }, options);
}

export async function readBotChannelHistory(session: AppSession, scope: OperationalReadScope = {}, options: TenantTransactionOptions = {}) {
  return readSnapshot(session, scope, "bots:run", "crm_read_bot_channels", undefined, options) as Promise<ChannelHistory>;
}

export async function readBotActionHistory(session: AppSession, scope: OperationalReadScope = {}, options: TenantTransactionOptions = {}) {
  return readSnapshot(session, scope, "bots:run", "crm_read_bot_actions", undefined, options) as Promise<ActionHistory>;
}

export async function readApprovalHistory(session: AppSession, scope: OperationalReadScope = {}, status = "pending", options: TenantTransactionOptions = {}) {
  if (!["pending", "approved", "denied", "expired"].includes(status)) throw new CrmCommandError("VALIDATION_ERROR", "Invalid approval status");
  return readSnapshot(session, scope, "bots:approve", "crm_read_approvals", status, options) as Promise<ApprovalHistory>;
}

export async function readCalendarConnectionStatuses(session: AppSession, options: TenantTransactionOptions = {}) {
  return readSnapshot(session, {}, "calendar:sync", "crm_read_calendar_connections", undefined, options) as Promise<CalendarConnections>;
}
