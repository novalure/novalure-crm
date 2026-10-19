import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "../auth/session";
import { withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision, requireKnowledgePermission } from "./policy";
import { knowledgeInternals } from "./repository";
import { createKnowledgeProposalInTransaction, recordKnowledgeWorkflowEventInTransaction } from "./workflow";
import type { KnowledgeEntitlement } from "./types";
import { scanWebsite, WebsiteScanError, type WebsiteScanPorts, type WebsiteScanResult } from "./website-scanner";

export const knowledgeMonitoringIntervals = ["manual", "daily", "weekly", "monthly"] as const;
export type KnowledgeMonitoringInterval = typeof knowledgeMonitoringIntervals[number];
export type KnowledgeMonitoringConfig = {
  sourceId: string; interval: KnowledgeMonitoringInterval; enabled: boolean; revision: number;
  nextDueAt: string | null; lastSuccessAt: string | null; lastScanAt: string | null;
  lastErrorCode: string | null; lastRunStatus: string | null;
};
export type KnowledgeWebsiteRun = {
  id: string; sourceId: string; trigger: "manual" | "scheduled";
  status: "running" | "retry_wait" | "changed" | "unchanged" | "failed" | "blocked" | "stale";
  attempts: number; startedAt: string; completedAt: string | null; errorCode: string | null;
  proposalId: string | null; contentHash: string | null;
};
export type KnowledgeMonitoringJob = Readonly<{ workspaceId: string; sourceId: string; actorId: string; configRevision: number }>;
export type KnowledgeMonitoringOptions = TenantTransactionOptions & Readonly<{ scanPorts?: WebsiteScanPorts }>;
export type SaveKnowledgeMonitoringInput = { sourceId: string; expectedVersion: number; interval: KnowledgeMonitoringInterval; enabled: boolean };
const configColumns = `source_id as "sourceId",interval,enabled,revision,next_due_at::text as "nextDueAt",last_success_at::text as "lastSuccessAt",last_scan_at::text as "lastScanAt",last_error_code as "lastErrorCode",last_run_status as "lastRunStatus"`;
const runColumns = `id,source_id as "sourceId",trigger,status,attempts,started_at::text as "startedAt",completed_at::text as "completedAt",error_code as "errorCode",proposal_id as "proposalId",content_hash as "contentHash"`;
const terminal = new Set(["changed", "unchanged", "failed", "blocked", "stale"]);
const retryableErrors = new Set(["website_scan_timeout", "website_fetch_failed", "website_response_aborted", "website_http_error"]);
const intervalSql = `case interval when 'daily' then interval '1 day' when 'weekly' then interval '7 days' when 'monthly' then interval '1 month' else null end`;
function fail(code: string, message: string, status = 409): never { throw new KnowledgeCenterError(code, message, status); }

/** Missing, malformed and unknown contract values never unlock a periodic scan. */
export function allowedKnowledgeMonitoringIntervals(contract: KnowledgeEntitlement): KnowledgeMonitoringInterval[] {
  if (!contract.enabled || !contract.contractReference?.trim() || contract.features?.websiteImport !== true) return [];
  const allowed: KnowledgeMonitoringInterval[] = ["manual"];
  const configured = contract.allowedMonitoringIntervals;
  if (contract.features?.monitoring === true && Array.isArray(configured)) {
    for (const interval of knowledgeMonitoringIntervals) if (interval !== "manual" && configured.includes(interval)) allowed.push(interval);
  }
  return allowed;
}
export function parseKnowledgeMonitoringInterval(value: unknown): KnowledgeMonitoringInterval {
  if (typeof value !== "string" || !knowledgeMonitoringIntervals.includes(value as KnowledgeMonitoringInterval)) fail("VALIDATION_ERROR", "Invalid monitoring interval.", 400);
  return value as KnowledgeMonitoringInterval;
}
function requireWebsiteContract(contract: KnowledgeEntitlement, interval: KnowledgeMonitoringInterval = "manual") {
  if (!allowedKnowledgeMonitoringIntervals(contract).includes(interval)) fail("ENTITLEMENT_REQUIRED", "This website monitoring interval is not enabled in the trusted contract.", 403);
}
async function readConfig(tx: TenantTransaction, session: AppSession, sourceId: string) {
  return tx.queryOne<KnowledgeMonitoringConfig & { actorId: string; due: boolean }>(`select ${configColumns},configured_by as "actorId",next_due_at<=clock_timestamp() as due from knowledge_website_monitoring where source_id=$1::uuid and workspace_id=$2::uuid`, [sourceId, session.workspaceId]);
}
async function readRun(tx: TenantTransaction, session: AppSession, runId: string) {
  const row = await tx.queryOne<KnowledgeWebsiteRun>(`select ${runColumns} from knowledge_website_scan_runs where id=$1::uuid and workspace_id=$2::uuid`, [runId, session.workspaceId]);
  if (!row) fail("NOT_FOUND", "Website scan is unavailable.", 404);
  return row;
}
export async function getKnowledgeMonitoring(session: AppSession, input: { sourceId: string }, options: TenantTransactionOptions = {}) {
  const sourceId = knowledgeId(input.sourceId, "sourceId");
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); const contract = await knowledgeInternals.enabled(tx, fresh);
    const row = await knowledgeInternals.source(tx, fresh, sourceId, true);
    if (row.type !== "url") fail("VALIDATION_ERROR", "Only URL sources support monitoring.", 400);
    const stored = await readConfig(tx, fresh, sourceId);
    const config = stored ? publicConfig(stored) : null;
    const history = await tx.query<KnowledgeWebsiteRun>(`select ${runColumns} from knowledge_website_scan_runs where source_id=$1::uuid and workspace_id=$2::uuid order by started_at desc,id desc limit 30`, [sourceId, fresh.workspaceId]);
    const totals = await tx.queryOne<{ scans: number }>(`select scans_this_month as scans from knowledge_center_usage($1::uuid)`, [fresh.workspaceId]);
    return { config, history, scansThisMonth: totals?.scans ?? 0, allowedIntervals: allowedKnowledgeMonitoringIntervals(contract) };
  }, options);
}
function publicConfig(config: KnowledgeMonitoringConfig): KnowledgeMonitoringConfig {
  return { sourceId: config.sourceId, interval: config.interval, enabled: config.enabled, revision: config.revision, nextDueAt: config.nextDueAt, lastSuccessAt: config.lastSuccessAt, lastScanAt: config.lastScanAt, lastErrorCode: config.lastErrorCode, lastRunStatus: config.lastRunStatus };
}
export async function saveKnowledgeMonitoring(session: AppSession, input: SaveKnowledgeMonitoringInput, options: TenantTransactionOptions = {}) {
  const sourceId = knowledgeId(input.sourceId, "sourceId"), expectedVersion = knowledgeRevision(input.expectedVersion), interval = parseKnowledgeMonitoringInterval(input.interval);
  if (typeof input.enabled !== "boolean") fail("VALIDATION_ERROR", "An explicit enabled value is required.", 400);
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await knowledgeInternals.lock(tx, fresh);
    const contract = await knowledgeInternals.enabled(tx, fresh), row = await knowledgeInternals.source(tx, fresh, sourceId, true);
    if (row.revision !== expectedVersion) fail("VERSION_CONFLICT", "Knowledge source changed; reload before configuring monitoring.");
    if (row.type !== "url" || !row.version?.url) fail("VALIDATION_ERROR", "Only URL sources support monitoring.", 400);
    // Revocation may always be persisted by a current writer, even after a contract downgrade.
    if (input.enabled) requireWebsiteContract(contract, interval);
    await tx.execute(`insert into knowledge_website_monitoring(source_id,workspace_id,configured_by,project_id,interval,enabled,next_due_at)
      values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,case when $6 and $5<>'manual' then clock_timestamp() else null end)
      on conflict(source_id) do update set configured_by=excluded.configured_by,interval=excluded.interval,enabled=excluded.enabled,revision=knowledge_website_monitoring.revision+1,
      next_due_at=case when excluded.enabled and excluded.interval<>'manual' then clock_timestamp() else null end,updated_at=clock_timestamp()`, [sourceId, fresh.workspaceId, fresh.userId, row.projectId, interval, input.enabled]);
    await knowledgeInternals.audit(tx, fresh, "knowledge.website.monitoring_configured", sourceId, { interval, enabled: input.enabled });
    return publicConfig((await readConfig(tx, fresh, sourceId))!);
  }, options);
}

type ClaimedRun = {
  id: string; sourceId: string; actorId: string; sourceRevision: number; configRevision: number | null;
  url: string; previousHash: string | null; leaseToken: string; trigger: "manual" | "scheduled";
};
type ActiveRun = ClaimedRun & { status: KnowledgeWebsiteRun["status"]; attempts: number; leaseActive: boolean; retryPending: boolean };
async function claimRun(session: AppSession, input: { sourceId: string; expectedVersion?: number; job?: KnowledgeMonitoringJob }, options: TenantTransactionOptions): Promise<{ claimed: ClaimedRun } | { busy: KnowledgeWebsiteRun }> {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await knowledgeInternals.lock(tx, fresh);
    const contract = await knowledgeInternals.enabled(tx, fresh), row = await knowledgeInternals.source(tx, fresh, input.sourceId, true);
    if (row.type !== "url" || !row.version?.url) fail("VALIDATION_ERROR", "Only URL sources may be scanned.", 400);
    if (input.expectedVersion !== undefined && row.revision !== input.expectedVersion) fail("VERSION_CONFLICT", "Knowledge source changed; reload before scanning.");
    const config = await readConfig(tx, fresh, row.id);
    if (input.job) {
      if (input.job.actorId !== fresh.userId || input.job.workspaceId !== fresh.workspaceId || !config || config.actorId !== fresh.userId || config.revision !== input.job.configRevision || !config.enabled || config.interval === "manual" || !config.due) fail("MONITORING_NOT_DUE", "Monitoring configuration is no longer due or authorized.");
      requireWebsiteContract(contract, config.interval);
    } else requireWebsiteContract(contract);
    const active = await tx.queryOne<ActiveRun>(`select id,source_id as "sourceId",actor_id as "actorId",source_revision as "sourceRevision",config_revision as "configRevision",source_url as url,previous_hash as "previousHash",lease_token as "leaseToken",trigger,status,attempts,lease_until>clock_timestamp() as "leaseActive",next_attempt_at>clock_timestamp() as "retryPending" from knowledge_website_scan_runs where workspace_id=$1::uuid and source_id=$2::uuid and status in ('running','retry_wait') for update`, [fresh.workspaceId, row.id]);
    if (active) {
      if (active.leaseActive || active.retryPending) return { busy: await readRun(tx, fresh, active.id) };
      const configValid = active.configRevision === null || (config?.enabled && config.revision === active.configRevision && config.actorId === active.actorId);
      if (active.actorId === fresh.userId && active.sourceRevision === row.revision && active.url === row.version.url && configValid && active.attempts < 3) {
        if (active.trigger === "scheduled") requireWebsiteContract(contract, config!.interval);
        const leaseToken = randomUUID();
        await tx.execute(`update knowledge_website_scan_runs set status='running',lease_token=$1::uuid,lease_until=clock_timestamp()+interval '90 seconds',next_attempt_at=null,attempts=attempts+1,error_code=null where id=$2::uuid and workspace_id=$3::uuid`, [leaseToken, active.id, fresh.workspaceId]);
        await knowledgeInternals.audit(tx, fresh, "knowledge.website.scan_retried", row.id, { runId: active.id, attempt: active.attempts + 1 });
        return { claimed: { ...active, leaseToken } };
      }
      await tx.execute(`update knowledge_website_scan_runs set status=$1,completed_at=clock_timestamp(),lease_token=null,lease_until=null,next_attempt_at=null,error_code=$2 where id=$3::uuid and workspace_id=$4::uuid`, [active.attempts >= 3 ? "failed" : "stale", active.attempts >= 3 ? "SCAN_RETRIES_EXHAUSTED" : "SCAN_CONTEXT_CHANGED", active.id, fresh.workspaceId]);
      await knowledgeInternals.audit(tx, fresh, "knowledge.website.scan_expired", row.id, { runId: active.id });
      // A scheduled run has a bounded retry budget, including abandoned leases.
      if (input.job) {
        await advanceConfig(tx, fresh, row.id, active.configRevision, "failed", "SCAN_RETRIES_EXHAUSTED");
        return { busy: await readRun(tx, fresh, active.id) };
      }
    }
    const totals = await tx.queryOne<{ scans: number }>(`select scans_this_month as scans from knowledge_center_usage($1::uuid)`, [fresh.workspaceId]);
    if (!Number.isSafeInteger(contract.limits?.maxScansPerMonth) || (totals?.scans ?? 0) >= contract.limits.maxScansPerMonth) fail("LIMIT_EXCEEDED", "Monthly website scan limit reached.");
    const id = randomUUID(), leaseToken = randomUUID(), previousHash = row.version.content ? createHash("sha256").update(row.version.content).digest("hex") : null;
    const configRevision = input.job ? config!.revision : null;
    await tx.execute(`insert into knowledge_website_scan_runs(id,workspace_id,source_id,actor_id,project_id,trigger,source_revision,config_revision,source_url,previous_hash,status,lease_token,lease_until) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,'running',$11::uuid,clock_timestamp()+interval '90 seconds')`, [id, fresh.workspaceId, row.id, fresh.userId, row.projectId, input.job ? "scheduled" : "manual", row.revision, configRevision, row.version.url, previousHash, leaseToken]);
    await knowledgeInternals.audit(tx, fresh, "knowledge.website.scan_reserved", row.id, { runId: id, trigger: input.job ? "scheduled" : "manual" });
    return { claimed: { id, sourceId: row.id, actorId: fresh.userId, sourceRevision: row.revision, configRevision, url: row.version.url, previousHash, leaseToken, trigger: input.job ? "scheduled" : "manual" } };
  }, options);
}
async function advanceConfig(tx: TenantTransaction, session: AppSession, sourceId: string, configRevision: number | null, status: string, errorCode: string | null) {
  await tx.execute(`update knowledge_website_monitoring set last_scan_at=clock_timestamp(),last_run_status=$1,last_error_code=$2,
    last_success_at=case when $1 in ('changed','unchanged') then clock_timestamp() else last_success_at end,
    next_due_at=case when $3::int is not null and enabled and interval<>'manual' then clock_timestamp()+${intervalSql} else next_due_at end,
    updated_at=clock_timestamp() where source_id=$4::uuid and workspace_id=$5::uuid and ($3::int is null or revision=$3::int)`, [status, errorCode, configRevision, sourceId, session.workspaceId]);
}
async function ownLease(tx: TenantTransaction, session: AppSession, claimed: ClaimedRun) {
  const lease = await tx.queryOne<{ id: string }>(`select id from knowledge_website_scan_runs where id=$1::uuid and workspace_id=$2::uuid and actor_id=$3::uuid and status='running' and lease_token=$4::uuid and lease_until>clock_timestamp() for update`, [claimed.id, session.workspaceId, session.userId, claimed.leaseToken]);
  if (!lease) fail("SCAN_LEASE_LOST", "Website scan lease expired or was superseded.");
}
async function finishScan(session: AppSession, claimed: ClaimedRun, scanned: WebsiteScanResult, options: TenantTransactionOptions) {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await knowledgeInternals.lock(tx, fresh);
    const contract = await knowledgeInternals.enabled(tx, fresh), row = await knowledgeInternals.source(tx, fresh, claimed.sourceId, true);
    await ownLease(tx, fresh, claimed);
    requireWebsiteContract(contract);
    if (claimed.configRevision !== null) {
      const config = await readConfig(tx, fresh, row.id);
      if (!config?.enabled || config.revision !== claimed.configRevision || config.actorId !== fresh.userId) fail("MONITORING_CONFIG_CHANGED", "Monitoring configuration changed during the scan.");
      requireWebsiteContract(contract, config.interval);
    }
    const stale = row.revision !== claimed.sourceRevision || row.version?.url !== claimed.url;
    let proposal: { id: string } | undefined;
    if (!stale && scanned.change.kind !== "unchanged") {
      proposal = await createKnowledgeProposalInTransaction(tx, fresh, { source: row, kind: "website_change", dedupeKey: `website:${row.id}:${row.version!.id}:${scanned.contentHash}`, changes: { content: scanned.text }, evidence: { runId: claimed.id, contentHash: scanned.contentHash, requestedUrl: scanned.requestedUrl, finalUrl: scanned.finalUrl, scannedAt: scanned.scannedAt, trust: scanned.trust } });
    }
    const status = stale ? "stale" : scanned.change.kind === "unchanged" ? "unchanged" : "changed";
    await tx.execute(`update knowledge_website_scan_runs set status=$1,content_hash=$2,proposal_id=$3::uuid,error_code=$4,completed_at=clock_timestamp(),lease_token=null,lease_until=null where id=$5::uuid and workspace_id=$6::uuid`, [status, scanned.contentHash, proposal?.id ?? null, stale ? "VERSION_CONFLICT" : null, claimed.id, fresh.workspaceId]);
    await advanceConfig(tx, fresh, row.id, claimed.configRevision, status, stale ? "VERSION_CONFLICT" : null);
    await recordKnowledgeWorkflowEventInTransaction(tx, fresh, `knowledge.website.scan_${status}`, row, row.version?.id ?? null, { runId: claimed.id, proposalId: proposal?.id ?? null, contentHash: scanned.contentHash });
    return { run: await readRun(tx, fresh, claimed.id), ...(proposal ? { proposal } : {}), scan: { change: scanned.change, title: scanned.title, finalUrl: scanned.finalUrl, scannedAt: scanned.scannedAt, trust: scanned.trust }, unchanged: status === "unchanged", busy: false };
  }, options);
}
async function recordFailure(session: AppSession, claimed: ClaimedRun, errorCode: string, options: TenantTransactionOptions) {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await knowledgeInternals.lock(tx, fresh); await ownLease(tx, fresh, claimed);
    const run = await readRun(tx, fresh, claimed.id), retry = retryableErrors.has(errorCode) && run.attempts < 3;
    const status = retry ? "retry_wait" : ["ENTITLEMENT_REQUIRED", "MONITORING_CONFIG_CHANGED", "FORBIDDEN", "PROJECT_FORBIDDEN"].includes(errorCode) ? "blocked" : "failed";
    await tx.execute(`update knowledge_website_scan_runs set status=$1,error_code=$2,completed_at=case when $3 then null else clock_timestamp() end,lease_token=null,lease_until=null,next_attempt_at=case when $3 then clock_timestamp()+interval '1 minute' else null end where id=$4::uuid and workspace_id=$5::uuid`, [status, errorCode, retry, claimed.id, fresh.workspaceId]);
    if (!retry) await advanceConfig(tx, fresh, claimed.sourceId, claimed.configRevision, status, errorCode);
    else await tx.execute(`update knowledge_website_monitoring set last_scan_at=clock_timestamp(),last_run_status='retry_wait',last_error_code=$1 where source_id=$2::uuid and workspace_id=$3::uuid`, [errorCode, claimed.sourceId, fresh.workspaceId]);
    const row = await knowledgeInternals.source(tx, fresh, claimed.sourceId, true);
    await recordKnowledgeWorkflowEventInTransaction(tx, fresh, "knowledge.website.scan_failed", row, row.version?.id ?? null, { runId: claimed.id, code: errorCode, retry });
  }, options);
}
async function runScan(session: AppSession, input: { sourceId: string; expectedVersion?: number; job?: KnowledgeMonitoringJob }, options: KnowledgeMonitoringOptions) {
  const claim = await claimRun(session, input, options);
  if ("busy" in claim) return { run: claim.busy, busy: true, unchanged: claim.busy.status === "unchanged" };
  const claimed = claim.claimed;
  try {
    // DNS, network and extraction are bounded by the existing safe scanner and
    // always run after the reservation transaction has committed.
    const scanned = await scanWebsite(claimed.url, { previousHash: claimed.previousHash, ports: options.scanPorts });
    return await finishScan(session, claimed, scanned, options);
  } catch (error) {
    const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : "WEBSITE_SCAN_FAILED";
    const errorCode = /^[a-zA-Z0-9_]{1,80}$/.test(candidate) ? candidate : "WEBSITE_SCAN_FAILED";
    // Loss of membership/project rights must never be bypassed for cleanup.
    // Its expired lease cannot publish and a later authorized run can retire it.
    await recordFailure(session, claimed, errorCode, options).catch(() => undefined);
    if (error instanceof WebsiteScanError) throw new KnowledgeCenterError(error.code, "The website could not be safely scanned.", error.code === "website_scan_timeout" ? 504 : 422);
    throw error;
  }
}
export async function runKnowledgeWebsiteScan(session: AppSession, input: { sourceId: string; expectedVersion: number }, options: KnowledgeMonitoringOptions = {}) {
  return runScan(session, { sourceId: knowledgeId(input.sourceId, "sourceId"), expectedVersion: knowledgeRevision(input.expectedVersion) }, options);
}
/** Explicitly scoped discovery: callers supply an already trusted tenant actor. */
export async function listDueKnowledgeMonitoringJobs(session: AppSession, options: TenantTransactionOptions = {}): Promise<KnowledgeMonitoringJob[]> {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); const contract = await knowledgeInternals.enabled(tx, fresh);
    const allowed = allowedKnowledgeMonitoringIntervals(contract).filter(interval => interval !== "manual");
    if (!allowed.length) return [];
    return tx.query<KnowledgeMonitoringJob>(`select workspace_id as "workspaceId",source_id as "sourceId",configured_by as "actorId",revision as "configRevision" from knowledge_website_monitoring where workspace_id=$1::uuid and configured_by=$2::uuid and enabled and interval=any($3::text[]) and next_due_at<=clock_timestamp() order by next_due_at,source_id limit 100`, [fresh.workspaceId, fresh.userId, allowed]);
  }, options);
}
export async function runScheduledKnowledgeWebsiteScan(session: AppSession, job: KnowledgeMonitoringJob, options: KnowledgeMonitoringOptions = {}) {
  knowledgeId(job.workspaceId, "workspaceId"); knowledgeId(job.actorId, "actorId"); knowledgeId(job.sourceId, "sourceId"); knowledgeRevision(job.configRevision);
  if (session.workspaceId !== job.workspaceId || session.userId !== job.actorId) fail("TENANT_MISMATCH", "Monitoring actor scope differs.", 403);
  return runScan(session, { sourceId: job.sourceId, job }, options);
}
export function isKnowledgeWebsiteRunTerminal(run: KnowledgeWebsiteRun) { return terminal.has(run.status); }
