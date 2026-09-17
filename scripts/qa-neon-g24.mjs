#!/usr/bin/env node
/** G24: explicit fresh QA rebuild only; never the general production migration runner. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { getCACertificates } from 'node:tls';
import { assertRepositoryCommitted } from './db-migrate.mjs';
import { applyNeon061Compatibility, renderNeon061Compatibility, neon061ProfileId } from './lib/neon-061-compat.mjs';
import { seedG24Fixture, verifyG24Security, snapshotG24 } from './lib/g24-qa-verification.mjs';

const project = 'weathered-term-98273025';
const branch = 'br-spring-snow-alupo8u4';
const sourceName = 'qa_g24_pr63_20260917';
const restoreName = 'qa_g24_restore_20260917';
const runtimeRole = 'g24_qa_20260917';
const root = path.resolve('.npm-cache/qa/g24');
const digest = value => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const configPath = process.argv[2];
if (!configPath) throw new Error('Explicit ignored private QA config path required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
assert.deepEqual([config.projectId, config.branchId, config.databaseName, config.restoreDatabaseName, config.runtimeRole], [project, branch, sourceName, restoreName, runtimeRole]);
const url = new URL(config.adminUrl);
assert.equal(url.username, 'neondb_owner');
assert.equal(url.pathname, '/neondb');
assert.ok(url.hostname.endsWith('.neon.tech') && !url.hostname.includes('-pooler.'));
const headCommit = assertRepositoryCommitted();
const manifest = [];
for (const name of (await readdir('migrations')).filter(name => /^\d{3}_.+\.sql$/.test(name) && !name.includes('_rollback')).sort()) {
  assert.ok(Number(name.slice(0, 3)) <= 85, 'Review new migrations before extending this explicit QA profile');
  const content = await readFile(path.join('migrations', name), 'utf8');
  const committed = execFileSync('git', ['show', 'HEAD:migrations/' + name], { encoding: 'utf8' });
  assert.equal(digest(content), digest(committed));
  manifest.push({ name, content, checksum: digest(content), version: name.replace(/\.sql$/, '') });
}
assert.equal(manifest.find(m => m.name.startsWith('061_')).checksum, '0fdd95faee430de5b6e1ea0d22d477099ff151c5583476bdb542b6e00dcb5d23');
// 062 depends on 051, not 060. On a new empty DB execute it before the audit trigger.
const media = manifest.find(m => m.name.startsWith('062_'));
const plan = manifest.filter(m => m !== media);
plan.splice(plan.findIndex(m => m.name.startsWith('060_')), 0, media);
const compatibilityPlan = renderNeon061Compatibility(manifest.find(m => m.name.startsWith('061_')).content);
const planDigest = digest(JSON.stringify({ profileId: neon061ProfileId, executed061Checksum: compatibilityPlan.executedSqlChecksum, headCommit, project, branch, sourceName, restoreName, plan: plan.map(({ name, checksum }) => ({ name, checksum })) }));
await mkdir(root, { recursive: true });
const trustedCaPath = path.join(root, 'trusted-ca.pem');
await writeFile(trustedCaPath, getCACertificates('default').concat(getCACertificates('system')).join('\n'));
const evidence = { format: 'novalure-g24-neon-rebuild-v1', startedAt: new Date().toISOString(), headCommit, planDigest, target: { project, branch, sourceName, restoreName, runtimeRole, branchName: config.branchName, branchCreatedAt: config.branchCreatedAt }, status: 'RUNNING', productionAccess: 0, manualDatabaseRepairs: 0, historicalSourceModified: false, applied: [], limitations: ['Fresh database inside a fresh QA branch; inherited parent database is not migrated or read for business data.', 'Native dump/restore into a second empty database on the same isolated QA branch. Global roles already exist; this is not a production DR or cross-cluster role restore.', 'This QA-specific compatibility profile does not enable production migrations or configure application connections.'] };
const save = () => writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
const makePool = (database, user = url.username, password = decodeURIComponent(url.password)) => {
  const next = new URL(url); next.pathname = '/' + database; next.username = user; next.password = password;
  return new pg.Pool({ connectionString: next.toString(), max: 3, connectionTimeoutMillis: 20000, query_timeout: 180000 });
};
async function guard(pool, database) {
  const fp = (await pool.query("select current_setting('neon.project_id',true) project,current_setting('neon.branch_id',true) branch,current_database() database,current_user role")).rows[0];
  assert.deepEqual(fp, { project, branch, database, role: 'neondb_owner' });
}
async function nativeTool(name, database, extraArgs) {
  const executable = process.env.CRM_QA_PG_BIN ? path.join(path.resolve(process.env.CRM_QA_PG_BIN), name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|comspec|pathext|lang|lc_all)$/i.test(key)));
  Object.assign(env, { PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: url.username, PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: database, PGSSLMODE: 'verify-full', PGSSLROOTCERT: trustedCaPath, PGCONNECT_TIMEOUT: '20' });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--no-password', ...extraArgs], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(name + ' exceeded remote QA timeout')); }, 180000);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(name + ' failed (' + code + '): ' + output.slice(-2500)));  });
  });
}
const management = makePool('neondb');
let admin, runtime, restored, restoredRuntime;
try {
  await guard(management, 'neondb');
  const existing = (await management.query('select datname from pg_database where datname=any($1::text[])', [[sourceName, restoreName]])).rows;
  assert.equal(existing.length, 0, 'Fresh databases required; never resume/repair/overwrite an existing database');
  assert.equal((await management.query('select 1 from pg_roles where rolname=$1', [runtimeRole])).rowCount, 0, 'Fresh runtime role required');
  // Only create this run-owned login. No ALTER or REVOKE on provider-managed roles.
  const password = randomBytes(40).toString('hex');
  await management.query(`create role ${identifier(runtimeRole)} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${password}'`);
  const group = (await management.query("select * from pg_roles where rolname='novalure_app'")).rows[0];
  assert.ok(group && !group.rolsuper && !group.rolcreatedb && !group.rolcreaterole && !group.rolreplication && !group.rolbypassrls, 'Expected safe inherited legacy application role');
  await management.query(`grant novalure_app to ${identifier(runtimeRole)} with admin false, inherit true, set false`);
  await management.query(`create database ${identifier(sourceName)} template template0`);
  admin = makePool(sourceName); runtime = makePool(sourceName, runtimeRole, password);
  await guard(admin, sourceName);
  assert.equal((await admin.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n, 0);
  await writeFile(path.join(root, 'runtime-private.json'), JSON.stringify({ runtimeRole, password }), { mode: 0o600, flag: 'wx' });
  for (const migration of plan) {
    const number = Number(migration.name.slice(0, 3));
    if (number === 62) {
      assert.equal((await admin.query("select count(*)::int n from novalure_schema_migrations where version like '060%'")).rows[0].n, 0);
      assert.equal((await admin.query("select count(*)::int n from pg_trigger where tgname='audit_logs_append_only_guard' and not tgisinternal")).rows[0].n, 0);
      for (const table of ['media_assets', 'media_asset_shares', 'bot_document_sends']) assert.equal((await admin.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, '062 fresh-empty guard: ' + table);
      // Original 030 seeds exactly one audit event. Preserve it, verify its complete business payload,
      // and prove 062's media-audit update has no affected historical rows. No audit repair is performed.
      const seed = (await admin.query(`select count(*)::int total,count(*) filter(where workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' and actor_user_id is null and action='workspace.seeded' and entity_type='workspace' and entity_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' and before is null and after='{"migration":"030_novalure_growth_workspace","workspace":"Novalure Growth","profiles":["novalureGrowth","novalureServiceOps","novalureAdmin"]}'::jsonb)::int expected from audit_logs`)).rows[0];
      assert.deepEqual(seed, { total: 1, expected: 1 }, '062 permits only unchanged original-030 seed audit event');
    }
    if (number === 61) {
      await admin.query(`grant novalure_tenant_app to ${identifier(runtimeRole)} with admin false, inherit true, set false`);
      await admin.query("comment on role novalure_tenant_app is 'novalure-tenant-cutover:g24-qa-pr63-20260917'");
    }
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local search_path=public');
      if (number === 61) evidence.compatibility061 = await applyNeon061Compatibility({ client, sql: migration.content, executionContext: { headCommit, planDigest }, target: { projectId: project, branchId: branch, databaseName: sourceName, runtimeRole } });
      else await client.query(migration.content);
      if (number >= 41) await client.query('insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)', [migration.version, migration.name, migration.checksum]);
      await client.query('commit');
      evidence.applied.push({ file: migration.name, sourceChecksum: migration.checksum, execution: number === 61 ? 'explicit-neon-061-compatibility-receipt' : 'original-sql' });
      await save(); console.log('Applied ' + migration.name);
    } catch (error) { await client.query('rollback'); throw new Error(migration.name + ': ' + error.message, { cause: error }); }
    finally { client.release(); }
  }
  assert.equal(evidence.applied.length, manifest.length);
  const ids = await seedG24Fixture(admin);
  evidence.securityBeforeRestore = await verifyG24Security({ admin, runtime, ids });
  const before = await snapshotG24(admin);
  await writeFile(path.join(root, 'schema-before.json'), JSON.stringify(before, null, 2));
  const archive = path.join(root, 'g24-full.dump');
  evidence.pgTools = { dump: (await nativeTool('pg_dump', sourceName, ['--version'])).trim(), restore: (await nativeTool('pg_restore', sourceName, ['--version'])).trim() };
  await nativeTool('pg_dump', sourceName, ['--format=custom', '--file=' + archive]);
  await management.query(`create database ${identifier(restoreName)} template template0`);
  restored = makePool(restoreName); restoredRuntime = makePool(restoreName, runtimeRole, password);
  await guard(restored, restoreName);
  assert.equal((await restored.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n, 0);
  await nativeTool('pg_restore', restoreName, ['--exit-on-error', '--single-transaction', archive]);
  const after = await snapshotG24(restored);
  await writeFile(path.join(root, 'schema-after.json'), JSON.stringify(after, null, 2));
  assert.deepEqual(after, before, 'Native restore must preserve complete schema/ACL/RLS/ledger/data signature');
  evidence.restore = { status: 'PASS', actualNativeDumpRestore: true, exactSchemaLedgerDataEquality: true, sourceHash: before.hash, restoredHash: after.hash, counts: before.counts, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex') };
  evidence.securityAfterRestore = await verifyG24Security({ admin: restored, runtime: restoredRuntime, ids });
  // Source was not rewritten by the restore or post-restore checks.
  assert.deepEqual(await snapshotG24(admin), before);
  evidence.status = 'PASS'; evidence.completedAt = new Date().toISOString(); await save();
  console.log('G24 remote rebuild, security and native restore PASS; sanitized evidence: ' + path.join(root, 'evidence.json'));
} catch (error) {
  evidence.status = 'FAIL'; evidence.failure = { message: String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[REDACTED]'), code: error.code ?? error.cause?.code ?? null }; await save();
  console.error('G24 QA failed: ' + evidence.failure.message); process.exitCode = 1;
} finally {
  await Promise.allSettled([management.end(), admin?.end(), runtime?.end(), restored?.end(), restoredRuntime?.end()]);
}
