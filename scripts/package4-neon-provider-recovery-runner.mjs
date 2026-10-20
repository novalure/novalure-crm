#!/usr/bin/env node
// Local tool bridge: API requests contain metadata only; all DB credentials stay
// in the owner-only QA directory and travel over approved Neon HTTPS WebSockets.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from '@neondatabase/serverless';
import { configurePackage4NeonTransport } from './package4-neon-bootstrap.mjs';
import { recoverPackage4ProviderBaselineUsingBranches } from './package4-neon-provider-baseline-recovery.mjs';
import { getRolePermissions } from '../src/lib/auth/permissions.ts';
import { getProductRoleCapabilities } from '../src/lib/product-model.ts';
import { withCrmRead } from '../src/lib/crm-command.ts';
import { loadKnowledgeCenter } from '../src/lib/knowledge-center/repository.ts';
import { readBotChannelHistory, readCalendarConnectionStatuses } from '../src/lib/db/crm-operational-readers.ts';

const directory = path.resolve(process.argv[2]);
const run = process.argv[3] ?? 'r1'; assert.match(run, /^r[1-3]$/);
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'Clean committed tooling required');
const sourceOwnerUrl = new URL((await readFile(path.join(directory, 'admin-url.txt'), 'utf8')).trim());
const sourceRuntimeUrl = new URL((await readFile(path.join(directory, 'runtime-url.txt'), 'utf8')).trim());
assert.equal(sourceOwnerUrl.hostname, 'ep-steep-shadow-bapfxomh.c-8.eu-central-1.aws.neon.tech');
assert.equal(sourceRuntimeUrl.hostname, sourceOwnerUrl.hostname);
assert.equal(sourceOwnerUrl.pathname, '/neondb'); assert.equal(sourceRuntimeUrl.pathname, '/neondb');
assert.equal(decodeURIComponent(sourceOwnerUrl.username), 'neondb_owner'); assert.equal(decodeURIComponent(sourceRuntimeUrl.username), 'novalure_app');
sourceOwnerUrl.hostname = 'ep-crimson-forest-ba4kk6sb.c-8.eu-central-1.aws.neon.tech';
sourceRuntimeUrl.hostname = sourceOwnerUrl.hostname;
const fixture = JSON.parse(await readFile(path.join(directory, 'hosted-target.json'), 'utf8'));
const implementationRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
configurePackage4NeonTransport();
let sequence = 0;
async function rpc(method, args) {
  const id = ++sequence;
  const request = { id, method, args };
  await writeFile(path.join(directory, `provider-${run}-recovery-request-${id}.json`), JSON.stringify(request) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ rpc: request }));
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    try {
      const response = JSON.parse(await readFile(path.join(directory, `provider-${run}-recovery-response-${id}.json`), 'utf8'));
      if (response.error) throw new Error(response.error);
      return response.result;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('METADATA_TOOL_BRIDGE_TIMEOUT');
}

const session = account => ({ authenticated: true, source: 'database', userId: account.userId,
  workspaceId: account.workspaceId, workspaceName: account.workspaceName, email: account.email,
  name: 'SYNTHETIC Package4 recovery actor', role: 'owner', productRole: 'customer_owner',
  permissions: getRolePermissions('owner'), productPermissions: getProductRoleCapabilities('customer_owner') });
const customer = session(fixture.accounts.customerA);
const sourceBinding = { syntheticOnly: true, newIsolatedResource: true, projectId: 'green-thunder-49879900',
  branchId: 'br-sweet-surf-ba6iahut', host: sourceOwnerUrl.hostname, databaseName: 'neondb', owner: 'neondb_owner',
  workspaceIds: fixture.allWorkspaceIds };
const sourcePool = new Pool({ connectionString: sourceOwnerUrl.toString(), max: 1, connectionTimeoutMillis: 20_000 });
const source = await sourcePool.connect();
const branchHosts = new Map();
const api = {
  listBranches: args => rpc('listBranches', args), getBranch: args => rpc('getBranch', args),
  createBranch: args => rpc('createBranch', args), setExpiration: args => rpc('setExpiration', args),
};
async function hostFor(branch) {
  if (!branchHosts.has(branch.id)) {
    const endpoints = await rpc('listEndpoints', { project_id: sourceBinding.projectId });
    const matches = endpoints.filter(endpoint => endpoint.branch_id === branch.id && endpoint.type === 'read_write');
    assert.equal(matches.length, 1, 'One independently created read-write compute required');
    assert.equal(matches[0].project_id, sourceBinding.projectId);
    assert.match(matches[0].host, /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/);
    assert.ok(!matches[0].host.includes('-pooler.'));
    branchHosts.set(branch.id, matches[0].host);
  }
  return branchHosts.get(branch.id);
}
async function runtimeFor(branch) {
  const url = new URL(sourceRuntimeUrl); url.hostname = await hostFor(branch);
  return new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 20_000 });
}
try {
  const sourceRuntime = await runtimeFor({ id: sourceBinding.branchId });
  let sourceRuntimeSafety;
  try {
    const actual = (await sourceRuntime.query("select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit,has_schema_privilege(current_user,'public','CREATE') as create_public from pg_roles where rolname=current_user")).rows[0];
    // The byte-pinned original QA snapshots and bootstrap intentionally use
    // LOGIN INHERIT. This source profile is distinct from production NOINHERIT.
    assert.deepEqual(actual, { project: sourceBinding.projectId, branch: sourceBinding.branchId, database: 'neondb', role: 'novalure_app', rolsuper:false, rolbypassrls:false, rolcreatedb:false, rolcreaterole:false, rolreplication:false, rolinherit:true, create_public:false });
    const owns = (await sourceRuntime.query("select count(*)::int as count from pg_class where relnamespace='public'::regnamespace and (relowner='novalure_app'::regrole or pg_has_role('novalure_app',relowner,'MEMBER'))")).rows[0].count;
    assert.equal(owns, 0);
    const task = await withCrmRead(customer, tx=>tx.queryOne('select title from tasks where id=$1',[fixture.recoveryTaskId]), {pool:sourceRuntime});
    assert.equal(task?.title, fixture.recoveryFixture.title);
    sourceRuntimeSafety = { checkedAt:new Date().toISOString(), ...actual, ownsPublicObjects:owns, ordinaryScopedTaskRead:'PASS' };
    await writeFile(path.join(directory,`provider-${run}-recovery-source-runtime.json`), JSON.stringify(sourceRuntimeSafety,null,2)+'\n', {mode:0o600,flag:'wx'});
  } finally { await sourceRuntime.end(); }
  const result = await recoverPackage4ProviderBaselineUsingBranches({ source, sourceBinding, implementationRevision,
    initialSnapshotFile: path.join(directory, 'database-recovery', 'database-working-initial.private.json'), sourceRuntimeSafety,
    artifactDirectory: path.join(directory, 'database-provider-recovery-' + run), runName: 'package4-db-recovery-20261020-provider-' + run, api,
    connectBranch: async branch => {
      const url = new URL(sourceOwnerUrl); url.hostname = await hostFor(branch);
      const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 20_000 });
      const client = await pool.connect();
      return { client, binding: { ...sourceBinding, branchId: branch.id, host: url.hostname },
        close: async () => { client.release(); await pool.end(); } };
    },
    changeWorkingSyntheticFixture: async ({ branch }) => {
      const runtime = await runtimeFor(branch);
      try {
        const rows = await withCrmRead(customer, tx => tx.query('update tasks set title=$2 where id=$1 and workspace_id=$3 returning id',
          [fixture.recoveryTaskId, 'SYNTHETIC post-checkpoint working change', customer.workspaceId]), { pool: runtime });
        assert.equal(rows.length, 1);
        return { syntheticOnly: true, branchId: branch.id, committedRows: rows.length };
      } finally { await runtime.end(); }
    },
    verifyRestoredDatabaseApplication: async ({ branch }) => {
      const runtime = await runtimeFor(branch);
      try {
        const role = (await runtime.query("select current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
        const owns = (await runtime.query("select count(*)::int as count from pg_class where relnamespace='public'::regnamespace and (relowner='novalure_app'::regrole or pg_has_role('novalure_app',relowner,'MEMBER'))")).rows[0].count;
        const options = { pool: runtime };
        const checks = [];
        const task = await withCrmRead(customer, tx => tx.queryOne('select title from tasks where id=$1', [fixture.recoveryTaskId]), options);
        assert.equal(task?.title, fixture.recoveryFixture.title); checks.push({ name: 'pre-checkpoint synthetic task restored through actual application scoped read', status: 'PASS' });
        const projects = await withCrmRead(customer, tx => tx.query('select id from projects'), options);
        assert.ok(projects.some(project => project.id === fixture.accounts.customerA.projectId));
        assert.ok(!projects.some(project => project.id === fixture.accounts.customerB.projectId));
        checks.push({ name: 'application tenant-scoped project reads remain isolated after recovery', status: 'PASS' });
        const knowledge = await loadKnowledgeCenter(customer, options);
        assert.equal(knowledge.available, true); checks.push({ name: 'actual Knowledge repository loads the restored active synthetic contract', status: 'PASS' });
        assert.equal((await readBotChannelHistory(customer, {}, options)).source, 'database');
        assert.equal((await readCalendarConnectionStatuses(customer, options)).source, 'database');
        checks.push({ name: 'migration106 operational application readers remain compatible', status: 'PASS' });
        return { status: 'PASS', databaseRole: role.role, superuser: role.rolsuper, bypassRls: role.rolbypassrls,
          ownsPublicObjects: owns, checks, scope: 'real application data layer through ordinary runtime; hosted login/MFA and files are not claimed' };
      } finally { await runtime.end(); }
    },
    saveEvidence: evidence => writeFile(path.join(directory, 'database-provider-recovery-' + run + '-result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }),
  });
  console.log(JSON.stringify({ status: result.status, scope: result.scope, elapsedMs: result.elapsedMs,
    branches: result.createdBranches.map(branch => ({ id: branch.id, name: branch.name })), privateFiles: result.privateFiles.status }));
} finally { source.release(); await sourcePool.end(); }
