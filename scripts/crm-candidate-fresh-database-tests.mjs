import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { startLocalSalesDb } from './lib/local-sales-db.mjs';
import { applyCrmCandidateOriginalMigration, assertCrmCandidateBlankDatabase, assertCrmCandidateLedger, crmCandidateTransaction } from './lib/crm-candidate-fresh-bootstrap.mjs';
import { applyCrmCandidate061Compatibility, applyNeon061Compatibility, renderNeon061Compatibility } from './lib/neon-061-compat.mjs';
import { digest, sha256 } from './lib/crm-candidate-fresh-manifest.mjs';

const sql = async name => (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const migration = async file => {
  const content = await sql(file), version = file.slice(0, -4);
  return { path: 'migrations/' + file, file, version, name: version.slice(4), number: Number(file.slice(0, 3)), content, checksum: sha256(content) };
};

test('real disposable PostgreSQL: unchanged041/042 commit exact ledger and roll back failed source; not a full pgvector/Neon bootstrap', async () => {
  const db = await startLocalSalesDb();
  const first = await migration('041_schema_ledger_baseline.sql');
  const second = await migration('042_teams_notification_reservation_workflow_constraint.sql');
  const client = await db.admin.connect();
  try {
    assert.equal((await assertCrmCandidateBlankDatabase(client)).relations, 0);
    await applyCrmCandidateOriginalMigration(client, first);
    await assert.rejects(assertCrmCandidateBlankDatabase(client), /CRM_QA_DATABASE_NOT_BLANK/);
    assertCrmCandidateLedger((await client.query('select version,name,checksum from novalure_schema_migrations')).rows, [first]);
    await assert.rejects(applyCrmCandidateOriginalMigration(client, second), error => error.code === '42P01');
    assert.equal((await client.query('select count(*)::int n from novalure_schema_migrations')).rows[0].n, 1);
    // Only this named fixture table is synthetic. The two tested migration bodies are unmodified.
    await client.query('create table teams_notification_jobs(id uuid primary key,alert_type text)');
    await applyCrmCandidateOriginalMigration(client, second);
    const rows = (await client.query('select version,name,checksum from novalure_schema_migrations order by version')).rows;
    assertCrmCandidateLedger(rows, [first, second]);
    await assert.rejects(client.query("insert into teams_notification_jobs values('00000000-0000-4000-8000-000000000001','unsupported')"),
      error => error.code === '23514');
    await client.query("insert into teams_notification_jobs values('00000000-0000-4000-8000-000000000002','reservation_workflow')");
    await assert.rejects(crmCandidateTransaction(client, async () => {
      await client.query("insert into novalure_schema_migrations(version,name,checksum) values('SYNTHETIC_ROLLBACK','SYNTHETIC_ROLLBACK',$1)", ['a'.repeat(64)]);
      await client.query('select 1/0');
    }), error => error.code === '22012');
    assertCrmCandidateLedger((await client.query('select version,name,checksum from novalure_schema_migrations order by version')).rows, [first, second]);
  } finally { client.release(); await db.stop(); }
});

test('real local PostgreSQL new061 entry: simulated provider IDs, genuine FK/RLS/role guards, no cloud attestation', async t => {
  const db = await startLocalSalesDb();
  const source = await sql('061_validate_and_activate_tenant_rls_pilot.sql');
  const preparation = await sql('060_tenant_rls_pilot_prepare.sql');
  const headCommit = 'a'.repeat(40), projectId = 'synthetic-fresh-project-12345678', branchId = 'br-synthetic-fresh-12345678';
  const descriptor = { format: 'crm-candidate-free-target-v1', status: 'NATIVE_NEW_FREE_PROJECT_AUTHORIZED', sourceRevision: headCommit,
    organizationId: 'org-cool-cloud-50864215', plan: 'free', projectId, branchId, branchParentId: null, endpointId: 'ep-synthetic-fresh-12345678',
    projectCreatedAt: new Date().toISOString(), directHost: 'ep-synthetic-fresh-12345678.eu-central-1.aws.neon.tech',
    pooledHost: 'ep-synthetic-fresh-12345678-pooler.eu-central-1.aws.neon.tech', databaseName: 'neondb',
    runtimeRole: 'novalure_app', migrationRole: 'neondb_owner', productionDirectHost: 'ep-synthetic-prod-12345678.eu-central-1.aws.neon.tech',
    productionPooledHost: 'ep-synthetic-prod-12345678-pooler.eu-central-1.aws.neon.tech', nativeCreationReceiptSha256: 'b'.repeat(64) };
  let admin, client;
  try {
    await db.admin.query('create role crm_fixture_control login superuser');
    const bootstrap = new pg.Client({ host: '127.0.0.1', port: db.port, user: 'crm_fixture_control', database: 'postgres' });
    await bootstrap.connect();
    try { await bootstrap.query('alter role qa_admin rename to cloud_admin'); }
    finally { await bootstrap.end(); }
    admin = new pg.Pool({ host: '127.0.0.1', port: db.port, user: 'cloud_admin', database: 'postgres', max: 1 });
    await admin.query('create role neondb_owner login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
    await admin.query('create role novalure_tenant_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
    await admin.query('create database neondb owner neondb_owner');
    client = new pg.Client({ host: '127.0.0.1', port: db.port, user: 'neondb_owner', database: 'neondb' });
    await client.connect();
    await client.query("select set_config('neon.project_id',$1,false),set_config('neon.branch_id',$2,false)", [projectId, branchId]);
    await client.query(`create table workspace_users(id uuid primary key,workspace_id uuid not null);
      create table projects(id uuid primary key,workspace_id uuid not null);
      create table organizations(id uuid primary key,workspace_id uuid not null);
      create table contacts(id uuid primary key,workspace_id uuid not null,project_id uuid,organization_id uuid,owner_user_id uuid,archived_by_user_id uuid);
      create table leads(id uuid primary key,workspace_id uuid not null,project_id uuid,contact_id uuid,assigned_to_user_id uuid);
      create table deals(id uuid primary key,workspace_id uuid not null,project_id uuid,contact_id uuid,organization_id uuid,owner_user_id uuid,lead_id uuid);
      create table audit_logs(id uuid primary key,workspace_id uuid not null,actor_user_id uuid,project_id uuid,deal_id uuid);
      create table novalure_schema_migrations(version text primary key,name text not null,checksum text not null,applied_at timestamptz not null default now());`);
    // A deliberate local provider-like predecessor, not001–059 or Neon proof. Original060 is executed unchanged.
    await admin.query('alter role neondb_owner createrole');
    await client.query(preparation);
    await admin.query('grant novalure_tenant_app to neondb_owner with admin true,inherit false,set false; alter role novalure_app login; grant novalure_tenant_app to novalure_app with admin false,inherit true,set false');
    const creator = (await admin.query(`select g.rolname grantor,m.admin_option,m.inherit_option,m.set_option
      from pg_auth_members m join pg_roles g on g.oid=m.grantor
      where m.roleid='novalure_tenant_app'::regrole and m.member='neondb_owner'::regrole`)).rows;
    assert.deepEqual(creator, [{ grantor: 'cloud_admin', admin_option: true, inherit_option: false, set_option: false }]);
    await client.query("comment on role novalure_tenant_app is 'novalure-tenant-cutover:synthetic-crm-candidate-test'");
    await client.query("insert into novalure_schema_migrations(version,name,checksum) values('060_tenant_rls_pilot_prepare','tenant_rls_pilot_prepare',$1)", [sha256(preparation)]);
    const input = { client, sql: source, descriptor, descriptorSha256: digest(descriptor),
      target: { projectId, branchId, databaseName: 'neondb', runtimeRole: 'novalure_app' }, executionContext: { headCommit, planDigest: 'c'.repeat(64) } };
    const rolledBack = async fn => { await client.query('begin'); try { return await fn(); } finally { await client.query('rollback'); } };
    await t.test('positive entry preserves original15 FKs and5 FORCE-RLS tables with distinct receipt', async () => {
      await rolledBack(async () => {
        const receipt = await applyCrmCandidate061Compatibility(input);
        assert.equal(receipt.profileId, 'crm-candidate-fresh:neon-provider-creator-admin-only-061-v1');
        assert.equal(receipt.sourceChecksum, sha256(source));
        assert.equal(receipt.executedSqlChecksum, renderNeon061Compatibility(source).executedSqlChecksum);
        assert.equal(receipt.evidence.foreignKeysValidated.length, 15);
        assert.equal(receipt.evidence.forcedRlsTables.length, 5);
        assert.equal(receipt.evidence.roles.runtimePrivilegedReachability, false);
        assert.equal(receipt.evidence.candidateAuthorization.descriptorSha256, digest(descriptor));
        assert.equal((await client.query('select count(*)::int n from novalure_migration_execution_receipts')).rows[0].n, 1);
      });
    });
    await t.test('historical generic profile cannot select this new project', async () => {
      await rolledBack(() => assert.rejects(applyNeon061Compatibility({ ...input, executionProfile: 'crm-candidate-fresh' }), /exact new CRM/));
      await rolledBack(() => assert.rejects(applyNeon061Compatibility({ ...input, executionProfile: 'qa' }), /pinned Neon QA/));
    });
    await t.test('wrong actual branch, unsafe runtime or source change denies before a new receipt', async () => {
      await client.query("set neon.branch_id='br-synthetic-wrong'");
      try { await rolledBack(() => assert.rejects(applyCrmCandidate061Compatibility(input), /fingerprint/)); }
      finally { await client.query("select set_config('neon.branch_id',$1,false)", [branchId]); }
      await admin.query('alter role novalure_app bypassrls');
      try { await rolledBack(() => assert.rejects(applyCrmCandidate061Compatibility(input), /safe non-owner/)); }
      finally { await admin.query('alter role novalure_app nobypassrls'); }
      await rolledBack(() => assert.rejects(applyCrmCandidate061Compatibility({ ...input, sql: source + '\n-- changed' }), /checksum/));
      assert.equal((await client.query("select to_regclass('public.novalure_migration_execution_receipts') is null absent")).rows[0].absent, true);
    });
  } finally { await client?.end(); await admin?.end(); await db.stop(); }
});
