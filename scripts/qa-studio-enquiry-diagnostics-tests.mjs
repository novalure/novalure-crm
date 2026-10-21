// Unit security tests only: fake fetch responses and an in-memory owner port.
// These assertions provide no HTTP, database, runtime-role or deployment proof.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attestStudioEnquiryCandidate, studioCandidateHttpDiagnostic } from "./lib/qa-studio-enquiry-candidate.mjs";
import { verifyStudioEnquirySignature } from "../src/lib/studio-enquiry-contract.ts";

const origin = "http://127.0.0.1:3000";
const secret = "SYNTHETIC-UNIT-ONLY-SIGNING-KEY-DO-NOT-USE";
const sentinels = ["https://private-unit.example.invalid/do-not-log", "SYNTHETIC_PASSWORD_DO_NOT_LOG", "SYNTHETIC_SIGNATURE_DO_NOT_LOG"];
const fields = ["phase", "expectedHttpStatus", "actualHttpStatus", "responseJsonState", "apiErrorCode"];
const workspace = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const leadId = "53513767-3319-44af-bf5f-028699308dac";
const submissionId = "9c1a892f-479a-4cef-8c70-0662898730fe";

function harness(override = () => undefined) {
  const calls = [];
  let payload, accepted = false, queryCount = 0;
  const receipt = () => ({ accepted: true, operationId: payload.operationId, workspaceId: workspace,
    revision: payload.revision, payloadHash: payload.payloadHash, reference: "NL-1234ABCD",
    crmLeadId: leadId, formSubmissionId: submissionId, attachments: [] });
  const owner = { async query(sql) {
    queryCount++;
    if (sql.includes("from studio_enquiry_transfers")) return { rows: [{ state: "accepted", lead_id: leadId,
      submission_id: submissionId, payload_hash: payload.payloadHash, mode: "test", synthetic: "true",
      lead_synthetic: "true", lead_operation: payload.operationId }] };
    assert.ok(sql.includes("from form_submissions"), "only the expected count query reaches the unit port");
    return { rows: [{ submissions: accepted ? 1 : 0, business_submissions: 0, business_leads: 0 }] };
  } };
  const fetch = async (url, init) => {
    assert.equal(url, `${origin}/api/public/website-sales/enquiry`);
    assert.equal(init.method, "POST");
    payload = JSON.parse(init.body);
    const call = { action: payload.action, headers: init.headers, body: init.body };
    calls.push(call);
    let response = override(call, calls.length - 1);
    if (!response) {
      if (init.headers["x-novalure-signature"] === "invalid") response = { status: 401, body: { error: "unauthorized" } };
      else if (payload.action === "reserve") response = { status: 200, body: { ...payload, status: "reserved", targets: [] } };
      else {
        accepted = true;
        response = { status: 202, body: { ...payload, status: "transmitted", receipt: receipt() } };
      }
    }
    return new Response(response.invalidJson ? sentinels.join(" ") : JSON.stringify(response.body),
      { status: response.status, headers: { "content-type": "application/json" } });
  };
  return { calls, get queryCount() { return queryCount; },
    run: () => attestStudioEnquiryCandidate({ owner, base: origin,
      email: "studio-candidate-1234567-1@example.invalid", secret, fetch }) };
}

async function failure(probe, code) {
  let caught;
  await assert.rejects(probe.run, error => { caught = error; return error instanceof Error && error.message === code; });
  return caught;
}

function diagnostic(error, expected) {
  const value = studioCandidateHttpDiagnostic(error);
  assert.deepEqual(Object.keys(value), fields);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(value, expected);
  // This is the JSON payload used by the integration catch; no response is copied.
  const serialized = JSON.stringify(value) + String(error);
  for (const sentinel of [...sentinels, secret]) assert.equal(serialized.includes(sentinel), false);
  assert.throws(() => { value.apiErrorCode = sentinels[0]; }, TypeError);
  return value;
}

test("known reserve rejection reports only the exact allowlisted HTTP diagnosis", async () => {
  const probe = harness(() => ({ status: 403, body: { error: "candidate_request_not_allowed", private: sentinels } }));
  const error = await failure(probe, "QA_STUDIO_RESERVE_HTTP_FAILED");
  diagnostic(error, { phase: "reserve", expectedHttpStatus: 200, actualHttpStatus: 403,
    responseJsonState: "VALID_JSON", apiErrorCode: "candidate_request_not_allowed" });
  assert.deepEqual(probe.calls.map(call => call.action), ["reserve"]);
  assert.equal(probe.queryCount, 1);
});

test("unknown server error text and nested sensitive data never enter the diagnosis", async () => {
  const probe = harness(() => ({ status: 503, body: { error: sentinels.join(" "),
    url: sentinels[0], password: sentinels[1], signature: sentinels[2], nested: { secret } } }));
  diagnostic(await failure(probe, "QA_STUDIO_RESERVE_HTTP_FAILED"), {
    phase: "reserve", expectedHttpStatus: 200, actualHttpStatus: 503,
    responseJsonState: "VALID_JSON", apiErrorCode: "UNRECOGNIZED" });
  assert.equal(probe.calls.length, 1);
});

test("known 503 target failure remains distinct from an unrecognized server error", async () => {
  const probe = harness(() => ({ status: 503, body: { error: "studio_qa_target_unverified" } }));
  diagnostic(await failure(probe, "QA_STUDIO_RESERVE_HTTP_FAILED"), {
    phase: "reserve", expectedHttpStatus: 200, actualHttpStatus: 503,
    responseJsonState: "VALID_JSON", apiErrorCode: "studio_qa_target_unverified" });
});

for (const status of [200, 503]) test(`invalid JSON at HTTP ${status} has an explicit parse state and never advances`, async () => {
  const probe = harness(() => ({ status, invalidJson: true }));
  diagnostic(await failure(probe, status === 200 ? "QA_STUDIO_RESPONSE_JSON_INVALID" : "QA_STUDIO_RESERVE_HTTP_FAILED"), {
    phase: "reserve", expectedHttpStatus: 200, actualHttpStatus: status,
    responseJsonState: "INVALID_JSON", apiErrorCode: "NONE" });
  assert.equal(probe.calls.length, 1);
  assert.equal(probe.queryCount, 1);
});

test("error-code matching is exact and never coerces structured or extended values", async () => {
  for (const error of [null, ["candidate_request_not_allowed"], { code: "candidate_request_not_allowed" },
    "candidate_request_not_allowed\n" + sentinels[0], "CANDIDATE_REQUEST_NOT_ALLOWED"]) {
    const probe = harness(() => ({ status: 403, body: { error } }));
    diagnostic(await failure(probe, "QA_STUDIO_RESERVE_HTTP_FAILED"), { phase: "reserve", expectedHttpStatus: 200,
      actualHttpStatus: 403, responseJsonState: "VALID_JSON", apiErrorCode: "UNRECOGNIZED" });
  }
  const probe = harness(() => ({ status: 503, body: [sentinels[0]] }));
  diagnostic(await failure(probe, "QA_STUDIO_RESERVE_HTTP_FAILED"), { phase: "reserve", expectedHttpStatus: 200,
    actualHttpStatus: 503, responseJsonState: "VALID_JSON", apiErrorCode: "NONE" });
});

test("formatter refuses arbitrary errors and forged diagnostic properties", () => {
  const forged = { phase: "reserve", expectedHttpStatus: 200, actualHttpStatus: 503,
    responseJsonState: "VALID_JSON", apiErrorCode: sentinels[0] };
  for (const value of [null, undefined, "QA_STUDIO_RESERVE_HTTP_FAILED", { diagnostic: forged },
    Object.assign(new Error("QA_STUDIO_RESERVE_HTTP_FAILED"), { diagnostic: forged }),
    Object.assign(new Error(sentinels.join(" ")), { diagnostic: forged })]) {
    assert.equal(studioCandidateHttpDiagnostic(value), null);
  }
});

test("HTTP 200 containing an API error is not accepted as a successful reserve", async () => {
  const probe = harness(() => ({ status: 200, body: { error: "candidate_request_not_allowed", private: sentinels } }));
  const error = await failure(probe, "QA_STUDIO_RESERVE_IDENTITY_FAILED");
  assert.equal(studioCandidateHttpDiagnostic(error), null);
  assert.equal(sentinels.some(value => String(error).includes(value)), false);
  assert.equal(probe.calls.length, 1);
  assert.equal(probe.queryCount, 1);
});

test("a legitimate HTTP 200 reserve advances and a later HTTP failure retains its own phase", async () => {
  const probe = harness((_call, index) => index === 1 ? { status: 503, body: { error: "enquiry_temporarily_unavailable" } } : undefined);
  diagnostic(await failure(probe, "QA_STUDIO_FINALIZE_HTTP_FAILED"), { phase: "finalize", expectedHttpStatus: 202,
    actualHttpStatus: 503, responseJsonState: "VALID_JSON", apiErrorCode: "enquiry_temporarily_unavailable" });
  assert.deepEqual(probe.calls.map(call => call.action), ["reserve", "finalize"]);
  assert.equal(probe.queryCount, 2);
});

test("successful fake responses retain all original status, identity and signature expectations", async () => {
  const probe = harness();
  assert.deepEqual(await probe.run(), { contract: "studio-enquiry-v1", schema: "100", textOnly: true,
    reserve: "PASS", finalize: "PASS", durableIdentity: "PASS", replay: "PASS", status: "PASS",
    syntheticKpi: "PASS", signature: "PASS" });
  assert.deepEqual(probe.calls.map(call => call.action), ["reserve", "finalize", "finalize", "status", "status"]);
  for (const call of probe.calls.slice(0, -1)) assert.equal(verifyStudioEnquirySignature(call.body,
    call.headers["x-novalure-timestamp"], call.headers["x-novalure-signature"], secret), true);
  assert.equal(probe.calls.at(-1).headers["x-novalure-signature"], "invalid");
  assert.equal(probe.queryCount, 4);
});
