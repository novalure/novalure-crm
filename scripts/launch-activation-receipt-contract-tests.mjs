import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson,
  externalGateTrustAnchorRecordType,
  sha256,
} from "./lib/external-gate-receipts.mjs";
import {
  expectedLaunchActivationPayload,
  launchActivationReceiptRecordType,
  launchActivationReceiptRole,
  verifyLaunchActivationReceipt,
} from "./lib/launch-activation-receipt.mjs";
import { verifyProductionCutoverEvidence } from "./lib/production-cutover-receipt.mjs";
import {
  createProductionCutoverTestFixture,
  productionCutoverTestCandidateCommit,
  productionCutoverTestRollback,
  productionCutoverTestTarget,
} from "./production-cutover-receipt-contract-tests.mjs";
import {
  evaluateLaunchScope,
  launchScopeActivationEnvironmentKeys,
  launchScopeDecisionCanonicalDocument,
  launchScopeDecisionSha256,
  launchScopePolicyCanonicalDocument,
  launchScopePolicySha256,
  launchScopeProductionMinimumActivationGeneration,
  resolveLaunchScopeProductionActivation,
} from "../src/lib/launch-scope.ts";
import {
  launchActivationChannelSymbol,
  publishLaunchActivationChannelSnapshot,
} from "../src/lib/launch-activation-channel.ts";

const activationLeaseNotBeforeEpochMs = Date.now() - 60_000;
const activationLeaseExpiresAtEpochMs = activationLeaseNotBeforeEpochMs + 20 * 60 * 1_000;
const activationReceiptSignedAtEpochMs = activationLeaseNotBeforeEpochMs - 5 * 60 * 1_000;

const expected = Object.freeze({
  activationExpiresAt: new Date(activationLeaseExpiresAtEpochMs).toISOString(),
  activationGeneration: 2,
  activationNotBefore: new Date(activationLeaseNotBeforeEpochMs).toISOString(),
  candidateCommit: "a".repeat(40),
  deploymentHost: "novalure-final-preview.vercel.app",
  deploymentId: "dpl_abcdefghijklmnopqrstuvwx",
  documentBundleSha256: "1".repeat(64),
  finalAttestationSha256: "2".repeat(64),
  flagsEnvironment: "production",
  flagsRevisionFloor: 41,
  productionCutoverDbaReceiptSha256: "4".repeat(64),
  productionCutoverEvidenceSha256: "5".repeat(64),
  productionCutoverPlatformOperationsReceiptSha256: "6".repeat(64),
  productionCutoverReleaseObserverReceiptSha256: "7".repeat(64),
  productionDeploymentHost: "novalure-staged-production.vercel.app",
  productionDeploymentId: "dpl_productionabcdefghijklmn",
  productionHost: "www.novalure-crm.app",
  projectId: "prj_abcdefghijklmnop",
  releaseGateMatrixSha256: "3".repeat(64),
});

const productionCutoverVerification = Object.freeze({
  candidateCommit: expected.candidateCommit,
  evidenceSha256: expected.productionCutoverEvidenceSha256,
  productionDeploymentHost: expected.productionDeploymentHost,
  productionDeploymentId: expected.productionDeploymentId,
  receiptSha256ByRole: Object.freeze({
    dba: expected.productionCutoverDbaReceiptSha256,
    platformOperations: expected.productionCutoverPlatformOperationsReceiptSha256,
    releaseObserver: expected.productionCutoverReleaseObserverReceiptSha256,
  }),
  status: "PRE_ACTIVATION_READY",
});

function createSignedFixture(payloadOverrides = {}, options = {}) {
  const expectedActivation = options.expectedActivation ?? expected;
  let privateKey;
  let anchor;
  let trustedKey;
  if (options.externalSigner) {
    ({ anchor, privateKey } = options.externalSigner);
    trustedKey = anchor.keys.find(({ role }) => role === launchActivationReceiptRole);
    assert.ok(trustedKey);
  } else {
    const keyPair = generateKeyPairSync("ed25519");
    privateKey = keyPair.privateKey;
    trustedKey = {
      algorithm: "Ed25519",
      keyId: "key_launch_activation_20260823",
      publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      role: launchActivationReceiptRole,
      signerSubject: "subject:novalure-release-activation-owner",
      status: "ACTIVE",
    };
    anchor = {
      keys: [trustedKey],
      recordType: externalGateTrustAnchorRecordType,
      schemaVersion: 1,
      trustAnchorId: "ta_launch_activation_20260823",
    };
  }
  const trustContext = {
    anchor,
    expectedSha256: sha256(canonicalJson(anchor)),
  };
  const payload = {
    ...expectedLaunchActivationPayload(expectedActivation),
    ...payloadOverrides,
  };
  const payloadSha256 = sha256(canonicalJson(payload));
  const receipt = {
    detachedSignature: "",
    keyId: trustedKey.keyId,
    payload,
    payloadSha256,
    receiptId: `grc_${"4".repeat(32)}`,
    recordType: launchActivationReceiptRecordType,
    role: launchActivationReceiptRole,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: [
      "urn:novalure:gate-receipt:v1",
      anchor.trustAnchorId,
      trustedKey.keyId,
      launchActivationReceiptRole,
      launchActivationReceiptRecordType,
      payloadSha256,
    ].join(":"),
    signedAt: new Date(activationReceiptSignedAtEpochMs).toISOString(),
    signerSubject: trustedKey.signerSubject,
    trustAnchorId: anchor.trustAnchorId,
    trustAnchorSha256: trustContext.expectedSha256,
  };
  receipt.detachedSignature = sign(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    privateKey,
  ).toString("base64");
  return { receipt, trustContext };
}

function runtimeIdentity() {
  return {
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_SHA: expected.candidateCommit,
    VERCEL_DEPLOYMENT_ID: expected.productionDeploymentId,
    VERCEL_PROJECT_ID: expected.projectId,
    VERCEL_PROJECT_PRODUCTION_URL: expected.productionHost,
    VERCEL_URL: expected.productionDeploymentHost,
  };
}

test("canonical policy and executable decision digests are current and client-safe", () => {
  assert.equal(sha256(canonicalJson(launchScopePolicyCanonicalDocument)), launchScopePolicySha256);
  assert.equal(sha256(canonicalJson(launchScopeDecisionCanonicalDocument)), launchScopeDecisionSha256);
  assert.notEqual(launchScopePolicySha256, launchScopeDecisionSha256);
  assert.equal(Object.isFrozen(launchScopePolicyCanonicalDocument), true);
  assert.equal(Object.isFrozen(launchScopeDecisionCanonicalDocument), true);

  const launchScopeSource = readFileSync(new URL("../src/lib/launch-scope.ts", import.meta.url), "utf8");
  const receiptVerifierSource = readFileSync(
    new URL("./lib/launch-activation-receipt.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    launchScopeSource,
    /(?:from\s+["']node:crypto["']|\b(?:createHash|createPublicKey)\s*\()/u,
  );
  assert.match(receiptVerifierSource, /verifyExternalGateReceipt/u);
  assert.doesNotMatch(receiptVerifierSource, /-----BEGIN (?:PRIVATE|PUBLIC) KEY-----/u);
});

test("a real Ed25519 receipt emits the only runtime binding accepted for its exact Production deployment", () => {
  const fixture = createSignedFixture();
  const verified = verifyLaunchActivationReceipt({
    expected,
    productionCutoverVerification,
    receipt: fixture.receipt,
    trustContext: fixture.trustContext,
  });
  assert.equal(verified.status, "VERIFIED");
  assert.match(verified.signatureReference, /^urn:novalure:gate-receipt:v1:/u);
  assert.equal(
    verified.receiptSha256,
    sha256(canonicalJson(fixture.receipt)),
  );
  assert.deepEqual(
    resolveLaunchScopeProductionActivation({
      ...runtimeIdentity(),
      ...verified.runtimeEnvironment,
    }),
    verified.activation,
  );
  assert.equal(resolveLaunchScopeProductionActivation({
    ...runtimeIdentity(),
    ...verified.runtimeEnvironment,
    VERCEL_DEPLOYMENT_ID: "dpl_newproductiondeployment1234",
  }).active, false, "a same-SHA redeploy must require a new exact Production activation receipt");
});

test("activation verification enforces the short current lease and rejects use outside it", () => {
  const fixture = createSignedFixture();
  const notBefore = Date.parse(expected.activationNotBefore);
  const expiresAt = Date.parse(expected.activationExpiresAt);
  assert.equal(verifyLaunchActivationReceipt({
    expected,
    nowEpochMs: notBefore,
    productionCutoverVerification,
    receipt: fixture.receipt,
    trustContext: fixture.trustContext,
  }).status, "VERIFIED");
  for (const nowEpochMs of [notBefore - 1, expiresAt, expiresAt + 60_000]) {
    assert.throws(
      () => verifyLaunchActivationReceipt({
        expected,
        nowEpochMs,
        productionCutoverVerification,
        receipt: fixture.receipt,
        trustContext: fixture.trustContext,
      }),
      /LAUNCH_ACTIVATION_LEASE_INACTIVE/u,
    );
  }
  assert.throws(
    () => expectedLaunchActivationPayload({
      ...expected,
      activationExpiresAt: new Date(notBefore + 30 * 60 * 1_000 + 1).toISOString(),
    }),
    /LAUNCH_ACTIVATION_EXPECTED_LEASE_WINDOW_INVALID/u,
  );
  assert.throws(
    () => expectedLaunchActivationPayload({ ...expected, flagsEnvironment: "preview" }),
    /LAUNCH_ACTIVATION_EXPECTED_FLAGS_ENVIRONMENT_INVALID/u,
  );
  assert.equal(launchScopeProductionMinimumActivationGeneration, 2);
  assert.throws(
    () => expectedLaunchActivationPayload({ ...expected, activationGeneration: 1 }),
    /LAUNCH_ACTIVATION_EXPECTED_GENERATION_INVALID/u,
  );
  const verified = verifyLaunchActivationReceipt({
    expected,
    productionCutoverVerification,
    receipt: fixture.receipt,
    trustContext: fixture.trustContext,
  });
  assert.equal(resolveLaunchScopeProductionActivation({
    ...runtimeIdentity(),
    ...verified.runtimeEnvironment,
    [launchScopeActivationEnvironmentKeys.activationGeneration]: "1",
  }).active, false, "raising the code-pinned floor must revoke an older signed generation");
});

test("Production remains closed for absent, partial, malformed or identity-mismatched bindings", () => {
  assert.equal(resolveLaunchScopeProductionActivation(runtimeIdentity()).active, false);
  const fixture = createSignedFixture();
  const verified = verifyLaunchActivationReceipt({
    expected,
    productionCutoverVerification,
    receipt: fixture.receipt,
    trustContext: fixture.trustContext,
  });
  const { runtimeEnvironment } = verified;
  for (const environmentName of Object.values(launchScopeActivationEnvironmentKeys)) {
    const partial = { ...runtimeIdentity(), ...runtimeEnvironment };
    delete partial[environmentName];
    assert.equal(
      resolveLaunchScopeProductionActivation(partial).active,
      false,
      `${environmentName} must be mandatory`,
    );
  }
  for (const mismatch of [
    { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) },
    { VERCEL_DEPLOYMENT_ID: "dpl_otherproductiondeploy1234" },
    { VERCEL_PROJECT_ID: "prj_zyxwvutsrqponmlk" },
    { VERCEL_PROJECT_PRODUCTION_URL: "other.novalure-crm.app" },
  ]) {
    assert.equal(
      resolveLaunchScopeProductionActivation({
        ...runtimeIdentity(),
        ...runtimeEnvironment,
        ...mismatch,
      }).active,
      false,
    );
  }
  assert.equal(resolveLaunchScopeProductionActivation({
    ...runtimeIdentity(),
    ...runtimeEnvironment,
    [launchScopeActivationEnvironmentKeys.documentBundleSha256]: "not-a-digest",
  }).active, false);
});

test("external receipt verification rejects signed non-GO and every stale exact binding", () => {
  for (const override of [
    { activationDecision: "NO-GO" },
    { activationExpiresAt: "2026-08-24T00:00:00.000Z" },
    { activationGeneration: 3 },
    { activationNotBefore: "2026-08-23T18:06:00.000Z" },
    { candidateCommit: "b".repeat(40) },
    { deploymentHost: "other-final-preview.vercel.app" },
    { deploymentId: "dpl_zyxwvutsrqponmlkjihgfedc" },
    { documentBundleSha256: "5".repeat(64) },
    { finalAttestationSha256: "6".repeat(64) },
    { flagsEnvironment: "preview" },
    { flagsRevisionFloor: 42 },
    { launchScopeDecisionSha256: "7".repeat(64) },
    { launchScopePolicySha256: "8".repeat(64) },
    { launchScopePolicyVersion: "stale-policy" },
    { productionCutoverDbaReceiptSha256: "8".repeat(64) },
    { productionCutoverEvidenceSha256: "8".repeat(64) },
    { productionCutoverPlatformOperationsReceiptSha256: "8".repeat(64) },
    { productionCutoverReleaseObserverReceiptSha256: "8".repeat(64) },
    { productionDeploymentHost: "other-staged-production.vercel.app" },
    { productionDeploymentId: "dpl_otherproductiondeploy1234" },
    { productionHost: "other.novalure-crm.app" },
    { projectId: "prj_zyxwvutsrqponmlk" },
    { releaseGateMatrixSha256: "9".repeat(64) },
  ]) {
    const fixture = createSignedFixture(override);
    assert.throws(
      () => verifyLaunchActivationReceipt({
        expected,
        productionCutoverVerification,
        receipt: fixture.receipt,
        trustContext: fixture.trustContext,
      }),
      /LAUNCH_ACTIVATION_PAYLOAD_BINDING_MISMATCH/u,
    );
  }
});

test("launch activation rejects a missing or stale PRE_ACTIVATION_READY cutover verification", () => {
  const fixture = createSignedFixture();
  assert.throws(
    () => verifyLaunchActivationReceipt({
      expected,
      receipt: fixture.receipt,
      trustContext: fixture.trustContext,
    }),
    /LAUNCH_ACTIVATION_PRODUCTION_CUTOVER_VERIFICATION_OBJECT_REQUIRED/u,
  );
  for (const [mutate, expectedError] of [
    [(value) => { value.status = "PENDING"; }, /PRODUCTION_CUTOVER_NOT_READY/u],
    [(value) => { value.candidateCommit = "b".repeat(40); }, /PRODUCTION_CUTOVER_CANDIDATE_MISMATCH/u],
    [(value) => { value.productionDeploymentId = "dpl_otherproductiondeploy1234"; }, /PRODUCTION_CUTOVER_DEPLOYMENT_MISMATCH/u],
    [(value) => { value.productionDeploymentHost = "other-staged.vercel.app"; }, /PRODUCTION_CUTOVER_HOST_MISMATCH/u],
    [(value) => { value.evidenceSha256 = "8".repeat(64); }, /PRODUCTION_CUTOVER_EVIDENCE_MISMATCH/u],
    [(value) => { value.receiptSha256ByRole.dba = "8".repeat(64); }, /PRODUCTION_CUTOVER_DBA_RECEIPT_MISMATCH/u],
    [(value) => { value.receiptSha256ByRole.platformOperations = "8".repeat(64); }, /PRODUCTION_CUTOVER_PLATFORM_RECEIPT_MISMATCH/u],
    [(value) => { value.receiptSha256ByRole.releaseObserver = "8".repeat(64); }, /PRODUCTION_CUTOVER_OBSERVER_RECEIPT_MISMATCH/u],
  ]) {
    const stale = structuredClone(productionCutoverVerification);
    mutate(stale);
    assert.throws(
      () => verifyLaunchActivationReceipt({
        expected,
        productionCutoverVerification: stale,
        receipt: fixture.receipt,
        trustContext: fixture.trustContext,
      }),
      expectedError,
    );
  }
});

test("tampering after signing and an unrelated external trust anchor fail cryptographically", () => {
  const fixture = createSignedFixture();
  const tampered = structuredClone(fixture.receipt);
  tampered.detachedSignature = `${tampered.detachedSignature.slice(0, -4)}AAAA`;
  assert.throws(
    () => verifyLaunchActivationReceipt({ expected, productionCutoverVerification, receipt: tampered, trustContext: fixture.trustContext }),
    /EXTERNAL_GATE_RECEIPT_SIGNATURE/u,
  );

  const unrelated = createSignedFixture();
  assert.throws(
    () => verifyLaunchActivationReceipt({
      expected,
      productionCutoverVerification,
      receipt: fixture.receipt,
      trustContext: unrelated.trustContext,
    }),
    /EXTERNAL_GATE_RECEIPT_(?:TRUST|KEY|SUBJECT|SIGNATURE)/u,
  );
  assert.throws(
    () => verifyLaunchActivationReceipt({
      expected,
      productionCutoverVerification,
      receipt: fixture.receipt,
      trustContext: {
        ...fixture.trustContext,
        expectedSha256: "f".repeat(64),
      },
    }),
    /LAUNCH_ACTIVATION_TRUST_ANCHOR_DIGEST_MISMATCH/u,
  );
});

test("the standalone verifier requires a canonical receipt and an external digest-pinned trust anchor", () => {
  const launchKeyPair = generateKeyPairSync("ed25519");
  const launchTrustKey = {
    algorithm: "Ed25519",
    keyId: "key_launch_activation_cli_20260824",
    publicKeyPem: launchKeyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    role: launchActivationReceiptRole,
    signerSubject: "subject:novalure-release-activation-cli-owner",
    status: "ACTIVE",
  };
  const cutoverFixture = createProductionCutoverTestFixture({
    additionalTrustKeys: [launchTrustKey],
  });
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const cutoverVerification = verifyProductionCutoverEvidence({
    document: cutoverFixture.document,
    expectedCandidateCommit: productionCutoverTestCandidateCommit,
    expectedTarget: {
      ...productionCutoverTestRollback,
      stagedDeploymentHost: productionCutoverTestTarget.stagedDeploymentHost,
      stagedDeploymentId: productionCutoverTestTarget.stagedDeploymentId,
    },
    repositoryRoot,
    trustContext: cutoverFixture.trustContext,
  });
  const cliExpected = {
    ...expected,
    candidateCommit: productionCutoverTestCandidateCommit,
    productionCutoverDbaReceiptSha256: cutoverVerification.receiptSha256ByRole.dba,
    productionCutoverEvidenceSha256: cutoverVerification.evidenceSha256,
    productionCutoverPlatformOperationsReceiptSha256:
      cutoverVerification.receiptSha256ByRole.platformOperations,
    productionCutoverReleaseObserverReceiptSha256:
      cutoverVerification.receiptSha256ByRole.releaseObserver,
    productionDeploymentHost: productionCutoverTestTarget.stagedDeploymentHost,
    productionDeploymentId: productionCutoverTestTarget.stagedDeploymentId,
    productionHost: productionCutoverTestTarget.productionHost,
    projectId: productionCutoverTestTarget.vercelProjectId,
  };
  const fixture = createSignedFixture({}, {
    expectedActivation: cliExpected,
    externalSigner: {
      anchor: cutoverFixture.trustContext.anchor,
      privateKey: launchKeyPair.privateKey,
    },
  });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "novalure-launch-activation-"));
  const anchorPath = join(temporaryDirectory, "trust-anchor.json");
  const receiptPath = join(temporaryDirectory, "receipt.json");
  const cutoverPath = join(temporaryDirectory, "production-cutover.json");
  const flagsOutputPath = join(temporaryDirectory, "launch-flags-capability.json");
  const verifierPath = join(repositoryRoot, "scripts", "verify-launch-activation-receipt.mjs");
  const verifierArguments = [
    "--activation-expires-at", cliExpected.activationExpiresAt,
    "--activation-generation", String(cliExpected.activationGeneration),
    "--activation-not-before", cliExpected.activationNotBefore,
    "--receipt", receiptPath,
    "--trust-anchor", anchorPath,
    "--expected-trust-anchor-sha256", fixture.trustContext.expectedSha256,
    "--candidate", cliExpected.candidateCommit,
    "--deployment-id", cliExpected.deploymentId,
    "--deployment-host", cliExpected.deploymentHost,
    "--project-id", cliExpected.projectId,
    "--production-host", cliExpected.productionHost,
    "--release-gate-matrix-sha256", cliExpected.releaseGateMatrixSha256,
    "--final-attestation-sha256", cliExpected.finalAttestationSha256,
    "--flags-environment", cliExpected.flagsEnvironment,
    "--flags-output", flagsOutputPath,
    "--flags-revision-floor", String(cliExpected.flagsRevisionFloor),
    "--production-deployment-id", cliExpected.productionDeploymentId,
    "--production-deployment-host", cliExpected.productionDeploymentHost,
    "--production-cutover", cutoverPath,
    "--rollback-deployment-id", productionCutoverTestRollback.rollbackDeploymentId,
    "--rollback-deployment-host", productionCutoverTestRollback.rollbackDeploymentHost,
    "--document-bundle-sha256", cliExpected.documentBundleSha256,
  ];
  try {
    writeFileSync(anchorPath, canonicalJson(fixture.trustContext.anchor), { encoding: "utf8", flag: "wx" });
    writeFileSync(receiptPath, canonicalJson(fixture.receipt), { encoding: "utf8", flag: "wx" });
    writeFileSync(cutoverPath, canonicalJson(cutoverFixture.document), { encoding: "utf8", flag: "wx" });
    const result = spawnSync(process.execPath, [verifierPath, ...verifierArguments], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    if (process.platform === "win32") {
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /LAUNCH_ACTIVATION_FLAGS_OUTPUT_WINDOWS_PRIVATE_ACL_UNVERIFIED/u,
      );
      assert.equal(result.stdout, "");
      assert.throws(() => readFileSync(flagsOutputPath), /ENOENT/u);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "VERIFIED");
    assert.equal(output.receiptSha256, sha256(canonicalJson(fixture.receipt)));
    assert.doesNotMatch(result.stdout, /v1\.br/u);
    assert.equal(typeof output.flagsActivation.outputSha256, "string");
    assert.equal(Object.hasOwn(output.flagsActivation, "value"), false);
    const flagsCapability = JSON.parse(readFileSync(flagsOutputPath, "utf8"));
    assert.match(flagsCapability.value, /^v1\.br/u);
    assert.equal(flagsCapability.envelopeSha256, output.flagsActivation.envelopeSha256);
    assert.equal(
      sha256(readFileSync(flagsOutputPath)),
      output.flagsActivation.outputSha256,
    );

    const repositoryAnchorPath = join(repositoryRoot, "package.json");
    const nestedCwdResult = spawnSync(process.execPath, [
      verifierPath,
      ...verifierArguments.map((value) => value === anchorPath
        ? repositoryAnchorPath
        : value === fixture.trustContext.expectedSha256
          ? sha256(readFileSync(repositoryAnchorPath))
          : value),
    ], {
      cwd: join(repositoryRoot, "scripts"),
      encoding: "utf8",
    });
    assert.equal(nestedCwdResult.status, 1);
    assert.match(nestedCwdResult.stderr, /EXTERNAL_GATE_TRUST_ANCHOR_MUST_BE_OUTSIDE_REPOSITORY/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("valid activation opens only code-defined ON/INTERNAL decisions; OFF and actor checks are immutable", () => {
  const fixture = createSignedFixture();
  const verified = verifyLaunchActivationReceipt({
    expected,
    productionCutoverVerification,
    receipt: fixture.receipt,
    trustContext: fixture.trustContext,
  });
  const { runtimeEnvironment } = verified;
  const touchedNames = new Set([
    ...Object.values(launchScopeActivationEnvironmentKeys),
    ...Object.keys(runtimeIdentity()),
    "NOVALURE_LAUNCH_SCOPE_PROPERTY_RESERVATION_RELATIONSHIP_SYNC",
  ]);
  const original = Object.fromEntries([...touchedNames].map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, runtimeIdentity(), runtimeEnvironment, {
      NOVALURE_LAUNCH_SCOPE_PROPERTY_RESERVATION_RELATIONSHIP_SYNC: "LAUNCH-ON",
    });
    const monotonicNow = performance.now();
    publishLaunchActivationChannelSnapshot({
      binding: verified.activation.binding,
      checkedAtEpochMs: Date.now(),
      checkedAtMonotonicMs: monotonicNow,
      envelopeSha256: "a".repeat(64),
      flagConfigUpdatedAtEpochMs: Date.now(),
      flagRevision: expected.flagsRevisionFloor + 1,
      requestRefresh() {},
      schemaVersion: 1,
      state: "ACTIVE",
      validUntilMonotonicMs: monotonicNow + 30_000,
    });
    assert.equal(evaluateLaunchScope("publicFormSubmission").allowed, true);
    assert.equal(evaluateLaunchScope("propertyReservationRelationshipSync").allowed, false);
    assert.equal(evaluateLaunchScope("propertyReservationRelationshipSync").code, "LAUNCH_SCOPE_OFF");
    assert.equal(evaluateLaunchScope("systemDatabaseDiagnostics").allowed, false);
    assert.equal(
      evaluateLaunchScope("systemDatabaseDiagnostics", {
        productPermissions: ["novalure:internal"],
        productRole: "novalureAdmin",
      }).allowed,
      true,
    );
    assert.equal(
      evaluateLaunchScope("systemDatabaseDiagnostics", {
        productPermissions: [],
        productRole: "novalureAdmin",
      }).allowed,
      false,
    );
    publishLaunchActivationChannelSnapshot({
      binding: verified.activation.binding,
      checkedAtEpochMs: Date.now() - 30_000,
      checkedAtMonotonicMs: performance.now(),
      envelopeSha256: "a".repeat(64),
      flagConfigUpdatedAtEpochMs: Date.now(),
      flagRevision: expected.flagsRevisionFloor + 1,
      requestRefresh() {},
      schemaVersion: 1,
      state: "ACTIVE",
      validUntilMonotonicMs: performance.now() + 29_000,
    });
    assert.equal(
      resolveLaunchScopeProductionActivation().active,
      false,
      "a suspended or resumed process must not reuse an old epoch snapshot",
    );
    publishLaunchActivationChannelSnapshot({
      binding: { ...verified.activation.binding, flagsEnvironment: "preview" },
      checkedAtEpochMs: Date.now(),
      checkedAtMonotonicMs: performance.now(),
      envelopeSha256: "a".repeat(64),
      flagConfigUpdatedAtEpochMs: Date.now(),
      flagRevision: expected.flagsRevisionFloor + 1,
      requestRefresh() {},
      schemaVersion: 1,
      state: "ACTIVE",
      validUntilMonotonicMs: performance.now() + 29_000,
    });
    assert.equal(
      resolveLaunchScopeProductionActivation().active,
      false,
      "the channel consumer must independently pin the Production Flags environment",
    );
  } finally {
    delete globalThis[launchActivationChannelSymbol];
    for (const name of touchedNames) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test("the browser cannot activate Production and never receives Node crypto", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
      writable: true,
    });
    assert.deepEqual(resolveLaunchScopeProductionActivation({}), {
      active: false,
      code: "CLIENT_RUNTIME",
    });
    assert.equal(evaluateLaunchScope("publicFormSubmission").allowed, false);
    assert.equal(evaluateLaunchScope("publicFormSubmission").code, "LAUNCH_SCOPE_RUNTIME_UNSAFE");
    assert.equal(evaluateLaunchScope("propertyReservationRelationshipSync").code, "LAUNCH_SCOPE_OFF");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
});

test("operations documentation and verifier keep capability output exclusive and network-free", () => {
  const documentation = readFileSync(
    new URL("../docs/audit/2026-08-23/launch-activation-receipt-contract.md", import.meta.url),
    "utf8",
  );
  const verifier = readFileSync(
    new URL("./verify-launch-activation-receipt.mjs", import.meta.url),
    "utf8",
  );
  for (const environmentName of Object.values(launchScopeActivationEnvironmentKeys)) {
    assert.match(documentation, new RegExp(environmentName, "u"));
  }
  assert.match(documentation, /kein Receipt[\s\S]*kein Trust Anchor/u);
  assert.match(documentation, /Deployment-ID-Fixpunkt/u);
  assert.doesNotMatch(verifier, /\bfetch\s*\(|https?:\/\//u);
  assert.match(verifier, /open\(resolved, "wx", 0o600\)/u);
  assert.match(verifier, /LAUNCH_ACTIVATION_FLAGS_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY/u);
  assert.match(verifier, /outputSha256/u);
});
