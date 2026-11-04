import "server-only";
import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { getRolePermissions, isAppRole } from "@/lib/auth/permissions";
import { getProductRoleCapabilities, hasProductCapability, isProductRole } from "@/lib/product-model";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { runWithTenantTransaction } from "@/lib/db/transaction-context";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";
import { runAutomationDue } from "./repository";

type ScheduledScope = { workspaceId: string; actorId: string; automationId: string };
function configuredScopes(env: NodeJS.ProcessEnv): ScheduledScope[] {
  const value: unknown = JSON.parse(env.NOVALURE_AUTOMATION_SCOPES?.trim() || "[]");
  if (!Array.isArray(value) || value.length > 20) throw new CrmCommandError("AUTOMATION_SCOPE_INVALID", "Automations-Zeitplan ist ungültig.", 503);
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join() !== "actorId,automationId,workspaceId") throw new CrmCommandError("AUTOMATION_SCOPE_INVALID", "Automations-Zeitplan ist ungültig.", 503);
    const row = item as Record<string, unknown>, scope = { workspaceId: assertCrmUuid(row.workspaceId), actorId: assertCrmUuid(row.actorId), automationId: assertCrmUuid(row.automationId) };
    if (seen.has(`${scope.workspaceId}:${scope.automationId}`)) throw new CrmCommandError("AUTOMATION_SCOPE_INVALID", "Flow wurde mehrfach im Zeitplan eingetragen.", 503);
    seen.add(`${scope.workspaceId}:${scope.automationId}`); return scope;
  });
}
/** Nonsecret readiness only. Never returns configured scope IDs to other tenants. */
export function automationSchedulerReadiness(scope: ScheduledScope, granted: boolean, env: NodeJS.ProcessEnv = process.env) {
  if (areQueueWorkersPaused(env)) return { ready: false, reason: "paused" };
  if (!granted) return { ready: false, reason: "mfa_activation_required" };
  if (!env.CRON_SECRET?.trim()) return { ready: false, reason: "cron_auth_unavailable" };
  try {
    const ready = configuredScopes(env).some((s) => s.workspaceId === scope.workspaceId && s.actorId === scope.actorId && s.automationId === scope.automationId);
    return { ready, reason: ready ? "ready" : "not_configured" };
  } catch { return { ready: false, reason: "invalid_configuration" }; }
}

/** A bearer-authenticated host tick can run only explicitly configured and durably delegated flow IDs. */
export async function handleAutomationCron(request: Request, env: NodeJS.ProcessEnv = process.env, options: TenantTransactionOptions = {}) {
  if (request.method !== "GET" || new URL(request.url).search || !env.CRON_SECRET?.trim() || !isCronAuthorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (areQueueWorkersPaused(env)) return Response.json({ ok: true, paused: true });
  let scopes: ScheduledScope[];
  try { scopes = configuredScopes(env); } catch { return Response.json({ ok: false, code: "AUTOMATION_SCOPE_INVALID" }, { status: 503 }); }
  const host = createCronRun({ route: "automations", softDeadlineMs: 45000 });
  const results: { automationId: string; status: string; processed?: number; ingested?: number; code?: string }[] = [];
  for (const scope of scopes) {
    if (!host.shouldContinue() || areQueueWorkersPaused(env)) break;
    try {
      const outcome = await withTenantTransaction({ workspaceId: scope.workspaceId, actorId: scope.actorId }, (tx) => runWithTenantTransaction({ workspaceId: scope.workspaceId, actorId: scope.actorId }, tx, async () => {
        const member = await tx.queryOne<{ role: string; productRole: string; operatingModel: string; identityId: string | null }>(`select role,product_role as "productRole",operating_model as "operatingModel",auth_identity_id as "identityId" from crm_lock_active_member($1::uuid,$2::uuid)`, [scope.workspaceId, scope.actorId]);
        if (!member || !member.identityId || !isAppRole(member.role) || !isProductRole(member.productRole) || !getRolePermissions(member.role).includes("crm:write") || !hasProductCapability(member.productRole, "pipeline:write") || (member.operatingModel === "novalure_internal" && !hasProductCapability(member.productRole, "novalure:internal"))) throw new CrmCommandError("AUTOMATION_ACTOR_REVOKED", "Automationsberechtigung wurde entzogen.", 403);
        const identity = await tx.queryOne<{ active: boolean }>(`select credential_state='active' and disabled_at is null and mfa_enabled_at is not null as active from auth_identities where id=$1::uuid for share`, [member.identityId]);
        if (!identity?.active) throw new CrmCommandError("AUTOMATION_IDENTITY_REVOKED", "Die delegierte Identität ist nicht mehr aktiv.", 403);
        const flow = await tx.queryOne<{ projectId: string | null; version: number; granted: boolean; status: string }>(`select project_id as "projectId",active_version as version,status,(schedule_actor_id=$3::uuid and schedule_identity_id=$4::uuid and schedule_version=active_version) as granted from crm_automations where workspace_id=$1::uuid and id=$2::uuid for share`, [scope.workspaceId, scope.automationId, scope.actorId, member.identityId]);
        if (flow && flow.status !== "active") return { paused: true, processed: 0, ingested: 0 };
        if (!flow || !flow.granted) throw new CrmCommandError("AUTOMATION_DELEGATION_REQUIRED", "Für diesen Flow fehlt eine aktive Delegation.", 403);
        const session: AppSession = { authenticated: true, source: "database", workspaceId: scope.workspaceId, userId: scope.actorId, workspaceName: "", email: "", name: "Delegierte Automationsausführung", role: member.role, productRole: member.productRole, permissions: getRolePermissions(member.role), productPermissions: getProductRoleCapabilities(member.productRole) };
        return withCrmRead(session, async () => {
          if (flow.projectId) await assertProjectGrant(tx, session, flow.projectId, true);
          else if (!(await tx.queryOne<{ allowed: boolean }>("select crm_workspace_manager($1::uuid) as allowed", [scope.workspaceId]))?.allowed) throw new CrmCommandError("AUTOMATION_PROJECT_REVOKED", "Projektberechtigung wurde entzogen.", 403);
          const result = await runAutomationDue(tx, session, flow.projectId, 20, scope.automationId);
          await tx.execute(`insert into audit_logs(id,workspace_id,actor_user_id,project_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'automation.scheduled_run','automation',$5::uuid,$6::jsonb)`, [randomUUID(), scope.workspaceId, scope.actorId, flow.projectId, scope.automationId, JSON.stringify({ actorType: "DELEGATED_AUTOMATION_JOB", hostRunId: host.runId, delegatedIdentityId: member.identityId, activeVersion: flow.version, result })]);
          return { ...result, paused: false };
        });
      }), options);
      results.push({ automationId: scope.automationId, status: outcome.paused ? "paused" : "completed", processed: outcome.processed, ingested: outcome.ingested });
    } catch (error) {
      const code = error instanceof CrmCommandError ? error.code : "AUTOMATION_UNAVAILABLE";
      results.push({ automationId: scope.automationId, status: "blocked", code });
    }
  }
  const ok = results.every((r) => r.status !== "blocked");
  return Response.json({ ok, configured: scopes.length, attempted: results.length, runId: host.runId, durationMs: host.durationMs(), results }, { status: ok ? 200 : 503 });
}
