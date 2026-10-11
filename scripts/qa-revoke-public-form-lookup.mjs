#!/usr/bin/env node

import pg from "pg";
import { assertQaTarget } from "./qa-target-guard.mjs";

const qa = await assertQaTarget();
const ownerUrl = process.env.MIGRATION_DATABASE_URL?.trim();
if (!ownerUrl) throw new Error("QA_LOOKUP_REVOKE_INPUT_MISSING");

const target = new URL(ownerUrl);
const productionHost = process.env.NOVALURE_PRODUCTION_DATABASE_HOST?.trim().toLowerCase();
if (target.protocol !== "postgresql:" || decodeURIComponent(target.username) !== "neondb_owner"
  || target.pathname !== `/${qa.expectedDatabase}` || target.hostname.includes("-pooler.")
  || target.hostname === productionHost || !target.hostname.endsWith(".neon.tech")
  || !["require", "verify-full"].includes(target.searchParams.get("sslmode"))) {
  throw new Error("QA_LOOKUP_REVOKE_SCOPE_INVALID");
}

target.searchParams.set("sslmode", "verify-full");
const owner = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true } });
try {
  await owner.connect();
  const identity = (await owner.query(`select current_setting('neon.project_id',true) project,
    current_setting('neon.branch_id',true) branch,current_database() database,current_user role`)).rows[0];
  if (identity.project !== qa.expectedProjectId || identity.branch !== qa.expectedBranchId
    || identity.database !== qa.expectedDatabase || identity.role !== "neondb_owner") {
    throw new Error("QA_LOOKUP_REVOKE_FINGERPRINT_INVALID");
  }
  const role = (await owner.query("select rolcanlogin from pg_roles where rolname='novalure_public_form_lookup'")).rows[0];
  if (!role) {
    console.log("QA_LOOKUP_REVOKE_NOT_REQUIRED");
  } else {
    if (!role.rolcanlogin) throw new Error("QA_LOOKUP_REVOKE_ROLE_INVALID");
    await owner.query("alter role novalure_public_form_lookup password null");
    const verified = (await owner.query("select rolpassword is null as revoked from pg_roles where rolname='novalure_public_form_lookup'")).rows[0];
    if (verified?.revoked !== true) throw new Error("QA_LOOKUP_REVOKE_UNVERIFIED");
    console.log("QA_LOOKUP_REVOKE_PASS");
  }
} catch (error) {
  const code = error instanceof Error && /^QA_[A-Z0-9_]+$/u.test(error.message)
    ? error.message : "QA_LOOKUP_REVOKE_UNEXPECTED_FAILURE";
  console.error(code);
  process.exitCode = 1;
} finally {
  await owner.end();
}
