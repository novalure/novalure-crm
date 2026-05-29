#!/usr/bin/env node
import { randomUUID, scrypt as scryptCallback } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";

const scrypt = promisify(scryptCallback);
const defaultQaPassword = "QA-Novalure-Local-2026!";
const runStamp = Date.now();
const marker = `CODEXTEST_CONTACT_ACCESS_${runStamp}`;

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

function cleanDatabaseUrl(value) {
  if (!value) return "";

  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);

  return prefixedUrl?.[1] ?? trimmed;
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=[^;,]+=)/g);
}

function storeCookies(cookieJar, headers) {
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
    if (!cookieValue) cookieJar.delete(name);
    else cookieJar.set(name, cookieValue);
  }
}

function cookieHeader(cookieJar) {
  return Array.from(cookieJar.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function hashPassword(password) {
  const salt = randomUUID().replace(/-/g, "");
  const derivedKey = await scrypt(password, salt, 64);
  return ["scrypt", salt, Buffer.from(derivedKey).toString("base64url")].join(":");
}

loadEnv(".env.local");
loadEnv(".env.production.local");

const baseUrl = (process.env.NOVALURE_QA_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const qaPassword = process.env.NOVALURE_QA_PASSWORD || process.env.QA_LOGIN_PASSWORD || defaultQaPassword;
const databaseUrl =
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);

if (!databaseUrl) throw new Error("DATABASE_URL or POSTGRES_URL is required.");

const sql = neon(databaseUrl);
const createdUserIds = [];
let createdContactId = "";

async function safeQuery(query, params = []) {
  try {
    return await sql.query(query, params);
  } catch (error) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

async function request(cookieJar, path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookieJar.size) headers.set("cookie", cookieHeader(cookieJar));

  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    headers,
    method: options.method ?? "GET",
    redirect: "manual",
  });
  storeCookies(cookieJar, response.headers);

  const contentType = response.headers.get("content-type") ?? "";
  const json = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
  const text = json ? "" : await response.text().catch(() => "");
  return { json, response, text };
}

async function login(email) {
  const cookieJar = new Map();
  const body = new URLSearchParams({ email, password: qaPassword, returnTo: "/" });
  const result = await request(cookieJar, "/api/auth/login", {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  assert([302, 303, 307, 308].includes(result.response.status), `${email} login redirects`);
  assert(cookieJar.has("novalure_session"), `${email} receives a session cookie`);
  return cookieJar;
}

async function core(cookieJar) {
  const result = await request(cookieJar, "/api/crm/core");
  assert(result.response.ok, `/api/crm/core returns ${result.response.status}`);
  return result.json;
}

function coreContacts(payload) {
  return payload?.contacts ?? payload?.data?.contacts ?? [];
}

async function createUser(input) {
  const passwordHash = await hashPassword(qaPassword);
  const rows = await sql.query(
    `
      insert into workspace_users (
        id,
        workspace_id,
        name,
        email,
        role,
        status,
        password_hash,
        product_role
      )
      values ($1::uuid, $2::uuid, $3, $4, $5, 'active', $6, $7)
      returning id, email
    `,
    [
      randomUUID(),
      input.workspaceId,
      input.name,
      input.email,
      input.role,
      passwordHash,
      input.productRole,
    ],
  );
  createdUserIds.push(rows[0].id);
  return rows[0];
}

async function cleanup() {
  if (createdContactId) {
    await safeQuery(`delete from contact_timeline_items where contact_id = $1::uuid`, [createdContactId]);
    await safeQuery(`delete from consent_records where contact_id = $1::uuid`, [createdContactId]);
    await safeQuery(`delete from crm_analytics_events where contact_id = $1::uuid or entity_id = $1::uuid`, [createdContactId]);
    await safeQuery(`delete from audit_logs where entity_id = $1::uuid`, [createdContactId]);
    await sql.query(`delete from contacts where id = $1::uuid`, [createdContactId]);
  }

  if (createdUserIds.length) {
    await sql.query(`delete from workspace_users where id = any($1::uuid[])`, [createdUserIds]);
  }
}

async function cleanupStaleRuns() {
  const staleContacts = await sql.query(
    `
      select id
      from contacts
      where name like 'CODEXTEST_CONTACT_ACCESS_%'
         or email like 'codextest-contact-access-%@example.test'
    `,
  );
  const staleContactIds = staleContacts.map((contact) => contact.id).filter(Boolean);

  if (staleContactIds.length) {
    await safeQuery(`delete from contact_timeline_items where contact_id = any($1::uuid[])`, [staleContactIds]);
    await safeQuery(`delete from consent_records where contact_id = any($1::uuid[])`, [staleContactIds]);
    await safeQuery(`delete from crm_analytics_events where contact_id = any($1::uuid[]) or entity_id = any($1::uuid[])`, [
      staleContactIds,
    ]);
    await safeQuery(`delete from audit_logs where entity_id = any($1::uuid[])`, [staleContactIds]);
    await sql.query(`delete from contacts where id = any($1::uuid[])`, [staleContactIds]);
  }

  await sql.query(
    `
      delete from workspace_users
      where email like 'codextest-contact-%@novalure.local'
         or name like 'CODEXTEST_CONTACT_ACCESS_%'
    `,
  );
}

try {
  await cleanupStaleRuns();

  const workspaceRows = await sql.query(
    `
      select
        w.id as "workspaceId",
        (
          select p.id
          from projects p
          where p.workspace_id = w.id
          order by p.created_at asc
          limit 1
        ) as "projectId"
      from workspaces w
      where w.name = 'QA Makler Workspace'
      limit 1
    `,
  );
  const developerUser = await sql.query(
    `
      select email
      from workspace_users
      where email = 'qa-developer-sales@novalure.local'
        and status = 'active'
      limit 1
    `,
  );

  assert(workspaceRows[0]?.workspaceId, "QA Makler Workspace exists");
  assert(workspaceRows[0]?.projectId, "QA Makler project exists");
  assert(developerUser[0]?.email, "QA user in another workspace exists");

  const workspaceId = workspaceRows[0].workspaceId;
  const projectId = workspaceRows[0].projectId;
  const userA = await createUser({
    email: `codextest-contact-a-${runStamp}@novalure.local`,
    name: `${marker} User A`,
    productRole: "broker_agent",
    role: "agent",
    workspaceId,
  });
  const userB = await createUser({
    email: `codextest-contact-b-${runStamp}@novalure.local`,
    name: `${marker} User B`,
    productRole: "broker_agent",
    role: "agent",
    workspaceId,
  });
  const leader = await createUser({
    email: `codextest-contact-lead-${runStamp}@novalure.local`,
    name: `${marker} Leader`,
    productRole: "customer_owner",
    role: "owner",
    workspaceId,
  });
  const viewer = await createUser({
    email: `codextest-contact-viewer-${runStamp}@novalure.local`,
    name: `${marker} Viewer`,
    productRole: "viewer",
    role: "assistant",
    workspaceId,
  });

  const cookiesA = await login(userA.email);
  const createResult = await request(cookiesA, "/api/crm/contacts", {
    json: {
      contact: {
        email: `codextest-contact-access-${runStamp}@example.test`,
        intent: "CODEXTEST contact access",
        name: marker,
        projectId,
        source: "Manual",
      },
    },
    method: "POST",
  });
  assert(createResult.response.ok, `User A can create a contact, got ${createResult.response.status}`);
  createdContactId = createResult.json?.contact?.id ?? "";
  assert(createdContactId, "created contact id exists");
  assert(createResult.json.contact.ownerUserId === userA.id, "new contact defaults to the current user as owner");

  const coreA = await core(cookiesA);
  assert(coreContacts(coreA).some((contact) => contact.id === createdContactId), "User A sees own contact");

  const cookiesB = await login(userB.email);
  const coreB = await core(cookiesB);
  assert(!coreContacts(coreB).some((contact) => contact.id === createdContactId), "User B does not see User A contact");
  const editByB = await request(cookiesB, "/api/crm/contacts", {
    json: { contact: { id: createdContactId, intent: "CODEXTEST forbidden edit", name: `${marker} B edit` } },
    method: "PATCH",
  });
  assert(editByB.response.status === 403, "User B cannot edit User A contact");

  const leaderCookies = await login(leader.email);
  const leaderCore = await core(leaderCookies);
  assert(coreContacts(leaderCore).some((contact) => contact.id === createdContactId), "Leader sees workspace contact");
  const editByLeader = await request(leaderCookies, "/api/crm/contacts", {
    json: { contact: { id: createdContactId, intent: "CODEXTEST leader edit", name: `${marker} Leader edit`, ownerUserId: userB.id } },
    method: "PATCH",
  });
  assert(editByLeader.response.ok, `Leader can edit and reassign contact, got ${editByLeader.response.status}`);
  assert(editByLeader.json.contact.ownerUserId === userB.id, "Leader can assign contact owner");

  const otherWorkspaceCookies = await login(developerUser[0].email);
  const otherWorkspaceCore = await core(otherWorkspaceCookies);
  assert(
    !coreContacts(otherWorkspaceCore).some((contact) => contact.id === createdContactId),
    "User in another workspace never sees contact",
  );
  const otherWorkspacePatch = await request(otherWorkspaceCookies, "/api/crm/contacts", {
    json: { contact: { id: createdContactId, intent: "CODEXTEST foreign edit", name: `${marker} foreign edit` } },
    method: "PATCH",
  });
  assert(otherWorkspacePatch.response.status === 404, "Foreign workspace cannot mutate existing contact");

  const viewerCookies = await login(viewer.email);
  const viewerCore = await core(viewerCookies);
  assert(Array.isArray(coreContacts(viewerCore)), "Viewer can read explicitly exposed contact payload");
  const viewerCreate = await request(viewerCookies, "/api/crm/contacts", {
    json: { contact: { email: `codextest-viewer-${runStamp}@example.test`, name: `${marker} Viewer create`, projectId } },
    method: "POST",
  });
  assert(viewerCreate.response.status === 403, "Viewer cannot create contacts");

  console.log("QA contact access checks passed");
  console.log(JSON.stringify({ contactId: createdContactId, marker, removedByCleanup: true }, null, 2));
} finally {
  await cleanup();
}
