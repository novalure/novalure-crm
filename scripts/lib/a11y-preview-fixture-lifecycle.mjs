import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { neon } from "@neondatabase/serverless";

import {
  parsePublicRuntimeBatchProvisionInput,
  provisionPublicRuntimeBatch,
  requireLocalCandidate,
} from "../qa-public-runtime-batch-provision.mjs";
import {
  assertPublicRuntimeEvidenceSafe,
  attestRuntime,
  authenticatedMutation,
  bootstrapPublicRuntimeShareAccess,
  buildPublicRuntimeFormFixture,
  createPublicRuntimeCookieJar,
  createPublicRuntimeDatabaseStore,
  canonicalJson,
  fingerprint,
  inspectPublicRuntimeDatabase,
  parsePublicRuntimeActionInput,
  requestExact,
  requireJsonObject,
  requireStatus,
  resetQaBatch,
  stripFunnelValidationPatterns,
} from "./public-runtime-preview-e2e.mjs";
import {
  a11yBrowserEvidenceFileName,
  a11yBrowserEvidenceSidecarFileName,
  a11yFixtureLifecycleFileName,
  a11yFixtureLifecycleRecordType,
  a11yFixtureLifecycleSidecarFileName,
  a11yRetainedTableNames,
  validateA11yFixtureLifecycleEvidence,
} from "./a11y-fixture-lifecycle-evidence.mjs";
import {
  recoveryExpectedProductionBranchId,
  recoveryExpectedProjectId,
} from "./database-recovery-query-pack.mjs";

const lifecycleConfirmation = "RUN_A11Y_PREVIEW_FIXTURE_LIFECYCLE";
const dummyPrimaryBatchId = "11111111-1111-4111-8111-111111111111";
const dummyCrossTenantBatchId = "22222222-2222-4222-8222-222222222222";
const qaHeaderName = "x-novalure-qa-batch-id";
const qaRegistrationHeaderName = "x-novalure-qa-batch-registration";
const runtimeIdentityPath = "/api/admin/qa-runtime-identity";
const runtimeCapabilityPath = "/api/admin/qa-batch-capability";
const expectedAtomicSurfaces = Object.freeze([
  "blueprint",
  "formPublicSubmit",
  "formUpsert",
  "funnelCreate",
  "funnelPublicSubmit",
  "reset",
  "tokenRotation",
]);
const productionHosts = new Set([
  "novalure-crm.app",
  "novalure-crm-novalure.vercel.app",
  "novalure-crm.vercel.app",
  "www.novalure-crm.app",
]);
const topLevelKeys = Object.freeze([
  "confirmation",
  "crossTenant",
  "databaseUrl",
  "expectedDeploymentId",
  "expectedGitRef",
  "expectedGitSha",
  "expectedNeonBranchId",
  "expectedNeonProjectId",
  "previewOrigin",
  "primary",
  "productionDatabaseHost",
  "productionNeonBranchId",
  "productionNeonProjectId",
  "productionOrigin",
  "schemaVersion",
  "shareUrl",
]);
const scopeKeys = Object.freeze(["actorUserId", "batchMarker", "sessionCookie", "workspaceId"]);
const a11yChildEnvironmentAllowlist = Object.freeze([
  "APPDATA",
  "CI",
  "COMSPEC",
  "HOME",
  "LOCALAPPDATA",
  "NEXT_TELEMETRY_DISABLED",
  "NO_COLOR",
  "NOVALURE_BROWSER_EXECUTABLE",
  "NOVALURE_PLAYWRIGHT_MODULE_PATH",
  "NOVALURE_QA_A11Y_PASSWORD_RESET_RESULT_URL",
  "NOVALURE_QA_PREVIEW_EMAIL",
  "NOVALURE_QA_PREVIEW_FIXTURE_MARKER",
  "NOVALURE_QA_PREVIEW_FIXTURE_MARKER_KEY",
  "NOVALURE_QA_PREVIEW_PASSWORD",
  "NOVALURE_QA_PREVIEW_PRODUCT_ROLE",
  "NOVALURE_QA_PREVIEW_ROLE",
  "NOVALURE_QA_PREVIEW_TOTP_SECRET",
  "NOVALURE_QA_PREVIEW_WORKSPACE_ID",
  "PATH",
  "PATHEXT",
  "PLAYWRIGHT_BROWSERS_PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);
const projectIdPattern = /^[-A-Za-z0-9]{8,80}$/u;
const branchIdPattern = /^br-[-A-Za-z0-9]{8,128}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export class A11yPreviewFixtureLifecycleError extends Error {
  constructor(code, options) {
    super(code, options);
    this.code = code;
    this.name = "A11yPreviewFixtureLifecycleError";
  }
}

function fail(code, cause) {
  throw new A11yPreviewFixtureLifecycleError(code, cause ? { cause } : undefined);
}

function invariant(condition, code) {
  if (!condition) fail(code);
}

function normalizedFilesystemPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function exactObjectKeys(value, expected, code) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    code,
  );
}

function numberValue(value, code) {
  const number = Number(value);
  invariant(Number.isSafeInteger(number) && number >= 0, code);
  return number;
}

function databaseTargetDigest(input) {
  return `sha256:${createHash("sha256")
    .update([input.expectedNeonProjectId, input.expectedNeonBranchId, "neondb", "novalure_app"].join("\0"))
    .digest("hex")}`;
}

function publicActionShape(input, primaryBatchId, crossTenantBatchId) {
  return {
    actorUserId: input.primary.actorUserId,
    batchId: primaryBatchId,
    batchMarker: input.primary.batchMarker,
    crossTenantActorUserId: input.crossTenant.actorUserId,
    crossTenantBatchId,
    crossTenantBatchMarker: input.crossTenant.batchMarker,
    crossTenantSessionCookie: input.crossTenant.sessionCookie,
    crossTenantWorkspaceId: input.crossTenant.workspaceId,
    databaseUrl: input.databaseUrl,
    expectedDeploymentId: input.expectedDeploymentId,
    expectedGitRef: input.expectedGitRef,
    expectedGitSha: input.expectedGitSha,
    expectedNeonBranchId: input.expectedNeonBranchId,
    expectedNeonProjectId: input.expectedNeonProjectId,
    previewOrigin: input.previewOrigin,
    productionDatabaseHost: input.productionDatabaseHost,
    productionOrigin: input.productionOrigin,
    sessionCookie: input.primary.sessionCookie,
    shareUrl: input.shareUrl,
    workspaceId: input.primary.workspaceId,
  };
}

export function parseA11yPreviewFixtureLifecycleInput(source) {
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    fail("A11Y_FIXTURE_INPUT_INVALID");
  }
  exactObjectKeys(raw, topLevelKeys, "A11Y_FIXTURE_INPUT_KEYS_INVALID");
  exactObjectKeys(raw.primary, scopeKeys, "A11Y_FIXTURE_PRIMARY_SCOPE_INVALID"); // gitleaks:allow -- validation error code, not a credential
  exactObjectKeys(raw.crossTenant, scopeKeys, "A11Y_FIXTURE_CROSS_TENANT_SCOPE_INVALID");
  invariant(
    raw.schemaVersion === 1 && raw.confirmation === lifecycleConfirmation,
    "A11Y_FIXTURE_CONFIRMATION_INVALID",
  );

  let normalized;
  try {
    normalized = parsePublicRuntimeActionInput(JSON.stringify(publicActionShape({
      ...raw,
      crossTenant: raw.crossTenant,
      primary: raw.primary,
    }, dummyPrimaryBatchId, dummyCrossTenantBatchId)));
  } catch (error) {
    fail("A11Y_FIXTURE_INPUT_SCOPE_INVALID", error);
  }

  const productionNeonProjectId = typeof raw.productionNeonProjectId === "string"
    ? raw.productionNeonProjectId.trim()
    : "";
  const productionNeonBranchId = typeof raw.productionNeonBranchId === "string"
    ? raw.productionNeonBranchId.trim()
    : "";
  const productionHost = new URL(normalized.productionOrigin).hostname.toLowerCase();
  invariant(productionHosts.has(productionHost), "A11Y_FIXTURE_PRODUCTION_ORIGIN_INVALID");
  invariant(
    projectIdPattern.test(productionNeonProjectId)
      && branchIdPattern.test(productionNeonBranchId)
      && productionNeonProjectId === recoveryExpectedProjectId
      && productionNeonBranchId === recoveryExpectedProductionBranchId
      && productionNeonProjectId !== normalized.expectedNeonProjectId
      && productionNeonBranchId !== normalized.expectedNeonBranchId,
    "A11Y_FIXTURE_PRODUCTION_DATABASE_IDENTITY_INVALID",
  );
  if (normalized.shareUrl) {
    invariant(
      new URL(normalized.shareUrl).origin === normalized.previewOrigin,
      "A11Y_FIXTURE_SHARE_HANDOFF_INVALID",
    );
  }

  return Object.freeze({
    crossTenant: Object.freeze({
      actorUserId: normalized.crossTenantActorUserId,
      batchMarker: normalized.crossTenantBatchMarker,
      sessionCookie: normalized.crossTenantSessionCookie,
      workspaceId: normalized.crossTenantWorkspaceId,
    }),
    databaseUrl: normalized.databaseUrl,
    expectedDeploymentId: normalized.expectedDeploymentId,
    expectedGitRef: normalized.expectedGitRef,
    expectedGitSha: normalized.expectedGitSha,
    expectedHost: normalized.expectedHost,
    expectedNeonBranchId: normalized.expectedNeonBranchId,
    expectedNeonProjectId: normalized.expectedNeonProjectId,
    previewOrigin: normalized.previewOrigin,
    primary: Object.freeze({
      actorUserId: normalized.actorUserId,
      batchMarker: normalized.batchMarker,
      sessionCookie: normalized.sessionCookie,
      workspaceId: normalized.workspaceId,
    }),
    productionDatabaseHost: normalized.productionDatabaseHost,
    productionNeonBranchId,
    productionNeonProjectId,
    productionOrigin: normalized.productionOrigin,
    schemaVersion: 1,
    shareUrl: normalized.shareUrl,
  });
}

function batchProvisionInput(input, scope) {
  return parsePublicRuntimeBatchProvisionInput(JSON.stringify({
    actorUserId: scope.actorUserId,
    batchMarker: scope.batchMarker,
    confirmation: "PROVISION_PUBLIC_RUNTIME_PREVIEW_BATCH",
    databaseUrl: input.databaseUrl,
    expectedDeploymentId: input.expectedDeploymentId,
    expectedGitRef: input.expectedGitRef,
    expectedGitSha: input.expectedGitSha,
    expectedNeonBranchId: input.expectedNeonBranchId,
    expectedNeonProjectId: input.expectedNeonProjectId,
    productionDatabaseHost: input.productionDatabaseHost,
    schemaVersion: 1,
    workspaceId: scope.workspaceId,
  }));
}

export function bindA11yLifecycleBatches(input, primaryBatch, crossTenantBatch) {
  invariant(
    uuidPattern.test(primaryBatch?.batchId ?? "")
      && uuidPattern.test(crossTenantBatch?.batchId ?? "")
      && primaryBatch.batchId !== crossTenantBatch.batchId
      && primaryBatch.workspaceId === input.primary.workspaceId
      && crossTenantBatch.workspaceId === input.crossTenant.workspaceId
      && primaryBatch.batchMarker === input.primary.batchMarker
      && crossTenantBatch.batchMarker === input.crossTenant.batchMarker
      && primaryBatch.deploymentId === input.expectedDeploymentId
      && crossTenantBatch.deploymentId === input.expectedDeploymentId,
    "A11Y_FIXTURE_BATCH_BINDING_INVALID",
  );
  try {
    return parsePublicRuntimeActionInput(JSON.stringify(publicActionShape(
      input,
      primaryBatch.batchId,
      crossTenantBatch.batchId,
    )));
  } catch (error) {
    fail("A11Y_FIXTURE_BATCH_BINDING_INVALID", error);
  }
}

async function inspectTargetScope(sql, input, scope) {
  let results;
  try {
    results = await sql.transaction((transaction) => [
      transaction`
        select
          set_config('app.tenant_id', ${scope.workspaceId}, true) as "tenantId",
          set_config('app.actor_id', ${scope.actorUserId}, true) as "actorId"
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
          actor.id as "actorId",
          actor.role,
          actor.product_role as "productRole",
          actor.status
        from workspaces workspace
        inner join workspace_users actor
          on actor.workspace_id = workspace.id
         and actor.id = ${scope.actorUserId}::uuid
        where workspace.id = ${scope.workspaceId}::uuid
        limit 1
      `,
    ], { isolationLevel: "RepeatableRead", readOnly: true });
  } catch (error) {
    fail("A11Y_FIXTURE_DATABASE_PREFLIGHT_FAILED", error);
  }
  const identity = results?.[1]?.[0];
  const actor = results?.[2]?.[0];
  invariant(
    identity?.projectId === input.expectedNeonProjectId
      && identity?.branchId === input.expectedNeonBranchId
      && identity?.tenantId?.toLowerCase() === scope.workspaceId
      && identity?.actorId?.toLowerCase() === scope.actorUserId
      && identity?.databaseName === "neondb"
      && identity?.databaseRole === "novalure_app"
      && actor?.isQa === true
      && actor?.actorId?.toLowerCase() === scope.actorUserId
      && actor?.role === "owner"
      && actor?.productRole === "platform_admin"
      && actor?.status === "active",
    "A11Y_FIXTURE_DATABASE_PREFLIGHT_MISMATCH",
  );
}

export async function inspectA11yPreviewTarget(input, { sqlFactory = neon } = {}) {
  const sql = sqlFactory(input.databaseUrl);
  await inspectTargetScope(sql, input, input.primary);
  await inspectTargetScope(sql, input, input.crossTenant);
  return Object.freeze({ databaseTargetDigest: databaseTargetDigest(input), status: "PASS" });
}

function validateRuntimeCommon(input, body) {
  invariant(
    body?.version === 2
      && body.databaseBranchId === input.expectedNeonBranchId
      && body.databaseLeastPrivilege === true
      && body.databaseRlsActive === true
      && body.databaseTargetDigest === databaseTargetDigest(input)
      && body.deploymentHost?.toLowerCase() === input.expectedHost
      && body.deploymentId === input.expectedDeploymentId
      && body.gitBranch === input.expectedGitRef
      && body.gitSha === input.expectedGitSha,
    "A11Y_FIXTURE_RUNTIME_IDENTITY_MISMATCH",
  );
}

export async function attestA11yRuntimePreflight(input, jar, fetchImpl = globalThis.fetch) {
  const runtime = await requestExact(input, jar, fetchImpl, runtimeIdentityPath);
  const runtimeBody = requireJsonObject(
    requireStatus(runtime, 200, "A11Y_FIXTURE_RUNTIME_IDENTITY_UNAVAILABLE"),
    "A11Y_FIXTURE_RUNTIME_IDENTITY_UNAVAILABLE",
  );
  validateRuntimeCommon(input, runtimeBody);

  for (const scope of [input.primary, input.crossTenant]) {
    const capability = await requestExact(input, jar, fetchImpl, runtimeCapabilityPath, {
      appSessionCookie: scope.sessionCookie,
    });
    const body = requireJsonObject(
      requireStatus(capability, 200, "A11Y_FIXTURE_SESSION_CAPABILITY_UNAVAILABLE"),
      "A11Y_FIXTURE_SESSION_CAPABILITY_UNAVAILABLE",
    );
    validateRuntimeCommon(input, body);
    invariant(
      body.atomicRegistration === true
        && body.batchCapability === null
        && body.sessionScope?.source === "cookie"
        && body.sessionScope?.workspaceId?.toLowerCase() === scope.workspaceId
        && body.sessionScope?.userId?.toLowerCase() === scope.actorUserId
        && body.sessionScope?.role === "owner"
        && body.sessionScope?.productRole === "platform_admin"
        && body.publicRuntimeAtomicSurfaces
        && Object.keys(body.publicRuntimeAtomicSurfaces).length === expectedAtomicSurfaces.length
        && expectedAtomicSurfaces.every((surface) => body.publicRuntimeAtomicSurfaces[surface] === true),
      "A11Y_FIXTURE_SESSION_CAPABILITY_MISMATCH",
    );
  }
  return Object.freeze({ status: "PASS" });
}

function requireQaRegistration(result, batchId, code) {
  invariant(
    result.response.headers.get(qaHeaderName)?.toLowerCase() === batchId
      && result.response.headers.get(qaRegistrationHeaderName) === "committed",
    code,
  );
}

export async function prepareA11yPublicSurfaces({
  databaseAttestation,
  fetchImpl = globalThis.fetch,
  input,
  jar,
} = {}) {
  invariant(databaseAttestation?.attestation?.freshBatch === true, "A11Y_FIXTURE_DATABASE_ATTESTATION_REQUIRED");
  const formFixture = buildPublicRuntimeFormFixture(input);
  const formCreate = await authenticatedMutation(input, jar, fetchImpl, {
    appSessionCookie: input.sessionCookie,
    batchId: input.batchId,
    body: JSON.stringify({ expectedVersion: 0, form: formFixture }),
    headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
    path: "/api/forms",
  });
  const formCreateBody = requireJsonObject(
    requireStatus(formCreate, 200, "A11Y_FIXTURE_FORM_CREATE_FAILED"),
    "A11Y_FIXTURE_FORM_CREATE_FAILED",
  );
  const form = formCreateBody.form;
  invariant(
    formCreateBody.persisted === true
      && uuidPattern.test(form?.id ?? "")
      && form.ownerUserId?.toLowerCase() === input.actorUserId
      && form.status === "aktiv",
    "A11Y_FIXTURE_FORM_CREATE_FAILED",
  );
  requireQaRegistration(formCreate, input.batchId, "A11Y_FIXTURE_FORM_REGISTRATION_FAILED");
  const formKey = `${databaseAttestation.workspacePublicKey}/${form.slug}`;
  const formPath = `/forms/${encodeURIComponent(databaseAttestation.workspacePublicKey)}/${encodeURIComponent(form.slug)}`;
  requireStatus(
    await requestExact(input, jar, fetchImpl, formPath),
    200,
    "A11Y_FIXTURE_FORM_PAGE_FAILED",
  );

  const funnelCreate = await authenticatedMutation(input, jar, fetchImpl, {
    appSessionCookie: input.sessionCookie,
    batchId: input.batchId,
    body: JSON.stringify({
      funnel: {
        audience: "Käufer",
        conversionRate: 0,
        entryChannel: "Website",
        goal: "QA accessibility",
        id: randomUUID(),
        leads: 0,
        name: `QA A11y Funnel ${input.batchFingerprint.slice(-8)}`,
        ownerUserId: input.actorUserId,
        projectId: databaseAttestation.projectId,
        status: "entwurf",
        visits: 0,
      },
      steps: [],
    }),
    headers: { "content-type": "application/json" },
    path: "/api/crm/funnels",
  });
  const funnelCreateBody = requireJsonObject(
    requireStatus(funnelCreate, 200, "A11Y_FIXTURE_FUNNEL_CREATE_FAILED"),
    "A11Y_FIXTURE_FUNNEL_CREATE_FAILED",
  );
  const funnel = funnelCreateBody.funnel;
  invariant(
    funnelCreateBody.persisted === true
      && uuidPattern.test(funnel?.id ?? "")
      && funnel.ownerUserId?.toLowerCase() === input.actorUserId,
    "A11Y_FIXTURE_FUNNEL_CREATE_FAILED",
  );
  requireQaRegistration(funnelCreate, input.batchId, "A11Y_FIXTURE_FUNNEL_REGISTRATION_FAILED");

  const blueprintPath = `/api/funnels/${encodeURIComponent(funnel.id)}/blueprint`;
  const blueprintGet = await requestExact(input, jar, fetchImpl, blueprintPath, {
    appSessionCookie: input.sessionCookie,
  });
  const blueprintGetBody = requireJsonObject(
    requireStatus(blueprintGet, 200, "A11Y_FIXTURE_BLUEPRINT_LOAD_FAILED"),
    "A11Y_FIXTURE_BLUEPRINT_LOAD_FAILED",
  );
  invariant(
    Number.isSafeInteger(blueprintGetBody.blueprintRevision) && blueprintGetBody.blueprint,
    "A11Y_FIXTURE_BLUEPRINT_LOAD_FAILED",
  );
  const blueprintPut = await authenticatedMutation(input, jar, fetchImpl, {
    appSessionCookie: input.sessionCookie,
    batchId: input.batchId,
    body: JSON.stringify({
      blueprint: stripFunnelValidationPatterns(blueprintGetBody.blueprint),
      expectedBlueprintRevision: blueprintGetBody.blueprintRevision,
      label: "A11y Preview Fixture",
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
    path: blueprintPath,
  });
  const blueprintPutBody = requireJsonObject(
    requireStatus(blueprintPut, 200, "A11Y_FIXTURE_FUNNEL_PUBLISH_FAILED"),
    "A11Y_FIXTURE_FUNNEL_PUBLISH_FAILED",
  );
  invariant(
    blueprintPutBody.blueprint?.status === "aktiv"
      && blueprintPutBody.preflight?.ok === true
      && blueprintPut.response.headers.get(qaHeaderName)?.toLowerCase() === input.batchId,
    "A11Y_FIXTURE_FUNNEL_PUBLISH_FAILED",
  );

  const tokenPath = `/api/admin/funnels/${encodeURIComponent(funnel.id)}/publish-token/cutover`;
  const tokenStatus = await requestExact(input, jar, fetchImpl, tokenPath, {
    appSessionCookie: input.sessionCookie,
  });
  const tokenStatusBody = requireJsonObject(
    requireStatus(tokenStatus, 200, "A11Y_FIXTURE_TOKEN_STATUS_FAILED"),
    "A11Y_FIXTURE_TOKEN_STATUS_FAILED",
  );
  invariant(Number.isSafeInteger(tokenStatusBody.revision), "A11Y_FIXTURE_TOKEN_STATUS_FAILED");
  const tokenCutover = await authenticatedMutation(input, jar, fetchImpl, {
    appSessionCookie: input.sessionCookie,
    batchId: input.batchId,
    body: JSON.stringify({ expectedRevision: tokenStatusBody.revision }),
    headers: { "content-type": "application/json", "idempotency-key": `qa-a11y-${randomUUID()}` },
    path: tokenPath,
  });
  const tokenCutoverBody = requireJsonObject(
    requireStatus(tokenCutover, 200, "A11Y_FIXTURE_TOKEN_CUTOVER_FAILED"),
    "A11Y_FIXTURE_TOKEN_CUTOVER_FAILED",
  );
  const publishToken = tokenCutoverBody.publishToken;
  invariant(
    /^[A-Za-z0-9_-]{43}$/u.test(publishToken ?? "")
      && Number.isSafeInteger(tokenCutoverBody.revision),
    "A11Y_FIXTURE_TOKEN_CUTOVER_FAILED",
  );
  const funnelPath = `/preview/${encodeURIComponent(funnel.id)}?mode=live&token=${encodeURIComponent(publishToken)}`;
  requireStatus(
    await requestExact(input, jar, fetchImpl, funnelPath),
    200,
    "A11Y_FIXTURE_FUNNEL_PAGE_FAILED",
  );

  requireStatus(
    await requestExact(
      input,
      jar,
      fetchImpl,
      `/api/forms/resolve?form=${encodeURIComponent(formKey)}`,
      { appSessionCookie: input.crossTenantSessionCookie },
    ),
    404,
    "A11Y_FIXTURE_CROSS_TENANT_FORM_ISOLATION_FAILED",
  );
  requireStatus(
    await requestExact(input, jar, fetchImpl, blueprintPath, {
      appSessionCookie: input.crossTenantSessionCookie,
    }),
    404,
    "A11Y_FIXTURE_CROSS_TENANT_FUNNEL_ISOLATION_FAILED",
  );
  requireStatus(
    await requestExact(input, jar, fetchImpl, tokenPath, {
      appSessionCookie: input.crossTenantSessionCookie,
    }),
    404,
    "A11Y_FIXTURE_CROSS_TENANT_TOKEN_ISOLATION_FAILED",
  );

  return Object.freeze({
    publicFormUrl: new URL(formPath, input.previewOrigin).href,
    publicFunnelUrl: new URL(funnelPath, input.previewOrigin).href,
    shareUrl: input.shareUrl ?? "",
  });
}

async function inspectResidualScope(sql, input, scope) {
  let results;
  try {
    results = await sql.transaction((transaction) => [
      transaction`
        select
          set_config('app.tenant_id', ${scope.workspaceId}, true) as "tenantId",
          set_config('app.actor_id', ${scope.actorUserId}, true) as "actorId"
      `,
      transaction`
        select
          current_setting('neon.project_id', true) as "projectId",
          current_setting('neon.branch_id', true) as "branchId",
          current_database() as "databaseName",
          current_user as "databaseRole"
      `,
      transaction`
        select
          batch.metadata->>'candidate' as "candidateSha",
          batch.metadata->>'deploymentId' as "deploymentId",
          batch.metadata->>'purpose' as "purpose",
          (select count(*) from qa_batch_objects object where object.workspace_id = batch.workspace_id and object.batch_id = batch.id) as "ledgerCount",
          (select count(*) from qa_reset_audit_events audit where audit.workspace_id = batch.workspace_id and audit.batch_id = batch.id) as "auditCount",
          (select count(*) from qa_reset_audit_events audit where audit.workspace_id = batch.workspace_id and audit.batch_id = batch.id and audit.outcome = 'executed') as "executedCount",
          (
            select count(*)
            from qa_batch_objects object
            where object.workspace_id = batch.workspace_id
              and object.batch_id = batch.id
              and object.resource_scope = 'database'
              and (
                (object.resource_type = 'forms' and exists (select 1 from forms row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
                or (object.resource_type = 'funnels' and exists (select 1 from funnels row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
                or (object.resource_type = 'funnel_steps' and exists (select 1 from funnel_steps row where row.workspace_id = object.workspace_id and row.id::text = object.resource_id))
              )
          ) as "liveRegisteredCount",
          (
            select count(*)
            from public_funnel_visit_events visit
            where visit.workspace_id = batch.workspace_id
              and visit.funnel_id::text in (
                select object.resource_id
                from qa_batch_objects object
                where object.workspace_id = batch.workspace_id
                  and object.batch_id = batch.id
                  and object.resource_type = 'funnels'
              )
          ) as "liveCascadeCount",
          (
            select count(*)
            from qa_batch_objects object
            where object.workspace_id = batch.workspace_id
              and object.batch_id = batch.id
              and (object.resource_scope <> 'database' or object.resource_type not in ('forms', 'funnels', 'funnel_steps'))
          ) as "unexpectedLedgerCount"
        from qa_batches batch
        where batch.workspace_id = ${scope.workspaceId}::uuid
          and batch.id = ${scope.batchId}::uuid
        limit 1
      `,
    ], { isolationLevel: "RepeatableRead", readOnly: true });
  } catch (error) {
    fail("A11Y_FIXTURE_RESIDUAL_INSPECTION_FAILED", error);
  }
  const identity = results?.[1]?.[0];
  const row = results?.[2]?.[0];
  invariant(
    identity?.projectId === input.expectedNeonProjectId
      && identity?.branchId === input.expectedNeonBranchId
      && identity?.databaseName === "neondb"
      && identity?.databaseRole === "novalure_app"
      && row?.candidateSha === input.expectedGitSha
      && row?.deploymentId === input.expectedDeploymentId
      && row?.purpose === "public-runtime-preview",
    "A11Y_FIXTURE_RESIDUAL_SCOPE_MISMATCH",
  );
  const result = Object.freeze({
    auditCount: numberValue(row.auditCount, "A11Y_FIXTURE_RESIDUAL_COUNT_INVALID"),
    executedCount: numberValue(row.executedCount, "A11Y_FIXTURE_RESIDUAL_COUNT_INVALID"),
    ledgerCount: numberValue(row.ledgerCount, "A11Y_FIXTURE_RESIDUAL_COUNT_INVALID"),
    liveCascadeCount: numberValue(row.liveCascadeCount, "A11Y_FIXTURE_RESIDUAL_COUNT_INVALID"),
    liveRegisteredCount: numberValue(row.liveRegisteredCount, "A11Y_FIXTURE_RESIDUAL_COUNT_INVALID"),
    unexpectedLedgerCount: numberValue(row.unexpectedLedgerCount, "A11Y_FIXTURE_RESIDUAL_COUNT_INVALID"),
  });
  invariant(
    result.auditCount >= 1
      && result.executedCount === 1
      && result.liveRegisteredCount === 0
      && result.liveCascadeCount === 0
      && result.unexpectedLedgerCount === 0,
    "A11Y_FIXTURE_RESIDUAL_ROWS_REMAIN",
  );
  return result;
}

export async function inspectA11yCleanupResiduals(input, scopes, { sqlFactory = neon } = {}) {
  const sql = sqlFactory(input.databaseUrl);
  const result = {};
  for (const scope of scopes) result[scope.key] = await inspectResidualScope(sql, input, scope);
  return Object.freeze(result);
}

export async function scanA11yEvidenceForSecrets(outputDirectory, secretValues) {
  const root = path.resolve(outputDirectory);
  const files = [a11yBrowserEvidenceFileName, a11yBrowserEvidenceSidecarFileName];
  const [rootState, entries] = await Promise.all([lstat(root), readdir(root)]);
  invariant(
    rootState.isDirectory()
      && !rootState.isSymbolicLink()
      && entries.sort().join("\0") === [...files].sort().join("\0"),
    "A11Y_FIXTURE_EVIDENCE_DIRECTORY_INVALID",
  );
  const normalizedSecrets = secretValues
    .filter((value) => typeof value === "string" && value.length >= 8)
    .map((value) => Buffer.from(value, "utf8"));
  let browserEvidenceSha256 = null;
  let browserEvidenceSizeBytes = null;
  let browserSidecarSha256 = null;
  let browserSidecarSource = null;
  for (const name of files) {
    const filePath = path.join(root, name);
    const state = await lstat(filePath);
    invariant(
      state.isFile() && !state.isSymbolicLink() && state.nlink === 1 && state.size > 0 && state.size <= 16 * 1024 * 1024,
      "A11Y_FIXTURE_EVIDENCE_FILE_INVALID",
    );
    const contents = await readFile(filePath);
    try {
      invariant(
        normalizedSecrets.every((secret) => !contents.includes(secret)),
        "A11Y_FIXTURE_SECRET_LEAK_DETECTED",
      );
      if (name === a11yBrowserEvidenceFileName) {
        try {
          const document = JSON.parse(contents.toString("utf8"));
          invariant(
            document && typeof document === "object" && !Array.isArray(document),
            "A11Y_FIXTURE_EVIDENCE_JSON_INVALID",
          );
        } catch (error) {
          if (error instanceof A11yPreviewFixtureLifecycleError) throw error;
          fail("A11Y_FIXTURE_EVIDENCE_JSON_INVALID", error);
        }
        browserEvidenceSha256 = createHash("sha256").update(contents).digest("hex");
        browserEvidenceSizeBytes = contents.length;
      } else {
        browserSidecarSha256 = createHash("sha256").update(contents).digest("hex");
        browserSidecarSource = contents.toString("utf8");
      }
    } finally {
      contents.fill(0);
    }
  }
  invariant(
    browserSidecarSource
      === `${browserEvidenceSha256}  ${a11yBrowserEvidenceFileName}\n`,
    "A11Y_FIXTURE_EVIDENCE_SIDECAR_MISMATCH",
  );
  return Object.freeze({
    browserEvidenceSha256,
    browserEvidenceSizeBytes,
    browserSidecarSha256,
  });
}

export function buildA11yChildEnvironment(environment = process.env) {
  const childEnvironment = {};
  for (const name of a11yChildEnvironmentAllowlist) {
    if (typeof environment[name] === "string" && environment[name].length > 0) {
      childEnvironment[name] = environment[name];
    }
  }
  childEnvironment.CI = "true";
  childEnvironment.NEXT_TELEMETRY_DISABLED = "1";
  childEnvironment.NO_COLOR = "1";
  return Object.freeze(childEnvironment);
}

export function collectA11yEvidenceSecretValues({ childEnvironment, handoff, input }) {
  return Object.freeze([
    handoff.publicFormUrl,
    handoff.publicFunnelUrl,
    handoff.shareUrl,
    new URL(handoff.publicFunnelUrl).searchParams.get("token") ?? "",
    childEnvironment.NOVALURE_QA_A11Y_PASSWORD_RESET_RESULT_URL ?? "",
    childEnvironment.NOVALURE_QA_PREVIEW_EMAIL ?? "",
    childEnvironment.NOVALURE_QA_PREVIEW_PASSWORD ?? "",
    childEnvironment.NOVALURE_QA_PREVIEW_TOTP_SECRET ?? "",
    input.primary.sessionCookie,
    input.crossTenant.sessionCookie,
    input.databaseUrl,
  ]);
}

async function createFreshA11yRunDirectory(baseDirectory) {
  const base = path.resolve(baseDirectory);
  await mkdir(base, { mode: 0o700, recursive: true });
  const [canonicalBase, baseState] = await Promise.all([realpath(base), lstat(base)]);
  invariant(
    normalizedFilesystemPath(canonicalBase) === normalizedFilesystemPath(base)
      && baseState.isDirectory()
      && !baseState.isSymbolicLink(),
    "A11Y_FIXTURE_OUTPUT_BASE_INVALID",
  );
  const runId = `a11y-run-${randomUUID()}`;
  const outputDirectory = path.join(base, runId);
  try {
    await mkdir(outputDirectory, { mode: 0o700, recursive: false });
  } catch (error) {
    fail("A11Y_FIXTURE_OUTPUT_RUN_CREATE_FAILED", error);
  }
  const [canonicalOutput, outputState, entries] = await Promise.all([
    realpath(outputDirectory),
    lstat(outputDirectory),
    readdir(outputDirectory),
  ]);
  invariant(
    normalizedFilesystemPath(canonicalOutput) === normalizedFilesystemPath(outputDirectory)
      && outputState.isDirectory()
      && !outputState.isSymbolicLink()
      && entries.length === 0,
    "A11Y_FIXTURE_OUTPUT_RUN_NOT_FRESH",
  );
  return Object.freeze({ outputDirectory, runId });
}

export async function spawnA11yBrowserMatrix({ environment = process.env, handoff, input } = {}) {
  const outputBaseDirectory = path.resolve(
    environment.NOVALURE_QA_A11Y_OUTPUT_DIR?.trim() || path.join("artifacts", "qa", "a11y-browser-matrix"),
  );
  const { outputDirectory, runId } = await createFreshA11yRunDirectory(outputBaseDirectory);
  const childEnvironment = buildA11yChildEnvironment(environment);
  let childFailure = null;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "scripts/a11y-browser-matrix.mjs",
          "--read-only",
          "--fixture-input-stdin",
          "--base-url", input.previewOrigin,
          "--expected-host", input.expectedHost,
          "--expected-database-branch-id", input.expectedNeonBranchId,
          "--expected-deployment-id", input.expectedDeploymentId,
          "--expected-git-branch", input.expectedGitRef,
          "--expected-sha", input.expectedGitSha,
          "--output-dir", outputDirectory,
        ],
        {
          cwd: process.cwd(),
          env: childEnvironment,
          shell: false,
          stdio: ["pipe", "inherit", "inherit"],
          windowsHide: true,
        },
      );
      child.once("error", () => reject(new Error("A11Y_FIXTURE_BROWSER_RUNNER_START_FAILED")));
      child.once("exit", (code, signal) => {
        if (code === 0 && signal === null) resolve();
        else reject(new Error("A11Y_FIXTURE_BROWSER_MATRIX_FAILED"));
      });
      child.stdin.end(`${JSON.stringify(handoff)}\n`);
    });
  } catch (error) {
    childFailure = error;
  }
  let scannedEvidence = null;
  try {
    scannedEvidence = await scanA11yEvidenceForSecrets(
      outputDirectory,
      collectA11yEvidenceSecretValues({ childEnvironment, handoff, input }),
    );
  } catch (error) {
    if (error?.code === "A11Y_FIXTURE_SECRET_LEAK_DETECTED" || !childFailure) throw error;
  }
  if (childFailure) throw childFailure;
  invariant(scannedEvidence, "A11Y_FIXTURE_EVIDENCE_SCAN_INCOMPLETE");
  return Object.freeze({ outputDirectory, runId, ...scannedEvidence });
}

function normalizedInventory(inventory, code) {
  invariant(
    inventory
      && /^[a-f0-9]{64}$/u.test(inventory.digest ?? "")
      && Number.isSafeInteger(inventory.rowCount)
      && inventory.rowCount >= 0,
    code,
  );
  return Object.freeze({ digest: inventory.digest, rowCount: inventory.rowCount });
}

function normalizedRetainedInventory(inventory, code) {
  invariant(
    inventory
      && /^[a-f0-9]{64}$/u.test(inventory.digest ?? "")
      && Number.isSafeInteger(inventory.rowCount)
      && inventory.rowCount >= 0,
    code,
  );
  exactObjectKeys(inventory.tables, a11yRetainedTableNames, code);
  const tables = {};
  for (const name of a11yRetainedTableNames) {
    const table = inventory.tables[name];
    invariant(
      table
        && /^[a-f0-9]{64}$/u.test(table.digest ?? "")
        && Number.isSafeInteger(table.rowCount)
        && table.rowCount >= 0,
      code,
    );
    tables[name] = Object.freeze({ digest: table.digest, rowCount: table.rowCount });
  }
  invariant(
    Object.values(tables).reduce((sum, table) => sum + table.rowCount, 0) === inventory.rowCount,
    code,
  );
  return Object.freeze({
    digest: inventory.digest,
    rowCount: inventory.rowCount,
    tables: Object.freeze(tables),
  });
}

function assertRetainedInventoryNonDestructive(before, after) {
  for (const name of a11yRetainedTableNames) {
    invariant(
      after.tables[name].rowCount >= before.tables[name].rowCount,
      "A11Y_FIXTURE_RETAINED_TABLE_DECREASED",
    );
  }
}

function assertRetainedMembershipNonDestructive(before, after) {
  for (const name of a11yRetainedTableNames) {
    const beforeTable = before?.tables?.[name];
    const afterTable = after?.tables?.[name];
    invariant(
      Array.isArray(beforeTable?.members)
        && Array.isArray(afterTable?.members)
        && beforeTable.members.length === beforeTable.rowCount
        && afterTable.members.length === afterTable.rowCount
        && beforeTable.digest === createHash("sha256")
          .update(canonicalJson([...beforeTable.members].sort()))
          .digest("hex")
        && afterTable.digest === createHash("sha256")
          .update(canonicalJson([...afterTable.members].sort()))
          .digest("hex"),
      "A11Y_FIXTURE_RETAINED_MEMBERSHIP_INVALID",
    );
    const afterMembers = new Set(afterTable.members);
    invariant(
      beforeTable.members.every((member) => afterMembers.has(member)),
      "A11Y_FIXTURE_RETAINED_MEMBER_REMOVED",
    );
  }
}

export async function writeA11yFixtureLifecycleEvidence(outputDirectory, document) {
  const root = path.resolve(outputDirectory);
  const [canonicalRoot, rootState, initialEntries] = await Promise.all([
    realpath(root),
    lstat(root),
    readdir(root),
  ]);
  invariant(
    normalizedFilesystemPath(canonicalRoot) === normalizedFilesystemPath(root)
      && rootState.isDirectory()
      && !rootState.isSymbolicLink()
      && initialEntries.sort().join("\0")
        === [a11yBrowserEvidenceFileName, a11yBrowserEvidenceSidecarFileName].sort().join("\0"),
    "A11Y_FIXTURE_EVIDENCE_DIRECTORY_INVALID",
  );
  const artifactPath = path.join(root, a11yFixtureLifecycleFileName);
  const sidecarPath = path.join(root, a11yFixtureLifecycleSidecarFileName);
  const source = canonicalJson(document);
  const sourceBytes = Buffer.from(source, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  const sidecarBytes = Buffer.from(`${digest}  ${a11yFixtureLifecycleFileName}\n`, "utf8");
  let artifactHandle = null;
  let sidecarHandle = null;
  try {
    artifactHandle = await open(artifactPath, "wx+", 0o600);
    sidecarHandle = await open(sidecarPath, "wx+", 0o600);
    const [artifactState, sidecarState] = await Promise.all([
      artifactHandle.stat(),
      sidecarHandle.stat(),
    ]);
    invariant(
      artifactState.isFile()
        && artifactState.nlink === 1
        && sidecarState.isFile()
        && sidecarState.nlink === 1,
      "A11Y_FIXTURE_LIFECYCLE_EVIDENCE_OUTPUT_INVALID",
    );
    await artifactHandle.writeFile(sourceBytes);
    await sidecarHandle.writeFile(sidecarBytes);
    await Promise.all([artifactHandle.sync(), sidecarHandle.sync()]);
    const artifactReadback = Buffer.alloc(sourceBytes.length);
    const sidecarReadback = Buffer.alloc(sidecarBytes.length);
    const [artifactRead, sidecarRead, rootAfter, canonicalRootAfter] = await Promise.all([
      artifactHandle.read(artifactReadback, 0, artifactReadback.length, 0),
      sidecarHandle.read(sidecarReadback, 0, sidecarReadback.length, 0),
      lstat(root),
      realpath(root),
    ]);
    invariant(
      artifactRead.bytesRead === sourceBytes.length
        && sidecarRead.bytesRead === sidecarBytes.length
        && artifactReadback.equals(sourceBytes)
        && sidecarReadback.equals(sidecarBytes)
        && normalizedFilesystemPath(canonicalRootAfter) === normalizedFilesystemPath(root)
        && rootAfter.dev === rootState.dev
        && rootAfter.ino === rootState.ino
        && rootAfter.isDirectory()
        && !rootAfter.isSymbolicLink(),
      "A11Y_FIXTURE_LIFECYCLE_EVIDENCE_READBACK_MISMATCH",
    );
  } catch (error) {
    if (error instanceof A11yPreviewFixtureLifecycleError) throw error;
    fail("A11Y_FIXTURE_LIFECYCLE_EVIDENCE_WRITE_FAILED", error);
  } finally {
    await Promise.allSettled([artifactHandle?.close(), sidecarHandle?.close()]);
    sourceBytes.fill(0);
    sidecarBytes.fill(0);
  }
  return Object.freeze({
    artifactPath,
    digest,
    fileName: a11yFixtureLifecycleFileName,
    sidecarFileName: a11yFixtureLifecycleSidecarFileName,
    sidecarPath,
  });
}

export async function executeA11yPreviewFixtureLifecycle({
  a11yRunner = spawnA11yBrowserMatrix,
  batchRuntimeAttestor = attestRuntime,
  databaseInspector = inspectPublicRuntimeDatabase,
  databaseStoreFactory = createPublicRuntimeDatabaseStore,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  input,
  lifecycleEvidenceWriter = writeA11yFixtureLifecycleEvidence,
  postCleanupInspector = inspectA11yCleanupResiduals,
  provisionBatch = provisionPublicRuntimeBatch,
  requireLocalIdentity = true,
  resetBatch = resetQaBatch,
  runtimePreflight = attestA11yRuntimePreflight,
  surfacePreparer = prepareA11yPublicSurfaces,
  targetInspector = inspectA11yPreviewTarget,
} = {}) {
  invariant(input, "A11Y_FIXTURE_INPUT_REQUIRED");
  const primaryProvisionInput = batchProvisionInput(input, input.primary);
  const crossProvisionInput = batchProvisionInput(input, input.crossTenant);
  if (requireLocalIdentity) {
    requireLocalCandidate(primaryProvisionInput, {
      cwd: environment.NOVALURE_REPOSITORY_ROOT || process.cwd(),
    });
  }
  await targetInspector(input);
  const preflightJar = createPublicRuntimeCookieJar(input.primary.sessionCookie);
  await bootstrapPublicRuntimeShareAccess(input, preflightJar, fetchImpl);
  await runtimePreflight(input, preflightJar, fetchImpl);

  let primaryBatch = null;
  let crossTenantBatch = null;
  let publicInput = null;
  let jar = preflightJar;
  let failure = null;
  let a11yResult = null;
  let baselineInventory = null;
  let databaseStore = null;
  let operationalInventoryAfter = null;
  let remainingBatchObjectCount = null;
  let cleanupResiduals = null;
  let retainedInventoryBefore = null;
  let retainedInventoryAfter = null;
  const resetResults = {};
  try {
    primaryBatch = await provisionBatch(primaryProvisionInput);
    crossTenantBatch = await provisionBatch(crossProvisionInput);
    publicInput = bindA11yLifecycleBatches(input, primaryBatch, crossTenantBatch);
    const databaseAttestation = await databaseInspector(publicInput);
    await batchRuntimeAttestor(publicInput, jar, fetchImpl);
    databaseStore = databaseStoreFactory(publicInput);
    [baselineInventory, retainedInventoryBefore] = await Promise.all([
      databaseStore.inventory(),
      databaseStore.retainedInventory(),
    ]);
    const handoff = await surfacePreparer({ databaseAttestation, fetchImpl, input: publicInput, jar });
    exactObjectKeys(handoff, ["publicFormUrl", "publicFunnelUrl", "shareUrl"], "A11Y_FIXTURE_HANDOFF_INVALID");
    a11yResult = await a11yRunner({ environment, handoff, input });
  } catch (error) {
    failure = error;
  } finally {
    const scopes = [
      primaryBatch ? {
        ...input.primary,
        batchId: primaryBatch.batchId,
        key: "primary",
      } : null,
      crossTenantBatch ? {
        ...input.crossTenant,
        batchId: crossTenantBatch.batchId,
        key: "crossTenant",
      } : null,
    ].filter(Boolean);
    let cleanupFailure = null;
    for (const scope of scopes) {
      try {
        resetResults[scope.key] = await resetBatch(publicInput ?? input, jar, fetchImpl, {
          batchId: scope.batchId,
          sessionCookie: scope.sessionCookie,
          workspaceId: scope.workspaceId,
        });
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (scopes.length > 0) {
      try {
        cleanupResiduals = await postCleanupInspector(input, scopes);
        for (const scope of scopes) {
          const reset = resetResults[scope.key];
          const residual = cleanupResiduals[scope.key];
          invariant(
            reset
              && residual
              && reset.createdObjectCount === residual.ledgerCount
              && reset.deletedObjectCount === reset.createdObjectCount,
            "A11Y_FIXTURE_CLEANUP_RECONCILIATION_FAILED",
          );
        }
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (databaseStore && baselineInventory && retainedInventoryBefore) {
      try {
        const [afterInventory, remainingObjectCount, retainedAfterRaw] = await Promise.all([
          databaseStore.inventory(),
          databaseStore.remainingBatchObjectCount(),
          databaseStore.retainedInventory(),
        ]);
        const operationalBefore = normalizedInventory(
          baselineInventory,
          "A11Y_FIXTURE_OPERATIONAL_INVENTORY_INVALID",
        );
        const operationalAfter = normalizedInventory(
          afterInventory,
          "A11Y_FIXTURE_OPERATIONAL_INVENTORY_INVALID",
        );
        assertRetainedMembershipNonDestructive(retainedInventoryBefore, retainedAfterRaw);
        const retainedBefore = normalizedRetainedInventory(
          retainedInventoryBefore,
          "A11Y_FIXTURE_RETAINED_INVENTORY_INVALID",
        );
        const retainedAfter = normalizedRetainedInventory(
          retainedAfterRaw,
          "A11Y_FIXTURE_RETAINED_INVENTORY_INVALID",
        );
        assertRetainedInventoryNonDestructive(retainedBefore, retainedAfter);
        invariant(
          operationalAfter.digest === operationalBefore.digest
            && operationalAfter.rowCount === operationalBefore.rowCount
            && remainingObjectCount === 0,
          "A11Y_FIXTURE_OPERATIONAL_INVENTORY_NOT_RESTORED",
        );
        baselineInventory = operationalBefore;
        operationalInventoryAfter = operationalAfter;
        retainedInventoryBefore = retainedBefore;
        retainedInventoryAfter = retainedAfter;
        remainingBatchObjectCount = remainingObjectCount;
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure) {
      failure = new A11yPreviewFixtureLifecycleError(
        "A11Y_FIXTURE_EMERGENCY_CLEANUP_FAILED",
        { cause: cleanupFailure },
      );
    }
  }
  if (failure) throw failure;
  invariant(
    primaryBatch
      && crossTenantBatch
      && a11yResult
      && /^[a-f0-9]{64}$/u.test(a11yResult.browserEvidenceSha256 ?? "")
      && /^[a-f0-9]{64}$/u.test(a11yResult.browserSidecarSha256 ?? "")
      && Number.isSafeInteger(a11yResult.browserEvidenceSizeBytes)
      && a11yResult.browserEvidenceSizeBytes > 0
      && /^a11y-run-[a-f0-9-]{36}$/u.test(a11yResult.runId ?? "")
      && baselineInventory
      && operationalInventoryAfter
      && retainedInventoryBefore
      && retainedInventoryAfter
      && cleanupResiduals
      && remainingBatchObjectCount === 0,
    "A11Y_FIXTURE_RESULT_INCOMPLETE",
  );
  const cleanupScopeEvidence = Object.fromEntries([
    ["primary", primaryBatch],
    ["crossTenant", crossTenantBatch],
  ].map(([key, batch]) => {
    const reset = resetResults[key];
    const residual = cleanupResiduals[key];
    return [key, {
      auditCount: residual.auditCount,
      batchFingerprint: fingerprint(
        key === "primary" ? "a11y-primary-batch" : "a11y-cross-tenant-batch",
        batch.batchId,
        64,
      ),
      createdObjectCount: reset.createdObjectCount,
      deletedObjectCount: reset.deletedObjectCount,
      executedCount: residual.executedCount,
      ledgerCount: residual.ledgerCount,
      liveCascadeCount: residual.liveCascadeCount,
      liveRegisteredCount: residual.liveRegisteredCount,
      unexpectedLedgerCount: residual.unexpectedLedgerCount,
    }];
  }));
  const lifecycleDocument = {
    browserEvidence: {
      fileName: a11yBrowserEvidenceFileName,
      sha256: a11yResult.browserEvidenceSha256,
      sidecarFileName: a11yBrowserEvidenceSidecarFileName,
      sidecarSha256: a11yResult.browserSidecarSha256,
      sizeBytes: a11yResult.browserEvidenceSizeBytes,
    },
    candidateCommit: input.expectedGitSha,
    cleanup: {
      crossTenant: cleanupScopeEvidence.crossTenant,
      primary: cleanupScopeEvidence.primary,
      remainingBatchObjectCount,
      residualLiveObjectCount: 0,
      status: "PASS",
    },
    completedAt: new Date().toISOString(),
    database: {
      operationalAfter: operationalInventoryAfter,
      operationalBefore: baselineInventory,
      retainedAfter: retainedInventoryAfter,
      retainedBefore: retainedInventoryBefore,
      targetDigest: databaseTargetDigest(input),
    },
    deploymentHost: input.expectedHost,
    deploymentId: input.expectedDeploymentId,
    gitBranch: input.expectedGitRef,
    neonBranchId: input.expectedNeonBranchId,
    neonProjectId: input.expectedNeonProjectId,
    productionMutationPerformed: false,
    recordType: a11yFixtureLifecycleRecordType,
    runId: a11yResult.runId,
    schemaVersion: 1,
    status: "PASS",
  };
  const lifecycleSha256 = createHash("sha256")
    .update(canonicalJson(lifecycleDocument))
    .digest("hex");
  validateA11yFixtureLifecycleEvidence({
    browserEvidenceSha256: a11yResult.browserEvidenceSha256,
    document: lifecycleDocument,
    expectedRuntime: {
      candidateCommit: input.expectedGitSha,
      databaseBranchId: input.expectedNeonBranchId,
      databaseProjectId: input.expectedNeonProjectId,
      deploymentHost: input.expectedHost,
      deploymentId: input.expectedDeploymentId,
      gitBranch: input.expectedGitRef,
      productionMutationPerformed: false,
    },
    lifecycleSha256,
  });
  const writtenLifecycle = await lifecycleEvidenceWriter(a11yResult.outputDirectory, lifecycleDocument);
  invariant(
    writtenLifecycle?.digest === lifecycleSha256,
    "A11Y_FIXTURE_LIFECYCLE_EVIDENCE_DIGEST_MISMATCH",
  );
  const summary = {
    a11yBrowserEvidenceSha256: a11yResult.browserEvidenceSha256,
    a11yFixtureLifecycleSha256: lifecycleSha256,
    candidateSha: input.expectedGitSha,
    crossTenantBatchFingerprint: fingerprint("a11y-cross-tenant-batch", crossTenantBatch.batchId),
    deploymentHost: input.expectedHost,
    deploymentId: input.expectedDeploymentId,
    neonBranchId: input.expectedNeonBranchId,
    primaryBatchFingerprint: fingerprint("a11y-primary-batch", primaryBatch.batchId),
    productionMutationPerformed: false,
    retainedAppendOnlyRowDelta: retainedInventoryAfter.rowCount - retainedInventoryBefore.rowCount,
    residualLiveObjectCount: 0,
    runId: a11yResult.runId,
    status: "PASS",
  };
  assertPublicRuntimeEvidenceSafe(summary);
  return Object.freeze(summary);
}

export const a11yPreviewFixtureLifecycleContract = Object.freeze({
  confirmation: lifecycleConfirmation,
  handoff: "STDIN_ONLY",
  productionMutationAllowed: false,
  schemaVersion: 1,
});
