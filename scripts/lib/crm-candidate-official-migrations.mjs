import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyMigration, applyCommittedMigrationPlan, assertMigrationPlanCommitted, assertRepositoryCommitted,
  createMigrationPlan, createMigrationPlanToken, migrationExecutionProfile, readLedger, readMigrations, validateMigrationPlan,
} from '../db-migrate.mjs';
import { assertConnectedDatabaseTarget } from './infra-targets.mjs';
import { crmCandidateExecutionVariant, sha256, validateCrmCandidateDescriptor } from './crm-candidate-fresh-manifest.mjs';

const check = (condition, code) => assert.ok(condition, code);
export function crmCandidateMetadataEnvironment(descriptor) {
  return {
    MIGRATION_TARGET: 'test', NOVALURE_QA_PROJECT_ID: descriptor.projectId, POSTGRES_NEON_PROJECT_ID: descriptor.projectId,
    NOVALURE_QA_PROJECT_FINGERPRINT: '', NOVALURE_QA_BRANCH_ID: descriptor.branchId,
    NOVALURE_QA_DATABASE_NAME: descriptor.databaseName, NOVALURE_QA_DATABASE_ROLE: descriptor.runtimeRole,
    NOVALURE_QA_MIGRATION_DATABASE_ROLE: descriptor.migrationRole,
    NOVALURE_QA_DATABASE_HOST: descriptor.pooledHost, NOVALURE_QA_MIGRATION_DATABASE_HOST: descriptor.directHost,
    NOVALURE_PRODUCTION_DATABASE_HOST: descriptor.productionPooledHost,
    NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST: descriptor.productionDirectHost,
  };
}

/** A metadata-only, testable composition of the actual official planner and token guards. */
export function planCrmCandidateOfficialStep({ connectedTarget, migrations, ledgerRows, migration, headCommit, descriptor, cwd }) {
  check(!migration || !['097_studio_sales_calendar_bridge', '098_studio_enquiry_handoff', '099_studio_enquiry_public_launch']
    .includes(migration.version), 'CRM_QA_INCOMPATIBLE_PREVIEW_VARIANT');
  check(!ledgerRows.some(row => ['097_studio_sales_calendar_bridge', '098_studio_enquiry_handoff', '099_studio_enquiry_public_launch']
    .includes(row.version)), 'CRM_QA_PREVIEW_ALREADY_INSTALLED');
  const plan = createMigrationPlan({ allowManualCutover: migration?.manual === true, ledgerRows, migrations,
    only: migration?.version || '' });
  validateMigrationPlan({ ledgerRows, migrations, plan, cwd });
  const expected = migration ? [migration] : migrations.filter(row => !row.rollback && row.number > 120 &&
    !ledgerRows.some(applied => applied.version === row.version));
  check(plan.length === expected.length && plan.every((row, index) => row.version === expected[index].version &&
    row.checksum === expected[index].checksum), 'CRM_QA_OFFICIAL_UNEXPECTED_PLAN');
  const executionProfile = migrationExecutionProfile({ runtimeRole: descriptor.runtimeRole,
    hostFingerprint: sha256(descriptor.directHost).slice(0, 16), transport: 'pg' });
  return { plan, executionProfile, token: createMigrationPlanToken({ connectedTarget, executionProfile, headCommit, ledgerRows, plan }) };
}

/** No CLI subprocess, credential environment variable or duplicate SQL executor. */
export function createCrmCandidateOfficialRunner({ client, descriptor, descriptorDigest, manifest, headCommit, planDirectory, journal,
  repository = process.cwd() }) {
  let ordinal = 0;
  return async migration => {
    validateCrmCandidateDescriptor(descriptor, { expectedDigest: descriptorDigest, headCommit });
    check(manifest.executionVariant === crmCandidateExecutionVariant, 'CRM_QA_EXECUTION_VARIANT');
    check(assertRepositoryCommitted({ cwd: repository }) === headCommit && path.resolve(process.cwd()) === path.resolve(repository),
      'CRM_QA_OFFICIAL_SOURCE_CHANGED');
    const env = crmCandidateMetadataEnvironment(descriptor);
    const capture = async () => {
      const connectedTarget = await assertConnectedDatabaseTarget({ client, connectionMode: 'direct',
        minimumServerVersionNum: 170000, purpose: 'CRM candidate original migration', target: 'test', env });
      const migrations = readMigrations();
      const forward = migrations.filter(row => !row.rollback);
      check(forward.length === manifest.forward.length && forward.every(row => manifest.forward.some(original =>
        original.version === row.version && original.checksum === row.checksum && original.manual === row.manualCutover)),
      'CRM_QA_OFFICIAL_ORIGINAL_SOURCE_CHANGED');
      const ledger = await readLedger(client);
      return { connectedTarget, ...planCrmCandidateOfficialStep({ connectedTarget, migrations, ledgerRows: ledger.rows,
        migration, headCommit, descriptor, cwd: repository }) };
    };
    await client.query("set search_path=public; set lock_timeout='5s'; set statement_timeout='14min'; set transaction_timeout='15min'");
    const actualPath = (await client.query("select current_setting('search_path') path,current_schema() schema")).rows[0];
    check(actualPath?.path === 'public' && actualPath.schema === 'public', 'CRM_QA_OFFICIAL_SEARCH_PATH');
    check((await client.query('select pg_try_advisory_lock(941041) acquired')).rows[0]?.acquired === true,
      'CRM_QA_OFFICIAL_MIGRATION_BUSY');
    try {
      const before = await capture();
      assertMigrationPlanCommitted({ cwd: repository, plan: before.plan });
      const name = `official-plan-${String(++ordinal).padStart(3, '0')}.json`;
      const relative = path.relative(repository, path.resolve(planDirectory));
      check(path.isAbsolute(planDirectory) && relative.startsWith('..' + path.sep), 'CRM_QA_PLAN_OUTSIDE_REPOSITORY_REQUIRED');
      await writeFile(path.join(planDirectory, name), JSON.stringify({ format: 'crm-candidate-official-in-process-plan-v1',
        headCommit, descriptorDigest, token: before.token, connectedTarget: before.connectedTarget,
        executionProfile: before.executionProfile, plan: before.plan.map(row => ({ version: row.version, checksum: row.checksum })) }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
      await journal({ event: 'OFFICIAL_PLAN_CAPTURED', planFile: name, token: before.token });
      // Re-read the real target, complete ledger, actual Git files and source revision immediately before applying.
      const immediatelyBefore = await capture();
      check(assertRepositoryCommitted({ cwd: repository }) === headCommit && immediatelyBefore.token === before.token,
        'CRM_QA_OFFICIAL_PLAN_CHANGED');
      await applyCommittedMigrationPlan({ cwd: repository, plan: immediatelyBefore.plan,
        apply: row => applyMigration(client, row, { headCommit, planToken: before.token,
          runtimeRole: descriptor.runtimeRole, connectedTarget: immediatelyBefore.connectedTarget }) });
      await journal({ event: 'OFFICIAL_PLAN_ACKNOWLEDGED', token: before.token });
    } finally { await client.query('select pg_advisory_unlock(941041)'); }
  };
}
