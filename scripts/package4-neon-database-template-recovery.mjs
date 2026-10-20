#!/usr/bin/env node
/** Actual same-branch PostgreSQL database checkpoint/recovery; source is read-only.
 * No branch ACL repair, down-migration, existing-database replacement or DROP.
 * This is neither native dump/restore nor independent/off-provider disaster recovery.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from '@neondatabase/serverless';
import { configurePackage4NeonTransport } from './package4-neon-bootstrap.mjs';
import { snapshotPackage4RecoveryDatabase, preparePackage4RecoveryDirectory } from './package4-neon-restore.mjs';
import { canonical, captureDatabaseMetadata } from './lib/studio-stage3-qa-fingerprint.mjs';
import { getRolePermissions } from '../src/lib/auth/permissions.ts';
import { getProductRoleCapabilities } from '../src/lib/product-model.ts';
import { withCrmRead } from '../src/lib/crm-command.ts';
import { loadKnowledgeCenter } from '../src/lib/knowledge-center/repository.ts';
import { readBotChannelHistory, readCalendarConnectionStatuses } from '../src/lib/db/crm-operational-readers.ts';

assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'Committed clean tooling required before actual remote recovery');
const directory = path.resolve(process.argv[2]);
const run = process.argv[3] ?? 'r1'; assert.match(run, /^r[1-3]$/);
const originalOwner = new URL((await readFile(path.join(directory, 'admin-url.txt'), 'utf8')).trim());
const originalRuntime = new URL((await readFile(path.join(directory, 'runtime-url.txt'), 'utf8')).trim());
const fixture = JSON.parse(await readFile(path.join(directory, 'hosted-target.json'), 'utf8'));
assert.equal(originalOwner.hostname, 'ep-steep-shadow-bapfxomh.c-8.eu-central-1.aws.neon.tech');
assert.equal(originalOwner.pathname, '/neondb'); assert.equal(decodeURIComponent(originalOwner.username), 'neondb_owner');
assert.equal(originalRuntime.hostname, originalOwner.hostname); assert.equal(decodeURIComponent(originalRuntime.username), 'novalure_app');
assert.equal(originalRuntime.pathname, '/neondb');
const target = { projectId: 'green-thunder-49879900', branchId: 'br-shiny-darkness-baz4524v', host: originalOwner.hostname,
  owner: 'neondb_owner', syntheticOnly: true, newIsolatedResource: true, workspaceIds: fixture.allWorkspaceIds };
const names = { source: 'neondb', checkpoint: 'package4_checkpoint_20261020_' + run, working: 'package4_working_20261020_' + run, restored: 'package4_restore_20261020_' + run };
const identifier = value => { assert.match(value, /^[a-z][a-z0-9_]{0,62}$/); return '"' + value + '"'; };
configurePackage4NeonTransport();
const makePool = (database, runtime = false) => {
  const url = new URL(runtime ? originalRuntime : originalOwner); url.pathname = '/' + database;
  return new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 20_000,
    application_name: 'package4_template_' + run + '_' + database });
};
const control = makePool('postgres');
const beforeTime = performance.now();
const artifact = path.join(directory, 'database-template-recovery-' + run);
await preparePackage4RecoveryDirectory(artifact);
const evidence = { format: 'package4-neon-database-template-recovery-v1', scope: 'DATABASE_ONLY', status: 'RUNNING',
  implementationRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), target,
  method: 'Committed PostgreSQL CREATE DATABASE TEMPLATE checkpoint, changed working database, new restored database',
  startedAt: new Date().toISOString(), productionAccess: 0, sourceWrites: 0, existingDatabasesOverwritten: 0,
  nativeDumpRestore: false, createdDatabases: [], copyAttempts: [], sessionObservations: [], run, providerAclChanges: 0,
  privateFiles: { status: 'NOT TESTED', prerequisiteStatus: 'BLOCKED', reason: 'Private Vercel Blob access was HTTP403; private object bytes not archived or restored' },
  completeDatabaseAndPrivateFileRecovery: 'BLOCKED',
  limitations: ['Same isolated Neon branch and compute; global roles already exist. No independent archive, cross-cluster, point-in-time or production DR claim.',
    'Only database state and ordinary application data-layer compatibility are tested. Hosted login/MFA and private-file bytes are separate gates.',
    'Three bounded synthetic databases are retained for review; no automatic cleanup or measured production recovery SLA is claimed.'] };
const save = () => writeFile(path.join(directory, 'database-template-recovery-result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
async function snapshot(database, suffix) {
  const pool = makePool(database), client = await pool.connect();
  try {
    evidence.sessionObservations.push({ database, snapshot: suffix, ...(await client.query('select pid,usename,application_name,backend_start from pg_stat_activity where pid=pg_backend_pid()')).rows[0] });
    const result = await snapshotPackage4RecoveryDatabase(client, { ...target, databaseName: database });
    // PostgreSQL does not copy database-level ACLs/settings from TEMPLATE.
    // Include them in strict equality instead of assuming a successful copy.
    result.publicStateSha256 = result.sha256;
    result.databaseMetadata = await captureDatabaseMetadata(client);
    result.sha256 = createHash('sha256').update(canonical({ publicStateSha256: result.publicStateSha256, databaseMetadata: result.databaseMetadata })).digest('hex');
    await writeFile(path.join(artifact, suffix + '.private.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return result;
  } finally { client.release(); await pool.end(); }
}
const account = fixture.accounts.customerA;
const session = { authenticated: true, source: 'database', userId: account.userId, workspaceId: account.workspaceId,
  workspaceName: account.workspaceName, email: account.email, name: account.name, role: account.role, productRole: account.productRole,
  permissions: getRolePermissions(account.role), productPermissions: getProductRoleCapabilities(account.productRole) };
async function create(database, template) {
  // PostgreSQL requires a quiescent template. Never terminate another session or
  // force a copy; the caller keeps source browser writes paused for this drill.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // pool.end() may finish before the remote backend disappears. Require two
    // consecutive empty observations, then retry only PostgreSQL's transient
    // source-in-use failure. Never terminate a backend or overwrite a database.
    for (let observation = 0; observation < 2; observation += 1) {
      const active = (await control.query('select pid,usename,state,application_name from pg_stat_activity where datname=$1', [template])).rows;
      assert.equal(active.length, 0, 'Template must have no connected sessions: ' + template);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal((await control.query('select count(*)::int as count from pg_database where datname=$1', [database])).rows[0].count, 0, 'New unused copy database required');
    try {
      await control.query('create database ' + identifier(database) + ' with template ' + identifier(template) + ' owner neondb_owner');
      evidence.copyAttempts.push({ database, template, attempt, status: 'COMMITTED' }); break;
    } catch (error) {
      evidence.copyAttempts.push({ database, template, attempt, status: 'FAIL', code: error.code, message: error.message }); await save();
      if (error.code !== '55006' || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  evidence.createdDatabases.push({ database, template, committedAt: new Date().toISOString() }); await save();
}
await save();
try {
  assert.deepEqual((await control.query("select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role")).rows[0],
    { project: target.projectId, branch: target.branchId, database: 'postgres', role: 'neondb_owner' });
  assert.equal((await control.query('select count(*)::int as count from pg_database where datname=any($1::text[])', [[names.checkpoint, names.working, names.restored]])).rows[0].count, 0, 'Three new run-owned database names required');
  const sizes = (await control.query("select sum(pg_database_size(datname))::text as total,(select pg_database_size('neondb'))::text as source from pg_database where not datistemplate")).rows[0];
  assert.ok(Number(sizes.total) + 3 * Number(sizes.source) <= 400 * 1024 * 1024, 'Conservative free-project storage bound exceeded');
  evidence.storageSizeGuard = { currentDatabaseBytes: Number(sizes.total), eachCopyBytes: Number(sizes.source), projectedDatabaseBytes: Number(sizes.total) + 3 * Number(sizes.source), maximumProjectedBytes: 400 * 1024 * 1024 };
  const before = await snapshot(names.source, 'source-before');
  await create(names.checkpoint, names.source);
  const point = await snapshot(names.checkpoint, 'checkpoint');
  assert.equal(point.sha256, before.sha256, 'Checkpoint must exactly preserve all schema/ACL/RLS/ledger/sequence/data categories');
  await create(names.working, names.checkpoint);
  assert.equal((await snapshot(names.working, 'working-before')).sha256, before.sha256, 'Working copy must exactly equal checkpoint');
  const workingRuntime = makePool(names.working, true);
  try {
    const changed = await withCrmRead(session, tx => tx.query('update tasks set title=$2 where id=$1 returning id', [fixture.recoveryTaskId, 'SYNTHETIC committed post-checkpoint working change']), { pool: workingRuntime });
    assert.equal(changed.length, 1); evidence.workingCommittedRows = changed.length;
  } finally { await workingRuntime.end(); }
  const changed = await snapshot(names.working, 'working-after');
  assert.notEqual(changed.sha256, before.sha256, 'Committed synthetic change must be observable before recovery');
  await create(names.restored, names.checkpoint);
  const restored = await snapshot(names.restored, 'restored');
  assert.equal(restored.sha256, before.sha256, 'Restored database must exactly equal the complete original checkpoint');
  const runtime = makePool(names.restored, true);
  try {
    const role = (await runtime.query("select current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
    assert.deepEqual(role, { role: 'novalure_app', rolsuper: false, rolbypassrls: false });
    assert.equal((await runtime.query("select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relowner=(select oid from pg_roles where rolname=current_user)")).rows[0].count, 0, 'Ordinary runtime must own no public relation');
    const options = { pool: runtime };
    const task = await withCrmRead(session, tx => tx.queryOne('select title from tasks where id=$1', [fixture.recoveryTaskId]), options);
    assert.equal(task?.title, fixture.recoveryFixture.title);
    assert.equal((await loadKnowledgeCenter(session, options)).available, true);
    assert.equal((await readBotChannelHistory(session, {}, options)).source, 'database');
    assert.equal((await readCalendarConnectionStatuses(session, options)).source, 'database');
    const foreign = await withCrmRead(session, tx => tx.query('select id from projects where workspace_id=$1', [fixture.accounts.customerB.workspaceId]), options);
    assert.equal(foreign.length, 0);
    evidence.application = { status: 'PASS', databaseRole: role.role, superuser: false, bypassRls: false,
      checks: ['Checkpoint task value restored', 'Knowledge application repository reads restored contract', 'Migration106 operational readers work', 'Foreign tenant rows remain denied'] };
  } finally { await runtime.end(); }
  assert.equal((await snapshot(names.source, 'source-after')).sha256, before.sha256, 'Source must remain unchanged throughout recovery');
  evidence.status = 'PASS'; evidence.completedAt = new Date().toISOString(); evidence.elapsedMs = Math.round(performance.now() - beforeTime);
  evidence.recoveryPoint = { database: names.checkpoint, committedAt: evidence.createdDatabases[0].committedAt, completeStateSha256: before.sha256 };
  evidence.restored = { database: names.restored, completeStateSha256: restored.sha256, ledgerRows: restored.ledger.length,
    dataTables: restored.data.length, dataRows: restored.data.reduce((sum, table) => sum + table.rows, 0), vector: restored.catalog.extensions.find(extension => extension.extname === 'vector') };
  await save(); console.log(JSON.stringify({ status: evidence.status, elapsedMs: evidence.elapsedMs, createdDatabases: evidence.createdDatabases.map(item => item.database), privateFiles: evidence.privateFiles.status }));
} catch (error) {
  evidence.status = 'FAIL'; evidence.elapsedMs = Math.round(performance.now() - beforeTime);
  evidence.failure = { code: error.code ?? null, message: String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[REDACTED]') };
  await save(); throw error;
} finally { await control.end(); }
