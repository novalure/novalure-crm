import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";

const workspaceId = "5a8d1111-1111-4111-8111-111111111111";
const projectId = "5a8d1111-1111-4111-8111-111111111112";
const userId = "5a8d1111-1111-4111-8111-111111111113";
const singleProjectId = "5a8d1111-1111-4111-8111-111111111114";
const emptyProjectId = "5a8d1111-1111-4111-8111-111111111115";
const olderProjectId = "5a8d1111-1111-4111-8111-111111111116";
const listingMultiId = "5a8d1111-1111-4111-8111-111111111301";
const listingSingleId = "5a8d1111-1111-4111-8111-111111111302";
const listingEmptyId = "5a8d1111-1111-4111-8111-111111111303";
const listingOlderId = "5a8d1111-1111-4111-8111-111111111304";
const reservedContactId = "5a8d1111-1111-4111-8111-111111111401";
const reservedUnitId = "5a8d1111-1111-4111-8111-111111111502";

const otherWorkspaceId = "5a8d2222-2222-4222-8222-222222222221";
const otherProjectId = "5a8d2222-2222-4222-8222-222222222222";
const otherUserId = "5a8d2222-2222-4222-8222-222222222223";

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
    throw new Error(`Refusing property pagination QA: active DB host is not test (${testDbHost})`);
  }
  if (!projectIdValue.includes(testDbSuffix)) {
    throw new Error(`Refusing property pagination QA: project id does not contain ${testDbSuffix}`);
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
      ($1::uuid, 'UATTEST_Phase3_Property_Pagination', 'Growth Workspace', 'self_service_customer', 'property_developer', 'project_sales_available', '{"enabledModules":{"properties":true,"units":true,"reservations":true,"projectOverview":true},"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb, 'uattest-phase3-property-pagination'),
      ($2::uuid, 'UATTEST_Phase3_Property_Pagination_Other', 'Growth Workspace', 'self_service_customer', 'property_developer', 'project_sales_available', '{"enabledModules":{"properties":true,"units":true},"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb, 'uattest-phase3-property-pagination-other')
  `,
    [workspaceId, otherWorkspaceId],
  );

  await pool.query(
    `
    insert into workspace_users (id, workspace_id, name, email, role, status, product_role)
    values
      ($1::uuid, $2::uuid, 'UATTEST Property Pagination Owner', 'uattest.property.pagination.owner@example.test', 'owner', 'active', 'customer_owner'),
      ($3::uuid, $4::uuid, 'UATTEST Property Pagination Other Owner', 'uattest.property.pagination.other@example.test', 'owner', 'active', 'customer_owner')
  `,
    [userId, workspaceId, otherUserId, otherWorkspaceId],
  );

  await pool.query(
    `
    insert into projects (id, workspace_id, name, type, status, customer_type, default_operating_model, setup_defaults)
    values
      ($1::uuid, $5::uuid, 'UATTEST Property Multi Unit Asset', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ($2::uuid, $5::uuid, 'UATTEST Property Single Unit Asset', 'Makler Einzelobjekt', 'Aktiv', 'real_estate_broker', 'self_service_customer', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ($3::uuid, $5::uuid, 'UATTEST Property Empty Asset', 'Makler Einzelobjekt', 'Aktiv', 'real_estate_broker', 'self_service_customer', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ($4::uuid, $5::uuid, 'UATTEST Property Older Asset', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ($6::uuid, $7::uuid, 'UATTEST Property Other Tenant', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"UATTEST_PROPERTY_PAGINATION_OTHER"}'::jsonb)
  `,
    [projectId, singleProjectId, emptyProjectId, olderProjectId, workspaceId, otherProjectId, otherWorkspaceId],
  );

  await pool.query(
    `
    insert into contacts (id, workspace_id, project_id, name, role, source, intent, consent_label, email, metadata)
    values (
      $1::uuid,
      $2::uuid,
      $3::uuid,
      'UATTEST Property Pagination Reservierung',
      'Kaeufer',
      'UATTEST Property Pagination',
      'Reservierung pruefen',
      'DSGVO ok',
      'uattest.property.reservation@example.test',
      '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb
    )
  `,
    [reservedContactId, workspaceId, projectId],
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
      ('5a8d1111-1111-4111-8111-111111111501', $1::uuid, $2::uuid, 'PAG-001', 1, 3, 82, 30000000, 'available', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ($3::uuid, $1::uuid, $2::uuid, 'PAG-002', 2, 4, 96, 35000000, 'reserved', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ('5a8d1111-1111-4111-8111-111111111503', $1::uuid, $2::uuid, 'PAG-003', 1, 2, 58, 45000000, 'sold', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ('5a8d1111-1111-4111-8111-111111111504', $1::uuid, $2::uuid, 'PAG-004', 3, 3, 74, 25000000, 'blocked', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ('5a8d1111-1111-4111-8111-111111111505', $1::uuid, $2::uuid, 'PAG-005', 4, 5, 141, 64000000, 'available', '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb),
      ('5a8d1111-1111-4111-8111-111111111506', $1::uuid, $4::uuid, 'PAG-SINGLE', 1, 3, 75, 28000000, 'available', '{"source":"UATTEST_PROPERTY_PAGINATION_SINGLE"}'::jsonb),
      ('5a8d1111-1111-4111-8111-111111111507', $1::uuid, $5::uuid, 'PAG-OLDER', 1, 2, 62, 21000000, 'sold', '{"source":"UATTEST_PROPERTY_PAGINATION_OLDER"}'::jsonb),
      ('5a8d2222-2222-4222-8222-222222222501', $6::uuid, $7::uuid, 'PAG-OTHER-001', 1, 2, 55, 22000000, 'available', '{"source":"UATTEST_PROPERTY_PAGINATION_OTHER"}'::jsonb)
  `,
    [workspaceId, projectId, reservedUnitId, singleProjectId, olderProjectId, otherWorkspaceId, otherProjectId],
  );

  await pool.query(
    `
    insert into property_reservations (
      id,
      workspace_id,
      project_id,
      unit_id,
      contact_id,
      status,
      expires_at,
      deposit_cents,
      contract_milestone,
      next_action,
      metadata
    )
    values (
      '5a8d1111-1111-4111-8111-111111111701',
      $1::uuid,
      $2::uuid,
      $3::uuid,
      $4::uuid,
      'reserved',
      now() + interval '14 days',
      1500000,
      'contract_draft',
      'UATTEST Kaufanbot vorbereiten',
      '{"source":"UATTEST_PROPERTY_PAGINATION"}'::jsonb
    )
  `,
    [workspaceId, projectId, reservedUnitId, reservedContactId],
  );

  await pool.query(
    `
    insert into property_buildings (
      id,
      workspace_id,
      project_id,
      name,
      address,
      completion_date,
      floors
    )
    values (
      '5a8d1111-1111-4111-8111-111111111801',
      $1::uuid,
      $2::uuid,
      'UATTEST Pagination Bauteil A',
      'UATTEST Property Gasse 1, 8010 Graz',
      '2027-12-31',
      5
    )
  `,
    [workspaceId, projectId],
  );

  await pool.query(
    `
    insert into seller_listings (
      id,
      workspace_id,
      project_id,
      title,
      address,
      region,
      object_type,
      area_sqm,
      rooms,
      year_built,
      market_value_cents,
      target_price_cents,
      object_number,
      marketing_type,
      public_price_cents,
      gdpr_status,
      portal_mapping_status,
      property_status,
      created_at,
      canonical_payload
    )
    values
      ($1::uuid, $5::uuid, $6::uuid, 'UATTEST Multi Unit Objekt', 'UATTEST Property Gasse 1, 8010 Graz', 'Steiermark', 'Wohnung', 451, 17, 2027, 199000000, 199000000, 'UATTEST-PROP-PAGE-001', 'sale', 199000000, 'ready', 'mapped', 'draft', '2026-06-18T10:03:00Z', '{"source":"UATTEST_PROPERTY_PAGINATION","case":"multi-unit"}'::jsonb),
      ($2::uuid, $5::uuid, $7::uuid, 'UATTEST Single Unit Objekt', 'UATTEST Single 2, 8010 Graz', 'Steiermark', 'Wohnung', 75, 3, 2020, 28000000, 28000000, 'UATTEST-PROP-PAGE-002', 'sale', 28000000, 'ready', 'mapped', 'published', '2026-06-18T10:02:00Z', '{"source":"UATTEST_PROPERTY_PAGINATION","case":"single-unit"}'::jsonb),
      ($3::uuid, $5::uuid, $8::uuid, 'UATTEST Empty Objekt', 'UATTEST Empty 3, 8010 Graz', 'Steiermark', 'Haus', 110, 4, 1999, 50000000, 50000000, 'UATTEST-PROP-PAGE-003', 'sale', 50000000, 'needs_review', 'needs_review', 'draft', '2026-06-18T10:01:00Z', '{"source":"UATTEST_PROPERTY_PAGINATION","case":"empty"}'::jsonb),
      ($4::uuid, $5::uuid, $9::uuid, 'UATTEST Older Objekt', 'UATTEST Older 4, 8010 Graz', 'Steiermark', 'Wohnung', 62, 2, 2018, 21000000, 21000000, 'UATTEST-PROP-PAGE-004', 'sale', 21000000, 'ready', 'mapped', 'draft', '2026-06-18T10:00:00Z', '{"source":"UATTEST_PROPERTY_PAGINATION","case":"older"}'::jsonb),
      ('5a8d2222-2222-4222-8222-222222222301', $10::uuid, $11::uuid, 'UATTEST Other Tenant Objekt A', 'UATTEST Other 1, 8010 Graz', 'Steiermark', 'Wohnung', 55, 2, 2021, 22000000, 22000000, 'UATTEST-PROP-OTHER-001', 'sale', 22000000, 'ready', 'mapped', 'draft', '2026-06-18T10:04:00Z', '{"source":"UATTEST_PROPERTY_PAGINATION_OTHER"}'::jsonb),
      ('5a8d2222-2222-4222-8222-222222222302', $10::uuid, $11::uuid, 'UATTEST Other Tenant Objekt B', 'UATTEST Other 2, 8010 Graz', 'Steiermark', 'Wohnung', 65, 3, 2021, 24000000, 24000000, 'UATTEST-PROP-OTHER-002', 'sale', 24000000, 'ready', 'mapped', 'draft', '2026-06-18T10:02:30Z', '{"source":"UATTEST_PROPERTY_PAGINATION_OTHER"}'::jsonb)
  `,
    [
      listingMultiId,
      listingSingleId,
      listingEmptyId,
      listingOlderId,
      workspaceId,
      projectId,
      singleProjectId,
      emptyProjectId,
      olderProjectId,
      otherWorkspaceId,
      otherProjectId,
    ],
  );
}

function buildSessionHeaders(input = {}) {
  const activeWorkspaceId = input.workspaceId ?? workspaceId;
  const activeUserId = input.userId ?? userId;
  return {
    "x-novalure-product-role": "customer_owner",
    "x-novalure-role": "owner",
    "x-novalure-user-email": "uattest.property.pagination.owner@example.test",
    "x-novalure-user-id": activeUserId,
    "x-novalure-user-name": "UATTEST Property Pagination Owner",
    "x-novalure-workspace-id": activeWorkspaceId,
  };
}

function buildSession() {
  return {
    authenticated: true,
    email: "uattest.property.pagination.owner@example.test",
    name: "UATTEST Property Pagination Owner",
    permissions: ["crm:read", "crm:write", "settings:manage"],
    productPermissions: ["workspace:read", "workspace:operate", "workspace:admin"],
    productRole: "customer_owner",
    role: "owner",
    source: "database",
    userId,
    workspaceCustomerType: "property_developer",
    workspaceId,
    workspaceName: "UATTEST_Phase3_Property_Pagination",
    workspaceOperatingModel: "self_service_customer",
    workspaceTeamStructure: "project_sales_available",
  };
}

async function callPropertiesRoute(GET, query, headers = buildSessionHeaders()) {
  const url = `https://qa.local/api/crm/properties${query ? `?${query}` : ""}`;
  const response = await GET(new Request(url, { headers }));
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`GET /api/crm/properties failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function assetTitles(payload) {
  return payload.data.assets.map((asset) => asset.title);
}

function assertNoTenantLeak(payload, expectedWorkspaceId) {
  const leaked = payload.data.assets.filter((asset) => asset.workspaceId !== expectedWorkspaceId);
  assert.deepEqual(leaked, [], "paginated property page must not include another workspace");
}

function pickAsset(payload, sellerListingId) {
  const asset = payload.data.assets.find((item) => item.sellerListingId === sellerListingId);
  assert.ok(asset, `missing asset for listing ${sellerListingId}`);
  return asset;
}

async function explainPaginationQuery(pool) {
  const result = await pool.query(
    `
    explain (format json)
    select sl.id
    from seller_listings sl
    where sl.workspace_id = $1::uuid
    order by sl.created_at desc, sl.id desc
    limit 2
    offset 0
  `,
    [workspaceId],
  );
  const plan = result.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
  const child = plan?.Plans?.[0];
  const grandChild = child?.Plans?.[0];
  console.log(JSON.stringify({
    explain: {
      childNodeType: child?.["Node Type"],
      childSortKey: child?.["Sort Key"],
      grandChildNodeType: grandChild?.["Node Type"],
      grandChildRelationName: grandChild?.["Relation Name"],
      nodeType: plan?.["Node Type"],
      relationName: plan?.["Relation Name"],
      sortKey: plan?.["Sort Key"],
      totalCost: plan?.["Total Cost"],
    },
  }, null, 2));
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
    await explainPaginationQuery(pool);

    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const { GET } = jiti("../src/app/api/crm/properties/route.ts");
    const { getCoreCrmData, loadPaginatedPropertyUnits } = jiti("../src/lib/db/crm-loaders.ts");
    const { buildPropertyAssets } = jiti("../src/lib/property-department.ts");

    const standard = await callPropertiesRoute(GET, "");
    assert.equal(standard.pagination.limit, 50);
    assert.equal(standard.pagination.offset, 0);
    assert.equal(standard.pagination.total, 4);
    assert.equal(standard.pagination.hasMore, false);
    assert.deepEqual(assetTitles(standard), [
      "UATTEST Multi Unit Objekt",
      "UATTEST Single Unit Objekt",
      "UATTEST Empty Objekt",
      "UATTEST Older Objekt",
    ]);
    assertNoTenantLeak(standard, workspaceId);

    const page1 = await callPropertiesRoute(GET, "limit=2&offset=0");
    assert.equal(page1.pagination.total, 4);
    assert.equal(page1.pagination.hasMore, true);
    assert.equal(page1.pagination.nextOffset, 2);
    assert.deepEqual(assetTitles(page1), ["UATTEST Multi Unit Objekt", "UATTEST Single Unit Objekt"]);
    assertNoTenantLeak(page1, workspaceId);

    const page2 = await callPropertiesRoute(GET, "limit=2&offset=2");
    assert.equal(page2.pagination.total, 4);
    assert.equal(page2.pagination.hasMore, false);
    assert.equal(page2.pagination.nextOffset, null);
    assert.deepEqual(assetTitles(page2), ["UATTEST Empty Objekt", "UATTEST Older Objekt"]);
    assertNoTenantLeak(page2, workspaceId);

    const published = await callPropertiesRoute(GET, "status=published&limit=10");
    assert.equal(published.pagination.total, 1);
    assert.deepEqual(assetTitles(published), ["UATTEST Single Unit Objekt"]);

    const searched = await callPropertiesRoute(GET, "q=PAGE-001&limit=10");
    assert.equal(searched.pagination.total, 1);
    assert.deepEqual(assetTitles(searched), ["UATTEST Multi Unit Objekt"]);

    const otherWorkspace = await callPropertiesRoute(
      GET,
      "limit=10",
      buildSessionHeaders({ userId: otherUserId, workspaceId: otherWorkspaceId }),
    );
    assert.equal(otherWorkspace.pagination.total, 2);
    assert.deepEqual(assetTitles(otherWorkspace), ["UATTEST Other Tenant Objekt A", "UATTEST Other Tenant Objekt B"]);
    assertNoTenantLeak(otherWorkspace, otherWorkspaceId);

    const invalidProject = await GET(new Request("https://qa.local/api/crm/properties?projectId=not-a-uuid", {
      headers: buildSessionHeaders(),
    }));
    assert.equal(invalidProject.status, 400);

    const multiAsset = pickAsset(standard, listingMultiId);
    assert.equal(multiAsset.unitCount, 5);
    assert.equal(multiAsset.availableUnits, 2);
    assert.equal(multiAsset.reservedUnits, 1);
    assert.equal(multiAsset.soldUnits, 1);
    assert.equal(multiAsset.price, 1990000);
    assert.equal(multiAsset.activeReservations, 1);

    const unitPageForSameProject = await loadPaginatedPropertyUnits(workspaceId, {
      limit: 2,
      offset: 0,
      projectId,
    });
    assert.equal(unitPageForSameProject.units.length, 2);
    assert.equal(unitPageForSameProject.pagination.total, 5);
    assert.equal(multiAsset.unitCount, 5);

    const coreData = await getCoreCrmData(workspaceId, { session: buildSession() });
    const coreAssets = buildPropertyAssets({
      brokerMandates: coreData.brokerMandates,
      buildings: coreData.propertyBuildings,
      propertyCostItems: coreData.propertyCostItems,
      propertyDocuments: coreData.propertyDocuments,
      propertyMedia: coreData.propertyMedia,
      propertyTextBlocks: coreData.propertyTextBlocks,
      projects: coreData.projects,
      reservations: coreData.propertyReservations,
      sellerListings: coreData.sellerListings,
      units: coreData.propertyUnits,
    });
    const coreMultiAsset = coreAssets.find((asset) => asset.sellerListingId === listingMultiId);
    assert.ok(coreMultiAsset, "core countercheck asset missing");
    assert.deepEqual({
      activeReservations: multiAsset.activeReservations,
      availableUnits: multiAsset.availableUnits,
      price: multiAsset.price,
      reservedUnits: multiAsset.reservedUnits,
      soldUnits: multiAsset.soldUnits,
      unitCount: multiAsset.unitCount,
      unitIds: multiAsset.unitIds,
    }, {
      activeReservations: coreMultiAsset.activeReservations,
      availableUnits: coreMultiAsset.availableUnits,
      price: coreMultiAsset.price,
      reservedUnits: coreMultiAsset.reservedUnits,
      soldUnits: coreMultiAsset.soldUnits,
      unitCount: coreMultiAsset.unitCount,
      unitIds: coreMultiAsset.unitIds,
    });

    console.log(JSON.stringify({
      coreCountercheck: {
        activeReservations: coreMultiAsset.activeReservations,
        availableUnits: coreMultiAsset.availableUnits,
        price: coreMultiAsset.price,
        reservedUnits: coreMultiAsset.reservedUnits,
        soldUnits: coreMultiAsset.soldUnits,
        unitCount: coreMultiAsset.unitCount,
      },
      endpoint: "/api/crm/properties",
      fixtures: {
        listingMultiId,
        otherWorkspaceId,
        projectId,
        workspaceId,
      },
      page1: {
        pagination: page1.pagination,
        titles: assetTitles(page1),
      },
      page2: {
        pagination: page2.pagination,
        titles: assetTitles(page2),
      },
      standard: {
        pagination: standard.pagination,
        titles: assetTitles(standard),
      },
      summaryOverFullUnitScope: {
        propertyAssetUnitCount: multiAsset.unitCount,
        propertyAssetValue: multiAsset.price,
        unitPageReturnedUnits: unitPageForSameProject.units.map((unit) => unit.unitNumber),
        unitPageTotalUnits: unitPageForSameProject.pagination.total,
      },
      tenantCountercheck: {
        otherWorkspaceAssets: assetTitles(otherWorkspace),
        otherWorkspaceTotal: otherWorkspace.pagination.total,
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
