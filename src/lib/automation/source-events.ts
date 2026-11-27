import type { AppSession } from "@/lib/auth/session";
import { CrmCommandError } from "@/lib/crm-command";
import { currentTenantTransaction } from "@/lib/db/transaction-context";
import { recordAutomationEvent, type AutomationEventInput } from "./repository";

/** Optional additive module: old tenants keep their ordinary writes before migration 120.
 * Once installed, an event failure rolls the source transaction back with its mutation. */
export async function recordSourceAutomationEvent(session: AppSession, event: Omit<AutomationEventInput, "workspaceId">) {
  const active = currentTenantTransaction();
  if (!active) return { recorded: false, reason: "transaction_required" as const };
  if (active.scope.workspaceId !== session.workspaceId || active.scope.actorId !== session.userId) throw new CrmCommandError("TENANT_MISMATCH", "Automationsereignis und Transaktion gehören nicht zusammen.", 403);
  const installed = await active.transaction.queryOne<{ ready: boolean }>("select to_regclass('public.crm_automation_events') is not null as ready");
  if (!installed?.ready) return { recorded: false, reason: "module_not_installed" as const };
  const result = await recordAutomationEvent(active.transaction, { ...event, workspaceId: session.workspaceId }, { enroll: false });
  return { recorded: true, ...result };
}

/** Completion is inferred only from the persisted search-profile contract, not from a click. */
export async function recordBuyerProfileCompletion(session: AppSession, profileId: string) {
  const active = currentTenantTransaction();
  if (!active) return { recorded: false, reason: "transaction_required" as const };
  const row = await active.transaction.queryOne<{ leadId: string | null; projectId: string | null; complete: boolean }>(`select buyer_lead_id as "leadId",project_id as "projectId",(budget_to_cents>0 and coalesce(budget_from_cents,0)>=0 and coalesce(budget_from_cents,0)<=budget_to_cents and nullif(trim(desired_location),'') is not null and nullif(trim(property_type),'') is not null) as complete from buyer_search_profiles where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, profileId]);
  if (!row?.leadId || !row.complete) return { recorded: false, reason: "profile_incomplete" as const };
  return recordSourceAutomationEvent(session, { leadId: row.leadId, projectId: row.projectId, eventId: `search-profile-completed:${profileId}`, trigger: "search_profile_completed", context: { searchProfileCompleted: true } });
}
