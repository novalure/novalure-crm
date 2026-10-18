#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getCACertificates } from 'node:tls';
import pg from 'pg';
import { captureQaDatabase, qaProject, restoreProject, validateTarget } from './lib/studio-stage3-qa-fingerprint.mjs';
const fail = (condition, code) => { if (!condition) throw new Error(code); };
const digest = (text) => createHash('sha256').update(text.replace(/\r\n/gu, '\n')).digest('hex');
async function privatePath(input, existing = true) {
  const base = await realpath(path.resolve('.npm-cache/qa'));
  const candidate = existing ? await realpath(path.resolve(input)) : path.join(await realpath(path.dirname(path.resolve(input))), path.basename(input));
  const relative = path.relative(base, candidate);
  fail(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'IGNORED_QA_PATH_REQUIRED');
  execFileSync('git', ['check-ignore', '--quiet', candidate], { stdio: 'ignore' }); return candidate;
}
async function main() {
  fail(process.argv.length === 4, 'USAGE_CONFIG_AND_NEW_REPORT_PATH_REQUIRED');
  const config = JSON.parse(await readFile(await privatePath(process.argv[2]), 'utf8'));
  const outputPath = await privatePath(process.argv[3], false);
  fail(Array.isArray(config.databases) && config.databases.length > 0 && config.databases.length <= 12 &&
    new Set(config.databases).size === config.databases.length, 'BOUNDED_EXPLICIT_DATABASES_REQUIRED');
  const targets = config.databases.map((databaseName) => validateTarget({ mode: config.mode, projectId: config.mode === 'restore' ? restoreProject : qaProject,
    branchId: config.branchId, databaseName, roleName: 'neondb_owner' }));
  const uri = new URL((await readFile(await privatePath(config.uriFile), 'utf8')).trim());
  fail(['postgres:', 'postgresql:'].includes(uri.protocol) && uri.hostname.endsWith('.neon.tech') &&
    !uri.hostname.includes('-pooler.') && uri.username === 'neondb_owner' &&
    (!uri.port || uri.port === '5432') && uri.password && uri.hostname === config.expectedHost, 'DIRECT_QA_OWNER_URI_REQUIRED');
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const headCommit = git(['rev-parse', 'HEAD']).trim();
  const files = git(['ls-tree', '-r', '--name-only', 'HEAD', 'migrations']).trim().split(/\r?\n/u)
    .filter((name) => /^migrations\/\d{3}_.+\.sql$/u.test(name) && !name.includes('_rollback'));
  const manifest = files.map((name) => ({ name: path.basename(name), version: path.basename(name, '.sql'),
    number: Number(path.basename(name).slice(0, 3)), checksum: digest(git(['show', 'HEAD:' + name])) }));
  const sql061 = git(['show', 'HEAD:migrations/061_validate_and_activate_tenant_rls_pilot.sql']);
  const databases = [];
  for (const target of targets) {
    const client = new pg.Client({ host: uri.hostname, port: 5432, user: 'neondb_owner', password: decodeURIComponent(uri.password),
      database: target.databaseName, connectionTimeoutMillis: 15000, query_timeout: 35000,
      ssl: { rejectUnauthorized: true, ca: getCACertificates('default').concat(getCACertificates('system')).join('\n') } });
    try { await client.connect(); databases.push(await captureQaDatabase({ client, target, manifest, sql061 })); }
    finally { await client.end(); }
  }
  await writeFile(outputPath, JSON.stringify({ format: 'studio-stage3-qa-readonly-inventory-v4',
    capturedAt: new Date().toISOString(), headCommit, productionAccess: 0, databaseWrites: 0, databases }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'CAPTURED_READ_ONLY', databases: databases.map((item) => ({
    databaseName: item.databaseName, tables: item.data.tables, rows: item.data.rows, ledgerRows: item.ledger.rows,
    through: item.ledger.through, markers: item.classification.markerChecks, original061Verified: item.executionReceipts.original061Verified,
    server: item.extensionProfile.server, extensions: item.extensionProfile.extensions
  })) }));
}
main().catch((error) => {
  const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message || '') ? error.message : 'READ_ONLY_CAPTURE_FAILED';
  console.error(JSON.stringify({ status: 'FAIL', code })); process.exitCode = 1;
});
