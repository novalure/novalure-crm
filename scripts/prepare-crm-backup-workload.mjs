#!/usr/bin/env node
/** Package only the existing backup runner for its dedicated Vercel project.
 * No credentials, application source, Git history, provider calls or deployment.
 */
import { mkdir, copyFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultCrmBackupConfig } from './lib/crm-full-backup.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const files = Object.freeze([
  'package.json', 'package-lock.json',
  'scripts/crm-full-backup.mjs',
  'scripts/lib/crm-full-backup.mjs',
  'scripts/lib/crm-full-backup-providers.mjs',
  'scripts/lib/crm-full-backup-http.mjs',
  'scripts/lib/studio-stage3-qa-fingerprint.mjs',
  'scripts/lib/neon-061-compat.mjs',
]);

export async function prepareCrmBackupWorkload(output, { enableCron = false } = {}) {
  if (typeof output !== 'string' || !path.isAbsolute(output) || typeof enableCron !== 'boolean') throw new Error('EXPLICIT_ABSOLUTE_WORKLOAD_DIRECTORY_REQUIRED');
  const parent = await realpath(path.dirname(output));
  const target = path.join(parent, path.basename(output));
  const root = await realpath(repository);
  if (target === root || target.startsWith(root + path.sep)) throw new Error('WORKLOAD_MUST_BE_OUTSIDE_APPLICATION_REPOSITORY');
  // Existing output directories are never reused or overwritten.
  await mkdir(target, { mode: 0o700 });
  for (const relative of files) {
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, relative), destination);
  }
  await mkdir(path.join(target, 'api'));
  await writeFile(path.join(target, 'api/backup.mjs'),
    "import { createCrmBackupHttpHandler } from '../scripts/lib/crm-full-backup-http.mjs';\nexport const GET = createCrmBackupHttpHandler();\n");
  await writeFile(path.join(target, 'vercel.json'), JSON.stringify({
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null, buildCommand: '', installCommand: 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund',
    regions: ['fra1'], functions: { 'api/backup.mjs': { maxDuration: 800 } },
    crons: enableCron ? [{ path: '/api/backup', schedule: '15 3 * * *' }] : [],
  }, null, 2) + '\n');
  await mkdir(path.join(target, '.vercel'));
  await writeFile(path.join(target, '.vercel/project.json'), JSON.stringify({
    projectId: defaultCrmBackupConfig.backupProjectId, orgId: defaultCrmBackupConfig.teamId,
  }, null, 2) + '\n');
  return { status: 'PACKAGED_NOT_DEPLOYED', projectId: defaultCrmBackupConfig.backupProjectId,
    copiedFiles: files.length, cronIncluded: enableCron, secretsCopied: 0, providerCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args[0] !== '--output' || (args.length > 2 && (args.length !== 3 || args[2] !== '--enable-cron'))) throw new Error('USAGE_OUTPUT_DIRECTORY_AND_OPTIONAL_ENABLE_CRON_REQUIRED');
    console.log(JSON.stringify(await prepareCrmBackupWorkload(args[1], { enableCron: args.includes('--enable-cron') })));
  } catch (error) {
    console.error(JSON.stringify({ status: 'NOT_DEPLOYED', code: typeof error?.code === 'string' ? error.code : error.message }));
    process.exitCode = 1;
  }
}
