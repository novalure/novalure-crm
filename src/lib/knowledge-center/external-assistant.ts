import "server-only";

import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { withCrmRead, assertProjectGrant } from "@/lib/crm-command";
import { ExternalIntegrationError, resolveExternalIntegration, type ExternalIntegrationResolution } from "@/lib/db/external-integration-gateway";
import type { TenantTransaction, TenantTransactionOptions } from "@/lib/db/tenant-client";
import { exactBehaviorObject } from "@/lib/shared-behavior/catalog";
import { loadNativeWebsiteBehavior, type NativeAssistantOptions } from "@/lib/shared-behavior/native-assistant";
import { webchatBehaviorFingerprint } from "@/lib/shared-behavior/fingerprint";
import { assistantKnowledgeLimits, retrieveAssistantKnowledge } from "./integrations";
import { knowledgeId } from "./policy";

/**
 * Existing External Integration Gateway credentials authorize a visitor only
 * for its active session. Tenant, project, actor and assistant come from the
 * current saved integration; the channel is fixed to webchat server-side.
 */
type ExternalAssistantInput = Readonly<{
  origin: string;
  publicSiteKey: string;
  sessionId: string;
  sessionToken: string;
}>;
type Authority = Readonly<{ assistantId: string; projectId: string | null }>;
export type ExternalAssistantOptions = NativeAssistantOptions & { includeSharedBehavior?: boolean };

async function withExternalAssistantAuthority<T>(input: ExternalAssistantInput,
  work: (tx: TenantTransaction, member: AppSession, authority: Authority) => Promise<T>, options: TenantTransactionOptions) {
  const resolution = await resolveExternalIntegration({
    capability: "chat.context", origin: input.origin, publicSiteKey: input.publicSiteKey,
  });
  if (!resolution || resolution.widgetConfiguration.chatEnabled !== true) throw new ExternalIntegrationError("integration_not_found", 404);
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(input.sessionToken)) throw new ExternalIntegrationError("session_denied", 403);
  knowledgeId(input.sessionId, "sessionId");
  const session: AppSession = {
    authenticated: true, source: "database", userId: resolution.publicActorId,
    workspaceId: resolution.workspaceId, workspaceName: "Verified integration workspace",
    name: "Verified integration actor", email: "external-integration@service.invalid",
    role: "owner", productRole: "customer_owner", permissions: ["crm:read"], productPermissions: [],
  };
  return withCrmRead(session, async (tx, member) => {
    const current = await tx.queryOne<ExternalIntegrationResolution>(
      `select integration_id as "integrationId",workspace_id as "workspaceId",project_id as "projectId",
        public_actor_id as "publicActorId",configuration,widget_configuration as "widgetConfiguration"
       from public.crm_external_integration_resolve($1,$2,'chat.context',null::uuid)`, [input.publicSiteKey, input.origin]);
    if (!current || current.integrationId !== resolution.integrationId || current.workspaceId !== member.workspaceId ||
      current.publicActorId !== member.userId || current.widgetConfiguration.chatEnabled !== true) {
      throw new ExternalIntegrationError("integration_not_found", 404);
    }
    const active = await tx.queryOne<{ projectId: string | null }>(
      `select project_id as "projectId" from public.external_chat_sessions
       where id=$1::uuid and workspace_id=$2::uuid and integration_id=$3::uuid
         and session_token_hash=$4 and status='active' for share`,
      [input.sessionId, member.workspaceId, current.integrationId, createHash("sha256").update(input.sessionToken).digest("hex")]);
    if (!active || active.projectId !== current.projectId) throw new ExternalIntegrationError("session_denied", 403);
    let assistantId: string;
    try { assistantId = knowledgeId(current.configuration.knowledgeAssistantId, "assistantId"); }
    catch { throw new ExternalIntegrationError("assistant_not_configured", 403); }
    const bot = await tx.queryOne<{ projectId: string | null }>(
      `select project_id as "projectId" from public.bots where id=$1::uuid and workspace_id=$2::uuid for share`, [assistantId, member.workspaceId]);
    if (!bot || bot.projectId !== current.projectId) throw new ExternalIntegrationError("assistant_not_configured", 403);
    if (bot.projectId) await assertProjectGrant(tx, member, bot.projectId);
    return work(tx, member, { assistantId, projectId: bot.projectId });
  }, { ...options, statementTimeoutMs: assistantKnowledgeLimits.statementTimeoutMs });
}

export async function retrieveExternalAssistantKnowledge(input: ExternalAssistantInput & Readonly<{ query: string; maxResults: number }>, options: ExternalAssistantOptions = {}) {
  return withExternalAssistantAuthority(input, async (_tx, member, authority) => {
    const knowledge = await retrieveAssistantKnowledge(member, { assistantId: authority.assistantId, channel: "webchat", query: input.query, maxResults: input.maxResults }, options);
    if (!options.includeSharedBehavior) return knowledge;
    const behavior = await loadNativeWebsiteBehavior(member, options);
    return { ...knowledge, behavior: behavior ? { ...behavior, fingerprint: webchatBehaviorFingerprint(behavior) } : null };
  }, options);
}

/** Exact source/version and methods recheck. No retrieval, usage increment or text input. */
export async function checkExternalAssistantContext(input: ExternalAssistantInput & Readonly<{ sourceVersions: unknown; behaviorFingerprint: unknown }>, options: NativeAssistantOptions = {}) {
  if (!Array.isArray(input.sourceVersions) || input.sourceVersions.length > 5 ||
    typeof input.behaviorFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.behaviorFingerprint)) throw new ExternalIntegrationError("invalid_request", 400);
  const versions = input.sourceVersions.map(value => {
    const row = exactBehaviorObject(value, ["sourceId", "versionId"]);
    return { sourceId: knowledgeId(row.sourceId, "sourceId"), versionId: knowledgeId(row.versionId, "versionId") };
  });
  if (new Set(versions.map(row => `${row.sourceId}:${row.versionId}`)).size !== versions.length) throw new ExternalIntegrationError("invalid_request", 400);
  return withExternalAssistantAuthority(input, async (tx, member, authority) => {
    let knowledgeCurrent = true;
    if (versions.length) {
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`knowledge-center:${member.workspaceId}`]);
      const entitled = await tx.queryOne<{ allowed: boolean }>(`select e.enabled and length(trim(coalesce(e.contract_reference,'')))>0
        and e.features->>'webchatAccess'='true' and not exists(select 1 from workspace_module_settings m
          where m.workspace_id=e.workspace_id and m.module_key in ('knowledge','bots') and m.enabled=false) as allowed
        from knowledge_center_entitlements e where e.workspace_id=$1::uuid`, [member.workspaceId]);
      const current = await tx.query(`select s.id from jsonb_to_recordset($1::jsonb) as r("sourceId" uuid,"versionId" uuid)
        join knowledge_sources s on s.id=r."sourceId" and s.workspace_id=$2::uuid and s.approved_version_id=r."versionId" and s.archived_at is null
        join knowledge_source_versions v on v.id=r."versionId" and v.source_id=s.id and v.workspace_id=s.workspace_id and v.status='approved'
        join knowledge_areas a on a.id=s.knowledge_area_id and a.workspace_id=s.workspace_id and a.archived_at is null
        join knowledge_area_grants g on g.area_id=a.id and g.workspace_id=a.workspace_id and g.bot_id=$3::uuid and g.channel='webchat'
        where (a.project_id is null or a.project_id=$4::uuid) and (s.project_id is null or crm_project_access(s.workspace_id,s.project_id,false))`,
      [JSON.stringify(versions), member.workspaceId, authority.assistantId, authority.projectId]);
      knowledgeCurrent = entitled?.allowed === true && current.length === versions.length;
    }
    const behavior = await loadNativeWebsiteBehavior(member, options);
    return { current: knowledgeCurrent && behavior !== null && webchatBehaviorFingerprint(behavior) === input.behaviorFingerprint };
  }, options);
}
