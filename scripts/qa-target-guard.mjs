#!/usr/bin/env node

import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; QA mutations are fail-closed.`);
  return value;
}

function normalizeDatabaseUrl(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

export async function assertQaTarget() {
  const databaseUrl = normalizeDatabaseUrl(required("NOVALURE_QA_DATABASE_URL"));
  const expectedHost = required("NOVALURE_QA_DATABASE_HOST").toLowerCase();
  const expectedProjectId = required("NOVALURE_QA_PROJECT_ID");
  const expectedBranchId = required("NOVALURE_QA_BRANCH_ID");
  const expectedDatabase = required("NOVALURE_QA_DATABASE_NAME");
  const expectedRole = required("NOVALURE_QA_DATABASE_ROLE");
  const runPrefix = required("NOVALURE_QA_RUN_PREFIX");
  const parsed = new URL(databaseUrl);

  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error("NOVALURE_QA_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (parsed.hostname.toLowerCase() !== expectedHost) {
    throw new Error("QA database host does not match NOVALURE_QA_DATABASE_HOST.");
  }
  if (!parsed.hostname.toLowerCase().includes("-pooler.")) {
    throw new Error("QA E2E must use the pooled Neon endpoint.");
  }
  if (parsed.pathname.replace(/^\//, "") !== expectedDatabase) {
    throw new Error("QA database name does not match NOVALURE_QA_DATABASE_NAME.");
  }
  if (decodeURIComponent(parsed.username) !== expectedRole) {
    throw new Error("QA database role does not match NOVALURE_QA_DATABASE_ROLE.");
  }
  if (!/^GOLIVETEST_[A-Za-z0-9_-]{6,80}$/.test(runPrefix)) {
    throw new Error("NOVALURE_QA_RUN_PREFIX must be a unique GOLIVETEST_ run identifier.");
  }

  const productionHost = process.env.NOVALURE_PRODUCTION_DATABASE_HOST?.trim().toLowerCase();
  if (productionHost && parsed.hostname.toLowerCase() === productionHost) {
    throw new Error("QA guard rejected the configured production database host.");
  }

  const genericDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (genericDatabaseUrl && normalizeDatabaseUrl(genericDatabaseUrl) !== databaseUrl) {
    throw new Error("DATABASE_URL differs from NOVALURE_QA_DATABASE_URL.");
  }

  const sql = neon(databaseUrl);
  const rows = await sql`
    select
      current_setting('neon.project_id', true) as project_id,
      current_setting('neon.branch_id', true) as branch_id,
      current_database() as database_name,
      current_user as role_name
  `;
  const target = rows[0];

  if (
    target?.project_id !== expectedProjectId ||
    target?.branch_id !== expectedBranchId ||
    target?.database_name !== expectedDatabase ||
    target?.role_name !== expectedRole
  ) {
    throw new Error("Connected database fingerprint does not match the declared QA target.");
  }

  const targetFingerprint = createHash("sha256")
    .update([expectedProjectId, expectedBranchId, expectedDatabase, expectedRole].join("\0"))
    .digest("hex")
    .slice(0, 16);
  const runFingerprint = createHash("sha256").update(runPrefix).digest("hex").slice(0, 16);
  console.log(
    `QA target verified: fingerprint=sha256:${targetFingerprint}; run=sha256:${runFingerprint}.`,
  );
  return { databaseUrl, expectedBranchId, expectedDatabase, expectedHost, expectedProjectId, expectedRole, runPrefix };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await assertQaTarget();
}
