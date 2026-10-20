/**
 * Create-only, HTTP/API-compatible Neon recovery drill for the newly authorized
 * Package 4 project. No branch reset, replacement, finalization or deletion.
 * Importing this module opens no database and makes no API/storage requests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  archivePackage4PrivateDocuments, preparePackage4RecoveryDirectory,
  snapshotPackage4RecoveryDatabase, assertPackage4RestoreIdentity,
} from "./package4-neon-restore.mjs";

export const package4RecoverySource = Object.freeze({ projectId: "green-thunder-49879900",
  branchId: "br-shiny-darkness-baz4524v", host: "ep-steep-shadow-bapfxomh.c-8.eu-central-1.aws.neon.tech",
  databaseName: "neondb", owner: "neondb_owner", projectCreatedAt: "2026-10-20T05:32:05Z" });
const requireValue = (condition, code) => assert.ok(condition, code);
const hash = value => createHash("sha256").update(value).digest("hex");
const branchId = value => /^br-[a-z0-9-]{8,99}$/u.test(value || "");

function sourceGuard(binding) {
  for (const field of ["projectId", "branchId", "host", "databaseName", "owner"]) requireValue(binding?.[field] === package4RecoverySource[field], "EXACT_NEW_PACKAGE4_SOURCE_REQUIRED");
  requireValue(binding.syntheticOnly === true && binding.newIsolatedResource === true, "SYNTHETIC_SOURCE_ATTESTATION_REQUIRED");
}
function createdBranch(metadata, { name, parentId }) {
  requireValue(metadata?.project_id === package4RecoverySource.projectId && branchId(metadata.id) &&
    metadata.id !== package4RecoverySource.branchId && metadata.parent_id === parentId && metadata.name === name &&
    /^[A-F0-9]+\/[A-F0-9]+$/iu.test(metadata.parent_lsn || "") && metadata.current_state === "ready", "CREATED_BRANCH_PROVENANCE_MISMATCH");
  return metadata;
}
function targetGuard(binding, metadata, sourceBinding) {
  requireValue(binding?.projectId === package4RecoverySource.projectId && binding.branchId === metadata.id &&
    binding.databaseName === package4RecoverySource.databaseName && binding.owner === package4RecoverySource.owner &&
    JSON.stringify([...binding.workspaceIds].sort()) === JSON.stringify([...sourceBinding.workspaceIds].sort()), "EXACT_CREATED_RECOVERY_BINDING_REQUIRED");
}

/**
 * api ports map to existing Neon tools/REST. createBranch gets the exact tool
 * argument shape; setExpiration maps to update_branch. connectBranch obtains
 * credentials through a secret channel and returns {client,binding,close}.
 * The createBranch adapter must await getBranch current_state=ready before
 * returning; a provider response in init is not ready. Free-plan compute keeps
 * its provider suspend interval. The caller records actual endpoint metadata
 * and explicitly deactivates created computes after the proof.
 * PostgreSQL clients may use an approved HTTP transaction transport.
 */
export async function recoverPackage4UsingBranches({ source, sourceBinding, implementationRevision, artifactDirectory,
  api, connectBranch, changeWorkingSyntheticFixture, storageBinding, readSourceDocument, assertEmptyTargetStorage,
  writeTargetDocument, readTargetDocument, verifyRestoredApplication, saveEvidence, runName }) {
  sourceGuard(sourceBinding);
  requireValue(/^[a-f0-9]{40}$/u.test(implementationRevision || ""), "EXACT_IMPLEMENTATION_REVISION_REQUIRED");
  requireValue(/^package4-recovery-[a-z0-9-]{4,50}$/u.test(runName || ""), "UNIQUE_BOUNDED_RECOVERY_RUN_NAME_REQUIRED");
  requireValue([api?.listBranches, api?.getBranch, api?.createBranch, api?.setExpiration, connectBranch,
    changeWorkingSyntheticFixture, readSourceDocument, assertEmptyTargetStorage, writeTargetDocument,
    readTargetDocument, verifyRestoredApplication, saveEvidence].every(fn => typeof fn === "function"), "EXPLICIT_BRANCH_RECOVERY_PORTS_REQUIRED");
  requireValue(storageBinding?.syntheticOnly === true && storageBinding.access === "private" &&
    /^[a-z0-9_-]{5,100}$/iu.test(storageBinding.sourceStoreId || "") && /^[a-z0-9_-]{5,100}$/iu.test(storageBinding.targetStoreId || "") &&
    storageBinding.sourceStoreId !== storageBinding.targetStoreId, "TWO_EXACT_PRIVATE_QA_STORAGE_BINDINGS_REQUIRED");
  const directory = await preparePackage4RecoveryDirectory(artifactDirectory);
  const evidence = { format: "package4-neon-branch-recovery-v1", status: "RUNNING", implementationRevision,
    method: "Create-only COW checkpoint, changed working branch, new recovered branch; private-object byte archive/restore",
    startedAt: new Date().toISOString(), source: sourceBinding, storage: storageBinding, productionAccess: 0,
    sourceWrites: 0, nativeDumpRestore: false, existingBranchesOverwritten: 0, createdBranches: [],
    limits: { projectBranchCapacity: 10, createdBranches: 3, minCu: 0.25, maxCu: 0.25,
      providerSuspendTimeoutConfigurable: false, observedSuspendTimeoutSeconds: null },
    limitations: ["Same-project Neon COW recovery; no independent/off-provider dump or cross-project disaster-recovery claim.",
      "Only the new synthetic QA project is copied, including its test-only roles. Production data and credentials are absent by provisioning provenance.",
      "Creating a recovered branch changes endpoint credentials/bindings; the original source branch and deployment are not switched.",
      "The ordinary application callback verifies the exact compatible implementation against restored data and a separate private store.",
      "The no-compute checkpoint has no TTL because Neon forbids children of expiring branches. It requires manual cleanup review; this helper never deletes branches.",
      "The provider controls the free-plan suspend interval. No automatic suspension or shutdown is claimed; the caller must deactivate created computes after the proof."] };
  const started = performance.now();
  const connections = [];
  await saveEvidence(evidence);
  try {
    await assertPackage4RestoreIdentity(source, sourceBinding);
    const inventory = await api.listBranches({ project_id: package4RecoverySource.projectId });
    requireValue(Array.isArray(inventory) && inventory.length + 3 <= 10 && inventory.every(item => item.project_id === package4RecoverySource.projectId), "FREE_BRANCH_CAPACITY_NOT_ATTESTED");
    requireValue(!inventory.some(item => [runName + "-point", runName + "-working", runName + "-restored"].includes(item.name)), "NEW_RECOVERY_BRANCH_NAMES_REQUIRED");
    const sourceMetadata = await api.getBranch({ project_id: package4RecoverySource.projectId, branch_id: package4RecoverySource.branchId });
    requireValue(sourceMetadata?.id === package4RecoverySource.branchId && sourceMetadata.project_id === package4RecoverySource.projectId &&
      !sourceMetadata.parent_id && sourceMetadata.current_state === "ready", "EXACT_NEW_SOURCE_ROOT_METADATA_REQUIRED");
    const emptyStore = await assertEmptyTargetStorage();
    requireValue(emptyStore?.storeId === storageBinding.targetStoreId && emptyStore.access === "private" && emptyStore.objects === 0, "EXACT_EMPTY_PRIVATE_RESTORE_STORE_REQUIRED");
    const before = await snapshotPackage4RecoveryDatabase(source, sourceBinding);
    const documents = await archivePackage4PrivateDocuments({ client: source, binding: sourceBinding, directory, readSource: readSourceDocument });
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    const create = async (name, parentId, noCompute = false) => {
      const metadata = createdBranch(await api.createBranch({ project_id: package4RecoverySource.projectId, parent_id: parentId,
        name, ...(noCompute ? { no_compute: true } : { compute: { min_cu: 0.25, max_cu: 0.25 } }) }), { name, parentId });
      // Only leaf compute branches expire. Their frozen parent cannot have TTL
      // while children exist, and remains for explicit manual cleanup review.
      if (!noCompute) await api.setExpiration({ project_id: package4RecoverySource.projectId, branch_id: metadata.id, expires_at: expiresAt });
      evidence.createdBranches.push({ id: metadata.id, name, parentId, parentLsn: metadata.parent_lsn,
        expiresAt: noCompute ? null : expiresAt, compute: !noCompute, noCompute, automaticExpiration: !noCompute,
        ...(noCompute ? { cleanup: "Manual review required; no automatic deletion" } : {}) });
      await saveEvidence(evidence); return metadata;
    };
    const checkpoint = await create(runName + "-point", package4RecoverySource.branchId, true);
    requireValue((await snapshotPackage4RecoveryDatabase(source, sourceBinding)).sha256 === before.sha256, "SOURCE_CHANGED_DURING_CHECKPOINT");
    const working = await create(runName + "-working", checkpoint.id);
    const work = await connectBranch(working); connections.push(work);
    targetGuard(work.binding, working, sourceBinding);
    requireValue((await snapshotPackage4RecoveryDatabase(work.client, work.binding)).sha256 === before.sha256, "CHECKPOINT_COW_COPY_MISMATCH");
    const changed = await changeWorkingSyntheticFixture({ branch: working, binding: work.binding, implementationRevision });
    requireValue(changed?.syntheticOnly === true && changed.branchId === working.id && changed.committedRows >= 1,
      "COMMITTED_RUN_OWNED_SYNTHETIC_CHANGE_REQUIRED");
    const changedState = await snapshotPackage4RecoveryDatabase(work.client, work.binding);
    requireValue(changedState.sha256 !== before.sha256, "WORKING_CHANGE_NOT_OBSERVED");
    evidence.workingChange = { branchId: working.id, committedRows: changed.committedRows, observedDatabaseSha256: changedState.sha256 };
    const restored = await create(runName + "-restored", checkpoint.id);
    const recovery = await connectBranch(restored); connections.push(recovery);
    targetGuard(recovery.binding, restored, sourceBinding);
    const after = await snapshotPackage4RecoveryDatabase(recovery.client, recovery.binding);
    requireValue(after.sha256 === before.sha256, "RECOVERED_SCHEMA_LEDGER_DATA_ROLES_ACL_MISMATCH");
    for (const file of documents.files) {
      const bytes = await readFile(path.join(directory, file.archiveName));
      requireValue(bytes.length === file.bytes && hash(bytes) === file.sha256, "PRIVATE_DOCUMENT_ARCHIVE_CHANGED");
      const receipt = await writeTargetDocument(file, bytes);
      requireValue(receipt?.access === "private" && receipt.pathname === file.pathname && receipt.storeId === storageBinding.targetStoreId, "PRIVATE_DOCUMENT_RESTORE_KEY_MISMATCH");
      const actual = Buffer.from(await readTargetDocument(file));
      requireValue(actual.length === file.bytes && hash(actual) === file.sha256, "PRIVATE_DOCUMENT_BYTE_RESTORE_MISMATCH");
    }
    evidence.recoveryPoint = { branchId: checkpoint.id, parentBranchId: checkpoint.parent_id, parentLsn: checkpoint.parent_lsn,
      createdAt: checkpoint.created_at, schemaLedgerRolesDataSha256: before.sha256, documents: documents.files.length,
      privateDocumentManifestSha256: hash(JSON.stringify(documents)), versionBindingsSha256: documents.versionBindingsSha256 };
    evidence.restored = { branchId: restored.id, databaseName: recovery.binding.databaseName, matchingSchemaLedgerRolesDataSha256: after.sha256,
      genuineVector: after.catalog.extensions.find(item => item.extname === "vector"), ledgerRows: after.ledger.length,
      allTableCount: after.data.length, allRowCount: after.data.reduce((sum, item) => sum + item.rows, 0) };
    evidence.application = await verifyRestoredApplication({ branch: restored, binding: recovery.binding, implementationRevision, documents });
    requireValue(evidence.application?.status === "PASS", "RESTORED_ORDINARY_APPLICATION_NOT_VERIFIED");
    requireValue((await snapshotPackage4RecoveryDatabase(source, sourceBinding)).sha256 === before.sha256, "SOURCE_CHANGED_DURING_RECOVERY_DRILL");
    evidence.status = "PASS"; evidence.elapsedMs = Math.round(performance.now() - started); evidence.completedAt = new Date().toISOString();
    await saveEvidence(evidence); return evidence;
  } catch (error) {
    evidence.status = "FAIL"; evidence.elapsedMs = Math.round(performance.now() - started);
    evidence.failureCode = /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.message || "") ? error.message : "PACKAGE4_BRANCH_RECOVERY_FAILED";
    await saveEvidence(evidence); throw new Error(evidence.failureCode);
  } finally { await Promise.allSettled(connections.map(connection => connection.close())); }
}
