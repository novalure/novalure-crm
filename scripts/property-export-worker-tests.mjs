import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const nodeRequire = createRequire(import.meta.url);

async function loadTypeScriptModule(path, dependencyMocks) {
  const source = await read(path);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    Set,
    URL,
    exports: cjsModule.exports,
    module: cjsModule,
    process,
    require(specifier) {
      if (Object.hasOwn(dependencyMocks, specifier)) return dependencyMocks[specifier];
      if (specifier === "server-only") return {};
      if (specifier.startsWith("node:")) return nodeRequire(specifier);
      throw new Error(`Unexpected runtime import in ${path}: ${specifier}`);
    },
  }, { filename: path });
  return cjsModule.exports;
}

test("migration 080 is additive and introduces an explicitly guarded Preview rollback", async () => {
  const migration = await read("migrations/080_property_export_runtime.sql");
  const rollback = await read("migrations/080_property_export_runtime_rollback.sql");

  assert.match(migration, /alter table public\.property_export_jobs[\s\S]*add column if not exists payload_snapshot jsonb/i);
  assert.match(migration, /add column if not exists payload_sha256 text/i);
  assert.match(migration, /add column if not exists artifact_payload text/i);
  assert.match(migration, /create table if not exists public\.property_export_job_events/i);
  assert.match(migration, /property_export_jobs_runtime_shape_check[\s\S]*operation = 'qa_test_export'[\s\S]*provider_key = 'novalure_qa_sink'/i);
  for (const status of [
    "draft",
    "preflight_failed",
    "ready",
    "queued",
    "exporting",
    "published",
    "partially_published",
    "update_required",
    "failed",
    "paused",
    "withdrawn",
  ]) {
    assert.match(migration, new RegExp(`'${status}'`));
  }
  assert.match(migration, /property_export_jobs_workspace_channel_fk[\s\S]*not valid/i);
  assert.match(migration, /property_export_jobs_workspace_property_fk[\s\S]*not valid/i);
  assert.match(migration, /property_export_job_events_workspace_job_fk[\s\S]*not valid/i);
  assert.match(migration, /alter table public\.property_export_job_events enable row level security/i);
  assert.match(migration, /alter table public\.property_export_job_events force row level security/i);
  assert.match(migration, /current_setting\('app\.tenant_id', true\)/i);
  assert.match(migration, /current_setting\('app\.actor_id', true\)/i);
  assert.match(migration, /array\['novalure_app', 'novalure_tenant_app'\]/i);
  assert.match(migration, /grant select, insert on table public\.property_export_job_events to novalure_app/i);
  assert.match(migration, /grant select, insert on table public\.property_export_job_events to novalure_tenant_app/i);
  assert.doesNotMatch(migration, /grant[\s\S]{0,120}public\.(?:property_channels|property_export_jobs)/i);
  assert.match(migration, /alter table public\.property_channels enable row level security/i);
  assert.match(migration, /property_channels_runtime_tenant_policy[\s\S]*runtime_key is null[\s\S]*app\.tenant_id/i);
  assert.match(migration, /alter table public\.property_export_jobs enable row level security/i);
  assert.match(migration, /property_export_jobs_runtime_tenant_policy[\s\S]*operation is distinct from 'qa_test_export'[\s\S]*app\.tenant_id/i);
  assert.doesNotMatch(migration, /alter table public\.(?:property_channels|property_export_jobs) force row level security/i);
  assert.doesNotMatch(migration, /delete\s+from|truncate\s+table|drop\s+table\s+(?:if\s+exists\s+)?public\.(?:property_channels|property_export_jobs)/i);

  const guardPosition = rollback.indexOf("novalure.allow_qa_schema_rollback");
  const destructivePosition = rollback.indexOf("drop table if exists public.property_export_job_events");
  assert.ok(guardPosition >= 0 && destructivePosition > guardPosition);
  assert.match(rollback, /novalure\.environment'[\s\S]*is distinct from 'preview'/i);
  assert.match(rollback, /novalure\.allow_qa_schema_rollback'[\s\S]*is distinct from 'true'/i);
  assert.match(rollback, /relforcerowsecurity[\s\S]*later or pre-existing parent-table RLS cutover/i);
  assert.match(rollback, /property_channels contains expanded publication lifecycle states/i);
  assert.ok(guardPosition < rollback.indexOf("disable row level security"));
  assert.match(rollback, /delete from public\.novalure_schema_migrations where version = \$1[\s\S]*using '080_property_export_runtime'/i);
  assert.doesNotMatch(rollback, /\bcascade\b|truncate\s+table/i);
  assert.doesNotMatch(rollback, /drop\s+table\s+(?:if\s+exists\s+)?public\.(?:property_channels|property_export_jobs)/i);
});

test("schedule validation canonicalizes bounded future times and distinguishes immediate work", async () => {
  const lifecycle = await loadTypeScriptModule("src/lib/property-export/lifecycle.ts", {});
  const now = new Date("2026-09-02T10:00:00.000Z");

  const immediate = lifecycle.parsePropertyExportSchedule(null, now);
  assert.equal(immediate.ok, true);
  assert.equal(immediate.value.immediate, true);
  assert.equal(immediate.value.scheduledAt, null);
  assert.equal(immediate.value.availableAt, now.toISOString());

  const scheduled = lifecycle.parsePropertyExportSchedule("2026-09-02T12:30:00+02:00", now);
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.value.immediate, false);
  assert.equal(scheduled.value.scheduledAt, "2026-09-02T10:30:00.000Z");
  assert.equal(scheduled.value.availableAt, scheduled.value.scheduledAt);

  for (const invalid of [
    "2026-09-02T09:59:59Z",
    "2026-12-02T10:00:00Z",
    "2026-09-02T10:30",
    "2026-02-30T10:30:00Z",
    " 2026-09-02T10:30:00Z",
  ]) {
    assert.equal(lifecycle.parsePropertyExportSchedule(invalid, now).ok, false, invalid);
  }

  const oldReplay = lifecycle.parsePropertyExportSchedule(
    "2026-09-01T10:00:00Z",
    now,
    { enforceWindow: false },
  );
  assert.equal(oldReplay.ok, true, "an already-created scheduled job remains replayable by its original key");
});

test("channel lifecycle is closed over truthful local QA states", async () => {
  const lifecycle = await loadTypeScriptModule("src/lib/property-export/lifecycle.ts", {});
  const cases = [
    [{ action: "pause", channelStatus: "queued", jobStatus: "queued" }, "paused"],
    [{ action: "resume", channelStatus: "paused", jobStatus: "queued" }, "queued"],
    [{ action: "resume", channelStatus: "paused", jobStatus: "completed" }, "ready"],
    [{ action: "resume", channelStatus: "paused", jobStatus: "dead_letter" }, "failed"],
    [{ action: "withdraw", channelStatus: "ready", jobStatus: "completed" }, "withdrawn"],
    [{ action: "mark_update_required", channelStatus: "ready", jobStatus: "completed" }, "update_required"],
  ];
  for (const [input, expected] of cases) {
    const result = lifecycle.resolvePropertyExportChannelTransition(input);
    assert.equal(result.ok, true, JSON.stringify(input));
    assert.equal(result.value, expected);
    assert.notEqual(result.value, "published");
    assert.notEqual(result.value, "partially_published");
  }
  for (const input of [
    { action: "pause", channelStatus: "exporting", jobStatus: "running" },
    { action: "resume", channelStatus: "withdrawn", jobStatus: "cancelled" },
    { action: "withdraw", channelStatus: "exporting", jobStatus: "running" },
    { action: "mark_update_required", channelStatus: "ready", jobStatus: "queued" },
  ]) {
    assert.equal(lifecycle.resolvePropertyExportChannelTransition(input).ok, false, JSON.stringify(input));
  }
});

test("enqueue builds the snapshot and preflight from tenant-qualified server reads", async () => {
  const repository = await read("src/lib/db/property-export-repositories.ts");
  const canonical = await read("src/lib/property-export/canonical-payload.ts");
  const enqueue = repository.slice(repository.indexOf("export async function enqueuePropertyExport"));

  for (const table of [
    "seller_listings",
    "property_units",
    "property_reservations",
    "property_buildings",
    "property_text_blocks",
    "property_cost_items",
    "property_media",
    "property_documents",
  ]) {
    const tablePosition = repository.indexOf(`from ${table}`);
    assert.ok(tablePosition >= 0, `${table} is server-loaded`);
    assert.match(repository.slice(tablePosition, tablePosition + 750), /workspace_id\s*=\s*\$1::uuid/i);
  }
  assert.ok(enqueue.indexOf("loadPropertyExportSource") < enqueue.indexOf("insert into property_export_jobs"));
  assert.ok(enqueue.indexOf("runServerPropertyExportPreflight") < enqueue.indexOf("insert into property_export_jobs"));
  assert.match(enqueue, /if \(preflight\.status === "blocked"\)[\s\S]*preflight_blocked/);
  assert.match(enqueue, /buildPropertyExportSnapshot\(source\)/);
  assert.match(enqueue, /hashPropertyExportSnapshot\(snapshot\)/);
  assert.match(enqueue, /on conflict \(workspace_id, idempotency_key\) do nothing/i);
  assert.match(enqueue, /Idempotency-Key is already bound to a different property export snapshot/);
  assert.match(enqueue, /\$15::timestamptz/);
  assert.match(enqueue, /requestedScheduledAt/);
  assert.match(enqueue, /status = 'queued'/);
  assert.match(enqueue, /status in \('queued', 'retry', 'running'\)[\s\S]*for update/i);
  assert.match(canonical, /exportableTextStatuses = new Set\(\["approved", "published"\]\)/);
  assert.match(canonical, /exportableVisibilities = new Set\(\["channel", "public"\]\)/);
  assert.match(canonical, /normalizeKey\(source\.listing\.gdprStatus\) === "ready"/);
  assert.match(canonical, /source\.listing\.ownerContactId/);
  assert.match(canonical, /requiredDocuments\.every\(\(document\) => exportableDocumentIds\.has\(document\.id\)\)/);
  assert.match(canonical, /visibility !== "publish_price" \|\| Boolean\(publicPrice && publicPrice > 0\)/);
  assert.match(repository, /left join contacts export_contact[\s\S]*export_contact\.workspace_id = sl\.workspace_id/i);
  assert.equal((repository.match(/ma\.id as "mediaAssetId"/g) ?? []).length, 2);
  assert.match(repository, /project_pipeline_permissions export_permission[\s\S]*can_edit_deals = true/i);
  assert.ok(repository.indexOf("requirePropertyExportAccess(input.session)") < repository.indexOf("requirePersistence();", repository.indexOf("export async function listPropertyExportJobs")));
  assert.doesNotMatch(canonical, /internalNotes|sellerData|canonicalPayload/);
});

test("worker lifecycle claims atomically, fences acknowledgements, retries and dead-letters", async () => {
  const repository = await read("src/lib/db/property-export-repositories.ts");
  const runner = await read("src/lib/property-export/runner.ts");
  const claim = repository.slice(
    repository.indexOf("export async function claimPropertyExportJob"),
    repository.indexOf("export async function completePropertyExportJob"),
  );

  assert.match(repository, /for update of j, c skip locked/i);
  assert.match(repository, /lease_expires_at = now\(\) \+ interval '45 seconds'/i);
  assert.match(repository, /attempt_count = j\.attempt_count \+ 1/i);
  assert.match(repository, /status = 'running'[\s\S]*locked_by = \$3[\s\S]*operation = 'qa_test_export'/i);
  assert.match(repository, /when attempt_count >= max_attempts then 'dead_letter'/i);
  assert.match(repository, /now\(\) \+ make_interval\(secs => \$6::int\)/i);
  assert.match(repository, /property_export_job_events[\s\S]*worker_claimed/i);
  assert.match(repository, /property_export_job_events[\s\S]*qa_artifact_created/i);
  assert.match(repository, /property_export_job_events[\s\S]*worker_failed/i);
  assert.match(repository, /status = case when \$4 in \('failed', 'dead_letter'\) then 'failed' else 'queued' end/i);
  assert.doesNotMatch(repository, /then 'error' else 'ready'/i);
  assert.match(repository, /j\.status in \('queued', 'retry'\) and c\.status = 'queued' and j\.available_at <= now\(\)/i);
  assert.match(repository, /j\.status = 'running' and c\.status = 'exporting' and j\.lease_expires_at <= now\(\)/i);
  assert.match(repository, /Only failed or dead-lettered QA exports can be retried/);
  assert.match(repository, /join workspace_users wu[\s\S]*wu\.workspace_id = j\.workspace_id[\s\S]*wu\.id = j\.started_by_user_id/i);
  assert.match(repository, /withTenantTransaction\(\{[\s\S]*actorId: input\.job\.startedByUserId,[\s\S]*workspaceId: input\.job\.workspaceId/i);
  assert.match(runner, /createLeaseOwner\("property-export"\)/);
  assert.match(runner, /actorId: ref\.actorId[\s\S]*workspaceId: ref\.workspaceId/);
  assert.match(runner, /sanitizeJobError\(error\)/);
  assert.match(runner, /retryDelaySeconds\(job\.attemptCount\)/);
  assert.ok(
    claim.indexOf('evaluateLaunchScope("propertyExportQueue")') < claim.indexOf("requirePersistence()"),
    "claim must honor the central launch scope before touching persistence",
  );
  assert.match(claim, /select role, product_role as "productRole"[\s\S]*status = 'active'[\s\S]*for share/i);
  assert.match(claim, /isAppRole\(membership\.role\)/);
  assert.match(claim, /isProductRole\(membership\.productRole\)/);
  assert.match(claim, /canProcessPropertyExports\(\{/);
  assert.match(claim, /join workspace_users wu[\s\S]*wu\.status = 'active'/i);
  assert.match(runner, /evaluateLaunchScope\("propertyExportQueue"\)/);
  assert.ok(
    runner.indexOf('evaluateLaunchScope("propertyExportQueue")') < runner.indexOf("listDuePropertyExportJobIds({"),
    "runner must honor the central launch scope before listing stored jobs",
  );
});

test("manual channel transitions are tenant-qualified, OCC-fenced, audited and QA-only", async () => {
  const repository = await read("src/lib/db/property-export-repositories.ts");
  const transition = repository.slice(
    repository.indexOf("export async function transitionPropertyExportChannel"),
    repository.indexOf("export async function getPropertyExportArtifact"),
  );

  assert.match(transition, /requirePropertyExportAccess\(input\.session\)/);
  assert.match(transition, /workspace_id = \$1::uuid[\s\S]*propertyRecordAccessPredicate/);
  assert.match(transition, /for update of j, c/i);
  assert.match(transition, /expectedChannelStatus/);
  assert.match(transition, /expectedChannelUpdatedAt/);
  assert.match(transition, /to_char\(updated_at at time zone 'UTC'/i);
  assert.match(transition, /code: "stale_write"/);
  assert.match(transition, /request_key = \$3/);
  assert.match(transition, /property_export_job_events/);
  assert.match(transition, /export_history = export_history \|\| jsonb_build_array/i);
  assert.match(transition, /manual_channel_action/);
  assert.match(transition, /when \$3 = 'withdraw' and status in \('queued', 'retry'\) then 'cancelled'/i);
  assert.match(transition, /externalWithdrawalPerformed', false/i);
  assert.match(transition, /networkRequestPerformed', false/i);
  assert.match(transition, /productionPublication', false/i);
  assert.match(transition, /External portal channels are not configured and remain launch-off/);
  assert.doesNotMatch(transition, /status\s*=\s*'published'/i);
});

test("withdrawing a queued export terminates the job and releases the next enqueue", async () => {
  const repository = await read("src/lib/db/property-export-repositories.ts");
  const enqueue = repository.slice(
    repository.indexOf("export async function enqueuePropertyExport"),
    repository.indexOf("export async function retryPropertyExport"),
  );
  const transition = repository.slice(
    repository.indexOf("export async function transitionPropertyExportChannel"),
    repository.indexOf("export async function getPropertyExportArtifact"),
  );
  const activeJobGuard = enqueue.slice(
    enqueue.indexOf("const activeJob"),
    enqueue.indexOf("const inserted"),
  );

  assert.match(activeJobGuard, /status in \('queued', 'retry', 'running'\)/i);
  assert.doesNotMatch(activeJobGuard, /status in \([^)]*'cancelled'/i);
  assert.match(transition, /when \$3 = 'withdraw' and status in \('queued', 'retry'\) then 'cancelled'/i);
  assert.match(transition, /finished_at = case[\s\S]*then clock_timestamp\(\)/i);
  assert.match(transition, /locked_by = case[\s\S]*then null/i);
  assert.match(transition, /lease_expires_at = case[\s\S]*then null/i);
  assert.match(transition, /'jobStatusAfter', \$11::text/i);
});

test("central launch-off stops worker and direct claim before database or provider effects", async () => {
  const calls = { claim: 0, database: 0, delivery: 0, list: 0, transaction: 0 };
  class ConfigurationError extends Error {}
  const runner = await loadTypeScriptModule("src/lib/property-export/runner.ts", {
    "@/lib/db/property-export-repositories": {
      claimPropertyExportJob: async () => { calls.claim += 1; return null; },
      completePropertyExportJob: async () => true,
      failPropertyExportJob: async () => null,
      listDuePropertyExportJobIds: async () => { calls.list += 1; return []; },
    },
    "@/lib/jobs/durable-queue": {
      classifyDeliveryError: () => "unknown",
      createLeaseOwner: () => "lease",
      retryDelaySeconds: () => 1,
      sanitizeJobError: () => "redacted",
    },
    "@/lib/launch-scope": {
      evaluateLaunchScope: () => ({ allowed: false, code: "LAUNCH_SCOPE_OFF" }),
    },
    "@/lib/property-export/provider-adapters": {
      deliverPropertyExportToQaSink: async () => { calls.delivery += 1; throw new Error("must not deliver"); },
      isPropertyExportQaSinkEnabled: () => true,
      PropertyExportProviderConfigurationError: ConfigurationError,
    },
  });

  const workerResult = await runner.processDuePropertyExports({ limit: 10 });
  assert.deepEqual(JSON.parse(JSON.stringify(workerResult)), {
    checked: 0,
    completed: 0,
    deadLettered: 0,
    failed: 0,
    fenced: 0,
    retried: 0,
  });
  assert.deepEqual(calls, { claim: 0, database: 0, delivery: 0, list: 0, transaction: 0 });

  const repository = await loadTypeScriptModule("src/lib/db/property-export-repositories.ts", {
    "@/lib/auth/permissions": { isAppRole: () => true },
    "@/lib/db/client": {
      hasDatabaseUrl: () => { calls.database += 1; return true; },
      queryRows: async () => [],
    },
    "@/lib/db/runtime-repositories": { isUuid: () => true },
    "@/lib/db/tenant-client": {
      withTenantTransaction: async () => { calls.transaction += 1; throw new Error("must not transact"); },
    },
    "@/lib/launch-scope": {
      evaluateLaunchScope: () => ({ allowed: false, code: "LAUNCH_SCOPE_OFF" }),
    },
    "@/lib/product-model": { isProductRole: () => true },
    "@/lib/property-export/access": {
      canAccessPropertyExports: () => true,
      canProcessPropertyExports: () => true,
      hasProjectPropertyRecordScope: () => true,
      hasWorkspacePropertyRecordScope: () => true,
    },
    "@/lib/property-export/canonical-payload": {
      buildPropertyExportSnapshot: () => ({}),
      hashPropertyExportSnapshot: () => "hash",
      runServerPropertyExportPreflight: () => ({ status: "pass" }),
    },
    "@/lib/property-export/lifecycle": { isPropertyPublicationStatus: () => true },
    "@/lib/property-export/types": {
      PROPERTY_EXPORT_FORMAT: "openimmo_preview_v1",
      PROPERTY_EXPORT_OPERATION: "qa_test_export",
      PROPERTY_EXPORT_QA_PROVIDER: "novalure_qa_sink",
    },
  });
  const claimed = await repository.claimPropertyExportJob({
    actorId: "22222222-2222-4222-8222-222222222222",
    jobId: "33333333-3333-4333-8333-333333333333",
    leaseOwner: "worker-lease",
    workspaceId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(claimed, null);
  assert.equal(calls.database, 0);
  assert.equal(calls.transaction, 0);
});

test("claim revalidates an active current actor role before leasing stored work", async () => {
  let membership = null;
  const state = { accessChecks: 0, claimQueries: 0, membershipQueries: [] };
  const claimedRow = {
    attemptCount: 1,
    id: "33333333-3333-4333-8333-333333333333",
    leaseOwner: "worker-lease",
    maxAttempts: 3,
    payloadSha256: "a".repeat(64),
    payloadSnapshot: {},
    projectId: null,
    propertyChannelId: "44444444-4444-4444-8444-444444444444",
    propertyId: "55555555-5555-4555-8555-555555555555",
    providerKey: "novalure_qa_sink",
    startedByUserId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "11111111-1111-4111-8111-111111111111",
  };
  const transaction = {
    async queryOne(query, params) {
      const sql = query.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql.startsWith('select role, product_role as "productrole"')) {
        state.membershipQueries.push({ params, sql });
        return membership;
      }
      state.claimQueries += 1;
      return claimedRow;
    },
  };
  const repository = await loadTypeScriptModule("src/lib/db/property-export-repositories.ts", {
    "@/lib/auth/permissions": {
      isAppRole: (value) => ["owner", "admin", "agent", "assistant"].includes(value),
    },
    "@/lib/db/client": { hasDatabaseUrl: () => true, queryRows: async () => [] },
    "@/lib/db/runtime-repositories": {
      isUuid: (value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value),
    },
    "@/lib/db/tenant-client": {
      withTenantTransaction: async (_scope, callback) => callback(transaction),
    },
    "@/lib/launch-scope": { evaluateLaunchScope: () => ({ allowed: true }) },
    "@/lib/product-model": { isProductRole: (value) => typeof value === "string" },
    "@/lib/property-export/access": {
      canAccessPropertyExports: () => true,
      canProcessPropertyExports: (actor) => {
        state.accessChecks += 1;
        return actor.role !== "assistant" && actor.productRole === "workspace_admin";
      },
      hasProjectPropertyRecordScope: () => true,
      hasWorkspacePropertyRecordScope: () => true,
    },
    "@/lib/property-export/canonical-payload": {
      buildPropertyExportSnapshot: () => ({}),
      hashPropertyExportSnapshot: () => "hash",
      runServerPropertyExportPreflight: () => ({ status: "pass" }),
    },
    "@/lib/property-export/lifecycle": { isPropertyPublicationStatus: () => true },
    "@/lib/property-export/types": {
      PROPERTY_EXPORT_FORMAT: "openimmo_preview_v1",
      PROPERTY_EXPORT_OPERATION: "qa_test_export",
      PROPERTY_EXPORT_QA_PROVIDER: "novalure_qa_sink",
    },
  });
  const claim = () => repository.claimPropertyExportJob({
    actorId: "22222222-2222-4222-8222-222222222222",
    jobId: "33333333-3333-4333-8333-333333333333",
    leaseOwner: "worker-lease",
    workspaceId: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(await claim(), null, "missing or inactive membership must not claim");
  membership = { productRole: "workspace_admin", role: "assistant" };
  assert.equal(await claim(), null, "a role without current CRM write permission must not claim");
  assert.equal(state.claimQueries, 0);

  membership = { productRole: "workspace_admin", role: "agent" };
  const allowed = await claim();
  assert.equal(allowed.id, claimedRow.id);
  assert.equal(state.claimQueries, 1);
  assert.equal(state.accessChecks, 2);
  assert.ok(state.membershipQueries.every(({ sql }) => sql.includes("status = 'active'") && sql.endsWith("for share")));
});

test("the only delivery adapter is an in-process QA sink and production remains fail-closed", async () => {
  const provider = await read("src/lib/property-export/provider-adapters.ts");
  const types = await read("src/lib/property-export/types.ts");

  assert.match(types, /PROPERTY_EXPORT_QA_PROVIDER = "novalure_qa_sink"/);
  assert.match(provider, /vercelEnvironment === "preview"/);
  assert.match(provider, /NOVALURE_PROPERTY_EXPORT_QA_SINK_ENABLED === "1"/);
  assert.match(provider, /job\.providerKey !== PROPERTY_EXPORT_QA_PROVIDER/);
  assert.match(provider, /External property portal delivery is launch-off and not configured/);
  assert.match(provider, /networkRequestPerformed: false/);
  assert.match(provider, /<novalure-openimmo-preview[\s\S]*certification="none"/);
  assert.doesNotMatch(provider, /<openimmo(?:\s|>)/i);
  assert.doesNotMatch(provider, /\bfetch\s*\(/);
});

test("property export APIs reuse auth and CSRF guards and never accept arbitrary portal delivery", async () => {
  const route = await read("src/app/api/crm/property-exports/route.ts");
  const retry = await read("src/app/api/crm/property-exports/[jobId]/retry/route.ts");
  const payload = await read("src/app/api/crm/property-exports/[jobId]/payload/route.ts");
  const cron = await read("src/app/api/cron/property-exports/route.ts");
  const access = await read("src/lib/property-export/access.ts");
  const runner = await read("src/lib/property-export/runner.ts");

  assert.match(route, /resolveWorkspaceScopedSession\(request, \{ permission: "crm:read" \}\)/);
  assert.match(route, /capability: "workspace:operate"[\s\S]*permission: "crm:write"/);
  assert.match(route, /idempotency-key/i);
  assert.ok(route.indexOf("providerKey !== PROPERTY_EXPORT_QA_PROVIDER") < route.indexOf("enqueuePropertyExport({"));
  assert.match(route, /external_portal_launch_off/);
  assert.match(route, /configurationState: "not_configured"/);
  assert.match(route, /launchState: "launch_off"/);
  assert.match(retry, /resolveWorkspaceScopedSession[\s\S]*idempotency-key/i);
  assert.match(payload, /resolveWorkspaceScopedSession\(request, \{ permission: "crm:read" \}\)/);
  assert.match(payload, /Content-Disposition/);
  assert.match(payload, /X-Novalure-Artifact-Sha256/);
  assert.match(route, /canAccessPropertyExports\(auth\.session\)/);
  assert.match(retry, /canAccessPropertyExports\(auth\.session\)/);
  assert.match(payload, /canAccessPropertyExports\(auth\.session\)/);
  assert.match(access, /getPropertyActionStates\([\s\S]*\.exportChannel\.enabled/);
  assert.match(access, /can\(session\.role, "crm:write"\)[\s\S]*hasProductCapability\(session\.productRole, "workspace:operate"\)/);
  assert.match(cron, /isCronAuthorized\(request\)/);
  assert.match(cron, /areQueueWorkersPaused\(\)/);
  assert.match(cron, /isPropertyExportQaSinkEnabled\(\)/);
  const post = route.slice(route.indexOf("export async function POST"));
  const patch = route.slice(route.indexOf("export async function PATCH"));
  const retryPost = retry.slice(retry.indexOf("export async function POST"));
  const cronGet = cron.slice(cron.indexOf("export async function GET"));
  assert.match(route, /function propertyExportQueueLaunchOff\(\)[\s\S]*evaluateLaunchScope\("propertyExportQueue"\)/);
  assert.ok(post.indexOf("propertyExportQueueLaunchOff()") < post.indexOf("request.json()"));
  assert.ok(post.indexOf("propertyExportQueueLaunchOff()") < post.indexOf("enqueuePropertyExport({"));
  assert.ok(patch.indexOf("propertyExportQueueLaunchOff()") < patch.indexOf("request.json()"));
  assert.match(patch, /transitionPropertyExportChannel\(\{/);
  assert.match(patch, /expectedChannelStatus: body\.expectedChannelStatus/);
  assert.match(patch, /expectedChannelUpdatedAt: body\.expectedChannelUpdatedAt/);
  assert.match(patch, /externalWithdrawalPerformed: false/);
  assert.ok(retryPost.indexOf('evaluateLaunchScope("propertyExportQueue")') < retryPost.indexOf("retryPropertyExportJob({"));
  assert.ok(cronGet.indexOf('evaluateLaunchScope("propertyExportQueue")') < cronGet.indexOf("processDuePropertyExports({"));
  assert.ok(runner.indexOf('evaluateLaunchScope("propertyExportQueue")') < runner.indexOf("listDuePropertyExportJobIds({"));
  for (const source of [route, retry, cron]) {
    assert.match(source, /property_export_queue_launch_off/);
    assert.match(source, /Cache-Control["']?: "private, no-store"/);
  }
});

test("POST persists scheduledAt without early processing and kick-starts only immediate jobs", async () => {
  const workerCalls = [];
  const enqueueInputs = [];
  let lastJob = null;
  class RuntimeError extends Error {}
  const route = await loadTypeScriptModule("src/app/api/crm/property-exports/route.ts", {
    "next/server": {
      NextResponse: {
        json: (body, init = {}) => ({ body, headers: init.headers, status: init.status ?? 200 }),
      },
    },
    "@/lib/auth/session": {
      resolveWorkspaceScopedSession: async () => ({
        ok: true,
        session: {
          productRole: "workspace_admin",
          role: "owner",
          userId: "22222222-2222-4222-8222-222222222222",
          workspaceId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    },
    "@/lib/db/property-export-repositories": {
      enqueuePropertyExport: async (input) => {
        enqueueInputs.push(input);
        lastJob = {
          availableAt: input.scheduledAt ?? "2026-09-02T10:00:00.000Z",
          id: "33333333-3333-4333-8333-333333333333",
          scheduledAt: input.scheduledAt ?? null,
          status: "queued",
        };
        return { created: true, job: lastJob, preflight: { status: "pass" } };
      },
      getPropertyExportJob: async () => lastJob,
      isPropertyExportIdempotencyKey: () => true,
      listPropertyExportJobs: async () => [],
      PropertyExportRuntimeError: RuntimeError,
      transitionPropertyExportChannel: async () => { throw new Error("not used"); },
    },
    "@/lib/property-export/provider-adapters": {
      getPropertyExportAvailability: () => ({ externalPortals: [], qaSink: { state: "ready" } }),
      isPropertyExportQaSinkEnabled: () => true,
    },
    "@/lib/property-export/access": { canAccessPropertyExports: () => true },
    "@/lib/launch-scope": { evaluateLaunchScope: () => ({ allowed: true }) },
    "@/lib/property-export/runner": {
      processDuePropertyExports: async (input) => {
        workerCalls.push(input);
        return { checked: 1, completed: 1 };
      },
    },
    "@/lib/property-export/types": { PROPERTY_EXPORT_QA_PROVIDER: "novalure_qa_sink" },
  });
  const request = (scheduledAt) => ({
    headers: { get: () => "property-export-test-key-123" },
    json: async () => ({
      propertyId: "55555555-5555-4555-8555-555555555555",
      providerKey: "novalure_qa_sink",
      scheduledAt,
    }),
  });

  const scheduledAt = "2026-09-03T10:00:00.000Z";
  const scheduledResponse = await route.POST(request(scheduledAt));
  assert.equal(scheduledResponse.status, 201);
  assert.equal(scheduledResponse.body.kickStarted, false);
  assert.equal(scheduledResponse.body.worker, null);
  assert.equal(workerCalls.length, 0);
  assert.equal(enqueueInputs[0].scheduledAt, scheduledAt);

  const immediateResponse = await route.POST(request(null));
  assert.equal(immediateResponse.status, 201);
  assert.equal(immediateResponse.body.kickStarted, true);
  assert.equal(workerCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(workerCalls[0].jobIds)), [lastJob.id]);
});

test("standalone panel exposes status, history, retry and protected artifact download", async () => {
  const panel = await read("src/components/property-export-panel.tsx");
  const commandCenter = await read("src/components/property-command-center.tsx");

  assert.match(panel, /export type PropertyExportPanelProps/);
  for (const prop of ["canExport", "language", "propertyId", "propertyTitle", "workspaceId"]) {
    assert.match(panel, new RegExp(`${prop}\\??:`));
  }
  assert.match(panel, /export function PropertyExportPanel/);
  assert.match(panel, /fetchExportList\(listUrl/);
  assert.match(panel, /csrfFetch\(url, \{ cache: "no-store", signal \}\)/);
  assert.match(panel, /Idempotency-Key/);
  assert.match(panel, /property-export-retry-ui/);
  assert.match(panel, /pendingCreateRequest = useRef/);
  assert.match(panel, /pendingRetryRequests = useRef/);
  assert.match(panel, /pendingTransitionRequests = useRef/);
  assert.match(panel, /type="datetime-local"/);
  assert.match(panel, /scheduledAt: schedule\.scheduledAt/);
  assert.match(panel, /expectedChannelStatus: job\.channelStatus/);
  assert.match(panel, /expectedChannelUpdatedAt: job\.channelUpdatedAt/);
  for (const action of ["pause", "resume", "withdraw", "mark_update_required"]) {
    assert.match(panel, new RegExp(`"${action}"`));
  }
  assert.match(panel, /response\.status < 500/);
  assert.match(panel, /\/payload\$\{payloadQuery\}/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(panel, /<summary className="flex min-h-11 cursor-pointer items-center font-semibold">/);
  assert.match(panel, /Testexport abgeschlossen/);
  assert.match(panel, /kein Portalversand/);
  assert.match(commandCenter, /<PropertyExportPanel[\s\S]*canExport=\{actions\.exportChannel\.enabled\}/);
});
