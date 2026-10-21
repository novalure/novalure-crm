/**
 * Database-only post-commit recovery drill. This deliberately has no storage
 * ports: it cannot satisfy private-document recovery or the complete release
 * recovery gate. Importing performs no network or filesystem operations.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { package4RecoverySource } from "./package4-neon-branch-recovery.mjs";
import {
  assertPackage4RestoreIdentity, preparePackage4RecoveryDirectory,
  snapshotPackage4RecoveryDatabase,
} from "./package4-neon-restore.mjs";

const required = (condition, code) => assert.ok(condition, code);
const branchId = value => /^br-[a-z0-9-]{8,99}$/u.test(value || "");
const equalWorkspaces = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function sourceGuard(binding) {
  for (const field of ["projectId", "branchId", "host", "databaseName", "owner"]) required(binding?.[field] === package4RecoverySource[field], "EXACT_NEW_PACKAGE4_SOURCE_REQUIRED");
  required(binding.syntheticOnly === true && binding.newIsolatedResource === true, "SYNTHETIC_SOURCE_ATTESTATION_REQUIRED");
}
function createdBranch(metadata, name, parentId) {
  required(metadata?.project_id === package4RecoverySource.projectId && branchId(metadata.id) &&
    metadata.id !== package4RecoverySource.branchId && metadata.parent_id === parentId && metadata.name === name &&
    /^[A-F0-9]+\/[A-F0-9]+$/iu.test(metadata.parent_lsn || "") && metadata.current_state === "ready", "CREATED_DATABASE_RECOVERY_BRANCH_MISMATCH");
  return metadata;
}
function createdTarget(binding, metadata, sourceBinding) {
  required(binding?.projectId === package4RecoverySource.projectId && binding.branchId === metadata.id &&
    binding.databaseName === package4RecoverySource.databaseName && binding.owner === package4RecoverySource.owner &&
    equalWorkspaces(binding.workspaceIds, sourceBinding.workspaceIds), "EXACT_CREATED_DATABASE_RECOVERY_BINDING_REQUIRED");
}

/**
 * API methods use the existing Neon tool argument shapes and normalized branch
 * metadata. The createBranch adapter must await getBranch current_state=ready
 * before returning; a provider response in init is not ready. Free-plan compute
 * inherits its provider suspend interval. The caller records actual endpoint
 * metadata and explicitly deactivates created computes after the proof.
 * connectBranch returns {client,binding,close}; its client must keep a
 * real transaction for the complete fingerprint (approved HTTP batch/session or
 * WebSocket transport). changeWorkingSyntheticFixture must commit through an
 * ordinary scoped runtime, e.g. update one synthetic task title. It must not
 * disable an invariant. verifyRestoredDatabaseApplication likewise uses the
 * ordinary runtime and returns actual role/access checks, never a placeholder.
 */
export async function recoverPackage4DatabaseOnlyUsingBranches({ source, sourceBinding, implementationRevision,
  artifactDirectory, api, connectBranch, changeWorkingSyntheticFixture, verifyRestoredDatabaseApplication,
  saveEvidence, runName }) {
  sourceGuard(sourceBinding);
  required(/^[a-f0-9]{40}$/u.test(implementationRevision || ""), "EXACT_IMPLEMENTATION_REVISION_REQUIRED");
  required(/^package4-db-recovery-[a-z0-9-]{4,45}$/u.test(runName || ""), "UNIQUE_DATABASE_RECOVERY_RUN_NAME_REQUIRED");
  required([api?.listBranches, api?.getBranch, api?.createBranch, api?.setExpiration, connectBranch,
    changeWorkingSyntheticFixture, verifyRestoredDatabaseApplication, saveEvidence].every(fn => typeof fn === "function"), "EXPLICIT_DATABASE_RECOVERY_PORTS_REQUIRED");
  const directory = await preparePackage4RecoveryDirectory(artifactDirectory);
  const evidence = { format: "package4-neon-database-only-recovery-v1", scope: "DATABASE_ONLY", status: "RUNNING",
    implementationRevision, method: "Create-only COW checkpoint, committed change on working branch, recovered branch from checkpoint",
    source: sourceBinding, startedAt: new Date().toISOString(), productionAccess: 0, sourceWrites: 0,
    nativeDumpRestore: false, existingBranchesOverwritten: 0, createdBranches: [],
    privateFiles: { status: "NOT TESTED", prerequisiteStatus: "BLOCKED", reason: "Private Vercel Blob access returned HTTP 403",
      bytesArchived: 0, bytesRestored: 0, databaseFileReferencesAreNotFileByteProof: true },
    completeDatabaseAndPrivateFileRecovery: "BLOCKED",
    limits: { projectBranchCapacity: 10, createdBranches: 3, minCu: 0.25, maxCu: 0.25,
      providerSuspendTimeoutConfigurable: false, observedSuspendTimeoutSeconds: null },
    limitations: ["Database-only COW recovery of the new synthetic QA project; no private-file, independent dump or cross-project recovery claim.",
      "Private-file references and version bindings are included in the database digest, but document existence, bytes and storage access are NOT TESTED.",
      "Original source and application deployment remain unchanged; recovered branch requires separate endpoint/application binding.",
      "Elapsed time is measured for this synthetic drill; it is not an agreed or guaranteed production recovery time.",
      "The no-compute checkpoint cannot expire while it has children. It has no TTL and requires manual cleanup review; this helper never deletes branches.",
      "The provider controls the free-plan suspend interval. No automatic suspension or shutdown is claimed; the caller must deactivate created computes after the proof."] };
  const connections = [];
  const started = performance.now();
  await saveEvidence(evidence);
  try {
    await assertPackage4RestoreIdentity(source, sourceBinding);
    const inventory = await api.listBranches({ project_id: package4RecoverySource.projectId });
    required(Array.isArray(inventory) && inventory.length + 3 <= 10 && inventory.every(item => item.project_id === package4RecoverySource.projectId), "FREE_BRANCH_CAPACITY_NOT_ATTESTED");
    required(!inventory.some(item => [runName + "-point", runName + "-working", runName + "-restored"].includes(item.name)), "NEW_DATABASE_RECOVERY_BRANCH_NAMES_REQUIRED");
    const sourceMetadata = await api.getBranch({ project_id: package4RecoverySource.projectId, branch_id: package4RecoverySource.branchId });
    required(sourceMetadata?.id === package4RecoverySource.branchId && sourceMetadata.project_id === package4RecoverySource.projectId &&
      !sourceMetadata.parent_id && sourceMetadata.current_state === "ready", "EXACT_NEW_SOURCE_ROOT_METADATA_REQUIRED");
    const before = await snapshotPackage4RecoveryDatabase(source, sourceBinding);
    await writeFile(path.join(directory, "database-before.private.json"), JSON.stringify(before, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    const create = async (name, parentId, noCompute = false) => {
      const metadata = createdBranch(await api.createBranch({ project_id: package4RecoverySource.projectId, parent_id: parentId, name,
        ...(noCompute ? { no_compute: true } : { compute: { min_cu: 0.25, max_cu: 0.25 } }) }), name, parentId);
      // Neon rejects children of expiring branches. Only leaf compute branches
      // get TTLs; the frozen parent remains without TTL for manual review.
      if (!noCompute) await api.setExpiration({ project_id: package4RecoverySource.projectId, branch_id: metadata.id, expires_at: expiresAt });
      evidence.createdBranches.push({ id: metadata.id, name, parentId, parentLsn: metadata.parent_lsn,
        expiresAt: noCompute ? null : expiresAt, compute: !noCompute, noCompute, automaticExpiration: !noCompute,
        ...(noCompute ? { cleanup: "Manual review required; no automatic deletion" } : {}) });
      await saveEvidence(evidence); return metadata;
    };
    const checkpoint = await create(runName + "-point", package4RecoverySource.branchId, true);
    required((await snapshotPackage4RecoveryDatabase(source, sourceBinding)).sha256 === before.sha256, "SOURCE_CHANGED_DURING_DATABASE_CHECKPOINT");
    const working = await create(runName + "-working", checkpoint.id);
    const work = await connectBranch(working); connections.push(work);
    createdTarget(work.binding, working, sourceBinding);
    required((await snapshotPackage4RecoveryDatabase(work.client, work.binding)).sha256 === before.sha256, "DATABASE_CHECKPOINT_COW_COPY_MISMATCH");
    const changed = await changeWorkingSyntheticFixture({ branch: working, binding: work.binding, implementationRevision });
    required(changed?.syntheticOnly === true && changed.branchId === working.id && Number.isSafeInteger(changed.committedRows) && changed.committedRows >= 1,
      "COMMITTED_RUN_OWNED_SYNTHETIC_DATABASE_CHANGE_REQUIRED");
    const workingAfter = await snapshotPackage4RecoveryDatabase(work.client, work.binding);
    required(workingAfter.sha256 !== before.sha256, "WORKING_SYNTHETIC_DATABASE_CHANGE_NOT_OBSERVED");
    evidence.workingChange = { branchId: working.id, committedRows: changed.committedRows, databaseSha256: workingAfter.sha256 };
    const restored = await create(runName + "-restored", checkpoint.id);
    const recovered = await connectBranch(restored); connections.push(recovered);
    createdTarget(recovered.binding, restored, sourceBinding);
    const after = await snapshotPackage4RecoveryDatabase(recovered.client, recovered.binding);
    required(after.sha256 === before.sha256, "RECOVERED_DATABASE_SCHEMA_LEDGER_ROWS_ROLES_ACL_MISMATCH");
    await writeFile(path.join(directory, "database-restored.private.json"), JSON.stringify(after, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    evidence.recoveryPoint = { branchId: checkpoint.id, parentBranchId: checkpoint.parent_id, parentLsn: checkpoint.parent_lsn,
      createdAt: checkpoint.created_at, schemaLedgerRowsRolesAclSha256: before.sha256 };
    evidence.restored = { branchId: restored.id, databaseName: recovered.binding.databaseName,
      schemaLedgerRowsRolesAclSha256: after.sha256, genuineVector: after.catalog.extensions.find(row => row.extname === "vector"),
      ledgerRows: after.ledger.length, dataTables: after.data.length, dataRows: after.data.reduce((sum, item) => sum + item.rows, 0) };
    evidence.application = await verifyRestoredDatabaseApplication({ branch: restored, binding: recovered.binding, implementationRevision });
    required(evidence.application?.status === "PASS" && evidence.application.databaseRole === "novalure_app" &&
      evidence.application.superuser === false && evidence.application.bypassRls === false && evidence.application.ownsPublicObjects === 0 &&
      Array.isArray(evidence.application.checks) && evidence.application.checks.length > 0 && evidence.application.checks.every(check => check.status === "PASS"), "RESTORED_ORDINARY_DATABASE_APPLICATION_NOT_VERIFIED");
    required((await snapshotPackage4RecoveryDatabase(source, sourceBinding)).sha256 === before.sha256, "SOURCE_CHANGED_DURING_DATABASE_RECOVERY_DRILL");
    evidence.status = "PASS"; evidence.completedAt = new Date().toISOString(); evidence.elapsedMs = Math.round(performance.now() - started);
    await saveEvidence(evidence); return evidence;
  } catch (error) {
    evidence.status = "FAIL"; evidence.elapsedMs = Math.round(performance.now() - started);
    evidence.failureCode = /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.message || "") ? error.message : "PACKAGE4_DATABASE_RECOVERY_FAILED";
    await saveEvidence(evidence); throw new Error(evidence.failureCode);
  } finally { await Promise.allSettled(connections.map(connection => connection.close())); }
}
