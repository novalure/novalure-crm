/**
 * DRAFT: post-hosted, full database + private-file recovery on the separately
 * authorized provider baseline. This does not run, relax or replace the older
 * 7760928f-pinned experiment. Importing performs no IO. All remote actions use
 * explicit caller ports after a fresh, SHA-approved and quiescent baseline.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonical, captureDatabaseMetadata } from "./lib/studio-stage3-qa-fingerprint.mjs";
import { validateHostedTarget } from "./lib/package4-hosted-target.mjs";
import { package4ProviderRecoverySource } from "./package4-neon-provider-baseline-recovery.mjs";
import { archivePackage4PrivateDocuments, assertPackage4RestoreIdentity, preparePackage4RecoveryDirectory,
  snapshotPackage4RecoveryDatabase } from "./package4-neon-restore.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const required = (condition, code) => assert.ok(condition, code);
const same = (a, b) => canonical(a) === canonical(b);
const sorted = values => [...values].sort();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const sha = value => /^[a-f0-9]{64}$/u.test(value || "");
const appSha = value => /^[a-f0-9]{40}$/u.test(value || "");
const root = package4ProviderRecoverySource;
const historicalProviderRun = "package4-db-recovery-20261020-provider-r2";
const historicalProviderBranches = { point: "br-icy-boat-baaov5es", working: "br-mute-salad-babco1q7", restored: "br-dark-block-bakix0lx" };
const requiredApplicationChecks = ["private_current_and_historical_documents", "foreign_tenant_document_denial",
  "same_published_version_binding", "revoked_document_denial", "restored_knowledge_and_106_readers"];

export function validatePackage4HostedRecoveryInputs({ sourceBinding, hostedManifest, storageBinding, quiescenceProof }) {
  // Enforce the established immutable synthetic Preview descriptor, including
  // required project/team identifiers, integration branch, immutable Vercel
  // Preview origin and public-secret exclusions. Caller binds live deployment.
  validateHostedTarget(hostedManifest);
  for (const key of ["projectId", "branchId", "host", "databaseName", "owner"]) required(sourceBinding?.[key] === root[key], "EXACT_HOSTED_PROVIDER_SOURCE_REQUIRED");
  required(sourceBinding.syntheticOnly === true && sourceBinding.newIsolatedResource === true && Array.isArray(sourceBinding.workspaceIds) &&
    sourceBinding.workspaceIds.length === 4 && sourceBinding.workspaceIds.every(value => uuid.test(value)) && new Set(sourceBinding.workspaceIds).size === 4, "EXACT_FOUR_SYNTHETIC_HOSTED_WORKSPACES_REQUIRED");
  required(hostedManifest?.schema === "novalure.package4.hosted-target.v1" && hostedManifest.syntheticOnly === true && hostedManifest.target === "preview" &&
    appSha(hostedManifest.sourceSha) && /^dpl_[a-zA-Z0-9]+$/u.test(hostedManifest.deploymentId || ""), "ACTUAL_HOSTED_PREVIEW_DEPLOYMENT_MANIFEST_REQUIRED");
  const origin = new URL(hostedManifest.origin);
  required(origin.protocol === "https:" && origin.origin === hostedManifest.origin && !origin.username && !origin.password &&
    hostedManifest.neon?.projectId === root.projectId && hostedManifest.neon.branchId === root.branchId && hostedManifest.neon.database === "neondb" &&
    hostedManifest.neon.runtimeRole === "novalure_app" && hostedManifest.neon.migrationRole === "neondb_owner", "HOSTED_DEPLOYMENT_DATABASE_BINDING_MISMATCH");
  required(Array.isArray(hostedManifest.allWorkspaceIds) && same(sorted(hostedManifest.allWorkspaceIds), sorted(sourceBinding.workspaceIds)),
    "PUBLIC_HOSTED_MANIFEST_ALL_WORKSPACE_IDS_REQUIRED");
  required(storageBinding?.syntheticOnly === true && storageBinding.provider === "vercel-blob" && storageBinding.access === "private" &&
    /^[a-z0-9_-]{5,100}$/iu.test(storageBinding.sourceStoreId || "") && /^[a-z0-9_-]{5,100}$/iu.test(storageBinding.targetStoreId || "") &&
    storageBinding.sourceStoreId !== storageBinding.targetStoreId && hostedManifest.storage?.provider === "vercel-blob" &&
    hostedManifest.storage.access === "private" && hostedManifest.storage.storeId === storageBinding.sourceStoreId &&
    Array.isArray(hostedManifest.storage.allowedUploadOrigins) && hostedManifest.storage.allowedUploadOrigins.length > 0, "TWO_EXACT_PRIVATE_HOSTED_QA_STORES_REQUIRED");
  // These are upload destination origins, independently bound from the Preview
  // application origin above. Match the existing hosted target's Blob-only rule.
  for (const uploadOrigin of hostedManifest.storage.allowedUploadOrigins) {
    let parsed;
    try { parsed = new URL(uploadOrigin); } catch { throw new Error("HOSTED_PRIVATE_UPLOAD_ORIGIN_DENIED"); }
    required(parsed.origin === uploadOrigin && parsed.protocol === "https:" && !parsed.username && !parsed.password &&
      (parsed.hostname === "blob.vercel-storage.com" || parsed.hostname.endsWith(".blob.vercel-storage.com")), "HOSTED_PRIVATE_UPLOAD_ORIGIN_DENIED");
  }
  const age = Date.now() - Date.parse(quiescenceProof?.verifiedAt);
  required(quiescenceProof?.sourceBranchId === root.branchId && quiescenceProof.deploymentId === hostedManifest.deploymentId &&
    quiescenceProof.syntheticTestWritersPaused === true && quiescenceProof.inFlightWritesDrained === true &&
    quiescenceProof.noScheduledOrProviderWriters === true && Number.isFinite(age) && age >= 0 && age <= 300000,
    "FRESH_EXPLICIT_HOSTED_WRITE_QUIESCENCE_REQUIRED");
  return { hostedManifestSha256: hash(canonical(hostedManifest)), storageBindingSha256: hash(canonical(storageBinding)),
    sourceBindingSha256: hash(canonical(sourceBinding)), deploymentId: hostedManifest.deploymentId,
    applicationRevision: hostedManifest.sourceSha, quiescenceProofSha256: hash(canonical(quiescenceProof)) };
}

function applicationGuard(proof) {
  required(proof?.status === "PASS" && proof.databaseRole === "novalure_app" && proof.superuser === false && proof.bypassRls === false &&
    proof.ownsPublicObjects === 0 && Array.isArray(proof.checks) && proof.checks.length > 0 && proof.checks.every(check => check.status === "PASS"), "ACTUAL_HOSTED_RECOVERY_APPLICATION_PROOF_REQUIRED");
}
function metadataGuard(metadata, expectedId, parentId) {
  required(metadata?.id === expectedId && metadata.project_id === root.projectId && (metadata.parent_id ?? null) === parentId &&
    metadata.current_state === "ready", "HOSTED_RECOVERY_BRANCH_PROVENANCE_MISMATCH");
}
async function inventoryGuard(api) {
  const inventory = await api.listBranches({ project_id: root.projectId });
  required(Array.isArray(inventory) && inventory.length === 6 && inventory.length + 3 === 9 && inventory.every(branch => branch.project_id === root.projectId), "EXACT_SIX_TO_NINE_HOSTED_BRANCH_BOUND_REQUIRED");
  const existing = new Map(inventory.map(branch => [branch.id, branch]));
  const expectedIds = [root.originalRootBranchId, root.parentBranchId, root.branchId, ...Object.values(historicalProviderBranches)];
  required(existing.size === 6 && same(sorted([...existing.keys()]), sorted(expectedIds)), "EXACT_PREVIOUS_OWNED_BRANCHES_REQUIRED");
  for (const [phase, id] of Object.entries(historicalProviderBranches)) {
    const branch = existing.get(id);
    required(branch.name === historicalProviderRun + "-" + phase &&
      branch.parent_id === (phase === "point" ? root.branchId : historicalProviderBranches.point), "PREVIOUS_PROVIDER_DRILL_EXACT_ID_AND_LINEAGE_REQUIRED");
  }
  const source = await api.getBranch({ project_id: root.projectId, branch_id: root.branchId });
  const parent = await api.getBranch({ project_id: root.projectId, branch_id: root.parentBranchId });
  const original = await api.getBranch({ project_id: root.projectId, branch_id: root.originalRootBranchId });
  metadataGuard(source, root.branchId, root.parentBranchId);
  metadataGuard(parent, root.parentBranchId, root.originalRootBranchId);
  metadataGuard(original, root.originalRootBranchId, null);
  required(source.expires_at == null, "HOSTED_SOURCE_WITH_EXPIRY_CANNOT_HAVE_CHILDREN");
  return { inventory: inventory.map(({ id, project_id, parent_id, name }) => ({ id, project_id, parent_id: parent_id ?? null, name })).sort((a, b) => a.id.localeCompare(b.id)), source };
}
async function state(client, binding) {
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
async function versionBindings(client, binding) {
  await assertPackage4RestoreIdentity(client, binding);
  const rows = (await client.query(`select v.id,v.source_id,v.workspace_id,v.media_asset_id,v.status,
    s.draft_version_id,s.approved_version_id from public.knowledge_source_versions v
    join public.knowledge_sources s on s.id=v.source_id and s.workspace_id=v.workspace_id
    where v.media_asset_id is not null order by v.id`)).rows;
  required(rows.length > 0 && rows.every(row => binding.workspaceIds.includes(row.workspace_id)), "OWNED_NONEMPTY_DOCUMENT_VERSION_BINDINGS_REQUIRED");
  return hash(canonical(rows));
}
export const package4HostedPrivateAssetInventorySql = `select m.id,m.workspace_id,m.relative_path,m.storage_provider,m.storage_access,
  m.is_public,m.public_token,m.size_bytes::text,exists(select 1 from public.knowledge_source_versions v
    where v.media_asset_id=m.id and v.workspace_id::text=m.workspace_id) as has_version
  from public.media_assets m where m.storage_access='private' order by m.id`;

async function privateAssetInventory(client, binding) {
  await client.query("begin isolation level repeatable read read only");
  try {
    await assertPackage4RestoreIdentity(client, binding);
    const rows = (await client.query(package4HostedPrivateAssetInventorySql)).rows;
    required(rows.length > 0 && rows.length <= 100 && rows.every(row => binding.workspaceIds.includes(row.workspace_id) &&
      row.storage_provider === "vercel-blob" && row.storage_access === "private" && row.is_public === false &&
      row.public_token === null && row.has_version === true), "ALL_PRIVATE_MEDIA_MUST_BE_OWNED_AND_COVERED_BY_KNOWLEDGE_ARCHIVE");
    await client.query("rollback");
    return { scope: "ALL_PRIVATE_MEDIA_ASSETS", count: rows.length, assetIds: rows.map(row => row.id), sha256: hash(canonical(rows)) };
  } catch (error) { await client.query("rollback"); throw error; }
}
function privateReadGuard(receipt, file, storeId) {
  required(receipt?.storeId === storeId && receipt.pathname === file.pathname && receipt.access === "private" &&
    [401, 403, 404].includes(receipt.unauthenticatedStatus) && receipt.body != null, "ACTUAL_PRIVATE_OBJECT_READ_AND_PUBLIC_DENIAL_REQUIRED");
  const bytes = Buffer.from(receipt.body);
  required(bytes.length === file.bytes && hash(bytes) === file.sha256, "PRIVATE_OBJECT_BYTES_OR_SHA_MISMATCH");
  return bytes;
}
async function checkedPrivateFile(filename) {
  const base = await realpath(path.resolve(".npm-cache/qa"));
  const actual = await realpath(filename), info = await lstat(actual);
  required(actual.startsWith(base + path.sep) && info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0,
    "OWNER_ONLY_IGNORED_HOSTED_BASELINE_REQUIRED");
  execFileSync("git", ["check-ignore", "--quiet", actual], { stdio: "ignore" });
  return actual;
}

/**
 * Preflight only: capture the legitimate post-hosted state after normal login,
 * MFA, uploads and quota changes. It creates no Neon branch and no target blob.
 * The caller must inspect/bind the returned new byte SHA before calling restore.
 * readSourceDocument returns {body,storeId,pathname,access,unauthenticatedStatus}.
 */
export async function capturePackage4HostedRecoveryBaseline({ source, sourceBinding, hostedManifest, storageBinding, quiescenceProof,
  implementationRevision, artifactDirectory, api, readSourceDocument, verifySourceDatabaseApplication }) {
  const bindings = validatePackage4HostedRecoveryInputs({ sourceBinding, hostedManifest, storageBinding, quiescenceProof });
  required(appSha(implementationRevision) && [api?.listBranches, api?.getBranch, readSourceDocument, verifySourceDatabaseApplication].every(fn => typeof fn === "function"), "EXPLICIT_HOSTED_BASELINE_PORTS_REQUIRED");
  const directory = await preparePackage4RecoveryDirectory(artifactDirectory);
  const { inventory, source: sourceMetadata } = await inventoryGuard(api);
  const initial = await state(source, sourceBinding);
  const sourceApplication = await verifySourceDatabaseApplication({ branch: sourceMetadata, binding: sourceBinding,
    implementationRevision, applicationRevision: hostedManifest.sourceSha, phase: "fresh-hosted-baseline" });
  applicationGuard(sourceApplication);
  required((await state(source, sourceBinding)).combinedSha256 === initial.combinedSha256, "HOSTED_SOURCE_CHANGED_DURING_BASELINE_APPLICATION_PROOF");
  const privateAssets = await privateAssetInventory(source, sourceBinding);
  const receipts = [];
  const documents = await archivePackage4PrivateDocuments({ client: source, binding: sourceBinding, directory, readSource: async asset => {
    const receipt = await readSourceDocument(asset);
    const bytes = Buffer.from(receipt?.body ?? []);
    const file = { pathname: asset.relative_path, bytes: Number(asset.size_bytes), sha256: hash(bytes) };
    privateReadGuard(receipt, file, storageBinding.sourceStoreId);
    receipts.push({ assetId: asset.id, storeId: receipt.storeId, pathname: receipt.pathname, access: receipt.access,
      unauthenticatedStatus: receipt.unauthenticatedStatus, bytes: bytes.length, sha256: hash(bytes) });
    return bytes;
  } });
  required(same(sorted(documents.files.map(file => file.assetId)), sorted(privateAssets.assetIds)), "PRIVATE_MEDIA_ARCHIVE_NOT_EXHAUSTIVE");
  required(documents.versionBindingsSha256 === await versionBindings(source, sourceBinding), "HOSTED_VERSION_BINDINGS_CHANGED_DURING_ARCHIVE");
  required((await state(source, sourceBinding)).combinedSha256 === initial.combinedSha256, "HOSTED_SOURCE_CHANGED_DURING_PRIVATE_ARCHIVE");
  const baseline = { format: "package4-post-hosted-recovery-baseline-v1", toolingRevision: implementationRevision,
    capturedAt: new Date().toISOString(), sourceBinding, hostedManifest, storageBinding, quiescenceProof, bindings,
    inventory, state: initial, sourceApplication, documents, privateAssets, sourcePrivateReadProofs: receipts,
    historicalProfilesUnchanged: { originalZeroDefaultsRecovery: "FAIL preserved", historical7760928fProfile: "separate unchanged experiment" } };
  const filename = path.join(directory, "post-hosted-baseline.private.json");
  const bytes = Buffer.from(JSON.stringify(baseline, null, 2) + "\n");
  await writeFile(filename, bytes, { mode: 0o600, flag: "wx" });
  return { status: "BASELINE_CAPTURED_NOT_RECOVERY_PASS", baselineFile: filename, baselineBytesSha256: hash(bytes),
    combinedDatabaseSha256: initial.combinedSha256, privateDocuments: documents.files.length, deploymentId: hostedManifest.deploymentId,
    applicationRevision: hostedManifest.sourceSha, toolingRevision: implementationRevision, remoteBranchesCreated: 0, targetObjectsCreated: 0 };
}

/**
 * Run only after an explicit caller review of this newly captured baseline SHA.
 * All six existing branch identities must still match; only three new branches
 * may be created. createBranch must await ready; compute suspend is inherited.
 * The caller MUST deactivate the source/working/restored computes in its finally
 * and save disabled+idle receipts, including FAIL paths. Hosted Source availability
 * remains a separately coordinated root action, never an implicit promotion.
 */
export async function recoverPackage4PostHostedUsingBranches({ source, sourceBinding, hostedManifest, storageBinding, quiescenceProof,
  implementationRevision, baselineFile, approvedBaselineSha256, artifactDirectory, api, connectBranch,
  readSourceDocument, assertEmptyTargetStorage, writeTargetDocument, readTargetDocument,
  changeWorkingSyntheticFixture, verifyRestoredApplication, verifySourceDatabaseApplication, saveEvidence, runName }) {
  const bindings = validatePackage4HostedRecoveryInputs({ sourceBinding, hostedManifest, storageBinding, quiescenceProof });
  required(appSha(implementationRevision) && sha(approvedBaselineSha256), "EXPLICIT_NEW_HOSTED_BASELINE_SHA_APPROVAL_REQUIRED");
  required(/^package4-hosted-recovery-[a-z0-9-]{4,40}$/u.test(runName || ""), "BOUNDED_HOSTED_RECOVERY_RUN_NAME_REQUIRED");
  required([api?.listBranches, api?.getBranch, api?.createBranch, api?.setExpiration, connectBranch, readSourceDocument,
    assertEmptyTargetStorage, writeTargetDocument, readTargetDocument, changeWorkingSyntheticFixture,
    verifyRestoredApplication, verifySourceDatabaseApplication, saveEvidence].every(fn => typeof fn === "function"), "EXPLICIT_FULL_HOSTED_RECOVERY_PORTS_REQUIRED");
  baselineFile = await checkedPrivateFile(baselineFile);
  const originalBytes = await readFile(baselineFile);
  required(hash(originalBytes) === approvedBaselineSha256, "APPROVED_HOSTED_BASELINE_BYTES_CHANGED");
  const baseline = JSON.parse(originalBytes);
  required(baseline.format === "package4-post-hosted-recovery-baseline-v1" && same(baseline.sourceBinding, sourceBinding) &&
    same(baseline.hostedManifest, hostedManifest) && same(baseline.storageBinding, storageBinding) &&
    baseline.bindings.hostedManifestSha256 === bindings.hostedManifestSha256 && baseline.bindings.storageBindingSha256 === bindings.storageBindingSha256 &&
    baseline.bindings.sourceBindingSha256 === bindings.sourceBindingSha256, "FRESH_HOSTED_BASELINE_BINDING_MISMATCH");
  const age = Date.now() - Date.parse(baseline.capturedAt);
  required(Number.isFinite(age) && age >= 0 && age <= 3600000, "HOSTED_BASELINE_EXPIRED_RECAPTURE_REQUIRED");
  const directory = await preparePackage4RecoveryDirectory(artifactDirectory);
  const evidence = { format: "package4-post-hosted-full-recovery-v1", status: "RUNNING", scope: "DATABASE_AND_PRIVATE_FILES",
    toolingRevision: implementationRevision, applicationRevision: hostedManifest.sourceSha, deploymentId: hostedManifest.deploymentId,
    source: sourceBinding, storage: storageBinding, baselineBytesSha256: approvedBaselineSha256,
    startedAt: new Date().toISOString(), productionAccess: 0, sourceWrites: 0, grantChanges: 0, categoriesIgnored: 0,
    createdBranches: [], nativeDumpRestore: false, existingBranchesOverwritten: 0,
    limits: { existingBranches: 6, newBranches: 3, totalBranches: 9, projectBranchCapacity: 10, minCu: 0.25, maxCu: 0.25,
      providerSuspendTimeoutConfigurable: false, observedSuspendTimeoutSeconds: null },
    endpointCleanup: { status: "NOT TESTED", owner: "caller finally", requiredState: "source/working/restored disabled+idle receipts; source availability root-coordinated" },
    limitations: ["New post-hosted baseline only. Historical root FAIL and 7760928f-pinned provider experiment remain unchanged and separate.",
      "Same-project Neon COW plus byte archive to a separately bound private store; no independent PostgreSQL dump or cross-project disaster recovery claim.",
      "Hosted source is paused by the caller. This helper never promotes deployments, switches domains, resets branches or changes source roles/ACLs.",
      "The final ordinary application callback must bind its actual verification to the recovered branch, restored private store and compatible application revision.",
      "New checkpoint has no TTL/compute; caller reviews cleanup. Caller must deactivate computes in finally; no automatic-suspend guarantee."] };
  const connections = [], started = performance.now();
  await saveEvidence(evidence);
  try {
    const existing = await inventoryGuard(api);
    required(same(existing.inventory, baseline.inventory), "POST_HOSTED_SIX_BRANCH_INVENTORY_CHANGED");
    const before = await state(source, sourceBinding);
    required(same(before, baseline.state), "POST_HOSTED_SOURCE_CHANGED_RECAPTURE_REQUIRED");
    required(same(await privateAssetInventory(source, sourceBinding), baseline.privateAssets) &&
      same(sorted(baseline.documents.files.map(file => file.assetId)), sorted(baseline.privateAssets.assetIds)), "APPROVED_PRIVATE_MEDIA_ARCHIVE_COVERAGE_MISMATCH");
    const sourceProof = await verifySourceDatabaseApplication({ branch: existing.source, binding: sourceBinding,
      implementationRevision, applicationRevision: hostedManifest.sourceSha, phase: "before-hosted-recovery" });
    applicationGuard(sourceProof); evidence.sourceApplication = sourceProof;
    const empty = await assertEmptyTargetStorage();
    required(empty?.storeId === storageBinding.targetStoreId && empty.access === "private" && empty.objects === 0, "EXACT_EMPTY_PRIVATE_RECOVERY_STORE_REQUIRED");
    for (const file of baseline.documents.files) {
      required(uuid.test(file.assetId) && file.archiveName === file.assetId + ".document.private" &&
        sourceBinding.workspaceIds.includes(file.workspaceId) && sha(file.sha256), "EXACT_OWNED_PRIVATE_ARCHIVE_ENTRY_REQUIRED");
      const archived = await readFile(path.join(path.dirname(baselineFile), file.archiveName));
      required(archived.length === file.bytes && hash(archived) === file.sha256, "APPROVED_PRIVATE_ARCHIVE_BYTES_CHANGED");
      // Reconstruct the existing archive port's actual DB asset shape. The SDK
      // uses relative_path plus its separately bound store token, never ma.url.
      const sourceAsset = { id: file.assetId, workspace_id: file.workspaceId, relative_path: file.pathname,
        mime_type: file.mimeType, size_bytes: String(file.bytes), storage_provider: "vercel-blob",
        storage_access: "private", is_public: false, public_token: null };
      privateReadGuard(await readSourceDocument(sourceAsset), file, storageBinding.sourceStoreId);
    }
    required(await versionBindings(source, sourceBinding) === baseline.documents.versionBindingsSha256 &&
      (await state(source, sourceBinding)).combinedSha256 === before.combinedSha256, "SOURCE_OR_DOCUMENT_BINDINGS_CHANGED_BEFORE_CREATES");
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    const create = async (name, parentId, noCompute) => {
      const metadata = await api.createBranch({ project_id: root.projectId, parent_id: parentId, name,
        ...(noCompute ? { no_compute: true } : { compute: { min_cu: 0.25, max_cu: 0.25 } }) });
      required(/^br-[a-z0-9-]{8,99}$/u.test(metadata?.id || "") && !baseline.inventory.some(branch => branch.id === metadata.id) &&
        !evidence.createdBranches.some(branch => branch.id === metadata.id) && metadata.name === name && /^[A-F0-9]+\/[A-F0-9]+$/iu.test(metadata.parent_lsn || ""), "NEW_POST_HOSTED_RECOVERY_BRANCH_REQUIRED");
      metadataGuard(metadata, metadata.id, parentId);
      // Preserve every actual new resource for caller cleanup even if the next
      // provider TTL request fails. Never leave a created compute unrecorded.
      const created = { id: metadata.id, name, parentId, parentLsn: metadata.parent_lsn, noCompute,
        expiresAt: null, requestedExpiresAt: noCompute ? null : expiresAt, expirationApplied: false };
      evidence.createdBranches.push(created); await saveEvidence(evidence);
      if (!noCompute) {
        await api.setExpiration({ project_id: root.projectId, branch_id: metadata.id, expires_at: expiresAt });
        created.expiresAt = expiresAt; created.expirationApplied = true; await saveEvidence(evidence);
      }
      return metadata;
    };
    const connect = async metadata => {
      const connection = await connectBranch(metadata); connections.push(connection);
      const binding = connection.binding;
      required(binding?.projectId === root.projectId && binding.branchId === metadata.id && binding.databaseName === "neondb" &&
        binding.owner === "neondb_owner" && same(sorted(binding.workspaceIds || []), sorted(sourceBinding.workspaceIds)), "EXACT_POST_HOSTED_RECOVERY_CONNECTION_REQUIRED");
      return connection;
    };
    const point = await create(runName + "-point", root.branchId, true);
    required((await state(source, sourceBinding)).combinedSha256 === before.combinedSha256, "HOSTED_SOURCE_CHANGED_DURING_CHECKPOINT");
    const workingMetadata = await create(runName + "-working", point.id, false), working = await connect(workingMetadata);
    required(same(await state(working.client, working.binding), before), "HOSTED_WORKING_COMPLETE_STATE_MISMATCH");
    const changed = await changeWorkingSyntheticFixture({ branch: workingMetadata, binding: working.binding,
      implementationRevision, applicationRevision: hostedManifest.sourceSha });
    required(changed?.syntheticOnly === true && changed.branchId === workingMetadata.id && Number.isSafeInteger(changed.committedRows) && changed.committedRows > 0,
      "ACTUAL_COMMITTED_POST_HOSTED_WORKING_CHANGE_REQUIRED");
    const afterChange = await state(working.client, working.binding);
    required(afterChange.snapshot.sha256 !== before.snapshot.sha256 && same(afterChange.databaseMetadata, before.databaseMetadata), "POST_HOSTED_WORKING_CHANGE_MISSING_OR_METADATA_DRIFT");
    evidence.workingChange = { branchId: workingMetadata.id, committedRows: changed.committedRows, combinedSha256: afterChange.combinedSha256 };
    const restoredMetadata = await create(runName + "-restored", point.id, false), restored = await connect(restoredMetadata);
    const after = await state(restored.client, restored.binding);
    required(same(after, before), "POST_HOSTED_RECOVERED_COMPLETE_DATABASE_STATE_MISMATCH");
    required(await versionBindings(restored.client, restored.binding) === baseline.documents.versionBindingsSha256, "RECOVERED_PRIVATE_VERSION_BINDINGS_MISMATCH");
    const restoredFiles = [];
    for (const file of baseline.documents.files) {
      const bytes = await readFile(path.join(path.dirname(baselineFile), file.archiveName));
      required(bytes.length === file.bytes && hash(bytes) === file.sha256, "PRIVATE_ARCHIVE_CHANGED_DURING_RECOVERY");
      const receipt = await writeTargetDocument(file, bytes);
      required(receipt?.storeId === storageBinding.targetStoreId && receipt.access === "private" && receipt.pathname === file.pathname, "PRIVATE_RESTORE_CHANGED_STORAGE_OR_IMMUTABLE_KEY");
      const read = await readTargetDocument(file);
      privateReadGuard(read, file, storageBinding.targetStoreId);
      restoredFiles.push({ assetId: file.assetId, bytes: file.bytes, sha256: file.sha256, pathname: file.pathname, access: "private", unauthenticatedStatus: read.unauthenticatedStatus });
    }
    evidence.privateFiles = { status: "PASS", sourceStoreId: storageBinding.sourceStoreId, restoredStoreId: storageBinding.targetStoreId,
      files: restoredFiles, exhaustivePrivateMediaInventory: baseline.privateAssets,
      versionBindingsSha256: baseline.documents.versionBindingsSha256, archivedBytes: restoredFiles.reduce((sum, file) => sum + file.bytes, 0) };
    evidence.application = await verifyRestoredApplication({ branch: restoredMetadata, binding: restored.binding,
      implementationRevision, applicationRevision: hostedManifest.sourceSha, deploymentId: hostedManifest.deploymentId,
      storageBinding, documents: baseline.documents, requiredChecks: requiredApplicationChecks });
    applicationGuard(evidence.application);
    required(evidence.application.privateStoreId === storageBinding.targetStoreId && evidence.application.restoredBranchId === restoredMetadata.id &&
      evidence.application.applicationRevision === hostedManifest.sourceSha && evidence.application.authenticatedSessionVerified === true &&
      requiredApplicationChecks.every(name => evidence.application.checks.some(check => check.name === name && check.status === "PASS")), "RESTORED_APPLICATION_STORAGE_REVISION_BINDING_REQUIRED");
    required((await state(source, sourceBinding)).combinedSha256 === before.combinedSha256, "HOSTED_SOURCE_CHANGED_DURING_FULL_RECOVERY");
    evidence.recoveryPoint = { branchId: point.id, parentBranchId: point.parent_id, parentLsn: point.parent_lsn, createdAt: point.created_at,
      combinedDatabaseSha256: before.combinedSha256, privateManifestSha256: hash(canonical(baseline.documents)) };
    evidence.restored = { branchId: restoredMetadata.id, combinedDatabaseSha256: after.combinedSha256, storeId: storageBinding.targetStoreId,
      ledgerRows: after.snapshot.ledger.length, dataTables: after.snapshot.data.length };
    evidence.proofStatus = "PASS";
    evidence.status = "AWAITING_CALLER_ENDPOINT_DEACTIVATION";
    evidence.elapsedMs = Math.round(performance.now() - started); evidence.completedAt = new Date().toISOString();
    await writeFile(path.join(directory, "restored-database.private.json"), JSON.stringify(after, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await saveEvidence(evidence); return evidence;
  } catch (error) {
    evidence.status = "FAIL"; evidence.elapsedMs = Math.round(performance.now() - started);
    evidence.failureCode = /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.message || "") ? error.message : "POST_HOSTED_FULL_RECOVERY_FAILED";
    await saveEvidence(evidence); throw new Error(evidence.failureCode);
  } finally { await Promise.allSettled(connections.map(connection => connection.close())); }
}
