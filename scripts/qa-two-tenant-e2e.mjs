#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import { assertQaTarget } from "./qa-target-guard.mjs";
import {
  assertEvidenceContainsNoSecrets,
  buildQaTwoTenantScenarioMatrix,
  canonicalJson,
  evaluateQaTenantRelationGate,
  fingerprint,
  parseQaTwoTenantConfig,
  qaLaunchSchemaArtifactNames,
  qaRequiredMigrationVersions,
  qaTenantConstraintNames,
  qaTwoTenantRequiredEnvironment,
} from "./lib/qa-two-tenant-matrix.mjs";

const registrationHeader = "x-novalure-qa-batch-registration";
const batchHeader = "x-novalure-qa-batch-id";
const capabilityPath = "/api/admin/qa-batch-capability";
const allowedRegistrationStates = new Set(["committed", "already-registered"]);
const allowedChallengeDiagnostics = new Set(["mfa_enrollment", "mfa_verification", "workspace_selection"]);
const allowedLoginErrorDiagnostics = new Set([
  "database_unavailable",
  "invalid_credentials",
  "invalid_mfa",
  "login_not_configured",
]);

async function loadRequiredMigrationChecksums() {
  const entries = await Promise.all(qaRequiredMigrationVersions.map(async (version) => {
    const content = await fs.readFile(path.join(process.cwd(), "migrations", version + ".sql"), "utf8");
    const checksum = createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
    return [version, checksum];
  }));
  return Object.freeze(Object.fromEntries(entries));
}

function usage() {
  console.log([
    "Two-tenant QA E2E harness",
    "",
    "  --plan             Print the deterministic matrix and required environment (default; no network)",
    "  --validate-config  Validate identifiers/targets without network or writes",
    "  --preflight        Read-only DB/HTTP/auth/cross-tenant checks; no CRM object mutations",
    "  --execute          Run CRM writes only after atomic batch capability preflight, then reset in finally",
    "",
    "The harness never accepts a production origin and never prints credentials or raw response bodies.",
  ].join("\n"));
}

function modeFromArgs(argv) {
  const modes = ["--plan", "--validate-config", "--preflight", "--execute"].filter((flag) => argv.includes(flag));
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (modes.length > 1) throw new Error("Choose exactly one harness mode.");
  return modes[0]?.slice(2) ?? "plan";
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

export function createHttpClient(config, actor, tenant, evidence) {
  const cookies = new Map();
  const baseUrl = config.baseUrl;
  const origin = new URL(baseUrl).origin;

  function storeCookies(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : splitSetCookie(headers.get("set-cookie"));
    for (const value of values) {
      const [cookie] = value.split(";");
      const separator = cookie.indexOf("=");
      if (separator < 1) continue;
      const name = cookie.slice(0, separator).trim();
      const cookieValue = cookie.slice(separator + 1).trim();
      if (cookieValue) cookies.set(name, cookieValue);
      else cookies.delete(name);
    }
  }

  function cookieHeader() {
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async function request(requestPath, options = {}) {
    const url = new URL(requestPath, baseUrl);
    if (url.origin !== origin) throw new Error("Cross-origin request rejected by QA harness.");
    const method = (options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers ?? {});
    if (options.auth !== false && cookies.size) headers.set("cookie", cookieHeader());
    if (options.batchMutation) headers.set(batchHeader, tenant.batchId);
    if (["DELETE", "PATCH", "POST", "PUT"].includes(method) && options.auth !== false && cookies.has("novalure_session")) {
      const csrfUrl = new URL("/api/auth/csrf", baseUrl);
      csrfUrl.searchParams.set("method", method);
      csrfUrl.searchParams.set("path", url.pathname);
      const csrfResponse = await fetch(csrfUrl, {
        headers: {
          accept: "application/json",
          cookie: cookieHeader(),
          origin,
          "sec-fetch-site": "same-origin",
        },
      });
      storeCookies(csrfResponse.headers);
      const csrfPayload = await csrfResponse.json().catch(() => null);
      if (!csrfResponse.ok || typeof csrfPayload?.csrfToken !== "string") {
        throw new Error(`CSRF preflight failed with HTTP ${csrfResponse.status}.`);
      }
      headers.set("origin", origin);
      headers.set("sec-fetch-site", "same-origin");
      headers.set("x-novalure-csrf-token", csrfPayload.csrfToken);
    }
    const init = { headers, method, redirect: options.redirect ?? "manual" };
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
      init.body = options.body;
    }
    const startedAt = Date.now();
    const response = await fetch(url, init);
    storeCookies(response.headers);
    const contentType = response.headers.get("content-type") ?? "";
    const json = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
    const text = json === null ? await response.text().catch(() => "") : "";
    evidence.requests.push({
      durationMs: Date.now() - startedAt,
      method,
      path: url.pathname,
      status: response.status,
    });
    return { json, response, text };
  }

  async function login() {
    cookies.clear();
    const body = new URLSearchParams({ email: actor.email, password: actor.password, returnTo: "/" });
    let result = await request("/api/auth/login", {
      auth: false,
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-site": "same-origin" },
      method: "POST",
    });
    if (![302, 303, 307, 308].includes(result.response.status)) {
      throw new Error(`Login did not redirect (HTTP ${result.response.status}).`);
    }
    for (let index = 0; !cookies.has("novalure_session") && index < 3; index += 1) {
      const location = result.response.headers.get("location") ?? "/login";
      const challengeUrl = new URL(location, baseUrl);
      const challengeKind = challengeUrl.searchParams.get("step");
      if (challengeKind === "mfa_enrollment") {
        throw new Error("QA account is not pre-enrolled for MFA; provisioning must complete before E2E.");
      }
      if (!["workspace_selection", "mfa_verification"].includes(challengeKind ?? "")) {
        const errorKind = challengeUrl.searchParams.get("error");
        const safeChallengeKind = challengeKind === null
          ? "none"
          : allowedChallengeDiagnostics.has(challengeKind) ? challengeKind : "unknown";
        const safeErrorKind = errorKind === null
          ? "none"
          : allowedLoginErrorDiagnostics.has(errorKind) ? errorKind : "unknown";
        throw new Error(`Unexpected login challenge (step=${safeChallengeKind}, error=${safeErrorKind}).`);
      }
      const challengeBody = new URLSearchParams({ flow: "challenge", returnTo: "/" });
      if (challengeKind === "workspace_selection") {
        challengeBody.set("workspaceUserId", actor.userId);
      } else {
        const code = createTotpCode(actor.totpSecret);
        if (!code) throw new Error("Unable to generate TOTP code for QA account.");
        challengeBody.set("code", code);
      }
      result = await request("/api/auth/login", {
        body: challengeBody,
        headers: { "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-site": "same-origin" },
        method: "POST",
      });
      if (![302, 303, 307, 308].includes(result.response.status)) {
        throw new Error(`Login challenge did not redirect (HTTP ${result.response.status}).`);
      }
    }
    if (!cookies.has("novalure_session")) throw new Error("Login did not establish a persisted session.");
    const session = await request("/api/auth/session");
    if (!session.response.ok) throw new Error(`Session read failed with HTTP ${session.response.status}.`);
    if (session.json?.workspace?.id !== tenant.workspaceId) throw new Error("Session selected the wrong workspace.");
    if (session.json?.user?.id !== actor.userId) throw new Error("Session selected the wrong workspace membership.");
    if (session.json?.user?.role !== actor.appRole || session.json?.user?.productRole !== actor.productRole) {
      throw new Error("Session role/product-role differs from the signed QA fixture contract.");
    }
    return session.json;
  }

  async function logout() {
    if (!cookies.has("novalure_session")) return 204;
    const result = await request("/api/auth/logout", { method: "POST" });
    if (result.response.status !== 303) {
      throw new Error(`Logout failed with HTTP ${result.response.status}.`);
    }
    return result.response.status;
  }

  function assertAtomicRegistration(result, label) {
    const state = result.response.headers.get(registrationHeader);
    const registeredBatch = result.response.headers.get(batchHeader);
    if (!allowedRegistrationStates.has(state ?? "") || registeredBatch !== tenant.batchId) {
      throw new Error(`${label} did not prove atomic QA batch registration.`);
    }
  }

  return { assertAtomicRegistration, login, logout, request };
}

function createPublicClient(config, evidence) {
  return {
    async request(requestPath, options = {}) {
      const url = new URL(requestPath, config.baseUrl);
      if (url.origin !== config.baseUrl) throw new Error("Cross-origin public request rejected.");
      const method = (options.method ?? "GET").toUpperCase();
      const headers = new Headers(options.headers ?? {});
      const startedAt = Date.now();
      const response = await fetch(url, {
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
        headers: options.json === undefined ? headers : new Headers({ ...Object.fromEntries(headers), "content-type": "application/json" }),
        method,
        redirect: "manual",
      });
      const contentType = response.headers.get("content-type") ?? "";
      const json = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
      const text = json === null ? await response.text().catch(() => "") : "";
      evidence.requests.push({ durationMs: Date.now() - startedAt, method, path: url.pathname, status: response.status });
      return { json, response, text };
    },
  };
}

function resultRecorder(evidence) {
  return function check(id, condition, actual, expected) {
    const row = { actual, expected, id, status: condition ? "pass" : "fail" };
    evidence.results.push(row);
    if (!condition) throw new Error(`${id} failed (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}).`);
  };
}

function responseStatusAllowed(response, expected) {
  return (Array.isArray(expected) ? expected : [expected]).includes(response.status);
}

function markerFor(config, tenant, suffix) {
  const digest = createHash("sha256").update(`${config.runPrefix}\0${tenant.key}\0${suffix}`).digest("hex").slice(0, 12);
  return `${tenant.batchMarker}-${suffix}-${digest}`.slice(0, 180);
}

function emailFor(config, tenant, suffix) {
  const digest = createHash("sha256").update(`${config.runPrefix}\0${tenant.key}\0${suffix}`).digest("hex").slice(0, 20);
  return `qa-${digest}@example.test`;
}

async function scopedRead(sql, tenant, actorId) {
  const results = await sql.transaction((transaction) => [
    transaction`select set_config('app.tenant_id', ${tenant.workspaceId}, true), set_config('app.actor_id', ${actorId}, true)`,
    transaction`
      select id, name, is_qa as "isQa"
      from workspaces
      where id = ${tenant.workspaceId}::uuid
    `,
    transaction`
      select id, workspace_id as "workspaceId"
      from projects
      where id = ${tenant.projectId}::uuid
        and workspace_id = ${tenant.workspaceId}::uuid
    `,
    transaction`
      select id, role, product_role as "productRole", status
      from workspace_users
      where workspace_id = ${tenant.workspaceId}::uuid
        and id = any(${[
          tenant.resetActorUserId,
          ...Object.values(tenant.actors).map((actor) => actor.userId),
        ]}::uuid[])
      order by id
    `,
    transaction`
      select id, workspace_id as "workspaceId", batch_marker as "batchMarker", created_by_user_id as "createdByUserId"
      from qa_batches
      where id = ${tenant.batchId}::uuid
        and workspace_id = ${tenant.workspaceId}::uuid
    `,
    transaction`
      select version, checksum
      from public.novalure_schema_migration_checksums
      where version = any(${qaRequiredMigrationVersions}::text[])
      order by version
    `,
    transaction`
      select
        current_user = 'novalure_app' as "appRole",
        pg_catalog.pg_has_role(current_user, 'novalure_tenant_app', 'USAGE') as "tenantRoleInherited",
        not (
          pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migrations', 'SELECT')
          or pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migrations', 'INSERT')
          or pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migrations', 'UPDATE')
          or pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migrations', 'DELETE')
          or pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migrations', 'TRUNCATE')
          or pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migrations', 'REFERENCES')
          or pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migrations', 'TRIGGER')
          or pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migrations', 'MAINTAIN')
          or pg_catalog.has_any_column_privilege(current_user, 'public.novalure_schema_migrations', 'SELECT')
          or pg_catalog.has_any_column_privilege(current_user, 'public.novalure_schema_migrations', 'INSERT')
          or pg_catalog.has_any_column_privilege(current_user, 'public.novalure_schema_migrations', 'UPDATE')
          or pg_catalog.has_any_column_privilege(current_user, 'public.novalure_schema_migrations', 'REFERENCES')
        ) as "baseDenied",
        (
          pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'SELECT')
          and not pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'SELECT WITH GRANT OPTION')
          and not pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'INSERT')
          and not pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'UPDATE')
          and not pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'DELETE')
          and not pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'TRUNCATE')
          and not pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'REFERENCES')
          and not pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'TRIGGER')
          and not pg_catalog.has_table_privilege(current_user, 'public.novalure_schema_migration_checksums', 'MAINTAIN')
          and not pg_catalog.has_any_column_privilege(current_user, 'public.novalure_schema_migration_checksums', 'INSERT')
          and not pg_catalog.has_any_column_privilege(current_user, 'public.novalure_schema_migration_checksums', 'UPDATE')
          and not pg_catalog.has_any_column_privilege(current_user, 'public.novalure_schema_migration_checksums', 'REFERENCES')
          and not pg_catalog.has_any_column_privilege(current_user, 'public.novalure_schema_migration_checksums', 'SELECT WITH GRANT OPTION')
        ) as "projectionReadOnly",
        exists (
          select 1
          from pg_catalog.pg_class relation
          join pg_catalog.pg_class ledger
            on ledger.oid = to_regclass('public.novalure_schema_migrations')
          where relation.oid = to_regclass('public.novalure_schema_migration_checksums')
            and relation.relkind = 'v'
            and relation.relowner = ledger.relowner
            and not pg_catalog.pg_has_role(current_user, relation.relowner, 'MEMBER')
            and not pg_catalog.pg_has_role(current_user, relation.relowner, 'USAGE')
            and 'security_barrier=true' = any(coalesce(relation.reloptions, '{}'::text[]))
            and 'security_invoker=false' = any(coalesce(relation.reloptions, '{}'::text[]))
        ) as "projectionOwnerScoped",
        pg_catalog.row_security_active('public.qa_batches'::regclass) as "qaBatchesRlsActive",
        pg_catalog.row_security_active('public.qa_batch_objects'::regclass) as "qaBatchObjectsRlsActive",
        (
          select array_agg(attribute.attname::text order by attribute.attnum)
          from pg_catalog.pg_attribute attribute
          where attribute.attrelid = to_regclass('public.novalure_schema_migration_checksums')
            and attribute.attnum > 0
            and not attribute.attisdropped
        ) = array['version', 'checksum']::text[] as "projectionColumnsExact",
        not exists (
          select 1
          from pg_catalog.pg_class relation
          cross join lateral pg_catalog.aclexplode(
            coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
          ) acl
          where relation.oid = to_regclass('public.novalure_schema_migration_checksums')
            and acl.grantee = 0
          union all
          select 1
          from pg_catalog.pg_attribute attribute
          cross join lateral pg_catalog.aclexplode(attribute.attacl) acl
          where attribute.attrelid = to_regclass('public.novalure_schema_migration_checksums')
            and attribute.attnum > 0
            and not attribute.attisdropped
            and acl.grantee = 0
        ) as "projectionPublicDenied"
    `,
    transaction`
      select
        count(*)::int as found,
        count(*) filter (where convalidated)::int as validated,
        count(*) filter (where condeferrable)::int as deferrable,
        count(*) filter (where condeferred)::int as "initiallyDeferred"
      from pg_catalog.pg_constraint
      where conname = any(${qaTenantConstraintNames}::text[])
    `,
    transaction`
      select relation, violations
      from (
        select 'funnels.project' relation, count(*)::int violations from funnels c left join projects p on p.workspace_id = c.workspace_id and p.id = c.project_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.project_id is not null and p.id is null
        union all select 'funnels.owner', count(*)::int from funnels c left join workspace_users p on p.workspace_id = c.workspace_id and p.id = c.owner_user_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.owner_user_id is not null and p.id is null
        union all select 'funnel_steps.project', count(*)::int from funnel_steps c left join projects p on p.workspace_id = c.workspace_id and p.id = c.project_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.project_id is not null and p.id is null
        union all select 'funnel_steps.funnel', count(*)::int from funnel_steps c left join funnels p on p.workspace_id = c.workspace_id and p.id = c.funnel_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.funnel_id is not null and p.id is null
        union all select 'funnel_steps.bot', count(*)::int from funnel_steps c left join bots p on p.workspace_id = c.workspace_id and p.id = c.bot_rule_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.bot_rule_id is not null and p.id is null
        union all select 'property_inquiries.project', count(*)::int from property_inquiries c left join projects p on p.workspace_id = c.workspace_id and p.id = c.project_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.project_id is not null and p.id is null
        union all select 'property_inquiries.property', count(*)::int from property_inquiries c left join seller_listings p on p.workspace_id = c.workspace_id and p.id = c.property_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.property_id is not null and p.id is null
        union all select 'property_inquiries.unit', count(*)::int from property_inquiries c left join property_units p on p.workspace_id = c.workspace_id and p.id = c.unit_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.unit_id is not null and p.id is null
        union all select 'property_inquiries.contact', count(*)::int from property_inquiries c left join contacts p on p.workspace_id = c.workspace_id and p.id = c.contact_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.contact_id is not null and p.id is null
        union all select 'property_inquiries.lead', count(*)::int from property_inquiries c left join leads p on p.workspace_id = c.workspace_id and p.id = c.lead_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.lead_id is not null and p.id is null
        union all select 'property_inquiries.funnel', count(*)::int from property_inquiries c left join funnels p on p.workspace_id = c.workspace_id and p.id = c.funnel_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.funnel_id is not null and p.id is null
        union all select 'property_inquiries.form', count(*)::int from property_inquiries c left join forms p on p.workspace_id = c.workspace_id and p.id = c.form_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.form_id is not null and p.id is null
        union all select 'property_inquiries.owner', count(*)::int from property_inquiries c left join workspace_users p on p.workspace_id = c.workspace_id and p.id = c.owner_user_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.owner_user_id is not null and p.id is null
        union all select 'property_activity.project', count(*)::int from property_activity_events c left join projects p on p.workspace_id = c.workspace_id and p.id = c.project_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.project_id is not null and p.id is null
        union all select 'property_activity.property', count(*)::int from property_activity_events c left join seller_listings p on p.workspace_id = c.workspace_id and p.id = c.property_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.property_id is not null and p.id is null
        union all select 'property_activity.unit', count(*)::int from property_activity_events c left join property_units p on p.workspace_id = c.workspace_id and p.id = c.unit_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.unit_id is not null and p.id is null
        union all select 'property_activity.contact', count(*)::int from property_activity_events c left join contacts p on p.workspace_id = c.workspace_id and p.id = c.contact_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.contact_id is not null and p.id is null
        union all select 'property_activity.lead', count(*)::int from property_activity_events c left join leads p on p.workspace_id = c.workspace_id and p.id = c.lead_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.lead_id is not null and p.id is null
        union all select 'property_activity.actor', count(*)::int from property_activity_events c left join workspace_users p on p.workspace_id = c.workspace_id and p.id = c.actor_user_id where c.workspace_id = ${tenant.workspaceId}::uuid and c.actor_user_id is not null and p.id is null
      ) relation_checks
      order by relation
    `,
    transaction`
      select count(*)::int as count
      from qa_batch_objects
      where workspace_id = ${tenant.workspaceId}::uuid
        and batch_id = ${tenant.batchId}::uuid
    `,
    transaction`
      select
        (select count(*)::int from contacts where workspace_id = ${tenant.workspaceId}::uuid and starts_with(name, ${tenant.batchMarker})) as contacts,
        (select count(*)::int from deals where workspace_id = ${tenant.workspaceId}::uuid and starts_with(name, ${tenant.batchMarker})) as deals
    `,
    transaction`
      select artifact, ok
      from (
        select
          '075.table.public_funnel_visit_events'::text as artifact,
          to_regclass('public.public_funnel_visit_events') is not null as ok
        union all
        select
          '075.constraint.scope_unique',
          exists (
            select 1 from pg_catalog.pg_constraint
            where conrelid = to_regclass('public.public_funnel_visit_events')
              and conname = 'public_funnel_visit_events_scope_key'
              and contype = 'u' and convalidated
              and lower(regexp_replace(pg_catalog.pg_get_constraintdef(oid, true), '\\s+', ' ', 'g'))
                = 'unique (workspace_id, funnel_id, publication_revision, visit_id_hash)'
          )
        union all
        select
          '075.constraint.funnel_fk',
          exists (
            select 1 from pg_catalog.pg_constraint
            where conrelid = to_regclass('public.public_funnel_visit_events')
              and confrelid = to_regclass('public.funnels')
              and conname = 'public_funnel_visit_events_funnel_fk'
              and contype = 'f' and convalidated and confdeltype = 'c'
          )
        union all
        select
          '075.constraints.checks',
          (
            select count(*) = 3
            from pg_catalog.pg_constraint
            where conrelid = to_regclass('public.public_funnel_visit_events')
              and conname = any(array[
                'public_funnel_visit_events_revision_check',
                'public_funnel_visit_events_hash_check',
                'public_funnel_visit_events_expiry_check'
              ]::text[])
              and contype = 'c' and convalidated
          )
        union all
        select
          '075.index.expiry',
          exists (
            select 1
            from pg_catalog.pg_index index_state
            join pg_catalog.pg_class index_relation on index_relation.oid = index_state.indexrelid
            where index_state.indrelid = to_regclass('public.public_funnel_visit_events')
              and index_relation.relname = 'public_funnel_visit_events_expiry_idx'
              and index_state.indisvalid and index_state.indisready and not index_state.indisunique
              and regexp_replace(pg_catalog.pg_get_indexdef(index_state.indexrelid), '\\s+', ' ', 'g')
                ~ '\\(expires_at, id\\)$'
          )
        union all
        select
          '075.grants.tenant_app_none',
          not (
            has_table_privilege('novalure_tenant_app', 'public.public_funnel_visit_events', 'SELECT')
            or has_table_privilege('novalure_tenant_app', 'public.public_funnel_visit_events', 'INSERT')
            or has_table_privilege('novalure_tenant_app', 'public.public_funnel_visit_events', 'DELETE')
          )
        union all
        select
          '075.grants.public_none',
          not exists (
            select 1
            from pg_catalog.pg_class relation
            cross join lateral pg_catalog.aclexplode(
              coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
            ) acl
            where relation.oid = to_regclass('public.public_funnel_visit_events')
              and acl.grantee = 0
          )
        union all
        select
          '076.columns.webhook_state',
          (
            select count(*) = 15
            from (values
              ('payload_sha256', 'text', false, null::text),
              ('processing_attempt', 'integer', true, '0'),
              ('lease_token', 'uuid', false, null::text),
              ('lease_expires_at', 'timestamp with time zone', false, null::text),
              ('processing_result', 'jsonb', false, null::text),
              ('last_error', 'text', false, null::text),
              ('completed_at', 'timestamp with time zone', false, null::text),
              ('reply_state', 'text', true, '''not_requested''::text'),
              ('reply_attempt_token', 'uuid', false, null::text),
              ('reply_attempted_at', 'timestamp with time zone', false, null::text),
              ('reply_completed_at', 'timestamp with time zone', false, null::text),
              ('reply_result', 'jsonb', false, null::text),
              ('quarantine_reason', 'text', false, null::text),
              ('quarantined_at', 'timestamp with time zone', false, null::text),
              ('conflict_count', 'integer', true, '0')
            ) expected(column_name, data_type, is_not_null, default_expr)
            join pg_catalog.pg_attribute attribute
              on attribute.attrelid = to_regclass('public.bot_channel_webhooks')
             and attribute.attname = expected.column_name
             and attribute.attnum > 0 and not attribute.attisdropped
             and pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = expected.data_type
             and attribute.attnotnull = expected.is_not_null
            left join pg_catalog.pg_attrdef default_state
              on default_state.adrelid = attribute.attrelid and default_state.adnum = attribute.attnum
            where (expected.default_expr is null and default_state.adbin is null)
               or pg_catalog.pg_get_expr(default_state.adbin, default_state.adrelid) = expected.default_expr
          )
        union all
        select
          '076.constraints.webhook_state',
          (
            select count(*) = 7
            from pg_catalog.pg_constraint
            where conrelid = to_regclass('public.bot_channel_webhooks')
              and conname = any(array[
                'bot_channel_webhooks_payload_sha256_check',
                'bot_channel_webhooks_processing_attempt_check',
                'bot_channel_webhooks_processing_state_check',
                'bot_channel_webhooks_processing_lease_check',
                'bot_channel_webhooks_reply_state_check',
                'bot_channel_webhooks_external_message_id_check',
                'bot_channel_webhooks_conflict_count_check'
              ]::text[])
              and contype = 'c' and convalidated
          )
        union all
        select
          '076.index.webhook_workspace_unique',
          exists (
            select 1
            from pg_catalog.pg_index index_state
            join pg_catalog.pg_class index_relation on index_relation.oid = index_state.indexrelid
            where index_state.indrelid = to_regclass('public.bot_channel_webhooks')
              and index_relation.relname = 'bot_channel_webhooks_workspace_id_uidx'
              and index_state.indisunique and index_state.indisvalid and index_state.indisready
              and index_state.indpred is null
          )
        union all
        select
          '076.index.webhook_account_event',
          exists (
            select 1
            from pg_catalog.pg_index index_state
            join pg_catalog.pg_class index_relation on index_relation.oid = index_state.indexrelid
            where index_state.indrelid = to_regclass('public.bot_channel_webhooks')
              and index_relation.relname = 'bot_channel_webhooks_account_event_uidx'
              and index_state.indisunique and index_state.indisvalid and index_state.indisready
              and index_state.indpred is not null
              and index_state.indnkeyatts = 2
              and pg_catalog.pg_get_indexdef(index_state.indexrelid, 1, true) = 'channel_account_id'
              and pg_catalog.pg_get_indexdef(index_state.indexrelid, 2, true) = 'external_message_id'
              and pg_catalog.regexp_replace(
                lower(pg_catalog.pg_get_expr(index_state.indpred, index_state.indrelid, true)),
                '[()[:space:]]', '', 'g'
              ) = 'channel_account_idisnotnullandexternal_message_idisnotnull'
          )
        union all
        select
          '076.index.webhook_legacy_absent',
          to_regclass('public.bot_channel_webhooks_workspace_message_uidx') is null
        union all
        select
          '076.index.webhook_reclaim',
          exists (
            select 1
            from pg_catalog.pg_index index_state
            join pg_catalog.pg_class index_relation on index_relation.oid = index_state.indexrelid
            where index_state.indrelid = to_regclass('public.bot_channel_webhooks')
              and index_relation.relname = 'bot_channel_webhooks_reclaim_idx'
              and not index_state.indisunique and index_state.indisvalid and index_state.indisready
              and index_state.indpred is not null
          )
        union all
        select
          '076.index.webhook_account_received',
          exists (
            select 1
            from pg_catalog.pg_index index_state
            join pg_catalog.pg_class index_relation on index_relation.oid = index_state.indexrelid
            where index_state.indrelid = to_regclass('public.bot_channel_webhooks')
              and index_relation.relname = 'bot_channel_webhooks_account_received_idx'
              and not index_state.indisunique and index_state.indisvalid and index_state.indisready
              and index_state.indpred is not null
          )
        union all
        select
          '076.table.webhook_envelopes',
          to_regclass('public.bot_channel_webhook_envelopes') is not null
          and exists (
            select 1
            from pg_catalog.pg_constraint
            where conrelid = to_regclass('public.bot_channel_webhook_envelopes')
              and conname = 'bot_channel_webhook_envelopes_payload_key'
              and contype = 'u' and convalidated
          )
          and exists (
            select 1
            from pg_catalog.pg_constraint
            where conrelid = to_regclass('public.bot_channel_webhook_envelopes')
              and conname = 'bot_channel_webhook_envelopes_reason_check'
              and contype = 'c' and convalidated
          )
        union all
        select
          '076.rpc.webhook_envelope_quarantine',
          exists (
            select 1
            from pg_catalog.pg_proc routine
            join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
            where namespace.nspname = 'public'
              and routine.oid = to_regprocedure(
                'public.quarantine_bot_channel_webhook_envelope(text,text,integer,text)'
              )
              and routine.prosecdef
              and routine.prorettype = 'uuid'::regtype
              and coalesce(array_to_string(routine.proconfig, ','), '')
                = 'search_path=pg_catalog'
          )
        union all
        select
          '076.grants.webhook_envelope_quarantine',
          exists (
            select 1
            from pg_catalog.pg_roles role_state
            where role_state.rolname = 'novalure_tenant_app'
              and pg_catalog.has_function_privilege(
                role_state.oid,
                to_regprocedure('public.quarantine_bot_channel_webhook_envelope(text,text,integer,text)'),
                'EXECUTE'
              )
              and not pg_catalog.has_table_privilege(
                role_state.oid, to_regclass('public.bot_channel_webhook_envelopes'), 'SELECT'
              )
              and not pg_catalog.has_table_privilege(
                role_state.oid, to_regclass('public.bot_channel_webhook_envelopes'), 'INSERT'
              )
              and not pg_catalog.has_table_privilege(
                role_state.oid, to_regclass('public.bot_channel_webhook_envelopes'), 'UPDATE'
              )
              and not pg_catalog.has_table_privilege(
                role_state.oid, to_regclass('public.bot_channel_webhook_envelopes'), 'DELETE'
              )
          )
          and not exists (
            select 1
            from pg_catalog.pg_proc routine
            cross join lateral pg_catalog.aclexplode(
              coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
            ) acl
            where routine.oid = to_regprocedure(
              'public.quarantine_bot_channel_webhook_envelope(text,text,integer,text)'
            )
              and acl.grantee = 0
              and acl.privilege_type = 'EXECUTE'
          )
          and not exists (
            select 1
            from pg_catalog.pg_class relation
            cross join lateral pg_catalog.aclexplode(
              coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
            ) acl
            where relation.oid = to_regclass('public.bot_channel_webhook_envelopes')
              and acl.grantee = 0
          )
        union all
        select
          '076.columns.event_ids',
          (
            select count(*) = 7
            from (values
              ('bot_conversations'), ('bot_messages'), ('bot_tool_calls'),
              ('bot_document_sends'), ('contact_timeline_items'), ('audit_logs'),
              ('approval_requests')
            ) expected(table_name)
            join pg_catalog.pg_class relation on relation.relname = expected.table_name
            join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace and namespace.nspname = 'public'
            join pg_catalog.pg_attribute attribute
              on attribute.attrelid = relation.oid
             and attribute.attname = 'webhook_event_id'
             and attribute.attnum > 0 and not attribute.attisdropped
             and pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = 'uuid'
             and not attribute.attnotnull
          )
        union all
        select
          '076.indexes.event_unique',
          (
            select count(*) = 7
            from pg_catalog.pg_index index_state
            join pg_catalog.pg_class index_relation on index_relation.oid = index_state.indexrelid
            where index_relation.relname = any(array[
              'bot_conversations_webhook_event_uidx',
              'bot_messages_webhook_role_uidx',
              'bot_tool_calls_webhook_tool_uidx',
              'bot_document_sends_webhook_event_uidx',
              'contact_timeline_items_webhook_event_uidx',
              'audit_logs_webhook_action_uidx',
              'approval_requests_webhook_action_uidx'
            ]::text[])
              and index_state.indisunique and index_state.indisvalid and index_state.indisready
              and index_state.indpred is not null
          )
        union all
        select
          '076.constraints.event_fks',
          (
            select count(*) = 6
            from pg_catalog.pg_constraint
            where conname = any(array[
              'bot_conversations_workspace_webhook_event_fk',
              'bot_messages_workspace_webhook_event_fk',
              'bot_tool_calls_workspace_webhook_event_fk',
              'bot_document_sends_workspace_webhook_event_fk',
              'contact_timeline_items_workspace_webhook_event_fk',
              'approval_requests_workspace_webhook_event_fk'
            ]::text[])
              and contype = 'f'
              and confrelid = to_regclass('public.bot_channel_webhooks')
              and convalidated and condeferrable and condeferred and confdeltype = 'n'
          )
        union all
        select
          '076.audit.snapshot_without_fk',
          not exists (
            select 1 from pg_catalog.pg_constraint
            where conrelid = to_regclass('public.audit_logs')
              and conname = 'audit_logs_workspace_webhook_event_fk'
          )
      ) artifact_state
      order by artifact
    `,
  ], { readOnly: true });
  return {
    batch: results[4][0] ?? null,
    batchObjectCount: Number(results[9][0]?.count ?? 0),
    ledgerAccess: results[6][0] ?? null,
    markerCounts: {
      contacts: Number(results[10][0]?.contacts ?? 0),
      deals: Number(results[10][0]?.deals ?? 0),
    },
    launchSchemaArtifacts: results[11],
    migrations: results[5],
    project: results[2][0] ?? null,
    tenantConstraintState: results[7][0] ?? null,
    tenantRelationViolations: results[8],
    users: results[3],
    workspace: results[1][0] ?? null,
  };
}

async function remainingBatchRows(sql, tenant) {
  const results = await sql.transaction((transaction) => [
    transaction`select set_config('app.tenant_id', ${tenant.workspaceId}, true), set_config('app.actor_id', ${tenant.resetActorUserId}, true)`,
    transaction`
      with targets as (
        select resource_type, resource_id::uuid as resource_id
        from qa_batch_objects
        where workspace_id = ${tenant.workspaceId}::uuid
          and batch_id = ${tenant.batchId}::uuid
          and resource_scope = 'database'
      )
      select 'contacts' as resource_type, count(*)::int as count
      from targets join contacts on targets.resource_type = 'contacts' and contacts.id = targets.resource_id
      union all
      select 'consent_records', count(*)::int
      from targets join consent_records on targets.resource_type = 'consent_records' and consent_records.id = targets.resource_id
      union all
      select 'deals', count(*)::int
      from targets join deals on targets.resource_type = 'deals' and deals.id = targets.resource_id
      union all
      select 'deal_stage_history', count(*)::int
      from targets join deal_stage_history on targets.resource_type = 'deal_stage_history' and deal_stage_history.id = targets.resource_id
      union all
      select 'marker_contacts', count(*)::int
      from contacts
      where workspace_id = ${tenant.workspaceId}::uuid
        and starts_with(name, ${tenant.batchMarker})
      union all
      select 'marker_deals', count(*)::int
      from deals
      where workspace_id = ${tenant.workspaceId}::uuid
        and starts_with(name, ${tenant.batchMarker})
      union all
      select 'marker_consent_records', count(*)::int
      from consent_records consent
      join contacts contact on contact.id = consent.contact_id and contact.workspace_id = consent.workspace_id
      where consent.workspace_id = ${tenant.workspaceId}::uuid
        and starts_with(contact.name, ${tenant.batchMarker})
      union all
      select 'marker_deal_stage_history', count(*)::int
      from deal_stage_history history
      join deals deal on deal.id = history.deal_id and deal.workspace_id = history.workspace_id
      where history.workspace_id = ${tenant.workspaceId}::uuid
        and starts_with(deal.name, ${tenant.batchMarker})
      order by resource_type
    `,
  ], { readOnly: true });
  return Object.fromEntries(results[1].map((row) => [row.resource_type, Number(row.count)]));
}

async function verifyDatabasePreflight(config, evidence) {
  await assertQaTarget();
  const sql = neon(config.database.url);
  const check = resultRecorder(evidence);
  const expectedMigrationChecksums = await loadRequiredMigrationChecksums();
  for (const tenant of config.tenants) {
    const state = await scopedRead(sql, tenant, tenant.resetActorUserId);
    check(`${tenant.key.toLowerCase()}.db.app_role`, state.ledgerAccess?.appRole === true, state.ledgerAccess?.appRole, true);
    check(`${tenant.key.toLowerCase()}.db.tenant_role_inherited`, state.ledgerAccess?.tenantRoleInherited === true, state.ledgerAccess?.tenantRoleInherited, true);
    check(`${tenant.key.toLowerCase()}.db.qa_batches_rls_active`, state.ledgerAccess?.qaBatchesRlsActive === true, state.ledgerAccess?.qaBatchesRlsActive, true);
    check(`${tenant.key.toLowerCase()}.db.qa_batch_objects_rls_active`, state.ledgerAccess?.qaBatchObjectsRlsActive === true, state.ledgerAccess?.qaBatchObjectsRlsActive, true);
    check(`${tenant.key.toLowerCase()}.db.ledger_base_denied`, state.ledgerAccess?.baseDenied === true, state.ledgerAccess?.baseDenied, true);
    check(`${tenant.key.toLowerCase()}.db.ledger_projection_read_only`, state.ledgerAccess?.projectionReadOnly === true, state.ledgerAccess?.projectionReadOnly, true);
    check(`${tenant.key.toLowerCase()}.db.ledger_projection_owner_scoped`, state.ledgerAccess?.projectionOwnerScoped === true, state.ledgerAccess?.projectionOwnerScoped, true);
    check(`${tenant.key.toLowerCase()}.db.ledger_projection_columns_exact`, state.ledgerAccess?.projectionColumnsExact === true, state.ledgerAccess?.projectionColumnsExact, true);
    check(`${tenant.key.toLowerCase()}.db.ledger_projection_public_denied`, state.ledgerAccess?.projectionPublicDenied === true, state.ledgerAccess?.projectionPublicDenied, true);
    check(`${tenant.key.toLowerCase()}.db.workspace_is_qa`, state.workspace?.isQa === true, Boolean(state.workspace?.isQa), true);
    check(`${tenant.key.toLowerCase()}.db.project_scope`, state.project?.workspaceId === tenant.workspaceId, Boolean(state.project), true);
    check(`${tenant.key.toLowerCase()}.db.batch_exists`, Boolean(state.batch), Boolean(state.batch), true);
    check(`${tenant.key.toLowerCase()}.db.batch_marker`, state.batch?.batchMarker === tenant.batchMarker, state.batch?.batchMarker === tenant.batchMarker, true);
    check(`${tenant.key.toLowerCase()}.db.batch_actor`, state.batch?.createdByUserId === tenant.resetActorUserId, state.batch?.createdByUserId === tenant.resetActorUserId, true);
    check(`${tenant.key.toLowerCase()}.db.batch_unused`, state.batchObjectCount === 0, state.batchObjectCount, 0);
    const priorMarkerRows = Object.values(state.markerCounts).reduce((sum, count) => sum + count, 0);
    check(`${tenant.key.toLowerCase()}.db.marker_unused`, priorMarkerRows === 0, priorMarkerRows, 0);
    const userById = new Map(state.users.map((user) => [user.id, user]));
    for (const actor of Object.values(tenant.actors)) {
      const persisted = userById.get(actor.userId);
      check(`${tenant.key.toLowerCase()}.db.actor.${actor.name}`, persisted?.status === "active" && persisted?.role === actor.appRole && persisted?.productRole === actor.productRole, Boolean(persisted), true);
    }
    const resetActor = userById.get(tenant.resetActorUserId);
    check(`${tenant.key.toLowerCase()}.db.reset_actor`, resetActor?.role === "owner" && resetActor?.productRole === "platform_admin" && resetActor?.status === "active", Boolean(resetActor), true);
    const tenantRelationGate = evaluateQaTenantRelationGate({
      constraintState: state.tenantConstraintState,
      expectedMigrationChecksums,
      migrations: state.migrations,
      schemaArtifacts: state.launchSchemaArtifacts,
      violations: state.tenantRelationViolations,
    });
    check(`${tenant.key.toLowerCase()}.db.migrations_launch_required`, tenantRelationGate.migrationsPresent, tenantRelationGate.errors, qaRequiredMigrationVersions);
    check(`${tenant.key.toLowerCase()}.db.migrations_launch_required_checksummed`, tenantRelationGate.migrationsChecksummed, tenantRelationGate.errors, true);
    check(`${tenant.key.toLowerCase()}.db.launch_schema_artifacts_075_076`, tenantRelationGate.schemaArtifactsValid, tenantRelationGate.errors, qaLaunchSchemaArtifactNames);
    check(`${tenant.key.toLowerCase()}.db.tenant_constraints_present`, tenantRelationGate.constraintsPresent, state.tenantConstraintState?.found, qaTenantConstraintNames.length);
    check(`${tenant.key.toLowerCase()}.db.tenant_constraints_validated`, tenantRelationGate.constraintsValidated, state.tenantConstraintState?.validated, qaTenantConstraintNames.length);
    check(`${tenant.key.toLowerCase()}.db.tenant_constraints_deferrable`, tenantRelationGate.constraintsDeferrable, state.tenantConstraintState, { deferrable: qaTenantConstraintNames.length, initiallyDeferred: qaTenantConstraintNames.length });
    check(`${tenant.key.toLowerCase()}.db.tenant_relation_preflight_count`, tenantRelationGate.relationChecksPresent, state.tenantRelationViolations.length, qaTenantConstraintNames.length);
    check(`${tenant.key.toLowerCase()}.db.tenant_relation_preflight_zero`, tenantRelationGate.relationViolationsZero, tenantRelationGate.violationTotal, 0);
    check(`${tenant.key.toLowerCase()}.db.tenant_relation_gate`, tenantRelationGate.ok, tenantRelationGate.errors, []);
    evidence.targets.push({
      batch: fingerprint(tenant.batchId),
      branch: fingerprint(config.database.branchId),
      project: fingerprint(tenant.projectId),
      tenant: tenant.key,
      workspace: fingerprint(tenant.workspaceId),
    });
  }
  return sql;
}

async function verifyHttpPreflight(config, evidence, options = {}, clients = new Map()) {
  const check = resultRecorder(evidence);
  const publicClient = createPublicClient(config, evidence);
  for (const tenant of config.tenants) {
    for (const actor of Object.values(tenant.actors)) {
      const client = createHttpClient(config, actor, tenant, evidence);
      await client.login();
      clients.set(`${tenant.key}:${actor.name}`, client);
      check(`${tenant.key.toLowerCase()}.auth.${actor.name}`, true, 200, 200);
    }
    const resetActor = {
      ...config.resetAdmin,
      name: "resetAdmin",
      userId: tenant.resetActorUserId,
    };
    const resetClient = createHttpClient(config, resetActor, tenant, evidence);
    await resetClient.login();
    clients.set(`${tenant.key}:resetAdmin`, resetClient);
    check(`${tenant.key.toLowerCase()}.auth.reset_admin`, true, 200, 200);
  }

  for (let index = 0; index < config.tenants.length; index += 1) {
    const tenant = config.tenants[index];
    const other = config.tenants[index === 0 ? 1 : 0];
    for (const actorName of Object.keys(tenant.actors)) {
      const client = clients.get(`${tenant.key}:${actorName}`);
      const foreignRead = await client.request(`/api/crm/core?workspaceId=${encodeURIComponent(other.workspaceId)}`);
      check(`${tenant.key.toLowerCase()}.cross_tenant.${actorName}.read`, foreignRead.response.status === 403, foreignRead.response.status, 403);
    }
    const anonymousCore = await publicClient.request(`/api/crm/core?workspaceId=${encodeURIComponent(tenant.workspaceId)}`);
    check(`${tenant.key.toLowerCase()}.public.api_read`, anonymousCore.response.status === 401, anonymousCore.response.status, 401);
    const publicPage = await publicClient.request(tenant.publicPath);
    check(
      `${tenant.key.toLowerCase()}.public.page`,
      publicPage.response.status === 200 && (publicPage.response.headers.get("content-type") ?? "").includes("text/html"),
      publicPage.response.status,
      200,
    );
    check(`${tenant.key.toLowerCase()}.public.no_cross_tenant_id`, !publicPage.text.includes(other.workspaceId), false, false);
  }

  if (options.requireAtomicCapability) {
    for (const tenant of config.tenants) {
      const client = clients.get(`${tenant.key}:resetAdmin`);
      const capability = await client.request(capabilityPath);
      const valid =
        capability.response.status === 200 &&
        capability.json?.atomicRegistration === true &&
        capability.json?.version === 1 &&
        capability.json?.header === batchHeader &&
        capability.json?.gitSha === config.expectedGitSha;
      check(`${tenant.key.toLowerCase()}.batch.atomic_capability`, valid, capability.response.status, 200);
    }
  }
  return clients;
}

function corePayload(result) {
  return result.json?.data ?? result.json ?? {};
}

async function runTenantBusinessMatrix(config, tenant, otherTenant, clients, evidence) {
  const check = resultRecorder(evidence);
  const publicClient = createPublicClient(config, evidence);
  const actorNames = ["owner", "admin", "member"];
  const contacts = new Map();
  const deals = new Map();

  for (const actorName of actorNames) {
    const client = clients.get(`${tenant.key}:${actorName}`);
    const name = markerFor(config, tenant, `contact-${actorName}`);
    const create = await client.request(`/api/crm/contacts?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, {
      batchMutation: true,
      json: {
        contact: {
          consent: "Nur CRM",
          email: emailFor(config, tenant, `contact-${actorName}`),
          intent: name,
          name,
          projectId: tenant.projectId,
          role: "Käufer",
          source: "Manual",
          workspaceId: otherTenant.workspaceId,
        },
      },
      method: "POST",
    });
    check(`${tenant.key.toLowerCase()}.contact.${actorName}.create`, create.response.status === 200, create.response.status, 200);
    client.assertAtomicRegistration(create, `${tenant.key} ${actorName} contact create`);
    check(`${tenant.key.toLowerCase()}.contact.${actorName}.payload_scope`, create.json?.contact?.workspaceId === tenant.workspaceId, create.json?.contact?.workspaceId === tenant.workspaceId, true);
    contacts.set(actorName, create.json.contact);
  }

  const customer = clients.get(`${tenant.key}:customer`);
  const deniedCustomerCreate = await customer.request(`/api/crm/contacts?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, {
    batchMutation: true,
    json: { contact: { email: emailFor(config, tenant, "customer-denied"), name: markerFor(config, tenant, "customer-denied"), projectId: tenant.projectId } },
    method: "POST",
  });
  check(`${tenant.key.toLowerCase()}.contact.customer.create`, deniedCustomerCreate.response.status === 403, deniedCustomerCreate.response.status, 403);
  const deniedPublicCreate = await publicClient.request(`/api/crm/contacts?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, {
    json: { contact: { email: emailFor(config, tenant, "public-denied"), name: markerFor(config, tenant, "public-denied"), projectId: tenant.projectId } },
    method: "POST",
  });
  check(`${tenant.key.toLowerCase()}.contact.public.create`, deniedPublicCreate.response.status === 401, deniedPublicCreate.response.status, 401);

  const customerRead = await customer.request(`/api/crm/core?workspaceId=${encodeURIComponent(tenant.workspaceId)}`);
  check(`${tenant.key.toLowerCase()}.contact.customer.read`, customerRead.response.status === 200, customerRead.response.status, 200);
  const publicRead = await publicClient.request(`/api/crm/core?workspaceId=${encodeURIComponent(tenant.workspaceId)}`);
  check(`${tenant.key.toLowerCase()}.contact.public.read`, publicRead.response.status === 401, publicRead.response.status, 401);

  for (const actorName of actorNames) {
    const client = clients.get(`${tenant.key}:${actorName}`);
    const core = await client.request(`/api/crm/core?workspaceId=${encodeURIComponent(tenant.workspaceId)}`);
    const visible = (corePayload(core).contacts ?? []).some((contact) => contact.id === contacts.get(actorName).id);
    check(`${tenant.key.toLowerCase()}.contact.${actorName}.read`, core.response.status === 200 && visible, core.response.status, 200);
    const update = await client.request(`/api/crm/contacts?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, {
      batchMutation: true,
      json: { contact: { ...contacts.get(actorName), intent: markerFor(config, tenant, `updated-${actorName}`) } },
      method: "PATCH",
    });
    check(`${tenant.key.toLowerCase()}.contact.${actorName}.update`, update.response.status === 200, update.response.status, 200);
    client.assertAtomicRegistration(update, `${tenant.key} ${actorName} contact update`);
    contacts.set(actorName, update.json.contact);
  }

  const ownerCore = await clients.get(`${tenant.key}:owner`).request(`/api/crm/core?workspaceId=${encodeURIComponent(tenant.workspaceId)}`);
  const stages = (corePayload(ownerCore).crmPipelineStages ?? [])
    .filter((stage) => stage.projectId === tenant.projectId)
    .sort((left, right) => left.position - right.position);
  check(`${tenant.key.toLowerCase()}.deal.pipeline_stages`, stages.length >= 2, stages.length, ">=2");

  for (const actorName of actorNames) {
    const client = clients.get(`${tenant.key}:${actorName}`);
    const name = markerFor(config, tenant, `deal-${actorName}`);
    const create = await client.request(`/api/crm/deals?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, {
      batchMutation: true,
      headers: { "Idempotency-Key": `${tenant.batchMarker}:${actorName}:deal` },
      json: {
        deal: {
          contactId: contacts.get(actorName).id,
          expectedCloseDate: "2027-12-31",
          name,
          nextAction: name,
          probability: 35,
          projectId: tenant.projectId,
          riskLevel: "mittel",
          source: "Manual",
          stage: stages[0].name,
          value: "410000",
        },
      },
      method: "POST",
    });
    check(`${tenant.key.toLowerCase()}.deal.${actorName}.create`, create.response.status === 200, create.response.status, 200);
    client.assertAtomicRegistration(create, `${tenant.key} ${actorName} deal create`);
    deals.set(actorName, create.json.deal);
  }

  const owner = clients.get(`${tenant.key}:owner`);
  const concurrencyKey = `${tenant.batchMarker}:owner:concurrency`;
  const concurrencyPayload = {
    deal: {
      contactId: contacts.get("owner").id,
      expectedCloseDate: "2027-12-31",
      name: markerFor(config, tenant, "deal-concurrency"),
      nextAction: markerFor(config, tenant, "deal-concurrency"),
      probability: 42,
      projectId: tenant.projectId,
      riskLevel: "mittel",
      source: "Manual",
      stage: stages[0].name,
      value: "420000",
    },
  };
  const concurrent = await Promise.all([
    owner.request(`/api/crm/deals?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, { batchMutation: true, headers: { "Idempotency-Key": concurrencyKey }, json: concurrencyPayload, method: "POST" }),
    owner.request(`/api/crm/deals?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, { batchMutation: true, headers: { "Idempotency-Key": concurrencyKey }, json: concurrencyPayload, method: "POST" }),
  ]);
  check(`${tenant.key.toLowerCase()}.deal.concurrency`, concurrent.every((item) => item.response.status === 200), concurrent.map((item) => item.response.status), [200, 200]);
  check(`${tenant.key.toLowerCase()}.deal.idempotency`, concurrent[0].json?.deal?.id === concurrent[1].json?.deal?.id, concurrent[0].json?.deal?.id === concurrent[1].json?.deal?.id, true);
  for (const item of concurrent) owner.assertAtomicRegistration(item, `${tenant.key} concurrent deal create`);

  const ownerDeal = deals.get("owner");
  const dealUpdate = await owner.request(`/api/crm/deals?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, {
    batchMutation: true,
    json: { deal: { ...ownerDeal, nextAction: markerFor(config, tenant, "deal-updated"), probability: 61, stage: stages[1].name, value: "515000" } },
    method: "PATCH",
  });
  check(`${tenant.key.toLowerCase()}.deal.owner.update`, dealUpdate.response.status === 200, dealUpdate.response.status, 200);
  owner.assertAtomicRegistration(dealUpdate, `${tenant.key} owner deal update`);

  const freshOwner = createHttpClient(config, tenant.actors.owner, tenant, evidence);
  clients.set(`${tenant.key}:ownerReload`, freshOwner);
  try {
    await freshOwner.login();
    const reload = await freshOwner.request(`/api/crm/core?workspaceId=${encodeURIComponent(tenant.workspaceId)}`);
    const persistedDeal = (corePayload(reload).deals ?? []).find((deal) => deal.id === ownerDeal.id);
    check(`${tenant.key.toLowerCase()}.persistence.relogin`, persistedDeal?.probability === 61 && String(persistedDeal?.value ?? "").includes("515"), Boolean(persistedDeal), true);
  } finally {
    await freshOwner.logout();
  }

  for (const actorName of ["owner", "admin", "member", "customer"]) {
    const foreignClient = clients.get(`${otherTenant.key}:${actorName}`);
    const foreignUpdate = await foreignClient.request(`/api/crm/contacts?workspaceId=${encodeURIComponent(otherTenant.workspaceId)}`, {
      batchMutation: true,
      json: { contact: { id: contacts.get("member").id, intent: "foreign", name: "foreign" } },
      method: "PATCH",
    });
    check(`${tenant.key.toLowerCase()}.cross_tenant.${actorName}.update`, responseStatusAllowed(foreignUpdate.response, [403, 404]), foreignUpdate.response.status, [403, 404]);
  }

  const customerUpdate = await customer.request(`/api/crm/contacts?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, {
    batchMutation: true,
    json: { contact: { id: contacts.get("owner").id, intent: "forbidden", name: "forbidden" } },
    method: "PATCH",
  });
  check(`${tenant.key.toLowerCase()}.contact.customer.update`, customerUpdate.response.status === 403, customerUpdate.response.status, 403);
  const publicUpdate = await publicClient.request(`/api/crm/contacts?workspaceId=${encodeURIComponent(tenant.workspaceId)}`, {
    json: { contact: { id: contacts.get("owner").id, intent: "forbidden", name: "forbidden" } },
    method: "PATCH",
  });
  check(`${tenant.key.toLowerCase()}.contact.public.update`, publicUpdate.response.status === 401, publicUpdate.response.status, 401);

  const deniedMemberDelete = await clients.get(`${tenant.key}:member`).request(`/api/crm/contacts?id=${encodeURIComponent(contacts.get("member").id)}&workspaceId=${encodeURIComponent(tenant.workspaceId)}`, { batchMutation: true, method: "DELETE" });
  check(`${tenant.key.toLowerCase()}.contact.member.delete`, deniedMemberDelete.response.status === 403, deniedMemberDelete.response.status, 403);
  const deniedCustomerDelete = await customer.request(`/api/crm/contacts?id=${encodeURIComponent(contacts.get("owner").id)}`, { batchMutation: true, method: "DELETE" });
  check(`${tenant.key.toLowerCase()}.contact.customer.delete`, deniedCustomerDelete.response.status === 403, deniedCustomerDelete.response.status, 403);
  const deniedPublicDelete = await publicClient.request(`/api/crm/contacts?id=${encodeURIComponent(contacts.get("owner").id)}`, { method: "DELETE" });
  check(`${tenant.key.toLowerCase()}.contact.public.delete`, deniedPublicDelete.response.status === 401, deniedPublicDelete.response.status, 401);
  const ownerDelete = await owner.request(`/api/crm/contacts?id=${encodeURIComponent(contacts.get("owner").id)}&workspaceId=${encodeURIComponent(tenant.workspaceId)}`, { batchMutation: true, method: "DELETE" });
  check(`${tenant.key.toLowerCase()}.contact.owner.delete`, ownerDelete.response.status === 200, ownerDelete.response.status, 200);
  owner.assertAtomicRegistration(ownerDelete, `${tenant.key} owner contact archive`);
  const admin = clients.get(`${tenant.key}:admin`);
  const adminDelete = await admin.request(`/api/crm/contacts?id=${encodeURIComponent(contacts.get("admin").id)}&workspaceId=${encodeURIComponent(tenant.workspaceId)}`, { batchMutation: true, method: "DELETE" });
  check(`${tenant.key.toLowerCase()}.contact.admin.delete`, adminDelete.response.status === 200, adminDelete.response.status, 200);
  admin.assertAtomicRegistration(adminDelete, `${tenant.key} admin contact archive`);
}

async function resetTenant(tenant, client, sql, evidence) {
  const check = resultRecorder(evidence);
  await client.logout();
  await client.login();
  const dryRun = await client.request("/api/admin/qa-reset", {
    json: { batchId: tenant.batchId, confirmation: null, mode: "dry_run", workspaceId: tenant.workspaceId },
    method: "POST",
  });
  const planDigest = typeof dryRun.json?.plan?.digest === "string" && /^[0-9a-f]{64}$/.test(dryRun.json.plan.digest)
    ? dryRun.json.plan.digest
    : null;
  check(
    `${tenant.key.toLowerCase()}.cleanup.dry_run`,
    dryRun.response.status === 200 &&
      dryRun.json?.outcome === "dry_run" &&
      (dryRun.json?.plan?.blockers ?? []).length === 0 &&
      planDigest !== null,
    { outcome: dryRun.json?.outcome ?? null, status: dryRun.response.status, validPlanDigest: planDigest !== null },
    { outcome: "dry_run", status: 200, validPlanDigest: true },
  );
  const execute = await client.request("/api/admin/qa-reset", {
    json: {
      batchId: tenant.batchId,
      confirmation: `RESET QA BATCH ${tenant.workspaceId} ${tenant.batchId}`,
      expectedPlanDigest: planDigest,
      mode: "execute",
      workspaceId: tenant.workspaceId,
    },
    method: "POST",
  });
  const expectedDeletedCounts = Object.fromEntries(
    (dryRun.json?.plan?.targets ?? []).map((target) => [target.table, target.ids.length]),
  );
  const executeMatchesDryRun =
    execute.json?.plan?.digest === planDigest &&
    canonicalJson(execute.json?.deletedCounts ?? {}) === canonicalJson(expectedDeletedCounts);
  check(
    `${tenant.key.toLowerCase()}.cleanup.execute`,
    execute.response.status === 200 && execute.json?.outcome === "executed" && executeMatchesDryRun,
    {
      countsMatch: canonicalJson(execute.json?.deletedCounts ?? {}) === canonicalJson(expectedDeletedCounts),
      outcome: execute.json?.outcome ?? null,
      planDigestMatch: execute.json?.plan?.digest === planDigest,
      status: execute.response.status,
    },
    { countsMatch: true, outcome: "executed", planDigestMatch: true, status: 200 },
  );
  const remaining = await remainingBatchRows(sql, tenant);
  const total = Object.values(remaining).reduce((sum, count) => sum + count, 0);
  check(`${tenant.key.toLowerCase()}.cleanup.remaining_rows`, total === 0, total, 0);
  evidence.cleanup.push({
    deletedCounts: execute.json?.deletedCounts ?? {},
    planDigest,
    remaining,
    tenant: tenant.key,
  });
}

async function writeEvidence(config, evidence) {
  evidence.completedAt = new Date().toISOString();
  evidence.summary = {
    failed: evidence.results.filter((row) => row.status === "fail").length,
    passed: evidence.results.filter((row) => row.status === "pass").length,
    requests: evidence.requests.length,
  };
  assertEvidenceContainsNoSecrets(evidence);
  const serialized = canonicalJson(evidence);
  const digest = createHash("sha256").update(serialized).digest("hex");
  const directory = path.resolve(config.evidenceDirectory);
  const evidenceName = `${evidence.mode}-two-tenant-e2e.json`;
  const digestName = `${evidence.mode}-two-tenant-e2e.sha256`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, evidenceName), serialized, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(path.join(directory, digestName), `${digest}  ${evidenceName}\n`, { encoding: "utf8", flag: "wx" });
  console.log(`Evidence written: ${directory}`);
  console.log(`Evidence digest: sha256:${digest}`);
}

function createEvidence(config, mode) {
  return {
    cleanup: [],
    commit: config.expectedGitSha,
    completedAt: null,
    mode,
    requests: [],
    results: [],
    run: fingerprint(config.runPrefix),
    schema: "novalure.qa.two-tenant-e2e.v1",
    startedAt: new Date().toISOString(),
    summary: null,
    targets: [],
  };
}

async function main() {
  const mode = modeFromArgs(process.argv.slice(2));
  if (mode === "help") {
    usage();
    return;
  }
  if (mode === "plan") {
    console.log("TWO_TENANT_QA_MATRIX");
    console.log(canonicalJson(buildQaTwoTenantScenarioMatrix()).trim());
    console.log("REQUIRED_ENVIRONMENT");
    console.log(qaTwoTenantRequiredEnvironment().join("\n"));
    console.log("No network or writes performed.");
    return;
  }

  const config = parseQaTwoTenantConfig(process.env, { requireExecution: mode === "execute" });
  console.log(`QA config valid: run=${fingerprint(config.runPrefix)}; preview=${fingerprint(config.baseUrl)}; commit=${config.expectedGitSha}.`);
  if (mode === "validate-config") return;

  const evidence = createEvidence(config, mode);
  let sql = null;
  let clients = null;
  let businessWritesStarted = false;
  let failure = null;
  try {
    sql = await verifyDatabasePreflight(config, evidence);
    clients = new Map();
    await verifyHttpPreflight(config, evidence, { requireAtomicCapability: mode === "execute" }, clients);
    if (mode !== "preflight") {
      businessWritesStarted = true;
      for (let index = 0; index < config.tenants.length; index += 1) {
        const tenant = config.tenants[index];
        const otherTenant = config.tenants[index === 0 ? 1 : 0];
        await runTenantBusinessMatrix(config, tenant, otherTenant, clients, evidence);
      }
    }
  } catch (error) {
    failure = error;
    evidence.results.push({ actual: "stopped", expected: "pass", id: "harness.stop_condition", status: "fail" });
  } finally {
    if (businessWritesStarted && clients && sql) {
      for (const tenant of config.tenants) {
        try {
          await resetTenant(tenant, clients.get(`${tenant.key}:resetAdmin`), sql, evidence);
        } catch (cleanupError) {
          evidence.results.push({ actual: "cleanup_failed", expected: "executed_and_zero", id: `${tenant.key.toLowerCase()}.cleanup.finally`, status: "fail" });
          failure ??= cleanupError;
        }
      }
    }
    if (clients) {
      let logoutIndex = 0;
      for (const client of new Set(clients.values())) {
        try {
          const status = await client.logout();
          evidence.results.push({ actual: status, expected: [204, 303], id: `auth.logout.${logoutIndex}`, status: "pass" });
        } catch (logoutError) {
          evidence.results.push({ actual: "logout_failed", expected: 303, id: `auth.logout.${logoutIndex}`, status: "fail" });
          failure ??= logoutError;
        }
        logoutIndex += 1;
      }
    }
    try {
      await writeEvidence(config, evidence);
    } catch (evidenceError) {
      failure ??= evidenceError;
    }
  }
  if (failure) throw failure;
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  main().catch((error) => {
    console.error(`QA two-tenant harness failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
