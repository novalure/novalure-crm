import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createEvelynApprovalClient, createEvelynApprovalClientForTests, evelynActionHash,
  evelynRequestJti, EvelynApprovalError, EVELYN_PREVIEW_URL, EVELYN_PREVIEW_AUDIENCE,
  type EvelynApprovalAction, type EvelynCreateApprovalRequest, type EvelynVerifyRequest,
} from "../src/lib/evelyn-approval-client";

// These tests are simulated transport/contract tests, never evidence of live identity.
Object.assign(process.env, { NODE_ENV: "test" });
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const action: EvelynApprovalAction = {
    actionId: id(1), workflowId: id(2), tenantId: id(3), requestingActorId: id(4),
    actionType: "contract.send", resourceType: "Contract", resourceId: id(5),
    actionVersion: 1, resourceVersion: 1, amount: 2_037_000, currency: "EUR", net: true,
    payload: { recipient: { id: id(6), email: "synthetic-buyer@example.invalid" },
      contract: { id: id(5), version: 1, content: "SYNTHETIC 9900 EUR + 3 x 3490 EUR" },
      scope: { projectId: id(7), description: "SYNTHETIC preview contract" },
      price: { netCents: 2_037_000, currency: "EUR" } },
  };
  const actionHash = evelynActionHash(action);
  const create: EvelynCreateApprovalRequest = {
    contractVersion: "create-approval-request-v1", requestId: id(8), correlationId: id(9), action, actionHash,
    policyEvidence: { financialTotalKnown: true, standardContract: false, approvedOffer: true, customerAccepted: true, approvedTemplate: false },
    policyReferences: { approvedOfferId: id(10), customerAcceptanceId: id(11), approvedTemplateId: null },
  };
  const verify: EvelynVerifyRequest = { approvalReference: id(12), tenantId: action.tenantId, actionId: action.actionId,
    actionType: action.actionType, resourceId: action.resourceId, actionVersion: action.actionVersion,
    actionHash, correlationId: create.correlationId };
  const created = { contractVersion: "create-approval-request-v1", environment: "preview", approvalReference: id(12),
    actionId: action.actionId, actionVersion: 1, actionHash, requiredSteps: 2, status: "PENDING", auditReference: id(14), correlationId: create.correlationId };
  const valid = { contractVersion: "approval-bridge-v1", environment: "preview", status: "VALID", approvalReference: id(12), correlationId: create.correlationId };
  return { action, create, verify, created, valid };
}
function harness(response: unknown = fixture().valid, options: { status?: number; timeoutMs?: number; fetch?: typeof fetch; token?: () => Promise<string> } = {}) {
  const requests: { url: string; options: RequestInit }[] = [];
  const tokenOptions: unknown[] = [];
  const client = createEvelynApprovalClientForTests(id(3), {
    fetch: options.fetch ?? (async (url, options) => {
      requests.push({ url: String(url), options: options! });
      return Response.json(response, { status: optionsStatus });
    }),
    getToken: async options => { tokenOptions.push(options); return optionsToken ? optionsToken() : options ? "request-bound-test-token" : "test-transport-token"; },
    nonce: randomUUID, timeoutMs: options.timeoutMs ?? 1000,
  });
  const optionsStatus = options.status ?? 200, optionsToken = options.token;
  return { client, requests, tokenOptions };
}
const denied = (code: string) => (error: unknown) => error instanceof EvelynApprovalError && error.code === code;

test("Evelyn contract golden: hashes and route JTIs match exact pinned Evelyn implementation", () => {
  // Generated read-only using Evelyn's actual bridgeActionHash/requestJti at requested commit.
  const f = fixture();
  assert.equal(f.create.actionHash, "56da5b62c3ecb7a25f00b512ef4430558e061ed2e26cf398de692a29a576914f");
  assert.equal(evelynRequestJti(id(13), f.create, "create"), id(13) + ".da52ae27e039521550bad6b8065d6d42d4950d8e0377411f50d41d0869b61ade");
  assert.equal(evelynRequestJti(id(13), f.verify, "verify"), id(13) + ".e45474dd7ea51197a58029c30ab243bda2176e1daa77c947f086be364bf9771e");
});

test("Evelyn client registers 20,370 EUR as two-step pending with separate request/protection credentials", async () => {
  const f = fixture(), h = harness(f.created);
  assert.deepEqual(await h.client.requestApproval(f.create), f.created);
  assert.equal(h.requests[0].url, EVELYN_PREVIEW_URL + "/api/v1/approvals/requests");
  const options = h.requests[0].options, headers = new Headers(options.headers);
  assert.equal(headers.get("authorization"), "Bearer request-bound-test-token");
  assert.equal(headers.get("x-vercel-trusted-oidc-idp-token"), "test-transport-token");
  assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store");
  const input = JSON.parse(String(options.body));
  assert.equal("environment" in input.action, false); assert.equal("synthetic" in input.action, false);
  assert.deepEqual(h.tokenOptions, [{ audience: EVELYN_PREVIEW_AUDIENCE,
    jti: evelynRequestJti(headers.get("x-evelyn-request-nonce")!, input, "create"), skipCache: true }, undefined]);
});

test("Evelyn Verify sends exactly eight fields and returns only a strictly bound VALID response", async () => {
  const f = fixture(), h = harness(f.valid);
  assert.deepEqual(await h.client.verifyApproval(f.verify), f.valid);
  assert.equal(h.requests[0].url, EVELYN_PREVIEW_URL + "/api/v1/approvals/verify");
  assert.deepEqual(Object.keys(JSON.parse(String(h.requests[0].options.body))).sort(),
    ["approvalReference", "tenantId", "actionId", "actionType", "resourceId", "actionVersion", "actionHash", "correlationId"].sort());
});

for (const status of ["INVALID", "PENDING", "EXPIRED", "REJECTED", "VERSION_MISMATCH", "ACTION_MISMATCH", "TENANT_MISMATCH"]) {
  test(`Evelyn fail closed: ${status} never authorizes execution`, async () => {
    const f = fixture(), h = harness({ ...f.valid, status });
    await assert.rejects(h.client.verifyApproval(f.verify), denied(status));
  });
}
for (const status of [400, 401, 403, 409, 429, 500, 502, 503]) {
  test(`Evelyn fail closed: HTTP ${status} rejects even a VALID-looking body`, async () => {
    const f = fixture(), h = harness(f.valid, { status });
    await assert.rejects(h.client.verifyApproval(f.verify), denied(`HTTP_${status}`));
  });
}

test("Evelyn fail closed: unreachable, token failure, body failure and timeout expose no credential detail", async () => {
  const f = fixture();
  for (const options of [
    { fetch: async () => { throw new Error("private-provider-token"); } },
    { token: async () => { throw new Error("private-provider-token"); } },
  ]) await assert.rejects(harness(f.valid, options).client.verifyApproval(f.verify), denied("SERVICE_UNAVAILABLE"));
  await assert.rejects(harness(f.valid, { token: () => new Promise<string>(() => {}), timeoutMs: 15 }).client.verifyApproval(f.verify), denied("TIMEOUT"));
  await assert.rejects(harness(f.valid, { fetch: () => new Promise<Response>(() => {}), timeoutMs: 15 }).client.verifyApproval(f.verify), denied("TIMEOUT"));
  const hungBody = new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
  await assert.rejects(harness(f.valid, { fetch: async () => hungBody, timeoutMs: 15 }).client.verifyApproval(f.verify), denied("TIMEOUT"));
});

test("Evelyn fail closed: invalid JSON, HTML/protection response and oversized response", async () => {
  for (const response of [
    new Response("not json", { headers: { "content-type": "application/json" } }),
    new Response("<html>Authentication</html>", { headers: { "content-type": "text/html" } }),
    new Response(" ".repeat(16_385), { headers: { "content-type": "application/json" } }),
  ]) await assert.rejects(harness(undefined, { fetch: async () => response }).client.verifyApproval(fixture().verify), denied("MALFORMED_RESPONSE"));
});

test("Evelyn fail closed: response schema and authority bindings cannot be widened", async () => {
  const f = fixture();
  for (const response of [null, [], {}, { ...f.valid, approved: true }, { ...f.valid, environment: "production" },
    { ...f.valid, contractVersion: "v2" }, { ...f.valid, status: "approved" }]) {
    await assert.rejects(harness(response).client.verifyApproval(f.verify), denied("MALFORMED_RESPONSE"));
  }
  for (const response of [{ ...f.valid, approvalReference: id(50) }, { ...f.valid, correlationId: id(50) }]) {
    await assert.rejects(harness(response).client.verifyApproval(f.verify), denied("RESPONSE_BINDING_MISMATCH"));
  }
  for (const response of [{ ...f.created, requiredSteps: 1 }, { ...f.created, auditReference: "" }, { ...f.created, approved: true }]) {
    await assert.rejects(harness(response).client.requestApproval(f.create), denied("MALFORMED_RESPONSE"));
  }
  for (const field of ["actionId", "actionVersion", "actionHash", "correlationId"] as const) {
    await assert.rejects(harness({ ...f.created, [field]: "changed" }).client.requestApproval(f.create), denied("RESPONSE_BINDING_MISMATCH"));
  }
});

test("Evelyn fail closed: malformed request and wrong tenant are denied before identity/network calls", async () => {
  const f = fixture(), h = harness();
  for (const input of [{ ...f.verify, environment: "preview" }, { ...f.verify, approvalReference: "" }, { ...f.verify, actionVersion: 0 },
    { ...f.verify, actionHash: "invalid" }, { ...f.verify, actionType: "offer.send" }]) {
    await assert.rejects(h.client.verifyApproval(input), denied("INVALID_INPUT"));
  }
  await assert.rejects(h.client.verifyApproval({ ...f.verify, tenantId: id(50) }), denied("TENANT_MISMATCH"));
  await assert.rejects(h.client.requestApproval({ ...f.create, action: { ...f.action, tenantId: id(50) } }), denied("TENANT_MISMATCH"));
  await assert.rejects(h.client.requestApproval({ ...f.create, actionHash: "0".repeat(64) }), denied("ACTION_MISMATCH"));
  assert.equal(h.requests.length, 0); assert.equal(h.tokenOptions.length, 0);
});

test("Evelyn action integrity: price, recipient, content, tenant, resource and versions change the hash", () => {
  const f = fixture();
  const actions = [
    { ...f.action, amount: 2_037_100, payload: { ...f.action.payload, price: { ...f.action.payload.price, netCents: 2_037_100 } } },
    { ...f.action, actionVersion: 2 }, { ...f.action, resourceVersion: 2 }, { ...f.action, resourceId: id(50) }, { ...f.action, tenantId: id(50) },
    { ...f.action, payload: { ...f.action.payload, recipient: { ...f.action.payload.recipient, email: "other@example.invalid" } } },
    { ...f.action, payload: { ...f.action.payload, contract: { ...f.action.payload.contract, content: "SYNTHETIC changed" } } },
  ];
  for (const action of actions) assert.notEqual(evelynActionHash(action), f.create.actionHash);
});

test("Evelyn retries keep business identity/body and mint distinct route-bound transport nonces", async () => {
  const f = fixture(), h = harness(f.created);
  assert.deepEqual(await h.client.requestApproval(f.create), await h.client.requestApproval(f.create));
  assert.equal(h.requests[0].options.body, h.requests[1].options.body);
  const first = new Headers(h.requests[0].options.headers), second = new Headers(h.requests[1].options.headers);
  assert.notEqual(first.get("x-evelyn-request-nonce"), second.get("x-evelyn-request-nonce"));
  const verify = harness(f.valid);
  await verify.client.verifyApproval(f.verify); await verify.client.verifyApproval(f.verify);
  assert.equal(verify.requests.length, 2);
  assert.notDeepEqual(verify.tokenOptions[0], verify.tokenOptions[2]);
});

test("Evelyn request is immutable while asynchronous identity acquisition runs", async () => {
  const f = fixture(), h = harness(f.created);
  const pending = h.client.requestApproval(f.create);
  f.create.correlationId = id(60); f.create.action.payload.contract.content = "SYNTHETIC changed after dispatch";
  assert.equal((await pending).correlationId, id(9));
  const sent = JSON.parse(String(h.requests[0].options.body));
  assert.equal(sent.correlationId, id(9)); assert.equal(sent.action.payload.contract.content, "SYNTHETIC 9900 EUR + 3 x 3490 EUR");
});

test("Evelyn production factory refuses local, production, wrong-project and custom environments", () => {
  const keys = ["VERCEL", "VERCEL_ENV", "VERCEL_TARGET_ENV", "VERCEL_PROJECT_ID"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const environment of [{}, { VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: "prj_R32Okl6AHijTohvuKmryuTLjWMsk" },
      { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_PROJECT_ID: "prj_evelyn" },
      { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "staging", VERCEL_PROJECT_ID: "prj_R32Okl6AHijTohvuKmryuTLjWMsk" }]) {
      for (const key of keys) delete process.env[key]; Object.assign(process.env, environment);
      assert.throws(() => createEvelynApprovalClient(id(3)), denied("REAL_CRM_PREVIEW_REQUIRED"));
    }
    process.env.VERCEL = "1";
    assert.throws(() => harness(), denied("TEST_TRANSPORT_FORBIDDEN"));
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
});
