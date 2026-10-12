import {
  appendExternalChatMessage,
  consumeExternalIntegrationRateLimit,
  createCorrelationId,
  ExternalIntegrationError,
  readExternalRequestOrigin,
  recordExternalIntegrationEvent,
  resolveExternalIntegration,
} from "@/lib/db/external-integration-gateway";
import {
  externalFailure,
  externalJson,
  externalOptions,
  observeExternalSuccess,
  readBoundedJson,
} from "@/lib/external-api-response";
import { getTrustedPublicSubmissionClientIp } from "@/lib/security/public-submission-abuse";

export async function POST(request: Request) {
  const context = { correlationId: createCorrelationId(), operation: "chat.message", startedAt: Date.now() };
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const body = await readBoundedJson(request, 16_384);
    const publicSiteKey = request.headers.get("x-novalure-site-key")?.trim()
      || text(body.siteKey);
    const sessionId = text(body.sessionId);
    const resolution = await resolveExternalIntegration({ capability: "chat.message", origin, publicSiteKey });
    if (!resolution) throw new ExternalIntegrationError("integration_not_found", 404);
    const clientIp = getTrustedPublicSubmissionClientIp(request.headers);
    if (!clientIp) throw new Error("Trusted client IP is unavailable");
    const limit = await consumeExternalIntegrationRateLimit({
      clientIp,
      operation: "chat.message",
      resolution,
      subject: sessionId,
    });
    if (!limit.allowed) {
      await recordExternalIntegrationEvent(resolution, {
        capability: "chat.message", correlationId: context.correlationId,
        eventType: "chat.message.append", outcome: "denied",
      });
      throw new ExternalIntegrationError("rate_limited", 429);
    }
    const result = await appendExternalChatMessage({
      correlationId: context.correlationId,
      content: text(body.message),
      idempotencyKey: request.headers.get("idempotency-key")?.trim()
        || text(body.idempotencyKey),
      origin,
      publicSiteKey,
      sessionId,
      sessionToken: request.headers.get("x-novalure-session-token")?.trim()
        || text(body.sessionToken),
    });
    observeExternalSuccess({ ...context, status: 202 });
    return externalJson(origin, result, { correlationId: context.correlationId, status: 202 });
  } catch (error) {
    return externalFailure(error, origin, context);
  }
}

export async function OPTIONS(request: Request) {
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const url = new URL(request.url);
    const integration = await resolveExternalIntegration({
      capability: "chat.message",
      origin,
      publicSiteKey: url.searchParams.get("site_key")?.trim() || "",
    });
    if (!integration) throw new ExternalIntegrationError("integration_not_found", 404);
    return externalOptions(origin, "POST, OPTIONS");
  } catch (error) {
    return externalFailure(error, origin);
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
