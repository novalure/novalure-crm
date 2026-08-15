import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const marker = "QADUPGUARD_";

const workspaceId = "9a8d3333-3333-4333-8333-333333333301";
const projectId = "9a8d3333-3333-4333-8333-333333333302";
const propertyId = "9a8d3333-3333-4333-8333-333333333303";
const unitId = "9a8d3333-3333-4333-8333-333333333304";
const contactId = "9a8d3333-3333-4333-8333-333333333305";
const userId = "9a8d3333-3333-4333-8333-333333333306";

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
    throw new Error(`Refusing duplicate guard QA: active DB host is not test (${testDbHost})`);
  }
  if (!projectIdValue.includes(testDbSuffix)) {
    throw new Error(`Refusing duplicate guard QA: project id does not contain ${testDbSuffix}`);
  }
}

async function cleanup(pool) {
  await pool.query("delete from workspaces where id = $1::uuid", [workspaceId]);
}

async function countMarkerRests(pool) {
  const result = await pool.query(
    `
      select jsonb_build_object(
        'workspaces', (select count(*)::int from workspaces where id = $1::uuid or name like $2),
        'workspaceUsers', (select count(*)::int from workspace_users where workspace_id = $1::uuid or name like $2 or email like $3),
        'projects', (select count(*)::int from projects where workspace_id = $1::uuid or name like $2),
        'contacts', (select count(*)::int from contacts where workspace_id = $1::uuid or name like $2 or source like $2),
        'sellerListings', (select count(*)::int from seller_listings where workspace_id = $1::uuid or title like $2 or object_number like $2),
        'propertyUnits', (select count(*)::int from property_units where workspace_id = $1::uuid or unit_number like $2),
        'propertyTextBlocks', (select count(*)::int from property_text_blocks where workspace_id = $1::uuid or title like $2 or text_key like $2),
        'propertyCostItems', (select count(*)::int from property_cost_items where workspace_id = $1::uuid or label like $2 or cost_key like $2),
        'propertyReservations', (select count(*)::int from property_reservations where workspace_id = $1::uuid)
      ) as counts
    `,
    [workspaceId, `${marker}%`, `%${marker}%`],
  );
  return result.rows[0]?.counts ?? {};
}

function countTotal(counts) {
  return Object.values(counts).reduce((sum, value) => sum + Number(value ?? 0), 0);
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
        'QADUPGUARD_Phase3_Workspace',
        'Growth Workspace',
        'self_service_customer',
        'property_developer',
        'project_sales_available',
        '{"enabledModules":{"properties":true,"units":true,"reservations":true},"source":"QADUPGUARD"}'::jsonb,
        'qadupguard-phase3-workspace'
      )
    `,
    [workspaceId],
  );

  await pool.query(
    `
      insert into workspace_users (id, workspace_id, name, email, role, status, product_role)
      values ($1::uuid, $2::uuid, 'QADUPGUARD Owner', 'qadupguard.owner@example.test', 'owner', 'active', 'customer_owner')
    `,
    [userId, workspaceId],
  );

  await pool.query(
    `
      insert into projects (id, workspace_id, name, type, status, customer_type, default_operating_model, setup_defaults)
      values ($1::uuid, $2::uuid, 'QADUPGUARD Duplicate Guard Project', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"QADUPGUARD"}'::jsonb)
    `,
    [projectId, workspaceId],
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
        city,
        postal_code,
        street,
        object_number,
        marketing_type,
        public_price_cents,
        gdpr_status,
        portal_mapping_status,
        canonical_payload
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'QADUPGUARD Listing',
        'QADUPGUARD Strasse 1, 8010 Graz',
        'Steiermark',
        'Wohnung',
        82,
        3,
        2026,
        30000000,
        30000000,
        'Graz',
        '8010',
        'QADUPGUARD Strasse',
        'QADUPGUARD-LISTING-001',
        'sale',
        30000000,
        'ready',
        'mapped',
        '{"source":"QADUPGUARD"}'::jsonb
      )
    `,
    [propertyId, workspaceId, projectId],
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
      values ($1::uuid, $2::uuid, $3::uuid, 'QADUPGUARD-A-01', 1, 3, 82, 30000000, 'available', '{"source":"QADUPGUARD"}'::jsonb)
    `,
    [unitId, workspaceId, projectId],
  );

  await pool.query(
    `
      insert into contacts (id, workspace_id, project_id, name, role, source, intent, consent_label, email, metadata)
      values ($1::uuid, $2::uuid, $3::uuid, 'QADUPGUARD Reservation Contact', 'Kaeufer', 'QADUPGUARD', 'Duplicate guard reservation', 'DSGVO ok', 'qadupguard.contact@example.test', '{"source":"QADUPGUARD"}'::jsonb)
    `,
    [contactId, workspaceId, projectId],
  );

  console.log("Seeded QADUPGUARD duplicate guard fixture.");
}

async function inspectDuplicates(pool) {
  const result = await pool.query(
    `
      with text_property_duplicates as (
        select workspace_id, property_id, text_key, channel, count(*)::int as count
        from property_text_blocks
        where workspace_id = $1::uuid and property_id is not null and unit_id is null
        group by workspace_id, property_id, text_key, channel
        having count(*) > 1
      ),
      text_unit_duplicates as (
        select workspace_id, unit_id, text_key, channel, count(*)::int as count
        from property_text_blocks
        where workspace_id = $1::uuid and unit_id is not null and property_id is null
        group by workspace_id, unit_id, text_key, channel
        having count(*) > 1
      ),
      cost_property_duplicates as (
        select workspace_id, property_id, cost_key, count(*)::int as count
        from property_cost_items
        where workspace_id = $1::uuid and property_id is not null and unit_id is null
        group by workspace_id, property_id, cost_key
        having count(*) > 1
      ),
      cost_unit_duplicates as (
        select workspace_id, unit_id, cost_key, count(*)::int as count
        from property_cost_items
        where workspace_id = $1::uuid and unit_id is not null and property_id is null
        group by workspace_id, unit_id, cost_key
        having count(*) > 1
      ),
      active_reservation_duplicates as (
        select workspace_id, unit_id, count(*)::int as count
        from property_reservations
        where workspace_id = $1::uuid and status in ('hold', 'reserved')
        group by workspace_id, unit_id
        having count(*) > 1
      )
      select jsonb_build_object(
        'textPropertyDuplicates', coalesce((select jsonb_agg(text_property_duplicates) from text_property_duplicates), '[]'::jsonb),
        'textUnitDuplicates', coalesce((select jsonb_agg(text_unit_duplicates) from text_unit_duplicates), '[]'::jsonb),
        'costPropertyDuplicates', coalesce((select jsonb_agg(cost_property_duplicates) from cost_property_duplicates), '[]'::jsonb),
        'costUnitDuplicates', coalesce((select jsonb_agg(cost_unit_duplicates) from cost_unit_duplicates), '[]'::jsonb),
        'activeReservationDuplicates', coalesce((select jsonb_agg(active_reservation_duplicates) from active_reservation_duplicates), '[]'::jsonb)
      ) as duplicates
    `,
    [workspaceId],
  );

  const duplicates = result.rows[0]?.duplicates ?? {};
  console.log(JSON.stringify({ duplicates }, null, 2));
  return duplicates;
}

function duplicateCount(duplicates) {
  return Object.values(duplicates).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
}

async function expectDuplicateFailure(pool, name, expectedConstraint, statements) {
  await pool.query("begin");
  try {
    await pool.query(statements[0]);
    await pool.query(statements[1]);
    throw new Error(`${name}: duplicate insert unexpectedly succeeded`);
  } catch (error) {
    if (error?.code !== "23505") {
      throw error;
    }
    if (error.constraint !== expectedConstraint) {
      throw new Error(`${name}: expected ${expectedConstraint}, got ${error.constraint}`);
    }
    console.log(`${name}: duplicate blocked by unique index (${error.constraint})`);
  } finally {
    await pool.query("rollback");
  }
}

async function exerciseDuplicateGuards(pool) {
  await expectDuplicateFailure(pool, "property_text_blocks property-only", "property_text_blocks_property_only_uidx", [
    {
      text: `
        insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, null, 'QADUPGUARD_text_property', 'all', 'QADUPGUARD Property Text', 'first', '{"source":"QADUPGUARD"}'::jsonb)
      `,
      values: [workspaceId, projectId, propertyId],
    },
    {
      text: `
        insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, null, 'QADUPGUARD_text_property', 'all', 'QADUPGUARD Property Text', 'second', '{"source":"QADUPGUARD"}'::jsonb)
      `,
      values: [workspaceId, projectId, propertyId],
    },
  ]);

  await expectDuplicateFailure(pool, "property_text_blocks unit-only", "property_text_blocks_unit_only_uidx", [
    {
      text: `
        insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
        values ($1::uuid, $2::uuid, null, $3::uuid, 'QADUPGUARD_text_unit', 'all', 'QADUPGUARD Unit Text', 'first', '{"source":"QADUPGUARD"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId],
    },
    {
      text: `
        insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
        values ($1::uuid, $2::uuid, null, $3::uuid, 'QADUPGUARD_text_unit', 'all', 'QADUPGUARD Unit Text', 'second', '{"source":"QADUPGUARD"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId],
    },
  ]);

  await expectDuplicateFailure(pool, "property_cost_items property-only", "property_cost_items_property_only_uidx", [
    {
      text: `
        insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, null, 'QADUPGUARD_cost_property', 'QADUPGUARD Property Cost', '{"source":"QADUPGUARD"}'::jsonb)
      `,
      values: [workspaceId, projectId, propertyId],
    },
    {
      text: `
        insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, null, 'QADUPGUARD_cost_property', 'QADUPGUARD Property Cost Duplicate', '{"source":"QADUPGUARD"}'::jsonb)
      `,
      values: [workspaceId, projectId, propertyId],
    },
  ]);

  await expectDuplicateFailure(pool, "property_cost_items unit-only", "property_cost_items_unit_only_uidx", [
    {
      text: `
        insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
        values ($1::uuid, $2::uuid, null, $3::uuid, 'QADUPGUARD_cost_unit', 'QADUPGUARD Unit Cost', '{"source":"QADUPGUARD"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId],
    },
    {
      text: `
        insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
        values ($1::uuid, $2::uuid, null, $3::uuid, 'QADUPGUARD_cost_unit', 'QADUPGUARD Unit Cost Duplicate', '{"source":"QADUPGUARD"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId],
    },
  ]);

  await expectDuplicateFailure(pool, "property_reservations one active per unit", "property_reservations_one_active_per_unit_idx", [
    {
      text: `
        insert into property_reservations (workspace_id, project_id, unit_id, contact_id, deal_id, status, expires_at, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 'reserved', now() + interval '7 days', '{"source":"QADUPGUARD","purpose":"first"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId, contactId],
    },
    {
      text: `
        insert into property_reservations (workspace_id, project_id, unit_id, contact_id, deal_id, status, expires_at, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 'hold', now() + interval '7 days', '{"source":"QADUPGUARD","purpose":"duplicate"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId, contactId],
    },
  ]);
}

async function main() {
  const env = loadEnvFile(join(process.cwd(), ".env.local"));
  const databaseUrl = cleanDatabaseUrl(
    env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_DATABASE_URL || env.POSTGRES_PRISMA_URL,
  );
  if (!databaseUrl) throw new Error("DATABASE_URL is missing");
  assertTestDatabase(env, databaseUrl);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await seed(pool);
    const duplicates = await inspectDuplicates(pool);
    assert.equal(duplicateCount(duplicates), 0, "Fixture must start without duplicate rows.");
    await exerciseDuplicateGuards(pool);
  } finally {
    await cleanup(pool);
    const remaining = await countMarkerRests(pool);
    console.log("QADUPGUARD cleanup check");
    console.log(JSON.stringify(remaining, null, 2));
    assert.equal(countTotal(remaining), 0, `QADUPGUARD cleanup left rows: ${JSON.stringify(remaining)}`);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
