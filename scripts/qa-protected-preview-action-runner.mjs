#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import {
  assertEvidenceContainsNoSecrets,
  canonicalJson,
  qaTwoTenantRequiredEnvironment,
} from "./lib/qa-two-tenant-matrix.mjs";
import {
  protectedWorkflowEvidenceFiles,
  twoTenantParentBaseArtifactFile,
} from "./lib/protected-workflow-provenance-receipt.mjs";
import { validateProtectedPreviewWorkflowContract } from "./qa-protected-preview-workflow-contract.mjs";

const bundleHeader = "# Generated Preview-only QA fixture. Gitignored. Never commit or print this file.";
const maximumEncodedBytes = 512 * 1024;
const maximumDecodedBytes = 256 * 1024;
const sourceEvidenceNames = Object.freeze([
  "preflight-two-tenant-e2e.json",
  "preflight-two-tenant-e2e.sha256",
  "execute-two-tenant-e2e.json",
  "execute-two-tenant-e2e.sha256",
]);
const workflowEnvironmentNames = Object.freeze([
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_REF",
  "NOVALURE_WORKFLOW_ENVIRONMENT",
  "NOVALURE_WORKFLOW_CONFIRMATION",
  "NOVALURE_WORKFLOW_CANDIDATE_SHA",
  "NOVALURE_WORKFLOW_CANDIDATE_BRANCH",
  "NOVALURE_WORKFLOW_DEPLOYMENT_ID",
  "NOVALURE_WORKFLOW_PREVIEW_ORIGIN",
  "NOVALURE_WORKFLOW_PREVIEW_HOST",
  "NOVALURE_WORKFLOW_NEON_PROJECT_ID",
  "NOVALURE_WORKFLOW_NEON_BRANCH_ID",
  "NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA",
  "NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA_INPUT",
]);
const serverOnlyBundleNames = Object.freeze([
  "NOVALURE_ABUSE_SECRET",
  "NOVALURE_AUTH_ENCRYPTION_KEY",
  "NOVALURE_AUTH_RATE_LIMIT_SECRET",
  "NOVALURE_PRODUCTION_WORKSPACE_IDS",
  "NOVALURE_QA_BATCH_REGISTRATION_ENABLED",
  "NOVALURE_QA_RESET_EXECUTION_ENABLED",
  "NOVALURE_QA_RESET_WORKSPACE_IDS",
  "NOVALURE_QA_WORKSPACE_IDS",
]);
const runnerOptionalNames = Object.freeze([
  "NOVALURE_QA_EVIDENCE_DIR",
  "NOVALURE_QA_PASSWORD",
  ...["A", "B"].flatMap((tenant) =>
    ["OWNER", "ADMIN", "MEMBER", "CUSTOMER"].map(
      (actor) => `NOVALURE_QA_TENANT_${tenant}_${actor}_PRODUCT_ROLE`,
    )),
]);

export const qaProtectedActionChildEnvironmentNames = Object.freeze([
  ...new Set([...qaTwoTenantRequiredEnvironment(), ...runnerOptionalNames]),
].sort());

export const qaProtectedActionBundleRequiredNames = Object.freeze([
  ...new Set([
    ...qaTwoTenantRequiredEnvironment(),
    ...serverOnlyBundleNames,
    "NOVALURE_QA_EVIDENCE_DIR",
    ...runnerOptionalNames.filter((name) => name.endsWith("_PRODUCT_ROLE")),
  ]),
].sort());

export const qaProtectedActionBundleAllowedNames = Object.freeze([
  ...new Set([
    ...qaProtectedActionChildEnvironmentNames,
    ...serverOnlyBundleNames,
  ]),
].sort());

function safeRequired(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for protected Preview QA.`);
  return value;
}

function exactBase64(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumEncodedBytes
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error("The encrypted QA bundle must be one canonical bounded Base64 value.");
  }
}

export function decodeProtectedQaBundle(encoded) {
  exactBase64(encoded);
  const decoded = Buffer.from(encoded, "base64");
  try {
    if (
      decoded.length === 0
      || decoded.length > maximumDecodedBytes
      || decoded.toString("base64") !== encoded
    ) {
      throw new Error("The encrypted QA bundle failed canonical Base64 validation.");
    }
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      throw new Error("The encrypted QA bundle is not valid UTF-8.");
    }
    if (source.includes("\0")) throw new Error("The encrypted QA bundle contains a forbidden NUL byte.");
    const lines = source.replaceAll("\r\n", "\n").split("\n");
    if (lines.shift() !== bundleHeader) throw new Error("The encrypted QA bundle header is invalid.");

    const names = new Set();
    for (const line of lines) {
      if (!line) continue;
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
      if (!match) throw new Error("The encrypted QA bundle contains a malformed line.");
      if (names.has(match[1])) throw new Error(`The encrypted QA bundle repeats ${match[1]}.`);
      names.add(match[1]);
    }

    let parsed;
    try {
      parsed = parseEnv(source);
    } catch {
      throw new Error("The encrypted QA bundle could not be parsed safely.");
    }
    if (Object.keys(parsed).length !== names.size) {
      throw new Error("The encrypted QA bundle parser and line inventory disagree.");
    }
    const allowed = new Set(qaProtectedActionBundleAllowedNames);
    const unexpected = Object.keys(parsed).filter((name) => !allowed.has(name)).sort();
    if (unexpected.length) {
      throw new Error(`The encrypted QA bundle contains forbidden variables: ${unexpected.join(", ")}.`);
    }
    const missing = qaProtectedActionBundleRequiredNames.filter((name) => !Object.hasOwn(parsed, name));
    if (missing.length) {
      throw new Error(`The encrypted QA bundle is incomplete: ${missing.join(", ")}.`);
    }
    return Object.freeze({ ...parsed });
  } finally {
    decoded.fill(0);
  }
}

export function buildProtectedQaChildEnvironment(bundle, workflowEnv = {}) {
  const child = {
    CI: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
  };
  for (const name of qaProtectedActionChildEnvironmentNames) {
    if (Object.hasOwn(bundle, name)) child[name] = bundle[name];
  }
  for (const name of ["GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_WORKFLOW_REF", "NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA"]) {
    if (Object.hasOwn(workflowEnv, name)) child[name] = workflowEnv[name];
  }
  return Object.freeze(child);
}

function workflowContractEnvironment(bundle, env) {
  const contract = { ...bundle };
  for (const name of workflowEnvironmentNames) contract[name] = safeRequired(env, name);
  return contract;
}

async function runNode(args, childEnvironment, input = null, spawnImplementation = spawn) {
  await new Promise((resolve, reject) => {
    const child = spawnImplementation(process.execPath, args, {
      cwd: process.cwd(),
      env: childEnvironment,
      shell: false,
      stdio: [input === null ? "ignore" : "pipe", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("Protected Preview child process could not start.")));
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`Protected Preview child process failed (exit=${code ?? "signal"}).`));
    });
    if (input !== null) child.stdin.end(`${input}\n`);
  });
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function assertDirectoryChainNoLinks(workspace, directory) {
  const relative = path.relative(workspace, directory);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("QA evidence directory escaped the checked-out workspace.");
  }
  let current = workspace;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const state = await lstat(current);
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error("QA evidence directory contains a symlink or reparse boundary.");
    }
  }
}

async function readExactRegularFile(filePath, maximumBytes = 16 * 1024 * 1024) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > maximumBytes) {
    throw new Error(`QA evidence file ${path.basename(filePath)} is not one bounded single-link regular file.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      throw new Error(`QA evidence file ${path.basename(filePath)} changed during verification.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeExactRegularFile(filePath, contents) {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(contents);
    const state = await handle.stat();
    if (!state.isFile() || state.nlink !== 1) {
      throw new Error("Staged QA evidence is not a single-link regular file.");
    }
  } finally {
    await handle.close();
  }
}

function validateEvidencePair(jsonName, jsonBytes, digestBytes, expectedMode, expected) {
  let evidence;
  try {
    evidence = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    throw new Error(`${jsonName} is not valid JSON evidence.`);
  }
  if (
    evidence?.schema !== "novalure.qa.two-tenant-e2e.v1"
    || evidence?.mode !== expectedMode
    || evidence?.commit !== expected.candidateSha
    || evidence?.summary?.failed !== 0
    || evidence?.productionMutationPerformed !== false
    || evidence?.runtime?.databaseBranchId !== expected.branchId
    || evidence?.runtime?.deploymentHost !== expected.previewHost
    || evidence?.runtime?.deploymentId !== expected.deploymentId
    || evidence?.runtime?.gitBranch !== expected.candidateBranch
    || evidence?.runtime?.gitSha !== expected.candidateSha
    || evidence?.workflowTrust?.schema !== "novalure.qa.protected-workflow-trust.v1"
    || evidence?.workflowTrust?.candidateSha !== expected.candidateSha
    || evidence?.workflowTrust?.trustedHarnessSha !== expected.trustedHarnessSha
    || evidence?.workflowTrust?.workflowRef !== expected.workflowRef
    || evidence?.workflowTrust?.workflowSha !== expected.trustedHarnessSha
  ) {
    throw new Error(`${jsonName} does not contain a passing candidate-bound QA evidence record.`);
  }
  assertEvidenceContainsNoSecrets(evidence);
  const digest = createHash("sha256").update(jsonBytes).digest("hex");
  if (digestBytes.toString("utf8") !== `${digest}  ${jsonName}\n`) {
    throw new Error(`${jsonName} digest sidecar does not match the exact evidence bytes.`);
  }
  return evidence;
}

export async function stageQaEvidenceForUpload(config, options = {}) {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const runnerTemp = path.resolve(options.runnerTemp ?? safeRequired(process.env, "RUNNER_TEMP"));
  const artifactRoot = path.resolve(workspace, "artifacts", "qa");
  const sourceDirectory = path.resolve(workspace, config.evidenceDirectory);
  if (!isInside(artifactRoot, sourceDirectory)) {
    throw new Error("QA evidence upload source must be a child of artifacts/qa.");
  }
  await assertDirectoryChainNoLinks(workspace, sourceDirectory);
  const realWorkspace = await realpath(workspace);
  const realSource = await realpath(sourceDirectory);
  if (!isInside(path.join(realWorkspace, "artifacts", "qa"), realSource)) {
    throw new Error("QA evidence real path escaped artifacts/qa.");
  }

  const source = Object.fromEntries(await Promise.all(
    sourceEvidenceNames.map(async (name) => [name, await readExactRegularFile(path.join(sourceDirectory, name))]),
  ));
  validateEvidencePair(
    "preflight-two-tenant-e2e.json",
    source["preflight-two-tenant-e2e.json"],
    source["preflight-two-tenant-e2e.sha256"],
    "preflight",
    config,
  );
  const executeEvidence = validateEvidencePair(
    "execute-two-tenant-e2e.json",
    source["execute-two-tenant-e2e.json"],
    source["execute-two-tenant-e2e.sha256"],
    "execute",
    config,
  );
  if (
    Object.hasOwn(executeEvidence, "protectedWorkflowArtifactManifest")
    || Object.hasOwn(executeEvidence, "protectedWorkflowReceipt")
  ) {
    throw new Error("Two-tenant parent evidence must not contain protected workflow references.");
  }
  const stagedSource = {
    ...source,
    [twoTenantParentBaseArtifactFile]: Buffer.from(canonicalJson(executeEvidence), "utf8"),
  };

  const stagingDirectory = await mkdtemp(path.join(runnerTemp, "novalure-qa-public-"));
  await chmod(stagingDirectory, 0o700);
  const stagingState = await lstat(stagingDirectory);
  if (!stagingState.isDirectory() || stagingState.isSymbolicLink()) {
    throw new Error("QA public evidence staging directory is unsafe.");
  }
  for (const name of protectedWorkflowEvidenceFiles) {
    await writeExactRegularFile(path.join(stagingDirectory, name), stagedSource[name]);
  }
  const realStaging = await realpath(stagingDirectory);
  if (!isInside(await realpath(runnerTemp), realStaging)) {
    throw new Error("QA public evidence staging escaped RUNNER_TEMP.");
  }
  return Object.freeze({
    names: protectedWorkflowEvidenceFiles,
    root: stagingDirectory,
  });
}

export async function runProtectedPreviewAction(env = process.env, options = {}) {
  const encoded = safeRequired(env, "NOVALURE_QA_TWO_TENANT_ENV_B64");
  const shareUrl = safeRequired(env, "NOVALURE_QA_VERCEL_SHARE_URL");
  const bundle = decodeProtectedQaBundle(encoded);
  const contract = validateProtectedPreviewWorkflowContract(
    workflowContractEnvironment(bundle, env),
    { shareUrl },
  );
  const childEnvironment = buildProtectedQaChildEnvironment(bundle, env);
  const run = options.runNode ?? runNode;
  await run(["scripts/qa-two-tenant-e2e.mjs", "--validate-config"], childEnvironment);
  await run(["scripts/qa-two-tenant-e2e.mjs", "--preflight", "--share-url-stdin"], childEnvironment, shareUrl);
  await run(["scripts/qa-two-tenant-e2e.mjs", "--execute", "--share-url-stdin"], childEnvironment, shareUrl);
  const staged = await (options.stageEvidence ?? stageQaEvidenceForUpload)(
    { evidenceDirectory: bundle.NOVALURE_QA_EVIDENCE_DIR, ...contract },
    options,
  );
  return staged;
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  const encoded = process.env.NOVALURE_QA_TWO_TENANT_ENV_B64;
  const shareUrl = process.env.NOVALURE_QA_VERCEL_SHARE_URL;
  delete process.env.NOVALURE_QA_TWO_TENANT_ENV_B64;
  delete process.env.NOVALURE_QA_VERCEL_SHARE_URL;
  runProtectedPreviewAction({ ...process.env, NOVALURE_QA_TWO_TENANT_ENV_B64: encoded, NOVALURE_QA_VERCEL_SHARE_URL: shareUrl })
    .then(async (staged) => {
      const outputFile = safeRequired(process.env, "GITHUB_OUTPUT");
      await appendFile(outputFile, `evidence_root=${staged.root}\n`, { encoding: "utf8" });
      console.log("PROTECTED_PREVIEW_ACTION_OK");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Protected Preview action failed.");
      process.exitCode = 1;
    });
}
