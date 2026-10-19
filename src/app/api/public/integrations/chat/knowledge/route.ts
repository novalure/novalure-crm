import { consumeExternalIntegrationRateLimit, createCorrelationId, ExternalIntegrationError, readExternalRequestOrigin, requireExternalIntegrationClientIp, resolveExternalIntegration } from "@/lib/db/external-integration-gateway";
import { externalFailure, externalJson, externalOptions } from "@/lib/external-api-response";
import { parseAssistantKnowledgeQuery } from "@/lib/knowledge-center/assistant-http";
import { readKnowledgeJson } from "@/lib/knowledge-center/http";
import { retrieveExternalAssistantKnowledge } from "@/lib/knowledge-center/external-assistant";
import { KnowledgeCenterError } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";

function publicKnowledgeSiteKey(request: Request) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (key !== "site_key" || params.getAll(key).length !== 1) throw new ExternalIntegrationError("invalid_request", 400);
  }
  const headerKey = request.headers.get("x-novalure-site-key")?.trim() ?? "";
  const queryKey = params.get("site_key")?.trim() ?? "";
  if (headerKey && queryKey && headerKey !== queryKey) throw new ExternalIntegrationError("invalid_request", 400);
  return headerKey || queryKey;
}

export async function POST(request: Request) {
  const context = { correlationId: createCorrelationId(), operation: "chat.knowledge", startedAt: Date.now() };
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    // Browsers preflight the same URL without the custom header values. The
    // public site key must therefore also be usable in this exact URL.
    const publicSiteKey = publicKnowledgeSiteKey(request);
    const resolution = await resolveExternalIntegration({ capability: "chat.context", origin, publicSiteKey });
    if (!resolution) throw new ExternalIntegrationError("integration_not_found", 404);
    const limit = await consumeExternalIntegrationRateLimit({
      clientIp: requireExternalIntegrationClientIp(request.headers), operation: "chat.context", resolution,
    });
    if (!limit.allowed) throw new ExternalIntegrationError("rate_limited", 429);
    const body = await readKnowledgeJson(request, ["query", "maxResults", "sessionId"], 8192);
    if (typeof body.sessionId !== "string") throw new ExternalIntegrationError("session_denied", 403);
    const knowledge = await retrieveExternalAssistantKnowledge({
      ...parseAssistantKnowledgeQuery(body), origin, publicSiteKey, sessionId: body.sessionId,
      sessionToken: request.headers.get("x-novalure-session-token")?.trim() ?? "",
    });
    return externalJson(origin, { contractVersion: "knowledge-context-v1", ...knowledge }, { correlationId: context.correlationId });
  } catch (error) {
    return externalFailure(error instanceof KnowledgeCenterError
      ? new ExternalIntegrationError("invalid_knowledge_request", error.status) : error, origin, context);
  }
}

export async function OPTIONS(request: Request) {
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const publicSiteKey = publicKnowledgeSiteKey(request);
    if (!await resolveExternalIntegration({ capability: "chat.context", origin, publicSiteKey })) throw new ExternalIntegrationError("integration_not_found", 404);
    return externalOptions(origin, "POST, OPTIONS");
  } catch (error) { return externalFailure(error, origin); }
}
