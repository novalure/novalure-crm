#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadExternalGateTrustContext,
  requireSha256,
} from "./lib/external-gate-receipts.mjs";
import {
  productionFunnelTokenCutoverExpectedProductionHost,
  productionFunnelTokenCutoverExpectedVercelProjectId,
  productionFunnelTokenCutoverRole,
  validateProductionFunnelTokenCutoverEvidence,
} from "./lib/production-funnel-token-cutover-receipt.mjs";
import {
  recoveryExpectedDatabaseName,
  recoveryExpectedProductionBranchId,
  recoveryExpectedProjectId,
} from "./lib/database-recovery-query-pack.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const maximumEvidenceBytes = 16 * 1024 * 1024;
const commitPattern = /^[a-f0-9]{40}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const deploymentHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function parseArguments(argv) {
  const allowed = new Set([
    "--candidate",
    "--evidence",
    "--expected-vercel-deployment-host",
    "--expected-vercel-deployment-id",
    "--trust-anchor",
    "--trust-anchor-sha256",
  ]);
  invariant(argv.length % 2 === 0, "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_ARGUMENTS_INCOMPLETE");
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(allowed.has(key), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_ARGUMENT_UNKNOWN");
    invariant(!Object.hasOwn(parsed, key), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_ARGUMENT_DUPLICATED");
    invariant(typeof value === "string" && value.length > 0, "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_VALUE_REQUIRED");
    parsed[key] = value;
  }
  invariant(Object.keys(parsed).length === allowed.size, "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_ARGUMENTS_INCOMPLETE");
  invariant(commitPattern.test(parsed["--candidate"]), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_CANDIDATE_INVALID");
  invariant(isAbsolute(parsed["--evidence"]), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_EVIDENCE_ABSOLUTE_REQUIRED");
  invariant(isAbsolute(parsed["--trust-anchor"]), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_TRUST_ABSOLUTE_REQUIRED");
  requireSha256(
    parsed["--trust-anchor-sha256"],
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_TRUST_DIGEST_INVALID",
  );
  invariant(
    deploymentIdPattern.test(parsed["--expected-vercel-deployment-id"]),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_DEPLOYMENT_INVALID",
  );
  invariant(
    deploymentHostPattern.test(parsed["--expected-vercel-deployment-host"]),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CLI_DEPLOYMENT_HOST_INVALID",
  );
  return Object.freeze(parsed);
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function readBoundedStableJson(absolutePath) {
  const resolvedPath = resolve(absolutePath);
  const before = await lstat(resolvedPath);
  invariant(
    before.isFile()
      && !before.isSymbolicLink()
      && before.nlink === 1
      && before.size > 0
      && before.size <= maximumEvidenceBytes,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EVIDENCE_NOT_BOUNDED_REGULAR_FILE",
  );
  const beforeRealPath = await realpath(resolvedPath);
  const noFollow = Number(fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(resolvedPath, Number(fsConstants.O_RDONLY) | noFollow);
  let source;
  let during;
  let afterHandle;
  try {
    during = await handle.stat();
    invariant(
      during.isFile()
        && during.nlink === 1
        && during.size === before.size
        && sameFile(before, during),
      "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EVIDENCE_IDENTITY_CHANGED",
    );
    source = await handle.readFile();
    afterHandle = await handle.stat();
  } finally {
    await handle.close();
  }
  const [after, afterRealPath] = await Promise.all([
    lstat(resolvedPath),
    realpath(resolvedPath),
  ]);
  invariant(
    sameFile(before, after)
      && sameFile(during, afterHandle)
      && beforeRealPath === afterRealPath
      && source.length === before.size,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EVIDENCE_CHANGED_DURING_READ",
  );
  let parsed;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch {
    invariant(false, "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EVIDENCE_JSON_INVALID");
  }
  return parsed;
}

export async function verifyProductionFunnelTokenCutoverCli(argv) {
  const input = parseArguments(argv);
  const [document, trustContext] = await Promise.all([
    readBoundedStableJson(input["--evidence"]),
    loadExternalGateTrustContext({
      anchorPath: input["--trust-anchor"],
      expectedSha256: input["--trust-anchor-sha256"],
      repositoryRoot,
      requiredRoles: [productionFunnelTokenCutoverRole],
    }),
  ]);
  return validateProductionFunnelTokenCutoverEvidence({
    document,
    expectedCandidateCommit: input["--candidate"],
    expectedProductionTarget: {
      databaseName: recoveryExpectedDatabaseName,
      neonBranchId: recoveryExpectedProductionBranchId,
      neonProjectId: recoveryExpectedProjectId,
      productionHost: productionFunnelTokenCutoverExpectedProductionHost,
      vercelDeploymentHost: input["--expected-vercel-deployment-host"],
      vercelDeploymentId: input["--expected-vercel-deployment-id"],
      vercelProjectId: productionFunnelTokenCutoverExpectedVercelProjectId,
    },
    trustContext,
  });
}

async function main() {
  const result = await verifyProductionFunnelTokenCutoverCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
