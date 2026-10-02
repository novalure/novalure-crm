import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, access as fileAccess } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import pg from "pg";
import { authenticatorCode, vercelDeploymentEvidence } from "./qa-g27-live-preview.mjs";
import { previewAccessHeaders, verifyCrmBrowserBinding } from "./lib/g27-preview-access.mjs";
import { tsImport } from "tsx/esm/api";
const { evelynActionHash } = await tsImport("../src/lib/evelyn-approval-client.ts", import.meta.url);

const directory = ".npm-cache/g27/private-live/";
const read = async file => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeFile(directory + file, JSON.stringify(value, null, 2));
const state = { status: "PENDING", stage: "PRECONDITION", artifacts: {} };
let browser, context, db;
let progressCreated = false;

async function main() {
  assert.equal(process.argv[2], "--run-authorized-preview-bootstrap");
  // This is an additive fixture, never a rerun of the database/base-user seed.
  const resumeQueued = process.argv.includes("--resume-queued-offer");
  const resume = resumeQueued || process.argv.includes("--resume-enrolled-no-business-writes");
  if (resume) {
    const prior = await read(directory + "bootstrap-progress.json");
    assert.equal(prior.status, "BLOCKED");
    assert.equal(prior.stage, "CREATE_ACCEPTED_LEGACY_SOURCE");
    if (resumeQueued) {
      assert.deepEqual(Object.keys(prior.artifacts).sort(), ["contacts", "deals", "leads"]);
      for (const ids of Object.values(prior.artifacts)) assert.equal(ids.length, 1);
      state.artifacts = prior.artifacts;
    } else assert.deepEqual(prior.artifacts, {});
  } else await assert.rejects(fileAccess(directory + "bootstrap-progress.json"), { code: "ENOENT" });
  const fixtureDocument = await read(".npm-cache/g27/preview-private.json");
  const fixture = fixtureDocument.fixture;
  const access = await read(directory + "live-access.json");
  const zeroWrite = await read("C:/Projects/evelyn/artifacts/g27-qa/wrong-tenant-zero-write-evidence.json");
  assert.equal(zeroWrite.status, "PASS");
  assert.equal(zeroWrite.tenants.target.tenantId, fixture.workspaceId);
  assert.equal(access.evelyn.config.tenantId, fixture.workspaceId);
  assert.equal(fixture.workspaceId, "afeac3f9-7534-47f5-b749-b3fd91b8f91b");
  assert.equal(fixture.projectId, "f7599088-09cb-44a6-a366-a36f9146d495");
  const pins = { crmDeploymentId: access.crm.deploymentId, crmCommitSha: access.crm.commitSha,
    crmVercelProjectId: access.crm.vercelProjectId, evelynDeploymentId: access.evelyn.deploymentId,
    evelynCommitSha: access.evelyn.commitSha };
  await vercelDeploymentEvidence("CRM", access.crm, access.crm.url, pins);
  await vercelDeploymentEvidence("EVELYN", access.evelyn, access.evelyn.url, pins);
  const browserOrigin = await verifyCrmBrowserBinding(access.crm);
  const url = new URL(fixtureDocument.runtimeURL);
  assert.equal(url.hostname, "ep-soft-thunder-awqgz3t0.c-12.us-east-1.aws.neon.tech");
  assert.equal(url.pathname, "/qa_g27_20260923");
  assert.equal(url.username, "g27_qa_20260923");
  url.searchParams.set("sslmode", "verify-full");
  db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000, query_timeout: 15000 });
  await db.connect();
  const identity = (await db.query("select current_database() database,current_setting('neon.project_id',true) project,current_setting('neon.branch_id',true) branch")).rows[0];
  assert.deepEqual(identity, { database: "qa_g27_20260923", project: "super-block-59791927", branch: "br-summer-breeze-awuzinct" });
  if (resume) {
    await db.query("begin read only");
    try {
      await db.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [fixture.workspaceId, fixture.userId]);
      const counts = (await db.query("select (select count(*)::int from crm_offers where workspace_id=$1) offers,(select count(*)::int from crm_evelyn_contract_actions where workspace_id=$1) actions", [fixture.workspaceId])).rows[0];
      assert.deepEqual(counts, { offers: resumeQueued ? 1 : 0, actions: 0 });
      if (resumeQueued) {
        const offer = (await db.query("select status from crm_offers where workspace_id=$1 and project_id=$2 and deal_id=$3", [fixture.workspaceId, fixture.projectId, state.artifacts.deals[0]])).rows[0];
        assert.equal(offer?.status, "QUEUED");
      }
    } finally { await db.query("rollback"); }
  }
  state.stage = "MFA_ENROLLMENT";
  await save("bootstrap-progress.json", state);
  progressCreated = true;
  const headers = previewAccessHeaders(process.env.G27_CRM_ACCESS_OIDC_TOKEN);
  state.stage = "BROWSER_LAUNCH";
  browser = await chromium.launch({ channel: "chrome", headless: true });
  context = await browser.newContext({ locale: "de-AT", timezoneId: "Europe/Vienna" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["data:", "blob:"].includes(url.protocol)) return route.continue();
    if (url.origin !== browserOrigin) return route.abort();
    if (!["GET", "HEAD"].includes(route.request().method())) {
      try { await verifyCrmBrowserBinding(access.crm); } catch { return route.abort(); }
    }
    return route.continue({ headers: { ...route.request().headers(), ...headers } });
  });
  const page = await context.newPage();
  state.stage = "LOGIN_PAGE";
  await page.goto(browserOrigin + "/login", { waitUntil: "domcontentloaded" });
  await page.locator("#login-email").fill(fixture.email);
  await page.locator("#login-password").fill(fixture.password);
  state.stage = "PASSWORD_LOGIN";
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.locator("form:has(#login-password) button[type=submit]").click()]);
  await expect(page.locator("#login-mfa-code")).toBeVisible();
  state.stage = "MFA_ENROLLMENT";
  let totpSecret;
  if (resume) {
    totpSecret = (await read(directory + "live-browser-private.json")).totpSecret;
  } else {
  await expect(page.locator("input[name=recoveryCodesSaved]")).toBeVisible();
  totpSecret = (await page.locator("p").filter({ has: page.locator("strong", { hasText: "TOTP-Schlüssel:" }) }).locator("code").innerText()).trim();
  assert.match(totpSecret, /^[A-Z2-7]{16,}$/);
  const recoveryCodes = await page.locator("form:has(#login-mfa-code) li code").allTextContents();
  assert.ok(recoveryCodes.length > 0);
  await save("live-browser-private.json", { workspaceId: fixture.workspaceId, email: fixture.email, totpSecret, recoveryCodes });
  await page.locator("input[name=recoveryCodesSaved]").check();
  }
  await page.locator("#login-mfa-code").fill(authenticatorCode(totpSecret));
  await Promise.all([page.waitForURL(url => url.origin === browserOrigin && !url.pathname.startsWith("/login"), { waitUntil: "domcontentloaded", timeout: 30000 }),
    page.getByRole("button", { name: "Sicher bestätigen", exact: true }).click()]);
  assert.equal(new URL(page.url()).origin, browserOrigin);
  assert.equal(new URL(page.url()).pathname.startsWith("/login"), false);
  state.stage = "CREATE_ACCEPTED_LEGACY_SOURCE";
  await save("bootstrap-progress.json", state);
  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const exact = (_name, actual, expected) => assert.deepEqual(actual, expected);
  const resultData = body => body.data ?? body;
  const track = (collection, value) => { const ids = state.artifacts[collection] ??= []; if (!ids.includes(value)) ids.push(value); };
  async function api(requestPath, body, method = "POST", metadata = {}) {
    const result = await page.evaluate(async input => {
      const headers = { "content-type": "application/json", "Idempotency-Key": input.idempotencyKey, "X-Correlation-Id": input.correlationId };
      if (input.method !== "GET") {
        const csrf = await fetch("/api/auth/csrf?" + new URLSearchParams({ method: input.method, path: input.requestPath }), { redirect: "error" });
        const token = await csrf.json();
        if (!csrf.ok || typeof token.csrfToken !== "string") return { status: csrf.status, body: {} };
        headers["x-novalure-csrf-token"] = token.csrfToken;
      }
      const response = await fetch(input.requestPath, { method: input.method, headers,
        ...(input.method === "GET" ? {} : { body: JSON.stringify(input.body) }), redirect: "error", signal: AbortSignal.timeout(30000) });
      return { status: response.status, serverDate: response.headers.get("date"), body: response.headers.get("content-type")?.includes("application/json") ? await response.json() : {} };
    }, { requestPath, body, method, idempotencyKey: metadata.idempotencyKey ?? randomUUID(), correlationId: metadata.correlationId ?? randomUUID() });
    state.lastHttp = { path: requestPath.split("?")[0], operation: body?.operation ?? null, status: result.status,
      code: /^[A-Z_]{3,80}$/.test(result.body?.code ?? "") ? result.body.code : null };
    state.serverDate = result.serverDate;
    assert.ok(result.status >= 200 && result.status < 300, "SYNTHETIC_SOURCE_API_DENIED");
    await save("bootstrap-progress.json", state);
    return result.body;
  }
  const get = requestPath => api(requestPath, undefined, "GET");
    async function acceptedOffer() {
      const existing = resumeQueued ? resultData(await get("/api/crm/core")) : null;
      const contact = resumeQueued ? existing.contacts.find(item => item.id === state.artifacts.contacts[0]) : (await api("/api/crm/contacts", { contact: {
        name: `SYNTHETIC G27 Buyer ${marker}`,
        email: `g27-${marker}@example.invalid`,
        role: "Bauträger",
        source: "Manual",
        consent: "Opt-in",
        projectId: fixture.projectId,
      } })).contact;
      track("contacts", contact.id);
      const lead = resumeQueued ? existing.leads.find(item => item.id === state.artifacts.leads[0]) : (await api("/api/crm/leads", { lead: {
        contactId: contact.id,
        projectId: fixture.projectId,
        type: "Bauträger",
        source: "Manual",
        intent: "SYNTHETIC G27 service inquiry",
      } })).lead;
      track("leads", lead.id);
      const deal = resumeQueued ? existing.deals.find(item => item.id === state.artifacts.deals[0]) : (await api("/api/crm/deals", { deal: {
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
      let offer;
      if (!resumeQueued) {
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
      offer = (await view()).offer;
      exact("OFFER_DRAFT_STATUS", offer.status, "DRAFT");
      exact("OFFER_NET_MINOR_UNITS", String(offer.totalNetCents), "2037000");
      await offerCommand("approve", {
        revision: offer.revision,
        contentDigest: offer.contentDigest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await offerCommand("queue_send");
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      offer = (await view()).offer;
      const receiptAt = new Date(state.serverDate).toISOString();
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

  const source = await acceptedOffer();
  state.stage = "LEGACY_V1_PRESEED";
  state.offerId = source.offer.id;
  await save("bootstrap-progress.json", state);
  const bytes = createHash("sha256").update(`crm-evelyn:${source.offer.id}:contract`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex"), id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const correlationId = randomUUID();
  await db.query("begin");
  try {
    await db.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [fixture.workspaceId, fixture.userId]);
    const row = (await db.query(`select o.*,r.content,r.content_digest,r.total_net_cents
      from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
      where o.workspace_id=$1 and o.project_id=$2 and o.id=$3 and o.status='ACCEPTED' for share of o`,
    [fixture.workspaceId, fixture.projectId, source.offer.id])).rows[0];
    assert.ok(row?.approval_id && row.response_reference && row.response_actor_id);
    assert.ok(row.content.subject.startsWith("SYNTHETIC") && row.content.recipientEmail.endsWith(".invalid"));
    const action = { actionId: id, workflowId: id, tenantId: fixture.workspaceId, requestingActorId: fixture.userId,
      actionType: "contract.send", resourceType: "Contract", resourceId: id, actionVersion: 1, resourceVersion: 1,
      amount: Number(row.total_net_cents), currency: "EUR", net: true, payload: {
        recipient: { id: row.contact_id, email: row.content.recipientEmail },
        contract: { id, version: 1, content: `SYNTHETIC contract derived from accepted offer ${row.id}; revision ${row.revision}; digest ${row.content_digest}` },
        scope: { projectId: fixture.projectId, description: "SYNTHETIC Preview contract approval verification; no delivery" },
        price: { netCents: Number(row.total_net_cents), currency: "EUR" } } };
    await db.query(`insert into crm_evelyn_contract_actions(id,workspace_id,project_id,offer_id,created_by,correlation_id,offer_version,offer_revision,source_approval_id,source_content_digest)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, fixture.workspaceId, fixture.projectId, row.id, fixture.userId,
      correlationId, row.version, row.revision, row.approval_id, row.content_digest]);
    await db.query(`insert into crm_evelyn_contract_revisions(workspace_id,project_id,action_id,version,created_by,action,action_hash)
      values($1,$2,$3,1,$4,$5,$6)`, [fixture.workspaceId, fixture.projectId, id, fixture.userId, action, evelynActionHash(action)]);
    await db.query("commit");
  } catch (error) { await db.query("rollback"); throw error; }
  await save("legacy-fixture.json", { workspaceId: fixture.workspaceId, projectId: fixture.projectId,
    actionId: id, actionVersion: 1, correlationId, offerId: source.offer.id, contractVersion: "v1" });
  state.status = "PASS"; state.stage = "LEGACY_FIXTURE_READY";
  await save("bootstrap-progress.json", state);
  console.log("SYNTHETIC_MFA_AND_REAL_LEGACY_V1_FIXTURE_PASS");
}

try { await main(); }
catch (error) { state.status = "BLOCKED"; state.errorType = error?.name === "TimeoutError" ? "TIMEOUT" : "ASSERTION_OR_RUNTIME"; state.sourceLine = String(error?.stack ?? "").match(/qa-g27-live-bootstrap\.mjs:(\d+):/)?.[1] ?? null; if (progressCreated) await save("bootstrap-progress.json", state); console.error(`G27_BOOTSTRAP_BLOCKED_AT_${state.stage}`); process.exitCode = 1; }
finally { await context?.close(); await browser?.close(); await db?.end(); }
