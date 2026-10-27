import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { getCrmMachineBearer, CrmMachineAuthError } from "../crm-machine-auth";
import { resolveExternalIntegration, type ExternalIntegrationResolution } from "../db/external-integration-gateway";
import { knowledgeJson, readKnowledgeJson } from "../knowledge-center/http";
import { KnowledgeCenterError } from "../knowledge-center/policy";
import { behaviorEnum, SharedBehaviorError } from "./catalog";
import { findNativeAssistantSignalBinding, type NativeAssistantOptions } from "./native-assistant";
import { recordBoundAssistantFormatSignal } from "./bound-private-signal";
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
    const receipt = await recordBoundAssistantFormatSignal(binding, { kind: "website", origin: fixed.publicOrigin, publicSiteKey: fixed.publicSiteKey },
      { eventId: body.eventId, issue: "unclear_next_step", outcome }, options);
    return knowledgeJson({ recorded: receipt.recorded === true, replayed: receipt.replayed });
  } catch (error) {
    if (error instanceof StudioAuthorityChanged) return knowledgeJson({ code: "STUDIO_AUTHORITY_CHANGED", authorityCurrent: false }, 409);
    if (error instanceof SharedBehaviorError && error.code === "NATIVE_INTEGRATION_DENIED") return knowledgeJson({ code: "STUDIO_AUTHORITY_CHANGED", authorityCurrent: false }, 409);
    if (error instanceof SharedBehaviorError && error.code === "NATIVE_SIGNAL_ACCESS_DENIED") return knowledgeJson({ code: "RUNTIME_AUTH_DENIED" }, 403);
    if (error instanceof SharedBehaviorError && error.code === "NATIVE_SIGNAL_BUSY") return knowledgeJson({ code: "SIGNAL_UNCONFIRMED" }, 503);
    if (error instanceof CrmMachineAuthError) return knowledgeJson({ code: "RUNTIME_AUTH_DENIED" }, error.status);
    if (error instanceof SharedBehaviorError && error.code === "LEARNING_IDEMPOTENCY_CONFLICT") return knowledgeJson({ code: "SIGNAL_CONFLICT" }, 409);
    if (error instanceof KnowledgeCenterError && error.code === "RUNTIME_ACCESS_DENIED") return knowledgeJson({ code: "RUNTIME_AUTH_DENIED" }, 403);
    if (error instanceof SharedBehaviorError && error.code === "NATIVE_ASSISTANT_BINDING_DENIED") return knowledgeJson({ code: "SIGNAL_UNCONFIRMED" }, 503);
    if (error instanceof SharedBehaviorError || error instanceof KnowledgeCenterError && error.status < 500) return knowledgeJson({ code: "INVALID_SIGNAL" }, 400);
    // A transport/commit error can follow a successful insert. Never claim absence.
    return knowledgeJson({ code: "SIGNAL_UNCONFIRMED" }, 503);
  }
}
