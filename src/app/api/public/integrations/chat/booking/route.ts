import { createCorrelationId, consumeExternalIntegrationRateLimit, ExternalIntegrationError,
  readExternalRequestOrigin, requireExternalIntegrationClientIp, resolveExternalIntegration } from "@/lib/db/external-integration-gateway";
import { externalFailure, externalJson, externalOptions, readBoundedJsonObject } from "@/lib/external-api-response";
import { dispatchTrustedBookingTool } from "@/lib/booking/channel-http";
import { verifyExternalChatBookingAuthority } from "@/lib/booking/channel-bindings";
import { BookingError } from "@/lib/booking/types";

export const runtime = "nodejs";
export const maxDuration = 60;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export async function POST(request: Request) {
  const context = { correlationId: createCorrelationId(), operation: "chat.booking", startedAt: Date.now() };
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const body = await readBoundedJsonObject(request, 16_384);
    const publicSiteKey = text(request.headers.get("x-novalure-site-key")) || text(body.siteKey);
    const sessionId = text(body.sessionId);
    const sessionToken = text(request.headers.get("x-novalure-session-token")) || text(body.sessionToken);
    const resolution = await resolveExternalIntegration({ capability: "appointment.request", publicSiteKey, origin });
    if (!resolution || resolution.integrationMode !== "real_customer") throw new ExternalIntegrationError("integration_not_found", 404);
    const limit = await consumeExternalIntegrationRateLimit({ clientIp: requireExternalIntegrationClientIp(request.headers),
      operation: "chat.context", resolution, subject: sessionId });
    if (!limit.allowed) throw new ExternalIntegrationError("rate_limited", 429);
    const authority = await verifyExternalChatBookingAuthority({ publicSiteKey, origin, sessionId, sessionToken, correlationId: context.correlationId });
    const payload = { ...body };
    delete payload.siteKey; delete payload.sessionId; delete payload.sessionToken;
    const result = await dispatchTrustedBookingTool(request, "chat", authority, payload);
    return externalJson(origin, result, { correlationId: context.correlationId });
  } catch (error) {
    return externalFailure(error instanceof BookingError ? new ExternalIntegrationError(error.code, error.status) : error, origin, context);
  }
}

export async function OPTIONS(request: Request) {
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const resolution = await resolveExternalIntegration({ capability: "appointment.request", origin,
      publicSiteKey: new URL(request.url).searchParams.get("site_key") ?? "" });
    if (!resolution || resolution.integrationMode !== "real_customer") throw new ExternalIntegrationError("integration_not_found", 404);
    return externalOptions(origin, "POST, OPTIONS");
  } catch (error) { return externalFailure(error, origin); }
}
