import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonical } from "./lib/studio-stage3-qa-fingerprint.mjs";
import { assertHostedOwnerMigrationReceipt, assertHostedRuntimeBinding, exactHostedUrl, loadHostedOwnerMigrationReceipt, validateHostedTarget } from "./lib/package4-hosted-target.mjs";

function target() {
  const account = label => ({ userId: randomUUID(), workspaceId: randomUUID(), projectId: randomUUID(), email: `${label}@example.invalid`, credentialKey: `PACKAGE4_${label.toUpperCase()}_CREDENTIALS` });
  const customerA = { ...account("customer_a"), hiddenProjectId: randomUUID(), hiddenUnitId: randomUUID() };
  return { schema: "novalure.package4.hosted-target.v1", syntheticOnly: true, target: "preview",
    origin: "https://novalure-crm-synthetic123-novalure.vercel.app", sourceSha: "a".repeat(40), gitBranch: "codex/evelyn-crm-package4-integration",
    deploymentId: "dpl_" + "a".repeat(24), projectId: "prj_" + "b".repeat(24), teamId: "team_" + "c".repeat(24),
    neon: { projectId: "synthetic-project", branchId: "br-synthetic", database: "neondb", runtimeRole: "synthetic_runtime", migrationRole: "synthetic_owner" },
    neonMigrationReceipt: { path: "qa/package4-hosted-2026-10-20/neon-migrations.json", sha256: "f".repeat(64), implementationRevision: "b".repeat(40) },
    storage: { provider: "vercel-blob", access: "private", storeId: "synthetic-private-store", allowedUploadOrigins: ["https://blob.vercel-storage.com"] },
    studio: { workspaceId: randomUUID() }, controlledWebsite: { url: "https://synthetic-public.com/after.txt", beforeContent: "SYNTHETIC anchor 09:00", afterContent: "SYNTHETIC anchor 10:00", query: "anchor" },
    migrationChecksums: Object.fromEntries(["091_", "092_", "093_", "094_", "095_", "096_", "100_", "101_", "102_", "103_", "104_", "105_", "106_"].map(prefix => [prefix + "synthetic", "d".repeat(64)])),
    accounts: { operator: { ...account("operator"), workspaceName: "SYNTHETIC INTERNAL" }, customerA, customerB: account("customer_b"),
      viewer: { ...account("viewer"), workspaceId: customerA.workspaceId }, projectMember: { ...account("project_member"), workspaceId: customerA.workspaceId } } };
}
function diagnostics(config) {
  const identity = { leastPrivilege: true, neonProjectId: config.neon.projectId, neonBranchId: config.neon.branchId, database: config.neon.database,
    currentUser: config.neon.runtimeRole, sessionUser: config.neon.runtimeRole, ownedOrInheritedPublicTables: 0, reachableElevatedRoles: 0,
    requiredRlsTablesProtected: true, tenantRuntimeMember: true };
  for (const key of ["superuser", "bypassRls", "createDatabase", "createRole", "replication", "sessionSuperuser", "sessionBypassRls", "sessionCreateDatabase", "sessionCreateRole", "sessionReplication",
    "databaseOwner", "sessionDatabaseOwner", "databaseCreate", "sessionDatabaseCreate", "schemaCreate", "sessionSchemaCreate", "readAllData", "sessionReadAllData", "writeAllData", "sessionWriteAllData", "forbiddenCompanyProfilesSelect"]) identity[key] = false;
  return { ok: false, status: { configured: true }, runtimeProof: { environment: "preview", status: "FAIL", identityError: null, build: { gitSha: config.sourceSha, branch: config.gitBranch, deploymentId: config.deploymentId }, identity },
    migrationLedger: [], migrationLedgerError: "migration_ledger_unavailable", migrationStatus: { rows: 0, checksumRows: 0, currentVersion: null }, tableCheckError: null,
    expectedTables: ["contacts", "company_profiles"], missingTables: ["company_profiles"], tableStatus: [{ tableName: "contacts", exists: true }, { tableName: "company_profiles", exists: false }] };
}
function ownerBundle(config) {
  const receipt = { format: "package4-neon-bootstrap-v1", status: "PASS", productionAccess: 0, implementationRevision: config.neonMigrationReceipt.implementationRevision, manifestDigest: "e".repeat(64),
    target: { projectId: config.neon.projectId, branchId: config.neon.branchId, databaseName: config.neon.database, runtimeRole: config.neon.runtimeRole },
    identity: { role: config.neon.migrationRole, project: config.neon.projectId, branch: config.neon.branchId, database: config.neon.database },
    applied: Object.entries(config.migrationChecksums).map(([version, sourceChecksum]) => ({ file: version + ".sql", sourceChecksum, execution: "unchangedOriginalSql" })),
    final: { actualRuntimeConnectionVerified: true, runtimeOwnsNoPublicObjects: true, privateProvisioningTablesDenied: true, missingContextDeniesKnowledge: true,
      runtime: { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
      forcedRls: [{ relname: "knowledge_sources", relrowsecurity: true, relforcerowsecurity: true }],
      ledger: Object.entries(config.migrationChecksums).map(([version, checksum]) => ({ version, checksum })),
      runtimeCatalogVisibility: { expectedTablesSourceFile: "src/lib/db/schema.ts", expectedTablesSourceSha256: "f".repeat(64), checkedAt: new Date().toISOString(), tables: [
        { tableName: "contacts", exists: true, runtimeVisible: true, runtimeAnyTablePrivilege: true },
        { tableName: "company_profiles", exists: true, runtimeVisible: false, runtimeAnyTablePrivilege: false },
      ] } } };
  const sha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  config.neonMigrationReceipt.sha256 = sha256;
  return { receipt, sha256 };
}

test("hosted descriptor requires an exact synthetic Preview origin and isolated native bindings", () => {
  const valid = target();
  assert.deepEqual(validateHostedTarget(valid), valid);
  for (const origin of ["http://127.0.0.1:3000", "https://novalure-crm.vercel.app", "https://novalure-crm.app", valid.origin + "/", valid.origin + "?token=secret", "https://user:secret@" + new URL(valid.origin).hostname]) {
    assert.throws(() => validateHostedTarget({ ...valid, origin }), /HOSTED_/);
  }
  for (const mutation of [
    { target: "production" }, { syntheticOnly: false }, { sourceSha: "unknown" }, { gitBranch: "main" }, { deploymentId: "latest" },
    { neon: { ...valid.neon, runtimeRole: valid.neon.migrationRole } }, { storage: { ...valid.storage, access: "public" } },
    { accounts: { ...valid.accounts, customerB: { ...valid.accounts.customerB, workspaceId: valid.accounts.customerA.workspaceId } } },
    { accounts: { ...valid.accounts, customerA: { ...valid.accounts.customerA, password: "do-not-save" } } },
    { migrationChecksums: Object.fromEntries(Object.entries(valid.migrationChecksums).filter(([version]) => !version.startsWith("106_"))) },
  ]) assert.throws(() => validateHostedTarget({ ...valid, ...mutation }), /HOSTED_/);
  assert.equal(exactHostedUrl("/api/knowledge-center", valid).origin, valid.origin);
  for (const pathname of ["https://another.vercel.app/api/knowledge-center", "//another.vercel.app/", "/api/knowledge-center#fragment"]) assert.throws(() => exactHostedUrl(pathname, valid), /HOSTED_CROSS_ORIGIN/);
});

test("hosted diagnostics bind exact implementation, deployment, real Neon identity and candidate checksums", () => {
  const config = validateHostedTarget(target()), valid = diagnostics(config);
  const owner = ownerBundle(config);
  const result = assertHostedRuntimeBinding(valid, config, owner);
  assert.equal(result.verifiedMigrationChecksums, 13);
  assert.equal(result.environment, "preview");
  // The diagnostic route's production-only umbrella status is deliberately not
  // treated as a Preview result. The underlying authenticated facts are checked.
  assert.equal(valid.runtimeProof.status, "FAIL");
  for (const mutate of [
    value => { value.runtimeProof.environment = "production"; },
    value => { value.runtimeProof.build.gitSha = "b".repeat(40); },
    value => { value.runtimeProof.build.deploymentId = "dpl_" + "z".repeat(24); },
    value => { value.runtimeProof.identity.neonBranchId = "br-foreign"; },
    value => { value.runtimeProof.identity.currentUser = config.neon.migrationRole; },
    value => { value.runtimeProof.identity.createRole = true; },
    value => { delete value.runtimeProof.identity.sessionBypassRls; },
    value => { value.migrationLedgerError = "unexpected_connection_error"; },
    value => { value.migrationLedger.push({ version: "unexpected", checksum: "e".repeat(64) }); },
  ]) {
    const altered = structuredClone(valid); mutate(altered);
    assert.throws(() => assertHostedRuntimeBinding(altered, config, owner), /HOSTED_/);
  }
});

test("only proven administrative ledger denial and exact private table visibility are accepted", () => {
  const config = validateHostedTarget(target()), valid = diagnostics(config), owner = ownerBundle(config);
  const proof = assertHostedRuntimeBinding(valid, config, owner);
  assert.equal(proof.runtimeLedger.status, "EXPECTED DENIAL");
  assert.equal(proof.administrativeLedger.status, "PASS");
  assert.deepEqual(proof.runtimeInvisiblePrivateTables, [{ tableName: "company_profiles", ownerVerifiedExists: true, runtimeAnyTablePrivilege: false }]);
  for (const mutate of [
    value => { value.ok = true; },
    value => { value.status.configured = false; },
    value => { value.tableCheckError = "table_check_failed"; },
    value => { value.runtimeProof.identityError = "runtime_identity_unavailable"; },
    value => { value.missingTables.push("contacts"); },
    value => { value.tableStatus[0].exists = false; },
    value => { value.expectedTables.push("unknown_private"); },
  ]) {
    const altered = structuredClone(valid); mutate(altered);
    assert.throws(() => assertHostedRuntimeBinding(altered, config, owner), /HOSTED_/);
  }
  for (const mutate of [
    value => { value.receipt.status = "FAIL"; },
    value => { value.receipt.target.branchId = "br-foreign"; },
    value => { value.receipt.final.ledger[0].checksum = "0".repeat(64); },
    value => { value.receipt.final.runtimeCatalogVisibility.tables[1].runtimeAnyTablePrivilege = true; },
    value => { value.sha256 = "0".repeat(64); },
  ]) {
    const altered = structuredClone(owner); mutate(altered);
    assert.throws(() => assertHostedRuntimeBinding(valid, config, altered), /HOSTED_/);
  }
});

function updateSourceProof(receipt) {
  const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
  receipt.currentSourceProof = { branchId: receipt.target.branchId, checkedAt: receipt.checkedAt,
    ledgerSha256: hash(receipt.final.ledger), runtimeProofSha256: hash(receipt.final.runtimeProof), catalogSha256: hash(receipt.final.runtimeCatalogVisibility),
    hashFormat: "SHA256 of canonical JSON (scripts/lib/studio-stage3-qa-fingerprint.mjs canonical)" };
}

function cloneBundle(config) {
  config.neon = { projectId: "green-thunder-49879900", branchId: "br-shiny-darkness-baz4524v", database: "neondb", runtimeRole: "novalure_app", migrationRole: "neondb_owner" };
  const bundle = ownerBundle(config);
  const original = structuredClone(bundle.receipt);
  config.neon.branchId = "br-sweet-surf-ba6iahut";
  config.neonCloneAttestation = { path: "qa/package4-hosted-2026-10-20/neon-clone-attestation.json", sha256: "a".repeat(64), implementationRevision: "c".repeat(40) };
  const receipt = { format: "package4-neon-clone-v1", status: "PASS", productionAccess: 0, implementationRevision: config.neonCloneAttestation.implementationRevision,
    appSourceRevision: "e".repeat(40), checkedAt: new Date().toISOString(),
    target: { ...original.target, branchId: config.neon.branchId, migrationRole: config.neon.migrationRole },
    bootstrapReceipt: { ...config.neonMigrationReceipt, manifestDigest: original.manifestDigest, target: structuredClone(original.target) },
    provenance: { originalRootBranchId: "br-shiny-darkness-baz4524v", checkpointBranchId: "br-flat-block-baycv1oa", cloneBranchId: config.neon.branchId,
      checkpointParentId: "br-shiny-darkness-baz4524v", cloneParentId: "br-flat-block-baycv1oa", checkpointParentLsn: "0/2F63518", cloneParentLsn: "0/2F63518",
      initialSnapshotBytesSha256: "7760928f4cdbb479b4373818ff0c5ebe002b453df92a49dd513a387b53c250e7" },
    identity: { ...original.identity, branch: config.neon.branchId, sessionRole: config.neon.migrationRole },
    final: structuredClone(original.final), sourceMigrationChecksums: structuredClone(config.migrationChecksums), manifestDigest: original.manifestDigest,
    migrationsExecutedOnClone: false, migrationsInheritedThroughCOW: true };
  receipt.final.runtime = { ...receipt.final.runtime, rolname: config.neon.runtimeRole, rolinherit: true };
  receipt.final.runtimeCatalogVisibility.checkedAt = receipt.checkedAt;
  receipt.final.forcedRlsTables = structuredClone(receipt.final.forcedRls);
  delete receipt.final.forcedRls;
  receipt.final.runtimeProof = { identity: { project: config.neon.projectId, branch: config.neon.branchId, database: config.neon.database, role: config.neon.runtimeRole, sessionRole: config.neon.runtimeRole },
    role: structuredClone(receipt.final.runtime), ownsPublicObjects: 0, publicCreate: false,
    privateProvisioningDenied: ["novalure_schema_migrations", "novalure_migration_execution_receipts", "crm_service_principals", "provider_connections", "company_profiles"],
    missingContextDeniedKnowledge: ["knowledge_sources", "knowledge_areas", "knowledge_workflow_events", "knowledge_website_monitoring"] };
  updateSourceProof(receipt);
  bundle.cloneAttestation = { receipt, sha256: config.neonCloneAttestation.sha256 };
  return bundle;
}

test("original branch accepts only its explicit separately hashed catalog measurement", () => {
  const config = target(), bundle = ownerBundle(config);
  const catalog = structuredClone(bundle.receipt.final.runtimeCatalogVisibility);
  delete bundle.receipt.final.runtimeCatalogVisibility;
  config.neonRuntimeCatalogReceipt = { path: "qa/package4-hosted-2026-10-20/neon-runtime-catalog-visibility.json", sha256: "a".repeat(64) };
  bundle.catalogReceipt = { sha256: config.neonRuntimeCatalogReceipt.sha256,
    receipt: { format: "package4-neon-runtime-catalog-visibility-v1", status: "PASS", target: { ...config.neon }, runtimeCatalogVisibility: catalog } };
  assert.deepEqual(assertHostedOwnerMigrationReceipt(bundle, validateHostedTarget(config)).catalog, catalog);
  const altered = structuredClone(bundle); altered.catalogReceipt.receipt.target.branchId = "br-foreign";
  assert.throws(() => assertHostedOwnerMigrationReceipt(altered, config), /HOSTED_OWNER_MIGRATION_TARGET_MISMATCH/);
  const noSeparateBinding = structuredClone(config); delete noSeparateBinding.neonRuntimeCatalogReceipt;
  assert.throws(() => assertHostedOwnerMigrationReceipt(bundle, noSeparateBinding), /HOSTED_UNEXPECTED_CATALOG/);
  const relabeled = structuredClone(config); relabeled.neon.branchId = "br-sweet-surf-ba6iahut";
  assert.throws(() => assertHostedOwnerMigrationReceipt(bundle, relabeled), /HOSTED_OWNER_MIGRATION_TARGET_MISMATCH/);
});

test("provider clone needs immutable bootstrap, exact COW provenance and fresh native proofs", () => {
  const config = target(), bundle = cloneBundle(config), valid = diagnostics(config);
  const result = assertHostedRuntimeBinding(valid, validateHostedTarget(config), bundle);
  assert.equal(result.administrativeLedger.source, config.neonCloneAttestation.path);
  assert.equal(result.administrativeLedger.cloneProvenance.bootstrapReceiptSha256, config.neonMigrationReceipt.sha256);
  assert.notEqual(bundle.cloneAttestation.receipt.appSourceRevision, config.sourceSha);
  for (const mutate of [
    value => { delete value.cloneAttestation; },
    value => { value.cloneAttestation.sha256 = "0".repeat(64); },
    value => { value.cloneAttestation.receipt.status = "FAIL"; },
    value => { value.cloneAttestation.receipt.bootstrapReceipt.sha256 = "0".repeat(64); },
    value => { value.cloneAttestation.receipt.bootstrapReceipt.target.branchId = config.neon.branchId; },
    value => { value.cloneAttestation.receipt.provenance.checkpointParentId = "br-foreign"; },
    value => { value.cloneAttestation.receipt.provenance.cloneParentId = "br-shiny-darkness-baz4524v"; },
    value => { value.cloneAttestation.receipt.provenance.cloneParentLsn = "0/0000000"; },
    value => { value.cloneAttestation.receipt.provenance.initialSnapshotBytesSha256 = "0".repeat(64); },
    value => { value.cloneAttestation.receipt.identity.branch = "br-shiny-darkness-baz4524v"; },
    value => { value.cloneAttestation.receipt.identity.sessionRole = "cloud_admin"; },
    value => { value.cloneAttestation.receipt.final.runtime.rolbypassrls = true; },
    value => { value.cloneAttestation.receipt.final.actualRuntimeConnectionVerified = false; },
    value => { value.cloneAttestation.receipt.sourceMigrationChecksums[Object.keys(config.migrationChecksums)[0]] = "0".repeat(64); },
    value => { value.cloneAttestation.receipt.final.ledger.pop(); updateSourceProof(value.cloneAttestation.receipt); },
    value => { value.cloneAttestation.receipt.currentSourceProof.ledgerSha256 = "0".repeat(64); },
    value => { value.cloneAttestation.receipt.currentSourceProof.branchId = "br-foreign"; },
    value => { value.cloneAttestation.receipt.currentSourceProof.checkedAt = "2000-01-01T00:00:00.000Z"; },
    value => { value.cloneAttestation.receipt.final.runtimeProof.identity.branch = "br-foreign"; updateSourceProof(value.cloneAttestation.receipt); },
    value => { value.cloneAttestation.receipt.final.runtimeProof.privateProvisioningDenied.pop(); updateSourceProof(value.cloneAttestation.receipt); },
    value => { value.cloneAttestation.receipt.final.runtimeProof.publicCreate = true; updateSourceProof(value.cloneAttestation.receipt); },
    value => { value.cloneAttestation.receipt.final.forcedRlsTables[0].relforcerowsecurity = false; },
    value => { value.cloneAttestation.receipt.migrationsExecutedOnClone = true; },
    value => { value.cloneAttestation.receipt.final.runtimeCatalogVisibility.tables[1].runtimeAnyTablePrivilege = true; },
    value => { value.receipt.target.branchId = config.neon.branchId; },
  ]) {
    const altered = structuredClone(bundle); mutate(altered);
    assert.throws(() => assertHostedRuntimeBinding(valid, config, altered), /HOSTED_/);
  }
  const missingCloneBinding = structuredClone(config); delete missingCloneBinding.neonCloneAttestation;
  assert.throws(() => assertHostedRuntimeBinding(valid, missingCloneBinding, bundle), /HOSTED_/);
  assert.throws(() => validateHostedTarget({ ...config, neon: { ...config.neon, branchId: "br-arbitrary" } }), /HOSTED_EXACT_CLONE_PROFILE_REQUIRED/);
});

test("clone loader hashes actual receipt bytes and binds the fresh catalog to candidate schema source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "package4-hosted-receipt-"));
  try {
    const config = target(), bundle = cloneBundle(config), clone = bundle.cloneAttestation.receipt;
    const schema = "// SYNTHETIC candidate schema source\n";
    clone.final.runtimeCatalogVisibility.expectedTablesSourceSha256 = createHash("sha256").update(schema).digest("hex");
    updateSourceProof(clone);
    const cloneBytes = JSON.stringify(clone);
    config.neonCloneAttestation.sha256 = createHash("sha256").update(cloneBytes).digest("hex");
    await mkdir(path.join(root, "qa/package4-hosted-2026-10-20"), { recursive: true });
    await mkdir(path.join(root, "src/lib/db"), { recursive: true });
    await writeFile(path.join(root, "src/lib/db/schema.ts"), schema);
    await writeFile(path.join(root, config.neonMigrationReceipt.path), JSON.stringify(bundle.receipt));
    await writeFile(path.join(root, config.neonCloneAttestation.path), cloneBytes);
    const loaded = await loadHostedOwnerMigrationReceipt(validateHostedTarget(config), root);
    assert.equal(loaded.sha256, config.neonMigrationReceipt.sha256);
    assert.equal(loaded.cloneAttestation.sha256, config.neonCloneAttestation.sha256);
    await writeFile(path.join(root, config.neonCloneAttestation.path), cloneBytes + "\n");
    await assert.rejects(loadHostedOwnerMigrationReceipt(config, root), /HOSTED_CLONE_ATTESTATION_MISMATCH/);
    await writeFile(path.join(root, config.neonCloneAttestation.path), cloneBytes);
    await writeFile(path.join(root, "src/lib/db/schema.ts"), schema + "// source changed\n");
    await assert.rejects(loadHostedOwnerMigrationReceipt(config, root), /HOSTED_OWNER_CATALOG_SOURCE_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
