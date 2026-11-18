#!/usr/bin/env node
// Explicit host operator. Importing opens no connection and reads no credential.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCACertificates } from 'node:tls';
import pg from 'pg';
import { assertRepositoryCommitted } from './db-migrate.mjs';
import { assertConnectedDatabaseTarget } from './lib/infra-targets.mjs';
import { canonical, crmCandidateOriginalSources, crmCandidateSourceManifestSha256, crmCandidateTarget, createCrmCandidateManifest, sha256,
  validateCrmCandidateDescriptor, validateCrmCandidatePlan } from './lib/crm-candidate-fresh-manifest.mjs';
import { captureCrmCandidateFreshPlan, completeCrmCandidateFreshSchema, runCrmCandidateFreshEarly } from './lib/crm-candidate-fresh-bootstrap.mjs';
import { createCrmCandidateOfficialRunner, crmCandidateMetadataEnvironment } from './lib/crm-candidate-official-migrations.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = (condition, code) => assert.ok(condition, code);
const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', maxBuffer: 16_000_000,
  stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

export function loadCrmCandidateCommittedManifest(headCommit) {
  const names = git(['ls-tree', '-r', '--name-only', headCommit, 'migrations']).trim().split(/\r?\n/)
    .filter(name => /^migrations\/\d{3}_[a-z0-9_]+\.sql$/.test(name) && !name.includes('_rollback'));
  const files = names.map(name => ({ path: name, content: git(['show', headCommit + ':' + name]) }));
  const staged = crmCandidateOriginalSources.staged087.map(row => ({ path: row.path,
    content: git(['show', headCommit + ':' + row.path]) }));
  return createCrmCandidateManifest(files, staged, headCommit);
}

export function validateCrmCandidatePrivateInput(input, descriptor, mode) {
  check(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).sort().join(',') === (mode === '--apply' ? 'migrationDatabaseUrl,runtimePassword' : 'migrationDatabaseUrl'),
  'CRM_QA_PRIVATE_STDIN_SHAPE');
  check(typeof input.migrationDatabaseUrl === 'string' && input.migrationDatabaseUrl.length <= 8192, 'CRM_QA_PRIVATE_URL_REQUIRED');
  let url;
  try { url = new URL(input.migrationDatabaseUrl); } catch { throw new Error('CRM_QA_PRIVATE_URL_INVALID'); }
  check(/^postgres(?:ql)?:$/.test(url.protocol) && url.hostname === descriptor.directHost &&
    (!url.port || url.port === '5432') && decodeURIComponent(url.username) === 'neondb_owner' && url.password &&
    url.pathname === '/neondb' && !url.hash && url.searchParams.getAll('sslmode').length === 1 &&
    url.searchParams.get('sslmode') === 'verify-full' &&
    [...url.searchParams.keys()].every(key => ['sslmode', 'channel_binding'].includes(key)) &&
    url.searchParams.getAll('channel_binding').length <= 1 &&
    (!url.searchParams.has('channel_binding') || url.searchParams.get('channel_binding') === 'require'), 'CRM_QA_PRIVATE_URL_SCOPE');
  if (mode === '--apply') check(typeof input.runtimePassword === 'string' && /^[a-f0-9]{80}$/.test(input.runtimePassword),
    'CRM_QA_PRIVATE_RUNTIME_PASSWORD');
  return { url, runtimePassword: input.runtimePassword };
}

async function inputJson(stream) {
  let text = '';
  for await (const chunk of stream) { text += chunk.toString('utf8'); check(Buffer.byteLength(text) <= 16_384, 'CRM_QA_PRIVATE_STDIN_TOO_LARGE'); }
  try { return JSON.parse(text); } catch { throw new Error('CRM_QA_PRIVATE_STDIN_INVALID'); }
}

async function publicJson(filename, limit = 8_000_000) {
  const info = await lstat(filename);
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= limit, 'CRM_QA_METADATA_FILE_REQUIRED');
  return JSON.parse(await readFile(filename, 'utf8'));
}

function powershell(command, target) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|temp|tmp|userprofile|appdata|localappdata|comspec|pathext)$/i.test(name)));
  env.CRM_QA_PRIVATE_PATH = target; // Path only; never a credential environment variable.
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { env, encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function assertPrivate(filename, directory) {
  const info = await lstat(filename);
  check(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()), 'CRM_QA_PRIVATE_PATH_TYPE');
  if (process.platform === 'win32') {
    const code = "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:CRM_QA_PRIVATE_PATH; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=if($a.Owner -match '^S-1-'){([System.Security.Principal.SecurityIdentifier]::new($a.Owner)).Value}else{([System.Security.Principal.NTAccount]::new($a.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value}; if($owner -ne $s){exit 1}; $seen=@{}; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow'){$i=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($i -ne $s -and $i -ne 'S-1-5-18'){exit 1};$seen[$i]=$true}};if(-not $seen.ContainsKey($s) -or -not $seen.ContainsKey('S-1-5-18')){exit 1};'PRIVATE_OK'";
    check(powershell(code, filename) === 'PRIVATE_OK', 'CRM_QA_PRIVATE_ACL_REQUIRED');
  } else check(info.uid === process.getuid() && (info.mode & 0o077) === 0, 'CRM_QA_PRIVATE_MODE_REQUIRED');
}

async function privateOutput(filename, { newDirectory = false } = {}) {
  check(path.isAbsolute(filename), 'CRM_QA_ABSOLUTE_PRIVATE_OUTPUT_REQUIRED');
  const parent = await realpath(path.dirname(filename));
  const outside = path.relative(repository, parent);
  check(path.isAbsolute(outside) || outside.startsWith('..' + path.sep), 'CRM_QA_OUTPUT_OUTSIDE_REPOSITORY_REQUIRED');
  await assertPrivate(parent, true);
  const output = path.join(parent, path.basename(filename));
  if (newDirectory) {
    await mkdir(output, { mode: 0o700 });
    if (process.platform === 'win32') {
      const code = "$ErrorActionPreference='Stop';$a=New-Object System.Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false);$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetOwner($s);foreach($i in @($s,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($i,'FullControl','ContainerInherit, ObjectInherit','None','Allow'))};Set-Acl -LiteralPath $env:CRM_QA_PRIVATE_PATH -AclObject $a;'PRIVATE_SET'";
      check(powershell(code, output) === 'PRIVATE_SET', 'CRM_QA_PRIVATE_ACL_INSTALL');
    } else await chmod(output, 0o700);
    await assertPrivate(output, true);
  }
  return output;
}

function connector(descriptor, url) {
  const ca = [...getCACertificates('default'), ...getCACertificates('system')].join('\n');
  check(ca.length > 0, 'CRM_QA_VERIFIED_TLS_ROOTS_REQUIRED');
  return async (database, runtimePassword) => {
    const runtime = runtimePassword !== undefined;
    check(['postgres', 'neondb', 'crm_candidate_provider_baseline'].includes(database) && (!runtime || database === 'neondb'),
      'CRM_QA_CONNECT_DATABASE_SCOPE');
    const client = new pg.Client({ host: runtime ? descriptor.pooledHost : descriptor.directHost, port: 5432,
      database, user: runtime ? 'novalure_app' : 'neondb_owner', password: runtime ? runtimePassword : decodeURIComponent(url.password),
      enableChannelBinding: true, sslnegotiation: 'postgres',
      ssl: { rejectUnauthorized: true, ca, servername: runtime ? descriptor.pooledHost : descriptor.directHost }, connectionTimeoutMillis: 15_000,
      query_timeout: 960_000, options: '-c statement_timeout=840000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=60000',
      application_name: 'crm-candidate-original-qa-bootstrap', client_encoding: 'UTF8' });
    client.on('error', () => {}); // Query/end outcomes, never raw provider errors, determine the journal status.
    try { await client.connect(); return client; } catch (error) { await client.end(); throw error; }
  };
}

async function verifyRuntime(runtime, owner, descriptor) {
  const runtimeIdentity = await assertConnectedDatabaseTarget({ client: runtime, connectionMode: 'pooled', minimumServerVersionNum: 170000,
    purpose: 'CRM candidate restricted runtime', target: 'test', env: crmCandidateMetadataEnvironment(descriptor) });
  const ownerIdentity = await assertConnectedDatabaseTarget({ client: owner, connectionMode: 'direct', minimumServerVersionNum: 170000,
    purpose: 'CRM candidate migration owner readback', target: 'test', env: crmCandidateMetadataEnvironment(descriptor) });
  const posture = (await runtime.query(`select
    not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
    and not has_schema_privilege(current_user,'public','CREATE')
    and not has_database_privilege(current_user,current_database(),'CREATE')
    and not has_table_privilege(current_user,'public.novalure_schema_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    and not exists(select 1 from pg_class where relnamespace='public'::regnamespace and relowner=r.oid)
    and exists(select 1 from pg_auth_members m join pg_roles p on p.oid=m.roleid where m.member=r.oid
      and p.rolname='novalure_tenant_app' and m.inherit_option and not m.admin_option and not m.set_option)
    and not exists(select 1 from pg_roles p where p.oid<>r.oid and
      (pg_has_role(r.oid,p.oid,'USAGE') or pg_has_role(r.oid,p.oid,'SET')) and
      (p.rolsuper or p.rolbypassrls or p.rolcreatedb or p.rolcreaterole or p.rolreplication)) as safe
    from pg_roles r where r.rolname=current_user`)).rows[0];
  check(posture?.safe === true, 'CRM_QA_FULL_RUNTIME_POSTURE');
  const physical = (await owner.query('select (select count(*)::int from forms) forms,(select count(*)::int from external_integrations) integrations')).rows[0];
  check(physical?.forms > 0 && physical.integrations > 0, 'CRM_QA_GATEWAY_ORIGINAL_SEEDS_MISSING');
  const visible = (await runtime.query('select (select count(*)::int from forms) forms,(select count(*)::int from external_integrations) integrations')).rows[0];
  check(visible?.forms === 0 && visible.integrations === 0, 'CRM_QA_RUNTIME_DEFAULT_DENY');
  const retired = (await owner.query(`select not r.rolcanlogin and a.rolpassword is null and
    not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
    and not pg_has_role(r.oid,'novalure_tenant_app','MEMBER') and not pg_has_role(r.oid,'novalure_app','MEMBER') as safe
    from pg_roles r join pg_authid a on a.oid=r.oid where r.rolname='novalure_public_form_lookup'`)).rows[0];
  check(retired?.safe === true, 'CRM_QA_LOOKUP_NOT_RETIRED');
  return { runtime: 'novalure_app', migration: 'neondb_owner', runtimeIdentity, ownerIdentity, safeRoleSeparation: true,
    physicalOriginalGatewaySeeds: true, noContextDefaultDeny: true, retiredLookupNoLoginPasswordNull: true };
}

export async function main(argv = process.argv.slice(2), stream = process.stdin) {
  const [mode, descriptorPath, descriptorDigest, planPath, runPath] = argv;
  check(path.resolve(process.cwd()) === repository &&
    (mode === '--inspect' ? argv.length === 1 : mode === '--preflight' ? argv.length === 4 : mode === '--apply' && argv.length === 5),
  'CRM_QA_EXPLICIT_OPERATOR_ARGUMENTS');
  const headCommit = assertRepositoryCommitted({ cwd: repository });
  const manifest = loadCrmCandidateCommittedManifest(headCommit);
  if (mode === '--inspect') {
    console.log(JSON.stringify({ status: 'LOCAL_SOURCE_ONLY_TARGET_PENDING', headCommit, sourceRegistrySha256: crmCandidateSourceManifestSha256,
      manifestDigest: manifest.sha256, sourceInventorySqlFiles: 169, originalForwardSql: 166, historicalExecutions: 41, expectedLedgerRows: 125,
      executionVariant: manifest.executionVariant, excluded: manifest.excluded,
      nativeAttestation: false, providerCalls: 0 })); return;
  }
  const descriptor = validateCrmCandidateDescriptor(await publicJson(descriptorPath), { expectedDigest: descriptorDigest, headCommit });
  const credentials = validateCrmCandidatePrivateInput(await inputJson(stream), descriptor, mode);
  const connect = connector(descriptor, credentials.url);
  if (mode === '--preflight') {
    const output = await privateOutput(planPath);
    const plan = await captureCrmCandidateFreshPlan({ connect, descriptor, descriptorDigest, manifest, headCommit });
    check(assertRepositoryCommitted({ cwd: repository }) === headCommit, 'CRM_QA_SOURCE_CHANGED');
    await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await assertPrivate(output, false);
    console.log(JSON.stringify({ status: 'NATIVE_READ_ONLY_PLAN_CREATED', headCommit, planDigest: plan.sha256,
      descriptorDigest, mutations: 0 })); return;
  }
  await assertPrivate(planPath, false);
  const plan = validateCrmCandidatePlan(await publicJson(planPath), { descriptor, descriptorDigest, manifest, headCommit });
  const output = await privateOutput(runPath, { newDirectory: true });
  const intent = { format: 'crm-candidate-one-shot-intent-v1', headCommit, descriptorDigest, planDigest: plan.sha256,
    target: plan.bound.target, startedAt: new Date().toISOString(), retryOrResumeAuthorized: false };
  await writeFile(path.join(output, 'intent.json'), canonical(intent) + '\n', { flag: 'wx', mode: 0o600 });
  const journalPath = path.join(output, 'journal.jsonl');
  await writeFile(journalPath, '', { flag: 'wx', mode: 0o600 });
  const journal = event => appendFile(journalPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  let owner, runtime, result;
  try {
    const early = await runCrmCandidateFreshEarly({ connect, descriptor, descriptorDigest, manifest, headCommit,
      plan, runtimePassword: credentials.runtimePassword, journal });
    const earlyText = JSON.stringify(early, null, 2) + '\n';
    await writeFile(path.join(output, 'early-receipt.json'), earlyText, { flag: 'wx', mode: 0o600 });
    check(assertRepositoryCommitted({ cwd: repository }) === headCommit, 'CRM_QA_SOURCE_CHANGED');
    owner = await connect('neondb');
    const runOfficial = createCrmCandidateOfficialRunner({ client: owner, descriptor, descriptorDigest, manifest, headCommit,
      planDirectory: output, journal, repository });
    const full = await completeCrmCandidateFreshSchema({ client: owner, manifest, earlyResult: early, runOfficial, journal });
    runtime = await connect('neondb', credentials.runtimePassword);
    const runtimeBinding = await verifyRuntime(runtime, owner, descriptor);
    check(assertRepositoryCommitted({ cwd: repository }) === headCommit, 'CRM_QA_SOURCE_CHANGED');
    result = { ...full, format: 'crm-candidate-native-standalone-installation-v1',
      producer: 'scripts/crm-candidate-fresh-bootstrap.mjs', mode: '--apply', executionEnvironment: 'ACTUAL_NEON_NEW_FREE_PROJECT',
      headCommit, target: crmCandidateTarget(descriptor), descriptorDigest, planDigest: plan.sha256,
      manifestDigest: manifest.sha256, sourceRegistrySha256: crmCandidateSourceManifestSha256,
      executionVariantSha256: manifest.executionVariantSha256, earlyReceiptSha256: sha256(earlyText), runtimeBinding,
      completedAt: new Date().toISOString(),
      productionAccess: 0, customerActions: 0, modelCalls: 0, applicationAcceptance: 'PENDING_EXISTING_MANUAL_QA' };
  } catch (error) {
    await journal({ event: 'HELD_NO_AUTOMATIC_RETRY', code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message || '')
      ? error.message : 'CRM_QA_OPERATOR_STEP_UNCONFIRMED',
    ...(typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? { sqlState: error.code } : {}) });
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([owner?.end(), runtime?.end()]);
    const closed = cleanup.every(row => row.status === 'fulfilled');
    await journal({ event: closed ? 'CONNECTIONS_CLOSED' : 'CONNECTION_CLEANUP_HELD' });
    check(closed, 'CRM_QA_FINAL_CONNECTION_CLEANUP_UNCONFIRMED');
  }
  const fullText = JSON.stringify(result, null, 2) + '\n';
  await writeFile(path.join(output, 'full-receipt.json'), fullText, { flag: 'wx', mode: 0o600 });
  await journal({ event: 'FULL_RECEIPT_WRITTEN', receiptSha256: sha256(fullText), status: result.status,
    headCommit, target: result.target, descriptorDigest, planDigest: plan.sha256, manifestDigest: manifest.sha256,
    ledger: result.ledger, earlyReceiptSha256: result.earlyReceiptSha256 });
  console.log(JSON.stringify({ status: result.status, headCommit, ledgerRows: result.ledger.rows, originalForwardSql: result.forwardSqlFiles,
    runtimeVerified: true, applicationAcceptance: result.applicationAcceptance, productionReadiness: false }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  const code = /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message || '') ? error.message : 'CRM_QA_OPERATOR_FAILED';
  console.error(JSON.stringify({ status: 'HELD', code, automaticRetry: false })); process.exitCode = 1;
});
