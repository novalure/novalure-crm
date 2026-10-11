import "server-only";

import pg from "pg";
import { resolveDatabaseUrl } from "@/lib/db/client";
import { localTestDatabaseTarget } from "@/lib/db/local-test-transport";

const { Pool } = pg;
let lookupPool: pg.Pool | null = null;
let lookupUrl = "";
let expectedDatabase = "";

function pool() {
  const url = process.env.CRM_PUBLIC_FORM_LOOKUP_DATABASE_URL?.trim() ?? "";
  if (!url) throw new Error("Public form lookup database identity is not configured");
  if (lookupPool && lookupUrl !== url) throw new Error("Public form lookup database target changed");
  const local = localTestDatabaseTarget(url);
  const runtimeUrl = resolveDatabaseUrl();
  if (!runtimeUrl) throw new Error("Tenant runtime database target is not configured");
  const lookupTarget = new URL(url);
  const runtimeTarget = new URL(runtimeUrl);
  if (lookupTarget.username !== "novalure_public_form_lookup"
      || lookupTarget.protocol !== runtimeTarget.protocol
      || lookupTarget.hostname.toLowerCase() !== runtimeTarget.hostname.toLowerCase()
      || (lookupTarget.port || "5432") !== (runtimeTarget.port || "5432")
      || lookupTarget.pathname !== runtimeTarget.pathname) {
    throw new Error("Public form lookup target differs from tenant runtime target");
  }
  if (!local && lookupTarget.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Public form lookup requires verified TLS");
  }
  for (const key of lookupTarget.searchParams.keys()) {
    if (key !== "sslmode" && key !== "channel_binding") {
      throw new Error("Unexpected public form lookup connection option");
    }
  }
  if (lookupTarget.searchParams.has("channel_binding")
      && lookupTarget.searchParams.get("channel_binding") !== "require") {
    throw new Error("Unsafe public form lookup channel binding option");
  }
  if (!lookupPool) {
    // Force Node TLS certificate and hostname checks even if a URL parser
    // interprets sslmode differently. The local test cluster is loopback-only.
    lookupTarget.searchParams.delete("sslmode");
    lookupPool = new Pool({
      connectionString: lookupTarget.toString(), max: 3, idleTimeoutMillis: 10_000,
      allowExitOnIdle: true, ssl: local ? false : { rejectUnauthorized: true },
    });
    lookupUrl = url;
    expectedDatabase = decodeURIComponent(lookupTarget.pathname.slice(1));
  }
  return lookupPool;
}

async function verifiedClient() {
  const client = await pool().connect();
  try {
    const role = await client.query<{
      currentUser: string;
      databaseName: string;
      safe: boolean;
    }>(`
      select current_user as "currentUser",
        current_database() as "databaseName",
        not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb
        and not r.rolcreaterole and not r.rolreplication
        and not pg_has_role(r.oid, 'novalure_tenant_app', 'MEMBER')
        and not pg_has_role(r.oid, 'novalure_app', 'MEMBER')
        and not has_table_privilege(r.oid, 'public.forms', 'SELECT')
        and not has_table_privilege(r.oid, 'public.form_submissions', 'SELECT')
        as safe
      from pg_roles r where r.rolname = current_user
    `);
    if (role.rows[0]?.currentUser !== "novalure_public_form_lookup"
        || role.rows[0]?.databaseName !== expectedDatabase
        || role.rows[0]?.safe !== true) {
      throw new Error("Unsafe public form lookup database identity");
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function publicFormLookup(formId: string | null, workspacePublicKey: string, slug: string) {
  const client = await verifiedClient();
  try {
    const result = await client.query<{ form: Record<string, unknown> | null }>(
      "select public.crm_public_form_lookup($1::uuid,$2::text,$3::text) as form",
      [formId, workspacePublicKey, slug],
    );
    return result.rows[0]?.form ?? null;
  } finally { client.release(); }
}

export async function publicFormLegacyRoutes(slug: string) {
  const client = await verifiedClient();
  try {
    const result = await client.query<{ form_id: string; slug: string; workspace_public_key: string }>(
      "select * from public.crm_public_form_legacy_route($1::text)",
      [slug],
    );
    return result.rows;
  } finally { client.release(); }
}

export async function publicFormSubmissionScope(formId: string) {
  const client = await verifiedClient();
  try {
    const result = await client.query<{ workspaceId: string; actorId: string }>(
      'select workspace_id as "workspaceId", actor_id as "actorId" from public.crm_public_form_scope($1::uuid)',
      [formId],
    );
    return result.rows[0] ?? null;
  } finally { client.release(); }
}

/** Local test teardown only; production pools remain process-scoped. */
export async function closePublicFormLookupPool() {
  const active = lookupPool;
  lookupPool = null;
  lookupUrl = "";
  expectedDatabase = "";
  if (active) await active.end();
}
