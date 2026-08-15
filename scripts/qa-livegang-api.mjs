#!/usr/bin/env node
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { assertQaTarget } from "./qa-target-guard.mjs";

const defaultQaPassword = "QA-Novalure-Local-2026!";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(".env.local");
loadEnv(".env.production.local");

const qaTarget = await assertQaTarget();
const qaRunSlug = qaTarget.runPrefix.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

function qaEmail(localPart) {
  return `${localPart}+${qaRunSlug}@novalure.local`;
}

const baseUrl = (process.env.NOVALURE_QA_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const trustedOrigin = new URL(baseUrl).origin;
const configuredQaPassword = process.env.NOVALURE_QA_PASSWORD || process.env.NOVALURE_QA_SEED_PASSWORD;
if (!configuredQaPassword && process.env.CI) throw new Error("NOVALURE_QA_PASSWORD is required in CI.");
const qaPassword = configuredQaPassword || defaultQaPassword;

const users = {
  admin: qaEmail("qa-platform-admin"),
  assistant: qaEmail("qa-assistant"),
  broker: qaEmail("qa-broker-sales"),
  developer: qaEmail("qa-developer-sales"),
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=[^;,]+=)/g);
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.toUpperCase().replace(/=+$/g, "").replace(/[\s-]/g, "");
  let bits = 0;
  let buffer = 0;
  const decoded = [];

  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((buffer >>> bits) & 255);
    }
  }

  return Buffer.from(decoded);
}

function createTotpCode(secret, now = Date.now()) {
  const decoded = decodeBase32(secret);
  if (!decoded) return null;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", decoded).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(binary % 1_000_000).padStart(6, "0");
}

function createClient(email) {
  const cookies = new Map();

  function storeCookies(headers) {
    const values =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : splitSetCookie(headers.get("set-cookie"));

    for (const value of values) {
      const [cookie] = value.split(";");
      const separator = cookie.indexOf("=");
      if (separator === -1) continue;
      const name = cookie.slice(0, separator).trim();
      const cookieValue = cookie.slice(separator + 1).trim();
      if (!cookieValue) cookies.delete(name);
      else cookies.set(name, cookieValue);
    }
  }

  function cookieHeader() {
    return Array.from(cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async function getCsrfToken(method, path) {
    const target = new URL(path, baseUrl);
    const params = new URLSearchParams({ method, path: target.pathname });
    const response = await fetch(`${baseUrl}/api/auth/csrf?${params.toString()}`, {
      headers: {
        accept: "application/json",
        cookie: cookieHeader(),
        origin: trustedOrigin,
        "sec-fetch-site": "same-origin",
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || typeof payload?.csrfToken !== "string") {
      throw new Error(`CSRF token request failed with ${response.status}`);
    }
    return payload.csrfToken;
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    if (options.auth !== false && cookies.size > 0) headers.set("cookie", cookieHeader());
    const method = (options.method ?? "GET").toUpperCase();
    if (["DELETE", "PATCH", "POST", "PUT"].includes(method) && options.auth !== false && cookies.has("novalure_session")) {
      headers.set("origin", trustedOrigin);
      headers.set("sec-fetch-site", "same-origin");
      headers.set("x-novalure-csrf-token", await getCsrfToken(method, path));
    }
    const init = {
      headers,
      method,
      redirect: options.redirect ?? "manual",
    };

    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
      init.body = options.body;
    }

    const response = await fetch(`${baseUrl}${path}`, init);
    storeCookies(response.headers);
    const contentType = response.headers.get("content-type") ?? "";
    const json = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
    const text = !json ? await response.text().catch(() => "") : "";
    return { json, response, text };
  }

  async function login() {
    cookies.clear();
    const body = new URLSearchParams({ email, password: qaPassword, returnTo: "/" });
    const { response } = await request("/api/auth/login", {
      auth: false,
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: trustedOrigin,
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
    });
    assert(
      [302, 303, 307, 308].includes(response.status),
      `${email} login redirects (received HTTP ${response.status})`,
    );

    if (!cookies.has("novalure_session")) {
      const redirectLocation = response.headers.get("location") ?? "";
      const challengeKind = new URL(redirectLocation, baseUrl).searchParams.get("step");
      assert(challengeKind === "mfa_enrollment", `${email} receives the expected MFA enrollment challenge`);
      assert(cookies.has("novalure_login_challenge"), `${email} receives login challenge cookie`);

      const challengePage = await request(redirectLocation || "/login");
      assert(challengePage.response.ok, `${email} can load MFA enrollment challenge`);
      const secret = challengePage.text.match(/<code>([A-Z2-7]{32})<\/code>/)?.[1] ?? null;
      const code = secret ? createTotpCode(secret) : null;
      assert(Boolean(code), `${email} MFA enrollment exposes a valid TOTP secret`);

      const challengeBody = new URLSearchParams({
        code,
        flow: "challenge",
        recoveryCodesSaved: "1",
        returnTo: "/",
      });
      const challengeResponse = await request("/api/auth/login", {
        body: challengeBody,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: trustedOrigin,
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      });
      assert(
        [302, 303, 307, 308].includes(challengeResponse.response.status),
        `${email} MFA enrollment redirects (received HTTP ${challengeResponse.response.status})`,
      );
    }

    assert(cookies.has("novalure_session"), `${email} receives session cookie`);
  }

  return { email, login, request };
}

function workspaceByName(workspaces, needle) {
  return workspaces.find((workspace) => String(workspace.name ?? "").includes(needle));
}

async function getWorkspaces(client) {
  const { json, response } = await client.request("/api/workspaces");
  assert(response.ok, `${client.email} can load /api/workspaces`);
  return json?.workspaces ?? [];
}

async function getCore(client, workspaceId) {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const { json, response } = await client.request(`/api/crm/core${query}`);
  assert(response.ok, `${client.email} can load /api/crm/core${workspaceId ? " for switched workspace" : ""}`);
  return json?.data ?? json;
}

function assertOnlyWorkspace(core, workspaceId, label) {
  for (const key of [
    "projects",
    "contacts",
    "leads",
    "deals",
    "tasks",
    "crmPipelines",
    "crmPipelineStages",
    "projectPipelinePermissions",
  ]) {
    const records = core[key] ?? [];
    assert(records.every((record) => record.workspaceId === workspaceId), `${label} ${key} stay inside workspace`);
  }
}

function qaProject(core) {
  const project = (core.projects ?? []).find((item) => String(item.name ?? "").startsWith("QA "));
  assert(project, "QA project exists in core data");
  return project;
}

function qaStages(core, projectId) {
  const stages = (core.crmPipelineStages ?? []).filter((stage) => stage.projectId === projectId);
  assert(stages.length > 1, "DB pipeline stages exist for QA project");
  return stages.sort((a, b) => a.position - b.position);
}

function qaLostStage(stages) {
  const stage = stages.find((item) => item.name === "Verloren") ?? stages.find((item) => String(item.category).toLowerCase() === "lost");
  assert(stage, "lost DB stage exists");
  return stage;
}

async function createContact(client, workspaceId, projectId, name) {
  const { json, response } = await client.request(`/api/crm/contacts?workspaceId=${encodeURIComponent(workspaceId)}`, {
    json: {
      contact: {
        consent: "Nur CRM",
        email: `${Date.now()}-${Math.random().toString(16).slice(2)}@qa.novalure.local`,
        intent: "QA Livegang API Kontakt",
        name,
        phone: "+43 660 111111",
        projectId,
        role: "K\u00e4ufer",
        source: "Manual",
      },
    },
    method: "POST",
  });
  assert(response.ok, `${name} contact can be created`);
  assert(json?.contact?.workspaceId === workspaceId, `${name} contact persisted in requested effective workspace`);
  return json.contact;
}

async function createDeal(client, workspaceId, projectId, contactId, stage, name) {
  const { json, response } = await client.request(`/api/crm/deals?workspaceId=${encodeURIComponent(workspaceId)}`, {
    json: {
      deal: {
        contactId,
        expectedCloseDate: "2026-08-15",
        name,
        nextAction: "QA Livegang Pipeline pruefen",
        probability: 41,
        projectId,
        riskLevel: "mittel",
        source: "Manual",
        stage,
        value: "510000",
      },
    },
    method: "POST",
  });
  assert(response.ok, `${name} deal can be created`);
  assert(json?.deal?.workspaceId === workspaceId, `${name} deal persisted in requested effective workspace`);
  return json.deal;
}

async function main() {
  const admin = createClient(users.admin);
  const broker = createClient(users.broker);
  const developer = createClient(users.developer);
  const assistant = createClient(users.assistant);

  await admin.login();
  const adminWorkspaces = await getWorkspaces(admin);
  const internalWorkspace = workspaceByName(adminWorkspaces, "QA Novalure Internal");
  const developerWorkspace = workspaceByName(adminWorkspaces, "QA Bautr");
  const brokerWorkspace = workspaceByName(adminWorkspaces, "QA Makler");

  assert(adminWorkspaces.length >= 3, "platform admin sees multiple workspaces");
  assert(internalWorkspace && developerWorkspace && brokerWorkspace, "platform admin sees all QA workspaces");

  const developerCoreFromAdmin = await getCore(admin, developerWorkspace.id);
  const brokerCoreFromAdmin = await getCore(admin, brokerWorkspace.id);
  assertOnlyWorkspace(developerCoreFromAdmin, developerWorkspace.id, "admin developer switch");
  assertOnlyWorkspace(brokerCoreFromAdmin, brokerWorkspace.id, "admin broker switch");
  assert(
    !(developerCoreFromAdmin.contacts ?? []).some((contact) => contact.workspaceId === brokerWorkspace.id),
    "broker contacts do not appear in developer core",
  );
  assert(
    !(brokerCoreFromAdmin.deals ?? []).some((deal) => deal.workspaceId === developerWorkspace.id),
    "developer deals do not appear in broker core",
  );
  assert(
    !(brokerCoreFromAdmin.tasks ?? []).some((task) => task.workspaceId === developerWorkspace.id),
    "developer tasks do not appear in broker core",
  );

  await broker.login();
  const brokerWorkspaces = await getWorkspaces(broker);
  assert(brokerWorkspaces.length === 1 && brokerWorkspaces[0].id === brokerWorkspace.id, "broker user sees only broker workspace");
  const brokerForbiddenCore = await broker.request(`/api/crm/core?workspaceId=${encodeURIComponent(developerWorkspace.id)}`);
  assert(brokerForbiddenCore.response.status === 403, "broker user cannot load developer workspace by workspaceId");
  const brokerCore = await getCore(broker);
  assertOnlyWorkspace(brokerCore, brokerWorkspace.id, "broker default core");

  await developer.login();
  const developerWorkspaces = await getWorkspaces(developer);
  assert(
    developerWorkspaces.length === 1 && developerWorkspaces[0].id === developerWorkspace.id,
    "developer user sees only developer workspace",
  );
  const developerForbiddenCore = await developer.request(`/api/crm/core?workspaceId=${encodeURIComponent(brokerWorkspace.id)}`);
  assert(developerForbiddenCore.response.status === 403, "developer user cannot load broker workspace by workspaceId");
  const developerCore = await getCore(developer);
  assertOnlyWorkspace(developerCore, developerWorkspace.id, "developer default core");

  await assistant.login();
  const assistantWorkspaces = await getWorkspaces(assistant);
  assert(assistantWorkspaces.length === 1 && assistantWorkspaces[0].id === internalWorkspace.id, "assistant sees only own internal workspace");
  const assistantForbiddenCore = await assistant.request(`/api/crm/core?workspaceId=${encodeURIComponent(brokerWorkspace.id)}`);
  assert(assistantForbiddenCore.response.status === 403, "assistant without internal switch capability cannot switch workspaces");

  await broker.login();
  const brokerProject = qaProject(brokerCore);
  const brokerStages = qaStages(brokerCore, brokerProject.id);
  const foreignPayloadContact = await broker.request("/api/crm/contacts", {
    json: {
      contact: {
        consent: "Nur CRM",
        email: `qa-foreign-payload-${Date.now()}@novalure.local`,
        intent: "QA foreign workspace payload",
        name: "QA Foreign Workspace Payload Contact",
        phone: "+43 660 222222",
        projectId: brokerProject.id,
        role: "K\u00e4ufer",
        source: "Manual",
        workspaceId: developerWorkspace.id,
      },
    },
    method: "POST",
  });
  assert(foreignPayloadContact.response.ok, "client contact payload with foreign workspaceId is accepted only in session scope");
  assert(foreignPayloadContact.json?.contact?.workspaceId === brokerWorkspace.id, "foreign contact workspaceId payload is ignored");

  const foreignPayloadDeal = await broker.request("/api/crm/deals", {
    json: {
      deal: {
        contactId: foreignPayloadContact.json.contact.id,
        expectedCloseDate: "2026-08-20",
        name: "QA Foreign Workspace Payload Deal",
        nextAction: "QA payload isolation pruefen",
        probability: 52,
        projectId: brokerProject.id,
        source: "Manual",
        stage: brokerStages[0].name,
        value: "320000",
        workspaceId: developerWorkspace.id,
      },
    },
    method: "POST",
  });
  assert(foreignPayloadDeal.response.ok, "client deal payload with foreign workspaceId is accepted only in session scope");
  assert(foreignPayloadDeal.json?.deal?.workspaceId === brokerWorkspace.id, "foreign deal workspaceId payload is ignored");

  await admin.login();
  const refreshedBrokerCore = await getCore(admin, brokerWorkspace.id);
  const refreshedBrokerProject = qaProject(refreshedBrokerCore);
  const refreshedBrokerStages = qaStages(refreshedBrokerCore, refreshedBrokerProject.id);
  const firstStage = refreshedBrokerStages[0].name;
  const secondStage = refreshedBrokerStages[1].name;
  const lostStage = qaLostStage(refreshedBrokerStages).name;

  assert((refreshedBrokerCore.crmPipelines ?? []).length > 0, "crmPipelines are returned from /api/crm/core");
  assert((refreshedBrokerCore.crmPipelineStages ?? []).length > 0, "crmPipelineStages are returned from /api/crm/core");
  assert(
    (refreshedBrokerCore.projectPipelinePermissions ?? []).some(
      (permission) =>
        permission.workspaceId === brokerWorkspace.id &&
        permission.projectId === refreshedBrokerProject.id &&
        permission.canMoveDeals === true &&
        permission.canCloseDeals === true &&
        permission.canReopenDeals === false,
    ),
    "projectPipelinePermissions are returned with granular rights from /api/crm/core",
  );

  const contact = await createContact(
    admin,
    brokerWorkspace.id,
    refreshedBrokerProject.id,
    `QA Pipeline API Contact ${Date.now()}`,
  );
  const deal = await createDeal(
    admin,
    brokerWorkspace.id,
    refreshedBrokerProject.id,
    contact.id,
    firstStage,
    `QA Pipeline API Deal ${Date.now()}`,
  );

  const moveResponse = await admin.request(
    `/api/crm/deals/${encodeURIComponent(deal.id)}/stage?workspaceId=${encodeURIComponent(brokerWorkspace.id)}`,
    {
      json: { toStage: secondStage },
      method: "POST",
    },
  );
  assert(moveResponse.response.ok, "admin can move QA deal to next DB stage");
  assert(moveResponse.json?.history?.fromStage === firstStage, "stage history stores fromStage");
  assert(moveResponse.json?.history?.toStage === secondStage, "stage history stores toStage");
  assert(
    moveResponse.json?.history?.changedByName === "QA Platform Admin" || moveResponse.json?.history?.changedByUserId,
    "stage history stores changedBy",
  );

  const historyResponse = await admin.request(
    `/api/crm/deals/${encodeURIComponent(deal.id)}/stage-history?workspaceId=${encodeURIComponent(brokerWorkspace.id)}`,
  );
  assert(historyResponse.response.ok, "stage history endpoint loads");
  assert(
    (historyResponse.json?.history ?? []).some((entry) => entry.fromStage === firstStage && entry.toStage === secondStage),
    "stage history endpoint contains stage move",
  );

  const editedDealResponse = await admin.request(`/api/crm/deals?workspaceId=${encodeURIComponent(brokerWorkspace.id)}`, {
    json: {
      deal: {
        contactId: contact.id,
        expectedCloseDate: "2026-08-20",
        id: deal.id,
        name: deal.name,
        nextAction: "QA Vertrag pruefen und Rueckruf planen",
        probability: 64,
        projectId: refreshedBrokerProject.id,
        riskLevel: "hoch",
        source: "Manual",
        stage: secondStage,
        value: "777000",
      },
    },
    method: "PATCH",
  });
  assert(editedDealResponse.response.ok, "deal detail fields can be edited");

  const reloadedBrokerCore = await getCore(admin, brokerWorkspace.id);
  const reloadedDeal = (reloadedBrokerCore.deals ?? []).find((item) => item.id === deal.id);
  assert(reloadedDeal?.stage === secondStage, "deal stage persists after reload");
  assert(String(reloadedDeal?.value ?? "").includes("777"), "deal value persists after reload");
  assert(reloadedDeal?.probability === 64, "deal probability persists after reload");
  assert(reloadedDeal?.riskLevel === "hoch", "deal risk persists after reload");
  assert(reloadedDeal?.nextAction === "QA Vertrag pruefen und Rueckruf planen", "deal next action persists after reload");
  assert(reloadedDeal?.expectedCloseDate === "2026-08-20", "deal expected close date persists after reload");

  const lostWithoutReason = await admin.request(
    `/api/crm/deals/${encodeURIComponent(deal.id)}/stage?workspaceId=${encodeURIComponent(brokerWorkspace.id)}`,
    {
      json: { toStage: lostStage },
      method: "POST",
    },
  );
  assert(!lostWithoutReason.response.ok, "lost stage without reason is rejected");

  const lostWithReason = await admin.request(
    `/api/crm/deals/${encodeURIComponent(deal.id)}/stage?workspaceId=${encodeURIComponent(brokerWorkspace.id)}`,
    {
      json: {
        reason: "QA Timing passt nicht",
        reasonCategory: "timing",
        reasonDetail: "QA Kunde moechte erst spaeter verkaufen",
        toStage: lostStage,
      },
      method: "POST",
    },
  );
  assert(lostWithReason.response.ok, "lost stage with structured reason succeeds");

  await broker.login();
  const unauthorizedReopen = await broker.request(`/api/crm/deals/${encodeURIComponent(deal.id)}/stage`, {
    json: { toStage: secondStage },
    method: "POST",
  });
  assert(unauthorizedReopen.response.status === 403, "broker agent without reopen permission cannot reopen terminal deal");

  await admin.login();
  const adminReopen = await admin.request(
    `/api/crm/deals/${encodeURIComponent(deal.id)}/stage?workspaceId=${encodeURIComponent(brokerWorkspace.id)}`,
    {
      json: { toStage: secondStage },
      method: "POST",
    },
  );
  assert(adminReopen.response.ok, "platform admin can reopen terminal deal");

  await broker.login();
  const developerDeal = (developerCoreFromAdmin.deals ?? []).find((item) => String(item.name ?? "").startsWith("QA "));
  assert(developerDeal, "developer QA deal exists for foreign workspace mutation test");
  const foreignDealMutation = await broker.request(`/api/crm/deals/${encodeURIComponent(developerDeal.id)}/stage`, {
    json: { toStage: firstStage },
    method: "POST",
  });
  assert([403, 404].includes(foreignDealMutation.response.status), "broker cannot mutate a developer workspace deal");

  await admin.login();
  const analyticsResponse = await admin.request(
    `/api/crm/analytics-events?workspaceId=${encodeURIComponent(brokerWorkspace.id)}&eventTypes=deal_created,deal_stage_changed,deal_lost&limit=100`,
  );
  assert(analyticsResponse.response.ok, "admin can load switched analytics events");
  const events = analyticsResponse.json?.events ?? [];
  assert(events.some((event) => event.dealId === deal.id && event.eventType === "deal_created"), "deal_created analytics event exists");
  assert(
    events.some((event) => event.dealId === deal.id && event.eventType === "deal_stage_changed"),
    "deal_stage_changed analytics event exists",
  );
  assert(events.some((event) => event.dealId === deal.id && event.eventType === "deal_lost"), "deal_lost analytics event exists");

  console.log("QA Livegang API checks complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
