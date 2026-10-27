import "server-only";
import { consumeExternalIntegrationRateLimit, createCorrelationId, ExternalIntegrationError, readExternalRequestOrigin, requireExternalIntegrationClientIp, resolveExternalIntegration } from "../db/external-integration-gateway";
import { externalFailure, externalJson, externalOptions } from "../external-api-response";
import { parseAssistantKnowledgeQuery } from "./assistant-http";
import { readKnowledgeJson } from "./http";
import { checkExternalAssistantContext, retrieveExternalAssistantKnowledge, type ExternalAssistantOptions } from "./external-assistant";
import { KnowledgeCenterError } from "./policy";
import { SharedBehaviorError } from "../shared-behavior/catalog";

function siteKey(request: Request) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (key !== "site_key" || params.getAll(key).length !== 1) throw new ExternalIntegrationError("invalid_request", 400);
  const header = request.headers.get("x-novalure-site-key")?.trim() ?? "", query = params.get("site_key")?.trim() ?? "";
  if (header && query && header !== query) throw new ExternalIntegrationError("invalid_request", 400);
  return header || query;
}

/** The existing public knowledge route; the check mode accepts metadata only. */
export async function handleExternalAssistantKnowledgeRequest(request: Request, options: ExternalAssistantOptions = {}) {
  const context = { correlationId: createCorrelationId(), operation: "chat.knowledge", startedAt: Date.now() };
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const publicSiteKey = siteKey(request);
    const resolution = await resolveExternalIntegration({ capability: "chat.context", origin, publicSiteKey });
    if (!resolution) throw new ExternalIntegrationError("integration_not_found", 404);
    const limit = await consumeExternalIntegrationRateLimit({ clientIp: requireExternalIntegrationClientIp(request.headers), operation: "chat.context", resolution });
    if (!limit.allowed) throw new ExternalIntegrationError("rate_limited", 429);
    const check = request.headers.get("x-novalure-knowledge-check"), shared = request.headers.get("x-novalure-shared-behavior");
    if (check !== null && check !== "v1" || shared !== null && shared !== "v1") throw new ExternalIntegrationError("invalid_request", 400);
    const body = await readKnowledgeJson(request, check === "v1" ? ["sessionId", "sourceVersions", "behaviorFingerprint"] : ["query", "maxResults", "sessionId"], 8192);
    if (typeof body.sessionId !== "string") throw new ExternalIntegrationError("session_denied", 403);
    const authority = { origin, publicSiteKey, sessionId: body.sessionId, sessionToken: request.headers.get("x-novalure-session-token")?.trim() ?? "" };
    if (check === "v1") return externalJson(origin, { contractVersion: "knowledge-check-v1", ...await checkExternalAssistantContext({ ...authority,
      sourceVersions: body.sourceVersions, behaviorFingerprint: body.behaviorFingerprint }, options) }, { correlationId: context.correlationId });
    const knowledge = await retrieveExternalAssistantKnowledge({ ...parseAssistantKnowledgeQuery(body), ...authority }, { ...options, includeSharedBehavior: shared === "v1" });
    return externalJson(origin, { contractVersion: "knowledge-context-v1", ...knowledge }, { correlationId: context.correlationId });
  } catch (error) {
    return externalFailure(error instanceof SharedBehaviorError ? new ExternalIntegrationError("invalid_request", 400)
      : error instanceof KnowledgeCenterError ? new ExternalIntegrationError("invalid_knowledge_request", error.status) : error, origin, context);
  }
}

export async function externalAssistantKnowledgeOptions(request: Request) {
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    if (!await resolveExternalIntegration({ capability: "chat.context", origin, publicSiteKey: siteKey(request) })) throw new ExternalIntegrationError("integration_not_found", 404);
    return externalOptions(origin, "POST, OPTIONS");
  } catch (error) { return externalFailure(error, origin); }
}
