#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

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

const baseUrl = (process.env.NOVALURE_QA_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const loginEmail = process.env.NOVALURE_QA_EMAIL || process.env.QA_LOGIN_EMAIL || "franz@novalure.local";
const loginPassword =
  process.env.NOVALURE_QA_PASSWORD ||
  process.env.QA_LOGIN_PASSWORD ||
  process.env.NOVALURE_LOGIN_PASSCODE ||
  "";

if (!loginPassword) {
  console.error("Missing QA password. Set NOVALURE_QA_PASSWORD or QA_LOGIN_PASSWORD.");
  process.exit(1);
}

const cookies = new Map();
const createdContactIds = new Set();
const archivedContactIds = new Set();
let createdForm = null;

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=[^;,]+=)/g);
}

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

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const init = {
    headers,
    method: options.method ?? "GET",
    redirect: options.redirect ?? "manual",
  };

  if (options.auth !== false && cookies.size > 0) headers.set("cookie", cookieHeader());
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
  const text = !json && contentType.includes("text/") ? await response.text().catch(() => "") : "";
  return { json, response, text };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

async function login() {
  const form = new URLSearchParams({ email: loginEmail, password: loginPassword, returnTo: "/" });
  const { response } = await request("/api/auth/login", {
    auth: false,
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert([302, 303, 307, 308].includes(response.status), "login redirects after valid credentials");
  assert(cookies.has("novalure_session"), "login creates a session cookie");
}

async function logout() {
  await request("/api/auth/logout", { method: "POST" });
  cookies.delete("novalure_session");
}

async function getCore() {
  const { json, response } = await request("/api/crm/core");
  assert(response.ok, "/api/crm/core loads");
  return json?.data ?? json;
}

async function archiveContact(contactId) {
  if (!contactId || archivedContactIds.has(contactId)) return;
  const { response } = await request(`/api/crm/contacts?id=${encodeURIComponent(contactId)}`, { method: "DELETE" });
  assert(response.ok, `contact ${contactId} archives`);
  archivedContactIds.add(contactId);
}

async function testDateHandling(timestamp, projectId) {
  const contactResponse = await request("/api/crm/contacts", {
    json: {
      contact: {
        consent: "Nur CRM",
        email: `qa-date-${timestamp}@example.test`,
        intent: "QA date-only",
        name: `QA Date Contact ${timestamp}`,
        phone: `+43 660 ${String(timestamp).slice(-6)}`,
        projectId,
        role: "Kaeufer",
        source: "QA",
      },
    },
    method: "POST",
  });
  assert(contactResponse.response.ok, "date QA contact can be created");
  const contactId = contactResponse.json?.contact?.id;
  createdContactIds.add(contactId);

  const createDeal = await request("/api/crm/deals", {
    json: {
      deal: {
        contactId,
        expectedCloseDate: "2026-06-15",
        name: `QA Date Deal ${timestamp}`,
        nextAction: "Date-only pruefen",
        probability: 45,
        projectId,
        source: "QA",
        stage: "Neu",
        value: "250000",
      },
    },
    method: "POST",
  });
  assert(createDeal.response.ok, "deal with expectedCloseDate 2026-06-15 can be created");
  const dealId = createDeal.json?.deal?.id;
  let core = await getCore();
  assert(
    core.deals.some((deal) => deal.id === dealId && deal.expectedCloseDate === "2026-06-15"),
    "/api/crm/core returns expectedCloseDate 2026-06-15 exactly",
  );

  const editDeal = await request("/api/crm/deals", {
    json: {
      deal: {
        contactId,
        expectedCloseDate: "2026-07-01",
        id: dealId,
        name: `QA Date Deal ${timestamp}`,
        nextAction: "Date-only erneut pruefen",
        probability: 55,
        projectId,
        source: "QA",
        stage: "Qualifizieren",
        value: "260000",
      },
    },
    method: "PATCH",
  });
  assert(editDeal.response.ok, "deal expectedCloseDate can be edited to 2026-07-01");

  await logout();
  await login();
  core = await getCore();
  assert(
    core.deals.some((deal) => deal.id === dealId && deal.expectedCloseDate === "2026-07-01"),
    "expectedCloseDate remains 2026-07-01 after re-login",
  );

  const due = "2026-06-15T09:30:00.000Z";
  const taskResponse = await request("/api/crm/tasks", {
    json: {
      task: {
        contactId,
        due,
        priority: "Mittel",
        projectId,
        status: "open",
        title: `QA Timestamp Task ${timestamp}`,
      },
    },
    method: "POST",
  });
  assert(taskResponse.response.ok, "task with timestamp due date can be created");
  const taskId = taskResponse.json?.task?.id;
  core = await getCore();
  assert(
    core.tasks.some((task) => task.id === taskId && task.due === due),
    "task due timestamp remains an exact timestamp",
  );
}

function buildQaForm(timestamp) {
  const step = { description: "", id: "step_contact", title: "Kontakt" };
  return {
    actions: {
      createTask: true,
      followUpEmail: false,
      internalNotification: true,
      newsletterList: false,
      redirectUrl: "",
      showMeeting: false,
      thankYouMessage: "Danke, wir melden uns in Kuerze.",
    },
    campaign: "QA Livegang",
    conversionRate: 0,
    crmTarget: "lead",
    doubleOptIn: false,
    fields: [
      { crmField: "name", id: "field_name", label: "Name", placeholder: "Name", required: true, stepId: step.id, type: "text" },
      { crmField: "email", id: "field_email", label: "E-Mail", placeholder: "name@example.test", required: true, stepId: step.id, type: "email" },
      { crmField: "phone", id: "field_phone", label: "Telefon", placeholder: "+43", required: false, stepId: step.id, type: "phone" },
      { crmField: "message", id: "field_message", label: "Nachricht", placeholder: "Nachricht", required: true, stepId: step.id, type: "textarea" },
      { crmField: "privacy", helpText: "Datenschutz akzeptieren", id: "field_privacy", label: "Datenschutz", placeholder: "", required: true, stepId: step.id, type: "consent" },
      { crmField: "marketing_consent", helpText: "Marketing akzeptieren", id: "field_marketing", label: "Marketing", placeholder: "", required: false, stepId: step.id, type: "consent" },
    ],
    funnelId: "",
    id: `qa_public_form_${timestamp}`,
    lastSubmission: "",
    name: `QA Public Form ${timestamp}`,
    ownerMode: "roundRobin",
    ownerUserId: "",
    pipelineStage: "Lead Inbox",
    progressMode: "none",
    spamProtection: true,
    status: "aktiv",
    steps: [step],
    submissions: 0,
    tags: "qa, livegang",
    template: "contact",
    utmCapture: true,
    variant: "standalone",
    visits: 0,
  };
}

async function testPublicForms(timestamp) {
  const form = buildQaForm(timestamp);
  const slug = `qa-public-form-${timestamp}`;
  const createResponse = await request("/api/forms", {
    json: { form },
    method: "POST",
  });
  assert(createResponse.response.ok, "QA public form can be saved");
  createdForm = createResponse.json?.form;
  assert(createdForm?.id, "saved public form has a database id");

  const publicPage = await request(`/forms/${slug}`, { auth: false });
  assert(publicPage.response.status === 200, "public form page loads without CRM cookie");
  assert(publicPage.text.includes("QA Public Form"), "public form page renders the persisted form");

  const email = `qa-public-${timestamp}@example.test`;
  const validSubmit = new URLSearchParams({
    email,
    form_slug: slug,
    marketing_consent: "1",
    message: "QA public form submit",
    name: `QA Public Lead ${timestamp}`,
    phone: `+43 677 ${String(timestamp).slice(-6)}`,
    privacy: "1",
    return_to: `/forms/${slug}`,
    utm_source: "qa",
  });
  const submitResponse = await request("/api/forms/submissions", {
    auth: false,
    body: validSubmit,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert(submitResponse.response.ok && submitResponse.json?.persisted === true, "valid public submit persists without CRM cookie");

  let core = await getCore();
  const contact = core.contacts.find((item) => item.email === email);
  assert(contact, "public submit creates a contact");
  createdContactIds.add(contact.id);
  const lead = core.leads.find((item) => item.contactId === contact.id);
  assert(lead, "public submit creates a lead");
  assert(core.tasks.some((task) => task.contactId === contact.id || task.leadId === lead.id), "public submit creates a task");

  const missingConsent = new URLSearchParams({
    email: `qa-public-missing-consent-${timestamp}@example.test`,
    form_slug: slug,
    message: "Missing consent",
    name: "Missing Consent",
    return_to: `/forms/${slug}`,
  });
  const blockedConsent = await request("/api/forms/submissions", {
    auth: false,
    body: missingConsent,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert(blockedConsent.response.status === 422, "public submit without privacy consent is blocked");

  const missingPage = await request("/forms/not-existing-livegang-form", { auth: false });
  assert(missingPage.response.status === 200, "missing public form returns a non-submit page");
  assert(!missingPage.text.includes("data-novalure-runtime=\"form\""), "missing public form does not render a fake form");
  const missingSubmit = await request("/api/forms/submissions", {
    auth: false,
    body: new URLSearchParams({ form_slug: "not-existing-livegang-form", privacy: "1" }),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert(missingSubmit.response.status === 404, "unknown public form submit returns 404");

  createdForm.status = "fehler";
  await request("/api/forms", { json: { form: createdForm }, method: "POST" });
  const archivedPage = await request(`/forms/${slug}`, { auth: false });
  assert(!archivedPage.text.includes("data-novalure-runtime=\"form\""), "archived QA form no longer renders as usable");
}

function ensureLiveReadyBlueprint(blueprint, funnelId, projectId, timestamp) {
  const copy = JSON.parse(JSON.stringify(blueprint));
  copy.id = funnelId;
  copy.name = copy.name || `QA Funnel ${timestamp}`;
  copy.projectId = projectId;
  copy.status = "entwurf";
  copy.crmHandover = {
    ...copy.crmHandover,
    createLeadInboxEntry: true,
    createTask: true,
    destination: "leadInbox",
    followUp: copy.crmHandover?.followUp || "QA Funnel Lead pruefen",
    pipelineStage: copy.crmHandover?.pipelineStage || "Lead Inbox",
  };

  const formElement = copy.pages
    ?.flatMap((page) => page.sections ?? [])
    .flatMap((section) => section.columns ?? [])
    .flatMap((column) => column.elements ?? [])
    .find((element) => element.type === "form");
  if (formElement) {
    formElement.fields = Array.isArray(formElement.fields) ? formElement.fields : [];
    if (!formElement.fields.some((field) => String(field.crmField ?? "").toLowerCase().includes("email"))) {
      formElement.fields.push({ crmField: "email", id: `qa_email_${timestamp}`, label: "E-Mail", required: true, type: "email" });
    }
    if (!formElement.fields.some((field) => String(field.crmField ?? field.label ?? "").toLowerCase().includes("privacy"))) {
      formElement.fields.push({ crmField: "privacy", helpText: "Datenschutz akzeptieren", id: `qa_privacy_${timestamp}`, label: "Datenschutz", required: true, type: "consent" });
    }
  }

  return copy;
}

async function testFunnelLive(timestamp, projectId) {
  const core = await getCore();
  const funnelId = core.funnels?.[0]?.id;
  assert(funnelId, "core exposes a funnel for QA");

  const blueprintResponse = await request(`/api/funnels/${encodeURIComponent(funnelId)}/blueprint`);
  assert(blueprintResponse.response.ok, "funnel blueprint loads");
  let blueprint = ensureLiveReadyBlueprint(blueprintResponse.json.blueprint, funnelId, projectId, timestamp);

  const saveDraft = await request(`/api/funnels/${encodeURIComponent(funnelId)}/blueprint`, {
    json: { blueprint, label: `QA livegang draft ${timestamp}` },
    method: "PUT",
  });
  assert(saveDraft.response.ok, "QA funnel blueprint saves as draft");

  const testEmail = `qa-funnel-test-${timestamp}@example.test`;
  const testPayload = {
    answers: { email: testEmail, name: `QA Funnel Test ${timestamp}`, phone: "+43 660 000000" },
    consent: { analytics: true, marketing: false, privacy: true },
    funnelId,
    mode: "test",
    visitor: { id: `qa-test-${timestamp}`, sourceUrl: `${baseUrl}/preview/${funnelId}` },
  };
  const testSubmit = await request(`/api/funnels/${encodeURIComponent(funnelId)}/submissions`, {
    json: testPayload,
    method: "POST",
  });
  assert(testSubmit.response.ok && testSubmit.json?.persisted === true && testSubmit.json?.mode === "test", "funnel test submit persists as test");
  let afterTestCore = await getCore();
  assert(!afterTestCore.contacts.some((contact) => contact.email === testEmail), "funnel test submit creates no productive contact");
  assert(!afterTestCore.leads.some((lead) => JSON.stringify(lead).includes(testEmail)), "funnel test submit creates no productive lead");

  const blockedLive = await request(`/api/funnels/${encodeURIComponent(funnelId)}/submissions?token=wrong`, {
    auth: false,
    json: { ...testPayload, mode: "live" },
    method: "POST",
  });
  assert(blockedLive.response.status === 403, "inactive funnel live submit with wrong token is blocked");

  const noConsent = await request(`/api/funnels/${encodeURIComponent(funnelId)}/submissions`, {
    auth: false,
    json: { ...testPayload, consent: { analytics: true, marketing: false, privacy: false }, mode: "live" },
    method: "POST",
  });
  assert(noConsent.response.status === 422, "funnel live submit without privacy consent is blocked");

  blueprint = { ...blueprint, status: "aktiv" };
  const activate = await request(`/api/funnels/${encodeURIComponent(funnelId)}/blueprint`, {
    json: { blueprint, label: `QA livegang active ${timestamp}` },
    method: "PUT",
  });
  assert(activate.response.ok, "QA funnel can be activated after preflight");

  const liveEmail = `qa-funnel-live-${timestamp}@example.test`;
  const liveSubmit = await request(`/api/funnels/${encodeURIComponent(funnelId)}/submissions`, {
    auth: false,
    json: {
      ...testPayload,
      answers: { email: liveEmail, name: `QA Funnel Live ${timestamp}`, phone: "+43 660 111111" },
      mode: "live",
      visitor: { id: `qa-live-${timestamp}`, sourceUrl: `${baseUrl}/preview/${funnelId}?mode=live` },
    },
    method: "POST",
  });
  assert(liveSubmit.response.ok && liveSubmit.json?.persisted === true && liveSubmit.json?.mode === "live", "active funnel live submit persists");

  await logout();
  await login();
  const afterLiveCore = await getCore();
  const contact = afterLiveCore.contacts.find((item) => item.email === liveEmail);
  assert(contact, "funnel live submit creates a contact visible after re-login");
  createdContactIds.add(contact.id);
  const lead = afterLiveCore.leads.find((item) => item.contactId === contact.id);
  assert(lead, "funnel live submit creates a lead");
  assert(afterLiveCore.tasks.some((task) => task.contactId === contact.id || task.leadId === lead.id), "funnel live submit creates a task");
}

async function main() {
  const timestamp = Date.now();
  await login();
  const core = await getCore();
  const projectId = core.projects?.[0]?.id;
  assert(projectId, "core exposes a project for QA");

  try {
    await testDateHandling(timestamp, projectId);
    await testPublicForms(timestamp);
    await testFunnelLive(timestamp, projectId);
  } finally {
    for (const contactId of createdContactIds) {
      await archiveContact(contactId).catch((error) => console.warn(`WARN contact cleanup failed: ${error.message}`));
    }
    await logout().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
