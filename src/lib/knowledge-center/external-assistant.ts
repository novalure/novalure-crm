import "server-only";

import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { withCrmRead, assertProjectGrant } from "@/lib/crm-command";
import { ExternalIntegrationError, resolveExternalIntegration, type ExternalIntegrationResolution } from "@/lib/db/external-integration-gateway";
import type { TenantTransactionOptions } from "@/lib/db/tenant-client";
import { assistantKnowledgeLimits, retrieveAssistantKnowledge } from "./integrations";
import { knowledgeId } from "./policy";

/**
 * Existing External Integration Gateway credentials authorize a visitor only
 * for its active session. Tenant, project, actor and assistant come from the
 * current saved integration; the channel is fixed to webchat server-side.
 */
export async function retrieveExternalAssistantKnowledge(input: Readonly<{
  origin: string;
  publicSiteKey: string;
  sessionId: string;
  sessionToken: string;
  query: string;
  maxResults: number;
}>, options: TenantTransactionOptions = {}) {
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
    return retrieveAssistantKnowledge(member, { assistantId, channel: "webchat", query: input.query, maxResults: input.maxResults }, options);
  }, { ...options, statementTimeoutMs: assistantKnowledgeLimits.statementTimeoutMs });
}
