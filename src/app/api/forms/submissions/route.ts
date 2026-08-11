import { NextResponse } from "next/server";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import {
  getPublicWebsiteFormByKey,
  persistWebsiteFormSubmission,
} from "@/lib/db/form-repositories";
import {
  claimPublicSubmissionIdempotency,
  completePublicSubmissionIdempotency,
  consumePublicSubmissionRateLimits,
} from "@/lib/db/public-submission-abuse-repository";
import type { WebsiteForm } from "@/lib/form-types";
import { publicSubmissionControlFields } from "@/lib/public-submission-contract";
import {
  buildPublicSubmissionScope,
  createPublicSubmissionIdempotencyHashes,
  createPublicSubmissionRateLimitPolicies,
  formSubmissionBodyLimits,
  getPublicSubmissionProof,
  getTrustedPublicSubmissionClientIp,
  hasPublicSubmissionHoneypotValue,
  normalizePublicSubmissionIdentifier,
  publicSubmissionActions,
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionFormData,
  stripPublicSubmissionControlFields,
  validatePublicSubmissionFieldRules,
  validatePublicSubmissionFilesForFields,
  verifyPublicSubmissionProof,
  type PublicSubmissionResponseSnapshot,
} from "@/lib/security/public-submission-abuse";
import { resolveSafeFormRedirect } from "@/lib/security/redirects";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  let parsed: Awaited<ReturnType<typeof readBoundedPublicSubmissionFormData>>;
  try {
    parsed = await readBoundedPublicSubmissionFormData(request, formSubmissionBodyLimits);
  } catch (error) {
    const reason = error instanceof PublicSubmissionRequestError
      ? error.code
      : "temporarily_unavailable";
    const status = error instanceof PublicSubmissionRequestError ? error.status : 503;
    return responseFromSnapshot(
      createPublicFormFailureSnapshot({
        formSlug: "formular",
        reason,
        request,
        source: "website",
        status,
      }),
    );
  }

  const formData = parsed.formData;
  const returnTo = getString(formData, "return_to");
  const formSlug = getString(formData, "form_slug") || getString(formData, "form_id") || getString(formData, "form") || "formular";
  const source = getString(formData, "utm_source") || "website";
  const lookup = await getPublicWebsiteFormByKey(formSlug).catch(() => null);
  if (!lookup) {
    return responseFromSnapshot(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: "Form not found",
        request,
        returnTo,
        source,
        status: 404,
      }),
    );
  }

  try {
    validatePublicSubmissionFieldRules(
      formData,
      buildPublicFormFieldRules(lookup.form),
    );
    await validatePublicSubmissionFilesForFields(
      formData,
      lookup.form.fields
        .filter((field) => field.type === "file")
        .map((field) => ({
          acceptedTypes: field.fileAccept,
          maxBytes: Math.min(
            formSubmissionBodyLimits.allowedFileBytes,
            Math.max(1, field.fileMaxMb || 10) * 1024 * 1024,
          ),
          multiple: field.multiple,
          name: field.crmField || field.id,
        })),
    );
  } catch (error) {
    const reason = error instanceof PublicSubmissionRequestError
      ? error.code
      : "invalid_submission";
    const status = error instanceof PublicSubmissionRequestError ? error.status : 400;
    return responseFromSnapshot(
      createPublicFormFailureSnapshot({
        formSlug,
        reason,
        request,
        returnTo,
        source,
        status,
      }),
    );
  }

  const scope = buildPublicSubmissionScope({
    resourceId: lookup.id,
    resourceType: "form",
    workspaceId: lookup.workspaceId,
  });
  let hashes: ReturnType<typeof createPublicSubmissionIdempotencyHashes>;
  let proofValidation: ReturnType<typeof verifyPublicSubmissionProof>;
  try {
    proofValidation = verifyPublicSubmissionProof({
      action: publicSubmissionActions.form,
      proof: getPublicSubmissionProof(formData),
      scope,
    });
    if (!proofValidation.ok) {
      return responseFromSnapshot(
        createPublicFormFailureSnapshot({
          formSlug,
          reason: proofValidation.reason,
          request,
          returnTo,
          source,
          status: 400,
        }),
      );
    }
    hashes = createPublicSubmissionIdempotencyHashes({
      action: publicSubmissionActions.form,
      idempotencyKey: proofValidation.proof.idempotencyKey,
      requestFingerprint: parsed.requestFingerprint,
      scope,
    });
  } catch {
    return unavailableResponse();
  }

  let claim: Awaited<ReturnType<typeof claimPublicSubmissionIdempotency>>;
  try {
    claim = await claimPublicSubmissionIdempotency(hashes);
  } catch {
    return unavailableResponse();
  }
  if (claim.state === "replay") return responseFromSnapshot(claim.response);
  if (claim.state === "processing" || claim.state === "conflict") {
    return responseFromSnapshot(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: claim.state === "processing" ? "submission_in_progress" : "submission_replay_conflict",
        request,
        returnTo,
        source,
        status: 409,
      }),
    );
  }

  const complete = async (response: PublicSubmissionResponseSnapshot) => {
    try {
      await completePublicSubmissionIdempotency({
        idempotencyHash: hashes.idempotencyHash,
        requestHash: hashes.requestHash,
        response,
      });
      return responseFromSnapshot(response);
    } catch {
      return unavailableResponse();
    }
  };

  const clientIp = getTrustedPublicSubmissionClientIp(request.headers);
  if (!clientIp) {
    return complete(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: "temporarily_unavailable",
        request,
        returnTo,
        source,
        status: 503,
      }),
    );
  }

  try {
    const identifier = getPublicFormIdentifier(lookup.form, formData, proofValidation.proof.idempotencyKey);
    const rateLimit = await consumePublicSubmissionRateLimits({
      policies: createPublicSubmissionRateLimitPolicies({
        action: publicSubmissionActions.form,
        clientIp,
        identifier,
        scope,
      }),
    });
    if (!rateLimit.allowed) {
      return complete(
        createPublicFormFailureSnapshot({
          formSlug,
          reason: "rate_limited",
          request,
          returnTo,
          source,
          status: 429,
        }),
      );
    }
  } catch {
    return complete(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: "temporarily_unavailable",
        request,
        returnTo,
        source,
        status: 503,
      }),
    );
  }

  if (hasPublicSubmissionHoneypotValue(formData)) {
    return complete(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: "submission_rejected",
        request,
        returnTo,
        source,
        status: 400,
      }),
    );
  }

  stripPublicSubmissionControlFields(formData);
  try {
    const persistence = await persistWebsiteFormSubmission({
      formData,
      formKey: formSlug,
      requestUrl: request.url,
    });
    return complete(
      createPublicFormPersistenceSnapshot({
        formSlug,
        persistence,
        request,
        returnTo,
        source,
      }),
    );
  } catch {
    return complete(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: "temporarily_unavailable",
        request,
        returnTo,
        source,
        status: 503,
      }),
    );
  }
}

function createPublicFormPersistenceSnapshot(input: {
  formSlug: string;
  persistence: Awaited<ReturnType<typeof persistWebsiteFormSubmission>>;
  request: Request;
  returnTo: string;
  source: string;
}): PublicSubmissionResponseSnapshot {
  if (input.request.headers.get("accept")?.includes("application/json")) {
    return {
      body: input.persistence.persisted
        ? { persisted: true, form: input.persistence.form }
        : { error: normalizePublicFormReason(input.persistence.reason), persisted: false },
      kind: "json",
      status: input.persistence.persisted ? 200 : getFailureStatus(input.persistence.reason),
    };
  }

  const configuredRedirect = input.persistence.persisted ? input.persistence.redirectUrl ?? "" : "";
  const redirectUrl = resolvePublicFormRedirect({
    configuredRedirect,
    formSlug: input.formSlug,
    returnTo: input.returnTo,
  });

  redirectUrl.searchParams.set("submitted", input.persistence.persisted ? "1" : "0");
  redirectUrl.searchParams.set("utm_source", input.source);
  redirectUrl.searchParams.set("crm_status", input.persistence.persisted ? "saved" : "failed");
  if (!input.persistence.persisted) {
    redirectUrl.searchParams.set("crm_reason", normalizePublicFormReason(input.persistence.reason));
  }

  return { kind: "redirect", location: redirectUrl.toString(), status: 303 };
}

function createPublicFormFailureSnapshot(input: {
  formSlug: string;
  reason: string;
  request: Request;
  returnTo?: string;
  source: string;
  status: number;
}): PublicSubmissionResponseSnapshot {
  const reason = normalizePublicFormReason(input.reason);
  if (input.request.headers.get("accept")?.includes("application/json")) {
    return { body: { error: reason, persisted: false }, kind: "json", status: input.status };
  }

  const redirectUrl = resolvePublicFormRedirect({
    configuredRedirect: "",
    formSlug: input.formSlug,
    returnTo: input.returnTo ?? "",
  });
  redirectUrl.searchParams.set("submitted", "0");
  redirectUrl.searchParams.set("utm_source", input.source);
  redirectUrl.searchParams.set("crm_status", "failed");
  redirectUrl.searchParams.set("crm_reason", reason);
  return { kind: "redirect", location: redirectUrl.toString(), status: 303 };
}

function resolvePublicFormRedirect(input: {
  configuredRedirect: string;
  formSlug: string;
  returnTo: string;
}) {
  const trustedOrigin = getTrustedAppOrigin();
  const safeReturnTo = resolveSafeFormRedirect({
    allowlist: process.env.NOVALURE_FORM_REDIRECT_ALLOWLIST,
    configuredTarget: input.configuredRedirect,
    fallback: `/forms/${encodeURIComponent(input.formSlug)}`,
    returnTo: input.returnTo,
    trustedOrigin,
  });
  return new URL(safeReturnTo, trustedOrigin);
}

function responseFromSnapshot(response: PublicSubmissionResponseSnapshot) {
  const nextResponse = response.kind === "redirect"
    ? NextResponse.redirect(response.location, response.status)
    : NextResponse.json(response.body, { status: response.status });
  nextResponse.headers.set("cache-control", "private, no-store");
  return nextResponse;
}

function unavailableResponse() {
  return NextResponse.json(
    { error: "temporarily_unavailable", persisted: false },
    {
      headers: { "cache-control": "private, no-store", "retry-after": "5" },
      status: 503,
    },
  );
}

function buildPublicFormFieldRules(form: WebsiteForm) {
  const rules = new Map<string, {
    allowFile?: boolean;
    maxEntries?: number;
    maxLength: number;
    name: string;
  }>();
  for (const field of form.fields) {
    const name = field.crmField || field.id;
    rules.set(name, {
      allowFile: field.type === "file",
      maxEntries: field.multiple || field.type === "multiCheckbox"
        ? Math.max(1, Math.min(20, field.options.length || 5))
        : 1,
      maxLength: getPublicFormFieldMaxLength(field.type),
      name,
    });
  }

  for (const rule of getPublicFormSystemFieldRules()) rules.set(rule.name, rule);
  return Array.from(rules.values());
}

function getPublicFormFieldMaxLength(type: WebsiteForm["fields"][number]["type"]) {
  if (type === "email") return 320;
  if (type === "phone") return 64;
  if (type === "textarea") return 8_192;
  if (type === "hidden" || type === "url") return 2_048;
  if (type === "file") return 0;
  return 1_024;
}

function getPublicFormSystemFieldRules() {
  return [
    { maxLength: 192, name: "form_id" },
    { maxLength: 192, name: "form_slug" },
    { maxLength: 192, name: "form" },
    { maxLength: 2_048, name: "return_to" },
    { maxLength: 256, name: "utm_source" },
    { maxLength: 256, name: "utm_medium" },
    { maxLength: 256, name: "utm_campaign" },
    { maxLength: 256, name: "gclid" },
    { maxLength: 256, name: "fbclid" },
    { maxLength: 32, name: "form_variant" },
    { maxLength: 64, name: "funnel_id" },
    { maxLength: 2_048, name: "page_url" },
    { maxLength: 2_048, name: "referrer" },
    { maxLength: 8, name: "_charset_" },
    { maxLength: 128, name: publicSubmissionControlFields.idempotencyKey },
    { maxLength: 16, name: publicSubmissionControlFields.issuedAt },
    { maxLength: 16, name: publicSubmissionControlFields.expiresAt },
    { maxLength: 128, name: publicSubmissionControlFields.proof },
    { maxLength: 256, name: publicSubmissionControlFields.honeypot },
  ];
}

function getPublicFormIdentifier(form: WebsiteForm, formData: FormData, fallback: string) {
  const emailField = form.fields.find((field) => field.type === "email");
  if (emailField) {
    const email = getString(formData, emailField.crmField || emailField.id);
    if (email) return normalizePublicSubmissionIdentifier(email, "email");
  }
  const phoneField = form.fields.find((field) => field.type === "phone");
  if (phoneField) {
    const phone = getString(formData, phoneField.crmField || phoneField.id);
    if (phone) return normalizePublicSubmissionIdentifier(phone, "phone");
  }
  return normalizePublicSubmissionIdentifier(fallback, "opaque");
}

function normalizePublicFormReason(reason: string) {
  if (reason === "Form not found") return reason;
  if (reason === "privacy_consent_required" || reason.startsWith("required_field_missing")) return reason;
  if (reason === "invalid_email") return reason;
  if (
    reason === "rate_limited" ||
    reason === "submission_in_progress" ||
    reason === "submission_replay_conflict" ||
    reason === "submission_rejected" ||
    reason.startsWith("submission_") ||
    reason.startsWith("invalid_") ||
    reason.startsWith("file_") ||
    reason.startsWith("too_many_") ||
    reason.startsWith("unsupported_")
  ) {
    return reason;
  }
  return "temporarily_unavailable";
}

function getFailureStatus(reason: string) {
  if (reason === "Form not found") return 404;
  if (reason === "privacy_consent_required" || reason.startsWith("required_field_missing") || reason === "invalid_email") {
    return 422;
  }

  return 400;
}
