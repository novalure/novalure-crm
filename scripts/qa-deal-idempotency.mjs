import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createJiti } from "jiti";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const marker = "GOLIVETEST_DEALIDEM_";

const workspaceId = "7f630000-0000-4000-8000-000000000001";
const userId = "7f630000-0000-4000-8000-000000000002";
const projectId = "7f630000-0000-4000-8000-000000000101";
const pipelineId = "7f630000-0000-4000-8000-000000000201";
const sameKeyContactId = "7f630000-0000-4000-8000-000000000301";
const noKeyContactId = "7f630000-0000-4000-8000-000000000302";

let idCounter = 1000;

function id() {
  idCounter += 1;
  return `7f630000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[line.slice(0, index).trim()] = value;
  }
  return env;
}

function cleanDatabaseUrl(value) {
  const trimmed = (value || "").trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);
  return prefixedUrl?.[1] ?? trimmed;
}

function maskDatabaseUrl(value) {
  return value.replace(/:\/\/[^:@/]+:([^@/]+)@/, "://***:***@");
}

function assertTestDatabase(env, databaseUrl) {
  const parsed = new URL(databaseUrl);
  const projectIdValue = env.POSTGRES_NEON_PROJECT_ID || env.NEON_PROJECT_ID || "";
  console.log(`Active DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);
  console.log(`Active DB host: ${parsed.hostname}`);
  console.log(`Project ID suffix verified: ${projectIdValue ? "***" + projectIdValue.slice(-8) : "missing"}`);
  if (parsed.hostname !== testDbHost) {
    throw new Error(`Refusing deal idempotency QA: active DB host is not test (${testDbHost})`);
  }
  if (!projectIdValue.includes(testDbSuffix)) {
    throw new Error(`Refusing deal idempotency QA: project id does not contain ${testDbSuffix}`);
  }
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function cleanup(pool) {
  await pool.query("delete from analytics_events where workspace_id = $1::uuid or metadata::text like $2", [
    workspaceId,
    `%${marker}%`,
  ]);
  await pool.query("delete from audit_logs where workspace_id = $1::uuid or before::text like $2 or after::text like $2", [
    workspaceId,
    `%${marker}%`,
  ]);
  await pool.query("delete from deal_stage_history where workspace_id = $1::uuid", [workspaceId]);
  await pool.query("delete from deals where workspace_id = $1::uuid or name like $2 or idempotency_key like $2", [
    workspaceId,
    `${marker}%`,
  ]);
  await pool.query("delete from contacts where workspace_id = $1::uuid or name like $2 or email like $2", [
    workspaceId,
    `${marker}%`,
  ]);
  await pool.query("delete from crm_pipeline_stages where workspace_id = $1::uuid", [workspaceId]);
  await pool.query("delete from crm_pipelines where workspace_id = $1::uuid", [workspaceId]);
  await pool.query("delete from workspace_module_settings where workspace_id = $1::uuid", [workspaceId]);
  await pool.query("delete from projects where workspace_id = $1::uuid or name like $2", [workspaceId, `${marker}%`]);
  await pool.query("delete from workspace_users where workspace_id = $1::uuid or email like $2", [
    workspaceId,
    `${marker.toLowerCase()}%`,
  ]);
  await pool.query("delete from workspaces where id = $1::uuid or name like $2", [workspaceId, `${marker}%`]);
}

async function seed(pool) {
  await cleanup(pool);

  await pool.query(
    `
      insert into workspaces (
        id,
        name,
        plan,
        operating_model,
        customer_type,
        team_structure,
        setup_state,
        slug
      )
      values (
        $1::uuid,
        $2,
        'Growth Workspace',
        'self_service_customer',
        'property_developer',
        'project_sales_available',
        '{"enabledModules":{"pipeline":true},"source":"GOLIVETEST_DEALIDEM"}'::jsonb,
        'golivetest-dealidem'
      )
    `,
    [workspaceId, `${marker}Workspace`],
  );

  await pool.query(
    `
      insert into workspace_users (id, workspace_id, name, email, role, status, product_role)
      values ($1::uuid, $2::uuid, 'GOLIVETEST Deal Idempotency Owner', 'golivetest.dealidem@example.test', 'owner', 'active', 'customer_owner')
    `,
    [userId, workspaceId],
  );

  await pool.query(
    `
      insert into projects (id, workspace_id, name, type, status, customer_type, default_operating_model, setup_defaults)
      values ($1::uuid, $2::uuid, $3, 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"GOLIVETEST_DEALIDEM"}'::jsonb)
    `,
    [projectId, workspaceId, `${marker}Project`],
  );

  await pool.query(
    `
      insert into crm_pipelines (
        id,
        workspace_id,
        project_id,
        customer_type,
        operating_model,
        key,
        name,
        purpose,
        is_default,
        metadata
      )
      values ($1::uuid, $2::uuid, $3::uuid, 'property_developer', 'self_service_customer', 'dealidem_pipeline', $4, 'sales', true, '{"source":"GOLIVETEST_DEALIDEM"}'::jsonb)
    `,
    [pipelineId, workspaceId, projectId, `${marker}Pipeline`],
  );

  for (const [index, stage] of [
    { category: "work", key: "new", name: "Neu", probability: 5 },
    { category: "won", key: "won", name: "Gewonnen", probability: 100 },
  ].entries()) {
    await pool.query(
      `
        insert into crm_pipeline_stages (
          id,
          pipeline_id,
          workspace_id,
          project_id,
          key,
          name,
          position,
          probability,
          category,
          metadata
        )
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, '{"source":"GOLIVETEST_DEALIDEM"}'::jsonb)
      `,
      [id(), pipelineId, workspaceId, projectId, stage.key, stage.name, index + 1, stage.probability, stage.category],
    );
  }

  await pool.query(
    `
      insert into contacts (id, workspace_id, project_id, name, role, source, intent, consent_label, email, metadata)
      values
        ($1::uuid, $3::uuid, $4::uuid, $5, 'Kaeufer', 'GOLIVETEST_DEALIDEM', 'Deal idempotency QA', 'DSGVO ok', $6, '{"source":"GOLIVETEST_DEALIDEM"}'::jsonb),
        ($2::uuid, $3::uuid, $4::uuid, $7, 'Kaeufer', 'GOLIVETEST_DEALIDEM', 'Deal idempotency QA', 'DSGVO ok', $8, '{"source":"GOLIVETEST_DEALIDEM"}'::jsonb)
    `,
    [
      sameKeyContactId,
      noKeyContactId,
      workspaceId,
      projectId,
      `${marker}Same Key Contact`,
      "golivetest.dealidem.same@example.test",
      `${marker}No Key Contact`,
      "golivetest.dealidem.nokey@example.test",
    ],
  );
}

function requestHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    "x-novalure-product-role": "customer_owner",
    "x-novalure-role": "owner",
    "x-novalure-user-email": "golivetest.dealidem@example.test",
    "x-novalure-user-id": userId,
    "x-novalure-user-name": "GOLIVETEST Deal Idempotency Owner",
    "x-novalure-workspace-id": workspaceId,
    ...extra,
  };
}

async function postDeal(POST, body, extraHeaders = {}) {
  const response = await POST(
    new Request("https://qa.local/api/crm/deals", {
      body: JSON.stringify(body),
      headers: requestHeaders(extraHeaders),
      method: "POST",
    }),
  );
  const payload = await response.json();
  return { payload, status: response.status };
}

function buildDealBody(label, contactId) {
  return {
    deal: {
      contactId,
      name: `${marker}${label}`,
      nextAction: "QA next action",
      probability: 100,
      projectId,
      source: "Manual",
      stage: "Gewonnen",
      value: "650000",
    },
    reasonCategory: "won",
    reasonDetail: "GOLIVETEST_DEALIDEM won smoke",
  };
}

async function count(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function countPrefixHits(pool) {
  const columns = await pool.query(
    `
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('text', 'character varying', 'character', 'json', 'jsonb')
      order by table_name, ordinal_position
    `,
  );
  const hits = [];
  for (const row of columns.rows) {
    const table = quoteIdent(row.table_name);
    const column = quoteIdent(row.column_name);
    const result = await pool.query(`select count(*)::int as count from ${table} where ${column}::text like $1`, [
      `%${marker}%`,
    ]);
    const rowCount = Number(result.rows[0]?.count ?? 0);
    if (rowCount > 0) hits.push({ column: row.column_name, count: rowCount, table: row.table_name });
  }
  return hits;
}

async function sideEffectCounts(pool, dealId) {
  const [
    dealStageHistory,
    auditCreated,
    analyticsCreated,
    analyticsOutcome,
  ] = await Promise.all([
    count(pool, "select count(*) from deal_stage_history where workspace_id = $1::uuid and deal_id = $2::uuid", [
      workspaceId,
      dealId,
    ]),
    count(pool, "select count(*) from audit_logs where workspace_id = $1::uuid and entity_id = $2::uuid and action = 'deal.created'", [
      workspaceId,
      dealId,
    ]),
    count(pool, "select count(*) from analytics_events where workspace_id = $1::uuid and deal_id = $2::uuid and event_type = 'deal_created'", [
      workspaceId,
      dealId,
    ]),
    count(pool, "select count(*) from analytics_events where workspace_id = $1::uuid and deal_id = $2::uuid and event_type = 'deal_won'", [
      workspaceId,
      dealId,
    ]),
  ]);
  return { analyticsCreated, analyticsOutcome, auditCreated, dealStageHistory };
}

async function main() {
  const env = loadEnvFile(".env.local");
  const databaseUrl =
    cleanDatabaseUrl(env.DATABASE_URL) ||
    cleanDatabaseUrl(env.POSTGRES_URL) ||
    cleanDatabaseUrl(env.POSTGRES_DATABASE_URL) ||
    cleanDatabaseUrl(env.POSTGRES_PRISMA_URL);
  assertTestDatabase(env, databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.POSTGRES_DATABASE_URL = databaseUrl;
  process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";
  if (env.POSTGRES_NEON_PROJECT_ID) process.env.POSTGRES_NEON_PROJECT_ID = env.POSTGRES_NEON_PROJECT_ID;
  if (env.NEON_PROJECT_ID) process.env.NEON_PROJECT_ID = env.NEON_PROJECT_ID;

  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { POST } = jiti("../src/app/api/crm/deals/route.ts");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await seed(pool);

    const idempotencyKey = `${marker}${Date.now()}`;
    const sameKeyBody = buildDealBody("Same Key Deal", sameKeyContactId);
    const sameKeyResults = await Promise.all([
      postDeal(POST, sameKeyBody, { "Idempotency-Key": idempotencyKey }),
      postDeal(POST, sameKeyBody, { "Idempotency-Key": idempotencyKey }),
    ]);
    assert.deepEqual(sameKeyResults.map((result) => result.status), [200, 200]);
    const sameKeyDealIds = sameKeyResults.map((result) => result.payload?.deal?.id);
    assert.ok(sameKeyDealIds[0], "same-key deal id missing");
    assert.equal(sameKeyDealIds[0], sameKeyDealIds[1]);

    const sameKeyDbCount = await count(
      pool,
      "select count(*) from deals where workspace_id = $1::uuid and idempotency_key = $2",
      [workspaceId, idempotencyKey],
    );
    assert.equal(sameKeyDbCount, 1);

    const effects = await sideEffectCounts(pool, sameKeyDealIds[0]);
    assert.deepEqual(effects, {
      analyticsCreated: 1,
      analyticsOutcome: 1,
      auditCreated: 1,
      dealStageHistory: 1,
    });

    const noKeyBody = buildDealBody("No Key Deal", noKeyContactId);
    const noKeyResults = await Promise.all([
      postDeal(POST, noKeyBody),
      postDeal(POST, noKeyBody),
    ]);
    assert.deepEqual(noKeyResults.map((result) => result.status), [200, 200]);
    const noKeyDealIds = noKeyResults.map((result) => result.payload?.deal?.id);
    assert.notEqual(noKeyDealIds[0], noKeyDealIds[1]);
    const noKeyDbCount = await count(
      pool,
      "select count(*) from deals where workspace_id = $1::uuid and name = $2 and idempotency_key is null",
      [workspaceId, `${marker}No Key Deal`],
    );
    assert.equal(noKeyDbCount, 2);

    const beforeCleanup = {
      deals: await count(pool, "select count(*) from deals where workspace_id = $1::uuid", [workspaceId]),
      prefixHits: await countPrefixHits(pool),
    };
    await cleanup(pool);
    const prefixHitsAfterCleanup = await countPrefixHits(pool);
    assert.deepEqual(prefixHitsAfterCleanup, []);

    console.log(JSON.stringify({
      cleanup: {
        beforeCleanup,
        marker,
        prefixHitsAfterCleanup,
      },
      noKey: {
        dbCount: noKeyDbCount,
        dealIds: noKeyDealIds,
        statuses: noKeyResults.map((result) => result.status),
      },
      sameKey: {
        dbCount: sameKeyDbCount,
        dealIds: sameKeyDealIds,
        idempotencyKey,
        sideEffects: effects,
        statuses: sameKeyResults.map((result) => result.status),
      },
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
