import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";

const workspaceId = "4a8d1111-1111-4111-8111-111111111111";
const projectId = "4a8d1111-1111-4111-8111-111111111112";
const userId = "4a8d1111-1111-4111-8111-111111111113";
const otherWorkspaceId = "4a8d2222-2222-4222-8222-222222222221";
const otherProjectId = "4a8d2222-2222-4222-8222-222222222222";
const otherUserId = "4a8d2222-2222-4222-8222-222222222223";

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
    throw new Error(`Refusing property-unit pagination QA: active DB host is not test (${testDbHost})`);
  }
  if (!projectIdValue.includes(testDbSuffix)) {
    throw new Error(`Refusing property-unit pagination QA: project id does not contain ${testDbSuffix}`);
  }
}

async function seed(pool) {
  await pool.query("delete from workspaces where id = $1::uuid", [workspaceId]);
  await pool.query("delete from workspaces where id = $1::uuid", [otherWorkspaceId]);

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
    values
      ($1::uuid, 'UATTEST_Phase2_Unit_Pagination', 'Growth Workspace', 'self_service_customer', 'property_developer', 'project_sales_available', '{"enabledModules":{"properties":true,"units":true,"reservations":true,"projectOverview":true},"source":"UATTEST_PAGINATION"}'::jsonb, 'uattest-phase2-unit-pagination'),
      ($2::uuid, 'UATTEST_Phase2_Unit_Pagination_Other', 'Growth Workspace', 'self_service_customer', 'property_developer', 'project_sales_available', '{"enabledModules":{"properties":true,"units":true},"source":"UATTEST_PAGINATION"}'::jsonb, 'uattest-phase2-unit-pagination-other')
  `,
    [workspaceId, otherWorkspaceId],
  );

  await pool.query(
    `
    insert into workspace_users (id, workspace_id, name, email, role, status, product_role)
    values
      ($1::uuid, $2::uuid, 'UATTEST Pagination Owner', 'uattest.pagination.owner@example.test', 'owner', 'active', 'customer_owner'),
      ($3::uuid, $4::uuid, 'UATTEST Pagination Other Owner', 'uattest.pagination.other@example.test', 'owner', 'active', 'customer_owner')
  `,
    [userId, workspaceId, otherUserId, otherWorkspaceId],
  );

  await pool.query(
    `
    insert into projects (id, workspace_id, name, type, status, customer_type, default_operating_model, setup_defaults)
    values
      ($1::uuid, $2::uuid, 'UATTEST Pagination Wohnpark', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"UATTEST_PAGINATION"}'::jsonb),
      ($3::uuid, $4::uuid, 'UATTEST Pagination Other Workspace', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"UATTEST_PAGINATION"}'::jsonb)
  `,
    [projectId, workspaceId, otherProjectId, otherWorkspaceId],
  );

  await pool.query(
    `
    insert into property_units (
      id,
      workspace_id,
      project_id,
      unit_number,
      floor,
      rooms,
      area_sqm,
      price_cents,
      status,
      metadata
    )
    values
      ('4a8d1111-1111-4111-8111-111111111501', $1::uuid, $2::uuid, 'UAT-001', 1, 3, 82, 30000000, 'available', '{"source":"UATTEST_PAGINATION"}'::jsonb),
      ('4a8d1111-1111-4111-8111-111111111502', $1::uuid, $2::uuid, 'UAT-002', 2, 4, 96, 35000000, 'reserved', '{"source":"UATTEST_PAGINATION"}'::jsonb),
      ('4a8d1111-1111-4111-8111-111111111503', $1::uuid, $2::uuid, 'UAT-003', 1, 2, 58, 45000000, 'sold', '{"source":"UATTEST_PAGINATION"}'::jsonb),
      ('4a8d1111-1111-4111-8111-111111111504', $1::uuid, $2::uuid, 'UAT-004', 3, 3, 74, 25000000, 'blocked', '{"source":"UATTEST_PAGINATION"}'::jsonb),
      ('4a8d1111-1111-4111-8111-111111111505', $1::uuid, $2::uuid, 'UAT-005', 4, 5, 141, 64000000, 'available', '{"source":"UATTEST_PAGINATION"}'::jsonb),
      ('4a8d2222-2222-4222-8222-222222222501', $3::uuid, $4::uuid, 'UAT-001', 1, 2, 55, 21000000, 'available', '{"source":"UATTEST_PAGINATION_OTHER"}'::jsonb),
      ('4a8d2222-2222-4222-8222-222222222502', $3::uuid, $4::uuid, 'UAT-002', 2, 2, 62, 22000000, 'reserved', '{"source":"UATTEST_PAGINATION_OTHER"}'::jsonb),
      ('4a8d2222-2222-4222-8222-222222222503', $3::uuid, $4::uuid, 'UAT-003', 3, 3, 78, 23000000, 'sold', '{"source":"UATTEST_PAGINATION_OTHER"}'::jsonb)
  `,
    [workspaceId, projectId, otherWorkspaceId, otherProjectId],
  );
}

function buildSessionHeaders(input = {}) {
  const activeWorkspaceId = input.workspaceId ?? workspaceId;
  const activeUserId = input.userId ?? userId;
  return {
    "x-novalure-product-role": "customer_owner",
    "x-novalure-role": "owner",
    "x-novalure-user-email": "uattest.pagination.owner@example.test",
    "x-novalure-user-id": activeUserId,
    "x-novalure-user-name": "UATTEST Pagination Owner",
    "x-novalure-workspace-id": activeWorkspaceId,
  };
}

function buildSession() {
  return {
    authenticated: true,
    email: "uattest.pagination.owner@example.test",
    name: "UATTEST Pagination Owner",
    permissions: ["crm:read", "crm:write", "settings:manage"],
    productPermissions: ["workspace:read", "workspace:operate", "workspace:admin"],
    productRole: "customer_owner",
    role: "owner",
    source: "database",
    userId,
    workspaceCustomerType: "property_developer",
    workspaceId,
    workspaceName: "UATTEST_Phase2_Unit_Pagination",
    workspaceOperatingModel: "self_service_customer",
    workspaceTeamStructure: "project_sales_available",
  };
}

async function callUnitsRoute(GET, query, headers = buildSessionHeaders()) {
  const url = `https://qa.local/api/crm/units${query ? `?${query}` : ""}`;
  const response = await GET(new Request(url, { headers }));
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`GET /api/crm/units failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function unitNumbers(payload) {
  return payload.data.units.map((unit) => unit.unitNumber);
}

function assertNoTenantLeak(payload, expectedWorkspaceId) {
  const leaked = payload.data.units.filter((unit) => unit.workspaceId !== expectedWorkspaceId);
  assert.deepEqual(leaked, [], "paginated unit page must not include another workspace");
}

async function main() {
  const env = loadEnvFile(join(process.cwd(), ".env.local"));
  const databaseUrl = cleanDatabaseUrl(
    env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_DATABASE_URL || env.POSTGRES_PRISMA_URL,
  );
  if (!databaseUrl) throw new Error("DATABASE_URL is missing");
  assertTestDatabase(env, databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.POSTGRES_DATABASE_URL = databaseUrl;
  process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";
  if (env.POSTGRES_NEON_PROJECT_ID) process.env.POSTGRES_NEON_PROJECT_ID = env.POSTGRES_NEON_PROJECT_ID;
  if (env.NEON_PROJECT_ID) process.env.NEON_PROJECT_ID = env.NEON_PROJECT_ID;

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await seed(pool);

    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const { GET } = jiti("../src/app/api/crm/units/route.ts");
    const { getCoreCrmData } = jiti("../src/lib/db/crm-loaders.ts");

    const page1 = await callUnitsRoute(GET, "limit=2&offset=0");
    assert.equal(page1.pagination.total, 5);
    assert.equal(page1.pagination.limit, 2);
    assert.equal(page1.pagination.offset, 0);
    assert.equal(page1.pagination.hasMore, true);
    assert.equal(page1.pagination.nextOffset, 2);
    assert.deepEqual(unitNumbers(page1), ["UAT-001", "UAT-002"]);
    assertNoTenantLeak(page1, workspaceId);

    const page2 = await callUnitsRoute(GET, "limit=2&offset=2");
    assert.equal(page2.pagination.total, 5);
    assert.equal(page2.pagination.hasMore, true);
    assert.equal(page2.pagination.nextOffset, 4);
    assert.deepEqual(unitNumbers(page2), ["UAT-003", "UAT-004"]);
    assertNoTenantLeak(page2, workspaceId);

    const page3 = await callUnitsRoute(GET, "limit=2&offset=4");
    assert.equal(page3.pagination.total, 5);
    assert.equal(page3.pagination.hasMore, false);
    assert.equal(page3.pagination.nextOffset, null);
    assert.deepEqual(unitNumbers(page3), ["UAT-005"]);
    assertNoTenantLeak(page3, workspaceId);

    assert.deepEqual(page1.summary, {
      availableUnits: 2,
      blockedUnits: 1,
      inventoryValueCents: 154000000,
      reservedUnits: 1,
      soldUnits: 1,
      soldValueCents: 45000000,
      totalSalesValueCents: 199000000,
      totalUnits: 5,
    });

    const reserved = await callUnitsRoute(GET, "status=reserved&limit=10");
    assert.equal(reserved.pagination.total, 1);
    assert.deepEqual(unitNumbers(reserved), ["UAT-002"]);

    const searched = await callUnitsRoute(GET, "q=UAT-005&limit=10");
    assert.equal(searched.pagination.total, 1);
    assert.deepEqual(unitNumbers(searched), ["UAT-005"]);

    const otherWorkspace = await callUnitsRoute(
      GET,
      "limit=10",
      buildSessionHeaders({ userId: otherUserId, workspaceId: otherWorkspaceId }),
    );
    assert.equal(otherWorkspace.pagination.total, 3);
    assert.deepEqual(unitNumbers(otherWorkspace), ["UAT-001", "UAT-002", "UAT-003"]);
    assertNoTenantLeak(otherWorkspace, otherWorkspaceId);

    const invalidProject = await GET(new Request("https://qa.local/api/crm/units?projectId=not-a-uuid", {
      headers: buildSessionHeaders(),
    }));
    assert.equal(invalidProject.status, 400);

    const coreData = await getCoreCrmData(workspaceId, { session: buildSession() });
    const coreUnits = coreData.propertyUnits.filter((unit) => unit.workspaceId === workspaceId);
    assert.equal(coreUnits.length, 5);
    assert.equal(coreUnits.reduce((sum, unit) => sum + unit.priceCents, 0), 199000000);

    console.log(JSON.stringify({
      coreCountercheck: {
        propertyUnits: coreUnits.length,
        totalSalesValueCents: coreUnits.reduce((sum, unit) => sum + unit.priceCents, 0),
      },
      endpoint: "/api/crm/units",
      fixtures: {
        otherProjectId,
        otherWorkspaceId,
        projectId,
        unitNumbers: coreUnits.map((unit) => unit.unitNumber).sort(),
        workspaceId,
      },
      page1: {
        pagination: page1.pagination,
        summary: page1.summary,
        unitNumbers: unitNumbers(page1),
      },
      page2: {
        pagination: page2.pagination,
        unitNumbers: unitNumbers(page2),
      },
      page3: {
        pagination: page3.pagination,
        unitNumbers: unitNumbers(page3),
      },
      tenantCountercheck: {
        otherWorkspaceTotal: otherWorkspace.pagination.total,
        otherWorkspaceUnits: unitNumbers(otherWorkspace),
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
