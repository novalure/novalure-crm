import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { applyCrmCandidate061Compatibility, renderNeon061Compatibility } from './neon-061-compat.mjs';
import { captureDatabaseMetadata, captureExtensionMetadata, catalogQueries } from './studio-stage3-qa-fingerprint.mjs';
import { prepareTargetQueries } from './studio-stage3-qa-prepare-target.mjs';
import { crmCandidateTarget, digest, sha256, validateCrmCandidateDescriptor, validateCrmCandidatePlan } from './crm-candidate-fresh-manifest.mjs';
import { applyMigration } from '../db-migrate.mjs';

const check = (condition, code) => assert.ok(condition, code);
const providerRoleNames = new Set(['cloud_admin', 'neon_service', 'neon_superuser', 'neondb_owner', 'token_roles']);
const providerMonitors = new Set(['compute_ctl:compute_monitor', 'vm-monitor', 'neon_compute_sql_exporter']);
const safeSessionErrors = new WeakSet();
const strictProviderIdle = row => row.role === 'cloud_admin' && row.database === 'postgres' &&
  row.backend_type === 'client backend' && row.state === 'idle';
export const crmCandidatePreservedDatabase = 'crm_candidate_provider_baseline';
export const crmCandidateQueries = Object.freeze({
  sessions: `select pid,datname as database,usename as role,state,backend_type,application_name
    from pg_stat_activity where backend_type='client backend' order by pid`,
  providerRoles: `select rolname as name,rolcanlogin as login,rolsuper as superuser,rolbypassrls as bypassrls,
    rolcreatedb as create_database,rolcreaterole as create_role,rolreplication as replication
    from pg_roles where rolname !~ '^pg_' order by rolname`,
  empty: `select
    (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')) as relations,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')) as functions,
    (select count(*)::int from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and t.typtype in('e','d','r','m')
      and not exists(select 1 from pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e')) as types,
    (select count(*)::int from pg_db_role_setting) as settings,
    (select count(*)::int from pg_event_trigger)+(select count(*)::int from pg_foreign_server)+
    (select count(*)::int from pg_publication)+(select count(*)::int from pg_largeobject_metadata) as global_objects`,
  runtime: `select r.rolname,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    not exists(select 1 from pg_class where relowner=r.oid) and
    not exists(select 1 from pg_namespace where nspowner=r.oid) and
    not exists(select 1 from pg_database where datdba=r.oid) as nonowner,
    not has_database_privilege(r.oid,current_database(),'CREATE') and
    not has_schema_privilege(r.oid,'public','CREATE') as no_ddl
    from pg_roles r where r.rolname in('novalure_app','novalure_tenant_app') order by r.rolname`,
  ledger: 'select version,name,checksum from public.novalure_schema_migrations order by version',
});

function sessionFailure(reason, rows, own, attempts) {
  const knownStates = new Set(['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call', 'disabled']);
  const safe = row => {
    const app = typeof row?.application_name === 'string' ? row.application_name : '';
    return { pid: Number.isInteger(row?.pid) && row.pid > 0 ? row.pid : null,
      roleClass: row?.role === 'cloud_admin' ? 'PROVIDER_ADMIN' : row?.role === 'neondb_owner' ? 'OWNER' :
        row?.role === 'novalure_app' ? 'RUNTIME' : 'OTHER',
      databaseClass: ['postgres', 'neondb', crmCandidatePreservedDatabase].includes(row?.database) ? row.database : 'OTHER',
      state: knownStates.has(row?.state) ? row.state : 'UNKNOWN',
      backendType: row?.backend_type === 'client backend' ? 'CLIENT_BACKEND' : 'OTHER',
      application: providerMonitors.has(app) || app === 'crm-candidate-original-qa-bootstrap' ? app : 'OTHER',
      applicationSha256: sha256(app), applicationBytes: Buffer.byteLength(app) };
  };
  const seen = new Set(rows.map(row => row?.pid));
  const missing = [...own.keys()].filter(pid => !seen.has(pid));
  const offenders = rows.filter(row => own.has(row?.pid) ? row.role !== 'neondb_owner' || row.database !== own.get(row.pid) ||
    row.backend_type !== 'client backend' : !strictProviderIdle(row));
  const error = new Error('CRM_QA_FOREIGN_SESSION');
  error.sessionGuardDiagnostic = Object.freeze({ reason, attempts, ownExpectedCount: own.size, missingOwnCount: missing.length,
    missingOwnPids: Object.freeze(missing.slice(0, 32)), observedCount: rows.length, projectedCount: Math.min(offenders.length, 32),
    sessions: Object.freeze(offenders.slice(0, 32).map(row => Object.freeze(safe(row)))) });
  safeSessionErrors.add(error);
  return error;
}

/** All retries are metadata reads; successful return still requires the original strict-idle condition. */
export async function assertCrmCandidateSessions({ readSessions, own, wait = pause }) {
  check(own instanceof Map && own.size > 0 && [...own].every(([pid, database]) => Number.isInteger(pid) && pid > 0 &&
    ['postgres', 'neondb', crmCandidatePreservedDatabase].includes(database)), 'CRM_QA_SESSION_EXPECTATION_INVALID');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const rows = await readSessions();
    if (!Array.isArray(rows) || rows.some(row => !Number.isInteger(row?.pid) || row.pid <= 0) ||
      new Set(rows.map(row => row.pid)).size !== rows.length) throw sessionFailure('INVALID_SESSION_INVENTORY', [], own, attempt);
    const seen = new Set(rows.map(row => row.pid));
    if ([...own.keys()].some(pid => !seen.has(pid))) throw sessionFailure('MISSING_OWN_PID', rows, own, attempt);
    if (rows.some(row => own.has(row.pid) && (row.role !== 'neondb_owner' || row.database !== own.get(row.pid) ||
      row.backend_type !== 'client backend'))) throw sessionFailure('MISMATCHED_OWN_IDENTITY', rows, own, attempt);
    const rejected = rows.filter(row => !own.has(row.pid) && !strictProviderIdle(row));
    if (rejected.length === 0) return { attempts: attempt };
    const knownBusyOnly = rejected.every(row => row.role === 'cloud_admin' && row.database === 'postgres' &&
      row.backend_type === 'client backend' && providerMonitors.has(row.application_name) && row.state === 'active');
    if (!knownBusyOnly) throw sessionFailure('UNRECOGNIZED_FOREIGN_SESSION', rows, own, attempt);
    if (attempt === 5) throw sessionFailure('PROVIDER_NOT_QUIESCENT_TIMEOUT', rows, own, attempt);
    await wait(100);
  }
}

function assertReservedTokenRole(roles, memberships) {
  const token = roles.filter(row => row.name === 'token_roles');
  // Neon documents this reserved role. Recognition grants nothing and never modifies it.
  // https://neon.com/docs/manage/roles#reserved-role-names
  check(token.length <= 1 && token.every(row => ['login', 'superuser', 'bypassrls', 'create_database', 'create_role', 'replication']
    .every(flag => row[flag] === false)) && Array.isArray(memberships) &&
    memberships.every(row => row.parent !== 'token_roles' && row.member !== 'token_roles' && row.grantor !== 'token_roles'),
  'CRM_QA_RESERVED_TOKEN_ROLE_UNSAFE');
}

export function assertCrmCandidateProviderRoles(roles, memberships) {
  check(Array.isArray(roles) && roles.length >= 3 && new Set(roles.map(row => row.name)).size === roles.length &&
    roles.every(row => providerRoleNames.has(row.name)) && roles.some(row => row.name === 'cloud_admin') &&
    roles.some(row => row.name === 'neon_superuser') &&
    roles.some(row => row.name === 'neondb_owner' && row.login && !row.superuser && row.create_database && row.create_role),
  'CRM_QA_FRESH_PROVIDER_ROLES');
  assertReservedTokenRole(roles, memberships);
  return roles;
}

async function assertProviderBaseline(client, baseline) {
  check(baseline && digest(baseline.roles) === baseline.sha256, 'CRM_QA_PROVIDER_BASELINE_REQUIRED');
  const roles = (await client.query(crmCandidateQueries.providerRoles)).rows;
  assertReservedTokenRole(roles, (await client.query(catalogQueries.memberships)).rows);
  const provider = roles.filter(row => providerRoleNames.has(row.name));
  check(provider.length === baseline.roles.length && digest(provider) === baseline.sha256, 'CRM_QA_PROVIDER_BASELINE_CHANGED');
}

export async function crmCandidateTransaction(client, action) {
  await client.query('begin');
  try { const result = await action(); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback'); throw error; }
}

async function snapshot(client) {
  const database = await captureDatabaseMetadata(client), extensions = await captureExtensionMetadata(client);
  return { database, extensions, sha256: digest({ database: database.sha256, extensions: extensions.sha256 }) };
}

export async function assertCrmCandidateBlankDatabase(client) {
  const empty = (await client.query(crmCandidateQueries.empty)).rows[0];
  check(empty && Object.keys(empty).sort().join(',') === 'functions,global_objects,relations,settings,types' &&
    Object.values(empty).every(value => value === 0), 'CRM_QA_DATABASE_NOT_BLANK');
  return empty;
}

function clientsFor(connect, descriptor) {
  const clients = new Map();
  return {
    clients,
    async open(database) {
      check(['postgres', 'neondb', crmCandidatePreservedDatabase].includes(database), 'CRM_QA_DATABASE_NOT_ALLOWED');
      const client = await connect(database); clients.set(client, { database, pid: null });
      const identity = (await client.query(prepareTargetQueries.identity)).rows[0];
      check(identity?.project === descriptor.projectId && identity.branch === descriptor.branchId &&
        identity.database === database && identity.role === 'neondb_owner' && identity.session_role === 'neondb_owner' &&
        identity.server_version_num >= 170000 && identity.can_create_database === true &&
        (database === 'postgres' || identity.database_owner === 'neondb_owner') &&
        Number.isInteger(identity.database_oid) && Number.isInteger(identity.pid), 'CRM_QA_NATIVE_IDENTITY');
      clients.set(client, { database, pid: identity.pid }); return { client, identity };
    },
    async close(client) { await client.end(); clients.delete(client); },
    async closeAll() {
      const closed = await Promise.allSettled([...clients.keys()].map(client => client.end()));
      check(closed.every(result => result.status === 'fulfilled'), 'CRM_QA_CONNECTION_CLEANUP_UNCONFIRMED');
      clients.clear();
    },
  };
}

async function clusterGuard(context, control, expectedNames, providerRoles, application = []) {
  const databases = (await control.query(prepareTargetQueries.databases)).rows;
  check(databases.map(row => row.name).join(',') === [...expectedNames].sort().join(',') &&
    databases.filter(row => ['neondb', crmCandidatePreservedDatabase].includes(row.name))
      .every(row => row.owner === 'neondb_owner' && row.is_template === false), 'CRM_QA_DATABASE_INVENTORY');
  const roles = (await control.query(crmCandidateQueries.providerRoles)).rows;
  assertReservedTokenRole(roles, (await control.query(catalogQueries.memberships)).rows);
  check(roles.filter(row => providerRoleNames.has(row.name)).length === providerRoles.length &&
    digest(roles.filter(row => providerRoleNames.has(row.name))) === digest(providerRoles) &&
    roles.every(row => providerRoleNames.has(row.name) || application.includes(row.name)) &&
    application.every(name => roles.some(row => row.name === name)), 'CRM_QA_ROLE_INVENTORY');
  const own = new Map([...context.clients.values()].map(row => [row.pid, row.database]));
  let observations = 0;
  await assertCrmCandidateSessions({ own, readSessions: async () => {
    if (observations++ > 0) {
      check(digest((await control.query(prepareTargetQueries.databases)).rows) === digest(databases), 'CRM_QA_DATABASE_INVENTORY_CHANGED_WHILE_WAITING');
      check(digest((await control.query(crmCandidateQueries.providerRoles)).rows) === digest(roles), 'CRM_QA_ROLE_INVENTORY_CHANGED_WHILE_WAITING');
      assertReservedTokenRole(roles, (await control.query(catalogQueries.memberships)).rows);
    }
    await control.query('select pg_stat_clear_snapshot()');
    return (await control.query(crmCandidateQueries.sessions)).rows;
  } });
  check((await control.query(prepareTargetQueries.prepared)).rows[0]?.count === 0, 'CRM_QA_PREPARED_TRANSACTION');
  return databases;
}

async function capture(context, descriptor, descriptorDigest, manifest, headCommit, now) {
  const { client: control } = await context.open('postgres');
  const roles = (await control.query(crmCandidateQueries.providerRoles)).rows;
  const memberships = (await control.query(catalogQueries.memberships)).rows;
  assertCrmCandidateProviderRoles(roles, memberships);
  const databases = await clusterGuard(context, control, ['neondb', 'postgres', 'template0', 'template1'], roles);
  const selected = await context.open('neondb');
  await selected.client.query('begin isolation level repeatable read read only');
  let baseline;
  try {
    await assertCrmCandidateBlankDatabase(selected.client);
    baseline = await snapshot(selected.client);
    await selected.client.query('rollback');
  } catch (error) { await selected.client.query('rollback'); throw error; }
  check(digest((await control.query(catalogQueries.memberships)).rows) === digest(memberships), 'CRM_QA_PROVIDER_MEMBERSHIP_DRIFT');
  await clusterGuard(context, control, ['neondb', 'postgres', 'template0', 'template1'], roles);
  await context.close(selected.client);
  const bound = { headCommit, descriptorDigest, target: crmCandidateTarget(descriptor), manifestDigest: manifest.sha256,
    providerRoles: roles, memberships, databases, baseline, originalDatabaseOid: selected.identity.database_oid,
    executed061Sha256: renderNeon061Compatibility(manifest.early.find(row => row.number === 61).content).executedSqlChecksum };
  return { format: 'crm-candidate-fresh-plan-v1', capturedAt: new Date(now).toISOString(), bound, sha256: digest(bound) };
}

export async function captureCrmCandidateFreshPlan({ connect, descriptor, descriptorDigest, manifest, headCommit, now = Date.now() }) {
  validateCrmCandidateDescriptor(descriptor, { expectedDigest: descriptorDigest, headCommit, now });
  const context = clientsFor(connect, descriptor);
  try { return await capture(context, descriptor, descriptorDigest, manifest, headCommit, now); }
  finally { await context.closeAll(); }
}

async function runtimePosture(client, tenantExists) {
  const rows = (await client.query(crmCandidateQueries.runtime)).rows;
  check(rows.length === (tenantExists ? 2 : 1) && rows.every(row =>
    !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole && !row.rolreplication && !row.rolbypassrls &&
    row.nonowner && row.no_ddl && (row.rolname === 'novalure_app' ? row.rolcanlogin && row.rolinherit :
      row.rolname === 'novalure_tenant_app' && !row.rolcanlogin && !row.rolinherit)), 'CRM_QA_UNSAFE_RUNTIME');
}

export async function assertCrmCandidateFresh062(client) {
  check((await client.query("select count(*)::int n from public.novalure_schema_migrations where version ~ '^0*(60|61)(_|$)'")).rows[0]?.n === 0,
    'CRM_QA_062_RLS_ALREADY_INSTALLED');
  check((await client.query("select count(*)::int n from pg_trigger where tgname='audit_logs_append_only_guard' and not tgisinternal")).rows[0]?.n === 0,
    'CRM_QA_062_AUDIT_ALREADY_PROTECTED');
  for (const table of ['media_assets', 'media_asset_shares', 'bot_document_sends']) {
    check((await client.query('select count(*)::int n from public.' + table)).rows[0]?.n === 0, 'CRM_QA_062_MEDIA_NOT_EMPTY');
  }
  const row = (await client.query(`select count(*)::int total,count(*) filter(where
    workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' and actor_user_id is null and action='workspace.seeded'
    and entity_type='workspace' and entity_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' and before is null
    and after='{"migration":"030_novalure_growth_workspace","workspace":"Novalure Growth","profiles":["novalureGrowth","novalureServiceOps","novalureAdmin"]}'::jsonb)::int expected
    from public.audit_logs`)).rows[0];
  check(row?.total === 1 && row.expected === 1, 'CRM_QA_062_ORIGINAL_SEED_MISMATCH');
}

export function assertCrmCandidateLedger(rows, expected) {
  check(Array.isArray(rows) && rows.length === expected.length && new Set(rows.map(row => row.version)).size === expected.length && rows.every(row => expected.some(migration =>
    row.version === migration.version && row.checksum === migration.checksum && row.name === migration.name)), 'CRM_QA_EXACT_LEDGER_MISMATCH');
  return { rows: rows.length, sha256: digest(rows) };
}

/** One fresh early bootstrap only. No repair, resume, donor data or cloud provisioning. */
export async function runCrmCandidateFreshEarly({ connect, descriptor, descriptorDigest, manifest, headCommit, plan,
  runtimePassword, journal, now = Date.now() }) {
  validateCrmCandidatePlan(plan, { descriptor, descriptorDigest, manifest, headCommit, now });
  check(/^[a-f0-9]{80}$/.test(runtimePassword || ''), 'CRM_QA_PRIVATE_RANDOM_RUNTIME_PASSWORD_REQUIRED');
  const context = clientsFor(connect, descriptor);
  const applied = [], operations = [];
  let phase = 'FRESH_PLAN_RECHECK';
  const record = async (event, metadata = {}) => journal({ at: new Date().toISOString(), event, phase, ...metadata });
  const effect = async (name, action) => {
    phase = name; await record('INTENT'); const result = await action(); operations.push(name); await record('ACKNOWLEDGED'); return result;
  };
  try {
    // Acquire the same management-database lock before the complete immutable re-read.
    const lock = await context.open('postgres');
    check((await lock.client.query('select pg_try_advisory_lock(94130485) acquired')).rows[0]?.acquired === true, 'CRM_QA_BOOTSTRAP_BUSY');
    const current = await capture(context, descriptor, descriptorDigest, manifest, headCommit, Date.now());
    check(current.sha256 === plan.sha256 && digest(current.bound) === digest(plan.bound), 'CRM_QA_REVIEWED_PLAN_DRIFT');
    const control = lock.client, roles = current.bound.providerRoles;
    const original = await context.open('neondb');
    await context.close(original.client);
    await effect('PRESERVE_INITIAL_PROVIDER_DATABASE', () => control.query('alter database neondb rename to ' + crmCandidatePreservedDatabase));
    const preserved = await context.open(crmCandidatePreservedDatabase);
    check(preserved.identity.database_oid === current.bound.originalDatabaseOid &&
      (await snapshot(preserved.client)).sha256 === current.bound.baseline.sha256, 'CRM_QA_PRESERVED_BASELINE_CHANGED');
    await context.close(preserved.client);
    await effect('CREATE_PRISTINE_NEONDB', () => control.query('create database neondb with template template0 owner neondb_owner'));
    const fresh = await context.open('neondb');
    check(fresh.identity.database_oid !== current.bound.originalDatabaseOid, 'CRM_QA_NEW_DATABASE_OID_REQUIRED');
    await assertCrmCandidateBlankDatabase(fresh.client);
    check(
      (await fresh.client.query('select count(*)::int n from pg_default_acl')).rows[0]?.n === 0 &&
      (await fresh.client.query("select extname from pg_extension order by extname")).rows.map(row => row.extname).join(',') === 'plpgsql',
    'CRM_QA_TEMPLATE0_DATABASE_NOT_PRISTINE');
    await effect('CREATE_RESTRICTED_RUNTIME', () => crmCandidateTransaction(fresh.client, async () => {
      await fresh.client.query("create role novalure_app login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '" + runtimePassword + "'");
      await runtimePosture(fresh.client, false);
    }));
    const names = ['neondb', 'postgres', 'template0', 'template1', crmCandidatePreservedDatabase];
    for (const migration of manifest.early) {
      phase = 'GUARD_BEFORE_ORIGINAL_' + migration.version;
      await clusterGuard(context, control, names, roles,
        ['novalure_app', ...(applied.some(row => row.number === 60) ? ['novalure_tenant_app'] : [])]);
      const receipt = await effect('ORIGINAL_' + migration.version, () => crmCandidateTransaction(fresh.client, async () => {
        await fresh.client.query('set local search_path=public');
        if (migration.number === 62) await assertCrmCandidateFresh062(fresh.client);
        let receipt061;
        if (migration.number === 61) {
          await runtimePosture(fresh.client, true);
          await fresh.client.query('grant novalure_tenant_app to novalure_app with admin false,inherit true,set false');
          await fresh.client.query("comment on role novalure_tenant_app is 'novalure-tenant-cutover:crm-candidate-" + headCommit + "'");
          receipt061 = await applyCrmCandidate061Compatibility({ client: fresh.client, sql: migration.content,
            target: crmCandidateTarget(descriptor), descriptor, descriptorSha256: descriptorDigest,
            executionContext: { headCommit, planDigest: current.sha256 } });
        } else await fresh.client.query(migration.content);
        if (migration.number >= 41) await fresh.client.query('insert into public.novalure_schema_migrations(version,name,checksum) values($1,$2,$3)',
          [migration.version, migration.name, migration.checksum]);
        return receipt061;
      }));
      applied.push({ number: migration.number, version: migration.version, sourceChecksum: migration.checksum,
        execution: receipt ? 'NEW_NATIVE_061_COMPATIBILITY_RECEIPT' : 'UNCHANGED_ORIGINAL_SQL', ...(receipt ? { receipt061: receipt } : {}) });
      await record('MIGRATION_COMMITTED', applied.at(-1));
    }
    phase = 'GUARD_FINAL_EARLY_SCHEMA';
    await runtimePosture(fresh.client, true);
    const ledger = assertCrmCandidateLedger((await fresh.client.query(crmCandidateQueries.ledger)).rows,
      manifest.early.filter(row => row.number >= 41));
    const receipts = (await fresh.client.query('select source_checksum,executed_sql_checksum,profile_id,target from public.novalure_migration_execution_receipts')).rows;
    check(receipts.length === 1 && receipts[0].source_checksum === manifest.early.find(row => row.number === 61).checksum &&
      receipts[0].executed_sql_checksum === current.bound.executed061Sha256 &&
      receipts[0].profile_id === 'crm-candidate-fresh:neon-provider-creator-admin-only-061-v1' &&
      digest(receipts[0].target) === digest(crmCandidateTarget(descriptor)), 'CRM_QA_NEW_061_RECEIPT_MISMATCH');
    const retained = await context.open(crmCandidatePreservedDatabase);
    check(retained.identity.database_oid === current.bound.originalDatabaseOid &&
      (await snapshot(retained.client)).sha256 === current.bound.baseline.sha256, 'CRM_QA_PRESERVED_BASELINE_CHANGED');
    await clusterGuard(context, control, names, roles, ['novalure_app', 'novalure_tenant_app']);
    const result = { status: 'PASS_NEW_NATIVE_EARLY_SCHEMA_THROUGH_085', headCommit, descriptorDigest,
      manifestDigest: manifest.sha256, planDigest: plan.sha256, applied, ledger,
      providerRoleBaseline: { roles, sha256: digest(roles) },
      providerBaselineUnchanged: true, productionAccess: 0, sourceRestoreClaimed: false, historicalLedgerCopied: false };
    await record('EARLY_COMPLETE', { status: result.status, ledger, appliedCount: applied.length }); return result;
  } catch (error) {
    await record('HELD_REQUIRES_READ_ONLY_RECONCILIATION', { operationsAcknowledged: operations,
      code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message || '') ? error.message : 'CRM_QA_NATIVE_STEP_UNCONFIRMED',
      ...(safeSessionErrors.has(error) ? { sessionGuard: error.sessionGuardDiagnostic } : {}),
      ...(typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? { sqlState: error.code } : {}) });
    throw error;
  } finally { await context.closeAll(); }
}

/** Existing official runner owns every086+ ledger row;087 stages have separate truthful receipts. */
export async function completeCrmCandidateFreshSchema({ client, manifest, earlyResult, runOfficial, journal }) {
  check(earlyResult?.status === 'PASS_NEW_NATIVE_EARLY_SCHEMA_THROUGH_085' &&
    earlyResult.headCommit === manifest.headCommit && earlyResult.manifestDigest === manifest.sha256,
  'CRM_QA_EARLY_RECEIPT_REQUIRED');
  assertCrmCandidateLedger((await client.query(crmCandidateQueries.ledger)).rows, manifest.early.filter(row => row.number >= 41));
  await assertProviderBaseline(client, earlyResult.providerRoleBaseline);
  const stages = [];
  for (const migration of manifest.explicit) {
    await assertProviderBaseline(client, earlyResult.providerRoleBaseline);
    await journal({ event: 'OFFICIAL_RUNNER_INTENT', version: migration.version, checksum: migration.checksum, manual: migration.manual });
    await runOfficial(migration);
    await assertProviderBaseline(client, earlyResult.providerRoleBaseline);
    assertCrmCandidateLedger((await client.query(crmCandidateQueries.ledger)).rows,
      manifest.selected.filter(row => row.number >= 41 && (row.number < migration.number ||
        (row.number === migration.number && row.version.localeCompare(migration.version) <= 0))));
    await journal({ event: 'OFFICIAL_RUNNER_COMMIT_CONFIRMED', version: migration.version, checksum: migration.checksum });
    if (migration.number === 87) {
      const [backfill, contract] = manifest.staged087;
      await journal({ event: 'STAGED_087_INTENT', paths: manifest.staged087.map(row => ({ path: row.path, checksum: row.checksum })) });
      let remaining;
      for (let count = 0; count < 100; count++) {
        remaining = (await client.query(backfill.content)).rows[0]?.crm_d11_backfill_batch?.remaining;
        check(remaining && Object.values(remaining).every(value => Number.isSafeInteger(Number(value)) && Number(value) >= 0),
          'CRM_QA_087_BACKFILL_RESPONSE');
        if (Object.values(remaining).every(value => Number(value) === 0)) break;
      }
      check(remaining && Object.values(remaining).every(value => Number(value) === 0), 'CRM_QA_087_BACKFILL_NOT_COMPLETE');
      await crmCandidateTransaction(client, () => client.query(contract.content));
      stages.push(...[backfill, contract].map(row => ({ path: row.path, checksum: row.checksum, execution: 'ACKNOWLEDGED_ORIGINAL_SQL', ledgerRow: false })));
      await journal({ event: 'STAGED_087_CONFIRMED', stages });
    }
  }
  await journal({ event: 'OFFICIAL_STANDARD_PENDING_INTENT', versions: manifest.standard.map(row => row.version) });
  await assertProviderBaseline(client, earlyResult.providerRoleBaseline);
  await runOfficial(null);
  await assertProviderBaseline(client, earlyResult.providerRoleBaseline);
  const ledger = assertCrmCandidateLedger((await client.query(crmCandidateQueries.ledger)).rows, manifest.selected.filter(row => row.number >= 41));
  check(ledger.rows === manifest.coverage.expectedCanonicalLedgerRows && stages.length === 2, 'CRM_QA_FULL_SOURCE_COVERAGE');
  const sourceInventorySqlFiles = manifest.forward.length, forwardSqlFiles = manifest.selected.length;
  await journal({ event: 'COMPLETE_SCHEMA_VERIFIED', ledger, sourceInventorySqlFiles, forwardSqlFiles,
    sourceExtensionSha256: manifest.sourceExtensionSha256, executionVariant: manifest.executionVariant, excluded: manifest.excluded, staged087: stages });
  return { status: 'PASS_NEW_NATIVE_STANDALONE_SCHEMA_209', ledger, sourceInventorySqlFiles, forwardSqlFiles,
    sourceExtensionSha256: manifest.sourceExtensionSha256, executionVariant: manifest.executionVariant, excluded: manifest.excluded,
    historicalExecutions: manifest.coverage.historicalExecutionsBeforeLedger, staged087: stages,
    applicationAcceptance: 'PENDING_EXISTING_MANUAL_QA', productionReadiness: false };
}

// The actual official transaction/ledger implementation is exposed for scoped callers and native tests.
export { applyMigration as applyCrmCandidateOriginalMigration };
