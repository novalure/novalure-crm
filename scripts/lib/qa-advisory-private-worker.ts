/** Disposable loopback acceptance helper only. Never imported by an application route or production CLI. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Pool } from 'pg';
import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { createWebsiteSalesAdvisoryExecutor, readWebsiteSalesAdvisoryJob, claimWebsiteSalesAdvisoryJob, withWebsiteSalesAdvisoryExecutorActor, readWebsiteSalesAdvisoryDemo, completeWebsiteSalesAdvisoryJob, markWebsiteSalesAdvisoryJobUnknown, type WebsiteSalesAdvisoryExecutor } from '../../src/lib/db/website-sales-advisory-jobs';
import { advisoryProfileExecutionBinding } from '../../src/lib/website-sales-advisory-host';
import { runWebsiteSalesAdvisoryModelJob } from '../../src/lib/website-sales-advisory-worker';
import { createWebsiteSalesAdvisoryVideoJobRunner } from '../website-sales-advisory-video-worker';
import { verifyWebsiteStudioQaCertificate } from '../../src/lib/website-sales-studio-qa';
import { CRM_MACHINE_WORKSPACE_ID, CRM_MACHINE_ISSUER, CRM_MACHINE_AUDIENCE, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_ENVIRONMENT } from '../../src/lib/crm-machine-auth';
import { areQueueWorkersPaused } from '../../src/lib/cron/runtime';
import { closeLocalTestPool } from '../../src/lib/db/local-test-transport';
import type { TenantPool } from '../../src/lib/db/tenant-client';

const uuid = z.uuid(), hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inputSchema = z.strictObject({ syntheticOnly: z.literal(true), mode: z.enum(['ADVICE', 'VIDEO']), jobId: uuid,
  workspaceId: uuid, projectId: uuid, companyId: uuid, locationId: uuid, workflowId: uuid });
const root = resolve('.npm-cache', 'qa');
function privatePath(value: string) { const path = resolve(value); assert(path.startsWith(root + sep) && path !== root); return path; }
async function main() {
  assert.equal(process.argv.length, 3); assert.notEqual(process.env.VERCEL, '1'); assert.notEqual(process.env.NODE_ENV, 'production');
  const input = inputSchema.parse(JSON.parse(await readFile(privatePath(process.argv[2]), 'utf8')));
  const fixtureFile = privatePath('.npm-cache/qa/sales-browser-context.json'), fixtureBytes = await readFile(fixtureFile, 'utf8'), fixture = JSON.parse(fixtureBytes);
  assert.equal(fixture.fixtureMode, 'design-c-current-application-originals'); assert(fixture.syntheticOnly && fixture.websiteAdvisory?.syntheticOnly && fixture.websiteStudio?.syntheticOnly);
  assert.equal(new URL(fixture.baseUrl).hostname, '127.0.0.1'); assert.equal(fixture.database.host, '127.0.0.1'); assert.equal(fixture.database.database, 'neondb'); assert(/^sales_qa_[a-f0-9]+$/.test(fixture.database.user));
  assert(Number.isInteger(fixture.database.port) && fixture.database.port > 1024 && fixture.database.port <= 65535);
  assert.equal(input.workspaceId, CRM_MACHINE_WORKSPACE_ID); assert.equal(fixture.workspaceId, input.workspaceId);
  assert(fixture.websiteSales.projects.some((project: { projectId: string; companyId: string }) => project.projectId === input.projectId && project.companyId === input.companyId));
  assert.equal(fixture.websiteAdvisory.migration.file, '210_website_sales_advisory.sql');
  assert.equal(fixture.websiteAdvisory.migration.checksum, hash((await readFile('migrations/210_website_sales_advisory.sql', 'utf8')).replace(/\r\n/g, '\n')));
  const admin = new Pool({ ...fixture.database, user: 'qa_admin', max: 1 }); let executorPool: Pool | undefined;
  const environment = { DATABASE_URL: process.env.DATABASE_URL, CRM_LOCAL_TEST_DATABASE: process.env.CRM_LOCAL_TEST_DATABASE, NODE_ENV: process.env.NODE_ENV, WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS: process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS };
  try {
    assert((await admin.query('select id from crm_website_sales_workflows where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and id=$5', [input.workspaceId, input.projectId, input.companyId, input.locationId, input.workflowId])).rows.length === 1);
    const contextFile = privatePath('.npm-cache/qa/advisory-private-executor.json'), fingerprint = hash(fixtureBytes);
    let saved: { syntheticOnly: true; fingerprint: string; profile: Record<string, unknown>; user: string; password: string };
    let existing: string | null = null; try { existing = await readFile(contextFile, 'utf8'); } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
    if (existing) {
      saved = JSON.parse(existing); assert(saved.syntheticOnly && saved.fingerprint === fingerprint && /^advisory_browser_[a-f0-9]{12}$/.test(saved.user) && /^[A-Za-z0-9_-]{43}$/.test(saved.password));
      const profile = saved.profile as { identity: { workspaceId: string; projectId: string; companyId: string; locationId: string }; workflowId: string };
      assert.deepEqual(profile.identity, { workspaceId: input.workspaceId, projectId: input.projectId, companyId: input.companyId, locationId: input.locationId }); assert.equal(profile.workflowId, input.workflowId);
    } else {
      const actorId = randomUUID(), workloadId = randomUUID(), grantId = randomUUID(), user = `advisory_browser_${randomBytes(6).toString('hex')}`, password = randomBytes(32).toString('base64url');
      const authorityReference = 'SYNTHETIC scoped loopback browser advisory worker', validUntil = new Date(Date.now() + 1800000).toISOString();
      const key = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
      const client = await admin.connect();
      try {
        await client.query('begin');
        assert.equal((await client.query('select count(*)::int as n from crm_website_sales_machine_workloads')).rows[0].n, 0, 'A prior machine fixture must never be overwritten');
        await client.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status)values($1,$2,'SYNTHETIC private advisory worker',$3,'agent','novalure_operator','active')", [actorId, input.workspaceId, `synthetic-advisory-${actorId}@example.invalid`]);
        await client.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals)values($1,$2,$3,true,true)', [input.workspaceId, input.projectId, actorId]);
        await client.query("insert into crm_website_sales_machine_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,authority_reference)values($1,'EVELYN_WEBSITE_SALES_INTERNAL_IDENTITY',$2,$3,$4,$5,$6,$7,$8,$9,$10)", [workloadId, input.workspaceId, actorId, CRM_MACHINE_ISSUER, CRM_MACHINE_AUDIENCE, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_ENVIRONMENT, authorityReference]);
        await client.query("insert into crm_website_sales_machine_grants(id,workload_id,workspace_id,actor_user_id,project_id,company_id,location_id,department_id,agent_id,task_id,authority_reference,delegation_public_key,scopes,not_before,expires_at)values($1,$2,$3,$4,$5,$6,$7,'SALES','evelyn.sales.advisory-browser-qa',$8,$9,$10,$11,clock_timestamp(),$12)", [grantId, workloadId, input.workspaceId, actorId, input.projectId, input.companyId, input.locationId, randomUUID(), authorityReference, key, ['crm.website-sales.advisory.read', 'crm.website-sales.advisory.process-job', 'crm.website-sales.studio.read', 'crm.website-sales.enablement.read'], validUntil]);
        // Both identifiers and password are freshly generated from restricted alphabets, never caller strings.
        await client.query(`create role ${user} login password '${password}' inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
        await client.query(`grant novalure_website_sales_advisory_executor to ${user}`);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
      saved = { syntheticOnly: true, fingerprint, user, password, profile: { id: randomUUID(), identity: { workspaceId: input.workspaceId, projectId: input.projectId, companyId: input.companyId, locationId: input.locationId }, workflowId: input.workflowId, actorId, workloadId, grantId, authorityReference, allowedKinds: ['ADVICE', 'VIDEO'], validUntil } };
      await mkdir(dirname(contextFile), { recursive: true }); await writeFile(contextFile, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
    }
    const url = new URL(`postgresql://127.0.0.1:${fixture.database.port}/${fixture.database.database}`); url.username = fixture.database.user; if (fixture.database.password) url.password = fixture.database.password;
    // The local test transport is explicit and confined to the verified disposable loopback fixture.
    Object.assign(process.env, { DATABASE_URL: url.href, CRM_LOCAL_TEST_DATABASE: '1', NODE_ENV: 'test', WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS: JSON.stringify(fixture.websiteStudio.publicKeys) });
    executorPool = new Pool({ ...fixture.database, user: saved.user, password: saved.password, max: 2 });
    const deadline = Date.now() + 240000;
    const executor = createWebsiteSalesAdvisoryExecutor({ pool: executorPool as unknown as TenantPool, assertCurrent: async () => { assert(!areQueueWorkersPaused()); assert.equal(hash(await readFile(fixtureFile, 'utf8')), fingerprint); return advisoryProfileExecutionBinding(saved.profile, deadline); } });
    let generated = 0, rejectedOverlongVideo = false;
    const runVideo = createWebsiteSalesAdvisoryVideoJobRunner<WebsiteSalesAdvisoryExecutor>({ read: readWebsiteSalesAdvisoryJob, claim: claimWebsiteSalesAdvisoryJob,
      withActor: (cap, id, run) => withWebsiteSalesAdvisoryExecutorActor(cap, id, actor => run({ job: actor.job, isCurrent: actor.isCurrent })), readDemo: readWebsiteSalesAdvisoryDemo,
      verifyQa: (certificate, artifact, workflowId, builderId, now) => { verifyWebsiteStudioQaCertificate(certificate, artifact, workflowId, builderId, now); }, markUnknown: markWebsiteSalesAdvisoryJobUnknown,
      complete: async (cap, completion) => {
        const current = await readWebsiteSalesAdvisoryJob(cap, completion.jobId), story = (current.frozenContext.storyboard as { payload: { value: { shots: unknown[]; maximumSeconds: number } } }).payload.value;
        assert(story.shots.length >= 2 && story.maximumSeconds === 20);
        await assert.rejects(completeWebsiteSalesAdvisoryJob(cap, { ...completion, video: { ...completion.video, durationSeconds: 21 } }), error => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ADVISORY_VIDEO_APPROVED_DURATION_EXCEEDED'));
        const retained = await readWebsiteSalesAdvisoryJob(cap, completion.jobId); assert.equal(retained.status, 'CLAIMED'); assert.equal(retained.resultDigest, null); rejectedOverlongVideo = true;
        return completeWebsiteSalesAdvisoryJob(cap, completion);
      } });
    const result = input.mode === 'VIDEO' ? await runVideo(executor, input.jobId) : await runWebsiteSalesAdvisoryModelJob({ executor,
      modelPorts: { profile: { enabled: true, targets: [{ workspaceId: input.workspaceId, projectId: input.projectId }], validUntil: new Date(deadline).toISOString(), maxCreditsPerTurn: 100 },
        model: new MockLanguageModelV4({ doGenerate: async () => { generated++; return { content: [{ type: 'text', text: JSON.stringify({ answerable: true, sourceIndices: [0], assertions: [], roleplayUtterance: null }) }], finishReason: { unified: 'stop', raw: undefined }, warnings: [], usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } } }; } }) } }, input.jobId);
    const current = await readWebsiteSalesAdvisoryJob(executor, input.jobId);
    let actualCredits: number | null = null;
    if (input.mode === 'ADVICE') { const row = (await admin.query('select actual_credits from ai_credit_reservations where workspace_id=$1 and request_id=$2', [input.workspaceId, input.jobId])).rows[0]; actualCredits = row?.actual_credits ?? null; }
    process.stdout.write(JSON.stringify({ syntheticOnly: true, productionAdmission: false, realProviderCalls: 0, syntheticSdkCalls: generated, mode: input.mode, jobId: input.jobId, status: result.status, persistedStatus: current.status, resultDigest: current.resultDigest, actualCredits, rejectedOverlongVideo }) + '\n');
    if (current.status !== 'SUCCEEDED') process.exitCode = 2;
  } finally {
    await executorPool?.end(); await closeLocalTestPool(); await admin.end(); for (const [key, value] of Object.entries(environment)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
void main().catch(() => { process.stderr.write('SYNTHETIC_ADVISORY_PRIVATE_WORKER_UNCONFIRMED\n'); process.exitCode = 1; });
