import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { LocalSalesPool } from './local-sales-db.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, milliseconds, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function commandEnvironment(directory, executable) {
  const env = { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TEMP: directory, TMP: directory };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATH', 'Path']) if (process.env[name]) env[name] = process.env[name];
  env.PATH = `${path.dirname(executable)}${path.delimiter}${env.PATH ?? env.Path ?? ''}`;
  delete env.Path;
  return env;
}
async function command(executable, args, cwd, env, logfile, timeoutMs) {
  const log = await open(logfile, 'wx', 0o600);
  const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
  // pg_ctl can hand inherited handles to its daemon. Await the actual control
  // process exit, never descendant-held pipe closure. No pipe keeps Node alive.
  const exited = new Promise((resolve, reject) => { child.once('error', () => reject(new Error('OWNED_NATIVE_CONTROL_START_FAILED'))); child.once('exit', (code, signal) => resolve({ code, signal })); });
  try {
    const result = await bounded(exited, timeoutMs, 'OWNED_NATIVE_CONTROL_TIMEOUT');
    const size = (await stat(logfile)).size;
    if (result.code !== 0 || size > 2 * 1024 * 1024) throw new Error('OWNED_NATIVE_CONTROL_FAILED_SEE_LOCAL_LOG');
    return { exitCode: result.code, signal: result.signal, logfile, logBytesAtExit: size, stdio: 'OWN_REGULAR_FILE_NO_PIPE',
      nativeControlChildHandleRetained: true, serverLifetimeHandleClaimed: false };
  } catch (error) {
    // Only a stuck control command itself is signaled through its retained handle.
    // No taskkill, PID/group signal or descendant retry is used.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await bounded(exited, 3_000, 'OWNED_NATIVE_CONTROL_EXIT_UNSUPPORTED').catch(() => undefined);
    error.nativeControlOutcome = { exitCode: child.exitCode, signalCode: child.signalCode, logfile, stdio: 'OWN_REGULAR_FILE_NO_PIPE' };
    throw error;
  } finally { await log.close(); }
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('OWNED_LOCAL_PORT_UNAVAILABLE');
  return address.port;
}
async function listenerOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port }); let done = false;
    const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(500, () => finish(true));
  });
}

/** Actual ephemeral Windows PostgreSQL. Native instance start/stop is scoped to
 * its fresh nonce directory; stopping additionally requires fresh SQL identity.
 * This is not a direct server-lifetime handle or generic OS process-tree cleanup.
 */
export async function startReachabilityDb() {
  if (process.platform !== 'win32') throw new Error('REACHABILITY_WINDOWS_HOST_ONLY_COORDINATE_SEPARATE_LINUX_EXECUTION');
  if (process.env.VERCEL !== undefined || process.env.VERCEL_ENV !== undefined || process.env.VERCEL_URL !== undefined) throw new Error('REACHABILITY_LOCAL_HOST_REQUIRED');
  const cwd = await realpath(process.cwd()), parent = path.join(cwd, '.npm-cache', 'qa');
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== parent) throw new Error('REACHABILITY_REAL_LOCAL_DIRECTORY_REQUIRED');
  const leasePath = path.join(parent, '.property-reachability-20261105.lock'); let lease;
  try { lease = await open(leasePath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('REACHABILITY_OWN_TASK_CLUSTER_LOCK_BUSY_NO_LOCK_BREAK'); throw error; }
  const startedAt = new Date().toISOString();
  const leaseText = JSON.stringify({ kind: 'OWNED_PROPERTY_REACHABILITY_LOCAL_CLUSTER', runId: randomUUID(), ownerProcess: process.pid, startedAt });
  await lease.writeFile(leaseText); await lease.sync();
  let directory, port, bin, env, admin, pool, stopping, expectedIdentity;
  const role = `sales_qa_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const evidence = { schemaVersion: 2, scope: 'OWN_NONCE_INSTANCE_NATIVE_CONTROL_WITH_FRESH_SQL_IDENTITY_NOT_OS_TREE_CLEANUP', startedAt,
    bootstrap: 'REAL_EPHEMERAL_POSTGRES_NOT_SQL_RESULT_FAKE', loopbackOnly: true, directOsPidOrGroupSignals: false,
    pgCtlInvoked: false, taskkillInvoked: false, externalEnvironmentDatabaseUrlConsumed: false, directServerLifetimeHandleClaimed: false,
    controller: 'NATIVE_PG_CTL_OWN_DIRECTORY_AFTER_FRESH_SQL_DIRECTORY_PORT_STARTTIME_MATCH', role, cleanup: null };
  async function identity() {
    if (!admin || !directory || !port) throw new Error('OWNED_INSTANCE_IDENTITY_UNAVAILABLE_NO_STOP');
    const actual = (await admin.query("select current_setting('data_directory') as directory, host(inet_server_addr()) as host, inet_server_port() as port, pg_postmaster_start_time() as started, version() as version")).rows[0];
    // These are local synthetic server metadata only; capture before validation
    // so a failed host/path comparison is diagnosable without any credential.
    evidence.lastObservedIdentity = actual;
    const lines = (await readFile(path.join(directory, 'postmaster.pid'), 'utf8')).split(/\r?\n/);
    const startMs = new Date(actual?.started).valueOf();
    const matches = { sqlDirectory: typeof actual?.directory === 'string' && path.resolve(actual.directory).toLowerCase() === directory.toLowerCase(),
      sqlLoopbackHost: actual?.host === '127.0.0.1', sqlPort: Number(actual?.port) === port,
      recordedPostmasterIdentity: Number.isSafeInteger(Number(lines[0])) && Number(lines[0]) > 1,
      pidfileDirectory: typeof lines[1] === 'string' && path.resolve(lines[1]).toLowerCase() === directory.toLowerCase(), pidfilePort: Number(lines[3]) === port,
      postmasterStartWindow: Number.isFinite(startMs) && startMs >= Date.parse(startedAt) - 1000 && Math.abs(startMs - Number(lines[2]) * 1000) <= 2000,
      originalStartIdentity: !expectedIdentity || expectedIdentity.startedMs === startMs && expectedIdentity.postmasterIdentity === Number(lines[0]) };
    evidence.lastIdentityChecks = matches;
    if (Object.values(matches).some(value => !value)) throw new Error('OWNED_POSTGRES_IDENTITY_MISMATCH_NO_STOP');
    if (await realpath(directory) !== directory) throw new Error('OWNED_DIRECTORY_ALIAS_NO_STOP');
    return { directory, host: actual.host, port, startedMs: startMs, started: new Date(startMs).toISOString(), postmasterIdentity: Number(lines[0]), version: actual.version };
  }
  async function releaseLease() {
    if (await readFile(leasePath, 'utf8') !== leaseText) throw new Error('REACHABILITY_OWN_TASK_LOCK_CHANGED_NO_UNLINK');
    await lease.close(); lease = undefined; await rm(leasePath);
  }
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      const errors = []; let stopIdentity = null, control = null;
      if (port && await listenerOpen(port)) {
        try { stopIdentity = await identity(); if (!expectedIdentity) throw new Error('OWNED_START_IDENTITY_UNPROVEN_NO_STOP'); }
        catch (error) { errors.push(error.message); }
      }
      await bounded(Promise.allSettled([pool?.end(), admin?.end()]).then(results => {
        for (const result of results) if (result.status === 'rejected') errors.push('OWNED_POOL_CLOSE_FAILED');
      }), 10_000, 'OWNED_POOL_CLOSE_TIMEOUT').catch(error => errors.push(error.message));
      if (stopIdentity && errors.length === 0) {
        try { control = await command(bin.pg_ctl, ['-D', directory, '-m', 'fast', '-t', '15', '-w', 'stop'], cwd, env, path.join(directory, 'native-stop.log'), 20_000); }
        catch (error) { errors.push(error.message); }
      }
      let closed = !port;
      if (port) { const deadline = Date.now() + 5_000; while (Date.now() < deadline && await listenerOpen(port)) await delay(100); closed = !await listenerOpen(port); }
      if (!closed) errors.push('OWNED_LISTENER_STILL_OPEN_NO_UNPROVEN_ACTION');
      evidence.finishedAt = new Date().toISOString();
      evidence.cleanup = { method: control ? 'OWN_INSTANCE_NATIVE_PG_CTL_FAST_STOP_WITH_FRESH_SQL_IDENTITY' : 'NO_NATIVE_STOP_NEEDED_OR_UNSUPPORTED', stopIdentity, nativeControl: control, listenerClosed: closed,
        errors, ok: errors.length === 0 && closed, dataDirectoryRemoved: false, retainedForEvidence: true, foreignProcessAction: false, genericPidGroupOrTreeKill: false };
      if (directory) await writeFile(path.join(directory, 'property-reachability-lifecycle.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      if (evidence.cleanup.ok && lease) await releaseLease();
      if (!evidence.cleanup.ok) throw new Error('REACHABILITY_LOCAL_CLEANUP_UNSUPPORTED_EVIDENCE_AND_LOCK_RETAINED');
      return evidence.cleanup;
    })();
    return stopping;
  };
  try {
    directory = await mkdtemp(path.join(parent, 'property-reachability-pg-'));
    if (path.dirname(directory) !== parent || await realpath(directory) !== directory) throw new Error('REACHABILITY_OWN_DIRECTORY_REQUIRED');
    bin = await import('@embedded-postgres/windows-x64'); env = commandEnvironment(directory, bin.postgres);
    evidence.initdb = await command(bin.initdb, ['-D', directory, '--username=qa_admin', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'], cwd, env, `${directory}-initdb.log`, 45_000);
    port = await unusedPort(); evidence.directory = directory; evidence.port = port;
    evidence.pgCtlInvoked = true;
    evidence.nativeStart = await command(bin.pg_ctl, ['-D', directory, '-l', path.join(directory, 'postgres-native.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-t', '25', '-w', 'start'], cwd, env, path.join(directory, 'native-start.log'), 30_000);
    admin = new LocalSalesPool({ host: '127.0.0.1', port, user: 'qa_admin', database: 'postgres', max: 5, connectionTimeoutMillis: 3_000, query_timeout: 15_000 });
    expectedIdentity = await identity(); evidence.startIdentity = expectedIdentity; evidence.serverIdentityVerified = true;
    await admin.query(`create role ${role} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await admin.query('create role novalure_app nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
    await admin.query(`grant novalure_app to ${role}`);
    pool = new LocalSalesPool({ host: '127.0.0.1', port, user: role, database: 'postgres', max: 8, connectionTimeoutMillis: 3_000, query_timeout: 15_000 });
    const flags = (await pool.query('select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
    if (!flags || Object.values(flags).some(Boolean)) throw new Error('OWNED_APP_ROLE_MUST_NOT_BYPASS_RLS');
    evidence.runtimeRoleFlags = flags;
    return { admin, pool, port, role, directory, stop, lifecycleEvidence: evidence };
  } catch (error) {
    if (error.nativeControlOutcome) evidence.failedNativeControl = error.nativeControlOutcome;
    try { await stop(); } catch { /* The failed local cleanup and its own lease remain for bounded operator recovery. */ }
    throw error;
  }
}
