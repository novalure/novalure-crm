#!/usr/bin/env node
import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";

const scrypt = promisify(scryptCallback);
const productionEnvPath = fs.existsSync(".env.vercel-production.local")
  ? ".env.vercel-production.local"
  : ".env.production.local";
const liveOnboardingEnvPath = ".env.codex.live-onboarding.local";
const appUrl = "https://www.novalure-crm.app";
const workspaceSeed = "CODEXTEST_ONBOARDING_LIVE";
const blockedTargetIndicators = ["tenant-isolation-test", "preview", "test"];
const databaseKeys = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_DATABASE_URL", "POSTGRES_PRISMA_URL"];

function parseEnvFile(filePath, required = false) {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Env file not found: ${filePath}`);
    return new Map();
  }

  const values = new Map();
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    values.set(key, value);
  }
  return values;
}

function cleanDatabaseUrl(value) {
  if (!value) return "";
  const trimmed = String(value).trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);
  return prefixedUrl?.[1] ?? trimmed;
}

function getDatabaseUrl(values) {
  for (const key of databaseKeys) {
    const value = cleanDatabaseUrl(values.get(key));
    if (value) return { key, value };
  }
  throw new Error("No production database URL found.");
}

function fingerprint(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return {
    database: parsed.pathname.slice(1),
    host: parsed.hostname,
    user: parsed.username,
  };
}

function mask(value) {
  if (!value) return "";
  if (value.length <= 10) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function maskedFingerprint(databaseUrl) {
  const parsed = fingerprint(databaseUrl);
  return {
    database: mask(parsed.database),
    host: mask(parsed.host),
    user: mask(parsed.user),
  };
}

function getKnownNonProductionFingerprints() {
  const fingerprints = [];
  for (const filePath of [".env.local", ".env.preview.local", ".env.codex.vercel-development.local"]) {
    const values = parseEnvFile(filePath);
    for (const key of [...databaseKeys, "QA_TENANT_DATABASE_URL", "QA_TENANT_POSTGRES_URL"]) {
      const value = cleanDatabaseUrl(values.get(key));
      if (!value) continue;
      fingerprints.push({ filePath, key, ...fingerprint(value) });
    }
  }
  return fingerprints;
}

function assertLiveTarget(env, databaseUrl) {
  const target = fingerprint(databaseUrl);
  const vercelEnv = env.get("VERCEL_ENV") ?? "";
  if (vercelEnv !== "production") {
    throw new Error(`Blocked: expected VERCEL_ENV=production, got ${vercelEnv || "empty"}.`);
  }

  const targetText = `${target.host} ${target.database}`.toLowerCase();
  for (const indicator of blockedTargetIndicators) {
    if (targetText.includes(indicator)) {
      throw new Error(`Blocked: production DB target contains non-live indicator "${indicator}".`);
    }
  }

  const knownNonProduction = getKnownNonProductionFingerprints();
  const matchingNonProduction = knownNonProduction.find(
    (item) => item.host === target.host && item.database === target.database && item.user === target.user,
  );
  if (matchingNonProduction) {
    throw new Error(
      `Blocked: production DB matches ${matchingNonProduction.filePath}:${matchingNonProduction.key}.`,
    );
  }
}

function stableUuid(input) {
  const chars = createHash("sha1").update(`novalure-live-onboarding:${input}`).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomPassword() {
  return `CODEXTEST-${randomBytes(18).toString("base64url")}-2026!`;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = await scrypt(password, salt, 64);
  return ["scrypt", salt, Buffer.from(derivedKey).toString("base64url")].join(":");
}

function splitSql(sql) {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyOnboardingMigration(sql) {
  const statements = splitSql(fs.readFileSync("migrations/031_user_onboarding.sql", "utf8"));
  for (const statement of statements) {
    await sql.query(statement);
  }
}

async function tableColumns(sql, tableName) {
  const rows = await sql.query(
    `
      select column_name as "name", data_type as "dataType", udt_name as "udtName"
      from information_schema.columns
      where table_schema = 'public' and table_name = $1
    `,
    [tableName],
  );
  return new Map(rows.map((row) => [row.name, row]));
}

function valuePlaceholder(index, column) {
  if (column.udtName === "uuid") return `$${index}::uuid`;
  if (column.udtName === "jsonb" || column.dataType === "jsonb") return `$${index}::jsonb`;
  if (column.udtName === "_text") return `$${index}::text[]`;
  return `$${index}`;
}

async function upsertById(sql, tableName, row) {
  const columns = await tableColumns(sql, tableName);
  const entries = Object.entries(row).filter(([key]) => columns.has(key));
  if (!entries.some(([key]) => key === "id")) throw new Error(`${tableName} row needs an id`);

  const columnNames = entries.map(([key]) => key);
  const values = entries.map(([, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
    return value;
  });
  const placeholders = entries.map(([key], index) => valuePlaceholder(index + 1, columns.get(key)));
  const updateColumns = columnNames.filter((key) => key !== "id" && key !== "created_at");
  const updateSet = updateColumns.map((key) => `${key} = excluded.${key}`).join(", ");

  await sql.query(
    `
      insert into ${tableName} (${columnNames.join(", ")})
      values (${placeholders.join(", ")})
      on conflict (id) do update set
        ${updateSet},
        updated_at = now()
    `,
    values,
  );
}

function readOrCreatePassword() {
  const values = parseEnvFile(liveOnboardingEnvPath);
  return values.get("NOVALURE_ONBOARDING_PASSWORD") || randomPassword();
}

function writeLiveOnboardingEnv(password) {
  fs.writeFileSync(
    liveOnboardingEnvPath,
    [
      "# Local Codex-only live onboarding QA credentials. Do not commit.",
      `NOVALURE_QA_BASE_URL=${appUrl}`,
      "NOVALURE_ONBOARDING_OWNER_EMAIL=codextest-onboarding-owner@novalure.local",
      "NOVALURE_ONBOARDING_AGENT_EMAIL=codextest-onboarding-agent@novalure.local",
      "NOVALURE_ONBOARDING_VIEWER_EMAIL=codextest-onboarding-viewer@novalure.local",
      `NOVALURE_ONBOARDING_PASSWORD=${password}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
}

async function main() {
  const env = parseEnvFile(productionEnvPath, true);
  const databaseUrl = getDatabaseUrl(env);
  assertLiveTarget(env, databaseUrl.value);

  const sql = neon(databaseUrl.value);
  await applyOnboardingMigration(sql);

  const password = readOrCreatePassword();
  const passwordHash = await hashPassword(password);
  const workspaceId = stableUuid("workspace");
  const projectId = stableUuid("project");
  const contactId = stableUuid("contact");
  const leadId = stableUuid("lead");
  const now = new Date().toISOString();

  await upsertById(sql, "workspaces", {
    id: workspaceId,
    name: workspaceSeed,
    plan: "Live onboarding QA",
    operating_model: "self_service_customer",
    customer_type: "real_estate_broker",
    team_structure: "small_team",
    active_calendar_provider: "none",
    setup_state: {
      qaSeed: workspaceSeed,
      externalCommunication: false,
      createdFor: "live-onboarding-implementation",
      updatedAt: now,
    },
  });

  const users = [
    {
      email: "codextest-onboarding-owner@novalure.local",
      id: stableUuid("owner"),
      name: "CODEXTEST Onboarding Owner",
      productRole: "customer_owner",
      role: "owner",
    },
    {
      email: "codextest-onboarding-agent@novalure.local",
      id: stableUuid("agent"),
      name: "CODEXTEST Onboarding Agent",
      productRole: "broker_agent",
      role: "agent",
    },
    {
      email: "codextest-onboarding-viewer@novalure.local",
      id: stableUuid("viewer"),
      name: "CODEXTEST Onboarding Viewer",
      productRole: "viewer",
      role: "assistant",
    },
  ];

  for (const user of users) {
    await upsertById(sql, "workspace_users", {
      id: user.id,
      workspace_id: workspaceId,
      name: user.name,
      email: user.email,
      role: user.role,
      status: "active",
      product_role: user.productRole,
      password_hash: passwordHash,
      onboarding_completed_at: null,
      onboarding_current_step: null,
      onboarding_completed_steps: [],
      onboarding_skipped_steps: [],
      onboarding_dismissed_at: null,
      onboarding_role_context: null,
    });
  }

  await upsertById(sql, "projects", {
    id: projectId,
    workspace_id: workspaceId,
    name: `${workspaceSeed}_PROJECT`,
    type: "brokerage",
    status: "Aktiv",
    customer_type: "real_estate_broker",
    default_operating_model: "self_service_customer",
    setup_defaults: { qaSeed: workspaceSeed, externalCommunication: false },
  });

  await upsertById(sql, "contacts", {
    id: contactId,
    workspace_id: workspaceId,
    project_id: projectId,
    name: `${workspaceSeed}_Kontakt`,
    role: "Käufer",
    source: "Manual",
    intent: "Live onboarding QA baseline contact",
    consent_label: "Nur CRM",
    email: "codextest-onboarding-contact@example.test",
    metadata: { qaSeed: workspaceSeed, externalCommunication: false },
  });

  await upsertById(sql, "leads", {
    id: leadId,
    workspace_id: workspaceId,
    project_id: projectId,
    contact_id: contactId,
    assigned_to_user_id: users[1].id,
    source: "Manual",
    type: "Käufer",
    status: "Neu",
    score: 55,
    intent: "Live onboarding QA lead",
    next_action: "CODEXTEST_ONBOARDING_LIVE Onboarding prüfen",
    received_at: now,
    sla_due_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    buyer_profile: { desiredLocation: "Wien", propertyType: "Wohnung" },
    metadata: { qaSeed: workspaceSeed, externalCommunication: false },
  });

  writeLiveOnboardingEnv(password);

  console.log(JSON.stringify({
    ok: true,
    appUrl,
    database: maskedFingerprint(databaseUrl.value),
    databaseUrlSource: databaseUrl.key,
    environment: env.get("VERCEL_ENV"),
    auth: {
      demoAuth: false,
      strictAuth: env.get("NOVALURE_AUTH_STRICT") === "1" || env.get("VERCEL_ENV") === "production",
    },
    createdOrUpdated: {
      workspace: workspaceSeed,
      users: users.map((user) => ({ email: user.email, productRole: user.productRole, role: user.role })),
      project: `${workspaceSeed}_PROJECT`,
      contact: `${workspaceSeed}_Kontakt`,
      lead: "Live onboarding QA lead",
    },
    localCredentialsFile: liveOnboardingEnvPath,
    passwordPrinted: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
