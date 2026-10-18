import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { validateTarget, qaProject, sourceBranch, restoreProject, restoreBranch } from './studio-stage3-qa-fingerprint.mjs';
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
  return ['schema', 'ledger', 'executionReceipts', 'data'].every((key) => a[key]?.sha256 && a[key].sha256 === b[key]?.sha256);
}
export function verifyApprovedSource(report, approved) {
  requireValue(report.databaseName === sourceTarget.databaseName && report.projectId === qaProject &&
    report.branchId === sourceBranch && report.readOnlyTransaction === true, 'SOURCE_IDENTITY_NOT_APPROVED');
  requireValue(report.ledger.rows === 42 && report.ledger.through === 85 && report.ledger.completeCanonicalCoverage &&
    report.ledger.verifiedCommittedChecksums && report.executionReceipts.original061Verified &&
    report.data.tables === 141 && report.data.rows === 118, 'SOURCE_HISTORICAL_PROVENANCE_MISMATCH');
  requireValue(compareDatabaseFingerprints(report, approved), 'SOURCE_FINGERPRINT_NOT_APPROVED');
  requireValue(report.classification.markerChecks === 'PASS_NARROW_MARKER_CHECKS', 'SOURCE_CLASSIFICATION_REQUIRES_REVIEW');
}
async function targetIdentity(client) {
  const row = (await client.query("select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role,session_user as session_role")).rows[0];
  requireValue(row?.project === restoreProject && row.branch === restoreBranch && row.database === 'neondb' &&
    row.role === 'neondb_owner' && row.session_role === 'neondb_owner', 'PINNED_RESTORE_IDENTITY_MISMATCH');
}
export async function assertEmptyRestoreTarget(client) {
  validateTarget(restoreTarget);
  await client.query('begin isolation level repeatable read read only');
  try {
    await targetIdentity(client);
    const row = (await client.query("select (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema') as relations,(select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema') as functions,(select count(*)::int from pg_namespace where nspname !~ '^pg_' and nspname not in ('public','information_schema')) as extra_schemas")).rows[0];
    requireValue(row?.relations === 0 && row.functions === 0 && row.extra_schemas === 0, 'RESTORE_TARGET_NOT_EMPTY');
    await client.query('rollback');
  } catch (error) { await client.query('rollback'); throw error; }
}
export async function provisionRunOwnedRoles(client, savePassword) {
  await client.query('begin');
  try {
    await targetIdentity(client);
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
    await step('exact_empty_target', () => assertEmptyRestoreTarget(target));
    const tools = await step('native_client_versions', async () => ({ dump: await native('pg_dump', 'version'), restore: await native('pg_restore', 'version') }));
    requireValue(/^pg_dump \(PostgreSQL\) 18\./u.test(tools.dump.trim()) && /^pg_restore \(PostgreSQL\) 18\./u.test(tools.restore.trim()), 'POSTGRESQL18_CLIENTS_REQUIRED');
    evidence.nativeClients = tools;
    evidence.roles = await step('run_owned_target_roles', () => provisionRunOwnedRoles(target, savePassword));
    evidence.archive = await step('native_selected_database_dump', () => native('pg_dump', 'dump'));
    const unchanged = await step('source_unchanged_after_dump', () => capture(source, sourceTarget));
    requireValue(compareDatabaseFingerprints(before, unchanged), 'SOURCE_DRIFT_DURING_DUMP');
    await step('target_empty_before_restore', () => assertEmptyRestoreTarget(target));
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
