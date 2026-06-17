import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const workspaceId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f201";
const unitProjectId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f202";
const listingProjectId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f203";
const joinProjectId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f204";
const listingOnlyId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f301";
const reservedContactId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f401";
const reservedUnitId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f502";
const reservedDealId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f602";

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
    throw new Error(`Refusing to write/read phase2 UAT data: active DB host is not test (${testDbHost})`);
  }
  if (!projectId.includes(testDbSuffix)) {
    throw new Error(`Refusing to write/read phase2 UAT data: project id does not contain ${testDbSuffix}`);
  }
}

async function seed(pool) {
  await pool.query("delete from workspaces where id = $1::uuid", [workspaceId]);
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
      $1,
      'UATTEST_Phase2_Property_KPI',
      'Growth Workspace',
      'self_service_customer',
      'property_developer',
      'small_team',
      '{"enabledModules":{"properties":true,"units":true,"reservations":true,"projectOverview":true}}'::jsonb,
      'uattest-phase2-property-kpi'
    )
  `,
    [workspaceId],
  );

  await pool.query(
    `
    insert into projects (id, workspace_id, name, type, status, customer_type, default_operating_model, setup_defaults)
    values
      ($1, $4, 'UATTEST Phase2 Wohnpark Units', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"phase2"}'::jsonb),
      ($2, $4, 'UATTEST Phase2 Listing Only', 'Makler Einzelobjekt', 'Aktiv', 'real_estate_broker', 'self_service_customer', '{"source":"phase2"}'::jsonb),
      ($3, $4, 'UATTEST Phase2 Multi Lead Revenue', 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"phase2"}'::jsonb)
  `,
    [unitProjectId, listingProjectId, joinProjectId, workspaceId],
  );

  await pool.query(
    `
    insert into contacts (id, workspace_id, project_id, name, role, source, intent, consent_label, email, metadata)
    values
      ($1, $2, $3, 'UATTEST Phase2 Reservierung Kontakt', 'Käufer', 'UATTEST Phase2', 'Reservierung prüfen', 'DSGVO ok', 'phase2.reservierung@example.test', '{"source":"phase2"}'::jsonb)
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
      ('8f730b7a-6f61-4a71-87c5-2e2b7eb2f501', $1, $2, 'A-01', 1, 3, 82, 30000000, 'available', '{"source":"phase2","expected":"available"}'::jsonb),
      ($3, $1, $2, 'A-02', 2, 4, 96, 35000000, 'reserved', '{"source":"phase2","expected":"reserved"}'::jsonb),
      ('8f730b7a-6f61-4a71-87c5-2e2b7eb2f503', $1, $2, 'B-01', 1, 2, 58, 45000000, 'sold', '{"source":"phase2","expected":"sold"}'::jsonb),
      ('8f730b7a-6f61-4a71-87c5-2e2b7eb2f504', $1, $2, 'B-02', 3, 3, 74, 25000000, 'blocked', '{"source":"phase2","expected":"blocked"}'::jsonb)
  `,
    [workspaceId, unitProjectId, reservedUnitId],
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
      ($1, $2, $3, $4, 'UATTEST Phase2 Reservierung A-02', 'Reservierung', 35000000, 70, 'mittel', 'UATTEST Phase2', '{"source":"phase2","purpose":"reservation"}'::jsonb),
      ('8f730b7a-6f61-4a71-87c5-2e2b7eb2f611', $2, $5, null, 'UATTEST Join Deal 500k', 'Qualifiziert', 50000000, 50, 'mittel', 'UATTEST Phase2', '{"source":"phase2","purpose":"join-revenue"}'::jsonb),
      ('8f730b7a-6f61-4a71-87c5-2e2b7eb2f612', $2, $5, null, 'UATTEST Join Deal 200k', 'Angebot', 20000000, 60, 'mittel', 'UATTEST Phase2', '{"source":"phase2","purpose":"join-revenue"}'::jsonb)
  `,
    [reservedDealId, workspaceId, unitProjectId, reservedContactId, joinProjectId],
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
      '8f730b7a-6f61-4a71-87c5-2e2b7eb2f701',
      $1,
      $2,
      $3,
      $4,
      $5,
      'reserved',
      now() + interval '14 days',
      1500000,
      'contract_draft',
      'UATTEST Kaufanbot vorbereiten',
      '{"source":"phase2"}'::jsonb
    )
  `,
    [workspaceId, unitProjectId, reservedUnitId, reservedContactId, reservedDealId],
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
      $1,
      $2,
      $3,
      'UATTEST Phase2 Einfamilienhaus Listing Only',
      'UATTEST Gasse 12, 8010 Graz',
      'Steiermark',
      'Haus',
      141,
      5,
      1998,
      62000000,
      64000000,
      'Graz',
      '8010',
      'UATTEST Gasse',
      'UATTEST-PH2-LO-001',
      'sale',
      64000000,
      'needs_review',
      'needs_review',
      '{"source":"phase2","purpose":"default-unit-before-code","explicitUnits":false}'::jsonb
    )
  `,
    [listingOnlyId, workspaceId, listingProjectId],
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
      ('8f730b7a-6f61-4a71-87c5-2e2b7eb2f801', $1, $2, 'UATTEST Phase2', 'Käufer', 'Neu', 86, 'Join-Test Lead 1', 'Steiermark', true, '{"source":"phase2","purpose":"join-revenue"}'::jsonb),
      ('8f730b7a-6f61-4a71-87c5-2e2b7eb2f802', $1, $2, 'UATTEST Phase2', 'Käufer', 'Qualifiziert', 72, 'Join-Test Lead 2', 'Steiermark', false, '{"source":"phase2","purpose":"join-revenue"}'::jsonb),
      ('8f730b7a-6f61-4a71-87c5-2e2b7eb2f803', $1, $2, 'UATTEST Phase2', 'Investor', 'Neu', 64, 'Join-Test Lead 3', 'Steiermark', false, '{"source":"phase2","purpose":"join-revenue"}'::jsonb)
  `,
    [workspaceId, joinProjectId],
  );

  console.log("Seeded UATTEST_Phase2_Property_KPI workspace and fixture data.");
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
    reservationRate: result.unit_kpis.total_units
      ? result.unit_kpis.reserved_units / result.unit_kpis.total_units
      : 0,
    salesRate: result.unit_kpis.total_units ? result.unit_kpis.sold_units / result.unit_kpis.total_units : 0,
  };
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
    if (process.argv.includes("--seed")) await seed(pool);
    await measure(pool);
    if (process.argv.includes("--list")) await listFixtures(pool);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
