import {
  consumeExternalIntegrationRateLimit,
  createCorrelationId,
  ExternalIntegrationError,
  readExternalRequestOrigin,
  recordExternalIntegrationEvent,
  resolveExternalIntegration,
} from "@/lib/db/external-integration-gateway";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import {
  getPublicWebsiteForm,
  publicWebsiteFormView,
} from "@/lib/db/form-repositories";
import { externalFailure, externalJson, externalOptions, observeExternalSuccess } from "@/lib/external-api-response";
import { getTrustedPublicSubmissionClientIp } from "@/lib/security/public-submission-abuse";

export async function GET(request: Request) {
  const context = { correlationId: createCorrelationId(), operation: "form.read", startedAt: Date.now() };
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const url = new URL(request.url);
    const publicSiteKey = request.headers.get("x-novalure-site-key")?.trim()
      || url.searchParams.get("site_key")?.trim()
      || "";
    const requestedFormId = url.searchParams.get("form_id")?.trim() || null;
    const resolution = await resolveExternalIntegration({
      capability: "form.read",
      formId: requestedFormId,
      origin,
      publicSiteKey,
    });
    if (!resolution?.formId) throw new ExternalIntegrationError("form_not_found", 404);
    const clientIp = getTrustedPublicSubmissionClientIp(request.headers);
    if (!clientIp) throw new Error("Trusted client IP is unavailable");
    const limit = await consumeExternalIntegrationRateLimit({ clientIp, operation: "form.read", resolution });
    if (!limit.allowed) {
      await recordExternalIntegrationEvent(resolution, {
        capability: "form.read", correlationId: context.correlationId,
        eventType: "form.read", outcome: "denied",
      });
      throw new ExternalIntegrationError("rate_limited", 429);
    }
    const lookup = await withTenantTransaction(
      { actorId: resolution.publicActorId, workspaceId: resolution.workspaceId },
      (transaction) => getPublicWebsiteForm(
        { formId: resolution.formId! },
        { transaction },
      ),
    );
    if (!lookup) throw new ExternalIntegrationError("form_not_found", 404);
    await recordExternalIntegrationEvent(resolution, {
      capability: "form.read", correlationId: context.correlationId,
      eventType: "form.read", outcome: "accepted",
    });
    observeExternalSuccess({ ...context, status: 200 });
    return externalJson(origin, {
      form: publicWebsiteFormView(lookup.form),
      widget: resolution.widgetConfiguration,
    }, { correlationId: context.correlationId });
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
    const resolution = await resolveExternalIntegration({
      capability: "form.read",
      origin,
      publicSiteKey,
    });
    if (!resolution) return externalJson(origin, { error: "integration_not_found" }, { status: 404 });
    return externalOptions(origin, "GET, OPTIONS");
  } catch (error) {
    return externalFailure(error, origin);
  }
}
