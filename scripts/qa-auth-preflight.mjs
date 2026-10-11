#!/usr/bin/env node

// This workflow path is deliberately read-only and prints no provider errors,
// connection strings, passwords, or database row values.
import { neon } from "@neondatabase/serverless";

const fail = (code) => { throw new Error(code); };
const required = (name) => process.env[name]?.trim() || fail(`MISSING_${name}`);

function targetUrl(kind, host, role, database, productionHost) {
  let parsed;
  try { parsed = new URL(required(kind)); }
  catch { fail(`${kind}_INVALID`); }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) ||
      !parsed.password ||
      parsed.hostname.toLowerCase() !== host.toLowerCase() ||
      parsed.hostname.toLowerCase() === productionHost.toLowerCase() ||
      parsed.pathname !== `/${database}` ||
      parsed.searchParams.get("sslmode") !== "verify-full" ||
      decodeURIComponent(parsed.username) !== role) {
    fail(`${kind}_TARGET_MISMATCH`);
  }
  return parsed.toString();
}

async function identity(url, code) {
  try {
    const rows = await neon(url)`
      select current_setting('neon.project_id', true) as project_id,
             current_setting('neon.branch_id', true) as branch_id,
             current_database() as database_name,
             current_user as role_name
    `;
    return rows[0] || fail(`${code}_EMPTY`);
  } catch { fail(`${code}_CONNECT_FAILED`); }
}

function verifyIdentity(row, project, branch, database, role, code) {
  if (row.project_id !== project || row.branch_id !== branch ||
      row.database_name !== database || row.role_name !== role) {
    fail(`${code}_IDENTITY_MISMATCH`);
  }
}

async function main() {
  const project = required("NOVALURE_QA_PROJECT_ID");
  const branch = required("NOVALURE_QA_BRANCH_ID");
  const database = required("NOVALURE_QA_DATABASE_NAME");
  const runtimeRole = required("NOVALURE_QA_DATABASE_ROLE");
  const migrationRole = required("NOVALURE_QA_MIGRATION_DATABASE_ROLE");
  if (runtimeRole === migrationRole) fail("ROLE_SEPARATION_FAILED");
  const runtimeUrl = targetUrl(
    "NOVALURE_QA_DATABASE_URL", required("NOVALURE_QA_DATABASE_HOST"),
    runtimeRole, database, required("NOVALURE_PRODUCTION_DATABASE_HOST"),
  );
  const migrationUrl = targetUrl(
    "NOVALURE_QA_MIGRATION_DATABASE_URL", required("NOVALURE_QA_MIGRATION_DATABASE_HOST"),
    migrationRole, database, required("NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST"),
  );
  if (!new URL(runtimeUrl).hostname.includes("-pooler.")) fail("RUNTIME_NOT_POOLED");
  if (new URL(migrationUrl).hostname.includes("-pooler.")) fail("MIGRATION_NOT_DIRECT");
  const runtime = await identity(runtimeUrl, "RUNTIME");
  verifyIdentity(runtime, project, branch, database, runtimeRole, "RUNTIME");
  console.log("QA_AUTH_RUNTIME=PASS");
  const migration = await identity(migrationUrl, "MIGRATION");
  verifyIdentity(migration, project, branch, database, migrationRole, "MIGRATION");
  console.log("QA_AUTH_MIGRATION=PASS");
  console.log("QA_AUTH_ROLE_SEPARATION=PASS");

  let posture;
  try {
    [posture] = await neon(runtimeUrl)`
      select not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb
             and not r.rolcreaterole and not r.rolreplication
             and not has_schema_privilege(current_user, 'public', 'CREATE')
             and not has_database_privilege(current_user, current_database(), 'CREATE')
             and not coalesce(has_table_privilege(current_user,
                 to_regclass('public.novalure_schema_migrations'), 'INSERT,UPDATE,DELETE'), false)
             and not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relowner = r.oid)
             as safe
      from pg_roles r where r.rolname = current_user
    `;
  } catch { fail("RUNTIME_POSTURE_READ_FAILED"); }
  if (posture?.safe !== true) fail("RUNTIME_POSTURE_FAILED");
  console.log("QA_AUTH_RUNTIME_POSTURE=PASS");

  let ledger;
  try {
    ledger = await neon(migrationUrl)`
      select to_regclass('public.novalure_schema_migrations') is not null as present
    `;
    if (ledger[0]?.present) {
      await neon(migrationUrl)`select version, checksum from public.novalure_schema_migrations order by version`;
    }
  } catch { fail("MIGRATION_LEDGER_READ_FAILED"); }
  console.log(`QA_AUTH_LEDGER_READ=PASS;PRESENT=${ledger[0]?.present === true ? "YES" : "NO"}`);
  console.log("QA_AUTH_TARGET=PASS");
}

try { await main(); }
catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message : "UNEXPECTED_FAILURE";
  console.error(`QA_AUTH_PREFLIGHT_FAIL=${code}`);
  process.exitCode = 1;
}
