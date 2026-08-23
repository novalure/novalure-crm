import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildProtectedQaChildEnvironment,
  decodeProtectedQaBundle,
  qaProtectedActionBundleAllowedNames,
  qaProtectedActionBundleRequiredNames,
  stageQaEvidenceForUpload,
} from "./qa-protected-preview-action-runner.mjs";

const bundleHeader = "# Generated Preview-only QA fixture. Gitignored. Never commit or print this file.";

function encodedBundle(overrides = {}, extraLines = [], omittedNames = []) {
  const values = Object.fromEntries(qaProtectedActionBundleRequiredNames.map((name) => [name, `value-${name}`]));
  Object.assign(values, overrides);
  for (const name of omittedNames) delete values[name];
  const source = [
    bundleHeader,
    ...Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`),
    ...extraLines,
    "",
  ].join("\n");
  return Buffer.from(source, "utf8").toString("base64");
}

test("action-time QA bundle is decoded only in memory through an exact allowlist", () => {
  const bundle = decodeProtectedQaBundle(encodedBundle());
  assert.deepEqual(Object.keys(bundle).sort(), [...qaProtectedActionBundleRequiredNames].sort());
  const child = buildProtectedQaChildEnvironment(bundle);
  assert.equal(child.NOVALURE_AUTH_ENCRYPTION_KEY, undefined);
  assert.equal(child.NOVALURE_AUTH_RATE_LIMIT_SECRET, undefined);
  assert.equal(child.NOVALURE_ABUSE_SECRET, undefined);
  assert.equal(child.NOVALURE_QA_DATABASE_URL, bundle.NOVALURE_QA_DATABASE_URL);
  assert.equal(child.NOVALURE_QA_TWO_TENANT_ENV_B64, undefined);
  assert.equal(child.NOVALURE_QA_VERCEL_SHARE_URL, undefined);
});

test("bundle parser rejects noncanonical, duplicate, missing and unexpected variables", () => {
  assert.throws(() => decodeProtectedQaBundle("not base64"), /canonical bounded Base64/);
  assert.throws(
    () => decodeProtectedQaBundle(encodedBundle({}, [], ["NOVALURE_QA_DATABASE_URL"])),
    /incomplete: NOVALURE_QA_DATABASE_URL/,
  );

  const valid = encodedBundle();
  const decoded = Buffer.from(valid, "base64").toString("utf8");
  const duplicate = Buffer.from(`${decoded}NOVALURE_QA_DATABASE_URL=duplicate\n`, "utf8").toString("base64");
  assert.throws(() => decodeProtectedQaBundle(duplicate), /repeats NOVALURE_QA_DATABASE_URL/);
  const unexpected = Buffer.from(`${decoded}UNSAFE_SECRET=value\n`, "utf8").toString("base64");
  assert.throws(() => decodeProtectedQaBundle(unexpected), /forbidden variables: UNSAFE_SECRET/);
  assert.equal(qaProtectedActionBundleAllowedNames.includes("NOVALURE_QA_ALLOW_LOCAL"), false);
});

async function createEvidencePair(directory, mode, expected) {
  const name = `${mode}-two-tenant-e2e.json`;
  const serialized = JSON.stringify({
    commit: expected.candidateSha,
    mode,
    productionMutationPerformed: false,
    runtime: {
      databaseBranchId: expected.branchId,
      deploymentHost: expected.previewHost,
      deploymentId: expected.deploymentId,
      gitBranch: expected.candidateBranch,
      gitSha: expected.candidateSha,
    },
    schema: "novalure.qa.two-tenant-e2e.v1",
    summary: { failed: 0, passed: 1, requests: 1 },
    workflowTrust: {
      candidateSha: expected.candidateSha,
      schema: "novalure.qa.protected-workflow-trust.v1",
      trustedHarnessSha: expected.trustedHarnessSha,
      workflowRef: expected.workflowRef,
      workflowSha: expected.trustedHarnessSha,
    },
  });
  const digest = createHash("sha256").update(serialized).digest("hex");
  await writeFile(path.join(directory, name), serialized, { flag: "wx" });
  await writeFile(path.join(directory, `${mode}-two-tenant-e2e.sha256`), `${digest}  ${name}\n`, { flag: "wx" });
}

test("only four verified single-link evidence files are staged outside the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novalure-action-runner-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const runnerTemp = path.join(root, "runner-temp");
    const evidenceDirectory = "artifacts/qa/exact-run";
    const source = path.join(workspace, evidenceDirectory);
    const expected = {
      branchId: "br-isolated-preview",
      candidateBranch: "codex/exact-preview",
      candidateSha: "a".repeat(40),
      deploymentId: "dpl_ExactPreviewDeployment1",
      previewHost: "novalure-exact.vercel.app",
      trustedHarnessSha: "c".repeat(40),
      workflowRef: "novalure/novalure-crm/.github/workflows/livegang-e2e.yml@refs/heads/main",
    };
    await mkdir(source, { recursive: true });
    await mkdir(runnerTemp);
    await createEvidencePair(source, "preflight", expected);
    await createEvidencePair(source, "execute", expected);

    const staged = await stageQaEvidenceForUpload(
      { evidenceDirectory, ...expected },
      { runnerTemp, workspace },
    );
    assert.equal(path.relative(runnerTemp, staged.root).startsWith("novalure-qa-public-"), true);
    assert.equal(path.relative(workspace, staged.root).startsWith(".."), true);
    assert.deepEqual([...staged.names].sort(), [
      "execute-two-tenant-e2e.json",
      "execute-two-tenant-e2e.sha256",
      "preflight-two-tenant-e2e.json",
      "preflight-two-tenant-e2e.sha256",
    ]);
    for (const name of staged.names) {
      const state = await stat(path.join(staged.root, name));
      assert.equal(state.isFile(), true);
      assert.equal(state.nlink, 1);
      assert.deepEqual(
        await readFile(path.join(staged.root, name)),
        await readFile(path.join(source, name)),
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("hard-linked evidence fails closed before upload staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novalure-action-runner-hardlink-"));
  try {
    const workspace = path.join(root, "workspace");
    const runnerTemp = path.join(root, "runner-temp");
    const evidenceDirectory = "artifacts/qa/exact-run";
    const source = path.join(workspace, evidenceDirectory);
    const expected = {
      branchId: "br-isolated-preview",
      candidateBranch: "codex/exact-preview",
      candidateSha: "b".repeat(40),
      deploymentId: "dpl_ExactPreviewDeployment1",
      previewHost: "novalure-exact.vercel.app",
      trustedHarnessSha: "c".repeat(40),
      workflowRef: "novalure/novalure-crm/.github/workflows/livegang-e2e.yml@refs/heads/main",
    };
    await mkdir(source, { recursive: true });
    await mkdir(runnerTemp);
    await createEvidencePair(source, "preflight", expected);
    await createEvidencePair(source, "execute", expected);
    await link(
      path.join(source, "execute-two-tenant-e2e.json"),
      path.join(source, "unexpected-hardlink.json"),
    );
    await assert.rejects(
      stageQaEvidenceForUpload(
        { evidenceDirectory, ...expected },
        { runnerTemp, workspace },
      ),
      /single-link regular file/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("candidate evidence without the exact protected workflow receipt fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novalure-action-runner-trust-"));
  try {
    const workspace = path.join(root, "workspace");
    const runnerTemp = path.join(root, "runner-temp");
    const evidenceDirectory = "artifacts/qa/exact-run";
    const source = path.join(workspace, evidenceDirectory);
    const expected = {
      branchId: "br-isolated-preview",
      candidateBranch: "codex/exact-preview",
      candidateSha: "d".repeat(40),
      deploymentId: "dpl_ExactPreviewDeployment1",
      previewHost: "novalure-exact.vercel.app",
      trustedHarnessSha: "e".repeat(40),
      workflowRef: "novalure/novalure-crm/.github/workflows/livegang-e2e.yml@refs/heads/main",
    };
    await mkdir(source, { recursive: true });
    await mkdir(runnerTemp);
    await createEvidencePair(source, "preflight", expected);
    await createEvidencePair(source, "execute", { ...expected, trustedHarnessSha: "f".repeat(40) });

    await assert.rejects(
      stageQaEvidenceForUpload(
        { evidenceDirectory, ...expected },
        { runnerTemp, workspace },
      ),
      /passing candidate-bound QA evidence record/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
