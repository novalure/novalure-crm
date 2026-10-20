#!/usr/bin/env node
// An explicitly pinned, empty-project QA bootstrap. Importing opens no database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getCACertificates } from 'node:tls';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { assertRepositoryCommitted } from './db-migrate.mjs';
import * as neon061 from './lib/neon-061-compat.mjs';

const { applyNeon061Compatibility, renderNeon061Compatibility } = neon061;

const preservedDatabase = 'package4_provider_baseline_20261020';
const hash = value => createHash('sha256').update(value).digest('hex');
const sqlHash = value => hash(value.replace(/\r\n/g, '\n'));
const identifier = value => { assert.match(value, /^[a-z][a-z0-9_]{0,62}$/); return '"' + value + '"'; };
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16_000_000, stdio: ['ignore', 'pipe', 'ignore'] });
const canonical = value => JSON.stringify(value);

/** Neon WebSockets use the authorized HTTPS sidecar, never blocked direct5432. */
export function configurePackage4NeonTransport() {
  const require = createRequire(import.meta.url);
  const WebSocket = require('next/dist/compiled/ws');
  const { HttpsProxyAgent } = require('next/dist/compiled/https-proxy-agent');
  assert.ok(process.env.HTTPS_PROXY, 'Managed HTTPS proxy is required for this QA transport');
  const ca = [...getCACertificates('default'), ...getCACertificates('system')];
  const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
  neonConfig.webSocketConstructor = class Package4ProxyWebSocket extends WebSocket {
    constructor(address, protocols, options) { super(address, protocols, { ...options, agent, ca, rejectUnauthorized: true }); }
  };
}

export function createPackage4NeonManifest(headCommit) {
  assert.match(headCommit, /^[a-f0-9]{40}$/);
  const names = git(['ls-tree', '-r', '--name-only', headCommit, 'migrations']).trim().split(/\r?\n/)
    .filter(name => /^migrations\/\d{3}_[a-z0-9_]+\.sql$/.test(name) && !name.includes('_rollback'));
  const excluded = names.filter(name => /\/(097|098|099)_/.test(name));
  assert.equal(excluded.length, 3, 'Standalone100 requires deliberate exclusion of all three Preview predecessors');
  const plan = names.filter(name => !excluded.includes(name)).sort().map(name => {
    const sql = git(['show', headCommit + ':' + name]);
    return { path: name, file: path.basename(name), version: path.basename(name, '.sql'), number: Number(path.basename(name).slice(0, 3)), checksum: sqlHash(sql), sql };
  });
  assert.equal(plan.length, 101, 'Review an extended historical migration set before running this profile');
  assert.deepEqual(plan.filter(item => item.number === 13).map(item => item.file), ['013_analysis_bot_70_sprint.sql', '013_newsletter_suppressions.sql']);
  assert.deepEqual(plan.filter(item => item.number >= 91).map(item => item.number), [91, 92, 93, 94, 95, 96, 100, 101, 102, 103, 104, 105, 106]);
  const media = plan.splice(plan.findIndex(item => item.number === 62), 1)[0];
  plan.splice(plan.findIndex(item => item.number === 60), 0, media);
  renderNeon061Compatibility(plan.find(item => item.number === 61).sql);
  const staged = ['backfill', 'contract'].map(phase => {
    const name = `migrations/staged/087_d11_crm_source_of_truth_${phase}.sql`;
    const sql = git(['show', headCommit + ':' + name]);
    return { path: name, phase, checksum: sqlHash(sql), sql };
  });
  return { plan, staged, excluded, digest: hash(canonical({ headCommit,
    plan: plan.map(({ path, checksum }) => ({ path, checksum })), staged: staged.map(({ path, checksum }) => ({ path, checksum })), excluded })) };
}

async function privateFile(filename) {
  const root = await realpath(path.resolve('.npm-cache/qa'));
  const resolved = await realpath(filename);
  assert.ok(resolved.startsWith(root + path.sep), 'Private QA file must remain inside git-ignored QA directory');
  execFileSync('git', ['check-ignore', '--quiet', resolved], { stdio: 'ignore' });
  const info = await lstat(resolved);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0, 'Owner-only private file required');
  return resolved;
}

async function identity(client, target, database, user = 'neondb_owner') {
  const row = (await client.query(`select current_setting('neon.project_id',true) as project,
    current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role,
    session_user as session_role,current_setting('server_version_num')::int as server_version,
    (select rolname from pg_roles where oid=(select datdba from pg_database where datname=current_database())) as database_owner`)).rows[0];
  assert.deepEqual([row.project, row.branch, row.database, row.role, row.session_role], [target.projectId, target.branchId, database, user, user], 'Connected QA fingerprint mismatch');
  assert.ok(row.server_version >= 170000, 'PostgreSQL17+ required');
  if (database !== 'postgres') assert.equal(row.database_owner, 'neondb_owner');
  return row;
}

async function pristine(client) {
  const relations = (await client.query("select c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e') order by c.relname")).rows;
  assert.equal(relations.length, 0, 'Fresh target must have no user relations');
  const functions = (await client.query("select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e') order by p.proname")).rows;
  assert.equal(functions.length, 0, 'Fresh target must have no user functions');
  const userTypes = (await client.query("select t.typname from pg_type t where t.typnamespace='public'::regnamespace and t.typtype in('e','d','r','m') and not exists(select 1 from pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e') order by t.typname")).rows;
  assert.equal(userTypes.length, 0, 'Fresh target must have no user-defined types');
  return {
    providerDatabase: await providerDatabaseSnapshot(client),
    extensions: (await client.query("select e.extname,e.extversion,r.rolname as owner from pg_extension e join pg_roles r on r.oid=e.extowner order by e.extname")).rows,
    databases: (await client.query("select datname,pg_get_userbyid(datdba) as owner from pg_database order by datname")).rows,
    roles: (await client.query("select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname !~ '^pg_' order by rolname")).rows,
    memberships: (await client.query("select r.rolname as role,m.rolname as member,g.rolname as grantor,a.admin_option,a.inherit_option,a.set_option from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor order by r.rolname,m.rolname,g.rolname")).rows,
  };
}

async function providerDatabaseSnapshot(client) {
  const queries = [
    "select oid,pg_get_userbyid(datdba) as owner,encoding,datcollate,datctype,datconnlimit,datistemplate,datallowconn,datacl::text from pg_database where datname=current_database()",
    "select n.nspname,n.nspowner::regrole::text,n.nspacl::text from pg_namespace n where n.nspname !~ '^pg_' and n.nspname<>'information_schema' order by n.nspname",
    "select e.extname,e.extversion,e.extowner::regrole::text,n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname",
    "select n.nspname,c.relname,c.relkind,c.relowner::regrole::text,c.relacl::text,c.reloptions,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' order by n.nspname,c.relname",
    "select n.nspname,t.typname,t.typtype,t.typowner::regrole::text from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' order by n.nspname,t.typname",
    "select n.nspname,p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid),p.proacl::text,p.proowner::regrole::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and p.prokind in('f','p') order by n.nspname,signature",
    "select defaclrole::regrole::text,coalesce(n.nspname,'ALL_SCHEMAS') as schema,defaclobjtype,defaclacl::text from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace order by defaclrole,schema,defaclobjtype",
  ];
  const data = [];
  for (const query of queries) data.push((await client.query(query)).rows);
  return { databaseOid: data[0][0].oid, metadataSha256: hash(canonical(data)), categories: data.map(rows => rows.length) };
}

async function fresh062(client) {
  assert.equal((await client.query("select count(*)::int as n from novalure_schema_migrations where version ~ '^0*(60|61)(_|$)'")).rows[0].n, 0);
  assert.equal((await client.query("select count(*)::int as n from pg_trigger where tgname='audit_logs_append_only_guard' and not tgisinternal")).rows[0].n, 0);
  for (const table of ['media_assets', 'media_asset_shares', 'bot_document_sends']) assert.equal((await client.query('select count(*)::int as n from ' + identifier(table))).rows[0].n, 0);
  const seed = (await client.query(`select count(*)::int as total,count(*) filter(where workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' and actor_user_id is null and action='workspace.seeded' and entity_type='workspace' and entity_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' and before is null and after='{"migration":"030_novalure_growth_workspace","workspace":"Novalure Growth","profiles":["novalureGrowth","novalureServiceOps","novalureAdmin"]}'::jsonb)::int as expected from audit_logs`)).rows[0];
  assert.deepEqual(seed, { total: 1, expected: 1 }, 'Only unchanged original030 seed may precede fresh062');
}

async function migrationCatalogDigest(client) {
  const queries = [
    "select c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,pg_get_userbyid(c.relowner) as owner from pg_class c where c.relnamespace='public'::regnamespace order by c.relname",
    "select c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid) from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where c.relnamespace='public'::regnamespace and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum",
    "select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid),p.proacl::text from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in('f','p') order by signature",
    "select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname",
    "select c.relname,k.conname,pg_get_constraintdef(k.oid),k.convalidated from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace order by c.relname,k.conname",
    "select c.relname,t.tgname,pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by c.relname,t.tgname",
    "select version,name,checksum from novalure_schema_migrations order by version",
  ];
  const data = [];
  for (const query of queries) data.push((await client.query(query)).rows);
  return hash(canonical(data));
}

export async function runPackage4NeonBootstrap(configFilename, mode) {
  assert.ok(['--preflight', '--apply', '--verify'].includes(mode), 'Explicit bootstrap mode required');
  const configPath = await privateFile(configFilename);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.ok(neon061.neon061Package4QaTarget, 'Exact Package4 QA target must be provisioned and reviewed before any connection');
  assert.deepEqual(config.target, neon061.neon061Package4QaTarget, 'Exact new isolated package4 QA target required');
  assert.ok(Date.now() - Date.parse(config.projectCreatedAt) >= 0 && Date.now() - Date.parse(config.projectCreatedAt) < 86_400_000, 'New-project authorization expires after24h');
  const url = new URL((await readFile(await privateFile(config.adminUrlFile), 'utf8')).trim());
  assert.equal(decodeURIComponent(url.username), 'neondb_owner');
  assert.equal(url.pathname, '/neondb');
  assert.match(url.hostname, /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/);
  assert.ok(!url.hostname.includes('-pooler.'));
  assert.equal(url.hostname, config.host);
  const headCommit = assertRepositoryCommitted();
  const manifest = createPackage4NeonManifest(headCommit);
  const runRoot = path.dirname(configPath);
  await chmod(runRoot, 0o700);
  configurePackage4NeonTransport();
  const pools = [];
  const pool = (database, connectionUrl = url) => {
    const next = new URL(connectionUrl); next.pathname = '/' + database;
    for (const param of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) next.searchParams.delete(param);
    const result = new Pool({ connectionString: next.toString(), max: 2, connectionTimeoutMillis: 20_000, query_timeout: 900_000 });
    pools.push(result); return result;
  };
  const evidence = { format: 'package4-neon-bootstrap-v1', target: config.target, implementationRevision: headCommit,
    manifestDigest: manifest.digest, startedAt: new Date().toISOString(), status: 'RUNNING', productionAccess: 0,
    originalSqlExceptExplicit061Receipt: true, vectorSubstitution: false, excludedPreviewMigrations: manifest.excluded, applied: [], staged: [] };
  const save = () => writeFile(path.join(runRoot, 'bootstrap-result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  try {
    const admin = pool('neondb');
    evidence.identity = await identity(admin, config.target, 'neondb');
    if (mode === '--preflight') {
      const baseline = await pristine(admin);
      assert.ok(!baseline.roles.some(row => ['novalure_app', 'novalure_tenant_app'].includes(row.rolname)), 'Fresh run-owned application roles must not preexist');
      assert.deepEqual(baseline.databases.map(row => row.datname).filter(name => !['postgres', 'template0', 'template1'].includes(name)), ['neondb'], 'New isolated project must contain only initial neondb');
      const bound = { target: config.target, host: config.host, headCommit, manifestDigest: manifest.digest, baseline };
      const plan = { format: 'package4-neon-fresh-plan-v1', capturedAt: new Date().toISOString(), bound, digest: hash(canonical(bound)) };
      await writeFile(path.join(runRoot, 'bootstrap-plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      evidence.status = 'PREFLIGHT_PASS'; evidence.planDigest = plan.digest; await save(); return evidence;
    }
    if (mode === '--apply') {
      const plan = JSON.parse(await readFile(await privateFile(path.join(runRoot, 'bootstrap-plan.json')), 'utf8'));
      assert.equal(plan.format, 'package4-neon-fresh-plan-v1');
      assert.equal(hash(canonical(plan.bound)), plan.digest);
      assert.ok(Date.now() - Date.parse(plan.capturedAt) >= 0 && Date.now() - Date.parse(plan.capturedAt) < 3_600_000, 'Fresh preflight expires after1h');
      const baseline = await pristine(admin);
      assert.deepEqual(plan.bound, { target: config.target, host: config.host, headCommit, manifestDigest: manifest.digest, baseline }, 'Fresh preflight catalog/commit drift');
      const control = pool('postgres'); await identity(control, config.target, 'postgres');
      await admin.end(); pools.splice(pools.indexOf(admin), 1);
      await control.query('alter database neondb rename to ' + identifier(preservedDatabase));
      const preserved = pool(preservedDatabase); await identity(preserved, config.target, preservedDatabase);
      assert.deepEqual(await providerDatabaseSnapshot(preserved), baseline.providerDatabase, 'Renamed provider baseline OID/metadata must be identical');
      await control.query('create database neondb with template template0 owner neondb_owner');
      const fresh = pool('neondb'); await identity(fresh, config.target, 'neondb'); await pristine(fresh);
      assert.deepEqual((await fresh.query("select extname from pg_extension order by extname")).rows, [{ extname: 'plpgsql' }], 'template0 must have no inherited provider extensions');
      const password = randomBytes(40).toString('hex');
      const runtimeUrl = new URL(url); runtimeUrl.username = 'novalure_app'; runtimeUrl.password = password;
      await writeFile(path.join(runRoot, 'runtime-url.txt'), runtimeUrl.toString() + '\n', { mode: 0o600, flag: 'wx' });
      await fresh.query("create role novalure_app login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '" + password + "'");
      for (const item of manifest.plan) {
        if (item.number === 104) {
          const before = await migrationCatalogDigest(fresh);
          const connection = await fresh.connect(); let failure;
          try {
            await connection.query('begin');
            for (const candidate of manifest.plan.filter(item => item.number >= 104)) {
              await connection.query(candidate.sql);
              await connection.query('insert into public.novalure_schema_migrations(version,name,checksum) values($1,$2,$3)', [candidate.version, candidate.file, candidate.checksum]);
            }
            await connection.query('select 1/0');
          } catch (error) { failure = error; }
          finally { await connection.query('rollback'); connection.release(); }
          assert.equal(failure?.code, '22012', 'Combined104/105/106 rehearsal must reach its intentional failure');
          assert.equal(await migrationCatalogDigest(fresh), before, 'Actual Neon transactional failure must preserve schema and ledger');
          evidence.combined104105106FailureRollback = { status: 'PASS', sqlState: '22012', schemaAndLedgerDigestUnchanged: before };
          await save();
        }
        const client = await fresh.connect();
        try {
          await client.query('begin');
          await client.query('set local search_path=public');
          if (item.number === 62) await fresh062(client);
          let receipt;
          if (item.number === 61) {
            await client.query('grant novalure_tenant_app to novalure_app with admin false,inherit true,set false');
            await client.query("comment on role novalure_tenant_app is 'novalure-tenant-cutover:package4-qa-" + headCommit + "'");
            receipt = await applyNeon061Compatibility({ client, sql: item.sql, target: config.target,
              executionProfile: 'package4-qa', executionContext: { headCommit, planDigest: plan.digest } });
          } else await client.query(item.sql);
          if (item.number >= 41) await client.query('insert into public.novalure_schema_migrations(version,name,checksum) values($1,$2,$3)', [item.version, item.file, item.checksum]);
          await client.query('commit');
          evidence.applied.push({ file: item.file, sourceChecksum: item.checksum, execution: receipt ? 'explicit061CompatibilityReceipt' : 'unchangedOriginalSql', ...(receipt ? { receipt } : {}) });
          await save();
        } catch (error) { await client.query('rollback'); throw new Error(item.file + ': ' + error.message, { cause: error }); }
        finally { client.release(); }
        if (item.number === 87) {
          const backfill = manifest.staged.find(item => item.phase === 'backfill');
          let remaining;
          for (let i = 0; i < 100; i++) {
            const result = await fresh.query(backfill.sql);
            remaining = result.rows[0].crm_d11_backfill_batch.remaining;
            if (Object.values(remaining).every(value => Number(value) === 0)) break;
          }
          assert.ok(remaining && Object.values(remaining).every(value => Number(value) === 0), 'Bounded staged087 backfill must converge');
          const contract = manifest.staged.find(item => item.phase === 'contract');
          const client = await fresh.connect();
          try { await client.query('begin'); await client.query(contract.sql); await client.query('commit'); }
          catch (error) { await client.query('rollback'); throw error; }
          finally { client.release(); }
          evidence.staged = manifest.staged.map(({ path, checksum }) => ({ path, checksum, actualExecution: true })); await save();
        }
      }
      assert.deepEqual(await providerDatabaseSnapshot(preserved), baseline.providerDatabase, 'Provider baseline must remain unchanged after all committed migrations');
      evidence.providerBaseline = { ...baseline.providerDatabase, preservedDatabase, unchangedBeforeAndAfter: true };
    }
    const checked = pool('neondb'); await identity(checked, config.target, 'neondb');
    const ledger = (await checked.query('select version,name,checksum from public.novalure_schema_migrations order by version')).rows;
    const expected = manifest.plan.filter(item => item.number >= 41).map(item => ({ version: item.version, name: item.file, checksum: item.checksum })).sort((a, b) => a.version.localeCompare(b.version));
    assert.deepEqual(ledger, expected, 'Actual ledger must contain exactly executed migrations, with original source hashes');
    const extensions = (await checked.query('select extname,extversion from pg_extension order by extname')).rows;
    assert.ok(extensions.some(row => row.extname === 'vector') && extensions.some(row => row.extname === 'pgcrypto'));
    assert.match((await checked.query("select format_type(atttypid,atttypmod) as type from pg_attribute where attrelid='public.knowledge_chunks'::regclass and attname='embedding'")).rows[0].type, /^vector\(1536\)$/);
    assert.equal((await checked.query("select count(*)::int as n from pg_index where indexrelid='public.knowledge_chunks_embedding_idx'::regclass and indisvalid and indisready")).rows[0].n, 1);
    const runtime = (await checked.query("select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname='novalure_app'")).rows[0];
    assert.deepEqual(runtime, { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    assert.equal((await checked.query("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace and (relowner='novalure_app'::regrole or pg_has_role('novalure_app',relowner,'MEMBER'))")).rows[0].n, 0);
    const runtimeUrl = new URL((await readFile(await privateFile(path.join(runRoot, 'runtime-url.txt')), 'utf8')).trim());
    assert.equal(runtimeUrl.hostname, config.host); assert.equal(decodeURIComponent(runtimeUrl.username), 'novalure_app'); assert.equal(runtimeUrl.pathname, '/neondb');
    const app = pool('neondb', runtimeUrl);
    await identity(app, config.target, 'neondb', 'novalure_app');
    assert.equal((await app.query("select has_schema_privilege(current_user,'public','CREATE') as allowed")).rows[0].allowed, false);
    for (const table of ['knowledge_sources', 'knowledge_areas', 'knowledge_workflow_events', 'knowledge_website_monitoring']) {
      assert.equal((await app.query('select count(*)::int as n from public.' + identifier(table))).rows[0].n, 0, 'Missing context must deny rows: ' + table);
    }
    for (const table of ['novalure_schema_migrations', 'novalure_migration_execution_receipts', 'crm_service_principals', 'provider_connections']) {
      await assert.rejects(app.query('select * from public.' + identifier(table)), error => error.code === '42501', 'Runtime must not read private provisioning records: ' + table);
    }
    evidence.final = { ledgerRows: ledger.length, ledger, extensions, originalVectorColumnAndIndex: true, runtime, runtimeOwnsNoPublicObjects: true,
      actualRuntimeConnectionVerified: true, missingContextDeniesKnowledge: true, privateProvisioningTablesDenied: true,
      forcedRls: (await checked.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind in('r','p') and relrowsecurity order by relname")).rows };
    assert.ok(evidence.final.forcedRls.every(row => row.relforcerowsecurity));
    evidence.status = 'PASS'; evidence.completedAt = new Date().toISOString(); await save(); return evidence;
  } catch (error) {
    evidence.status = 'FAIL'; evidence.failure = { code: error.code ?? error.cause?.code ?? null,
      message: String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[REDACTED]') };
    await save(); throw error;
  } finally { await Promise.allSettled(pools.map(pool => pool.end())); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runPackage4NeonBootstrap(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ status: result.status, target: result.target, applied: result.applied.length, manifestDigest: result.manifestDigest }));
}
