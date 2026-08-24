import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signDetached,
} from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  buildExternalGateReceiptSigningPayload,
  canonicalJson,
  sha256,
} from "./lib/external-gate-receipts.mjs";
import {
  providerExpectedDatabaseTables,
  providerExpectedRequestIds,
} from "./lib/final-preview-gate-inventories.mjs";
import {
  buildProviderAcceptanceReceiptBundleSha256,
  providerAcceptanceRecordType,
  providerAcceptanceRoles,
  providerFinalCleanupRecordType,
  providerFinalCleanupRole,
  requiredProviderAcceptances,
} from "./lib/provider-acceptance-receipts.mjs";
import { providerFailClosedScenarios } from "./lib/provider-fail-closed-preview.mjs";
import {
  providerAcceptanceEvidenceFreezeMain,
  providerAcceptanceFreezeLimits,
} from "./provider-acceptance-evidence-freeze.mjs";

const runtime = Object.freeze({
  branch: "codex/go-live-remediation-20260822",
  candidateCommit: "a".repeat(40),
  databaseBranchId: "br-lucky-heart-alrm9dlw",
  deploymentHost: "candidate-provider-acceptance.vercel.app",
  deploymentId: "dpl_ProviderAcceptanceCandidate01",
});

function receiptRuntime(value = runtime) {
  return {
    candidateCommit: value.candidateCommit,
    databaseBranchId: value.databaseBranchId,
    deploymentHost: value.deploymentHost,
    deploymentId: value.deploymentId,
    gitBranch: value.branch,
    productionMutationPerformed: false,
  };
}

function databasePostcondition(seed = 1) {
  return {
    reasonCode: null,
    status: "PASS",
    tables: Object.fromEntries(providerExpectedDatabaseTables.map((table, index) => {
      const fingerprint = `sha256:${String(((index + seed) % 8) + 1).repeat(64)}`;
      return [table, {
        afterCount: index + seed,
        afterFingerprint: fingerprint,
        beforeCount: index + seed,
        beforeFingerprint: fingerprint,
        unchanged: true,
      }];
    })),
  };
}

function rawCollector(value = runtime, database = databasePostcondition()) {
  const scenarios = new Map(providerFailClosedScenarios.map((entry) => [entry.id, entry]));
  return {
    candidate: {
      commitSha: value.candidateCommit,
      databaseBranchFingerprint: `sha256:${"1".repeat(16)}`,
      databaseBranchId: value.databaseBranchId,
      deploymentHost: value.deploymentHost,
      deploymentId: value.deploymentId,
      gitRef: value.branch,
      previewOriginFingerprint: `sha256:${"2".repeat(16)}`,
    },
    cleanup: {
      databaseCleanup: "NOT_REQUIRED",
      externalSessionCreatedByRunner: false,
      inMemoryCookieJar: "CLEARED_IN_FINALLY",
      status: "COMPLETE",
    },
    completedAt: "2026-08-25T19:59:00.000Z",
    databaseWritePostcondition: database,
    httpTechnicalStatus: "PASS",
    productionMutationPerformed: false,
    providerSideEffectPostcondition: {
      codeOrderAndHttpGate: "PASS",
      independentProviderLogs: "UNPROVEN",
      reasonCode: "INDEPENDENT_PROVIDER_LOGS_NOT_COLLECTED",
    },
    releaseGateStatus: "BLOCKED",
    requests: providerExpectedRequestIds.map((id) => {
      if (id === "identity.session" || id === "identity.runtime") {
        return {
          code: id === "identity.session" ? "SESSION_SCOPE_MATCH" : "RUNTIME_IDENTITY_MATCH",
          csrf: "not-applicable",
          id,
          method: "GET",
          status: 200,
        };
      }
      const scenario = scenarios.get(id);
      return {
        code: "LAUNCH_SCOPE_OFF",
        csrf: scenario.csrf,
        id,
        method: scenario.method,
        status: 503,
      };
    }),
    schemaVersion: 1,
    startedAt: "2026-08-25T19:58:00.000Z",
  };
}

function buildTrustMaterial(signerSubject = "subject:provider-qa-attestor") {
  const trustRoles = [...providerAcceptanceRoles, providerFinalCleanupRole];
  const signingKeys = Object.fromEntries(trustRoles.map((role) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return [role, {
      keyId: `key_${role.replaceAll("-", "_")}_01`,
      privateKey,
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      signerSubject,
    }];
  }));
  const anchor = {
    keys: trustRoles.map((role) => ({
      algorithm: "Ed25519",
      keyId: signingKeys[role].keyId,
      publicKeyPem: signingKeys[role].publicKeyPem,
      role,
      signerSubject: signingKeys[role].signerSubject,
      status: "ACTIVE",
    })),
    recordType: "NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR",
    schemaVersion: 1,
    trustAnchorId: "ta_provider_acceptance_01",
  };
  const bytes = Buffer.from(canonicalJson(anchor));
  return { anchor, anchorSha256: sha256(bytes), bytes, signingKeys };
}

function buildFinalCleanupReceipt({
  anchor,
  anchorSha256,
  receipts,
  runtimeValue,
  signingKeys,
  sourceArtifactSha256,
  sourceCollectorSha256,
}) {
  const signingKey = signingKeys[providerFinalCleanupRole];
  const payload = {
    acceptanceReceiptBundleSha256: buildProviderAcceptanceReceiptBundleSha256(receipts),
    cleanupWindow: {
      completedAt: "2026-08-25T20:32:00.000Z",
      startedAt: "2026-08-25T20:31:00.000Z",
    },
    databaseResidualEvidenceSha256: "5".repeat(64),
    externalProviderSessionCount: 0,
    providerResidualEvidenceSha256: "6".repeat(64),
    qaBatchInventorySha256: "7".repeat(64),
    residualLiveObjectCount: 0,
    runtime: receiptRuntime(runtimeValue),
    sourceArtifactSha256,
    sourceCollectorSha256,
    status: "PASS",
  };
  const payloadSha256 = sha256(canonicalJson(payload));
  const receipt = {
    detachedSignature: "",
    keyId: signingKey.keyId,
    payload,
    payloadSha256,
    receiptId: `grc_${sha256("provider-final-cleanup").slice(0, 40)}`,
    recordType: providerFinalCleanupRecordType,
    role: providerFinalCleanupRole,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: [
      "urn:novalure:gate-receipt:v1",
      anchor.trustAnchorId,
      signingKey.keyId,
      providerFinalCleanupRole,
      providerFinalCleanupRecordType,
      payloadSha256,
    ].join(":"),
    signedAt: "2026-08-25T20:33:00.000Z",
    signerSubject: signingKey.signerSubject,
    trustAnchorId: anchor.trustAnchorId,
    trustAnchorSha256: anchorSha256,
  };
  receipt.detachedSignature = signDetached(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    signingKey.privateKey,
  ).toString("base64");
  return receipt;
}

function resignReceipt(receipt, signingKey) {
  receipt.keyId = signingKey.keyId;
  receipt.payloadSha256 = sha256(canonicalJson(receipt.payload));
  receipt.signerSubject = signingKey.signerSubject;
  receipt.signatureReference = [
    "urn:novalure:gate-receipt:v1",
    receipt.trustAnchorId,
    receipt.keyId,
    receipt.role,
    receipt.recordType,
    receipt.payloadSha256,
  ].join(":");
  receipt.detachedSignature = signDetached(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    signingKey.privateKey,
  ).toString("base64");
  return receipt;
}

function buildReceipt({
  acceptanceId,
  anchor,
  anchorSha256,
  database,
  signingKeys,
  runtimeValue = runtime,
  sourceArtifactSha256,
  sourceCollectorSha256,
}) {
  const contract = requiredProviderAcceptances[acceptanceId];
  const signingKey = signingKeys[contract.receiptRole];
  const index = Object.keys(requiredProviderAcceptances).indexOf(acceptanceId);
  const payload = {
    acceptanceId,
    artifactSha256: String((index % 8) + 1).repeat(64),
    databasePostconditionSha256: sha256(canonicalJson(database)),
    observationWindow: {
      completedAt: "2026-08-25T20:30:00.000Z",
      startedAt: "2026-08-25T20:00:00.000Z",
    },
    observations: contract.outcomes.map((id, outcomeIndex) => ({
      evidenceSha256: String(((index + outcomeIndex) % 8) + 1).repeat(64),
      id,
      status: "PASS",
    })),
    providerIdentity: {
      providerAccountFingerprint: `sha256:${"a".repeat(64)}`,
      providerEnvironment: "QA_PREVIEW",
      providerLogArtifactSha256: "b".repeat(64),
      providerName: contract.providers[0],
    },
    postAcceptance: {
      cleanupEvidenceSha256: String(((index + 3) % 8) + 1).repeat(64),
      completedAt: "2026-08-25T20:30:30.000Z",
      databaseEvidenceSha256: String(((index + 4) % 8) + 1).repeat(64),
      residualLiveObjectCount: 0,
      status: "PASS",
    },
    qaTargetApproval: {
      approvedAt: "2026-08-25T19:59:30.000Z",
      purpose: contract.targetPurpose,
      status: "APPROVED",
      targetFingerprint: `sha256:${"c".repeat(64)}`,
    },
    qaTargetFingerprint: `sha256:${"c".repeat(64)}`,
    runtime: receiptRuntime(runtimeValue),
    sourceArtifactSha256,
    sourceCollectorSha256,
    sourceCompletedAt: "2026-08-25T19:59:00.000Z",
  };
  const payloadSha256 = sha256(canonicalJson(payload));
  const receiptId = `grc_${sha256(`provider:${acceptanceId}`).slice(0, 40)}`;
  const receipt = {
    detachedSignature: "",
    keyId: signingKey.keyId,
    payload,
    payloadSha256,
    receiptId,
    recordType: providerAcceptanceRecordType,
    role: contract.receiptRole,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
    signatureReference: [
      "urn:novalure:gate-receipt:v1",
      anchor.trustAnchorId,
      signingKey.keyId,
      contract.receiptRole,
      providerAcceptanceRecordType,
      payloadSha256,
    ].join(":"),
    signedAt: "2026-08-25T20:31:00.000Z",
    signerSubject: signingKey.signerSubject,
    trustAnchorId: anchor.trustAnchorId,
    trustAnchorSha256: anchorSha256,
  };
  receipt.detachedSignature = signDetached(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    signingKey.privateKey,
  ).toString("base64");
  return receipt;
}

async function writePinnedSource(directory, document, fileName = "provider-fail-closed-evidence.json") {
  const sourcePath = path.join(directory, fileName);
  const bytes = Buffer.from(canonicalJson(document));
  const digest = sha256(bytes);
  const sourceSidecarPath = `${sourcePath}.sha256`;
  await writeFile(sourcePath, bytes, { flag: "wx" });
  await writeFile(sourceSidecarPath, `${digest}  ${fileName}\n`, { flag: "wx" });
  return { digest, sourcePath, sourceSidecarPath };
}

async function createFixture({
  database = databasePostcondition(),
  runtimeValue = runtime,
  sourceDocument = null,
  signerSubject = "subject:provider-qa-attestor",
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "provider-acceptance-freeze-"));
  const inputs = path.join(root, "inputs");
  const outputDirectory = path.join(root, "output");
  await Promise.all([mkdir(inputs), mkdir(outputDirectory)]);
  const trust = buildTrustMaterial(signerSubject);
  const trustAnchorPath = path.join(root, "provider-trust-anchor.json");
  await writeFile(trustAnchorPath, trust.bytes, { flag: "wx" });
  const collector = sourceDocument ?? rawCollector(runtimeValue, database);
  const source = await writePinnedSource(inputs, collector);
  const sourceCollectorSha256 = sha256(canonicalJson(collector));
  const receiptPaths = [];
  for (const acceptanceId of Object.keys(requiredProviderAcceptances)) {
    const receipt = buildReceipt({
      acceptanceId,
      anchor: trust.anchor,
      anchorSha256: trust.anchorSha256,
      database,
      signingKeys: trust.signingKeys,
      runtimeValue,
      sourceArtifactSha256: source.digest,
      sourceCollectorSha256,
    });
    const receiptPath = path.join(inputs, `${acceptanceId}.json`);
    await writeFile(receiptPath, canonicalJson(receipt), { flag: "wx" });
    receiptPaths.push(receiptPath);
  }
  const receipts = await Promise.all(receiptPaths.map(async (receiptPath) =>
    JSON.parse(await readFile(receiptPath, "utf8"))));
  const cleanupReceipt = buildFinalCleanupReceipt({
    anchor: trust.anchor,
    anchorSha256: trust.anchorSha256,
    receipts,
    runtimeValue,
    signingKeys: trust.signingKeys,
    sourceArtifactSha256: source.digest,
    sourceCollectorSha256,
  });
  const cleanupReceiptPath = path.join(inputs, "provider-final-cleanup.json");
  await writeFile(cleanupReceiptPath, canonicalJson(cleanupReceipt), { flag: "wx" });
  return {
    input: {
      cleanupReceiptPath,
      expectedSourceSha256: source.digest,
      expectedTrustAnchorSha256: trust.anchorSha256,
      kind: "provider-acceptance",
      outputDirectory,
      receiptPaths,
      runtime: runtimeValue,
      schemaVersion: 1,
      sourcePath: source.sourcePath,
      sourceSidecarPath: source.sourceSidecarPath,
      trustAnchorPath,
    },
    outputDirectory,
    root,
    source,
    trust,
  };
}

async function runFixture(fixture) {
  let stdout = "";
  const written = await providerAcceptanceEvidenceFreezeMain({
    inputStream: Readable.from([JSON.stringify(fixture.input)]),
    outputStream: { write(value) { stdout += String(value); return true; } },
  });
  return { stdout, written };
}

async function replacePinnedSource(fixture, document) {
  await Promise.all([
    rm(fixture.input.sourcePath),
    rm(fixture.input.sourceSidecarPath),
  ]);
  const source = await writePinnedSource(path.dirname(fixture.input.sourcePath), document);
  fixture.input.expectedSourceSha256 = source.digest;
  fixture.input.sourcePath = source.sourcePath;
  fixture.input.sourceSidecarPath = source.sourceSidecarPath;
}

test("freezes a pinned fail-closed collector plus exactly six signed provider receipts into final PASS evidence", async () => {
  const fixture = await createFixture();
  try {
    const { stdout, written } = await runFixture(fixture);
    const artifact = JSON.parse(await readFile(written.artifactPath, "utf8"));
    const sidecar = await readFile(written.sidecarPath, "utf8");
    assert.equal(artifact.collectionMode, "LIVE_PROVIDER_ACCEPTANCE");
    assert.equal(artifact.releaseGateStatus, "PASS");
    assert.equal(artifact.providerSideEffectPostcondition.independentProviderLogs, "PASS");
    assert.equal(artifact.providerSideEffectPostcondition.reasonCode, null);
    assert.equal(artifact.completedAt, "2026-08-25T20:33:00.000Z");
    assert.equal(artifact.providerAcceptanceReceipts.length, 6);
    assert.deepEqual(
      artifact.providerAcceptanceAssembly.acceptanceIds,
      Object.keys(requiredProviderAcceptances),
    );
    assert.equal(
      artifact.providerAcceptanceAssembly.sourceArtifactSha256,
      fixture.input.expectedSourceSha256,
    );
    assert.equal(
      artifact.providerAcceptanceAssembly.sourceCollectorSha256,
      sha256(canonicalJson(rawCollector())),
    );
    assert.equal(
      artifact.providerAcceptanceAssembly.databasePostconditionSha256,
      sha256(canonicalJson(artifact.databaseWritePostcondition)),
    );
    assert.equal(
      artifact.providerAcceptanceAssembly.sourceCompletedAt,
      "2026-08-25T19:59:00.000Z",
    );
    assert.match(sidecar, new RegExp(`^${written.digest}  provider-boundaries\\.json\\n$`, "u"));
    assert.deepEqual(JSON.parse(stdout), {
      digest: written.digest,
      fileName: "provider-boundaries.json",
      kind: "provider-acceptance",
      sidecarFileName: "provider-boundaries.json.sha256",
      status: "PASS",
    });
    assert.doesNotMatch(await readFile(written.artifactPath, "utf8"), /https?:\/\/|novalure_session=|_vercel_share|PRIVATE KEY/iu);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("refuses status relabelling or a collector that is no longer the exact BLOCKED raw artifact", async () => {
  const document = rawCollector();
  document.collectionMode = "LIVE_PROVIDER_ACCEPTANCE";
  document.releaseGateStatus = "PASS";
  document.providerSideEffectPostcondition.independentProviderLogs = "PASS";
  document.providerSideEffectPostcondition.reasonCode = null;
  const fixture = await createFixture({ sourceDocument: document });
  try {
    await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_SOURCE_COLLECTOR_KEYS_INVALID/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects provider observations that predate the bound fail-closed collector", async () => {
  const fixture = await createFixture();
  try {
    const receiptPath = fixture.input.receiptPaths[0];
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.payload.observationWindow = {
      completedAt: "2026-08-25T19:58:30.000Z",
      startedAt: "2026-08-25T19:58:10.000Z",
    };
    receipt.payload.postAcceptance.completedAt = "2026-08-25T19:58:40.000Z";
    resignReceipt(receipt, fixture.trust.signingKeys[receipt.role]);
    await writeFile(receiptPath, canonicalJson(receipt));
    await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_OBSERVATION_PRECEDES_SOURCE/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("requires a distinct final cleanup attestor and zero residuals after all six acceptances", async (t) => {
  await t.test("missing cleanup receipt", async () => {
    const fixture = await createFixture();
    try {
      delete fixture.input.cleanupReceiptPath;
      await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_INPUT_KEYS_INVALID/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
  await t.test("signed nonzero residual", async () => {
    const fixture = await createFixture();
    try {
      const receipt = JSON.parse(await readFile(fixture.input.cleanupReceiptPath, "utf8"));
      receipt.payload.residualLiveObjectCount = 1;
      resignReceipt(receipt, fixture.trust.signingKeys[providerFinalCleanupRole]);
      await writeFile(fixture.input.cleanupReceiptPath, canonicalJson(receipt));
      await assert.rejects(runFixture(fixture), /PROVIDER_FINAL_CLEANUP_NOT_PASS/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

test("rejects source-byte tamper, sidecar tamper and receipt-signature tamper", async (t) => {
  await t.test("source bytes", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(fixture.input.sourcePath, `${await readFile(fixture.input.sourcePath, "utf8")} `);
      await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_SOURCE_DIGEST_MISMATCH/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
  await t.test("source sidecar", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        fixture.input.sourceSidecarPath,
        `${"f".repeat(64)}  provider-fail-closed-evidence.json\n`,
      );
      await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_SOURCE_SIDECAR_DIGEST_MISMATCH/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
  await t.test("signed receipt", async () => {
    const fixture = await createFixture();
    try {
      const receipt = JSON.parse(await readFile(fixture.input.receiptPaths[0], "utf8"));
      receipt.payload.observations[0].evidenceSha256 = "f".repeat(64);
      await writeFile(fixture.input.receiptPaths[0], canonicalJson(receipt));
      await assert.rejects(runFixture(fixture), /EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_MISMATCH/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

test("rejects replayed receipts against another deployment or another unchanged DB snapshot", async (t) => {
  await t.test("deployment replay", async () => {
    const fixture = await createFixture();
    try {
      const replayRuntime = {
        ...runtime,
        deploymentId: "dpl_ProviderAcceptanceCandidate02",
      };
      fixture.input.runtime = replayRuntime;
      await replacePinnedSource(fixture, rawCollector(replayRuntime));
      await assert.rejects(runFixture(fixture), /EXTERNAL_GATE_RUNTIME_DEPLOYMENTID_MISMATCH/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
  await t.test("database replay", async () => {
    const fixture = await createFixture();
    try {
      await replacePinnedSource(fixture, rawCollector(runtime, databasePostcondition(3)));
      await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_DATABASE_DIGEST_MISMATCH/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

test("rejects linked inputs and oversized artifacts before parsing", async (t) => {
  await t.test("symlink", async (symlinkTest) => {
    const fixture = await createFixture();
    try {
      const linkedPath = path.join(path.dirname(fixture.input.sourcePath), "source-link.json");
      try {
        await symlink(fixture.input.sourcePath, linkedPath, "file");
      } catch (error) {
        if (["EACCES", "EPERM"].includes(error?.code)) {
          symlinkTest.skip("Symlink creation is unavailable on this Windows host");
          return;
        }
        throw error;
      }
      fixture.input.sourcePath = linkedPath;
      await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_SOURCE_NOT_BOUNDED_REGULAR_FILE/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
  await t.test("oversize", async () => {
    const fixture = await createFixture();
    try {
      const oversized = Buffer.alloc(providerAcceptanceFreezeLimits.jsonBytes + 1, 0x20);
      await writeFile(fixture.input.sourcePath, oversized);
      fixture.input.expectedSourceSha256 = sha256(oversized);
      await writeFile(
        fixture.input.sourceSidecarPath,
        `${fixture.input.expectedSourceSha256}  provider-fail-closed-evidence.json\n`,
      );
      await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_SOURCE_NOT_BOUNDED_REGULAR_FILE/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
  await t.test("hard link", async () => {
    const fixture = await createFixture();
    try {
      const linkedPath = path.join(path.dirname(fixture.input.sourcePath), "source-hard-link.json");
      await link(fixture.input.sourcePath, linkedPath);
      await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_SOURCE_NOT_BOUNDED_REGULAR_FILE/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
  await t.test("oversized receipt", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        fixture.input.receiptPaths[0],
        Buffer.alloc(providerAcceptanceFreezeLimits.receiptBytes + 1, 0x20),
      );
      await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_RECEIPT_1_NOT_BOUNDED_REGULAR_FILE/u);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

test("rejects oversized stdin before any path is opened", async () => {
  await assert.rejects(
    providerAcceptanceEvidenceFreezeMain({
      inputStream: Readable.from([Buffer.alloc(providerAcceptanceFreezeLimits.stdinBytes + 1, 0x20)]),
      outputStream: { write() { return true; } },
    }),
    /PROVIDER_ACCEPTANCE_STDIN_TOO_LARGE/u,
  );
});

test("exclusive output never overwrites an existing provider-boundaries artifact", async () => {
  const fixture = await createFixture();
  try {
    await runFixture(fixture);
    await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_OUTPUT_EXISTS/u);
    assert.equal(JSON.parse(await readFile(path.join(fixture.outputDirectory, "provider-boundaries.json"), "utf8")).releaseGateStatus, "PASS");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("signed provider-token-shaped material is not persisted into final evidence", async () => {
  const fixture = await createFixture({ signerSubject: "subject:re_abcdefghijklmnop" });
  try {
    await assert.rejects(runFixture(fixture), /PROVIDER_ACCEPTANCE_OUTPUT_SECRET_PATTERN_DETECTED/u);
    await assert.rejects(readFile(path.join(fixture.outputDirectory, "provider-boundaries.json")), /ENOENT/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
