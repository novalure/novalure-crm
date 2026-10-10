import { NextResponse } from "next/server";
import {
  buildPublicSubmissionScope,
  createPublicSubmissionIdempotencyHashes,
  createPublicSubmissionOpaqueHash,
  createPublicSubmissionRateLimitPolicies,
  normalizePublicSubmissionIdentifier,
  type PublicSubmissionResponseSnapshot,
} from "@/lib/security/public-submission-abuse";
import {
  claimPublicSubmissionIdempotency,
  completePublicSubmissionIdempotency,
  consumePublicSubmissionRateLimits,
} from "@/lib/db/public-submission-abuse-repository";
import { persistWebsiteFormSubmission } from "@/lib/db/form-repositories";
import {
  createWebsiteSalesReference,
  parseWebsiteSalesLeadPayload,
  resolveWebsiteSalesClientIp,
  verifyWebsiteSalesSignature,
  websiteSalesFormId,
  websiteSalesWorkspaceId,
} from "@/lib/website-sales-ingestion";

const cacheHeaders = { "cache-control": "private, no-store" };
const maxBodyBytes = 12_000;

function responseFromSnapshot(snapshot: PublicSubmissionResponseSnapshot) {
  if (snapshot.kind !== "json") throw new Error("Website Sales endpoint only supports JSON responses");
  return NextResponse.json(snapshot.body, { headers: cacheHeaders, status: snapshot.status });
}

function failure(status: number, error: string) {
  return NextResponse.json({ error }, { headers: cacheHeaders, status });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!contentType.includes("application/json")) return failure(415, "unsupported_content_type");
  if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBodyBytes) {
    return failure(413, "submission_too_large");
  }

  const rawBody = await request.text();
  if (!rawBody || Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) return failure(413, "submission_too_large");
  if (!verifyWebsiteSalesSignature({
    body: rawBody,
    secret: process.env.NOVALURE_STUDIO_INGESTION_SECRET,
    signature: request.headers.get("x-novalure-signature"),
    timestamp: request.headers.get("x-novalure-timestamp"),
  })) {
    return failure(401, "unauthorized");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return failure(400, "invalid_json");
  }
  const payload = parseWebsiteSalesLeadPayload(parsed);
  const clientIp = resolveWebsiteSalesClientIp(request.headers.get("x-novalure-client-ip"));
  if (!payload) return failure(400, "invalid_submission");
  if (!clientIp) return failure(400, "invalid_client_ip");

  const scope = buildPublicSubmissionScope({
    resourceId: websiteSalesFormId,
    resourceType: "form",
    workspaceId: websiteSalesWorkspaceId,
  });
  const hashes = createPublicSubmissionIdempotencyHashes({
    action: "website_form",
    idempotencyKey: payload.idempotencyKey,
    requestFingerprint: createPublicSubmissionOpaqueHash({ label: "request-body", value: rawBody }),
    scope,
  });

  let claim;
  try {
    claim = await claimPublicSubmissionIdempotency(hashes);
  } catch {
    return failure(503, "temporarily_unavailable");
  }
  if (claim.state === "replay") return responseFromSnapshot(claim.response);
  if (claim.state === "processing" || claim.state === "conflict") {
    return failure(409, claim.state === "processing" ? "submission_in_progress" : "submission_replay_conflict");
  }

  const complete = async (snapshot: PublicSubmissionResponseSnapshot) => {
    try {
      await completePublicSubmissionIdempotency({
        idempotencyHash: hashes.idempotencyHash,
        requestHash: hashes.requestHash,
        response: snapshot,
      });
      return responseFromSnapshot(snapshot);
    } catch {
      return failure(503, "temporarily_unavailable");
    }
  };

  try {
    const rateLimit = await consumePublicSubmissionRateLimits({
      policies: createPublicSubmissionRateLimitPolicies({
        action: "website_form",
        clientIp,
        identifier: normalizePublicSubmissionIdentifier(payload.email, "email"),
        scope,
      }),
    });
    if (!rateLimit.allowed) return complete({ body: { error: "rate_limited" }, kind: "json", status: 429 });
  } catch {
    return complete({ body: { error: "temporarily_unavailable" }, kind: "json", status: 503 });
  }

  const formData = new FormData();
  const fields: Record<string, string> = {
    company: payload.company ?? "",
    current_website_url: payload.currentWebsiteUrl ?? "",
    email: payload.email,
    message: payload.message,
    name: payload.name,
    package_interest: payload.packageInterest,
    phone: payload.phone ?? "",
    privacy: "true",
    synthetic_test: payload.syntheticTest ? "true" : "false",
  };
  const attributionFields: Record<string, string> = {
    landingPage: "landing_page",
    pageUrl: "page_url",
    referrer: "referrer",
    utmCampaign: "utm_campaign",
    utmContent: "utm_content",
    utmMedium: "utm_medium",
    utmSource: "utm_source",
    utmTerm: "utm_term",
  };
  for (const [sourceKey, formKey] of Object.entries(attributionFields)) {
    const value = (payload.attribution ?? {})[sourceKey];
    if (typeof value === "string") fields[formKey] = value;
  }
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);

  try {
    const persistence = await persistWebsiteFormSubmission({
      formData,
      formKey: websiteSalesFormId,
      requestUrl: String((payload.attribution ?? {}).pageUrl || "https://novalurestudio.ie/"),
    });
    if (!persistence.persisted) return complete({ body: { error: "temporarily_unavailable" }, kind: "json", status: 503 });
    return complete({ body: { accepted: true, reference: createWebsiteSalesReference() }, kind: "json", status: 202 });
  } catch (error) {
    console.error("website_sales_ingestion_failed", { reason: error instanceof Error ? error.message : "unknown" });
    return complete({ body: { error: "temporarily_unavailable" }, kind: "json", status: 503 });
  }
}
