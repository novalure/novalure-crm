import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AppSession } from "../auth/session";
import { getRolePermissions } from "../auth/permissions";
import { getProductRoleCapabilities } from "../product-model";
import { getCrmMachineBearer, CrmMachineAuthError } from "../crm-machine-auth";
import { resolveExternalIntegration, type ExternalIntegrationResolution } from "../db/external-integration-gateway";
import { knowledgeJson, readKnowledgeJson } from "../knowledge-center/http";
import { KnowledgeCenterError } from "../knowledge-center/policy";
import { behaviorEnum, SharedBehaviorError } from "./catalog";
import { findNativeAssistantSignalBinding, type NativeAssistantOptions } from "./native-assistant";
import { recordEvelynRuntimeSignal } from "./runtime";
import { studioRuntimeIdentity as fixed, verifyStudioRuntimeToken, type StudioRuntimeAuthOptions } from "./studio-auth";

export type StudioSignalOptions = NativeAssistantOptions & { env?: NodeJS.ProcessEnv; studioAuth?: StudioRuntimeAuthOptions };
class StudioAuthorityChanged extends Error {}
function exactStudioScope(row: ExternalIntegrationResolution | null): row is ExternalIntegrationResolution {
  return !!row && row.integrationId === fixed.integrationId && row.workspaceId === fixed.workspaceId && row.projectId === fixed.crmProjectId &&
    row.configuration.knowledgeAssistantId === fixed.botId && row.widgetConfiguration.chatEnabled === true;
}

/** Existing native signal route, one fixed Studio caller; no context/tool actions. */
export async function handleStudioRuntimeSignal(request: Request, options: StudioSignalOptions = {}) {
  try {
    if (request.method !== "POST" || request.headers.has("origin") || request.headers.has("cookie") || new URL(request.url).searchParams.size) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    const token = getCrmMachineBearer(request.headers);
    if (!token) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    await verifyStudioRuntimeToken(token, options.studioAuth ?? { env: options.env });
    const env = options.nativeBehaviorEnv ?? options.env ?? process.env;
    if (env.VERCEL_ENV !== "production" || env.NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED !== "1") return knowledgeJson({ code: "RUNTIME_DISABLED" }, 503);
    const body = await readKnowledgeJson(request, ["eventId", "issue", "outcome"], 1024);
    if (typeof body.eventId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.eventId) || body.issue !== "unclear_next_step") return knowledgeJson({ code: "INVALID_SIGNAL" }, 400);
    const outcome = behaviorEnum(body.outcome, ["pass", "fail"] as const);
    const resolution = await resolveExternalIntegration({ capability: "chat.context", origin: fixed.publicOrigin, publicSiteKey: fixed.publicSiteKey });
    if (!exactStudioScope(resolution)) throw new StudioAuthorityChanged();
    const binding = findNativeAssistantSignalBinding({ workspaceId: fixed.workspaceId, projectId: fixed.crmProjectId, botId: fixed.botId,
      integrationId: fixed.integrationId, brokerActorId: resolution.publicActorId }, { ...options, nativeBehaviorEnv: env });
    const capability = request.headers.get("x-evelyn-runtime-token");
    if (!binding || typeof capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
      !timingSafeEqual(createHash("sha256").update(capability).digest(), createHash("sha256").update(binding.capability).digest())) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
    const broker: AppSession = { authenticated: true, source: "database", workspaceId: fixed.workspaceId, userId: resolution.publicActorId,
      workspaceName: "Verified Studio scope", name: "Verified Studio broker", email: "studio-broker@service.invalid", role: "owner", productRole: "customer_owner",
      permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner") };
    const receipt = await recordEvelynRuntimeSignal(broker, capability, { eventId: body.eventId, issue: "unclear_next_step", outcome }, { ...options,
      statementTimeoutMs: 2000, verifyWorkload: async tx => {
        const current = await tx.queryOne<ExternalIntegrationResolution>(`select integration_id as "integrationId",workspace_id as "workspaceId",project_id as "projectId",
          public_actor_id as "publicActorId",configuration,widget_configuration as "widgetConfiguration"
          from public.crm_external_integration_resolve($1,$2,'chat.context',null::uuid)`, [fixed.publicSiteKey, fixed.publicOrigin]);
        if (!exactStudioScope(current) || current.publicActorId !== binding.brokerActorId) throw new StudioAuthorityChanged();
        const actual = await tx.queryOne<{ actor_id: string; bot_id: string; workspace_id: string }>("select * from public.behavior_lock_runtime($1::uuid,$2)",
          [binding.brokerActorId, createHash("sha256").update(capability).digest("hex")]);
        if (!actual || actual.actor_id !== binding.actorId || actual.bot_id !== fixed.botId || actual.workspace_id !== fixed.workspaceId) throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
        const bot = await tx.queryOne<{ projectId: string | null }>('select project_id as "projectId" from bots where id=$1::uuid and workspace_id=$2::uuid', [fixed.botId, fixed.workspaceId]);
        if (!bot || bot.projectId !== fixed.crmProjectId) throw new StudioAuthorityChanged();
      } });
    return knowledgeJson({ recorded: receipt.recorded === true, replayed: receipt.replayed });
  } catch (error) {
    if (error instanceof StudioAuthorityChanged) return knowledgeJson({ code: "STUDIO_AUTHORITY_CHANGED", authorityCurrent: false }, 409);
    if (error instanceof CrmMachineAuthError) return knowledgeJson({ code: "RUNTIME_AUTH_DENIED" }, error.status);
    if (error instanceof SharedBehaviorError && error.code === "LEARNING_IDEMPOTENCY_CONFLICT") return knowledgeJson({ code: "SIGNAL_CONFLICT" }, 409);
    if (error instanceof KnowledgeCenterError && error.code === "RUNTIME_ACCESS_DENIED") return knowledgeJson({ code: "RUNTIME_AUTH_DENIED" }, 403);
    if (error instanceof SharedBehaviorError && error.code === "NATIVE_ASSISTANT_BINDING_DENIED") return knowledgeJson({ code: "SIGNAL_UNCONFIRMED" }, 503);
    if (error instanceof SharedBehaviorError || error instanceof KnowledgeCenterError && error.status < 500) return knowledgeJson({ code: "INVALID_SIGNAL" }, 400);
    // A transport/commit error can follow a successful insert. Never claim absence.
    return knowledgeJson({ code: "SIGNAL_UNCONFIRMED" }, 503);
  }
}
