#!/usr/bin/env node

import { createCipheriv, createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const confirmation = "PROVISION_ISOLATED_TWO_TENANT_QA";
const runtimeBindConfirmation = "BIND_EXACT_PREVIEW_RUNTIME";
const defaultBundlePath = ".env.qa-two-tenant.local";
const defaultPlanPath = ".env.qa-two-tenant-plan.local.json";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projectIdPattern = /^[-A-Za-z0-9]{8,80}$/;
const branchIdPattern = /^br-[-A-Za-z0-9]{8,128}$/;
const databaseNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/;
const databaseHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const planSchemaVersion = 2;

function usage() {
  console.log([
    "Two-tenant Preview QA fixture provisioning",
    "",
    "  generate   Create a gitignored 0600 credential bundle and SQL plan",
    "  bind-runtime  Bind the READY deployment and Preview DB from strict stdin JSON",
    "  print-plan Emit the generated SQL plan as JSON for an approved orchestrator",
    "  summary    Print only non-secret fixture identifiers",
    "",
    `generate requires NOVALURE_QA_PROVISION_CONFIRM=${confirmation}.`,
    `bind-runtime requires confirmation=${runtimeBindConfirmation} in stdin JSON.`,
    "It also requires the exact Git branch and Git SHA before the Preview deployment is built.",
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
  const databaseName = required("NOVALURE_QA_DATABASE_NAME");
  const databaseHost = required("NOVALURE_QA_DATABASE_HOST").toLowerCase();
  const productionProjectId = required("NOVALURE_PRODUCTION_PROJECT_ID");
  const productionBranchId = required("NOVALURE_PRODUCTION_BRANCH_ID");
  const productionDatabaseHost = required("NOVALURE_PRODUCTION_DATABASE_HOST").toLowerCase();
  const expectedGitBranch = required("NOVALURE_QA_EXPECTED_GIT_BRANCH");
  const expectedGitSha = required("NOVALURE_QA_EXPECTED_GIT_SHA").toLowerCase();
  if (
    !projectIdPattern.test(projectId)
    || !branchIdPattern.test(branchId)
    || !databaseNamePattern.test(databaseName)
    || !databaseHostPattern.test(databaseHost)
  ) {
    throw new Error("Invalid isolated Preview target identifiers");
  }
  if (
    !projectIdPattern.test(productionProjectId)
    || !branchIdPattern.test(productionBranchId)
    || !databaseHostPattern.test(productionDatabaseHost)
  ) {
    throw new Error("Invalid independent Production deny-target identifiers");
  }
  if (
    projectId === productionProjectId
    || branchId === productionBranchId
    || databaseHost === productionDatabaseHost
  ) {
    throw new Error("Preview and Production project, branch, and host must be independently distinct");
  }
  if (!/^[a-f0-9]{40}$/.test(expectedGitSha)) {
    throw new Error("NOVALURE_QA_EXPECTED_GIT_SHA must be the exact lowercase candidate SHA");
  }
  if (!/^codex\/[A-Za-z0-9._/-]{1,220}$/.test(expectedGitBranch)) {
    throw new Error("NOVALURE_QA_EXPECTED_GIT_BRANCH must be the exact codex/ Preview branch");
  }
  const namespace = `${projectId}:${branchId}:go-live-two-tenant-v1`;
  const authEncryptionKey = secret(48);
  const authRateLimitSecret = secret(48);
  const abuseSecret = secret(48);
  const runId = secret(8).replaceAll("-", "").replaceAll("_", "").slice(0, 10);
  const markerTime = timestampMarker();
  const targetGuardDigest = createHash("sha256")
    .update([projectId, branchId, databaseName].join("\0"))
    .digest("hex");
  const sqlStatements = [
    `
      do $novalure_qa_fixture_target_guard$
      declare
        actual_project_id text := current_setting('neon.project_id', true);
        actual_branch_id text := current_setting('neon.branch_id', true);
        actual_database_name text := current_database();
      begin
        if actual_project_id is distinct from ${sqlLiteral(projectId)}
          or actual_branch_id is distinct from ${sqlLiteral(branchId)}
          or actual_database_name is distinct from ${sqlLiteral(databaseName)}
        then
          raise exception 'QA fixture target identity mismatch';
        end if;
        if actual_project_id = ${sqlLiteral(productionProjectId)}
          or actual_branch_id = ${sqlLiteral(productionBranchId)}
        then
          raise exception 'QA fixture target overlaps Production deny target';
        end if;
        perform set_config('novalure.qa_fixture_target_guard', ${sqlLiteral(targetGuardDigest)}, true);
      end
      $novalure_qa_fixture_target_guard$
    `.trim(),
  ];
  const env = {
    NOVALURE_ABUSE_SECRET: abuseSecret,
    NOVALURE_AUTH_ENCRYPTION_KEY: authEncryptionKey,
    NOVALURE_AUTH_RATE_LIMIT_SECRET: authRateLimitSecret,
    NOVALURE_PRODUCTION_ORIGIN: "https://www.novalure-crm.app",
    NOVALURE_PRODUCTION_BRANCH_ID: productionBranchId,
    NOVALURE_PRODUCTION_DATABASE_HOST: productionDatabaseHost,
    NOVALURE_PRODUCTION_PROJECT_ID: productionProjectId,
    NOVALURE_PRODUCTION_WORKSPACE_IDS: "11111111-1111-4111-8111-111111111111,8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101",
    NOVALURE_QA_BATCH_REGISTRATION_ENABLED: "true",
    NOVALURE_QA_E2E_CLEANUP_CONFIRM: "RESET_TWO_TENANT_QA",
    NOVALURE_QA_E2E_WRITE_CONFIRM: "RUN_TWO_TENANT_QA",
    NOVALURE_QA_EXPECTED_GIT_BRANCH: expectedGitBranch,
    NOVALURE_QA_EXPECTED_GIT_SHA: expectedGitSha,
    NOVALURE_QA_PROJECT_ID: projectId,
    NOVALURE_QA_BRANCH_ID: branchId,
    NOVALURE_QA_DATABASE_HOST: databaseHost,
    NOVALURE_QA_DATABASE_NAME: databaseName,
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
        with identity_updated as (
          update public.auth_identities identity
          set password_hash = ${sqlLiteral(actor.passwordHash)},
              credential_state = 'active',
              mfa_secret_ciphertext = ${sqlLiteral(actor.ciphertext)},
              mfa_enabled_at = now(),
              disabled_at = null,
              password_changed_at = now(),
              updated_at = now()
          where identity.normalized_email = ${sqlLiteral(actor.email.toLowerCase())}
          returning identity.id
        ), sessions_revoked as (
          update public.auth_sessions session
          set revoked_at = now(), revoked_reason = 'qa_fixture_rotation'
          from identity_updated identity
          where session.auth_identity_id = identity.id
            and session.revoked_at is null
          returning session.id
        ), challenges_consumed as (
          update public.auth_login_challenges challenge
          set used_at = now(),
              payload_ciphertext = case
                when challenge.kind = 'mfa_enrollment' then null
                else challenge.payload_ciphertext
              end
          from identity_updated identity
          where challenge.auth_identity_id = identity.id
            and challenge.used_at is null
          returning challenge.id
        ), audited as (
          insert into public.auth_audit_events (
            event_type, outcome, auth_identity_id, workspace_user_id,
            workspace_id, session_id, metadata
          )
          select
            'auth.qa_fixture.credentials_rotated', 'success', identity.id,
            ${sqlLiteral(actor.userId)}::uuid, ${sqlLiteral(workspaceId)}::uuid, null,
            jsonb_build_object(
              'candidate', ${sqlLiteral(expectedGitSha)},
              'revokedSessionCount', (select count(*) from sessions_revoked),
              'consumedChallengeCount', (select count(*) from challenges_consumed)
            )
          from identity_updated identity
          returning id
        )
        select
          1 / (select count(*)::int from identity_updated)
          + 1 / (select count(*)::int from audited)
          as credential_rotation_guard
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
        ${sqlJson({ candidate: expectedGitSha, qaFixture: "go-live-two-tenant-v1", tenant: key })}
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
      databaseHost,
      databaseName,
      expectedGitBranch,
      expectedGitSha,
      productionBranchId,
      productionDatabaseHost,
      productionProjectId,
      projectId,
      schemaVersion: planSchemaVersion,
      sqlStatements,
      targetGuardDigest,
      tenants,
      transactionRequired: true,
      verifyStatements,
    },
  };
}

function checkedSpawn(executable, args, spawn = spawnSync, options = {}) {
  const result = spawn(executable, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || result.error?.message || "")
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .trim()
      .slice(0, 300);
    throw new Error(`Owner-only ACL command failed (${path.basename(executable)})${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  return result.stdout ?? "";
}

function windowsSystemExecutable(name) {
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", name);
}

function currentWindowsSid(spawn = spawnSync) {
  const output = checkedSpawn(
    windowsSystemExecutable("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    spawn,
  );
  const sid = output.match(/S-1-(?:-?\d+)+/u)?.[0] ?? "";
  if (!/^S-1-(?:\d+-)+\d+$/u.test(sid)) throw new Error("Current Windows owner SID is unavailable");
  return sid;
}

function readWindowsAcl(filePath, spawn = spawnSync) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$modulePath = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'",
    "Import-Module -Name $modulePath -ErrorAction Stop",
    "$sidType = [System.Security.Principal.SecurityIdentifier]",
    "$acl = Get-Acl -LiteralPath $env:NOVALURE_SECRET_ACL_PATH",
    "$ownerSid = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate($sidType).Value",
    "$access = @($acl.Access | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Translate($sidType).Value; type = $_.AccessControlType.ToString(); rights = [int64]$_.FileSystemRights; inherited = [bool]$_.IsInherited } })",
    "[pscustomobject]@{ ownerSid = $ownerSid; access = $access } | ConvertTo-Json -Compress -Depth 5",
  ].join("; ");
  const output = checkedSpawn(
    path.win32.join(
      process.env.SystemRoot?.trim() || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    spawn,
    { env: { ...process.env, NOVALURE_SECRET_ACL_PATH: filePath } },
  );
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Owner-only Windows ACL verification returned invalid output");
  }
}

export async function verifyOwnerOnlySecretFile(filePath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const spawn = options.spawn ?? spawnSync;
    const expectedSid = options.expectedWindowsSid ?? currentWindowsSid(spawn);
    const acl = readWindowsAcl(filePath, spawn);
    const access = Array.isArray(acl?.access) ? acl.access : [];
    const ownerOnly = acl?.ownerSid === expectedSid
      && access.length === 1
      && access[0]?.sid === expectedSid
      && access[0]?.type === "Allow"
      && access[0]?.inherited === false
      && Number(access[0]?.rights) === 2_032_127;
    if (!ownerOnly) throw new Error("Secret file owner-only Windows ACL could not be proven");
    return;
  }

  const state = await stat(filePath);
  if (!state.isFile() || (state.mode & 0o777) !== 0o600) {
    throw new Error("Secret file POSIX mode must be exactly 0600");
  }
}

export async function protectOwnerOnlySecretFile(filePath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const spawn = options.spawn ?? spawnSync;
    const sid = currentWindowsSid(spawn);
    checkedSpawn(
      windowsSystemExecutable("icacls.exe"),
      [filePath, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "/q"],
      spawn,
    );
    await verifyOwnerOnlySecretFile(filePath, { ...options, expectedWindowsSid: sid, spawn });
    return;
  }

  await chmod(filePath, 0o600);
  await verifyOwnerOnlySecretFile(filePath, options);
}

export async function writeSecretFile(filePath, contents, options = {}) {
  let created = false;
  try {
    await writeFile(filePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    const protect = options.protect ?? protectOwnerOnlySecretFile;
    const verify = options.verify ?? verifyOwnerOnlySecretFile;
    await protect(filePath, options);
    await writeFile(filePath, contents, { encoding: "utf8", flag: "r+" });
    await verify(filePath, options);
  } catch (error) {
    if (created) await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
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
  let bundleCreated = false;
  let planCreated = false;
  try {
    await writeSecretFile(bundlePath, envContents);
    bundleCreated = true;
    await writeSecretFile(planPath, `${JSON.stringify(fixture.plan)}\n`);
    planCreated = true;
  } catch (error) {
    if (planCreated) await rm(planPath, { force: true }).catch(() => undefined);
    if (bundleCreated) await rm(bundlePath, { force: true }).catch(() => undefined);
    throw new Error(`Fixture files could not be written atomically: ${error instanceof Error ? error.message : "unknown error"}`);
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
  if (
    parsed?.schemaVersion !== planSchemaVersion
    || parsed.transactionRequired !== true
    || !Array.isArray(parsed.sqlStatements)
    || !Array.isArray(parsed.tenants)
    || !projectIdPattern.test(parsed.projectId ?? "")
    || !branchIdPattern.test(parsed.branchId ?? "")
    || !databaseNamePattern.test(parsed.databaseName ?? "")
    || !databaseHostPattern.test(parsed.databaseHost ?? "")
    || !projectIdPattern.test(parsed.productionProjectId ?? "")
    || !branchIdPattern.test(parsed.productionBranchId ?? "")
    || !databaseHostPattern.test(parsed.productionDatabaseHost ?? "")
    || !/^[a-f0-9]{64}$/u.test(parsed.targetGuardDigest ?? "")
    || !/^do \$novalure_qa_fixture_target_guard\$/u.test(parsed.sqlStatements[0] ?? "")
  ) {
    throw new Error("Invalid QA fixture plan");
  }
  if (
    parsed.projectId === parsed.productionProjectId
    || parsed.branchId === parsed.productionBranchId
    || parsed.databaseHost.toLowerCase() === parsed.productionDatabaseHost.toLowerCase()
  ) throw new Error("QA fixture plan overlaps its Production deny target");
  if (parsed.tenants.some((tenant) => !uuidPattern.test(tenant.workspaceId) || !uuidPattern.test(tenant.batchId))) {
    throw new Error("QA fixture plan contains invalid identifiers");
  }
  return parsed;
}

async function readBoundedStdin(maximumBytes = 8_192) {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error("Runtime binding input is too large");
  }
  return value;
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const requiredKeys = [...expected].sort();
  if (actual.length !== requiredKeys.length || actual.some((key, index) => key !== requiredKeys[index])) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function parseRuntimeBinding(value, plan) {
  let input;
  try {
    input = JSON.parse(value);
  } catch {
    throw new Error("Runtime binding input must be valid JSON");
  }
  exactObjectKeys(input, [
    "baseUrl",
    "confirmation",
    "database",
    "deploymentId",
    "evidenceDirectory",
    "productionDatabase",
    "schemaVersion",
  ], "Runtime binding");
  exactObjectKeys(input.database, ["branchId", "databaseName", "host", "projectId", "role", "url"], "Runtime database binding");
  exactObjectKeys(input.productionDatabase, ["branchId", "host", "projectId"], "Runtime Production database binding");
  if (input.schemaVersion !== planSchemaVersion || input.confirmation !== runtimeBindConfirmation) {
    throw new Error("Runtime binding confirmation or schema version is invalid");
  }
  if (!/^dpl_[A-Za-z0-9]{20,80}$/.test(input.deploymentId)) {
    throw new Error("Runtime binding deployment id is invalid");
  }
  let base;
  let databaseUrl;
  try {
    base = new URL(input.baseUrl);
    databaseUrl = new URL(input.database.url);
  } catch {
    throw new Error("Runtime binding contains an invalid URL");
  }
  if (
    base.protocol !== "https:"
    || base.pathname !== "/"
    || base.search
    || base.hash
    || base.username
    || base.password
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/.test(base.hostname)
  ) throw new Error("Runtime binding base URL must be an exact Vercel Preview origin");
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || !databaseUrl.username
    || !databaseUrl.password
    || databaseUrl.hostname !== input.database.host
    || decodeURIComponent(databaseUrl.username) !== input.database.role
    || decodeURIComponent(databaseUrl.pathname.slice(1)) !== input.database.databaseName
    || !new Set(["require", "verify-full"]).has(databaseUrl.searchParams.get("sslmode") ?? "")
  ) throw new Error("Runtime database URL does not match its declared target");
  if (
    input.database.projectId !== plan.projectId
    || input.database.branchId !== plan.branchId
    || input.database.databaseName !== plan.databaseName
    || input.database.host.toLowerCase() !== plan.databaseHost.toLowerCase()
    || !projectIdPattern.test(input.database.projectId)
    || !branchIdPattern.test(input.database.branchId)
    || !databaseNamePattern.test(input.database.databaseName)
    || input.database.role !== "novalure_app"
    || !databaseHostPattern.test(input.database.host.toLowerCase())
    || !input.database.host.toLowerCase().includes("-pooler.")
  ) throw new Error("Runtime database target does not match the generated fixture plan");
  if (
    input.productionDatabase.projectId !== plan.productionProjectId
    || input.productionDatabase.branchId !== plan.productionBranchId
    || input.productionDatabase.host?.trim().toLowerCase() !== plan.productionDatabaseHost.toLowerCase()
    || !projectIdPattern.test(input.productionDatabase.projectId ?? "")
    || !branchIdPattern.test(input.productionDatabase.branchId ?? "")
    || !databaseHostPattern.test(input.productionDatabase.host?.trim().toLowerCase() ?? "")
    || input.productionDatabase.projectId === input.database.projectId
    || input.productionDatabase.branchId === input.database.branchId
    || input.productionDatabase.host.trim().toLowerCase() === input.database.host.toLowerCase()
  ) throw new Error("Runtime binding must preserve distinct Production project, branch, and host deny targets");
  if (
    typeof input.evidenceDirectory !== "string"
    || !/^artifacts\/qa\/[a-z0-9][a-z0-9._/-]{1,180}$/u.test(input.evidenceDirectory)
    || input.evidenceDirectory.includes("..")
  ) throw new Error("Runtime evidence directory is invalid");

  return Object.freeze({
    NOVALURE_PRODUCTION_BRANCH_ID: input.productionDatabase.branchId,
    NOVALURE_PRODUCTION_DATABASE_HOST: input.productionDatabase.host.trim().toLowerCase(),
    NOVALURE_PRODUCTION_PROJECT_ID: input.productionDatabase.projectId,
    NOVALURE_QA_BASE_URL: base.origin,
    NOVALURE_QA_DATABASE_HOST: input.database.host.toLowerCase(),
    NOVALURE_QA_DATABASE_NAME: input.database.databaseName,
    NOVALURE_QA_DATABASE_ROLE: input.database.role,
    NOVALURE_QA_DATABASE_URL: input.database.url,
    NOVALURE_QA_EVIDENCE_DIR: input.evidenceDirectory,
    NOVALURE_QA_EXPECTED_DEPLOYMENT_ID: input.deploymentId,
  });
}

async function bindRuntime() {
  const bundlePath = assertSafeLocalPath(process.env.NOVALURE_QA_FIXTURE_ENV_FILE, defaultBundlePath);
  const plan = await readPlan();
  const binding = parseRuntimeBinding(await readBoundedStdin(), plan);
  const existing = await readFile(bundlePath, "utf8");
  if (!existing.startsWith("# Generated Preview-only QA fixture.")) throw new Error("QA fixture bundle header is invalid");
  const bindingNames = new Set(Object.keys(binding));
  const retained = existing.split(/\r?\n/u).filter((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    return !match || !bindingNames.has(match[1]);
  });
  while (retained.at(-1) === "") retained.pop();
  const contents = [
    ...retained,
    ...Object.entries(binding).sort(([left], [right]) => left.localeCompare(right)).map(([name, item]) => envLine(name, item)),
    "",
  ].join("\n");
  const temporaryPath = `${bundlePath}.runtime-${process.pid}-${randomBytes(6).toString("hex")}`;
  let renamed = false;
  try {
    await writeSecretFile(temporaryPath, contents);
    await rename(temporaryPath, bundlePath);
    renamed = true;
    await verifyOwnerOnlySecretFile(bundlePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (renamed) await rm(bundlePath, { force: true }).catch(() => undefined);
    throw error;
  }
  console.log(JSON.stringify({
    bound: true,
    branchId: plan.branchId,
    deploymentId: binding.NOVALURE_QA_EXPECTED_DEPLOYMENT_ID,
    previewHost: new URL(binding.NOVALURE_QA_BASE_URL).hostname,
    projectId: plan.projectId,
  }));
}

async function main() {
  const mode = process.argv[2] ?? "help";
  if (mode === "generate") return generate();
  if (mode === "bind-runtime") return bindRuntime();
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

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "QA fixture provisioning failed");
    process.exitCode = 1;
  });
}
