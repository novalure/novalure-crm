import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonical } from "./studio-stage3-qa-fingerprint.mjs";

const productionHosts = new Set(["novalure-crm.vercel.app", "novalure-crm-novalure.vercel.app", "novalure-crm.app", "www.novalure-crm.app"]);
const receiptDirectory = "qa/package4-hosted-2026-10-20/";
const cloneProfile = Object.freeze({ projectId: "green-thunder-49879900", originalRootBranchId: "br-shiny-darkness-baz4524v",
  checkpointBranchId: "br-flat-block-baycv1oa", cloneBranchId: "br-sweet-surf-ba6iahut", parentLsn: "0/2F63518",
  initialSnapshotBytesSha256: "7760928f4cdbb479b4373818ff0c5ebe002b453df92a49dd513a387b53c250e7" });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sameMap = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const fail = code => { throw new Error(code); };
const requireMatch = (value, pattern, code) => typeof value === "string" && pattern.test(value) ? value : fail(code);

/** Public target descriptors contain identifiers, never credentials or URLs with access tokens. */
export function validateHostedTarget(value) {
  if (!value || value.schema !== "novalure.package4.hosted-target.v1" || value.syntheticOnly !== true || value.target !== "preview") fail("HOSTED_SYNTHETIC_PREVIEW_REQUIRED");
  let url;
  try { url = new URL(value.origin); } catch { fail("HOSTED_EXACT_ORIGIN_REQUIRED"); }
  if (url.protocol !== "https:" || url.origin !== value.origin || url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
    !url.hostname.endsWith(".vercel.app") || productionHosts.has(url.hostname.toLowerCase())) fail("HOSTED_EXACT_PREVIEW_ORIGIN_REQUIRED");
  requireMatch(value.sourceSha, /^[a-f0-9]{40}$/u, "HOSTED_SOURCE_SHA_REQUIRED");
  if (value.gitBranch !== "codex/evelyn-crm-package4-integration") fail("HOSTED_INTEGRATION_BRANCH_REQUIRED");
  requireMatch(value.deploymentId, /^dpl_[A-Za-z0-9]{20,80}$/u, "HOSTED_DEPLOYMENT_ID_REQUIRED");
  requireMatch(value.projectId, /^prj_[A-Za-z0-9]{10,80}$/u, "HOSTED_PROJECT_ID_REQUIRED");
  requireMatch(value.teamId, /^team_[A-Za-z0-9]{10,80}$/u, "HOSTED_TEAM_ID_REQUIRED");
  for (const key of ["projectId", "branchId", "database", "runtimeRole", "migrationRole"]) requireMatch(value.neon?.[key], /^[A-Za-z0-9_-]{1,128}$/u, "HOSTED_NEON_BINDING_REQUIRED");
  if (value.neon.runtimeRole === value.neon.migrationRole) fail("HOSTED_SEPARATE_DATABASE_ROLES_REQUIRED");
  if (value.neonMigrationReceipt?.path !== "qa/package4-hosted-2026-10-20/neon-migrations.json" ||
    !/^[a-f0-9]{64}$/u.test(value.neonMigrationReceipt.sha256 ?? "") ||
    !/^[a-f0-9]{40}$/u.test(value.neonMigrationReceipt.implementationRevision ?? "")) fail("HOSTED_OWNER_MIGRATION_RECEIPT_BINDING_REQUIRED");
  for (const [key, filename] of [["neonCloneAttestation", "neon-clone-attestation.json"], ["neonRuntimeCatalogReceipt", "neon-runtime-catalog-visibility.json"]]) {
    const binding = value[key];
    if (binding !== undefined && (binding?.path !== receiptDirectory + filename || !/^[a-f0-9]{64}$/u.test(binding.sha256 ?? "") ||
      (key === "neonCloneAttestation" && !/^[a-f0-9]{40}$/u.test(binding.implementationRevision ?? "")))) fail("HOSTED_ADDITIONAL_NEON_RECEIPT_BINDING_REQUIRED");
  }
  if (value.neonCloneAttestation && (value.neon.projectId !== cloneProfile.projectId || value.neon.branchId !== cloneProfile.cloneBranchId ||
    value.neon.database !== "neondb" || value.neon.runtimeRole !== "novalure_app" || value.neon.migrationRole !== "neondb_owner" || value.neonRuntimeCatalogReceipt)) fail("HOSTED_EXACT_CLONE_PROFILE_REQUIRED");
  if (value.storage?.provider !== "vercel-blob" || value.storage.access !== "private" || typeof value.storage.storeId !== "string" || !value.storage.storeId) fail("HOSTED_PRIVATE_STORAGE_BINDING_REQUIRED");
  if (value.storage.uploadApi?.origin !== "https://vercel.com" || value.storage.uploadApi.pathname !== "/api/blob/" ||
    Object.keys(value.storage.uploadApi).length !== 2 || !/^store_[A-Za-z0-9-]+$/u.test(value.storage.storeId)) fail("HOSTED_EXACT_PROVIDER_UPLOAD_API_REQUIRED");
  if (!Array.isArray(value.storage.allowedUploadOrigins) || !value.storage.allowedUploadOrigins.length) fail("HOSTED_PRIVATE_UPLOAD_ORIGINS_REQUIRED");
  for (const origin of value.storage.allowedUploadOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { fail("HOSTED_PRIVATE_UPLOAD_ORIGIN_DENIED"); }
    if (parsed.origin !== origin || parsed.protocol !== "https:" || parsed.username || parsed.password ||
      !(parsed.hostname === "blob.vercel-storage.com" || parsed.hostname.endsWith(".blob.vercel-storage.com"))) fail("HOSTED_PRIVATE_UPLOAD_ORIGIN_DENIED");
  }
  if (!uuid.test(value.studio?.workspaceId)) fail("HOSTED_STUDIO_BINDING_REQUIRED");
  const control = value.controlledWebsite;
  let website;
  try { website = new URL(control?.url); } catch { fail("HOSTED_CONTROLLED_HTTPS_SOURCE_REQUIRED"); }
  if (website.protocol !== "https:" || website.username || website.password || website.search || website.hash || website.origin === value.origin ||
    typeof control.beforeContent !== "string" || typeof control.afterContent !== "string" || typeof control.query !== "string" || !control.query.trim() ||
    control.beforeContent === control.afterContent || !control.beforeContent.includes(control.query) || !control.afterContent.includes(control.query)) fail("HOSTED_CONTROLLED_HTTPS_SOURCE_INVALID");
  if (Object.keys(value.migrationChecksums ?? {}).length !== 13) fail("HOSTED_EXACT_MIGRATION_SET_REQUIRED");
  for (const prefix of ["091_", "092_", "093_", "094_", "095_", "096_", "100_", "101_", "102_", "103_", "104_", "105_", "106_"]) {
    const entries = Object.entries(value.migrationChecksums ?? {}).filter(([name]) => name.startsWith(prefix));
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/u.test(entries[0][1])) fail("HOSTED_PINNED_MIGRATION_CHECKSUM_REQUIRED");
  }
  for (const name of ["operator", "customerA", "customerB", "viewer", "projectMember"]) {
    const account = value.accounts?.[name];
    if (!account || !uuid.test(account.userId) || !uuid.test(account.workspaceId) || !uuid.test(account.projectId) ||
      typeof account.email !== "string" || !account.email.endsWith("@example.invalid") ||
      !/^[A-Z][A-Z0-9_]{1,80}$/u.test(account.credentialKey ?? "")) fail("HOSTED_SYNTHETIC_ACCOUNT_BINDING_REQUIRED");
  }
  const expectedWorkspaces = [...new Set([...Object.values(value.accounts).map(account => account.workspaceId), value.studio.workspaceId])].sort();
  if (!Array.isArray(value.allWorkspaceIds) || value.allWorkspaceIds.some(value => !uuid.test(value)) ||
    JSON.stringify([...value.allWorkspaceIds].sort()) !== JSON.stringify(expectedWorkspaces)) fail("HOSTED_EXACT_SYNTHETIC_WORKSPACE_MANIFEST_REQUIRED");
  if (typeof value.accounts.operator.workspaceName !== "string" || !value.accounts.operator.workspaceName.trim()) fail("HOSTED_OPERATOR_WORKSPACE_LABEL_REQUIRED");
  if (!uuid.test(value.accounts.customerA.hiddenProjectId) || !uuid.test(value.accounts.customerA.hiddenUnitId) ||
    value.accounts.customerA.hiddenProjectId === value.accounts.customerA.projectId ||
    value.accounts.viewer.workspaceId !== value.accounts.customerA.workspaceId || value.accounts.projectMember.workspaceId !== value.accounts.customerA.workspaceId) fail("HOSTED_RESTRICTED_PROJECT_AND_ROLE_BINDINGS_REQUIRED");
  if (value.accounts.customerA.workspaceId === value.accounts.customerB.workspaceId || value.accounts.operator.workspaceId === value.accounts.customerA.workspaceId) fail("HOSTED_DISTINCT_SYNTHETIC_TENANTS_REQUIRED");
  for (const key of ["password", "totpSecret", "sessionToken", "connectionString", "databaseUrl", "protectionToken"]) {
    if (new RegExp(`"${key}"\\s*:`, "iu").test(JSON.stringify(value))) fail("HOSTED_PUBLIC_DESCRIPTOR_CONTAINS_SECRET_FIELD");
  }
  return structuredClone(value);
}

function assertRuntimeReceipt(final) {
  if (final?.actualRuntimeConnectionVerified !== true || final.runtimeOwnsNoPublicObjects !== true || final.privateProvisioningTablesDenied !== true || final.missingContextDeniesKnowledge !== true ||
    final.runtime?.rolcanlogin !== true || ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"].some(flag => final.runtime?.[flag] !== false)) fail("HOSTED_OWNER_RUNTIME_PROOF_REQUIRED");
}
function assertCatalog(catalog) {
  if (!catalog || catalog.expectedTablesSourceFile !== "src/lib/db/schema.ts" || !/^[a-f0-9]{64}$/u.test(catalog.expectedTablesSourceSha256 ?? "") || !Array.isArray(catalog.tables) || !catalog.tables.length ||
    new Set(catalog.tables.map(row => row.tableName)).size !== catalog.tables.length || !Number.isFinite(Date.parse(catalog.checkedAt))) fail("HOSTED_OWNER_CATALOG_RECEIPT_REQUIRED");
  for (const row of catalog.tables) {
    if (!/^[a-z][a-z0-9_]+$/u.test(row.tableName ?? "") || row.exists !== true || typeof row.runtimeVisible !== "boolean" || typeof row.runtimeAnyTablePrivilege !== "boolean" ||
      (!row.runtimeVisible && row.runtimeAnyTablePrivilege !== false)) fail("HOSTED_OWNER_CATALOG_PROOF_INVALID");
  }
  return catalog;
}
function assertTarget(actual, expected, databaseKey = "databaseName") {
  if (actual?.projectId !== expected.projectId || actual.branchId !== expected.branchId || actual[databaseKey] !== expected.database || actual.runtimeRole !== expected.runtimeRole) fail("HOSTED_OWNER_MIGRATION_TARGET_MISMATCH");
}
function assertOwnerIdentity(identity, expected, sessionKey) {
  if (identity?.role !== expected.migrationRole || identity.project !== expected.projectId || identity.branch !== expected.branchId || identity.database !== expected.database ||
    (sessionKey && identity[sessionKey] !== expected.migrationRole)) fail("HOSTED_OWNER_MIGRATION_TARGET_MISMATCH");
}
function ledgerMap(ledger) {
  if (!Array.isArray(ledger) || !ledger.length || new Set(ledger.map(row => row.version)).size !== ledger.length ||
    ledger.some(row => !/^\d{3}_[a-z0-9_]+$/u.test(row.version ?? "") || !/^[a-f0-9]{64}$/u.test(row.checksum ?? ""))) fail("HOSTED_OWNER_MIGRATION_LEDGER_INVALID");
  return Object.fromEntries(ledger.map(row => [row.version, row.checksum]));
}

function assertCloneSourceProof(clone, original, target) {
  const final = clone.final, proof = final.runtimeProof, identity = proof?.identity, source = clone.currentSourceProof;
  if (identity?.project !== target.neon.projectId || identity.branch !== target.neon.branchId || identity.database !== target.neon.database ||
    identity.role !== target.neon.runtimeRole || identity.sessionRole !== target.neon.runtimeRole || proof.ownsPublicObjects !== 0 || proof.publicCreate !== false ||
    proof.role?.rolname !== target.neon.runtimeRole || proof.role.rolinherit !== true || canonical(proof.role) !== canonical(final.runtime)) fail("HOSTED_CLONE_ACTUAL_RUNTIME_PROOF_MISMATCH");
  const privateTables = ["novalure_schema_migrations", "novalure_migration_execution_receipts", "crm_service_principals", "provider_connections", "company_profiles"];
  const knowledgeTables = ["knowledge_sources", "knowledge_areas", "knowledge_workflow_events", "knowledge_website_monitoring"];
  if (!Array.isArray(proof.privateProvisioningDenied) || !Array.isArray(proof.missingContextDeniedKnowledge) ||
    canonical([...proof.privateProvisioningDenied].sort()) !== canonical(privateTables.sort()) || canonical([...proof.missingContextDeniedKnowledge].sort()) !== canonical(knowledgeTables.sort())) fail("HOSTED_CLONE_NATIVE_DENIAL_PROOF_MISMATCH");
  const rls = final.forcedRlsTables, originalRls = original.final.forcedRls;
  if (!Array.isArray(rls) || !rls.length || !Array.isArray(originalRls) || !originalRls.length || rls.some(row => row.relrowsecurity !== true || row.relforcerowsecurity !== true) ||
    canonical([...rls].sort((a, b) => a.relname.localeCompare(b.relname))) !== canonical([...originalRls].sort((a, b) => a.relname.localeCompare(b.relname)))) fail("HOSTED_CLONE_FORCED_RLS_PROOF_MISMATCH");
  if (source?.branchId !== target.neon.branchId || source.checkedAt !== clone.checkedAt || final.runtimeCatalogVisibility?.checkedAt !== clone.checkedAt ||
    source.hashFormat !== "SHA256 of canonical JSON (scripts/lib/studio-stage3-qa-fingerprint.mjs canonical)" ||
    source.ledgerSha256 !== sha256(canonical(final.ledger)) || source.runtimeProofSha256 !== sha256(canonical(proof)) ||
    source.catalogSha256 !== sha256(canonical(final.runtimeCatalogVisibility))) fail("HOSTED_CLONE_SOURCE_PROOF_DIGEST_MISMATCH");
}

/** The original bootstrap is immutable and proves only its original branch.
 * An explicitly pinned clone needs a separate, freshly measured attestation. */
export function assertHostedOwnerMigrationReceipt(bundle, target) {
  const receipt = bundle?.receipt, clone = bundle?.cloneAttestation?.receipt;
  if (!receipt || bundle.sha256 !== target.neonMigrationReceipt.sha256 || receipt.format !== "package4-neon-bootstrap-v1" || receipt.status !== "PASS" || receipt.productionAccess !== 0 ||
    receipt.implementationRevision !== target.neonMigrationReceipt.implementationRevision || !/^[a-f0-9]{64}$/u.test(receipt.manifestDigest ?? "")) fail("HOSTED_OWNER_MIGRATION_RECEIPT_MISMATCH");
  const original = target.neonCloneAttestation ? { projectId: cloneProfile.projectId, branchId: cloneProfile.originalRootBranchId,
    database: "neondb", runtimeRole: "novalure_app", migrationRole: "neondb_owner" } : target.neon;
  assertTarget(receipt.target, original);
  assertOwnerIdentity(receipt.identity, original);
  assertRuntimeReceipt(receipt.final);
  const originalLedger = ledgerMap(receipt.final.ledger);
  for (const [version, checksum] of Object.entries(target.migrationChecksums)) {
    const applied = (receipt.applied ?? []).filter(row => row.file === `${version}.sql`);
    if (originalLedger[version] !== checksum || applied.length !== 1 || applied[0].sourceChecksum !== checksum || applied[0].execution !== "unchangedOriginalSql") fail("HOSTED_OWNER_MIGRATION_CHECKSUM_MISMATCH");
  }
  if (target.neonCloneAttestation) {
    if (target.neon.projectId !== cloneProfile.projectId || target.neon.branchId !== cloneProfile.cloneBranchId || target.neon.database !== "neondb" ||
      target.neon.runtimeRole !== "novalure_app" || target.neon.migrationRole !== "neondb_owner" || target.neonRuntimeCatalogReceipt || bundle.catalogReceipt ||
      !clone || bundle.cloneAttestation.sha256 !== target.neonCloneAttestation.sha256 || clone.format !== "package4-neon-clone-v1" || clone.status !== "PASS" || clone.productionAccess !== 0 ||
      clone.implementationRevision !== target.neonCloneAttestation.implementationRevision || !/^[a-f0-9]{40}$/u.test(clone.appSourceRevision ?? "") || !Number.isFinite(Date.parse(clone.checkedAt)) ||
      clone.manifestDigest !== receipt.manifestDigest || clone.migrationsExecutedOnClone !== false || clone.migrationsInheritedThroughCOW !== true) fail("HOSTED_CLONE_ATTESTATION_MISMATCH");
    const bootstrap = clone.bootstrapReceipt;
    if (bootstrap?.path !== target.neonMigrationReceipt.path || bootstrap.sha256 !== bundle.sha256 || bootstrap.implementationRevision !== receipt.implementationRevision ||
      bootstrap.manifestDigest !== receipt.manifestDigest || !sameMap(bootstrap.target, receipt.target)) fail("HOSTED_CLONE_BOOTSTRAP_BINDING_MISMATCH");
    assertTarget(clone.target, target.neon);
    if (clone.target.migrationRole !== target.neon.migrationRole) fail("HOSTED_OWNER_MIGRATION_TARGET_MISMATCH");
    assertOwnerIdentity(clone.identity, target.neon, "sessionRole");
    const provenance = clone.provenance;
    if (provenance?.originalRootBranchId !== cloneProfile.originalRootBranchId || provenance.checkpointBranchId !== cloneProfile.checkpointBranchId ||
      provenance.cloneBranchId !== cloneProfile.cloneBranchId || provenance.checkpointParentId !== cloneProfile.originalRootBranchId || provenance.cloneParentId !== cloneProfile.checkpointBranchId ||
      provenance.checkpointParentLsn !== cloneProfile.parentLsn || provenance.cloneParentLsn !== cloneProfile.parentLsn ||
      provenance.initialSnapshotBytesSha256 !== cloneProfile.initialSnapshotBytesSha256) fail("HOSTED_CLONE_PROVENANCE_MISMATCH");
    assertRuntimeReceipt(clone.final);
    assertCloneSourceProof(clone, receipt, target);
    if (!sameMap(clone.sourceMigrationChecksums, target.migrationChecksums) || !sameMap(ledgerMap(clone.final.ledger), originalLedger)) fail("HOSTED_CLONE_MIGRATION_CHECKSUM_MISMATCH");
    return { ledger: clone.final.ledger, catalog: assertCatalog(clone.final.runtimeCatalogVisibility), sourceRevision: clone.implementationRevision,
      sha256: bundle.cloneAttestation.sha256, source: target.neonCloneAttestation.path,
      cloneProvenance: { ...provenance, bootstrapReceiptSha256: bundle.sha256, bootstrapImplementationRevision: receipt.implementationRevision } };
  }
  if (clone || bundle?.cloneAttestation) fail("HOSTED_UNEXPECTED_CLONE_ATTESTATION");
  let catalog = receipt.final.runtimeCatalogVisibility;
  if (target.neonRuntimeCatalogReceipt) {
    const extra = bundle.catalogReceipt;
    if (!extra || extra.sha256 !== target.neonRuntimeCatalogReceipt.sha256 || extra.receipt?.format !== "package4-neon-runtime-catalog-visibility-v1" || extra.receipt.status !== "PASS") fail("HOSTED_OWNER_CATALOG_RECEIPT_MISMATCH");
    assertTarget(extra.receipt.target, target.neon, "database");
    if (extra.receipt.target.migrationRole !== target.neon.migrationRole) fail("HOSTED_OWNER_MIGRATION_TARGET_MISMATCH");
    catalog = extra.receipt.runtimeCatalogVisibility;
  } else if (bundle?.catalogReceipt) fail("HOSTED_UNEXPECTED_CATALOG_RECEIPT");
  return { ledger: receipt.final.ledger, catalog: assertCatalog(catalog), sourceRevision: receipt.implementationRevision,
    sha256: bundle.sha256, source: target.neonMigrationReceipt.path };
}

export async function loadHostedOwnerMigrationReceipt(target, root = process.cwd()) {
  const load = async binding => {
    const bytes = await readFile(path.resolve(root, binding.path));
    let receipt;
    try { receipt = JSON.parse(bytes.toString("utf8")); } catch { fail("HOSTED_OWNER_MIGRATION_RECEIPT_JSON_INVALID"); }
    return { receipt, sha256: sha256(bytes) };
  };
  const bundle = await load(target.neonMigrationReceipt);
  if (target.neonCloneAttestation) bundle.cloneAttestation = await load(target.neonCloneAttestation);
  if (target.neonRuntimeCatalogReceipt) bundle.catalogReceipt = await load(target.neonRuntimeCatalogReceipt);
  const proof = assertHostedOwnerMigrationReceipt(bundle, target);
  const schema = await readFile(path.resolve(root, "src/lib/db/schema.ts"), "utf8");
  if (sha256(schema.replace(/\r\n/gu, "\n")) !== proof.catalog.expectedTablesSourceSha256) fail("HOSTED_OWNER_CATALOG_SOURCE_MISMATCH");
  return bundle;
}

export function assertHostedRuntimeBinding(value, target, ownerBundle) {
  const proof = value?.runtimeProof, identity = proof?.identity, build = proof?.build;
  if (proof?.environment !== "preview" || build?.gitSha !== target.sourceSha || build.branch !== target.gitBranch || build.deploymentId !== target.deploymentId) fail("HOSTED_DEPLOYMENT_BUILD_MISMATCH");
  if (!identity || identity.leastPrivilege !== true || identity.neonProjectId !== target.neon.projectId || identity.neonBranchId !== target.neon.branchId ||
    identity.database !== target.neon.database || identity.currentUser !== target.neon.runtimeRole || identity.sessionUser !== target.neon.runtimeRole ||
    identity.superuser || identity.bypassRls || identity.databaseOwner || identity.sessionSuperuser || identity.sessionBypassRls || identity.sessionDatabaseOwner ||
    identity.ownedOrInheritedPublicTables !== 0 || identity.reachableElevatedRoles !== 0 || identity.requiredRlsTablesProtected !== true || identity.tenantRuntimeMember !== true) fail("HOSTED_NEON_RUNTIME_BINDING_MISMATCH");
  for (const flag of ["superuser", "bypassRls", "createDatabase", "createRole", "replication", "sessionSuperuser", "sessionBypassRls", "sessionCreateDatabase", "sessionCreateRole", "sessionReplication",
    "databaseOwner", "sessionDatabaseOwner", "databaseCreate", "sessionDatabaseCreate", "schemaCreate", "sessionSchemaCreate", "readAllData", "sessionReadAllData", "writeAllData", "sessionWriteAllData", "forbiddenCompanyProfilesSelect"]) {
    if (identity[flag] !== false) fail("HOSTED_NEON_RUNTIME_PRIVILEGE_MISMATCH");
  }
  const owner = assertHostedOwnerMigrationReceipt(ownerBundle, target);
  // The actual secure runtime cannot read administrative provisioning ledgers.
  // Permit that one known denial, while rejecting every other diagnostic error.
  if (value?.ok !== false || value.status?.configured !== true || value.migrationLedgerError !== "migration_ledger_unavailable" ||
    !Array.isArray(value.migrationLedger) || value.migrationLedger.length !== 0 || value.migrationStatus?.rows !== 0 || value.migrationStatus.checksumRows !== 0 || value.migrationStatus.currentVersion !== null ||
    value.tableCheckError !== null || proof.identityError !== null) fail("HOSTED_UNEXPECTED_DIAGNOSTIC_ERROR");
  const tables = owner.catalog.tables;
  if (!Array.isArray(value.expectedTables) || !Array.isArray(value.tableStatus) || !Array.isArray(value.missingTables) ||
    value.expectedTables.length !== tables.length || new Set(value.expectedTables).size !== tables.length || value.tableStatus.length !== tables.length) fail("HOSTED_DIAGNOSTIC_TABLE_MANIFEST_MISMATCH");
  for (const row of tables) {
    const actual = value.tableStatus.filter(item => item.tableName === row.tableName);
    if (!value.expectedTables.includes(row.tableName) || actual.length !== 1 || actual[0].exists !== row.runtimeVisible) fail("HOSTED_DIAGNOSTIC_TABLE_VISIBILITY_MISMATCH");
  }
  const invisible = tables.filter(row => !row.runtimeVisible).map(row => row.tableName).sort();
  if (JSON.stringify([...value.missingTables].sort()) !== JSON.stringify(invisible)) fail("HOSTED_UNPROVEN_MISSING_TABLE");
  return { environment: proof.environment, sourceSha: build.gitSha, deploymentId: build.deploymentId,
    neonProjectId: identity.neonProjectId, neonBranchId: identity.neonBranchId, database: identity.database, runtimeRole: identity.currentUser,
    leastPrivilege: true, verifiedMigrationChecksums: Object.keys(target.migrationChecksums).length,
    runtimeLedger: { status: "EXPECTED DENIAL", code: value.migrationLedgerError, privilegedRuntimeGrantAdded: false },
    administrativeLedger: { status: "PASS", source: owner.source, receiptSha256: owner.sha256, receiptImplementationRevision: owner.sourceRevision, candidateMigrationHashesMatch: true, ...(owner.cloneProvenance ? { cloneProvenance: owner.cloneProvenance } : {}) },
    runtimeInvisiblePrivateTables: invisible.map(tableName => ({ tableName, ownerVerifiedExists: true, runtimeAnyTablePrivilege: false })) };
}

/** Compare the descriptor with the actual immutable migration files before any remote writes. */
export async function verifyHostedMigrationFiles(target, root = process.cwd()) {
  for (const [version, checksum] of Object.entries(target.migrationChecksums)) {
    requireMatch(version, /^\d{3}_[a-z0-9_]+$/u, "HOSTED_MIGRATION_FILENAME_DENIED");
    const sql = await readFile(path.resolve(root, "migrations", `${version}.sql`), "utf8");
    if (createHash("sha256").update(sql.replace(/\r\n/gu, "\n")).digest("hex") !== checksum) fail("HOSTED_SOURCE_MIGRATION_CHECKSUM_MISMATCH");
  }
}

export function exactHostedUrl(pathname, target) {
  const url = new URL(pathname, target.origin);
  if (url.origin !== target.origin || url.username || url.password || url.hash) fail("HOSTED_CROSS_ORIGIN_REQUEST_DENIED");
  return url;
}
