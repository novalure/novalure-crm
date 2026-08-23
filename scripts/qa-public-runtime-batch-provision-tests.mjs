import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePublicRuntimeBatchProvisionInput,
  provisionPublicRuntimeBatch,
  requireLocalCandidate,
} from "./qa-public-runtime-batch-provision.mjs";

const batchId = "33333333-3333-4333-8333-333333333333";

function validSource(overrides = {}) {
  return JSON.stringify({
    actorUserId: "11111111-1111-4111-8111-111111111111",
    batchMarker: "QA-TEST-20260823-1830-PUBLICA",
    confirmation: "PROVISION_PUBLIC_RUNTIME_PREVIEW_BATCH",
    databaseUrl: `postgresql://novalure_app:${encodeURIComponent("unit-test-placeholder")}@ep-public-preview.neon.tech/neondb?sslmode=require`,
    expectedDeploymentId: "dpl_12345678901234567890",
    expectedGitRef: "codex/go-live-remediation-20260822",
    expectedGitSha: "a".repeat(40),
    expectedNeonBranchId: "br-public-preview-12345678",
    expectedNeonProjectId: "weathered-term-98273025",
    productionDatabaseHost: "ep-production-primary.neon.tech",
    schemaVersion: 1,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  });
}

test("Public batch provision input is exact, Preview-only and deployment-bound", () => {
  const parsed = parsePublicRuntimeBatchProvisionInput(validSource());
  assert.equal(parsed.expectedGitSha, "a".repeat(40));
  assert.equal(parsed.expectedDeploymentId, "dpl_12345678901234567890");
  assert.equal(new URL(parsed.databaseUrl).username, "novalure_app");

  assert.throws(
    () => parsePublicRuntimeBatchProvisionInput(validSource({ extra: "forbidden" })),
    /PUBLIC_BATCH_INPUT_KEYS_INVALID/u,
  );
  assert.throws(
    () => parsePublicRuntimeBatchProvisionInput(validSource({
      databaseUrl: `postgresql://novalure_app:${encodeURIComponent("unit-test-placeholder")}@ep-production-primary.neon.tech/neondb?sslmode=require`,
    })),
    /PUBLIC_BATCH_DATABASE_URL_INVALID/u,
  );
  assert.throws(
    () => parsePublicRuntimeBatchProvisionInput(validSource({
      databaseUrl: `postgresql://owner:${encodeURIComponent("unit-test-placeholder")}@ep-public-preview.neon.tech/neondb?sslmode=require`,
    })),
    /PUBLIC_BATCH_DATABASE_URL_INVALID/u,
  );
});

test("Public batch local candidate gate requires exact clean SHA and branch", () => {
  const input = parsePublicRuntimeBatchProvisionInput(validSource());
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { status: 0, stdout: `${input.expectedGitSha}\n` };
    if (args[0] === "branch") return { status: 0, stdout: `${input.expectedGitRef}\n` };
    return { status: 0, stdout: "" };
  };
  requireLocalCandidate(input, { cwd: "C:/candidate", spawn });
  assert.deepEqual(calls, [
    ["rev-parse", "HEAD"],
    ["branch", "--show-current"],
    ["status", "--short"],
  ]);

  assert.throws(
    () => requireLocalCandidate(input, {
      spawn: (_command, args) => ({
        status: 0,
        stdout: args[0] === "status" ? " M package.json\n" : args[0] === "branch" ? `${input.expectedGitRef}\n` : `${input.expectedGitSha}\n`,
      }),
    }),
    /PUBLIC_BATCH_LOCAL_CANDIDATE_MISMATCH/u,
  );
});

test("Public batch provision is serializable, actor-owned, QA-only and single-use", async () => {
  const input = parsePublicRuntimeBatchProvisionInput(validSource());
  const captured = { databaseUrl: null, isolationLevel: null, queries: [] };
  const sqlFactory = (databaseUrl) => {
    captured.databaseUrl = databaseUrl;
    return {
      transaction: async (build, options) => {
        captured.isolationLevel = options?.isolationLevel;
        const transaction = (strings, ...values) => {
          const query = { text: strings.join("?"), values };
          captured.queries.push(query);
          return query;
        };
        build(transaction);
        return [
          [{ actorId: input.actorUserId, tenantId: input.workspaceId }],
          [{ batchMarker: input.batchMarker, id: batchId, workspaceId: input.workspaceId }],
        ];
      },
    };
  };

  const result = await provisionPublicRuntimeBatch(input, {
    batchIdFactory: () => batchId,
    sqlFactory,
  });
  assert.deepEqual(result, {
    batchId,
    batchMarker: input.batchMarker,
    deploymentId: input.expectedDeploymentId,
    workspaceId: input.workspaceId,
  });
  assert.equal(captured.databaseUrl, input.databaseUrl);
  assert.equal(captured.isolationLevel, "Serializable");
  assert.equal(captured.queries.length, 2);
  const insert = captured.queries[1];
  assert.match(insert.text, /workspace\.is_qa = true/u);
  assert.match(insert.text, /current_user = 'novalure_app'/u);
  assert.match(insert.text, /qa_reset_audit_events/u);
  assert.match(insert.text, /audit\.outcome = 'executed'/u);
  assert.match(insert.text, /not exists/u);
  assert.ok(insert.values.includes(input.actorUserId));
  assert.ok(insert.values.includes(input.expectedDeploymentId));
  assert.ok(insert.values.includes(input.expectedNeonBranchId));
  assert.ok(insert.values.includes(input.expectedNeonProjectId));
  assert.ok(insert.values.includes(batchId));
  assert.ok(insert.values.some((value) => (
    typeof value === "string"
      && value.includes('"purpose":"public-runtime-preview"')
      && value.includes(`"candidate":"${input.expectedGitSha}"`)
      && value.includes(`"deploymentId":"${input.expectedDeploymentId}"`)
  )));
});

test("Public batch provision fails closed when the guarded insert returns no batch", async () => {
  const input = parsePublicRuntimeBatchProvisionInput(validSource());
  await assert.rejects(
    provisionPublicRuntimeBatch(input, {
      batchIdFactory: () => batchId,
      sqlFactory: () => ({
        transaction: async (build) => {
          build((strings, ...values) => ({ text: strings.join("?"), values }));
          return [[], []];
        },
      }),
    }),
    /PUBLIC_BATCH_NOT_FRESH_OR_TARGET_BOUND/u,
  );
});
