import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../config/masterplan-sync.json', import.meta.url), 'utf8'));
const masterplanUrl = new URL(`../${manifest.localPath}`, import.meta.url);
const contents = await readFile(masterplanUrl);
const digest = createHash('sha256').update(contents).digest('hex');

if (digest !== manifest.sha256) {
  throw new Error(`MASTERPLAN_SYNC_MISMATCH expected=${manifest.sha256} actual=${digest}`);
}

const text = contents.toString('utf8');
if (!text.includes(`Autonomy and access framework:** \`${manifest.frameworkVersion}\``)) {
  throw new Error(`MASTERPLAN_FRAMEWORK_VERSION_MISSING version=${manifest.frameworkVersion}`);
}

console.log(`MASTERPLAN_SYNC_PASS version=${manifest.frameworkVersion} sha256=${digest} authority=${manifest.authoritativeRepository}:${manifest.authoritativePath}`);
