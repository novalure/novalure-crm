import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const crmCandidateFreeOrganization = 'org-cool-cloud-50864215';
export const crmCandidateSourceManifestSha256 = 'c6823ea7e096242923db1038975cb59d48974fac64fc8742a693a1310f358487';
const sourceBytes = readFileSync(new URL('../../config/crm-candidate-fresh-migrations.json', import.meta.url));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => value instanceof Date ? JSON.stringify(value.toISOString()) :
  value === null || typeof value !== 'object' ? JSON.stringify(value) :
    Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
      '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
export const digest = value => sha256(canonical(value));
const check = (condition, code) => assert.ok(condition, code);
check(sha256(sourceBytes.toString('utf8').replace(/\r\n/g, '\n')) === crmCandidateSourceManifestSha256,
  'CRM_QA_ORIGINAL_SOURCE_REGISTRY_CHANGED');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const sources = freeze(JSON.parse(sourceBytes));
check(sources.format === 'crm-candidate-original-migration-sources-v1' && sources.forward.length === 169 &&
  sources.staged087.length === 2, 'CRM_QA_ORIGINAL_SOURCE_REGISTRY_INVALID');
export const crmCandidateOriginalSources = Object.freeze(sources);
export const crmCandidateExecutionVariant = 'STANDALONE_100_WITHOUT_PREVIEW_097_098_099';
export const crmCandidateExecutionVariantSha256 = '5d102a9fbd3e0c5c67e77962bd820d3f2459cf30d3cb75c588c7193cf57c063a';
const variantBytes = readFileSync(new URL('../../config/crm-candidate-fresh-execution-variant.json', import.meta.url));
check(sha256(variantBytes.toString('utf8').replace(/\r\n/g, '\n')) === crmCandidateExecutionVariantSha256,
  'CRM_QA_EXECUTION_VARIANT_REGISTRY_CHANGED');
export const crmCandidateVariant = freeze(JSON.parse(variantBytes));
check(crmCandidateVariant.id === crmCandidateExecutionVariant &&
  crmCandidateVariant.sourceRegistrySha256 === crmCandidateSourceManifestSha256 &&
  crmCandidateVariant.excluded.length === 3, 'CRM_QA_EXECUTION_VARIANT_INVALID');
const incompatiblePreview = crmCandidateVariant.excluded.map(row => row.path);
const oldProjects = new Set(['misty-cloud-70835427', 'weathered-term-98273025', 'super-block-59791927', 'green-thunder-49879900']);
const shaPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const hostPattern = /^ep-[a-z0-9-]+\.(?:[a-z0-9-]+\.)+neon\.tech$/;
const descriptorKeys = ['format', 'status', 'sourceRevision', 'organizationId', 'plan', 'projectId', 'branchId', 'branchParentId', 'endpointId',
  'projectCreatedAt', 'directHost', 'pooledHost', 'databaseName', 'runtimeRole', 'migrationRole',
  'productionDirectHost', 'productionPooledHost', 'nativeCreationReceiptSha256'];

/** Nonsecret owner-reviewed descriptor, not a provider attestation or a caller-selected production target. */
export function validateCrmCandidateDescriptor(value, { expectedDigest, headCommit, now = Date.now() }) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...descriptorKeys].sort().join(',') &&
    descriptorKeys.filter(key => key !== 'branchParentId').every(key => typeof value[key] === 'string') &&
    value.branchParentId === null, 'CRM_QA_DESCRIPTOR_SHAPE');
  check(shaPattern.test(expectedDigest || '') && digest(value) === expectedDigest, 'CRM_QA_DESCRIPTOR_DIGEST');
  check(revisionPattern.test(headCommit || '') && value.sourceRevision === headCommit,
    'CRM_QA_DESCRIPTOR_REVISION');
  check(value.format === 'crm-candidate-free-target-v1' && value.status === 'NATIVE_NEW_FREE_PROJECT_AUTHORIZED' &&
    value.organizationId === crmCandidateFreeOrganization && value.plan === 'free', 'CRM_QA_NEW_FREE_TARGET_REQUIRED');
  check(typeof value.projectId === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(value.projectId) &&
    !oldProjects.has(value.projectId) && /^br-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value.branchId || '') &&
    /^ep-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value.endpointId || ''), 'CRM_QA_NEW_PROJECT_IDENTITY');
  const age = now - Date.parse(value.projectCreatedAt);
  check(Number.isFinite(age) && age >= 0 && age <= 86_400_000, 'CRM_QA_NEW_PROJECT_AGE');
  check(value.databaseName === 'neondb' && value.runtimeRole === 'novalure_app' && value.migrationRole === 'neondb_owner',
    'CRM_QA_EXACT_DATABASE_ROLES');
  check(hostPattern.test(value.directHost || '') && !value.directHost.includes('-pooler.') &&
    value.pooledHost === value.directHost.replace('.', '-pooler.') &&
    value.directHost.split('.')[0] === value.endpointId && hostPattern.test(value.productionDirectHost || '') &&
    !value.productionDirectHost.includes('-pooler.') &&
    value.productionPooledHost === value.productionDirectHost.replace('.', '-pooler.') &&
    value.directHost !== value.productionDirectHost && value.pooledHost !== value.productionPooledHost,
  'CRM_QA_EXACT_DISTINCT_HOSTS');
  check(shaPattern.test(value.nativeCreationReceiptSha256 || ''), 'CRM_QA_NATIVE_CREATION_REFERENCE_REQUIRED');
  return Object.freeze(structuredClone(value));
}

export function crmCandidateTarget(descriptor) {
  return { projectId: descriptor.projectId, branchId: descriptor.branchId, databaseName: descriptor.databaseName,
    runtimeRole: descriptor.runtimeRole };
}

/** Every SQL input must be the full original immutable source, including both013 and both108. */
export function createCrmCandidateManifest(files, stagedFiles, headCommit) {
  check(revisionPattern.test(headCommit || ''), 'CRM_QA_SOURCE_REVISION_REQUIRED');
  const capture = (provided, expected) => {
    check(Array.isArray(provided) && provided.length === expected.length &&
      new Set(provided.map(row => row.path)).size === expected.length, 'CRM_QA_SQL_FILE_COVERAGE');
    return expected.map(row => {
      const input = provided.find(item => item.path === row.path);
      check(input && typeof input.content === 'string', 'CRM_QA_SQL_FILE_MISSING');
      const content = input.content.replace(/\r\n/g, '\n');
      check(sha256(content) === row.sha256, 'CRM_QA_ORIGINAL_SQL_CHANGED');
      const version = row.path.split('/').at(-1).replace(/\.sql$/, '');
      return Object.freeze({ path: row.path, file: version + '.sql', version, number: Number(version.slice(0, 3)),
        name: version.slice(4), checksum: row.sha256, manual: row.manual === true, content });
    });
  };
  const forward = capture(files, sources.forward);
  const staged087 = capture(stagedFiles, sources.staged087);
  const excluded = forward.filter(row => incompatiblePreview.includes(row.path));
  check(excluded.length === 3 && excluded.every(row => row.manual), 'CRM_QA_EXACT_PREVIEW_EXCLUSION_REQUIRED');
  const selected = forward.filter(row => !incompatiblePreview.includes(row.path));
  check(selected.length === 166 && selected.filter(row => row.number >= 41).length === 125, 'CRM_QA_STANDALONE_VARIANT_COUNTS');
  const early = forward.filter(row => row.number <= 85);
  check(early.length === 83 && forward.filter(row => row.number < 41).length === 41 &&
    forward.filter(row => row.number >= 41).length === 128, 'CRM_QA_SQL_COUNTS_CHANGED');
  const media = early.splice(early.findIndex(row => row.number === 62), 1)[0];
  early.splice(early.findIndex(row => row.number === 60), 0, media);
  const bound = { format: 'crm-candidate-original-migration-manifest-v1', headCommit,
    sourceRegistrySha256: crmCandidateSourceManifestSha256,
    executionVariant: crmCandidateExecutionVariant,
    executionVariantSha256: crmCandidateExecutionVariantSha256,
    excluded: excluded.map(({ path, checksum }) => ({ path, checksum, execution: 'NOT_EXECUTED_INCOMPATIBLE_PREVIEW_VARIANT' })),
    forward: forward.map(({ path, checksum, manual }) => ({ path, checksum, manual })),
    staged087: staged087.map(({ path, checksum }) => ({ path, checksum })), earlyOrder: early.map(row => row.version) };
  return freeze({ ...bound, sha256: digest(bound), forward: Object.freeze(forward), selected: Object.freeze(selected), early: Object.freeze(early),
    explicit: Object.freeze(selected.filter(row => row.number > 85 && row.number <= 120)),
    standard: Object.freeze(selected.filter(row => row.number > 120)), staged087: Object.freeze(staged087) });
}

export function validateCrmCandidatePlan(plan, { descriptor, descriptorDigest, manifest, headCommit, now = Date.now() }) {
  validateCrmCandidateDescriptor(descriptor, { expectedDigest: descriptorDigest, headCommit, now });
  const age = now - Date.parse(plan?.capturedAt);
  check(plan?.format === 'crm-candidate-fresh-plan-v1' && Number.isFinite(age) && age >= 0 && age <= 3_600_000 &&
    plan.bound?.headCommit === headCommit && plan.bound.descriptorDigest === descriptorDigest &&
    plan.bound.manifestDigest === manifest.sha256 && digest(plan.bound) === plan.sha256 &&
    digest(plan.bound.target) === digest(crmCandidateTarget(descriptor)), 'CRM_QA_EXACT_RECENT_PLAN_REQUIRED');
  return plan;
}
