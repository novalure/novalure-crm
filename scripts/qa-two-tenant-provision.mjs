#!/usr/bin/env node

import { createCipheriv, createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const confirmation = "PROVISION_ISOLATED_TWO_TENANT_QA";
const defaultBundlePath = ".env.qa-two-tenant.local";
const defaultPlanPath = ".env.qa-two-tenant-plan.local.json";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage() {
  console.log([
    "Two-tenant Preview QA fixture provisioning",
    "",
    "  generate   Create a gitignored 0600 credential bundle and SQL plan",
    "  print-plan Emit the generated SQL plan as JSON for an approved orchestrator",
    "  summary    Print only non-secret fixture identifiers",
    "",
    `generate requires NOVALURE_QA_PROVISION_CONFIRM=${confirmation}.`,
    "The script never prints passwords, TOTP secrets, encryption keys, or database URLs.",
  ].join("\n"));
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertSafeLocalPath(value, fallback) {
  const resolved = path.resolve(value || fallback);
  const root = path.resolve(process.cwd());
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("QA fixture output must stay inside the current repository");
  }
  if (!path.basename(resolved).startsWith(".env.qa-two-tenant")) {
    throw new Error("QA fixture output must use the ignored .env.qa-two-tenant* prefix");
  }
  return resolved;
}

function stableUuid(namespace, key) {
  const chars = createHash("sha256").update(`${namespace}\0${key}`).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function envLine(name, value) {
  const normalized = String(value);
  if (/^[A-Za-z0-9_.,:/?=@+-]+$/.test(normalized)) return `${name}=${normalized}`;
  return `${name}=${JSON.stringify(normalized)}`;
}

function secret(bytes = 36) {
  return randomBytes(bytes).toString("base64url");
}

function base32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function createTotpSecret() {
  return base32(randomBytes(20));
}

async function hashPassword(value) {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = await scrypt(value, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derivedKey).toString("base64url")}`;
}

function encryptMfaSecret(encryptionSecret, totpSecret) {
  const key = createHash("sha256")
    .update("novalure-auth-encryption-v1\0")
    .update(encryptionSecret)
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify({ secret: totpSecret }), "utf8")),
    cipher.final(),
  ]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function timestampMarker() {
  const now = new Date();
  const compact = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("");
  const time = `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
  return { compact, time };
}

async function buildFixture() {
  if (required("NOVALURE_QA_PROVISION_CONFIRM") !== confirmation) {
    throw new Error(`NOVALURE_QA_PROVISION_CONFIRM must equal ${confirmation}`);
  }
  const projectId = required("NOVALURE_QA_PROJECT_ID");
  const branchId = required("NOVALURE_QA_BRANCH_ID");
  if (!/^[-A-Za-z0-9]{8,80}$/.test(projectId) || !/^[-A-Za-z0-9]{8,80}$/.test(branchId)) {
    throw new Error("Invalid isolated Preview target identifiers");
  }
  const namespace = `${projectId}:${branchId}:go-live-two-tenant-v1`;
  const authEncryptionKey = secret(48);
  const authRateLimitSecret = secret(48);
  const abuseSecret = secret(48);
  const runId = secret(8).replaceAll("-", "").replaceAll("_", "").slice(0, 10);
  const markerTime = timestampMarker();
  const sqlStatements = [];
  const env = {
    NOVALURE_ABUSE_SECRET: abuseSecret,
    NOVALURE_AUTH_ENCRYPTION_KEY: authEncryptionKey,
    NOVALURE_AUTH_RATE_LIMIT_SECRET: authRateLimitSecret,
    NOVALURE_PRODUCTION_ORIGIN: "https://www.novalure-crm.app",
    NOVALURE_PRODUCTION_WORKSPACE_IDS: "11111111-1111-4111-8111-111111111111,8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101",
    NOVALURE_QA_BATCH_REGISTRATION_ENABLED: "true",
    NOVALURE_QA_E2E_CLEANUP_CONFIRM: "RESET_TWO_TENANT_QA",
    NOVALURE_QA_E2E_WRITE_CONFIRM: "RUN_TWO_TENANT_QA",
    NOVALURE_QA_PROJECT_ID: projectId,
    NOVALURE_QA_BRANCH_ID: branchId,
    NOVALURE_QA_RESET_EXECUTION_ENABLED: "true",
    NOVALURE_QA_RUN_PREFIX: `GOLIVETEST_20260822_${runId}`,
  };
  const actors = [
    ["OWNER", "owner", "customer_owner"],
    ["ADMIN", "admin", "workspace_admin"],
    ["MEMBER", "agent", "team_member"],
    ["CUSTOMER", "assistant", "viewer"],
  ];
  const resetPassword = secret(30);
  const resetPasswordHash = await hashPassword(resetPassword);
  const resetTotpSecret = createTotpSecret();
  const resetEmail = `codextest_go_live_reset_${createHash("sha256").update(namespace).digest("hex").slice(0, 10)}@example.test`;
  env.NOVALURE_QA_RESET_ADMIN_EMAIL = resetEmail;
  env.NOVALURE_QA_RESET_ADMIN_PASSWORD = resetPassword;
  env.NOVALURE_QA_RESET_ADMIN_TOTP_SECRET = resetTotpSecret;

  const tenants = [];
  for (const key of ["A", "B"]) {
    const prefix = `NOVALURE_QA_TENANT_${key}`;
    const lower = key.toLowerCase();
    const workspaceId = stableUuid(namespace, `workspace:${lower}`);
    const projectFixtureId = stableUuid(namespace, `project:${lower}`);
    const pipelineId = stableUuid(namespace, `pipeline:${lower}`);
    const batchId = stableUuid(`${namespace}:${runId}`, `batch:${lower}`);
    const resetActorUserId = stableUuid(namespace, `user:${lower}:reset`);
    const batchMarker = `QA-TEST-${markerTime.compact}-${markerTime.time}-${lower}${runId}`;
    const publicKey = createHash("sha256").update(`${namespace}:public:${lower}`).digest("hex").slice(0, 32);
    const workspaceName = `CODEXTEST_GO_LIVE_${key}_Workspace`;
    const projectName = `CODEXTEST_GO_LIVE_${key}_Project`;
    env[`${prefix}_WORKSPACE_ID`] = workspaceId;
    env[`${prefix}_PROJECT_ID`] = projectFixtureId;
    env[`${prefix}_PUBLIC_PATH`] = `/meta?lang=en&qaTenant=${key}`;
    env[`${prefix}_BATCH_ID`] = batchId;
    env[`${prefix}_BATCH_MARKER`] = batchMarker;
    env[`${prefix}_RESET_ACTOR_USER_ID`] = resetActorUserId;

    sqlStatements.push(`
      insert into public.workspaces (
        id, name, plan, slug, public_key, operating_model, customer_type,
        team_structure, active_calendar_provider, setup_state, is_qa
      ) values (
        ${sqlLiteral(workspaceId)}::uuid, ${sqlLiteral(workspaceName)}, 'Preview QA',
        ${sqlLiteral(`codextest-go-live-${lower}`)}, ${sqlLiteral(publicKey)},
        'self_service_customer', 'real_estate_broker', 'small_team', 'none',
        ${sqlJson({ qaFixture: "go-live-two-tenant-v1", tenant: key })}, true
      )
      on conflict (id) do update set
        name = excluded.name,
        plan = excluded.plan,
        slug = excluded.slug,
        public_key = excluded.public_key,
        operating_model = excluded.operating_model,
        customer_type = excluded.customer_type,
        team_structure = excluded.team_structure,
        active_calendar_provider = excluded.active_calendar_provider,
        setup_state = public.workspaces.setup_state || excluded.setup_state,
        is_qa = true,
        updated_at = now()
    `.trim());

    const tenantActors = [];
    for (const [actorName, appRole, productRole] of actors) {
      const userId = stableUuid(namespace, `user:${lower}:${actorName.toLowerCase()}`);
      const email = `codextest_go_live_${lower}_${actorName.toLowerCase()}_${createHash("sha256").update(namespace).digest("hex").slice(0, 8)}@example.test`;
      const password = secret(30);
      const passwordHash = await hashPassword(password);
      const totpSecret = createTotpSecret();
      const ciphertext = encryptMfaSecret(authEncryptionKey, totpSecret);
      env[`${prefix}_${actorName}_EMAIL`] = email;
      env[`${prefix}_${actorName}_PASSWORD`] = password;
      env[`${prefix}_${actorName}_TOTP_SECRET`] = totpSecret;
      env[`${prefix}_${actorName}_USER_ID`] = userId;
      env[`${prefix}_${actorName}_PRODUCT_ROLE`] = productRole;
      tenantActors.push({ actorName, appRole, ciphertext, email, passwordHash, productRole, userId });
    }
    tenantActors.push({
      actorName: "RESET",
      appRole: "owner",
      ciphertext: encryptMfaSecret(authEncryptionKey, resetTotpSecret),
      email: resetEmail,
      passwordHash: resetPasswordHash,
      productRole: "platform_admin",
      userId: resetActorUserId,
    });

    for (const actor of tenantActors) {
      sqlStatements.push(`
        insert into public.workspace_users (
          id, workspace_id, name, email, role, status, product_role, password_hash
        ) values (
          ${sqlLiteral(actor.userId)}::uuid, ${sqlLiteral(workspaceId)}::uuid,
          ${sqlLiteral(`CODEXTEST_${key}_${actor.actorName}`)}, ${sqlLiteral(actor.email)},
          ${sqlLiteral(actor.appRole)}, 'active', ${sqlLiteral(actor.productRole)}, ${sqlLiteral(actor.passwordHash)}
        )
        on conflict (id) do update set
          name = excluded.name,
          email = excluded.email,
          role = excluded.role,
          status = 'active',
          product_role = excluded.product_role,
          password_hash = excluded.password_hash,
          updated_at = now()
      `.trim());
      sqlStatements.push(`
        update public.auth_identities
        set password_hash = ${sqlLiteral(actor.passwordHash)},
            credential_state = 'active',
            mfa_secret_ciphertext = ${sqlLiteral(actor.ciphertext)},
            mfa_enabled_at = now(),
            disabled_at = null,
            password_changed_at = now(),
            updated_at = now()
        where normalized_email = ${sqlLiteral(actor.email.toLowerCase())}
      `.trim());
    }

    sqlStatements.push(`
      insert into public.projects (
        id, workspace_id, name, type, status, customer_type,
        default_operating_model, setup_defaults
      ) values (
        ${sqlLiteral(projectFixtureId)}::uuid, ${sqlLiteral(workspaceId)}::uuid,
        ${sqlLiteral(projectName)}, 'property_development', 'Aktiv',
        'real_estate_broker', 'self_service_customer',
        ${sqlJson({ qaFixture: "go-live-two-tenant-v1", tenant: key })}
      )
      on conflict (id) do update set
        name = excluded.name,
        status = excluded.status,
        setup_defaults = public.projects.setup_defaults || excluded.setup_defaults,
        updated_at = now()
    `.trim());
    sqlStatements.push(`
      insert into public.crm_pipelines (
        id, workspace_id, project_id, customer_type, operating_model,
        key, name, purpose, is_default, metadata
      ) values (
        ${sqlLiteral(pipelineId)}::uuid, ${sqlLiteral(workspaceId)}::uuid,
        ${sqlLiteral(projectFixtureId)}::uuid, 'real_estate_broker', 'self_service_customer',
        ${sqlLiteral(`go_live_qa_${lower}`)}, ${sqlLiteral(`CODEXTEST ${key} Pipeline`)},
        'sales', true, ${sqlJson({ qaFixture: "go-live-two-tenant-v1", tenant: key })}
      )
      on conflict (id) do update set
        name = excluded.name,
        is_default = true,
        metadata = public.crm_pipelines.metadata || excluded.metadata,
        updated_at = now()
    `.trim());
    const stageDefinitions = [
      ["neu", "Neu", 0, 10, "work"],
      ["qualifizieren", "Qualifizieren", 1, 35, "work"],
      ["angebot", "Angebot", 2, 70, "work"],
      ["gewonnen", "Gewonnen", 3, 100, "won"],
      ["verloren", "Verloren", 4, 0, "lost"],
    ];
    for (const [stageKey, stageName, position, probability, category] of stageDefinitions) {
      const stageId = stableUuid(namespace, `stage:${lower}:${stageKey}`);
      sqlStatements.push(`
        insert into public.crm_pipeline_stages (
          id, pipeline_id, workspace_id, project_id, key, name,
          position, probability, category, metadata
        ) values (
          ${sqlLiteral(stageId)}::uuid, ${sqlLiteral(pipelineId)}::uuid,
          ${sqlLiteral(workspaceId)}::uuid, ${sqlLiteral(projectFixtureId)}::uuid,
          ${sqlLiteral(stageKey)}, ${sqlLiteral(stageName)}, ${position}, ${probability},
          ${sqlLiteral(category)}, ${sqlJson({ qaFixture: "go-live-two-tenant-v1", tenant: key })}
        )
        on conflict (pipeline_id, key) do update set
          name = excluded.name,
          position = excluded.position,
          probability = excluded.probability,
          category = excluded.category,
          metadata = public.crm_pipeline_stages.metadata || excluded.metadata,
          updated_at = now()
      `.trim());
    }
    sqlStatements.push(`
      update public.projects
      set default_pipeline_id = ${sqlLiteral(pipelineId)}::uuid, updated_at = now()
      where id = ${sqlLiteral(projectFixtureId)}::uuid
        and workspace_id = ${sqlLiteral(workspaceId)}::uuid
    `.trim());
    sqlStatements.push(`
      insert into public.qa_batches (
        id, workspace_id, batch_marker, created_by_user_id, metadata
      ) values (
        ${sqlLiteral(batchId)}::uuid, ${sqlLiteral(workspaceId)}::uuid,
        ${sqlLiteral(batchMarker)}, ${sqlLiteral(resetActorUserId)}::uuid,
        ${sqlJson({ candidate: "pending-sha", qaFixture: "go-live-two-tenant-v1", tenant: key })}
      )
      on conflict (id) do nothing
    `.trim());
    tenants.push({ batchId, batchMarker, projectId: projectFixtureId, resetActorUserId, workspaceId });
  }
  env.NOVALURE_QA_RESET_WORKSPACE_IDS = tenants.map((tenant) => tenant.workspaceId).join(",");
  env.NOVALURE_QA_WORKSPACE_IDS = env.NOVALURE_QA_RESET_WORKSPACE_IDS;

  const verifyStatements = tenants.flatMap((tenant) => [
    `select id, is_qa from public.workspaces where id = ${sqlLiteral(tenant.workspaceId)}::uuid`,
    `select id, workspace_id, batch_marker from public.qa_batches where id = ${sqlLiteral(tenant.batchId)}::uuid`,
  ]);
  return {
    env,
    plan: {
      branchId,
      projectId,
      schemaVersion: 1,
      sqlStatements,
      tenants,
      verifyStatements,
    },
  };
}

async function writeSecretFile(filePath, contents) {
  await writeFile(filePath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function generate() {
  const bundlePath = assertSafeLocalPath(process.env.NOVALURE_QA_FIXTURE_ENV_FILE, defaultBundlePath);
  const planPath = assertSafeLocalPath(process.env.NOVALURE_QA_FIXTURE_PLAN_FILE, defaultPlanPath);
  const fixture = await buildFixture();
  const envContents = [
    "# Generated Preview-only QA fixture. Gitignored. Never commit or print this file.",
    ...Object.entries(fixture.env).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => envLine(name, value)),
    "",
  ].join("\n");
  await writeSecretFile(bundlePath, envContents);
  try {
    await writeSecretFile(planPath, `${JSON.stringify(fixture.plan)}\n`);
  } catch (error) {
    throw new Error(`Fixture plan could not be written after secret bundle creation: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  console.log(JSON.stringify({
    bundle: path.basename(bundlePath),
    plan: path.basename(planPath),
    statementCount: fixture.plan.sqlStatements.length,
    tenants: fixture.plan.tenants.map((tenant) => ({
      batchId: tenant.batchId,
      projectId: tenant.projectId,
      workspaceId: tenant.workspaceId,
    })),
  }));
}

async function readPlan() {
  const planPath = assertSafeLocalPath(process.env.NOVALURE_QA_FIXTURE_PLAN_FILE, defaultPlanPath);
  const parsed = JSON.parse(await readFile(planPath, "utf8"));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.sqlStatements) || !Array.isArray(parsed.tenants)) {
    throw new Error("Invalid QA fixture plan");
  }
  if (parsed.tenants.some((tenant) => !uuidPattern.test(tenant.workspaceId) || !uuidPattern.test(tenant.batchId))) {
    throw new Error("QA fixture plan contains invalid identifiers");
  }
  return parsed;
}

async function main() {
  const mode = process.argv[2] ?? "help";
  if (mode === "generate") return generate();
  if (mode === "print-plan") {
    const plan = await readPlan();
    process.stdout.write(JSON.stringify(plan));
    return;
  }
  if (mode === "summary") {
    const plan = await readPlan();
    console.log(JSON.stringify({
      branchId: plan.branchId,
      projectId: plan.projectId,
      statementCount: plan.sqlStatements.length,
      tenants: plan.tenants,
    }, null, 2));
    return;
  }
  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "QA fixture provisioning failed");
  process.exitCode = 1;
});
