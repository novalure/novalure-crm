import "server-only";
import { randomUUID } from "node:crypto";
import type { AppSession } from "../auth/session";
import { getRolePermissions, isAppRole } from "../auth/permissions";
import { getProductRoleCapabilities, hasProductCapability, isProductRole } from "../product-model";
import { withTenantTransaction, type TenantTransaction, type TenantTransactionOptions } from "../db/tenant-client";
import { runWithTenantTransaction } from "../db/transaction-context";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "../cron/runtime";
import { KnowledgeCenterError, knowledgeId } from "./policy";
import type { KnowledgeMonitoringJob, KnowledgeMonitoringOptions } from "./monitoring";

type MonitoringScope = Readonly<{ workspaceId: string; sourceId: string; actorId: string }>;
type HostAuthority = Readonly<{ readonly kind: "knowledge-monitoring-host" }>;
type HostProof = { scopes: readonly MonitoringScope[]; deadline: number; runId: string; env: NodeJS.ProcessEnv };
type Delegation = { host: HostAuthority; job: KnowledgeMonitoringJob; identityId: string };
const hosts = new WeakMap<HostAuthority, HostProof>();
const principals = new WeakMap<AppSession, Delegation>();
const scopeKeys = ["actorId", "sourceId", "workspaceId"];
function deny(code: string): never { throw new KnowledgeCenterError(code, "Scheduled website monitoring is not authorized.", 403); }
function configuredScopes(env: NodeJS.ProcessEnv): MonitoringScope[] {
  const value: unknown = JSON.parse(env.NOVALURE_KNOWLEDGE_MONITORING_SCOPES?.trim() || "[]");
  if (!Array.isArray(value) || value.length > 3) deny("MONITORING_SCOPE_INVALID");
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join() !== scopeKeys.join()) deny("MONITORING_SCOPE_INVALID");
    const scope = Object.freeze({ workspaceId: knowledgeId(item.workspaceId, "workspaceId"), sourceId: knowledgeId(item.sourceId, "sourceId"), actorId: knowledgeId(item.actorId, "actorId") });
    const key = `${scope.workspaceId}:${scope.sourceId}`;
    if (seen.has(key)) deny("MONITORING_SCOPE_INVALID");
    seen.add(key); return scope;
  });
}

/** Nonsecret UI readiness only. It neither grants authority nor discovers other tenants. */
export function getKnowledgeMonitoringDispatcherReadiness(scope: MonitoringScope, env: NodeJS.ProcessEnv = process.env) {
  if (areQueueWorkersPaused(env)) return { available: false, reason: "paused" as const };
  if (!env.CRON_SECRET?.trim()) return { available: false, reason: "cron_auth_unavailable" as const };
  try {
    const available = configuredScopes(env).some(item => scopeKeys.every(key => item[key as keyof MonitoringScope] === scope[key as keyof MonitoringScope]));
    return { available, reason: available ? "ready" as const : "not_configured" as const };
  } catch { return { available: false, reason: "invalid_configuration" as const }; }
}

/** The only minting path; a JSON-shaped object or a browser cookie is never host authority. */
export function authorizeKnowledgeMonitoringCron(request: Request, env: NodeJS.ProcessEnv = process.env): HostAuthority | null {
  if (request.method !== "GET" || !env.CRON_SECRET?.trim() || !isCronAuthorized(request, env)) return null;
  if (new URL(request.url).search) return null;
  const authority = Object.freeze({ kind: "knowledge-monitoring-host" as const });
  hosts.set(authority, { scopes: configuredScopes(env), deadline: Date.now() + 55_000, runId: randomUUID(), env });
  return authority;
}
function hostProof(authority: HostAuthority) {
  const proof = hosts.get(authority);
  if (!proof || Date.now() >= proof.deadline) deny("MONITORING_HOST_AUTHORITY_REQUIRED");
  if (areQueueWorkersPaused(proof.env)) deny("MONITORING_PAUSED");
  return proof;
}

/** A normal, persisted MFA session can save a durable, narrow scope grant. No login token is retained. */
export async function knowledgeMonitoringGrant(tx: TenantTransaction, session: AppSession, configRevision: number, enabled: boolean, interval: string) {
  if (!enabled || interval === "manual" || session.source !== "cookie" || session.serviceIdentity || !session.authIdentityId || !session.authSessionId) return {};
  const verified = await tx.queryOne<{ valid: boolean }>(`select exists(select 1 from auth_sessions s join auth_identities i on i.id=s.auth_identity_id
    where s.id=$1::uuid and s.auth_identity_id=$2::uuid and s.workspace_id=$3::uuid and s.workspace_user_id=$4::uuid
    and s.revoked_at is null and s.expires_at>clock_timestamp() and s.mfa_verified_at is not null
    and i.credential_state='active' and i.disabled_at is null and i.mfa_enabled_at is not null) as valid`, [session.authSessionId, session.authIdentityId, session.workspaceId, session.userId]);
  if (!verified?.valid) deny("MONITORING_MFA_GRANT_REQUIRED");
  return { monitoringDelegation: { version: 1, identityId: session.authIdentityId, configRevision, actorId: session.userId, interval } };
}

type Member = { role: string; productRole: string; operatingModel: string; identityId: string | null };
async function currentPrincipal(tx: TenantTransaction, scope: MonitoringScope, authority: HostAuthority, revision?: number): Promise<{ session: AppSession; job: KnowledgeMonitoringJob } | null> {
  hostProof(authority);
  const member = await tx.queryOne<Member>(`select role,product_role as "productRole",operating_model as "operatingModel",auth_identity_id as "identityId" from crm_lock_active_member($1::uuid,$2::uuid)`, [scope.workspaceId, scope.actorId]);
  if (!member || !member.identityId || !isAppRole(member.role) || !isProductRole(member.productRole)) deny("MONITORING_ACTOR_REVOKED");
  const permissions = getRolePermissions(member.role);
  if (!permissions.includes("crm:read") || !permissions.includes("crm:write") || !["novalure_internal", "self_service_customer", "managed_by_novalure", "hybrid"].includes(member.operatingModel) || (member.operatingModel === "novalure_internal" && !hasProductCapability(member.productRole, "novalure:internal"))) deny("MONITORING_ACTOR_REVOKED");
  // Read only security metadata already granted to the ordinary runtime. No credential or MFA secret is selected.
  const identity = await tx.queryOne<{ active: boolean }>(`select credential_state='active' and disabled_at is null and mfa_enabled_at is not null as active from auth_identities where id=$1::uuid for share`, [member.identityId]);
  if (!identity?.active) deny("MONITORING_IDENTITY_REVOKED");
  // Match the scanner/configuration lock order before holding a configuration row lock.
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`knowledge-center:${scope.workspaceId}`]);
  const config = await tx.queryOne<{ revision: number; interval: string; due: boolean; granted: boolean }>(`select c.revision,c.interval,c.next_due_at<=clock_timestamp() as due,
    exists(select 1 from audit_logs a where a.workspace_id=c.workspace_id and a.actor_user_id=c.configured_by and a.entity_id=c.source_id
      and a.action='knowledge.website.monitoring_configured' and a.after->'monitoringDelegation' = jsonb_build_object('version',1,'identityId',$4::text,'configRevision',c.revision,'actorId',c.configured_by::text,'interval',c.interval)
      and a.after->>'enabled'='true') as granted
    from knowledge_website_monitoring c where c.workspace_id=$1::uuid and c.source_id=$2::uuid and c.configured_by=$3::uuid and c.enabled and c.interval='daily' for share`, [scope.workspaceId, scope.sourceId, scope.actorId, member.identityId]);
  if (!config) deny("MONITORING_CONFIG_CHANGED");
  if (!config.granted) deny("MONITORING_MFA_GRANT_REQUIRED");
  if (revision !== undefined && revision !== config.revision) deny("MONITORING_CONFIG_CHANGED");
  if (revision === undefined && !config.due) return null;
  const job = Object.freeze({ ...scope, configRevision: config.revision });
  const session: AppSession = Object.freeze({ authenticated: true, source: "database", userId: scope.actorId, workspaceId: scope.workspaceId,
    workspaceName: "", email: "", name: "Delegated website monitoring", role: member.role, permissions,
    productRole: member.productRole, productPermissions: getProductRoleCapabilities(member.productRole),
    serviceIdentity: Object.freeze({ identityId: "KNOWLEDGE_MONITOR", role: "Knowledge.Monitor", consumer: "KNOWLEDGE_MONITORING", environment: "production", delegatedByIdentityId: member.identityId, sourceId: scope.sourceId, configRevision: config.revision, runId: hostProof(authority).runId }) });
  principals.set(session, { host: authority, job, identityId: member.identityId });
  const { knowledgeInternals } = await import("./repository");
  const { allowedKnowledgeMonitoringIntervals } = await import("./monitoring");
  const contract = await knowledgeInternals.enabled(tx, session);
  if (!allowedKnowledgeMonitoringIntervals(contract).includes("daily")) deny("ENTITLEMENT_REQUIRED");
  const source = await knowledgeInternals.source(tx, session, scope.sourceId, true);
  if (source.type !== "url" || !source.version?.url) deny("MONITORING_SOURCE_CHANGED");
  return { session, job };
}

/** Called only by the scheduled scan's claim/finish/failure transactions, never general CRM commands. */
export async function withKnowledgeMonitoringDelegation<T>(session: AppSession, job: KnowledgeMonitoringJob, callback: (tx: TenantTransaction, fresh: AppSession) => Promise<T>, options: TenantTransactionOptions = {}): Promise<T> {
  const proof = principals.get(session);
  if (!proof || session.serviceIdentity?.role !== "Knowledge.Monitor" || proof.job.workspaceId !== job.workspaceId || proof.job.actorId !== job.actorId || proof.job.sourceId !== job.sourceId || proof.job.configRevision !== job.configRevision) deny("MONITORING_DELEGATION_REQUIRED");
  hostProof(proof.host);
  return withTenantTransaction({ workspaceId: job.workspaceId, actorId: job.actorId }, tx => runWithTenantTransaction({ workspaceId: job.workspaceId, actorId: job.actorId }, tx, async () => {
    const current = await currentPrincipal(tx, job, proof.host, job.configRevision);
    if (!current || current.session.serviceIdentity?.role !== "Knowledge.Monitor" || current.session.serviceIdentity.delegatedByIdentityId !== proof.identityId) deny("MONITORING_IDENTITY_REVOKED");
    return callback(tx, current.session);
  }), options);
}

export function knowledgeMonitoringAuditMetadata(session: AppSession): Record<string, unknown> {
  const identity = session.serviceIdentity;
  if (identity?.role !== "Knowledge.Monitor" || !principals.has(session)) return {};
  return { actorType: "DELEGATED_KNOWLEDGE_JOB", delegation: { sourceId: identity.sourceId, configRevision: identity.configRevision, delegatedByIdentityId: identity.delegatedByIdentityId, hostRunId: identity.runId }, scope: "knowledge.website.scan_proposal_only" };
}

export async function dispatchKnowledgeMonitoring(authority: HostAuthority, options: KnowledgeMonitoringOptions = {}) {
  const proof = hostProof(authority), run = createCronRun({ route: "knowledge-monitoring", softDeadlineMs: 45_000 });
  const results: { sourceId: string; outcome: "completed" | "busy" | "blocked" | "not_due"; runStatus?: string; errorCode?: string }[] = [];
  for (const scope of proof.scopes) {
    if (!run.shouldContinue()) break;
    try {
      const current = await withTenantTransaction({ workspaceId: scope.workspaceId, actorId: scope.actorId }, tx => currentPrincipal(tx, scope, authority), options);
      if (!current) { results.push({ sourceId: scope.sourceId, outcome: "not_due" }); continue; }
      const { runScheduledKnowledgeWebsiteScan } = await import("./monitoring");
      const result = await runScheduledKnowledgeWebsiteScan(current.session, current.job, options);
      if (["failed", "blocked", "stale"].includes(result.run.status)) results.push({ sourceId: scope.sourceId, outcome: "blocked", runStatus: result.run.status, errorCode: result.run.errorCode ?? "MONITORING_SCAN_INCOMPLETE" });
      else results.push({ sourceId: scope.sourceId, outcome: result.busy ? "busy" : "completed", runStatus: result.run.status });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "MONITORING_UNAVAILABLE";
      results.push({ sourceId: scope.sourceId, outcome: "blocked", errorCode: /^[a-zA-Z0-9_]{1,80}$/.test(code) ? code : "MONITORING_UNAVAILABLE" });
    }
  }
  return { ok: results.every(item => item.outcome !== "blocked"), configured: proof.scopes.length, attempted: results.length, runId: proof.runId, durationMs: run.durationMs(), results };
}

export async function handleKnowledgeMonitoringCron(request: Request, env: NodeJS.ProcessEnv = process.env, options: KnowledgeMonitoringOptions = {}) {
  let authority: HostAuthority | null;
  try { authority = authorizeKnowledgeMonitoringCron(request, env); }
  catch { return Response.json({ ok: false, code: "MONITORING_SCOPE_INVALID" }, { status: 503 }); }
  if (!authority) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (areQueueWorkersPaused(env)) return Response.json({ ok: true, paused: true });
  const result = await dispatchKnowledgeMonitoring(authority, options);
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
