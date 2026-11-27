import "server-only";
import type { AppSession } from "./auth/session";
import { getRolePermissions, isAppRole } from "./auth/permissions";
import { getProductRoleCapabilities, hasProductCapability, isProductRole } from "./product-model";
import { CrmCommandError, withCrmRead, type TenantTransaction } from "./crm-command";
import { withTenantTransaction } from "./db/tenant-client";
import { runWithTenantTransaction } from "./db/transaction-context";
import { configuredCrmNotificationEmailScopes, crmNotificationEmailConfiguration, type CrmNotificationEmailScope } from "./crm-notification-email-configuration";
import { claimCrmNotificationEmail, finishCrmNotificationEmail, prepareCrmNotificationEmail, type NotificationEmailOptions } from "./db/crm-notification-email-repository";
import { dispatchApprovedNewsletter, type NewsletterTransport } from "./newsletter-provider";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "./cron/runtime";

type WorkerOptions = NotificationEmailOptions & { transport?: NewsletterTransport };
async function withActor<T>(scope: CrmNotificationEmailScope, options: WorkerOptions, work: (tx: TenantTransaction, session: AppSession) => Promise<T>) {
  return withTenantTransaction({ workspaceId: scope.workspaceId, actorId: scope.actorId }, tx => runWithTenantTransaction({ workspaceId: scope.workspaceId, actorId: scope.actorId }, tx, async () => {
    const member = await tx.queryOne<{ role: string; productRole: string; operatingModel: string; identityId: string | null }>(`select role,product_role as "productRole",operating_model as "operatingModel",auth_identity_id as "identityId" from crm_lock_active_member($1::uuid,$2::uuid)`, [scope.workspaceId, scope.actorId]);
    if (!member || !member.identityId || !isAppRole(member.role) || !isProductRole(member.productRole) || member.productRole === "external_partner" || !getRolePermissions(member.role).includes("crm:read") || (member.operatingModel === "novalure_internal" && !hasProductCapability(member.productRole, "novalure:internal"))) throw new CrmCommandError("DIGEST_ACTOR_REVOKED", "Digest-Mitgliedschaft ist nicht mehr aktiv", 403);
    const session: AppSession = { authenticated: true, source: "database", workspaceId: scope.workspaceId, userId: scope.actorId, workspaceName: "", name: "Persönliche Digest-Ausführung", email: "", role: member.role, productRole: member.productRole, authIdentityId: member.identityId, permissions: getRolePermissions(member.role), productPermissions: getProductRoleCapabilities(member.productRole) };
    return withCrmRead(session, freshTx => work(freshTx, session));
  }), options);
}
/** Claim is committed before I/O. Unknown outcomes retain coverage and are never automatically replayed. */
export async function processCrmNotificationEmail(scope: CrmNotificationEmailScope, options: WorkerOptions = {}) {
  const config = crmNotificationEmailConfiguration(scope, options.env); if (!config.ready) return { status: "blocked", reason: config.reason };
  const prepared = await withActor(scope, options, (tx, session) => prepareCrmNotificationEmail(tx, session, options));
  if (!("id" in prepared) || !prepared.id) return { status: "quiet", reason: prepared.reason };
  const claim = await withActor(scope, options, (tx, session) => claimCrmNotificationEmail(tx, session, prepared.id!, options));
  if (!claim) return { status: "quiet", reason: "not_claimed" };
  // A final deployment pause/configuration check precedes the external adapter call.
  if (!crmNotificationEmailConfiguration(scope, options.env).ready) {
    await withActor(scope, options, (tx, session) => finishCrmNotificationEmail(tx, session, claim, { status: "failed" }));
    return { status: "blocked", reason: "configuration_changed" };
  }
  const result = await (options.transport ?? dispatchApprovedNewsletter)(claim.payload).catch(() => ({ status: "uncertain" as const }));
  const finished = await withActor(scope, options, (tx, session) => finishCrmNotificationEmail(tx, session, claim, result));
  return { status: finished.saved ? finished.status : "uncertain", id: claim.id };
}
export async function handleCrmNotificationEmailCron(request: Request, env: NodeJS.ProcessEnv = process.env, options: WorkerOptions = {}) {
  if (request.method !== "GET" || new URL(request.url).search || !env.CRON_SECRET?.trim() || !isCronAuthorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (areQueueWorkersPaused(env)) return Response.json({ ok: true, paused: true });
  let scopes: CrmNotificationEmailScope[]; try { scopes = configuredCrmNotificationEmailScopes(env); } catch { return Response.json({ ok: false, code: "DIGEST_SCOPE_INVALID" }, { status: 503 }); }
  const host = createCronRun({ route: "notification-digests", softDeadlineMs: 45000 }), results: { status: string; code?: string }[] = [];
  for (const scope of scopes) {
    if (!host.shouldContinue() || areQueueWorkersPaused(env)) break;
    try { const result = await processCrmNotificationEmail(scope, { ...options, env }); results.push({ status: result.status }); }
    catch (error) { results.push({ status: "blocked", code: error instanceof CrmCommandError ? error.code : "DIGEST_UNAVAILABLE" }); }
  }
  const ok = results.every(result => !["blocked", "uncertain", "failed"].includes(result.status));
  return Response.json({ ok, runId: host.runId, configured: scopes.length, attempted: results.length, results, durationMs: host.durationMs() }, { status: ok ? 200 : 503 });
}
