import { randomUUID } from "node:crypto";
import { buildStudioEnquirySignature, parseStudioEnquiryRequest, studioEnquiryHash,
  studioEnquiryPolicy } from "../../src/lib/studio-enquiry-contract.ts";

const workspace = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const form = "0f98b9fd-d300-4a34-a14c-54a1a61b2415";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const requireProof = (condition, code) => { if (!condition) throw new Error(code); };
const httpPhases = {
  reserve: [200, "QA_STUDIO_RESERVE_HTTP_FAILED"],
  finalize: [202, "QA_STUDIO_FINALIZE_HTTP_FAILED"],
  replay_finalize: [202, "QA_STUDIO_REPLAY_HTTP_FAILED"],
  status: [202, "QA_STUDIO_STATUS_HTTP_FAILED"],
  signature: [401, "QA_STUDIO_SIGNATURE_BYPASS"],
};
const apiErrorCodes = new Set([
  "unsupported_content_type", "enquiry_too_large", "invalid_enquiry", "unauthorized",
  "invalid_idempotency_key", "privacy_policy_not_current", "studio_origin_not_allowed",
  "synthetic_test_not_authorized", "qa_recipient_not_allowed", "candidate_request_not_allowed",
  "studio_qa_target_unverified", "enquiry_temporarily_unavailable", "contact_required",
  "enquiry_not_reserved", "enquiry_conflict", "files_not_copied", "copied_file_mismatch",
  "private_storage_unavailable", "workspace_storage_limit", "crm_persistence_unconfirmed",
]);
class StudioCandidateHttpError extends Error {
  constructor(phase, response) {
    const [expectedHttpStatus, code] = httpPhases[phase];
    super(response.status === expectedHttpStatus ? "QA_STUDIO_RESPONSE_JSON_INVALID" : code);
    const error = response.body && typeof response.body === "object" && !Array.isArray(response.body)
      ? response.body.error : undefined;
    this.diagnostic = Object.freeze({ phase, expectedHttpStatus,
      actualHttpStatus: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0,
      responseJsonState: response.jsonValid ? "VALID_JSON" : "INVALID_JSON",
      apiErrorCode: error === undefined ? "NONE" : apiErrorCodes.has(error) ? error : "UNRECOGNIZED" });
  }
}
export function studioCandidateHttpDiagnostic(error) {
  return error instanceof StudioCandidateHttpError ? error.diagnostic : null;
}
function requireHttp(response, phase) {
  if (response.status !== httpPhases[phase][0] || !response.jsonValid) {
    throw new StudioCandidateHttpError(phase, response);
  }
}

/** The standalone 100 text-only intake contract; deliberately no legacy 097 endpoint or file I/O. */
export async function attestStudioEnquiryCandidate({ owner, base, email, secret, fetch: send = globalThis.fetch }) {
  requireProof(base === "http://127.0.0.1:3000" &&
    /^studio-candidate-[1-9][0-9]*-[1-9][0-9]*@example\.invalid$/.test(email) &&
    typeof secret === "string" && Buffer.byteLength(secret) >= 32, "QA_STUDIO_INPUT_INVALID");
  const snapshot = { schemaVersion: "studio-enquiry-snapshot-v1", conversationId: randomUUID(),
    confirmedAt: new Date().toISOString(), consent: { privacy: true, policyVersion: studioEnquiryPolicy },
    brief: { values: { name: "SYNTHETIC Candidate Studio", email, contactMethod: "email", goals: "Synthetic website" },
      summary: "SYNTHETIC isolated candidate enquiry; no outbound actions.", openQuestions: [] },
    files: [], websites: [], syntheticTest: true };
  const payload = parseStudioEnquiryRequest({ version: "studio-enquiry-v1", action: "reserve",
    operationId: randomUUID(), revision: 1, payloadHash: studioEnquiryHash(JSON.stringify(snapshot)), snapshot });
  const post = async (action, tampered = false) => {
    const body = JSON.stringify({ ...payload, action });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await send(`${base}/api/public/website-sales/enquiry`, { method: "POST", body,
      headers: { "content-type": "application/json", "idempotency-key": payload.operationId,
        "x-novalure-timestamp": timestamp, "x-novalure-signature": tampered ? "invalid"
          : buildStudioEnquirySignature(body, timestamp, secret) }, signal: AbortSignal.timeout(30_000) });
    try { return { status: response.status, body: await response.json(), jsonValid: true }; }
    catch { return { status: response.status, body: null, jsonValid: false }; }
  };
  const counts = async () => (await owner.query(`select
    (select count(*)::int from form_submissions where form_id=$1::uuid) as submissions,
    (select submissions_count from forms where id=$1::uuid) as business_submissions,
    (select count(*)::int from leads where workspace_id=$2::uuid and metadata->>'businessLine'='WEBSITE_SALES'
      and (metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true') as business_leads`, [form, workspace])).rows[0];
  const sameOperation = body => body?.operationId === payload.operationId && body.revision === 1 && body.payloadHash === payload.payloadHash;
  const before = await counts();
  const reserved = await post("reserve");
  requireHttp(reserved, "reserve");
  requireProof(reserved.body?.status === "reserved" && sameOperation(reserved.body) &&
    Array.isArray(reserved.body.targets) && reserved.body.targets.length === 0, "QA_STUDIO_RESERVE_IDENTITY_FAILED");
  const beforeFinalize = await counts();
  requireProof(beforeFinalize.submissions === before.submissions, "QA_STUDIO_RESERVE_PUBLISHED_EARLY");
  const first = await post("finalize");
  requireHttp(first, "finalize");
  const receipt = first.body?.receipt;
  requireProof(first.body?.status === "transmitted" && sameOperation(first.body) && receipt?.accepted === true &&
    receipt.operationId === payload.operationId && receipt.workspaceId === workspace && receipt.revision === 1 &&
    receipt.payloadHash === payload.payloadHash && /^NL-[0-9A-F]{8}$/.test(receipt.reference) &&
    uuid.test(receipt.crmLeadId) && uuid.test(receipt.formSubmissionId) &&
    Array.isArray(receipt.attachments) && receipt.attachments.length === 0, "QA_STUDIO_RECEIPT_INVALID");
  for (const action of ["finalize", "status"]) {
    const replay = await post(action);
    requireHttp(replay, action === "status" ? "status" : "replay_finalize");
    requireProof(sameOperation(replay.body) && replay.body.status === "transmitted" &&
      JSON.stringify(replay.body.receipt) === JSON.stringify(receipt), "QA_STUDIO_REPLAY_RECEIPT_CHANGED");
  }
  const after = await counts();
  requireProof(after.submissions === before.submissions + 1, "QA_STUDIO_SUBMISSION_CARDINALITY_FAILED");
  requireProof(after.business_leads === before.business_leads && after.business_submissions === before.business_submissions,
    "QA_STUDIO_SYNTHETIC_KPI_CHANGED");
  const persisted = (await owner.query(`select t.state,t.lead_id,t.submission_id,t.payload_hash,
    t.snapshot_text::jsonb->>'syntheticTest' as synthetic,fs.mode,
    l.metadata #>> '{websiteSales,syntheticTest}' as lead_synthetic,
    l.metadata #>> '{studioEnquiry,operationId}' as lead_operation
    from studio_enquiry_transfers t join form_submissions fs on fs.id=t.submission_id and fs.workspace_id=t.workspace_id
    join leads l on l.id=t.lead_id and l.workspace_id=t.workspace_id
    where t.operation_id=$1::uuid and t.workspace_id=$2::uuid`, [payload.operationId, workspace])).rows;
  requireProof(persisted.length === 1 && persisted[0].state === "accepted" && persisted[0].lead_id === receipt.crmLeadId &&
    persisted[0].submission_id === receipt.formSubmissionId && persisted[0].payload_hash === payload.payloadHash &&
    persisted[0].mode === "test" && persisted[0].synthetic === "true" && persisted[0].lead_synthetic === "true" &&
    persisted[0].lead_operation === payload.operationId, "QA_STUDIO_DURABLE_IDENTITY_FAILED");
  requireHttp(await post("status", true), "signature");
  return { contract: "studio-enquiry-v1", schema: "100", textOnly: true, reserve: "PASS", finalize: "PASS",
    durableIdentity: "PASS", replay: "PASS", status: "PASS", syntheticKpi: "PASS", signature: "PASS" };
}
