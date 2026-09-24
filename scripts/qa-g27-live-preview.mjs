import { createHash, createHmac, randomUUID } from "node:crypto";
import { access as fileAccess, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, request as playwrightRequest } from "@playwright/test";
import pg from "pg";
import { previewAccessHeaders, crmBrowserOrigin, verifyCrmBrowserBinding } from "./lib/g27-preview-access.mjs";

// G27 live verification is intentionally Preview-only and synthetic-only.
// It never reads secrets from source files and never prints response bodies,
// credentials, protection values, TOTP material, or database connection data.
//
// Required private inputs (paths can be overridden with G27_QA_*_FILE):
// - preview-private.json: pre-enrolled synthetic CRM fixture and Preview DB target
// - live-access.json: pinned CRM/Evelyn Preview origins, deployment IDs, commit
//   SHAs, Vercel project ID, protection material, and synthetic Owner password
// - live-browser-private.json: existing synthetic MFA seed
// - live-preseed-private.json: Legacy/V1 fixture, foreign-tenant fixture,
//   disposable Preview DB identity, and optional Neon cleanup targets
//
// Deployment pins may instead come from G27_{CRM,EVELYN}_{DEPLOYMENT_ID,
// COMMIT_SHA}, G27_CRM_VERCEL_PROJECT_ID and the two *_ENVIRONMENT values.
// Live mode: --run-authorized-live
// Cleanup mode: --cleanup --run-authorized-preview-cleanup
const OUTPUT_DIR = ".npm-cache/g27";
const EXPECTED_EVELYN_V2_ORIGIN = "https://evelyn-jyh6ijl3u-novalure.vercel.app";
const EXPECTED_CRM_VERCEL_PROJECT_ID = "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
const REPORT_PATH = path.join(OUTPUT_DIR, "live-preview-report.json");
const CLEANUP_REPORT_PATH = path.join(OUTPUT_DIR, "live-preview-cleanup-report.json");
const argv = new Set(process.argv.slice(2));

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(value)
    ? value
    : "UNEXPECTED_RESPONSE";
}

function object(value, code) {
  ensure(value && typeof value === "object" && !Array.isArray(value), code);
  return value;
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function endpoint(origin, relative) {
  ensure(typeof relative === "string" && relative.startsWith("/") && !relative.startsWith("//"), "RELATIVE_PATH_REQUIRED");
  const url = new URL(relative, origin);
  ensure(url.origin === origin, "EXACT_ORIGIN_REQUIRED");
  return url;
}

function previewOrigin(raw, system, environment) {
  ensure(environment === "preview", `${system}_PREVIEW_ENVIRONMENT_REQUIRED`);
  const url = new URL(raw);
  ensure(url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash
    && !url.username && !url.password, `${system}_PREVIEW_ORIGIN_REQUIRED`);
  ensure(url.hostname.endsWith(".vercel.app"), `${system}_VERCEL_PREVIEW_REQUIRED`);
  ensure(!["novalure-crm.vercel.app", "evelyn.vercel.app"].includes(url.hostname), `${system}_PRODUCTION_ORIGIN_DENIED`);
  return url.origin;
}

function protectionHeaders(raw) {
  object(raw, "PROTECTION_HEADERS_REQUIRED");
  const result = {};
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    ensure(["x-vercel-protection-bypass", "x-vercel-set-bypass-cookie"].includes(lower)
      && typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value), "INVALID_PROTECTION_HEADER");
    result[lower] = value;
  }
  return result;
}

function protectionUrl(raw, origin) {
  if (raw === undefined || raw === null || raw === "") return null;
  const url = new URL(raw);
  ensure(url.origin === origin && !url.username && !url.password, "PROTECTION_URL_ORIGIN_REQUIRED");
  return url.href;
}

export async function vercelDeploymentEvidence(system, section, origin, pins) {
  const token = process.env.G27_VERCEL_API_TOKEN;
  ensure(typeof token === "string" && token.length > 20, "VERCEL_API_TOKEN_REQUIRED");
  ensure(/^team_[A-Za-z0-9]+$/.test(section.teamId ?? ""), `${system}_VERCEL_TEAM_REQUIRED`);
  const deploymentId = system === "CRM" ? pins.crmDeploymentId : pins.evelynDeploymentId;
  const commitSha = system === "CRM" ? pins.crmCommitSha : pins.evelynCommitSha;
  const url = new URL(`https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}`);
  url.searchParams.set("teamId", section.teamId);
  const response = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  ensure(response.status === 200 && response.headers.get("content-type")?.includes("application/json"),
    `${system}_DEPLOYMENT_LOOKUP_FAILED`);
  let raw;
  try {
    raw = object(await response.json(), `${system}_DEPLOYMENT_OBJECT_REQUIRED`);
  } catch {
    throw new Error(`${system}_DEPLOYMENT_RESPONSE_INVALID`);
  }
  const actualProjectId = raw.projectId ?? raw.project?.id;
  const actualTeamId = raw.team?.id ?? raw.teamId;
  const actualCommit = raw.meta?.githubCommitSha ?? raw.meta?.gitCommitSha ?? raw.gitSource?.sha;
  const actualRef = raw.meta?.githubCommitRef ?? raw.meta?.gitCommitRef ?? raw.gitSource?.ref ?? null;
  const immutableHost = typeof raw.url === "string"
    ? raw.url.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase() : null;
  const expectedHost = new URL(origin).hostname.toLowerCase();
  ensure(raw.id === deploymentId, `${system}_DEPLOYMENT_ID_MISMATCH`);
  ensure(actualProjectId === (system === "CRM" ? pins.crmVercelProjectId : section.vercelProjectId),
    `${system}_DEPLOYMENT_PROJECT_MISMATCH`);
  ensure(actualTeamId === section.teamId, `${system}_DEPLOYMENT_TEAM_MISMATCH`);
  ensure(actualRef === (system === "CRM" ? "codex/crm-production-readiness-g27" : "codex/evelyn-g27-qa-20260924"),
    `${system}_DEPLOYMENT_BRANCH_MISMATCH`);
  ensure(actualCommit === commitSha, `${system}_DEPLOYMENT_COMMIT_MISMATCH`);
  ensure(immutableHost === expectedHost, `${system}_DEPLOYMENT_ORIGIN_MISMATCH`);
  ensure(raw.readyState === "READY" && raw.target !== "production"
    && !/^(main|master|production)$/i.test(actualRef ?? ""), `${system}_DEPLOYMENT_NOT_PREVIEW_READY`);
  return {
    deploymentId: raw.id,
    projectId: actualProjectId,
    teamId: section.teamId,
    commitSha: actualCommit,
    gitRef: actualRef,
    matchedHost: expectedHost,
    readyState: raw.readyState,
    target: raw.target ?? null,
  };
}

async function readable(file) {
  try {
    await fileAccess(file);
    return true;
  } catch {
    return false;
  }
}

async function readPrivateJson(label, candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (!(await readable(candidate))) continue;
    try {
      return object(JSON.parse(await readFile(candidate, "utf8")), `${label}_OBJECT_REQUIRED`);
    } catch {
      throw new Error(`${label}_INVALID`);
    }
  }
  throw new Error(`${label}_REQUIRED`);
}

async function writePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

export function authenticatorCode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = [];
  let accumulator = 0;
  let bits = 0;
  ensure(typeof secret === "string" && /^[A-Z2-7]{16,}$/.test(secret), "INVALID_SYNTHETIC_TOTP_KEY");
  for (const character of secret) {
    const value = alphabet.indexOf(character);
    ensure(value >= 0, "INVALID_SYNTHETIC_TOTP_KEY");
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const result = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = result[result.length - 1] & 15;
  return String((result.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function successful(response, label) {
  ensure(response.status >= 200 && response.status < 300,
    `${label}_HTTP_${response.status}_${safeCode(response.body?.code ?? response.body?.error)}`);
  return response.body;
}

function resultData(body) {
  return body?.data ?? body;
}

function moneyEvidence(record) {
  const snapshot = record.snapshot;
  return {
    id: record.id,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    businessVersion: record.businessVersion,
    reviewState: record.reviewState,
    supersedesSnapshotId: record.supersedesSnapshotId,
    snapshotHash: record.snapshotHash,
    schemaVersion: snapshot.snapshotSchemaVersion,
    canonicalReviewState: snapshot.reviewState,
    currency: snapshot.currency,
    minorUnitExponent: snapshot.minorUnitExponent,
    totals: snapshot.totals,
    roundingPolicy: snapshot.roundingPolicy,
    currencyPolicy: snapshot.currencyDefinition?.registryReference ?? null,
    taxComponents: (snapshot.components ?? []).flatMap(component => component.taxComponents.map(tax => ({
      componentId: tax.componentId,
      amount: tax.amount,
      policyReference: tax.policy.reference,
      jurisdiction: tax.policy.jurisdiction,
      sourceReference: tax.policy.sourceProvenance.sourceReference,
    }))),
    provenance: snapshot.provenance ? {
      sourceSystem: snapshot.provenance.sourceSystem,
      sourceRecordId: snapshot.provenance.sourceRecordId,
      sourceVersion: snapshot.provenance.sourceVersion,
      sourceHash: snapshot.provenance.sourceHash,
    } : null,
  };
}

function policyPayloads(marker, verifiedAt) {
  const currencyId = `SYNTHETIC:G27:${marker}:currency`;
  const roundingId = `SYNTHETIC:G27:${marker}:rounding`;
  const taxId = `SYNTHETIC:G27:${marker}:tax`;
  const currency = {
    policySchemaVersion: "crm-currency-policy-v1",
    kind: "CURRENCY",
    standard: "ISO-4217",
    code: "EUR",
    minorUnitExponent: 2,
    verifiedAt,
  };
  const rounding = {
    policySchemaVersion: "crm-rounding-policy-v1",
    kind: "ROUNDING",
    mode: "HALF_EVEN",
    currencyExponent: 2,
    scope: "TAX_COMPONENT",
  };
  const tax = (version, numerator) => ({
    policySchemaVersion: "crm-tax-policy-v1",
    kind: "TAX",
    jurisdiction: "AT:BUSINESS",
    treatment: `SYNTHETIC:G27:${marker}:net-tax`,
    category: `SYNTHETIC:G27:${marker}:standard`,
    rate: { basis: "NET", numerator, denominator: "100" },
    sourceProvenance: {
      authority: "SYNTHETIC G27 preview authority",
      sourceReference: `SYNTHETIC:G27:${marker}:tax:${version}:source`,
      jurisdiction: "AT:BUSINESS",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      policyVersion: version,
      verifiedAt,
    },
  });
  return { currencyId, roundingId, taxId, currency, rounding, tax };
}

async function loadInputs() {
  const fixtureDocument = await readPrivateJson("PRIVATE_FIXTURE", [
    process.env.G27_QA_FIXTURE_FILE,
    path.join(OUTPUT_DIR, "preview-private.json"),
  ]);
  const access = await readPrivateJson("PRIVATE_ACCESS", [
    process.env.G27_QA_ACCESS_FILE,
    path.join(OUTPUT_DIR, "live-access.json"),
  ]);
  const preseed = await readPrivateJson("PRIVATE_PRESEED", [
    process.env.G27_QA_PRESEED_FILE,
    path.join(OUTPUT_DIR, "live-preseed-private.json"),
  ]);
  return { fixtureDocument, fixture: fixtureDocument.fixture ?? fixtureDocument.crmFixture ?? fixtureDocument, access, preseed };
}

function validateInputs(inputs) {
  const { fixtureDocument, fixture, access, preseed } = inputs;
  object(fixture, "FIXTURE_REQUIRED");
  object(access.crm, "CRM_ACCESS_REQUIRED");
  object(access.evelyn, "EVELYN_ACCESS_REQUIRED");
  object(access.evelyn.config, "EVELYN_CONFIG_REQUIRED");
  object(preseed.legacyContract, "LEGACY_V1_PRESEED_REQUIRED");
  object(preseed.foreignTenant, "FOREIGN_TENANT_PRESEED_REQUIRED");
  object(preseed.database, "PREVIEW_DATABASE_PRESEED_REQUIRED");
  const crmOrigin = previewOrigin(access.crm.url, "CRM", access.crm.environment ?? process.env.G27_CRM_ENVIRONMENT);
  const evelynOrigin = previewOrigin(access.evelyn.url, "EVELYN", access.evelyn.environment ?? process.env.G27_EVELYN_ENVIRONMENT);
  const pins = {
    crmDeploymentId: access.crm.deploymentId ?? process.env.G27_CRM_DEPLOYMENT_ID,
    crmCommitSha: access.crm.commitSha ?? process.env.G27_CRM_COMMIT_SHA,
    crmVercelProjectId: access.crm.vercelProjectId ?? process.env.G27_CRM_VERCEL_PROJECT_ID,
    evelynDeploymentId: access.evelyn.deploymentId ?? process.env.G27_EVELYN_DEPLOYMENT_ID,
    evelynCommitSha: access.evelyn.commitSha ?? process.env.G27_EVELYN_COMMIT_SHA,
  };
  ensure(access.crm.state === "READY" && access.evelyn.state === "READY", "READY_PREVIEW_DEPLOYMENTS_REQUIRED");
  ensure(/^dpl_[A-Za-z0-9]+$/.test(pins.crmDeploymentId ?? ""), "PINNED_CRM_DEPLOYMENT_REQUIRED");
  ensure(/^dpl_[A-Za-z0-9]+$/.test(pins.evelynDeploymentId ?? ""), "PINNED_EVELYN_DEPLOYMENT_REQUIRED");
  ensure(/^[a-f0-9]{40}$/.test(pins.crmCommitSha ?? ""), "PINNED_CRM_COMMIT_REQUIRED");
  ensure(/^[a-f0-9]{40}$/.test(pins.evelynCommitSha ?? ""), "PINNED_EVELYN_COMMIT_REQUIRED");
  ensure(pins.evelynCommitSha === "1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc"
    && pins.evelynDeploymentId === "dpl_78AgPzc13Y2LNKFmZKMLpbDhdDiA", "EVELYN_HANDOFF_PIN_MISMATCH");
  ensure(pins.crmVercelProjectId === EXPECTED_CRM_VERCEL_PROJECT_ID, "PINNED_CRM_PROJECT_REQUIRED");
  ensure(/^prj_[A-Za-z0-9]+$/.test(access.evelyn.vercelProjectId ?? ""), "PINNED_EVELYN_PROJECT_REQUIRED");
  ensure(/^team_[A-Za-z0-9]+$/.test(access.crm.teamId ?? "")
    && access.evelyn.teamId === access.crm.teamId, "PINNED_VERCEL_TEAM_REQUIRED");
  ensure(typeof process.env.G27_VERCEL_API_TOKEN === "string"
    && process.env.G27_VERCEL_API_TOKEN.length > 20, "VERCEL_API_TOKEN_REQUIRED");
  ensure(evelynOrigin === EXPECTED_EVELYN_V2_ORIGIN, "CURRENT_EVELYN_V2_PREVIEW_REQUIRED");
  ensure([fixture.workspaceId, fixture.projectId, fixture.userId, fixture.developerId,
    fixture.developerContactId, access.evelyn.config.tenantId, access.evelyn.config.ownerId].every(isUuid),
  "CRM_FIXTURE_IDS_REQUIRED");
  ensure(typeof fixture.email === "string" && fixture.email.endsWith(".invalid"), "SYNTHETIC_EMAIL_REQUIRED");
  ensure(typeof fixture.password === "string" && fixture.password.length > 0, "CRM_TEST_PASSWORD_REQUIRED");
  ensure(typeof fixture.developerId === "string" && typeof fixture.developerContactId === "string", "PROPERTY_AUTHORITY_FIXTURE_REQUIRED");
  ensure(typeof access.evelyn.ownerPassword === "string" && access.evelyn.ownerPassword.length > 0, "OWNER_TEST_PASSWORD_REQUIRED");
  ensure(access.evelyn.config.tenantId === fixture.workspaceId, "QA_TENANT_BINDING_REQUIRED");
  ensure(preseed.environment === "preview", "PRESEED_PREVIEW_REQUIRED");
  ensure(isUuid(preseed.workspaceId) && isUuid(preseed.projectId)
    && preseed.workspaceId === fixture.workspaceId && preseed.projectId === fixture.projectId, "PRESEED_SCOPE_REQUIRED");
  ensure(preseed.legacyContract.workspaceId === fixture.workspaceId
    && preseed.legacyContract.projectId === fixture.projectId, "LEGACY_V1_SCOPE_REQUIRED");
  ensure([preseed.legacyContract.actionId, preseed.legacyContract.correlationId].every(isUuid),
    "LEGACY_V1_IDENTIFIERS_REQUIRED");
  ensure(Number.isSafeInteger(preseed.legacyContract.actionVersion) && preseed.legacyContract.actionVersion >= 1,
    "LEGACY_V1_VERSION_REQUIRED");
  ensure(preseed.foreignTenant.workspaceId !== fixture.workspaceId, "DISTINCT_FOREIGN_TENANT_REQUIRED");
  ensure(isUuid(preseed.foreignTenant.workspaceId) && isUuid(preseed.foreignTenant.snapshotId),
    "FOREIGN_TENANT_IDENTIFIERS_REQUIRED");
  ensure(/^[a-f0-9]{64}$/.test(preseed.foreignTenant.snapshotHash ?? ""), "FOREIGN_SNAPSHOT_HASH_REQUIRED");
  const sourceBranch = fixtureDocument.target?.branch;
  ensure(preseed.database.environment === "preview" && preseed.database.disposable === true,
    "DISPOSABLE_PREVIEW_DATABASE_REQUIRED");
  ensure(/^br-[A-Za-z0-9-]+$/.test(preseed.database.crmBranchId ?? "")
    && sourceBranch === preseed.database.crmBranchId, "PINNED_PREVIEW_DATABASE_BRANCH_REQUIRED");
  ensure(!/^(main|master|production)$/i.test(sourceBranch), "PRODUCTION_DATABASE_BRANCH_DENIED");
  const crmCleanupTarget = Array.isArray(preseed.cleanup?.targets)
    ? preseed.cleanup.targets.find(target => target.system === "crm")
    : null;
  ensure(crmCleanupTarget
    && crmCleanupTarget.projectId === preseed.database.crmProjectId
    && crmCleanupTarget.branchId === preseed.database.crmBranchId
    && crmCleanupTarget.parentBranchId === preseed.database.crmParentBranchId
    && crmCleanupTarget.environment === "preview"
    && crmCleanupTarget.disposable === true, "CRM_PREVIEW_CLEANUP_TARGET_REQUIRED");
  return {
    crmOrigin,
    evelynOrigin,
    pins,
    crmHeaders: { ...protectionHeaders(access.crm.protectionHeaders),
      ...(process.env.G27_CRM_ACCESS_OIDC_TOKEN ? previewAccessHeaders(process.env.G27_CRM_ACCESS_OIDC_TOKEN) : {}) },
    ownerHeaders: { ...protectionHeaders(access.evelyn.protectionHeaders),
      ...(process.env.G27_EVELYN_PROTECTION_BYPASS
        ? protectionHeaders({ "x-vercel-protection-bypass": process.env.G27_EVELYN_PROTECTION_BYPASS }) : {}),
      ...(!process.env.G27_EVELYN_PROTECTION_BYPASS && process.env.G27_EVELYN_ACCESS_OIDC_TOKEN ? previewAccessHeaders(process.env.G27_EVELYN_ACCESS_OIDC_TOKEN,
        Date.now(), "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I") : {}) },
    crmProtectionUrl: protectionUrl(access.crm.protectionUrl, crmOrigin),
    ownerProtectionUrl: protectionUrl(access.evelyn.protectionUrl, evelynOrigin),
  };
}

async function liveMain() {
  ensure(argv.has("--run-authorized-live") && !argv.has("--cleanup"), "EXPLICIT_LIVE_RUN_FLAG_REQUIRED");
  const inputs = await loadInputs();
  const { fixture, access, preseed } = inputs;
  const validated = validateInputs(inputs);
  const { crmOrigin: crmDeploymentOrigin, evelynOrigin, pins, crmHeaders, ownerHeaders, crmProtectionUrl, ownerProtectionUrl } = validated;
  const crmOrigin = crmBrowserOrigin;
  ensure(crmProtectionUrl || crmHeaders["x-vercel-protection-bypass"] || crmHeaders["x-vercel-trusted-oidc-idp-token"], "CRM_PROTECTION_ACCESS_REQUIRED");
  ensure(ownerProtectionUrl || ownerHeaders["x-vercel-protection-bypass"] || ownerHeaders["x-vercel-trusted-oidc-idp-token"], "OWNER_PROTECTION_ACCESS_REQUIRED");

  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const report = {
    reportContractVersion: "g27-live-preview-report-v1",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "RUNNING",
    failedStep: null,
    environment: "preview",
    syntheticOnly: true,
    productionMutation: false,
    externalContractDelivery: false,
    runMarker: marker,
    targets: {
      crm: { origin: crmDeploymentOrigin, browserOrigin: crmOrigin, deploymentId: pins.crmDeploymentId, commitSha: pins.crmCommitSha, vercelProjectId: pins.crmVercelProjectId },
      evelyn: { origin: evelynOrigin, deploymentId: pins.evelynDeploymentId, commitSha: pins.evelynCommitSha },
      tenantId: fixture.workspaceId,
      projectId: fixture.projectId,
    },
    checks: [],
    assertions: [],
    http: [],
    flows: {},
    artifacts: {
      contacts: [], leads: [], deals: [], offers: [], units: [], reservations: [], sales: [],
      policies: [], actions: [], snapshots: [], approvals: [],
    },
    cleanup: {
      strategy: "DISPOSABLE_PREVIEW_BRANCH_DELETE",
      supportedByRunner: true,
      command: "node scripts/qa-g27-live-preview.mjs --cleanup --run-authorized-preview-cleanup",
      status: "PENDING",
      targets: Array.isArray(preseed.cleanup?.targets)
        ? preseed.cleanup.targets.map(target => ({ system: target.system, provider: target.provider,
          projectId: target.projectId, branchId: target.branchId, branchName: target.branchName,
          parentBranchId: target.parentBranchId, parentBranchName: target.parentBranchName,
          schemaSourceBranchId: target.schemaSourceBranchId ?? null,
          schemaSourceBranchName: target.schemaSourceBranchName ?? null,
          createdAt: target.createdAt }))
        : [],
    },
    limits: [
      "The browser runner proves public Preview behavior; independent database evidence must confirm row counts and audit events.",
      "Append-only G27 facts are cleaned by deleting explicitly disposable Preview database branches, never by mutating historical rows.",
      "The Legacy/V1 and foreign-tenant fixtures must be prepared by a separate tenant-aware admin seed before the run.",
    ],
  };
  let active = "INITIALIZATION";
  let activeFlow = "PRECHECK";
  let browser;
  let context;
  let ownerContext;
  let lastCrmServerDate;
  let ownerCsrf;
  let ownerCookie = false;
  let pageErrors = 0;

  const save = () => writePrivateJson(REPORT_PATH, report);
  const track = (collection, value) => {
    if (value && !report.artifacts[collection].includes(value)) report.artifacts[collection].push(value);
  };
  const exact = (name, actual, expected) => {
    const pass = stable(actual) === stable(expected);
    report.assertions.push({ flow: activeFlow, step: active, name, expected, actual, status: pass ? "PASS" : "FAIL" });
    ensure(pass, "EXACT_ASSERTION_FAILED");
  };
  const truth = (name, condition, evidence) => {
    const pass = condition === true;
    report.assertions.push({ flow: activeFlow, step: active, name, expected: true,
      actual: pass, ...(evidence === undefined ? {} : { evidence }), status: pass ? "PASS" : "FAIL" });
    ensure(pass, "BOOLEAN_ASSERTION_FAILED");
  };
  const step = async (flow, name, work) => {
    activeFlow = flow;
    active = name;
    try {
      const result = await work();
      report.checks.push({ flow, name, status: "PASS" });
      await save();
      console.log(`PASS ${flow} ${name}`);
      return result;
    } catch (error) {
      report.checks.push({ flow, name, status: "FAIL", reason: safeCode(error?.message) });
      throw new Error("LIVE_STEP_FAILED");
    }
  };
  const recordHttp = (system, requestPath, method, response, correlationId) => {
    const body = response.body ?? {};
    const value = resultData(body) ?? {};
    report.http.push({
      system,
      path: requestPath.split("?")[0],
      method,
      httpStatus: response.status,
      ...(correlationId ? { correlationId } : {}),
      ...(typeof value.status === "string" ? { result: safeCode(value.status) } : {}),
      ...(body.code || body.error ? { code: safeCode(body.code ?? body.error) } : {}),
      ...(typeof body.auditReference === "string" ? { auditReference: body.auditReference } : {}),
    });
  };
  const expectDenied = (response, expectedStatus, expectedCode, label) => {
    exact(`${label}_HTTP_STATUS`, response.status, expectedStatus);
    exact(`${label}_ERROR_CODE`, response.body?.code ?? response.body?.error, expectedCode);
    return { status: response.status, code: response.body?.code ?? response.body?.error };
  };

  async function owner(requestPath, body, method = "POST", extraHeaders = {}) {
    const url = endpoint(evelynOrigin, requestPath);
    ensure(Object.keys(extraHeaders).every(name => name.toLowerCase() === "authorization"), "OWNER_EXTRA_HEADER_DENIED");
    const headers = {
      ...ownerHeaders,
      ...(method === "POST" ? {
        "content-type": "application/json",
        origin: evelynOrigin,
        "sec-fetch-site": "same-origin",
        ...(ownerCsrf ? { "x-evelyn-csrf": ownerCsrf } : {}),
      } : {}),
      ...extraHeaders,
    };
    const response = await ownerContext.fetch(url.href, {
      method,
      headers,
      ...(method === "POST" ? { data: JSON.stringify(body) } : {}),
      maxRedirects: 0,
      timeout: 30_000,
    });
    const cookies = (await ownerContext.storageState()).cookies;
    ownerCookie = cookies.some(cookie => cookie.name === "__Host-evelyn-test");
    if (!response.headers()["content-type"]?.includes("application/json")) {
      recordHttp("evelyn-owner", requestPath, method, { status: response.status(), body: { code: "NON_JSON_RESPONSE" } });
      throw new Error("EVELYN_JSON_REQUIRED");
    }
    const result = { status: response.status(), body: await response.json() };
    recordHttp("evelyn-owner", requestPath, method, result);
    return result;
  }

  try {
    await step("PRECHECK", "LIVE_VERCEL_DEPLOYMENT_ORIGIN_PROJECT_AND_COMMIT_BINDING", async () => {
      const crmDeployment = await vercelDeploymentEvidence("CRM", access.crm, crmDeploymentOrigin, pins);
      await verifyCrmBrowserBinding(access.crm);
      const evelynDeployment = await vercelDeploymentEvidence("EVELYN", access.evelyn, evelynOrigin, pins);
      exact("CRM_DEPLOYMENT_ID_LIVE_BINDING", crmDeployment.deploymentId, pins.crmDeploymentId);
      exact("CRM_DEPLOYMENT_PROJECT_LIVE_BINDING", crmDeployment.projectId, pins.crmVercelProjectId);
      exact("CRM_DEPLOYMENT_COMMIT_LIVE_BINDING", crmDeployment.commitSha, pins.crmCommitSha);
      exact("CRM_DEPLOYMENT_READY_STATE", crmDeployment.readyState, "READY");
      exact("EVELYN_DEPLOYMENT_ID_LIVE_BINDING", evelynDeployment.deploymentId, pins.evelynDeploymentId);
      exact("EVELYN_DEPLOYMENT_PROJECT_LIVE_BINDING", evelynDeployment.projectId, access.evelyn.vercelProjectId);
      exact("EVELYN_DEPLOYMENT_COMMIT_LIVE_BINDING", evelynDeployment.commitSha, pins.evelynCommitSha);
      exact("EVELYN_DEPLOYMENT_READY_STATE", evelynDeployment.readyState, "READY");
      report.targets.crm.vercelApiEvidence = crmDeployment;
      report.targets.evelyn.vercelApiEvidence = evelynDeployment;
    });
    browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
    context.setDefaultTimeout(30_000);
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["data:", "blob:"].includes(url.protocol)) return route.continue();
      if (url.origin !== crmOrigin) return route.abort();
      if (!["GET", "HEAD"].includes(route.request().method())) {
        try { await verifyCrmBrowserBinding(access.crm); } catch { return route.abort(); }
      }
      return route.continue({ headers: { ...route.request().headers(), ...crmHeaders } });
    });
    await context.addInitScript(() => localStorage.setItem("novalure-crm-navigation-preset-v1", "realEstateBroker"));
    const page = await context.newPage();
    report.loginHttp = [];
    page.on("response", response => {
      const request = response.request();
      if (new URL(response.url()).pathname === "/api/auth/login") {
        report.loginHttp.push({ method: request.method(), status: response.status(),
          origin: request.headers().origin ?? null,
          fetchSite: request.headers()["sec-fetch-site"] ?? null });
      }
    });
    page.on("pageerror", () => { pageErrors += 1; });

    async function crmCall(requestPath, body, method = "POST", metadata = {}) {
      endpoint(crmOrigin, requestPath);
      const idempotencyKey = metadata.idempotencyKey ?? randomUUID();
      const correlationId = metadata.correlationId ?? randomUUID();
      const response = await page.evaluate(async input => {
        const headers = {
          "content-type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
          "X-Correlation-Id": input.correlationId,
        };
        if (input.method !== "GET") {
          const csrf = await fetch("/api/auth/csrf?" + new URLSearchParams({
            method: input.method,
            path: input.requestPath.split("?")[0],
          }), { redirect: "error", signal: AbortSignal.timeout(30_000) });
          const token = await csrf.json();
          if (!csrf.ok || typeof token.csrfToken !== "string") {
            return { status: csrf.status, body: { code: "CSRF_UNAVAILABLE" } };
          }
          headers["x-novalure-csrf-token"] = token.csrfToken;
        }
        const result = await fetch(input.requestPath, {
          method: input.method,
          headers,
          ...(input.method === "GET" ? {} : { body: JSON.stringify(input.body) }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (!result.headers.get("content-type")?.includes("application/json")) {
          return { status: result.status, body: { code: "NON_JSON_RESPONSE" } };
        }
        return { status: result.status, serverDate: result.headers.get("date"), body: await result.json() };
      }, { requestPath, body, method, idempotencyKey, correlationId });
      lastCrmServerDate = response.serverDate;
      recordHttp("crm", requestPath, method, response, correlationId);
      return response;
    }

    const api = async (requestPath, body, method = "POST", metadata = {}) =>
      successful(await crmCall(requestPath, body, method, metadata), "CRM");
    const get = requestPath => api(requestPath, undefined, "GET");
    const contract = body => crmCall("/api/crm/evelyn-contracts", body, "POST", body);
    const getSnapshot = async snapshotId => (await get(`/api/crm/financial-snapshots?snapshotId=${encodeURIComponent(snapshotId)}`)).snapshot;

    await step("PRECHECK", "PINNED_PREVIEW_AND_MFA_LOGIN", async () => {
      if (crmProtectionUrl) {
        await page.goto(crmProtectionUrl, { waitUntil: "domcontentloaded" });
        exact("CRM_PROTECTION_REDIRECT_ORIGIN", new URL(page.url()).origin, crmOrigin);
      }
      const response = await page.goto(`${crmOrigin}/login?lang=de`, { waitUntil: "domcontentloaded" });
      truth("CRM_LOGIN_PAGE_OK", Boolean(response?.ok()));
      exact("CRM_LOGIN_ORIGIN", new URL(page.url()).origin, crmOrigin);
      await expect(page.locator("#login-email")).toBeVisible();
      await page.locator("#login-email").fill(fixture.email);
      await page.locator("#login-password").fill(fixture.password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.locator("form:has(#login-password) button[type=submit]").click(),
      ]);
      await expect(page.locator("#login-mfa-code")).toBeVisible();
      // The live runner consumes an already-enrolled synthetic MFA fixture. It
      // never scrapes or emits enrollment secrets from a Preview page.
      exact("PRESEEDED_MFA_ENROLLMENT", await page.locator("input[name=recoveryCodesSaved]").count(), 0);
      const prior = await readPrivateJson("PRIVATE_MFA", [
        process.env.G27_QA_MFA_FILE,
        path.join(OUTPUT_DIR, "live-browser-private.json"),
      ]);
      exact("MFA_WORKSPACE_BINDING", prior.workspaceId, fixture.workspaceId);
      exact("MFA_EMAIL_BINDING", prior.email, fixture.email);
      const totpSecret = prior.totpSecret;
      await page.locator("#login-mfa-code").fill(authenticatorCode(totpSecret));
      await Promise.all([
        page.waitForURL(url => url.origin === crmOrigin && !url.pathname.startsWith("/login"), { waitUntil: "domcontentloaded", timeout: 30000 }),
        page.getByRole("button", { name: "Sicher bestätigen", exact: true }).click(),
      ]);
      const loginError = new URL(page.url()).searchParams.get("error");
      report.loginResultPath = new URL(page.url()).pathname;
      if (["invalid_credentials", "invalid_mfa", "database_unavailable", "rate_limited"].includes(loginError)) {
        report.loginError = loginError;
      }
      truth("CRM_LOGIN_LEFT_LOGIN_PAGE", !/\/login(?:\?|$)/.test(page.url()));
      const session = (await context.cookies()).find(cookie => cookie.name === "novalure_session");
      truth("CRM_SERVER_MFA_SESSION", Boolean(session?.httpOnly && session.secure && session.value.startsWith("v2.")));
      const core = await get("/api/crm/core");
      exact("AUTHENTICATED_WORKSPACE", core.activeWorkspaceId, fixture.workspaceId);
      exact("AUTHENTICATED_DATA_SOURCE", core.source, "database");
    });

    await step("PRECHECK", "SEPARATE_EVELYN_OWNER_LOGIN", async () => {
      ownerContext = await playwrightRequest.newContext({ timeout: 30_000 });
      if (ownerProtectionUrl) {
        let next = ownerProtectionUrl;
        for (let index = 0; index < 5; index += 1) {
          exact("OWNER_PROTECTION_REDIRECT_ORIGIN", new URL(next).origin, evelynOrigin);
          const response = await ownerContext.get(next, { headers: ownerHeaders, maxRedirects: 0 });
          if (response.status() >= 300 && response.status() < 400) {
            const location = response.headers().location;
            truth("OWNER_PROTECTION_LOCATION_PRESENT", Boolean(location));
            next = new URL(location, next).href;
            truth("OWNER_PROTECTION_REDIRECT_LIMIT", index < 4);
          } else {
            truth("OWNER_PROTECTION_OK", response.ok());
            break;
          }
        }
      }
      const health = successful(await owner("/api/health", undefined, "GET"), "EVELYN_HEALTH");
      exact("EVELYN_HEALTH_ENVIRONMENT", health.environment, "preview");
      exact("EVELYN_HEALTH_SYNTHETIC", health.synthetic, true);
      const login = successful(await owner("/api/login", { identity: "owner", password: access.evelyn.ownerPassword }), "OWNER_LOGIN");
      exact("OWNER_ROLE", login.role, "OWNER");
      truth("OWNER_CSRF_PRESENT", typeof login.csrf === "string" && login.csrf.length > 0);
      truth("OWNER_SESSION_COOKIE_PRESENT", ownerCookie);
      ownerCsrf = login.csrf;
    });

    const verifiedAt = new Date().toISOString();
    const policies = policyPayloads(marker, verifiedAt);
    const policyPath = "/api/crm/financial-policies";
    async function registerPolicy(policyId, policyVersion, payload, sourceReference) {
      const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const response = resultData(await api(policyPath, {
        projectId: fixture.projectId,
        policyId,
        policyVersion,
        payload,
        sourceReference,
        verifiedAt,
        ...metadata,
      }, "POST", metadata));
      exact("REGISTERED_POLICY_ID", response.policyId, policyId);
      exact("REGISTERED_POLICY_VERSION", response.policyVersion, policyVersion);
      exact("REGISTERED_POLICY_KIND", response.kind, payload.kind);
      truth("REGISTERED_POLICY_HASH", /^[a-f0-9]{64}$/.test(response.contentHash));
      track("policies", response.id);
      return { id: policyId, version: policyVersion, contentHash: response.contentHash };
    }

    let v1Selection;
    await step("A", "REGISTER_EXPLICIT_EUR_ROUNDING_AND_TAX_V1", async () => {
      const currency = await registerPolicy(policies.currencyId, "1", policies.currency,
        `SYNTHETIC:G27:${marker}:currency:source`);
      const rounding = await registerPolicy(policies.roundingId, "1", policies.rounding,
        `SYNTHETIC:G27:${marker}:rounding:source`);
      const taxPayload = policies.tax("1", "20");
      const tax = await registerPolicy(policies.taxId, "1", taxPayload, taxPayload.sourceProvenance.sourceReference);
      v1Selection = {
        jurisdiction: "AT:BUSINESS",
        currencyPolicy: { id: currency.id, version: currency.version },
        roundingPolicy: { id: rounding.id, version: rounding.version },
        taxPolicies: [{ componentId: "vat", policy: { id: tax.id, version: tax.version } }],
      };
      exact("TAX_V1_RATE", taxPayload.rate, { basis: "NET", numerator: "20", denominator: "100" });
      exact("TAX_V1_OUTER_SOURCE_BINDING", taxPayload.sourceProvenance.sourceReference,
        `SYNTHETIC:G27:${marker}:tax:1:source`);
    });

    async function acceptedOffer() {
      const contact = (await api("/api/crm/contacts", { contact: {
        name: `SYNTHETIC G27 Buyer ${marker}`,
        email: `g27-${marker}@example.invalid`,
        role: "Bauträger",
        source: "Manual",
        consent: "Opt-in",
        projectId: fixture.projectId,
      } })).contact;
      track("contacts", contact.id);
      const lead = (await api("/api/crm/leads", { lead: {
        contactId: contact.id,
        projectId: fixture.projectId,
        type: "Bauträger",
        source: "Manual",
        intent: "SYNTHETIC G27 service inquiry",
      } })).lead;
      track("leads", lead.id);
      const deal = (await api("/api/crm/deals", { deal: {
        contactId: contact.id,
        leadId: lead.id,
        projectId: fixture.projectId,
        name: `SYNTHETIC G27 EUR 20370 ${marker}`,
        stage: "Neu",
        value: "20370",
        expectedCloseDate: "2030-12-31",
      } })).deal;
      track("deals", deal.id);
      const view = () => get(`/api/crm/offers?dealId=${encodeURIComponent(deal.id)}`);
      async function offerCommand(operation, payload = {}) {
        const current = await view();
        const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
        return resultData(await api("/api/crm/offers", {
          operation,
          projectId: fixture.projectId,
          dealId: deal.id,
          ...(current.offer ? { offerId: current.offer.id } : {}),
          expectedVersion: current.offer?.version ?? current.dealVersion,
          payload,
          ...metadata,
        }, "POST", metadata));
      }
      await offerCommand("create", {
        leadId: lead.id,
        organizationName: `SYNTHETIC G27 Company ${marker}`,
        content: {
          subject: `SYNTHETIC G27 EUR 20370 ${marker}`,
          recipientName: contact.name,
          recipientEmail: contact.email,
          terms: "SYNTHETIC 9900 EUR setup plus three mandatory periods at 3490 EUR net; no external delivery.",
          validUntil: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          currency: "EUR",
          taxBasis: "NET",
          items: [
            { description: "SYNTHETIC G27 setup", quantity: 1, unitNetCents: 990_000 },
            { description: "SYNTHETIC G27 mandatory period", quantity: 3, unitNetCents: 349_000 },
          ],
        },
      });
      let offer = (await view()).offer;
      exact("OFFER_DRAFT_STATUS", offer.status, "DRAFT");
      exact("OFFER_NET_MINOR_UNITS", String(offer.totalNetCents), "2037000");
      await offerCommand("approve", {
        revision: offer.revision,
        contentDigest: offer.contentDigest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await offerCommand("queue_send");
      await new Promise(resolve => setTimeout(resolve, 1500));
      offer = (await view()).offer;
      const receiptAt = new Date(lastCrmServerDate).toISOString();
      await offerCommand("record_sent", {
        revision: offer.revision,
        contentDigest: offer.contentDigest,
        recipientEmail: offer.content.recipientEmail,
        reference: `SYNTHETIC G27 manual QA receipt ${marker}`,
        sentAt: receiptAt,
      });
      offer = (await view()).offer;
      await offerCommand("accept", {
        revision: offer.revision,
        contentDigest: offer.contentDigest,
        reference: `SYNTHETIC G27 acceptance ${marker}`,
      });
      offer = (await view()).offer;
      exact("OFFER_ACCEPTED_STATUS", offer.status, "ACCEPTED");
      exact("OFFER_FIXED_NET_MINOR_UNITS", String(offer.totalNetCents), "2037000");
      const core = resultData(await get("/api/crm/core"));
      exact("ACCEPTED_DEAL_STAGE", core.deals.find(item => item.id === deal.id)?.stage, "Gewonnen");
      track("offers", offer.id);
      return { contact, lead, deal, offer };
    }

    const source = await step("A", "CREATE_AND_ACCEPT_EXACT_EUR_20370_OFFER", acceptedOffer);
    let actionV1;
    let snapshotV1;
    let approvalV1;

    await step("A", "CREATE_V2_ACTION_AND_COMPLETE_20_PERCENT_SNAPSHOT", async () => {
      const input = {
        operation: "create",
        approvalContractVersion: "v2",
        projectId: fixture.projectId,
        offerId: source.offer.id,
        expectedOfferVersion: source.offer.version,
        policySelection: v1Selection,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      };
      actionV1 = resultData(successful(await contract(input), "V2_CREATE"));
      exact("APPROVAL_CONTRACT_VERSION", actionV1.approvalContractVersion, "v2");
      exact("ACTION_VERSION_V1", actionV1.actionVersion, 1);
      exact("ECONOMIC_BASIS", actionV1.economicCommitment.basis, "NET");
      exact("ECONOMIC_NET_MONEY", actionV1.economicCommitment.amount,
        { minorUnits: "2037000", currency: "EUR", minorUnitExponent: 2 });
      truth("ACTION_HASH_V1", /^[a-f0-9]{64}$/.test(actionV1.actionHash));
      truth("SNAPSHOT_HASH_V1", /^[a-f0-9]{64}$/.test(actionV1.financialSnapshotHash));
      snapshotV1 = await getSnapshot(actionV1.financialSnapshotId);
      const financial = snapshotV1.snapshot;
      exact("SNAPSHOT_V1_RESOURCE_TYPE", snapshotV1.resourceType, "CONTRACT");
      exact("SNAPSHOT_V1_REVIEW_STATE", [snapshotV1.reviewState, financial.reviewState], ["VERIFIED", "COMPLETE"]);
      exact("SNAPSHOT_V1_VERSION", snapshotV1.businessVersion, 1);
      exact("SNAPSHOT_V1_HASH_BINDING", snapshotV1.snapshotHash, actionV1.financialSnapshotHash);
      exact("SNAPSHOT_V1_CURRENCY", [financial.currency, financial.minorUnitExponent], ["EUR", 2]);
      exact("SNAPSHOT_V1_TOTALS", financial.totals, {
        net: { minorUnits: "2037000", currency: "EUR", minorUnitExponent: 2 },
        tax: { minorUnits: "407400", currency: "EUR", minorUnitExponent: 2 },
        gross: { minorUnits: "2444400", currency: "EUR", minorUnitExponent: 2 },
      });
      exact("SNAPSHOT_V1_TAX_POLICY_VERSIONS",
        financial.components.flatMap(component => component.taxComponents.map(tax => tax.policy.reference.version)),
        ["1", "1"]);
      exact("SNAPSHOT_V1_TAX_COMPONENT_AMOUNTS",
        financial.components.flatMap(component => component.taxComponents.map(tax => tax.amount.minorUnits)),
        ["198000", "209400"]);
      exact("SNAPSHOT_V1_ROUNDING_POLICY", financial.roundingPolicy.version, "1");
      track("actions", actionV1.actionId);
      track("snapshots", actionV1.financialSnapshotId);
      report.flows.A = { action: {
        actionId: actionV1.actionId,
        actionVersion: actionV1.actionVersion,
        actionHash: actionV1.actionHash,
        financialSnapshotId: actionV1.financialSnapshotId,
        financialSnapshotHash: actionV1.financialSnapshotHash,
        correlationId: actionV1.correlationId,
      }, snapshot: moneyEvidence(snapshotV1) };
    });

    function actionEnvelope(action, operation, extra = {}) {
      return {
        operation,
        approvalContractVersion: "v2",
        projectId: fixture.projectId,
        actionId: action.actionId,
        expectedVersion: action.actionVersion,
        idempotencyKey: randomUUID(),
        correlationId: action.correlationId,
        ...extra,
      };
    }

    async function ownerOverview() {
      return successful(await owner("/api/overview", undefined, "GET"), "OWNER_OVERVIEW");
    }

    async function ownerRecord(action) {
      const overview = await ownerOverview();
      const record = overview.approvals.find(item => item.actionId === action.actionId
        && item.actionVersion === action.actionVersion);
      truth("OWNER_APPROVAL_RECORD_PRESENT", Boolean(record));
      exact("OWNER_TENANT_BINDING", record.tenantId, fixture.workspaceId);
      exact("OWNER_PREVIEW_ENVIRONMENT", record.environment, "preview");
      exact("OWNER_ACTION_HASH_BINDING", record.actionHash, action.actionHash);
      exact("OWNER_CORRELATION_BINDING", record.correlationId, action.correlationId);
      exact("OWNER_SOURCE_SERVICE", record.registration?.serviceId, "crm-preview");
      exact("OWNER_SOURCE_PROJECT", record.registration?.projectId, pins.crmVercelProjectId);
      const remoteFinancialHash = record.financialSnapshotHash
        ?? record.action?.financialSnapshotHash
        ?? record.registration?.financialSnapshotHash;
      exact("OWNER_FINANCIAL_HASH_BINDING", remoteFinancialHash, action.financialSnapshotHash);
      return record;
    }

    async function ownerStep(action, stepNumber) {
      const before = await ownerRecord(action);
      const reauth = successful(await owner("/api/reauth", { password: access.evelyn.ownerPassword }), "OWNER_REAUTH");
      exact("OWNER_REAUTHENTICATED", reauth.reauthenticated, true);
      const challenge = successful(await owner("/api/challenge", {
        approvalId: before.approvalId,
        step: stepNumber,
        requestId: randomUUID(),
      }), "OWNER_CHALLENGE");
      exact("OWNER_CHALLENGE_STEP", challenge.step, stepNumber);
      exact("OWNER_CHALLENGE_ACTION_HASH", challenge.actionHash, action.actionHash);
      exact("OWNER_CHALLENGE_ACTION_VERSION", challenge.actionVersion, action.actionVersion);
      const decision = successful(await owner("/api/decision", {
        approvalId: before.approvalId,
        challengeId: challenge.challengeId,
        decision: "APPROVE",
        requestId: randomUUID(),
      }), "OWNER_DECISION");
      exact(`OWNER_STEP_${stepNumber}_DECISION`, decision[`step${stepNumber}`]?.decision, "APPROVE");
      exact(`OWNER_STEP_${stepNumber}_ACTOR`, decision[`step${stepNumber}`]?.ownerId, access.evelyn.config.ownerId);
      if (stepNumber === 2) {
        truth("OWNER_STEPS_USE_DISTINCT_CHALLENGES", decision.step1.challengeId !== decision.step2.challengeId);
        truth("OWNER_STEPS_USE_DISTINCT_REQUESTS", decision.step1.requestId !== decision.step2.requestId);
      }
      return decision;
    }

    await step("A", "REQUEST_TWO_STEP_APPROVAL_AND_VERIFY_VALID", async () => {
      const requestInput = actionEnvelope(actionV1, "request");
      const requested = resultData(successful(await contract(requestInput), "V2_REQUEST"));
      exact("V2_REQUEST_CONTRACT", requested.contractVersion, "create-approval-request-v2");
      exact("V2_REQUEST_STATUS", requested.status, "PENDING");
      exact("V2_REQUIRED_STEPS", requested.requiredSteps, 2);
      exact("V2_REQUEST_ACTION_HASH", requested.actionHash, actionV1.actionHash);
      exact("V2_REQUEST_FINANCIAL_HASH", requested.financialSnapshotHash, actionV1.financialSnapshotHash);
      const retry = successful(await contract(requestInput), "V2_REQUEST_RETRY");
      exact("V2_REQUEST_REPLAY", retry.replayed, true);
      exact("V2_REQUEST_REPLAY_REFERENCE", resultData(retry).approvalReference, requested.approvalReference);
      approvalV1 = requested.approvalReference;
      track("approvals", approvalV1);
      await ownerRecord(actionV1);
      expectDenied(await contract(actionEnvelope(actionV1, "verify", { approvalReference: approvalV1 })),
        409, "EVELYN_PENDING", "V2_PRE_STEP_VERIFY");
      const firstDecision = await ownerStep(actionV1, 1);
      exact("V2_STEP_ONE_STATUS", firstDecision.status, "STEP_1_APPROVED");
      expectDenied(await contract(actionEnvelope(actionV1, "verify", { approvalReference: approvalV1 })),
        409, "EVELYN_PENDING", "V2_POST_STEP_ONE_VERIFY");
      const secondDecision = await ownerStep(actionV1, 2);
      exact("V2_STEP_TWO_STATUS", secondDecision.status, "APPROVED");
      const verified = successful(await contract(actionEnvelope(actionV1, "verify", { approvalReference: approvalV1 })), "V2_VERIFY");
      exact("V2_VERIFY_STATUS", verified.status, "VALID");
      exact("V2_VERIFY_CONTRACT", verified.contractVersion, "approval-bridge-v2");
      exact("V2_VERIFY_ACTION_VERSION", verified.actionVersion, 1);
      exact("V2_VERIFY_ACTION_HASH", verified.actionHash, actionV1.actionHash);
      exact("V2_VERIFY_FINANCIAL_HASH", verified.financialSnapshotHash, actionV1.financialSnapshotHash);
      report.flows.A.approval = { approvalReference: approvalV1, requiredSteps: 2, finalStatus: verified.status };
    });

    let v2Selection;
    let actionV2;
    let snapshotV2;
    let approvalV2;
    const frozenV1 = stable(snapshotV1);
    const frozenV1Digest = digest(snapshotV1);

    await step("D", "REGISTER_TAX_POLICY_V2_AT_21_PERCENT_WITHOUT_REWRITING_V1", async () => {
      const taxV2Payload = policies.tax("2", "21");
      const taxV2 = await registerPolicy(policies.taxId, "2", taxV2Payload,
        taxV2Payload.sourceProvenance.sourceReference);
      v2Selection = {
        ...v1Selection,
        taxPolicies: [{ componentId: "vat", policy: { id: taxV2.id, version: taxV2.version } }],
      };
      exact("TAX_V2_RATE", taxV2Payload.rate, { basis: "NET", numerator: "21", denominator: "100" });
      const afterPolicyRegistration = await getSnapshot(actionV1.financialSnapshotId);
      exact("V1_SNAPSHOT_UNCHANGED_AFTER_POLICY_REGISTRATION", stable(afterPolicyRegistration), frozenV1);
      exact("V1_SNAPSHOT_EVIDENCE_DIGEST_AFTER_POLICY_REGISTRATION", digest(afterPolicyRegistration), frozenV1Digest);
    });

    await step("B_D", "REVISE_ACTION_TO_POLICY_V2_AND_PRESERVE_OLD_SNAPSHOT", async () => {
      const reviseInput = {
        ...actionEnvelope(actionV1, "revise"),
        policySelection: v2Selection,
      };
      actionV2 = resultData(successful(await contract(reviseInput), "V2_REVISE"));
      exact("REVISED_ACTION_VERSION", actionV2.actionVersion, 2);
      truth("REVISED_ACTION_HASH_CHANGED", actionV2.actionHash !== actionV1.actionHash);
      truth("REVISED_FINANCIAL_HASH_CHANGED", actionV2.financialSnapshotHash !== actionV1.financialSnapshotHash);
      exact("REVISED_APPROVAL_REFERENCE_RESET", actionV2.approvalReference, null);
      snapshotV2 = await getSnapshot(actionV2.financialSnapshotId);
      exact("SNAPSHOT_V2_SUPERSEDES_V1", snapshotV2.supersedesSnapshotId, snapshotV1.id);
      exact("SNAPSHOT_V2_VERSION", snapshotV2.businessVersion, 2);
      exact("SNAPSHOT_V2_TOTALS", snapshotV2.snapshot.totals, {
        net: { minorUnits: "2037000", currency: "EUR", minorUnitExponent: 2 },
        tax: { minorUnits: "427770", currency: "EUR", minorUnitExponent: 2 },
        gross: { minorUnits: "2464770", currency: "EUR", minorUnitExponent: 2 },
      });
      exact("SNAPSHOT_V2_TAX_POLICY_VERSIONS",
        snapshotV2.snapshot.components.flatMap(component => component.taxComponents.map(tax => tax.policy.reference.version)),
        ["2", "2"]);
      exact("SNAPSHOT_V2_TAX_COMPONENT_AMOUNTS",
        snapshotV2.snapshot.components.flatMap(component => component.taxComponents.map(tax => tax.amount.minorUnits)),
        ["207900", "219870"]);
      exact("V1_SNAPSHOT_UNCHANGED_AFTER_REVISION", stable(await getSnapshot(snapshotV1.id)), frozenV1);
      track("snapshots", snapshotV2.id);
      report.flows.D = {
        policyV1: { id: policies.taxId, version: "1", numerator: "20", denominator: "100" },
        policyV2: { id: policies.taxId, version: "2", numerator: "21", denominator: "100" },
        oldSnapshot: moneyEvidence(snapshotV1),
        revisedSnapshot: moneyEvidence(snapshotV2),
        oldSnapshotEvidenceDigest: frozenV1Digest,
      };
    });

    await step("B", "NEW_REQUEST_INVALIDATES_OLD_APPROVAL_AND_V2_BECOMES_VALID", async () => {
      const requestV2 = resultData(successful(await contract(actionEnvelope(actionV2, "request")), "V2_REVISION_REQUEST"));
      approvalV2 = requestV2.approvalReference;
      track("approvals", approvalV2);
      exact("REVISION_REQUEST_STATUS", requestV2.status, "PENDING");
      exact("REVISION_REQUIRED_STEPS", requestV2.requiredSteps, 2);
      truth("REVISION_HAS_NEW_APPROVAL", approvalV2 !== approvalV1);
      const overview = await ownerOverview();
      exact("OLD_APPROVAL_INVALIDATED",
        overview.approvals.find(item => item.approvalId === approvalV1)?.status, "INVALIDATED");
      expectDenied(await contract(actionEnvelope(actionV1, "verify", { approvalReference: approvalV1 })),
        409, "VERSION_MISMATCH", "STALE_VERSION_OLD_APPROVAL");
      expectDenied(await contract(actionEnvelope(actionV2, "execute", { approvalReference: approvalV1 })),
        409, "APPROVAL_REFERENCE_MISMATCH", "CURRENT_VERSION_OLD_APPROVAL");
      expectDenied(await contract(actionEnvelope(actionV2, "verify", { approvalReference: approvalV2 })),
        409, "EVELYN_PENDING", "NEW_APPROVAL_PENDING");
      await ownerStep(actionV2, 1);
      await ownerStep(actionV2, 2);
      const verified = successful(await contract(actionEnvelope(actionV2, "verify", { approvalReference: approvalV2 })), "V2_REVISION_VERIFY");
      exact("REVISED_VERIFY_STATUS", verified.status, "VALID");
      exact("REVISED_VERIFY_ACTION_VERSION", verified.actionVersion, 2);
      exact("REVISED_VERIFY_ACTION_HASH", verified.actionHash, actionV2.actionHash);
      exact("REVISED_VERIFY_FINANCIAL_HASH", verified.financialSnapshotHash, actionV2.financialSnapshotHash);
      exact("V1_SNAPSHOT_FINAL_IMMUTABILITY", stable(await getSnapshot(snapshotV1.id)), frozenV1);
      report.flows.B = {
        oldApprovalReference: approvalV1,
        oldApprovalStatus: "INVALIDATED",
        staleVersionCode: "VERSION_MISMATCH",
        currentVersionOldReferenceCode: "APPROVAL_REFERENCE_MISMATCH",
        newApprovalReference: approvalV2,
        newApprovalStatus: verified.status,
        revisedAction: {
          actionId: actionV2.actionId,
          actionVersion: actionV2.actionVersion,
          actionHash: actionV2.actionHash,
          financialSnapshotId: actionV2.financialSnapshotId,
          financialSnapshotHash: actionV2.financialSnapshotHash,
        },
      };
    });

    await step("C", "PROPERTY_SALE_350K_REMAINS_FIXED_AFTER_CURRENT_PRICE_360K", async () => {
      const buyer = (await api("/api/crm/contacts", { contact: {
        name: `SYNTHETIC G27 Property Buyer ${marker}`,
        email: `g27-property-${marker}@example.invalid`,
        role: "Käufer",
        source: "Manual",
        consent: "Opt-in",
        projectId: fixture.projectId,
      } })).contact;
      track("contacts", buyer.id);
      const lead = (await api("/api/crm/leads", { lead: {
        contactId: buyer.id,
        projectId: fixture.projectId,
        type: "Käufer",
        source: "Manual",
        intent: "SYNTHETIC G27 property inquiry",
      } })).lead;
      track("leads", lead.id);
      const unit = resultData(await api("/api/crm/units", {
        projectId: fixture.projectId,
        unitNumber: `SYN-G27-${marker}`,
        floor: 1,
        rooms: 3,
        areaSqm: 80,
        status: "available",
        priceCents: 0,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      }));
      track("units", unit.id);
      const state = async () => resultData(await get(`/api/crm/property-sales?projectId=${encodeURIComponent(fixture.projectId)}`));
      async function sales(action, payload, expectedVersion) {
        const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
        return resultData(await api("/api/crm/property-sales", {
          action,
          projectId: fixture.projectId,
          payload,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          ...metadata,
        }, "POST", metadata));
      }
      const initial = await state();
      const authority = initial.authorities.find(item => item.user_id === fixture.userId);
      await sales("authority.assign", {
        userId: fixture.userId,
        developerOrganizationId: fixture.developerId,
        contactId: fixture.developerContactId,
        canConfirmPrice: true,
        canConfirmReservation: true,
        canConfirmSale: true,
        sourceReference: `SYNTHETIC G27 project mandate ${marker}`,
      }, authority ? Number(authority.version) : undefined);
      await sales("unit.price.confirm", {
        unitId: unit.id,
        priceCents: 35_000_000,
        sourceReference: `SYNTHETIC G27 sale price 35000000 ${marker}`,
      }, Number(unit.version));
      const qualified = await sales("qualification.save", {
        leadId: lead.id,
        desiredUnitId: unit.id,
        budgetFrom: 300_000,
        budgetTo: 400_000,
        financingStatus: "vorqualifiziert",
        purchaseTimeline: "Within six months",
        useCase: "Eigennutzung",
        priority: "high",
        sourceReference: `SYNTHETIC G27 buyer interview ${marker}`,
      }, Number(lead.version));
      await sales("handover.create", {
        leadId: lead.id,
        recipientUserId: fixture.userId,
        sourceReference: `SYNTHETIC G27 handover ${marker}`,
      }, Number(qualified.record.version));
      const visit = {
        unitId: unit.id,
        leadId: lead.id,
        ownerUserId: fixture.userId,
        startsAt: "2030-01-01T10:00:00Z",
        endsAt: "2030-01-01T11:00:00Z",
        timeZone: "Europe/Vienna",
      };
      const viewing = (await sales("viewing.save", { ...visit, status: "planned" })).record;
      const confirmed = (await sales("viewing.save", { ...visit, viewingId: viewing.id, status: "confirmed" }, Number(viewing.version))).record;
      await sales("viewing.save", { ...visit, viewingId: viewing.id, status: "completed" }, Number(confirmed.version));
      let currentUnit = (await state()).units.find(item => item.id === unit.id);
      const reservation = (await sales("reservation.request", {
        unitId: unit.id,
        leadId: lead.id,
        expiresAt: "2030-02-01T12:00:00Z",
      }, Number(currentUnit.version))).record;
      track("reservations", reservation.id);
      const reserved = (await sales("reservation.confirm", {
        reservationId: reservation.id,
        unitVersion: Number(currentUnit.version),
        sourceReference: `SYNTHETIC G27 reservation ${marker}`,
      }, Number(reservation.version))).record;
      currentUnit = (await state()).units.find(item => item.id === unit.id);
      const saleResult = await sales("sale.confirm", {
        reservationId: reservation.id,
        unitVersion: Number(currentUnit.version),
        sourceReference: `SYNTHETIC G27 sale ${marker}`,
      }, Number(reserved.version));
      const sale = saleResult.record;
      track("sales", sale.id);
      const soldState = await state();
      currentUnit = soldState.units.find(item => item.id === unit.id);
      exact("PROPERTY_SOLD_STATUS", currentUnit.status, "sold");
      exact("PROPERTY_SALE_TIME_CURRENT_PRICE", String(currentUnit.price_cents), "35000000");
      const review = await get(`/api/crm/financial-snapshots?projectId=${encodeURIComponent(fixture.projectId)}`);
      const prior = review.snapshots.find(item => item.resourceType === "PROPERTY_SALE" && item.resourceId === sale.id);
      truth("PROPERTY_SALE_REVIEW_SNAPSHOT_PRESENT", Boolean(prior));
      exact("PROPERTY_SALE_PRIOR_STATE", [prior.reviewState, prior.snapshot.reviewState], ["NEEDS_REVIEW", "NEEDS_REVIEW"]);
      const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const resolved = resultData(await api("/api/crm/financial-snapshots", {
        projectId: fixture.projectId,
        priorSnapshotId: prior.id,
        expectedPriorSnapshotHash: prior.snapshotHash,
        policySelection: v1Selection,
        reviewDecision: "VERIFY_EVIDENCED_NET",
        ...metadata,
      }, "POST", metadata));
      exact("PROPERTY_SALE_RESOLVED_STATE", [resolved.reviewState, resolved.snapshot.reviewState], ["VERIFIED", "COMPLETE"]);
      exact("PROPERTY_SALE_RESOLVED_PREDECESSOR", resolved.supersedesSnapshotId, prior.id);
      exact("PROPERTY_SALE_HISTORICAL_NET", resolved.snapshot.totals.net,
        { minorUnits: "35000000", currency: "EUR", minorUnitExponent: 2 });
      const frozenHistorical = stable(resolved);
      const frozenHistoricalDigest = digest(resolved);
      await sales("unit.price.confirm", {
        unitId: unit.id,
        priceCents: 36_000_000,
        sourceReference: `SYNTHETIC G27 current price 36000000 after sale ${marker}`,
      }, Number(currentUnit.version));
      const changedState = await state();
      const changedUnit = changedState.units.find(item => item.id === unit.id);
      exact("PROPERTY_CURRENT_PRICE_AFTER_CHANGE", String(changedUnit.price_cents), "36000000");
      const historicalAfter = await getSnapshot(resolved.id);
      exact("PROPERTY_HISTORICAL_SNAPSHOT_UNCHANGED", stable(historicalAfter), frozenHistorical);
      exact("PROPERTY_HISTORICAL_DIGEST_UNCHANGED", digest(historicalAfter), frozenHistoricalDigest);
      exact("PROPERTY_HISTORICAL_NET_AFTER_CURRENT_CHANGE", historicalAfter.snapshot.totals.net.minorUnits, "35000000");
      track("snapshots", prior.id);
      track("snapshots", resolved.id);
      report.flows.C = {
        unitId: unit.id,
        saleId: sale.id,
        priorSnapshotId: prior.id,
        historicalSnapshot: moneyEvidence(resolved),
        historicalEvidenceDigest: frozenHistoricalDigest,
        saleTimeNetMinorUnits: "35000000",
        currentUnitPriceMinorUnits: "36000000",
      };
    });

    await step("E", "LEGACY_V1_REJECTED_BY_V2_WITH_AUDIT_AND_NO_EXECUTION", async () => {
      const seeded = preseed.legacyContract;
      // Read only the explicitly pinned disposable CRM database. PostgreSQL
      // enforces READ ONLY; application writes are exercised through HTTP.
      const evidence = async () => {
        const uri = new URL(inputs.fixtureDocument.runtimeURL);
        ensure(uri.hostname === "ep-soft-thunder-awqgz3t0.c-12.us-east-1.aws.neon.tech"
          && uri.pathname === "/qa_g27_20260923" && uri.username === "g27_qa_20260923"
          && inputs.fixtureDocument.target.branch === "br-summer-breeze-awuzinct",
        "QA_DATABASE_ISOLATION_NOT_PROVEN");
        uri.searchParams.set("sslmode", "verify-full");
        const db = new pg.Client({ connectionString: uri.toString(), connectionTimeoutMillis: 15000,
          query_timeout: 15000 });
        try {
          await db.connect();
          await db.query("begin isolation level repeatable read read only");
          await db.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",
            [fixture.workspaceId, fixture.userId]);
          const params = [fixture.workspaceId, seeded.actionId];
          const revisions = (await db.query(`select version,action,action_hash,approval_contract_version,
            financial_snapshot_id from crm_evelyn_contract_revisions
            where workspace_id=$1 and action_id=$2 order by version`, params)).rows;
          exact("LEGACY_V1_STORED_REVISION", revisions.map(row => ({ version: row.version,
            contract: row.approval_contract_version, snapshot: row.financial_snapshot_id })),
          [{ version: seeded.actionVersion, contract: "v1", snapshot: null }]);
          const counts = {};
          for (const table of ["crm_evelyn_contract_approvals", "crm_evelyn_contract_executions"]) {
            counts[table] = (await db.query(`select count(*)::int n from ${table}
              where workspace_id=$1 and action_id=$2`, params)).rows[0].n;
          }
          const events = (await db.query(`select id,stage,result_code,correlation_id,recorded_by
            from crm_evelyn_contract_events where workspace_id=$1 and action_id=$2 order by id`, params)).rows;
          await db.query("commit");
          return { revisionDigest: digest(revisions), counts, events };
        } finally { await db.end(); }
      };
      const databaseBefore = await evidence();
      const before = await ownerOverview();
      exact("SEEDED_ACTION_ABSENT_FROM_EVELYN_BEFORE",
        before.approvals.filter(item => item.actionId === seeded.actionId).length, 0);
      const codes = {};
      for (const operation of ["request", "verify", "execute"]) {
        const input = {
          operation,
          approvalContractVersion: "v2",
          projectId: seeded.projectId,
          actionId: seeded.actionId,
          expectedVersion: seeded.actionVersion,
          ...(operation === "request" ? {} : { approvalReference: randomUUID() }),
          idempotencyKey: randomUUID(),
          correlationId: seeded.correlationId,
        };
        const denied = expectDenied(await contract(input), 409, "EVELYN_CONTRACT_VERSION_MISMATCH",
          `LEGACY_V1_${operation.toUpperCase()}`);
        codes[operation] = denied.code;
      }
      const after = await ownerOverview();
      exact("SEEDED_ACTION_ABSENT_FROM_EVELYN_AFTER",
        after.approvals.filter(item => item.actionId === seeded.actionId).length, 0);
      const databaseAfter = await evidence();
      exact("LEGACY_REVISION_UNCHANGED", databaseAfter.revisionDigest, databaseBefore.revisionDigest);
      const noEffects = { crm_evelyn_contract_approvals: 0, crm_evelyn_contract_executions: 0 };
      exact("LEGACY_EFFECTS_BEFORE", databaseBefore.counts, noEffects);
      exact("LEGACY_EFFECTS_AFTER", databaseAfter.counts, noEffects);
      const existingIds = new Set(databaseBefore.events.map(event => event.id));
      const newEvents = databaseAfter.events.filter(event => !existingIds.has(event.id));
      exact("LEGACY_DURABLE_REJECTION_AUDIT", newEvents.map(event => ({ stage: event.stage,
        result_code: event.result_code, correlation_id: event.correlation_id, recorded_by: event.recorded_by }))
        .sort((a, b) => a.stage.localeCompare(b.stage)),
      ["EXECUTE", "REQUEST", "VERIFY"].map(stage => ({ stage,
        result_code: "EVELYN_CONTRACT_VERSION_MISMATCH", correlation_id: seeded.correlationId,
        recorded_by: fixture.userId })));
      report.flows.E = {
        actionId: seeded.actionId,
        actionVersion: seeded.actionVersion,
        contractVersion: "v1",
        revisionDigest: databaseAfter.revisionDigest,
        auditEventIds: newEvents.map(event => event.id),
        sideEffects: databaseAfter.counts,
        deniedCodes: codes,
        evelynApprovalCountBefore: 0,
        evelynApprovalCountAfter: 0,
      };
    });

    await step("F", "CROSS_TENANT_FINANCIAL_READ_AND_WRITE_ARE_DENIED", async () => {
      const foreign = preseed.foreignTenant;
      const read = await crmCall(`/api/crm/financial-snapshots?snapshotId=${encodeURIComponent(foreign.snapshotId)}`,
        undefined, "GET");
      expectDenied(read, 404, "FINANCIAL_SNAPSHOT_NOT_ACCESSIBLE", "FOREIGN_SNAPSHOT_READ");
      const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const write = await crmCall("/api/crm/financial-snapshots", {
        projectId: fixture.projectId,
        priorSnapshotId: foreign.snapshotId,
        expectedPriorSnapshotHash: foreign.snapshotHash,
        policySelection: v1Selection,
        reviewDecision: "VERIFY_EVIDENCED_NET",
        ...metadata,
      }, "POST", metadata);
      expectDenied(write, 404, "FINANCIAL_SNAPSHOT_NOT_ACCESSIBLE", "FOREIGN_SNAPSHOT_WRITE");
      report.flows.F = {
        foreignSnapshotId: foreign.snapshotId,
        read: { status: read.status, code: read.body.code ?? read.body.error },
        write: { status: write.status, code: write.body.code ?? write.body.error },
        tenantId: fixture.workspaceId,
      };
    });

    await step("RACE", "PARALLEL_EXECUTION_AND_REPLAY_HAVE_ONE_SYNTHETIC_EFFECT", async () => {
      const input = actionEnvelope(actionV2, "execute", { approvalReference: approvalV2 });
      const responses = await Promise.all([contract(input), contract(input)]);
      const outcomes = responses.map((response, index) => successful(response, `EXECUTION_RACE_${index}`));
      const effects = outcomes.map(resultData);
      exact("RACE_IDENTICAL_EFFECT_IDS", effects[0].id, effects[1].id);
      exact("RACE_EXACTLY_ONE_REPLAY", outcomes.filter(result => result.replayed === true).length, 1);
      for (const effect of effects) {
        exact("RACE_SYNTHETIC_EFFECT", effect.effect, "SYNTHETIC_CONTRACT_SEND");
        exact("RACE_NO_EXTERNAL_EFFECT", effect.externalEffect, false);
        exact("RACE_NO_CONTRACT_DELIVERY", effect.contractDelivered, false);
      }
      const replay = successful(await contract(input), "EXECUTION_REPLAY");
      exact("EXECUTION_REPLAY_RECEIPT", replay.replayed, true);
      exact("EXECUTION_REPLAY_SAME_EFFECT", resultData(replay).id, effects[0].id);
      const uri = new URL(inputs.fixtureDocument.runtimeURL);
      ensure(uri.hostname === "ep-soft-thunder-awqgz3t0.c-12.us-east-1.aws.neon.tech"
        && uri.pathname === "/qa_g27_20260923" && uri.username === "g27_qa_20260923"
        && inputs.fixtureDocument.target.branch === "br-summer-breeze-awuzinct",
      "QA_DATABASE_ISOLATION_NOT_PROVEN");
      uri.searchParams.set("sslmode", "verify-full");
      const db = new pg.Client({ connectionString: uri.toString(), connectionTimeoutMillis: 15000,
        query_timeout: 15000 });
      try {
        await db.connect();
        await db.query("begin isolation level repeatable read read only");
        await db.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",
          [fixture.workspaceId, fixture.userId]);
        const rows = (await db.query(`select id,version,approval_reference from crm_evelyn_contract_executions
          where workspace_id=$1 and action_id=$2`, [fixture.workspaceId, actionV2.actionId])).rows;
        exact("RACE_ONE_PERSISTED_EXECUTION", rows,
          [{ id: effects[0].id, version: actionV2.actionVersion, approval_reference: approvalV2 }]);
        await db.query("commit");
      } finally { await db.end(); }
      report.flows.RACE = { actionId: actionV2.actionId, actionVersion: actionV2.actionVersion,
        effectId: effects[0].id, concurrentRequests: 2, replayed: true, persistedExecutions: 1,
        externalEffect: false, contractDelivered: false };
    });

    await step("FINAL", "NO_UNCAUGHT_BROWSER_ERRORS_AND_EXACT_TARGETS", async () => {
      exact("UNCAUGHT_BROWSER_ERROR_COUNT", pageErrors, 0);
      exact("REPORT_ENVIRONMENT", report.environment, "preview");
      exact("SYNTHETIC_ONLY", report.syntheticOnly, true);
      exact("PRODUCTION_MUTATION", report.productionMutation, false);
      exact("EXTERNAL_CONTRACT_DELIVERY", report.externalContractDelivery, false);
      truth("ALL_REQUIRED_FLOWS_RECORDED", ["A", "B", "C", "D", "E", "F", "RACE"].every(key => report.flows[key]));
    });
    await verifyCrmBrowserBinding(access.crm);
    report.status = "PASS";
  } catch (error) {
    report.status = "BLOCKED";
    report.errorCode = /^[A-Z][A-Z0-9_]{1,160}$/.test(error?.message ?? "") ? error.message : "RUNNER_RUNTIME_ERROR";
    report.failedStep = { flow: activeFlow, name: active };
    console.error("BLOCKED G27 live Preview step; sanitized evidence saved. No raw error or credentials logged.");
    process.exitCode = 1;
  } finally {
    if (ownerContext && ownerCookie && ownerCsrf) {
      try {
        await owner("/api/logout", {});
      } catch {
        report.ownerLogout = "UNVERIFIED";
      }
    }
    await ownerContext?.dispose();
    await context?.close();
    await browser?.close();
    report.finishedAt = new Date().toISOString();
    await save();
  }
}

export function cleanupTarget(raw, prior, preseed) {
  const target = object(raw, "CLEANUP_TARGET_REQUIRED");
  ensure(target.provider === "neon" && ["crm", "evelyn"].includes(target.system), "CLEANUP_PROVIDER_DENIED");
  ensure(target.environment === "preview" && target.disposable === true, "DISPOSABLE_PREVIEW_CLEANUP_REQUIRED");
  const allowedBranch = target.system === "crm"
    ? { name: "g27-qa-crm-20260923", id: "br-summer-breeze-awuzinct" }
    : { name: "evelyn-g27-qa-20260924", id: "br-young-water-awa2ri4k" };
  ensure(target.branchName === allowedBranch.name && target.branchId === allowedBranch.id
    && target.projectId === "super-block-59791927",
    "G27_QA_BRANCH_NAME_REQUIRED");
  const schemaOnly = target.system === "evelyn" && target.parentBranchId === null
    && target.parentBranchName === null && target.schemaSourceBranchId === "br-dry-thunder-awmimouk"
    && target.schemaSourceBranchName === "main";
  ensure(/^br-[A-Za-z0-9-]+$/.test(target.branchId ?? "")
    && (schemaOnly || (/^br-[A-Za-z0-9-]+$/.test(target.parentBranchId ?? "")
    && target.parentBranchId !== target.branchId)), "NEON_BRANCH_ID_REQUIRED");
  ensure(/^[A-Za-z0-9-]{3,100}$/.test(target.projectId ?? ""), "NEON_PROJECT_ID_REQUIRED");
  ensure(schemaOnly || (typeof target.parentBranchName === "string" && target.parentBranchName.length > 0
    && !/^g27-qa-/i.test(target.parentBranchName)), "NEON_PARENT_BRANCH_REQUIRED");
  ensure(typeof target.createdAt === "string" && !Number.isNaN(Date.parse(target.createdAt)),
    "NEON_BRANCH_CREATED_AT_REQUIRED");
  const prefix = target.system === "crm" ? "crm" : "evelyn";
  const expected = {
    projectId: preseed.database[`${prefix}ProjectId`],
    branchId: preseed.database[`${prefix}BranchId`],
    parentBranchId: preseed.database[`${prefix}ParentBranchId`],
  };
  ensure(target.projectId === expected.projectId && target.branchId === expected.branchId
    && target.parentBranchId === expected.parentBranchId, "CLEANUP_DATABASE_BINDING_FAILED");
  const priorTarget = prior.cleanup?.targets?.find(item => item.system === target.system);
  const publicTarget = {
    system: target.system,
    provider: target.provider,
    projectId: target.projectId,
    branchId: target.branchId,
    branchName: target.branchName,
    parentBranchId: target.parentBranchId,
    parentBranchName: target.parentBranchName,
    schemaSourceBranchId: target.schemaSourceBranchId ?? null,
    schemaSourceBranchName: target.schemaSourceBranchName ?? null,
    createdAt: target.createdAt,
  };
  ensure(stable(priorTarget) === stable(publicTarget), "CLEANUP_REPORT_TARGET_MISMATCH");
  const expectedSecret = target.system === "crm" ? "G27_CRM_NEON_API_KEY" : "G27_EVELYN_NEON_API_KEY"; // gitleaks:allow -- environment variable names, not credentials
  const expectedProject = target.system === "crm" ? "G27_CRM_NEON_PROJECT_ID" : "G27_EVELYN_NEON_PROJECT_ID";
  ensure(target.apiKeyEnv === expectedSecret, "FIXED_CLEANUP_SECRET_ENV_REQUIRED");
  ensure(process.env[expectedProject] === target.projectId, "FIXED_NEON_PROJECT_ALLOWLIST_REQUIRED");
  ensure(typeof process.env[expectedSecret] === "string" && process.env[expectedSecret].length > 0,
    "CLEANUP_API_KEY_REQUIRED");
  return { ...target, schemaOnly, apiKey: process.env[expectedSecret] };
}
async function cleanupMain() {
  ensure(argv.has("--cleanup") && argv.has("--run-authorized-preview-cleanup")
    && !argv.has("--run-authorized-live"), "EXPLICIT_PREVIEW_CLEANUP_FLAG_REQUIRED");
  const prior = object(JSON.parse(await readFile(REPORT_PATH, "utf8")), "LIVE_REPORT_REQUIRED");
  ensure(prior.environment === "preview" && prior.syntheticOnly === true && prior.productionMutation === false,
    "PREVIEW_REPORT_BINDING_REQUIRED");
  ensure(prior.status === "PASS" && ["A", "B", "C", "D", "E", "F", "RACE"].every(key => prior.flows?.[key]),
    "JOINT_ACCEPTANCE_REQUIRED_BEFORE_BRANCH_CLEANUP");
  const { fixtureDocument, preseed } = await loadInputs();
  ensure(fixtureDocument.target?.branch === preseed.database.crmBranchId,
    "CLEANUP_FIXTURE_DATABASE_BINDING_REQUIRED");
  ensure(prior.targets?.tenantId === preseed.workspaceId && prior.targets?.projectId === preseed.projectId,
    "CLEANUP_TENANT_REPORT_BINDING_REQUIRED");
  const targets = preseed.cleanup?.targets;
  ensure(Array.isArray(targets) && targets.length === 2
    && targets.length === prior.cleanup?.targets?.length, "CLEANUP_TARGETS_REQUIRED");
  ensure(new Set(targets.map(target => target.system)).size === targets.length, "DUPLICATE_CLEANUP_TARGET_DENIED");
  const cleanup = {
    cleanupContractVersion: "g27-preview-cleanup-report-v1",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "RUNNING",
    sourceReportDigest: digest(prior),
    targets: [],
  };
  const save = () => writePrivateJson(CLEANUP_REPORT_PATH, cleanup);
  try {
    for (const raw of targets) {
      const target = cleanupTarget(raw, prior, preseed);
      const base = "https://console.neon.tech/api/v2";
      const url = `${base}/projects/${encodeURIComponent(target.projectId)}/branches/${encodeURIComponent(target.branchId)}`;
      const headers = { authorization: `Bearer ${target.apiKey}`, accept: "application/json" };
      const inspect = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
      ensure(inspect.status === 200, "CLEANUP_BRANCH_INSPECTION_FAILED");
      const payload = await inspect.json();
      const branch = payload.branch ?? payload;
      ensure(branch.id === target.branchId && branch.name === target.branchName
        && (branch.parent_id ?? null) === target.parentBranchId && branch.created_at === target.createdAt,
      "CLEANUP_BRANCH_BINDING_FAILED");
      ensure(branch.protected === false && branch.primary !== true && branch.default !== true,
        "PROTECTED_DATABASE_BRANCH_DENIED");
      const sourceId = target.schemaOnly ? target.schemaSourceBranchId : target.parentBranchId;
      const sourceName = target.schemaOnly ? target.schemaSourceBranchName : target.parentBranchName;
      const parentUrl = `${base}/projects/${encodeURIComponent(target.projectId)}/branches/${encodeURIComponent(sourceId)}`;
      const parentResponse = await fetch(parentUrl, {
        method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      ensure(parentResponse.status === 200, "CLEANUP_PARENT_BRANCH_INSPECTION_FAILED");
      const parentPayload = await parentResponse.json();
      const parent = parentPayload.branch ?? parentPayload;
      ensure(parent.id === sourceId && parent.name === sourceName,
        "CLEANUP_PARENT_BRANCH_BINDING_FAILED");
      const response = await fetch(url, {
        method: "DELETE",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      ensure([200, 202, 204, 404].includes(response.status), "CLEANUP_BRANCH_DELETE_FAILED");
      const absent = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
      ensure(absent.status === 404, "CLEANUP_BRANCH_ABSENCE_NOT_CONFIRMED");
      cleanup.targets.push({ system: target.system, provider: target.provider, projectId: target.projectId,
        branchId: target.branchId, branchName: target.branchName, httpStatus: response.status,
        confirmationStatus: absent.status, status: "ABSENCE_CONFIRMED" });
      await save();
      console.log(`PASS ${target.system.toUpperCase()} disposable Preview branch cleanup`);
    }
    cleanup.status = "PASS";
  } catch {
    cleanup.status = "BLOCKED";
    console.error("BLOCKED G27 Preview cleanup; sanitized cleanup evidence saved. No token or response body logged.");
    process.exitCode = 1;
  } finally {
    cleanup.finishedAt = new Date().toISOString();
    await save();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (argv.has("--cleanup")) {
    await cleanupMain().catch(() => {
      console.error("CLEANUP_PRECONDITION_FAILED; inspect private configuration without logging secrets.");
      process.exitCode = 1;
    });
  } else {
    await liveMain().catch(() => {
      console.error("LIVE_RUNNER_PRECONDITION_FAILED; inspect private configuration without logging secrets.");
      process.exitCode = 1;
    });
  }
}
