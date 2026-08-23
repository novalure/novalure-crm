#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestRelativePath =
  "docs/audit/2026-08-23/database-recovery-evidence-manifest.json";

export const expectedRecoveryMigrationPlan = Object.freeze([
  "057_bot_webhook_legacy_index_cutover",
  "060_tenant_rls_pilot_prepare",
  "068_qa_batch_reset_safety",
  "069_property_unit_idempotency",
  "070_funnel_submission_idempotency_recovery",
  "071_forms_owner_tenant_guard",
  "072_form_submission_atomicity",
  "073_launch_tenant_relation_guards",
  "074_validate_launch_tenant_relation_guards",
  "075_public_funnel_visit_truth",
  "076_bot_webhook_durable_processing",
  "077_schema_ledger_runtime_projection",
  "078_company_profile_approval_integrity",
  "079_public_funnel_visit_role_boundary",
]);

export const expectedExcludedMigrations = Object.freeze([
  "061_validate_and_activate_tenant_rls_pilot",
  "062_private_media_contract_cutover",
  "065_notification_guard_search_path_hardening",
]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function resolveRepositoryFile(relativePath) {
  invariant(
    typeof relativePath === "string"
      && relativePath.length > 0
      && !relativePath.includes("\\"),
    "RECOVERY_EVIDENCE_PATH_INVALID",
  );
  const target = resolve(repositoryRoot, relativePath);
  const targetRelative = relative(repositoryRoot, target);
  invariant(
    targetRelative !== ""
      && targetRelative !== ".."
      && !targetRelative.startsWith(`..${sep}`),
    "RECOVERY_EVIDENCE_PATH_ESCAPED_REPOSITORY",
  );
  return target;
}

function parseSidecar(source, expectedFileName) {
  const match = String(source).trim().match(/^([a-f0-9]{64})  ([^\r\n]+)$/u);
  invariant(match, "RECOVERY_EVIDENCE_SIDECAR_INVALID");
  invariant(match[2] === expectedFileName, "RECOVERY_EVIDENCE_SIDECAR_FILENAME_MISMATCH");
  return match[1];
}

async function readHashedJson(entry) {
  invariant(entry && typeof entry === "object", "RECOVERY_EVIDENCE_ENTRY_INVALID");
  invariant(/^[a-f0-9]{64}$/u.test(entry.sha256), "RECOVERY_EVIDENCE_DIGEST_INVALID");
  const path = resolveRepositoryFile(entry.path);
  const sidecarPath = resolveRepositoryFile(entry.sidecarPath);
  const [source, sidecar] = await Promise.all([
    readFile(path),
    readFile(sidecarPath, "utf8"),
  ]);
  const actualDigest = sha256(source);
  invariant(actualDigest === entry.sha256, "RECOVERY_EVIDENCE_MANIFEST_DIGEST_MISMATCH");
  invariant(
    parseSidecar(sidecar, basename(path)) === actualDigest,
    "RECOVERY_EVIDENCE_SIDECAR_DIGEST_MISMATCH",
  );
  return { digest: actualDigest, json: JSON.parse(source.toString("utf8")), source };
}

function validateLedger(ledger) {
  invariant(ledger && typeof ledger === "object", "RECOVERY_LEDGER_INVALID");
  invariant(ledger.count === 19, "RECOVERY_LEDGER_COUNT_MISMATCH");
  invariant(
    ledger.maxVersion === "067_app_role_runtime_grants",
    "RECOVERY_LEDGER_MAX_VERSION_MISMATCH",
  );
}

export function buildRecoveryDataFingerprint({ migrationLedger, rowCounts }) {
  validateLedger(migrationLedger);
  invariant(rowCounts && typeof rowCounts === "object", "RECOVERY_ROW_COUNTS_INVALID");
  const entries = Object.entries(rowCounts).sort(([left], [right]) => left.localeCompare(right));
  invariant(entries.length === 19, "RECOVERY_ROW_TABLE_COUNT_MISMATCH");
  for (const [table, count] of entries) {
    invariant(/^[a-z][a-z0-9_]*$/u.test(table), "RECOVERY_ROW_TABLE_NAME_INVALID");
    invariant(Number.isSafeInteger(count) && count >= 0, "RECOVERY_ROW_COUNT_INVALID");
  }
  const canonical = JSON.stringify({
    migrationLedger: {
      count: migrationLedger.count,
      maxVersion: migrationLedger.maxVersion,
    },
    rowCounts: Object.fromEntries(entries),
  });
  return sha256(canonical);
}

function validateFingerprint(subject, expectedDigest) {
  invariant(subject && typeof subject === "object", "RECOVERY_FINGERPRINT_SUBJECT_INVALID");
  const digest = buildRecoveryDataFingerprint(subject);
  invariant(subject.dataFingerprintSha256 === digest, "RECOVERY_DATA_FINGERPRINT_INVALID");
  invariant(digest === expectedDigest, "RECOVERY_DATA_FINGERPRINT_MISMATCH");
  return digest;
}

function scanForSecretMaterial(sources) {
  const combined = sources.map((source) => source.toString("utf8")).join("\n");
  for (const forbidden of [
    /postgres(?:ql)?:\/\/[^\s"'<>]+/iu,
    /_vercel_share=/iu,
    /vercel_blob_rw_/iu,
    /(?:password|passwd)\s*[:=]\s*[^\s,}]+/iu,
  ]) {
    invariant(!forbidden.test(combined), "RECOVERY_EVIDENCE_SECRET_PATTERN_DETECTED");
  }
}

function validateRehearsalEvidence(evidence, manifest) {
  invariant(evidence.status === "PASS", "RECOVERY_REHEARSAL_SELECTED_EVIDENCE_NOT_PASS");
  invariant(
    evidence.candidateCommit === manifest.candidateCommit,
    "RECOVERY_REHEARSAL_CANDIDATE_MISMATCH",
  );
  invariant(
    evidence.branchId === manifest.rollback.resetRecoveryBranchId,
    "RECOVERY_REHEARSAL_BRANCH_MISMATCH",
  );
  invariant(evidence.environment === "RECOVERY_BRANCH_ONLY", "RECOVERY_REHEARSAL_SCOPE_INVALID");
  invariant(evidence.productionMutationPerformed === false, "RECOVERY_PRODUCTION_MUTATION_RECORDED");
  invariant(evidence.migration061Executed === false, "RECOVERY_MIGRATION_061_RECORDED");
  invariant(
    sameArray(evidence.records?.map((record) => record.version), expectedRecoveryMigrationPlan),
    "RECOVERY_REHEARSAL_PLAN_MISMATCH",
  );
  invariant(
    evidence.records.every(
      (record) => record.dryRun === "PASS"
        && record.up === "PASS"
        && /^[a-f0-9]{64}$/u.test(record.checksum),
    ),
    "RECOVERY_REHEARSAL_RECORD_NOT_PASS",
  );
}

function validateRollbackEvidence(evidence, manifest) {
  invariant(evidence.status === "PASS", "RECOVERY_ROLLBACK_EVIDENCE_NOT_PASS");
  invariant(
    evidence.candidateCommit === manifest.candidateCommit,
    "RECOVERY_ROLLBACK_CANDIDATE_MISMATCH",
  );
  invariant(evidence.productionMutationPerformed === false, "RECOVERY_ROLLBACK_PRODUCTION_MUTATION");
  invariant(
    evidence.productionAliasOrEnvironmentChanged === false,
    "RECOVERY_ROLLBACK_PRODUCTION_ENVIRONMENT_CHANGED",
  );
  invariant(
    sameArray(evidence.explicitlyExcludedMigrations, expectedExcludedMigrations),
    "RECOVERY_ROLLBACK_EXCLUSION_MISMATCH",
  );
  const selectedPass = manifest.evidence.find((entry) => entry.role === "SELECTED_PASS");
  invariant(
    evidence.rehearsal.selectedEvidencePath === selectedPass?.path
      && evidence.rehearsal.selectedEvidenceSha256 === selectedPass?.sha256,
    "RECOVERY_ROLLBACK_REHEARSAL_SOURCE_MISMATCH",
  );
  invariant(
    evidence.rehearsal.preservedMigratedBranchId === manifest.rollback.preservedMigratedBranchId,
    "RECOVERY_PRESERVED_BRANCH_MISMATCH",
  );
  invariant(
    evidence.reset.resetRecoveryBranchId === manifest.rollback.resetRecoveryBranchId,
    "RECOVERY_RESET_BRANCH_MISMATCH",
  );
  invariant(
    evidence.rehearsal.preservedMigratedBranchId !== evidence.reset.resetRecoveryBranchId,
    "RECOVERY_ROLLBACK_BRANCHES_NOT_SEPARATE",
  );
  invariant(
    sameArray(evidence.rehearsal.appliedMigrations, expectedRecoveryMigrationPlan),
    "RECOVERY_ROLLBACK_PLAN_MISMATCH",
  );
  invariant(evidence.reset.comparisonResult === "PASS", "RECOVERY_RESET_COMPARISON_NOT_PASS");
  invariant(evidence.reset.rowCountMismatchCount === 0, "RECOVERY_RESET_ROW_COUNT_MISMATCH");
  const productionDigest = validateFingerprint(
    evidence.reset.productionFingerprint,
    manifest.rollback.dataFingerprintSha256,
  );
  const resetDigest = validateFingerprint(
    evidence.reset.recoveryFingerprint,
    manifest.rollback.dataFingerprintSha256,
  );
  invariant(productionDigest === resetDigest, "RECOVERY_RESET_FINGERPRINTS_DIFFER");
  invariant(
    evidence.schemaDiffApi.status === "UNAVAILABLE_HTTP_413_TOOL_LIMIT"
      && evidence.schemaDiffApi.countedAsPassEvidence === false,
    "RECOVERY_SCHEMA_DIFF_TOOL_LIMIT_MISREPRESENTED",
  );
}

export async function verifyRecoveryEvidence() {
  const manifestPath = resolveRepositoryFile(manifestRelativePath);
  const [manifestSource, manifestSidecar] = await Promise.all([
    readFile(manifestPath),
    readFile(`${manifestPath}.sha256`, "utf8"),
  ]);
  const manifestDigest = sha256(manifestSource);
  invariant(
    parseSidecar(manifestSidecar, basename(manifestPath)) === manifestDigest,
    "RECOVERY_MANIFEST_SIDECAR_DIGEST_MISMATCH",
  );
  const manifest = JSON.parse(manifestSource.toString("utf8"));
  invariant(manifest.schemaVersion === 1, "RECOVERY_MANIFEST_SCHEMA_UNSUPPORTED");
  invariant(
    manifest.status === "CURRENT_SHA_REHEARSAL_AND_RESET_PASS",
    "RECOVERY_MANIFEST_STATUS_INVALID",
  );
  invariant(/^[a-f0-9]{40}$/u.test(manifest.candidateCommit), "RECOVERY_CANDIDATE_INVALID");
  invariant(manifest.productionMutationPerformed === false, "RECOVERY_MANIFEST_PRODUCTION_MUTATION");
  invariant(
    sameArray(manifest.explicitlyExcludedMigrations, expectedExcludedMigrations),
    "RECOVERY_MANIFEST_EXCLUSION_MISMATCH",
  );
  invariant(
    manifest.schemaDiffApi.status === "UNAVAILABLE_HTTP_413_TOOL_LIMIT"
      && manifest.schemaDiffApi.countedAsPassEvidence === false,
    "RECOVERY_MANIFEST_SCHEMA_DIFF_MISREPRESENTED",
  );
  invariant(manifest.signatureStatus === "PENDING_SIGNATURE", "RECOVERY_SIGNATURE_STATUS_INVALID");
  invariant(manifest.rollback.tableCount === 19, "RECOVERY_MANIFEST_TABLE_COUNT_INVALID");
  invariant(manifest.rollback.migrationLedgerCount === 19, "RECOVERY_MANIFEST_LEDGER_COUNT_INVALID");
  invariant(
    manifest.rollback.migrationLedgerMaxVersion === "067_app_role_runtime_grants",
    "RECOVERY_MANIFEST_LEDGER_MAX_INVALID",
  );
  invariant(manifest.rollback.rowCountMismatchCount === 0, "RECOVERY_MANIFEST_ROW_MISMATCH");

  const selectedEntries = manifest.evidence.filter((entry) => entry.role === "SELECTED_PASS");
  const failedEntries = manifest.evidence.filter((entry) => entry.role === "EXCLUDED_FAILED_ATTEMPT");
  const rollbackEntries = manifest.evidence.filter((entry) => entry.role === "ROLLBACK_RESET_PASS");
  invariant(selectedEntries.length === 1, "RECOVERY_SELECTED_PASS_CARDINALITY_INVALID");
  invariant(selectedEntries[0].passEligible === true, "RECOVERY_SELECTED_PASS_NOT_ELIGIBLE");
  invariant(failedEntries.length === 3, "RECOVERY_FAILED_ATTEMPT_CARDINALITY_INVALID");
  invariant(rollbackEntries.length === 1, "RECOVERY_ROLLBACK_CARDINALITY_INVALID");

  const sources = [manifestSource];
  const selected = await readHashedJson(selectedEntries[0]);
  sources.push(selected.source);
  validateRehearsalEvidence(selected.json, manifest);

  for (const entry of failedEntries) {
    invariant(entry.passEligible === false, "RECOVERY_FAILED_ATTEMPT_NOT_EXCLUDED");
    const failed = await readHashedJson(entry);
    sources.push(failed.source);
    invariant(failed.json.status === "FAIL", "RECOVERY_EXCLUDED_ATTEMPT_NOT_FAIL");
    invariant(
      failed.json.candidateCommit === manifest.candidateCommit,
      "RECOVERY_FAILED_ATTEMPT_CANDIDATE_MISMATCH",
    );
  }

  const rollback = await readHashedJson(rollbackEntries[0]);
  sources.push(rollback.source);
  validateRollbackEvidence(rollback.json, manifest);
  scanForSecretMaterial(sources);

  return Object.freeze({
    candidateCommit: manifest.candidateCommit,
    excludedFailedAttempts: failedEntries.length,
    manifestDigest,
    migrationCount: expectedRecoveryMigrationPlan.length,
    ok: true,
    productionMutationPerformed: false,
    resetRecoveryBranchId: manifest.rollback.resetRecoveryBranchId,
    status: manifest.status,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await verifyRecoveryEvidence()));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: error instanceof Error ? error.message : "RECOVERY_EVIDENCE_VERIFY_FAILED",
      ok: false,
    }));
    process.exitCode = 1;
  }
}
