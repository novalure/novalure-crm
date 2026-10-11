#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { assertQaTarget } from "./qa-target-guard.mjs";

const qa = await assertQaTarget();
const ownerUrl = process.env.MIGRATION_DATABASE_URL?.trim();
const envFile = process.env.GITHUB_ENV?.trim();
if (!ownerUrl || !envFile) throw new Error("QA_LOOKUP_BIND_INPUT_MISSING");

const ownerTarget = new URL(ownerUrl);
const appTarget = new URL(qa.databaseUrl);
const productionHost = process.env.NOVALURE_PRODUCTION_DATABASE_HOST?.trim().toLowerCase();
if (ownerTarget.protocol !== "postgresql:" || decodeURIComponent(ownerTarget.username) !== "neondb_owner"
  || ownerTarget.pathname !== `/${qa.expectedDatabase}` || ownerTarget.hostname.includes("-pooler.")
  || ownerTarget.hostname === productionHost || !ownerTarget.hostname.endsWith(".neon.tech")
  || appTarget.hostname === productionHost || appTarget.hostname !== qa.expectedHost) {
  throw new Error("QA_LOOKUP_BIND_SCOPE_INVALID");
}

const owner = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: true } });
let lookup;
try {
  await owner.connect();
  const identity = (await owner.query(`select current_setting('neon.project_id',true) project,
    current_setting('neon.branch_id',true) branch,current_database() database,current_user role`)).rows[0];
  if (identity.project !== qa.expectedProjectId || identity.branch !== qa.expectedBranchId
    || identity.database !== qa.expectedDatabase || identity.role !== "neondb_owner") {
    throw new Error("QA_LOOKUP_BIND_FINGERPRINT_INVALID");
  }
  const role = (await owner.query(`select rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,
    pg_has_role(oid,'novalure_tenant_app','MEMBER') tenant_member,
    pg_has_role(oid,'novalure_app','MEMBER') app_member
    from pg_roles where rolname='novalure_public_form_lookup'`)).rows[0];
  if (!role?.rolcanlogin || role.rolsuper || role.rolbypassrls || role.rolcreatedb
    || role.rolcreaterole || role.rolreplication || role.tenant_member || role.app_member) {
    throw new Error("QA_LOOKUP_BIND_ROLE_UNSAFE");
  }
  const password = randomBytes(36).toString("hex");
  await owner.query(`alter role novalure_public_form_lookup password '${password}'`);
  const target = new URL(qa.databaseUrl);
  target.username = "novalure_public_form_lookup";
  target.password = password;
  target.searchParams.set("sslmode", "verify-full");
  lookup = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true } });
  await lookup.connect();
  const verified = (await lookup.query(`select current_setting('neon.project_id',true) project,
    current_setting('neon.branch_id',true) branch,current_user role,
    has_table_privilege(current_user,'public.forms','SELECT') forms_read,
    has_table_privilege(current_user,'public.form_submissions','SELECT') submissions_read`)).rows[0];
  if (verified.project !== qa.expectedProjectId || verified.branch !== qa.expectedBranchId
    || verified.role !== "novalure_public_form_lookup" || verified.forms_read || verified.submissions_read) {
    throw new Error("QA_LOOKUP_BIND_PROOF_INVALID");
  }
  appendFileSync(envFile, `CRM_PUBLIC_FORM_LOOKUP_DATABASE_URL=${target.toString()}\n`, { encoding: "utf8" });
  console.log("QA_LOOKUP_BINDING_PASS");
} catch (error) {
  const code = error instanceof Error && /^QA_[A-Z0-9_]+$/u.test(error.message)
    ? error.message : "QA_LOOKUP_BIND_UNEXPECTED_FAILURE";
  console.error(code);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([owner.end(), lookup?.end()]);
}
