import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const workspaceId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f201";
const propertyId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f301";
const unitId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f502";
const projectId = "8f730b7a-6f61-4a71-87c5-2e2b7eb2f202";

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
    throw new Error(`Refusing phase3 duplicate QA: active DB host is not test (${testDbHost})`);
  }
  if (!projectIdValue.includes(testDbSuffix)) {
    throw new Error(`Refusing phase3 duplicate QA: project id does not contain ${testDbSuffix}`);
  }
}

async function inspectDuplicates(pool) {
  const result = await pool.query(`
    with text_property_duplicates as (
      select workspace_id, property_id, text_key, channel, count(*)::int as count
      from property_text_blocks
      where property_id is not null and unit_id is null
      group by workspace_id, property_id, text_key, channel
      having count(*) > 1
    ),
    text_unit_duplicates as (
      select workspace_id, unit_id, text_key, channel, count(*)::int as count
      from property_text_blocks
      where unit_id is not null and property_id is null
      group by workspace_id, unit_id, text_key, channel
      having count(*) > 1
    ),
    cost_property_duplicates as (
      select workspace_id, property_id, cost_key, count(*)::int as count
      from property_cost_items
      where property_id is not null and unit_id is null
      group by workspace_id, property_id, cost_key
      having count(*) > 1
    ),
    cost_unit_duplicates as (
      select workspace_id, unit_id, cost_key, count(*)::int as count
      from property_cost_items
      where unit_id is not null and property_id is null
      group by workspace_id, unit_id, cost_key
      having count(*) > 1
    ),
    active_reservation_duplicates as (
      select workspace_id, unit_id, count(*)::int as count
      from property_reservations
      where status in ('hold', 'reserved')
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
  `);

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
        values ($1::uuid, $2::uuid, $3::uuid, null, 'uattest_phase3', 'all', 'UATTEST Phase3', 'first', '{"source":"phase3"}'::jsonb)
      `,
      values: [workspaceId, projectId, propertyId],
    },
    {
      text: `
        insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, null, 'uattest_phase3', 'all', 'UATTEST Phase3', 'second', '{"source":"phase3"}'::jsonb)
      `,
      values: [workspaceId, projectId, propertyId],
    },
  ]);

  await expectDuplicateFailure(pool, "property_text_blocks unit-only", "property_text_blocks_unit_only_uidx", [
    {
      text: `
        insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
        values ($1::uuid, $2::uuid, null, $3::uuid, 'uattest_phase3', 'all', 'UATTEST Phase3', 'first', '{"source":"phase3"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId],
    },
    {
      text: `
        insert into property_text_blocks (workspace_id, project_id, property_id, unit_id, text_key, channel, title, content, metadata)
        values ($1::uuid, $2::uuid, null, $3::uuid, 'uattest_phase3', 'all', 'UATTEST Phase3', 'second', '{"source":"phase3"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId],
    },
  ]);

  await expectDuplicateFailure(pool, "property_cost_items property-only", "property_cost_items_property_only_uidx", [
    {
      text: `
        insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, null, 'uattest_phase3', 'UATTEST Phase3', '{"source":"phase3"}'::jsonb)
      `,
      values: [workspaceId, projectId, propertyId],
    },
    {
      text: `
        insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, null, 'uattest_phase3', 'UATTEST Phase3 Duplicate', '{"source":"phase3"}'::jsonb)
      `,
      values: [workspaceId, projectId, propertyId],
    },
  ]);

  await expectDuplicateFailure(pool, "property_cost_items unit-only", "property_cost_items_unit_only_uidx", [
    {
      text: `
        insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
        values ($1::uuid, $2::uuid, null, $3::uuid, 'uattest_phase3', 'UATTEST Phase3', '{"source":"phase3"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId],
    },
    {
      text: `
        insert into property_cost_items (workspace_id, project_id, property_id, unit_id, cost_key, label, metadata)
        values ($1::uuid, $2::uuid, null, $3::uuid, 'uattest_phase3', 'UATTEST Phase3 Duplicate', '{"source":"phase3"}'::jsonb)
      `,
      values: [workspaceId, projectId, unitId],
    },
  ]);

  const reservationTarget = await pool.query(
    `
      select pu.id as unit_id, pu.project_id, c.id as contact_id
      from property_units pu
      join contacts c on c.workspace_id = pu.workspace_id and c.project_id = pu.project_id
      where pu.workspace_id = $1::uuid
        and not exists (
          select 1
          from property_reservations pr
          where pr.workspace_id = pu.workspace_id
            and pr.unit_id = pu.id
            and pr.status in ('hold', 'reserved')
        )
      order by pu.unit_number asc, pu.id asc
      limit 1
    `,
    [workspaceId],
  );
  const target = reservationTarget.rows[0];
  if (!target) throw new Error("No property unit without active reservation found for reservation duplicate guard test.");

  await expectDuplicateFailure(pool, "property_reservations one active per unit", "property_reservations_one_active_per_unit_idx", [
    {
      text: `
        insert into property_reservations (workspace_id, project_id, unit_id, contact_id, deal_id, status, expires_at, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 'reserved', now() + interval '7 days', '{"source":"phase3_reservation_guard"}'::jsonb)
      `,
      values: [workspaceId, target.project_id, target.unit_id, target.contact_id],
    },
    {
      text: `
        insert into property_reservations (workspace_id, project_id, unit_id, contact_id, deal_id, status, expires_at, metadata)
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 'hold', now() + interval '7 days', '{"source":"phase3_reservation_guard_duplicate"}'::jsonb)
      `,
      values: [workspaceId, target.project_id, target.unit_id, target.contact_id],
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
    const duplicates = await inspectDuplicates(pool);
    if (duplicateCount(duplicates) > 0) {
      throw new Error("Existing duplicate rows found. Do not apply unique indexes until Franz gives cleanup GO.");
    }
    if (process.argv.includes("--exercise")) {
      await exerciseDuplicateGuards(pool);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
