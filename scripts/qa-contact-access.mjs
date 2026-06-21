#!/usr/bin/env node
import { randomUUID, scrypt as scryptCallback } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";
import { createJiti } from "jiti";

const scrypt = promisify(scryptCallback);
const defaultQaPassword = "QA-Novalure-Local-2026!";
const runStamp = Date.now();
const marker = `QAACCESS_CONTACT_ACCESS_${runStamp}`;
const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function hashPassword(password) {
  const salt = randomUUID().replace(/-/g, "");
  const derivedKey = await scrypt(password, salt, 64);
  return ["scrypt", salt, Buffer.from(derivedKey).toString("base64url")].join(":");
}

loadEnv(".env.local");

const qaPassword = process.env.NOVALURE_QA_PASSWORD || process.env.QA_LOGIN_PASSWORD || defaultQaPassword;
const databaseUrl =
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);

if (!databaseUrl) throw new Error("DATABASE_URL or POSTGRES_URL is required.");

function maskDatabaseUrl(value) {
  return value.replace(/:\/\/[^:@/]+:([^@/]+)@/, "://***:***@");
}

function assertTestDatabase() {
  const parsed = new URL(databaseUrl);
  const projectId = process.env.POSTGRES_NEON_PROJECT_ID || process.env.NEON_PROJECT_ID || "";
  console.log(`Active DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);
  console.log(`Active DB host: ${parsed.hostname}`);
  console.log(`Project ID suffix verified: ${projectId ? "***" + projectId.slice(-8) : "missing"}`);
  if (parsed.hostname !== testDbHost) {
    throw new Error(`Refusing qa:contact-access: active DB host is not test (${testDbHost})`);
  }
  if (!projectId.includes(testDbSuffix)) {
    throw new Error(`Refusing qa:contact-access: project id does not contain ${testDbSuffix}`);
  }
}

const sql = neon(databaseUrl);
const createdUserIds = [];
const createdProjectIds = [];
const createdWorkspaceIds = [];
let createdContactId = "";

assertTestDatabase();
process.env.DATABASE_URL = databaseUrl;
process.env.POSTGRES_URL = databaseUrl;
process.env.POSTGRES_DATABASE_URL = databaseUrl;
process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const coreRoute = jiti("../src/app/api/crm/core/route.ts");
const contactsRoute = jiti("../src/app/api/crm/contacts/route.ts");
const routeHandlers = new Map([
  ["/api/crm/core", coreRoute],
  ["/api/crm/contacts", contactsRoute],
]);

async function safeQuery(query, params = []) {
  try {
    return await sql.query(query, params);
  } catch (error) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

function authHeaders(session, headersInit = {}) {
  const headers = new Headers(headersInit);
  headers.set("x-novalure-user-id", session.id);
  headers.set("x-novalure-user-email", session.email);
  headers.set("x-novalure-user-name", session.name);
  headers.set("x-novalure-role", session.role);
  headers.set("x-novalure-product-role", session.productRole);
  headers.set("x-novalure-workspace-id", session.workspaceId);
  return headers;
}

async function request(session, path, options = {}) {
  const url = new URL(path, "http://qa.local");
  const method = options.method ?? "GET";
  const handlers = routeHandlers.get(url.pathname);
  const handler = handlers?.[method];
  assert(handler, `Route handler exists for ${method} ${url.pathname}`);

  const headers = new Headers(options.headers ?? {});
  for (const [name, value] of authHeaders(session).entries()) {
    headers.set(name, value);
  }

  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await handler(new Request(url, {
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    headers,
    method: options.method ?? "GET",
  }));

  const contentType = response.headers.get("content-type") ?? "";
  const json = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
  const text = json ? "" : await response.text().catch(() => "");
  return { json, response, text };
}

async function core(session) {
  const result = await request(session, "/api/crm/core");
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
  return {
    id: rows[0].id,
    email: input.email,
    name: input.name,
    productRole: input.productRole,
    role: input.role,
    workspaceId: input.workspaceId,
  };
}

async function createWorkspace(name) {
  const id = randomUUID();
  const slug = `qaaccess-${runStamp}-${createdWorkspaceIds.length + 1}`;
  await sql.query(
    `
      insert into workspaces (
        id,
        name,
        plan,
        operating_model,
        customer_type,
        team_structure,
        active_calendar_provider,
        setup_state,
        slug
      )
      values (
        $1::uuid,
        $2,
        'Growth Workspace',
        'self_service_customer',
        'real_estate_broker',
        'small_team',
        'none',
        '{"source":"QAACCESS_CONTACT_ACCESS"}'::jsonb,
        $3
      )
    `,
    [id, name, slug],
  );
  createdWorkspaceIds.push(id);
  return { id };
}

async function createProject(workspaceId, name) {
  const id = randomUUID();
  await sql.query(
    `
      insert into projects (
        id,
        workspace_id,
        name,
        type,
        status,
        customer_type,
        default_operating_model,
        setup_defaults
      )
      values (
        $1::uuid,
        $2::uuid,
        $3,
        'Makler QA',
        'Aktiv',
        'real_estate_broker',
        'self_service_customer',
        '{"source":"QAACCESS_CONTACT_ACCESS"}'::jsonb
      )
    `,
    [id, workspaceId, name],
  );
  createdProjectIds.push(id);
  return { id };
}

async function createWorkspaceFixture(label) {
  const workspace = await createWorkspace(`${marker} ${label} Workspace`);
  const project = await createProject(workspace.id, `${marker} ${label} Project`);
  return { projectId: project.id, workspaceId: workspace.id };
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

  if (createdProjectIds.length) {
    await sql.query(`delete from projects where id = any($1::uuid[])`, [createdProjectIds]);
  }

  if (createdWorkspaceIds.length) {
    await sql.query(`delete from workspaces where id = any($1::uuid[])`, [createdWorkspaceIds]);
  }
}

async function cleanupStaleRuns() {
  const staleContacts = await sql.query(
    `
      select id
      from contacts
      where name like 'CODEXTEST_CONTACT_ACCESS_%'
         or name like 'QAACCESS_CONTACT_ACCESS_%'
         or email like 'codextest-contact-access-%@example.test'
         or email like 'qaaccess-contact-access-%@example.test'
         or email like 'qaaccess-viewer-%@example.test'
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
         or email like 'qaaccess-%@novalure.local'
         or name like 'CODEXTEST_CONTACT_ACCESS_%'
         or name like 'QAACCESS_CONTACT_ACCESS_%'
    `,
  );
  await sql.query(
    `
      delete from projects
      where name like 'QAACCESS_CONTACT_ACCESS_%'
    `,
  );
  await sql.query(
    `
      delete from workspaces
      where name like 'QAACCESS_CONTACT_ACCESS_%'
         or slug like 'qaaccess-%'
    `,
  );
}

async function countQaAccessRests() {
  const [contacts, users, projects, workspaces] = await Promise.all([
    safeQuery(
      `
        select id
        from contacts
        where name like 'QAACCESS_%'
           or email like 'qaaccess-%'
           or intent like 'QAACCESS_%'
      `,
    ),
    safeQuery(
      `
        select id
        from workspace_users
        where name like 'QAACCESS_%'
           or email like 'qaaccess-%'
      `,
    ),
    safeQuery(
      `
        select id
        from projects
        where name like 'QAACCESS_%'
           or setup_defaults::text like '%QAACCESS_%'
      `,
    ),
    safeQuery(
      `
        select id
        from workspaces
        where name like 'QAACCESS_%'
           or slug like 'qaaccess-%'
           or setup_state::text like '%QAACCESS_%'
      `,
    ),
  ]);

  return {
    contacts: contacts.map((row) => row.id),
    projects: projects.map((row) => row.id),
    users: users.map((row) => row.id),
    workspaces: workspaces.map((row) => row.id),
  };
}

function countRowsByTable(result) {
  return Object.fromEntries(Object.entries(result).map(([table, ids]) => [table, ids.length]));
}

function countTotal(result) {
  return Object.values(result).reduce((sum, ids) => sum + ids.length, 0);
}

try {
  await cleanupStaleRuns();

  const primaryFixture = await createWorkspaceFixture("Primary");
  const otherFixture = await createWorkspaceFixture("Other");
  const workspaceId = primaryFixture.workspaceId;
  const projectId = primaryFixture.projectId;
  const developerUser = await createUser({
    email: `qaaccess-developer-${runStamp}@novalure.local`,
    name: `${marker} Other Workspace User`,
    productRole: "developer_sales",
    role: "agent",
    workspaceId: otherFixture.workspaceId,
  });
  const userA = await createUser({
    email: `qaaccess-contact-a-${runStamp}@novalure.local`,
    name: `${marker} User A`,
    productRole: "broker_agent",
    role: "agent",
    workspaceId,
  });
  const userB = await createUser({
    email: `qaaccess-contact-b-${runStamp}@novalure.local`,
    name: `${marker} User B`,
    productRole: "broker_agent",
    role: "agent",
    workspaceId,
  });
  const leader = await createUser({
    email: `qaaccess-contact-lead-${runStamp}@novalure.local`,
    name: `${marker} Leader`,
    productRole: "customer_owner",
    role: "owner",
    workspaceId,
  });
  const viewer = await createUser({
    email: `qaaccess-contact-viewer-${runStamp}@novalure.local`,
    name: `${marker} Viewer`,
    productRole: "viewer",
    role: "assistant",
    workspaceId,
  });

  const createResult = await request(userA, "/api/crm/contacts", {
    json: {
      contact: {
        email: `qaaccess-contact-access-${runStamp}@example.test`,
        intent: "QAACCESS contact access",
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

  const coreA = await core(userA);
  assert(coreContacts(coreA).some((contact) => contact.id === createdContactId), "User A sees own contact");

  const coreB = await core(userB);
  assert(!coreContacts(coreB).some((contact) => contact.id === createdContactId), "User B does not see User A contact");
  const editByB = await request(userB, "/api/crm/contacts", {
    json: { contact: { id: createdContactId, intent: "QAACCESS forbidden edit", name: `${marker} B edit` } },
    method: "PATCH",
  });
  assert(editByB.response.status === 403, "User B cannot edit User A contact");

  const leaderCore = await core(leader);
  assert(coreContacts(leaderCore).some((contact) => contact.id === createdContactId), "Leader sees workspace contact");
  const editByLeader = await request(leader, "/api/crm/contacts", {
    json: { contact: { id: createdContactId, intent: "QAACCESS leader edit", name: `${marker} Leader edit`, ownerUserId: userB.id } },
    method: "PATCH",
  });
  assert(editByLeader.response.ok, `Leader can edit and reassign contact, got ${editByLeader.response.status}`);
  assert(editByLeader.json.contact.ownerUserId === userB.id, "Leader can assign contact owner");

  const otherWorkspaceCore = await core(developerUser);
  assert(
    !coreContacts(otherWorkspaceCore).some((contact) => contact.id === createdContactId),
    "User in another workspace never sees contact",
  );
  const otherWorkspacePatch = await request(developerUser, "/api/crm/contacts", {
    json: { contact: { id: createdContactId, intent: "QAACCESS foreign edit", name: `${marker} foreign edit` } },
    method: "PATCH",
  });
  assert(otherWorkspacePatch.response.status === 404, "Foreign workspace cannot mutate existing contact");

  const viewerCore = await core(viewer);
  assert(Array.isArray(coreContacts(viewerCore)), "Viewer can read explicitly exposed contact payload");
  const viewerCreate = await request(viewer, "/api/crm/contacts", {
    json: { contact: { email: `qaaccess-viewer-${runStamp}@example.test`, name: `${marker} Viewer create`, projectId } },
    method: "POST",
  });
  assert(viewerCreate.response.status === 403, "Viewer cannot create contacts");

  console.log("QA contact access checks passed");
  console.log(JSON.stringify({ contactId: createdContactId, marker, removedByCleanup: true }, null, 2));
} finally {
  await cleanup();
  const remaining = await countQaAccessRests();
  console.log("QAACCESS cleanup check");
  console.log(JSON.stringify(countRowsByTable(remaining), null, 2));
  assert(countTotal(remaining) === 0, `QAACCESS cleanup left rows: ${JSON.stringify(remaining)}`);
}
