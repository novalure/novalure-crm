import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { captureDatabaseMetadata, captureExtensionMetadata, extensionQueries, identityHash, sourceExtensions, validateTarget, qaProject, sourceBranch, restoreProject, restoreBranch } from './studio-stage3-qa-fingerprint.mjs';
export const sourceTarget = Object.freeze({ mode: 'source', projectId: qaProject, branchId: sourceBranch,
  databaseName: 'qa_g24_pr63_20260917_r3', roleName: 'neondb_owner' });
export const restoreTarget = Object.freeze({ mode: 'restore', projectId: restoreProject, branchId: restoreBranch,
  databaseName: 'neondb', roleName: 'neondb_owner' });
export const applicationRoles = Object.freeze([
  { name: 'novalure_app', login: true, inherit: true },
  { name: 'novalure_tenant_app', login: false, inherit: false },
  { name: 'g24_qa_20260917_r3', login: false, inherit: false }
]);
const requireValue = (value, code) => { assert.ok(value, code); };
const safeRole = (role, expected) => role.rolname === expected.name && role.rolcanlogin === expected.login &&
  role.rolinherit === expected.inherit && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole &&
  !role.rolreplication && !role.rolbypassrls && !role.rolconfig?.length;
export function compareDatabaseFingerprints(a, b) {
  return ['database', 'schema', 'ledger', 'executionReceipts', 'data', 'extensionProfile'].every((key) => a[key]?.sha256 && a[key].sha256 === b[key]?.sha256);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plpgsql = Object.freeze({ name: 'plpgsql', version: '1.0', schema: 'pg_catalog', owner: 'cloud_admin' });
const installedProfile = Object.freeze([sourceExtensions[0], plpgsql, sourceExtensions[1]]);
function assertSourceExtensionProfile(profile) {
  requireValue(profile?.format === 'studio-stage3-source-extension-profile-v1' &&
    profile.server?.version_num === 170011 && same(profile.extensions, installedProfile) &&
    profile.memberCount > 0 && /^[a-f0-9]{64}$/u.test(profile.structureSha256 || '') &&
    /^[a-f0-9]{64}$/u.test(profile.memberIdentitiesSha256 || '') &&
    Array.isArray(profile.privileges) && Array.isArray(profile.schemaGrants) &&
    profile.namespaces?.length === 1 && profile.namespaces[0].nspname === 'public', 'SOURCE_EXTENSION_PROFILE_NOT_APPROVED');
}
export function verifyApprovedSource(report, approved) {
  requireValue(report.databaseName === sourceTarget.databaseName && report.projectId === qaProject &&
    report.branchId === sourceBranch && report.readOnlyTransaction === true, 'SOURCE_IDENTITY_NOT_APPROVED');
  requireValue(report.database?.owner === 'neondb_owner', 'SOURCE_DATABASE_OWNER_NOT_APPROVED');
  requireValue(report.ledger.rows === 42 && report.ledger.through === 85 && report.ledger.completeCanonicalCoverage &&
    report.ledger.verifiedCommittedChecksums && report.executionReceipts.original061Verified &&
    report.data.tables === 141 && report.data.rows === 118, 'SOURCE_HISTORICAL_PROVENANCE_MISMATCH');
  requireValue(compareDatabaseFingerprints(report, approved), 'SOURCE_FINGERPRINT_NOT_APPROVED');
  assertSourceExtensionProfile(report.extensionProfile);
  requireValue(report.classification.markerChecks === 'PASS_NARROW_MARKER_CHECKS', 'SOURCE_CLASSIFICATION_REQUIRES_REVIEW');
}
async function targetIdentity(client) {
  const row = (await client.query("select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role,session_user as session_role,(select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as database_owner")).rows[0];
  requireValue(row?.project === restoreProject && row.branch === restoreBranch && row.database === 'neondb' &&
    row.role === 'neondb_owner' && row.session_role === 'neondb_owner' && row.database_owner === 'neondb_owner', 'PINNED_RESTORE_IDENTITY_MISMATCH');
}
async function assertDatabaseMetadataMatches(client, expected) {
  requireValue(expected?.owner === 'neondb_owner' && /^[a-f0-9]{64}$/u.test(expected.sha256 || ''), 'APPROVED_DATABASE_METADATA_REQUIRED');
  const actual = await captureDatabaseMetadata(client);
  requireValue(actual.owner === 'neondb_owner', 'PINNED_DATABASE_OWNER_REQUIRED');
  requireValue(actual.sha256 === expected.sha256, 'SOURCE_TARGET_DATABASE_METADATA_MISMATCH');
  return actual;
}
const privilegesSubset = (actual, source) => actual.every((privilege) => source.some((expected) => same(privilege, expected)));
async function inspectRestoreCatalog(client, sourceProfile, prepared = false, baseline) {
  assertSourceExtensionProfile(sourceProfile);
  const actual = await captureExtensionMetadata(client);
  requireValue(actual.server.version_num === 180006, 'PINNED_TARGET_POSTGRESQL18_6_REQUIRED');
  requireValue(same(actual.extensions, prepared ? installedProfile : [plpgsql]), 'TARGET_EXTENSION_VERSION_OR_IDENTITY_MISMATCH');
  requireValue(same(actual.namespaces, sourceProfile.namespaces), 'TARGET_SCHEMA_OWNER_OR_EXTRA_SCHEMA_MISMATCH');
  requireValue(privilegesSubset(actual.schemaGrants, sourceProfile.schemaGrants), 'TARGET_SCHEMA_ACL_EXCEEDS_SOURCE');
  requireValue(actual.schemaGrants.every((row) => row.is_grantable === false && row.grantor === row.owner &&
    ((row.grantee === 'PUBLIC' && row.privilege_type === 'USAGE') ||
     (row.grantee === row.owner && ['USAGE', 'CREATE'].includes(row.privilege_type)))), 'TARGET_SCHEMA_ACL_NOT_STANDARD');
  const objects = (await client.query(extensionQueries.userObjects)).rows;
  const globals = (await client.query(extensionQueries.globalObjects)).rows[0];
  requireValue(globals?.count === 0, 'TARGET_EXTRA_GLOBAL_OBJECTS');
  if (!prepared) {
    requireValue(objects.length === 0 && actual.memberCount === 0, 'RESTORE_TARGET_NOT_EMPTY');
    const available = (await client.query(extensionQueries.available)).rows;
    requireValue(sourceExtensions.every((extension) => available.some((row) => row.name === extension.name && row.version === extension.version)), 'SOURCE_EXTENSION_VERSION_UNAVAILABLE');
  } else {
    const extensionObjects = objects.filter((row) => row.catalog === 'pg_extension');
    const members = objects.filter((row) => row.catalog !== 'pg_extension');
    requireValue(extensionObjects.length === 2 && extensionObjects.every((row) => sourceExtensions.some((extension) => row.identity === extension.name)) &&
      members.length === sourceProfile.memberCount && identityHash(members) === sourceProfile.memberIdentitiesSha256,
    'TARGET_NON_EXTENSION_OBJECTS_OR_MEMBER_DRIFT');
    requireValue(actual.memberCount === sourceProfile.memberCount && actual.structureSha256 === sourceProfile.structureSha256,
      'TARGET_EXTENSION_STRUCTURE_MISMATCH');
    // Native restore will reapply the source's later tenant grants. Before it, only
    // standard owner/PUBLIC privileges that are a subset of source rights are safe.
    requireValue(actual.privileges.every((row) => row.is_grantable === false && row.grantor === 'neondb_owner' &&
      ['PUBLIC', 'neondb_owner'].includes(row.grantee) &&
      ((row.catalog === 'pg_proc' && row.privilege_type === 'EXECUTE') || (row.catalog === 'pg_type' && row.privilege_type === 'USAGE'))) &&
      privilegesSubset(actual.privileges, sourceProfile.privileges), 'TARGET_EXTENSION_ACL_EXCEEDS_SOURCE_OR_STANDARD');
    requireValue(baseline && same(actual.schemaGrants, baseline.schemaGrants), 'TARGET_SCHEMA_ACL_DRIFT');
    if (baseline.extensions.length === 3) requireValue(actual.sha256 === baseline.sha256, 'TARGET_PRE_RESTORE_EXTENSION_DRIFT');
  }
  return actual;
}
export async function assertEmptyRestoreTarget(client, expectedDatabase, sourceProfile) {
  validateTarget(restoreTarget);
  await client.query('begin isolation level repeatable read read only');
  try {
    await targetIdentity(client);
    await assertDatabaseMetadataMatches(client, expectedDatabase);
    const profile = await inspectRestoreCatalog(client, sourceProfile);
    await client.query('rollback'); return profile;
  } catch (error) { await client.query('rollback'); throw error; }
}
export async function installSourceExtensions(client, expectedDatabase, sourceProfile, emptyBaseline) {
  await client.query('begin');
  try {
    await targetIdentity(client); await assertDatabaseMetadataMatches(client, expectedDatabase);
    const empty = await inspectRestoreCatalog(client, sourceProfile);
    requireValue(empty.sha256 === emptyBaseline.sha256, 'TARGET_EMPTY_CATALOG_DRIFT');
    // Fixed, reviewed names/versions only; never execute caller-supplied extension SQL.
    await client.query('create extension "pgcrypto" with schema "public" version \'1.3\'');
    await client.query('create extension "vector" with schema "public" version \'0.8.0\'');
    const prepared = await inspectRestoreCatalog(client, sourceProfile, true, emptyBaseline);
    await client.query('commit'); return prepared;
  } catch (error) { await client.query('rollback'); throw error; }
}
export async function assertPreparedRestoreTarget(client, expectedDatabase, sourceProfile, baseline) {
  await client.query('begin isolation level repeatable read read only');
  try {
    await targetIdentity(client); await assertDatabaseMetadataMatches(client, expectedDatabase);
    await inspectRestoreCatalog(client, sourceProfile, true, baseline);
    await client.query('rollback');
  } catch (error) { await client.query('rollback'); throw error; }
}
export async function provisionRunOwnedRoles(client, savePassword, expectedDatabase) {
  await client.query('begin');
  try {
    await targetIdentity(client);
    await assertDatabaseMetadataMatches(client, expectedDatabase);
    const current = (await client.query("select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig from pg_roles where rolname=any($1::text[]) order by rolname", [applicationRoles.map((role) => role.name)])).rows;
    // Existing names may belong to an unknown prior attempt. Never rotate or repair them.
    requireValue(current.length === 0, 'RUN_OWNED_ROLES_ALREADY_EXIST');
    const password = randomBytes(40).toString('hex');
    await savePassword({ role: 'novalure_app', password, projectId: restoreProject, branchId: restoreBranch, databaseName: 'neondb' });
    for (const role of applicationRoles) {
      const sql = 'create role "' + role.name + '" ' + (role.login ? 'login' : 'nologin') + ' ' +
        (role.inherit ? 'inherit' : 'noinherit') + ' nosuperuser nocreatedb nocreaterole noreplication nobypassrls' +
        (role.login ? " password '" + password + "'" : '');
      await client.query(sql);
    }
    await client.query('grant novalure_tenant_app to novalure_app with admin false, inherit true, set false');
    const actual = (await client.query("select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig from pg_roles where rolname=any($1::text[]) order by rolname", [applicationRoles.map((role) => role.name)])).rows;
    requireValue(actual.length === 3 && applicationRoles.every((expected) => actual.some((role) => safeRole(role, expected))), 'CREATED_ROLE_ATTRIBUTES_MISMATCH');
    const edges = (await client.query("select parent.rolname as parent,member.rolname as member,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member where member.rolname=any($1::text[]) order by parent.rolname,member.rolname", [applicationRoles.map((role) => role.name)])).rows;
    requireValue(edges.length === 1 && edges[0].parent === 'novalure_tenant_app' && edges[0].member === 'novalure_app' &&
      edges[0].admin_option === false && edges[0].inherit_option === true && edges[0].set_option === false, 'RUNTIME_MEMBERSHIP_MISMATCH');
    await client.query('commit');
    return { created: applicationRoles.map(({ name, login, inherit }) => ({ name, login, inherit })),
      runtimeMembership: { parent: 'novalure_tenant_app', member: 'novalure_app', admin: false, inherit: true, set: false },
      differencesFromSource: ['Historical g24 principal is NOLOGIN/NOINHERIT with no membership.', 'novalure_app tenant membership has SET=false.'],
      sourceRoleChanges: 0, providerRoleChanges: 0 };
  } catch (error) { await client.query('rollback'); throw error; }
}
/** Runner is opt-in; callers supply verified TLS clients and private-only native/artifact adapters. */
export async function restoreSelectedQa({ source, target, approvedSource, capture, native, savePassword, saveEvidence }) {
  const evidence = { format: 'studio-stage3-selected-qa-restore-v1', status: 'RUNNING',
    source: sourceTarget, target: restoreTarget, productionAccess: 0, sourceWrites: 0, ledgerRecreation: 0,
    migrationExecution: 0, steps: [] };
  const step = async (name, action) => { const result = await action(); evidence.steps.push(name); await saveEvidence(evidence); return result; };
  await saveEvidence(evidence);
  try {
    const before = await step('source_readonly_provenance', () => capture(source, sourceTarget));
    verifyApprovedSource(before, approvedSource);
    const emptyBaseline = await step('exact_empty_target', () => assertEmptyRestoreTarget(target, before.database, before.extensionProfile));
    const tools = await step('native_client_versions', async () => ({ dump: await native('pg_dump', 'version'), restore: await native('pg_restore', 'version') }));
    requireValue(/^pg_dump \(PostgreSQL\) 18\./u.test(tools.dump.trim()) && /^pg_restore \(PostgreSQL\) 18\./u.test(tools.restore.trim()), 'POSTGRESQL18_CLIENTS_REQUIRED');
    evidence.nativeClients = tools;
    evidence.roles = await step('run_owned_target_roles', () => provisionRunOwnedRoles(target, savePassword, before.database));
    const prepared = await step('source_extension_versions_installed', () => installSourceExtensions(target, before.database, before.extensionProfile, emptyBaseline));
    evidence.crossVersionProfile = { sourceServer: before.extensionProfile.server, targetServer: prepared.server,
      extensions: sourceExtensions, scope: 'Selected G24 QA only; PostgreSQL17.11 to18.6 with source extension versions. Not a general disaster-recovery proof.' };
    evidence.archive = await step('native_selected_database_dump', () => native('pg_dump', 'dump'));
    const unchanged = await step('source_unchanged_after_dump', () => capture(source, sourceTarget));
    requireValue(compareDatabaseFingerprints(before, unchanged), 'SOURCE_DRIFT_DURING_DUMP');
    await step('target_extension_only_before_restore', () => assertPreparedRestoreTarget(target, before.database, before.extensionProfile, prepared));
    await step('native_restore_owner_acl', () => native('pg_restore', 'restore'));
    const after = await step('restore_readonly_fingerprint', () => capture(target, restoreTarget));
    requireValue(compareDatabaseFingerprints(before, after), 'RESTORED_DATABASE_FINGERPRINT_MISMATCH');
    const finalSource = await step('source_final_unchanged', () => capture(source, sourceTarget));
    requireValue(compareDatabaseFingerprints(before, finalSource), 'SOURCE_CHANGED_DURING_RESTORE');
    evidence.fingerprints = { source: before, restored: after };
    evidence.status = 'PASS'; await saveEvidence(evidence); return evidence;
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.failureCode = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message || '') ? error.message : 'SELECTED_QA_RESTORE_FAILED';
    await saveEvidence(evidence); throw new Error(evidence.failureCode);
  }
}
