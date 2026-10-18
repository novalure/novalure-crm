import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { captureQaDatabase, captureDatabaseMetadata, databaseQueries, extensionQueries, sourceExtensions, classifyQaRows, classifyAuthIdentityLinks, matchesOriginalOperatorSeed, originalOperatorSeed, validateTarget, catalogQueries, qaProject, sourceBranch, restoreProject, restoreBranch } from './lib/studio-stage3-qa-fingerprint.mjs';
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
const databaseProperties = { owner: 'neondb_owner', encoding: 'UTF8', collation: 'C.UTF-8', ctype: 'C.UTF-8',
  locale_provider: 'c', locale: null, icu_rules: null, collation_version: null,
  allow_connections: true, is_template: false, connection_limit: -1 };
const databaseAcl = [{ grantee: 'PUBLIC', grantor: 'neondb_owner', privilege_type: 'CONNECT', is_grantable: false },
  { grantee: 'PUBLIC', grantor: 'neondb_owner', privilege_type: 'TEMPORARY', is_grantable: false },
  { grantee: 'neondb_owner', grantor: 'neondb_owner', privilege_type: 'CREATE', is_grantable: false }];
function fakeClient({ target = source, rows = [{ id: 'contact-id', name: 'SYNTHETIC buyer', email: 'test@example.invalid' }],
  receiptRows = receipts, ledgerRows = ledger, identityOverride = {}, catalogOverride = {}, databaseOverride = {}, extensionOverride = {} } = {}) {
  const calls = [];
  return { calls, async query(sql, args) {
    calls.push(sql);
    if (sql.includes("current_setting('transaction_read_only')")) return { rows: [{ project: target.projectId, branch: target.branchId,
      database: target.databaseName, role: target.roleName, session_role: target.roleName, read_only: 'on', ...identityOverride }] };
    if (sql === 'select to_regclass($1) as relation') return { rows: [{ relation: args[0] }] };
    if (sql.startsWith('select version,name,checksum,applied_at')) return { rows: ledgerRows };
    if (sql.startsWith('select * from public.novalure_migration_execution_receipts')) return { rows: receiptRows };
    if (sql.startsWith('select to_jsonb')) return { rows: rows.map((row) => ({ canonical: JSON.stringify(row) })) };
    const databaseKind = Object.keys(databaseQueries).find((key) => databaseQueries[key] === sql);
    if (databaseKind) return { rows: databaseOverride[databaseKind] || (databaseKind === 'properties' ? [databaseProperties] : databaseKind === 'acl' ? databaseAcl : []) };
    const extensionKind = Object.keys(extensionQueries).find((key) => extensionQueries[key] === sql);
    if (extensionKind) return { rows: extensionOverride[extensionKind] || (extensionKind === 'server'
      ? [{ version: target.mode === 'source' ? '17.11' : '18.6', version_num: target.mode === 'source' ? 170011 : 180006 }]
      : extensionKind === 'installed' ? [sourceExtensions[0], { name: 'plpgsql', version: '1.0', schema: 'pg_catalog', owner: 'cloud_admin' }, sourceExtensions[1]] : []) };
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
  assert.ok(client.calls.every((sql) => /^(?:select|set local|begin|rollback)\b/iu.test(sql) || [extensionQueries.members, extensionQueries.privileges].includes(sql)));
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
  for (const category of ['database', 'schema', 'ledger', 'executionReceipts', 'data']) assert.equal(before[category].sha256, after[category].sha256);
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
test('only exact migration036 plus mandatory078 approval revocation is exempt from contact marker exceptions', () => {
  const row = { ...originalOperatorSeed, id: 'opaque-id', created_at: 'date', updated_at: 'date', approved_at: null };
  assert.equal(matchesOriginalOperatorSeed(row), true);
  assert.equal(classifyQaRows('company_profiles', [row]).contactExceptions, 0);
  for (const changed of [{ ...row, public_email: 'customer@example.ie' }, { ...row, registration_number: 'other' },
    { ...row, profile_scope: 'crm_account' }, { ...row, status: 'approved' }, { ...row, approved_at: '2026-01-01T00:00:00Z' }, { ...row, api_key: 'private-extra' }, { ...row, brand: { businessName: 'Different' } }]) {
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

test('current database owner effective ACL and normalized hashed settings participate in fingerprints', async () => {
  const secret = 'postgresql://PRIVATE_DATABASE_SETTING_SECRET';
  const settings = [{ database_scope: 'CURRENT_DATABASE', role_name: 'ALL_ROLES', setting: 'app.secret=' + secret }];
  const first = await captureDatabaseMetadata(fakeClient({ databaseOverride: { settings } }));
  assert.equal(first.owner, 'neondb_owner'); assert.deepEqual(first.acl, databaseAcl);
  assert.ok(!JSON.stringify(first).includes(secret)); assert.equal(first.settings[0].name, 'app.secret');
  assert.equal(first.settings[0].valueSha256, hash(secret));
  for (const databaseOverride of [
    { properties: [{ ...databaseProperties, owner: 'other_owner' }] },
    { acl: databaseAcl.filter((row) => row.privilege_type !== 'CONNECT') },
    { acl: databaseAcl.filter((row) => row.privilege_type !== 'CREATE') },
    { settings: [{ ...settings[0], setting: 'app.secret=different' }] }
  ]) {
    const changed = await captureDatabaseMetadata(fakeClient({ databaseOverride }));
    assert.notEqual(first.sha256, changed.sha256);
  }
  const empty = await captureDatabaseMetadata(fakeClient());
  const explicitDefault = await captureDatabaseMetadata(fakeClient({ databaseOverride: { acl: [...databaseAcl] } }));
  assert.equal(empty.sha256, explicitDefault.sha256, 'Effective privileges, not raw null-versus-explicit storage, are compared');
});
test('the current pinned database must actually be owned by neondb_owner', async () => {
  const client = fakeClient({ databaseOverride: { properties: [{ ...databaseProperties, owner: 'other_owner' }] } });
  await assert.rejects(captureQaDatabase({ client, target: source, manifest, sql061 }), /PINNED_DATABASE_OWNER_REQUIRED/u);
  assert.ok(!client.calls.includes(catalogQueries.tables));
});
test('extension profile records actual server versions without hiding extension version structure or ACL drift', async () => {
  const before = await captureQaDatabase({ client: fakeClient(), target: source, manifest, sql061 });
  const after = await captureQaDatabase({ client: fakeClient({ target: restored }), target: restored, manifest, sql061 });
  assert.equal(before.extensionProfile.server.version_num, 170011);
  assert.equal(after.extensionProfile.server.version_num, 180006);
  assert.equal(before.extensionProfile.sha256, after.extensionProfile.sha256, 'Server versions are reported, not normalized into a false same-server claim');
  const changed = await captureQaDatabase({ client: fakeClient({ extensionOverride: { installed: [{ ...sourceExtensions[0], version: '1.4' }] } }), target: source, manifest, sql061 });
  assert.notEqual(before.extensionProfile.sha256, changed.extensionProfile.sha256);
  const aclChanged = await captureQaDatabase({ client: fakeClient({ extensionOverride: { privileges: [{ grantee: 'unexpected', privilege_type: 'EXECUTE' }] } }), target: source, manifest, sql061 });
  assert.notEqual(before.extensionProfile.sha256, aclChanged.extensionProfile.sha256);
  await assert.rejects(captureQaDatabase({ client: fakeClient({ extensionOverride: { members: [{ definition: null }] } }), target: source, manifest, sql061 }), /EXTENSION_MEMBER_CATALOG_UNSUPPORTED/u);
});
test('aggregate extension members use OID-free aggregate metadata and changing their transition is fingerprinted', async () => {
  const aggregate = { catalog: 'pg_proc', object_type: 'aggregate', schema: 'public', name: 'avg', identity: 'public.avg(public.vector)',
    definition: { owner: 'neondb_owner', kind: 'a', aggregate: { transition: 'public.vector_accum(double precision[],vector)', transition_type: 'double precision[]', final: 'public.vector_avg(double precision[])', initial_value: '{0,0,0}' } } };
  // pg_get_functiondef throws for aggregates. Its SQL branch must be guarded;
  // definitions are catalog metadata, never a synthesized CREATE FUNCTION string.
  assert.match(extensionQueries.members, /case when p\.prokind='a' then/u);
  assert.match(extensionQueries.members, /from pg_aggregate a where a\.aggfnoid=p\.oid/u);
  assert.match(extensionQueries.members, /else jsonb_build_object\('owner',pg_get_userbyid\(p\.proowner\),'definition',pg_get_functiondef\(p\.oid\)\) end/u);
  const capture = (member) => captureQaDatabase({ client: fakeClient({ extensionOverride: { members: [member] } }), target: source, manifest, sql061 });
  const before = await capture(aggregate);
  const changed = await capture({ ...aggregate, definition: { ...aggregate.definition, aggregate: { ...aggregate.definition.aggregate, transition: 'public.wrong_transition(vector)' } } });
  assert.equal(before.extensionProfile.memberCount, 1);
  assert.notEqual(before.extensionProfile.structureSha256, changed.extensionProfile.structureSha256);
  assert.notEqual(before.extensionProfile.sha256, changed.extensionProfile.sha256);
});
