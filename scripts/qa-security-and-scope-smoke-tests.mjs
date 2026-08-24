#!/usr/bin/env node

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  hasSupportedWebhookContentEncoding,
  isJsonWebhookContentType,
  isMetaWebhookPayload,
  readLimitedWebhookBody,
  verifyMetaWebhookSignature,
} from "../src/lib/bots/webhook-security.ts";
import {
  createMediaShareToken,
  hasExpectedMediaMagicBytes,
  hashMediaShareToken,
  safeMediaContentDisposition,
} from "../src/lib/media-security.ts";
import {
  assertConnectedDatabaseTarget,
  assertDatabaseHost,
  assertDatabaseTarget,
  resolveDatabaseTarget,
} from "./lib/infra-targets.mjs";

const infraEnvironmentKeys = [
  "NOVALURE_PRODUCTION_DATABASE_HOST",
  "NOVALURE_PRODUCTION_BRANCH_ID",
  "NOVALURE_PRODUCTION_DATABASE_NAME",
  "NOVALURE_PRODUCTION_DATABASE_ROLE",
  "NOVALURE_PRODUCTION_MIGRATION_DATABASE_ROLE",
  "NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST",
  "NOVALURE_PRODUCTION_PROJECT_FINGERPRINT",
  "NOVALURE_PRODUCTION_PROJECT_ID",
  "NOVALURE_RECOVERY_DATABASE_HOST",
  "NOVALURE_RECOVERY_BRANCH_ID",
  "NOVALURE_RECOVERY_DATABASE_NAME",
  "NOVALURE_RECOVERY_DATABASE_ROLE",
  "NOVALURE_RECOVERY_MIGRATION_DATABASE_ROLE",
  "NOVALURE_RECOVERY_MIGRATION_DATABASE_HOST",
  "NOVALURE_RECOVERY_PROJECT_FINGERPRINT",
  "NOVALURE_RECOVERY_PROJECT_ID",
  "NOVALURE_QA_DATABASE_HOST",
  "NOVALURE_QA_BRANCH_ID",
  "NOVALURE_QA_DATABASE_NAME",
  "NOVALURE_QA_DATABASE_ROLE",
  "NOVALURE_QA_MIGRATION_DATABASE_ROLE",
  "NOVALURE_QA_MIGRATION_DATABASE_HOST",
  "NOVALURE_QA_PROJECT_FINGERPRINT",
  "NOVALURE_QA_PROJECT_ID",
  "POSTGRES_NEON_PROJECT_ID",
  "NEON_PROJECT_ID",
];

function withoutInfraEnvironment(callback) {
  const previous = new Map(infraEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of infraEnvironmentKeys) delete process.env[key];
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("CI pins the exact Node runtime and fails closed for QA targets", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const workflow = await readFile(new URL("../.github/workflows/livegang-e2e.yml", import.meta.url), "utf8");
  const protectedPreviewRunner = await readFile(
    new URL("./qa-protected-preview-action-runner.mjs", import.meta.url),
    "utf8",
  );
  const guard = await readFile(new URL("./qa-target-guard.mjs", import.meta.url), "utf8");

  assert.equal(packageJson.engines.node, ">=24 <25");
  assert.match(workflow, /node-version-file:\s*\.node-version/);
  assert.doesNotMatch(workflow, /secrets\.DATABASE_URL/);
  assert.doesNotMatch(workflow, /NOVALURE_RUN_LIVEGANG_E2E/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment:\s*go-live-preview/);
  assert.match(workflow, /node scripts\/qa-protected-preview-action-runner\.mjs/);
  assert.match(protectedPreviewRunner, /qa-protected-preview-workflow-contract\.mjs/);
  assert.match(
    protectedPreviewRunner,
    /\["scripts\/qa-two-tenant-e2e\.mjs", "--preflight", "--share-url-stdin"\]/,
  );
  assert.match(workflow, /group:\s*exact-protected-preview-\$\{\{ inputs\.deployment_id \}\}[\s\S]*cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /db-migrate\.mjs up|qa-livegang-seed/);
  assert.match(guard, /neon\.branch_id/);
  assert.match(guard, /-pooler\./);

  const childEnvironment = { ...process.env };
  for (const key of [
    "NOVALURE_QA_DATABASE_URL",
    "NOVALURE_QA_DATABASE_HOST",
    "NOVALURE_QA_PROJECT_ID",
    "NOVALURE_QA_BRANCH_ID",
    "NOVALURE_QA_DATABASE_NAME",
    "NOVALURE_QA_DATABASE_ROLE",
    "NOVALURE_QA_RUN_PREFIX",
  ]) delete childEnvironment[key];
  const guardResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./qa-target-guard.mjs", import.meta.url))],
    { encoding: "utf8", env: childEnvironment },
  );
  assert.notEqual(guardResult.status, 0);
  assert.match(guardResult.stderr, /NOVALURE_QA_DATABASE_URL is required/);
});

test("database infrastructure targets are lazy, explicit and fail closed", () => {
  withoutInfraEnvironment(() => {
    assert.throws(
      () => resolveDatabaseTarget("test", {}),
      /NOVALURE_QA_DATABASE_HOST is required/,
    );

    const exactEnvironment = {
      NOVALURE_QA_DATABASE_HOST: "qa-guard-pooler.example.neon.tech",
      NOVALURE_QA_PROJECT_ID: "qa-project-1234",
      POSTGRES_NEON_PROJECT_ID: "qa-project-1234",
    };
    const verified = assertDatabaseTarget({
      databaseUrl: "postgresql://user:secret@qa-guard-pooler.example.neon.tech/app",
      env: exactEnvironment,
      purpose: "repository hygiene test",
      target: "test",
    });
    assert.deepEqual(verified, {
      host: "qa-guard-pooler.example.neon.tech",
      projectId: "qa-project-1234",
      target: "test",
    });

    assert.throws(
      () => assertDatabaseHost({
        databaseUrl: "postgresql://user:secret@wrong-guard-pooler.example.neon.tech/app",
        env: exactEnvironment,
        purpose: "repository hygiene test",
        target: "test",
      }),
      (error) => {
        assert.doesNotMatch(error.message, /secret|wrong-guard/);
        return /does not match the declared test target/.test(error.message);
      },
    );
    assert.throws(
      () => assertDatabaseTarget({
        databaseUrl: "postgresql://user:secret@qa-guard-pooler.example.neon.tech/app",
        env: { ...exactEnvironment, POSTGRES_NEON_PROJECT_ID: "other-project-1234" },
        target: "test",
      }),
      /active Neon project does not match/,
    );

    const fingerprintEnvironment = {
      NOVALURE_QA_DATABASE_HOST: "qa-guard-pooler.example.neon.tech",
      NOVALURE_QA_PROJECT_FINGERPRINT: "fingerprint42",
      POSTGRES_NEON_PROJECT_ID: "project-fingerprint42",
    };
    assert.equal(assertDatabaseTarget({
      databaseUrl: "postgresql://user:secret@qa-guard-pooler.example.neon.tech/app",
      env: fingerprintEnvironment,
      target: "test",
    }).target, "test");
    assert.throws(
      () => resolveDatabaseTarget("test", {
        ...fingerprintEnvironment,
        NOVALURE_QA_PROJECT_ID: "qa-project-1234",
      }),
      /Configure only one/,
    );
    assert.throws(
      () => resolveDatabaseTarget("test", {
        ...fingerprintEnvironment,
        NOVALURE_PRODUCTION_DATABASE_HOST: "qa-guard-pooler.example.neon.tech",
      }),
      /hosts must be different/,
    );

    const directEnvironment = {
      NOVALURE_QA_MIGRATION_DATABASE_HOST: "qa-guard.example.neon.tech",
      NOVALURE_QA_PROJECT_ID: "qa-project-1234",
      POSTGRES_NEON_PROJECT_ID: "qa-project-1234",
    };
    assert.equal(assertDatabaseTarget({
      connectionMode: "direct",
      databaseUrl: "postgresql://user:secret@qa-guard.example.neon.tech/app",
      env: directEnvironment,
      target: "test",
    }).target, "test");
    assert.throws(
      () => assertDatabaseTarget({
        connectionMode: "direct",
        databaseUrl: "postgresql://user:secret@qa-guard-pooler.example.neon.tech/app",
        env: {
          ...directEnvironment,
          NOVALURE_QA_MIGRATION_DATABASE_HOST: "qa-guard-pooler.example.neon.tech",
        },
        target: "test",
      }),
      /bare direct Neon database hostname/,
    );
  });
});

test("migration connections verify the actual Neon branch, database and role", async () => {
  const env = {
    NOVALURE_QA_BRANCH_ID: "br-qa-branch-1234",
    NOVALURE_QA_DATABASE_NAME: "neondb",
    NOVALURE_QA_DATABASE_ROLE: "novalure_app",
    NOVALURE_QA_MIGRATION_DATABASE_ROLE: "migration_owner",
    NOVALURE_QA_PROJECT_ID: "qa-project-1234",
  };
  const actual = {
    branchId: "br-qa-branch-1234",
    databaseName: "neondb",
    projectId: "qa-project-1234",
    roleName: "novalure_app",
    serverVersionNum: "170004",
  };
  const client = { query: async () => ({ rows: [actual] }) };

  assert.deepEqual(
    await assertConnectedDatabaseTarget({ client, env, target: "test" }),
    { ...actual, serverVersionNum: 170004, target: "test" },
  );
  await assert.rejects(
    () => assertConnectedDatabaseTarget({
      client: {
        query: async () => ({
          rows: [{ ...actual, branchId: "br-wrong-branch-1234" }],
        }),
      },
      env,
      target: "test",
    }),
    /Connected database fingerprint does not match the declared test target/,
  );
  await assert.rejects(
    () => assertConnectedDatabaseTarget({
      client,
      env: { ...env, NOVALURE_QA_DATABASE_ROLE: "other_role" },
      target: "test",
    }),
    /Connected database fingerprint does not match the declared test target/,
  );
  assert.equal(
    (await assertConnectedDatabaseTarget({
      client: {
        query: async () => ({ rows: [{ ...actual, roleName: "migration_owner" }] }),
      },
      connectionMode: "direct",
      env,
      target: "test",
    })).roleName,
    "migration_owner",
  );
  await assert.rejects(
    () => assertConnectedDatabaseTarget({
      client,
      connectionMode: "direct",
      env: { ...env, NOVALURE_QA_MIGRATION_DATABASE_ROLE: "novalure_app" },
      target: "test",
    }),
    /Migration database role must differ from the pooled application role/,
  );
  await assert.rejects(
    () => assertConnectedDatabaseTarget({
      client: {
        query: async () => ({ rows: [{ ...actual, roleName: "migration_owner", serverVersionNum: "160010" }] }),
      },
      connectionMode: "direct",
      env,
      minimumServerVersionNum: 170000,
      target: "test",
    }),
    /PostgreSQL version does not meet the migration-runner requirement/,
  );
});

test("recovery migrations require one exact Production-project child branch", async () => {
  await withoutInfraEnvironment(async () => {
    const env = {
      NOVALURE_PRODUCTION_BRANCH_ID: "br-production-main-1234",
      NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST: "prod-main.example.neon.tech",
      NOVALURE_PRODUCTION_PROJECT_ID: "prod-project-1234",
      NOVALURE_QA_MIGRATION_DATABASE_HOST: "qa-isolated.example.neon.tech",
      NOVALURE_RECOVERY_BRANCH_ID: "br-recovery-child-1234",
      NOVALURE_RECOVERY_DATABASE_NAME: "neondb",
      NOVALURE_RECOVERY_DATABASE_ROLE: "novalure_app",
      NOVALURE_RECOVERY_MIGRATION_DATABASE_HOST: "recovery-child.example.neon.tech",
      NOVALURE_RECOVERY_MIGRATION_DATABASE_ROLE: "migration_owner",
      NOVALURE_RECOVERY_PROJECT_ID: "prod-project-1234",
      POSTGRES_NEON_PROJECT_ID: "prod-project-1234",
    };
    const databaseUrlFixture = new URL("postgresql://recovery-child.example.neon.tech/neondb");
    databaseUrlFixture.username = "migration_owner";
    databaseUrlFixture.password = "fixture_not_a_secret";
    const databaseUrl = databaseUrlFixture.href;

    assert.deepEqual(
      assertDatabaseTarget({
        connectionMode: "direct",
        databaseUrl,
        env,
        purpose: "recovery migration test",
        target: "recovery",
      }),
      {
        host: "recovery-child.example.neon.tech",
        projectId: "prod-project-1234",
        target: "recovery",
      },
    );

    const actual = {
      branchId: "br-recovery-child-1234",
      databaseName: "neondb",
      projectId: "prod-project-1234",
      roleName: "migration_owner",
      serverVersionNum: "170004",
    };
    assert.deepEqual(
      await assertConnectedDatabaseTarget({
        client: { query: async () => ({ rows: [actual] }) },
        connectionMode: "direct",
        env,
        minimumServerVersionNum: 170000,
        target: "recovery",
      }),
      { ...actual, serverVersionNum: 170004, target: "recovery" },
    );

    assert.throws(
      () => assertDatabaseTarget({
        connectionMode: "direct",
        databaseUrl,
        env: { ...env, NOVALURE_PRODUCTION_PROJECT_ID: "different-prod-project" },
        target: "recovery",
      }),
      /exact declared Production Neon project/,
    );
    assert.throws(
      () => assertDatabaseTarget({
        connectionMode: "direct",
        databaseUrl,
        env: {
          ...env,
          NOVALURE_RECOVERY_BRANCH_ID: "br-production-main-1234",
        },
        target: "recovery",
      }),
      /must differ from Production Main/,
    );
    assert.throws(
      () => assertDatabaseTarget({
        connectionMode: "direct",
        databaseUrl,
        env: {
          ...env,
          NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST: "recovery-child.example.neon.tech",
        },
        target: "recovery",
      }),
      /target hosts must be different/,
    );
    await assert.rejects(
      () => assertConnectedDatabaseTarget({
        client: {
          query: async () => ({
            rows: [{ ...actual, branchId: "br-production-main-1234" }],
          }),
        },
        connectionMode: "direct",
        env,
        target: "recovery",
      }),
      /does not match the declared recovery target/,
    );
  });
});

test("database scripts use the central target guard without embedded provider fingerprints", async () => {
  const guardedScripts = [
    "db-migrate.mjs",
    "e2e-object-creation-tests.mjs",
    "qa-contact-access.mjs",
    "qa-deal-idempotency.mjs",
    "qa-lead-idempotency.mjs",
    "qa-persistence-diagnostics.mjs",
    "qa-phase2-property-kpis.mjs",
    "qa-phase3-duplicate-guards.mjs",
    "qa-productrole-invite-hardening.mjs",
    "qa-property-pagination.mjs",
    "qa-property-unit-pagination.mjs",
    "qa-public-slug-routing.mjs",
    "qa-reservation-stage-resolver.mjs",
  ];
  const sources = await Promise.all(
    guardedScripts.map((file) => readFile(new URL(`./${file}`, import.meta.url), "utf8")),
  );

  for (const source of sources) {
    assert.match(source, /\.\/lib\/infra-targets\.mjs/);
    assert.doesNotMatch(source, /["']ep-[a-z0-9-]+[^"']*\.neon\.tech["']/i);
    assert.doesNotMatch(source, /(?:test|prod)Db(?:Host|Suffix)\s*=/);
    assert.doesNotMatch(source, /hostPrefix:\s*["']ep-/);
  }
});

test("legacy direct production migration entrypoints are fail-closed", async () => {
  const disabledScripts = await Promise.all(
    [
      "apply-company-profiles-migration.mjs",
      "apply-contact-archiving-migration.mjs",
      "apply-contact-owner-scope-migration.mjs",
      "apply-novalure-growth-migration.mjs",
      "apply-property-content-guards-migration.mjs",
      "apply-property-default-units-migration.mjs",
      "apply-property-department-migration.mjs",
      "apply-public-slug-routing-migration.mjs",
      "apply-user-onboarding-migration.mjs",
    ].map((file) => readFile(new URL(`./${file}`, import.meta.url), "utf8")),
  );
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const runner = await readFile(new URL("./db-migrate.mjs", import.meta.url), "utf8");

  for (const source of disabledScripts) {
    assert.match(source, /Direct .* migration is disabled/);
    assert.doesNotMatch(source, /new Pool|pool\.query|DATABASE_URL|\.env\.production/);
  }
  assert.equal(
    packageJson.scripts["db:migrate:company-profiles"],
    "node scripts/apply-company-profiles-migration.mjs",
  );
  assert.match(runner, /MIGRATION_DATABASE_URL/);
  assert.match(runner, /connectionMode:\s*"direct"/);
  assert.match(runner, /assertConnectedDatabaseTarget/);
  for (const [alias, script] of Object.entries(packageJson.scripts)) {
    if (!alias.startsWith("db:migrate:")) continue;
    assert.doesNotMatch(script, /db-migrate\.mjs\s+up/);
    assert.match(script, /scripts\/apply-.*-migration\.mjs/);
  }
});

test("secret scanning is immutable, full-history and least-privilege", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/secret-scan.yml", import.meta.url),
    "utf8",
  );
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");

  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/);
  assert.match(workflow, /@nogoo9\/gitleaks-linux-x64@8\.30\.1-post\.3/);
  assert.match(workflow, /88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509/);
  assert.match(workflow, /--log-opts="--all --full-history"/);
  assert.match(workflow, /"\$scanner" dir \./);
  assert.match(workflow, /--redact=100/);
  assert.match(workflow, /--report-path="\$history_report" \|\| history_status=\$\?/);
  assert.match(workflow, /--report-path="\$tree_report" \|\| tree_status=\$\?/);
  assert.match(workflow, /history_findings=|\$\{scope\}_findings=/);
  assert.match(workflow, /rule=\$\{safeText\(finding\.RuleID, 120\)\}/);
  assert.match(workflow, /file=\$\{safeText\(finding\.File, 260\)\}/);
  assert.match(workflow, /fingerprint=\$\{fingerprint\}/);
  assert.match(workflow, /\^\[A-Za-z0-9\._\/@:\+-\]\{1,620\}\$/);
  assert.match(workflow, /if \(total > 0\) process\.exitCode = 1/);
  assert.doesNotMatch(workflow, /finding\.(?:Secret|Match)|JSON\.stringify\(findings\)/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(workflow, /GITLEAKS_LICENSE|GITHUB_TOKEN|upload-artifact/);
  assert.doesNotMatch(workflow, /uses:\s*[^\s]+@(main|master|v\d+)\s*$/m);
  assert.match(gitignore, /^\*\.log$/m);
});

test("protected Preview CI pins the trusted harness, remote candidate and immutable actions", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/livegang-e2e.yml", import.meta.url),
    "utf8",
  );
  const protectedPreviewRunner = await readFile(
    new URL("./qa-protected-preview-action-runner.mjs", import.meta.url),
    "utf8",
  );
  const setupBlocks = [...workflow.matchAll(/uses:\s+actions\/setup-node@[\s\S]*?package-manager-cache:\s*false/g)];

  assert.equal(setupBlocks.length, 2);
  for (const block of setupBlocks) assert.match(block[0], /node-version-file:\s*\.node-version/);
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request):/m);
  assert.match(workflow, /environment:\s*go-live-preview/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.trusted_harness_sha \}\}/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{ inputs\.candidate_sha \}\}/);
  assert.match(workflow, /test "\$checked_out_sha" = "\$NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA"/);
  assert.match(workflow, /NOVALURE_WORKFLOW_CANDIDATE_SHA:\s*\$\{\{ inputs\.candidate_sha \}\}/);
  assert.equal((workflow.match(/\bnpm ci\b/g) ?? []).length, 2);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/);
  assert.doesNotMatch(workflow, /uses:\s*[^\s]+@(main|master|v\d+)\s*$/m);
  assert.doesNotMatch(workflow, /db-migrate\.mjs|qa-test-db-seed-base\.mjs|migrate-and-seed/);
  assert.doesNotMatch(workflow, /cat \/tmp\/novalure-livegang\.log/);
  assert.match(workflow, /node scripts\/qa-protected-preview-action-runner\.mjs/);
  assert.match(protectedPreviewRunner, /qa-protected-preview-workflow-contract\.mjs/);
  assert.match(
    protectedPreviewRunner,
    /\["scripts\/qa-two-tenant-e2e\.mjs", "--preflight", "--share-url-stdin"\]/,
  );
  assert.match(
    protectedPreviewRunner,
    /\["scripts\/qa-two-tenant-e2e\.mjs", "--execute", "--share-url-stdin"\]/,
  );
  assert.doesNotMatch(workflow, /\.env\.qa-two-tenant|shred --force/);
});

test("Meta webhook HMAC is bound to the unchanged raw body", () => {
  const secret = "qa-meta-app-secret";
  const rawBody = Buffer.from('{"object":"whatsapp_business_account","entry":[]}', "utf8");
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  assert.equal(verifyMetaWebhookSignature(rawBody, signature, secret), true);
  assert.equal(verifyMetaWebhookSignature(Buffer.concat([rawBody, Buffer.from(" ")]), signature, secret), false);
  assert.equal(verifyMetaWebhookSignature(rawBody, null, secret), false);
  assert.equal(verifyMetaWebhookSignature(rawBody, signature, null), false);
  assert.equal(verifyMetaWebhookSignature(rawBody, "sha256=not-a-digest", secret), false);
});

test("Meta payloads cannot downgrade to the custom webhook authentication path", () => {
  assert.equal(isMetaWebhookPayload({ field: "messages", value: { statuses: [] } }), true);
  assert.equal(isMetaWebhookPayload({ object: "whatsapp_business_account", entry: [] }), true);
  assert.equal(isMetaWebhookPayload({ channel: "WhatsApp", accountRef: "account-1" }), true);
  assert.equal(isMetaWebhookPayload({ channel: "API/Webhook", accountRef: "account-1" }), false);
});

test("webhook request media type, content encoding and byte limit fail closed", async () => {
  assert.equal(isJsonWebhookContentType("application/json; charset=utf-8"), true);
  assert.equal(isJsonWebhookContentType("application/webhook+json"), true);
  assert.equal(isJsonWebhookContentType("text/plain"), false);
  assert.equal(hasSupportedWebhookContentEncoding(null), true);
  assert.equal(hasSupportedWebhookContentEncoding("identity"), true);
  assert.equal(hasSupportedWebhookContentEncoding("gzip"), false);

  const accepted = await readLimitedWebhookBody(new Request("https://example.test/webhook", {
    body: "1234",
    method: "POST",
  }), 4);
  assert.equal(accepted.ok, true);

  const rejected = await readLimitedWebhookBody(new Request("https://example.test/webhook", {
    body: "12345",
    method: "POST",
  }), 4);
  assert.deepEqual(rejected, { ok: false, reason: "payload_too_large" });
});

test("webhook route has no unsigned Meta, caller-workspace or replay side-effect path", async () => {
  const route = await readFile(new URL("../src/app/api/bots/channels/webhook/route.ts", import.meta.url), "utf8");
  const normalizer = await readFile(new URL("../src/lib/bots/omnichannel.ts", import.meta.url), "utf8");
  const repository = await readFile(new URL("../src/lib/db/runtime-repositories.ts", import.meta.url), "utf8");
  const expandMigration = await readFile(
    new URL("../migrations/048_bot_webhook_integrity.sql", import.meta.url),
    "utf8",
  );
  const cutoverMigration = await readFile(
    new URL("../migrations/057_bot_webhook_legacy_index_cutover.sql", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(route, /unsignedMetaDashboardProbe|allowUnsignedWebhooks|getDefaultWorkspaceForWebhook/);
  assert.doesNotMatch(route, /x-novalure-workspace-id|body\.workspaceId|NOVALURE_WORKSPACE_ID/);
  assert.doesNotMatch(route, /hint:|supportedChannels:/);
  assert.match(route, /if \(!expectedToken\)/);
  assert.match(route, /constantTimeEqualStrings\(token, expectedToken\)/);
  assert.match(route, /webhookProcessingDisabled\(\)/);
  assert.match(route, /metaPayload\s*\?\s*verifyMetaWebhookSignature/);
  assert.match(route, /channelAccountResolution\.status !== "matched"/);
  assert.match(route, /webhookRecord\.outcome === "completed" \|\| webhookRecord\.outcome === "ignored"/);
  assert.match(route, /webhookRecord\.outcome === "in_flight"[\s\S]*return jsonWebhookResponse\(correlationId, 503/);
  assert.ok(route.indexOf("webhookRecord.outcome === \"completed\"") < route.indexOf("runBotChat({"));
  assert.ok(route.indexOf("webhookRecord.outcome === \"in_flight\"") < route.indexOf("sendBotChannelReply({"));
  assert.doesNotMatch(route, /botReply:|outboundDelivery,\s*\n\s*outboundConsent/);
  assert.doesNotMatch(normalizer, /crypto\.randomUUID/);
  assert.match(repository, /setup_status in \('ready', 'connected'\)/);
  assert.match(repository, /limit 2/);
  assert.match(repository, /status in \('received', 'failed'\)[\s\S]*lease_expires_at <= now\(\)/);
  assert.match(repository, /processing_attempt = bot_channel_webhooks\.processing_attempt \+ 1/);
  assert.match(expandMigration, /bot_channel_accounts_active_mapping_uidx/);
  assert.match(expandMigration, /bot_channel_webhooks_account_event_uidx/);
  assert.doesNotMatch(expandMigration, /drop index if exists bot_channel_webhooks_workspace_message_uidx/);
  assert.match(cutoverMigration, /drop index if exists bot_channel_webhooks_workspace_message_uidx/);
});

test("media signatures reject MIME/content mismatches", () => {
  assert.equal(hasExpectedMediaMagicBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"), true);
  assert.equal(
    hasExpectedMediaMagicBytes(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "image/png",
    ),
    true,
  );
  assert.equal(
    hasExpectedMediaMagicBytes(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]), "application/pdf"),
    true,
  );
  assert.equal(hasExpectedMediaMagicBytes(Uint8Array.from([0x25, 0x50, 0x44, 0x46]), "image/jpeg"), false);
  assert.equal(hasExpectedMediaMagicBytes(Uint8Array.from([0x3c, 0x73, 0x76, 0x67]), "image/svg+xml"), false);
});

test("media share tokens are high entropy, hashed and safe for response headers", () => {
  const first = createMediaShareToken();
  const second = createMediaShareToken();
  const digest = hashMediaShareToken(first);

  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(digest, first);

  const disposition = safeMediaContentDisposition('../private\r\nX-Injected: yes\\report".pdf', "application/pdf");
  assert.match(disposition, /^attachment;/);
  assert.doesNotMatch(disposition, /[\r\n]/);
  assert.doesNotMatch(disposition.split("; filename*=")[0], /\\/);
  assert.match(safeMediaContentDisposition("cover.png", "image/png"), /^inline;/);
});

test("private media routes stream through the app and never redirect to Blob", async () => {
  const store = await readFile(new URL("../src/lib/media-store.ts", import.meta.url), "utf8");
  const privateRoute = await readFile(
    new URL("../src/app/api/media/files/[assetId]/route.ts", import.meta.url),
    "utf8",
  );
  const publicRoute = await readFile(
    new URL("../src/app/api/media/public/[token]/route.ts", import.meta.url),
    "utf8",
  );
  const apiRoute = await readFile(new URL("../src/app/api/media/route.ts", import.meta.url), "utf8");
  const expandMigration = await readFile(
    new URL("../migrations/051_private_media_access.sql", import.meta.url),
    "utf8",
  );
  const cutoverMigration = await readFile(
    new URL("../migrations/062_private_media_contract_cutover.sql", import.meta.url),
    "utf8",
  );

  assert.match(store, /put\(relativePath, file, \{[\s\S]*?access: "private"/);
  assert.doesNotMatch(store, /put\([^)]*[\s\S]{0,250}access: "public"/);
  assert.match(store, /NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN/);
  assert.match(store, /PRIVATE_STORAGE_UNAVAILABLE/);
  assert.match(store, /get\(storagePathname\(asset\), \{[\s\S]*?useCache: false/);
  assert.match(store, /normalized\.startsWith\(workspacePrefix\)/);
  assert.match(store, /url: protectedMediaPath\(asset\.id\)/);
  assert.match(store, /hashMediaShareToken\(token\)/);
  assert.match(store, /revoked_at is null/);
  assert.match(store, /set revoked_at = coalesce\(mas\.revoked_at, now\(\)\)/);
  assert.match(store, /expires_at > now\(\)/);

  for (const route of [privateRoute, publicRoute]) {
    assert.match(route, /readMediaAssetContent\(asset\)/);
    assert.match(route, /"x-content-type-options": "nosniff"/);
    assert.match(route, /safeMediaContentDisposition/);
    assert.doesNotMatch(route, /redirect\s*\(/);
    assert.doesNotMatch(route, /asset\.url/);
  }
  assert.match(privateRoute, /"cache-control": "private, no-store"/);
  assert.match(privateRoute, /findWorkspaceMediaAsset\(assetId, auth\.session\.workspaceId\)/);
  assert.match(publicRoute, /findPublicMediaAsset\(token\)/);
  assert.match(apiRoute, /media\.assets\.map\(serializeMediaAsset\)/);
  assert.match(apiRoute, /body\?\.action !== "publish" && body\?\.action !== "revoke"/);

  assert.match(expandMigration, /storage_access in \('private', 'legacy-public', 'published-public'\)/);
  assert.match(expandMigration, /token_hash text not null/);
  assert.match(expandMigration, /scope text not null default 'public-download'/);
  assert.match(expandMigration, /expires_at timestamptz not null/);
  assert.match(expandMigration, /revoked_at timestamptz/);
  assert.match(expandMigration, /encode\(digest\(public_token, 'sha256'\), 'hex'\)/);
  assert.doesNotMatch(expandMigration, /add constraint media_assets_public_token_cleartext_check/);
  assert.match(cutoverMigration, /add constraint media_assets_public_token_cleartext_check/);
  assert.match(cutoverMigration, /set url = '\/api\/media\/files\/' \|\| id::text/);
});

test("media consumers do not serialize storage URLs or persist share tokens", async () => {
  const botActions = await readFile(new URL("../src/app/api/bots/actions/route.ts", import.meta.url), "utf8");
  const botDocuments = await readFile(new URL("../src/app/api/bots/documents/route.ts", import.meta.url), "utf8");
  const botRuntime = await readFile(new URL("../src/lib/bots/chat-runtime.ts", import.meta.url), "utf8");
  const crmLoaders = await readFile(new URL("../src/lib/db/crm-loaders.ts", import.meta.url), "utf8");

  assert.doesNotMatch(botActions, /ma\.url as "mediaAssetUrl"/);
  assert.doesNotMatch(botActions, /ma\.public_token/);
  assert.doesNotMatch(botActions, /attachedMediaAssetPublicUrl:/);
  assert.doesNotMatch(botActions, /attachedMediaAssetUrl:/);
  assert.match(botActions, /publishWorkspaceMedia\([\s\S]*?sendBotDocument\(/);
  assert.match(botDocuments, /media\.assets\.map\(serializeMediaAsset\)/);
  assert.doesNotMatch(botDocuments, /\n\s+documentUrl,\n\s+reason:/);
  const persistedRuntimeMetadata = botRuntime.slice(
    botRuntime.indexOf("const documentSendId = await insertBotDocumentSend"),
    botRuntime.indexOf("if (!input.decision.allowed"),
  );
  assert.doesNotMatch(persistedRuntimeMetadata, /\bdocumentUrl\s*:/);
  assert.doesNotMatch(crmLoaders, /ma\.url/);
});
