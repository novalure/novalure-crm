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
    let value = trimmed.slice(separator + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
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
  console.error(
    "Missing QA password. Set NOVALURE_QA_PASSWORD or QA_LOGIN_PASSWORD. Plain NOVALURE_LOGIN_PASSCODE is used only when available locally.",
  );
  process.exit(1);
}

const cookies = new Map();
const createdContactIds = new Set();
const archivedContactIds = new Set();

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
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const init = {
    method: options.method ?? "GET",
    redirect: options.redirect ?? "manual",
    headers,
  };

  if (options.auth !== false && cookies.size > 0) {
    headers.set("cookie", cookieHeader());
  }

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

  return { json, response };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

async function login() {
  const form = new URLSearchParams({
    email: loginEmail,
    password: loginPassword,
    returnTo: "/",
  });

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
  assert(response.ok, "/api/crm/core loads with a session");
  return json;
}

async function archiveContact(contactId) {
  const { response } = await request(`/api/crm/contacts?id=${encodeURIComponent(contactId)}`, {
    method: "DELETE",
  });
  assert(response.ok, "contact archive endpoint succeeds");
  archivedContactIds.add(contactId);
}

async function main() {
  const timestamp = Date.now();
  const uniqueName = `QA Contact DB First ${timestamp}`;
  const editedName = `${uniqueName} Edited`;
  let contactId = "";

  const rootWithoutCookie = await request("/", { auth: false });
  assert(
    [302, 303, 307, 308].includes(rootWithoutCookie.response.status) &&
      (rootWithoutCookie.response.headers.get("location") ?? "").includes("/login"),
    "/ without cookie redirects to /login",
  );

  const coreWithoutCookie = await request("/api/crm/core", { auth: false });
  assert(coreWithoutCookie.response.status === 401, "/api/crm/core without cookie returns 401");

  await login();

  const sessionResponse = await request("/api/auth/session");
  assert(sessionResponse.response.ok, "/api/auth/session loads with a session");
  assert(sessionResponse.json?.authenticated === true, "session endpoint reports authenticated");
  assert(sessionResponse.json?.sessionConfigured === true, "session endpoint reports sessionConfigured");
  assert(sessionResponse.json?.loginConfigured === true, "session endpoint reports loginConfigured");

  let core = await getCore();
  const projectId = core?.data?.projects?.[0]?.id;
  assert(projectId, "core data exposes a project for QA contact creation");

  const createResponse = await request("/api/crm/contacts", {
    json: {
      contact: {
        consent: "Nur CRM",
        email: `qa-contact-${timestamp}@example.test`,
        intent: "QA DB-first create",
        name: uniqueName,
        phone: `+43 660 ${String(timestamp).slice(-6)}`,
        projectId,
        role: "Käufer",
        source: "Manual",
        workspaceId: "00000000-0000-4000-8000-000000000000",
      },
    },
    method: "POST",
  });
  assert(createResponse.response.ok, "contact create endpoint succeeds");
  contactId = createResponse.json?.contact?.id;
  createdContactIds.add(contactId);
  assert(contactId && !contactId.startsWith("contact_manual_"), "created contact uses a server id");
  assert(
    createResponse.json?.contact?.workspaceId === sessionResponse.json?.workspace?.id,
    "client workspaceId does not override the session workspace",
  );

  core = await getCore();
  assert(
    core?.data?.contacts?.some((contact) => contact.id === contactId && contact.name === uniqueName),
    "created contact appears in /api/crm/core",
  );

  await logout();
  await login();

  core = await getCore();
  assert(
    core?.data?.contacts?.some((contact) => contact.id === contactId),
    "created contact remains after a new login",
  );

  const editResponse = await request("/api/crm/contacts", {
    json: {
      contact: {
        consent: "Nur CRM",
        email: `qa-contact-edited-${timestamp}@example.test`,
        id: contactId,
        intent: "QA DB-first edit",
        name: editedName,
        phone: `+43 699 ${String(timestamp).slice(-6)}`,
        projectId,
        role: "Investor",
        source: "Manual",
        workspaceId: "00000000-0000-4000-8000-000000000000",
      },
    },
    method: "POST",
  });
  assert(editResponse.response.ok, "contact edit endpoint succeeds");

  core = await getCore();
  assert(
    core?.data?.contacts?.some((contact) => contact.id === contactId && contact.name === editedName),
    "edited contact appears after core reload",
  );

  const invalidResponse = await request("/api/crm/contacts", {
    json: { contact: { intent: "invalid QA contact without route fields", projectId } },
    method: "POST",
  });
  assert(invalidResponse.response.status === 400, "contact without name, email or phone is rejected");

  await archiveContact(contactId);

  core = await getCore();
  assert(
    !core?.data?.contacts?.some((contact) => contact.id === contactId),
    "archived contact disappears from normal /api/crm/core contacts",
  );

  console.log("QA contact CRUD completed");
}

main()
  .catch(async (error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);

    for (const contactId of createdContactIds) {
      if (!contactId || archivedContactIds.has(contactId)) continue;
      try {
        await archiveContact(contactId);
      } catch {
        console.error(`Cleanup skipped for ${contactId}`);
      }
    }

    process.exit(1);
  });
