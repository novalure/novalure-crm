#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdir, lstat, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getCACertificates } from 'node:tls';
import pg from 'pg';
import { assertRepositoryCommitted } from './db-migrate.mjs';
import { captureQaDatabase } from './lib/studio-stage3-qa-fingerprint.mjs';
import { restoreSelectedQa, sourceTarget, restoreTarget } from './lib/studio-stage3-qa-restore.mjs';
const requireValue = (value, code) => { if (!value) throw new Error(code); };
const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const digest = (value) => createHash('sha256').update(value).digest('hex');
async function privatePath(value, existing = true) {
  const base = await realpath(path.resolve('.npm-cache/qa'));
  const result = existing ? await realpath(path.resolve(value)) : path.join(await realpath(path.dirname(path.resolve(value))), path.basename(value));
  const relative = path.relative(base, result);
  requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'IGNORED_PRIVATE_QA_PATH_REQUIRED');
  execFileSync('git', ['check-ignore', '--quiet', result], { stdio: 'ignore' }); return result;
}
async function secureNewDirectory(directory) {
  try { await lstat(directory); throw new Error('NEW_PRIVATE_RUN_DIRECTORY_REQUIRED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(directory, { mode: 0o700 });
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return; }
  const command = "$ErrorActionPreference='Stop'; $p=$env:STUDIO_QA_PRIVATE_RUN_DIR; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($sid); foreach($who in @($sid,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($who,'FullControl','ContainerInherit, ObjectInherit','None','Allow'); $acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $p -AclObject $acl";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { env: { ...process.env, STUDIO_QA_PRIVATE_RUN_DIR: directory }, windowsHide: true, stdio: 'ignore' });
}
async function readUri(file, host, database) {
  const uri = new URL((await readFile(await privatePath(file), 'utf8')).trim());
  requireValue(['postgres:', 'postgresql:'].includes(uri.protocol) && uri.username === 'neondb_owner' && uri.password &&
    uri.hostname === host && host.endsWith('.neon.tech') && !host.includes('-pooler.') &&
    (!uri.port || uri.port === '5432') && uri.pathname === '/' + database, 'PINNED_PRIVATE_URI_REQUIRED');
  return uri;
}
function nativeCommand(executable, args, env, logPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', finished = false;
    const fail = (code) => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error(code)); } };
    const timer = setTimeout(() => { child.kill(); fail('NATIVE_PG_TOOL_TIMEOUT'); }, 180000);
    child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 262144) stderr += chunk; });
    child.once('error', () => fail('NATIVE_PG_TOOL_START_FAILED'));
    child.once('exit', async (code) => {
      if (finished) return; finished = true; clearTimeout(timer);
      try {
        await writeFile(logPath, stderr, { flag: 'wx', mode: 0o600 });
        if (code !== 0) reject(new Error('NATIVE_PG_TOOL_EXIT_FAILURE')); else resolve(stdout);
      } catch { reject(new Error('NATIVE_PRIVATE_LOG_WRITE_FAILED')); }
    });
  });
}
async function main() {
  requireValue(process.argv.length === 4 && process.argv[3] === '--run-authorized-restore', 'EXPLICIT_AUTHORIZED_RESTORE_FLAG_REQUIRED');
  const headCommit = assertRepositoryCommitted();
  const config = JSON.parse(await readFile(await privatePath(process.argv[2]), 'utf8'));
  const sourceUri = await readUri(config.sourceUriFile, config.sourceHost, sourceTarget.databaseName);
  const targetUri = await readUri(config.targetUriFile, config.targetHost, restoreTarget.databaseName);
  requireValue(sourceUri.hostname !== targetUri.hostname, 'SOURCE_TARGET_HOSTS_MUST_DIFFER');
  const approvedReport = JSON.parse(await readFile(await privatePath(config.approvedSourceReport), 'utf8'));
  const approvedSource = approvedReport.databases?.find((item) => item.databaseName === sourceTarget.databaseName);
  requireValue(approvedSource, 'EXPLICIT_APPROVED_SOURCE_FINGERPRINT_REQUIRED');
  const directory = await privatePath(config.artifactDirectory, false); await secureNewDirectory(directory);
  const ca = getCACertificates('default').concat(getCACertificates('system')).join('\n');
  const caPath = path.join(directory, 'trusted-ca.pem'); await writeFile(caPath, ca, { flag: 'wx', mode: 0o600 });
  const archivePath = path.join(directory, 'selected-g24.dump');
  const files = git(['ls-tree', '-r', '--name-only', 'HEAD', 'migrations']).trim().split(/\r?\n/u)
    .filter((name) => /^migrations\/\d{3}_.+\.sql$/u.test(name) && !name.includes('_rollback'));
  const manifest = files.map((name) => ({ name: path.basename(name), version: path.basename(name, '.sql'),
    number: Number(path.basename(name).slice(0, 3)), checksum: digest(git(['show', 'HEAD:' + name]).replace(/\r\n/gu, '\n')) }));
  const sql061 = git(['show', 'HEAD:migrations/061_validate_and_activate_tenant_rls_pilot.sql']);
  const clientFor = (uri, database) => new pg.Client({ host: uri.hostname, port: 5432, user: 'neondb_owner',
    password: decodeURIComponent(uri.password), database, connectionTimeoutMillis: 15000, query_timeout: 35000,
    ssl: { rejectUnauthorized: true, ca } });
  const source = clientFor(sourceUri, sourceTarget.databaseName), target = clientFor(targetUri, restoreTarget.databaseName);
  const environment = (uri, database) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|comspec|pathext|lang|lc_all)$/iu.test(key))),
    PGHOST: uri.hostname, PGPORT: '5432', PGUSER: 'neondb_owner', PGPASSWORD: decodeURIComponent(uri.password),
    PGDATABASE: database, PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath, PGCONNECT_TIMEOUT: '15' });
  const pgBin = process.env.CRM_QA_PG_BIN;
  requireValue(pgBin && path.isAbsolute(pgBin), 'EXPLICIT_NATIVE_PG18_BIN_REQUIRED');
  let nativeIndex = 0;
  const native = async (tool, action) => {
    const sourceAction = tool === 'pg_dump', uri = sourceAction ? sourceUri : targetUri;
    const database = sourceAction ? sourceTarget.databaseName : restoreTarget.databaseName;
    const args = action === 'version' ? ['--version'] : tool === 'pg_dump'
      ? ['--no-password', '--dbname=' + database, '--format=custom', '--file=' + archivePath]
      : ['--no-password', '--dbname=' + database, '--exit-on-error', '--single-transaction', archivePath];
    const result = await nativeCommand(path.join(pgBin, tool + (process.platform === 'win32' ? '.exe' : '')), args,
      environment(uri, database), path.join(directory, 'native-' + (++nativeIndex) + '.stderr.private.log'));
    if (action === 'dump') {
      const bytes = await readFile(archivePath);
      return { sha256: digest(bytes), bytes: bytes.length, format: 'native-pg-custom-selected-database' };
    }
    return result;
  };
  try {
    await source.connect(); await target.connect();
    const evidence = await restoreSelectedQa({ source, target, approvedSource,
      capture: (client, selected) => captureQaDatabase({ client, target: selected, manifest, sql061 }), native,
      savePassword: (value) => writeFile(path.join(directory, 'runtime-private.json'), JSON.stringify(value), { flag: 'wx', mode: 0o600 }),
      saveEvidence: (value) => writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ ...value, headCommit }, null, 2) + '\n', { mode: 0o600 }) });
    console.log(JSON.stringify({ status: evidence.status, steps: evidence.steps.length, productionAccess: 0, sourceWrites: 0, ledgerRecreation: 0 }));
  } finally { await Promise.allSettled([source.end(), target.end()]); }
}
main().catch((error) => {
  const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message || '') ? error.message : 'SELECTED_QA_RESTORE_FAILED';
  console.error(JSON.stringify({ status: 'FAIL', code })); process.exitCode = 1;
});
