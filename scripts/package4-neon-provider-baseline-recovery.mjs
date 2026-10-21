/**
 * Separate, explicitly pinned provider-baseline experiment. This never changes
 * the original zero-default-ACL recovery profile or reclassifies its FAIL.
 * Importing performs no filesystem, database or API operations.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonical, captureDatabaseMetadata } from "./lib/studio-stage3-qa-fingerprint.mjs";
import { assertPackage4RestoreIdentity, preparePackage4RecoveryDirectory, snapshotPackage4RecoveryDatabase } from "./package4-neon-restore.mjs";

export const package4ProviderRecoverySource = Object.freeze({ projectId: "green-thunder-49879900", branchId: "br-sweet-surf-ba6iahut",
  host: "ep-crimson-forest-ba4kk6sb.c-8.eu-central-1.aws.neon.tech", databaseName: "neondb", owner: "neondb_owner",
  parentBranchId: "br-flat-block-baycv1oa", originalRootBranchId: "br-shiny-darkness-baz4524v" });
export const package4ProviderRecordedSnapshotSha256 = "7760928f4cdbb479b4373818ff0c5ebe002b453df92a49dd513a387b53c250e7";
const hash = value => createHash("sha256").update(value).digest("hex");
const required = (condition, code) => assert.ok(condition, code);
const branchId = value => /^br-[a-z0-9-]{8,99}$/u.test(value || "");
const equal = (a, b) => canonical(a) === canonical(b);

async function readPinnedInitialSnapshot(filename) {
  const privateRoot = await realpath(path.resolve(".npm-cache/qa"));
  const actual = await realpath(filename);
  required(actual.startsWith(privateRoot + path.sep), "IGNORED_ORIGINAL_SNAPSHOT_REQUIRED");
  execFileSync("git", ["check-ignore", "--quiet", actual], { stdio: "ignore" });
  const info = await lstat(actual);
  required(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0, "PRIVATE_ORIGINAL_SNAPSHOT_REQUIRED");
  const bytes = await readFile(actual);
  required(hash(bytes) === package4ProviderRecordedSnapshotSha256, "ORIGINAL_PROVIDER_SNAPSHOT_BYTES_CHANGED");
  const recorded = JSON.parse(bytes);
  required(recorded.format === "package4-recovery-database-v1" && recorded.ledger?.length === 60 && recorded.catalog?.defaultGrants?.length === 9,
    "EXACT_RECORDED_PROVIDER_BASELINE_REQUIRED");
  required(recorded.catalog.defaultGrants.every(row => row.owner === "cloud_admin" && row.grantor === "cloud_admin" && row.grantee === "neon_superuser" && row.schema === "public" && row.is_grantable === true), "RECORDED_PROVIDER_DEFAULTS_CHANGED");
  const { sha256, ...body } = recorded;
  required(sha256 === hash(canonical(body)), "RECORDED_PROVIDER_STATE_DIGEST_INVALID");
  // This is the untouched evidence from the different, original root baseline.
  const failurePath = path.resolve(path.dirname(actual), "..", "database-recovery-result.json");
  const originalFailureBytes = await readFile(failurePath);
  const originalFailure = JSON.parse(originalFailureBytes);
  required(originalFailure.status === "FAIL" && originalFailure.source?.projectId === package4ProviderRecoverySource.projectId &&
    originalFailure.source?.branchId === package4ProviderRecoverySource.originalRootBranchId && originalFailure.failureCode === "DATABASE_CHECKPOINT_COW_COPY_MISMATCH",
    "ORIGINAL_STRICT_FAILURE_EVIDENCE_REQUIRED");
  return { recorded, originalFailure: { status: originalFailure.status, sourceBranchId: originalFailure.source.branchId,
    failureCode: originalFailure.failureCode, bytesSha256: hash(originalFailureBytes) } };
}

function sourceGuard(binding) {
  for (const field of ["projectId", "branchId", "host", "databaseName", "owner"]) required(binding?.[field] === package4ProviderRecoverySource[field], "EXACT_PROVIDER_BASELINE_SOURCE_REQUIRED");
  required(binding.syntheticOnly === true && binding.newIsolatedResource === true, "EXPLICIT_SYNTHETIC_PROVIDER_BASELINE_REQUIRED");
}
function metadataGuard(metadata, expectedId, expectedParent) {
  required(metadata?.id === expectedId && metadata.project_id === package4ProviderRecoverySource.projectId &&
    (metadata.parent_id ?? null) === expectedParent && metadata.current_state === "ready", "PROVIDER_BASELINE_BRANCH_PROVENANCE_MISMATCH");
}
function connectionGuard(connection, metadata, sourceBinding) {
  const binding = connection?.binding;
  required(binding?.projectId === sourceBinding.projectId && binding.branchId === metadata.id && binding.databaseName === "neondb" &&
    binding.owner === "neondb_owner" && Array.isArray(binding.workspaceIds) && equal([...binding.workspaceIds].sort(), [...sourceBinding.workspaceIds].sort()), "EXACT_CREATED_PROVIDER_BRANCH_CONNECTION_REQUIRED");
}
function applicationGuard(proof) {
  required(proof?.status === "PASS" && proof.databaseRole === "novalure_app" && proof.superuser === false && proof.bypassRls === false &&
    proof.ownsPublicObjects === 0 && Array.isArray(proof.checks) && proof.checks.length > 0 && proof.checks.every(item => item.status === "PASS"), "ACTUAL_LEAST_PRIVILEGE_DATABASE_APPLICATION_REQUIRED");
}

/** Capture all previous categories unchanged, and bind database ACL/settings too. */
async function capture(client, binding) {
  const snapshot = await snapshotPackage4RecoveryDatabase(client, binding);
  await client.query("begin isolation level repeatable read read only");
  let databaseMetadata;
  try {
    await assertPackage4RestoreIdentity(client, binding);
    databaseMetadata = await captureDatabaseMetadata(client);
    await client.query("rollback");
  } catch (error) { await client.query("rollback"); throw error; }
  return { snapshot, databaseMetadata, combinedSha256: hash(canonical({ snapshot, databaseMetadata })) };
}

/**
 * Ports retain the database-only COW interface. createBranch must await ready;
 * no branch reset, TTL repair, role/ACL repair or normalization is performed.
 * verifySourceDatabaseApplication may return the runner's just-observed native
 * runtime proof; otherwise the ordinary application callback runs on Source.
 */
export async function recoverPackage4ProviderBaselineUsingBranches({ source, sourceBinding, implementationRevision, initialSnapshotFile,
  artifactDirectory, api, connectBranch, changeWorkingSyntheticFixture, verifyRestoredDatabaseApplication,
  verifySourceDatabaseApplication = verifyRestoredDatabaseApplication, saveEvidence, runName }) {
  sourceGuard(sourceBinding);
  required(/^[a-f0-9]{40}$/u.test(implementationRevision || ""), "EXACT_PROVIDER_RECOVERY_REVISION_REQUIRED");
  required(/^package4-db-recovery-[a-z0-9-]{4,45}$/u.test(runName || ""), "UNIQUE_PROVIDER_RECOVERY_RUN_NAME_REQUIRED");
  required([api?.listBranches, api?.getBranch, api?.createBranch, api?.setExpiration, connectBranch, changeWorkingSyntheticFixture,
    verifyRestoredDatabaseApplication, verifySourceDatabaseApplication, saveEvidence].every(fn => typeof fn === "function"), "EXPLICIT_PROVIDER_RECOVERY_PORTS_REQUIRED");
  const { recorded, originalFailure } = await readPinnedInitialSnapshot(initialSnapshotFile);
  const directory = await preparePackage4RecoveryDirectory(artifactDirectory);
  const evidence = { format: "package4-provider-baseline-database-recovery-v1", profile: "existing-provider-nine-defaults-v1", scope: "DATABASE_ONLY", status: "RUNNING",
    implementationRevision, source: sourceBinding, originalStrictRootRecovery: originalFailure,
    initialSnapshot: { bytesSha256: package4ProviderRecordedSnapshotSha256, stateSha256: recorded.sha256, providerDefaultGrantRows: 9 },
    method: "Separate unchanged provider baseline, create-only checkpoint, committed working change, new recovered branch",
    startedAt: new Date().toISOString(), productionAccess: 0, sourceWrites: 0, sourceMetadataChangesWithinHelper: 0,
    grantChanges: 0, categoriesIgnored: 0, nativeDumpRestore: false, existingBranchesOverwritten: 0, createdBranches: [],
    limits: { maximumTotalBranches: 6, projectBranchCapacity: 10, createdBranches: 3, minCu: 0.25, maxCu: 0.25,
      providerSuspendTimeoutConfigurable: false, observedSuspendTimeoutSeconds: null },
    privateFiles: { status: "NOT TESTED", prerequisiteStatus: "BLOCKED", reason: "Private Vercel Blob access returned HTTP403; no private bytes archived or restored" },
    completeDatabaseAndPrivateFileRecovery: "BLOCKED",
    limitations: ["The original zero-default-grant root-source recovery stays FAIL. This is a distinct, explicitly authorized existing provider baseline, not parity with that root.",
      "All catalog/ledger/data categories, all nine provider grants and database metadata are compared exactly. No ACL alteration, excluded category or normalization repairs a mismatch.",
      "Same-project COW database-only proof. No native archive, cross-project recovery, private-file recovery or hosted login/MFA claim.",
      "Source and checkpoint must have no TTL to allow children. The new checkpoint has no compute or TTL and needs manual cleanup review.",
      "The caller separately removes the existing source branch expiration and temporarily re-enables its own compute before this helper. These provider metadata prerequisites are recorded separately; no source SQL state is changed.",
      "Leaf branches expire after24h. The provider controls suspension; the caller must deactivate created computes and verify actual endpoint state after the proof."] };
  const connections = [];
  const started = performance.now();
  await saveEvidence(evidence);
  try {
    await assertPackage4RestoreIdentity(source, sourceBinding);
    const inventory = await api.listBranches({ project_id: sourceBinding.projectId });
    const existingIds = [package4ProviderRecoverySource.originalRootBranchId, package4ProviderRecoverySource.parentBranchId, package4ProviderRecoverySource.branchId].sort();
    required(Array.isArray(inventory) && inventory.every(item => item.project_id === sourceBinding.projectId) &&
      equal(inventory.map(item => item.id).sort(), existingIds) && inventory.length + 3 === 6 && inventory.length + 3 < 10, "EXACT_OWNED_SIX_BRANCH_CAPACITY_REQUIRED");
    const sourceMetadata = await api.getBranch({ project_id: sourceBinding.projectId, branch_id: sourceBinding.branchId });
    const parentMetadata = await api.getBranch({ project_id: sourceBinding.projectId, branch_id: package4ProviderRecoverySource.parentBranchId });
    const rootMetadata = await api.getBranch({ project_id: sourceBinding.projectId, branch_id: package4ProviderRecoverySource.originalRootBranchId });
    metadataGuard(sourceMetadata, sourceBinding.branchId, package4ProviderRecoverySource.parentBranchId);
    metadataGuard(parentMetadata, package4ProviderRecoverySource.parentBranchId, package4ProviderRecoverySource.originalRootBranchId);
    metadataGuard(rootMetadata, package4ProviderRecoverySource.originalRootBranchId, null);
    required(sourceMetadata.expires_at == null, "PROVIDER_SOURCE_WITH_EXPIRY_CANNOT_HAVE_CHILDREN");
    evidence.provenance = { sourceBranchId: sourceMetadata.id, parentBranchId: parentMetadata.id, originalRootBranchId: rootMetadata.id,
      parentLsn: sourceMetadata.parent_lsn, parentParentLsn: parentMetadata.parent_lsn, sourceExpiry: null };
    const before = await capture(source, sourceBinding);
    // Compare every category and row digest, not just counts or selected grants.
    required(equal(before.snapshot, recorded), "SOURCE_DIFFERS_FROM_PINNED_ORIGINAL_PROVIDER_SNAPSHOT");
    await writeFile(path.join(directory, "provider-source-before.private.json"), JSON.stringify(before, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    evidence.sourceApplication = await verifySourceDatabaseApplication({ branch: sourceMetadata, binding: sourceBinding,
      implementationRevision, phase: "source-before-checkpoint" });
    applicationGuard(evidence.sourceApplication);
    required((await capture(source, sourceBinding)).combinedSha256 === before.combinedSha256, "SOURCE_CHANGED_DURING_PRECHECK_APPLICATION_PROOF");
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    const create = async (name, parentId, noCompute) => {
      const metadata = await api.createBranch({ project_id: sourceBinding.projectId, parent_id: parentId, name,
        ...(noCompute ? { no_compute: true } : { compute: { min_cu: 0.25, max_cu: 0.25 } }) });
      required(branchId(metadata?.id) && !existingIds.includes(metadata.id) && !evidence.createdBranches.some(item => item.id === metadata.id), "NEW_PROVIDER_RECOVERY_BRANCH_REQUIRED");
      metadataGuard(metadata, metadata.id, parentId);
      required(metadata.name === name && /^[A-F0-9]+\/[A-F0-9]+$/iu.test(metadata.parent_lsn || ""), "EXACT_PROVIDER_RECOVERY_PARENT_LSN_REQUIRED");
      if (!noCompute) await api.setExpiration({ project_id: sourceBinding.projectId, branch_id: metadata.id, expires_at: expiresAt });
      evidence.createdBranches.push({ id: metadata.id, name, parentId, parentLsn: metadata.parent_lsn, noCompute, expiresAt: noCompute ? null : expiresAt,
        ...(noCompute ? { cleanup: "Manual review required; no automatic deletion" } : {}) });
      await saveEvidence(evidence); return metadata;
    };
    const point = await create(runName + "-point", sourceBinding.branchId, true);
    required((await capture(source, sourceBinding)).combinedSha256 === before.combinedSha256, "PROVIDER_SOURCE_CHANGED_DURING_CHECKPOINT");
    const workingMetadata = await create(runName + "-working", point.id, false);
    const working = await connectBranch(workingMetadata); connections.push(working);
    connectionGuard(working, workingMetadata, sourceBinding);
    const workingBefore = await capture(working.client, working.binding);
    required(workingBefore.combinedSha256 === before.combinedSha256 && equal(workingBefore, before), "PROVIDER_WORKING_SCHEMA_DATA_ROLES_DBACL_SETTINGS_MISMATCH");
    await writeFile(path.join(directory, "provider-working-before.private.json"), JSON.stringify(workingBefore, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    const changed = await changeWorkingSyntheticFixture({ branch: workingMetadata, binding: working.binding, implementationRevision });
    required(changed?.syntheticOnly === true && changed.branchId === workingMetadata.id && Number.isSafeInteger(changed.committedRows) && changed.committedRows >= 1,
      "ACTUAL_COMMITTED_PROVIDER_WORKING_CHANGE_REQUIRED");
    const workingAfter = await capture(working.client, working.binding);
    required(workingAfter.combinedSha256 !== before.combinedSha256 && workingAfter.snapshot.sha256 !== before.snapshot.sha256 &&
      equal(workingAfter.databaseMetadata, before.databaseMetadata), "PROVIDER_WORKING_DATA_CHANGE_NOT_OBSERVED_OR_METADATA_DRIFT");
    evidence.workingChange = { branchId: workingMetadata.id, committedRows: changed.committedRows, combinedSha256: workingAfter.combinedSha256 };
    const restoredMetadata = await create(runName + "-restored", point.id, false);
    const restored = await connectBranch(restoredMetadata); connections.push(restored);
    connectionGuard(restored, restoredMetadata, sourceBinding);
    const after = await capture(restored.client, restored.binding);
    required(after.combinedSha256 === before.combinedSha256 && equal(after, before), "PROVIDER_RECOVERED_SCHEMA_DATA_ROLES_DBACL_SETTINGS_MISMATCH");
    await writeFile(path.join(directory, "provider-restored.private.json"), JSON.stringify(after, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    evidence.application = await verifyRestoredDatabaseApplication({ branch: restoredMetadata, binding: restored.binding, implementationRevision, phase: "restored" });
    applicationGuard(evidence.application);
    required((await capture(source, sourceBinding)).combinedSha256 === before.combinedSha256, "PROVIDER_SOURCE_CHANGED_DURING_RECOVERY");
    evidence.recoveryPoint = { branchId: point.id, parentBranchId: point.parent_id, parentLsn: point.parent_lsn, createdAt: point.created_at,
      combinedSha256: before.combinedSha256, catalogLedgerDataSha256: before.snapshot.sha256, databaseMetadataSha256: before.databaseMetadata.sha256 };
    evidence.restored = { branchId: restoredMetadata.id, combinedSha256: after.combinedSha256, ledgerRows: after.snapshot.ledger.length,
      dataTables: after.snapshot.data.length, dataRows: after.snapshot.data.reduce((sum, item) => sum + item.rows, 0),
      vector: after.snapshot.catalog.extensions.find(item => item.extname === "vector"), providerDefaultGrantRows: after.snapshot.catalog.defaultGrants.length };
    evidence.status = "PASS"; evidence.elapsedMs = Math.round(performance.now() - started); evidence.completedAt = new Date().toISOString();
    await saveEvidence(evidence); return evidence;
  } catch (error) {
    evidence.status = "FAIL"; evidence.elapsedMs = Math.round(performance.now() - started);
    evidence.failureCode = /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.message || "") ? error.message : "PROVIDER_BASELINE_RECOVERY_FAILED";
    await saveEvidence(evidence); throw new Error(evidence.failureCode);
  } finally { await Promise.allSettled(connections.map(connection => connection.close())); }
}
