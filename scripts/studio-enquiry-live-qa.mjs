#!/usr/bin/env node
// Prepared only. Execution requires the private, exact-target QA configuration below.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import pg from "pg";
import { getCACertificates } from "node:tls";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { normalQaLogin, fixtureTarget, assertPrivateQaPath } from "./studio-stage3-login-fixture.mjs";
import { buildStudioEnquirySignature, parseStudioEnquiryRequest } from "../src/lib/studio-enquiry-contract.ts";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectId = "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
const branch = "codex/studio-preview-crm-handoff";
const workspaceId = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const actorId = "6122a6da-e7f4-47fa-bc55-e296bb01af62";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = value => createHash("sha256").update(value).digest("hex");
const check = (ok, code) => { if (!ok) throw new Error(code); };

export function validateLiveQaConfig(config) {
  check(config && typeof config === "object" && /^GOLIVETEST_[A-Za-z0-9_-]{6,80}$/.test(config.runId), "invalid_config");
  const c = config.crm, q = config.qa;
  check(c?.projectId === projectId && c.branch === branch && /^dpl_[A-Za-z0-9]+$/.test(c.deploymentId) &&
    /^[a-f0-9]{40}$/.test(c.gitSha) && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(c.origin), "invalid_crm_target");
  check(typeof config.approvalId === "string" && config.approvalId.trim() &&
    typeof config.signingSecret === "string" && Buffer.byteLength(config.signingSecret) >= 32, "missing_qa_authority");
  check(typeof config.protectionTokenFile === "string" && path.isAbsolute(config.protectionTokenFile), "existing_protection_token_file_required");
  check(typeof config.qaEmail === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.qaEmail), "missing_qa_contact");
  let database;
  try { database = new URL(q?.databaseUrl); } catch { throw new Error("invalid_qa_database"); }
  check(/^postgres(?:ql)?:$/.test(database.protocol) && database.hostname === q.host && q.host !== q.productionHost &&
    typeof q.productionHost === "string" && q.productionHost.length > 0 &&
    /^[a-z0-9-]+-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(q.host) &&
    decodeURIComponent(database.pathname.slice(1)) === q.databaseName && decodeURIComponent(database.username) === q.role &&
    q.projectId === fixtureTarget.projectId && q.branchId === fixtureTarget.branchId &&
    q.databaseName === fixtureTarget.databaseName && q.role === "novalure_app" &&
    (!database.port || database.port === '5432') && database.searchParams.get('sslmode') === 'verify-full' &&
    [...database.searchParams.keys()].every(key=>['sslmode','channel_binding'].includes(key)) &&
    (!database.searchParams.has('channel_binding') || database.searchParams.get('channel_binding') === 'require'), "invalid_qa_database");
  return config;
}
export function liveQaDatabaseOptions(config) {
  validateLiveQaConfig(config);
  check(!process.env.PGOPTIONS && !process.env.PGREPLICATION, "ambient_pg_startup_options_forbidden");
  const uri=new URL(config.qa.databaseUrl);
  // Do not pass connectionString or free URI options to pg's compatibility parser.
  return {host:uri.hostname,port:5432,user:decodeURIComponent(uri.username),password:decodeURIComponent(uri.password),
    database:decodeURIComponent(uri.pathname.slice(1)),ssl:{rejectUnauthorized:true,
      ca:getCACertificates('default').concat(getCACertificates('system')).join('\n')},enableChannelBinding:true,
    max:2,connectionTimeoutMillis:10000,query_timeout:20000};
}
export function parseCurlResponse(bytes) {
  let offset = 0, status = 0, headers = new Map();
  for (;;) {
    const end = bytes.indexOf(Buffer.from("\r\n\r\n"), offset);
    check(end >= 0, "invalid_http_response");
    const text = bytes.subarray(offset, end).toString("latin1"), lines = text.split("\r\n");
    const match = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/.exec(lines.shift() || "");
    check(match, "invalid_http_response"); status = Number(match[1]); headers = new Map();
    for (const line of lines) {
      const colon = line.indexOf(":"); if (colon < 1) continue;
      const key = line.slice(0, colon).toLowerCase(), values = headers.get(key) || [];
      values.push(line.slice(colon + 1).trim()); headers.set(key, values);
    }
    offset = end + 4;
    if (status < 200 || bytes.subarray(offset, offset + 5).toString() === "HTTP/") continue;
    return { status, headers, body: bytes.subarray(offset) };
  }
}
export function validateQaPut(target, snapshot, operationId) {
  const source = snapshot.files.find(file => file.id === target.sourceId);
  check(source && ["original", "analysis"].includes(target.variant), "unexpected_copy_source");
  const material = target.variant === "original" ? source.original : source;
  const extension = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[material.mime];
  check(target.sha256 === material.sha256 && uuid.test(target.assetId) && extension &&
    target.pathname === `${workspaceId}/studio-enquiries/${operationId}/${target.assetId}${extension}`, "unexpected_copy_target");
  if (target.status === "copied") return material;
  check(target.status === "upload_required" && target.put && typeof target.put.url === "string", "missing_copy_grant");
  const u = new URL(target.put.url);
  check(u.protocol === "https:" && u.hostname === "vercel.com" && !u.port && !u.username && !u.password &&
    !u.hash && u.pathname === "/api/blob/" && u.searchParams.getAll("pathname").length === 1 && u.searchParams.get("pathname") === target.pathname, "unexpected_copy_endpoint");
  const allowed = new Set(["content-type", "x-content-type", "x-content-length", "x-vercel-blob-access", "x-vercel-blob-store-id", "x-api-version"]);
  const h = {};
  for (const [key, value] of Object.entries(target.put.headers || {})) {
    const lower = key.toLowerCase(); check(allowed.has(lower) && !(lower in h) && typeof value === "string" && !/[\r\n]/.test(value), "unexpected_copy_header"); h[lower] = value;
  }
  check(Object.keys(h).length === 6 && h["content-type"] === material.mime && h["x-content-type"] === material.mime &&
    h["x-content-length"] === String(material.bytes) && h["x-vercel-blob-access"] === "private" &&
    /^[A-Za-z0-9]+$/.test(h["x-vercel-blob-store-id"]) && h["x-api-version"] === "13", "copy_constraint_mismatch");
  return material;
}
function executeCli(cli, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, ...args], { cwd: repository, windowsHide: true, encoding: "buffer",
      timeout: 60_000, maxBuffer: 12_000_000, env: { ...process.env, NODE_USE_SYSTEM_CA: "1", NO_UPDATE_NOTIFIER: "1", VERCEL_TELEMETRY_DISABLED: "1" } },
    (error, stdout) => error ? reject(new Error("authorized_cli_request_failed")) : resolve(stdout));
    child.stdin?.end(input);
  });
}
export function nativeCurlEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|userprofile|localappdata|appdata|home|lang)$/i.test(key)));
}
function curlQuote(value) {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
export function buildPrivateCurlRequest({ origin, pathname, method = "GET", headers = {}, bodyFile, protectionToken }) {
  check(/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin) && isAllowedLiveQaHttpPath(pathname), "unexpected_http_target");
  check(["GET", "POST"].includes(method), "unexpected_http_method");
  check(typeof protectionToken === "string" && protectionToken.length >= 16 && protectionToken.length <= 4096 &&
    !/[\x00-\x20\x7f]/.test(protectionToken), "existing_protection_token_required");
  const target = new URL(pathname, origin);
  check(target.origin === origin && target.href === origin + pathname, "unexpected_http_target");
  const lines = ["silent", "show-error", "include", "globoff", 'proto = "=https"', 'proto-redir = "=https"',
    "connect-timeout = 15", "max-time = 50", "max-redirs = 0", "url = " + curlQuote(target.href), "request = " + curlQuote(method),
    "header = " + curlQuote("x-vercel-protection-bypass: " + protectionToken)];
  const seen = new Set(["x-vercel-protection-bypass", "host"]);
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    check(/^[A-Za-z][A-Za-z0-9-]{0,80}$/.test(key) && !seen.has(lower) && typeof value === "string" &&
      value.length <= 32768 && !/[\x00-\x1f\x7f]/.test(value), "invalid_private_http_header");
    seen.add(lower); lines.push("header = " + curlQuote(key + ": " + value));
  }
  if (bodyFile !== undefined) {
    check(typeof bodyFile === "string" && path.isAbsolute(bodyFile) && !/[\x00-\x1f\x7f]/.test(bodyFile), "private_body_file_required");
    lines.push("data-binary = " + curlQuote("@" + bodyFile));
  }
  return { args: ["--disable", "--config", "-"], input: Buffer.from(lines.join("\n") + "\n") };
}
function executeNativeCurl(args, input) {
  return new Promise(resolve => {
    const executable = process.platform === "win32" ? "C:\\Windows\\System32\\curl.exe" : "curl";
    const child = execFile(executable, args, { cwd: repository, windowsHide: true, encoding: "buffer",
      timeout: 60_000, maxBuffer: 12_000_000, env: nativeCurlEnvironment() },
    (error, stdout, stderr) => resolve({ failed: Boolean(error), stdout: stdout || Buffer.alloc(0), stderr: stderr || Buffer.alloc(0) }));
    child.stdin?.on("error", () => undefined); child.stdin?.end(input);
  });
}
export async function createNativeProtectedHttp(config, privateDirectory) {
  await assertPrivateQaPath(privateDirectory, true);
  const tokenFile = await assertPrivateQaPath(config.protectionTokenFile);
  const protectionToken = (await readFile(tokenFile, "utf8")).trim();
  buildPrivateCurlRequest({ origin: config.crm.origin, pathname: "/api/version", protectionToken });
  const requestPrefix = config.runId + "-" + randomUUID();
  let sequence = 0;
  return async (pathname, { method = "GET", headers = {}, body } = {}) => {
    check(isAllowedLiveQaHttpPath(pathname), "unexpected_http_path");
    const prefix = path.join(privateDirectory, requestPrefix + "-" + (++sequence));
    let bodyFile;
    if (body !== undefined) {
      check(typeof body === "string" || Buffer.isBuffer(body), "invalid_private_http_body");
      bodyFile = prefix + ".body.private";
      await writeFile(bodyFile, body, { flag: "wx", mode: 0o600 });
      await assertPrivateQaPath(bodyFile);
    }
    const request = buildPrivateCurlRequest({ origin: config.crm.origin, pathname, method, headers, bodyFile, protectionToken });
    const responseFile = prefix + ".response.private.bin", errorFile = prefix + ".stderr.private";
    await writeFile(responseFile, "", { flag: "wx", mode: 0o600 });
    await writeFile(errorFile, "", { flag: "wx", mode: 0o600 });
    await assertPrivateQaPath(responseFile); await assertPrivateQaPath(errorFile);
    const result = await executeNativeCurl(request.args, request.input);
    await writeFile(responseFile, result.stdout, { mode: 0o600 });
    await writeFile(errorFile, result.stderr, { mode: 0o600 });
    check(!result.failed, "authorized_native_http_request_failed");
    return parseCurlResponse(result.stdout);
  };
}
async function signedQaRequest({ http, signingSecret }, payload) {
  const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
  const response = await http("/api/public/website-sales/enquiry", { method: "POST", body, headers: {
    "Content-Type": "application/json", "Idempotency-Key": payload.operationId,
    "X-Novalure-Timestamp": timestamp, "X-Novalure-Signature": buildStudioEnquirySignature(body, timestamp, signingSecret) } });
  return { response, data: JSON.parse(response.body.toString("utf8")) };
}
export function createSignedQaCaller({ state, http, signingSecret }) {
  return async (action, expectedStatus) => {
    const payload = parseStudioEnquiryRequest({ version: "studio-enquiry-v1", action, operationId: state.operationId,
      revision: state.revision, payloadHash: state.payloadHash, snapshot: state.snapshot });
    const result = await signedQaRequest({ http, signingSecret }, payload);
    check(expectedStatus === undefined ? [200, 202].includes(result.response.status) : result.response.status === expectedStatus,
      "signed_enquiry_request_not_accepted");
    return result;
  };
}
export async function verifySignedPreReserveRejections({ state, http, signingSecret, captureCounts }) {
  const before = await captureCounts();
  const changes = [
    ["foreignScope", snapshot => { snapshot.workspaceId = randomUUID(); }],
    ["foreignConversation", snapshot => { check(snapshot.files.length > 0, "negative_file_fixture_missing"); snapshot.files[0].conversationId = randomUUID(); }],
  ];
  const checks = {};
  for (const [name, change] of changes) {
    const snapshot = structuredClone(state.snapshot); change(snapshot);
    // Intentionally bypass the local parser: the real authenticated endpoint
    // must reject the invalid snapshot, despite its valid hash and signature.
    const payload = { version: "studio-enquiry-v1", action: "reserve", operationId: state.operationId,
      revision: state.revision, payloadHash: hash(JSON.stringify(snapshot)), snapshot };
    const result = await signedQaRequest({ http, signingSecret }, payload);
    check(result.response.status === 400 && result.data.error === "invalid_enquiry", "signed_negative_not_rejected");
    assert.deepEqual(await captureCounts(), before, "A rejected snapshot changed scoped CRM records");
    checks[name] = "PASS_signed_HTTP400_no_transfer_or_crm_effect";
  }
  return checks;
}
export async function verifyMissingCopyRejection({ call, captureCounts }) {
  const before = await captureCounts();
  check(before?.state === "reserved" && ["leads", "submissions", "assets", "links"].every(key => before[key] === 0),
    "precopy_state_not_empty");
  const result = await call("finalize", 409);
  check(result.data.error === "files_not_copied", "missing_copy_error_not_verified");
  assert.deepEqual(await captureCounts(), before, "A premature finalize changed scoped CRM records");
  return "PASS_HTTP409_reserved_no_lead_submission_asset_or_link";
}
async function scopedEffectCounts(pool) {
  return withReadOnly(pool, async client => {
    const counts = {};
    for (const table of ["studio_enquiry_transfers", "leads", "form_submissions", "media_assets", "studio_enquiry_assets"]) {
      const column = table === "media_assets" || table === "studio_enquiry_assets" ? "$1::text" : "$1::uuid";
      counts[table] = (await client.query("select count(*)::int as count from public." + table + " where workspace_id=" + column, [workspaceId])).rows[0].count;
    }
    return counts;
  });
}
async function newState(config) {
  const pdf = await PDFDocument.create(); pdf.addPage().drawText("SYNTHETIC ST1 transport fixture");
  const originalPdf = Buffer.from(await pdf.save());
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#336699" } }).png().toBuffer();
  const webp = await sharp(png).webp().toBuffer(), conversationId = randomUUID();
  const bytes = [{ name: "synthetic-brief.pdf", original: originalPdf, analysis: originalPdf, mime: "application/pdf", originalMime: "application/pdf" },
    { name: "synthetic-photo.png", original: png, analysis: webp, mime: "image/webp", originalMime: "image/png" }];
  const payloads = {};
  const files = bytes.map(item => {
    const id = randomUUID(); payloads[id] = { original: item.original.toString("base64"), analysis: item.analysis.toString("base64") };
    return { id, conversationId, name: item.name, mime: item.mime, bytes: item.analysis.length, sha256: hash(item.analysis), originalSha256: hash(item.original),
      original: { mime: item.originalMime, bytes: item.original.length, sha256: hash(item.original) },
      analysis: { status: "partial", summary: "Synthetic QA transport fixture", extractedText: "SYNTHETIC ST1 material transfer only.",
        limitations: ["Synthetic transport analysis; no live model was called."] } };
  });
  const snapshot = { schemaVersion: "studio-enquiry-snapshot-v1", conversationId, confirmedAt: new Date().toISOString(),
    consent: { privacy: true, policyVersion: "studio-enquiry-2026-10-18" },
    brief: { values: { goals: "A synthetic QA website without a shop", company: config.runId, email: config.qaEmail, contactMethod: "email",
      ...(config.qaPhone ? { phone: config.qaPhone } : {}) }, summary: "Goals: A synthetic QA website without a shop", openQuestions: ["Launch date remains open."] },
    files, websites: [], syntheticTest: true };
  return { binding: config.crm, operationId: randomUUID(), revision: 1, payloadHash: hash(JSON.stringify(snapshot)), snapshot, payloads };
}
export async function withReadOnly(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query("set local statement_timeout = '15s'");
    await client.query("set local lock_timeout = '5s'");
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [workspaceId, actorId]);
    const result = await callback(client); await client.query("commit"); return result;
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function scopedCounts(pool, state) {
  return withReadOnly(pool, async client => {
    const result = await client.query(`select t.state,t.payload_hash,t.snapshot_text,t.lead_id,t.submission_id,
      (select count(*)::int from studio_enquiry_assets a where a.operation_id=t.operation_id) as links,
      (select count(distinct a.media_asset_id)::int from studio_enquiry_assets a where a.operation_id=t.operation_id) as assets,
      (select count(*)::int from leads l where l.id=t.lead_id and l.workspace_id=t.workspace_id) as leads,
      (select count(*)::int from form_submissions s where s.id=t.submission_id and s.workspace_id=t.workspace_id) as submissions,
      (select count(*)::int from tasks x where x.lead_id=t.lead_id and x.workspace_id=t.workspace_id) as tasks,
      (select count(*)::int from studio_sales_bookings b where b.lead_id=t.lead_id and b.workspace_id=t.workspace_id) as bookings
      from studio_enquiry_transfers t where t.operation_id=$1::uuid and t.workspace_id=$2::uuid`, [state.operationId, workspaceId]);
    const row = result.rows[0];
    if (!row) return null;
    check(row.payload_hash === state.payloadHash && hash(row.snapshot_text) === state.payloadHash, "persisted_confirmation_mismatch");
    return { state: row.state, links: row.links, assets: row.assets, leads: row.leads, submissions: row.submissions, tasks: row.tasks, bookings: row.bookings,
      leadId: row.lead_id, submissionId: row.submission_id };
  });
}
async function normalMediaAccess(config, http, receipt, privateAuthDirectory) {
  const report = {};
  for (const label of ["sameWorkspace", "foreignWorkspace"]) {
    const fixture = config.logins?.[label];
    if (!fixture?.email || !fixture?.password || !fixture?.userId || !fixture?.workspaceId) { report[label] = "NOT_RUN_normal_login_fixture_missing"; continue; }
    check(label === "sameWorkspace" ? fixture.workspaceId === workspaceId : fixture.workspaceId !== workspaceId, "invalid_login_scope");
    check(config.qa.projectId===fixtureTarget.projectId&&config.qa.branchId===fixtureTarget.branchId&&
      config.qa.databaseName===fixtureTarget.databaseName,"normal_login_fixture_database_mismatch");
    await assertPrivateQaPath(privateAuthDirectory,true);
    const mfaPath=path.join(privateAuthDirectory,config.runId+"-"+label+"-mfa.private.json");
    let savedMfa;
    try {
      await assertPrivateQaPath(mfaPath);
      savedMfa=JSON.parse(await readFile(mfaPath,"utf8"));
      check(savedMfa.format==="studio-stage3-normal-mfa-v1"&&savedMfa.label===label&&
        savedMfa.email===fixture.email&&savedMfa.userId===fixture.userId&&savedMfa.workspaceId===fixture.workspaceId&&
        savedMfa.target?.projectId===fixtureTarget.projectId&&savedMfa.target?.branchId===fixtureTarget.branchId&&
        savedMfa.target?.databaseName===fixtureTarget.databaseName,"saved_normal_mfa_binding_mismatch");
    } catch(error) {if(error.code!=="ENOENT")throw error;}
    const auth=await normalQaLogin({label,account:{...fixture,...(savedMfa?{mfa:savedMfa}:{})},origin:config.crm.origin,http,
      savePrivateEnrollment:async(savedLabel,material)=>{
        check(savedLabel===label,"normal_enrollment_label_mismatch");
        // Exclusive creation: an uncertain prior enrollment is never overwritten.
        await writeFile(mfaPath,JSON.stringify({format:"studio-stage3-normal-mfa-v1",label,target:fixtureTarget,...material},null,2),
          {flag:"wx",mode:0o600});
      }});
    const cookie=auth.cookie;
    const detail=await http("/api/crm/leads?id="+encodeURIComponent(receipt.crmLeadId),{headers:{Cookie:cookie}});
    if(label==="sameWorkspace"){
      check(detail.status===200,"same_workspace_lead_details_not_readable");
      const view=JSON.parse(detail.body.toString("utf8"));
      check(view.enquiry?.operationId===receipt.operationId&&view.enquiry?.files?.length===2,"same_workspace_lead_details_mismatch");
    } else check(detail.status===404||detail.status===403,"foreign_lead_details_not_denied");
    const seen = new Set();
    for (const attachment of receipt.attachments) {
      if (seen.has(attachment.assetId)) continue; seen.add(attachment.assetId);
      const response = await http("/api/media/files/" + attachment.assetId, { headers: { Cookie: cookie } });
      if (label === "foreignWorkspace") { check(response.status === 404 || response.status === 403, "foreign_media_access_not_denied"); continue; }
      check(response.status === 200 && hash(response.body) === attachment.sha256 &&
        response.headers.get("cache-control")?.some(v => /private/.test(v) && /no-store/.test(v)) &&
        response.headers.get("x-content-type-options")?.includes("nosniff"), "same_workspace_media_not_verified");
    }
    report[label] = "PASS_normal_authenticated_lead_and_media_access";
  }
  const anonymous = await http("/api/media/files/" + receipt.attachments[0].assetId);
  check(anonymous.status === 401, "anonymous_media_access_not_denied"); report.anonymous = "PASS_unauthenticated_denied";
  return report;
}

export function isAllowedLiveQaHttpPath(pathname) {
  if (typeof pathname !== "string" || pathname.includes("\\") || /[\x00-\x20\x7f#]/.test(pathname)) return false;
  if (pathname === "/login?step=mfa_enrollment" || pathname === "/login?step=mfa_verification") return true;
  if (!pathname.startsWith("/api/")) return false;
  try {
    const parsed = new URL(pathname, "https://qa.example.invalid");
    return parsed.origin === "https://qa.example.invalid" && parsed.pathname.startsWith("/api/") &&
      parsed.pathname === pathname.split("?")[0];
  } catch { return false; }
}

export async function runLiveQa(configFile) {
  const allowed = await realpath(path.join(repository, ".npm-cache", "qa"));
  const filename = await assertPrivateQaPath(await realpath(path.resolve(configFile)));
  check(filename.startsWith(allowed + path.sep), "config_must_be_in_ignored_qa_directory");
  const config = validateLiveQaConfig(JSON.parse(await readFile(filename, "utf8")));
  const statePath = path.join(path.dirname(filename), `${config.runId}-studio-enquiry.private.json`);
  const reportPath = path.join(path.dirname(filename), `${config.runId}-studio-enquiry.receipt.json`);
  const report = { schemaVersion: "studio-enquiry-live-qa-v1", status: "RUNNING", checks: {}, startedAt: new Date().toISOString() };
  let pool, stage = "preflight";
  try {
    const cli = config.vercelCliPath || path.join(process.env.APPDATA || "", "npm", "node_modules", "vercel", "dist", "index.js");
    const metadata = JSON.parse((await executeCli(cli, ["api", "/v13/deployments/" + config.crm.deploymentId, "--scope", "novalure", "--non-interactive", "--raw"])).toString("utf8"));
    check((metadata.projectId || metadata.project?.id) === projectId && metadata.id === config.crm.deploymentId && metadata.target !== "production" &&
      metadata.readyState === "READY" && metadata.url === new URL(config.crm.origin).hostname &&
      (metadata.meta?.githubCommitSha || metadata.meta?.gitCommitSha || metadata.gitSource?.sha) === config.crm.gitSha &&
      (metadata.meta?.githubCommitRef || metadata.meta?.gitCommitRef || metadata.gitSource?.ref) === branch, "deployment_identity_mismatch");
    const http = await createNativeProtectedHttp(config, path.dirname(filename));
    const version = await http("/api/version"); check(version.status === 200, "preview_version_unavailable");
    const versionBody = JSON.parse(version.body.toString("utf8"));
    check(versionBody.gitSha === config.crm.gitSha && versionBody.branch === branch &&
      (!versionBody.deploymentId || versionBody.deploymentId === config.crm.deploymentId), "runtime_revision_mismatch");
    pool = new pg.Pool(liveQaDatabaseOptions(config));
    const actual = await withReadOnly(pool, async client => (await client.query(`select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,
      current_database() as name,current_user as role,(not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole
       and pg_has_role(r.oid,'novalure_tenant_app','USAGE') and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relrowsecurity and c.relkind in ('r','p') and (c.relowner=r.oid or pg_has_role(r.oid,c.relowner,'MEMBER')))) as safe,
      (select count(*)=2 and bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname in ('studio_enquiry_transfers','studio_enquiry_assets')) as migrated
      from pg_roles r where r.rolname=current_user`)).rows[0]);
    check(actual?.project === config.qa.projectId && actual.branch === config.qa.branchId && actual.name === config.qa.databaseName &&
      actual.role === config.qa.role && actual.safe === true && actual.migrated === true, "actual_qa_database_mismatch");
    report.checks.target = "PASS_exact_preview_and_neon_identity";
    report.target = { projectId, branch, deploymentId: config.crm.deploymentId, gitSha: config.crm.gitSha,
      databaseFingerprint: hash([config.qa.projectId,config.qa.branchId,config.qa.databaseName,config.qa.role].join("\0")).slice(0,16) };
    let state;
    try { state = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; state = await newState(config); await writeFile(statePath, JSON.stringify(state), { flag: "wx", mode: 0o600 }); }
    assert.deepEqual(state.binding, config.crm); check(uuid.test(state.operationId), "invalid_saved_operation");
    const call = createSignedQaCaller({ state, http, signingSecret: config.signingSecret });
    stage = "signed_snapshot_rejections";
    Object.assign(report.checks, await verifySignedPreReserveRejections({ state, http, signingSecret: config.signingSecret,
      captureCounts: () => scopedEffectCounts(pool) }));
    report.operationId = state.operationId; report.payloadHash = state.payloadHash;
    stage = "reserve";
    const initial = await call("reserve");
    if (initial.data.status !== "transmitted") {
      const noLead = await scopedCounts(pool,state);
      check(noLead?.state === "reserved" && noLead.leads === 0 && noLead.submissions === 0 && noLead.assets === 0 && noLead.links === 0, "reserve_created_crm_records");
      report.checks.reserve = "PASS_no_lead_or_asset_before_copy";
      const expectedRoles = new Set(state.snapshot.files.flatMap(f => [f.id + ":original", f.id + ":analysis"]));
      check(Array.isArray(initial.data.targets) && initial.data.targets.length === expectedRoles.size, "copy_roles_missing");
      if (initial.data.targets.every(target => target.status === "upload_required")) {
        stage = "premature_finalize";
        report.checks.missingCopy = await verifyMissingCopyRejection({ call, captureCounts: () => scopedCounts(pool, state) });
      } else report.checks.missingCopy = "NOT_RUN_resumed_operation_already_has_copied_files";
      const copied = new Set();
      stage = "copy";
      for (const target of initial.data.targets) {
        const role = target.sourceId + ":" + target.variant; check(expectedRoles.delete(role), "duplicate_copy_role");
        const expected = validateQaPut(target,state.snapshot,state.operationId);
        if (copied.has(target.assetId) || target.status === "copied") continue;
        const bytes = Buffer.from(state.payloads[target.sourceId][target.variant],"base64");
        check(bytes.length === expected.bytes && hash(bytes) === expected.sha256, "saved_source_bytes_mismatch");
        const result = await fetch(target.put.url,{method:"PUT",headers:target.put.headers,body:bytes,redirect:"error",signal:AbortSignal.timeout(50_000)});
        check(result.ok,"private_put_unconfirmed"); await result.body?.cancel(); copied.add(target.assetId);
      }
      const verified = await call("reserve"); check(verified.data.targets.every(t => t.status === "copied"), "copied_targets_not_verified");
      report.checks.copy = "PASS_private_original_and_analysis_hashes_verified";
      stage = "discarded_finalize_receipt";
      const discarded = await call("finalize"); check(discarded.response.status === 202,"finalize_not_acknowledged");
      // Deliberately discard this received result; subsequent success must come from status.
      report.checks.discardedResponse = "SIMULATED_client_loss_of_received_202_not_network_timeout";
    } else {
      report.checks.reserve = "RESUMED_previously_accepted_operation_no_new_transfer";
      report.checks.missingCopy = "NOT_RUN_resumed_previously_accepted_operation";
    }
    stage = "status_and_parallel_replay";
    const status = (await call("status")).data; check(status.status === "transmitted" && status.receipt?.accepted === true,"durable_status_missing");
    const receipt = status.receipt;
    check(receipt.operationId === state.operationId && receipt.payloadHash === state.payloadHash && receipt.revision === state.revision &&
      receipt.workspaceId === workspaceId && uuid.test(receipt.crmLeadId) && uuid.test(receipt.formSubmissionId), "receipt_binding_mismatch");
    const concurrent = await Promise.all([call("finalize"),call("finalize")]);
    for (const result of concurrent) assert.deepEqual(result.data.receipt,receipt);
    const counts = await scopedCounts(pool,state);
    check(counts?.state === "accepted" && counts.leads === 1 && counts.submissions === 1 && counts.links === state.snapshot.files.length*2 &&
      counts.assets === new Set(receipt.attachments.map(t=>t.assetId)).size && counts.tasks === 0 && counts.bookings === 0 &&
      counts.leadId === receipt.crmLeadId && counts.submissionId === receipt.formSubmissionId, "durable_counts_mismatch");
    report.checks.replay = "PASS_same_receipt_after_discard_status_and_parallel_finalize"; report.counts = counts;
    report.receipt = receipt;
    stage = "normal_authenticated_media_access";
    report.mediaAccess = await normalMediaAccess(config,http,receipt,path.dirname(filename));
    report.status = Object.values(report.mediaAccess).every(v=>v.startsWith("PASS")) ? "PASS" : "TRANSPORT_PASS_AUTHENTICATED_ACCESS_OPEN";
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});
    console.log(JSON.stringify(report));
  } catch {
    report.status = "FAILED"; report.failure = { stage, reason: "verification_unconfirmed" }; report.finishedAt = new Date().toISOString();
    await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600}).catch(()=>undefined);
    console.error(JSON.stringify(report)); process.exitCode = 1;
  } finally { await pool?.end(); }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error("Usage: node --conditions=react-server --import tsx scripts/studio-enquiry-live-qa.mjs <ignored-private-config.json>"); process.exitCode=1; }
  else try { await runLiveQa(process.argv[2]); }
  catch { console.error(JSON.stringify({status:'FAILED',failure:{stage:'private_config',reason:'configuration_unconfirmed'}})); process.exitCode=1; }
}
