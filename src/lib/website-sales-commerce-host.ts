import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { z } from 'zod';
import { createWebsiteSalesCommerceExecutor, type CommerceExecutionBinding, type CommerceJobKind, type WebsiteSalesCommerceExecutor } from './db/website-sales-commerce-outbox';
import { commerceDigest } from './website-sales-commerce-domain';
import { commerceIdentitySchema } from './website-sales-commerce-types';
import { commerceSourceConnectionSchema, CommerceSourceError } from './website-sales-commerce-source';
import { runWebsiteSalesCommerceWorker, type CommerceWorkerOptions } from './website-sales-commerce-worker';
import { recordCommerceResendEvent } from './website-sales-commerce-worker';
import type { VerifiedResendEvent } from './resend-webhooks';
import { CrmCommandError } from './crm-command';
import { areQueueWorkersPaused } from './cron/runtime';

const jobKinds = z.enum(['OFFER_SEND', 'CONTRACT_SEND', 'SIGNATURE_REQUEST', 'ACCOUNTING_INVOICE_REQUEST', 'SUBSCRIPTION_CHANGE']);
const profileSchema = z.strictObject({ id: z.uuid(), identity: commerceIdentitySchema, workflowId: z.uuid(), actorId: z.uuid(), workloadId: z.uuid(),
  dispatchGrantId: z.uuid(), sourceGrantId: z.uuid(), allowedKinds: z.array(jobKinds).min(1).max(5), validUntil: z.iso.datetime({ offset: true }),
  accounts: z.strictObject({ resend: z.string().max(200), docuseal: z.string().max(200) }),
});
const connectionSchema = commerceSourceConnectionSchema.extend({ profileId: z.uuid() });
const hostSchema = z.strictObject({ contractVersion: z.literal('website-sales-commerce-host-v1'), enabled: z.boolean(),
  environment: z.literal('production'), revision: z.string().regex(/^[a-f0-9]{40}$/), databaseHostDigest: z.hash('sha256'),
  sender: z.string().min(1).max(320), htmlSignatureCapabilityApproved: z.boolean(), maxJobsPerRun: z.number().int().min(1).max(10),
  profiles: z.array(profileSchema).min(1).max(50), sourceConnections: z.array(connectionSchema).max(100),
});
export type CommerceHostConfiguration = z.infer<typeof hostSchema>;
type Profile = z.infer<typeof profileSchema>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function unavailable(): never { throw new CommerceSourceError(503, 'COMMERCE_HOST_NOT_CONFIGURED'); }

/** Deployment/config bindings are checked here. They are not a self-attested replacement for release gates:
 * activation of these host-only settings remains subject to actual exact-revision technical and business authority.
 */
export function readCommerceHostConfiguration(env: NodeJS.ProcessEnv = process.env): CommerceHostConfiguration | null {
  if (!env.CRM_WEBSITE_SALES_COMMERCE_HOST) return null;
  let raw: unknown; try { raw = JSON.parse(env.CRM_WEBSITE_SALES_COMMERCE_HOST); } catch { return unavailable(); }
  const parsed = hostSchema.safeParse(raw); if (!parsed.success) return unavailable(); const config = parsed.data;
  if (!config.enabled) return null;
  if (env.VERCEL !== '1' || env.VERCEL_PROJECT_ID !== 'prj_R32Okl6AHijTohvuKmryuTLjWMsk'
    || env.VERCEL_ENV !== config.environment || env.VERCEL_GIT_COMMIT_SHA !== config.revision) return unavailable();
  const resources = new Set<string>(), profiles = new Set<string>(), connections = new Set<string>();
  for (const profile of config.profiles) {
    if (!profile.identity.locationId || profiles.has(profile.id)) return unavailable(); profiles.add(profile.id);
    const key = commerceDigest({ identity: profile.identity, workflowId: profile.workflowId });
    if (resources.has(key)) return unavailable(); resources.add(key);
  }
  for (const connection of config.sourceConnections) {
    const profile = config.profiles.find(profile => profile.id === connection.profileId);
    if (!profile || connections.has(connection.connectionId) || commerceDigest(profile.identity) !== commerceDigest(connection.identity)
      || profile.workflowId !== connection.workflowId) return unavailable(); connections.add(connection.connectionId);
  }
  return config;
}

let pool: Pool | undefined, poolKey = '';
function executorPool(config: CommerceHostConfiguration) {
  const connectionString = process.env.CRM_WEBSITE_SALES_COMMERCE_EXECUTOR_DATABASE_URL;
  if (!connectionString) return unavailable(); let url: URL; try { url = new URL(connectionString); } catch { return unavailable(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech')
    || !['require', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '') || sha(url.hostname) !== config.databaseHostDigest) return unavailable();
  const selected = sha(connectionString);
  if (!pool || selected !== poolKey) {
    const previous = pool; pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 }); poolKey = selected;
    if (previous) void previous.end().catch(() => undefined);
  }
  return pool;
}

function executor(config: CommerceHostConfiguration, original: Profile, source: boolean): WebsiteSalesCommerceExecutor {
  const expected = commerceDigest(config), deadline = Math.min(Date.parse(original.validUntil), Date.now() + 55_000), selectedPool = executorPool(config);
  return createWebsiteSalesCommerceExecutor({ pool: selectedPool, assertCurrent: async (): Promise<CommerceExecutionBinding> => {
    if (!source && areQueueWorkersPaused()) throw new CommerceSourceError(503, 'COMMERCE_WORKER_PAUSED');
    const fresh = readCommerceHostConfiguration();
    if (!fresh || commerceDigest(fresh) !== expected || Date.now() >= deadline) return unavailable();
    const current = fresh.profiles.find(profile => profile.id === original.id); if (!current || !current.identity.locationId) return unavailable();
    return { ...current.identity, locationId: current.identity.locationId, workflowId: current.workflowId, actorId: current.actorId,
      workloadId: current.workloadId, grantId: source ? current.sourceGrantId : current.dispatchGrantId,
      allowedKinds: current.allowedKinds as CommerceJobKind[], expiresAt: deadline, authorityReference: `commerce-host:${expected}:${current.id}` };
  } });
}

function options(config: CommerceHostConfiguration, profile: Profile): CommerceWorkerOptions {
  const from = process.env.RESEND_FROM?.trim() || process.env.NOVALURE_EMAIL_FROM?.trim() || '';
  if (from && from !== config.sender) return unavailable();
  return { executor: executor(config, profile, false), sourceExecutor: executor(config, profile, true), accounts: profile.accounts,
    mail: { apiKey: process.env.RESEND_API_KEY?.trim() ?? '', from },
    signature: { apiKey: process.env.CRM_WEBSITE_SALES_DOCUSEAL_API_KEY?.trim() ?? '', htmlCapabilityApproved: config.htmlSignatureCapabilityApproved },
  };
}

export function authorizeCommerceWorkerRequest(request: Request, secret = process.env.CRM_WEBSITE_SALES_COMMERCE_WORKER_SECRET ?? '') {
  const token = Buffer.from(request.headers.get('authorization') ?? ''), expected = Buffer.from(`Bearer ${secret}`);
  if (secret.length < 32 || token.length !== expected.length || !timingSafeEqual(token, expected))
    throw new CommerceSourceError(401, 'COMMERCE_WORKER_UNAUTHORIZED');
}
export async function runConfiguredCommerceWorker(request: Request) {
  authorizeCommerceWorkerRequest(request); if (new URL(request.url).search) throw new CommerceSourceError(400, 'COMMERCE_WORKER_SELECTOR_DENIED');
  if (areQueueWorkersPaused()) return { contractVersion: 'website-sales-commerce-worker-v1', status: 'PAUSED', results: [] };
  const config = readCommerceHostConfiguration(); if (!config) return unavailable();
  const results = await runCommerceProfileSequence(config.profiles.map(profile => ({ id: profile.id, validUntil: profile.validUntil,
    run: () => runWebsiteSalesCommerceWorker(options(config, profile), config.maxJobsPerRun) })));
  return { contractVersion: 'website-sales-commerce-worker-v1', results };
}

/** The server constructs every closure from the validated fixed profile. A policy stop
 * stays with its resource; unexpected technical faults and the global pause still stop the batch.
 */
export async function runCommerceProfileSequence(profiles: readonly { id: string; validUntil: string;
  run: () => Promise<Awaited<ReturnType<typeof runWebsiteSalesCommerceWorker>>> }[]) {
  if (profiles.length > 50) throw new CommerceSourceError(400, 'COMMERCE_WORKER_LIMIT_INVALID');
  const started = Date.now(), results = [];
  for (const profile of profiles) {
    if (Date.now() - started >= 35_000 || areQueueWorkersPaused()) break;
    if (Date.parse(profile.validUntil) <= Date.now()) { results.push({ profileId: profile.id, status: 'SCOPE_EXPIRED' }); continue; }
    try { results.push({ profileId: profile.id, result: await profile.run() }); }
    catch (error) {
      if (!(error instanceof CrmCommandError)) throw error;
      results.push({ profileId: profile.id, status: 'BLOCKED', code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'COMMERCE_POLICY_DENIED' });
    }
  }
  return results;
}

export function configuredCommerceSource(connectionId: string) {
  if (!z.uuid().safeParse(connectionId).success) throw new CommerceSourceError(401, 'COMMERCE_SOURCE_UNAUTHORIZED');
  const config = readCommerceHostConfiguration(); if (!config) return unavailable();
  const connection = config.sourceConnections.find(connection => connection.connectionId === connectionId);
  if (!connection || !connection.enabled || Date.parse(connection.validUntil) <= Date.now()) throw new CommerceSourceError(401, 'COMMERCE_SOURCE_UNAUTHORIZED');
  const profile = config.profiles.find(profile => profile.id === connection.profileId); if (!profile) return unavailable();
  let keyring: unknown; try { keyring = JSON.parse(process.env.CRM_WEBSITE_SALES_COMMERCE_SOURCE_KEYS ?? '{}'); } catch { return unavailable(); }
  const parsed = z.record(z.uuid(), z.string().regex(/^[A-Za-z0-9_-]{43,171}$/)).safeParse(keyring);
  const encoded = parsed.success ? parsed.data[connectionId] : undefined; if (!encoded) return unavailable();
  const key = Buffer.from(encoded, 'base64url'); if (key.byteLength < 32 || key.byteLength > 128 || key.toString('base64url') !== encoded) return unavailable();
  const { profileId: omitted, ...binding } = connection; void omitted;
  return { connection: binding, key, executor: executor(config, profile, true) };
}

export function configuredCommerceResendWorker() {
  const config = readCommerceHostConfiguration();
  if (!config) return null;
  return config.profiles.filter(profile => profile.accounts.resend && Date.parse(profile.validUntil) > Date.now())
    .map(profile => ({ profileId: profile.id, options: options(config, profile) }));
}

export async function recordConfiguredCommerceResendEvent(event: VerifiedResendEvent) {
  const workers = configuredCommerceResendWorker(); if (!workers) return unavailable();
  const started = Date.now();
  for (const worker of workers) {
    if (Date.now() - started > 35_000) return unavailable();
    try { return await recordCommerceResendEvent(worker.options, event); }
    catch (error) {
      // A tag cannot choose a tenant: each registered executor checks its full server-bound scope.
      if (error instanceof CrmCommandError && error.code === 'COMMERCE_EXECUTOR_JOB_DENIED') continue;
      throw error;
    }
  }
  throw new CommerceSourceError(403, 'COMMERCE_DELIVERY_SCOPE_DENIED');
}
