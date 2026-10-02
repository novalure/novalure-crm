/** Explicit, exact-target synthetic CRM fixture. No migrations, sessions or MFA are fabricated. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { hashPassword } from '../src/lib/auth/passwords.ts';
import { snapshotG27 } from './lib/g27-qa-verification.mjs';

assert.equal(process.argv[2], '--run-authorized-preview-seed');
const root = '.npm-cache/g27/';
const project = 'super-block-59791927', branch = 'br-summer-breeze-awuzinct', database = 'qa_g27_20260923';
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const recovery = await read(root + 'recovery-verify-20260924-v2/evidence.json');
assert.equal(recovery.status, 'PASS'); assert.equal(recovery.security.counts.passed, 64);
const privatePath = root + 'preview-private.json', secretsPath = root + 'preview-secrets-private.json';
for (const file of [privatePath, secretsPath]) {
  assert.ok(execFileSync('git', ['check-ignore', file], { encoding: 'utf8' }).trim());
  await assert.rejects(access(file), error => error.code === 'ENOENT');
}
const get = async suffix => {
  const response = await fetch('https://console.neon.tech/api/v2/projects/' + project + suffix, { headers: { authorization: 'Bearer ' + process.env.G27_CRM_NEON_API_KEY }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  assert.equal(response.status, 200); return response.json();
};
const remoteProject = (await get('')).project;
assert.equal(remoteProject.name, 'novalure-g27-disposable-qa-20260920');
assert.equal(remoteProject.org_id, 'org-divine-silence-19529003');
const remoteBranch = (await get('/branches/' + branch)).branch;
assert.equal(remoteBranch.name, 'g27-qa-crm-20260923'); assert.equal(remoteBranch.parent_id, 'br-dry-thunder-awmimouk');
assert.equal(remoteBranch.protected, false); assert.notEqual(remoteBranch.default, true); assert.notEqual(remoteBranch.primary, true);
const url = new URL(process.env.G27_QA_ADMIN_URL);
assert.equal(url.username, 'neondb_owner'); assert.equal(url.pathname, '/neondb');
assert.ok(url.hostname.endsWith('.neon.tech') && !url.hostname.includes('-pooler.'));
url.pathname = '/' + database; url.searchParams.set('sslmode', 'verify-full');
const admin = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const credential = await read(root + 'neon-bootstrap-20260923/runtime-private.json');
assert.equal(credential.runtimeRole, 'g27_qa_20260923');
const runtimeUrl = new URL(url); runtimeUrl.username = credential.runtimeRole; runtimeUrl.password = credential.password;
const fixture = { workspaceId: 'afeac3f9-7534-47f5-b749-b3fd91b8f91b', ...Object.fromEntries(['userId','projectId','pipelineId','developerId','developerContactId'].map(k => [k, randomUUID()])), password: randomBytes(32).toString('base64url') };
fixture.email = 'synthetic-g27-' + fixture.userId.replaceAll('-', '') + '@example.invalid';
const privateResult = { status: 'PENDING', syntheticOnly: true, target: { project, branch, database, runtimeRole: credential.runtimeRole, workspaceId: fixture.workspaceId }, runtimeURL: runtimeUrl.toString(), fixture };
const secrets = { NOVALURE_SESSION_SECRET: randomBytes(48).toString('base64url'), NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(48).toString('base64url') };
let committed = false;
try {
  assert.deepEqual((await admin.query("select current_setting('neon.project_id',true) project,current_setting('neon.branch_id',true) branch,current_database() database,current_user role")).rows[0], { project, branch, database, role: 'neondb_owner' });
  assert.equal((await snapshotG27(admin)).hash, recovery.checksum.before, 'Verified source must remain unchanged before seed');
  assert.equal((await admin.query('select count(*)::int n from workspaces where id=$1', [fixture.workspaceId])).rows[0].n, 0);
  assert.equal((await admin.query('select count(*)::int n from auth_sessions')).rows[0].n, 0);
  const role = (await admin.query('select rolsuper,rolcreatedb,rolcreaterole,rolbypassrls from pg_roles where rolname=$1', [credential.runtimeRole])).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  await writeFile(privatePath, JSON.stringify(privateResult), { flag: 'wx', mode: 0o600 });
  await writeFile(secretsPath, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 });
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC G27 CRM PREVIEW QA','novalure_internal','novalure_internal',$2::jsonb)", [fixture.workspaceId, JSON.stringify({ salesApprovalUserId: fixture.userId, syntheticQa: true, qaScope: 'g27-pr65-preview' })]);
    const user = await client.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC G27 owner',$3,'owner','novalureAdmin','active') returning auth_identity_id", [fixture.userId, fixture.workspaceId, fixture.email]);
    fixture.authIdentityId = user.rows[0].auth_identity_id; assert.ok(fixture.authIdentityId);
    await client.query("update auth_identities set credential_state='active',password_hash=$2 where id=$1", [fixture.authIdentityId, await hashPassword(fixture.password)]);
    await client.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,'SYNTHETIC G27 Sales Project','Bauträger','property_developer','novalure_internal')", [fixture.projectId, fixture.workspaceId]);
    await client.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'synthetic-g27-sales','SYNTHETIC G27 Sales','sales',true)", [fixture.pipelineId, fixture.workspaceId, fixture.projectId]);
    for (const [position, name] of ['Neu','Qualifizieren','Angebot','Gewonnen','Verloren'].entries()) await client.query('insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category,probability) values($1,$2,$3,$4,$5,$6,$7,$8)', [fixture.pipelineId, fixture.workspaceId, fixture.projectId, 'synthetic-g27-' + position, name, position, position === 3 ? 'won' : position === 4 ? 'lost' : 'work', position === 3 ? 100 : 50]);
    await client.query('update projects set default_pipeline_id=$2 where id=$1', [fixture.projectId, fixture.pipelineId]);
    await client.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC G27 Developer','Bauträger')", [fixture.developerId, fixture.workspaceId, fixture.projectId]);
    await client.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,'SYNTHETIC G27 developer representative','synthetic-g27-developer@example.invalid','Bauträger')", [fixture.developerContactId, fixture.workspaceId, fixture.projectId, fixture.developerId, fixture.userId]);
    await client.query('update workspace_users set onboarding_completed_at=now() where id=$1', [fixture.userId]);
    await client.query('insert into crm_evelyn_preview_targets(workspace_id,project_id,evelyn_tenant_id,enabled) values($1,$2,$1,true)', [fixture.workspaceId, fixture.projectId]);
    await client.query('grant select on auth_identities to g27_qa_20260923');
    await client.query('grant update(last_seen_at) on auth_sessions to g27_qa_20260923');
    await client.query('grant select,insert,delete on csrf_token_consumptions to g27_qa_20260923');
    assert.equal((await client.query('select count(*)::int n from auth_sessions')).rows[0].n, 0);
    assert.deepEqual((await client.query('select mfa_secret_ciphertext,mfa_enabled_at from auth_identities where id=$1', [fixture.authIdentityId])).rows[0], { mfa_secret_ciphertext: null, mfa_enabled_at: null });
    await client.query('commit'); committed = true;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  privateResult.status = 'READY'; await writeFile(privatePath, JSON.stringify(privateResult), { mode: 0o600 });
  await writeFile(root + 'preview-fixture-evidence.json', JSON.stringify({ status: 'PASS', productionImpact: 'NONE', target: privateResult.target, projectId: fixture.projectId, userId: fixture.userId, syntheticOnly: true, sessionsSeeded: 0, mfaSeeded: false, cleanup: { project, branch, branchName: remoteBranch.name, parentBranchId: remoteBranch.parent_id, createdAt: remoteBranch.created_at } }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', syntheticOnly: true, sessionsSeeded: 0, productionImpact: 'NONE' }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', committed, code: /^[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : 'QA_FIXTURE_FAILED' }));
  process.exitCode = 1;
} finally { await admin.end(); }
