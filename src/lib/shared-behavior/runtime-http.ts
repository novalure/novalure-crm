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
import { selectsPersonalRuntimeVerifier, verifyPersonalRuntimeToken, type PersonalRuntimeAuthOptions } from "./personal-auth";
import { selectsStudioRuntimeVerifier, type StudioRuntimeAuthOptions } from "./studio-auth";
import { handleStudioRuntimeSignal } from "./studio-runtime-http";
import type { NativeAssistantOptions } from "./native-assistant";
type Principal = { id: string; workspace_id: string; actor_user_id: string; identity_id: string };
export type RuntimeHttpOptions = TenantTransactionOptions & NativeAssistantOptions & { machineAuth?: CrmMachineAuthOptions; personalAuth?: PersonalRuntimeAuthOptions; studioAuth?: StudioRuntimeAuthOptions; env?: NodeJS.ProcessEnv };
const machineAuthSql = "select * from public.crm_authenticate_machine($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9)";
export async function handleEvelynRuntimeRequest(request: Request, action: "context" | "signal", options: RuntimeHttpOptions = {}) {
  try {
    const studioToken = getCrmMachineBearer(request.headers);
    if (action === "signal" && studioToken && selectsStudioRuntimeVerifier(studioToken)) return handleStudioRuntimeSignal(request, options);
    if ((options.env ?? process.env).EVELYN_SHARED_RUNTIME_ENABLED !== "1") return knowledgeJson({ code: "RUNTIME_DISABLED" }, 503);
    if (request.method !== "POST" || request.headers.has("cookie") || request.headers.has("origin") || new URL(request.url).searchParams.size) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    const token = getCrmMachineBearer(request.headers);
    if (!token) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    const personal = selectsPersonalRuntimeVerifier(token);
    const claims = personal ? await verifyPersonalRuntimeToken(token, options.personalAuth) : await verifyCrmMachineToken(token, options.machineAuth);
    const authSql = personal ? "select * from public.behavior_authenticate_personal_workload()" : machineAuthSql;
    const params = personal ? [] : [claims.identityId,claims.subject,claims.issuer,claims.audience,claims.projectId,claims.ownerId,claims.workspaceId,claims.environment,claims.role];
    const principal = (await queryAuthenticationRows<Principal>(authSql, params, options))[0];
    if (!principal || principal.workspace_id !== claims.workspaceId || principal.identity_id !== claims.identityId) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    const body = await readKnowledgeJson(request, action === "context" ? ["query"] : ["eventId","issue","outcome"], 8192);
    const broker: AppSession = { authenticated: true, source: "database", workspaceId: principal.workspace_id, userId: principal.actor_user_id,
      workspaceName: "Verified workload", name: "Verified workload", email: "workload@service.invalid", role: "agent", productRole: "novalure_operator",
      permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_operator") };
    const guarded = { ...options, verifyWorkload: async (tx: import("../crm-command").TenantTransaction) => {
      const lockSql = personal ? "select public.behavior_lock_personal_workload($1::uuid,$2::uuid) as allowed" : "select public.behavior_lock_workload($1::uuid,$2::uuid) as allowed";
      const locked = await tx.queryOne<{ allowed: boolean }>(lockSql, [principal.id, principal.actor_user_id]);
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
