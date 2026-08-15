#!/usr/bin/env node
import { randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";

const scrypt = promisify(scryptCallback);
const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const prodDbHost = "ep-wandering-union-alem0781-pooler.c-3.eu-central-1.aws.neon.tech";
const prodDbSuffix = "70835427";
const defaultQaPassword = "QA-Novalure-Local-2026!";
const runStamp = Date.now();
const marker = `CODEXTEST_PRODUCTROLE_INVITE_${runStamp}`;
const createdUserIds = [];
const touchedWorkspaceIds = new Set();
let targetVerified = false;

function loadEnvFile(path) {
  if (!existsSync(path)) return {};

  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
    if (!process.env[key]) process.env[key] = value;
  }
  return values;
}

function cleanDatabaseUrl(value) {
  if (!value) return "";

  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);

  return prefixedUrl?.[1] ?? trimmed;
}

function maskDatabaseUrl(value) {
  return value
    .replace(/:\/\/[^:@/]+:([^@/]+)@/, "://***:***@")
    .replace(/(project|database|dbname)=([^&\s]+)/gi, "$1=***");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
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

async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = await scrypt(password, salt, 64);
  return ["scrypt", salt, Buffer.from(derivedKey).toString("base64url")].join(":");
}

async function request(cookieJar, baseUrl, path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookieJar.size) headers.set("cookie", cookieHeader(cookieJar));

  if (options.json !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(`${baseUrl}${path}`, {
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    headers,
    method: options.method ?? "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  storeCookies(cookieJar, response.headers);

  const contentType = response.headers.get("content-type") ?? "";
  const json = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
  const text = json ? "" : await response.text().catch(() => "");
  return { json, response, text };
}

async function login(baseUrl, email, password) {
  const cookieJar = new Map();
  const body = new URLSearchParams({ email, password, returnTo: "/" });
  const result = await request(cookieJar, baseUrl, "/api/auth/login", {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  assert([302, 303, 307, 308].includes(result.response.status), `${email} login redirects`);
  assert(cookieJar.has("novalure_session"), `${email} receives a session cookie`);
  return cookieJar;
}

async function invite(cookieJar, baseUrl, input) {
  return request(cookieJar, baseUrl, "/api/crm/customer-access", {
    json: { operation: "invite_user", ...input },
    method: "PATCH",
  });
}

async function safeQuery(sql, query, params = []) {
  try {
    return await sql.query(query, params);
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") return [];
    throw error;
  }
}

async function cleanupUsers(sql, userIds) {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (!ids.length) return;

  const workspaces = await sql.query(
    `
      select distinct workspace_id as "workspaceId"
      from workspace_users
      where id = any($1::uuid[])
    `,
    [ids],
  );
  for (const workspace of workspaces) touchedWorkspaceIds.add(workspace.workspaceId);

  await safeQuery(sql, `delete from auth_password_reset_tokens where user_id = any($1::uuid[])`, [ids]);
  await safeQuery(sql, `delete from analytics_events where entity_id = any($1::uuid[]) or user_id = any($1::uuid[])`, [ids]);
  await safeQuery(sql, `delete from audit_logs where entity_id = any($1::uuid[]) or actor_user_id = any($1::uuid[])`, [ids]);
  await sql.query(`delete from workspace_users where id = any($1::uuid[])`, [ids]);
}

async function cleanupStaleRuns(sql) {
  const staleUsers = await sql.query(
    `
      select id
      from workspace_users
      where lower(email) like 'codextest-productrole-invite-%@example.test'
         or lower(email) like 'codextest-productrole-actor-%@novalure.local'
         or name like 'CODEXTEST_PRODUCTROLE_INVITE_%'
    `,
  );
  await cleanupUsers(sql, staleUsers.map((user) => user.id));
}

async function refreshCustomerAccessCounts(sql) {
  const workspaceIds = Array.from(touchedWorkspaceIds).filter(Boolean);
  if (!workspaceIds.length) return;

  await safeQuery(
    sql,
    `
      update customer_workspace_access ca
      set
        active_users = (
          select count(*)
          from workspace_users wu
          where wu.workspace_id = ca.workspace_id and wu.status = 'active'
        ),
        invited_users = (
          select count(*)
          from workspace_users wu
          where wu.workspace_id = ca.workspace_id and wu.status = 'invited'
        ),
        updated_at = now()
      where ca.workspace_id = any($1::uuid[])
    `,
    [workspaceIds],
  );
}

async function createUser(sql, input, password) {
  const passwordHash = await hashPassword(password);
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
      returning id, email, workspace_id as "workspaceId", role, product_role as "productRole"
    `,
    [randomUUID(), input.workspaceId, input.name, input.email, input.role, passwordHash, input.productRole],
  );
  createdUserIds.push(rows[0].id);
  touchedWorkspaceIds.add(rows[0].workspaceId);
  return rows[0];
}

async function verifyTarget(sql, databaseUrl, envValues) {
  const parsed = new URL(databaseUrl);
  console.log(`Active DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);
  console.log(`Active DB host: ${parsed.hostname}`);
  console.log(`Expected Test DB suffix: ${testDbSuffix}`);

  assert(parsed.hostname === testDbHost, `active DB host is the Test DB (${testDbHost})`);
  assert(parsed.hostname !== prodDbHost, "active DB host is not the Prod DB");

  let projectId = envValues.POSTGRES_NEON_PROJECT_ID || envValues.NEON_PROJECT_ID || process.env.POSTGRES_NEON_PROJECT_ID || process.env.NEON_PROJECT_ID || "";
  try {
    const [identity] = await sql.query(
      `
        select
          current_database() as "databaseName",
          current_user as "databaseUser",
          neon_project_id() as "projectId"
      `,
    );
    projectId = identity?.projectId || projectId;
    console.log(`Connected database: ${identity?.databaseName ?? "unknown"}`);
    console.log(`Connected user: ${identity?.databaseUser ?? "unknown"}`);
  } catch {
    const [identity] = await sql.query(
      `
        select
          current_database() as "databaseName",
          current_user as "databaseUser"
      `,
    );
    console.log(`Connected database: ${identity?.databaseName ?? "unknown"}`);
    console.log(`Connected user: ${identity?.databaseUser ?? "unknown"}`);
  }

  console.log(`Project ID suffix verified: ${projectId ? `***${projectId.slice(-8)}` : "missing"}`);
  assert(projectId.includes(testDbSuffix), `active project id contains Test DB suffix ${testDbSuffix}`);
  assert(!projectId.includes(prodDbSuffix), "active project id does not contain Prod DB suffix");
  targetVerified = true;
}

const qaEnvFile = process.env.NOVALURE_QA_ENV_FILE || ".env.local";
const envValues = loadEnvFile(join(process.cwd(), qaEnvFile));
const databaseUrl =
  cleanDatabaseUrl(envValues.DATABASE_URL) ||
  cleanDatabaseUrl(envValues.POSTGRES_URL) ||
  cleanDatabaseUrl(envValues.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(envValues.POSTGRES_PRISMA_URL) ||
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);
const baseUrl = (process.env.NOVALURE_QA_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const qaPassword =
  process.env.NOVALURE_QA_PASSWORD ||
  process.env.NOVALURE_QA_SEED_PASSWORD ||
  process.env.QA_LOGIN_PASSWORD ||
  defaultQaPassword;

if (!databaseUrl) throw new Error("DATABASE_URL or POSTGRES_URL is required.");

const sql = neon(databaseUrl);

try {
  console.log(`Loaded QA env file: ${qaEnvFile}`);
  await verifyTarget(sql, databaseUrl, envValues);
  await cleanupStaleRuns(sql);

  const health = await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch((error) => {
    throw new Error(`NOVALURE_QA_BASE_URL is not reachable (${baseUrl}): ${error.message}`);
  });
  assert(health.status < 500, `local app responds at ${baseUrl} with ${health.status}`);

  const workspaces = await sql.query(
    `
      select id, name
      from workspaces
      where name in ('QA Novalure Internal Workspace', 'QA Makler Workspace')
    `,
  );
  const internalWorkspace = workspaces.find((workspace) => workspace.name === "QA Novalure Internal Workspace");
  const brokerWorkspace = workspaces.find((workspace) => workspace.name === "QA Makler Workspace");
  assert(internalWorkspace?.id, "QA Novalure Internal workspace exists");
  assert(brokerWorkspace?.id, "QA Makler Workspace exists");

  const [platformAdmin] = await sql.query(
    `
      select id, email, workspace_id as "workspaceId", product_role as "productRole", role
      from workspace_users
      where lower(email) = lower('qa-platform-admin@novalure.local')
        and status = 'active'
      limit 1
    `,
  );
  assert(platformAdmin?.email, "QA platform admin exists");
  assert(platformAdmin.workspaceId === internalWorkspace.id, "QA platform admin is in the internal workspace");

  const onboardingActor = await createUser(
    sql,
    {
      email: `codextest-productrole-actor-onboarding-${runStamp}@novalure.local`,
      name: `${marker} Onboarding Actor`,
      productRole: "novalure_onboarding",
      role: "admin",
      workspaceId: internalWorkspace.id,
    },
    qaPassword,
  );
  const customerOwnerActor = await createUser(
    sql,
    {
      email: `codextest-productrole-actor-customer-${runStamp}@novalure.local`,
      name: `${marker} Customer Owner Actor`,
      productRole: "customer_owner",
      role: "owner",
      workspaceId: brokerWorkspace.id,
    },
    qaPassword,
  );

  const onboardingCookies = await login(baseUrl, onboardingActor.email, qaPassword);
  const allowedCustomerRole = await invite(onboardingCookies, baseUrl, {
    email: `codextest-productrole-invite-allowed-${runStamp}@example.test`,
    name: `${marker} Allowed Broker Agent`,
    productRole: "broker_agent",
    role: "agent",
  });
  assert(allowedCustomerRole.response.status === 200, `novalure_onboarding can invite broker_agent (${allowedCustomerRole.response.status})`);
  assert(allowedCustomerRole.json?.persisted === true, "allowed broker_agent invite is persisted");
  assert(allowedCustomerRole.json?.data?.user?.productRole === "broker_agent", "allowed invite stores broker_agent productRole");
  createdUserIds.push(allowedCustomerRole.json.data.user.id);
  touchedWorkspaceIds.add(allowedCustomerRole.json.data.user.workspaceId);

  const deniedPlatformByOnboarding = await invite(onboardingCookies, baseUrl, {
    email: `codextest-productrole-invite-denied-platform-${runStamp}@example.test`,
    name: `${marker} Denied Platform Admin`,
    productRole: "platform_admin",
    role: "owner",
  });
  assert(deniedPlatformByOnboarding.response.status === 403, "novalure_onboarding cannot invite platform_admin");
  assert(
    String(deniedPlatformByOnboarding.json?.error ?? "").includes("Only platform admins"),
    "platform escalation denial comes from role-grant matrix",
  );

  const deniedInternalByOnboarding = await invite(onboardingCookies, baseUrl, {
    email: `codextest-productrole-invite-denied-internal-${runStamp}@example.test`,
    name: `${marker} Denied Novalure Admin`,
    productRole: "novalureAdmin",
    role: "owner",
  });
  assert(deniedInternalByOnboarding.response.status === 403, "novalure_onboarding cannot invite novalureAdmin");
  assert(
    String(deniedInternalByOnboarding.json?.error ?? "").includes("Only platform or Novalure admins"),
    "internal-role escalation denial comes from role-grant matrix",
  );

  const customerCookies = await login(baseUrl, customerOwnerActor.email, qaPassword);
  const deniedPlatformByCustomer = await invite(customerCookies, baseUrl, {
    email: `codextest-productrole-invite-customer-platform-${runStamp}@example.test`,
    name: `${marker} Customer Denied Platform Admin`,
    productRole: "platform_admin",
    role: "owner",
  });
  assert(deniedPlatformByCustomer.response.status === 403, "customer_owner cannot invite platform_admin");

  const platformCookies = await login(baseUrl, platformAdmin.email, qaPassword);
  const allowedPlatformRole = await invite(platformCookies, baseUrl, {
    email: `codextest-productrole-invite-platform-${runStamp}@example.test`,
    name: `${marker} Allowed Platform Admin`,
    productRole: "platform_admin",
    role: "owner",
  });
  assert(allowedPlatformRole.response.status === 200, `platform_admin can invite platform_admin (${allowedPlatformRole.response.status})`);
  assert(allowedPlatformRole.json?.persisted === true, "allowed platform_admin invite is persisted");
  assert(allowedPlatformRole.json?.data?.user?.productRole === "platform_admin", "allowed invite stores platform_admin productRole");
  createdUserIds.push(allowedPlatformRole.json.data.user.id);
  touchedWorkspaceIds.add(allowedPlatformRole.json.data.user.workspaceId);

  console.log("QA ProductRole invite hardening checks passed");
  console.log(JSON.stringify({
    marker,
    denied: ["novalure_onboarding -> platform_admin", "novalure_onboarding -> novalureAdmin", "customer_owner -> platform_admin"],
    allowed: ["novalure_onboarding -> broker_agent", "platform_admin -> platform_admin"],
    testDbSuffix,
  }, null, 2));
} finally {
  try {
    if (targetVerified) {
      await cleanupUsers(sql, createdUserIds);
      await cleanupStaleRuns(sql);
      await refreshCustomerAccessCounts(sql);
    }
  } finally {
    console.log(`Cleaned synthetic marker: ${marker}`);
  }
}
