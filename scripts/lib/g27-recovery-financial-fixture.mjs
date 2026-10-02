import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withCrmRead } from '../../src/lib/crm-command.ts';
import { registerFinancialPolicyVersion, resolveLegacyFinancialSnapshot } from '../../src/lib/db/financial-snapshot-repositories.ts';
import { savePropertyCostItems } from '../../src/lib/db/property-department-repositories.ts';

/** Exact isolated QA target; real runtime repositories create all financial authority. */
export async function seedRecoveryFinancialFixture(admin, runtime) {
  const fp = (await admin.query("select current_setting('neon.project_id',true) project,current_setting('neon.branch_id',true) branch,current_database() database")).rows[0];
  assert.deepEqual(fp, { project: 'super-block-59791927', branch: 'br-summer-breeze-awuzinct', database: 'qa_g27_20260923' });
  assert.equal((await admin.query('select count(*)::int n from crm_financial_snapshots')).rows[0].n, 0);
  const { rows: [scope] } = await admin.query("select w.id workspace,p.id project,u.id actor,u.auth_identity_id from workspaces w join projects p on p.workspace_id=w.id join workspace_users u on u.workspace_id=w.id where w.name='SYNTHETIC G27 tenant A' and p.name='SYNTHETIC granted project' and u.email='g27-owner@example.invalid'");
  assert.ok(scope);
  const session = { authenticated: true, userId: scope.actor, workspaceId: scope.workspace, workspaceName: 'SYNTHETIC G27 tenant A', email: 'g27-owner@example.invalid', name: 'SYNTHETIC owner', role: 'owner', permissions: ['crm:read','crm:write'], productRole: 'customer_owner', productPermissions: ['settings:manage','workspace:operate','pipeline:write'], source: 'database', authIdentityId: scope.auth_identity_id };
  const options = { pool: runtime };
  return withCrmRead(session, async (tx, fresh) => {
    const instant = new Date().toISOString();
    const payloads = [
      { policySchemaVersion: 'crm-currency-policy-v1', kind: 'CURRENCY', standard: 'ISO-4217', code: 'EUR', minorUnitExponent: 2, verifiedAt: instant },
      { policySchemaVersion: 'crm-rounding-policy-v1', kind: 'ROUNDING', mode: 'HALF_EVEN', currencyExponent: 2, scope: 'TAX_COMPONENT' },
      { policySchemaVersion: 'crm-tax-policy-v1', kind: 'TAX', jurisdiction: 'AT:SYNTHETIC', treatment: 'SYNTHETIC recovery only', category: 'SYNTHETIC', rate: { basis: 'NET', numerator: '1', denominator: '5' }, sourceProvenance: { authority: 'SYNTHETIC recovery authority', sourceReference: 'SYNTHETIC:G27:recovery:tax', jurisdiction: 'AT:SYNTHETIC', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, policyVersion: '1', verifiedAt: instant } },
    ];
    const policies = [];
    for (const payload of payloads) {
      const id = 'SYNTHETIC:G27:recovery:' + payload.kind.toLowerCase();
      const result = await registerFinancialPolicyVersion(fresh, { projectId: scope.project, policyId: id, policyVersion: '1', payload, sourceReference: payload.sourceProvenance?.sourceReference ?? 'SYNTHETIC:G27:recovery', verifiedAt: instant, idempotencyKey: randomUUID(), correlationId: randomUUID() }, options);
      policies.push({ id, version: '1', contentHash: result.data.contentHash });
    }
    const property = randomUUID();
    await tx.execute("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm,market_value_cents,target_price_cents) values($1,$2,$3,'SYNTHETIC G27 recovery property','SYNTHETIC','Wien','apartment',50,0,0)", [property,scope.workspace,scope.project]);
    const saved = await savePropertyCostItems({ session: fresh, propertyId: property, projectId: scope.project, idempotencyKey: randomUUID(), correlationId: randomUUID(), costItems: [{ costKey: 'recovery', groupKey: 'monthly', label: 'SYNTHETIC recovery cost', monthlyGrossCents: '1188000', monthlyNetCents: '990000', monthlyVatCents: '198000', oneTimeGrossCents: '0', oneTimeNetCents: '0', oneTimeVatCents: '0', vatPercent: '20' }] }, options);
    assert.equal(saved.persisted, true);
    const selection = { jurisdiction: 'AT:SYNTHETIC', currencyPolicy: { id: policies[0].id, version: '1' }, roundingPolicy: { id: policies[1].id, version: '1' }, taxPolicies: [{ componentId: 'vat', policy: { id: policies[2].id, version: '1' } }] };
    const verified = await resolveLegacyFinancialSnapshot(fresh, { projectId: scope.project, priorSnapshotId: saved.data.snapshotId, expectedPriorSnapshotHash: saved.data.snapshotHash, policySelection: selection, reviewDecision: 'VERIFY_EVIDENCED_NET', idempotencyKey: randomUUID(), correlationId: randomUUID() }, options);
    assert.equal(verified.data.reviewState, 'VERIFIED');
    assert.equal(verified.data.snapshot.totals.net.minorUnits, '990000');
    assert.equal(verified.data.snapshot.totals.tax.minorUnits, '198000');
    assert.equal(verified.data.snapshot.totals.gross.minorUnits, '1188000');
    const pending = await tx.queryOne('select review_state from crm_financial_snapshots where id=$1', [saved.data.snapshotId]);
    assert.equal(pending.review_state, 'NEEDS_REVIEW');
    return { syntheticOnly: true, actualRuntimeRepositories: true, complete: { id: verified.data.id, hash: verified.data.snapshotHash }, needsReview: { id: saved.data.snapshotId, hash: saved.data.snapshotHash }, policies };
  }, options);
}
