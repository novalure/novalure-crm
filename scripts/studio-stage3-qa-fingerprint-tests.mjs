import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { captureQaDatabase, classifyQaRows, classifyAuthIdentityLinks, matchesOriginalOperatorSeed, originalOperatorSeed, validateTarget, catalogQueries, qaProject, sourceBranch, restoreProject, restoreBranch } from './lib/studio-stage3-qa-fingerprint.mjs';
import { renderNeon061Compatibility } from './lib/neon-061-compat.mjs';
const sql061 = readFileSync(new URL('../migrations/061_validate_and_activate_tenant_rls_pilot.sql', import.meta.url), 'utf8');
const prepared = renderNeon061Compatibility(sql061);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const source = { mode: 'source', projectId: qaProject, branchId: sourceBranch, databaseName: 'qa_g24_pr63_20260917_r3', roleName: 'neondb_owner' };
const restored = { mode: 'restore', projectId: restoreProject, branchId: restoreBranch, databaseName: 'neondb', roleName: 'neondb_owner' };
const manifest = [{ number: 41, name: '041_schema_ledger_baseline.sql', version: '041_schema_ledger_baseline', checksum: 'a'.repeat(64) },
  { number: 61, name: '061_validate_and_activate_tenant_rls_pilot.sql', version: '061_validate_and_activate_tenant_rls_pilot', checksum: prepared.sourceChecksum }];
const ledger = manifest.map((item) => ({ version: item.version, name: item.name, checksum: item.checksum, applied_at: '2026-09-17T15:46:00.000Z' }));
const receipts = [{ id: 'receipt-id', source_version: manifest[1].version, source_checksum: prepared.sourceChecksum,
  executed_sql_checksum: prepared.executedSqlChecksum, target: { projectId: qaProject, branchId: sourceBranch, databaseName: source.databaseName },
  catalog_evidence: { secretSentinel: 'PRIVATE_CONTENT_NOT_FOR_REPORT' } }];
function fakeClient({ target = source, rows = [{ id: 'contact-id', name: 'SYNTHETIC buyer', email: 'test@example.invalid' }],
  receiptRows = receipts, ledgerRows = ledger, identityOverride = {}, catalogOverride = {} } = {}) {
  const calls = [];
  return { calls, async query(sql, args) {
    calls.push(sql);
    if (sql.includes("current_setting('transaction_read_only')")) return { rows: [{ project: target.projectId, branch: target.branchId,
      database: target.databaseName, role: target.roleName, session_role: target.roleName, read_only: 'on', ...identityOverride }] };
    if (sql === 'select to_regclass($1) as relation') return { rows: [{ relation: args[0] }] };
    if (sql.startsWith('select version,name,checksum,applied_at')) return { rows: ledgerRows };
    if (sql.startsWith('select * from public.novalure_migration_execution_receipts')) return { rows: receiptRows };
    if (sql.startsWith('select to_jsonb')) return { rows: rows.map((row) => ({ canonical: JSON.stringify(row) })) };
    const kind = Object.keys(catalogQueries).find((key) => catalogQueries[key] === sql);
    if (kind) return { rows: catalogOverride[kind] || (kind === 'tables' ? [{ relname: 'contacts', relkind: 'r' }] :
      kind === 'namespaces' ? [{ nspname: 'public', owner: 'neondb_owner' }] : []) };
    return { rows: [] };
  } };
}
test('only the exact G24 source and exact new G27 target are admissible', () => {
  assert.equal(validateTarget(source), source); assert.equal(validateTarget(restored), restored);
  for (const target of [{ ...source, projectId: 'misty-cloud-70835427' }, { ...source, databaseName: 'neondb' },
    { ...source, branchId: 'br-unclassified-source' }, { ...restored, branchId: 'br-dry-thunder-awmimouk' },
    { ...restored, projectId: qaProject }, { ...restored, roleName: 'novalure_app' }, { ...restored, databaseName: 'bad;sql' }]) assert.throws(() => validateTarget(target));
});
test('verified read-only capture emits hashes rather than private row/catalog/receipt content', async () => {
  const rows = [{ id: 'private-person-id', name: 'Private actual name', email: 'private-person@example.ie', nested: { access_token: 'PRIVATE_ACCESS_TOKEN' } }];
  const client = fakeClient({ rows });
  const result = await captureQaDatabase({ client, target: source, manifest, sql061 });
  assert.equal(client.calls[0], 'begin isolation level repeatable read read only'); assert.equal(client.calls.at(-1), 'rollback');
  assert.ok(client.calls.every((sql) => /^(?:select|set local|begin|rollback)\b/iu.test(sql)));
  assert.equal(result.classification.markerChecks, 'REVIEW_REQUIRED'); assert.equal(result.ledger.completeCanonicalCoverage, true);
  assert.equal(result.executionReceipts.original061Verified, true);
  const output = JSON.stringify(result);
  for (const secret of ['private-person-id', 'Private actual name', 'private-person@example.ie', 'PRIVATE_ACCESS_TOKEN', 'PRIVATE_CONTENT_NOT_FOR_REPORT']) assert.ok(!output.includes(secret));
  assert.equal(result.data.fingerprints[0].sha256, hash(JSON.stringify(rows[0]) + '\n'));
});
test('wrong connected identity fails before catalog or data access', async () => {
  for (const identityOverride of [{ project: 'production' }, { branch: 'wrong' }, { database: 'wrong' }, { role: 'wrong' }, { session_role: 'wrong' }, { read_only: 'off' }]) {
    const client = fakeClient({ identityOverride });
    await assert.rejects(captureQaDatabase({ client, target: source, manifest, sql061 }), /CONNECTED_QA_READONLY_IDENTITY_MISMATCH/u);
    assert.equal(client.calls.at(-1), 'rollback'); assert.ok(!client.calls.includes(catalogQueries.tables));
  }
});
test('native source/restore preserves DB schema ledger receipts and exact row digests across distinct projects', async () => {
  const before = await captureQaDatabase({ client: fakeClient(), target: source, manifest, sql061 });
  const after = await captureQaDatabase({ client: fakeClient({ target: restored }), target: restored, manifest, sql061 });
  for (const category of ['schema', 'ledger', 'executionReceipts', 'data']) assert.equal(before[category].sha256, after[category].sha256);
  assert.equal(after.executionReceipts.original061Verified, true);
});
test('different data is detected despite identical counts', async () => {
  const before = await captureQaDatabase({ client: fakeClient(), target: source, manifest, sql061 });
  const after = await captureQaDatabase({ client: fakeClient({ rows: [{ id: 'contact-id', name: 'SYNTHETIC changed buyer', email: 'test@example.invalid' }] }), target: source, manifest, sql061 });
  assert.equal(before.data.rows, after.data.rows); assert.notEqual(before.data.sha256, after.data.sha256);
});
test('fabricated checksums or compatibility receipts remain unverified', async () => {
  const badLedger = await captureQaDatabase({ client: fakeClient({ ledgerRows: [{ ...ledger[0], checksum: 'f'.repeat(64) }, ledger[1]] }), target: source, manifest, sql061 });
  assert.equal(badLedger.ledger.verifiedCommittedChecksums, false);
  const badReceipt = await captureQaDatabase({ client: fakeClient({ receiptRows: [{ ...receipts[0], executed_sql_checksum: 'f'.repeat(64) }] }), target: source, manifest, sql061 });
  assert.equal(badReceipt.executionReceipts.original061Verified, false);
});
test('cluster roles are separate while ACL and enum changes affect DB schema fingerprints', async () => {
  const before = await captureQaDatabase({ client: fakeClient(), target: source, manifest, sql061 });
  const roles = await captureQaDatabase({ client: fakeClient({ catalogOverride: { roles: [{ rolname: 'extra_provider_role' }] } }), target: source, manifest, sql061 });
  assert.equal(before.schema.sha256, roles.schema.sha256); assert.notEqual(before.schema.clusterRolesSha256, roles.schema.clusterRolesSha256);
  for (const category of ['relationGrants', 'enums']) {
    const changed = await captureQaDatabase({ client: fakeClient({ catalogOverride: { [category]: [{ changed: true }] } }), target: source, manifest, sql061 });
    assert.notEqual(before.schema.sha256, changed.schema.sha256);
  }
});
test('unknown schemas/tables and limited classification remain explicit', async () => {
  const client = fakeClient({ catalogOverride: { namespaces: [{ nspname: 'public' }, { nspname: 'unknown_business' }], tables: [{ relname: 'unknown_business_table', relkind: 'r' }] } });
  const result = await captureQaDatabase({ client, target: source, manifest, sql061 });
  assert.equal(result.classification.markerChecks, 'REVIEW_REQUIRED');
  assert.deepEqual(result.classification.unclassifiedSchemas, ['unknown_business']);
  assert.deepEqual(result.classification.unclassifiedTables, ['unknown_business_table']);
  assert.ok(result.limitations.some((text) => text.includes('not a complete PII')));
  assert.equal(classifyQaRows('workspace_users', [{ name: 'SYNTHETIC QA', email: 'test@example.invalid' }]).contactExceptions, 0);
});

test('ledger and receipt timestamps remain part of canonical fingerprints', async () => {
  const a = await captureQaDatabase({ client: fakeClient({ ledgerRows: ledger.map((row) => ({ ...row, applied_at: new Date('2026-09-17T00:00:00Z') })) }), target: source, manifest, sql061 });
  const b = await captureQaDatabase({ client: fakeClient({ ledgerRows: ledger.map((row) => ({ ...row, applied_at: new Date('2026-09-18T00:00:00Z') })) }), target: source, manifest, sql061 });
  assert.notEqual(a.ledger.sha256, b.ledger.sha256);
});
test('only the exact original migration036 operator seed is exempt from contact marker exceptions', () => {
  const row = { ...originalOperatorSeed, id: 'opaque-id', created_at: 'date', updated_at: 'date', approved_at: 'date' };
  assert.equal(matchesOriginalOperatorSeed(row), true);
  assert.equal(classifyQaRows('company_profiles', [row]).contactExceptions, 0);
  for (const changed of [{ ...row, public_email: 'customer@example.ie' }, { ...row, registration_number: 'other' },
    { ...row, profile_scope: 'crm_account' }, { ...row, api_key: 'private-extra' }, { ...row, brand: { businessName: 'Different' } }]) {
    assert.equal(matchesOriginalOperatorSeed(changed), false);
    assert.ok(classifyQaRows('company_profiles', [changed]).unknownMarkers > 0);
  }
  assert.ok(classifyQaRows('company_profiles', [row, row]).unknownMarkers > 0);
});
test('exactly three synthetic users must map one to one to their own auth identities and emails', () => {
  const users = [1, 2, 3].map((id) => ({ name: 'SYNTHETIC user', email: 'test' + id + '@example.invalid', auth_identity_id: String(id) }));
  const identities = users.map((user) => ({ id: user.auth_identity_id, normalized_email: user.email, display_email: user.email }));
  assert.equal(classifyAuthIdentityLinks(identities, users).status, 'PASS');
  for (const changed of [[...identities, { id: '4' }], identities.slice(0, 2),
    identities.map((row, index) => index ? row : { ...row, normalized_email: 'other@example.invalid' })]) {
    assert.equal(classifyAuthIdentityLinks(changed, users).status, 'FAIL');
  }
});
