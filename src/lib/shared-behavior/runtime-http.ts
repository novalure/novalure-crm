import "server-only";
import type { AppSession } from "../auth/session";
import { getRolePermissions } from "../auth/permissions";
import { getProductRoleCapabilities } from "../product-model";
import { crmPayloadDigest } from "../crm-command";
import { queryAuthenticationRows, type TenantTransactionOptions } from "../db/tenant-client";
import { verifyCrmMachineToken, getCrmMachineBearer, type CrmMachineAuthOptions, CrmMachineAuthError } from "../crm-machine-auth";
import { knowledgeErrorResponse, knowledgeJson, readKnowledgeJson } from "../knowledge-center/http";
import { KnowledgeCenterError } from "../knowledge-center/policy";
import { loadEvelynRuntimeContext, recordEvelynRuntimeSignal } from "./runtime";
type Principal = { id: string; workspace_id: string; actor_user_id: string; identity_id: string };
export type RuntimeHttpOptions = TenantTransactionOptions & { machineAuth?: CrmMachineAuthOptions; env?: NodeJS.ProcessEnv };
const authSql = "select * from public.crm_authenticate_machine($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9)";
export async function handleEvelynRuntimeRequest(request: Request, action: "context" | "signal", options: RuntimeHttpOptions = {}) {
  try {
    if ((options.env ?? process.env).EVELYN_SHARED_RUNTIME_ENABLED !== "1") return knowledgeJson({ code: "RUNTIME_DISABLED" }, 503);
    if (request.method !== "POST" || request.headers.has("cookie") || request.headers.has("origin") || new URL(request.url).searchParams.size) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    const token = getCrmMachineBearer(request.headers);
    if (!token) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    const claims = await verifyCrmMachineToken(token, options.machineAuth);
    const params = [claims.identityId,claims.subject,claims.issuer,claims.audience,claims.projectId,claims.ownerId,claims.workspaceId,claims.environment,claims.role];
    const principal = (await queryAuthenticationRows<Principal>(authSql, params, options))[0];
    if (!principal || principal.workspace_id !== claims.workspaceId || principal.identity_id !== claims.identityId) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    const body = await readKnowledgeJson(request, action === "context" ? ["query"] : ["eventId","issue","outcome"], 8192);
    const broker: AppSession = { authenticated: true, source: "database", workspaceId: principal.workspace_id, userId: principal.actor_user_id,
      workspaceName: "Verified workload", name: "Verified workload", email: "workload@service.invalid", role: "agent", productRole: "novalure_operator",
      permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_operator") };
    const guarded = { ...options, verifyWorkload: async (tx: import("../crm-command").TenantTransaction) => {
      const locked = await tx.queryOne<{ allowed: boolean }>("select public.behavior_lock_workload($1::uuid,$2::uuid) as allowed", [principal.id, principal.actor_user_id]);
      const current = await tx.queryOne<Principal>(authSql, params);
      if (!locked?.allowed || !current || crmPayloadDigest(current) !== crmPayloadDigest(principal))
        throw new KnowledgeCenterError("RUNTIME_ACCESS_DENIED", "Runtime access is not granted.", 403);
    } };
    const capability = request.headers.get("x-evelyn-runtime-token");
    return knowledgeJson(action === "context"
      ? await loadEvelynRuntimeContext(broker, capability, body, guarded)
      : await recordEvelynRuntimeSignal(broker, capability, body, guarded));
  } catch (error) {
    if (error instanceof CrmMachineAuthError) return knowledgeJson({ code: "RUNTIME_AUTH_DENIED" }, error.status);
    return knowledgeErrorResponse(error);
  }
}
