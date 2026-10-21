import { NextResponse } from "next/server";
import { executeStudioEnquiry, studioEnquiryTargetVerified } from "@/lib/studio-enquiry";
import { studioEnquiryCandidateRequestAllowed } from "@/lib/studio-enquiry-candidate";
import { StudioEnquiryError, parseStudioEnquiryRequest, studioEnquiryMaxBodyBytes,
  studioEnquiryRecipientsAllowed, verifyStudioEnquirySignature, verifyStudioSyntheticTestProof,
  studioEnquiryRequestOriginAllowed, studioEnquiryStudioOrigin, studioEnquiryStudioProject,
  studioEnquiryPolicy, studioEnquiryPublicPolicy } from "@/lib/studio-enquiry-contract";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const failure = (status: number, error: string) => NextResponse.json({ error }, { status, headers });
const safeErrors = new Set(["invalid_enquiry", "contact_required", "enquiry_not_reserved", "enquiry_conflict", "files_not_copied",
  "copied_file_mismatch", "private_storage_unavailable", "workspace_storage_limit", "crm_persistence_unconfirmed"]);

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure(415, "unsupported_content_type");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > studioEnquiryMaxBodyBytes)) return failure(413, "enquiry_too_large");
  let raw = "";
  try {
    const reader = request.body?.getReader();
    if (!reader) return failure(400, "invalid_enquiry");
    const chunks: Uint8Array[] = []; let count = 0;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      count += next.value.byteLength;
      if (count > studioEnquiryMaxBodyBytes) { await reader.cancel(); return failure(413, "enquiry_too_large"); }
      chunks.push(next.value);
    }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch { return failure(400, "invalid_enquiry"); }
  if (!verifyStudioEnquirySignature(raw, request.headers.get("x-novalure-timestamp"),
    request.headers.get("x-novalure-signature"), process.env.STUDIO_ENQUIRY_SIGNING_SECRET)) return failure(401, "unauthorized");
  try {
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return failure(400, "invalid_enquiry"); }
    const payload = parseStudioEnquiryRequest(parsed);
    if (request.headers.get("idempotency-key") !== payload.operationId) return failure(400, "invalid_idempotency_key");
    if (payload.snapshot.consent.policyVersion !== (process.env.VERCEL_ENV === "production" ? studioEnquiryPublicPolicy : studioEnquiryPolicy)) {
      return failure(400,"privacy_policy_not_current");
    }
    if (process.env.VERCEL_ENV === "production") {
      if (!studioEnquiryRequestOriginAllowed(request) ||
          request.headers.get("x-studio-origin") !== studioEnquiryStudioOrigin ||
          request.headers.get("x-studio-project-id") !== studioEnquiryStudioProject) return failure(403, "studio_origin_not_allowed");
      if (payload.snapshot.syntheticTest && !verifyStudioSyntheticTestProof(payload,
        request.headers.get("x-studio-synthetic-test-proof"))) return failure(403, "synthetic_test_not_authorized");
    } else {
      if (!studioEnquiryRecipientsAllowed(payload.snapshot)) return failure(403, "qa_recipient_not_allowed");
      if (process.env.STUDIO_ENQUIRY_CANDIDATE_ENABLED === "1" &&
          (!studioEnquiryCandidateRequestAllowed(request) || !payload.snapshot.syntheticTest ||
           payload.snapshot.files.length !== 0 || payload.snapshot.websites.length !== 0)) {
        return failure(403, "candidate_request_not_allowed");
      }
    }
    if (!await studioEnquiryTargetVerified()) return failure(503, "studio_qa_target_unverified");
    const result = await executeStudioEnquiry(payload);
    return NextResponse.json(result, { headers, status: result.status === "transmitted" ? 202 : 200 });
  } catch (error) {
    let cause: unknown = error;
    for (let i = 0; i < 4 && cause instanceof Error && !(cause instanceof StudioEnquiryError) && cause.cause; i++) cause = cause.cause;
    if (cause instanceof StudioEnquiryError && safeErrors.has(cause.code)) return failure(cause.status, cause.code);
    console.error("studio_enquiry_failed", { reason: "operation_unconfirmed" });
    return failure(503, "enquiry_temporarily_unavailable");
  }
}
