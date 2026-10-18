import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { captureDatabaseMetadata, captureExtensionMetadata, catalogQueries, extensionQueries, restoreProject, restoreBranch } from './studio-stage3-qa-fingerprint.mjs';
import { prepareTargetQueries, managementDatabase, providerBaselineDatabase } from './studio-stage3-qa-prepare-target.mjs';
import { verifyApprovedSource } from './studio-stage3-qa-restore.mjs';
import { applyNeon061Compatibility, renderNeon061Compatibility } from './neon-061-compat.mjs';

const requireValue = (value, code) => assert.ok(value, code);
const canonical = (value) => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical(value[key]))]))
  : Array.isArray(value) ? value.map((entry) => JSON.parse(canonical(entry))) : value);
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const sqlHash = (value) => createHash('sha256').update(value.replace(/\r\n/gu, '\n')).digest('hex');
const equal = (a, b) => canonical(a) === canonical(b);
export const freshBootstrapTarget = Object.freeze({ projectId: restoreProject, branchId: restoreBranch, databaseName: 'neondb', runtimeRole: 'novalure_app' });
export const freshBootstrapBaseline = Object.freeze({ apiOid: 16396, managementOid: 32768, postgresOid: 5,
  apiDatabase: '0e6d312a3dda0a7970015261fea62a84f7cbe4c6e05e08707865b1c509c9578b',
  apiCatalog: '275fc9d31817c338148e51dcb1d3e8ea0a711d71cc29f3021b2168bca1396194',
  managementDatabase: 'c44118eae43133c199b6468dc98daddb7adabbc7bbdfa13de2e7d8ff247ac98c',
  managementCatalog: '1ec02902dd68d84e2c6a1550cc5ba49b6ca8bf5770aabf48bf6430874f1cd412',
  originalPlan: '17784722dcebd0e8d213e2b040ce5c9d5c5cc392ac48fb42f7aed3e44cbeedf9',
  originalCommit: '778ed0c8b609bc1a4b1d47d1532e9a594758ccdb' });
const initialNames = ['neondb', 'postgres', managementDatabase, 'template0', 'template1'].sort();
const shaPattern = /^[a-f0-9]{64}$/u;
export function createFreshBootstrapManifest(files, { headCommit, cutoverSourceSha }) {
  requireValue(/^[a-f0-9]{40}$/u.test(headCommit || '') && /^[a-f0-9]{40}$/u.test(cutoverSourceSha || ''), 'EXACT_FRESH_SOURCE_REVISIONS_REQUIRED');
  const migrations = files.map(({ name, content }) => {
    requireValue(/^\d{3}_[a-z0-9_]+\.sql$/u.test(name) && !name.includes('_rollback') && typeof content === 'string', 'INVALID_ORIGINAL_MIGRATION');
    return { name, content: content.replace(/\r\n/gu, '\n'), number: Number(name.slice(0, 3)), version: name.slice(0, -4), checksum: sqlHash(content) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  requireValue(migrations.length === 83 && new Set(migrations.map((row) => row.version)).size === 83, 'EXACT_83_ORIGINAL_MIGRATIONS_REQUIRED');
  for (let number = 1; number <= 85; number++) requireValue(migrations.filter((row) => row.number === number).length ===
    ([58, 59, 63].includes(number) ? 0 : number === 13 ? 2 : 1), 'ORIGINAL_MIGRATION_NUMBERING_MISMATCH');
  requireValue(migrations.every((row) => row.number >= 1 && row.number <= 85) && equal(migrations.filter((row) => row.number === 13).map((row) => row.name),
    ['013_analysis_bot_70_sprint.sql', '013_newsletter_suppressions.sql']), 'ORIGINAL_MIGRATION_SET_MISMATCH');
  const media = migrations.find((row) => row.number === 62), plan = migrations.filter((row) => row !== media);
  plan.splice(plan.findIndex((row) => row.number === 60), 0, media);
  renderNeon061Compatibility(plan.find((row) => row.number === 61).content);
  return Object.freeze(plan.map((row) => Object.freeze(row)));
}
function historyBindings(history) {
  const original = history.originalPreflight?.preflight;
  const { sha256: oldHash, ...originalBody } = original || {};
  requireValue(oldHash === freshBootstrapBaseline.originalPlan && hash(originalBody) === oldHash &&
    history.originalPreflight.headCommit === freshBootstrapBaseline.originalCommit, 'EXACT_ORIGINAL_PREPARE_PLAN_REQUIRED');
  const failed = history.failedPrepare;
  requireValue(failed?.status === 'FAIL' && failed.failureCode === 'TARGET_DEFAULT_ACL_MISMATCH' &&
    equal(failed.steps, ['create_management_database']) && failed.headCommit === freshBootstrapBaseline.originalCommit &&
    failed.projectId === restoreProject && failed.branchId === restoreBranch && failed.sourceWrites === 0 && failed.rolesCreated === 0 &&
    failed.extensionWrites === 0 && failed.aclChanges === 0 && failed.drops === 0 && equal(failed.preflight, original), 'EXACT_FAILED_PREPARE_EVIDENCE_REQUIRED');
  const source = history.sourceReport?.databases?.find((row) => row.databaseName === 'qa_g24_pr63_20260917_r3');
  requireValue(source, 'APPROVED_SOURCE_HISTORY_REQUIRED'); verifyApprovedSource(source, source);
  requireValue(source.database.sha256 === original.sourceDatabaseSha256 && source.extensionProfile.sha256 === original.sourceExtensionProfileSha256 &&
    source.database.globalRoleSettings.sha256 === original.sourceGlobalRoleSettingsSha256, 'SOURCE_HISTORY_BINDING_MISMATCH');
  const denial = history.nativeDenial;
  requireValue(denial?.status === 'BLOCKED_PROVIDER_42501' && denial.sqlState === '42501' && denial.rollbackConfirmed === true &&
    denial.effectiveRightsChanged === false && denial.sourceWrites === 0 && denial.commitAllowed === false && equal(denial.before, denial.after) &&
    denial.before.database === freshBootstrapBaseline.apiDatabase && denial.before.extensionProfile === freshBootstrapBaseline.apiCatalog,
  'ROLLED_BACK_NATIVE_DENIAL_REQUIRED');
  requireValue(history.startInventory?.readOnly === true, 'EXPLICIT_CURRENT_READONLY_INVENTORY_REQUIRED');
  for (const [name, databaseHash, catalogHash] of [['neondb', freshBootstrapBaseline.apiDatabase, freshBootstrapBaseline.apiCatalog],
    [managementDatabase, freshBootstrapBaseline.managementDatabase, freshBootstrapBaseline.managementCatalog]]) {
    const row = history.startInventory.databases?.find((entry) => entry.identity?.database === name);
    requireValue(row?.identity.project === restoreProject && row.identity.branch === restoreBranch && row.identity.role === 'neondb_owner' &&
      row.identity.session_role === 'neondb_owner' && row.database?.sha256 === databaseHash && row.extensionProfile?.sha256 === catalogHash && row.globals?.count === 0,
    'CURRENT_READONLY_BASELINE_BINDING_MISMATCH');
  }
  return { source: hash(history.sourceReport), originalPreflight: hash(history.originalPreflight), failedPrepare: hash(failed),
    startInventory: hash(history.startInventory), nativeDenial: hash(denial), providerRoles: original.providerRoles };
}
function connectionContext(connect) {
  const clients = new Map();
  return { clients,
    async open(database) {
      const client = await connect(database); clients.set(client, { database, pid: null });
      const identity = (await client.query(prepareTargetQueries.identity)).rows[0];
      requireValue(identity?.project === restoreProject && identity.branch === restoreBranch && identity.database === database &&
        identity.role === 'neondb_owner' && identity.session_role === 'neondb_owner' && identity.server_version_num === 180006 &&
        identity.can_create_database === true && identity.database_owner === (database === 'postgres' ? 'cloud_admin' : 'neondb_owner') &&
        Number.isInteger(identity.pid) && Number.isInteger(identity.database_oid), 'FRESH_TARGET_IDENTITY_MISMATCH');
      clients.set(client, { database, pid: identity.pid }); return { client, identity };
    },
    async close(client) { await client.end(); clients.delete(client); },
    async closeAll() { await Promise.allSettled([...clients.keys()].map((client) => client.end())); }
  };
}
async function guard(context, client, names, providerRoles, { runtimeCreated = false, tenantCreated = false } = {}) {
  const databases = (await client.query(prepareTargetQueries.databases)).rows;
  requireValue(equal(databases.map((row) => row.name), [...names].sort()), 'FRESH_DATABASE_INVENTORY_DRIFT');
  const roles = (await client.query(prepareTargetQueries.roles)).rows;
  requireValue(equal(roles.filter((row) => providerRoles.some((expected) => expected.name === row.name)), providerRoles) &&
    equal(roles.map((row) => row.name).sort(), [...providerRoles.map((row) => row.name), ...(runtimeCreated ? ['novalure_app'] : []), ...(tenantCreated ? ['novalure_tenant_app'] : [])].sort()), 'FRESH_ROLE_INVENTORY_DRIFT');
  const allowed = new Map([...context.clients.values()].map(({ pid, database }) => [pid, database]));
  const sessions = (await client.query(prepareTargetQueries.sessions)).rows;
  const owned = sessions.filter((row) => allowed.has(row.pid)), background = sessions.filter((row) => !allowed.has(row.pid));
  requireValue(owned.length === allowed.size && owned.every((row) => row.role === 'neondb_owner' && allowed.get(row.pid) === row.database) &&
    background.every((row) => row.database === 'postgres' && row.role === 'cloud_admin' && row.state === 'idle'), 'FRESH_FOREIGN_SESSION');
  requireValue((await client.query(prepareTargetQueries.prepared)).rows[0]?.count === 0, 'FRESH_PREPARED_TRANSACTION');
  return { count: background.length, inventory: background.map(({ database, role, state }) => ({ database, role, state })) };
}
export async function captureFreshDatabaseSnapshot(client) {
  await client.query('begin isolation level repeatable read read only');
  try {
    const database = await captureDatabaseMetadata(client), extensionProfile = await captureExtensionMetadata(client);
    const objects = (await client.query(extensionQueries.userObjects)).rows, globals = (await client.query(extensionQueries.globalObjects)).rows[0];
    await client.query('rollback'); return { database, extensionProfile, objects, globals };
  } catch (error) { await client.query('rollback'); throw error; }
}
async function preflight(context, { history, manifest, headCommit, cutoverSourceSha, snapshot }) {
  const bindings = historyBindings(history);
  requireValue(/^[a-f0-9]{40}$/u.test(headCommit) && /^[a-f0-9]{40}$/u.test(cutoverSourceSha), 'EXACT_FRESH_SOURCE_REVISIONS_REQUIRED');
  const control = await context.open('postgres'); requireValue(control.identity.database_oid === 5, 'PINNED_POSTGRES_MANAGEMENT_OID_REQUIRED');
  const diagnostics = await guard(context, control.client, initialNames, bindings.providerRoles);
  const captured = {};
  for (const [name, oid, expectedDatabase, expectedCatalog] of [['neondb', 16396, freshBootstrapBaseline.apiDatabase, freshBootstrapBaseline.apiCatalog],
    [managementDatabase, 32768, freshBootstrapBaseline.managementDatabase, freshBootstrapBaseline.managementCatalog]]) {
    const selected = await context.open(name);
    requireValue(selected.identity.database_oid === oid, 'FRESH_BASELINE_DATABASE_OID_MISMATCH');
    await guard(context, control.client, initialNames, bindings.providerRoles);
    const actual = await snapshot(selected.client);
    const approved = history.startInventory.databases.find((entry) => entry.identity.database === name);
    requireValue(actual.database.sha256 === expectedDatabase && actual.extensionProfile.sha256 === expectedCatalog &&
      actual.database.globalRoleSettings.count === 0 && equal(actual.objects, approved.objects) && actual.globals?.count === 0,
    'FRESH_BASELINE_CATALOG_DRIFT');
    captured[name] = { oid, databaseSha256: actual.database.sha256, catalogSha256: actual.extensionProfile.sha256,
      objectsSha256: hash(actual.objects), globalRoleSettingsSha256: actual.database.globalRoleSettings.sha256 };
    await context.close(selected.client);
  }
  const memberships = (await control.client.query(catalogQueries.memberships)).rows;
  const executed061Checksum = renderNeon061Compatibility(manifest.find((row) => row.number === 61).content).executedSqlChecksum;
  const bound = { format: 'studio-stage3-fresh-bootstrap-bound-v1', target: freshBootstrapTarget, headCommit, cutoverSourceSha,
    history: bindings, databases: captured, databaseNames: initialNames, membershipsSha256: hash(memberships),
    migrations: manifest.map(({ name, checksum }) => ({ name, checksum })), executed061Checksum, stopAfter: 85 };
  return { format: 'studio-stage3-fresh-bootstrap-plan-v1', bound, sha256: hash(bound), diagnostics: { providerBackgroundSessions: diagnostics } };
}
export async function captureFreshBootstrapPreflight({ connect, history, manifest, headCommit, cutoverSourceSha, snapshot = captureFreshDatabaseSnapshot }) {
  const context = connectionContext(connect);
  try { return await preflight(context, { history, manifest: createFreshBootstrapManifest(manifest, { headCommit, cutoverSourceSha }), headCommit, cutoverSourceSha, snapshot }); }
  finally { await context.closeAll(); }
}
async function assertFreshMedia062(client) {
  requireValue((await client.query("select count(*)::int as n from public.novalure_schema_migrations where version like '060%' or version like '061%'")).rows[0]?.n === 0, 'FRESH062_RLS_LEDGER_ALREADY_PRESENT');
  requireValue((await client.query("select count(*)::int as n from pg_trigger where tgname='audit_logs_append_only_guard' and not tgisinternal")).rows[0]?.n === 0, 'FRESH062_AUDIT_GUARD_ALREADY_PRESENT');
  for (const table of ['media_assets', 'media_asset_shares', 'bot_document_sends']) requireValue((await client.query('select count(*)::int as n from public.' + table)).rows[0]?.n === 0, 'FRESH062_MEDIA_NOT_EMPTY');
  const seed = (await client.query(`select count(*)::int total,count(*) filter(where workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' and actor_user_id is null and action='workspace.seeded' and entity_type='workspace' and entity_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' and before is null and after='{"migration":"030_novalure_growth_workspace","workspace":"Novalure Growth","profiles":["novalureGrowth","novalureServiceOps","novalureAdmin"]}'::jsonb)::int expected from public.audit_logs`)).rows[0];
  requireValue(seed?.total === 1 && seed.expected === 1, 'FRESH062_ORIGINAL030_AUDIT_SEED_MISMATCH');
}
async function runtimeAttributes(client, tenantCreated) {
  const rows = (await client.query("select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname in ('novalure_app','novalure_tenant_app') order by rolname")).rows;
  requireValue(rows.length === (tenantCreated ? 2 : 1) && rows.every((row) => !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole && !row.rolreplication && !row.rolbypassrls &&
    (row.rolname === 'novalure_app' ? row.rolcanlogin && row.rolinherit : tenantCreated && !row.rolcanlogin && !row.rolinherit)), 'FRESH_RUNTIME_ROLE_UNSAFE');
}
/** One separately reviewed fresh run only. It never imports G24 rows/ledger or invokes pg_restore. */
export async function runFreshBootstrap({ connect, history, manifest, headCommit, cutoverSourceSha, approvedPlan, saveEvidence, saveRuntimeSecret,
  snapshot = captureFreshDatabaseSnapshot, apply061 = applyNeon061Compatibility }) {
  const context = connectionContext(connect);
  const evidence = { format: 'studio-stage3-fresh-bootstrap-run-v1', status: 'RUNNING', target: freshBootstrapTarget, headCommit,
    sourceWrites: 0, providerRoleChanges: 0, nativeRestore: false, historicalLedgerCopied: false, stopAfter: 85, steps: [], applied: [] };
  const step = async (phase, action) => { evidence.phase = phase; await saveEvidence(evidence); const result = await action(); evidence.steps.push(phase); await saveEvidence(evidence); return result; };
  await saveEvidence(evidence);
  try {
    manifest = createFreshBootstrapManifest(manifest, { headCommit, cutoverSourceSha });
    requireValue(approvedPlan?.format === 'studio-stage3-fresh-bootstrap-plan-v1' && shaPattern.test(approvedPlan.sha256 || ''), 'REVIEWED_FRESH_PLAN_REQUIRED');
    const actual = await preflight(context, { history, manifest, headCommit, cutoverSourceSha, snapshot });
    requireValue(actual.sha256 === approvedPlan.sha256 && equal(actual.bound, approvedPlan.bound), 'REVIEWED_FRESH_PLAN_DRIFT');
    evidence.plan = actual; evidence.providerBackgroundSessions = actual.diagnostics.providerBackgroundSessions;
    const providerRoles = actual.bound.history.providerRoles, control = [...context.clients.keys()][0];
    await guard(context, control, initialNames, providerRoles);
    await step('preserve_original_api_database', () => control.query('alter database "neondb" rename to "st1_stage3_provider_baseline"'));
    const preservedNames = [...initialNames.filter((name) => name !== 'neondb'), providerBaselineDatabase].sort();
    const baseline = await context.open(providerBaselineDatabase);
    requireValue(baseline.identity.database_oid === 16396, 'PRESERVED_API_DATABASE_OID_MISMATCH');
    const unchanged = await snapshot(baseline.client);
    requireValue(unchanged.database.sha256 === freshBootstrapBaseline.apiDatabase && unchanged.extensionProfile.sha256 === freshBootstrapBaseline.apiCatalog &&
      hash(unchanged.objects) === actual.bound.databases.neondb.objectsSha256, 'PRESERVED_API_DATABASE_CHANGED');
    await context.close(baseline.client); await guard(context, control, preservedNames, providerRoles);
    await step('create_new_original_sql_database', () => control.query('create database "neondb" with template "template0" owner "neondb_owner"'));
    const currentNames = [...preservedNames, 'neondb'].sort(), fresh = await context.open('neondb');
    requireValue(![16396, 32768, 5].includes(fresh.identity.database_oid), 'NEW_SQL_DATABASE_OID_NOT_FRESH');
    const pristine = await snapshot(fresh.client);
    requireValue(pristine.database.sha256 === freshBootstrapBaseline.managementDatabase && pristine.extensionProfile.sha256 === freshBootstrapBaseline.managementCatalog &&
      pristine.objects.length === 0 && pristine.globals?.count === 0, 'NEW_SQL_DATABASE_NOT_PRISTINE');
    await guard(context, control, currentNames, providerRoles);
    const password = randomBytes(40).toString('hex');
    await saveRuntimeSecret({ role: 'novalure_app', password, target: freshBootstrapTarget, databaseOid: fresh.identity.database_oid });
    await step('new_safe_runtime_login', async () => {
      await fresh.client.query('begin');
      try {
        await fresh.client.query("create role novalure_app login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '" + password + "'");
        await runtimeAttributes(fresh.client, false); await fresh.client.query('commit');
      } catch (error) { await fresh.client.query('rollback'); throw error; }
    });
    for (const migration of manifest) {
      await guard(context, control, currentNames, providerRoles, { runtimeCreated: true, tenantCreated: evidence.applied.some((row) => row.number === 60) });
      evidence.phase = 'original_sql_' + migration.version; await saveEvidence(evidence);
      await fresh.client.query('begin'); let receipt;
      try {
        await fresh.client.query('set local search_path=public');
        if (migration.number === 62) await assertFreshMedia062(fresh.client);
        if (migration.number === 61) {
          await runtimeAttributes(fresh.client, true);
          await fresh.client.query('grant novalure_tenant_app to novalure_app with admin false, inherit true, set false');
          await fresh.client.query("comment on role novalure_tenant_app is 'novalure-tenant-cutover:studio-stage3-qa-" + cutoverSourceSha + "'");
          receipt = await apply061({ client: fresh.client, sql: migration.content, executionProfile: 'studio-stage3-qa', target: freshBootstrapTarget,
            executionContext: { headCommit, planDigest: actual.sha256 } });
        } else await fresh.client.query(migration.content);
        if (migration.number >= 41) await fresh.client.query('insert into public.novalure_schema_migrations(version,name,checksum) values($1,$2,$3)', [migration.version, migration.name, migration.checksum]);
        await fresh.client.query('commit');
      } catch (error) { await fresh.client.query('rollback'); throw error; }
      evidence.applied.push({ number: migration.number, file: migration.name, sourceChecksum: migration.checksum,
        execution: receipt ? 'actual-neon-061-compatible-execution-with-new-receipt' : 'original-sql', ...(receipt ? { receipt061: receipt } : {}) });
      await saveEvidence(evidence);
    }
    await runtimeAttributes(fresh.client, true);
    await guard(context, control, currentNames, providerRoles, { runtimeCreated: true, tenantCreated: true });
    const ledger = (await fresh.client.query('select version,name,checksum,applied_at from public.novalure_schema_migrations order by version')).rows;
    const expectedLedger = manifest.filter((row) => row.number >= 41);
    requireValue(ledger.length === expectedLedger.length && ledger.every((row) => expectedLedger.some((item) => row.version === item.version && row.name === item.name && row.checksum === item.checksum)), 'ACTUAL_FRESH_LEDGER_MISMATCH');
    const receipts = (await fresh.client.query('select source_checksum,executed_sql_checksum,profile_id,target from public.novalure_migration_execution_receipts')).rows;
    requireValue(receipts.length === 1 && receipts[0].source_checksum === manifest.find((row) => row.number === 61).checksum &&
      receipts[0].executed_sql_checksum === actual.bound.executed061Checksum && receipts[0].profile_id === 'studio-stage3-qa:neon-provider-creator-admin-only-061-v1' && equal(receipts[0].target, freshBootstrapTarget), 'ACTUAL_FRESH061_RECEIPT_MISMATCH');
    const finalCatalog = {};
    for (const [name, sql] of Object.entries(catalogQueries)) { const rows = (await fresh.client.query(sql)).rows; finalCatalog[name] = { count: rows.length, sha256: hash(rows) }; }
    evidence.final = { databaseOid: fresh.identity.database_oid, ledgerRows: ledger.length, ledgerSha256: hash(ledger), schemaCategories: finalCatalog,
      extensions: (await fresh.client.query(extensionQueries.installed)).rows, sourceEquivalenceClaimed: false };
    for (const [name, expectedOid, expectedDatabase, expectedCatalog, expectedObjects] of [
      [providerBaselineDatabase, 16396, freshBootstrapBaseline.apiDatabase, freshBootstrapBaseline.apiCatalog, actual.bound.databases.neondb.objectsSha256],
      [managementDatabase, 32768, freshBootstrapBaseline.managementDatabase, freshBootstrapBaseline.managementCatalog, actual.bound.databases[managementDatabase].objectsSha256]
    ]) {
      const selected = await context.open(name); const retained = await snapshot(selected.client);
      requireValue(selected.identity.database_oid === expectedOid && retained.database.sha256 === expectedDatabase &&
        retained.extensionProfile.sha256 === expectedCatalog && hash(retained.objects) === expectedObjects && retained.globals?.count === 0,
      'RETAINED_BASELINE_OR_MANAGEMENT_CHANGED');
      await context.close(selected.client);
    }
    evidence.status = 'PASS'; evidence.phase = 'original_085_complete';
    evidence.limitations = ['A new original-SQL QA bootstrap, not a G24/native restore or Production DR proof.',
      'No G24 rows/ledger/receipt are imported. Original migrations086–098 remain separately gated.',
      '061 attests the reviewed immutable application source revision for this isolated QA profile; it is not a Production deployment attestation.'];
    await saveEvidence(evidence); return evidence;
  } catch (error) {
    evidence.status = 'FAIL'; evidence.failureCode = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message || '') ? error.message : 'FRESH_BOOTSTRAP_STEP_FAILED';
    if (/^[A-Z0-9]{5}$/u.test(error.code || '')) evidence.sqlState = error.code;
    await saveEvidence(evidence); throw new Error(evidence.failureCode);
  } finally { await context.closeAll(); }
}
