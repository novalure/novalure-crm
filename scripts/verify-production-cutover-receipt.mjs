#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  loadExternalGateTrustContext,
} from "./lib/external-gate-receipts.mjs";
import {
  loadCanonicalProductionCutoverDocument,
  productionCutoverReceiptRoles,
  verifyProductionCutoverEvidence,
} from "./lib/production-cutover-receipt.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const allowed = new Set([
    "candidate",
    "document",
    "expected-trust-anchor-sha256",
    "rollback-deployment-host",
    "rollback-deployment-id",
    "staged-deployment-host",
    "staged-deployment-id",
    "trust-anchor",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      fail("PRODUCTION_CUTOVER_ARGUMENT_PAIR_INVALID");
    }
    const key = option.slice(2);
    if (!allowed.has(key) || Object.hasOwn(values, key)) {
      fail("PRODUCTION_CUTOVER_ARGUMENT_INVALID");
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== allowed.size) {
    fail("PRODUCTION_CUTOVER_ARGUMENT_REQUIRED");
  }
  return values;
}

const argumentsMap = parseArguments(process.argv.slice(2));
const trustContext = await loadExternalGateTrustContext({
  anchorPath: argumentsMap["trust-anchor"],
  expectedSha256: argumentsMap["expected-trust-anchor-sha256"],
  repositoryRoot,
  requiredRoles: Object.values(productionCutoverReceiptRoles),
});
const document = await loadCanonicalProductionCutoverDocument({
  documentPath: argumentsMap.document,
  repositoryRoot,
});
const result = verifyProductionCutoverEvidence({
  document,
  expectedCandidateCommit: argumentsMap.candidate,
  expectedTarget: {
    rollbackDeploymentHost: argumentsMap["rollback-deployment-host"],
    rollbackDeploymentId: argumentsMap["rollback-deployment-id"],
    stagedDeploymentHost: argumentsMap["staged-deployment-host"],
    stagedDeploymentId: argumentsMap["staged-deployment-id"],
  },
  repositoryRoot,
  trustContext,
});

process.stdout.write(canonicalJson(result));
