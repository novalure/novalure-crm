import {
  consumeExternalIntegrationRateLimit,
  createCorrelationId,
  ExternalIntegrationError,
  getExternalChatContext,
  readExternalRequestOrigin,
  recordExternalIntegrationEvent,
  requireExternalIntegrationClientIp,
  resolveExternalIntegration,
  startExternalChatSession,
} from "@/lib/db/external-integration-gateway";
import {
  externalFailure,
  externalJson,
  externalOptions,
  observeExternalSuccess,
  readBoundedJson,
} from "@/lib/external-api-response";

export async function POST(request: Request) {
  const context = { correlationId: createCorrelationId(), operation: "chat.start", startedAt: Date.now() };
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const body = await readBoundedJson(request, 16_384);
    const publicSiteKey = request.headers.get("x-novalure-site-key")?.trim()
      || text(body.siteKey)
      || "";
    const idempotencyKey = request.headers.get("idempotency-key")?.trim()
      || text(body.idempotencyKey);
    const resolution = await resolveExternalIntegration({ capability: "chat.start", origin, publicSiteKey });
    if (!resolution) throw new ExternalIntegrationError("integration_not_found", 404);
    const clientIp = requireExternalIntegrationClientIp(request.headers);
    const limit = await consumeExternalIntegrationRateLimit({
      clientIp,
      operation: "chat.start",
      resolution,
      subject: idempotencyKey,
    });
    if (!limit.allowed) {
      await recordExternalIntegrationEvent(resolution, {
        capability: "chat.start", correlationId: context.correlationId,
        eventType: "chat.session.start", outcome: "denied",
      });
      throw new ExternalIntegrationError("rate_limited", 429);
    }
    const session = await startExternalChatSession({
      correlationId: context.correlationId,
      idempotencyKey,
      language: text(body.language) || "en",
      origin,
      publicSiteKey,
    });
    observeExternalSuccess({ ...context, status: 201 });
    return externalJson(origin, session, { correlationId: context.correlationId, status: 201 });
  } catch (error) {
    return externalFailure(error, origin, context);
  }
}

export async function GET(request: Request) {
  const context = { correlationId: createCorrelationId(), operation: "chat.context", startedAt: Date.now() };
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const url = new URL(request.url);
    const publicSiteKey = request.headers.get("x-novalure-site-key")?.trim()
      || url.searchParams.get("site_key")?.trim()
      || "";
    const sessionId = url.searchParams.get("session_id")?.trim() || "";
    const resolution = await resolveExternalIntegration({ capability: "chat.start", origin, publicSiteKey });
    if (!resolution) throw new ExternalIntegrationError("integration_not_found", 404);
    const clientIp = requireExternalIntegrationClientIp(request.headers);
    const limit = await consumeExternalIntegrationRateLimit({
      clientIp,
      operation: "chat.context",
      resolution,
      subject: sessionId,
    });
    if (!limit.allowed) {
      await recordExternalIntegrationEvent(resolution, {
        capability: "chat.start", correlationId: context.correlationId,
        eventType: "chat.session.context", outcome: "denied",
      });
      throw new ExternalIntegrationError("rate_limited", 429);
    }
    const chatContext = await getExternalChatContext({
      correlationId: context.correlationId,
      origin,
      publicSiteKey,
      resolution,
      sessionId,
      sessionToken: request.headers.get("x-novalure-session-token")?.trim() || "",
    });
    observeExternalSuccess({ ...context, status: 200 });
    return externalJson(origin, chatContext, { correlationId: context.correlationId });
  } catch (error) {
    return externalFailure(error, origin, context);
  }
}

export async function OPTIONS(request: Request) {
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const url = new URL(request.url);
    const publicSiteKey = url.searchParams.get("site_key")?.trim() || "";
    const integration = await resolveExternalIntegration({
      capability: "chat.start",
      origin,
      publicSiteKey,
    });
    if (!integration) throw new ExternalIntegrationError("integration_not_found", 404);
    return externalOptions(origin, "GET, POST, OPTIONS");
  } catch (error) {
    return externalFailure(error, origin);
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
