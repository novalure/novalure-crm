import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PublicRuntimePreviewError,
  assertPublicRuntimeEvidenceSafe,
  canonicalJson,
  executePublicRuntimePreview,
  inspectPublicRuntimeDatabase,
  parsePublicRuntimeActionInput,
  publicRuntimeReadOnlyScenarios,
  scanRepositoryForTokens,
} from "./lib/public-runtime-preview-e2e.mjs";

const gitSha = "a".repeat(40);
const gitRef = "codex/go-live-remediation-20260822";
const deploymentId = `dpl_${"D".repeat(24)}`;
const branchId = "br-lucky-heart-alrm9dlw";
const neonProjectId = "weathered-term-98273025";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";
const crossTenantWorkspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const crossTenantBatchId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const crossTenantActorUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const previewOrigin = "https://candidate-novalure.vercel.app";
const sessionCookie = `novalure_session=${"p".repeat(48)}`;
const crossTenantSessionCookie = `novalure_session=${"x".repeat(48)}`;
const workspacePublicKey = "f".repeat(32);
const projectId = "44444444-4444-4444-8444-444444444444";
const oldToken = "O".repeat(43);
const newToken = "N".repeat(43);
const initialFormProof = Object.freeze({
  expiresAt: 1_800_000_900,
  idempotencyKey: "I".repeat(43),
  issuedAt: 1_800_000_000,
  signature: "S".repeat(43),
});
const refreshedFormProof = Object.freeze({
  expiresAt: 1_800_001_801,
  idempotencyKey: initialFormProof.idempotencyKey,
  issuedAt: 1_800_000_901,
  signature: "T".repeat(43),
});
const initialFunnelProof = Object.freeze({
  expiresAt: 1_800_000_900,
  idempotencyKey: "J".repeat(43),
  issuedAt: 1_800_000_000,
  signature: "U".repeat(43),
});
const refreshedFunnelProof = Object.freeze({
  expiresAt: 1_800_001_801,
  idempotencyKey: initialFunnelProof.idempotencyKey,
  issuedAt: 1_800_000_901,
  signature: "V".repeat(43),
});
const exactAtomicSurfaces = Object.freeze([
  "blueprint",
  "formPublicSubmit",
  "formUpsert",
  "funnelCreate",
  "funnelPublicSubmit",
  "reset",
  "tokenRotation",
]);

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function action(overrides = {}) {
  return parsePublicRuntimeActionInput(JSON.stringify({
    actorUserId,
    batchId,
    batchMarker: "QA-TEST-20260823-1200-primary",
    crossTenantActorUserId,
    crossTenantBatchId,
    crossTenantBatchMarker: "QA-TEST-20260823-1200-secondary",
    crossTenantSessionCookie,
    crossTenantWorkspaceId,
    databaseUrl: "postgresql://novalure_app:bounded-secret@ep-preview.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    expectedDeploymentId: deploymentId,
    expectedGitRef: gitRef,
    expectedGitSha: gitSha,
    expectedNeonBranchId: branchId,
    expectedNeonProjectId: neonProjectId,
    previewOrigin,
    productionDatabaseHost: "ep-production.aws.neon.tech",
    productionOrigin: "https://www.novalure-crm.app",
    sessionCookie,
    workspaceId,
    ...overrides,
  }));
}

function databaseFixture() {
  const fixture = {
    attestation: {
      databaseName: "neondb",
      databaseRole: "novalure_app",
      freshBatch: true,
      isQa: true,
      neonBranchId: branchId,
      neonProjectId,
    },
    contentFingerprintDigest: "1".repeat(64),
  };
  Object.defineProperties(fixture, {
    projectId: { value: projectId },
    workspacePublicKey: { value: workspacePublicKey },
  });
  return fixture;
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { headers, status });
}

function proofHtml(proof) {
  return [
    "<!doctype html><html><body><form>",
    `<input name="_novalure_idempotency_key" value="${proof.idempotencyKey}">`,
    `<input name="_novalure_proof_issued_at" value="${proof.issuedAt}">`,
    `<input name="_novalure_proof_expires_at" value="${proof.expiresAt}">`,
    `<input name="_novalure_proof" value="${proof.signature}">`,
    "</form></body></html>",
  ].join("");
}

function sessionScope(cookie) {
  if (cookie.includes(sessionCookie)) return "primary";
  if (cookie.includes(crossTenantSessionCookie)) return "secondary";
  return "none";
}

function createHarness(options = {}) {
  const state = {
    activeToken: null,
    blueprint: null,
    calls: [],
    csrfCalls: 0,
    form: null,
    formPersisted: 0,
    formSubmissionCalls: 0,
    funnel: null,
    funnelPersisted: 0,
    funnelSubmissionCalls: 0,
    primaryMutated: false,
    repositoryScans: 0,
    resetExecutions: [],
    revision: 0,
  };
  let currentTime = Date.parse("2026-08-23T12:00:00.000Z");

  function requireAuthenticated(headers, scope, expectedBatch = null) {
    assert.equal(sessionScope(headers.get("cookie") ?? ""), scope);
    assert.equal(headers.get("origin"), previewOrigin);
    assert.equal(headers.get("sec-fetch-site"), "same-origin");
    assert.match(headers.get("x-novalure-csrf-token") ?? "", /^[A-Za-z0-9._-]{40,2048}$/u);
    if (expectedBatch) assert.equal(headers.get("x-novalure-qa-batch-id"), expectedBatch);
  }

  function requireAnonymous(headers) {
    assert.equal(sessionScope(headers.get("cookie") ?? ""), "none");
  }

  function capability(scope) {
    const secondary = scope === "secondary";
    const surfaces = Object.fromEntries(exactAtomicSurfaces.map((surface) => [surface, true]));
    if (options.missingSurface) delete surfaces[options.missingSurface];
    return {
      atomicRegistration: true,
      batchCapability: {
        batchId: options.staleBatchId ?? (secondary ? crossTenantBatchId : batchId),
        candidateSha: gitSha,
        deploymentId,
        fresh: true,
        purpose: "public-runtime-preview",
      },
      databaseBranchId: branchId,
      deploymentHost: new URL(previewOrigin).hostname,
      deploymentId,
      gitBranch: gitRef,
      gitSha,
      publicRuntimeAtomicSurfaces: surfaces,
      sessionScope: {
        productRole: "platform_admin",
        role: options.ownerRole ?? "owner",
        source: "cookie",
        userId: secondary ? crossTenantActorUserId : actorUserId,
        workspaceId: secondary ? crossTenantWorkspaceId : workspaceId,
      },
      version: 2,
    };
  }

  function resetPlan(scope) {
    return scope === "primary"
      ? { contacts: 2, form_submissions: 1, forms: 1, funnel_submissions: 1, funnels: 1 }
      : {};
  }

  const fetchImpl = async (value, init = {}) => {
    const url = new URL(value);
    assert.equal(url.origin, previewOrigin);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    const scope = sessionScope(headers.get("cookie") ?? "");
    state.calls.push({
      batchId: url.searchParams.get("batchId"),
      method,
      path: url.pathname,
      qaBatchId: headers.get("x-novalure-qa-batch-id"),
      queryKeys: [...url.searchParams.keys()].sort(),
      scope,
    });

    if (url.pathname === "/api/admin/qa-batch-capability") {
      assert.ok(scope === "primary" || scope === "secondary");
      const expectedBatch = scope === "primary" ? batchId : crossTenantBatchId;
      assert.equal(url.searchParams.get("batchId"), expectedBatch);
      return json(capability(scope));
    }

    if (url.pathname === "/api/auth/csrf") {
      assert.ok(scope === "primary" || scope === "secondary");
      assert.match(url.searchParams.get("method") ?? "", /^(?:POST|PUT)$/u);
      assert.match(url.searchParams.get("path") ?? "", /^\/api\//u);
      assert.equal(headers.get("origin"), previewOrigin);
      assert.equal(headers.get("sec-fetch-site"), "same-origin");
      state.csrfCalls += 1;
      return json({ csrfToken: `${scope === "primary" ? "P" : "X"}${"c".repeat(63)}` });
    }

    if (url.pathname === "/api/admin/qa-reset" && method === "POST") {
      const body = JSON.parse(String(init.body));
      const expectedScope = body.workspaceId === workspaceId ? "primary" : "secondary";
      const expectedBatch = expectedScope === "primary" ? batchId : crossTenantBatchId;
      requireAuthenticated(headers, expectedScope);
      assert.equal(body.batchId, expectedBatch);
      assert.equal(body.workspaceId, expectedScope === "primary" ? workspaceId : crossTenantWorkspaceId);
      const digest = expectedScope === "primary" ? "d".repeat(64) : "e".repeat(64);
      const targetCounts = resetPlan(expectedScope);
      if (body.mode === "dry_run") {
        assert.equal(body.confirmation, null);
        assert.equal(body.expectedPlanDigest, null);
        return json({ outcome: "dry_run", plan: { blockers: [], digest, targetCounts } });
      }
      assert.equal(body.mode, "execute");
      assert.equal(body.expectedPlanDigest, digest);
      assert.equal(body.confirmation, `RESET QA BATCH ${body.workspaceId} ${body.batchId}`);
      state.resetExecutions.push(expectedScope);
      if (expectedScope === "primary") state.primaryMutated = false;
      const deletedCounts = options.cleanupCountMismatch && expectedScope === "primary"
        ? { ...targetCounts, forms: 0 }
        : targetCounts;
      return json({ deletedCounts, outcome: "executed", plan: { digest } });
    }

    if (url.pathname === "/api/forms" && method === "POST") {
      requireAuthenticated(headers, "primary", batchId);
      const body = JSON.parse(String(init.body));
      assert.equal(body.expectedVersion, 0);
      state.form = body.form;
      state.primaryMutated = true;
      return json(
        { form: state.form, persisted: true },
        200,
        { "x-novalure-qa-batch-id": batchId, "x-novalure-qa-batch-registration": "committed" },
      );
    }

    if (url.pathname === "/api/crm/funnels" && method === "POST") {
      requireAuthenticated(headers, "primary", batchId);
      const body = JSON.parse(String(init.body));
      state.funnel = body.funnel;
      state.primaryMutated = true;
      return json(
        { funnel: state.funnel, persisted: true },
        200,
        { "x-novalure-qa-batch-id": batchId, "x-novalure-qa-batch-registration": "committed" },
      );
    }

    if (url.pathname === "/api/forms/resolve") {
      assert.equal(scope, "secondary");
      return options.crossTenantLeak ? json({ form: state.form }) : json({ error: "not_found" }, 404);
    }

    const blueprintMatch = /^\/api\/funnels\/([^/]+)\/blueprint$/u.exec(url.pathname);
    if (blueprintMatch) {
      assert.equal(blueprintMatch[1], state.funnel?.id);
      if (scope === "secondary") {
        return options.crossTenantLeak ? json({ blueprint: state.blueprint, blueprintRevision: 1 }) : json({ error: "not_found" }, 404);
      }
      if (method === "GET") {
        assert.equal(scope, "primary");
        state.blueprint ??= {
          crmHandover: {},
          pages: [{
            id: "qa-page",
            sections: [{
              rows: [{
                columns: [{
                  elements: [{
                    fields: [
                      { crmField: "name", id: "qa-name", label: "Name", required: true, type: "text", validationPattern: ".+" },
                      { crmField: "email", id: "qa-email", label: "Email", required: true, type: "email", validationPattern: ".+@.+" },
                      { crmField: "privacy_consent", helpText: "Privacy", id: "qa-privacy", label: "Privacy", required: true, type: "consent" },
                    ],
                    id: "qa-contact",
                    type: "form",
                  }],
                }],
              }],
            }],
          }],
          status: "entwurf",
          tracking: {},
        };
        return json({ blueprint: state.blueprint, blueprintRevision: 0 });
      }
      requireAuthenticated(headers, "primary", batchId);
      const body = JSON.parse(String(init.body));
      assert.equal(body.expectedBlueprintRevision, 0);
      state.blueprint = body.blueprint;
      assert.equal(state.blueprint.status, "aktiv");
      return json(
        { blueprint: state.blueprint, blueprintRevision: 1, preflight: { ok: true } },
        200,
        { "x-novalure-qa-batch-id": batchId },
      );
    }

    const tokenMatch = /^\/api\/admin\/funnels\/([^/]+)\/publish-token\/cutover$/u.exec(url.pathname);
    if (tokenMatch) {
      assert.equal(tokenMatch[1], state.funnel?.id);
      if (scope === "secondary") return json({ error: "not_found" }, 404);
      if (method === "GET") {
        assert.equal(scope, "primary");
        return json({ revision: state.revision });
      }
      requireAuthenticated(headers, "primary", batchId);
      const body = JSON.parse(String(init.body));
      assert.equal(body.expectedRevision, state.revision);
      state.revision += 1;
      state.activeToken = state.revision === 1 ? oldToken : newToken;
      return json({ publishToken: state.activeToken, revision: state.revision });
    }

    if (url.pathname === "/api/forms/submission-proof" && method === "POST") {
      requireAnonymous(headers);
      if (!(init.body instanceof FormData)) return json({ error: "invalid_form_key" }, 400);
      assert.equal(init.body.get("_novalure_proof"), initialFormProof.signature);
      return json({ proof: refreshedFormProof });
    }

    if (url.pathname === "/api/forms/submissions" && method === "POST") {
      requireAnonymous(headers);
      if (!(init.body instanceof FormData)) return json({ error: "Form not found", persisted: false }, 404);
      const proof = init.body.get("_novalure_proof");
      if (proof === initialFormProof.signature) {
        return options.oldProofAccepted
          ? json({ persisted: true, replayed: false })
          : json({ error: "submission_proof_expired" }, 400);
      }
      assert.equal(proof, refreshedFormProof.signature);
      state.formSubmissionCalls += 1;
      if (state.formSubmissionCalls === 1) {
        state.formPersisted += 1;
        return json({ persisted: true, replayed: false });
      }
      if (state.formSubmissionCalls === 2) return json({ error: "submission_in_progress" }, 409);
      return json({ persisted: true, replayed: true });
    }

    const funnelProofMatch = /^\/api\/funnels\/([^/]+)\/submission-proof$/u.exec(url.pathname);
    if (funnelProofMatch) {
      requireAnonymous(headers);
      if (funnelProofMatch[1] !== state.funnel?.id) return json({ error: "invalid_submission_proof_refresh" }, 400);
      const body = JSON.parse(String(init.body));
      assert.equal(body.proof.signature, initialFunnelProof.signature);
      assert.equal(body.publicationRevision, 1);
      return json({ proof: refreshedFunnelProof, publicationRevision: 1 });
    }

    const funnelSubmissionMatch = /^\/api\/funnels\/([^/]+)\/submissions$/u.exec(url.pathname);
    if (funnelSubmissionMatch) {
      requireAnonymous(headers);
      if (funnelSubmissionMatch[1] !== state.funnel?.id) return json({ error: "invalid_funnel_mode", persisted: false }, 400);
      const body = JSON.parse(String(init.body));
      const proof = body.publicSubmission?.proof;
      if (proof?.signature === initialFunnelProof.signature) return json({ error: "submission_proof_expired" }, 400);
      assert.equal(proof?.signature, refreshedFunnelProof.signature);
      state.funnelSubmissionCalls += 1;
      if (state.funnelSubmissionCalls === 1) {
        state.funnelPersisted += 1;
        return json({ persisted: true, replayed: false });
      }
      if (state.funnelSubmissionCalls === 2) return json({ error: "submission_in_progress" }, 409);
      return json({ persisted: true, replayed: true });
    }

    if (/^\/api\/funnels\/[^/]+\/visits$/u.test(url.pathname)) {
      requireAnonymous(headers);
      return json({ code: "LAUNCH_SCOPE_OFF", error: "funnel_visit_launch_off" }, 503);
    }

    if (url.pathname.startsWith("/forms/")) {
      requireAnonymous(headers);
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length === 2) return new Response("missing", { headers: { "content-type": "text/html" }, status: 404 });
      assert.equal(segments[1], workspacePublicKey);
      assert.equal(segments[2], state.form?.slug);
      return new Response(proofHtml(initialFormProof), { headers: { "content-type": "text/html" }, status: 200 });
    }

    if (url.pathname.startsWith("/preview/")) {
      requireAnonymous(headers);
      const id = url.pathname.split("/").at(-1);
      if (id !== state.funnel?.id || !url.searchParams.has("token")) {
        return new Response("missing", { headers: { "content-type": "text/html" }, status: 404 });
      }
      const token = url.searchParams.get("token");
      if (token === state.activeToken || (options.oldTokenAccepted && token === oldToken)) {
        return new Response(proofHtml(initialFunnelProof), { headers: { "content-type": "text/html" }, status: 200 });
      }
      return json({ error: "invalid_publish_token" }, 404);
    }

    throw new Error(`unexpected test route ${method} ${url.pathname}`);
  };

  const databaseStore = Object.freeze({
    async funnelState(funnelId) {
      assert.equal(funnelId, state.funnel?.id);
      return { blueprintDigest: sha256(canonicalJson(state.blueprint)), revision: state.revision };
    },
    async inventory() {
      return state.primaryMutated
        ? { digest: "2".repeat(64), rowCount: 9 }
        : { digest: "1".repeat(64), rowCount: 0 };
    },
    async remainingBatchObjectCount() {
      return options.remainingObjectCount ?? 0;
    },
    async retainedInventory() {
      return state.resetExecutions.length > 0
        ? { digest: "4".repeat(64), rowCount: 7 }
        : { digest: "3".repeat(64), rowCount: 0 };
    },
    async verifyFormSubmission(formId) {
      assert.equal(formId, state.form?.id);
      assert.equal(state.formPersisted, 1);
      return { digest: "5".repeat(64), submissionId: "55555555-5555-4555-8555-555555555555" };
    },
    async verifyFunnelSubmission(funnelId) {
      assert.equal(funnelId, state.funnel?.id);
      assert.equal(state.funnelPersisted, 1);
      return { digest: "6".repeat(64), submissionId: "66666666-6666-4666-8666-666666666666" };
    },
  });

  return {
    databaseStore,
    fetchImpl,
    now: () => currentTime,
    repositoryScanner(tokens, candidateRoot) {
      assert.deepEqual(tokens, [oldToken, newToken]);
      assert.equal(candidateRoot, "C:/isolated-candidate");
      state.repositoryScans += 1;
      return "7".repeat(64);
    },
    async sleep(milliseconds) {
      currentTime += options.shortElapsed ? milliseconds - 1 : milliseconds;
    },
    state,
  };
}

const passingSourceInspector = async () => ({ mutationEnabledByRunner: true, reasonCode: null, status: "PASS" });

async function executeHarness(harness, options = {}) {
  return executePublicRuntimePreview({
    databaseInspector: async () => databaseFixture(),
    databaseStore: harness.databaseStore,
    env: { NOVALURE_REPOSITORY_ROOT: "C:/isolated-candidate" },
    fetchImpl: harness.fetchImpl,
    input: action(),
    now: harness.now,
    repositoryScanner: harness.repositoryScanner,
    requireLocalIdentity: false,
    sleep: harness.sleep,
    sourceInspector: options.sourceInspector ?? (options.missingProducer
      ? async () => ({ mutationEnabledByRunner: false, reasonCode: "PUBLIC_MUTATION_ATOMIC_CLEANUP_UNAVAILABLE", status: "BLOCKED" })
      : passingSourceInspector),
  });
}

async function runHarness(options = {}) {
  const harness = createHarness(options);
  const evidence = await executeHarness(harness, options);
  return { evidence, harness };
}

async function expectHarnessFailure(options, expectedCode, expectedCause = null) {
  const harness = createHarness(options);
  await assert.rejects(executeHarness(harness, options), (error) => {
    assert.equal(error.code, expectedCode);
    if (expectedCause) assert.equal(error.cause?.code, expectedCause);
    return true;
  });
  return harness;
}

test("action input binds two distinct QA tenants, batches and sessions while keeping secrets non-enumerable", () => {
  const parsed = action();
  assert.equal(parsed.expectedGitSha, gitSha);
  assert.equal(parsed.expectedGitRef, gitRef);
  assert.equal(parsed.expectedDeploymentId, deploymentId);
  assert.equal(parsed.expectedNeonBranchId, branchId);
  assert.equal(parsed.expectedNeonProjectId, neonProjectId);
  for (const secret of [
    "actorUserId",
    "batchId",
    "batchMarker",
    "crossTenantActorUserId",
    "crossTenantBatchId",
    "crossTenantBatchMarker",
    "crossTenantSessionCookie",
    "crossTenantWorkspaceId",
    "databaseUrl",
    "sessionCookie",
    "workspaceId",
  ]) assert.equal(Object.keys(parsed).includes(secret), false);

  for (const override of [
    { crossTenantBatchId: batchId },
    { crossTenantBatchMarker: "invalid" },
    { crossTenantSessionCookie: sessionCookie },
    { crossTenantWorkspaceId: workspaceId },
    { expectedGitRef: "main" },
    { previewOrigin: "https://www.novalure-crm.app" },
    { unexpected: "value" },
  ]) assert.throws(() => action(override), PublicRuntimePreviewError);
});

test("publish-token repository scan passes token patterns only over child stdin", () => {
  const invocations = [];
  const scanner = (command, args, options) => {
    invocations.push({ args, command, options });
    return { status: 1 };
  };
  const digest = scanRepositoryForTokens([oldToken, newToken], "C:/candidate", scanner);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, "git");
  assert.deepEqual(invocations[0].args, [
    "grep",
    "--cached",
    "--quiet",
    "--fixed-strings",
    "-f",
    "-",
    "--",
  ]);
  assert.equal(invocations[0].args.includes(oldToken), false);
  assert.equal(invocations[0].args.includes(newToken), false);
  assert.equal(invocations[0].options.input, `${oldToken}\n${newToken}\n`);
  assert.equal(invocations[0].options.cwd, "C:/candidate");
  assert.throws(
    () => scanRepositoryForTokens([oldToken, newToken], "C:/candidate", () => ({ status: 0 })),
    (error) => error.code === "PUBLISH_TOKEN_REPOSITORY_REFERENCE_FOUND",
  );
});

test("read-only preflight remains an exact seven-scenario anonymous contract", () => {
  assert.deepEqual(publicRuntimeReadOnlyScenarios.map((scenario) => scenario.id), [
    "public-form-shell-missing",
    "public-form-proof-invalid",
    "public-form-submit-missing",
    "public-funnel-shell-missing",
    "public-funnel-proof-invalid",
    "public-funnel-submit-invalid",
    "public-funnel-visit-launch-off",
  ]);
});

test("mutating Preview runner proves both public flows, exactly once, rotation, isolation and exact cleanup", async () => {
  const { evidence, harness } = await runHarness();

  assert.equal(evidence.releaseGateStatus, "PASS");
  assert.equal(evidence.httpReadOnlyStatus, "PASS");
  assert.equal(evidence.productionMutationPerformed, false);
  assert.equal(evidence.mutationGate.status, "PASS");
  assert.deepEqual(evidence.blockedProofs, []);
  assert.deepEqual(
    evidence.proofs.map((proof) => proof.id),
    [
      "public-form-long-proof-refresh",
      "public-form-live-submission",
      "public-funnel-long-proof-refresh",
      "public-funnel-live-submission",
      "funnel-publish-token-rotation",
    ],
  );
  assert.deepEqual(evidence.proofs.map((proof) => proof.observations.map((observation) => observation.id)), [
    ["initial-proof-issued", "old-proof-rejected", "refresh-issued-after-long-session", "refreshed-proof-accepted"],
    ["crm-link-verified", "idempotent-replay-verified", "persisted-exactly-once", "submission-accepted"],
    ["initial-revision-proof-issued", "old-proof-rejected", "refresh-issued-after-long-session", "refreshed-revision-proof-accepted"],
    ["crm-link-verified", "idempotent-replay-verified", "persisted-exactly-once", "revision-bound-submission-accepted"],
    ["new-token-accepted", "old-token-rejected", "published-revision-preserved", "repository-token-reference-absent"],
  ]);
  for (const proof of evidence.proofs) {
    const { artifactFile, artifactSha256, ...payload } = proof;
    assert.equal(artifactFile, `${proof.id}.json`);
    assert.equal(artifactSha256, sha256(canonicalJson(payload)));
  }
  assert.ok(evidence.proofs[0].semanticEvidence.minimumElapsedSeconds >= 901);
  assert.ok(evidence.proofs[2].semanticEvidence.minimumElapsedSeconds >= 901);
  assert.equal(evidence.cleanup.status, "PASS");
  assert.equal(evidence.cleanup.createdObjectCount, evidence.cleanup.deletedObjectCount);
  assert.ok(evidence.cleanup.createdObjectCount > 0);
  assert.equal(evidence.cleanup.exactPrePostContentFingerprintMatch, true);
  assert.equal(evidence.cleanup.inventoryBeforeSha256, evidence.cleanup.inventoryAfterSha256);
  assert.equal(evidence.cleanup.remainingObjectCount, 0);
  assert.equal(evidence.databaseAttestation.contentFingerprintDigest, databaseFixture().contentFingerprintDigest);
  assert.equal(evidence.retainedEvidence.classification, "RETAINED_APPEND_ONLY_NOT_CLEANUP_TARGETS");
  assert.equal(evidence.retainedEvidence.rowDelta, 7);
  assert.notEqual(evidence.retainedEvidence.beforeSha256, evidence.retainedEvidence.afterSha256);
  assert.equal(assertPublicRuntimeEvidenceSafe(evidence), true);

  const capabilityCalls = harness.state.calls.filter((call) => call.path === "/api/admin/qa-batch-capability");
  assert.deepEqual(capabilityCalls.map((call) => [call.scope, call.batchId]), [
    ["primary", batchId],
    ["secondary", crossTenantBatchId],
  ]);
  assert.equal(harness.state.calls.filter((call) => call.path === "/api/forms" && call.method === "POST").at(0)?.qaBatchId, batchId);
  assert.equal(harness.state.calls.filter((call) => call.path === "/api/crm/funnels" && call.method === "POST").at(0)?.qaBatchId, batchId);
  assert.equal(harness.state.calls.filter((call) => call.path.endsWith("/blueprint") && call.method === "PUT").at(0)?.qaBatchId, batchId);
  assert.equal(harness.state.calls.filter((call) => call.path.endsWith("/publish-token/cutover") && call.method === "POST").length, 2);
  assert.equal(harness.state.calls.filter((call) => call.path.endsWith("/publish-token/cutover") && call.method === "POST").every((call) => call.qaBatchId === batchId), true);
  assert.equal(harness.state.formPersisted, 1);
  assert.equal(harness.state.funnelPersisted, 1);
  assert.equal(harness.state.formSubmissionCalls, 3);
  assert.equal(harness.state.funnelSubmissionCalls, 3);
  assert.equal(harness.state.repositoryScans, 1);
  assert.deepEqual(harness.state.resetExecutions, ["primary", "secondary"]);
  assert.equal(harness.state.csrfCalls, 9);

  const anonymousCalls = harness.state.calls.filter((call) =>
    call.path.startsWith("/forms/")
    || call.path.startsWith("/preview/")
    || call.path === "/api/forms/submission-proof"
    || call.path === "/api/forms/submissions"
    || /^\/api\/funnels\/[^/]+\/(?:submission-proof|submissions|visits)$/u.test(call.path));
  assert.ok(anonymousCalls.length > 0);
  assert.equal(anonymousCalls.every((call) => call.scope === "none"), true);
});

test("missing atomic capability surface fails before any mutation", async () => {
  const harness = await expectHarnessFailure({ missingSurface: "funnelPublicSubmit" }, "PREVIEW_RUNTIME_IDENTITY_MISMATCH");
  assert.equal(harness.state.calls.some((call) => call.path === "/api/forms" && call.method === "POST"), false);
  assert.deepEqual(harness.state.resetExecutions, []);
});

test("non-owner capability identity and a stale batch id both fail before mutation", async (context) => {
  await context.test("non-owner session", async () => {
    const harness = await expectHarnessFailure({ ownerRole: "member" }, "PREVIEW_RUNTIME_IDENTITY_MISMATCH");
    assert.equal(harness.state.calls.some((call) => call.path === "/api/forms" && call.method === "POST"), false);
  });
  await context.test("stale batch capability", async () => {
    const harness = await expectHarnessFailure(
      { staleBatchId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      "PREVIEW_RUNTIME_IDENTITY_MISMATCH",
    );
    assert.equal(harness.state.calls.some((call) => call.path === "/api/forms" && call.method === "POST"), false);
  });
});

test("database scope attestation rejects a batch created by another actor", async () => {
  const parsed = action();
  let transactionNumber = 0;
  const sqlFactory = () => ({
    async transaction(build, transactionOptions) {
      assert.deepEqual(transactionOptions, { isolationLevel: "RepeatableRead", readOnly: true });
      const transaction = (strings, ...values) => ({ text: strings.join("?"), values });
      const queries = build(transaction);
      transactionNumber += 1;
      if (transactionNumber === 1) {
        return queries.map((query, index) => {
          if (index === 0) return [{ actorId: actorUserId, tenantId: workspaceId }];
          if (index === 1) {
            return [{
              actorId: actorUserId,
              branchId,
              databaseName: "neondb",
              databaseRole: "novalure_app",
              projectId: neonProjectId,
              tenantId: workspaceId,
            }];
          }
          if (index === 2) {
            return [{
              auditCount: "0",
              batchMarker: parsed.batchMarker,
              candidateSha: gitSha,
              createdByUserId: "77777777-7777-4777-8777-777777777777",
              deploymentId,
              executedCount: "0",
              isQa: true,
              ledgerCount: "0",
              projectId,
              purpose: "public-runtime-preview",
              workspacePublicKey,
            }];
          }
          return [];
        });
      }
      return queries.map((query, index) => index === 1
        ? [{
            auditCount: "0",
            batchMarker: parsed.crossTenantBatchMarker,
            candidateSha: gitSha,
            createdByUserId: crossTenantActorUserId,
            deploymentId,
            executedCount: "0",
            isQa: true,
            ledgerCount: "0",
            purpose: "public-runtime-preview",
          }]
        : []);
    },
  });
  await assert.rejects(
    inspectPublicRuntimeDatabase(parsed, { sqlFactory }),
    (error) => error.code === "DATABASE_SCOPE_MISMATCH",
  );
  assert.equal(transactionNumber, 2);
});

test("missing atomic producer contract fails before runtime access", async () => {
  const harness = await expectHarnessFailure({ missingProducer: true }, "PUBLIC_MUTATION_ATOMIC_CLEANUP_UNAVAILABLE");
  assert.equal(harness.state.calls.length, 0);
});

test("atomic producer source inspection is bound to the isolated candidate checkout", async () => {
  let inspectedRoot = null;
  const harness = createHarness();
  await executeHarness(harness, {
    sourceInspector: async ({ repositoryRoot }) => {
      inspectedRoot = repositoryRoot;
      return passingSourceInspector();
    },
  });
  assert.equal(inspectedRoot, "C:/isolated-candidate");
});

test("a proof session shorter than 901 seconds fails closed and still resets both batches", async () => {
  const harness = await expectHarnessFailure({ shortElapsed: true }, "PUBLIC_PROOF_LONG_SESSION_TOO_SHORT");
  assert.deepEqual(harness.state.resetExecutions, ["primary", "secondary"]);
});

test("accepting an old form proof fails closed and still resets both batches", async () => {
  const harness = await expectHarnessFailure({ oldProofAccepted: true }, "PUBLIC_FORM_OLD_PROOF_NOT_REJECTED");
  assert.deepEqual(harness.state.resetExecutions, ["primary", "secondary"]);
});

test("a cross-tenant read leak fails closed before the long-session mutation and still cleans up", async () => {
  const harness = await expectHarnessFailure({ crossTenantLeak: true }, "CROSS_TENANT_FORM_ISOLATION_FAILED");
  assert.equal(harness.state.formPersisted, 0);
  assert.equal(harness.state.funnelPersisted, 0);
  assert.deepEqual(harness.state.resetExecutions, ["primary", "secondary"]);
});

test("reset count mismatch is surfaced as emergency-cleanup failure with the original mismatch cause", async () => {
  const harness = await expectHarnessFailure(
    { cleanupCountMismatch: true },
    "PUBLIC_RUNTIME_EMERGENCY_CLEANUP_FAILED",
    "QA_RESET_COUNT_MISMATCH",
  );
  assert.ok(harness.state.resetExecutions.length >= 2, "the primary reset is retried by the emergency cleanup path");
  assert.equal(harness.state.resetExecutions.every((scope) => scope === "primary"), true);
});

test("retained append-only evidence is allowed, but a resettable database object remaining is not", async () => {
  const harness = await expectHarnessFailure({ remainingObjectCount: 1 }, "PUBLIC_RUNTIME_CLEANUP_NOT_ZERO");
  assert.deepEqual(harness.state.resetExecutions, ["primary", "secondary"]);
});
