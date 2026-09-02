#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertRecoveryGoResult,
  buildRecoveryDataFingerprint,
  collectRecoveryEvidenceInventory,
  expectedExcludedMigrations,
  expectedRecoveryMigrationPlan,
  readBoundedRegularRecoveryFile,
  readCommittedRegularRecoveryFile,
  verifyRecoveryEvidence,
  verifyRecoveryEvidenceForFinalAttestation,
} from "./database-recovery-evidence-verify.mjs";
import { buildSignedRecoveryLiveEvidenceFixture } from "./database-recovery-live-evidence-tests.mjs";

const manifestPath = new URL(
  "../docs/audit/2026-08-23/database-recovery-evidence-manifest.json",
  import.meta.url,
);
const rollbackPath = new URL(
  "../docs/audit/2026-08-23/database-recovery-rollback-evidence.json",
  import.meta.url,
);
const verifierPath = new URL("./database-recovery-evidence-verify.mjs", import.meta.url);
const [manifest, rollback, verifierSource] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(rollbackPath, "utf8").then(JSON.parse),
  readFile(verifierPath, "utf8"),
]);

test("Historical unsigned Recovery evidence stays BLOCKED despite its old declared PASS", async () => {
  const result = await verifyRecoveryEvidence({ expectedCandidateCommit: manifest.candidateCommit });
  assert.equal(result.ok, true);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.passEligible, false);
  assert.equal(result.technicalPassEligible, false);
  assert.equal(result.historicalOnly, true);
  assert.equal(result.signatureStatus, "PENDING_SIGNATURE");
  assert.equal(result.declaredManifestStatus, "CURRENT_SHA_REHEARSAL_AND_RESET_PASS");
  assert.equal(result.candidateCommit, manifest.candidateCommit);
  assert.match(result.candidateCommit, /^[a-f0-9]{40}$/u);
  assert.equal(result.migrationCount, 14);
  assert.equal(result.liveEvidenceCount, 0);
  assert.equal(
    result.excludedFailedAttempts,
    manifest.evidence.filter((entry) => entry.role === "EXCLUDED_FAILED_ATTEMPT").length,
  );
  assert.equal(result.productionMutationPerformed, false);
  assert.match(result.manifestDigest, /^[a-f0-9]{64}$/u);
  assert.ok(result.inventory.length >= 12);
  assert.equal(new Set(result.inventory.map((entry) => entry.path)).size, result.inventory.length);
  const exported = await collectRecoveryEvidenceInventory({
    expectedCandidateCommit: manifest.candidateCommit,
  });
  assert.deepEqual(exported.inventory, result.inventory);
  assert.equal(exported.passEligible, false);
});

test("Evidence manifest separates the selected PASS from all failed attempts", () => {
  const selected = manifest.evidence.filter((entry) => entry.role === "SELECTED_PASS");
  const failed = manifest.evidence.filter((entry) => entry.role === "EXCLUDED_FAILED_ATTEMPT");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].passEligible, true);
  assert.match(selected[0].sha256, /^[a-f0-9]{64}$/u);
  assert.ok(failed.every((entry) => entry.passEligible === false));
  assert.deepEqual(manifest.explicitlyExcludedMigrations, expectedExcludedMigrations);
  assert.deepEqual(rollback.rehearsal.appliedMigrations, expectedRecoveryMigrationPlan);
});

test("Rollback contract binds distinct preserved/reset branches to equal data fingerprints", () => {
  assert.equal(
    rollback.rehearsal.preservedMigratedBranchId,
    manifest.rollback.preservedMigratedBranchId,
  );
  assert.equal(rollback.reset.resetRecoveryBranchId, manifest.rollback.resetRecoveryBranchId);
  assert.notEqual(
    rollback.rehearsal.preservedMigratedBranchId,
    rollback.reset.resetRecoveryBranchId,
  );
  const productionDigest = buildRecoveryDataFingerprint(rollback.reset.productionFingerprint);
  const recoveryDigest = buildRecoveryDataFingerprint(rollback.reset.recoveryFingerprint);
  assert.equal(productionDigest, recoveryDigest);
  assert.equal(productionDigest, manifest.rollback.dataFingerprintSha256);
  assert.equal(Object.keys(rollback.reset.productionFingerprint.rowCounts).length, 19);
  assert.equal(rollback.reset.productionFingerprint.migrationLedger.count, 19);
  assert.equal(
    rollback.reset.productionFingerprint.migrationLedger.maxVersion,
    "067_app_role_runtime_grants",
  );
  assert.equal(rollback.reset.rowCountMismatchCount, 0);
});

test("Recovery evidence cannot be relabelled as a different runtime candidate", async () => {
  const relabelledCandidate = manifest.candidateCommit === "f".repeat(40)
    ? "e".repeat(40)
    : "f".repeat(40);
  await assert.rejects(
    verifyRecoveryEvidence({ expectedCandidateCommit: relabelledCandidate }),
    /RECOVERY_EXPECTED_CANDIDATE_MISMATCH/u,
  );
});

test("Recovery verifier CLI exits non-zero for historical/PENDING evidence", () => {
  const result = spawnSync(process.execPath, [
    "scripts/database-recovery-evidence-verify.mjs",
    `--expected-candidate=${manifest.candidateCommit}`,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "BLOCKED");
  assert.equal(output.passEligible, false);
  assert.equal(output.signatureStatus, "PENDING_SIGNATURE");

  const requireGo = spawnSync(process.execPath, [
    "scripts/database-recovery-evidence-verify.mjs",
    "--require-go",
    `--expected-candidate=${manifest.candidateCommit}`,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(requireGo.status, 1, requireGo.stderr);
  assert.deepEqual(JSON.parse(requireGo.stderr), {
    errorCode: "RECOVERY_GO_EVIDENCE_COMMIT_REQUIRED",
    ok: false,
  });
});

test("Schema diff HTTP 413 remains a non-PASS tool boundary", () => {
  assert.equal(rollback.schemaDiffApi.status, "UNAVAILABLE_HTTP_413_TOOL_LIMIT");
  assert.equal(rollback.schemaDiffApi.countedAsPassEvidence, false);
  assert.equal(manifest.schemaDiffApi.status, "UNAVAILABLE_HTTP_413_TOOL_LIMIT");
  assert.equal(manifest.schemaDiffApi.countedAsPassEvidence, false);
});

test("Evidence verifier has no mutation or network capability and uses bounded regular-file reads", () => {
  assert.doesNotMatch(verifierSource, /\b(?:writeFile|appendFile|unlink|rm|mkdir|mkdtemp)\b/u);
  assert.doesNotMatch(verifierSource, /\b(?:fetch|WebSocket|neon)\b/u);
  assert.doesNotMatch(verifierSource, /MIGRATION_DATABASE_URL/u);
  assert.match(verifierSource, /lstat/u);
  assert.match(verifierSource, /O_NOFOLLOW/u);
  assert.match(verifierSource, /ls-tree/u);
  assert.match(verifierSource, /FINAL_LIVE_COLLECTOR_PASS/u);
  assert.match(verifierSource, /verifyDatabaseRecoveryLiveEvidence/u);
});

function git(root, args, { input } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeHashedJson(root, relativePath, value) {
  const absolutePath = join(root, ...relativePath.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  const source = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(absolutePath, source, { flag: "wx" });
  const digest = sha256(source);
  const sidecarPath = `${relativePath}.sha256`;
  await writeFile(
    join(root, ...sidecarPath.split("/")),
    `${digest}  ${basename(relativePath)}\n`,
    { flag: "wx" },
  );
  return Object.freeze({ path: relativePath, sha256: digest, sidecarPath });
}

async function createFinalRecoveryRepository({ candidateMode = "ancestor" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "novalure-recovery-final-verifier-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "recovery-final-test@example.invalid"]);
    git(root, ["config", "user.name", "Recovery Final Test"]);
    await writeFile(join(root, "runtime.js"), "export const runtime = 'candidate';\n", {
      flag: "wx",
    });
    git(root, ["add", "runtime.js"]);
    git(root, ["commit", "-m", "runtime candidate"]);
    const runtimeCandidateCommit = git(root, ["rev-parse", "HEAD"]);

    let candidateCommit = runtimeCandidateCommit;
    if (candidateMode === "missing") {
      candidateCommit = "f".repeat(40);
    } else if (candidateMode === "unrelated") {
      const emptyTree = git(root, ["mktree"], { input: "" });
      candidateCommit = git(root, ["commit-tree", emptyTree, "-m", "unrelated candidate"]);
    }

    const signed = buildSignedRecoveryLiveEvidenceFixture({
      expectedCandidateCommit: candidateCommit,
    });
    const live = signed.evidence;
    const selectedManifestEntry = manifest.evidence.find(
      (entry) => entry.role === "SELECTED_PASS",
    );
    const selected = JSON.parse(await readFile(
      resolve(process.cwd(), selectedManifestEntry.path),
      "utf8",
    ));
    selected.candidateCommit = candidateCommit;
    selected.branchId = live.branches.recoveryBranchId;
    const selectedFile = await writeHashedJson(root, "evidence/selected.json", selected);

    const failedFiles = [];
    const failedManifestEntries = manifest.evidence.filter(
      (entry) => entry.role === "EXCLUDED_FAILED_ATTEMPT",
    );
    for (const [index, entry] of failedManifestEntries.entries()) {
      const failed = JSON.parse(await readFile(resolve(process.cwd(), entry.path), "utf8"));
      failed.candidateCommit = candidateCommit;
      failedFiles.push(await writeHashedJson(root, `evidence/failed-${index + 1}.json`, failed));
    }

    const finalRollback = structuredClone(rollback);
    finalRollback.candidateCommit = candidateCommit;
    finalRollback.rehearsal.selectedEvidencePath = selectedFile.path;
    finalRollback.rehearsal.selectedEvidenceSha256 = selectedFile.sha256;
    finalRollback.rehearsal.sourceBranchIdAtExecution = live.branches.recoveryBranchId;
    finalRollback.rehearsal.preservedMigratedBranchId =
      live.branches.preservedMigratedBranchId;
    finalRollback.reset.resetRecoveryBranchId = live.branches.recoveryBranchId;
    finalRollback.schemaDiffApi = {
      countedAsPassEvidence: true,
      diffSha256: sha256(""),
      status: "PASS_EMPTY",
    };
    const rollbackFile = await writeHashedJson(root, "evidence/rollback.json", finalRollback);
    const liveFile = await writeHashedJson(root, "evidence/live.json", live);

    const finalManifest = structuredClone(manifest);
    finalManifest.schemaVersion = 2;
    finalManifest.status = "CURRENT_SHA_REHEARSAL_AND_RESET_PASS";
    finalManifest.candidateCommit = candidateCommit;
    finalManifest.signatureStatus = "VERIFIED";
    finalManifest.evidence = [
      { ...selectedFile, passEligible: true, role: "SELECTED_PASS" },
      ...failedFiles.map((entry) => ({
        ...entry,
        passEligible: false,
        role: "EXCLUDED_FAILED_ATTEMPT",
      })),
      { ...rollbackFile, passEligible: true, role: "ROLLBACK_RESET_PASS" },
      { ...liveFile, passEligible: true, role: "FINAL_LIVE_COLLECTOR_PASS" },
    ];
    finalManifest.rollback.preservedMigratedBranchId =
      live.branches.preservedMigratedBranchId;
    finalManifest.rollback.resetRecoveryBranchId = live.branches.recoveryBranchId;
    finalManifest.schemaDiffApi = {
      countedAsPassEvidence: true,
      diffSha256: sha256(""),
      status: "PASS_EMPTY",
    };
    await writeHashedJson(
      root,
      "docs/audit/2026-08-23/database-recovery-evidence-manifest.json",
      finalManifest,
    );

    git(root, ["add", "."]);
    git(root, ["commit", "-m", "signed Recovery evidence"]);
    return Object.freeze({
      candidateCommit,
      evidenceCommit: git(root, ["rev-parse", "HEAD"]),
      root,
      runtimeCandidateCommit,
      trustAnchor: signed.trustAnchor,
    });
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

async function removeTemporaryRecoveryRepository(root) {
  assert.ok(resolve(root).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()));
  await rm(root, { force: true, recursive: true });
}

test("Final signed Recovery evidence returns PASS only for the bound clean Evidence commit", async () => {
  const fixture = await createFinalRecoveryRepository();
  try {
    const result = await verifyRecoveryEvidence({
      evidenceCommit: fixture.evidenceCommit,
      expectedCandidateCommit: fixture.candidateCommit,
      repositoryRoot: fixture.root,
      trustAnchor: fixture.trustAnchor,
    });
    assert.equal(result.status, "PASS");
    assert.equal(result.passEligible, true);
    assert.equal(result.technicalPassEligible, true);
    assert.equal(result.signatureStatus, "VERIFIED");
    assert.equal(result.evidenceCommit, fixture.evidenceCommit);
    assert.equal(
      assertRecoveryGoResult(result, { expectedEvidenceCommit: fixture.evidenceCommit }),
      result,
    );

    assert.throws(
      () => assertRecoveryGoResult(
        { ...result, passEligible: false },
        { expectedEvidenceCommit: fixture.evidenceCommit },
      ),
      /RECOVERY_GO_NOT_PASS_ELIGIBLE/u,
    );
    assert.throws(
      () => assertRecoveryGoResult(
        { ...result, signatureStatus: "PENDING_SIGNATURE" },
        { expectedEvidenceCommit: fixture.evidenceCommit },
      ),
      /RECOVERY_GO_SIGNATURE_NOT_VERIFIED/u,
    );
    assert.throws(
      () => assertRecoveryGoResult(result, { expectedEvidenceCommit: "e".repeat(40) }),
      /RECOVERY_GO_EVIDENCE_COMMIT_MISMATCH/u,
    );

    await writeFile(join(fixture.root, "runtime.js"), "export const runtime = 'dirty';\n");
    await assert.rejects(
      verifyRecoveryEvidence({
        evidenceCommit: fixture.evidenceCommit,
        expectedCandidateCommit: fixture.candidateCommit,
        repositoryRoot: fixture.root,
        trustAnchor: fixture.trustAnchor,
      }),
      /RECOVERY_EVIDENCE_WORKTREE_DIRTY/u,
    );
    git(fixture.root, ["restore", "runtime.js"]);

    await writeFile(join(fixture.root, "runtime.js"), "export const runtime = 'later-head';\n");
    git(fixture.root, ["add", "runtime.js"]);
    git(fixture.root, ["commit", "-m", "later runtime drift"]);
    const laterHead = git(fixture.root, ["rev-parse", "HEAD"]);
    await assert.rejects(
      verifyRecoveryEvidence({
        evidenceCommit: fixture.evidenceCommit,
        expectedCandidateCommit: fixture.candidateCommit,
        repositoryRoot: fixture.root,
        trustAnchor: fixture.trustAnchor,
      }),
      /RECOVERY_EVIDENCE_HEAD_MISMATCH/u,
    );

    const repositoryProvenance = Object.freeze({
      evidenceCommit: fixture.evidenceCommit,
      head: laterHead,
      status: "PASS",
    });
    await assert.rejects(
      verifyRecoveryEvidenceForFinalAttestation({
        evidenceCommit: fixture.evidenceCommit,
        expectedCandidateCommit: fixture.candidateCommit,
        repositoryProvenance,
        repositoryRoot: fixture.root,
      }),
      /RECOVERY_EXTERNAL_TRUST_ANCHOR_REQUIRED/u,
    );
    const finalResult = await verifyRecoveryEvidenceForFinalAttestation({
      evidenceCommit: fixture.evidenceCommit,
      expectedCandidateCommit: fixture.candidateCommit,
      repositoryProvenance,
      repositoryRoot: fixture.root,
      trustAnchor: fixture.trustAnchor,
    });
    assert.equal(finalResult.status, "PASS");
    assert.equal(finalResult.passEligible, true);
    assert.equal(finalResult.signatureStatus, "VERIFIED");
    assert.equal(finalResult.evidenceCommit, fixture.evidenceCommit);

    await assert.rejects(
      verifyRecoveryEvidenceForFinalAttestation({
        evidenceCommit: fixture.evidenceCommit,
        expectedCandidateCommit: fixture.candidateCommit,
        repositoryProvenance: { ...repositoryProvenance, evidenceCommit: "d".repeat(40) },
        repositoryRoot: fixture.root,
        trustAnchor: fixture.trustAnchor,
      }),
      /RECOVERY_FINAL_REPOSITORY_PROVENANCE_INVALID/u,
    );
    await assert.rejects(
      verifyRecoveryEvidenceForFinalAttestation({
        evidenceCommit: fixture.evidenceCommit,
        expectedCandidateCommit: fixture.candidateCommit,
        repositoryProvenance: { ...repositoryProvenance, head: fixture.evidenceCommit },
        repositoryRoot: fixture.root,
        trustAnchor: fixture.trustAnchor,
      }),
      /RECOVERY_FINAL_REPOSITORY_HEAD_MISMATCH/u,
    );
  } finally {
    await removeTemporaryRecoveryRepository(fixture.root);
  }
});

test("Final Recovery verifier rejects missing and non-ancestor candidate commits", async () => {
  for (const [candidateMode, errorPattern] of [
    ["missing", /RECOVERY_CANDIDATE_COMMIT_NOT_FOUND/u],
    ["unrelated", /RECOVERY_CANDIDATE_NOT_ANCESTOR_OF_EVIDENCE/u],
  ]) {
    const fixture = await createFinalRecoveryRepository({ candidateMode });
    try {
      await assert.rejects(
        verifyRecoveryEvidence({
          evidenceCommit: fixture.evidenceCommit,
          expectedCandidateCommit: fixture.candidateCommit,
          repositoryRoot: fixture.root,
          trustAnchor: fixture.trustAnchor,
        }),
        errorPattern,
      );
    } finally {
      await removeTemporaryRecoveryRepository(fixture.root);
    }
  }
});

test("Bounded Recovery reader rejects intermediate directory junctions", async () => {
  const root = await mkdtemp(join(tmpdir(), "novalure-recovery-reparse-test-"));
  try {
    const realDirectory = join(root, "real-evidence");
    const junctionDirectory = join(root, "junction-evidence");
    await mkdir(realDirectory);
    await writeFile(join(realDirectory, "recovery.json"), "{\"status\":\"PASS\"}\n");
    await symlink(
      realDirectory,
      junctionDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      readBoundedRegularRecoveryFile({
        absolutePath: join(junctionDirectory, "recovery.json"),
        repositoryRoot: root,
      }),
      /RECOVERY_EVIDENCE_PATH_COMPONENT_REPARSE/u,
    );
  } finally {
    await removeTemporaryRecoveryRepository(root);
  }
});

test("Committed Recovery reader accepts only CRLF checkout expansion and rejects real drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "novalure-recovery-evidence-git-test-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "recovery-test@example.invalid"]);
    git(root, ["config", "user.name", "Recovery Test"]);
    const relativePath = "evidence/recovery.json";
    await mkdir(join(root, "evidence"));
    await writeFile(join(root, relativePath), "{\"status\":\"BLOCKED\"}\n", { flag: "wx" });
    git(root, ["add", relativePath]);
    git(root, ["commit", "-m", "evidence"]);
    const commit = git(root, ["rev-parse", "HEAD"]);
    await writeFile(join(root, relativePath), "{\"status\":\"BLOCKED\"}\r\n");
    git(root, ["diff", "--quiet", "--", relativePath]);
    const source = await readCommittedRegularRecoveryFile({
      evidenceCommit: commit,
      relativePath,
      repositoryRoot: root,
    });
    assert.equal(source.toString("utf8"), "{\"status\":\"BLOCKED\"}\n");
    await writeFile(join(root, relativePath), "{\"status\":\"PASS\"}\r\n");
    await assert.rejects(
      readCommittedRegularRecoveryFile({
        evidenceCommit: commit,
        relativePath,
        repositoryRoot: root,
      }),
      /RECOVERY_EVIDENCE_CURRENT_WORKTREE_DRIFT/u,
    );
    await assert.rejects(
      readCommittedRegularRecoveryFile({
        evidenceCommit: commit,
        relativePath: "https://example.invalid/recovery.json",
        repositoryRoot: root,
      }),
      /RECOVERY_EVIDENCE_PATH_INVALID/u,
    );

    const linkBlob = git(root, ["hash-object", "-w", "--stdin"], { input: `${relativePath}\n` });
    git(root, ["update-index", "--add", "--cacheinfo", `120000,${linkBlob},evidence/link.json`]);
    git(root, ["commit", "-m", "symlink blob"]);
    const symlinkCommit = git(root, ["rev-parse", "HEAD"]);
    await assert.rejects(
      readCommittedRegularRecoveryFile({
        evidenceCommit: symlinkCommit,
        relativePath: "evidence/link.json",
        repositoryRoot: root,
        requireWorktreeMatch: false,
      }),
      /RECOVERY_EVIDENCE_COMMITTED_FILE_NOT_REGULAR/u,
    );
  } finally {
    const resolvedRoot = root.toLowerCase();
    assert.ok(resolvedRoot.startsWith(tmpdir().toLowerCase()));
    await rm(root, { force: true, recursive: true });
  }
});

test("Canonical data fingerprint rejects incomplete or malformed rollback captures", () => {
  const incomplete = {
    migrationLedger: rollback.reset.productionFingerprint.migrationLedger,
    rowCounts: { ...rollback.reset.productionFingerprint.rowCounts },
  };
  delete incomplete.rowCounts.workspaces;
  assert.throws(
    () => buildRecoveryDataFingerprint(incomplete),
    /RECOVERY_ROW_TABLE_COUNT_MISMATCH/u,
  );
});
