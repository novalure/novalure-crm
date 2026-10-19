import "server-only";

import type { AppSession } from "@/lib/auth/session";
import { getRolePermissions } from "@/lib/auth/permissions";
import { CrmCommandError, crmPayloadDigest, withCrmRead } from "@/lib/crm-command";
import { CrmMachineAuthError, getCrmMachineBearer, verifyCrmMachineToken, type CrmMachineAuthOptions, type CrmMachineClaims } from "@/lib/crm-machine-auth";
import { queryAuthenticationRows, type TenantTransactionOptions } from "@/lib/db/tenant-client";
import { getProductRoleCapabilities } from "@/lib/product-model";
import { assistantKnowledgeFallback, assistantKnowledgeLimits, retrieveAssistantKnowledge } from "./integrations";
import { knowledgeErrorResponse, knowledgeJson, readKnowledgeJson } from "./http";
import { KnowledgeCenterError, knowledgeText } from "./policy";

type MachinePrincipal = {
  id: string; workspace_id: string; actor_user_id: string;
  identity_id: string; data_context: string;
};
export type MachineKnowledgeOptions = TenantTransactionOptions & { machineAuth?: CrmMachineAuthOptions };
const machineAuthenticationSql = "select * from public.crm_authenticate_machine($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9)";
function machineParams(claims: CrmMachineClaims) {
  return [claims.identityId, claims.subject, claims.issuer, claims.audience, claims.projectId,
    claims.ownerId, claims.workspaceId, claims.environment, claims.role];
}
function denied(status = 403): never {
  throw new KnowledgeCenterError("ASSISTANT_ACCESS_DENIED", "Knowledge access is not granted.", status);
}

export function parseAssistantKnowledgeQuery(body: Record<string, unknown>) {
  const query = knowledgeText(body.query, "query", assistantKnowledgeLimits.queryCharacters);
  const maxResults = body.maxResults ?? assistantKnowledgeLimits.maxResults;
  if (!Number.isSafeInteger(maxResults) || Number(maxResults) < 1 || Number(maxResults) > assistantKnowledgeLimits.maxResults) {
    throw new KnowledgeCenterError("VALIDATION_ERROR", "maxResults must be between 1 and 5.");
  }
  return { query, maxResults: Number(maxResults) };
}

/**
 * Dedicated provider-neutral read-only tool endpoint. The route fixes the saved
 * channel; the verified native principal fixes tenant, actor and assistant via
 * a persisted binding. Model arguments contain only a bounded search query.
 * No static test token or cookie/header identity fallback exists here.
 */
export async function handleMachineKnowledgeRequest(
  request: Request,
  savedChannel: "webchat" | "voice",
  options: MachineKnowledgeOptions = {},
): Promise<Response> {
  try {
    if (request.method !== "POST" || request.headers.has("cookie") || request.headers.has("origin") ||
      new URL(request.url).searchParams.size !== 0 || !["webchat", "voice"].includes(savedChannel)) denied(401);
    const token = getCrmMachineBearer(request.headers);
    if (!token) denied(401);
    const claims = await verifyCrmMachineToken(token, options.machineAuth);
    const bounded = { ...options, statementTimeoutMs: assistantKnowledgeLimits.statementTimeoutMs };
    const principal = (await queryAuthenticationRows<MachinePrincipal>(machineAuthenticationSql, machineParams(claims), bounded))[0];
    if (!principal || principal.workspace_id !== claims.workspaceId || principal.identity_id !== claims.identityId) denied(401);
    const body = await readKnowledgeJson(request, ["query", "maxResults"], 8192);
    const query = parseAssistantKnowledgeQuery(body);
    const productRole = principal.data_context === "NOVALURE_INTERNAL" ? "novalure_operator" : "project_sales_member";
    const session: AppSession = {
      authenticated: true, source: "database", userId: principal.actor_user_id,
      workspaceId: principal.workspace_id, workspaceName: "Verified assistant workspace",
      name: "Verified Evelyn service", email: "evelyn-crm-service@service.invalid",
      role: "agent", productRole, permissions: getRolePermissions("agent"),
      productPermissions: getProductRoleCapabilities(productRole),
      serviceIdentity: { identityId: claims.identityId, role: claims.role, consumer: claims.consumer,
        environment: claims.environment, jtiHash: claims.jtiHash },
    };
    const context = await withCrmRead(session, async (tx, member) => {
      const binding = await tx.queryOne<{ bot_id: string; workspace_id: string }>(
        "select * from public.knowledge_lock_assistant_service_binding($1::uuid,$2)", [principal.id, savedChannel]);
      if (!binding || binding.workspace_id !== member.workspaceId) denied();
      const current = await tx.queryOne<MachinePrincipal>(machineAuthenticationSql, machineParams(claims));
      if (!current || crmPayloadDigest(current) !== crmPayloadDigest(principal)) denied();
      return retrieveAssistantKnowledge(member, {
        ...query, assistantId: binding.bot_id, channel: savedChannel === "voice" ? "telephony" : "webchat",
      }, bounded);
    }, bounded);
    return knowledgeJson({ contractVersion: "knowledge-context-v1", ...context });
  } catch (error) {
    if (error instanceof CrmMachineAuthError) return knowledgeJson({ error: "Knowledge access is not granted.", code: "ASSISTANT_ACCESS_DENIED" }, error.status);
    // Keep all underlying tenant, principal and assistant details private.
    if ((error instanceof CrmCommandError || error instanceof KnowledgeCenterError) && [401, 403, 404].includes(error.status)) {
      return knowledgeJson({ error: "Knowledge access is not granted.", code: "ASSISTANT_ACCESS_DENIED" }, error.status === 401 ? 401 : 403);
    }
    if (error && typeof error === "object" && "code" in error && ["57014", "55P03"].includes(String(error.code))) {
      return knowledgeJson({ contractVersion: "knowledge-context-v1", answerStatus: "insufficient_knowledge",
        excerpts: [], fallback: assistantKnowledgeFallback }, 503);
    }
    return knowledgeErrorResponse(error);
  }
}
