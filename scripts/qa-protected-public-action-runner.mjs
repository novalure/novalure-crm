#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  assertPublicRuntimeEvidenceSafe,
  canonicalJson,
  parsePublicRuntimeActionInput,
} from "./lib/public-runtime-preview-e2e.mjs";
import {
  publicRuntimeArtifactFiles,
  publicRuntimeParentBaseArtifactFile,
  publicRuntimeProofObservations,
} from "./lib/public-runtime-protected-receipt.mjs";

const maximumEncodedBytes = 256 * 1024;
const maximumDecodedBytes = 128 * 1024;
const maximumEvidenceBytes = 16 * 1024 * 1024;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const requiredWorkflowEnvironment = Object.freeze([
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_REF",
  "NOVALURE_WORKFLOW_CANDIDATE_BRANCH",
  "NOVALURE_WORKFLOW_CANDIDATE_SHA",
  "NOVALURE_WORKFLOW_DEPLOYMENT_ID",
  "NOVALURE_WORKFLOW_ENVIRONMENT",
  "NOVALURE_WORKFLOW_NEON_BRANCH_ID",
  "NOVALURE_WORKFLOW_NEON_PROJECT_ID",
  "NOVALURE_WORKFLOW_PUBLIC_BATCH_POLICY",
  "NOVALURE_WORKFLOW_PREVIEW_HOST",
  "NOVALURE_WORKFLOW_PREVIEW_ORIGIN",
  "NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA",
]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function safeRequired(environment, name) {
  const value = environment[name]?.trim();
  invariant(value, `PROTECTED_PUBLIC_${name}_REQUIRED`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactObjectKeys(value, expected, code) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${code}_OBJECT_REQUIRED`);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  invariant(
    actual.length === sortedExpected.length
      && actual.every((key, index) => key === sortedExpected[index]),
    `${code}_KEYS_INVALID`,
  );
}

function exactInventory(actual, expected, code) {
  invariant(
    Array.isArray(actual)
      && actual.length === expected.length
      && new Set(actual).size === actual.length
      && [...actual].sort().every((value, index) => value === [...expected].sort()[index]),
    code,
  );
}

export function decodeProtectedPublicInput(encoded) {
  invariant(
    typeof encoded === "string"
      && encoded.length > 0
      && encoded.length <= maximumEncodedBytes
      && encoded.length % 4 === 0
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded),
    "PROTECTED_PUBLIC_INPUT_BASE64_INVALID",
  );
  const decoded = Buffer.from(encoded, "base64");
  try {
    invariant(
      decoded.length > 0
        && decoded.length <= maximumDecodedBytes
        && decoded.toString("base64") === encoded,
      "PROTECTED_PUBLIC_INPUT_BASE64_INVALID",
    );
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      invariant(false, "PROTECTED_PUBLIC_INPUT_UTF8_INVALID");
    }
    invariant(!source.includes("\0"), "PROTECTED_PUBLIC_INPUT_NUL_REJECTED");
    const parsed = parsePublicRuntimeActionInput(source);
    return Object.freeze({
      actorUserId: parsed.actorUserId,
      batchId: parsed.batchId,
      batchMarker: parsed.batchMarker,
      crossTenantActorUserId: parsed.crossTenantActorUserId,
      crossTenantBatchId: parsed.crossTenantBatchId,
      crossTenantBatchMarker: parsed.crossTenantBatchMarker,
      crossTenantSessionCookie: parsed.crossTenantSessionCookie,
      crossTenantWorkspaceId: parsed.crossTenantWorkspaceId,
      databaseUrl: parsed.databaseUrl,
      expectedDeploymentId: parsed.expectedDeploymentId,
      expectedGitRef: parsed.expectedGitRef,
      expectedGitSha: parsed.expectedGitSha,
      expectedNeonBranchId: parsed.expectedNeonBranchId,
      expectedNeonProjectId: parsed.expectedNeonProjectId,
      previewOrigin: parsed.previewOrigin,
      productionDatabaseHost: parsed.productionDatabaseHost,
      productionOrigin: parsed.productionOrigin,
      sessionCookie: parsed.sessionCookie,
      shareUrl: parsed.shareUrl,
      workspaceId: parsed.workspaceId,
    });
  } finally {
    decoded.fill(0);
  }
}

export function validateProtectedPublicWorkflowInput(input, environment = process.env) {
  const values = Object.fromEntries(
    requiredWorkflowEnvironment.map((name) => [name, safeRequired(environment, name)]),
  );
  invariant(values.GITHUB_EVENT_NAME === "workflow_dispatch", "PROTECTED_PUBLIC_EVENT_INVALID");
  invariant(values.GITHUB_REF === "refs/heads/main", "PROTECTED_PUBLIC_REF_INVALID");
  invariant(values.NOVALURE_WORKFLOW_ENVIRONMENT === "go-live-preview", "PROTECTED_PUBLIC_ENVIRONMENT_INVALID");
  invariant(
    values.NOVALURE_WORKFLOW_PUBLIC_BATCH_POLICY === "fresh-deployment-bound-single-use-v1",
    "PROTECTED_PUBLIC_BATCH_POLICY_INVALID",
  );
  invariant(
    values.GITHUB_WORKFLOW_REF
      === `${values.GITHUB_REPOSITORY}/.github/workflows/exact-protected-preview-qa.yml@refs/heads/main`,
    "PROTECTED_PUBLIC_WORKFLOW_REF_INVALID",
  );
  invariant(
    values.GITHUB_SHA === values.NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA
      && /^[a-f0-9]{40}$/u.test(values.GITHUB_SHA),
    "PROTECTED_PUBLIC_HARNESS_SHA_INVALID",
  );
  const preview = new URL(input.previewOrigin);
  invariant(
    input.expectedGitSha === values.NOVALURE_WORKFLOW_CANDIDATE_SHA
      && input.expectedGitRef === values.NOVALURE_WORKFLOW_CANDIDATE_BRANCH
      && input.expectedDeploymentId === values.NOVALURE_WORKFLOW_DEPLOYMENT_ID
      && input.expectedNeonProjectId === values.NOVALURE_WORKFLOW_NEON_PROJECT_ID
      && input.expectedNeonBranchId === values.NOVALURE_WORKFLOW_NEON_BRANCH_ID
      && input.previewOrigin === values.NOVALURE_WORKFLOW_PREVIEW_ORIGIN
      && preview.hostname === values.NOVALURE_WORKFLOW_PREVIEW_HOST,
    "PROTECTED_PUBLIC_RUNTIME_BINDING_MISMATCH",
  );
  return Object.freeze({
    candidateBranch: input.expectedGitRef,
    candidateSha: input.expectedGitSha,
    databaseBranchId: input.expectedNeonBranchId,
    deploymentHost: preview.hostname,
    deploymentId: input.expectedDeploymentId,
    crossTenantQaBatchId: input.crossTenantBatchId,
    qaBatchId: input.batchId,
  });
}

function validateCleanup(cleanup, expected) {
  exactObjectKeys(cleanup, [
    "createdObjectCount",
    "databaseCleanup",
    "deletedObjectCount",
    "exactPrePostContentFingerprintMatch",
    "inventoryAfterSha256",
    "inventoryBeforeSha256",
    "qaBatchId",
    "remainingObjectCount",
    "status",
  ], "PROTECTED_PUBLIC_CLEANUP");
  invariant(
    cleanup.qaBatchId === expected.qaBatchId
      && uuidPattern.test(cleanup.qaBatchId)
      && cleanup.status === "PASS"
      && cleanup.databaseCleanup === "VERIFIED_ZERO"
      && cleanup.exactPrePostContentFingerprintMatch === true
      && Number.isSafeInteger(cleanup.createdObjectCount)
      && cleanup.createdObjectCount > 0
      && cleanup.deletedObjectCount === cleanup.createdObjectCount
      && cleanup.remainingObjectCount === 0
      && sha256Pattern.test(cleanup.inventoryBeforeSha256)
      && cleanup.inventoryBeforeSha256 === cleanup.inventoryAfterSha256,
    "PROTECTED_PUBLIC_CLEANUP_INVALID",
  );
  return sha256(canonicalJson(cleanup));
}

function expectedObservationStatus(id) {
  if (id === "old-proof-rejected") return 400;
  if (id === "old-token-rejected") return { minimum: 400, maximum: 499 };
  return { minimum: 200, maximum: 299 };
}

function publicProofArtifactPayload(proof) {
  return Object.fromEntries(
    Object.entries(proof).filter(([key]) => !["artifactFile", "artifactSha256"].includes(key)),
  );
}

function validateProof(proof, expected, cleanupDigest) {
  exactObjectKeys(proof, [
    "artifactFile",
    "artifactSha256",
    "candidateCommit",
    "cleanupInventorySha256",
    "databaseInventorySha256",
    "deploymentId",
    "id",
    "observations",
    "qaBatchId",
    "semanticEvidence",
    "status",
  ], "PROTECTED_PUBLIC_PROOF");
  const observationIds = publicRuntimeProofObservations[proof.id];
  invariant(Array.isArray(observationIds), "PROTECTED_PUBLIC_PROOF_ID_INVALID");
  invariant(
    proof.artifactFile === `${proof.id}.json`
      && proof.candidateCommit === expected.candidateSha
      && proof.deploymentId === expected.deploymentId
      && proof.qaBatchId === expected.qaBatchId
      && proof.cleanupInventorySha256 === cleanupDigest
      && proof.status === "PASS"
      && sha256Pattern.test(proof.artifactSha256)
      && sha256Pattern.test(proof.databaseInventorySha256),
    "PROTECTED_PUBLIC_PROOF_BINDING_INVALID",
  );
  exactInventory(
    proof.observations?.map((observation) => observation?.id),
    observationIds,
    "PROTECTED_PUBLIC_PROOF_OBSERVATION_INVENTORY_INVALID",
  );
  const observations = new Map(proof.observations.map((entry) => [entry.id, entry]));
  let previous = null;
  for (const id of observationIds) {
    const observation = observations.get(id);
    exactObjectKeys(observation, ["id", "observedAt", "responseSha256", "status"], "PROTECTED_PUBLIC_OBSERVATION");
    const instant = Date.parse(observation.observedAt);
    const status = expectedObservationStatus(id);
    invariant(
      Number.isFinite(instant)
        && (previous === null || instant > previous)
        && sha256Pattern.test(observation.responseSha256)
        && (typeof status === "number"
          ? observation.status === status
          : Number.isSafeInteger(observation.status)
            && observation.status >= status.minimum
            && observation.status <= status.maximum),
      "PROTECTED_PUBLIC_OBSERVATION_INVALID",
    );
    previous = instant;
  }
  const semantic = proof.semanticEvidence;
  if (proof.id.endsWith("long-proof-refresh")) {
    exactObjectKeys(semantic, [
      "idempotencyKeyAfterSha256",
      "idempotencyKeyBeforeSha256",
      "minimumElapsedSeconds",
      "oldProofRejectionCode",
    ], "PROTECTED_PUBLIC_LONG_PROOF");
    const initialId = proof.id.startsWith("public-funnel-")
      ? "initial-revision-proof-issued"
      : "initial-proof-issued";
    invariant(
      semantic.minimumElapsedSeconds >= 900
        && semantic.oldProofRejectionCode === "submission_proof_expired"
        && sha256Pattern.test(semantic.idempotencyKeyBeforeSha256)
        && semantic.idempotencyKeyBeforeSha256 === semantic.idempotencyKeyAfterSha256
        && Date.parse(observations.get("old-proof-rejected").observedAt)
          - Date.parse(observations.get(initialId).observedAt) >= 900_000,
      "PROTECTED_PUBLIC_LONG_PROOF_INVALID",
    );
  } else if (proof.id.endsWith("live-submission")) {
    exactObjectKeys(semantic, [
      "createdObjectCount",
      "idempotencyKeySha256",
      "idempotentReplayCreatedObjectCount",
      "persistedObjectSha256",
      "replayResponseSha256",
    ], "PROTECTED_PUBLIC_SUBMISSION_PROOF");
    invariant(
      semantic.createdObjectCount === 1
        && semantic.idempotentReplayCreatedObjectCount === 0
        && [
          semantic.idempotencyKeySha256,
          semantic.persistedObjectSha256,
          semantic.replayResponseSha256,
        ].every((value) => sha256Pattern.test(value)),
      "PROTECTED_PUBLIC_SUBMISSION_EXACTLY_ONCE_INVALID",
    );
  } else {
    exactObjectKeys(semantic, [
      "newTokenSha256",
      "oldTokenRejectionCode",
      "oldTokenSha256",
      "publishedRevisionSha256",
      "repositoryScanSha256",
    ], "PROTECTED_PUBLIC_TOKEN_ROTATION");
    invariant(
      semantic.oldTokenRejectionCode === "invalid_publish_token"
        && [
          semantic.newTokenSha256,
          semantic.oldTokenSha256,
          semantic.publishedRevisionSha256,
          semantic.repositoryScanSha256,
        ].every((value) => sha256Pattern.test(value))
        && semantic.newTokenSha256 !== semantic.oldTokenSha256,
      "PROTECTED_PUBLIC_TOKEN_ROTATION_INVALID",
    );
  }
  const payload = publicProofArtifactPayload(proof);
  invariant(
    sha256(canonicalJson(payload)) === proof.artifactSha256,
    "PROTECTED_PUBLIC_PROOF_ARTIFACT_DIGEST_MISMATCH",
  );
  return payload;
}

async function writeExactRegularFile(filePath, source) {
  const descriptor = await open(
    filePath,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o400,
  );
  try {
    await descriptor.writeFile(source, "utf8");
    const state = await descriptor.stat();
    invariant(state.isFile() && state.nlink === 1, "PROTECTED_PUBLIC_STAGED_FILE_INVALID");
  } finally {
    await descriptor.close();
  }
}

export async function stageProtectedPublicEvidence(evidence, expected, {
  runnerTemp = process.env.RUNNER_TEMP,
} = {}) {
  assertPublicRuntimeEvidenceSafe(evidence);
  invariant(
    evidence?.schemaVersion === 1
      && evidence.releaseGateStatus === "PASS"
      && evidence.httpReadOnlyStatus === "PASS"
      && evidence.productionMutationPerformed === false
      && evidence.mutationGate?.status === "PASS"
      && evidence.mutationGate?.reasonCode === null
      && Array.isArray(evidence.blockedProofs)
      && evidence.blockedProofs.length === 0
      && evidence.candidate?.gitSha === expected.candidateSha
      && evidence.candidate?.gitBranch === expected.candidateBranch
      && evidence.candidate?.deploymentId === expected.deploymentId
      && evidence.candidate?.deploymentHost === expected.deploymentHost
      && evidence.candidate?.neonBranchId === expected.databaseBranchId
      && evidence.databaseAttestation?.status === "PASS"
      && evidence.databaseAttestation?.freshBatch === true
      && evidence.databaseAttestation?.isQa === true
      && evidence.databaseAttestation?.qaBatchId === expected.qaBatchId
      && sha256Pattern.test(evidence.databaseAttestation?.contentFingerprintDigest),
    "PROTECTED_PUBLIC_PARENT_EVIDENCE_INVALID",
  );
  invariant(
    !Object.hasOwn(evidence, "protectedWorkflowArtifactManifest")
      && !Object.hasOwn(evidence, "protectedWorkflowReceipt"),
    "PROTECTED_PUBLIC_PARENT_EVIDENCE_REFERENCE_INVALID",
  );
  const cleanupDigest = validateCleanup(evidence.cleanup, expected);
  exactInventory(
    evidence.proofs?.map((proof) => proof?.id),
    Object.keys(publicRuntimeProofObservations),
    "PROTECTED_PUBLIC_PROOF_INVENTORY_INVALID",
  );
  const proofPayloads = new Map(
    evidence.proofs.map((proof) => [proof.id, validateProof(proof, expected, cleanupDigest)]),
  );
  const resolvedRunnerTemp = path.resolve(runnerTemp);
  const runnerState = await lstat(resolvedRunnerTemp);
  invariant(runnerState.isDirectory() && !runnerState.isSymbolicLink(), "PROTECTED_PUBLIC_RUNNER_TEMP_INVALID");
  const root = await mkdtemp(path.join(resolvedRunnerTemp, "novalure-public-evidence-"));
  await chmod(root, 0o700);
  for (const name of publicRuntimeArtifactFiles) {
    const value = name === publicRuntimeParentBaseArtifactFile
      ? evidence
      : name === "public-form-funnel-cleanup.json"
        ? evidence.cleanup
        : proofPayloads.get(name.slice(0, -".json".length));
    invariant(value, "PROTECTED_PUBLIC_ARTIFACT_VALUE_MISSING");
    await writeExactRegularFile(path.join(root, name), canonicalJson(value));
  }
  const realRoot = await realpath(root);
  const realTemp = await realpath(resolvedRunnerTemp);
  const relative = path.relative(realTemp, realRoot);
  invariant(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "PROTECTED_PUBLIC_STAGING_ESCAPE");
  return Object.freeze({ names: publicRuntimeArtifactFiles, root });
}

async function readBoundedEvidence(filePath) {
  const state = await lstat(filePath);
  invariant(
    state.isFile()
      && !state.isSymbolicLink()
      && state.nlink === 1
      && state.size > 0
      && state.size <= maximumEvidenceBytes,
    "PROTECTED_PUBLIC_PARENT_EVIDENCE_FILE_INVALID",
  );
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    invariant(false, "PROTECTED_PUBLIC_PARENT_EVIDENCE_JSON_INVALID");
  }
}

async function runPublicRunner(
  input,
  environment,
  evidenceDirectory,
  candidateRoot,
  spawnImplementation = spawn,
) {
  const childEnvironment = {
    CI: "true",
    COMSPEC: environment.COMSPEC,
    NEXT_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
    NOVALURE_QA_PUBLIC_RUNTIME_EVIDENCE_DIR: evidenceDirectory,
    NOVALURE_REPOSITORY_ROOT: candidateRoot,
    PATH: environment.PATH,
    SYSTEMROOT: environment.SYSTEMROOT,
    TEMP: environment.TEMP,
    TMP: environment.TMP,
  };
  await new Promise((resolve, reject) => {
    const child = spawnImplementation(
      process.execPath,
      ["scripts/public-runtime-preview-e2e.mjs", "--execute", "--input-stdin"],
      {
        cwd: process.cwd(),
        env: childEnvironment,
        shell: false,
        stdio: ["pipe", "inherit", "inherit"],
        windowsHide: true,
      },
    );
    child.once("error", () => reject(new Error("PROTECTED_PUBLIC_RUNNER_START_FAILED")));
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error("PROTECTED_PUBLIC_RUNNER_DID_NOT_PRODUCE_PASS"));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

export async function runProtectedPublicAction(environment = process.env, options = {}) {
  const encoded = safeRequired(environment, "NOVALURE_QA_PUBLIC_RUNTIME_INPUT_B64");
  const input = decodeProtectedPublicInput(encoded);
  const expected = validateProtectedPublicWorkflowInput(input, environment);
  const candidateRoot = path.resolve(safeRequired(environment, "NOVALURE_PUBLIC_CANDIDATE_ROOT"));
  const candidateState = await lstat(candidateRoot);
  invariant(
    candidateState.isDirectory() && !candidateState.isSymbolicLink(),
    "PROTECTED_PUBLIC_CANDIDATE_ROOT_INVALID",
  );
  const [realCandidateRoot, realWorkspaceRoot] = await Promise.all([
    realpath(candidateRoot),
    realpath(process.cwd()),
  ]);
  const candidateRelative = path.relative(realWorkspaceRoot, realCandidateRoot);
  invariant(
    candidateRelative
      && !candidateRelative.startsWith("..")
      && !path.isAbsolute(candidateRelative),
    "PROTECTED_PUBLIC_CANDIDATE_ROOT_ESCAPE",
  );
  const workspaceEvidenceRoot = path.resolve(process.cwd(), "artifacts", "qa", "protected-public-workflow");
  await mkdir(workspaceEvidenceRoot, { recursive: true });
  const evidenceDirectory = await mkdtemp(path.join(workspaceEvidenceRoot, "run-"));
  try {
    await (options.runPublicRunner ?? runPublicRunner)(
      input,
      environment,
      evidenceDirectory,
      realCandidateRoot,
    );
    const evidence = await readBoundedEvidence(
      path.join(evidenceDirectory, "public-runtime-preview-evidence.json"),
    );
    return await (options.stageEvidence ?? stageProtectedPublicEvidence)(evidence, expected, options);
  } finally {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  const encoded = process.env.NOVALURE_QA_PUBLIC_RUNTIME_INPUT_B64;
  delete process.env.NOVALURE_QA_PUBLIC_RUNTIME_INPUT_B64;
  runProtectedPublicAction({ ...process.env, NOVALURE_QA_PUBLIC_RUNTIME_INPUT_B64: encoded })
    .then(async (staged) => {
      await appendFile(safeRequired(process.env, "GITHUB_OUTPUT"), `evidence_root=${staged.root}\n`, "utf8");
      console.log("PROTECTED_PUBLIC_ACTION_OK");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "PROTECTED_PUBLIC_ACTION_FAILED");
      process.exitCode = 1;
    });
}
