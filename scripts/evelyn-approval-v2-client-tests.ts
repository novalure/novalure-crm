import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  EVELYN_PREVIEW_AUDIENCE,
  EVELYN_PREVIEW_URL,
  EVELYN_V2_PREVIEW_URL,
  EvelynApprovalError,
  canonicalEvelynJson,
  createEvelynApprovalClientForTests,
  createEvelynApprovalV2ClientForTests,
  evelynActionHash,
  evelynRequestJti,
  evelynRequestJtiV2,
  type EvelynApprovalAction,
  type EvelynApprovalActionV2,
  type EvelynCreateApprovalRequest,
  type EvelynCreateApprovalRequestV2,
  type EvelynVerifyRequestV2,
} from "../src/lib/evelyn-approval-client";
import {
  approvalActionV2Hash,
  financialSnapshotHash,
  financialSnapshotV1Schema,
  type CompleteFinancialSnapshotV1,
  type FinancialSnapshotV1,
  type MoneyV2,
} from "../src/lib/evelyn-money-tax-v2";

// Simulated transport contract tests only; never evidence of live identity.
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.VERCEL;

const EVELYN_V2_COMMIT = "1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc";
const GOLDEN_SNAPSHOT_HASH = "38f8d55c2596589418a2e0c77945bd593f59e1f2c6944b20f4e6a5bd2a17a878";
const GOLDEN_ACTION_HASH = "0af65619511af89dcd49588296207c2521538904d4b4877336bbdfe46cebac0b";
const INSTANT = "2026-09-18T12:00:00.000Z";
const id = (suffix: string) => `20000000-0000-4000-8000-000000000${suffix}`;
const money = (minorUnits: string, currency = "EUR", minorUnitExponent = 2): MoneyV2 => ({ minorUnits, currency, minorUnitExponent });
const reference = (name: string, version: string, digit: string) => ({
  id: `SYNTHETIC:${name}`,
  version,
  contentHash: digit.repeat(64),
});

function goldenSnapshot(): CompleteFinancialSnapshotV1 {
  return {
    snapshotSchemaVersion: "financial-snapshot-v1",
    snapshotId: id("201"),
    businessVersion: 1,
    tenantId: id("203"),
    resourceId: id("205"),
    reviewState: "COMPLETE",
    effectiveAt: INSTANT,
    currency: "EUR",
    minorUnitExponent: 2,
    currencyDefinition: {
      standard: "ISO-4217",
      code: "EUR",
      minorUnitExponent: 2,
      registryReference: reference("currency-registry", "2026-09-18", "1"),
      verifiedAt: INSTANT,
    },
    jurisdiction: "SYNTHETIC:BUSINESS",
    components: [{
      componentId: "line-setup",
      kind: "LINE",
      net: money("2037000"),
      tax: money("10000"),
      gross: money("2047000"),
      pricingReference: reference("line-price", "1", "2"),
      taxComponents: [{
        componentId: "tax-setup",
        amount: money("10000"),
        policy: {
          reference: reference("tax-policy", "7", "3"),
          jurisdiction: "SYNTHETIC:TAX",
          sourceProvenance: {
            authority: "SYNTHETIC authority",
            sourceReference: "SYNTHETIC controlled source",
            jurisdiction: "SYNTHETIC:TAX",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            effectiveTo: null,
            policyVersion: "7",
            verifiedAt: INSTANT,
          },
        },
      }],
    }],
    totals: { net: money("2037000"), tax: money("10000"), gross: money("2047000") },
    roundingPolicy: reference("rounding", "4", "4"),
    pricingReference: reference("accepted-offer", "9", "5"),
    provenance: {
      sourceSystem: "SYNTHETIC CRM",
      sourceRecordId: id("206"),
      sourceVersion: "11",
      sourceHash: "6".repeat(64),
      recordedAt: INSTANT,
      recordedBy: id("207"),
    },
  };
}

function actionFor(snapshot: FinancialSnapshotV1): EvelynApprovalActionV2 {
  return {
    actionContractVersion: "approval-action-v2",
    actionId: id("301"),
    workflowId: id("302"),
    tenantId: snapshot.tenantId,
    requestingActorId: id("304"),
    correlationId: id("307"),
    actionType: "contract.send",
    resourceType: "Contract",
    resourceId: snapshot.resourceId,
    actionVersion: 1,
    resourceVersion: snapshot.businessVersion,
    payload: {
      recipient: { id: id("306"), email: "synthetic-buyer@example.invalid" },
      contract: { id: snapshot.resourceId, version: 1, content: "SYNTHETIC deterministic V2 contract vector" },
      scope: { projectId: id("308"), description: "SYNTHETIC deterministic Preview-only scope" },
    },
    financialSnapshot: snapshot,
    financialSnapshotHash: financialSnapshotHash(snapshot),
    economicCommitment: { basis: "NET", amount: snapshot.totals.net },
  };
}

function fixture(snapshot: FinancialSnapshotV1 = goldenSnapshot()) {
  const action = actionFor(snapshot);
  const actionHash = approvalActionV2Hash({ ...action, environment: "preview", synthetic: true });
  const create: EvelynCreateApprovalRequestV2 = {
    contractVersion: "create-approval-request-v2",
    requestId: id("309"),
    correlationId: action.correlationId,
    action,
    actionHash,
    policyEvidence: {
      financialTotalKnown: snapshot.reviewState === "COMPLETE",
      standardContract: false,
      approvedOffer: true,
      customerAccepted: true,
      approvedTemplate: false,
    },
    policyReferences: {
      approvedOfferId: id("310"),
      customerAcceptanceId: id("311"),
      approvedTemplateId: null,
    },
  };
  const verify: EvelynVerifyRequestV2 = {
    contractVersion: "verify-approval-v2",
    approvalReference: id("312"),
    tenantId: action.tenantId,
    actionId: action.actionId,
    actionType: action.actionType,
    resourceId: action.resourceId,
    actionVersion: action.actionVersion,
    actionHash,
    financialSnapshotSchemaVersion: "financial-snapshot-v1",
    financialSnapshotHash: action.financialSnapshotHash,
    economicCommitment: structuredClone(action.economicCommitment),
    correlationId: create.correlationId,
  };
  const created = {
    contractVersion: "create-approval-request-v2" as const,
    environment: "preview" as const,
    approvalReference: verify.approvalReference,
    actionId: action.actionId,
    actionVersion: action.actionVersion,
    actionHash,
    financialSnapshotHash: action.financialSnapshotHash,
    requiredSteps: snapshot.reviewState === "COMPLETE" ? 2 as const : null,
    status: snapshot.reviewState === "COMPLETE" ? "PENDING" as const : "NEEDS_REVIEW" as const,
    auditReference: id("314"),
    correlationId: create.correlationId,
  };
  const valid = {
    contractVersion: "approval-bridge-v2" as const,
    environment: "preview" as const,
    status: "VALID" as const,
    approvalReference: verify.approvalReference,
    correlationId: create.correlationId,
  };
  return { action, create, verify, created, valid };
}

type TestTokenOptions = { audience: string; jti: string; skipCache: true };
type HarnessOptions = {
  status?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  getToken?: (options?: TestTokenOptions) => Promise<string>;
};
function harness(response: unknown = fixture().valid, options: HarnessOptions = {}) {
  const requests: { url: string; options: RequestInit }[] = [];
  const tokenOptions: (TestTokenOptions | undefined)[] = [];
  const responseStatus = options.status ?? 200;
  const getToken = options.getToken ?? (async token => token ? "request-bound-test-token" : "test-transport-token");
  const client = createEvelynApprovalV2ClientForTests(id("203"), {
    fetch: options.fetch ?? (async (url, init) => {
      requests.push({ url: String(url), options: init! });
      return Response.json(response, { status: responseStatus });
    }),
    getToken: async token => { tokenOptions.push(token); return getToken(token); },
    nonce: () => id("399"),
    timeoutMs: options.timeoutMs ?? 1000,
  });
  return { client, requests, tokenOptions };
}
const denied = (code: string) => (error: unknown) => error instanceof EvelynApprovalError && error.code === code;

function needsReview(source: CompleteFinancialSnapshotV1): FinancialSnapshotV1 {
  return financialSnapshotV1Schema.parse({
    ...structuredClone(source),
    reviewState: "NEEDS_REVIEW",
    effectiveAt: null,
    currencyDefinition: null,
    components: null,
    totals: { net: structuredClone(source.totals.net), tax: null, gross: null },
    roundingPolicy: null,
    missingFields: ["effectiveAt", "currencyDefinition", "components", "totals.tax", "totals.gross", "roundingPolicy"],
  });
}

function switchCurrency(source: CompleteFinancialSnapshotV1, currency: string): CompleteFinancialSnapshotV1 {
  const snapshot = structuredClone(source);
  snapshot.currency = currency;
  snapshot.currencyDefinition.code = currency;
  for (const component of snapshot.components) {
    for (const value of [component.net, component.tax, component.gross]) value.currency = currency;
    for (const tax of component.taxComponents) tax.amount.currency = currency;
  }
  for (const value of Object.values(snapshot.totals)) value.currency = currency;
  return snapshot;
}

function expectedJti(body: unknown, operation: "create" | "verify") {
  const nonce = id("399");
  const value = {
    contractVersion: operation === "create" ? "evelyn-approval-request-v2" : "evelyn-approval-v2",
    method: "POST",
    path: operation === "create" ? "/api/v2/approvals/requests" : "/api/v2/approvals/verify",
    body,
  };
  return `${nonce}.${createHash("sha256").update(canonicalEvelynJson(value)).digest("hex")}`;
}

test("Evelyn V2 client is pinned to the reviewed contract, golden hashes and route-bound JTI domains", () => {
  assert.equal(EVELYN_V2_COMMIT, "1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc");
  const f = fixture();
  assert.equal(f.action.financialSnapshotHash, GOLDEN_SNAPSHOT_HASH);
  assert.equal(f.create.actionHash, GOLDEN_ACTION_HASH);
  assert.equal(evelynRequestJtiV2(id("399"), f.create, "create"), expectedJti(f.create, "create"));
  assert.equal(evelynRequestJtiV2(id("399"), f.verify, "verify"), expectedJti(f.verify, "verify"));
  assert.notEqual(evelynRequestJtiV2(id("399"), f.create, "create"), evelynRequestJti(id("399"), f.create, "create"));
});

test("Evelyn V2 registers the 20,370 EUR net commitment as two-step pending on the exact V2 route", async () => {
  const f = fixture(), h = harness(f.created);
  assert.deepEqual(await h.client.requestApprovalV2(f.create), f.created);
  assert.equal(h.requests[0].url, EVELYN_V2_PREVIEW_URL + "/api/v2/approvals/requests");
  const init = h.requests[0].options, headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer request-bound-test-token");
  assert.equal(headers.get("x-vercel-trusted-oidc-idp-token"), "test-transport-token");
  assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
  const sent = JSON.parse(String(init.body));
  assert.equal("environment" in sent.action, false); assert.equal("synthetic" in sent.action, false);
  assert.deepEqual(h.tokenOptions, [{
    audience: EVELYN_PREVIEW_AUDIENCE,
    jti: evelynRequestJtiV2(headers.get("x-evelyn-request-nonce")!, sent, "create"),
    skipCache: true,
  }, undefined]);
});

test("Evelyn V2 sends the same UUID normalization used by the pinned action/hash contract", async () => {
  const f = fixture();
  f.create.action.actionId = "ABCDEF00-0000-4000-8000-000000000301";
  f.create.actionHash = approvalActionV2Hash({ ...f.create.action, environment: "preview", synthetic: true });
  const created = { ...f.created, actionId: f.create.action.actionId.toLowerCase(), actionHash: f.create.actionHash };
  const h = harness(created);
  assert.deepEqual(await h.client.requestApprovalV2(f.create), created);
  assert.equal(JSON.parse(String(h.requests[0].options.body)).action.actionId, created.actionId);
});

test("Evelyn V2 Verify sends exactly twelve fields and returns only a strictly bound VALID result", async () => {
  const f = fixture(), h = harness(f.valid);
  assert.deepEqual(await h.client.verifyApprovalV2(f.verify), f.valid);
  assert.equal(h.requests[0].url, EVELYN_V2_PREVIEW_URL + "/api/v2/approvals/verify");
  assert.deepEqual(Object.keys(JSON.parse(String(h.requests[0].options.body))).sort(), [
    "contractVersion", "approvalReference", "tenantId", "actionId", "actionType", "resourceId", "actionVersion",
    "actionHash", "financialSnapshotSchemaVersion", "financialSnapshotHash", "economicCommitment", "correlationId",
  ].sort());
});

test("Evelyn V2 preserves explicit NEEDS_REVIEW creation state and never invents steps", async () => {
  const f = fixture(needsReview(goldenSnapshot())), h = harness(f.created);
  assert.deepEqual(await h.client.requestApprovalV2(f.create), f.created);
  const cancelled = { ...f.created, status: "CANCELLED" as const };
  assert.deepEqual(await harness(cancelled).client.requestApprovalV2(f.create), cancelled);
  await assert.rejects(harness({ ...f.created, status: "PENDING" }).client.requestApprovalV2(f.create), denied("MALFORMED_RESPONSE"));
  await assert.rejects(harness({ ...f.created, requiredSteps: 1 }).client.requestApprovalV2(f.create), denied("MALFORMED_RESPONSE"));
});

for (const status of ["INVALID", "PENDING", "EXPIRED", "REJECTED", "VERSION_MISMATCH", "ACTION_MISMATCH",
  "TENANT_MISMATCH", "NEEDS_REVIEW", "POLICY_REQUIRED"] as const) {
  test(`Evelyn V2 Verify fails closed for ${status}`, async () => {
    const f = fixture();
    await assert.rejects(harness({ ...f.valid, status }).client.verifyApprovalV2(f.verify), denied(status));
  });
}

test("Evelyn V2 rejects unsupported money policy locally before identity or network access", async () => {
  const f = fixture(switchCurrency(goldenSnapshot(), "USD")), h = harness();
  await assert.rejects(h.client.requestApprovalV2(f.create), denied("POLICY_REQUIRED"));
  assert.equal(h.tokenOptions.length, 0); assert.equal(h.requests.length, 0);
});

test("Evelyn V2 rejects response widening, financial binding changes and V1 substitutions", async () => {
  const f = fixture();
  for (const response of [null, [], {}, { ...f.valid, approved: true }, { ...f.valid, environment: "production" },
    { ...f.valid, contractVersion: "approval-bridge-v1" }, { ...f.valid, status: "approved" }]) {
    await assert.rejects(harness(response).client.verifyApprovalV2(f.verify), denied("MALFORMED_RESPONSE"));
  }
  for (const response of [{ ...f.valid, approvalReference: id("350") }, { ...f.valid, correlationId: id("350") }]) {
    await assert.rejects(harness(response).client.verifyApprovalV2(f.verify), denied("RESPONSE_BINDING_MISMATCH"));
  }
  for (const response of [{ ...f.created, requiredSteps: 1 }, { ...f.created, status: "NEEDS_REVIEW" },
    { ...f.created, auditReference: "" }, { ...f.created, approved: true },
    { ...f.created, contractVersion: "create-approval-request-v1" }]) {
    await assert.rejects(harness(response).client.requestApprovalV2(f.create), denied("MALFORMED_RESPONSE"));
  }
  for (const field of ["actionId", "actionVersion", "actionHash", "financialSnapshotHash", "correlationId"] as const) {
    await assert.rejects(harness({ ...f.created, [field]: "changed" }).client.requestApprovalV2(f.create), denied("RESPONSE_BINDING_MISMATCH"));
  }
});

test("Evelyn V2 rejects malformed, oversized and cross-version requests before credentials or network", async () => {
  const f = fixture(), h = harness();
  for (const input of [{ ...f.verify, environment: "preview" }, { ...f.verify, contractVersion: "verify-approval-v1" },
    { ...f.verify, financialSnapshotHash: "invalid" }, { ...f.verify, economicCommitment: { basis: "GROSS", amount: null } }]) {
    await assert.rejects(h.client.verifyApprovalV2(input as EvelynVerifyRequestV2), denied("INVALID_INPUT"));
  }
  await assert.rejects(h.client.requestApprovalV2({ ...f.create, contractVersion: "create-approval-request-v1" } as unknown as EvelynCreateApprovalRequestV2), denied("INVALID_INPUT"));
  await assert.rejects(h.client.requestApprovalV2({ ...f.create, actionHash: "0".repeat(64) }), denied("ACTION_MISMATCH"));
  const nonsynthetic = structuredClone(f.create);
  nonsynthetic.action.payload.contract.content = "not synthetic";
  nonsynthetic.actionHash = approvalActionV2Hash({ ...nonsynthetic.action, environment: "preview", synthetic: true });
  await assert.rejects(h.client.requestApprovalV2(nonsynthetic), denied("INVALID_INPUT"));

  const oversized = structuredClone(f.create);
  oversized.action.payload.contract.content = "SYNTHETIC " + "x".repeat(18_000);
  oversized.actionHash = approvalActionV2Hash({ ...oversized.action, environment: "preview", synthetic: true });
  await assert.rejects(h.client.requestApprovalV2(oversized), denied("REQUEST_TOO_LARGE"));
  assert.equal(h.tokenOptions.length, 0); assert.equal(h.requests.length, 0);
});

test("Evelyn V2 maps network, identity, malformed body, oversized body and timeout failures to closed errors", async () => {
  const f = fixture();
  await assert.rejects(harness(f.valid, { fetch: async () => { throw new Error("private-provider-token"); } }).client.verifyApprovalV2(f.verify), denied("SERVICE_UNAVAILABLE"));
  await assert.rejects(harness(f.valid, { getToken: async () => { throw new Error("private-provider-token"); } }).client.verifyApprovalV2(f.verify), denied("SERVICE_UNAVAILABLE"));
  await assert.rejects(harness(f.valid, { getToken: () => new Promise<string>(() => {}), timeoutMs: 15 }).client.verifyApprovalV2(f.verify), denied("TIMEOUT"));
  await assert.rejects(harness(f.valid, { fetch: () => new Promise<Response>(() => {}), timeoutMs: 15 }).client.verifyApprovalV2(f.verify), denied("TIMEOUT"));
  for (const response of [
    new Response("not json", { headers: { "content-type": "application/json" } }),
    new Response("<html>Authentication</html>", { headers: { "content-type": "text/html" } }),
    new Response(" ".repeat(16_385), { headers: { "content-type": "application/json" } }),
  ]) {
    await assert.rejects(harness(undefined, { fetch: async () => response }).client.verifyApprovalV2(f.verify), denied("MALFORMED_RESPONSE"));
  }
});

for (const status of [400, 401, 403, 409, 413, 429, 500, 502, 503]) {
  test(`Evelyn V2 rejects HTTP ${status} even when the body looks VALID`, async () => {
    const f = fixture();
    await assert.rejects(harness(f.valid, { status }).client.verifyApprovalV2(f.verify), denied(`HTTP_${status}`));
  });
}

test("Evelyn V2 snapshots request bytes before asynchronous token acquisition", async () => {
  const f = fixture();
  let release!: (value: string) => void;
  const firstToken = new Promise<string>(resolve => { release = resolve; });
  let calls = 0;
  const h = harness(f.created, { getToken: async options => {
    calls += 1;
    return options ? firstToken : "test-transport-token";
  } });
  const pending = h.client.requestApprovalV2(f.create);
  f.create.correlationId = id("360");
  f.create.action.payload.contract.content = "SYNTHETIC changed after dispatch";
  release("request-bound-test-token");
  assert.equal((await pending).correlationId, id("307"));
  assert.equal(calls, 2);
  const sent = JSON.parse(String(h.requests[0].options.body));
  assert.equal(sent.correlationId, id("307"));
  assert.equal(sent.action.payload.contract.content, "SYNTHETIC deterministic V2 contract vector");
});

function v1Fixture() {
  const v1id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const action: EvelynApprovalAction = {
    actionId: v1id(1), workflowId: v1id(2), tenantId: v1id(3), requestingActorId: v1id(4),
    actionType: "contract.send", resourceType: "Contract", resourceId: v1id(5),
    actionVersion: 1, resourceVersion: 1, amount: 2_037_000, currency: "EUR", net: true,
    payload: {
      recipient: { id: v1id(6), email: "synthetic-buyer@example.invalid" },
      contract: { id: v1id(5), version: 1, content: "SYNTHETIC 9900 EUR + 3 x 3490 EUR" },
      scope: { projectId: v1id(7), description: "SYNTHETIC preview contract" },
      price: { netCents: 2_037_000, currency: "EUR" },
    },
  };
  const actionHash = evelynActionHash(action);
  const create: EvelynCreateApprovalRequest = {
    contractVersion: "create-approval-request-v1", requestId: v1id(8), correlationId: v1id(9), action, actionHash,
    policyEvidence: { financialTotalKnown: true, standardContract: false, approvedOffer: true, customerAccepted: true, approvedTemplate: false },
    policyReferences: { approvedOfferId: v1id(10), customerAcceptanceId: v1id(11), approvedTemplateId: null },
  };
  const created = {
    contractVersion: "create-approval-request-v1" as const, environment: "preview" as const, approvalReference: v1id(12),
    actionId: action.actionId, actionVersion: 1, actionHash, requiredSteps: 2 as const, status: "PENDING" as const,
    auditReference: v1id(14), correlationId: create.correlationId,
  };
  return { v1id, action, create, created };
}

test("the additive V2 client leaves V1 hashes, JTI domains, route and V1-only client shape unchanged", async () => {
  const f = v1Fixture(), requests: string[] = [];
  assert.equal(f.create.actionHash, "56da5b62c3ecb7a25f00b512ef4430558e061ed2e26cf398de692a29a576914f");
  assert.equal(evelynRequestJti(f.v1id(13), f.create, "create"), f.v1id(13) + ".da52ae27e039521550bad6b8065d6d42d4950d8e0377411f50d41d0869b61ade");
  const client = createEvelynApprovalClientForTests(f.action.tenantId, {
    fetch: async url => { requests.push(String(url)); return Response.json(f.created); },
    getToken: async options => options ? "request-token" : "protection-token",
    nonce: () => f.v1id(13), timeoutMs: 1000,
  });
  assert.deepEqual(Object.keys(client).sort(), ["requestApproval", "verifyApproval"]);
  assert.deepEqual(await client.requestApproval(f.create), f.created);
  assert.deepEqual(requests, [EVELYN_PREVIEW_URL + "/api/v1/approvals/requests"]);
  await assert.rejects(client.requestApproval(fixture().create as unknown as EvelynCreateApprovalRequest), denied("INVALID_INPUT"));
});
