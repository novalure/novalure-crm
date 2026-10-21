#!/usr/bin/env node
// Prepared host QA tooling. Importing this module never opens a database.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, lstat, mkdir, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCACertificates } from 'node:tls';
import pg from 'pg';
import { assertRepositoryCommitted } from './db-migrate.mjs';
import { createFreshBootstrapManifest, captureFreshBootstrapPreflight, runFreshBootstrap, freshBootstrapTarget } from './lib/studio-stage3-qa-fresh-bootstrap.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const historyKeys = ['sourceReport', 'originalPreflight', 'failedPrepare', 'startInventory', 'nativeDenial'];
const approvedFormat = 'studio-stage3-fresh-bootstrap-reviewed-plan-v1';
const allowedDatabases = new Set(['postgres', 'neondb', 'st1_stage3_management', 'st1_stage3_provider_baseline']);
const requireValue = (value, code) => { if (!value) throw new Error(code); };
const canonical = (value) => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical(value[key]))]))
  : Array.isArray(value) ? value.map((entry) => JSON.parse(canonical(entry))) : value);
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const git = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', maxBuffer: 8_000_000, stdio: ['ignore', 'pipe', 'ignore'] });

export function validateFreshBootstrapConfig(config, mode) {
  requireValue(config && typeof config === 'object' && !Array.isArray(config), 'FRESH_BOOTSTRAP_CONFIG_REQUIRED');
  requireValue(Object.keys(config.target || {}).sort().join(',') === 'branchId,databaseName,projectId,runtimeRole' &&
    Object.entries(freshBootstrapTarget).every(([key, value]) => config.target[key] === value), 'EXACT_FRESH_TARGET_CONFIG_REQUIRED');
  requireValue(typeof config.targetHost === 'string' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/u.test(config.targetHost) &&
    !config.targetHost.includes('-pooler.'), 'DIRECT_NEON_TARGET_HOST_REQUIRED');
  requireValue(typeof config.targetUriFile === 'string' && config.targetUriFile.length > 0 &&
    /^[a-f0-9]{40}$/u.test(config.cutoverSourceSha || ''), 'PRIVATE_TARGET_AND_CUTOVER_SOURCE_REQUIRED');
  requireValue(Object.keys(config.historyFiles || {}).sort().join(',') === [...historyKeys].sort().join(',') &&
    historyKeys.every((key) => typeof config.historyFiles[key] === 'string' && config.historyFiles[key].length > 0),
  'COMPLETE_PRIVATE_FRESH_HISTORY_REQUIRED');
  requireValue(['--preflight', '--run-authorized-fresh-bootstrap'].includes(mode), 'EXPLICIT_FRESH_BOOTSTRAP_MODE_REQUIRED');
  if (mode === '--run-authorized-fresh-bootstrap') requireValue(typeof config.approvedPlanFile === 'string' && config.approvedPlanFile.length > 0,
    'PRIVATE_REVIEWED_FRESH_PLAN_FILE_REQUIRED');
  return config;
}

export function validateReviewedFreshPlan(reviewed, { headCommit, cutoverSourceSha, now = Date.now() }) {
  const age = now - Date.parse(reviewed?.capturedAt);
  requireValue(reviewed?.format === approvedFormat && reviewed.headCommit === headCommit &&
    reviewed.plan?.format === 'studio-stage3-fresh-bootstrap-plan-v1' && reviewed.plan.bound?.headCommit === headCommit &&
    reviewed.plan.bound?.cutoverSourceSha === cutoverSourceSha &&
    Object.keys(reviewed.plan.bound.target || {}).sort().join(',') === 'branchId,databaseName,projectId,runtimeRole' &&
    Object.entries(freshBootstrapTarget).every(([key, value]) => reviewed.plan.bound.target?.[key] === value) &&
    /^[a-f0-9]{64}$/u.test(reviewed.plan.sha256 || '') && hash(reviewed.plan.bound) === reviewed.plan.sha256 && Number.isFinite(age) && age >= 0 && age <= 3_600_000,
  'EXACT_RECENT_REVIEWED_FRESH_PLAN_REQUIRED');
  return reviewed.plan;
}

function powershell(command, environment) {
  const childEnvironment = { ...process.env, ...environment };
  // PowerShell 7 module paths cannot be loaded by the Windows PowerShell 5 child.
  // Let that child discover its own system modules; the ACL predicates stay intact.
  for (const key of Object.keys(childEnvironment)) if (key.toLowerCase() === 'psmodulepath') delete childEnvironment[key];
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { env: childEnvironment, windowsHide: true, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function assertPrivateAccess(filename, isDirectory) {
  const info = await lstat(filename);
  requireValue(!info.isSymbolicLink() && (isDirectory ? info.isDirectory() : info.isFile()), 'PRIVATE_QA_PATH_TYPE_REQUIRED');
  if (process.platform === 'win32') {
    const command = "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:STUDIO_FRESH_PRIVATE_PATH; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $o=$a.Owner; $owner=if($o -match '^S-1-'){([System.Security.Principal.SecurityIdentifier]::new($o)).Value}else{([System.Security.Principal.NTAccount]::new($o)).Translate([System.Security.Principal.SecurityIdentifier]).Value}; if($owner -ne $s){exit 1}; $seen=@{}; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow'){$i=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($i -ne $s -and $i -ne 'S-1-5-18'){exit 1}; $seen[$i]=$true}}; if(-not $seen.ContainsKey($s) -or -not $seen.ContainsKey('S-1-5-18')){exit 1}; 'PRIVATE_OK'";
    requireValue(powershell(command, { STUDIO_FRESH_PRIVATE_PATH: filename }) === 'PRIVATE_OK', 'PRIVATE_QA_ACL_REQUIRED');
  } else {
    requireValue(info.uid === process.getuid() && (info.mode & 0o077) === 0, 'PRIVATE_QA_PERMISSIONS_REQUIRED');
  }
}

async function privatePath(input, existing = true, isDirectory = false) {
  requireValue(typeof input === 'string' && input.length > 0, 'EXPLICIT_PRIVATE_QA_PATH_REQUIRED');
  const base = await realpath(path.join(repository, '.npm-cache', 'qa'));
  const requested = path.resolve(repository, input);
  const candidate = existing ? await realpath(requested) : path.join(await realpath(path.dirname(requested)), path.basename(requested));
  const relative = path.relative(base, candidate);
  requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'IGNORED_PRIVATE_QA_PATH_REQUIRED');
  execFileSync('git', ['check-ignore', '--quiet', candidate], { cwd: repository, stdio: 'ignore' });
  await assertPrivateAccess(existing ? candidate : path.dirname(candidate), existing ? isDirectory : true);
  return candidate;
}

async function secureNewDirectory(directory) {
  try { await lstat(directory); throw new Error('NEW_PRIVATE_FRESH_RUN_DIRECTORY_REQUIRED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === 'win32') {
    const command = "$ErrorActionPreference='Stop'; $p=$env:STUDIO_FRESH_PRIVATE_PATH; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetOwner($s); foreach($i in @($s,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($i,'FullControl','ContainerInherit, ObjectInherit','None','Allow'))}; Set-Acl -LiteralPath $p -AclObject $a; 'PRIVATE_SET'";
    requireValue(powershell(command, { STUDIO_FRESH_PRIVATE_PATH: directory }) === 'PRIVATE_SET', 'PRIVATE_RUN_ACL_INSTALL_FAILED');
  } else await chmod(directory, 0o700);
  // Verify effective access before the first secret or evidence is persisted.
  await assertPrivateAccess(directory, true);
}

async function privateJson(filename) {
  return JSON.parse(await readFile(await privatePath(filename), 'utf8'));
}

function committedManifest(headCommit, cutoverSourceSha) {
  requireValue(git(['cat-file', '-t', cutoverSourceSha]).trim() === 'commit', 'CUTOVER_SOURCE_COMMIT_REQUIRED');
  execFileSync('git', ['merge-base', '--is-ancestor', cutoverSourceSha, headCommit], { cwd: repository, stdio: 'ignore' });
  const names = git(['ls-tree', '-r', '--name-only', headCommit, 'migrations']).trim().split(/\r?\n/u)
    .filter((name) => /^migrations\/\d{3}_[a-z0-9_]+\.sql$/u.test(name) && !name.includes('_rollback') &&
      Number(path.basename(name).slice(0, 3)) <= 85);
  // Read immutable committed objects, independent of Windows worktree line endings.
  return createFreshBootstrapManifest(names.map((name) => ({ name: path.basename(name),
    content: git(['show', headCommit + ':' + name]).replace(/\r\n/gu, '\n') })), { headCommit, cutoverSourceSha });
}

async function targetUri(config) {
  const uri = new URL((await readFile(await privatePath(config.targetUriFile), 'utf8')).trim());
  requireValue(['postgres:', 'postgresql:'].includes(uri.protocol) && uri.username === 'neondb_owner' && uri.password &&
    uri.hostname === config.targetHost && (!uri.port || uri.port === '5432') && uri.pathname === '/neondb' && !uri.hash &&
    [...uri.searchParams.keys()].every((key) => ['sslmode', 'channel_binding'].includes(key)), 'PINNED_PRIVATE_FRESH_URI_REQUIRED');
  return uri;
}

function targetConnector(uri) {
  // URI query parameters and ambient PG* variables never select TLS or the target.
  const ca = [...getCACertificates('default'), ...getCACertificates('system')].join('\n');
  requireValue(ca.length > 0, 'VERIFIED_SYSTEM_TLS_ROOTS_REQUIRED');
  requireValue(!process.env.PGREPLICATION, 'AMBIENT_REPLICATION_OPTIONS_FORBIDDEN');
  return async (database) => {
    requireValue(allowedDatabases.has(database), 'EXACT_FRESH_DATABASE_CONNECTION_REQUIRED');
    const client = new pg.Client({ host: uri.hostname, port: 5432, user: 'neondb_owner', password: decodeURIComponent(uri.password),
      database, connectionTimeoutMillis: 15000, query_timeout: 35000, options: '-c statement_timeout=35000 -c lock_timeout=10000',
      client_encoding: 'UTF8', application_name: 'studio-stage3-fresh-bootstrap', sslnegotiation: 'postgres',
      ssl: { rejectUnauthorized: true, ca } });
    try { await client.connect(); return client; } catch (error) { await client.end(); throw error; }
  };
}

export async function main(argv = process.argv.slice(2)) {
  requireValue(argv.length === 3 && ['--preflight', '--run-authorized-fresh-bootstrap'].includes(argv[2]),
    'USAGE_CONFIG_OUTPUT_AND_EXPLICIT_FRESH_MODE_REQUIRED');
  const headCommit = assertRepositoryCommitted({ cwd: repository });
  const config = validateFreshBootstrapConfig(await privateJson(argv[0]), argv[2]);
  const manifest = committedManifest(headCommit, config.cutoverSourceSha);
  const history = Object.fromEntries(await Promise.all(historyKeys.map(async (key) => [key, await privateJson(config.historyFiles[key])])));
  const uri = await targetUri(config);
  const connect = targetConnector(uri);
  const output = await privatePath(argv[1], false);
  const base = { connect, history, manifest, headCommit, cutoverSourceSha: config.cutoverSourceSha };
  if (argv[2] === '--preflight') {
    requireValue(assertRepositoryCommitted({ cwd: repository }) === headCommit, 'FRESH_SOURCE_CHANGED_DURING_PREPARATION');
    const plan = await captureFreshBootstrapPreflight(base);
    const wrapper = { format: approvedFormat, headCommit, capturedAt: new Date().toISOString(), plan };
    await writeFile(output, JSON.stringify(wrapper, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await assertPrivateAccess(output, false);
    console.log(JSON.stringify({ status: 'PREFLIGHT_READ_ONLY', sha256: plan.sha256, headCommit, databaseWrites: 0, sourceWrites: 0 }));
    return;
  }
  const approvedPlan = validateReviewedFreshPlan(await privateJson(config.approvedPlanFile),
    { headCommit, cutoverSourceSha: config.cutoverSourceSha });
  // No resume, reuse, or overwrite: partial attempts remain for explicit inspection.
  await secureNewDirectory(output);
  const evidencePath = path.join(output, 'evidence.json');
  await writeFile(evidencePath, '', { flag: 'wx', mode: 0o600 });
  await assertPrivateAccess(evidencePath, false);
  requireValue(assertRepositoryCommitted({ cwd: repository }) === headCommit, 'FRESH_SOURCE_CHANGED_DURING_PREPARATION');
  const evidence = await runFreshBootstrap({ ...base, approvedPlan,
    saveEvidence: (value) => writeFile(evidencePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }),
    saveRuntimeSecret: async (value) => {
      const file = path.join(output, 'runtime-private.json');
      await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await assertPrivateAccess(file, false);
    } });
  console.log(JSON.stringify({ status: evidence.status, headCommit, applied: evidence.applied.length, stopAfter: 85,
    sourceWrites: 0, providerRoleChanges: 0, nativeRestore: false, historicalLedgerCopied: false }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message || '') ? error.message : 'FRESH_BOOTSTRAP_CLI_FAILED';
    console.error(JSON.stringify({ status: 'FAIL', code })); process.exitCode = 1;
  });
}
