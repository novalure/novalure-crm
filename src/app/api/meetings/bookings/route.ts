import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import {
  createMeetingBookingWithNotifications,
  getPublicMeetingPageSettings,
  listMeetingBookingOverview,
} from "@/lib/db/meeting-repositories";
import {
  claimPublicSubmissionIdempotency,
  completePublicSubmissionIdempotency,
  consumePublicSubmissionRateLimits,
} from "@/lib/db/public-submission-abuse-repository";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { buildPublicMeetingPath } from "@/lib/public-routing";
import { publicSubmissionControlFields } from "@/lib/public-submission-contract";
import {
  bookingSubmissionBodyLimits,
  buildPublicSubmissionScope,
  createPublicSubmissionIdempotencyHashes,
  createPublicSubmissionRateLimitPolicies,
  getPublicSubmissionProof,
  getTrustedPublicSubmissionClientIp,
  hasPublicSubmissionHoneypotValue,
  normalizePublicSubmissionIdentifier,
  publicSubmissionActions,
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionFormData,
  shouldSuppressPublicSubmissionExternalEffects,
  stripPublicSubmissionControlFields,
  validatePublicSubmissionFieldRules,
  verifyPublicSubmissionProof,
  type PublicSubmissionResponseSnapshot,
} from "@/lib/security/public-submission-abuse";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getLimit(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 50;
}

function resolveCalendarProvider(formData: FormData) {
  const calendarProvider = getFormValue(formData, "calendar");
  const meetingProvider = getFormValue(formData, "meeting");

  if (calendarProvider === "microsoft" || calendarProvider === "google") return calendarProvider;
  if (meetingProvider === "microsoft-teams") return "microsoft";
  if (meetingProvider === "google-meet") return "google";
  return "none";
}

function resolveMeetingProvider(formData: FormData) {
  const meetingProvider = getFormValue(formData, "meeting");
  const calendarProvider = getFormValue(formData, "calendar");

  if (meetingProvider === "microsoft-teams" || meetingProvider === "google-meet" || meetingProvider === "manual-link") {
    return meetingProvider;
  }

  if (calendarProvider === "microsoft") return "microsoft-teams";
  if (calendarProvider === "google") return "google-meet";
  return "manual-link";
}

const bookingFieldRules = [
  { maxLength: 96, name: "slug" },
  { maxLength: 128, name: "workspace_public_key" },
  { maxLength: 8, name: "lang" },
  { maxLength: 32, name: "calendar" },
  { maxLength: 32, name: "meeting" },
  { maxLength: 10, name: "selectedDate" },
  { maxLength: 16, name: "theme" },
  { maxLength: 128, name: "utm_source" },
  { maxLength: 5, name: "slot" },
  { maxLength: 160, name: "name" },
  { maxLength: 320, name: "email" },
  { maxLength: 2_000, name: "note" },
  { maxLength: 128, name: publicSubmissionControlFields.idempotencyKey },
  { maxLength: 16, name: publicSubmissionControlFields.issuedAt },
  { maxLength: 16, name: publicSubmissionControlFields.expiresAt },
  { maxLength: 128, name: publicSubmissionControlFields.proof },
  { maxLength: 256, name: publicSubmissionControlFields.honeypot },
];

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const payload = await listMeetingBookingOverview({
    limit: getLimit(url),
    session: auth.session,
  });

  return NextResponse.json(payload);
}

export async function POST(request: Request) {
  let parsed: Awaited<ReturnType<typeof readBoundedPublicSubmissionFormData>>;
  try {
    parsed = await readBoundedPublicSubmissionFormData(request, bookingSubmissionBodyLimits);
    validatePublicSubmissionFieldRules(parsed.formData, bookingFieldRules);
  } catch (error) {
    const reason = error instanceof PublicSubmissionRequestError
      ? error.code
      : "temporarily_unavailable";
    return bookingFailureResponse({ reason, requestUrl: request.url });
  }

  const formData = parsed.formData;
  const slug = getFormValue(formData, "slug");
  const workspacePublicKey = getFormValue(formData, "workspace_public_key");
  const redirectPath = workspacePublicKey
    ? buildPublicMeetingPath({ slug: slug || "pipeline-audit", workspacePublicKey })
    : `/book/${slug || "pipeline-audit"}`;
  const redirectUrl = new URL(redirectPath, request.url);

  const page = workspacePublicKey && slug
    ? await getPublicMeetingPageSettings({ slug, workspacePublicKey }).catch(() => null)
    : null;
  if (!page?.id || !page.workspaceId) {
    return bookingFailureResponse({
      redirectUrl,
      reason: "meeting_page_not_found",
      requestUrl: request.url,
    });
  }

  const scope = buildPublicSubmissionScope({
    resourceId: page.id,
    resourceType: "meeting",
    workspaceId: page.workspaceId,
  });
  let proofValidation: ReturnType<typeof verifyPublicSubmissionProof>;
  let hashes: ReturnType<typeof createPublicSubmissionIdempotencyHashes>;
  try {
    proofValidation = verifyPublicSubmissionProof({
      action: publicSubmissionActions.booking,
      proof: getPublicSubmissionProof(formData),
      scope,
    });
    if (!proofValidation.ok) {
      return bookingFailureResponse({
        redirectUrl,
        reason: proofValidation.reason,
        requestUrl: request.url,
      });
    }
    hashes = createPublicSubmissionIdempotencyHashes({
      action: publicSubmissionActions.booking,
      idempotencyKey: proofValidation.proof.idempotencyKey,
      requestFingerprint: parsed.requestFingerprint,
      scope,
    });
  } catch {
    return bookingFailureResponse({
      redirectUrl,
      reason: "temporarily_unavailable",
      requestUrl: request.url,
    });
  }

  let claim: Awaited<ReturnType<typeof claimPublicSubmissionIdempotency>>;
  try {
    claim = await claimPublicSubmissionIdempotency(hashes);
  } catch {
    return unavailableResponse();
  }
  if (claim.state === "replay") return responseFromSnapshot(claim.response);
  if (claim.state === "processing") {
    return bookingFailureResponse({ redirectUrl, reason: "submission_in_progress", requestUrl: request.url });
  }
  if (claim.state === "conflict") {
    return bookingFailureResponse({ redirectUrl, reason: "submission_replay_conflict", requestUrl: request.url });
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
    return complete(createBookingFailureSnapshot(redirectUrl, "temporarily_unavailable"));
  }

  try {
    const identifier = normalizePublicSubmissionIdentifier(
      getFormValue(formData, "email"),
      "email",
    );
    const rateLimit = await consumePublicSubmissionRateLimits({
      policies: createPublicSubmissionRateLimitPolicies({
        action: publicSubmissionActions.booking,
        clientIp,
        identifier,
        scope,
      }),
    });
    if (!rateLimit.allowed) {
      return complete(createBookingFailureSnapshot(redirectUrl, "rate_limited"));
    }
  } catch {
    return complete(createBookingFailureSnapshot(redirectUrl, "temporarily_unavailable"));
  }

  if (hasPublicSubmissionHoneypotValue(formData)) {
    return complete(createBookingFailureSnapshot(redirectUrl, "submission_rejected"));
  }

  stripPublicSubmissionControlFields(formData);
  const suppressExternalEffects = shouldSuppressPublicSubmissionExternalEffects({
    workspaceId: page.workspaceId,
  });

  try {
    const result = await createMeetingBookingWithNotifications({
      calendarProvider: resolveCalendarProvider(formData),
      contactEmail: getFormValue(formData, "email"),
      contactName: getFormValue(formData, "name"),
      contactNote: getFormValue(formData, "note"),
      meetingProvider: resolveMeetingProvider(formData),
      requestUrl: request.url,
      selectedDate: getFormValue(formData, "selectedDate"),
      slot: getFormValue(formData, "slot"),
      slug,
      source: getFormValue(formData, "utm_source") || "booking_page",
      suppressExternalEffects,
      workspacePublicKey,
    });

    if (!result.persisted) {
      return complete(
        createBookingFailureSnapshot(
          redirectUrl,
          normalizeBookingFailureReason(result.reason),
          getFormValue(formData, "selectedDate"),
        ),
      );
    }

    const processed = !suppressExternalEffects && result.finalConfirmationJobId
      ? await processDueMeetingNotifications({ jobIds: [result.finalConfirmationJobId] })
      : { checked: 0, failed: 0, sent: 0 };

    redirectUrl.searchParams.set("submitted", "1");
    redirectUrl.searchParams.set("booking", result.bookingId || "");
    redirectUrl.searchParams.set("confirmed", result.autoConfirmed ? "1" : "0");
    redirectUrl.searchParams.set("date", getFormValue(formData, "selectedDate"));
    redirectUrl.searchParams.set("meeting_link", result.onlineMeetingUrl ? "1" : "0");
    redirectUrl.searchParams.set("queued", String(result.jobsQueued ?? 0));
    redirectUrl.searchParams.set("sent", String(processed.sent));

    return complete({ kind: "redirect", location: redirectUrl.toString(), status: 303 });
  } catch {
    return complete(createBookingFailureSnapshot(redirectUrl, "temporarily_unavailable"));
  }
}

function normalizeBookingFailureReason(reason?: string) {
  if (reason === "slot_unavailable" || reason === "calendar_sync_failed") return reason;
  if (reason === "meeting_page_ambiguous" || reason === "meeting_page_not_found") return reason;
  return "temporarily_unavailable";
}

function createBookingFailureSnapshot(
  redirectUrl: URL,
  reason: string,
  selectedDate = "",
): PublicSubmissionResponseSnapshot {
  const target = new URL(redirectUrl);
  target.searchParams.set("submitted", "0");
  target.searchParams.set("error", reason);
  if (selectedDate) target.searchParams.set("date", selectedDate);
  return { kind: "redirect", location: target.toString(), status: 303 };
}

function bookingFailureResponse(input: {
  reason: string;
  redirectUrl?: URL;
  requestUrl: string;
}) {
  const redirectUrl = input.redirectUrl ?? new URL("/book/pipeline-audit", input.requestUrl);
  return responseFromSnapshot(createBookingFailureSnapshot(redirectUrl, input.reason));
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
