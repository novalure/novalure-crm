#!/usr/bin/env node

// Historical filename retained so the Candidate workflow continues to prove
// the public-form boundary. V1 no longer binds or exports a database secret:
// it proves the opposite—the old role is NOLOGIN/PASSWORD NULL and the existing
// application runtime alone can execute the registry-backed gateway functions.
import pg from "pg";
import { assertQaTarget } from "./qa-target-guard.mjs";

const qa = await assertQaTarget();
const ownerUrl = process.env.MIGRATION_DATABASE_URL?.trim();
const productionHost = process.env.NOVALURE_PRODUCTION_DATABASE_HOST?.trim().toLowerCase();
if (!ownerUrl || !productionHost || process.env.CRM_PUBLIC_FORM_LOOKUP_DATABASE_URL) {
  throw new Error("QA_GATEWAY_BIND_INPUT_INVALID");
}

function safeUrl(value, role, pooled) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("QA_GATEWAY_BIND_CONNECTION_INVALID"); }
  if (parsed.protocol !== "postgresql:" || decodeURIComponent(parsed.username) !== role
    || parsed.pathname !== `/${qa.expectedDatabase}` || parsed.hostname.includes("-pooler.") !== pooled
    || parsed.hostname.toLowerCase() === productionHost || !parsed.hostname.endsWith(".neon.tech")
    || !["require", "verify-full"].includes(parsed.searchParams.get("sslmode"))) {
    throw new Error("QA_GATEWAY_BIND_SCOPE_INVALID");
  }
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed;
}

const ownerTarget = safeUrl(ownerUrl, "neondb_owner", false);
const runtimeTarget = safeUrl(qa.databaseUrl, "novalure_app", true);
const owner = new pg.Client({ connectionString: ownerTarget.toString(), ssl: { rejectUnauthorized: true } });
const runtime = new pg.Client({ connectionString: runtimeTarget.toString(), ssl: { rejectUnauthorized: true } });

try {
  await Promise.all([owner.connect(), runtime.connect()]);
  const identity = (await owner.query(`select current_setting('neon.project_id',true) project,
    current_setting('neon.branch_id',true) branch,current_database() database,current_user role`)).rows[0];
  if (identity.project !== qa.expectedProjectId || identity.branch !== qa.expectedBranchId
    || identity.database !== qa.expectedDatabase || identity.role !== "neondb_owner") {
    throw new Error("QA_GATEWAY_BIND_FINGERPRINT_INVALID");
  }
  const legacy = (await owner.query(`select r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolcreatedb,
      r.rolcreaterole,r.rolreplication,a.rolpassword,
      pg_has_role(r.oid,'novalure_tenant_app','MEMBER') tenant_member,
      pg_has_role(r.oid,'novalure_app','MEMBER') app_member
    from pg_roles r join pg_authid a on a.oid=r.oid
    where r.rolname='novalure_public_form_lookup'`)).rows[0];
  if (!legacy || legacy.rolcanlogin || legacy.rolpassword !== null || legacy.rolsuper
    || legacy.rolbypassrls || legacy.rolcreatedb || legacy.rolcreaterole
    || legacy.rolreplication || legacy.tenant_member || legacy.app_member) {
    throw new Error("QA_GATEWAY_BIND_LEGACY_ROLE_ACTIVE");
  }
  const binding = (await runtime.query(`select current_user role,
    current_setting('neon.project_id',true) project,
    current_setting('neon.branch_id',true) branch,
    has_function_privilege(current_user,
      'public.crm_external_integration_resolve(text,text,text,uuid)','EXECUTE') gateway_execute,
    has_function_privilege(current_user,
      'public.crm_public_form_lookup(uuid,text,text)','EXECUTE') compatibility_execute`)).rows[0];
  if (binding.role !== "novalure_app" || binding.project !== qa.expectedProjectId
    || binding.branch !== qa.expectedBranchId || !binding.gateway_execute || !binding.compatibility_execute) {
    throw new Error("QA_GATEWAY_BIND_RUNTIME_INVALID");
  }
  const physical = (await owner.query(`select
    (select count(*)::int from public.forms) forms,
    (select count(*)::int from public.external_integrations) integrations`)).rows[0];
  if (physical.forms < 1 || physical.integrations < 1) {
    throw new Error("QA_GATEWAY_BIND_PHYSICAL_FIXTURE_MISSING");
  }
  const noContext = (await runtime.query(`select
    (select count(*)::int from public.forms) forms,
    (select count(*)::int from public.form_submissions) submissions,
    (select count(*)::int from public.external_integrations) integrations`)).rows[0];
  if (noContext.forms !== 0 || noContext.submissions !== 0 || noContext.integrations !== 0) {
    throw new Error("QA_GATEWAY_BIND_NO_CONTEXT_DATA_VISIBLE");
  }
  console.log("QA_GATEWAY_BINDING_PASS lookupRole=NOLOGIN password=NULL runtime=novalure_app");
} catch (error) {
  const code = error instanceof Error && /^QA_[A-Z0-9_]+$/u.test(error.message)
    ? error.message : "QA_GATEWAY_BIND_UNEXPECTED_FAILURE";
  console.error(code);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([owner.end(), runtime.end()]);
}
