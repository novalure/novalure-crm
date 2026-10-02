import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../config/masterplan-sync.json', import.meta.url), 'utf8'));
if (manifest.schemaVersion !== 2) {
  throw new Error(`MASTERPLAN_MANIFEST_SCHEMA_UNSUPPORTED schemaVersion=${manifest.schemaVersion}`);
}
if (manifest.authoritativeRepository !== 'novalure/evelyn'
    || manifest.authoritativePath !== 'docs/masterplan/novalure-ai-workforce-masterplan-v1.md'
    || manifest.localPath !== 'docs/masterplan/novalure-ai-workforce-masterplan-v1.md') {
  throw new Error('MASTERPLAN_AUTHORITY_MISMATCH');
}

const masterplanUrl = new URL(`../${manifest.localPath}`, import.meta.url);
const contents = await readFile(masterplanUrl);
const normalizedContents = Buffer.from(contents.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const digest = createHash('sha256').update(normalizedContents).digest('hex');

if (digest !== manifest.sha256) {
  throw new Error(`MASTERPLAN_SYNC_MISMATCH expected=${manifest.sha256} actual=${digest}`);
}

const text = normalizedContents.toString('utf8');
if (!text.includes(`Autonomy and access framework:** \`${manifest.frameworkVersion}\``)) {
  throw new Error(`MASTERPLAN_FRAMEWORK_VERSION_MISSING version=${manifest.frameworkVersion}`);
}

for (const invariant of [
  'TARGET_IDENTITY_PASS',
  'QUALITY_PASS',
  'SECURITY_ISOLATION_PASS',
  'CREDENTIAL_RUNTIME_PASS',
  'BACKUP_RESTORE_PASS',
  'ROLLOUT_ROLLBACK_PASS',
  'MONITORING_ABORT_PASS',
  'COST_SCOPE_PASS',
  'Developer authority is not business authority',
  'Current Neon Runtime credential-bootstrap boundary',
]) {
  if (!text.includes(invariant)) {
    throw new Error(`MASTERPLAN_REQUIRED_INVARIANT_MISSING invariant=${JSON.stringify(invariant)}`);
  }
}

if (!Array.isArray(manifest.requiredConsumers) || manifest.requiredConsumers.length === 0) {
  throw new Error('MASTERPLAN_REQUIRED_CONSUMERS_MISSING');
}
for (const consumer of manifest.requiredConsumers) {
  const consumerText = await readFile(new URL(`../${consumer}`, import.meta.url), 'utf8');
  if (!consumerText.includes(`2.0.0`)) {
    throw new Error(`MASTERPLAN_CONSUMER_VERSION_MISSING path=${consumer}`);
  }
}

console.log(`MASTERPLAN_SYNC_PASS version=${manifest.frameworkVersion} sha256=${digest} authority=${manifest.authoritativeRepository}:${manifest.authoritativePath} consumers=${manifest.requiredConsumers.length}`);
