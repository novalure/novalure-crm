import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { neon } from "@neondatabase/serverless";
import {
  applyVercelAutomationBypass,
  bindVercelAutomationBypass,
  validateVercelAutomationBypassUrl,
} from "./vercel-preview-access.mjs";

export const publicRuntimeCapabilityPath = "/api/admin/qa-batch-capability";

const allowedInputKeys = new Set([
  "actorUserId",
  "batchId",
  "batchMarker",
  "crossTenantActorUserId",
  "crossTenantBatchId",
  "crossTenantBatchMarker",
  "crossTenantSessionCookie",
  "crossTenantWorkspaceId",
  "databaseUrl",
  "expectedDeploymentId",
  "expectedGitRef",
  "expectedGitSha",
  "expectedNeonBranchId",
  "expectedNeonProjectId",
  "previewOrigin",
  "productionDatabaseHost",
  "productionOrigin",
  "sessionCookie",
  "shareUrl",
  "workspaceId",
]);
const shaPattern = /^[a-f0-9]{40}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const branchPattern = /^codex\/[A-Za-z0-9._/-]{1,220}$/u;
const deploymentPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const neonBranchPattern = /^br-[A-Za-z0-9-]{8,128}$/u;
const neonProjectPattern = /^[A-Za-z0-9-]{8,128}$/u;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const sessionCookiePattern = /^novalure_session=[A-Za-z0-9._~-]{20,4096}$/u;
const redirectStatuses = new Set([302, 303, 307, 308]);
const productionHosts = new Set([
  "novalure-crm.app",
  "www.novalure-crm.app",
  "novalure-crm.vercel.app",
  "novalure-crm-novalure.vercel.app",
]);
const forbiddenEvidenceKey = /(?:authorization|cookie|credential|databaseurl|email|password|secret|share|token|totp|url)$/iu;
const forbiddenEvidenceValue = /(?:https?|postgres(?:ql)?):\/\/|_vercel_share|novalure_session=|x-vercel-protection-bypass|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;

export class PublicRuntimePreviewError extends Error {
  constructor(code, options) {
    super(code, options);
    this.code = code;
    this.name = "PublicRuntimePreviewError";
  }
}

function fail(code, cause) {
  throw new PublicRuntimePreviewError(code, cause ? { cause } : undefined);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function defineSecret(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function fingerprint(label, value, length = 20) {
  return `sha256:${sha256(`${label}\0${value}`).slice(0, length)}`;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
}

export function canonicalJson(value) {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function assertPublicRuntimeEvidenceSafe(value, currentPath = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertPublicRuntimeEvidenceSafe(nested, `${currentPath}[${index}]`));
    return true;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (forbiddenEvidenceKey.test(key)) fail("EVIDENCE_REDACTION_FAILED");
      assertPublicRuntimeEvidenceSafe(nested, `${currentPath}.${key}`);
    }
    return true;
  }
  if (typeof value === "string" && forbiddenEvidenceValue.test(value)) {
    fail("EVIDENCE_REDACTION_FAILED");
  }
  return true;
}

function parseOrigin(value, label, { preview = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label}_INVALID`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    value !== parsed.origin
  ) {
    fail(`${label}_INVALID`);
  }
  if (preview && (!parsed.hostname.endsWith(".vercel.app") || productionHosts.has(parsed.hostname.toLowerCase()))) {
    fail("PREVIEW_ORIGIN_INVALID");
  }
  return parsed;
}

function parseDatabaseUrl(value, productionDatabaseHost) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("DATABASE_TARGET_INVALID");
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.username ||
    !parsed.password ||
    parsed.hostname.toLowerCase() === productionDatabaseHost ||
    !parsed.hostname.toLowerCase().endsWith(".neon.tech") ||
    parsed.pathname !== "/neondb" ||
    parsed.username !== "novalure_app" ||
    parsed.searchParams.get("sslmode") !== "require"
  ) {
    fail("DATABASE_TARGET_INVALID");
  }
  return parsed;
}

function parseShareUrl(value, previewOrigin) {
  if (!value) fail("SHARE_ACCESS_REQUIRED");
  try {
    validateVercelAutomationBypassUrl(value, previewOrigin);
    return new URL(value);
  } catch {
    fail("SHARE_ACCESS_INVALID");
  }
}

export function parsePublicRuntimeActionInput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("ACTION_INPUT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("ACTION_INPUT_INVALID");
  if (Object.keys(parsed).some((key) => !allowedInputKeys.has(key))) fail("ACTION_INPUT_INVALID");

  const expectedGitSha = clean(parsed.expectedGitSha).toLowerCase();
  const expectedGitRef = clean(parsed.expectedGitRef);
  const expectedDeploymentId = clean(parsed.expectedDeploymentId);
  const expectedNeonBranchId = clean(parsed.expectedNeonBranchId);
  const expectedNeonProjectId = clean(parsed.expectedNeonProjectId);
  const actorUserId = clean(parsed.actorUserId).toLowerCase();
  const crossTenantActorUserId = clean(parsed.crossTenantActorUserId).toLowerCase();
  const crossTenantBatchId = clean(parsed.crossTenantBatchId).toLowerCase();
  const crossTenantBatchMarker = clean(parsed.crossTenantBatchMarker);
  const crossTenantWorkspaceId = clean(parsed.crossTenantWorkspaceId).toLowerCase();
  const workspaceId = clean(parsed.workspaceId).toLowerCase();
  const batchId = clean(parsed.batchId).toLowerCase();
  const batchMarker = clean(parsed.batchMarker);
  const productionDatabaseHost = clean(parsed.productionDatabaseHost).toLowerCase();
  if (
    !shaPattern.test(expectedGitSha) ||
    !branchPattern.test(expectedGitRef) ||
    !deploymentPattern.test(expectedDeploymentId) ||
    !neonBranchPattern.test(expectedNeonBranchId) ||
    !neonProjectPattern.test(expectedNeonProjectId) ||
    !uuidPattern.test(actorUserId) ||
    !uuidPattern.test(crossTenantActorUserId) ||
    !uuidPattern.test(crossTenantBatchId) ||
    !uuidPattern.test(crossTenantWorkspaceId) ||
    !uuidPattern.test(workspaceId) ||
    !uuidPattern.test(batchId) ||
    !/^QA-TEST-[A-Za-z0-9-]{12,100}$/u.test(batchMarker) ||
    !/^QA-TEST-[A-Za-z0-9-]{12,100}$/u.test(crossTenantBatchMarker) ||
    !hostnamePattern.test(productionDatabaseHost)
  ) {
    fail("ACTION_SCOPE_INVALID");
  }
  if (crossTenantWorkspaceId === workspaceId || crossTenantBatchId === batchId) fail("CROSS_TENANT_SCOPE_INVALID");

  const preview = parseOrigin(clean(parsed.previewOrigin), "PREVIEW_ORIGIN", { preview: true });
  const production = parseOrigin(clean(parsed.productionOrigin), "PRODUCTION_ORIGIN");
  if (preview.origin === production.origin || preview.hostname === production.hostname) fail("PRODUCTION_TARGET_REJECTED");
  const sessionCookie = clean(parsed.sessionCookie).split(";", 1)[0]?.trim() ?? "";
  const crossTenantSessionCookie = clean(parsed.crossTenantSessionCookie).split(";", 1)[0]?.trim() ?? "";
  if (
    !sessionCookiePattern.test(sessionCookie)
    || !sessionCookiePattern.test(crossTenantSessionCookie)
    || sessionCookie === crossTenantSessionCookie
  ) fail("SESSION_INPUT_INVALID");
  const database = parseDatabaseUrl(clean(parsed.databaseUrl), productionDatabaseHost);
  const share = parseShareUrl(clean(parsed.shareUrl), preview.origin);

  const input = {
    actorFingerprint: fingerprint("qa-actor", actorUserId),
    batchFingerprint: fingerprint("qa-batch", batchId),
    crossTenantActorFingerprint: fingerprint("qa-cross-tenant-actor", crossTenantActorUserId),
    crossTenantBatchFingerprint: fingerprint("qa-cross-tenant-batch", crossTenantBatchId),
    crossTenantWorkspaceFingerprint: fingerprint("qa-cross-tenant-workspace", crossTenantWorkspaceId),
    expectedDeploymentId,
    expectedGitRef,
    expectedGitSha,
    expectedHost: preview.hostname.toLowerCase(),
    expectedNeonBranchId,
    expectedNeonProjectId,
    targetFingerprint: fingerprint("preview-runtime", `${preview.hostname}:${expectedDeploymentId}:${expectedGitSha}`),
    workspaceFingerprint: fingerprint("qa-workspace", workspaceId),
  };
  defineSecret(input, "actorUserId", actorUserId);
  defineSecret(input, "batchId", batchId);
  defineSecret(input, "batchMarker", batchMarker);
  defineSecret(input, "databaseUrl", database.toString());
  defineSecret(input, "crossTenantActorUserId", crossTenantActorUserId);
  defineSecret(input, "crossTenantBatchId", crossTenantBatchId);
  defineSecret(input, "crossTenantBatchMarker", crossTenantBatchMarker);
  defineSecret(input, "crossTenantSessionCookie", crossTenantSessionCookie);
  defineSecret(input, "crossTenantWorkspaceId", crossTenantWorkspaceId);
  defineSecret(input, "previewOrigin", preview.origin);
  defineSecret(input, "productionDatabaseHost", productionDatabaseHost);
  defineSecret(input, "productionOrigin", production.origin);
  defineSecret(input, "sessionCookie", sessionCookie);
  defineSecret(input, "shareUrl", share.toString());
  defineSecret(input, "workspaceId", workspaceId);
  return Object.freeze(input);
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) fail("LOCAL_GIT_IDENTITY_UNAVAILABLE");
  return result.stdout.trim();
}

export function requireLocalPublicRuntimeCandidate(input, cwd = process.cwd()) {
  const head = runGit(["rev-parse", "HEAD"], cwd).toLowerCase();
  const branch = runGit(["branch", "--show-current"], cwd);
  const tracked = runGit(["status", "--short", "--untracked-files=no"], cwd);
  const runnerFiles = [
    "scripts/lib/public-runtime-preview-e2e.mjs",
    "scripts/public-runtime-preview-e2e.mjs",
  ];
  const trackedRunnerFiles = new Set(runGit(["ls-files", "--", ...runnerFiles], cwd).split(/\r?\n/gu).filter(Boolean));
  const runnerDiff = runGit(["diff", "--name-only", "HEAD", "--", ...runnerFiles], cwd);
  if (
    head !== input.expectedGitSha ||
    branch !== input.expectedGitRef ||
    tracked ||
    runnerDiff ||
    runnerFiles.some((file) => !trackedRunnerFiles.has(file))
  ) {
    fail("LOCAL_CANDIDATE_MISMATCH");
  }
  return { branch, head };
}

function numberValue(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail("DATABASE_ATTESTATION_INVALID");
  return number;
}

const maximumContentSnapshotRows = 20_000;

export function fingerprintPublicRuntimeContentSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) fail("DATABASE_ATTESTATION_INVALID");
  let totalRows = 0;
  const fingerprints = snapshots.map((snapshot) => {
    if (!snapshot || typeof snapshot.name !== "string" || !Array.isArray(snapshot.rows)) {
      fail("DATABASE_ATTESTATION_INVALID");
    }
    totalRows += snapshot.rows.length;
    if (totalRows > maximumContentSnapshotRows) fail("DATABASE_SNAPSHOT_TOO_LARGE");
    const hash = createHash("sha256").update(`${snapshot.name}\0`);
    for (const row of snapshot.rows) {
      if (!row || typeof row !== "object" || !("content" in row)) {
        fail("DATABASE_ATTESTATION_INVALID");
      }
      hash.update(canonicalJson(row.content));
    }
    return {
      digest: hash.digest("hex"),
      name: snapshot.name,
      rowCount: snapshot.rows.length,
    };
  });
  return sha256(canonicalJson(fingerprints));
}

export async function inspectPublicRuntimeDatabase(input, { sqlFactory = neon } = {}) {
  const sql = sqlFactory(input.databaseUrl);
  let contentFingerprintDigest;
  let runtimeRows;
  let secondaryScopeRows;
  let scopeRows;
  try {
    const results = await sql.transaction((transaction) => [
      transaction`
        select
          set_config('app.tenant_id', ${input.workspaceId}, true) as "tenantId",
          set_config('app.actor_id', ${input.actorUserId}, true) as "actorId"
      `,
      transaction`
        select
          current_setting('neon.project_id', true) as "projectId",
          current_setting('neon.branch_id', true) as "branchId",
          current_setting('app.tenant_id', true) as "tenantId",
          current_setting('app.actor_id', true) as "actorId",
          current_database() as "databaseName",
          current_user as "databaseRole"
      `,
      transaction`
        select
          workspace.is_qa as "isQa",
          batch.batch_marker as "batchMarker",
          batch.created_by_user_id as "createdByUserId",
          batch.metadata->>'candidate' as "candidateSha",
          batch.metadata->>'deploymentId' as "deploymentId",
          batch.metadata->>'purpose' as "purpose",
          workspace.public_key as "workspacePublicKey",
          (select project.id from projects project where project.workspace_id = workspace.id order by project.created_at, project.id limit 1) as "projectId",
          (select count(*) from qa_batch_objects object where object.workspace_id = workspace.id and object.batch_id = batch.id) as "ledgerCount",
          (select count(*) from qa_reset_audit_events event where event.workspace_id = workspace.id and event.batch_id = batch.id) as "auditCount",
          (select count(*) from qa_reset_audit_events event where event.workspace_id = workspace.id and event.batch_id = batch.id and event.outcome = 'executed') as "executedCount"
        from workspaces workspace
        join qa_batches batch on batch.workspace_id = workspace.id and batch.id = ${input.batchId}::uuid
        where workspace.id = ${input.workspaceId}::uuid
        limit 1
      `,
      transaction`select to_jsonb(workspace) as content from workspaces workspace where workspace.id = ${input.workspaceId}::uuid order by workspace.id`,
      transaction`select to_jsonb(form_row) as content from forms form_row where form_row.workspace_id = ${input.workspaceId}::uuid order by form_row.id`,
      transaction`select to_jsonb(funnel) as content from funnels funnel where funnel.workspace_id = ${input.workspaceId}::uuid order by funnel.id`,
      transaction`select to_jsonb(submission) as content from form_submissions submission where submission.workspace_id = ${input.workspaceId}::uuid order by submission.id`,
      transaction`select to_jsonb(submission) as content from funnel_submissions submission where submission.workspace_id = ${input.workspaceId}::uuid order by submission.id`,
      transaction`select to_jsonb(contact) as content from contacts contact where contact.workspace_id = ${input.workspaceId}::uuid order by contact.id`,
      transaction`select to_jsonb(lead) as content from leads lead where lead.workspace_id = ${input.workspaceId}::uuid order by lead.id`,
      transaction`select to_jsonb(deal) as content from deals deal where deal.workspace_id = ${input.workspaceId}::uuid order by deal.id`,
      transaction`select to_jsonb(task_row) as content from tasks task_row where task_row.workspace_id = ${input.workspaceId}::uuid order by task_row.id`,
      transaction`select to_jsonb(consent) as content from consent_records consent where consent.workspace_id = ${input.workspaceId}::uuid order by consent.id`,
      transaction`select to_jsonb(timeline) as content from contact_timeline_items timeline where timeline.workspace_id = ${input.workspaceId}::uuid order by timeline.id`,
      transaction`select to_jsonb(audit) as content from audit_logs audit where audit.workspace_id = ${input.workspaceId}::uuid order by audit.id`,
      transaction`select to_jsonb(analytics) as content from analytics_events analytics where analytics.workspace_id = ${input.workspaceId}::uuid order by analytics.id`,
      transaction`select to_jsonb(speed) as content from speed_to_lead_events speed where speed.workspace_id = ${input.workspaceId}::uuid order by speed.id`,
      transaction`select to_jsonb(visit) as content from public_funnel_visit_events visit where visit.workspace_id = ${input.workspaceId}::uuid order by visit.id`,
      transaction`select to_jsonb(batch) as content from qa_batches batch where batch.workspace_id = ${input.workspaceId}::uuid and batch.id = ${input.batchId}::uuid order by batch.id`,
      transaction`select to_jsonb(object_row) as content from qa_batch_objects object_row where object_row.workspace_id = ${input.workspaceId}::uuid and object_row.batch_id = ${input.batchId}::uuid order by object_row.id`,
      transaction`select to_jsonb(event) as content from qa_reset_audit_events event where event.workspace_id = ${input.workspaceId}::uuid and event.batch_id = ${input.batchId}::uuid order by event.id`,
      transaction`select to_jsonb(rate_limit) as content from public_submission_rate_limits rate_limit order by rate_limit.key_hash, rate_limit.bucket_started_at`,
      transaction`select to_jsonb(idempotency) as content from public_submission_idempotency idempotency order by idempotency.idempotency_hash`,
    ], { isolationLevel: "RepeatableRead", readOnly: true });
    [, runtimeRows, scopeRows] = results;
    const snapshotNames = [
      "workspaces",
      "forms",
      "funnels",
      "form_submissions",
      "funnel_submissions",
      "contacts",
      "leads",
      "deals",
      "tasks",
      "consent_records",
      "contact_timeline_items",
      "audit_logs",
      "analytics_events",
      "speed_to_lead_events",
      "public_funnel_visit_events",
      "qa_batches",
      "qa_batch_objects",
      "qa_reset_audit_events",
      "public_submission_rate_limits",
      "public_submission_idempotency",
    ];
    contentFingerprintDigest = fingerprintPublicRuntimeContentSnapshots(
      snapshotNames.map((name, index) => ({ name, rows: results[index + 3] })),
    );
    const secondaryResults = await sql.transaction((transaction) => [
      transaction`
        select
          set_config('app.tenant_id', ${input.crossTenantWorkspaceId}, true) as "tenantId",
          set_config('app.actor_id', ${input.crossTenantActorUserId}, true) as "actorId"
      `,
      transaction`
        select
          workspace.is_qa as "isQa",
          batch.batch_marker as "batchMarker",
          batch.created_by_user_id as "createdByUserId",
          batch.metadata->>'candidate' as "candidateSha",
          batch.metadata->>'deploymentId' as "deploymentId",
          batch.metadata->>'purpose' as "purpose",
          (select count(*) from qa_batch_objects object where object.workspace_id = workspace.id and object.batch_id = batch.id) as "ledgerCount",
          (select count(*) from qa_reset_audit_events event where event.workspace_id = workspace.id and event.batch_id = batch.id) as "auditCount",
          (select count(*) from qa_reset_audit_events event where event.workspace_id = workspace.id and event.batch_id = batch.id and event.outcome = 'executed') as "executedCount"
        from workspaces workspace
        join qa_batches batch on batch.workspace_id = workspace.id and batch.id = ${input.crossTenantBatchId}::uuid
        where workspace.id = ${input.crossTenantWorkspaceId}::uuid
        limit 1
      `,
    ], { isolationLevel: "RepeatableRead", readOnly: true });
    secondaryScopeRows = secondaryResults[1];
  } catch (error) {
    fail("DATABASE_ATTESTATION_FAILED", error);
  }
  const runtime = runtimeRows?.[0];
  const scope = scopeRows?.[0];
  const secondaryScope = secondaryScopeRows?.[0];
  if (
    !runtime ||
    runtime.projectId !== input.expectedNeonProjectId ||
    runtime.branchId !== input.expectedNeonBranchId ||
    runtime.tenantId?.toLowerCase() !== input.workspaceId ||
    runtime.actorId?.toLowerCase() !== input.actorUserId ||
    runtime.databaseName !== "neondb" ||
    runtime.databaseRole !== "novalure_app" ||
    !scope ||
    scope.isQa !== true ||
    scope.batchMarker !== input.batchMarker ||
    scope.createdByUserId?.toLowerCase() !== input.actorUserId ||
    scope.candidateSha !== input.expectedGitSha ||
    scope.deploymentId !== input.expectedDeploymentId ||
    scope.purpose !== "public-runtime-preview" ||
    !uuidPattern.test(scope.projectId ?? "") ||
    !/^[a-f0-9]{32}$/u.test(scope.workspacePublicKey ?? "") ||
    numberValue(scope.ledgerCount) !== 0 ||
    numberValue(scope.auditCount) !== 0 ||
    numberValue(scope.executedCount) !== 0 ||
    !contentFingerprintDigest
    || !secondaryScope
    || secondaryScope.isQa !== true
    || secondaryScope.batchMarker !== input.crossTenantBatchMarker
    || secondaryScope.createdByUserId?.toLowerCase() !== input.crossTenantActorUserId
    || secondaryScope.candidateSha !== input.expectedGitSha
    || secondaryScope.deploymentId !== input.expectedDeploymentId
    || secondaryScope.purpose !== "public-runtime-preview"
    || numberValue(secondaryScope.ledgerCount) !== 0
    || numberValue(secondaryScope.auditCount) !== 0
    || numberValue(secondaryScope.executedCount) !== 0
  ) {
    fail("DATABASE_SCOPE_MISMATCH");
  }
  const result = {
    attestation: {
      databaseName: runtime.databaseName,
      databaseRole: runtime.databaseRole,
      isQa: true,
      neonBranchId: runtime.branchId,
      neonProjectId: runtime.projectId,
      freshBatch: true,
    },
    contentFingerprintDigest,
  };
  defineSecret(result, "projectId", scope.projectId);
  defineSecret(result, "workspacePublicKey", scope.workspacePublicKey);
  return result;
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=[^;,]+=)/gu);
}

function getSetCookies(headers) {
  return typeof headers.getSetCookie === "function" ? headers.getSetCookie() : splitSetCookie(headers.get("set-cookie"));
}

export function createPublicRuntimeCookieJar(sessionCookie) {
  const previewCookies = new Map();
  return Object.freeze({
    header(appSessionCookie = null) {
      const pairs = [...previewCookies.entries()].map(([name, value]) => `${name}=${value}`);
      if (appSessionCookie) pairs.push(appSessionCookie === true ? sessionCookie : appSessionCookie);
      return pairs.join("; ");
    },
    storePreviewAccess(headers) {
      for (const value of getSetCookies(headers)) {
        const [pair, ...attributes] = value.split(";");
        const separator = pair.indexOf("=");
        if (separator < 1) continue;
        const name = pair.slice(0, separator).trim();
        const cookieValue = pair.slice(separator + 1).trim();
        if (!/^_vercel_[A-Za-z0-9_-]{1,64}$/u.test(name)) continue;
        if (!attributes.some((attribute) => attribute.trim().toLowerCase() === "secure")) fail("SHARE_ACCESS_INVALID");
        if (!/^[A-Za-z0-9._~-]{1,4096}$/u.test(cookieValue)) fail("SHARE_ACCESS_INVALID");
        previewCookies.set(name, cookieValue);
      }
    },
  });
}

async function boundedFetch(fetchImpl, value, init = {}) {
  return fetchImpl(value, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
}

export async function bootstrapPublicRuntimeShareAccess(input, jar, fetchImpl = globalThis.fetch) {
  const access = bindVercelAutomationBypass(jar, input.shareUrl, input.previewOrigin);
  const headers = new Headers({ accept: "text/html,application/xhtml+xml" });
  applyVercelAutomationBypass(jar, access.requestUrl, headers);
  let response;
  try {
    response = await boundedFetch(fetchImpl, access.requestUrl, { headers });
  } catch {
    fail("SHARE_ACCESS_FAILED");
  }
  if (
    response.status < 200
    || response.status >= 300
    || response.headers.has("location")
    || !clean(response.headers.get("content-type")).toLowerCase().includes("text/html")
  ) {
    fail("SHARE_ACCESS_FAILED");
  }
  return { mode: access.mode, protected: true };
}

function deterministicMissingUuid(sha) {
  const chars = sha.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "8";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export const publicRuntimeReadOnlyScenarios = Object.freeze([
  { id: "public-form-shell-missing", method: "GET", expectedStatus: 404 },
  { id: "public-form-proof-invalid", method: "POST", expectedStatus: 400, expectedCode: "invalid_form_key" },
  { id: "public-form-submit-missing", method: "POST", expectedStatus: 404 },
  { id: "public-funnel-shell-missing", method: "GET", expectedStatus: 404 },
  { id: "public-funnel-proof-invalid", method: "POST", expectedStatus: 400, expectedCode: "invalid_submission_proof_refresh" },
  { id: "public-funnel-submit-invalid", method: "POST", expectedStatus: 400, expectedCode: "invalid_funnel_mode" },
  { id: "public-funnel-visit-launch-off", method: "POST", expectedStatus: 503, expectedCode: "LAUNCH_SCOPE_OFF" },
]);

function scenarioRequest(input, scenario) {
  const missingId = deterministicMissingUuid(input.expectedGitSha);
  const slug = `qa-contract-${input.expectedGitSha.slice(0, 12)}-${input.batchFingerprint.slice(-8)}`;
  if (scenario.id === "public-form-shell-missing") return { path: `/forms/${slug}` };
  if (scenario.id === "public-form-proof-invalid") {
    return { body: "", headers: { "content-type": "application/x-www-form-urlencoded" }, path: "/api/forms/submission-proof" };
  }
  if (scenario.id === "public-form-submit-missing") {
    return {
      body: new URLSearchParams({ form_slug: slug, return_to: `/forms/${slug}` }).toString(),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      path: "/api/forms/submissions",
    };
  }
  if (scenario.id === "public-funnel-shell-missing") return { path: `/preview/${missingId}?mode=live` };
  if (scenario.id === "public-funnel-proof-invalid") {
    return { body: "{}", headers: { "content-type": "application/json" }, path: `/api/funnels/${missingId}/submission-proof` };
  }
  if (scenario.id === "public-funnel-submit-invalid") {
    return {
      body: JSON.stringify({ answers: {}, consent: { analytics: false, marketing: false, privacy: true }, funnelId: missingId, mode: "blocked-contract", visitor: {} }),
      headers: { "content-type": "application/json" },
      path: `/api/funnels/${missingId}/submissions`,
    };
  }
  if (scenario.id === "public-funnel-visit-launch-off") {
    return { body: "{}", headers: { "content-type": "application/json" }, path: `/api/funnels/${missingId}/visits` };
  }
  fail("HTTP_SCENARIO_INVALID");
}

export async function requestExact(input, jar, fetchImpl, path, {
  appSessionCookie = null,
  body,
  headers: initialHeaders = {},
  method = "GET",
} = {}) {
  const url = new URL(path, input.previewOrigin);
  if (url.origin !== input.previewOrigin) fail("HTTP_TARGET_REJECTED");
  const headers = new Headers(initialHeaders);
  applyVercelAutomationBypass(jar, url, headers);
  const cookie = jar.header(appSessionCookie);
  if (cookie) headers.set("cookie", cookie);
  const response = await boundedFetch(fetchImpl, url, { body, headers, method });
  if (redirectStatuses.has(response.status)) fail("HTTP_REDIRECT_REJECTED");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 256 * 1024) fail("HTTP_RESPONSE_TOO_LARGE");
  let json = null;
  if (clean(response.headers.get("content-type")).toLowerCase().includes("application/json")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { json, response, text };
}

async function attestRuntimeSession(input, jar, fetchImpl, expected) {
  const capabilityPath = `${publicRuntimeCapabilityPath}?batchId=${encodeURIComponent(expected.batchId)}`;
  const capability = await requestExact(input, jar, fetchImpl, capabilityPath, {
    appSessionCookie: expected.sessionCookie,
  });
  const body = capability.json;
  const expectedSurfaces = [
    "blueprint",
    "formPublicSubmit",
    "formUpsert",
    "funnelCreate",
    "funnelPublicSubmit",
    "reset",
    "tokenRotation",
  ];
  if (
    capability.response.status !== 200 ||
    body?.atomicRegistration !== true ||
    body?.databaseBranchId !== input.expectedNeonBranchId ||
    body?.deploymentHost?.toLowerCase() !== input.expectedHost ||
    body?.deploymentId !== input.expectedDeploymentId ||
    body?.gitBranch !== input.expectedGitRef ||
    body?.gitSha !== input.expectedGitSha ||
    body?.sessionScope?.source !== "cookie" ||
    body?.sessionScope?.workspaceId?.toLowerCase() !== expected.workspaceId ||
    body?.sessionScope?.userId?.toLowerCase() !== expected.actorUserId ||
    body?.sessionScope?.role !== "owner" ||
    body?.sessionScope?.productRole !== "platform_admin" ||
    body?.batchCapability?.batchId?.toLowerCase() !== expected.batchId ||
    body?.batchCapability?.candidateSha !== input.expectedGitSha ||
    body?.batchCapability?.deploymentId !== input.expectedDeploymentId ||
    body?.batchCapability?.fresh !== true ||
    body?.batchCapability?.purpose !== "public-runtime-preview" ||
    !body?.publicRuntimeAtomicSurfaces ||
    Object.keys(body.publicRuntimeAtomicSurfaces).length !== expectedSurfaces.length ||
    expectedSurfaces.some((surface) => body.publicRuntimeAtomicSurfaces[surface] !== true) ||
    body?.version !== 2
  ) {
    fail("PREVIEW_RUNTIME_IDENTITY_MISMATCH");
  }
}

export async function attestRuntime(input, jar, fetchImpl) {
  await attestRuntimeSession(input, jar, fetchImpl, {
    actorUserId: input.actorUserId,
    batchId: input.batchId,
    sessionCookie: input.sessionCookie,
    workspaceId: input.workspaceId,
  });
  await attestRuntimeSession(input, jar, fetchImpl, {
    actorUserId: input.crossTenantActorUserId,
    batchId: input.crossTenantBatchId,
    sessionCookie: input.crossTenantSessionCookie,
    workspaceId: input.crossTenantWorkspaceId,
  });
}

async function runReadOnlyScenarios(input, jar, fetchImpl) {
  const results = [];
  for (const scenario of publicRuntimeReadOnlyScenarios) {
    const request = scenarioRequest(input, scenario);
    const result = await requestExact(input, jar, fetchImpl, request.path, {
      body: request.body,
      headers: request.headers,
      method: scenario.method,
    });
    const observedCode = typeof result.json?.code === "string"
      ? result.json.code
      : typeof result.json?.error === "string"
        ? result.json.error
        : null;
    if (
      result.response.status !== scenario.expectedStatus ||
      (scenario.expectedCode && observedCode !== scenario.expectedCode)
    ) {
      fail("READ_ONLY_HTTP_CONTRACT_FAILED");
    }
    results.push({
      id: scenario.id,
      method: scenario.method,
      observedCode: scenario.expectedCode ?? null,
      status: result.response.status,
    });
  }
  return results;
}

const publicRuntimeProofControlFields = Object.freeze({
  expiresAt: "_novalure_proof_expires_at",
  idempotencyKey: "_novalure_idempotency_key",
  issuedAt: "_novalure_proof_issued_at",
  proof: "_novalure_proof",
});
const minimumLongSessionMilliseconds = 901_000;
const qaHeaderName = "x-novalure-qa-batch-id";
const csrfHeaderName = "x-novalure-csrf-token";
const operationalSnapshotNames = Object.freeze([
  "forms",
  "funnels",
  "funnel_steps",
  "form_submissions",
  "funnel_submissions",
  "contacts",
  "leads",
  "deals",
  "tasks",
  "consent_records",
  "contact_timeline_items",
  "speed_to_lead_events",
  "public_funnel_visit_events",
]);

export function requireStatus(result, status, code) {
  if (result.response.status !== status) fail(code);
  return result;
}

export function requireJsonObject(result, code) {
  if (!result.json || typeof result.json !== "object" || Array.isArray(result.json)) fail(code);
  return result.json;
}

async function issueAuthenticatedCsrf(input, jar, fetchImpl, { appSessionCookie, method, path }) {
  const query = `/api/auth/csrf?method=${encodeURIComponent(method)}&path=${encodeURIComponent(path)}`;
  const result = await requestExact(input, jar, fetchImpl, query, {
    appSessionCookie,
    headers: { origin: input.previewOrigin, "sec-fetch-site": "same-origin" },
  });
  const body = requireJsonObject(requireStatus(result, 200, "CSRF_ISSUANCE_FAILED"), "CSRF_ISSUANCE_FAILED");
  if (typeof body.csrfToken !== "string" || !/^[A-Za-z0-9._-]{40,2048}$/u.test(body.csrfToken)) {
    fail("CSRF_ISSUANCE_FAILED");
  }
  return body.csrfToken;
}

export async function authenticatedMutation(input, jar, fetchImpl, {
  appSessionCookie,
  batchId = null,
  body,
  headers: initialHeaders = {},
  method = "POST",
  path,
}) {
  const csrfToken = await issueAuthenticatedCsrf(input, jar, fetchImpl, {
    appSessionCookie,
    method,
    path,
  });
  const headers = {
    ...initialHeaders,
    [csrfHeaderName]: csrfToken,
    origin: input.previewOrigin,
    "sec-fetch-site": "same-origin",
    ...(batchId ? { [qaHeaderName]: batchId } : {}),
  };
  return requestExact(input, jar, fetchImpl, path, {
    appSessionCookie,
    body,
    headers,
    method,
  });
}

function htmlDecode(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function parsePublicRuntimeProofFromHtml(html) {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > 256 * 1024) {
    fail("PUBLIC_PROOF_HTML_INVALID");
  }
  const values = {};
  for (const [key, name] of Object.entries(publicRuntimeProofControlFields)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const patterns = [
      new RegExp(`<input[^>]*\\bname=["']${escaped}["'][^>]*\\bvalue=["']([^"']+)["'][^>]*>`, "iu"),
      new RegExp(`<input[^>]*\\bvalue=["']([^"']+)["'][^>]*\\bname=["']${escaped}["'][^>]*>`, "iu"),
    ];
    const match = patterns.map((pattern) => pattern.exec(html)).find(Boolean);
    if (!match?.[1]) fail("PUBLIC_PROOF_HTML_INVALID");
    values[key] = htmlDecode(match[1]);
  }
  const proof = {
    expiresAt: Number(values.expiresAt),
    idempotencyKey: values.idempotencyKey,
    issuedAt: Number(values.issuedAt),
    signature: values.proof,
  };
  if (
    !Number.isSafeInteger(proof.expiresAt)
    || !Number.isSafeInteger(proof.issuedAt)
    || proof.expiresAt - proof.issuedAt !== 900
    || !/^[A-Za-z0-9_-]{32,128}$/u.test(proof.idempotencyKey)
    || !/^[A-Za-z0-9_-]{32,128}$/u.test(proof.signature)
  ) fail("PUBLIC_PROOF_HTML_INVALID");
  return proof;
}

function formField(input) {
  return {
    conditionalFieldId: "",
    conditionalValue: "",
    crmField: input.crmField,
    defaultValue: "",
    errorMessage: "",
    fileAccept: "",
    fileMaxMb: 0,
    helpText: input.helpText ?? "",
    id: input.id,
    label: input.label,
    maxValue: "",
    minValue: "",
    multiple: false,
    options: [],
    placeholder: "",
    required: true,
    stepId: "qa-contact",
    type: input.type,
    validationPattern: "",
  };
}

export function buildPublicRuntimeFormFixture(input) {
  const suffix = input.batchId.replaceAll("-", "").slice(0, 16);
  return {
    actions: {
      createTask: false,
      followUpEmail: false,
      internalNotification: false,
      newsletterList: false,
      redirectUrl: "",
      showMeeting: false,
      thankYouMessage: "QA saved",
    },
    campaign: "",
    conversionRate: 0,
    crmTarget: "contact",
    doubleOptIn: false,
    fields: [
      formField({ crmField: "name", id: `qa_name_${suffix}`, label: "Name", type: "text" }),
      formField({ crmField: "email", id: `qa_email_${suffix}`, label: "Email", type: "email" }),
      formField({ crmField: "privacy_consent", helpText: "Privacy", id: `qa_privacy_${suffix}`, label: "Privacy", type: "consent" }),
    ],
    funnelId: "",
    id: randomUUID(),
    lastSubmission: "",
    name: `QA Public Form ${suffix}`,
    ownerMode: "user",
    ownerUserId: input.actorUserId,
    pipelineStage: "Lead Inbox",
    progressMode: "none",
    spamProtection: true,
    status: "aktiv",
    steps: [{ description: "", id: "qa-contact", title: "Contact" }],
    submissions: 0,
    slug: `qa-public-${suffix}`,
    tags: "qa-public-runtime",
    template: "contact",
    utmCapture: true,
    variant: "embed",
    visits: 0,
  };
}

export function stripFunnelValidationPatterns(blueprint) {
  const clone = structuredClone(blueprint);
  for (const page of clone.pages ?? []) {
    for (const section of page.sections ?? []) {
      for (const row of section.rows ?? []) {
        for (const column of row.columns ?? []) {
          for (const element of column.elements ?? []) {
            for (const field of element.fields ?? []) delete field.validationPattern;
          }
        }
      }
    }
  }
  clone.status = "aktiv";
  clone.tracking = { consentMode: "internal" };
  clone.crmHandover = {
    createAppointment: false,
    createLeadInboxEntry: false,
    createTask: false,
    destination: "newsletter",
    followUp: "",
    notificationRecipients: "",
    pipelineStage: "Lead Inbox",
    qualityRule: "",
    statusTemplate: "",
  };
  return clone;
}

function buildFunnelAnswers(blueprint, uniqueSuffix) {
  const answers = {};
  const consent = { analytics: false, marketing: false, privacy: false };
  for (const page of blueprint.pages ?? []) {
    for (const section of page.sections ?? []) {
      for (const row of section.rows ?? []) {
        for (const column of row.columns ?? []) {
          for (const element of column.elements ?? []) {
            if (element.type === "choice" && element.required) answers[element.crmField || element.id] = element.options?.[0] ?? "yes";
            for (const field of element.fields ?? []) {
              const key = field.crmField || field.id;
              if (field.type === "consent") {
                answers[key] = true;
                const intent = `${field.crmField} ${field.label} ${field.helpText ?? ""}`.toLowerCase();
                const analytics = /(analytics|tracking|cookie|pixel|capi|utm|analyse)/iu.test(intent);
                const marketing = /(marketing|newsletter|whatsapp|instagram|outreach|werbung|kampagne)/iu.test(intent);
                consent.analytics ||= analytics;
                consent.marketing ||= marketing;
                consent.privacy ||= /(privacy|datenschutz|dsgvo|gdpr|terms|bedingungen)/iu.test(intent) || (!analytics && !marketing);
              } else if (field.type === "email") answers[key] = `qa-${uniqueSuffix}@example.invalid`;
              else if (field.type === "phone") answers[key] = `+431${uniqueSuffix.slice(0, 8)}`;
              else if (field.type === "number" || field.type === "slider" || field.type === "rating") answers[key] = field.min ?? 1;
              else if (field.type === "multiChoice") answers[key] = field.options?.length ? [field.options[0]] : [];
              else if (field.type === "singleChoice" || field.type === "dropdown") answers[key] = field.options?.[0] ?? "";
              else if (field.type !== "hidden" || field.required) answers[key] = `QA ${uniqueSuffix}`;
            }
          }
        }
      }
    }
  }
  return { answers, consent };
}

function createFormSubmissionBody({ fixture, formKey, proof, uniqueSuffix }) {
  const body = new FormData();
  body.set("form_id", formKey);
  body.set("form_slug", formKey);
  body.set("return_to", `/forms/${formKey}`);
  body.set("utm_source", "protected-preview-qa");
  body.set("page_url", "");
  body.set("referrer", "");
  body.set(fixture.fields[0].id, `QA ${uniqueSuffix}`);
  body.set(fixture.fields[1].id, `qa-${uniqueSuffix}@example.invalid`);
  body.set(fixture.fields[2].id, "1");
  body.set(publicRuntimeProofControlFields.idempotencyKey, proof.idempotencyKey);
  body.set(publicRuntimeProofControlFields.issuedAt, String(proof.issuedAt));
  body.set(publicRuntimeProofControlFields.expiresAt, String(proof.expiresAt));
  body.set(publicRuntimeProofControlFields.proof, proof.signature);
  body.set("_novalure_company", "");
  return body;
}

function formProofRefreshBody(formKey, proof) {
  const body = new FormData();
  body.set("form", formKey);
  body.set(publicRuntimeProofControlFields.idempotencyKey, proof.idempotencyKey);
  body.set(publicRuntimeProofControlFields.issuedAt, String(proof.issuedAt));
  body.set(publicRuntimeProofControlFields.expiresAt, String(proof.expiresAt));
  body.set(publicRuntimeProofControlFields.proof, proof.signature);
  return body;
}

function responseDigest(result) {
  return sha256(canonicalJson({ body: result.json ?? result.text, status: result.response.status }));
}

function createObservationClock(now = () => Date.now()) {
  let previous = 0;
  return (id, result, forcedTime = null) => {
    const candidate = forcedTime ?? now();
    previous = Math.max(previous + 1, candidate);
    return {
      id,
      observedAt: new Date(previous).toISOString(),
      responseSha256: responseDigest(result),
      status: result.response.status,
    };
  };
}

function makeProof(input) {
  const payload = {
    candidateCommit: input.candidateCommit,
    cleanupInventorySha256: input.cleanupInventorySha256,
    databaseInventorySha256: input.databaseInventorySha256,
    deploymentId: input.deploymentId,
    id: input.id,
    observations: input.observations,
    qaBatchId: input.qaBatchId,
    semanticEvidence: input.semanticEvidence,
    status: "PASS",
  };
  return {
    artifactFile: `${input.id}.json`,
    artifactSha256: sha256(canonicalJson(payload)),
    ...payload,
  };
}

async function submitUntilReplay(submit, initialResults) {
  const successes = initialResults.filter((result) => result.response.status === 200);
  const acceptable = initialResults.every((result) =>
    result.response.status === 200
    || (result.response.status === 409 && result.json?.error === "submission_in_progress"));
  if (!acceptable || successes.length === 0) fail("PUBLIC_SUBMISSION_PARALLEL_CONTRACT_FAILED");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const replay = await submit();
    if (replay.response.status === 200) return replay;
    if (replay.response.status !== 409 || replay.json?.error !== "submission_in_progress") {
      fail("PUBLIC_SUBMISSION_REPLAY_FAILED");
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  fail("PUBLIC_SUBMISSION_REPLAY_FAILED");
}

export function createPublicRuntimeDatabaseStore(input, { sqlFactory = neon } = {}) {
  const sql = sqlFactory(input.databaseUrl);
  const readOnly = (build) => sql.transaction((transaction) => [
    transaction`
      select
        set_config('app.tenant_id', ${input.workspaceId}, true) as "tenantId",
        set_config('app.actor_id', ${input.actorUserId}, true) as "actorId"
    `,
    ...build(transaction),
  ], { isolationLevel: "RepeatableRead", readOnly: true });

  return Object.freeze({
    async inventory() {
      let results;
      try {
        results = await readOnly((transaction) => [
          transaction`select to_jsonb(row) as content from forms row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from funnels row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from funnel_steps row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from form_submissions row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from funnel_submissions row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from contacts row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from leads row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from deals row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from tasks row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from consent_records row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from contact_timeline_items row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from speed_to_lead_events row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
          transaction`select to_jsonb(row) as content from public_funnel_visit_events row where row.workspace_id = ${input.workspaceId}::uuid order by row.id`,
        ]);
      } catch (error) {
        fail("DATABASE_OPERATIONAL_INVENTORY_FAILED", error);
      }
      const snapshots = operationalSnapshotNames.map((name, index) => ({ name, rows: results[index + 1] }));
      return {
        digest: fingerprintPublicRuntimeContentSnapshots(snapshots),
        rowCount: snapshots.reduce((total, snapshot) => total + snapshot.rows.length, 0),
      };
    },
    async retainedInventory() {
      let results;
      try {
        results = await readOnly((transaction) => [
          transaction`select id::text as member from audit_logs where workspace_id = ${input.workspaceId}::uuid order by id`,
          transaction`select id::text as member from analytics_events where workspace_id = ${input.workspaceId}::uuid order by id`,
          transaction`select token_hash as member from csrf_token_consumptions order by token_hash`,
          transaction`select idempotency_hash as member from public_submission_idempotency order by idempotency_hash`,
          transaction`select concat(key_hash, ':', bucket_started_at::text) as member from public_submission_rate_limits order by key_hash, bucket_started_at`,
          transaction`select id::text as member from qa_batch_objects where workspace_id = ${input.workspaceId}::uuid and batch_id = ${input.batchId}::uuid order by id`,
          transaction`select id::text as member from qa_reset_audit_events where workspace_id = ${input.workspaceId}::uuid and batch_id = ${input.batchId}::uuid order by id`,
        ]);
      } catch (error) {
        fail("DATABASE_RETAINED_INVENTORY_FAILED", error);
      }
      const names = [
        "audit_logs",
        "analytics_events",
        "csrf_token_consumptions",
        "public_submission_idempotency",
        "public_submission_rate_limits",
        "qa_batch_objects",
        "qa_reset_audit_events",
      ];
      const tables = Object.fromEntries(names.map((name, index) => {
        const members = (results[index + 1] ?? []).map((row) => {
          if (typeof row?.member !== "string" || row.member.length === 0) {
            fail("DATABASE_RETAINED_INVENTORY_FAILED");
          }
          return sha256(`${name}\0${row.member}`);
        }).sort();
        if (new Set(members).size !== members.length) fail("DATABASE_RETAINED_INVENTORY_FAILED");
        return [name, {
          digest: sha256(canonicalJson(members)),
          members,
          rowCount: members.length,
        }];
      }));
      const summary = Object.fromEntries(names.map((name) => [name, {
        digest: tables[name].digest,
        rowCount: tables[name].rowCount,
      }]));
      return {
        digest: sha256(canonicalJson(summary)),
        rowCount: Object.values(tables).reduce((sum, table) => sum + table.rowCount, 0),
        tables,
      };
    },
    async verifyFormSubmission(formId) {
      let results;
      try {
        results = await readOnly((transaction) => [transaction`
          select
            submission.id,
            submission.contact_id as "contactId",
            contact.id as "linkedContactId"
          from form_submissions submission
          left join contacts contact
            on contact.workspace_id = submission.workspace_id
           and contact.id = submission.contact_id
          where submission.workspace_id = ${input.workspaceId}::uuid
            and submission.form_id = ${formId}::uuid
          order by submission.id
        `]);
      } catch (error) {
        fail("DATABASE_FORM_SUBMISSION_VERIFY_FAILED", error);
      }
      const rows = results[1];
      if (rows.length !== 1 || !rows[0].id || !rows[0].contactId || rows[0].linkedContactId !== rows[0].contactId) {
        fail("DATABASE_FORM_SUBMISSION_EXACTLY_ONCE_FAILED");
      }
      return { digest: sha256(canonicalJson(rows)), submissionId: rows[0].id };
    },
    async verifyFunnelSubmission(funnelId) {
      let results;
      try {
        results = await readOnly((transaction) => [transaction`
          select
            submission.id,
            submission.contact_id as "contactId",
            contact.id as "linkedContactId"
          from funnel_submissions submission
          left join contacts contact
            on contact.workspace_id = submission.workspace_id
           and contact.id = submission.contact_id
          where submission.workspace_id = ${input.workspaceId}::uuid
            and submission.funnel_id = ${funnelId}::uuid
          order by submission.id
        `]);
      } catch (error) {
        fail("DATABASE_FUNNEL_SUBMISSION_VERIFY_FAILED", error);
      }
      const rows = results[1];
      if (rows.length !== 1 || !rows[0].id || !rows[0].contactId || rows[0].linkedContactId !== rows[0].contactId) {
        fail("DATABASE_FUNNEL_SUBMISSION_EXACTLY_ONCE_FAILED");
      }
      return { digest: sha256(canonicalJson(rows)), submissionId: rows[0].id };
    },
    async funnelState(funnelId) {
      let results;
      try {
        results = await readOnly((transaction) => [transaction`
          select
            blueprint,
            coalesce((tracking->>'publicationRevision')::integer, 0) as revision
          from funnels
          where workspace_id = ${input.workspaceId}::uuid and id = ${funnelId}::uuid
          limit 1
        `]);
      } catch (error) {
        fail("DATABASE_FUNNEL_STATE_FAILED", error);
      }
      const row = results[1]?.[0];
      if (!row || !Number.isSafeInteger(Number(row.revision))) fail("DATABASE_FUNNEL_STATE_FAILED");
      return { blueprintDigest: sha256(canonicalJson(row.blueprint)), revision: Number(row.revision) };
    },
    async remainingBatchObjectCount() {
      let results;
      try {
        results = await readOnly((transaction) => [transaction`
          select count(*) as count
          from qa_batch_objects object
          where object.workspace_id = ${input.workspaceId}::uuid
            and object.batch_id = ${input.batchId}::uuid
            and object.resource_scope = 'database'
            and (
              (object.resource_type = 'forms' and exists (select 1 from forms row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'funnels' and exists (select 1 from funnels row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'funnel_steps' and exists (select 1 from funnel_steps row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'form_submissions' and exists (select 1 from form_submissions row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'funnel_submissions' and exists (select 1 from funnel_submissions row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'contacts' and exists (select 1 from contacts row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'leads' and exists (select 1 from leads row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'deals' and exists (select 1 from deals row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'tasks' and exists (select 1 from tasks row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'consent_records' and exists (select 1 from consent_records row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'contact_timeline_items' and exists (select 1 from contact_timeline_items row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              or (object.resource_type = 'speed_to_lead_events' and exists (select 1 from speed_to_lead_events row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
            )
        `]);
      } catch (error) {
        fail("DATABASE_CLEANUP_RECONCILIATION_FAILED", error);
      }
      return numberValue(results[1]?.[0]?.count);
    },
  });
}

export async function resetQaBatch(input, jar, fetchImpl, { batchId, sessionCookie, workspaceId }) {
  const resetPath = "/api/admin/qa-reset";
  const dryRun = await authenticatedMutation(input, jar, fetchImpl, {
    appSessionCookie: sessionCookie,
    body: JSON.stringify({ batchId, confirmation: null, expectedPlanDigest: null, mode: "dry_run", workspaceId }),
    headers: { "content-type": "application/json" },
    path: resetPath,
  });
  const dryBody = requireJsonObject(requireStatus(dryRun, 200, "QA_RESET_DRY_RUN_FAILED"), "QA_RESET_DRY_RUN_FAILED");
  if (dryBody.outcome !== "dry_run" || !/^[a-f0-9]{64}$/u.test(dryBody.plan?.digest ?? "") || dryBody.plan?.blockers?.length !== 0) {
    fail("QA_RESET_DRY_RUN_FAILED");
  }
  const execute = await authenticatedMutation(input, jar, fetchImpl, {
    appSessionCookie: sessionCookie,
    body: JSON.stringify({
      batchId,
      confirmation: `RESET QA BATCH ${workspaceId} ${batchId}`,
      expectedPlanDigest: dryBody.plan.digest,
      mode: "execute",
      workspaceId,
    }),
    headers: { "content-type": "application/json" },
    path: resetPath,
  });
  const executeBody = requireJsonObject(requireStatus(execute, 200, "QA_RESET_EXECUTE_FAILED"), "QA_RESET_EXECUTE_FAILED");
  if (executeBody.outcome !== "executed" || executeBody.plan?.digest !== dryBody.plan.digest) fail("QA_RESET_EXECUTE_FAILED");
  const createdObjectCount = Object.values(dryBody.plan.targetCounts ?? {}).reduce((sum, value) => sum + numberValue(value), 0);
  const deletedObjectCount = Object.values(executeBody.deletedCounts ?? {}).reduce((sum, value) => sum + numberValue(value), 0);
  if (createdObjectCount !== deletedObjectCount) fail("QA_RESET_COUNT_MISMATCH");
  return { createdObjectCount, deletedObjectCount, digest: dryBody.plan.digest };
}

export function scanRepositoryForTokens(tokens, cwd = process.cwd(), spawn = spawnSync) {
  if (
    !Array.isArray(tokens)
    || tokens.length !== 2
    || tokens.some((token) => !/^[A-Za-z0-9_-]{43}$/u.test(token))
  ) fail("PUBLISH_TOKEN_REPOSITORY_SCAN_FAILED");
  const result = spawn(
    "git",
    ["grep", "--cached", "--quiet", "--fixed-strings", "-f", "-", "--"],
    {
      cwd,
      encoding: "utf8",
      input: `${tokens.join("\n")}\n`,
      windowsHide: true,
    },
  );
  if (result.status === 0) fail("PUBLISH_TOKEN_REPOSITORY_REFERENCE_FOUND");
  if (result.status !== 1) fail("PUBLISH_TOKEN_REPOSITORY_SCAN_FAILED");
  return sha256(canonicalJson({
    scanner: "git-grep-index-stdin-v1",
    state: result.status,
    tokenCount: tokens.length,
  }));
}

export async function inspectPublicMutationCleanupContract({
  read,
  repositoryRoot = process.cwd(),
} = {}) {
  const root = await realpath(path.resolve(repositoryRoot));
  const readCandidateSource = read ?? (async (relativePath) => {
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("PUBLIC_MUTATION_SOURCE_PATH_INVALID");
    }
    const state = await lstat(candidate);
    if (state.isSymbolicLink() || !state.isFile() || state.size <= 0 || state.size > 8 * 1024 * 1024) {
      fail("PUBLIC_MUTATION_SOURCE_FILE_INVALID");
    }
    const resolved = await realpath(candidate);
    const resolvedRelative = path.relative(root, resolved);
    if (!resolvedRelative || resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
      fail("PUBLIC_MUTATION_SOURCE_PATH_INVALID");
    }
    return readFile(resolved, "utf8");
  });
  const files = Object.freeze({
    blueprint: "src/app/api/funnels/[funnelId]/blueprint/route.ts",
    capability: "src/app/api/admin/qa-batch-capability/route.ts",
    formRepository: "src/lib/db/form-repositories.ts",
    formRoute: "src/app/api/forms/route.ts",
    funnelRepository: "src/lib/db/runtime-repositories.ts",
    funnelRoute: "src/app/api/crm/funnels/route.ts",
    launchScope: "src/lib/launch-scope.ts",
    qaRepository: "src/lib/db/qa-batch-registration-repository.ts",
    resetRoute: "src/app/api/admin/qa-reset/route.ts",
    tokenRoute: "src/app/api/admin/funnels/[funnelId]/publish-token/cutover/route.ts",
  });
  const entries = await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readCandidateSource(file)]));
  const sources = Object.fromEntries(entries);
  const checks = [
    /qaPublicRuntimeAtomicSurfaces/iu.test(sources.capability) && /batchCapability/iu.test(sources.capability),
    /qaBatchCapabilityVersion\s*=\s*2/iu.test(await readCandidateSource("src/lib/qa-batch-runtime.ts")),
    /readQaBatchMutationHeader/iu.test(sources.formRoute) && /qaBatchSuccessHeaders/iu.test(sources.formRoute),
    /assertQaBatchForMutation/iu.test(sources.formRepository) && /findActiveQaBatchForObject/iu.test(sources.formRepository),
    /registerQaBatchObjectsWithOwnershipGuard/iu.test(sources.formRepository),
    /readQaBatchMutationHeader/iu.test(sources.funnelRoute) && /evaluateEditorPreflight/iu.test(sources.funnelRoute),
    /findActiveQaBatchForObject/iu.test(sources.funnelRepository) && /registerQaBatchObjects/iu.test(sources.funnelRepository),
    /readQaBatchMutationHeader/iu.test(sources.blueprint) && /qaBatchRuntimeErrorResponse/iu.test(sources.blueprint),
    /readQaBatchMutationHeader/iu.test(sources.tokenRoute),
    /runQaBatchReset/iu.test(sources.resetRoute) && /expectedPlanDigest/iu.test(sources.resetRoute),
    /QA_BATCH_ACTOR_MISMATCH/iu.test(sources.qaRepository) && /current_setting\('app\.actor_id'/iu.test(sources.qaRepository),
    /qaBatchMutation:[\s\S]*platform_admin/iu.test(sources.launchScope),
  ];
  const ready = checks.every(Boolean);
  return {
    mutationEnabledByRunner: ready,
    reasonCode: ready ? null : "PUBLIC_MUTATION_ATOMIC_CLEANUP_UNAVAILABLE",
    status: ready ? "PASS" : "BLOCKED",
  };
}

export async function executePublicRuntimePreview({
  databaseInspector = inspectPublicRuntimeDatabase,
  databaseStore: suppliedDatabaseStore,
  env = process.env,
  fetchImpl = globalThis.fetch,
  input,
  now = () => Date.now(),
  repositoryScanner = scanRepositoryForTokens,
  requireLocalIdentity = true,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  sourceInspector = inspectPublicMutationCleanupContract,
} = {}) {
  if (!input) fail("ACTION_INPUT_REQUIRED");
  const repositoryRoot = env.NOVALURE_REPOSITORY_ROOT || process.cwd();
  if (requireLocalIdentity) requireLocalPublicRuntimeCandidate(input, repositoryRoot);
  const cleanupContract = await sourceInspector({ repositoryRoot });
  if (
    cleanupContract?.status !== "PASS"
    || cleanupContract.mutationEnabledByRunner !== true
    || cleanupContract.reasonCode !== null
  ) fail("PUBLIC_MUTATION_ATOMIC_CLEANUP_UNAVAILABLE");

  const before = await databaseInspector(input);
  const databaseStore = suppliedDatabaseStore ?? createPublicRuntimeDatabaseStore(input);
  const jar = createPublicRuntimeCookieJar(input.sessionCookie);
  const observe = createObservationClock(now);
  let access = null;
  let baseline = null;
  let retainedBefore = null;
  let retainedAfter = null;
  let primaryReset = null;
  let secondaryReset = null;
  let cleanupAuthorized = false;
  let failure = null;
  let resultData = null;
  try {
    access = await bootstrapPublicRuntimeShareAccess(input, jar, fetchImpl);
    await attestRuntime(input, jar, fetchImpl);
    cleanupAuthorized = true;
    const requests = await runReadOnlyScenarios(input, jar, fetchImpl);
    baseline = await databaseStore.inventory();
    retainedBefore = await databaseStore.retainedInventory();

    const formFixture = buildPublicRuntimeFormFixture(input);
    const formCreate = await authenticatedMutation(input, jar, fetchImpl, {
      appSessionCookie: input.sessionCookie,
      batchId: input.batchId,
      body: JSON.stringify({ expectedVersion: 0, form: formFixture }),
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      path: "/api/forms",
    });
    const formCreateBody = requireJsonObject(requireStatus(formCreate, 200, "PUBLIC_FORM_CREATE_FAILED"), "PUBLIC_FORM_CREATE_FAILED");
    const form = formCreateBody.form;
    if (
      formCreateBody.persisted !== true
      || !uuidPattern.test(form?.id ?? "")
      || form?.ownerUserId?.toLowerCase() !== input.actorUserId
      || form?.status !== "aktiv"
      || formCreate.response.headers.get(qaHeaderName)?.toLowerCase() !== input.batchId
      || formCreate.response.headers.get("x-novalure-qa-batch-registration") !== "committed"
    ) fail("PUBLIC_FORM_CREATE_FAILED");
    const formKey = `${before.workspacePublicKey}/${form.slug}`;
    const formPublicPath = `/forms/${encodeURIComponent(before.workspacePublicKey)}/${encodeURIComponent(form.slug)}`;
    const formPage = requireStatus(
      await requestExact(input, jar, fetchImpl, formPublicPath),
      200,
      "PUBLIC_FORM_PAGE_FAILED",
    );
    const initialFormProof = parsePublicRuntimeProofFromHtml(formPage.text);
    const formInitialObservation = observe("initial-proof-issued", formPage);

    const funnelCreate = await authenticatedMutation(input, jar, fetchImpl, {
      appSessionCookie: input.sessionCookie,
      batchId: input.batchId,
      body: JSON.stringify({
        funnel: {
          audience: "Käufer",
          conversionRate: 0,
          entryChannel: "Website",
          goal: "QA public runtime",
          id: randomUUID(),
          leads: 0,
          name: `QA Public Funnel ${input.batchId.slice(0, 8)}`,
          ownerUserId: input.actorUserId,
          projectId: before.projectId,
          status: "entwurf",
          visits: 0,
        },
        steps: [],
      }),
      headers: { "content-type": "application/json" },
      path: "/api/crm/funnels",
    });
    const funnelCreateBody = requireJsonObject(requireStatus(funnelCreate, 200, "PUBLIC_FUNNEL_CREATE_FAILED"), "PUBLIC_FUNNEL_CREATE_FAILED");
    const funnel = funnelCreateBody.funnel;
    if (
      funnelCreateBody.persisted !== true
      || !uuidPattern.test(funnel?.id ?? "")
      || funnel?.ownerUserId?.toLowerCase() !== input.actorUserId
      || funnelCreate.response.headers.get(qaHeaderName)?.toLowerCase() !== input.batchId
      || funnelCreate.response.headers.get("x-novalure-qa-batch-registration") !== "committed"
    ) fail("PUBLIC_FUNNEL_CREATE_FAILED");
    const blueprintPath = `/api/funnels/${encodeURIComponent(funnel.id)}/blueprint`;
    const blueprintGet = await requestExact(input, jar, fetchImpl, blueprintPath, {
      appSessionCookie: input.sessionCookie,
    });
    const blueprintGetBody = requireJsonObject(requireStatus(blueprintGet, 200, "PUBLIC_FUNNEL_BLUEPRINT_LOAD_FAILED"), "PUBLIC_FUNNEL_BLUEPRINT_LOAD_FAILED");
    if (!Number.isSafeInteger(blueprintGetBody.blueprintRevision) || !blueprintGetBody.blueprint) {
      fail("PUBLIC_FUNNEL_BLUEPRINT_LOAD_FAILED");
    }
    const liveBlueprint = stripFunnelValidationPatterns(blueprintGetBody.blueprint);
    const blueprintPut = await authenticatedMutation(input, jar, fetchImpl, {
      appSessionCookie: input.sessionCookie,
      batchId: input.batchId,
      body: JSON.stringify({
        blueprint: liveBlueprint,
        expectedBlueprintRevision: blueprintGetBody.blueprintRevision,
        label: "Protected Preview Public QA",
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
      path: blueprintPath,
    });
    const blueprintPutBody = requireJsonObject(requireStatus(blueprintPut, 200, "PUBLIC_FUNNEL_PUBLISH_FAILED"), "PUBLIC_FUNNEL_PUBLISH_FAILED");
    if (
      blueprintPutBody.blueprint?.status !== "aktiv"
      || blueprintPutBody.preflight?.ok !== true
      || blueprintPut.response.headers.get(qaHeaderName)?.toLowerCase() !== input.batchId
    ) fail("PUBLIC_FUNNEL_PUBLISH_FAILED");

    const tokenPath = `/api/admin/funnels/${encodeURIComponent(funnel.id)}/publish-token/cutover`;
    const initialTokenStatus = await requestExact(input, jar, fetchImpl, tokenPath, {
      appSessionCookie: input.sessionCookie,
    });
    const initialTokenStatusBody = requireJsonObject(requireStatus(initialTokenStatus, 200, "PUBLISH_TOKEN_STATUS_FAILED"), "PUBLISH_TOKEN_STATUS_FAILED");
    if (!Number.isSafeInteger(initialTokenStatusBody.revision)) fail("PUBLISH_TOKEN_STATUS_FAILED");
    const firstRotation = await authenticatedMutation(input, jar, fetchImpl, {
      appSessionCookie: input.sessionCookie,
      batchId: input.batchId,
      body: JSON.stringify({ expectedRevision: initialTokenStatusBody.revision }),
      headers: { "content-type": "application/json", "idempotency-key": `qa-initial-${randomUUID()}` },
      path: tokenPath,
    });
    const firstRotationBody = requireJsonObject(requireStatus(firstRotation, 200, "PUBLISH_TOKEN_INITIAL_ROTATION_FAILED"), "PUBLISH_TOKEN_INITIAL_ROTATION_FAILED");
    const oldToken = firstRotationBody.publishToken;
    if (!/^[A-Za-z0-9_-]{43}$/u.test(oldToken ?? "") || !Number.isSafeInteger(firstRotationBody.revision)) {
      fail("PUBLISH_TOKEN_INITIAL_ROTATION_FAILED");
    }
    const oldFunnelPath = `/preview/${encodeURIComponent(funnel.id)}?mode=live&token=${encodeURIComponent(oldToken)}`;
    const funnelPage = requireStatus(
      await requestExact(input, jar, fetchImpl, oldFunnelPath),
      200,
      "PUBLIC_FUNNEL_PAGE_FAILED",
    );
    const initialFunnelProof = parsePublicRuntimeProofFromHtml(funnelPage.text);
    const funnelInitialObservation = observe("initial-revision-proof-issued", funnelPage);

    const crossForm = await requestExact(
      input,
      jar,
      fetchImpl,
      `/api/forms/resolve?form=${encodeURIComponent(formKey)}`,
      { appSessionCookie: input.crossTenantSessionCookie },
    );
    requireStatus(crossForm, 404, "CROSS_TENANT_FORM_ISOLATION_FAILED");
    const crossFunnel = await requestExact(input, jar, fetchImpl, blueprintPath, {
      appSessionCookie: input.crossTenantSessionCookie,
    });
    requireStatus(crossFunnel, 404, "CROSS_TENANT_FUNNEL_ISOLATION_FAILED");
    const crossToken = await requestExact(input, jar, fetchImpl, tokenPath, {
      appSessionCookie: input.crossTenantSessionCookie,
    });
    requireStatus(crossToken, 404, "CROSS_TENANT_TOKEN_ISOLATION_FAILED");

    const longSessionStart = now();
    await sleep(minimumLongSessionMilliseconds);
    const elapsedMilliseconds = now() - longSessionStart;
    if (elapsedMilliseconds < minimumLongSessionMilliseconds) fail("PUBLIC_PROOF_LONG_SESSION_TOO_SHORT");

    const uniqueSuffix = input.batchId.replaceAll("-", "").slice(0, 20);
    const expiredForm = await requestExact(input, jar, fetchImpl, "/api/forms/submissions", {
      body: createFormSubmissionBody({ fixture: formFixture, formKey, proof: initialFormProof, uniqueSuffix }),
      headers: { accept: "application/json" },
      method: "POST",
    });
    if (expiredForm.response.status !== 400 || expiredForm.json?.error !== "submission_proof_expired") {
      fail("PUBLIC_FORM_OLD_PROOF_NOT_REJECTED");
    }
    const formExpiredObservation = observe("old-proof-rejected", expiredForm);
    const formRefresh = await requestExact(input, jar, fetchImpl, "/api/forms/submission-proof", {
      body: formProofRefreshBody(formKey, initialFormProof),
      method: "POST",
    });
    const formRefreshBody = requireJsonObject(requireStatus(formRefresh, 200, "PUBLIC_FORM_PROOF_REFRESH_FAILED"), "PUBLIC_FORM_PROOF_REFRESH_FAILED");
    const refreshedFormProof = formRefreshBody.proof;
    if (
      refreshedFormProof?.idempotencyKey !== initialFormProof.idempotencyKey
      || !Number.isSafeInteger(refreshedFormProof.issuedAt)
      || !Number.isSafeInteger(refreshedFormProof.expiresAt)
      || !/^[A-Za-z0-9_-]{32,128}$/u.test(refreshedFormProof.signature ?? "")
    ) fail("PUBLIC_FORM_PROOF_REFRESH_FAILED");
    const formRefreshObservation = observe("refresh-issued-after-long-session", formRefresh);

    const funnelAnswers = buildFunnelAnswers(liveBlueprint, uniqueSuffix);
    const funnelPayload = (proof) => ({
      answers: funnelAnswers.answers,
      consent: funnelAnswers.consent,
      funnelId: funnel.id,
      mode: "live",
      publicSubmission: { honeypot: "", intentId: randomUUID(), proof },
      visitor: {},
    });
    const funnelIntentId = randomUUID();
    const stableFunnelPayload = (proof) => ({
      ...funnelPayload(proof),
      publicSubmission: { honeypot: "", intentId: funnelIntentId, proof },
    });
    const funnelSubmissionPath = `/api/funnels/${encodeURIComponent(funnel.id)}/submissions`;
    const expiredFunnel = await requestExact(input, jar, fetchImpl, funnelSubmissionPath, {
      body: JSON.stringify(stableFunnelPayload(initialFunnelProof)),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (expiredFunnel.response.status !== 400 || expiredFunnel.json?.error !== "submission_proof_expired") {
      fail("PUBLIC_FUNNEL_OLD_PROOF_NOT_REJECTED");
    }
    const funnelExpiredObservation = observe("old-proof-rejected", expiredFunnel);
    const funnelRefreshPath = `/api/funnels/${encodeURIComponent(funnel.id)}/submission-proof`;
    const funnelRefresh = await requestExact(input, jar, fetchImpl, funnelRefreshPath, {
      body: JSON.stringify({ proof: initialFunnelProof, publicationRevision: firstRotationBody.revision }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const funnelRefreshBody = requireJsonObject(requireStatus(funnelRefresh, 200, "PUBLIC_FUNNEL_PROOF_REFRESH_FAILED"), "PUBLIC_FUNNEL_PROOF_REFRESH_FAILED");
    const refreshedFunnelProof = funnelRefreshBody.proof;
    if (
      refreshedFunnelProof?.idempotencyKey !== initialFunnelProof.idempotencyKey
      || funnelRefreshBody.publicationRevision !== firstRotationBody.revision
      || !/^[A-Za-z0-9_-]{32,128}$/u.test(refreshedFunnelProof.signature ?? "")
    ) fail("PUBLIC_FUNNEL_PROOF_REFRESH_FAILED");
    const funnelRefreshObservation = observe("refresh-issued-after-long-session", funnelRefresh);

    const submitForm = () => requestExact(input, jar, fetchImpl, "/api/forms/submissions", {
      body: createFormSubmissionBody({ fixture: formFixture, formKey, proof: refreshedFormProof, uniqueSuffix }),
      headers: { accept: "application/json" },
      method: "POST",
    });
    const formParallel = await Promise.all([submitForm(), submitForm()]);
    const formReplay = await submitUntilReplay(submitForm, formParallel);
    const formAccepted = formParallel.find((entry) => entry.response.status === 200) ?? formReplay;
    const formProofAcceptedObservation = observe("refreshed-proof-accepted", formAccepted);

    const submitFunnel = () => requestExact(input, jar, fetchImpl, funnelSubmissionPath, {
      body: JSON.stringify(stableFunnelPayload(refreshedFunnelProof)),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const funnelParallel = await Promise.all([submitFunnel(), submitFunnel()]);
    const funnelReplay = await submitUntilReplay(submitFunnel, funnelParallel);
    const funnelAccepted = funnelParallel.find((entry) => entry.response.status === 200) ?? funnelReplay;
    const funnelProofAcceptedObservation = observe("refreshed-revision-proof-accepted", funnelAccepted);

    const formPersistence = await databaseStore.verifyFormSubmission(form.id);
    const funnelPersistence = await databaseStore.verifyFunnelSubmission(funnel.id);
    const funnelStateBeforeRotation = await databaseStore.funnelState(funnel.id);
    const secondRotation = await authenticatedMutation(input, jar, fetchImpl, {
      appSessionCookie: input.sessionCookie,
      batchId: input.batchId,
      body: JSON.stringify({ expectedRevision: firstRotationBody.revision }),
      headers: { "content-type": "application/json", "idempotency-key": `qa-final-${randomUUID()}` },
      path: tokenPath,
    });
    const secondRotationBody = requireJsonObject(requireStatus(secondRotation, 200, "PUBLISH_TOKEN_FINAL_ROTATION_FAILED"), "PUBLISH_TOKEN_FINAL_ROTATION_FAILED");
    const newToken = secondRotationBody.publishToken;
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(newToken ?? "")
      || newToken === oldToken
      || secondRotationBody.revision !== firstRotationBody.revision + 1
    ) fail("PUBLISH_TOKEN_FINAL_ROTATION_FAILED");
    const newTokenResponse = requireStatus(
      await requestExact(input, jar, fetchImpl, `/preview/${encodeURIComponent(funnel.id)}?mode=live&token=${encodeURIComponent(newToken)}`),
      200,
      "PUBLISH_TOKEN_NEW_REJECTED",
    );
    const oldTokenResponse = await requestExact(input, jar, fetchImpl, oldFunnelPath);
    if (oldTokenResponse.response.status !== 404 && oldTokenResponse.response.status !== 410) {
      fail("PUBLISH_TOKEN_OLD_ACCEPTED");
    }
    const funnelStateAfterRotation = await databaseStore.funnelState(funnel.id);
    if (
      funnelStateAfterRotation.blueprintDigest !== funnelStateBeforeRotation.blueprintDigest
      || funnelStateAfterRotation.revision !== secondRotationBody.revision
    ) fail("PUBLISH_TOKEN_BLUEPRINT_DRIFT");
    const repositoryScanSha256 = repositoryScanner([oldToken, newToken], repositoryRoot);
    const runtimeInventory = await databaseStore.inventory();

    primaryReset = await resetQaBatch(input, jar, fetchImpl, {
      batchId: input.batchId,
      sessionCookie: input.sessionCookie,
      workspaceId: input.workspaceId,
    });
    secondaryReset = await resetQaBatch(input, jar, fetchImpl, {
      batchId: input.crossTenantBatchId,
      sessionCookie: input.crossTenantSessionCookie,
      workspaceId: input.crossTenantWorkspaceId,
    });
    if (secondaryReset.createdObjectCount !== 0 || secondaryReset.deletedObjectCount !== 0) {
      fail("CROSS_TENANT_BATCH_NOT_FRESH");
    }
    const after = await databaseStore.inventory();
    retainedAfter = await databaseStore.retainedInventory();
    const remainingObjectCount = await databaseStore.remainingBatchObjectCount();
    if (
      primaryReset.createdObjectCount <= 0
      || baseline.digest !== after.digest
      || remainingObjectCount !== 0
    ) fail("PUBLIC_RUNTIME_CLEANUP_NOT_ZERO");
    const cleanup = {
      createdObjectCount: primaryReset.createdObjectCount,
      databaseCleanup: "VERIFIED_ZERO",
      deletedObjectCount: primaryReset.deletedObjectCount,
      exactPrePostContentFingerprintMatch: true,
      inventoryAfterSha256: after.digest,
      inventoryBeforeSha256: baseline.digest,
      qaBatchId: input.batchId,
      remainingObjectCount,
      status: "PASS",
    };
    const cleanupInventorySha256 = sha256(canonicalJson(cleanup));
    const formSubmissionObservations = [
      observe("crm-link-verified", { json: { digest: formPersistence.digest }, response: { status: 200 }, text: "" }),
      observe("idempotent-replay-verified", formReplay),
      observe("persisted-exactly-once", { json: { count: 1 }, response: { status: 200 }, text: "" }),
      observe("submission-accepted", formAccepted),
    ];
    const funnelSubmissionObservations = [
      observe("crm-link-verified", { json: { digest: funnelPersistence.digest }, response: { status: 200 }, text: "" }),
      observe("idempotent-replay-verified", funnelReplay),
      observe("persisted-exactly-once", { json: { count: 1 }, response: { status: 200 }, text: "" }),
      observe("revision-bound-submission-accepted", funnelAccepted),
    ];
    const tokenObservations = [
      observe("new-token-accepted", newTokenResponse),
      observe("old-token-rejected", oldTokenResponse),
      observe("published-revision-preserved", { json: funnelStateAfterRotation, response: { status: 200 }, text: "" }),
      observe("repository-token-reference-absent", { json: { digest: repositoryScanSha256 }, response: { status: 200 }, text: "" }),
    ];
    const commonProof = {
      candidateCommit: input.expectedGitSha,
      cleanupInventorySha256,
      databaseInventorySha256: runtimeInventory.digest,
      deploymentId: input.expectedDeploymentId,
      qaBatchId: input.batchId,
    };
    const proofs = [
      makeProof({
        ...commonProof,
        id: "public-form-long-proof-refresh",
        observations: [formInitialObservation, formExpiredObservation, formRefreshObservation, formProofAcceptedObservation],
        semanticEvidence: {
          idempotencyKeyAfterSha256: sha256(refreshedFormProof.idempotencyKey),
          idempotencyKeyBeforeSha256: sha256(initialFormProof.idempotencyKey),
          minimumElapsedSeconds: Math.floor((Date.parse(formExpiredObservation.observedAt) - Date.parse(formInitialObservation.observedAt)) / 1000),
          oldProofRejectionCode: "submission_proof_expired",
        },
      }),
      makeProof({
        ...commonProof,
        id: "public-form-live-submission",
        observations: formSubmissionObservations,
        semanticEvidence: {
          createdObjectCount: 1,
          idempotencyKeySha256: sha256(refreshedFormProof.idempotencyKey),
          idempotentReplayCreatedObjectCount: 0,
          persistedObjectSha256: formPersistence.digest,
          replayResponseSha256: responseDigest(formReplay),
        },
      }),
      makeProof({
        ...commonProof,
        id: "public-funnel-long-proof-refresh",
        observations: [funnelInitialObservation, funnelExpiredObservation, funnelRefreshObservation, funnelProofAcceptedObservation],
        semanticEvidence: {
          idempotencyKeyAfterSha256: sha256(refreshedFunnelProof.idempotencyKey),
          idempotencyKeyBeforeSha256: sha256(initialFunnelProof.idempotencyKey),
          minimumElapsedSeconds: Math.floor((Date.parse(funnelExpiredObservation.observedAt) - Date.parse(funnelInitialObservation.observedAt)) / 1000),
          oldProofRejectionCode: "submission_proof_expired",
        },
      }),
      makeProof({
        ...commonProof,
        id: "public-funnel-live-submission",
        observations: funnelSubmissionObservations,
        semanticEvidence: {
          createdObjectCount: 1,
          idempotencyKeySha256: sha256(refreshedFunnelProof.idempotencyKey),
          idempotentReplayCreatedObjectCount: 0,
          persistedObjectSha256: funnelPersistence.digest,
          replayResponseSha256: responseDigest(funnelReplay),
        },
      }),
      makeProof({
        ...commonProof,
        id: "funnel-publish-token-rotation",
        observations: tokenObservations,
        semanticEvidence: {
          newTokenSha256: sha256(newToken),
          oldTokenRejectionCode: "invalid_publish_token",
          oldTokenSha256: sha256(oldToken),
          publishedRevisionSha256: sha256(canonicalJson({
            after: funnelStateAfterRotation,
            before: funnelStateBeforeRotation,
          })),
          repositoryScanSha256,
        },
      }),
    ];
    resultData = {
      after,
      cleanup,
      proofs,
      requests,
      runtimeInventory,
    };
  } catch (error) {
    failure = error;
  } finally {
    if (cleanupAuthorized) {
      try {
        primaryReset ??= await resetQaBatch(input, jar, fetchImpl, {
          batchId: input.batchId,
          sessionCookie: input.sessionCookie,
          workspaceId: input.workspaceId,
        });
        secondaryReset ??= await resetQaBatch(input, jar, fetchImpl, {
          batchId: input.crossTenantBatchId,
          sessionCookie: input.crossTenantSessionCookie,
          workspaceId: input.crossTenantWorkspaceId,
        });
      } catch (cleanupError) {
        failure = new PublicRuntimePreviewError("PUBLIC_RUNTIME_EMERGENCY_CLEANUP_FAILED", { cause: cleanupError });
      }
    }
  }
  if (failure) throw failure;
  if (!access || !baseline || !retainedBefore || !retainedAfter || !resultData) fail("PUBLIC_RUNTIME_RESULT_INCOMPLETE");
  const evidence = {
    candidate: {
      deploymentHost: input.expectedHost,
      deploymentId: input.expectedDeploymentId,
      gitBranch: input.expectedGitRef,
      gitSha: input.expectedGitSha,
      neonBranchId: input.expectedNeonBranchId,
      neonProjectId: input.expectedNeonProjectId,
      targetFingerprint: input.targetFingerprint,
    },
    cleanup: resultData.cleanup,
    completedAt: new Date().toISOString(),
    databaseAttestation: {
      contentFingerprintDigest: before.contentFingerprintDigest,
      databaseName: before.attestation.databaseName,
      databaseRole: before.attestation.databaseRole,
      freshBatch: before.attestation.freshBatch,
      isQa: before.attestation.isQa,
      qaBatchId: input.batchId,
      status: "PASS",
    },
    httpReadOnlyStatus: "PASS",
    mutationGate: cleanupContract,
    blockedProofs: [],
    previewAccess: access.mode,
    productionMutationPerformed: false,
    proofs: resultData.proofs,
    releaseGateStatus: "PASS",
    requests: resultData.requests,
    retainedEvidence: {
      afterSha256: retainedAfter.digest,
      beforeSha256: retainedBefore.digest,
      classification: "RETAINED_APPEND_ONLY_NOT_CLEANUP_TARGETS",
      rowDelta: retainedAfter.rowCount - retainedBefore.rowCount,
    },
    schemaVersion: 1,
    scope: {
      actorFingerprint: input.actorFingerprint,
      batchFingerprint: input.batchFingerprint,
      crossTenantActorFingerprint: input.crossTenantActorFingerprint,
      crossTenantBatchFingerprint: input.crossTenantBatchFingerprint,
      crossTenantWorkspaceFingerprint: input.crossTenantWorkspaceFingerprint,
      workspaceFingerprint: input.workspaceFingerprint,
    },
  };
  assertPublicRuntimeEvidenceSafe(evidence);
  return evidence;
}
