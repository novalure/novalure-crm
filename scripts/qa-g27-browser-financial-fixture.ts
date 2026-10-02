import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import type { AppSession } from '../src/lib/auth/session';
import type { TenantPool } from '../src/lib/db/tenant-client';
import { registerFinancialPolicyVersion, getFinancialSnapshot, type ContractFinancialPolicySelection } from '../src/lib/db/financial-snapshot-repositories';
import { createEvelynContractActionV2 } from '../src/lib/db/evelyn-contract-v2-repositories';
import type { FinancialPolicyPayload } from '../src/lib/financial-snapshot';
import { financialSnapshotHash } from '../src/lib/evelyn-money-tax-v2';

// Only a fixture driver for the browser's ephemeral loopback database. Never a web route.
async function main() {
const [mode, offerId] = process.argv.slice(2);
assert.ok(['prepare', 'verify', 'change-current-values'].includes(mode));
assert.match(offerId, /^[a-f0-9-]{36}$/);
assert.equal(process.env.NODE_ENV, 'test');
for (const key of ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL']) assert.equal(process.env[key], undefined);
const context = JSON.parse(await readFile('.npm-cache/qa/sales-browser-context.json', 'utf8'));
assert.equal(context.syntheticOnly, true); assert.equal(context.database.host, '127.0.0.1');
assert.equal(new URL(context.baseUrl).hostname, '127.0.0.1');
const admin = new pg.Pool({ ...context.database, user: 'qa_admin' });
const runtime = new pg.Pool({ ...context.database });
const file = '.npm-cache/qa/g27-browser-financial.json';
try {
  assert.equal((await admin.query("select inet_server_addr() in ('127.0.0.1'::inet,'::1'::inet) local")).rows[0].local, true);
  const user = (await admin.query('select id,auth_identity_id from workspace_users where id=$1 and workspace_id=$2', [context.userId, context.workspaceId])).rows[0];
  assert.ok(user);
  const auth = (await admin.query('select id,created_at from auth_sessions where workspace_user_id=$1 and workspace_id=$2 and revoked_at is null and expires_at>now() order by created_at desc limit 1', [context.userId, context.workspaceId])).rows[0];
  assert.ok(auth, 'A real UI-created authenticated session must already exist');
  const session = { authenticated: true, userId: context.userId, workspaceId: context.workspaceId, workspaceName: 'SYNTHETIC SALES QA', email: context.email, name: 'Synthetic sales owner', role: 'owner', permissions: ['crm:read', 'crm:write'], productRole: 'novalureAdmin', productPermissions: ['pipeline:write', 'settings:manage', 'novalure:internal'], source: 'database', authIdentityId: user.auth_identity_id, authSessionId: auth.id, sessionCreatedAt: auth.created_at } as AppSession;
  const options = { pool: runtime as unknown as TenantPool };
  const offer = (await admin.query('select id,version,deal_id from crm_offers where id=$1 and workspace_id=$2 and project_id=$3 and status=\'ACCEPTED\'', [offerId, context.workspaceId, context.projectId])).rows[0];
  assert.ok(offer, 'Only the actually accepted browser offer is eligible');
  const instant = new Date().toISOString();
  const register = async (kind: string, payload: FinancialPolicyPayload, version = '1') => {
    const policyId = 'SYNTHETIC:browser:' + kind;
    await registerFinancialPolicyVersion(session, { projectId: context.projectId, policyId, policyVersion: version, payload, sourceReference: payload.kind === 'TAX' ? payload.sourceProvenance.sourceReference : 'SYNTHETIC browser authority', verifiedAt: payload.kind === 'CURRENCY' ? payload.verifiedAt : instant, idempotencyKey: randomUUID(), correlationId: randomUUID() }, options);
    return { id: policyId, version };
  };
  const tax = (version: string, numerator: string): FinancialPolicyPayload => ({ policySchemaVersion: 'crm-tax-policy-v1', kind: 'TAX', jurisdiction: 'AT:SYNTHETIC', treatment: 'SYNTHETIC browser', category: 'SYNTHETIC', rate: { basis: 'NET', numerator, denominator: '5' }, sourceProvenance: { authority: 'SYNTHETIC browser authority', sourceReference: 'SYNTHETIC:browser:tax-source', jurisdiction: 'AT:SYNTHETIC', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, policyVersion: version, verifiedAt: instant } });
  if (mode === 'prepare') {
    const currency = await register('currency', { policySchemaVersion: 'crm-currency-policy-v1', kind: 'CURRENCY', standard: 'ISO-4217', code: 'EUR', minorUnitExponent: 2, verifiedAt: instant });
    const rounding = await register('rounding', { policySchemaVersion: 'crm-rounding-policy-v1', kind: 'ROUNDING', mode: 'HALF_EVEN', currencyExponent: 2, scope: 'TAX_COMPONENT' });
    const taxReference = await register('tax', tax('1', '1'));
    const selection: ContractFinancialPolicySelection = { jurisdiction: 'AT:SYNTHETIC', currencyPolicy: currency, roundingPolicy: rounding, taxPolicies: [{ componentId: 'vat', policy: taxReference }] };
    const pending = (await admin.query("select id,snapshot_hash,canonical_snapshot from crm_financial_snapshots where workspace_id=$1 and resource_type='OFFER' and resource_id=$2 and review_state='NEEDS_REVIEW' order by business_version desc limit 1", [context.workspaceId, offerId])).rows[0];
    assert.ok(pending, 'The real acceptance transition must create immutable pending evidence');
    assert.equal(financialSnapshotHash(pending.canonical_snapshot), pending.snapshot_hash);
    await admin.query('insert into crm_evelyn_preview_targets(workspace_id,project_id,evelyn_tenant_id) values($1,$2,$1)', [context.workspaceId, context.projectId]);
    const foreignWorkspaceId = randomUUID();
    await admin.query("insert into workspaces(id,name,operating_model,setup_state) values($1,'SYNTHETIC G27 browser foreign','novalure_internal','{}')", [foreignWorkspaceId]);
    await writeFile(file, JSON.stringify({ syntheticOnly: true, offerId, projectId: context.projectId, pendingId: pending.id, pendingHash: pending.snapshot_hash, selection, foreignWorkspaceId }));
  } else {
    const state = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(state.offerId, offerId); assert.equal(state.projectId, context.projectId);
    if (mode === 'verify') {
      const noRemote = async (): Promise<never> => { throw new Error('No remote transport allowed in local browser fixture'); };
      const v2Options = { ...options, testOnly: { target: { workspaceId: context.workspaceId, projectId: context.projectId, tenantId: context.workspaceId }, client: { requestApprovalV2: noRemote, verifyApprovalV2: noRemote } } };
      const input = { operation: 'create' as const, approvalContractVersion: 'v2' as const, projectId: context.projectId, offerId, expectedOfferVersion: Number(offer.version), policySelection: state.selection, idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const denied = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
      await assert.rejects(createEvelynContractActionV2(session, { ...input, policySelection: { ...state.selection, taxPolicies: [{ componentId: 'missing', policy: { id: 'SYNTHETIC:missing-tax', version: '1' } }] } }, v2Options), denied('UNKNOWN_FINANCIAL_POLICY'));
      await assert.rejects(createEvelynContractActionV2(session, { ...input, expectedOfferVersion: Number(offer.version) - 1, idempotencyKey: randomUUID() }, v2Options), denied('VERSION_MISMATCH'));
      const created = await createEvelynContractActionV2(session, { ...input, idempotencyKey: randomUUID() }, v2Options);
      const snapshot = await getFinancialSnapshot(session, created.data.financialSnapshotId, options);
      assert.equal(snapshot.reviewState, 'VERIFIED'); assert.equal(snapshot.snapshot.reviewState, 'COMPLETE');
      assert.equal(financialSnapshotHash(snapshot.snapshot), snapshot.snapshotHash);
      assert.equal(snapshot.snapshot.totals.net?.minorUnits, '990000');
      assert.equal(snapshot.snapshot.totals.tax?.minorUnits, '198000');
      assert.equal(snapshot.snapshot.totals.gross?.minorUnits, '1188000');
      Object.assign(state, { verifiedId: snapshot.id, verifiedHash: snapshot.snapshotHash, actionId: created.data.actionId, missingTaxDenied: true, staleVersionDenied: true, actualApprovalV2Preparation: true, remoteApprovalVerified: false });
      await writeFile(file, JSON.stringify(state));
    } else {
      const before = await getFinancialSnapshot(session, state.verifiedId, options);
      await admin.query('update deals set value_cents=value_cents+100 where id=$1 and workspace_id=$2', [offer.deal_id, context.workspaceId]);
      await register('tax', tax('2', '2'), '2');
      const after = await getFinancialSnapshot(session, state.verifiedId, options);
      assert.deepEqual(after, before); assert.equal(after.snapshotHash, state.verifiedHash);
      state.historicalUnchanged = true; await writeFile(file, JSON.stringify(state));
    }
  }
  console.log(JSON.stringify({ mode, status: 'PASS', syntheticOnly: true, remoteCalls: 0 }));
} finally { await Promise.allSettled([admin.end(), runtime.end()]); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
