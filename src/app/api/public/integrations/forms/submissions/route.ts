import { createHash, randomUUID } from "node:crypto";
import {
  readExternalRequestOrigin,
  createCorrelationId,
  recordExternalIntegrationEvent,
  requireExternalIntegrationClientIp,
  resolveExternalIntegration,
  ExternalIntegrationError,
  type ExternalIntegrationResolution,
} from "@/lib/db/external-integration-gateway";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import {
  getPublicWebsiteForm,
  persistWebsiteFormSubmission,
} from "@/lib/db/form-repositories";
import {
  PublicSubmissionTransactionError,
  withPublicSubmissionTransaction,
} from "@/lib/db/client";
import {
  claimPublicSubmissionIdempotency,
  completePublicSubmissionIdempotency,
  consumePublicSubmissionRateLimits,
} from "@/lib/db/public-submission-abuse-repository";
import {
  createPublicSubmissionIdempotencyHashes,
  createPublicSubmissionRateLimitPolicies,
  normalizePublicSubmissionIdentifier,
  publicSubmissionActions,
  type PublicSubmissionResponseSnapshot,
} from "@/lib/security/public-submission-abuse";
import {
  externalFailure,
  externalJson,
  externalOptions,
  observeExternalSuccess,
  readBoundedJsonObject,
} from "@/lib/external-api-response";
import type { WebsiteForm } from "@/lib/form-types";
import { prepareFormBookingFields, attachFormBookingFields } from "@/lib/booking/form-field";

const idempotencyPattern = /^[A-Za-z0-9_-]{32,128}$/u;

export async function POST(request: Request) {
  const context = { correlationId: createCorrelationId(), operation: "form.submit", startedAt: Date.now() };
  let origin = "null";
  let auditResolution: ExternalIntegrationResolution | null = null;
  try {
    origin = readExternalRequestOrigin(request);
    const body = await readBoundedJsonObject(request);
    const publicSiteKey = request.headers.get("x-novalure-site-key")?.trim()
      || stringValue(body.siteKey)
      || "";
    const formId = stringValue(body.formId) || null;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (!idempotencyPattern.test(idempotencyKey)) {
      throw new ExternalIntegrationError("idempotency_key_required", 400);
    }
    const resolution = await resolveExternalIntegration({
      capability: "form.submit",
      formId,
      origin,
      publicSiteKey,
    });
    if (!resolution?.formId) throw new ExternalIntegrationError("form_not_found", 404);
    auditResolution = resolution;
    const lookup = await withTenantTransaction(
      { actorId: resolution.publicActorId, workspaceId: resolution.workspaceId },
      (transaction) => getPublicWebsiteForm(
        { formId: resolution.formId! },
        { transaction },
      ),
    );
    if (!lookup) throw new ExternalIntegrationError("form_not_found", 404);
    if (lookup.form.crmTarget === "lead" || lookup.form.crmTarget === "deal") {
      const leadCapability = await resolveExternalIntegration({
        capability: "lead.create",
        formId: resolution.formId,
        origin,
        publicSiteKey,
      });
      if (!leadCapability) throw new ExternalIntegrationError("capability_denied", 403);
    }
    const fields = readFields(body.fields, lookup.form);
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) value.forEach((item) => formData.append(key, item));
      else formData.set(key, value);
    }
    const scope = `integration:${resolution.integrationId}:form:${resolution.formId}`;
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify({ fields, formId: resolution.formId }))
      .digest("hex");
    const hashes = createPublicSubmissionIdempotencyHashes({
      action: publicSubmissionActions.form,
      idempotencyKey,
      requestFingerprint,
      scope,
    });
    const clientIp = requireExternalIntegrationClientIp(request.headers);
    const identifier = publicIdentifier(lookup.form, fields, idempotencyKey);
    const result = await withPublicSubmissionTransaction(
      { actorId: resolution.publicActorId, workspaceId: resolution.workspaceId },
      async () => {
        const lockedResolution = await resolveExternalIntegration({
          capability: "form.submit",
          formId: resolution.formId,
          origin,
          publicSiteKey,
        });
        if (!lockedResolution || lockedResolution.integrationId !== resolution.integrationId) {
          throw new ExternalIntegrationError("integration_not_found", 404);
        }
        const claim = await claimPublicSubmissionIdempotency(hashes);
        if (claim.state === "replay") return { duplicate: true, snapshot: claim.response };
        if (claim.state === "processing" || claim.state === "conflict") {
          return {
            duplicate: false,
            snapshot: jsonSnapshot(
              claim.state === "processing" ? "submission_in_progress" : "submission_replay_conflict",
              409,
            ),
          };
        }
        const limit = await consumePublicSubmissionRateLimits({
          policies: createPublicSubmissionRateLimitPolicies({
            action: publicSubmissionActions.form,
            clientIp,
            identifier,
            scope,
          }),
        });
        if (!limit.allowed) return {
          duplicate: false,
          snapshot: await complete(hashes, jsonSnapshot("rate_limited", 429)),
        };
        const bookingProofs = prepareFormBookingFields(lookup.form, formData);
        const persistence = await persistWebsiteFormSubmission({
          actorUserId: resolution.publicActorId,
          formData,
          formKey: resolution.formId!,
          requestUrl: request.url,
        });
        if (!persistence.persisted) {
          return {
            duplicate: false,
            snapshot: await complete(hashes, jsonSnapshot(normalizePersistenceReason(persistence.reason), 422)),
          };
        }
        await attachFormBookingFields(bookingProofs, { workspaceId: resolution.workspaceId, formId: resolution.formId!, ids: persistence.ids });
        const durableAcceptedReceipt: PublicSubmissionResponseSnapshot = {
          body: { accepted: true, reference: randomUUID() },
          kind: "json",
          status: 202,
        };
        // The domain write and completed idempotency receipt share this same
        // transaction. withPublicSubmissionTransaction returns only after COMMIT.
        return { duplicate: false, snapshot: await complete(hashes, durableAcceptedReceipt) };
      },
    );
    const { duplicate, snapshot } = result;
    if (snapshot.kind !== "json") throw new ExternalIntegrationError("temporarily_unavailable", 503);
    await recordExternalIntegrationEvent(resolution, {
      capability: "form.submit",
      correlationId: context.correlationId,
      eventType: "form.submit",
      outcome: duplicate ? "duplicate" : snapshot.status >= 400 ? "denied" : "accepted",
    });
    observeExternalSuccess({ ...context, outcome: duplicate ? "duplicate" : "accepted", status: snapshot.status });
    return externalJson(origin, snapshot.body, {
      correlationId: context.correlationId,
      status: snapshot.status,
    });
  } catch (error) {
    if (auditResolution) {
      await recordExternalIntegrationEvent(auditResolution, {
        capability: "form.submit",
        correlationId: context.correlationId,
        eventType: "form.submit",
        outcome: error instanceof ExternalIntegrationError && error.status < 500 ? "denied" : "failed",
      }).catch(() => undefined);
    }
    if (error instanceof PublicSubmissionTransactionError && !error.rollbackConfirmed) {
      // The request key remains stable; a caller retry reconciles the durable receipt.
      return externalFailure(error, origin, context);
    }
    return externalFailure(error, origin, context);
  }
}

export async function OPTIONS(request: Request) {
  let origin = "null";
  try {
    origin = readExternalRequestOrigin(request);
    const url = new URL(request.url);
    const publicSiteKey = url.searchParams.get("site_key")?.trim() || "";
    const resolution = await resolveExternalIntegration({ capability: "form.submit", origin, publicSiteKey });
    if (!resolution) throw new ExternalIntegrationError("integration_not_found", 404);
    return externalOptions(origin, "POST, OPTIONS");
  } catch (error) {
    return externalFailure(error, origin);
  }
}

async function complete(
  hashes: ReturnType<typeof createPublicSubmissionIdempotencyHashes>,
  response: PublicSubmissionResponseSnapshot,
) {
  await completePublicSubmissionIdempotency({
    idempotencyHash: hashes.idempotencyHash,
    requestHash: hashes.requestHash,
    response,
  });
  return response;
}

function jsonSnapshot(error: string, status: number): PublicSubmissionResponseSnapshot {
  return { body: { error }, kind: "json", status };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readFields(value: unknown, form: WebsiteForm) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalIntegrationError("invalid_fields", 400);
  }
  const permitted = new Map(form.fields.map((field) => [field.crmField || field.id, field]));
  for (const field of form.fields.filter(field => field.type === "booking")) {
    permitted.set(`booking_${field.id}_id`, field);
    permitted.set(`booking_${field.id}_token`, field);
  }
  const result: Record<string, string | string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const field = permitted.get(key);
    if (!field) throw new ExternalIntegrationError("unknown_submission_field", 400);
    const max = field.type === "textarea" ? 8_192 : field.type === "url" || field.type === "hidden" ? 2_048 : 1_024;
    if (Array.isArray(raw)) {
      if (!field.multiple && field.type !== "multiCheckbox") throw new ExternalIntegrationError("too_many_field_values", 400);
      const values = raw.map(stringValue);
      if (values.length > 20 || values.some((item) => !item || item.length > max)) {
        throw new ExternalIntegrationError("invalid_submission_field", 400);
      }
      result[key] = values;
    } else {
      const item = stringValue(raw);
      if (item.length > max) throw new ExternalIntegrationError("submission_field_too_long", 413);
      result[key] = item;
    }
  }
  for (const field of form.fields) {
    if (field.type === "booking") {
      if ((field.bookingRequired ?? field.required) && (!result[`booking_${field.id}_id`] || !result[`booking_${field.id}_token`])) throw new ExternalIntegrationError("booking_confirmation_required", 422);
      continue;
    }
    const key = field.crmField || field.id;
    if (field.required && (!Object.hasOwn(result, key) || !result[key]?.length)) {
      throw new ExternalIntegrationError(`required_field_missing:${key}`, 422);
    }
  }
  return result;
}

function publicIdentifier(form: WebsiteForm, fields: Record<string, string | string[]>, fallback: string) {
  const email = form.fields.find((field) => field.type === "email");
  const phone = form.fields.find((field) => field.type === "phone");
  const scalar = (key: string) => {
    const value = fields[key];
    return Array.isArray(value) ? value[0] || "" : value || "";
  };
  if (email) {
    const value = scalar(email.crmField || email.id);
    if (value) return normalizePublicSubmissionIdentifier(value, "email");
  }
  if (phone) {
    const value = scalar(phone.crmField || phone.id);
    if (value) return normalizePublicSubmissionIdentifier(value, "phone");
  }
  return normalizePublicSubmissionIdentifier(fallback, "opaque");
}

function normalizePersistenceReason(reason?: string) {
  if (reason === "privacy_consent_required" || reason?.startsWith("required_field_missing")) return reason;
  if (reason === "invalid_email") return reason;
  return "submission_rejected";
}
