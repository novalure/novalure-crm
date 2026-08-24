#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signDetached } from "node:crypto";
import { link, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalPreviewGateBindings,
  observedFinalPreviewGateStatus,
} from "./final-preview-release-attestation-contract.mjs";
import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson,
  sha256,
} from "./lib/external-gate-receipts.mjs";
import {
  buildProductionFunnelTokenCutoverEvidenceSha256,
  buildProductionFunnelTokenInventorySha256,
  productionFunnelTokenCutoverEmptyReason,
  productionFunnelTokenCutoverExpectedProductionHost,
  productionFunnelTokenCutoverExpectedVercelProjectId,
  productionFunnelTokenCutoverInventoryQuery,
  productionFunnelTokenCutoverInventoryQuerySha256,
  productionFunnelTokenCutoverReceiptRecordType,
  productionFunnelTokenCutoverRecordType,
  productionFunnelTokenCutoverRole,
  validateProductionFunnelTokenCutoverEvidence,
} from "./lib/production-funnel-token-cutover-receipt.mjs";
import {
  recoveryExpectedDatabaseName,
  recoveryExpectedProductionBranchId,
  recoveryExpectedProjectId,
} from "./lib/database-recovery-query-pack.mjs";
import {
  launchScopeDecisionSha256,
  launchScopePolicySha256,
  launchScopePolicyVersion,
} from "../src/lib/launch-scope.ts";
import { verifyProductionFunnelTokenCutoverCli } from "./verify-production-funnel-token-cutover.mjs";

const candidateCommit = "a".repeat(40);
const signingKey = generateKeyPairSync("ed25519");
const trustAnchorId = "ta_production_funnel_cutover_20260824";
const keyId = "key_production_funnel_cutover_20260824";
const signerSubject = "subject:novalure:production-funnel-token-cutover:20260824";
const trustAnchor = {
  keys: [{
    algorithm: "Ed25519",
    keyId,
    publicKeyPem: signingKey.publicKey.export({ format: "pem", type: "spki" }),
    role: productionFunnelTokenCutoverRole,
    signerSubject,
    status: "ACTIVE",
  }],
  recordType: "NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR",
  schemaVersion: 1,
  trustAnchorId,
};
const trustAnchorSource = `${JSON.stringify(trustAnchor, null, 2)}\n`;
const trustAnchorSha256 = createHash("sha256").update(trustAnchorSource).digest("hex");
const trustContext = Object.freeze({ anchor: trustAnchor, expectedSha256: trustAnchorSha256 });

const policy = Object.freeze({
  decisionSha256: launchScopeDecisionSha256,
  policySha256: launchScopePolicySha256,
  policyVersion: launchScopePolicyVersion,
});

const productionTarget = Object.freeze({
  databaseName: recoveryExpectedDatabaseName,
  neonBranchId: recoveryExpectedProductionBranchId,
  neonProjectId: recoveryExpectedProjectId,
  productionHost: productionFunnelTokenCutoverExpectedProductionHost,
  vercelDeploymentHost: "novalure-production-candidate.vercel.app",
  vercelDeploymentId: "dpl_12345678901234567890",
  vercelProjectId: productionFunnelTokenCutoverExpectedVercelProjectId,
});

function digest(character) {
  return character.repeat(64);
}

function rotatedEntry(index = 0) {
  const suffix = String(index + 1).padStart(12, "0");
  const priorCapabilitySha256 = digest(index === 0 ? "1" : "a");
  const replacementCapabilitySha256 = digest(index === 0 ? "2" : "b");
  const priorProofSha256 = digest(index === 0 ? "3" : "c");
  const replacementProofSha256 = digest(index === 0 ? "4" : "d");
  return {
    funnelId: `22222222-2222-4222-8222-${suffix}`,
    nonCapabilityStateSha256After: digest(index === 0 ? "5" : "e"),
    nonCapabilityStateSha256Before: digest(index === 0 ? "5" : "e"),
    observations: {
      newLink: {
        capabilitySha256: replacementCapabilitySha256,
        checkedAt: "2026-08-24T10:04:00.000Z",
        evidenceSha256: digest("6"),
        httpStatus: 200,
        outcome: "PASS",
      },
      newProof: {
        capabilitySha256: replacementCapabilitySha256,
        checkedAt: "2026-08-24T10:05:00.000Z",
        errorCode: null,
        evidenceSha256: digest("7"),
        httpStatus: 200,
        outcome: "PASS",
        proofSha256: replacementProofSha256,
      },
      oldLink: {
        capabilitySha256: priorCapabilitySha256,
        checkedAt: "2026-08-24T10:06:00.000Z",
        evidenceSha256: digest("8"),
        httpStatus: 404,
        outcome: "NOT_FOUND",
      },
      oldProof: {
        capabilitySha256: priorCapabilitySha256,
        checkedAt: "2026-08-24T10:07:00.000Z",
        errorCode: "funnel_publication_stale",
        evidenceSha256: digest("9"),
        httpStatus: 409,
        outcome: "REJECTED",
        proofSha256: priorProofSha256,
      },
    },
    priorCapabilitySha256,
    priorProofCapturedAt: "2026-08-24T10:02:00.000Z",
    priorProofSha256,
    replacementCapabilitySha256,
    replacementProofSha256,
    revisionAfter: 8 + index,
    revisionBefore: 7 + index,
    rotatedAt: "2026-08-24T10:03:00.000Z",
    workspaceId: "11111111-1111-4111-8111-111111111111",
  };
}

function receiptPayload(document) {
  return {
    attestationDecision: document.mode === "ROTATED"
      ? "ROTATION_VERIFIED"
      : "AUTHORITATIVE_EMPTY_VERIFIED",
    candidateCommit: document.candidateCommit,
    completedAt: document.completedAt,
    evidenceSha256: buildProductionFunnelTokenCutoverEvidenceSha256(document),
    inventorySha256: document.inventory.entriesSha256,
    mode: document.mode,
    policy: document.policy,
    productionMutationPerformed: document.productionMutationPerformed,
    productionTarget: document.productionTarget,
    totalAffectedFunnels: document.inventory.totalAffectedFunnels,
  };
}

function attachReceipt(document, payloadOverrides = {}) {
  const payload = { ...receiptPayload(document), ...payloadOverrides };
  const payloadSha256 = sha256(canonicalJson(payload));
  const receipt = {
    detachedSignature: null,
    keyId,
    payload,
    payloadSha256,
    receiptId: `grc_${"f".repeat(32)}`,
    recordType: productionFunnelTokenCutoverReceiptRecordType,
    role: productionFunnelTokenCutoverRole,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: [
      "urn:novalure:gate-receipt:v1",
      trustAnchorId,
      keyId,
      productionFunnelTokenCutoverRole,
      productionFunnelTokenCutoverReceiptRecordType,
      payloadSha256,
    ].join(":"),
    signedAt: "2026-08-24T10:09:00.000Z",
    signerSubject,
    trustAnchorId,
    trustAnchorSha256,
  };
  receipt.detachedSignature = signDetached(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    signingKey.privateKey,
  ).toString("base64");
  document.receipt = receipt;
  return document;
}

function rotatedDocument(entries = [rotatedEntry()]) {
  const document = {
    candidateCommit,
    completedAt: "2026-08-24T10:08:00.000Z",
    entries,
    inventory: {
      authoritativeEmpty: false,
      emptyReasonCode: null,
      entriesSha256: buildProductionFunnelTokenInventorySha256(entries),
      inventoryQuerySha256: productionFunnelTokenCutoverInventoryQuerySha256,
      observedAt: "2026-08-24T10:01:00.000Z",
      sourceArtifactSha256: digest("0"),
      totalAffectedFunnels: entries.length,
    },
    mode: "ROTATED",
    policy: { ...policy },
    productionMutationPerformed: true,
    productionTarget: { ...productionTarget },
    receipt: null,
    recordType: productionFunnelTokenCutoverRecordType,
    schemaVersion: 1,
    startedAt: "2026-08-24T10:00:00.000Z",
    status: "PASS",
  };
  return attachReceipt(document);
}

function emptyDocument() {
  const entries = [];
  const document = {
    candidateCommit,
    completedAt: "2026-08-24T10:08:00.000Z",
    entries,
    inventory: {
      authoritativeEmpty: true,
      emptyReasonCode: productionFunnelTokenCutoverEmptyReason,
      entriesSha256: buildProductionFunnelTokenInventorySha256(entries),
      inventoryQuerySha256: productionFunnelTokenCutoverInventoryQuerySha256,
      observedAt: "2026-08-24T10:01:00.000Z",
      sourceArtifactSha256: digest("0"),
      totalAffectedFunnels: 0,
    },
    mode: "AUTHORITATIVE_EMPTY",
    policy: { ...policy },
    productionMutationPerformed: false,
    productionTarget: { ...productionTarget },
    receipt: null,
    recordType: productionFunnelTokenCutoverRecordType,
    schemaVersion: 1,
    startedAt: "2026-08-24T10:00:00.000Z",
    status: "PASS",
  };
  return attachReceipt(document);
}

function validate(document, overrides = {}) {
  return validateProductionFunnelTokenCutoverEvidence({
    document,
    expectedCandidateCommit: candidateCommit,
    trustContext,
    ...overrides,
  });
}

function resignedMutation(mutator, source = rotatedDocument()) {
  const document = structuredClone(source);
  document.receipt = null;
  mutator(document);
  return attachReceipt(document);
}

test("authoritative ROTATED evidence passes and returns only a safe summary", () => {
  const document = rotatedDocument();
  const result = validate(document, { expectedProductionTarget: productionTarget });
  assert.equal(result.verificationStatus, "PASS");
  assert.equal(result.mode, "ROTATED");
  assert.equal(result.totalAffectedFunnels, 1);
  assert.equal(JSON.stringify(result).includes(document.entries[0].priorProofSha256), false);
  assert.equal(JSON.stringify(document).includes("?token="), false);
  assert.equal(JSON.stringify(document).includes("https://"), false);
});

test("a zero-count inventory passes only as explicitly signed AUTHORITATIVE_EMPTY", () => {
  const document = emptyDocument();
  const result = validate(document);
  assert.equal(result.mode, "AUTHORITATIVE_EMPTY");
  assert.equal(result.totalAffectedFunnels, 0);
  assert.equal(document.receipt.payload.attestationDecision, "AUTHORITATIVE_EMPTY_VERIFIED");

  const unsignedEmptyClaim = resignedMutation((candidate) => {
    candidate.mode = "AUTHORITATIVE_EMPTY";
    candidate.entries = [];
    candidate.inventory.entriesSha256 = buildProductionFunnelTokenInventorySha256([]);
    candidate.inventory.totalAffectedFunnels = 0;
    candidate.inventory.authoritativeEmpty = false;
    candidate.inventory.emptyReasonCode = null;
    candidate.productionMutationPerformed = false;
  });
  assert.throws(() => validate(unsignedEmptyClaim), /EMPTY_NOT_AUTHORITATIVE/);

  const zeroRotated = resignedMutation((candidate) => {
    candidate.entries = [];
    candidate.inventory.entriesSha256 = buildProductionFunnelTokenInventorySha256([]);
    candidate.inventory.totalAffectedFunnels = 0;
  });
  assert.throws(() => validate(zeroRotated), /ROTATED_INVENTORY_EMPTY/);

  const wrongDecision = structuredClone(document);
  wrongDecision.receipt = null;
  attachReceipt(wrongDecision, { attestationDecision: "ROTATION_VERIFIED" });
  assert.throws(() => validate(wrongDecision), /RECEIPT_DECISION_INVALID/);
});

test("old URL, new URL/proof and old-proof rejection postconditions are exact", () => {
  const cases = [
    ["old URL 410", (entry) => { entry.observations.oldLink.httpStatus = 410; }, /OLD_LINK_HTTP_STATUS_INVALID/],
    ["old URL redirect", (entry) => { entry.observations.oldLink.httpStatus = 302; }, /OLD_LINK_HTTP_STATUS_INVALID/],
    ["new URL not 200", (entry) => { entry.observations.newLink.httpStatus = 503; }, /NEW_LINK_HTTP_STATUS_INVALID/],
    ["new proof not PASS", (entry) => { entry.observations.newProof.outcome = "REJECTED"; }, /NEW_PROOF_OUTCOME_INVALID/],
    ["old proof accepted", (entry) => { entry.observations.oldProof.httpStatus = 200; }, /OLD_PROOF_HTTP_STATUS_INVALID/],
    ["old proof wrong code", (entry) => { entry.observations.oldProof.errorCode = "submission_proof_expired"; }, /OLD_PROOF_ERROR_CODE_INVALID/],
    ["check before rotation", (entry) => { entry.observations.oldLink.checkedAt = "2026-08-24T10:02:59.000Z"; }, /OUTSIDE_CUTOVER_WINDOW/],
  ];
  for (const [name, mutate, expected] of cases) {
    const document = resignedMutation((candidate) => mutate(candidate.entries[0]));
    assert.throws(() => validate(document), expected, name);
  }
});

test("candidate, launch policy and exact production target cannot drift", () => {
  const wrongCandidate = resignedMutation((document) => { document.candidateCommit = "b".repeat(40); });
  assert.throws(() => validate(wrongCandidate), /CANDIDATE_MISMATCH/);

  const wrongPolicy = resignedMutation((document) => { document.policy.policyVersion = "stale-policy"; });
  assert.throws(() => validate(wrongPolicy), /POLICY_VERSION_MISMATCH/);

  const wrongNeon = resignedMutation((document) => { document.productionTarget.neonBranchId = "br-wrong-production-branch"; });
  assert.throws(() => validate(wrongNeon), /TARGET_NEON_BRANCH_MISMATCH/);

  assert.throws(
    () => validate(rotatedDocument(), {
      expectedProductionTarget: {
        ...productionTarget,
        vercelDeploymentId: "dpl_ABCDEFGHIJABCDEFGHIJ",
      },
    }),
    /TARGET_VERCELDEPLOYMENTID_MISMATCH/,
  );
});

test("inventory, revisions, uniqueness and non-capability state are fail-closed", () => {
  const wrongCount = resignedMutation((document) => { document.inventory.totalAffectedFunnels = 2; });
  assert.throws(() => validate(wrongCount), /INVENTORY_COUNT_MISMATCH/);

  const wrongInventoryDigest = resignedMutation((document) => { document.inventory.entriesSha256 = digest("f"); });
  assert.throws(() => validate(wrongInventoryDigest), /INVENTORY_DIGEST_MISMATCH/);

  const revisionGap = resignedMutation((document) => { document.entries[0].revisionAfter += 1; });
  assert.throws(() => validate(revisionGap), /REVISION_NOT_INCREMENTED/);

  const contentDrift = resignedMutation((document) => { document.entries[0].nonCapabilityStateSha256After = digest("f"); });
  assert.throws(() => validate(contentDrift), /NON_CAPABILITY_STATE_DRIFT/);

  const first = rotatedEntry(0);
  const second = rotatedEntry(1);
  second.replacementCapabilitySha256 = first.priorCapabilitySha256;
  second.observations.newLink.capabilitySha256 = first.priorCapabilitySha256;
  second.observations.newProof.capabilitySha256 = first.priorCapabilitySha256;
  const oldCapabilityReused = rotatedDocument([first, second]);
  assert.throws(() => validate(oldCapabilityReused), /OLD_CAPABILITY_REUSED/);

  const reversed = rotatedDocument([rotatedEntry(1), rotatedEntry(0)]);
  assert.throws(() => validate(reversed), /INVENTORY_ORDER_OR_DUPLICATE_INVALID/);
});

test("receipt signature, payload binding and external role are mandatory", () => {
  const missingReceipt = rotatedDocument();
  missingReceipt.receipt = null;
  assert.throws(() => validate(missingReceipt), /EXTERNAL_GATE_RECEIPT_OBJECT_REQUIRED/);

  const tamperedSignature = rotatedDocument();
  tamperedSignature.receipt.detachedSignature = `${"A".repeat(86)}==`;
  assert.throws(() => validate(tamperedSignature), /SIGNATURE_VERIFICATION_FAILED/);

  const stalePayload = rotatedDocument();
  stalePayload.receipt = null;
  attachReceipt(stalePayload, { candidateCommit: "b".repeat(40) });
  assert.throws(() => validate(stalePayload), /RECEIPT_CANDIDATECOMMIT_MISMATCH/);

  const disposableQaEvidence = {
    candidate: { gitSha: candidateCommit },
    releaseGateStatus: "PASS",
    schemaVersion: 1,
  };
  assert.throws(() => validate(disposableQaEvidence), /DOCUMENT_KEYS_INVALID/);

  const rawCapabilityField = rotatedDocument();
  rawCapabilityField.entries[0].publishToken = "raw-capability-must-never-be-evidence";
  assert.throws(() => validate(rawCapabilityField), /ENTRY_KEYS_INVALID/);
});

test("inventory query returns digests rather than token material", () => {
  assert.equal(
    productionFunnelTokenCutoverInventoryQuerySha256,
    sha256(`${productionFunnelTokenCutoverInventoryQuery}\n`),
  );
  assert.match(productionFunnelTokenCutoverInventoryQuery, /digest\(/u);
  assert.match(productionFunnelTokenCutoverInventoryQuery, /order by funnel\.workspace_id, funnel\.id/u);
  assert.doesNotMatch(productionFunnelTokenCutoverInventoryQuery, /as "publishToken"|as "publicToken"/u);
});

test("schema and unsigned template expose no fabricated receipt or PASS", async () => {
  const schemaPath = new URL(
    "../docs/audit/2026-08-23/production-funnel-token-cutover.schema.json",
    import.meta.url,
  );
  const templatePath = new URL(
    "../docs/audit/2026-08-23/production-funnel-token-cutover.template.json",
    import.meta.url,
  );
  const runbookPath = new URL(
    "../docs/audit/2026-08-23/production-funnel-token-cutover-runbook.md",
    import.meta.url,
  );
  const packagePath = new URL("../package.json", import.meta.url);
  const [schema, template, runbook, packageDocument] = await Promise.all([
    readFile(schemaPath, "utf8").then(JSON.parse),
    readFile(templatePath, "utf8").then(JSON.parse),
    readFile(runbookPath, "utf8"),
    readFile(packagePath, "utf8").then(JSON.parse),
  ]);
  assert.equal(schema.properties.recordType.const, productionFunnelTokenCutoverRecordType);
  assert.equal(schema.$defs.receipt.properties.role.const, productionFunnelTokenCutoverRole);
  assert.equal(schema.allOf.some((clause) => clause.if?.properties?.mode?.const === "ROTATED"), true);
  assert.equal(schema.allOf.some((clause) => clause.if?.properties?.mode?.const === "AUTHORITATIVE_EMPTY"), true);
  assert.deepEqual(template, {
    candidateCommit: null,
    completedAt: null,
    entries: [],
    inventory: null,
    mode: null,
    policy: null,
    productionMutationPerformed: false,
    productionTarget: null,
    receipt: null,
    recordType: productionFunnelTokenCutoverRecordType,
    schemaVersion: 1,
    startedAt: null,
    status: "PENDING",
  });
  assert.match(runbook, /AUTHORITATIVE_EMPTY_VERIFIED/u);
  assert.match(runbook, /exakt HTTP 404/u);
  assert.match(runbook, /funnel_publication_stale/u);
  assert.match(runbook, /keine Netzwerk-, Vercel- oder Datenbankaufrufe/u);
  assert.equal(
    packageDocument.scripts["release:verify-production-funnel-token-cutover"],
    "node scripts/verify-production-funnel-token-cutover.mjs",
  );
  assert.match(
    packageDocument.scripts["test:go-live-remediation"],
    /scripts\/production-funnel-token-cutover-contract-tests\.mjs/u,
  );
});

test("final attestation exposes a separate fail-closed production cutover gate", () => {
  const binding = finalPreviewGateBindings.find((entry) => entry.id === "production-funnel-token-cutover");
  assert.deepEqual(binding, {
    candidateJsonPointer: "/candidateCommit",
    fileName: "production-funnel-token-cutover.json",
    id: "production-funnel-token-cutover",
    schemaJsonPointer: "/schemaVersion",
    schemaValue: 1,
    statusJsonPointer: "/status",
  });
  const runtime = {
    branch: "codex/go-live-remediation-20260822",
    candidateCommit,
    databaseBranchId: "br-lucky-heart-alrm9dlw",
    deploymentHost: "candidate-preview-novalure.vercel.app",
    deploymentId: "dpl_preview12345678901234",
  };
  assert.equal(
    observedFinalPreviewGateStatus(binding, rotatedDocument(), runtime, { trustContext }),
    "PASS",
  );
  assert.equal(
    observedFinalPreviewGateStatus(binding, {
      schemaVersion: 1,
      status: "PENDING",
    }, runtime, { trustContext }),
    "BLOCKED",
  );
});

test("read-only CLI binds the expected production deployment and rejects hardlinks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "novalure-production-funnel-cutover-"));
  const evidencePath = path.join(directory, "production-funnel-token-cutover.json");
  const trustPath = path.join(directory, "release-trust-anchor.json");
  const hardlinkPath = path.join(directory, "evidence-hardlink.json");
  try {
    await Promise.all([
      writeFile(evidencePath, `${JSON.stringify(rotatedDocument(), null, 2)}\n`, "utf8"),
      writeFile(trustPath, trustAnchorSource, "utf8"),
    ]);
    const argumentsFor = (pathToEvidence) => [
      "--evidence", pathToEvidence,
      "--candidate", candidateCommit,
      "--expected-vercel-deployment-id", productionTarget.vercelDeploymentId,
      "--expected-vercel-deployment-host", productionTarget.vercelDeploymentHost,
      "--trust-anchor", trustPath,
      "--trust-anchor-sha256", trustAnchorSha256,
    ];
    const result = await verifyProductionFunnelTokenCutoverCli(argumentsFor(evidencePath));
    assert.equal(result.verificationStatus, "PASS");

    await link(evidencePath, hardlinkPath);
    await assert.rejects(
      verifyProductionFunnelTokenCutoverCli(argumentsFor(evidencePath)),
      /EVIDENCE_NOT_BOUNDED_REGULAR_FILE/,
    );
    await unlink(hardlinkPath);

    await assert.rejects(
      verifyProductionFunnelTokenCutoverCli(argumentsFor(evidencePath).slice(0, -2)),
      /CLI_ARGUMENTS_INCOMPLETE/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
