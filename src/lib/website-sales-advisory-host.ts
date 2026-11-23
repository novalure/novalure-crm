import 'server-only';
import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { z } from 'zod';
import { createWebsiteSalesAdvisoryExecutor, type AdvisoryExecutionBinding } from './db/website-sales-advisory-jobs';
import { advisoryDigest } from './website-sales-advisory-domain';
import { advisoryIdentitySchema } from './website-sales-advisory-types';
import { runWebsiteSalesAdvisoryWorker } from './website-sales-advisory-worker';
import { areQueueWorkersPaused } from './cron/runtime';
import { CrmCommandError } from './crm-command';
import { advisoryModelProfileSchema } from './website-sales-advisory-model';

const runtimeSchema = z.enum(['VERCEL', 'CHECKED_OUT_NODE']);
const profileSchema = z.strictObject({ id: z.uuid(), identity: advisoryIdentitySchema, workflowId: z.uuid(), actorId: z.uuid(),
  workloadId: z.uuid(), grantId: z.uuid(), allowedKinds: z.array(z.enum(['ADVICE', 'TRANSCRIPT_ANALYSIS', 'ROLEPLAY', 'VIDEO'])).min(1).max(4), validUntil: z.iso.datetime({ offset: true }) });
const hostSchema = z.strictObject({ contractVersion: z.literal('website-sales-advisory-host-v1'), enabled: z.boolean(),
  hostRuntime: runtimeSchema, environment: z.literal('production'), revision: z.string().regex(/^[a-f0-9]{40}$/), databaseHostDigest: z.hash('sha256'),
  maxJobsPerRun: z.number().int().min(1).max(5), profiles: z.array(profileSchema).min(1).max(50) });
export type AdvisoryHostConfiguration = z.infer<typeof hostSchema>;
export type AdvisoryHostRuntime = z.infer<typeof runtimeSchema>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function unavailable(): never { throw new CrmCommandError('ADVISORY_HOST_NOT_CONFIGURED', 'Advisory host unavailable', 503); }

/** The dedicated video process verifies its actual clean checkout. It never impersonates a Vercel deployment. */
function checkedOutRevision(revision: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const origin = git('remote', 'get-url', 'origin').replace(/\.git$/, '');
    if (!['https://github.com/novalure/novalure-crm', 'git@github.com:novalure/novalure-crm'].includes(origin)
      || git('rev-parse', 'HEAD') !== revision || git('status', '--porcelain')) unavailable();
  } catch { unavailable(); }
}

/** Config admission is not evidence that independent review or production activation gates passed. */
export function readAdvisoryHostConfiguration(expectedRuntime: AdvisoryHostRuntime = 'VERCEL', env: NodeJS.ProcessEnv = process.env): AdvisoryHostConfiguration | null {
  if (!env.CRM_WEBSITE_SALES_ADVISORY_HOST) return null;
  let raw: unknown; try { raw = JSON.parse(env.CRM_WEBSITE_SALES_ADVISORY_HOST); } catch { return unavailable(); }
  const parsed = hostSchema.safeParse(raw); if (!parsed.success) return unavailable(); const config = parsed.data;
  if (!config.enabled) return null;
  if (config.hostRuntime !== expectedRuntime) return unavailable();
  if (expectedRuntime === 'VERCEL') {
    if (env.VERCEL !== '1' || env.VERCEL_PROJECT_ID !== 'prj_R32Okl6AHijTohvuKmryuTLjWMsk'
      || env.VERCEL_ENV !== config.environment || env.VERCEL_GIT_COMMIT_SHA !== config.revision
      || config.profiles.some(p => p.allowedKinds.includes('VIDEO'))) return unavailable();
  } else {
    if (env.VERCEL === '1' || config.profiles.some(p => p.allowedKinds.some(k => k !== 'VIDEO'))) return unavailable();
    checkedOutRevision(config.revision);
  }
  const profiles = new Set<string>(), resources = new Set<string>();
  for (const profile of config.profiles) {
    const resource = advisoryDigest({ identity: profile.identity, workflowId: profile.workflowId });
    if (profiles.has(profile.id) || resources.has(resource) || new Set(profile.allowedKinds).size !== profile.allowedKinds.length) return unavailable();
    profiles.add(profile.id); resources.add(resource);
  }
  return config;
}

let pool: Pool | undefined, poolKey = '';
/** Dedicated CLI shutdown only; no credentials or pool handle leave the host module. */
export async function closeAdvisoryExecutorPool() {
  const selected = pool; pool = undefined; poolKey = ''; await selected?.end();
}
function privatePool(config: AdvisoryHostConfiguration) {
  const connectionString = process.env.CRM_WEBSITE_SALES_ADVISORY_EXECUTOR_DATABASE_URL;
  if (!connectionString) return unavailable(); let url: URL; try { url = new URL(connectionString); } catch { return unavailable(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech') || url.username === 'neondb_owner'
    || !['require', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '') || sha(url.hostname) !== config.databaseHostDigest) return unavailable();
  const key = sha(connectionString);
  if (!pool || poolKey !== key) { const previous = pool; pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 }); poolKey = key;
    if (previous) void previous.end().catch(() => undefined); }
  return pool;
}

export function configuredAdvisoryExecutor(profileId: string, expectedRuntime: AdvisoryHostRuntime = 'VERCEL') {
  const config = readAdvisoryHostConfiguration(expectedRuntime); if (!config) return unavailable();
  const original = config.profiles.find(p => p.id === profileId); if (!original) return unavailable();
  const expected = advisoryDigest(config), selectedPool = privatePool(config);
  const deadline = Math.min(Date.parse(original.validUntil), Date.now() + (expectedRuntime === 'VERCEL' ? 55_000 : 240_000));
  return createWebsiteSalesAdvisoryExecutor({ pool: selectedPool, assertCurrent: async (): Promise<AdvisoryExecutionBinding> => {
    if (areQueueWorkersPaused()) throw new CrmCommandError('ADVISORY_WORKER_PAUSED', 'Advisory worker paused', 503);
    const fresh = readAdvisoryHostConfiguration(expectedRuntime);
    if (!fresh || advisoryDigest(fresh) !== expected || Date.now() >= deadline) return unavailable();
    const current = fresh.profiles.find(p => p.id === profileId); if (!current) return unavailable();
    return { ...current.identity, workflowId: current.workflowId, actorId: current.actorId, workloadId: current.workloadId,
      grantId: current.grantId, allowedKinds: current.allowedKinds, expiresAt: deadline, authorityReference: `advisory-host:${expected}:${profileId}` };
  } });
}

export function authorizeAdvisoryWorkerRequest(request: Request, secret = process.env.CRM_WEBSITE_SALES_ADVISORY_WORKER_SECRET ?? '') {
  const supplied = Buffer.from(request.headers.get('authorization') ?? ''), expected = Buffer.from(`Bearer ${secret}`);
  if (secret.length < 32 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new CrmCommandError('ADVISORY_WORKER_UNAUTHORIZED', 'Advisory worker unavailable', 401);
}
export async function runConfiguredAdvisoryWorker(request: Request) {
  authorizeAdvisoryWorkerRequest(request);
  if (new URL(request.url).search || request.method !== 'POST') throw new CrmCommandError('ADVISORY_WORKER_SELECTOR_DENIED', 'Advisory worker selector denied', 400);
  if (areQueueWorkersPaused()) return { contractVersion: 'website-sales-advisory-worker-v1', status: 'PAUSED', results: [] };
  const config = readAdvisoryHostConfiguration(); if (!config) return unavailable();
  // Inactive AI profiles leave durable jobs READY, so later activation needs no unsafe retry.
  let ai: unknown; try { ai = JSON.parse(process.env.CRM_WEBSITE_SALES_ADVISORY_AI ?? 'null'); } catch { return unavailable(); }
  const profile = advisoryModelProfileSchema.safeParse(ai);
  if (!profile.success || Date.parse(profile.data.validUntil) <= Date.now()) return { contractVersion: 'website-sales-advisory-worker-v1', status: 'MODEL_NOT_ACTIVATED', results: [] };
  const results = [], started = Date.now();
  for (const bound of config.profiles) {
    if (Date.now() - started >= 35_000 || areQueueWorkersPaused()) break;
    if (Date.parse(bound.validUntil) <= Date.now() || !profile.data.targets.some(t => t.workspaceId === bound.identity.workspaceId && t.projectId === bound.identity.projectId)) continue;
    results.push({ profileId: bound.id, jobs: await runWebsiteSalesAdvisoryWorker({ executor: configuredAdvisoryExecutor(bound.id) }, 1) });
    if (results.length >= config.maxJobsPerRun) break;
  }
  return { contractVersion: 'website-sales-advisory-worker-v1', results };
}
