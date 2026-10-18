#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getCACertificates } from 'node:tls';
import pg from 'pg';
import { assertRepositoryCommitted } from './db-migrate.mjs';
import { sourceTarget } from './lib/studio-stage3-qa-restore.mjs';
import { capturePrepareTargetPreflight, prepareSelectedQaTarget } from './lib/studio-stage3-qa-prepare-target.mjs';
const requireValue = (value, code) => { if (!value) throw new Error(code); };
async function privatePath(input, existing = true) {
  const base = await realpath(path.resolve('.npm-cache/qa'));
  const candidate = existing ? await realpath(path.resolve(input)) : path.join(await realpath(path.dirname(path.resolve(input))), path.basename(input));
  const relative = path.relative(base, candidate);
  requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'IGNORED_PRIVATE_QA_PATH_REQUIRED');
  execFileSync('git', ['check-ignore', '--quiet', candidate], { stdio: 'ignore' }); return candidate;
}
async function main() {
  const mode = process.argv[4];
  requireValue(process.argv.length === 5 && ['--preflight', '--run-authorized-prepare'].includes(mode), 'EXPLICIT_PREPARE_MODE_REQUIRED');
  const headCommit = assertRepositoryCommitted();
  const config = JSON.parse(await readFile(await privatePath(process.argv[2]), 'utf8'));
  const output = await privatePath(process.argv[3], false);
  const uri = new URL((await readFile(await privatePath(config.targetUriFile), 'utf8')).trim());
  requireValue(['postgres:', 'postgresql:'].includes(uri.protocol) && uri.username === 'neondb_owner' && uri.password &&
    uri.hostname === config.targetHost && uri.hostname.endsWith('.neon.tech') && !uri.hostname.includes('-pooler.') &&
    (!uri.port || uri.port === '5432') && uri.pathname === '/neondb' && !uri.hash &&
    [...uri.searchParams.keys()].every((key) => ['sslmode', 'channel_binding'].includes(key)), 'PINNED_PRIVATE_PREPARE_URI_REQUIRED');
  const inventory = JSON.parse(await readFile(await privatePath(config.approvedSourceReport), 'utf8'));
  const sourceReport = inventory.databases?.find((entry) => entry.databaseName === sourceTarget.databaseName);
  requireValue(sourceReport, 'APPROVED_SOURCE_REPORT_REQUIRED');
  const ca = getCACertificates('default').concat(getCACertificates('system')).join('\n');
  const connect = async (database) => {
    const client = new pg.Client({ host: uri.hostname, port: 5432, user: 'neondb_owner', password: decodeURIComponent(uri.password),
      database, connectionTimeoutMillis: 15000, query_timeout: 35000, ssl: { rejectUnauthorized: true, ca } });
    try { await client.connect(); return client; } catch (error) { await client.end(); throw error; }
  };
  if (mode === '--preflight') {
    const client = await connect('neondb');
    try {
      const preflight = await capturePrepareTargetPreflight(client, sourceReport);
      await writeFile(output, JSON.stringify({ format: 'studio-stage3-prepare-target-plan-v1', headCommit, capturedAt: new Date().toISOString(), preflight }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ status: 'PREFLIGHT_READ_ONLY', sha256: preflight.sha256, databaseWrites: 0 }));
    } finally { await client.end(); }
    return;
  }
  const reviewed = JSON.parse(await readFile(await privatePath(config.approvedPreflightFile), 'utf8'));
  const age = Date.now() - Date.parse(reviewed.capturedAt);
  requireValue(reviewed.format === 'studio-stage3-prepare-target-plan-v1' && reviewed.headCommit === headCommit &&
    Number.isFinite(age) && age >= -60000 && age <= 3600000, 'EXACT_RECENT_REVIEWED_PREPARE_PLAN_REQUIRED');
  // Reserve a new evidence file before opening a mutable run. Existing evidence
  // and partially completed attempts are never overwritten or resumed.
  await writeFile(output, '', { flag: 'wx', mode: 0o600 });
  const evidence = await prepareSelectedQaTarget({ connect, sourceReport, approvedPreflight: reviewed.preflight,
    saveEvidence: (value) => writeFile(output, JSON.stringify({ ...value, headCommit }, null, 2) + '\n', { mode: 0o600 }) });
  console.log(JSON.stringify({ status: evidence.status, steps: evidence.steps, sourceWrites: 0, aclChanges: 0, drops: 0, restoreExecuted: false }));
}
main().catch((error) => {
  const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message || '') ? error.message : 'PREPARE_TARGET_FAILED';
  console.error(JSON.stringify({ status: 'FAIL', code })); process.exitCode = 1;
});
