import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureDatabaseMetadata, restoreProject, restoreBranch } from './studio-stage3-qa-fingerprint.mjs';
import { verifyApprovedSource, inspectRestoreCatalog } from './studio-stage3-qa-restore.mjs';

export const managementDatabase = 'st1_stage3_management';
export const providerBaselineDatabase = 'st1_stage3_provider_baseline';
const requireValue = (value, code) => assert.ok(value, code);
const canonical = (value) => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical(value[key]))]))
  : Array.isArray(value) ? value.map((entry) => JSON.parse(canonical(entry))) : value);
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const equal = (a, b) => canonical(a) === canonical(b);
const initialNames = ['neondb', 'postgres', 'template0', 'template1'];
// Verified PG18.6 provider inventory on this exact target and its parent.
// These existing provider powers are observed, never granted or modified here.
const allowedRoles = Object.freeze([
  Object.freeze({ name: 'cloud_admin', login: true, superuser: true, bypassrls: true, create_database: true, create_role: true }),
  Object.freeze({ name: 'neon_service', login: true, superuser: false, bypassrls: true, create_database: true, create_role: true }),
  Object.freeze({ name: 'neon_superuser', login: false, superuser: false, bypassrls: true, create_database: true, create_role: true }),
  Object.freeze({ name: 'neondb_owner', login: true, superuser: false, bypassrls: true, create_database: true, create_role: true })
]);
export const prepareTargetQueries = Object.freeze({
  identity: "select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role,session_user as session_role,pg_backend_pid() as pid,(select oid::int from pg_database where datname=current_database()) as database_oid,(select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as database_owner,current_setting('server_version_num')::int as server_version_num,(select rolcreatedb from pg_roles where rolname=current_user) as can_create_database",
  databases: 'select datname as name,datistemplate as is_template,pg_get_userbyid(datdba) as owner from pg_database order by datname',
  roles: "select rolname as name,rolcanlogin as login,rolsuper as superuser,rolbypassrls as bypassrls,rolcreatedb as create_database,rolcreaterole as create_role from pg_roles where rolname !~ '^pg_' order by rolname",
  sessions: "select pid,datname as database,usename as role from pg_stat_activity where backend_type='client backend' order by pid",
  prepared: 'select count(*)::int as count from pg_prepared_xacts'
});

async function identity(client, database) {
  const row = (await client.query(prepareTargetQueries.identity)).rows[0];
  requireValue(row?.project === restoreProject && row.branch === restoreBranch && row.database === database &&
    row.role === 'neondb_owner' && row.session_role === 'neondb_owner' && row.database_owner === 'neondb_owner' &&
    row.server_version_num === 180006 && row.can_create_database === true && Number.isInteger(row.pid) && Number.isInteger(row.database_oid),
  'PINNED_PREPARE_TARGET_IDENTITY_MISMATCH');
  return row;
}
async function assertNoAppRoles(client) {
  const roles = (await client.query(prepareTargetQueries.roles)).rows;
  requireValue(roles.length === allowedRoles.length && equal(roles, allowedRoles), 'PREPARE_TARGET_APPLICATION_OR_UNKNOWN_ROLE_EXISTS');
  return roles;
}
async function assertSessions(client, allowed) {
  const rows = (await client.query(prepareTargetQueries.sessions)).rows;
  requireValue(rows.length === allowed.size && rows.every((row) => allowed.get(row.pid) === row.database && row.role === 'neondb_owner'), 'PREPARE_TARGET_FOREIGN_SESSION');
  requireValue((await client.query(prepareTargetQueries.prepared)).rows[0]?.count === 0, 'PREPARE_TARGET_PREPARED_TRANSACTION');
}
async function assertNames(client, expected) {
  const rows = (await client.query(prepareTargetQueries.databases)).rows;
  requireValue(equal(rows.map((row) => row.name), [...expected].sort()), 'PREPARE_TARGET_DATABASE_NAMES_NOT_FRESH');
  requireValue(rows.filter((row) => ['neondb', managementDatabase, providerBaselineDatabase].includes(row.name))
    .every((row) => row.owner === 'neondb_owner' && row.is_template === false), 'PREPARE_TARGET_DATABASE_OWNER_MISMATCH');
  return rows;
}
const emptyCatalog = (client, sourceReport) => inspectRestoreCatalog(client, sourceReport.extensionProfile);
function sourceMetadata(source) {
  verifyApprovedSource(source, source);
  requireValue(source.database.settings.length === 0, 'SOURCE_CURRENT_DATABASE_SETTINGS_REQUIRE_SEPARATE_PLAN');
  return source.database;
}
function assertProviderBaseline(database, source) {
  requireValue(database.format === 'studio-stage3-database-metadata-v2' && database.owner === 'neondb_owner' &&
    equal(database.properties, source.properties) && equal(database.settings, source.settings), 'PREPARE_TARGET_PROPERTIES_OR_SETTINGS_MISMATCH');
  const additions = database.acl.filter((row) => !source.acl.some((entry) => equal(row, entry)));
  requireValue(source.acl.every((row) => database.acl.some((entry) => equal(row, entry))) && additions.length === 3 &&
    equal(additions.map((row) => row.privilege_type).sort(), ['CONNECT', 'CREATE', 'TEMPORARY']) &&
    additions.every((row) => row.grantee === 'neon_superuser' && row.grantor === 'neondb_owner' && row.is_grantable === false),
  'PREPARE_TARGET_PROVIDER_BASELINE_ACL_MISMATCH');
  requireValue(database.globalRoleSettings.count === 0, 'PREPARE_TARGET_GLOBAL_ROLE_SETTINGS_EXIST');
}
/** Read-only plan. It neither changes ACLs nor creates a database/role/extension. */
export async function capturePrepareTargetPreflight(client, sourceReport) {
  const source = sourceMetadata(sourceReport);
  await client.query('begin isolation level repeatable read read only');
  try {
    const selected = await identity(client, 'neondb');
    const databases = await assertNames(client, initialNames);
    const providerRoles = await assertNoAppRoles(client); await assertSessions(client, new Map([[selected.pid, 'neondb']]));
    const database = await captureDatabaseMetadata(client); assertProviderBaseline(database, source);
    const extensionProfile = await emptyCatalog(client, sourceReport);
    const plan = { format: 'studio-stage3-prepare-target-preflight-v1', projectId: restoreProject, branchId: restoreBranch,
      databaseName: 'neondb', databaseOid: selected.database_oid, database, extensionProfile, databases, providerRoles,
      managementDatabase, providerBaselineDatabase, sourceDatabaseSha256: source.sha256,
      sourceExtensionProfileSha256: sourceReport.extensionProfile.sha256,
      sourceGlobalRoleSettingsSha256: source.globalRoleSettings.sha256,
      foreignSessions: 0, applicationRoles: 0, preparedTransactions: 0, databaseWrites: 0 };
    await client.query('rollback'); return { ...plan, sha256: hash(plan) };
  } catch (error) { await client.query('rollback'); throw error; }
}

/** Explicitly opt-in, selected target only. CREATE DATABASE cannot be atomic.
 * A partial/uncertain failure leaves all databases intact and requires a new plan.
 */
export async function prepareSelectedQaTarget({ connect, sourceReport, approvedPreflight, saveEvidence }) {
  const evidence = { format: 'studio-stage3-prepare-target-run-v1', status: 'RUNNING', projectId: restoreProject,
    branchId: restoreBranch, sourceWrites: 0, aclChanges: 0, rolesCreated: 0, extensionWrites: 0, drops: 0, steps: [] };
  const clients = new Map();
  const open = async (name) => {
    const client = await connect(name);
    clients.set(client, { name, pid: null });
    const selected = await identity(client, name); clients.set(client, { name, pid: selected.pid });
    return { client, selected };
  };
  const close = async (client) => { await client.end(); clients.delete(client); };
  const allowed = () => new Map([...clients.values()].map(({ name, pid }) => [pid, name]));
  const guard = async (client, names) => {
    await assertNames(client, names); await assertNoAppRoles(client); await assertSessions(client, allowed());
    requireValue((await captureDatabaseMetadata(client)).globalRoleSettings.count === 0, 'PREPARE_TARGET_GLOBAL_ROLE_SETTINGS_EXIST');
  };
  const write = async (client, phase, sql) => {
    evidence.phase = phase; await saveEvidence(evidence);
    await client.query(sql); evidence.steps.push(phase); await saveEvidence(evidence);
  };
  await saveEvidence(evidence);
  try {
    const source = sourceMetadata(sourceReport);
    requireValue(approvedPreflight?.format === 'studio-stage3-prepare-target-preflight-v1' && /^[a-f0-9]{64}$/u.test(approvedPreflight.sha256 || ''), 'APPROVED_PREPARE_PREFLIGHT_REQUIRED');
    const initial = await open('neondb');
    const actual = await capturePrepareTargetPreflight(initial.client, sourceReport);
    requireValue(actual.sha256 === approvedPreflight.sha256 && equal(actual, approvedPreflight), 'APPROVED_PREPARE_PREFLIGHT_DRIFT');
    evidence.preflight = actual;
    await guard(initial.client, initialNames);
    await write(initial.client, 'create_management_database', 'create database "st1_stage3_management" with template "template0" owner "neondb_owner"');
    const management = await open(managementDatabase);
    const managementMetadata = await captureDatabaseMetadata(management.client);
    requireValue(managementMetadata.sha256 === source.sha256, 'TEMPLATE0_MANAGEMENT_DATABASE_METADATA_MISMATCH');
    requireValue((await emptyCatalog(management.client, sourceReport)).sha256 === actual.extensionProfile.sha256, 'TEMPLATE0_MANAGEMENT_CATALOG_MISMATCH');
    await guard(management.client, [...initialNames, managementDatabase]);
    await close(initial.client);
    await guard(management.client, [...initialNames, managementDatabase]);
    await write(management.client, 'preserve_provider_baseline', 'alter database "neondb" rename to "st1_stage3_provider_baseline"');
    const baseline = await open(providerBaselineDatabase);
    requireValue(baseline.selected.database_oid === actual.databaseOid &&
      (await captureDatabaseMetadata(baseline.client)).sha256 === actual.database.sha256 &&
      (await emptyCatalog(baseline.client, sourceReport)).sha256 === actual.extensionProfile.sha256, 'PRESERVED_PROVIDER_BASELINE_MISMATCH');
    await close(baseline.client);
    const preservedNames = [...initialNames.filter((name) => name !== 'neondb'), managementDatabase, providerBaselineDatabase];
    await guard(management.client, preservedNames);
    await write(management.client, 'create_clean_restore_database', 'create database "neondb" with template "template0" owner "neondb_owner"');
    const fresh = await open('neondb');
    const restoredMetadata = await captureDatabaseMetadata(fresh.client);
    requireValue(fresh.selected.database_oid !== actual.databaseOid && fresh.selected.database_oid !== management.selected.database_oid &&
      restoredMetadata.sha256 === source.sha256, 'FRESH_RESTORE_DATABASE_METADATA_MISMATCH');
    requireValue((await emptyCatalog(fresh.client, sourceReport)).sha256 === actual.extensionProfile.sha256, 'FRESH_RESTORE_CATALOG_MISMATCH');
    await guard(management.client, [...preservedNames, 'neondb']);
    evidence.status = 'PASS'; evidence.phase = 'prepared_empty_target';
    evidence.database = restoredMetadata; evidence.providerBaselinePreserved = true;
    evidence.sourceGlobalRoleSettings = source.globalRoleSettings;
    evidence.limitations = ['Preparation only; no native restore, ledger, application migration or runtime-role configuration has run.',
      'The original provider database and its exact ACL remain under st1_stage3_provider_baseline.',
      'ALL_DATABASES role settings are reported separately, never copied or equated to current-database settings.'];
    await saveEvidence(evidence); return evidence;
  } catch (error) {
    evidence.status = 'FAIL'; evidence.failureCode = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message || '') ? error.message : 'PREPARE_TARGET_FAILED';
    await saveEvidence(evidence); throw new Error(evidence.failureCode);
  } finally { await Promise.allSettled([...clients.keys()].map((client) => client.end())); }
}
