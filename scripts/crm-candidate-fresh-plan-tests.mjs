import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCrmCandidateManifest, crmCandidateOriginalSources, crmCandidateTarget, digest,
  validateCrmCandidateDescriptor, validateCrmCandidatePlan } from './lib/crm-candidate-fresh-manifest.mjs';
import { loadCrmCandidateCommittedManifest, validateCrmCandidatePrivateInput } from './crm-candidate-fresh-bootstrap.mjs';
import { planCrmCandidateOfficialStep, crmCandidateMetadataEnvironment } from './lib/crm-candidate-official-migrations.mjs';
import { completeCrmCandidateFreshSchema } from './lib/crm-candidate-fresh-bootstrap.mjs';

const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const now = Date.now();
// Explicitly synthetic descriptor data. No native project or creation receipt exists in this test.
const descriptor = {
  format: 'crm-candidate-free-target-v1', status: 'NATIVE_NEW_FREE_PROJECT_AUTHORIZED', sourceRevision: headCommit,
  organizationId: 'org-cool-cloud-50864215', plan: 'free', projectId: 'synthetic-fresh-project-12345678',
  branchId: 'br-synthetic-fresh-12345678', branchParentId: null, endpointId: 'ep-synthetic-fresh-12345678',
  projectCreatedAt: new Date(now).toISOString(), directHost: 'ep-synthetic-fresh-12345678.eu-central-1.aws.neon.tech',
  pooledHost: 'ep-synthetic-fresh-12345678-pooler.eu-central-1.aws.neon.tech', databaseName: 'neondb',
  runtimeRole: 'novalure_app', migrationRole: 'neondb_owner', productionDirectHost: 'ep-synthetic-prod-12345678.eu-central-1.aws.neon.tech',
  productionPooledHost: 'ep-synthetic-prod-12345678-pooler.eu-central-1.aws.neon.tech', nativeCreationReceiptSha256: 'b'.repeat(64),
};
const files = crmCandidateOriginalSources.forward.map(row => ({ path: row.path, content: readFileSync(row.path, 'utf8') }));
const staged = crmCandidateOriginalSources.staged087.map(row => ({ path: row.path, content: readFileSync(row.path, 'utf8') }));
const manifest = createCrmCandidateManifest(files, staged, headCommit);
const descriptorDigest = digest(descriptor);
const plan = () => {
  const bound = { headCommit, descriptorDigest, manifestDigest: manifest.sha256, target: crmCandidateTarget(descriptor), syntheticCatalog: true };
  return { format: 'crm-candidate-fresh-plan-v1', capturedAt: new Date(now).toISOString(), bound, sha256: digest(bound) };
};

test('historical061 module imports and renders independently without any new CRM registry or helper', async () => {
  const root = path.resolve('.npm-cache/qa');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'crm-061-independent-'));
  const filename = path.join(directory, 'neon-061-compat.mjs');
  await writeFile(filename, readFileSync('scripts/lib/neon-061-compat.mjs'), { flag: 'wx' });
  const standalone = await import(pathToFileURL(filename).href);
  const source = files.find(row => row.path === 'migrations/061_validate_and_activate_tenant_rls_pilot.sql').content;
  assert.equal(standalone.renderNeon061Compatibility(source).sourceChecksum,
    manifest.forward.find(row => row.number === 61).checksum);
  await assert.rejects(standalone.applyNeon061Compatibility({}), /exact runner commit and plan digest/);
  // Own test output is intentionally retained; no tracked source was renamed or removed.
});

test('exact169-file inventory; standalone166-execution/125-ledger variant and83 early originals with only062 reordered', () => {
  const actual = loadCrmCandidateCommittedManifest(headCommit);
  assert.equal(actual.sha256, manifest.sha256);
  assert.equal(actual.forward.length, 169); assert.equal(actual.early.length, 83);
  assert.equal(actual.forward.filter(row => row.number >= 41).length, 128);
  assert.equal(actual.selected.length, 166);
  assert.equal(actual.selected.filter(row => row.number >= 41).length, 125);
  assert.deepEqual(actual.excluded.map(row => row.path), ['migrations/097_studio_sales_calendar_bridge.sql',
    'migrations/098_studio_enquiry_handoff.sql', 'migrations/099_studio_enquiry_public_launch.sql']);
  assert.ok(actual.excluded.every(row => row.execution === 'NOT_EXECUTED_INCOMPATIBLE_PREVIEW_VARIANT'));
  assert.ok(Object.isFrozen(actual.excluded) && actual.excluded.every(Object.isFrozen));
  assert.equal(actual.forward.filter(row => row.number === 13).length, 2);
  assert.equal(actual.forward.filter(row => row.number === 108).length, 2);
  assert.equal(actual.early[actual.early.findIndex(row => row.number === 60) - 1].number, 62);
  assert.ok(actual.explicit.find(row => row.number === 95).manual);
  assert.ok(actual.explicit.find(row => row.number === 120).manual);
  assert.ok(actual.standard.some(row => row.number === 199));
  assert.deepEqual(actual.staged087.map(row => row.path), staged.map(row => row.path));
});

test('missing, duplicate, extra, changed originals or changed staged source fail before execution', () => {
  const variants = [files.slice(1), [...files, files[0]], [...files.slice(1), files[1]],
    files.map((row, index) => index === 0 ? { ...row, content: row.content + '\n-- altered' } : row)];
  for (const variant of variants) assert.throws(() => createCrmCandidateManifest(variant, staged, headCommit));
  assert.throws(() => createCrmCandidateManifest(files, staged.slice(1), headCommit));
  assert.throws(() => createCrmCandidateManifest(files, staged.map(row => ({ ...row, content: row.content + '-- changed' })), headCommit));
  // Worktree CRLF is normalized exactly as the original official ledger contract.
  assert.equal(createCrmCandidateManifest(files.map(row => ({ ...row, content: row.content.replace(/\r?\n/g, '\r\n') })), staged, headCommit).sha256, manifest.sha256);
});

test('owner-reviewed new Free descriptor has exact digest/source/identity and no credentials', () => {
  assert.deepEqual(validateCrmCandidateDescriptor(descriptor, { expectedDigest: descriptorDigest, headCommit, now }), descriptor);
  const cases = [
    { status: 'PENDING_NATIVE_PROJECT' }, { organizationId: 'org-divine-silence-19529003' }, { plan: 'launch' },
    ...['misty-cloud-70835427', 'weathered-term-98273025', 'super-block-59791927', 'green-thunder-49879900'].map(projectId => ({ projectId })),
    { branchParentId: 'br-production-parent' }, { directHost: descriptor.productionDirectHost, pooledHost: descriptor.productionPooledHost },
    { pooledHost: descriptor.directHost }, { endpointId: 'ep-foreign-endpoint-12345678' }, { databaseName: 'other_db' },
    { runtimeRole: 'neondb_owner' }, { migrationRole: 'novalure_app' }, { sourceRevision: 'c'.repeat(40) },
    { projectCreatedAt: new Date(now - 86_400_001).toISOString() }, { projectCreatedAt: new Date(now + 1).toISOString() },
    { nativeCreationReceiptSha256: 'PENDING' }, { password: 'synthetic-not-a-secret' },
  ];
  for (const change of cases) {
    const altered = { ...descriptor, ...change };
    assert.throws(() => validateCrmCandidateDescriptor(altered, { expectedDigest: digest(altered), headCommit, now }));
  }
  assert.throws(() => validateCrmCandidateDescriptor(descriptor, { expectedDigest: 'd'.repeat(64), headCommit, now }));
});

test('private recent plan rejects revision, catalog, descriptor, target, SQL, age and digest drift', () => {
  assert.equal(validateCrmCandidatePlan(plan(), { descriptor, descriptorDigest, manifest, headCommit, now }).sha256, plan().sha256);
  for (const altered of [
    { ...plan(), capturedAt: new Date(now - 3_600_001).toISOString() },
    { ...plan(), capturedAt: new Date(now + 1).toISOString() }, { ...plan(), sha256: 'a'.repeat(64) },
    { ...plan(), bound: { ...plan().bound, headCommit: 'c'.repeat(40) } },
    { ...plan(), bound: { ...plan().bound, syntheticCatalog: 'changed' } },
    { ...plan(), bound: { ...plan().bound, target: { ...plan().bound.target, databaseName: 'foreign' } } },
    { ...plan(), bound: { ...plan().bound, descriptorDigest: 'c'.repeat(64) } },
    { ...plan(), bound: { ...plan().bound, manifestDigest: 'c'.repeat(64) } },
  ]) assert.throws(() => validateCrmCandidatePlan(altered, { descriptor, descriptorDigest, manifest, headCommit, now }));
});

test('private stdin accepts only exact direct owner URL and80-hex runtime password; never an env credential', () => {
  const url = `postgresql://neondb_owner:synthetic-password@${descriptor.directHost}/neondb?sslmode=verify-full`;
  assert.equal(validateCrmCandidatePrivateInput({ migrationDatabaseUrl: url }, descriptor, '--preflight').url.hostname, descriptor.directHost);
  assert.equal(validateCrmCandidatePrivateInput({ migrationDatabaseUrl: url, runtimePassword: 'a'.repeat(80) }, descriptor, '--apply').runtimePassword.length, 80);
  for (const changed of [url.replace(descriptor.directHost, descriptor.pooledHost), url.replace('/neondb?', '/other?'),
    url.replace('neondb_owner:', 'novalure_app:'), url.replace('verify-full', 'disable'), url + '&options=-csearch_path=foreign',
    url + '&sslmode=verify-full', url.replace(descriptor.directHost, descriptor.productionDirectHost)]) {
    assert.throws(() => validateCrmCandidatePrivateInput({ migrationDatabaseUrl: changed }, descriptor, '--preflight'));
  }
  assert.throws(() => validateCrmCandidatePrivateInput({ migrationDatabaseUrl: url, runtimePassword: "'; invalid" }, descriptor, '--apply'));
  assert.throws(() => validateCrmCandidatePrivateInput({ migrationDatabaseUrl: url, environment: {} }, descriptor, '--preflight'));
  assert.ok(!JSON.stringify(crmCandidateMetadataEnvironment(descriptor)).includes('postgresql://'));
});

const ledgerRow = row => ({ version: row.version, name: row.name, checksum: row.checksum, number: row.number });
test('official planner preserves explicit manual predecessors and tokens bind full source/ledger/target', () => {
  const connectedTarget = { projectId: descriptor.projectId, branchId: descriptor.branchId, databaseName: 'neondb',
    roleName: 'neondb_owner', serverVersionNum: 180000, target: 'test' };
  const official = manifest.forward.map(row => ({ ...row, rollback: false, manualCutover: row.manual }));
  const chosen = manifest.explicit.find(row => row.number === 96);
  const preceding = manifest.forward.filter(row => row.number >= 41 && row.number < 96).map(ledgerRow);
  const input = { connectedTarget, migrations: official, ledgerRows: preceding, migration: chosen, headCommit, descriptor, cwd: process.cwd() };
  const a = planCrmCandidateOfficialStep(input);
  assert.deepEqual(a.plan.map(row => row.version), ['096_public_integration_gateway']);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, migration: { ...chosen, manual: false } }), /manual cutover/);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, ledgerRows: preceding.filter(row => row.number !== 95) }), /predecessor/);
  const other = planCrmCandidateOfficialStep({ ...input, connectedTarget: { ...connectedTarget, branchId: 'br-synthetic-different' } });
  assert.notEqual(other.token, a.token);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, ledgerRows: [...preceding, ledgerRow(chosen)] }), /UNEXPECTED_PLAN/);
  const preview = manifest.forward.find(row => row.number === 97);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, migration: preview }), /INCOMPATIBLE_PREVIEW_VARIANT/);
  assert.throws(() => planCrmCandidateOfficialStep({ ...input, ledgerRows: [...preceding, ledgerRow(preview)] }), /PREVIEW_ALREADY_INSTALLED/);
});

test('synthetic orchestration only: all086–201 and actual staged source identities retained; failures do not claim full success', async () => {
  const initial = manifest.early.filter(row => row.number >= 41).map(ledgerRow);
  const rows = [...initial], events = [], calls = [], stageSql = [];
  const client = { async query(query) {
    if (query === 'select version,name,checksum from public.novalure_schema_migrations order by version') return { rows };
    if (query === manifest.staged087[0].content) { stageSql.push(query); return { rows: [{ crm_d11_backfill_batch: { remaining: { synthetic: 0 } } }] }; }
    if (query === manifest.staged087[1].content) { stageSql.push(query); return { rows: [] }; }
    assert.ok(['begin', 'commit', 'rollback'].includes(query)); return { rows: [] };
  } };
  const earlyResult = { status: 'PASS_NEW_NATIVE_EARLY_SCHEMA_THROUGH_085', headCommit, manifestDigest: manifest.sha256 };
  const runOfficial = async row => { calls.push(row?.version || 'STANDARD'); rows.push(...(row ? [row] : manifest.standard).map(ledgerRow)); };
  const result = await completeCrmCandidateFreshSchema({ client, manifest, earlyResult, runOfficial, journal: async event => events.push(event) });
  assert.equal(result.ledger.rows, 125); assert.equal(result.forwardSqlFiles, 166);
  assert.equal(result.sourceInventorySqlFiles, 169); assert.equal(result.excluded.length, 3);
  assert.equal(result.productionReadiness, false); assert.equal(result.applicationAcceptance, 'PENDING_EXISTING_MANUAL_QA');
  assert.equal(calls.length, manifest.explicit.length + 1); assert.equal(stageSql.length, 2);
  assert.deepEqual(result.staged087.map(row => row.checksum), manifest.staged087.map(row => row.checksum));
  assert.equal(events.filter(row => row.event === 'COMPLETE_SCHEMA_VERIFIED').length, 1);
  rows.splice(0, rows.length, ...initial);
  const failedEvents = [];
  await assert.rejects(completeCrmCandidateFreshSchema({ client, manifest, earlyResult,
    runOfficial: async () => { throw new Error('SYNTHETIC_OFFICIAL_FAILURE'); }, journal: async event => failedEvents.push(event) }));
  assert.equal(failedEvents.some(row => row.event === 'COMPLETE_SCHEMA_VERIFIED'), false);
});
