/** Exact-target recovery diagnostic. Does not run migrations or repair existing databases. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { snapshotG27, verifyG27Security } from './lib/g27-qa-verification.mjs';

const mode = process.argv[2];
assert.ok(['probe', 'verify'].includes(mode));
const project = 'super-block-59791927', branch = 'br-summer-breeze-awuzinct';
const source = 'qa_g27_20260923';
const destination = mode === 'probe' ? 'qa_g27_recovery_probe_20260924' : 'qa_g27_recovery_20260924';
const root = path.resolve('.npm-cache/g27/recovery-' + mode + '-20260924' + (mode === 'verify' ? '-v2' : ''));
assert.ok(execFileSync('git', ['check-ignore', root], { encoding: 'utf8' }).trim());
await mkdir(root); // No overwriting an earlier diagnostic or its evidence.
const priorRoot = path.resolve('.npm-cache/g27/neon-bootstrap-20260923');
let before = JSON.parse(await readFile(path.join(priorRoot, 'schema-before.json'), 'utf8'));
const prior = JSON.parse(await readFile(path.join(priorRoot, 'evidence.json'), 'utf8'));
assert.equal(prior.migrationStatus, 'PASS');
assert.equal(prior.applied.length, 85);
assert.equal(prior.securityBeforeRestore.counts.passed, 64);
const uri = new URL(process.env.G27_QA_ADMIN_URL);
assert.equal(uri.username, 'neondb_owner'); assert.equal(uri.pathname, '/neondb');
assert.ok(uri.hostname.endsWith('.neon.tech') && !uri.hostname.includes('-pooler.'));
uri.searchParams.set('sslmode', 'verify-full');
const runtimeSecret = JSON.parse(await readFile(path.join(priorRoot, 'runtime-private.json'), 'utf8'));
assert.equal(runtimeSecret.runtimeRole, 'g27_qa_20260923');
const pool = (database, runtime = false) => {
  const next = new URL(uri); next.pathname = '/' + database;
  if (runtime) { next.username = runtimeSecret.runtimeRole; next.password = runtimeSecret.password; }
  return new pg.Pool({ connectionString: next.toString(), max: 2, connectionTimeoutMillis: 20000, query_timeout: 30000 });
};
const management = pool('neondb'), original = pool(source), sourceRuntime = pool(source, true);
let restored, runtime;
const evidence = { mode, project, branch, source, destination, startedAt: new Date().toISOString(), status: 'RUNNING', productionImpact: 'NONE', timings: {}, samples: [], tools: [], serverCpu: 'Not exposed by PostgreSQL catalog; no historical CPU measurement available.' };
const save = () => writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
async function timed(name, fn) { const started = Date.now(); try { return await fn(); } finally { evidence.timings[name] = Date.now() - started; await save(); } }
async function guard(db, database) {
  assert.deepEqual((await db.query("select current_setting('neon.project_id',true) project,current_setting('neon.branch_id',true) branch,current_database() database,current_user role")).rows[0], { project, branch, database, role: 'neondb_owner' });
}
const scrub = value => {
  let text = String(value);
  for (const secret of [process.env.G27_CRM_NEON_API_KEY, process.env.G27_QA_ADMIN_URL, decodeURIComponent(uri.password), runtimeSecret.password]) if (secret) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[REDACTED_URI]');
};
function category(line) {
  if (/processing data for table|executing SEQUENCE SET/.test(line)) return 'data';
  if (/creating (FK CONSTRAINT|CONSTRAINT|CHECK CONSTRAINT)/.test(line)) return 'constraints';
  if (/creating INDEX/.test(line)) return 'indexes';
  if (/creating (TRIGGER|POLICY|ROW SECURITY|RULE|STATISTICS)/.test(line)) return 'post-data';
  if (/creating (TABLE|FUNCTION|EXTENSION|SEQUENCE|TYPE|VIEW|SCHEMA)/.test(line)) return 'schema';
  return 'other';
}
async function native(name, args, timeoutMs, monitor = false) {
  const record = { name, args, timeoutMs, startedAt: new Date().toISOString(), progress: [], stderr: [], stdout: [], phaseMs: {}, timedOut: false };
  evidence.tools.push(record);
  const started = Date.now(); let previous;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(path|systemroot|windir|temp|tmp|userprofile|localappdata|appdata|comspec|pathext)$/i.test(k)));
  Object.assign(env, { PGHOST: uri.hostname, PGPORT: uri.port || '5432', PGUSER: uri.username, PGPASSWORD: decodeURIComponent(uri.password), PGSSLMODE: 'verify-full', PGSSLROOTCERT: path.join(priorRoot, 'trusted-ca.pem'), PGCONNECT_TIMEOUT: '20', PGAPPNAME: 'g27-recovery-' + mode, LC_ALL: 'C' });
  let polling = false;
  const timer = monitor ? setInterval(async () => {
    if (polling) return; polling = true;
    try {
      const sessions = (await management.query("select pid,state,wait_event_type,wait_event,extract(epoch from now()-query_start)::float as query_seconds,extract(epoch from now()-xact_start)::float as transaction_seconds,cardinality(pg_blocking_pids(pid)) as blockers from pg_stat_activity where datname=$1 and application_name=$2", [destination, 'g27-recovery-' + mode])).rows;
      const stats = (await management.query('select numbackends,xact_commit,xact_rollback,deadlocks,temp_files,blks_read,blks_hit from pg_stat_database where datname=$1', [destination])).rows[0];
      evidence.samples.push({ elapsedMs: Date.now() - started, progress: record.progress.length, sessions, stats }); await save();
    } catch (error) { evidence.samples.push({ elapsedMs: Date.now() - started, diagnosticError: scrub(error.message) }); }
    finally { polling = false; }
  }, 10000) : null;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(path.join(process.env.CRM_QA_PG_BIN, name + '.exe'), args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      record.pid = child.pid;
      const deadline = setTimeout(() => { record.timedOut = true; child.kill(); }, timeoutMs);
      let pending = '';
      child.stdout.on('data', chunk => record.stdout.push(scrub(chunk)));
      child.stderr.on('data', chunk => {
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const raw of lines) {
          const line = scrub(raw), elapsedMs = Date.now() - started; record.stderr.push({ elapsedMs, line });
          if (/pg_restore: (creating |processing data for table|executing SEQUENCE SET)/.test(line)) {
            if (previous) { previous.completedByNextStep = true; previous.durationMs = elapsedMs - previous.elapsedMs; record.phaseMs[previous.phase] = (record.phaseMs[previous.phase] ?? 0) + previous.durationMs; }
            previous = { elapsedMs, phase: category(line), line }; record.progress.push(previous);
          }
        }
      });
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(deadline); record.exitCode = code; record.signal = signal; record.elapsedMs = Date.now() - started;
        if (pending) record.stderr.push({ elapsedMs: record.elapsedMs, line: scrub(pending) });
        if (code === 0 && !record.timedOut) resolve(); else reject(new Error(record.timedOut ? name + '_TIMEOUT' : name + '_EXIT_' + code));
      });
    });
  } finally { if (timer) clearInterval(timer); await save(); }
  return record;
}
try {
  const metadata = async suffix => {
    const r = await fetch(`https://console.neon.tech/api/v2/projects/${project}${suffix}`, { headers: { authorization: 'Bearer ' + process.env.G27_CRM_NEON_API_KEY }, redirect: 'error', signal: AbortSignal.timeout(30000) }); assert.equal(r.status, 200); return r.json();
  };
  const { project: remoteProject } = await metadata('');
  assert.equal(remoteProject.name, 'novalure-g27-disposable-qa-20260920'); assert.equal(remoteProject.org_id, 'org-divine-silence-19529003');
  const { branch: remoteBranch } = await metadata('/branches/' + branch);
  assert.equal(remoteBranch.name, 'g27-qa-crm-20260923'); assert.equal(remoteBranch.parent_id, 'br-dry-thunder-awmimouk');
  assert.equal(remoteBranch.protected, false); assert.notEqual(remoteBranch.default, true); assert.notEqual(remoteBranch.primary, true);
  await guard(management, 'neondb'); await guard(original, source);
  await timed('sourceChecksumComparison', async () => assert.deepEqual(await snapshotG27(original), before, 'Source must match the complete preserved original snapshot'));
  if (mode === 'verify') {
    const runtimeUri = new URL(uri); runtimeUri.pathname = '/' + source; runtimeUri.username = runtimeSecret.runtimeRole; runtimeUri.password = runtimeSecret.password;
    process.env.DATABASE_URL = runtimeUri.toString();
    const { seedRecoveryFinancialFixture } = await import('./lib/g27-recovery-financial-fixture.mjs');
    evidence.financialFixture = await timed('syntheticFinancialFixture', () => seedRecoveryFinancialFixture(original, sourceRuntime));
    before = await snapshotG27(original);
    await writeFile(path.join(root, 'schema-before.json'), JSON.stringify(before));
  }
  const archive = path.join(root, 'full.dump');
  await timed('dumpCreation', () => native('pg_dump', ['--no-password', '--dbname=' + source, '--format=custom', '--file=' + archive], 180000));
  evidence.dump = { bytes: (await stat(archive)).size, sha256: createHash('sha256').update(await readFile(archive)).digest('hex') };
  const list = await native('pg_restore', ['--list', archive], 30000);
  evidence.tocEntries = list.stdout.join('').split('\n').filter(line => /^\d+;/.test(line)).length;
  let timeoutMs = 180000;
  if (mode === 'verify') {
    const probe = JSON.parse(await readFile('.npm-cache/g27/recovery-probe-20260924/evidence.json', 'utf8'));
    const restoreProbe = probe.tools.find(t => t.name === 'pg_restore' && t.args.includes('--verbose'));
    assert.equal(restoreProbe.timedOut, true);
    const progress = restoreProbe.progress.filter(p => p.completedByNextStep);
    assert.ok(progress.length > 100 && progress.at(-1).elapsedMs > 160000);
    assert.ok(probe.samples.length >= 10 && probe.samples.every(s => !s.diagnosticError && s.sessions.every(a => a.blockers === 0 && a.wait_event_type !== 'Lock')));
    assert.ok(progress.every(p => p.durationMs < 30000), 'No stalled object may justify extending the deadline');
    const estimate = restoreProbe.elapsedMs * evidence.tocEntries / progress.length;
    timeoutMs = Math.ceil(estimate * 1.25 / 1000) * 1000;
    assert.ok(timeoutMs > 180000 && timeoutMs <= 900000, 'Measured budget must remain bounded');
    evidence.timeoutPolicy = { oldMs: 180000, newMs: timeoutMs, estimateMs: estimate, safetyMargin: '25%', measuredCompletedObjects: progress.length, totalObjects: evidence.tocEntries, method: 'Observed serial TOC throughput, no blocked sessions or stalled objects' };
  }
  await timed('targetPreparation', async () => {
    assert.equal((await management.query('select count(*)::int n from pg_database where datname=$1', [destination])).rows[0].n, 0, 'New target database required');
    await management.query('create database "' + destination + '" template template0');
    restored = pool(destination); await guard(restored, destination);
    assert.equal((await restored.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n, 0);
  });
  await timed('nativeRestore', () => native('pg_restore', ['--no-password', '--dbname=' + destination, '--exit-on-error', '--single-transaction', '--verbose', archive], timeoutMs, true));
  await timed('migrationLedgerVerification', async () => assert.deepEqual((await restored.query('select version,name,checksum from novalure_schema_migrations order by version')).rows, before.ledger));
  await timed('checksumComparison', async () => { const after = await snapshotG27(restored); await writeFile(path.join(root, 'schema-after.json'), JSON.stringify(after)); assert.deepEqual(after, before); evidence.checksum = { status: 'PASS', before: before.hash, after: after.hash }; });
  // Recover only known synthetic fixture IDs. No business row payloads leave the process.
  const ids = {};
  for (const [key, table, column, value] of [
    ['workspace','workspaces','name','SYNTHETIC G27 tenant A'],['foreignWorkspace','workspaces','name','SYNTHETIC G27 tenant B'],
    ['owner','workspace_users','email','g27-owner@example.invalid'],['agent','workspace_users','email','g27-agent@example.invalid'],['foreignOwner','workspace_users','email','g27-foreign@example.invalid'],
    ['project','projects','name','SYNTHETIC granted project'],['hiddenProject','projects','name','SYNTHETIC hidden project'],['foreignProject','projects','name','SYNTHETIC foreign project'],
    ['contact','contacts','name','SYNTHETIC buyer'],['hiddenContact','contacts','name','SYNTHETIC hidden buyer'],['foreignContact','contacts','name','SYNTHETIC foreign buyer'],
    ['task','tasks','title','SYNTHETIC G27 task'],['unit','property_units','unit_number','SYNTHETIC-G27-01']]) {
    const rows = (await restored.query(`select id from ${table} where ${column}=$1`, [value])).rows; assert.equal(rows.length, 1); ids[key] = rows[0].id;
  }
  ids.lead = (await restored.query('select id from leads where workspace_id=$1 and contact_id=$2', [ids.workspace, ids.contact])).rows[0].id;
  runtime = pool(destination, true);
  evidence.security = await timed('rlsVerification', () => verifyG27Security({ admin: restored, runtime, ids }));
  await timed('sourceUnchanged', async () => assert.deepEqual(await snapshotG27(original), before));
  evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL'; evidence.failure = { message: scrub(error.message), code: error.code ?? null };
  if (restored) evidence.remainingRelations = (await restored.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n;
  process.exitCode = 1;
} finally {
  evidence.completedAt = new Date().toISOString(); await save();
  await Promise.allSettled([management.end(), original.end(), sourceRuntime.end(), restored?.end(), runtime?.end()]);
  console.log(JSON.stringify({ status: evidence.status, evidence: root, failure: evidence.failure, timings: evidence.timings }));
}
