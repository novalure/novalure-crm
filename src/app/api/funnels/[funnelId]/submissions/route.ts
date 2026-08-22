import { NextResponse } from "next/server";
import { requirePermission, type AppSession } from "@/lib/auth/session";
import {
  claimPublicSubmissionIdempotency,
  completePublicSubmissionIdempotency,
  consumePublicSubmissionRateLimits,
  readPublicSubmissionIdempotency,
} from "@/lib/db/public-submission-abuse-repository";
import {
  findPersistedFunnelSubmissionByIdempotency,
  funnelPublicationRevisionConflictReason,
  persistFunnelSubmission,
  persistFunnelTestSubmission,
} from "@/lib/db/runtime-repositories";
import {
  getStoredFunnelPublicationRevision,
  getStoredFunnelSubmissionScopeResourceId,
  isStoredFunnelPubliclyLive,
} from "@/lib/funnel-public-access";
import { runFunnelLivePreflight } from "@/lib/funnel-live-preflight";
import { getStoredFunnel } from "@/lib/funnel-store";
import type { FunnelBlueprint, FunnelSubmissionPayload } from "@/lib/funnel-schema";
import { sanitizeFunnelSubmissionForPersistence } from "@/lib/funnel-submission-security";
import {
  canonicalizeFunnelSubmissionPayload,
  FunnelSubmissionValidationError,
  resolveCanonicalFunnelSubmissionSemantics,
  scoreCanonicalFunnelAnswers,
} from "@/lib/funnel-submission-validation";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { getProductRoleCapabilities } from "@/lib/product-model";
import {
  buildPublicSubmissionScope,
  createFunnelSubmissionDomainIdempotencyHash,
  createFunnelSubmissionReplayRequestFingerprint,
  createPublicSubmissionIdempotencyHashes,
  createPublicSubmissionOpaqueHash,
  createPublicSubmissionRateLimitPolicies,
  funnelSubmissionBodyLimits,
  getTrustedPublicSubmissionClientIp,
  normalizePublicSubmissionIdentifier,
  publicSubmissionActions,
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionJson,
  verifyPublicSubmissionProof,
  type PublicSubmissionResponseSnapshot,
} from "@/lib/security/public-submission-abuse";

type RouteContext = {
  params: Promise<{ funnelId: string }>;
};

function hasRequiredConsent(payload: FunnelSubmissionPayload) {
  return payload.consent?.privacy === true;
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function createPublicFunnelSession(input: {
  blueprint: FunnelBlueprint;
  stored: NonNullable<Awaited<ReturnType<typeof getStoredFunnel>>>;
}): AppSession {
  return {
    authenticated: true,
    email: "funnel@novalure.local",
    name: "Public Funnel Runtime",
    permissions: [],
    productPermissions: getProductRoleCapabilities("assistant_backoffice"),
    productRole: "assistant_backoffice",
    role: "owner",
    source: "database",
    userId: input.stored.ownerUserId ?? "public-funnel-runtime",
    workspaceId: input.stored.workspaceId ?? input.blueprint.workspaceId,
    workspaceName: input.stored.workspaceName ?? "Novalure",
  };
}

const allowedPayloadFields = new Set([
  "answers",
  "consent",
  "funnelId",
  "mode",
  "publicSubmission",
  "utm",
  "visitor",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function submissionError(code: string, status = 400): never {
  throw new PublicSubmissionRequestError(code, status);
}

function assertSafeObjectKey(value: string) {
  if (
    !value ||
    value.length > 128 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value) ||
    value === "__proto__" ||
    value === "constructor" ||
    value === "prototype"
  ) {
    submissionError("invalid_submission_field_name");
  }
}

function assertBoundedString(value: unknown, maxLength: number, code: string) {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    value.includes("\u0000") ||
    value.includes("\uFFFD")
  ) {
    submissionError(code, typeof value === "string" && value.length > maxLength ? 413 : 400);
  }
}

function validateFunnelSubmissionPayload(value: unknown, funnelId: string): FunnelSubmissionPayload {
  const record = asRecord(value);
  if (!record) submissionError("invalid_json");
  for (const key of Object.keys(record)) {
    if (!allowedPayloadFields.has(key)) submissionError("unknown_submission_field");
  }

  if (record.mode !== "test" && record.mode !== "live") {
    submissionError("invalid_funnel_mode");
  }
  if (record.funnelId !== funnelId || typeof record.funnelId !== "string" || record.funnelId.length > 64) {
    submissionError("funnel_mismatch");
  }

  const answers = asRecord(record.answers);
  if (!answers || Object.keys(answers).length > 128) {
    submissionError("invalid_funnel_answers", Object.keys(answers ?? {}).length > 128 ? 413 : 400);
  }
  for (const [key, answer] of Object.entries(answers)) {
    assertSafeObjectKey(key);
    if (typeof answer === "string") {
      assertBoundedString(answer, 8_192, "submission_field_too_long");
    } else if (Array.isArray(answer)) {
      if (answer.length > 20) submissionError("too_many_field_values", 413);
      for (const item of answer) assertBoundedString(item, 1_024, "submission_field_too_long");
    } else if (
      answer !== null &&
      typeof answer !== "boolean" &&
      (typeof answer !== "number" || !Number.isFinite(answer) || Math.abs(answer) > 1_000_000_000_000)
    ) {
      submissionError("invalid_submission_field_value");
    }
  }

  const visitor = asRecord(record.visitor);
  if (!visitor) submissionError("invalid_funnel_visitor");
  for (const key of Object.keys(visitor)) {
    if (key !== "id" && key !== "sourceUrl" && key !== "userAgent") {
      submissionError("unknown_submission_field");
    }
  }
  if (visitor.id != null) assertBoundedString(visitor.id, 128, "invalid_funnel_visitor");
  if (visitor.sourceUrl != null) assertBoundedString(visitor.sourceUrl, 2_048, "invalid_funnel_visitor");
  if (visitor.userAgent != null) assertBoundedString(visitor.userAgent, 2_048, "invalid_funnel_visitor");

  const consent = asRecord(record.consent);
  if (
    !consent ||
    typeof consent.analytics !== "boolean" ||
    typeof consent.marketing !== "boolean" ||
    typeof consent.privacy !== "boolean" ||
    Object.keys(consent).some((key) => key !== "analytics" && key !== "marketing" && key !== "privacy")
  ) {
    submissionError("invalid_funnel_consent");
  }

  if (record.utm != null) {
    const utm = asRecord(record.utm);
    if (!utm || Object.keys(utm).length > 20) submissionError("invalid_funnel_utm");
    for (const [key, utmValue] of Object.entries(utm)) {
      assertSafeObjectKey(key);
      assertBoundedString(utmValue, 512, "invalid_funnel_utm");
    }
  }

  if (record.publicSubmission != null) {
    const controls = asRecord(record.publicSubmission);
    if (!controls) submissionError("invalid_submission_proof");
    for (const key of Object.keys(controls)) {
      if (key !== "honeypot" && key !== "intentId" && key !== "proof") submissionError("unknown_submission_field");
    }
    if (controls.honeypot != null) {
      assertBoundedString(controls.honeypot, 256, "invalid_submission_honeypot");
    }
    if (controls.intentId != null) {
      assertBoundedString(controls.intentId, 36, "invalid_submission_intent");
      if (
        typeof controls.intentId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(controls.intentId)
      ) {
        submissionError("invalid_submission_intent");
      }
    }
    if (controls.proof != null) {
      const proof = asRecord(controls.proof);
      if (
        !proof ||
        typeof proof.idempotencyKey !== "string" ||
        typeof proof.signature !== "string" ||
        !Number.isInteger(proof.issuedAt) ||
        !Number.isInteger(proof.expiresAt) ||
        Object.keys(proof).some((key) =>
          key !== "expiresAt" && key !== "idempotencyKey" && key !== "issuedAt" && key !== "signature"
        )
      ) {
        submissionError("invalid_submission_proof");
      }
      assertBoundedString(proof.idempotencyKey, 128, "invalid_submission_proof");
      assertBoundedString(proof.signature, 128, "invalid_submission_proof");
    }
  }

  if (record.mode === "live") {
    const controls = asRecord(record.publicSubmission);
    if (!controls?.intentId || !controls.proof) submissionError("invalid_submission_proof");
  }

  return record as unknown as FunnelSubmissionPayload;
}

function getFunnelSubmissionIdentifier(
  blueprint: FunnelBlueprint,
  payload: FunnelSubmissionPayload,
  fallback: string,
) {
  const semantics = resolveCanonicalFunnelSubmissionSemantics(blueprint, payload.answers);
  if (semantics.email) return normalizePublicSubmissionIdentifier(semantics.email, "email");
  if (semantics.phone) return normalizePublicSubmissionIdentifier(semantics.phone, "phone");
  return normalizePublicSubmissionIdentifier(fallback, "opaque");
}

function getFunnelSubmissionDomainRequestFingerprint(payload: FunnelSubmissionPayload) {
  const utm = Object.fromEntries(Object.entries(payload.utm ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return createPublicSubmissionOpaqueHash({
    label: "funnel-submission-semantic-request",
    value: JSON.stringify({
      answers: payload.answers,
      consent: {
        analytics: payload.consent.analytics,
        marketing: payload.consent.marketing,
        privacy: payload.consent.privacy,
      },
      funnelId: payload.funnelId,
      mode: payload.mode,
      utm,
    }),
  });
}

function responseFromSnapshot(snapshot: PublicSubmissionResponseSnapshot) {
  const response = snapshot.kind === "redirect"
    ? NextResponse.redirect(snapshot.location, snapshot.status)
    : NextResponse.json(snapshot.body, { status: snapshot.status });
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function failureSnapshot(reason: string, status: number): PublicSubmissionResponseSnapshot {
  return { body: { error: reason, persisted: false }, kind: "json", status };
}

function staleFunnelPublicationSnapshot(): PublicSubmissionResponseSnapshot {
  return {
    body: {
      error: "funnel_publication_stale",
      persisted: false,
      reloadRequired: true,
    },
    kind: "json",
    status: 409,
  };
}

function unavailableResponse() {
  const response = responseFromSnapshot(failureSnapshot("temporarily_unavailable", 503));
  response.headers.set("retry-after", "5");
  return response;
}

function createSuccessSnapshot(input: {
  blueprint: FunnelBlueprint;
  funnelId: string;
  mode: FunnelSubmissionPayload["mode"];
  persistence: Extract<Awaited<ReturnType<typeof persistFunnelSubmission>>, { persisted: true }>;
  score: number;
}): PublicSubmissionResponseSnapshot {
  const submissionId = input.persistence.ids.submissionId;
  if (!submissionId) return failureSnapshot("temporarily_unavailable", 503);

  if (input.mode === "live") {
    return {
      body: {
        mode: "live",
        ok: true,
        persisted: true,
      },
      kind: "json",
      status: 200,
    };
  }

  return {
    body: {
      eventId: `${input.funnelId}_${submissionId}`,
      leadPreview: {
        createsAppointment: input.blueprint.crmHandover.createAppointment,
        createsLeadInboxEntry: input.blueprint.crmHandover.createLeadInboxEntry,
        createsTask: input.blueprint.crmHandover.createTask,
        destination: input.blueprint.crmHandover.destination,
        funnelId: input.funnelId,
        pipelineStage: input.blueprint.crmHandover.pipelineStage,
        score: input.score,
      },
      mode: input.mode,
      ok: true,
      persisted: true,
      persistence: input.persistence,
      residue: {
        cleanupRequired: true,
        records: ["funnel_submissions", "audit_logs", "crm_analytics_events"],
        residueFree: false,
      },
      submissionId,
      trackingPreview: {
        consentMode: input.blueprint.tracking.consentMode,
        ga4Ready: Boolean(input.blueprint.tracking.gaMeasurementId),
        gtmReady: Boolean(input.blueprint.tracking.gtmId),
        metaCapiReady: Boolean(input.blueprint.tracking.metaCapiToken),
        metaPixelReady: Boolean(input.blueprint.tracking.metaPixelId),
        webhookDelivery: "launch_off",
        webhookReady: false,
      },
    },
    kind: "json",
    status: 200,
  };
}

export async function POST(request: Request, context: RouteContext) {
  const launchScope = evaluateLaunchScope("publicFunnelSubmission");
  if (!launchScope.allowed) {
    return responseFromSnapshot(failureSnapshot(launchScope.code, 503));
  }
  const text = getApiSystemCopy(resolveRequestLanguage(request));
  const { funnelId } = await context.params;

  let parsed: Awaited<ReturnType<typeof readBoundedPublicSubmissionJson>>;
  let payload: FunnelSubmissionPayload;
  try {
    parsed = await readBoundedPublicSubmissionJson(request, funnelSubmissionBodyLimits);
    payload = validateFunnelSubmissionPayload(parsed.value, funnelId);
  } catch (error) {
    const reason = error instanceof PublicSubmissionRequestError ? error.code : text.invalidJson;
    const status = error instanceof PublicSubmissionRequestError ? error.status : 400;
    return responseFromSnapshot(failureSnapshot(reason, status));
  }

  const auth = payload.mode === "test"
    ? await requirePermission(request, "funnels:write")
    : null;
  if (auth && !auth.ok) return auth.response;

  let stored;
  try {
    stored = await getStoredFunnel(funnelId, auth?.session.workspaceId);
  } catch {
    return unavailableResponse();
  }
  if (!stored?.funnelId || !stored.workspaceId) {
    return responseFromSnapshot(failureSnapshot(text.funnelNotFound, 404));
  }

  const blueprint = stored.blueprint;
  const expectedPublicationRevision = getStoredFunnelPublicationRevision(stored.tracking);
  if (payload.mode === "live") {
    if (!isStoredFunnelPubliclyLive({ blueprint, stored })) {
      return responseFromSnapshot(failureSnapshot("funnel_not_published", 403));
    }
    const preflight = runFunnelLivePreflight(blueprint);
    if (!preflight.ok) {
      return responseFromSnapshot(failureSnapshot("funnel_live_preflight_blocked", 403));
    }
  }
  try {
    payload = canonicalizeFunnelSubmissionPayload(blueprint, payload);
    payload = sanitizeFunnelSubmissionForPersistence({
      payload,
      storedTracking: stored.tracking,
    });
  } catch (error) {
    const reason = error instanceof FunnelSubmissionValidationError
      ? error.code
      : "invalid_funnel_answers";
    const status = error instanceof FunnelSubmissionValidationError ? error.status : 400;
    return responseFromSnapshot(failureSnapshot(reason, status));
  }
  if (!hasRequiredConsent(payload)) {
    return responseFromSnapshot(failureSnapshot(text.privacyConsentRequired, 422));
  }

  const score = scoreCanonicalFunnelAnswers(payload.answers);
  const session = payload.mode === "live"
    ? createPublicFunnelSession({ blueprint, stored })
    : auth?.session;
  if (!session) return responseFromSnapshot(failureSnapshot("funnel_session_unavailable", 403));

  if (payload.mode === "test") {
    try {
      const persistence = await persistFunnelTestSubmission({
        blueprint,
        databaseFunnelId: stored.funnelId,
        payload,
        score,
        session,
      });
      if (!persistence.persisted) {
        return responseFromSnapshot(failureSnapshot(persistence.reason, persistence.reason.includes("not found") ? 404 : 503));
      }
      return responseFromSnapshot(createSuccessSnapshot({ blueprint, funnelId, mode: payload.mode, persistence, score }));
    } catch {
      return unavailableResponse();
    }
  }

  const scope = buildPublicSubmissionScope({
    resourceId: getStoredFunnelSubmissionScopeResourceId({
      funnelId: stored.funnelId,
      storedTracking: stored.tracking,
    }),
    resourceType: "funnel",
    workspaceId: stored.workspaceId,
  });
  const stableDomainScope = buildPublicSubmissionScope({
    resourceId: stored.funnelId,
    resourceType: "funnel",
    workspaceId: stored.workspaceId,
  });
  let proofValidation: ReturnType<typeof verifyPublicSubmissionProof>;
  let hashes: ReturnType<typeof createPublicSubmissionIdempotencyHashes>;
  let domainIdempotencyHash: string;
  try {
    proofValidation = verifyPublicSubmissionProof({
      action: publicSubmissionActions.funnel,
      proof: payload.publicSubmission?.proof ?? null,
      scope,
    });
    if (!proofValidation.ok) {
      return responseFromSnapshot(failureSnapshot(proofValidation.reason, 400));
    }
    const domainRequestFingerprint = getFunnelSubmissionDomainRequestFingerprint(payload);
    hashes = createPublicSubmissionIdempotencyHashes({
      action: publicSubmissionActions.funnel,
      idempotencyKey: proofValidation.proof.idempotencyKey,
      requestFingerprint: createFunnelSubmissionReplayRequestFingerprint({
        intentId: payload.publicSubmission?.intentId ?? "",
        requestFingerprint: domainRequestFingerprint,
      }),
      scope,
    });
    domainIdempotencyHash = createFunnelSubmissionDomainIdempotencyHash({
      intentId: payload.publicSubmission?.intentId ?? "",
      requestFingerprint: domainRequestFingerprint,
      scope: stableDomainScope,
    });
  } catch {
    return unavailableResponse();
  }

  const completeLease = async (leaseVersion: number, snapshot: PublicSubmissionResponseSnapshot) => {
    try {
      await completePublicSubmissionIdempotency({
        idempotencyHash: hashes.idempotencyHash,
        leaseVersion,
        requestHash: hashes.requestHash,
        response: snapshot,
      });
      return responseFromSnapshot(snapshot);
    } catch {
      return unavailableResponse();
    }
  };

  let priorClaim: Awaited<ReturnType<typeof readPublicSubmissionIdempotency>>;
  try {
    priorClaim = await readPublicSubmissionIdempotency(hashes);
  } catch {
    return unavailableResponse();
  }
  if (priorClaim.state === "replay") return responseFromSnapshot(priorClaim.response);
  if (priorClaim.state === "conflict") {
    return responseFromSnapshot(failureSnapshot("submission_replay_conflict", 409));
  }

  if (priorClaim.state === "processing") {
    try {
      const recovered = await findPersistedFunnelSubmissionByIdempotency({
        databaseFunnelId: stored.funnelId,
        submissionIdempotencyHash: domainIdempotencyHash,
        workspaceId: stored.workspaceId,
      });
      if (recovered.persisted) {
        return completeLease(
          priorClaim.leaseVersion,
          createSuccessSnapshot({ blueprint, funnelId, mode: payload.mode, persistence: recovered, score }),
        );
      }
    } catch {
      return unavailableResponse();
    }
    return responseFromSnapshot(failureSnapshot("submission_in_progress", 409));
  }

  const clientIp = getTrustedPublicSubmissionClientIp(request.headers);
  if (!clientIp) return responseFromSnapshot(failureSnapshot("temporarily_unavailable", 503));

  try {
    const rateLimit = await consumePublicSubmissionRateLimits({
      policies: createPublicSubmissionRateLimitPolicies({
        action: publicSubmissionActions.funnel,
        clientIp,
        identifier: getFunnelSubmissionIdentifier(blueprint, payload, proofValidation.proof.idempotencyKey),
        scope,
      }),
    });
    if (!rateLimit.allowed) return responseFromSnapshot(failureSnapshot("rate_limited", 429));
  } catch {
    return unavailableResponse();
  }

  if (cleanString(payload.publicSubmission?.honeypot)) {
    return responseFromSnapshot(failureSnapshot("submission_rejected", 400));
  }

  // Allocate or reclaim durable replay state only after the request has
  // consumed the bounded abuse controls. The atomic claim closes the race
  // between the read-only replay lookup above and this point.
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
  if (claim.state === "conflict") {
    return responseFromSnapshot(failureSnapshot("submission_replay_conflict", 409));
  }
  if (claim.state === "processing") {
    try {
      const recovered = await findPersistedFunnelSubmissionByIdempotency({
        databaseFunnelId: stored.funnelId,
        submissionIdempotencyHash: domainIdempotencyHash,
        workspaceId: stored.workspaceId,
      });
      if (recovered.persisted) {
        return completeLease(
          claim.leaseVersion,
          createSuccessSnapshot({ blueprint, funnelId, mode: payload.mode, persistence: recovered, score }),
        );
      }
    } catch {
      return unavailableResponse();
    }
    return responseFromSnapshot(failureSnapshot("submission_in_progress", 409));
  }

  const complete = (snapshot: PublicSubmissionResponseSnapshot) => completeLease(claim.leaseVersion, snapshot);

  const persistablePayload: FunnelSubmissionPayload = { ...payload };
  delete persistablePayload.publicSubmission;
  try {
    const persistence = await persistFunnelSubmission({
      blueprint,
      databaseFunnelId: stored.funnelId,
      expectedPublicationRevision,
      payload: persistablePayload,
      score,
      session,
      submissionIdempotencyHash: domainIdempotencyHash,
    });
    if (!persistence.persisted) {
      if (persistence.reason === funnelPublicationRevisionConflictReason) {
        // Rotation won the funnel row lock after this request's proof was
        // verified. Do not finalize the old-revision abuse lease: no domain
        // side effects committed and a refreshed proof must use the new scope.
        return responseFromSnapshot(staleFunnelPublicationSnapshot());
      }
      const status = persistence.reason.includes("not found") ? 404 : 503;
      return complete(failureSnapshot(persistence.reason, status));
    }

    return complete(createSuccessSnapshot({ blueprint, funnelId, mode: payload.mode, persistence, score }));
  } catch {
    try {
      const recovered = await findPersistedFunnelSubmissionByIdempotency({
        databaseFunnelId: stored.funnelId,
        submissionIdempotencyHash: domainIdempotencyHash,
        workspaceId: stored.workspaceId,
      });
      if (recovered.persisted) {
        return complete(createSuccessSnapshot({ blueprint, funnelId, mode: payload.mode, persistence: recovered, score }));
      }
    } catch {
      return unavailableResponse();
    }
    return complete(failureSnapshot("temporarily_unavailable", 503));
  }
}
