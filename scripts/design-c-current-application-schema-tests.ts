import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getCoreCrmData } from '../src/lib/db/crm-loaders';
import { getRolePermissions } from '../src/lib/auth/permissions';
import { getProductRoleCapabilities } from '../src/lib/product-model';
import { closeLocalTestPool } from '../src/lib/db/local-test-transport';
import { crmPhysicalTableStatusSql, crmTables } from '../src/lib/db/schema';
import { startDesignCIntegrationDatabase, seedDesignCIntegration } from './lib/design-c-integration-fixture.mjs';

test('explicit current Design C fixture builds the complete original application frontier on loopback', { timeout: 180_000 }, async () => {
  const testEnvironment: Record<string, string | undefined> = process.env;
  const keys = ['DATABASE_URL','CRM_LOCAL_TEST_DATABASE','NODE_ENV'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, testEnvironment[key]]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, '127.0.0.1', 'Non-loopback fetch forbidden in synthetic fixture test');
    return originalFetch(input, init);
  };
  const db = await startDesignCIntegrationDatabase({ accountLanguagePreference: true, bookingSetup: true, currentApplicationSchema: true });
  try {
    const evidence = JSON.parse(await readFile(`${db.directory}/design-c-predecessor-evidence.json`, 'utf8'));
    assert.equal(evidence.currentSchema.ledgerVersions, 124);
    assert.equal(evidence.currentSchema.originalSqlUnmodified, true);
    assert.equal(evidence.currentSchema.productionAcceptance, false);
    const manifest = JSON.parse(await readFile('scripts/fixtures/design-c-current-application-schema.json', 'utf8'));
    const ledger = (await db.admin.query('select version,checksum from public.novalure_schema_migrations order by version')).rows;
    assert.equal(ledger.length, 124);
    for (const migration of manifest.migrations) {
      assert.equal(createHash('sha256').update(await readFile(`migrations/${migration.file}`)).digest('hex'), migration.sha256);
      assert.equal(ledger.find(row => row.version === migration.version)?.checksum, migration.sha256);
    }
    for (const relation of ['crm_notification_preferences','crm_ai_assistant_runs','crm_integration_checks','web_expose_templates','project_wizard_settings','property_units']) {
      assert.ok((await db.admin.query('select to_regclass($1) as relation', [`public.${relation}`])).rows[0].relation, relation);
    }
    const runtime = (await db.pool.query('select current_user as actor,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
    assert.equal(runtime.actor, db.role); assert.equal(runtime.rolsuper, false); assert.equal(runtime.rolbypassrls, false);
    const accounts = await seedDesignCIntegration(db);
    assert.ok(accounts.operator.workspaceId && accounts.customer.workspaceId && accounts.foreign.workspaceId);
    assert.notEqual(accounts.operator.workspaceId, accounts.foreign.workspaceId);
    testEnvironment.DATABASE_URL = `postgresql://${db.role}@127.0.0.1:${db.port}/neondb`;
    testEnvironment.CRM_LOCAL_TEST_DATABASE = '1'; testEnvironment.NODE_ENV = 'test';
    const operator = accounts.operator;
    const loadCore = () => getCoreCrmData(operator.workspaceId, { session: {
      authenticated: true, source: 'database', workspaceId: operator.workspaceId, workspaceName: 'SYNTHETIC',
      userId: operator.userId, name: 'SYNTHETIC', email: 'synthetic@example.invalid', role: 'owner', productRole: 'novalureAdmin',
      permissions: getRolePermissions('owner'), productPermissions: getProductRoleCapabilities('novalureAdmin'),
    } });
    const core = await loadCore();
    assert.equal(core.source, 'database');
    assert.deepEqual(core.moduleErrors ?? {}, {});
    assert.ok(Object.values(core.moduleSources).every(source => source === 'database'));
    assert.ok(core.contacts.some(contact => contact.id === operator.developerContactId));
    assert.ok(core.projects.some(project => project.id === operator.projectId));
    assert.ok(core.contacts.every(contact => contact.workspaceId === operator.workspaceId));
    const ownerTables = new Set((await db.admin.query("select table_name from information_schema.tables where table_schema='public' and table_type in ('BASE TABLE','VIEW','FOREIGN')")).rows.map((row: { table_name: string }) => row.table_name));
    assert.equal(crmTables.length, 112);
    assert.deepEqual(crmTables.filter(name => !ownerTables.has(name)), []);
    const readPhysicalStatus = async () => (await db.pool.query(crmPhysicalTableStatusSql, [[...crmTables]])).rows as { tableName: string; exists: boolean }[];
    const physicalStatus = await readPhysicalStatus();
    assert.equal(physicalStatus.length, 112);
    assert.ok(physicalStatus.every(row => row.exists));
    assert.deepEqual(core.missingTables, []);
    for (const [relation, deniedRead] of [
      ['company_profiles', 'select id from public.company_profiles limit 0'],
      ['company_profile_versions', 'select id from public.company_profile_versions limit 0'],
    ]) {
      assert.ok((await db.admin.query('select to_regclass($1) relation', [`public.${relation}`])).rows[0].relation);
      assert.equal((await db.pool.query('select has_table_privilege(current_user,$1,\'SELECT\') allowed', [`public.${relation}`])).rows[0].allowed, false);
      assert.equal((await db.pool.query("select count(*)::int count from information_schema.tables where table_schema='public' and table_name=$1", [relation])).rows[0].count, 0);
      await assert.rejects(db.pool.query(deniedRead), (error: unknown) => (error as { code?: string }).code === '42501');
    }
    assert.equal((await db.admin.query("select to_regclass('public.approval_requests_catalog_visibility_probe') relation")).rows[0].relation, null);
    let renamed = false;
    try {
      // Fault injection only in this owned disposable DB, with the original ACLs unchanged.
      await db.admin.query('alter table public.approval_requests rename to approval_requests_catalog_visibility_probe');
      renamed = true;
      const missingStatus = await readPhysicalStatus();
      assert.equal(missingStatus.find(row => row.tableName === 'approval_requests')?.exists, false);
      const missingCore = await loadCore();
      assert.deepEqual(missingCore.missingTables, ['approval_requests']);
      assert.deepEqual(missingCore.moduleErrors ?? {}, {});
      assert.ok(Object.values(missingCore.moduleSources).every(source => source === 'database'));
    } finally {
      if (renamed) await db.admin.query('alter table public.approval_requests_catalog_visibility_probe rename to approval_requests');
    }
    assert.deepEqual((await loadCore()).missingTables, []);
    for (const relation of ['company_profiles', 'company_profile_versions']) {
      assert.equal((await db.pool.query('select has_table_privilege(current_user,$1,\'SELECT\') allowed', [`public.${relation}`])).rows[0].allowed, false);
    }
    for (const relation of ['crm_notification_preferences','crm_ai_assistant_runs','crm_integration_checks','web_expose_templates','project_wizard_settings']) {
      const protection = (await db.admin.query('select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass', [`public.${relation}`])).rows[0];
      assert.equal(protection.relrowsecurity, true, relation); assert.equal(protection.relforcerowsecurity, true, relation);
    }
    const edge = (await db.admin.query(`select admin_option,inherit_option,set_option from pg_auth_members where roleid='novalure_tenant_app'::regrole and member='neondb_owner'::regrole`)).rows[0];
    assert.deepEqual(edge, { admin_option: true, inherit_option: false, set_option: false });
    assert.equal((await db.admin.query(`select count(*)::int as count from pg_auth_members where member=$1::regrole and admin_option`, [db.role])).rows[0].count, 0);
    assert.equal((await db.admin.query(`select count(*)::int as count from pg_class where relnamespace='public'::regnamespace and relforcerowsecurity and relowner=$1::regrole`, [db.role])).rows[0].count, 0);
    assert.equal((await db.admin.query(`select tgenabled from pg_trigger where tgname='audit_logs_append_only_guard' and tgrelid='public.audit_logs'::regclass`)).rows[0].tgenabled, 'O');
  } finally {
    await closeLocalTestPool(); await db.stop();
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (previous[key] === undefined) delete testEnvironment[key]; else testEnvironment[key] = previous[key]; }
  }
});
