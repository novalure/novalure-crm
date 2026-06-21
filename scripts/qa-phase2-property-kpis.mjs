import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const marker = "QAKPI_";

const workspaceId = "9a8d1111-1111-4111-8111-111111111111";
const unitProjectId = "9a8d1111-1111-4111-8111-111111111202";
const listingProjectId = "9a8d1111-1111-4111-8111-111111111203";
const joinProjectId = "9a8d1111-1111-4111-8111-111111111204";
const listingOnlyId = "9a8d1111-1111-4111-8111-111111111301";
const reservedContactId = "9a8d1111-1111-4111-8111-111111111401";
const availableUnitId = "9a8d1111-1111-4111-8111-111111111501";
const reservedUnitId = "9a8d1111-1111-4111-8111-111111111502";
const soldUnitId = "9a8d1111-1111-4111-8111-111111111503";
const blockedUnitId = "9a8d1111-1111-4111-8111-111111111504";
const listingDefaultUnitId = "9a8d1111-1111-4111-8111-111111111505";
const reservedDealId = "9a8d1111-1111-4111-8111-111111111602";
const joinDealOneId = "9a8d1111-1111-4111-8111-111111111611";
const joinDealTwoId = "9a8d1111-1111-4111-8111-111111111612";
const reservationId = "9a8d1111-1111-4111-8111-111111111701";
const joinLeadOneId = "9a8d1111-1111-4111-8111-111111111801";
const joinLeadTwoId = "9a8d1111-1111-4111-8111-111111111802";
const joinLeadThreeId = "9a8d1111-1111-4111-8111-111111111803";

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
  const projectId = env.POSTGRES_NEON_PROJECT_ID || env.NEON_PROJECT_ID || "";
  console.log(`Active DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);
  console.log(`Active DB host: ${parsed.hostname}`);
  console.log(`Project ID suffix verified: ${projectId ? "***" + projectId.slice(-8) : "missing"}`);
  if (parsed.hostname !== testDbHost) {
    throw new Error(`Refusing phase2 KPI QA: active DB host is not test (${testDbHost})`);
  }
  if (!projectId.includes(testDbSuffix)) {
    throw new Error(`Refusing phase2 KPI QA: project id does not contain ${testDbSuffix}`);
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
        'projects', (select count(*)::int from projects where workspace_id = $1::uuid or name like $2),
        'contacts', (select count(*)::int from contacts where workspace_id = $1::uuid or name like $2 or source like $2),
        'deals', (select count(*)::int from deals where workspace_id = $1::uuid or name like $2 or source like $2),
        'leads', (select count(*)::int from leads where workspace_id = $1::uuid or source like $2 or intent like $2),
        'sellerListings', (select count(*)::int from seller_listings where workspace_id = $1::uuid or title like $2 or object_number like $2),
        'propertyUnits', (select count(*)::int from property_units where workspace_id = $1::uuid or unit_number like $2),
        'propertyReservations', (select count(*)::int from property_reservations where workspace_id = $1::uuid)
      ) as counts
    `,
    [workspaceId, `${marker}%`],
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
        'QAKPI_Phase2_Property_KPI',
        'Growth Workspace',
        'self_service_customer',
        'property_developer',
        'small_team',
        '{"enabledModules":{"properties":true,"units":true,"reservations":true,"projectOverview":true},"source":"QAKPI"}'::jsonb,
        'qakpi-phase2-property-kpi'
      )
    `,
    [workspaceId],
  );

  await pool.query(
    `
      insert into projects (id, workspace_id, name, type, status, customer_type, default_operating_model, setup_defaults)
      values
        ($1::uuid, $4::uuid, 'QAKPI Phase2 Wohnpark Units', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"QAKPI"}'::jsonb),
        ($2::uuid, $4::uuid, 'QAKPI Phase2 Listing Only', 'Makler Einzelobjekt', 'Aktiv', 'real_estate_broker', 'self_service_customer', '{"source":"QAKPI"}'::jsonb),
        ($3::uuid, $4::uuid, 'QAKPI Phase2 Multi Lead Revenue', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"QAKPI"}'::jsonb)
    `,
    [unitProjectId, listingProjectId, joinProjectId, workspaceId],
  );

  await pool.query(
    `
      insert into contacts (id, workspace_id, project_id, name, role, source, intent, consent_label, email, metadata)
      values ($1::uuid, $2::uuid, $3::uuid, 'QAKPI Phase2 Reservierung Kontakt', 'Kaeufer', 'QAKPI Phase2', 'Reservierung pruefen', 'DSGVO ok', 'qakpi.phase2.reservierung@example.test', '{"source":"QAKPI"}'::jsonb)
    `,
    [reservedContactId, workspaceId, unitProjectId],
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
        ($3::uuid, $1::uuid, $2::uuid, 'A-01', 1, 3, 82, 30000000, 'available', '{"source":"QAKPI","expected":"available"}'::jsonb),
        ($4::uuid, $1::uuid, $2::uuid, 'A-02', 2, 4, 96, 35000000, 'reserved', '{"source":"QAKPI","expected":"reserved"}'::jsonb),
        ($5::uuid, $1::uuid, $2::uuid, 'B-01', 1, 2, 58, 45000000, 'sold', '{"source":"QAKPI","expected":"sold"}'::jsonb),
        ($6::uuid, $1::uuid, $2::uuid, 'B-02', 3, 3, 74, 25000000, 'blocked', '{"source":"QAKPI","expected":"blocked"}'::jsonb),
        ($7::uuid, $1::uuid, $8::uuid, 'DEFAULT-9A8D11111111', 0, 5, 141, 64000000, 'available', '{"source":"QAKPI","defaultUnit":true,"hidden":true,"sellerListingId":"9a8d1111-1111-4111-8111-111111111301"}'::jsonb)
    `,
    [
      workspaceId,
      unitProjectId,
      availableUnitId,
      reservedUnitId,
      soldUnitId,
      blockedUnitId,
      listingDefaultUnitId,
      listingProjectId,
    ],
  );

  await pool.query(
    `
      insert into deals (
        id,
        workspace_id,
        project_id,
        contact_id,
        name,
        stage,
        value_cents,
        probability,
        risk_level,
        source,
        metadata
      )
      values
        ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'QAKPI Phase2 Reservierung A-02', 'Reservierung', 35000000, 70, 'mittel', 'QAKPI Phase2', '{"source":"QAKPI","purpose":"reservation"}'::jsonb),
        ($6::uuid, $2::uuid, $5::uuid, null, 'QAKPI Join Deal 500k', 'Qualifiziert', 50000000, 50, 'mittel', 'QAKPI Phase2', '{"source":"QAKPI","purpose":"join-revenue"}'::jsonb),
        ($7::uuid, $2::uuid, $5::uuid, null, 'QAKPI Join Deal 200k', 'Angebot', 20000000, 60, 'mittel', 'QAKPI Phase2', '{"source":"QAKPI","purpose":"join-revenue"}'::jsonb)
    `,
    [reservedDealId, workspaceId, unitProjectId, reservedContactId, joinProjectId, joinDealOneId, joinDealTwoId],
  );

  await pool.query(
    `
      insert into property_reservations (
        id,
        workspace_id,
        project_id,
        unit_id,
        contact_id,
        deal_id,
        status,
        expires_at,
        deposit_cents,
        contract_milestone,
        next_action,
        metadata
      )
      values (
        $6::uuid,
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        'reserved',
        now() + interval '14 days',
        1500000,
        'contract_draft',
        'QAKPI Kaufanbot vorbereiten',
        '{"source":"QAKPI"}'::jsonb
      )
    `,
    [workspaceId, unitProjectId, reservedUnitId, reservedContactId, reservedDealId, reservationId],
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
        unit_id,
        canonical_payload
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'QAKPI Phase2 Einfamilienhaus Listing Only',
        'QAKPI Gasse 12, 8010 Graz',
        'Steiermark',
        'Haus',
        141,
        5,
        1998,
        62000000,
        64000000,
        'Graz',
        '8010',
        'QAKPI Gasse',
        'QAKPI-PH2-LO-001',
        'sale',
        64000000,
        'needs_review',
        'needs_review',
        $4::uuid,
        '{"source":"QAKPI","purpose":"default-unit-before-code","explicitUnits":false,"defaultUnitId":"9a8d1111-1111-4111-8111-111111111505"}'::jsonb
      )
    `,
    [listingOnlyId, workspaceId, listingProjectId, listingDefaultUnitId],
  );

  await pool.query(
    `
      insert into leads (
        id,
        workspace_id,
        project_id,
        source,
        type,
        status,
        score,
        intent,
        region,
        hot_status,
        metadata
      )
      values
        ($3::uuid, $1::uuid, $2::uuid, 'QAKPI Phase2', 'Kaeufer', 'Neu', 86, 'Join-Test Lead 1', 'Steiermark', true, '{"source":"QAKPI","purpose":"join-revenue"}'::jsonb),
        ($4::uuid, $1::uuid, $2::uuid, 'QAKPI Phase2', 'Kaeufer', 'Qualifiziert', 72, 'Join-Test Lead 2', 'Steiermark', false, '{"source":"QAKPI","purpose":"join-revenue"}'::jsonb),
        ($5::uuid, $1::uuid, $2::uuid, 'QAKPI Phase2', 'Investor', 'Neu', 64, 'Join-Test Lead 3', 'Steiermark', false, '{"source":"QAKPI","purpose":"join-revenue"}'::jsonb)
    `,
    [workspaceId, joinProjectId, joinLeadOneId, joinLeadTwoId, joinLeadThreeId],
  );

  console.log("Seeded QAKPI_Phase2_Property_KPI workspace and fixture data.");
}

async function measure(pool) {
  const rows = await pool.query(
    `
      with unit_scope as (
        select *
        from property_units
        where workspace_id = $1::uuid
      ),
      unit_kpis as (
        select
          count(*)::int as total_units,
          count(*) filter (where status = 'available')::int as available_units,
          count(*) filter (where status = 'reserved')::int as reserved_units,
          count(*) filter (where status = 'sold')::int as sold_units,
          count(*) filter (where status = 'blocked')::int as blocked_units,
          coalesce(sum(price_cents), 0)::bigint as total_sales_value_cents,
          coalesce(sum(price_cents) filter (where status <> 'sold'), 0)::bigint as inventory_value_cents,
          coalesce(sum(price_cents) filter (where status = 'sold'), 0)::bigint as sold_value_cents
        from unit_scope
      ),
      reservation_kpis as (
        select count(*)::int as active_reservations
        from property_reservations
        where workspace_id = $1::uuid and status in ('hold', 'reserved')
      ),
      listing_only as (
        select
          sl.id,
          sl.title,
          sl.project_id,
          sl.unit_id,
          count(pu.id)::int as project_unit_count,
          coalesce(sum(pu.price_cents), 0)::bigint as project_unit_value_cents
        from seller_listings sl
        left join property_units pu on pu.workspace_id = sl.workspace_id and pu.project_id = sl.project_id
        where sl.id = $2::uuid and sl.workspace_id = $1::uuid
        group by sl.id
      ),
      join_project as (
        select
          p.id,
          count(distinct l.id)::int as lead_count,
          coalesce(sum(case when d.stage not in ('Gewonnen', 'Verloren', 'Disqualifiziert') then d.value_cents else 0 end), 0)::bigint as legacy_multiplied_revenue_cents
        from projects p
        left join leads l on l.project_id = p.id and l.workspace_id = p.workspace_id
        left join deals d on d.project_id = p.id and d.workspace_id = p.workspace_id
        where p.id = $3::uuid and p.workspace_id = $1::uuid
        group by p.id
      ),
      join_project_correct as (
        select
          coalesce(sum(value_cents), 0)::bigint as fixed_loader_revenue_cents,
          count(*)::int as deal_count
        from deals
        where workspace_id = $1::uuid
          and project_id = $3::uuid
          and stage not in ('Gewonnen', 'Verloren', 'Disqualifiziert')
      )
      select
        row_to_json(unit_kpis) as unit_kpis,
        row_to_json(reservation_kpis) as reservation_kpis,
        row_to_json(listing_only) as listing_only,
        row_to_json(join_project) as join_project,
        row_to_json(join_project_correct) as join_project_correct
      from unit_kpis, reservation_kpis, listing_only, join_project, join_project_correct
    `,
    [workspaceId, listingOnlyId, joinProjectId],
  );

  const result = rows.rows[0];
  const data = {
    workspaceId,
    unitProjectId,
    listingProjectId,
    joinProjectId,
    listingOnlyId,
    ...result,
    reservationRate: Number(result.unit_kpis.total_units)
      ? Number(result.unit_kpis.reserved_units) / Number(result.unit_kpis.total_units)
      : 0,
    salesRate: Number(result.unit_kpis.total_units)
      ? Number(result.unit_kpis.sold_units) / Number(result.unit_kpis.total_units)
      : 0,
  };

  assert.equal(Number(result.unit_kpis.total_units), 5);
  assert.equal(Number(result.unit_kpis.available_units), 2);
  assert.equal(Number(result.unit_kpis.reserved_units), 1);
  assert.equal(Number(result.unit_kpis.sold_units), 1);
  assert.equal(Number(result.unit_kpis.blocked_units), 1);
  assert.equal(Number(result.unit_kpis.total_sales_value_cents), 199000000);
  assert.equal(Number(result.unit_kpis.inventory_value_cents), 154000000);
  assert.equal(Number(result.unit_kpis.sold_value_cents), 45000000);
  assert.equal(Number(result.reservation_kpis.active_reservations), 1);
  assert.equal(Number(result.listing_only.project_unit_count), 1);
  assert.equal(Number(result.listing_only.project_unit_value_cents), 64000000);
  assert.equal(result.listing_only.unit_id, listingDefaultUnitId);
  assert.equal(Number(result.join_project.lead_count), 3);
  assert.equal(Number(result.join_project.legacy_multiplied_revenue_cents), 210000000);
  assert.equal(Number(result.join_project_correct.fixed_loader_revenue_cents), 70000000);
  assert.equal(Number(result.join_project_correct.deal_count), 2);
  assert.equal(data.reservationRate, 0.2);
  assert.equal(data.salesRate, 0.2);

  console.log(JSON.stringify(data, null, 2));
}

async function listFixtures(pool) {
  const result = await pool.query(
    `
      select jsonb_build_object(
        'workspaces',
        (
          select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'slug', slug) order by name)
          from workspaces
          where id = $1::uuid
        ),
        'projects',
        (
          select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'type', type) order by name)
          from projects
          where workspace_id = $1::uuid
        ),
        'sellerListings',
        (
          select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'projectId', project_id, 'unitId', unit_id) order by title)
          from seller_listings
          where workspace_id = $1::uuid
        ),
        'propertyUnits',
        (
          select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'unitNumber', unit_number, 'status', status, 'priceCents', price_cents, 'metadata', metadata) order by unit_number)
          from property_units
          where workspace_id = $1::uuid
        ),
        'propertyReservations',
        (
          select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'unitId', unit_id, 'status', status, 'depositCents', deposit_cents) order by id)
          from property_reservations
          where workspace_id = $1::uuid
        ),
        'leads',
        (
          select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'type', type, 'status', status, 'score', score, 'hotStatus', hot_status) order by id)
          from leads
          where workspace_id = $1::uuid
        ),
        'deals',
        (
          select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'name', name, 'stage', stage, 'valueCents', value_cents, 'probability', probability) order by name)
          from deals
          where workspace_id = $1::uuid
        )
      ) as fixtures
    `,
    [workspaceId],
  );
  console.log(JSON.stringify({ fixtures: result.rows[0]?.fixtures ?? {} }, null, 2));
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
    await measure(pool);
    if (process.argv.includes("--list")) await listFixtures(pool);
  } finally {
    await cleanup(pool);
    const remaining = await countMarkerRests(pool);
    console.log("QAKPI cleanup check");
    console.log(JSON.stringify(remaining, null, 2));
    assert.equal(countTotal(remaining), 0, `QAKPI cleanup left rows: ${JSON.stringify(remaining)}`);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
