#!/usr/bin/env node

import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const environment = process.argv[2] ?? "unknown";

function clean(value) {
  return typeof value === "string" ? value.trim().replace(/^['"]|['"]$/g, "") : "";
}

function fingerprint(label, values) {
  const normalized = values.map(clean).filter(Boolean);
  if (!normalized.length) return null;

  return `sha256:${createHash("sha256")
    .update(`${label}\0${normalized.join("\0")}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function databaseUrl() {
  return clean(
    process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_DATABASE_URL ||
      process.env.POSTGRES_PRISMA_URL,
  );
}

async function databaseFingerprint() {
  const url = databaseUrl();
  if (!url) return { configured: false, connected: false, fingerprint: null };

  try {
    const sql = neon(url);
    const rows = await sql`
      select
        current_setting('neon.project_id', true) as project_id,
        current_setting('neon.branch_id', true) as branch_id,
        current_database() as database_name,
        current_user as role_name
    `;
    const target = rows[0] ?? {};
    return {
      configured: true,
      connected: true,
      fingerprint: fingerprint("database-target", [
        target.project_id,
        target.branch_id,
        target.database_name,
        target.role_name,
      ]),
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      errorClass: error instanceof Error ? error.name : "UnknownError",
      fingerprint: null,
    };
  }
}

const result = {
  environment,
  database: await databaseFingerprint(),
  privateBlob: {
    configured: Boolean(
      clean(process.env.NOVALURE_PRIVATE_BLOB_STORE_ID) ||
        clean(process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN) ||
        clean(process.env.BLOB_READ_WRITE_TOKEN),
    ),
    fingerprint: fingerprint("private-blob-target", [
      process.env.NOVALURE_PRIVATE_BLOB_STORE_ID,
      process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN,
      process.env.BLOB_READ_WRITE_TOKEN,
    ]),
  },
  queue: {
    configured: Boolean(
      clean(process.env.QUEUE_URL) ||
        clean(process.env.KV_REST_API_URL) ||
        clean(process.env.UPSTASH_REDIS_REST_URL),
    ),
    fingerprint: fingerprint("queue-target", [
      process.env.QUEUE_URL,
      process.env.KV_REST_API_URL,
      process.env.UPSTASH_REDIS_REST_URL,
    ]),
  },
  emailProvider: {
    configured: Boolean(clean(process.env.RESEND_API_KEY)),
    explicitFromConfigured: Boolean(clean(process.env.RESEND_FROM)),
    legacyOrMisspelledFromConfigured: Boolean(
      clean(process.env.RESEND_FORM) || clean(process.env.NOVALURE_EMAIL_FROM),
    ),
    fingerprint: fingerprint("email-provider-target", [
      process.env.RESEND_API_KEY,
      process.env.RESEND_FROM,
      process.env.RESEND_FORM,
      process.env.NOVALURE_EMAIL_FROM,
    ]),
  },
  calendarProvider: {
    configured: Boolean(
      clean(process.env.MICROSOFT_CLIENT_ID) || clean(process.env.GOOGLE_CLIENT_ID),
    ),
    fingerprint: fingerprint("calendar-provider-target", [
      process.env.MICROSOFT_TENANT_ID,
      process.env.MICROSOFT_CLIENT_ID,
      process.env.MICROSOFT_CLIENT_SECRET,
      process.env.MICROSOFT_CALENDAR_USER_ID,
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    ]),
  },
};

console.log(JSON.stringify(result, null, 2));
