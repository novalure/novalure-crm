import { createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect, request as playwrightRequest } from "@playwright/test";

// This runner performs real, synthetic Preview mutations. Run only after local gates pass.
// Owner actions originate here in a separate authenticated Owner session, never in CRM.
const EVELYN = "https://evelyn-hrc1fof30-novalure.vercel.app";
// Root verifies that this PR branch alias resolves to the tested READY commit before running.
const CRM_PREVIEW_ALIAS = "https://novalure-crm-git-codex-crm-sales-readiness-high-gaps-novalure.vercel.app";
const CRM_PROJECT = "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
const paths = {
  fixture: ".npm-cache/g08/preview-private.json", access: ".npm-cache/g08/live-access.json",
  private: ".npm-cache/g08/live-browser-private.json", report: ".npm-cache/g08/live-preview-report.json",
};
function ensure(condition, code) { if (!condition) throw new Error(code); }
function endpoint(origin, relative) {
  const url = new URL(relative, origin);
  ensure(url.origin === origin && relative.startsWith("/") && !relative.startsWith("//"), "EXACT_ORIGIN_REQUIRED");
  return url;
}
function protectionHeaders(raw) {
  ensure(raw && typeof raw === "object" && !Array.isArray(raw), "PROTECTION_HEADERS_REQUIRED");
  const result = {};
  for (const [name, value] of Object.entries(raw)) {
    ensure(["x-vercel-protection-bypass", "x-vercel-set-bypass-cookie"].includes(name.toLowerCase())
      && typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value), "INVALID_PROTECTION_HEADER");
    result[name.toLowerCase()] = value;
  }
  return result;
}
function protectionUrl(value, origin) {
  if (value === undefined) return null;
  const url = new URL(value);
  ensure(url.origin === origin && !url.username && !url.password, "PROTECTION_URL_ORIGIN_REQUIRED");
  return url.href;
}
function authenticatorCode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", bytes = [];
  let accumulator = 0, bits = 0;
  for (const character of secret) {
    const value = alphabet.indexOf(character); ensure(value >= 0, "INVALID_SYNTHETIC_TOTP_KEY");
    accumulator = (accumulator << 5) | value; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); accumulator &= (1 << bits) - 1; }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest(), offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : "UNEXPECTED_RESPONSE";
function successful(response, label) {
  ensure(response.status >= 200 && response.status < 300, label + "_HTTP_" + response.status + "_" + safeCode(response.body?.code ?? response.body?.error));
  return response.body;
}
function denied(response, codes, label) {
  ensure(response.status >= 400 && response.status < 500 && codes.includes(response.body?.code), label + "_NOT_DENIED");
}
const data = body => body.data ?? body;

async function main() {
  ensure(process.argv.includes("--run-authorized-live"), "EXPLICIT_LIVE_RUN_FLAG_REQUIRED");
  const saved = JSON.parse(await readFile(paths.fixture, "utf8"));
  const fixture = saved.fixture ?? saved.crmFixture ?? saved;
  const access = JSON.parse(await readFile(paths.access, "utf8"));
  const crm = new URL(access.crm.url), evelyn = new URL(access.evelyn.url);
  ensure(crm.origin === CRM_PREVIEW_ALIAS
    && crm.pathname === "/" && !crm.search && !crm.hash && !crm.username && !crm.password, "PINNED_CRM_PREVIEW_REQUIRED");
  ensure(evelyn.origin === EVELYN && evelyn.pathname === "/" && !evelyn.search && !evelyn.hash, "PINNED_EVELYN_PREVIEW_REQUIRED");
  ensure(fixture.workspaceId === access.evelyn.config.tenantId && fixture.email.endsWith(".invalid"), "QA_TENANT_BINDING_REQUIRED");
  ensure(typeof fixture.password === "string" && typeof access.evelyn.ownerPassword === "string", "TEST_CREDENTIALS_REQUIRED");
  const crmOrigin = crm.origin, crmHeaders = protectionHeaders(access.crm.protectionHeaders);
  const ownerHeaders = protectionHeaders(access.evelyn.protectionHeaders);
  const crmProtectionUrl = protectionUrl(access.crm.protectionUrl, crmOrigin);
  const ownerProtectionUrl = protectionUrl(access.evelyn.protectionUrl, EVELYN);
  ensure(crmProtectionUrl || crmHeaders["x-vercel-protection-bypass"], "CRM_PROTECTION_ACCESS_REQUIRED");
  ensure(ownerProtectionUrl || ownerHeaders["x-vercel-protection-bypass"], "OWNER_PROTECTION_ACCESS_REQUIRED");
  const report = { startedAt: new Date().toISOString(), status: "RUNNING", crmPreviewUrl: crmOrigin, evelynPreviewUrl: EVELYN,
    expectedCrmProject: CRM_PROJECT, tenantId: fixture.workspaceId, syntheticOnly: true, externalEffect: false,
    ownerStepsPerformedBy: "separate_test_owner_session_outside_crm", checks: [], http: [], actions: [], audit: [],
    limits: ["Production identity rejection, unreachable/timeout/HTTP faults are separate local security tests, not simulated live claims.",
      "CRM audit rows and execution counts require the independent pinned Preview database check."] };
  let active = "initialization", ownerCookie, ownerCsrf, browser, context, ownerContext;
  const save = () => writeFile(paths.report, JSON.stringify(report, null, 2));
  async function step(name, work) {
    active = name;
    try { const result = await work(); report.checks.push({ name, status: "PASS" }); await save(); console.log("PASS " + name); return result; }
    catch (error) { report.checks.push({ name, status: "FAIL", reason: safeCode(error?.message) }); throw new Error("LIVE_STEP_FAILED"); }
  }
  const record = (system, path, method, response, correlationId) => {
    const value = data(response.body ?? {});
    report.http.push({ system, path: path.split("?")[0], method, httpStatus: response.status,
      ...(correlationId ? { correlationId } : {}),
      ...(value.status ? { result: safeCode(value.status) } : {}),
      ...(response.body?.code ? { code: safeCode(response.body.code) } : {}),
      ...(response.body?.auditReference ? { auditReference: response.body.auditReference } : {}) });
  };
  async function owner(path, body, method = "POST") {
    const url = endpoint(EVELYN, path);
    const headers = { ...ownerHeaders, ...(method === "POST" ? { "content-type": "application/json", origin: EVELYN,
      "sec-fetch-site": "same-origin", ...(ownerCsrf ? { "x-evelyn-csrf": ownerCsrf } : {}) } : {}) };
    const response = await ownerContext.fetch(url.href, { method, headers, ...(method === "POST" ? { data: JSON.stringify(body) } : {}),
      maxRedirects: 0, timeout: 30000 });
    ensure(response.status() < 300 || response.status() >= 400, "OWNER_REDIRECT_DENIED");
    const cookies = (await ownerContext.storageState()).cookies;
    ownerCookie = cookies.some(cookie => cookie.name === "__Host-evelyn-test");
    ensure(response.headers()["content-type"]?.includes("application/json"), "EVELYN_JSON_REQUIRED");
    const result = { status: response.status(), body: await response.json() };
    record("evelyn-owner", path, method, result);
    return result;
  }
  try {
    browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
    context.setDefaultTimeout(30000);
    // Inject protection only after exact-origin validation; no third-party telemetry or secret-bearing redirects.
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (["data:", "blob:"].includes(url.protocol)) return route.continue();
      if (url.origin !== crmOrigin) return route.abort();
      return route.continue({ headers: { ...route.request().headers(), ...crmHeaders } });
    });
    await context.addInitScript(() => localStorage.setItem("novalure-crm-navigation-preset-v1", "realEstateBroker"));
    const page = await context.newPage();
    let pageErrors = 0;
    page.on("pageerror", () => { pageErrors++; });
    async function crmCall(path, body, method = "POST", metadata = {}) {
      endpoint(crmOrigin, path);
      const key = metadata.idempotencyKey ?? randomUUID(), correlationId = metadata.correlationId ?? randomUUID();
      const result = await page.evaluate(async ({ path, body, method, key, correlationId }) => {
        const headers = { "content-type": "application/json", "Idempotency-Key": key, "X-Correlation-Id": correlationId };
        if (method !== "GET") {
          const csrf = await fetch("/api/auth/csrf?" + new URLSearchParams({ method, path: path.split("?")[0] }), { redirect: "error", signal: AbortSignal.timeout(30000) });
          const token = await csrf.json();
          if (!csrf.ok || typeof token.csrfToken !== "string") return { status: csrf.status, body: { code: "CSRF_UNAVAILABLE" } };
          headers["x-novalure-csrf-token"] = token.csrfToken;
        }
        const response = await fetch(path, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
          redirect: "error", signal: AbortSignal.timeout(30000) });
        if (!response.headers.get("content-type")?.includes("application/json")) return { status: response.status, body: { code: "NON_JSON_RESPONSE" } };
        return { status: response.status, body: await response.json() };
      }, { path, body, method, key, correlationId });
      record("crm", path, method, result, correlationId);
      return result;
    }
    const api = async (path, body, method = "POST", metadata = {}) => successful(await crmCall(path, body, method, metadata), "CRM");
    const get = path => api(path, undefined, "GET");
    await step("exact-origin CRM Preview deployment-protection access", async () => {
      if (crmProtectionUrl) {
        await page.goto(crmProtectionUrl, { waitUntil: "domcontentloaded" });
        ensure(new URL(page.url()).origin === crmOrigin, "CRM_PROTECTION_REDIRECT_DENIED");
      }
      const response = await page.goto(crmOrigin + "/login?lang=de", { waitUntil: "domcontentloaded" });
      ensure(response?.ok() && new URL(page.url()).origin === crmOrigin, "CRM_PROTECTION_DENIED");
      await expect(page.locator("#login-email")).toBeVisible();
    });
    await step("actual CRM browser password and MFA authentication", async () => {
      await page.goto(crmOrigin + "/login?lang=de", { waitUntil: "domcontentloaded" });
      await page.locator("#login-email").fill(fixture.email);
      await page.locator("#login-password").fill(fixture.password);
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
      await expect(page.locator("#login-mfa-code")).toBeVisible();
      let totpSecret;
      if (await page.locator("input[name=recoveryCodesSaved]").count()) {
        const key = page.locator("p").filter({ has: page.locator("strong", { hasText: "TOTP-Schlüssel:" }) }).locator("code");
        totpSecret = (await key.innerText()).trim();
        ensure(/^[A-Z2-7]{16,}$/.test(totpSecret), "UI_ENROLLMENT_KEY_REQUIRED");
        const recoveryCodes = await page.locator("form:has(#login-mfa-code) li code").allTextContents();
        ensure(recoveryCodes.length > 0, "RECOVERY_CODES_REQUIRED");
        await writeFile(paths.private, JSON.stringify({ workspaceId: fixture.workspaceId, email: fixture.email, totpSecret, recoveryCodes }), { mode: 0o600 });
        await page.locator("input[name=recoveryCodesSaved]").check();
      } else {
        const prior = JSON.parse(await readFile(paths.private, "utf8"));
        ensure(prior.workspaceId === fixture.workspaceId && prior.email === fixture.email, "PRIOR_MFA_FIXTURE_MISMATCH");
        totpSecret = prior.totpSecret;
      }
      await page.locator("#login-mfa-code").fill(authenticatorCode(totpSecret));
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: "Sicher bestätigen", exact: true }).click()]);
      await expect(page).not.toHaveURL(/\/login/);
      const session = (await context.cookies()).find(cookie => cookie.name === "novalure_session");
      ensure(session?.httpOnly && session.secure && session.value.startsWith("v2."), "REAL_SERVER_MFA_SESSION_REQUIRED");
      const core = await get("/api/crm/core");
      ensure(core.activeWorkspaceId === fixture.workspaceId && core.source === "database", "AUTHENTICATED_QA_WORKSPACE_REQUIRED");
    });
    await step("separate Evelyn Test-Owner authentication", async () => {
      ownerContext = await playwrightRequest.newContext({ timeout: 30000 });
      if (ownerProtectionUrl) {
        let next = ownerProtectionUrl;
        for (let index = 0; index < 5; index++) {
          ensure(new URL(next).origin === EVELYN, "OWNER_PROTECTION_REDIRECT_DENIED");
          const response = await ownerContext.get(next, { headers: ownerHeaders, maxRedirects: 0 });
          if (response.status() >= 300 && response.status() < 400) {
            const location = response.headers().location; ensure(location, "OWNER_PROTECTION_LOCATION_REQUIRED");
            next = new URL(location, next).href;
            ensure(new URL(next).origin === EVELYN && index < 4, "OWNER_PROTECTION_REDIRECT_DENIED");
          } else { ensure(response.ok(), "OWNER_PROTECTION_DENIED"); break; }
        }
      }
      const login = successful(await owner("/api/login", { identity: "owner", password: access.evelyn.ownerPassword }), "OWNER_LOGIN");
      ensure(login.role === "OWNER" && typeof login.csrf === "string" && ownerCookie, "OWNER_SESSION_REQUIRED"); ownerCsrf = login.csrf;
    });
    const run = randomUUID().slice(0, 8);
    async function offerFlow(label, accepted) {
      const contact = (await api("/api/crm/contacts", { contact: { name: `SYNTHETIC ${label} ${run}`,
        email: `g08-${label}-${run}@example.invalid`, role: "Bauträger", source: "Manual", consent: "Opt-in", projectId: fixture.projectId } })).contact;
      const lead = (await api("/api/crm/leads", { lead: { contactId: contact.id, projectId: fixture.projectId, type: "Bauträger", source: "Manual", intent: "SYNTHETIC service inquiry" } })).lead;
      const deal = (await api("/api/crm/deals", { deal: { contactId: contact.id, leadId: lead.id, projectId: fixture.projectId,
        name: `SYNTHETIC ${label} ${run}`, stage: "Neu", value: "20370", expectedCloseDate: "2030-12-31" } })).deal;
      ensure(deal.leadId === lead.id, "LEAD_DEAL_LINK_REQUIRED");
      const view = () => get("/api/crm/offers?dealId=" + deal.id);
      async function command(operation, payload = {}) {
        const current = await view(), metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
        return data(await api("/api/crm/offers", { operation, projectId: fixture.projectId, dealId: deal.id,
          ...(current.offer ? { offerId: current.offer.id } : {}), expectedVersion: current.offer?.version ?? current.dealVersion, payload, ...metadata }, "POST", metadata));
      }
      await command("create", { leadId: lead.id, organizationName: `SYNTHETIC company ${label} ${run}`,
        content: { subject: `SYNTHETIC Novalure ${label} ${run}`, recipientName: contact.name, recipientEmail: contact.email,
          terms: "SYNTHETIC 9900 EUR setup plus three mandatory periods at 3490 EUR, net. No external delivery.",
          validUntil: new Date(Date.now() + 2 * 86400000).toISOString(), currency: "EUR", taxBasis: "NET",
          items: [{ description: "SYNTHETIC Setup", quantity: 1, unitNetCents: 990000 }, { description: "SYNTHETIC Monthly service", quantity: 3, unitNetCents: 349000 }] } });
      let current = (await view()).offer;
      ensure(current.status === "DRAFT" && current.totalNetCents === 2037000, "FULL_NET_OBLIGATION_REQUIRED");
      await command("approve", { revision: current.revision, contentDigest: current.contentDigest, expiresAt: new Date(Date.now() + 3600000).toISOString() });
      await command("queue_send"); current = (await view()).offer;
      await command("record_sent", { revision: current.revision, contentDigest: current.contentDigest, recipientEmail: current.content.recipientEmail,
        reference: `SYNTHETIC manual QA receipt ${run}`, sentAt: new Date().toISOString() });
      ensure((await view()).offer.status === "SENT", "MANUAL_SENT_STATUS_REQUIRED");
      await command("schedule_follow_up", { dueAt: new Date(Date.now() + 86400000).toISOString() });
      ensure((await view()).offer.followUpStatus === "SCHEDULED", "FOLLOWUP_SCHEDULE_REQUIRED");
      current = (await view()).offer;
      await command(accepted ? "accept" : "reject", { revision: current.revision, contentDigest: current.contentDigest,
        reference: `SYNTHETIC customer ${accepted ? "acceptance" : "rejection"} ${run}`, ...(accepted ? {} : { reason: "SYNTHETIC declined" }) });
      current = (await view()).offer;
      ensure(current.status === (accepted ? "ACCEPTED" : "REJECTED") && current.followUpStatus === "STOPPED", "CUSTOMER_OUTCOME_REQUIRED");
      const core = (await get("/api/crm/core")).data;
      ensure(core.deals.find(item => item.id === deal.id)?.stage === (accepted ? "Gewonnen" : "Verloren"), "DEAL_OUTCOME_REQUIRED");
      report.flowA ??= [];
      report.flowA.push({ label, contactId: contact.id, leadId: lead.id, dealId: deal.id, offerId: current.id,
        organizationId: current.organizationId, offerVersion: current.version, revision: current.revision,
        contentDigest: current.contentDigest, approvalReference: current.approvalId, totalNetCents: current.totalNetCents,
        status: current.status, followUpStatus: current.followUpStatus, expectedDealStage: accepted ? "Gewonnen" : "Verloren",
        expectedCompanyLifecycle: accepted ? "Kunde" : "Lead" });
      return { offer: current, contact, lead, deal };
    }
    const accepted = await step("Flow A contact to accepted offer, stopped follow-up and won deal", () => offerFlow("accepted", true));
    await step("Flow A rejected offer stops follow-up and records lost deal", () => offerFlow("rejected", false));
    const mutationOffer = await step("independent accepted synthetic offer for action immutability", () => offerFlow("immutability", true));
    await step("authenticated Flow A UI renders persisted accepted offer outcome", async () => {
      await page.goto(crmOrigin + "/?lang=de&workspaceId=" + fixture.workspaceId + "&projectId=all");
      await page.getByRole("button", { name: "Pipeline", exact: true }).first().click();
      await page.getByRole("button", { name: accepted.deal.name, exact: true }).click();
      const section = page.getByRole("region", { name: "Angebotsablauf", exact: true });
      await expect(section).toBeVisible();
      await expect(section).toContainText("Angenommen · Deal gewonnen · Kunde");
    });
    const commandPath = "/api/crm/evelyn-contracts";
    function envelope(action, operation, extra = {}, key = randomUUID()) {
      return { operation, projectId: fixture.projectId, actionId: action.actionId, expectedVersion: action.actionVersion,
        idempotencyKey: key, correlationId: action.correlationId, ...extra };
    }
    const contract = input => crmCall(commandPath, input, "POST", input);
    async function createAction(offer) {
      const input = { operation: "create", projectId: fixture.projectId, offerId: offer.id, expectedOfferVersion: offer.version,
        idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const result = data(successful(await contract(input), "ACTION_CREATE"));
      ensure(result.amount === 2037000 && result.actionVersion === 1, "CONTRACT_20370_REQUIRED");
      report.actions.push({ actionId: result.actionId, correlationId: result.correlationId, actionVersion: result.actionVersion, actionHash: result.actionHash });
      return result;
    }
    async function ownerRecord(action) {
      const overview = successful(await owner("/api/overview", undefined, "GET"), "OWNER_OVERVIEW");
      const record = overview.approvals.find(item => item.actionId === action.actionId && item.actionVersion === action.actionVersion);
      ensure(record?.registration?.serviceId === "crm-preview" && record.registration.projectId === CRM_PROJECT
        && record.tenantId === fixture.workspaceId && record.environment === "preview" && record.actionHash === action.actionHash
        && record.correlationId === action.correlationId, "REAL_CRM_SOURCE_BINDING_REQUIRED");
      return record;
    }
    async function ownerStep(action, stepNumber) {
      const before = await ownerRecord(action);
      // Step 2's separate reauthentication necessarily follows committed Step 1.
      const reauth = successful(await owner("/api/reauth", { password: access.evelyn.ownerPassword }), "OWNER_REAUTH");
      ensure(reauth.reauthenticated === true, "OWNER_REAUTH_REQUIRED");
      const challenge = successful(await owner("/api/challenge", { approvalId: before.approvalId, step: stepNumber, requestId: randomUUID() }), "OWNER_CHALLENGE");
      ensure(challenge.step === stepNumber && challenge.actionHash === action.actionHash && challenge.actionVersion === action.actionVersion, "CHALLENGE_BINDING_REQUIRED");
      const decision = successful(await owner("/api/decision", { approvalId: before.approvalId, challengeId: challenge.challengeId, decision: "APPROVE", requestId: randomUUID() }), "OWNER_DECISION");
      ensure(decision[`step${stepNumber}`]?.decision === "APPROVE" && decision[`step${stepNumber}`].ownerId === access.evelyn.config.ownerId, "OWNER_DECISION_REQUIRED");
      if (stepNumber === 2) ensure(decision.step1.challengeId !== decision.step2.challengeId && decision.step1.requestId !== decision.step2.requestId, "SEPARATE_OWNER_STEPS_REQUIRED");
      return decision;
    }
    const first = await step("CRM registers immutable full-value contract action", () => createAction(accepted.offer));
    await step("missing approval reference blocks CRM before registration", async () => {
      for (const operation of ["verify", "execute"]) denied(await contract(envelope(first, operation)), ["APPROVAL_REFERENCE_REQUIRED"], "MISSING_REFERENCE");
    });
    let reference;
    await step("real CRM Preview creates Evelyn PENDING request with two required steps and idempotent retry", async () => {
      const request = envelope(first, "request"), response = successful(await contract(request), "APPROVAL_REQUEST");
      const result = data(response); reference = result.approvalReference;
      ensure(result.status === "PENDING" && result.requiredSteps === 2 && result.actionHash === first.actionHash, "TWO_STEP_PENDING_REQUIRED");
      const retry = successful(await contract(request), "APPROVAL_REQUEST_RETRY");
      ensure(data(retry).approvalReference === reference && retry.replayed === true, "DURABLE_REQUEST_RECEIPT_REQUIRED");
      await ownerRecord(first);
      report.actions[0].approvalReference = reference;
    });
    await step("live CRM rejects scope overrides and Evelyn rejects an unknown reference", async () => {
      const base = envelope(first, "verify", { approvalReference: reference });
      for (const extra of [{ tenantId: randomUUID() }, { resourceId: randomUUID() }, { actionHash: "0".repeat(64) }, { environment: "production" }]) {
        denied(await contract({ ...base, ...extra, idempotencyKey: randomUUID() }), ["UNKNOWN_FIELD"], "CLIENT_SCOPE_OVERRIDE");
      }
      denied(await contract({ ...base, projectId: randomUUID(), idempotencyKey: randomUUID() }), ["EVELYN_QA_SCOPE_DENIED"], "FOREIGN_PROJECT");
      denied(await contract(envelope(first, "verify", { approvalReference: randomUUID() })), ["EVELYN_INVALID"], "UNKNOWN_REFERENCE");
    });
    await step("pending approval blocks CRM verification and synthetic execution", async () => {
      for (const operation of ["verify", "execute"]) denied(await contract(envelope(first, operation, { approvalReference: reference })), ["EVELYN_PENDING"], "PENDING");
    });
    await step("separate Test-Owner Step 1 still denies CRM verification", async () => {
      const record = await ownerStep(first, 1); ensure(record.status === "STEP_1_APPROVED", "STEP1_REQUIRED");
      denied(await contract(envelope(first, "verify", { approvalReference: reference })), ["EVELYN_PENDING"], "STEP1");
    });
    await step("separate reauthenticated Test-Owner Step 2 enables fresh CRM Verify", async () => {
      const record = await ownerStep(first, 2); ensure(record.status === "APPROVED", "STEP2_REQUIRED");
      const request = envelope(first, "verify", { approvalReference: reference });
      for (let index = 0; index < 2; index++) ensure(successful(await contract(request), "VERIFY").status === "VALID", "LIVE_VALID_REQUIRED");
    });
    await step("verified synthetic execution has one effect across retries and rejects a new execution identity", async () => {
      const request = envelope(first, "execute", { approvalReference: reference });
      const response = successful(await contract(request), "EXECUTE"), executed = data(response);
      ensure(executed.effect === "SYNTHETIC_CONTRACT_SEND" && executed.externalEffect === false && executed.contractDelivered === false, "SYNTHETIC_ONLY_EFFECT_REQUIRED");
      const retry = successful(await contract(request), "EXECUTE_RETRY");
      ensure(retry.replayed === true && data(retry).id === executed.id, "EXECUTION_RECEIPT_REQUIRED");
      denied(await contract(envelope(first, "execute", { approvalReference: reference })), ["EVELYN_ALREADY_EXECUTED"], "DUPLICATE_EXECUTION");
      denied(await contract({ ...request, approvalReference: randomUUID() }), ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_PAYLOAD_MISMATCH"], "ALTERED_IDEMPOTENCY_PAYLOAD");
      report.actions[0].executionId = executed.id;
    });
    const second = await step("second independent action obtains its own two-step approval", async () => {
      const action = await createAction(mutationOffer.offer);
      const receipt = data(successful(await contract(envelope(action, "request")), "SECOND_REQUEST"));
      ensure(receipt.requiredSteps === 2 && receipt.status === "PENDING", "SECOND_PENDING_REQUIRED");
      action.approvalReference = receipt.approvalReference;
      await ownerStep(action, 1); await ownerStep(action, 2);
      ensure(successful(await contract(envelope(action, "verify", { approvalReference: action.approvalReference })), "SECOND_VERIFY").status === "VALID", "SECOND_VALID_REQUIRED");
      report.actions[1].approvalReference = action.approvalReference;
      return action;
    });
    await step("amount revision invalidates old approval and blocks CRM execution", async () => {
      const revised = data(successful(await contract(envelope(second, "revise", { contractNetCents: 2037100 })), "REVISE"));
      ensure(revised.amount === 2037100 && revised.actionVersion === 2 && revised.actionHash !== second.actionHash, "IMMUTABLE_REVISION_REQUIRED");
      const receipt = data(successful(await contract(envelope(revised, "request")), "REVISION_REQUEST"));
      ensure(receipt.approvalReference !== second.approvalReference && receipt.status === "PENDING", "FRESH_APPROVAL_REQUIRED");
      const overview = successful(await owner("/api/overview", undefined, "GET"), "OVERVIEW");
      ensure(overview.approvals.find(item => item.approvalId === second.approvalReference)?.status === "INVALIDATED", "OLD_APPROVAL_INVALIDATED_REQUIRED");
      denied(await contract(envelope(revised, "verify", { approvalReference: second.approvalReference })), ["EVELYN_VERSION_MISMATCH", "EVELYN_INVALID"], "OLD_REFERENCE_VERIFY");
      denied(await contract(envelope(revised, "execute", { approvalReference: second.approvalReference })), ["APPROVAL_REFERENCE_MISMATCH"], "OLD_REFERENCE_EXECUTE");
      denied(await contract(envelope(revised, "execute", { approvalReference: receipt.approvalReference })), ["EVELYN_PENDING"], "NEW_REFERENCE_PENDING");
      report.actions[1].revised = { actionVersion: 2, actionHash: revised.actionHash, approvalReference: receipt.approvalReference, amount: revised.amount };
    });
    await step("matching cross-system correlation and authenticated CRM project audit", async () => {
      const overview = successful(await owner("/api/overview", undefined, "GET"), "AUDIT_OVERVIEW");
      for (const action of [first, second]) {
        const events = overview.audit.filter(event => event.correlationId === action.correlationId && event.actionId === action.actionId);
        const requested = events.find(event => event.eventType === "ApprovalRequested" && event.actorId === "crm-preview" && event.metadata.serviceProjectId === CRM_PROJECT);
        ensure(requested && events.some(event => event.eventType === "VerificationSucceeded" && event.actorId === "crm-preview")
          && events.some(event => event.eventType === "Step1Approved" && event.actorId === access.evelyn.config.ownerId)
          && events.some(event => event.eventType === "Step2Approved" && event.actorId === access.evelyn.config.ownerId), "CROSS_SYSTEM_AUDIT_REQUIRED");
        report.audit.push({ actionId: action.actionId, correlationId: action.correlationId, serviceId: "crm-preview", sourceProjectId: CRM_PROJECT,
          events: events.map(event => ({ eventId: event.eventId, type: event.eventType, actorId: event.actorId, status: event.status })) });
      }
    });
    await step("Flow B project, unit, buyer qualification, handover, viewing, reservation and sale", async () => {
      const buyer = (await api("/api/crm/contacts", { contact: { name: `SYNTHETIC Buyer ${run}`, email: `g08-buyer-${run}@example.invalid`,
        role: "Käufer", source: "Manual", consent: "Opt-in", projectId: fixture.projectId } })).contact;
      const lead = (await api("/api/crm/leads", { lead: { contactId: buyer.id, projectId: fixture.projectId, type: "Käufer", source: "Manual", intent: "SYNTHETIC apartment inquiry" } })).lead;
      const unit = data(await api("/api/crm/units", { projectId: fixture.projectId, unitNumber: `SYN-G08-${run}`, floor: 1, rooms: 3, areaSqm: 80,
        status: "available", priceCents: 0, idempotencyKey: randomUUID(), correlationId: randomUUID() }));
      const state = async () => data(await get("/api/crm/property-sales?projectId=" + fixture.projectId));
      async function sales(action, payload, expectedVersion) {
        const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
        return data(await api("/api/crm/property-sales", { action, projectId: fixture.projectId, payload,
          ...(expectedVersion === undefined ? {} : { expectedVersion }), ...metadata }, "POST", metadata));
      }
      const before = await state(), existingAuthority = before.authorities.find(item => item.user_id === fixture.userId);
      await sales("authority.assign", { userId: fixture.userId, developerOrganizationId: fixture.developerId, contactId: fixture.developerContactId,
        canConfirmPrice: true, canConfirmReservation: true, canConfirmSale: true, sourceReference: "SYNTHETIC project mandate" }, existingAuthority ? Number(existingAuthority.version) : undefined);
      await sales("unit.price.confirm", { unitId: unit.id, priceCents: 35000000, sourceReference: "SYNTHETIC confirmed sale price" }, Number(unit.version));
      const qualified = await sales("qualification.save", { leadId: lead.id, desiredUnitId: unit.id, budgetFrom: 300000, budgetTo: 400000,
        financingStatus: "vorqualifiziert", purchaseTimeline: "Within six months", useCase: "Eigennutzung", priority: "high", sourceReference: "SYNTHETIC buyer interview" }, Number(lead.version));
      ensure(qualified.record.sales_qualification.priority === "high", "PRIORITY_REQUIRED");
      await sales("handover.create", { leadId: lead.id, recipientUserId: fixture.userId, sourceReference: "SYNTHETIC documented handover" }, Number(qualified.record.version));
      const visit = { unitId: unit.id, leadId: lead.id, ownerUserId: fixture.userId, startsAt: "2030-01-01T10:00:00Z", endsAt: "2030-01-01T11:00:00Z", timeZone: "Europe/Vienna" };
      const viewing = (await sales("viewing.save", { ...visit, status: "planned" })).record;
      const confirmed = (await sales("viewing.save", { ...visit, viewingId: viewing.id, status: "confirmed" }, Number(viewing.version))).record;
      await sales("viewing.save", { ...visit, viewingId: viewing.id, status: "completed" }, Number(confirmed.version));
      let currentUnit = (await state()).units.find(item => item.id === unit.id);
      const reservation = (await sales("reservation.request", { unitId: unit.id, leadId: lead.id, expiresAt: "2030-02-01T12:00:00Z" }, Number(currentUnit.version))).record;
      ensure((await state()).units.find(item => item.id === unit.id).status === "available", "REQUEST_MUST_NOT_RESERVE");
      const reserved = (await sales("reservation.confirm", { reservationId: reservation.id, unitVersion: Number(currentUnit.version), sourceReference: "SYNTHETIC authorized reservation" }, Number(reservation.version))).record;
      currentUnit = (await state()).units.find(item => item.id === unit.id); ensure(currentUnit.status === "reserved", "RESERVED_REQUIRED");
      await sales("sale.confirm", { reservationId: reservation.id, unitVersion: Number(currentUnit.version), sourceReference: "SYNTHETIC authorized sale" }, Number(reserved.version));
      const final = await state();
      ensure(final.project.developer_organization_id === fixture.developerId && final.units.find(item => item.id === unit.id).status === "sold"
        && final.viewings.find(item => item.id === viewing.id).status === "completed"
        && final.reservations.find(item => item.id === reservation.id).status === "converted"
        && final.sales.some(item => item.reservation_id === reservation.id), "FLOW_B_DURABLE_OUTCOME_REQUIRED");
      report.flowB = { projectId: fixture.projectId, buyerLeadId: lead.id, unitId: unit.id, reservationId: reservation.id, status: "sold" };
      await page.goto(crmOrigin + "/?lang=de&workspaceId=" + fixture.workspaceId + "&projectId=all");
      await page.getByRole("button", { name: "Einheiten / Bestand", exact: true }).click();
      const panel = page.locator("#property-sales-workflow"); await expect(panel).toBeVisible();
      await panel.getByLabel("Projekt", { exact: true }).selectOption(fixture.projectId);
      await panel.getByRole("button", { name: "Prozess laden / aktualisieren" }).click();
      await expect(panel).toContainText(`${unit.unitNumber ?? unit.unit_number}: verkauft`);
    });
    await step("authenticated Preview UI has no uncaught browser exceptions", async () => { ensure(pageErrors === 0, "BROWSER_EXCEPTION"); });
    report.status = "PASS";
  } catch {
    report.status = "BLOCKED"; report.failedStep = active;
    console.error("BLOCKED " + active + "; sanitized evidence saved. No raw error or credentials logged.");
    process.exitCode = 1;
  } finally {
    if (ownerCookie && ownerCsrf) { try { await owner("/api/logout", {}); } catch { report.ownerLogout = "UNVERIFIED"; } }
    await ownerContext?.dispose(); await context?.close(); await browser?.close(); report.finishedAt = new Date().toISOString(); await save();
  }
}

await main().catch(() => { console.error("LIVE_RUNNER_PRECONDITION_FAILED; inspect private configuration without logging secrets."); process.exitCode = 1; });
