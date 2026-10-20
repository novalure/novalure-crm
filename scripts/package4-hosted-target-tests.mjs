import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertHostedRuntimeBinding, exactHostedUrl, validateHostedTarget } from "./lib/package4-hosted-target.mjs";

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
      ledger: Object.entries(config.migrationChecksums).map(([version, checksum]) => ({ version, checksum })),
      runtimeCatalogVisibility: { expectedTablesSourceSha256: "f".repeat(64), checkedAt: new Date().toISOString(), tables: [
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
