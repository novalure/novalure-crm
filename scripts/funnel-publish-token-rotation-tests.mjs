import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import {
  buildPublicSubmissionScope,
  createPublicSubmissionProof,
  publicSubmissionActions,
  verifyPublicSubmissionProof,
} from "../src/lib/security/public-submission-abuse.ts";
import { evaluateLaunchScope } from "../src/lib/launch-scope.ts";
import { sanitizeFunnelSubmissionSourceUrl } from "../src/lib/funnel-submission-request.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const funnelId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const oldToken = "o".repeat(43);
const firstToken = "a".repeat(43);
const secondToken = "b".repeat(43);
const abuseSecret = "funnel-rotation-proof-secret-longer-than-32-bytes";

async function source(name) {
  return readFile(path.join(repositoryRoot, name), "utf8");
}

async function loadCommonJsTypeScript(name, dependencyMocks = {}) {
  const input = await source(name);
  const { outputText } = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: name,
  });
  const cjsModule = { exports: {} };
  vm.runInNewContext(outputText, {
    Buffer,
    exports: cjsModule.exports,
    module: cjsModule,
    process,
    require(specifier) {
      if (Object.hasOwn(dependencyMocks, specifier)) return dependencyMocks[specifier];
      if (specifier === "server-only") return {};
      if (specifier.startsWith("node:")) return nodeRequire(specifier);
      throw new Error(`Unexpected runtime import in ${name}: ${specifier}`);
    },
  }, { filename: name });
  return cjsModule.exports;
}

const access = await loadCommonJsTypeScript(
  "src/lib/funnel-public-access.ts",
  { "@/lib/launch-scope": { evaluateLaunchScope: () => ({ allowed: true }) } },
);
const repository = await loadCommonJsTypeScript(
  "src/lib/db/funnel-publish-token-repository.ts",
  { "@/lib/db/tenant-client": { withTenantTransaction() { throw new Error("not used"); } } },
);

function createRotationHarness(initialTracking = {}) {
  const state = {
    audits: [],
    calls: [],
    tracking: { publishToken: oldToken, publicToken: oldToken, ...initialTracking },
  };
  let queue = Promise.resolve();

  async function run(input) {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone(state);
    const transaction = {
      async execute(sql, params = []) {
        state.calls.push({ kind: "execute", params, sql });
      },
      async query(sql, params = []) {
        state.calls.push({ kind: "query", params, sql });
        return [];
      },
      async queryOne(sql, params = []) {
        state.calls.push({ kind: "queryOne", params, sql });
        if (/from funnels[\s\S]*for update/u.test(sql)) {
          if (params[0] !== workspaceA || params[1] !== funnelId) return null;
          return { id: funnelId, projectId, tracking: structuredClone(state.tracking) };
        }
        if (/update funnels/u.test(sql)) {
          state.tracking = JSON.parse(params[2]);
          return { id: funnelId };
        }
        if (/insert into audit_logs/u.test(sql)) {
          state.audits.push(params);
          return { id: "66666666-6666-4666-8666-666666666666" };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };

    try {
      return await repository.rotateFunnelPublishTokenInTransaction({
        actorUserId: actorId,
        funnelId,
        transaction,
        workspaceId: workspaceA,
        ...input,
      });
    } catch (error) {
      state.audits = snapshot.audits;
      state.calls = snapshot.calls;
      state.tracking = snapshot.tracking;
      throw error;
    } finally {
      release();
    }
  }

  return { run, state };
}

function publicFixture(token, revision) {
  return {
    blueprint: { status: "aktiv" },
    stored: {
      blueprintOrigin: "persisted",
      source: "database",
      status: "aktiv",
      tracking: { publicationRevision: revision, publishToken: token },
    },
  };
}

test("rotation atomically replaces the server token, audits only the revision, and invalidates old access", async () => {
  const harness = createRotationHarness({ publicationRevision: 0 });
  const result = await harness.run({
    expectedRevision: 0,
    idempotencyKey: "rotation-request-0001",
    tokenFactory: () => firstToken,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    publishToken: firstToken,
    replayed: false,
    revision: 1,
    status: "rotated",
  });
  assert.equal(harness.state.tracking.publishToken, firstToken);
  assert.equal(harness.state.tracking.publicToken, firstToken);
  assert.equal(harness.state.tracking.publicationRevision, 1);
  assert.equal(harness.state.audits.length, 1);
  assert.equal(JSON.stringify(harness.state.audits).includes(firstToken), false);
  assert.equal(JSON.stringify(harness.state.audits).includes(oldToken), false);

  const fixture = publicFixture(firstToken, 1);
  assert.equal(access.canUsePublicLiveFunnel({ ...fixture, token: oldToken }), false);
  assert.equal(access.canUsePublicLiveFunnel({ ...fixture, token: firstToken }), true);
});

test("same-key replay is no-op with no second secret return or audit", async () => {
  const harness = createRotationHarness({ publicationRevision: 0 });
  const command = {
    expectedRevision: 0,
    idempotencyKey: "rotation-request-replay",
    tokenFactory: () => firstToken,
  };
  await harness.run(command);
  const replay = await harness.run({ ...command, tokenFactory: () => secondToken });

  assert.deepEqual(JSON.parse(JSON.stringify(replay)), {
    replayed: true,
    revision: 1,
    status: "already-rotated",
  });
  assert.equal(Object.hasOwn(replay, "publishToken"), false);
  assert.equal(harness.state.tracking.publishToken, firstToken);
  assert.equal(harness.state.audits.length, 1);
});

test("row locking plus expected revision makes concurrent different-key rotation single-winner", async () => {
  const harness = createRotationHarness({ publicationRevision: 0 });
  const settled = await Promise.allSettled([
    harness.run({
      expectedRevision: 0,
      idempotencyKey: "rotation-concurrent-a",
      tokenFactory: () => firstToken,
    }),
    harness.run({
      expectedRevision: 0,
      idempotencyKey: "rotation-concurrent-b",
      tokenFactory: () => secondToken,
    }),
  ]);

  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = settled.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "PUBLICATION_REVISION_CONFLICT");
  assert.equal(rejected.reason.currentRevision, 1);
  assert.equal(harness.state.audits.length, 1);
  assert.equal(harness.state.tracking.publicationRevision, 1);
});

test("concurrent same-key rotation returns one token exactly once and one replay result", async () => {
  const harness = createRotationHarness({ publicationRevision: 0 });
  const results = await Promise.all([
    harness.run({
      expectedRevision: 0,
      idempotencyKey: "rotation-concurrent-same",
      tokenFactory: () => firstToken,
    }),
    harness.run({
      expectedRevision: 0,
      idempotencyKey: "rotation-concurrent-same",
      tokenFactory: () => secondToken,
    }),
  ]);

  assert.equal(results.filter((item) => Object.hasOwn(item, "publishToken")).length, 1);
  assert.equal(results.filter((item) => item.replayed).length, 1);
  assert.equal(harness.state.tracking.publishToken, firstToken);
  assert.equal(harness.state.audits.length, 1);
});

test("workspace predicate blocks cross-tenant rotation before update", async () => {
  const harness = createRotationHarness({ publicationRevision: 0 });
  const transaction = {
    execute: async () => {},
    query: async () => [],
    queryOne: async (sql, params) => {
      assert.match(sql, /where workspace_id = \$1::uuid[\s\S]*id = \$2::uuid[\s\S]*for update/u);
      assert.equal(params[0], workspaceB);
      return null;
    },
  };
  await assert.rejects(
    repository.rotateFunnelPublishTokenInTransaction({
      actorUserId: actorId,
      expectedRevision: 0,
      funnelId,
      idempotencyKey: "rotation-cross-tenant",
      tokenFactory: () => firstToken,
      transaction,
      workspaceId: workspaceB,
    }),
    (error) => error.code === "FUNNEL_NOT_FOUND",
  );
  assert.equal(harness.state.tracking.publishToken, oldToken);
});

test("publication revision immediately revokes proofs issued before rotation", () => {
  const oldScope = buildPublicSubmissionScope({
    resourceId: access.getStoredFunnelSubmissionScopeResourceId({
      funnelId,
      storedTracking: { publicationRevision: 0 },
    }),
    resourceType: "funnel",
    workspaceId: workspaceA,
  });
  const newScope = buildPublicSubmissionScope({
    resourceId: access.getStoredFunnelSubmissionScopeResourceId({
      funnelId,
      storedTracking: { publicationRevision: 1 },
    }),
    resourceType: "funnel",
    workspaceId: workspaceA,
  });
  const proof = createPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: 1_800_000_000,
    scope: oldScope,
    secret: abuseSecret,
  });

  assert.equal(verifyPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: 1_800_000_001,
    proof,
    scope: oldScope,
    secret: abuseSecret,
  }).ok, true);
  assert.equal(verifyPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: 1_800_000_001,
    proof,
    scope: newScope,
    secret: abuseSecret,
  }).ok, false);
});

test("launch scope keeps customer rotation off and permits only explicit platform-admin cutover", () => {
  assert.equal(evaluateLaunchScope("funnelPublishTokenRotation").allowed, false);
  assert.equal(evaluateLaunchScope("funnelPublishTokenInternalCutover", {
    productPermissions: ["funnels:publish", "novalure:internal"],
    productRole: "customer_owner",
  }).allowed, false);
  assert.equal(evaluateLaunchScope("funnelPublishTokenInternalCutover", {
    productPermissions: ["funnels:publish", "novalure:internal"],
    productRole: "platform_admin",
  }).allowed, true);
});

test("routes enforce RBAC, CSRF-bearing auth, launch scope, strict input, and private responses", async () => {
  const customerRoute = await source("src/app/api/funnels/[funnelId]/publish-token/rotate/route.ts");
  const internalRoute = await source("src/app/api/admin/funnels/[funnelId]/publish-token/cutover/route.ts");
  const http = await source("src/lib/funnel-publish-token-http.ts");
  const nextConfig = await source("next.config.ts");
  const store = await source("src/lib/funnel-store.ts");
  const repositorySource = await source("src/lib/db/funnel-publish-token-repository.ts");

  for (const route of [customerRoute, internalRoute]) {
    assert.match(route, /requirePermissionAndProductCapability/u);
    assert.match(route, /"funnels:write"[\s\S]*"funnels:publish"/u);
    assert.doesNotMatch(route, /console\.|publishToken\s*:/u);
  }
  const customerHandler = customerRoute.slice(customerRoute.indexOf("export async function POST"));
  assert.ok(customerHandler.indexOf('evaluateLaunchScope("funnelPublishTokenRotation"') < customerHandler.indexOf("rotateFunnelPublishTokenResponse"));
  assert.match(internalRoute, /evaluateLaunchScope\([\s\S]*"funnelPublishTokenInternalCutover"/u);
  assert.match(http, /Object\.keys\(command\)\.length !== 1/u);
  assert.match(http, /input\.request\.headers\.get\("idempotency-key"\)/u);
  assert.match(http, /rotationCommandMaxBytes = 2_048/u);
  assert.match(http, /await request\.arrayBuffer\(\)/u);
  assert.match(http, /UNSUPPORTED_CONTENT_TYPE/u);
  assert.match(http, /"Cache-Control": "private, no-store"/u);
  assert.match(http, /"Referrer-Policy": "no-referrer"/u);
  assert.doesNotMatch(http, /console\./u);
  assert.match(nextConfig, /source: "\/preview\/:path\*"/u);
  assert.match(nextConfig, /publicCapabilityPageHeaders[\s\S]*"Referrer-Policy", value: "no-referrer"/u);
  assert.match(nextConfig, /publicCapabilityPageHeaders[\s\S]*"Cache-Control", value: "private, no-store, max-age=0"/u);
  assert.match(store, /delete tracking\.publicationRevision/u);
  assert.match(store, /delete tracking\.publicationRotationRequestHash/u);
  assert.match(repositorySource, /randomBytes\(32\)\.toString\("base64url"\)/u);
  assert.match(repositorySource, /select[\s\S]*from funnels[\s\S]*workspace_id = \$1::uuid[\s\S]*for update/u);
  assert.doesNotMatch(repositorySource, /console\./u);
  assert.doesNotMatch(repositorySource, /JSON\.stringify\(\{[^}]*publishToken/u);
});

test("blueprint save and rotation share a row-lock contract without stale credential writeback", async () => {
  const store = await source("src/lib/funnel-store.ts");
  const rotationRepository = await source("src/lib/db/funnel-publish-token-repository.ts");

  assert.match(store, /findFunnelDatabaseRowInTransaction[\s\S]*for update of f/u);
  assert.match(store, /withTenantTransaction\([\s\S]*findFunnelDatabaseRowInTransaction/u);
  assert.match(store, /const clientTracking = stripClientManagedTrackingSecrets/u);
  assert.match(store, /tracking = tracking \|\| \$11::jsonb/u);
  assert.doesNotMatch(store, /serverTracking|createPublicToken|randomBytes/u);
  assert.doesNotMatch(store, /publicToken,\s*publishToken|publishToken:\s*publicToken/u);
  assert.ok(
    store.indexOf("findFunnelDatabaseRowInTransaction(") < store.indexOf("transaction.queryOne<FunnelStoreRow>("),
    "the authoritative row lock must precede the blueprint update",
  );
  assert.match(rotationRepository, /from funnels[\s\S]*for update/u);
});

test("central blueprint response DTO redacts every server tracking credential", async () => {
  const dto = await loadCommonJsTypeScript("src/lib/funnel-store-response.ts");
  const response = dto.toFunnelBlueprintResponse({
    blueprint: { id: funnelId, tracking: { consentMode: "active" } },
    blueprintOrigin: "persisted",
    blueprintRevision: 4,
    funnelId,
    ownerUserId: actorId,
    projectId,
    source: "database",
    status: "aktiv",
    tracking: {
      publicationRevision: 9,
      publicationRotationRequestHash: "request-hash",
      publicToken: firstToken,
      publishToken: firstToken,
    },
    updatedAt: "2026-08-22T00:00:00.000Z",
    versions: [],
    workspaceId: workspaceA,
    workspaceName: "QA",
  });
  const serialized = JSON.stringify(response);

  assert.deepEqual(Object.keys(response).sort(), [
    "blueprint",
    "blueprintOrigin",
    "blueprintRevision",
    "source",
    "updatedAt",
    "versions",
  ]);
  assert.doesNotMatch(serialized, /publishToken|publicToken|publicationRotationRequestHash|request-hash/u);

  const route = await source("src/app/api/funnels/[funnelId]/blueprint/route.ts");
  assert.equal((route.match(/toFunnelBlueprintResponse\(/gu) ?? []).length, 3);
  assert.doesNotMatch(route, /NextResponse\.json\(restored\)|\.\.\.saved/u);
});

test("submission persistence locks then compares the exact proof publication revision before every domain write", async () => {
  const runtime = await source("src/lib/db/runtime-repositories.ts");
  const route = await source("src/app/api/funnels/[funnelId]/submissions/route.ts");
  const lockedFunnel = runtime.slice(
    runtime.indexOf("with locked_funnel as ("),
    runtime.indexOf("existing_submission as ("),
  );

  assert.match(lockedFunnel, /publicationRevision[\s\S]*= \$29::numeric/u);
  assert.match(lockedFunnel, /for update[\s\S]*selected_funnel as/u);
  assert.match(lockedFunnel, /from locked_funnel[\s\S]*where "publicationRevisionMatched"/u);
  assert.match(runtime, /input\.expectedPublicationRevision/u);
  assert.match(runtime, /where not "publicationRevisionMatched"/u);
  assert.match(route, /expectedPublicationRevision = getStoredFunnelPublicationRevision\(stored\.tracking\)/u);
  assert.match(route, /expectedPublicationRevision,/u);

  const staleBranch = route.slice(route.indexOf("funnelPublicationRevisionConflictReason"));
  assert.match(staleBranch, /return responseFromSnapshot\(staleFunnelPublicationSnapshot\(\)\)/u);
  assert.match(route, /error: "funnel_publication_stale"[\s\S]*reloadRequired: true/u);
  const branchBody = staleBranch.slice(0, staleBranch.indexOf("const status ="));
  assert.doesNotMatch(branchBody, /complete\(/u);
});

test("server persistence boundary strips capability tokens and fragments from source URLs", async () => {
  const sanitized = sanitizeFunnelSubmissionSourceUrl(
    `https://crm.example/preview/${funnelId}?lang=de&TOKEN=${firstToken}&utm_source=qa#${secondToken}`,
  );
  assert.equal(
    sanitized,
    `https://crm.example/preview/${funnelId}?lang=de&utm_source=qa`,
  );
  assert.doesNotMatch(sanitized, new RegExp(`${firstToken}|${secondToken}`, "u"));

  const route = await source("src/app/api/funnels/[funnelId]/submissions/route.ts");
  assert.match(route, /canonicalizeFunnelSubmissionPayload[\s\S]*sanitizeFunnelSubmissionForPersistence/u);
  assert.ok(
    route.indexOf("sanitizeFunnelSubmissionForPersistence({")
      < route.indexOf("getFunnelSubmissionDomainRequestFingerprint(payload)"),
  );
});

test("canonical answers, UTM, and visitor metadata cannot persist capability-shaped secrets", async () => {
  class ValidationError extends Error {
    constructor(code, status) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  const urlHelpers = await import("../src/lib/funnel-submission-url.js");
  const security = await loadCommonJsTypeScript(
    "src/lib/funnel-submission-security.ts",
    {
      "@/lib/funnel-submission-url": urlHelpers,
      "@/lib/funnel-submission-validation": {
        FunnelSubmissionValidationError: ValidationError,
      },
    },
  );
  const basePayload = {
    answers: {
      source_url: `https://crm.example/preview/${funnelId}?lang=en&publish_token=${firstToken}#${secondToken}`,
    },
    consent: { analytics: false, marketing: false, privacy: true },
    funnelId,
    mode: "live",
    utm: { utm_source: "qa" },
    visitor: {
      id: "visitor-1",
      sourceUrl: `https://crm.example/preview/${funnelId}?publicToken=${firstToken}#${secondToken}`,
      userAgent: "QA",
    },
  };
  const sanitized = security.sanitizeFunnelSubmissionForPersistence({
    payload: basePayload,
    storedTracking: { publicToken: firstToken, publishToken: firstToken },
  });
  const serialized = JSON.stringify(sanitized);

  assert.equal(sanitized.answers.source_url, `https://crm.example/preview/${funnelId}?lang=en`);
  assert.equal(sanitized.visitor.sourceUrl, `https://crm.example/preview/${funnelId}`);
  assert.equal(sanitized.utm.utm_source, "qa");
  assert.doesNotMatch(serialized, new RegExp(`${firstToken}|${secondToken}`, "u"));

  const encodedToken = [...firstToken]
    .map((character) => `%${character.codePointAt(0).toString(16).padStart(2, "0")}`)
    .join("");
  const doubleEncodedToken = encodeURIComponent(encodedToken);
  const tripleEncodedToken = encodeURIComponent(doubleEncodedToken);

  for (const payload of [
    { ...basePayload, answers: { hidden: firstToken } },
    { ...basePayload, answers: { token: "not-even-a-valid-token" } },
    { ...basePayload, answers: { [encodeURIComponent(firstToken)]: "value" } },
    { ...basePayload, answers: { hidden: doubleEncodedToken } },
    { ...basePayload, answers: { [doubleEncodedToken]: "value" } },
    { ...basePayload, answers: { hidden: tripleEncodedToken } },
    { ...basePayload, answers: { source_url: `https://crm.example/?ref=${secondToken}` } },
    { ...basePayload, answers: { safe: "safe" }, utm: { utm_source: firstToken } },
    { ...basePayload, answers: { safe: "safe" }, utm: { [firstToken]: "value" } },
    { ...basePayload, answers: { safe: "safe" }, utm: { [`prefix-${firstToken}`]: "value" } },
    { ...basePayload, answers: { safe: "safe" }, utm: { ["c".repeat(43)]: "value" } },
    { ...basePayload, answers: { safe: "safe" }, utm: { utm_source: doubleEncodedToken } },
    { ...basePayload, answers: { safe: "safe" }, utm: { [tripleEncodedToken]: "value" } },
    { ...basePayload, answers: { safe: "safe" }, visitor: { id: firstToken } },
    { ...basePayload, answers: { safe: "safe" }, visitor: { sourceUrl: `https://crm.example/?ref=${secondToken}` } },
    { ...basePayload, answers: { safe: "safe" }, visitor: { sourceUrl: `https://crm.example/${doubleEncodedToken}` } },
  ]) {
    assert.throws(
      () => security.sanitizeFunnelSubmissionForPersistence({
        payload,
        storedTracking: { publicToken: firstToken, publishToken: firstToken },
      }),
      (error) => error.code === "funnel_capability_secret_rejected" && error.status === 422,
    );
  }

  const route = await source("src/app/api/funnels/[funnelId]/submissions/route.ts");
  const sanitizerIndex = route.indexOf("sanitizeFunnelSubmissionForPersistence({");
  assert.ok(sanitizerIndex > route.indexOf("canonicalizeFunnelSubmissionPayload"));
  for (const persistenceBoundary of [
    "scoreCanonicalFunnelAnswers(payload.answers)",
    "getFunnelSubmissionDomainRequestFingerprint(payload)",
    "persistFunnelSubmission({",
  ]) {
    assert.ok(sanitizerIndex < route.indexOf(persistenceBoundary));
  }
  assert.doesNotMatch(route.slice(route.indexOf("function createSuccessSnapshot"), route.indexOf("export async function POST")), /answers|visitor|utm|publishToken|publicToken/u);
});
