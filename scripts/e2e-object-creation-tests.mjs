import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const workspaceId = "e2e00000-0000-4000-8000-000000000001";
const userId = "e2e00000-0000-4000-8000-000000000002";
const workspaceName = "UATTEST_E2E_Object_Flow";
const workspaceSlug = "uattest-e2e-object-flow";
const testDataPrefix = "UATTEST_E2E";

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

function createDatabaseGuard(env, databaseUrl) {
  const parsed = new URL(databaseUrl);
  const projectId = env.POSTGRES_NEON_PROJECT_ID || env.NEON_PROJECT_ID || "";

  function assertTestDatabase(scope = "database access") {
    if (parsed.hostname !== testDbHost) {
      throw new Error(`Refusing ${scope}: active DB host is not test (${testDbHost})`);
    }
    if (!projectId.includes(testDbSuffix)) {
      throw new Error(`Refusing ${scope}: project id does not contain ${testDbSuffix}`);
    }
  }

  return {
    assertTestDatabase,
    projectId,
    report() {
      console.log(`Active DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);
      console.log(`Active DB host: ${parsed.hostname}`);
      console.log(`Project ID suffix verified: ${projectId ? "***" + projectId.slice(-8) : "missing"}`);
      assertTestDatabase("phase2 UATTEST_E2E run");
    },
  };
}

async function readQuery(pool, label, text, values = []) {
  const result = await pool.query(text, values);
  console.log(`[READBACK] ${label}: ${JSON.stringify(result.rows, null, 2)}`);
  return result.rows;
}

async function writeQuery(pool, guard, label, text, values = []) {
  guard.assertTestDatabase(label);
  return pool.query(text, values);
}

function safeIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function hasTestPrefix(value) {
  return String(value ?? "").startsWith(testDataPrefix) || String(value ?? "").startsWith(testDataPrefix.toLowerCase());
}

async function listWorkspaceScopedCounts(pool) {
  const tableRows = await pool.query(`
    select distinct table_name as "tableName"
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'workspace_id'
    order by table_name
  `);
  const counts = [];
  for (const row of tableRows.rows) {
    const tableName = row.tableName;
    const countResult = await pool.query(
      `select count(*)::int as count from ${safeIdentifier(tableName)} where workspace_id::text = $1`,
      [workspaceId],
    );
    const count = Number(countResult.rows[0]?.count ?? 0);
    if (count > 0) counts.push({ count, table: tableName });
  }
  return counts;
}

async function readExternalMarkerCounts(pool) {
  const result = await pool.query(
    `
      select
        count(*) filter (where name like 'CODEXTEST_%')::int as "codextestWorkspaces",
        count(*) filter (where name like 'PILOTTEST_%')::int as "pilottestWorkspaces",
        count(*) filter (where name like 'UATTEST_%' and name <> $1)::int as "otherUattestWorkspaces"
      from workspaces
    `,
    [workspaceName],
  );
  return result.rows[0] ?? { codextestWorkspaces: 0, otherUattestWorkspaces: 0, pilottestWorkspaces: 0 };
}

async function collectCleanupInventory(pool) {
  const workspaceRows = await pool.query(
    `
      select id, name, slug
      from workspaces
      where id = $1::uuid
         or name = $2
         or slug = $3
      order by created_at
    `,
    [workspaceId, workspaceName, workspaceSlug],
  );

  const scopedCounts = await listWorkspaceScopedCounts(pool);
  if (workspaceRows.rowCount === 0) {
    return {
      details: {},
      externalMarkers: await readExternalMarkerCounts(pool),
      scopedCounts,
      totalScopedRows: scopedCounts.reduce((sum, item) => sum + item.count, 0),
      workspace: null,
    };
  }

  if (workspaceRows.rowCount !== 1) {
    throw new Error(`Cleanup guard failed: expected one fixture workspace, found ${workspaceRows.rowCount}.`);
  }

  const workspace = workspaceRows.rows[0];
  const detailQueries = {
    contacts: `
      select id, name, email, source, project_id as "projectId"
      from contacts
      where workspace_id = $1::uuid
      order by created_at
    `,
    costItems: `
      select id, cost_key as "costKey", label, property_id as "propertyId", unit_id as "unitId"
      from property_cost_items
      where workspace_id = $1::uuid
      order by created_at
    `,
    propertyBuildings: `
      select id, name, address, project_id as "projectId"
      from property_buildings
      where workspace_id = $1::uuid
      order by created_at
    `,
    propertyReservations: `
      select
        pr.id,
        pr.status,
        pr.unit_id as "unitId",
        pu.unit_number as "unitNumber",
        c.email as "contactEmail"
      from property_reservations pr
      left join property_units pu on pu.id = pr.unit_id
      left join contacts c on c.id = pr.contact_id
      where pr.workspace_id = $1::uuid
      order by pr.created_at
    `,
    propertyUnits: `
      select
        pu.id,
        pu.unit_number as "unitNumber",
        pu.status,
        pu.price_cents as "priceCents",
        pu.metadata,
        sl.object_number as "sellerListingObjectNumber"
      from property_units pu
      left join seller_listings sl on sl.unit_id = pu.id and sl.workspace_id = pu.workspace_id
      where pu.workspace_id = $1::uuid
      order by pu.unit_number
    `,
    projects: `
      select id, name, type, status
      from projects
      where workspace_id = $1::uuid
      order by created_at
    `,
    sellerListings: `
      select id, title, object_number as "objectNumber", unit_id as "unitId", project_id as "projectId"
      from seller_listings
      where workspace_id = $1::uuid
      order by created_at
    `,
    textBlocks: `
      select id, text_key as "textKey", channel, title, property_id as "propertyId", unit_id as "unitId"
      from property_text_blocks
      where workspace_id = $1::uuid
      order by created_at
    `,
    workspaceUsers: `
      select id, name, email, role, status
      from workspace_users
      where workspace_id = $1::uuid
      order by created_at
    `,
  };
  const details = {};
  for (const [key, text] of Object.entries(detailQueries)) {
    details[key] = (await pool.query(text, [workspaceId])).rows;
  }

  return {
    details,
    externalMarkers: await readExternalMarkerCounts(pool),
    scopedCounts,
    totalScopedRows: scopedCounts.reduce((sum, item) => sum + item.count, 0),
    workspace,
  };
}

function assertCleanupInventorySafe(inventory) {
  if (!inventory.workspace) return;
  const workspaceSafe =
    inventory.workspace.id === workspaceId &&
    inventory.workspace.name === workspaceName &&
    inventory.workspace.slug === workspaceSlug &&
    hasTestPrefix(inventory.workspace.name);
  if (!workspaceSafe) {
    throw new Error(`Cleanup guard failed: fixture workspace identity mismatch (${JSON.stringify(inventory.workspace)}).`);
  }

  const unsafe = [];
  for (const row of inventory.details.workspaceUsers ?? []) {
    if (!hasTestPrefix(row.name) && !String(row.email ?? "").startsWith("uattest_e2e")) unsafe.push(["workspace_users", row.id]);
  }
  for (const row of inventory.details.projects ?? []) {
    if (!hasTestPrefix(row.name)) unsafe.push(["projects", row.id]);
  }
  for (const row of inventory.details.contacts ?? []) {
    if (!hasTestPrefix(row.name) && !String(row.email ?? "").startsWith("uattest_e2e")) unsafe.push(["contacts", row.id]);
  }
  for (const row of inventory.details.propertyBuildings ?? []) {
    if (!hasTestPrefix(row.name) && !hasTestPrefix(row.address)) unsafe.push(["property_buildings", row.id]);
  }
  for (const row of inventory.details.propertyUnits ?? []) {
    const isDefaultUnit =
      row.metadata?.defaultUnit === true &&
      row.metadata?.hidden === true &&
      hasTestPrefix(row.sellerListingObjectNumber ?? "");
    if (!hasTestPrefix(row.unitNumber) && !isDefaultUnit) unsafe.push(["property_units", row.id]);
  }
  for (const row of inventory.details.sellerListings ?? []) {
    if (!hasTestPrefix(row.title) && !hasTestPrefix(row.objectNumber)) unsafe.push(["seller_listings", row.id]);
  }
  for (const row of inventory.details.textBlocks ?? []) {
    if (!hasTestPrefix(row.title)) unsafe.push(["property_text_blocks", row.id]);
  }
  for (const row of inventory.details.costItems ?? []) {
    if (!hasTestPrefix(row.label)) unsafe.push(["property_cost_items", row.id]);
  }
  for (const row of inventory.details.propertyReservations ?? []) {
    if (!hasTestPrefix(row.unitNumber) || !String(row.contactEmail ?? "").startsWith("uattest_e2e")) {
      unsafe.push(["property_reservations", row.id]);
    }
  }

  if (unsafe.length) {
    throw new Error(`Cleanup guard failed: non-UATTEST_E2E rows in delete list: ${JSON.stringify(unsafe)}`);
  }
}

async function cleanupFixture(pool, guard, { execute }) {
  guard.assertTestDatabase(execute ? "phase4 cleanup delete" : "phase4 cleanup dry-run");
  const beforeExternalMarkers = await readExternalMarkerCounts(pool);
  const inventory = await collectCleanupInventory(pool);
  assertCleanupInventorySafe(inventory);
  console.log(`[CLEANUP-DRY-RUN] ${JSON.stringify(inventory, null, 2)}`);

  if (!inventory.workspace) {
    console.log("[CLEANUP] No UATTEST_E2E fixture workspace found.");
    return inventory;
  }

  if (!execute) return inventory;

  await writeQuery(pool, guard, "phase4 cleanup begin", "begin");
  try {
    const deleted = await writeQuery(pool, guard, "delete UATTEST_E2E fixture workspace", `
      delete from workspaces
      where id = $1::uuid
        and name = $2
        and slug = $3
      returning id, name, slug
    `, [workspaceId, workspaceName, workspaceSlug]);
    if (deleted.rowCount !== 1) {
      throw new Error(`Cleanup delete expected one workspace row, deleted ${deleted.rowCount}.`);
    }
    await writeQuery(pool, guard, "phase4 cleanup commit", "commit");
    console.log(`[CLEANUP] Deleted fixture workspace: ${JSON.stringify(deleted.rows[0], null, 2)}`);
  } catch (error) {
    await writeQuery(pool, guard, "phase4 cleanup rollback", "rollback");
    throw error;
  }

  const afterCounts = await listWorkspaceScopedCounts(pool);
  const afterWorkspace = await pool.query(
    `select id, name, slug from workspaces where id = $1::uuid or name = $2 or slug = $3`,
    [workspaceId, workspaceName, workspaceSlug],
  );
  const afterExternalMarkers = await readExternalMarkerCounts(pool);
  console.log(`[CLEANUP-READBACK] ${JSON.stringify({
    remainingFixtureWorkspaceRows: afterWorkspace.rows,
    remainingWorkspaceScopedRows: afterCounts,
    externalMarkersAfter: afterExternalMarkers,
    externalMarkersBefore: beforeExternalMarkers,
  }, null, 2)}`);
  if (afterWorkspace.rowCount > 0 || afterCounts.length > 0) {
    throw new Error("Cleanup read-back failed: fixture workspace rows still exist.");
  }
  if (JSON.stringify(beforeExternalMarkers) !== JSON.stringify(afterExternalMarkers)) {
    throw new Error("Cleanup guard failed: external marker workspace counts changed.");
  }
  return inventory;
}

function runChildScript(args, label) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

async function ensureNoExistingFixture(pool) {
  const result = await pool.query(
    `
      select id, name
      from workspaces
      where id = $1::uuid
         or name = $2
         or slug = 'uattest-e2e-object-flow'
      limit 1
    `,
    [workspaceId, workspaceName],
  );

  if (result.rowCount > 0) {
    throw new Error(
      `Existing ${workspaceName} fixture found. Phase 2 leaves data for Phase 3; run the Phase 4 cleanup before reseeding.`,
    );
  }
}

function buildSession() {
  return {
    authenticated: true,
    email: "uattest_e2e_owner@example.test",
    name: "UATTEST_E2E Owner",
    permissions: [
      "crm:read",
      "crm:write",
      "funnels:write",
      "bots:run",
      "bots:approve",
      "knowledge:write",
      "workflows:run",
      "newsletter:send",
      "calendar:sync",
      "settings:manage",
    ],
    productPermissions: [
      "analytics:read",
      "bots:publish",
      "calendar:manage",
      "funnels:publish",
      "knowledge:write",
      "newsletter:send",
      "pipeline:write",
      "reservations:write",
      "settings:manage",
      "workspace:admin",
      "workspace:operate",
      "workspace:read",
    ],
    productRole: "customer_owner",
    role: "owner",
    source: "database",
    userId,
    workspaceActiveCalendarProvider: "none",
    workspaceCustomerType: "property_developer",
    workspaceId,
    workspaceName,
    workspaceOperatingModel: "self_service_customer",
    workspaceSetupState: {
      enabledModules: {
        projectOverview: true,
        properties: true,
        reservations: true,
        units: true,
      },
      source: "UATTEST_E2E",
    },
    workspaceTeamStructure: "project_sales_available",
  };
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function metricRow(label, expected, actual) {
  return { actual, expected, label, status: actual === expected ? "ok" : "mismatch" };
}

async function expectPersisted(label, guard, fn, selectData = (result) => result.data) {
  guard.assertTestDatabase(label);
  const result = await fn();
  if (!result?.persisted) {
    throw new Error(`${label} failed: ${result?.reason ?? "unknown repository error"}`);
  }
  const data = selectData(result);
  console.log(`[WRITE] ${label}: ${JSON.stringify(data, null, 2)}`);
  return data;
}

async function expectDuplicateFailure(pool, guard, name, expectedConstraint, first, second) {
  await writeQuery(pool, guard, `${name} begin`, "begin");
  try {
    await writeQuery(pool, guard, `${name} first insert`, first.text, first.values);
    await writeQuery(pool, guard, `${name} duplicate insert`, second.text, second.values);
    throw new Error(`${name}: duplicate insert unexpectedly succeeded`);
  } catch (error) {
    if (error?.code !== "23505") {
      throw error;
    }
    if (error.constraint !== expectedConstraint) {
      throw new Error(`${name}: expected ${expectedConstraint}, got ${error.constraint}`);
    }
    console.log(`[DUPLICATE-GUARD] ${name}: blocked by ${error.constraint}`);
  } finally {
    await writeQuery(pool, guard, `${name} rollback`, "rollback");
  }
}

async function exerciseDuplicateGuards(pool, guard, input) {
  await expectDuplicateFailure(pool, guard, "property_text_blocks property-only", "property_text_blocks_property_only_uidx", {
    text: `
      insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
      values ($1::uuid, $2::uuid, $3::uuid, null, 'uattest_e2e_duplicate', 'all', 'UATTEST_E2E duplicate', 'first', '{"source":"UATTEST_E2E"}'::jsonb)
    `,
    values: [workspaceId, input.unitProject.id, input.primaryListing.id],
  }, {
    text: `
      insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
      values ($1::uuid, $2::uuid, $3::uuid, null, 'uattest_e2e_duplicate', 'all', 'UATTEST_E2E duplicate', 'second', '{"source":"UATTEST_E2E"}'::jsonb)
    `,
    values: [workspaceId, input.unitProject.id, input.primaryListing.id],
  });

  await expectDuplicateFailure(pool, guard, "property_text_blocks unit-only", "property_text_blocks_unit_only_uidx", {
    text: `
      insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
      values ($1::uuid, $2::uuid, null, $3::uuid, 'uattest_e2e_duplicate', 'all', 'UATTEST_E2E duplicate', 'first', '{"source":"UATTEST_E2E"}'::jsonb)
    `,
    values: [workspaceId, input.unitProject.id, input.reservedUnit.id],
  }, {
    text: `
      insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
      values ($1::uuid, $2::uuid, null, $3::uuid, 'uattest_e2e_duplicate', 'all', 'UATTEST_E2E duplicate', 'second', '{"source":"UATTEST_E2E"}'::jsonb)
    `,
    values: [workspaceId, input.unitProject.id, input.reservedUnit.id],
  });

  await expectDuplicateFailure(pool, guard, "property_cost_items property-only", "property_cost_items_property_only_uidx", {
    text: `
      insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
      values ($1::uuid, $2::uuid, $3::uuid, null, 'uattest_e2e_duplicate', 'UATTEST_E2E duplicate', '{"source":"UATTEST_E2E"}'::jsonb)
    `,
    values: [workspaceId, input.unitProject.id, input.primaryListing.id],
  }, {
    text: `
      insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
      values ($1::uuid, $2::uuid, $3::uuid, null, 'uattest_e2e_duplicate', 'UATTEST_E2E duplicate second', '{"source":"UATTEST_E2E"}'::jsonb)
    `,
    values: [workspaceId, input.unitProject.id, input.primaryListing.id],
  });

  await expectDuplicateFailure(pool, guard, "property_cost_items unit-only", "property_cost_items_unit_only_uidx", {
    text: `
      insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
      values ($1::uuid, $2::uuid, null, $3::uuid, 'uattest_e2e_duplicate', 'UATTEST_E2E duplicate', '{"source":"UATTEST_E2E"}'::jsonb)
    `,
    values: [workspaceId, input.unitProject.id, input.reservedUnit.id],
  }, {
    text: `
      insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
      values ($1::uuid, $2::uuid, null, $3::uuid, 'uattest_e2e_duplicate', 'UATTEST_E2E duplicate second', '{"source":"UATTEST_E2E"}'::jsonb)
    `,
    values: [workspaceId, input.unitProject.id, input.reservedUnit.id],
  });
}

async function listFixtureInventory(pool) {
  await readQuery(pool, "fixture inventory for Phase 3", `
    select jsonb_build_object(
      'workspace', (
        select jsonb_build_object('id', id, 'name', name, 'slug', slug)
        from workspaces
        where id = $1::uuid
      ),
      'projects', (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'type', type) order by created_at), '[]'::jsonb)
        from projects
        where workspace_id = $1::uuid
      ),
      'sellerListings', (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'projectId', project_id, 'unitId', unit_id, 'objectNumber', object_number) order by created_at), '[]'::jsonb)
        from seller_listings
        where workspace_id = $1::uuid
      ),
      'propertyBuildings', (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'projectId', project_id) order by name), '[]'::jsonb)
        from property_buildings
        where workspace_id = $1::uuid
      ),
      'propertyUnits', (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'unitNumber', unit_number, 'status', status, 'priceCents', price_cents, 'metadata', metadata) order by unit_number), '[]'::jsonb)
        from property_units
        where workspace_id = $1::uuid
      ),
      'propertyReservations', (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'unitId', unit_id, 'contactId', contact_id, 'status', status, 'depositCents', deposit_cents) order by created_at), '[]'::jsonb)
        from property_reservations
        where workspace_id = $1::uuid
      ),
      'contacts', (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'projectId', project_id, 'email', email) order by name), '[]'::jsonb)
        from contacts
        where workspace_id = $1::uuid
      ),
      'textBlockCount', (
        select count(*)::int
        from property_text_blocks
        where workspace_id = $1::uuid
      ),
      'costItemCount', (
        select count(*)::int
        from property_cost_items
        where workspace_id = $1::uuid
      )
    ) as fixtures
  `, [workspaceId]);
}

async function verifyDefaultUnitUpdateBranch(pool, guard, updateSellerListingRecord, session) {
  guard.assertTestDatabase("phase3 default-unit update branch");
  const beforeRows = await readQuery(pool, "default-unit update branch before", `
    select
      sl.id as "listingId",
      sl.title,
      sl.object_number as "objectNumber",
      sl.project_id as "projectId",
      sl.unit_id as "listingUnitId",
      pu.id as "unitId",
      pu.unit_number as "unitNumber",
      pu.status,
      pu.price_cents as "priceCents",
      pu.metadata,
      (
        select count(*)::int
        from property_units duplicate_check
        where duplicate_check.workspace_id = sl.workspace_id
          and duplicate_check.project_id = sl.project_id
          and duplicate_check.metadata @> jsonb_build_object('defaultUnit', true, 'sellerListingId', sl.id::text)
      ) as "defaultUnitCount"
    from seller_listings sl
    left join property_units pu on pu.id = sl.unit_id and pu.workspace_id = sl.workspace_id
    where sl.workspace_id = $1::uuid
      and sl.object_number = 'UATTEST_E2E-LO-001'
    limit 1
  `, [workspaceId]);
  const before = beforeRows[0];
  if (!before?.unitId) {
    throw new Error("Phase 3 update-branch precondition failed: FixB listing/default unit is missing.");
  }

  const updated = await expectPersisted("update existing listing-only default unit branch", guard, () => updateSellerListingRecord({
    property: {
      address: "UATTEST_E2E Gasse 12, 8010 Graz",
      areaSqm: 141,
      city: "Graz",
      gdprStatus: "ready",
      internalNotes: "UATTEST_E2E update branch verified",
      marketingType: "sale",
      objectNumber: "UATTEST_E2E-LO-001",
      objectType: "Haus",
      portalMappingStatus: "mapped",
      postalCode: "8010",
      price: 640000,
      priceVisibility: "publish_price",
      projectId: before.projectId,
      publicPrice: 640000,
      region: "Steiermark",
      rooms: 5,
      street: "UATTEST_E2E Gasse",
      title: before.title,
      yearBuilt: 1998,
    },
    propertyId: before.listingId,
    session,
  }));

  const afterRows = await readQuery(pool, "default-unit update branch after", `
    select
      sl.id as "listingId",
      sl.unit_id as "listingUnitId",
      pu.id as "unitId",
      pu.unit_number as "unitNumber",
      pu.status,
      pu.price_cents as "priceCents",
      pu.metadata,
      (
        select count(*)::int
        from property_units duplicate_check
        where duplicate_check.workspace_id = sl.workspace_id
          and duplicate_check.project_id = sl.project_id
          and duplicate_check.metadata @> jsonb_build_object('defaultUnit', true, 'sellerListingId', sl.id::text)
      ) as "defaultUnitCount"
    from seller_listings sl
    left join property_units pu on pu.id = sl.unit_id and pu.workspace_id = sl.workspace_id
    where sl.workspace_id = $1::uuid
      and sl.id = $2::uuid
    limit 1
  `, [workspaceId, before.listingId]);
  const after = afterRows[0];
  expectEqual("update branch kept listing unit id", after.listingUnitId, before.listingUnitId);
  expectEqual("update branch kept default unit id", after.unitId, before.unitId);
  expectEqual("update branch default unit count", Number(after.defaultUnitCount), 1);
  expectEqual("update branch price cents", Number(after.priceCents), 64000000);
  expectEqual("update branch unit status", after.status, "available");
  expectEqual("update branch metadata.defaultUnit", after.metadata?.defaultUnit, true);
  expectEqual("update branch metadata.hidden", after.metadata?.hidden, true);

  console.log(`[PHASE3] Default-unit update branch verified: ${JSON.stringify({
    afterUnitId: after.unitId,
    beforeUnitId: before.unitId,
    defaultUnitCount: Number(after.defaultUnitCount),
    listingId: updated.id,
    priceCents: Number(after.priceCents),
  }, null, 2)}`);
}

async function ensurePhase3Reservation(pool, guard, upsertContactRecord, mutateUnitReservation, session) {
  guard.assertTestDatabase("phase3 reservation setup");
  const unitRows = await readQuery(pool, "phase3 reservation unit before", `
    select id, project_id as "projectId", unit_number as "unitNumber", status, price_cents as "priceCents"
    from property_units
    where workspace_id = $1::uuid
      and unit_number = 'UATTEST_E2E_A-02'
    limit 1
  `, [workspaceId]);
  const unit = unitRows[0];
  if (!unit?.id) throw new Error("UATTEST_E2E_A-02 unit is missing.");

  const reservationRows = await readQuery(pool, "phase3 active reservation before", `
    select id, unit_id as "unitId", contact_id as "contactId", status
    from property_reservations
    where workspace_id = $1::uuid
      and unit_id = $2::uuid
      and status in ('hold', 'reserved')
    limit 1
  `, [workspaceId, unit.id]);
  if (reservationRows[0]?.id && unit.status === "reserved") {
    console.log(`[PHASE3] Reservation already present: ${JSON.stringify(reservationRows[0], null, 2)}`);
    return reservationRows[0];
  }

  if (unit.status !== "available") {
    throw new Error(`Cannot create Phase 3 reservation: unit ${unit.unitNumber} has status ${unit.status}.`);
  }

  const existingContacts = await readQuery(pool, "phase3 reservation contact lookup", `
    select id, name, email, project_id as "projectId"
    from contacts
    where workspace_id = $1::uuid
      and email = 'uattest_e2e.reservation@example.test'
    limit 1
  `, [workspaceId]);
  const contact = existingContacts[0] ?? await expectPersisted("create phase3 reservation contact", guard, () => upsertContactRecord({
    contact: {
      consent: "DSGVO ok",
      email: "uattest_e2e.reservation@example.test",
      intent: "UATTEST_E2E Reservierung pruefen",
      name: "UATTEST_E2E Reservierung Kontakt",
      phone: "+430000000002",
      projectId: unit.projectId,
      role: "Kaeufer",
      source: "UATTEST_E2E",
    },
    session,
  }));

  const reservation = await expectPersisted("create phase3 unit reservation", guard, () => mutateUnitReservation({
    input: {
      action: "create",
      contactId: contact.id,
      contractMilestone: "contract_draft",
      createTask: false,
      depositCents: 1500000,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      nextAction: "UATTEST_E2E Kaufanbot vorbereiten",
      notifyTeams: false,
      unitId: unit.id,
    },
    session,
  }), (result) => result.reservation);

  await readQuery(pool, "phase3 reservation and synced unit after", `
    select jsonb_build_object(
      'reservation', (
        select row_to_json(r)
        from (
          select id, unit_id as "unitId", contact_id as "contactId", status, deposit_cents as "depositCents"
          from property_reservations
          where workspace_id = $1::uuid and id = $2::uuid
        ) r
      ),
      'unit', (
        select row_to_json(u)
        from (
          select id, unit_number as "unitNumber", status, buyer_contact_id as "buyerContactId", price_cents as "priceCents"
          from property_units
          where workspace_id = $1::uuid and id = $3::uuid
        ) u
      )
    ) as fixture
  `, [workspaceId, reservation.id, unit.id]);
  return reservation;
}

function calculateUnitKpis(units, reservations) {
  const activeReservations = reservations.filter((reservation) => reservation.status === "hold" || reservation.status === "reserved");
  const totalUnits = units.length;
  const availableUnits = units.filter((unit) => unit.status === "available").length;
  const reservedUnits = units.filter((unit) => unit.status === "reserved").length;
  const soldUnits = units.filter((unit) => unit.status === "sold").length;
  const blockedUnits = units.filter((unit) => unit.status === "blocked").length;
  const totalSalesValue = units.reduce((sum, unit) => sum + unit.priceCents, 0);
  const inventoryValue = units.filter((unit) => unit.status !== "sold").reduce((sum, unit) => sum + unit.priceCents, 0);
  const soldValue = units.filter((unit) => unit.status === "sold").reduce((sum, unit) => sum + unit.priceCents, 0);

  return {
    activeReservations: activeReservations.length,
    availableUnits,
    blockedUnits,
    inventoryValue,
    reservationRatePercent: totalUnits ? Math.round((reservedUnits / totalUnits) * 100) : 0,
    reservedUnits,
    salesRatePercent: totalUnits ? Math.round((soldUnits / totalUnits) * 100) : 0,
    soldUnits,
    soldValue,
    totalSalesValue,
    totalUnits,
  };
}

async function verifyPhase3Kpis(getCoreCrmData, buildPropertyAssets, session) {
  const coreData = await getCoreCrmData(workspaceId, { session });
  console.log(`[PHASE3] Core module sources: ${JSON.stringify({
    propertyBuildings: coreData.moduleSources.propertyBuildings,
    propertyCostItems: coreData.moduleSources.propertyCostItems,
    propertyReservations: coreData.moduleSources.propertyReservations,
    propertyTextBlocks: coreData.moduleSources.propertyTextBlocks,
    propertyUnits: coreData.moduleSources.propertyUnits,
    sellerListings: coreData.moduleSources.sellerListings,
  }, null, 2)}`);

  for (const key of ["propertyBuildings", "propertyCostItems", "propertyReservations", "propertyTextBlocks", "propertyUnits", "sellerListings"]) {
    if (coreData.moduleSources[key] !== "database") {
      throw new Error(`Core loader for ${key} did not use database source.`);
    }
  }

  const kpis = calculateUnitKpis(coreData.propertyUnits, coreData.propertyReservations);
  const rows = [
    metricRow("Units gesamt", 5, kpis.totalUnits),
    metricRow("Frei", 2, kpis.availableUnits),
    metricRow("Reserviert", 1, kpis.reservedUnits),
    metricRow("Verkauft", 1, kpis.soldUnits),
    metricRow("Blockiert", 1, kpis.blockedUnits),
    metricRow("Gesamtverkaufswert Cent", 199000000, kpis.totalSalesValue),
    metricRow("Bestandswert nicht verkauft Cent", 154000000, kpis.inventoryValue),
    metricRow("Verkaufte Werte Cent", 45000000, kpis.soldValue),
    metricRow("Reservierungsquote Prozent", 20, kpis.reservationRatePercent),
    metricRow("Verkaufsquote Prozent", 20, kpis.salesRatePercent),
    metricRow("Aktive Reservierungen", 1, kpis.activeReservations),
  ];
  console.table(rows);
  for (const row of rows) expectEqual(row.label, row.actual, row.expected);

  const assets = buildPropertyAssets({
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
  const listingAsset = assets.find((asset) => asset.title === "UATTEST_E2E_Listing_Only_Haus");
  if (!listingAsset) throw new Error("Listing-only asset was not built by buildPropertyAssets.");
  console.log(`[PHASE3] Listing-only asset: ${JSON.stringify({
    id: listingAsset.id,
    price: listingAsset.price,
    sellerListingId: listingAsset.sellerListingId,
    title: listingAsset.title,
    unitCount: listingAsset.unitCount,
    unitIds: listingAsset.unitIds,
  }, null, 2)}`);
  expectEqual("Listing-only default-unit asset value", listingAsset.price, 640000);
  expectEqual("Listing-only unit count", listingAsset.unitCount, 1);
}

async function main() {
  const env = loadEnvFile(join(process.cwd(), ".env.local"));
  const databaseUrl = cleanDatabaseUrl(
    env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_DATABASE_URL || env.POSTGRES_PRISMA_URL,
  );
  if (!databaseUrl) throw new Error("DATABASE_URL is missing");

  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.POSTGRES_DATABASE_URL = databaseUrl;
  if (env.POSTGRES_NEON_PROJECT_ID) process.env.POSTGRES_NEON_PROJECT_ID = env.POSTGRES_NEON_PROJECT_ID;
  if (env.NEON_PROJECT_ID) process.env.NEON_PROJECT_ID = env.NEON_PROJECT_ID;

  const guard = createDatabaseGuard(env, databaseUrl);
  guard.report();

  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { createProjectRecord } = jiti("../src/lib/db/crm-write-repositories.ts");
  const { upsertContactRecord } = jiti("../src/lib/db/crm-write-repositories.ts");
  const {
    createPropertyBuildingRecord,
    createPropertyUnitRecord,
  } = jiti("../src/lib/db/property-inventory-repositories.ts");
  const {
    createSellerListingRecord,
    savePropertyCostItems,
    savePropertyTextBlocks,
    updateSellerListingRecord,
  } = jiti("../src/lib/db/property-department-repositories.ts");
  const { mutateUnitReservation } = jiti("../src/lib/db/reservation-repositories.ts");
  const { getCoreCrmData } = jiti("../src/lib/db/crm-loaders.ts");
  const { buildPropertyAssets } = jiti("../src/lib/property-department.ts");

  const pool = new Pool({ connectionString: databaseUrl });
  const session = buildSession();

  try {
    if (process.argv.includes("--cleanup-dry-run")) {
      await cleanupFixture(pool, guard, { execute: false });
      return;
    }

    if (process.argv.includes("--cleanup")) {
      await cleanupFixture(pool, guard, { execute: true });
      return;
    }

    if (process.argv.includes("--phase4")) {
      await cleanupFixture(pool, guard, { execute: true });
      try {
        runChildScript([], "phase4 object creation");
        runChildScript(["--phase3"], "phase4 KPI verification");
      } finally {
        await cleanupFixture(pool, guard, { execute: true });
      }
      console.log("[PHASE4] E2E object flow completed and cleaned up.");
      return;
    }

    if (process.argv.includes("--list")) {
      await listFixtureInventory(pool);
      return;
    }

    if (process.argv.includes("--phase3")) {
      await verifyDefaultUnitUpdateBranch(pool, guard, updateSellerListingRecord, session);
      await ensurePhase3Reservation(pool, guard, upsertContactRecord, mutateUnitReservation, session);
      await verifyPhase3Kpis(getCoreCrmData, buildPropertyAssets, session);
      await listFixtureInventory(pool);
      console.log("[PHASE3] KPI verification completed. Data intentionally remains for Phase 4 cleanup.");
      return;
    }

    await ensureNoExistingFixture(pool);

    await writeQuery(pool, guard, "create UATTEST_E2E workspace", `
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
        '{"enabledModules":{"properties":true,"units":true,"reservations":true,"projectOverview":true},"source":"UATTEST_E2E"}'::jsonb,
        'uattest-e2e-object-flow'
      )
    `, [workspaceId, workspaceName]);
    await writeQuery(pool, guard, "create UATTEST_E2E workspace owner", `
      insert into workspace_users (
        id,
        workspace_id,
        name,
        email,
        role,
        status,
        product_role
      )
      values (
        $1::uuid,
        $2::uuid,
        'UATTEST_E2E Owner',
        'uattest_e2e_owner@example.test',
        'owner',
        'active',
        'customer_owner'
      )
    `, [userId, workspaceId]);
    await readQuery(pool, "workspace + user", `
      select jsonb_build_object(
        'workspace', (select row_to_json(w) from (
          select id, name, slug, customer_type as "customerType", operating_model as "operatingModel", team_structure as "teamStructure"
          from workspaces
          where id = $1::uuid
        ) w),
        'workspaceUsers', (select jsonb_agg(row_to_json(u)) from (
          select id, name, email, role, product_role as "productRole", status
          from workspace_users
          where workspace_id = $1::uuid
          order by email
        ) u)
      ) as fixture
    `, [workspaceId]);

    const unitProject = await expectPersisted("create unit project", guard, () => createProjectRecord({
      project: {
        customerType: "property_developer",
        defaultOperatingModel: "self_service_customer",
        name: "UATTEST_E2E_Wohnpark_Units",
        setupDefaults: { source: "UATTEST_E2E", teamStructure: "project_sales_available" },
        status: "Aktiv",
        type: "Neubau Vertrieb",
      },
      session,
    }));
    const listingProject = await expectPersisted("create listing-only project", guard, () => createProjectRecord({
      project: {
        customerType: "real_estate_broker",
        defaultOperatingModel: "self_service_customer",
        name: "UATTEST_E2E_Listing_Only_Project",
        setupDefaults: { source: "UATTEST_E2E", teamStructure: "small_team" },
        status: "Aktiv",
        type: "Makler Einzelobjekt",
      },
      session,
    }));
    await readQuery(pool, "projects", `
      select id, name, type, status, customer_type as "customerType"
      from projects
      where workspace_id = $1::uuid
      order by created_at asc
    `, [workspaceId]);

    const building = await expectPersisted("create building", guard, () => createPropertyBuildingRecord({
      address: "UATTEST_E2E Projektstrasse 1, 8010 Graz",
      completionDate: "2027-12-31",
      floors: 4,
      name: "UATTEST_E2E_Bauteil_A",
      projectId: unitProject.id,
      session,
    }));
    await readQuery(pool, "property_buildings", `
      select id, project_id as "projectId", name, address, floors
      from property_buildings
      where workspace_id = $1::uuid
      order by name
    `, [workspaceId]);

    const unitA01 = await expectPersisted("create unit A-01 available", guard, () => createPropertyUnitRecord({
      areaSqm: 82,
      buildingId: building.id,
      floor: 1,
      priceCents: 30000000,
      projectId: unitProject.id,
      rooms: 3,
      session,
      status: "available",
      unitNumber: "UATTEST_E2E_A-01",
    }));
    const reservedUnit = await expectPersisted("create unit A-02 initially available", guard, () => createPropertyUnitRecord({
      areaSqm: 96,
      buildingId: building.id,
      floor: 2,
      priceCents: 35000000,
      projectId: unitProject.id,
      rooms: 4,
      session,
      status: "available",
      unitNumber: "UATTEST_E2E_A-02",
    }));
    const unitB01 = await expectPersisted("create unit B-01 sold", guard, () => createPropertyUnitRecord({
      areaSqm: 58,
      buildingId: building.id,
      floor: 1,
      priceCents: 45000000,
      projectId: unitProject.id,
      rooms: 2,
      session,
      status: "sold",
      unitNumber: "UATTEST_E2E_B-01",
    }));
    const unitB02 = await expectPersisted("create unit B-02 blocked", guard, () => createPropertyUnitRecord({
      areaSqm: 74,
      buildingId: building.id,
      floor: 3,
      priceCents: 25000000,
      projectId: unitProject.id,
      rooms: 3,
      session,
      status: "blocked",
      unitNumber: "UATTEST_E2E_B-02",
    }));
    await readQuery(pool, "property_units after creation", `
      select unit_number as "unitNumber", status, price_cents as "priceCents", metadata
      from property_units
      where workspace_id = $1::uuid and project_id = $2::uuid
      order by unit_number
    `, [workspaceId, unitProject.id]);

    const primaryListing = await expectPersisted("create primary seller listing for unit project", guard, () => createSellerListingRecord({
      property: {
        address: "UATTEST_E2E Projektstrasse 1, 8010 Graz",
        areaSqm: 310,
        city: "Graz",
        contactEmail: "uattest_e2e.sales@example.test",
        contactName: "UATTEST_E2E Vertrieb",
        contactPhone: "+430000000001",
        gdprStatus: "ready",
        marketingType: "sale",
        objectNumber: "UATTEST_E2E-UNIT-001",
        objectType: "Wohnung",
        portalMappingStatus: "mapped",
        postalCode: "8010",
        price: 1350000,
        priceVisibility: "publish_price",
        projectId: unitProject.id,
        publicPrice: 1350000,
        region: "Steiermark",
        rooms: 12,
        street: "UATTEST_E2E Projektstrasse",
        title: "UATTEST_E2E_Wohnpark_Anlage",
        yearBuilt: 2027,
      },
      session,
    }));

    await expectPersisted("save property text blocks", guard, () => savePropertyTextBlocks({
      projectId: unitProject.id,
      propertyId: primaryListing.id,
      session,
      textBlocks: [
        { channel: "expose", content: "UATTEST_E2E Expose Text fuer das Neubauprojekt.", status: "draft", textKey: "expose", title: "UATTEST_E2E Expose" },
        { channel: "website", content: "UATTEST_E2E Website Text fuer Projektseite.", status: "draft", textKey: "website", title: "UATTEST_E2E Website" },
        { channel: "portals", content: "UATTEST_E2E Portal Text fuer Export.", status: "draft", textKey: "portals", title: "UATTEST_E2E Portale" },
        { channel: "internal", content: "UATTEST_E2E Interne Notiz.", status: "draft", textKey: "internal", title: "UATTEST_E2E Intern" },
        { channel: "newsletter", content: "UATTEST_E2E Newsletter Text.", status: "draft", textKey: "newsletter", title: "UATTEST_E2E Newsletter" },
      ],
    }));
    await expectPersisted("save property cost items", guard, () => savePropertyCostItems({
      costItems: [
        { costKey: "operating_costs", groupKey: "monthly", label: "UATTEST_E2E Betriebskosten", monthlyGrossCents: 35000, vatPercent: 10 },
        { costKey: "heating_costs", groupKey: "monthly", label: "UATTEST_E2E Heizkosten", monthlyGrossCents: 12000, vatPercent: 20 },
        { costKey: "purchase_ancillary", groupKey: "one_time", label: "UATTEST_E2E Kaufnebenkosten", oneTimeGrossCents: 9000000, vatPercent: 0 },
        { commissionRelevant: true, costKey: "broker_commission", groupKey: "one_time", label: "UATTEST_E2E Provision", oneTimeGrossCents: 4860000, vatPercent: 20 },
      ],
      projectId: unitProject.id,
      propertyId: primaryListing.id,
      session,
    }));
    await readQuery(pool, "text and cost readback", `
      select jsonb_build_object(
        'textBlocks', (
          select jsonb_agg(jsonb_build_object('textKey', text_key, 'channel', channel, 'title', title) order by position)
          from property_text_blocks
          where workspace_id = $1::uuid and property_id = $2::uuid
        ),
        'costItems', (
          select jsonb_agg(jsonb_build_object('costKey', cost_key, 'groupKey', group_key, 'label', label, 'monthlyGrossCents', monthly_gross_cents, 'oneTimeGrossCents', one_time_gross_cents) order by position)
          from property_cost_items
          where workspace_id = $1::uuid and property_id = $2::uuid
        )
      ) as fixture
    `, [workspaceId, primaryListing.id]);

    const listingOnly = await expectPersisted("create listing-only property with automatic default unit", guard, () => createSellerListingRecord({
      property: {
        address: "UATTEST_E2E Gasse 12, 8010 Graz",
        areaSqm: 141,
        city: "Graz",
        contactEmail: "uattest_e2e.listing@example.test",
        contactName: "UATTEST_E2E Makler",
        gdprStatus: "ready",
        marketingType: "sale",
        objectNumber: "UATTEST_E2E-LO-001",
        objectType: "Haus",
        portalMappingStatus: "mapped",
        postalCode: "8010",
        price: 640000,
        priceVisibility: "publish_price",
        projectId: listingProject.id,
        publicPrice: 640000,
        region: "Steiermark",
        rooms: 5,
        street: "UATTEST_E2E Gasse",
        title: "UATTEST_E2E_Listing_Only_Haus",
        yearBuilt: 1998,
      },
      session,
    }));
    const defaultUnitRows = await readQuery(pool, "listing-only default unit", `
      select
        sl.id as "listingId",
        sl.title,
        sl.unit_id as "listingUnitId",
        pu.id as "unitId",
        pu.unit_number as "unitNumber",
        pu.status,
        pu.price_cents as "priceCents",
        pu.metadata
      from seller_listings sl
      left join property_units pu on pu.id = sl.unit_id and pu.workspace_id = sl.workspace_id
      where sl.workspace_id = $1::uuid and sl.id = $2::uuid
    `, [workspaceId, listingOnly.id]);
    if (!defaultUnitRows[0]?.unitId || Number(defaultUnitRows[0]?.priceCents ?? 0) !== 64000000) {
      throw new Error("Listing-only default unit was not created with the expected 64000000 cents value.");
    }

    const contact = await expectPersisted("create reservation contact", guard, () => upsertContactRecord({
      contact: {
        consent: "DSGVO ok",
        email: "uattest_e2e.reservation@example.test",
        intent: "UATTEST_E2E Reservierung pruefen",
        name: "UATTEST_E2E Reservierung Kontakt",
        phone: "+430000000002",
        projectId: unitProject.id,
        role: "Kaeufer",
        source: "UATTEST_E2E",
      },
      session,
    }));
    const reservation = await expectPersisted("create unit reservation", guard, () => mutateUnitReservation({
      input: {
        action: "create",
        contactId: contact.id,
        contractMilestone: "contract_draft",
        createTask: false,
        depositCents: 1500000,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        nextAction: "UATTEST_E2E Kaufanbot vorbereiten",
        notifyTeams: false,
        unitId: reservedUnit.id,
      },
      session,
    }), (result) => result.reservation);
    await readQuery(pool, "reservation and synced unit", `
      select jsonb_build_object(
        'reservation', (
          select row_to_json(r)
          from (
            select id, project_id as "projectId", unit_id as "unitId", contact_id as "contactId", status, deposit_cents as "depositCents", contract_milestone as "contractMilestone"
            from property_reservations
            where workspace_id = $1::uuid and id = $2::uuid
          ) r
        ),
        'unit', (
          select row_to_json(u)
          from (
            select id, unit_number as "unitNumber", status, buyer_contact_id as "buyerContactId", price_cents as "priceCents"
            from property_units
            where workspace_id = $1::uuid and id = $3::uuid
          ) u
        )
      ) as fixture
    `, [workspaceId, reservation.id, reservedUnit.id]);

    await exerciseDuplicateGuards(pool, guard, {
      primaryListing,
      reservedUnit,
      unitProject,
    });

    await listFixtureInventory(pool);

    console.log("[PHASE2] UATTEST_E2E object creation chain completed. Data intentionally remains for Phase 3.");
    console.log(`[PHASE2] Key unit ids: ${JSON.stringify({
      availableUnitId: unitA01.id,
      blockedUnitId: unitB02.id,
      listingOnlyId: listingOnly.id,
      primaryListingId: primaryListing.id,
      reservationId: reservation.id,
      reservedUnitId: reservedUnit.id,
      soldUnitId: unitB01.id,
      workspaceId,
    }, null, 2)}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
