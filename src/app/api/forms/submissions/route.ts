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
  readPublicSubmissionIdempotency,
} from "@/lib/db/public-submission-abuse-repository";
import type { WebsiteForm } from "@/lib/form-types";
import { publicSubmissionControlFields } from "@/lib/public-submission-contract";
import { getPublicFormLaunchBlockReason } from "@/lib/public-form-dto";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  buildPublicSubmissionScope,
  buildVersionedPublicSubmissionResourceId,
  createCanonicalPublicSubmissionFormDataFingerprint,
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
  const launchScope = evaluateLaunchScope("publicFormSubmission");
  if (!launchScope.allowed) {
    return Response.json(
      { error: "public_form_submission_launch_off", persisted: false },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
  }

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
  let lookup: Awaited<ReturnType<typeof getPublicWebsiteFormByKey>>;
  try {
    lookup = await getPublicWebsiteFormByKey(formSlug);
  } catch {
    return unavailableResponse();
  }
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

  const launchBlockReason = getPublicFormLaunchBlockReason(lookup.form, lookup.ownerActive);
  if (launchBlockReason) {
    return responseFromSnapshot(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: launchBlockReason,
        request,
        returnTo,
        source,
        status: 503,
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
    resourceId: buildVersionedPublicSubmissionResourceId({
      resourceId: lookup.id,
      version: lookup.form.version,
    }),
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
    const semanticRequestFingerprint = await createCanonicalPublicSubmissionFormDataFingerprint({
      formData,
    });
    hashes = createPublicSubmissionIdempotencyHashes({
      action: publicSubmissionActions.form,
      idempotencyKey: proofValidation.proof.idempotencyKey,
      requestFingerprint: semanticRequestFingerprint,
      scope,
    });
  } catch {
    return unavailableResponse();
  }

  let priorClaim: Awaited<ReturnType<typeof readPublicSubmissionIdempotency>>;
  try {
    priorClaim = await readPublicSubmissionIdempotency(hashes);
  } catch {
    return unavailableResponse();
  }
  if (priorClaim.state === "replay") return responseFromSnapshot(priorClaim.response);
  if (priorClaim.state === "processing" || priorClaim.state === "conflict") {
    return responseFromSnapshot(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: priorClaim.state === "processing" ? "submission_in_progress" : "submission_replay_conflict",
        request,
        returnTo,
        source,
        status: 409,
      }),
    );
  }

  const clientIp = getTrustedPublicSubmissionClientIp(request.headers);
  if (!clientIp) {
    return responseFromSnapshot(
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
      return responseFromSnapshot(
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
    return unavailableResponse();
  }

  if (hasPublicSubmissionHoneypotValue(formData)) {
    return responseFromSnapshot(
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

  // Only submissions that passed the bounded abuse controls may allocate or
  // reclaim durable idempotency storage. The claim itself remains atomic so a
  // race after the read-only replay check still fails closed.
  let claim: Awaited<ReturnType<typeof claimPublicSubmissionIdempotency>>;
  try {
    claim = await claimPublicSubmissionIdempotency({
      ...hashes,
      allowLeaseReclaim: true,
    });
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
        leaseVersion: claim.leaseVersion,
        requestHash: hashes.requestHash,
        response,
      });
      return responseFromSnapshot(response);
    } catch {
      return unavailableResponse();
    }
  };

  stripPublicSubmissionControlFields(formData);
  try {
    const persistence = await persistWebsiteFormSubmission({
      actionHash: hashes.actionHash,
      formData,
      formId: lookup.id,
      formKey: formSlug,
      idempotencyHash: hashes.idempotencyHash,
      leaseVersion: claim.leaseVersion,
      requestUrl: request.url,
      requestHash: hashes.requestHash,
      scopeHash: hashes.scopeHash,
      successResponse: createPublicFormSuccessSnapshot({
        form: lookup.form,
        formSlug,
        request,
        returnTo,
        source,
      }),
      workspaceId: lookup.workspaceId,
    });
    if (persistence.persisted) {
      return responseFromSnapshot(persistence.response);
    }
    return complete(
      createPublicFormFailureSnapshot({
        formSlug,
        reason: persistence.reason,
        request,
        returnTo,
        source,
        status: getPersistenceFailureStatus(persistence.reason),
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

function createPublicFormSuccessSnapshot(input: {
  form: WebsiteForm;
  formSlug: string;
  request: Request;
  returnTo: string;
  source: string;
}): PublicSubmissionResponseSnapshot {
  if (input.request.headers.get("accept")?.includes("application/json")) {
    return {
      body: { persisted: true },
      kind: "json",
      status: 200,
    };
  }

  const redirectUrl = resolvePublicFormRedirect({
    configuredRedirect: input.form.actions.redirectUrl,
    formSlug: input.formSlug,
    returnTo: input.returnTo,
  });

  redirectUrl.searchParams.set("submitted", "1");
  redirectUrl.searchParams.set("utm_source", input.source);
  redirectUrl.searchParams.set("crm_status", "saved");

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
    if (field.type === "hidden") continue;
    rules.set(field.id, {
      allowFile: field.type === "file",
      maxEntries: field.multiple || field.type === "multiCheckbox"
        ? Math.max(1, Math.min(20, field.options.length || 5))
        : 1,
      maxLength: getPublicFormFieldMaxLength(field.type),
      name: field.id,
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
    const email = getString(formData, emailField.id);
    if (email) return normalizePublicSubmissionIdentifier(email, "email");
  }
  const phoneField = form.fields.find((field) => field.type === "phone");
  if (phoneField) {
    const phone = getString(formData, phoneField.id);
    if (phone) return normalizePublicSubmissionIdentifier(phone, "phone");
  }
  return normalizePublicSubmissionIdentifier(fallback, "opaque");
}

function normalizePublicFormReason(reason: string) {
  if (reason === "Form not found") return reason;
  if (reason === "privacy_consent_required" || reason.startsWith("required_field_missing")) return reason;
  if (reason.startsWith("invalid_")) return reason;
  if (
    reason === "contact_identity_conflict" ||
    reason === "form_consent_configuration_unavailable" ||
    reason === "form_custom_pattern_unavailable" ||
    reason === "form_file_upload_unavailable" ||
    reason === "form_owner_unavailable" ||
    reason === "form_round_robin_unavailable" ||
    reason === "multiple_email_values" ||
    reason === "multiple_phone_values"
  ) return reason;
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

function getPersistenceFailureStatus(reason: string) {
  if (reason === "submission_proof_stale") return 409;
  if (reason === "submission_replay_conflict") return 409;
  if (reason === "contact_identity_conflict") return 409;
  if (reason === "Form not found") return 404;
  if (
    reason === "privacy_consent_required" ||
    reason.startsWith("required_field_missing") ||
    isPublicFormFieldValidationReason(reason)
  ) {
    return 422;
  }
  return 503;
}

function isPublicFormFieldValidationReason(reason: string) {
  return [
    "invalid_date",
    "invalid_email",
    "invalid_max_value",
    "invalid_min_value",
    "invalid_number",
    "invalid_option",
    "invalid_pattern",
    "invalid_phone",
    "invalid_time",
    "invalid_url",
  ].some((prefix) => reason === prefix || reason.startsWith(`${prefix}:`));
}
