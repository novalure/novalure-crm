import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { Pool } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const marker = "GOLIVETEST_STAGEFIX_";

const workspaceId = "7f610000-0000-4000-8000-000000000001";
const userId = "7f610000-0000-4000-8000-000000000002";
const realEstateProjectId = "7f610000-0000-4000-8000-000000000101";
const growthProjectId = "7f610000-0000-4000-8000-000000000102";
const missingStageProjectId = "7f610000-0000-4000-8000-000000000103";
const defaultPipelineProjectId = "7f610000-0000-4000-8000-000000000104";
const realEstatePipelineId = "7f610000-0000-4000-8000-000000000201";
const growthPipelineId = "7f610000-0000-4000-8000-000000000202";
const missingStagePipelineId = "7f610000-0000-4000-8000-000000000203";
const globalDefaultPipelineId = "7f610000-0000-4000-8000-000000000204";

let idCounter = 1000;

function id() {
  idCounter += 1;
  return `7f610000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
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
    throw new Error(`Refusing reservation stage resolver QA: active DB host is not test (${testDbHost})`);
  }
  if (!projectIdValue.includes(testDbSuffix)) {
    throw new Error(`Refusing reservation stage resolver QA: project id does not contain ${testDbSuffix}`);
  }
}

async function cleanup(pool) {
  await pool.query("delete from workspaces where id = $1::uuid", [workspaceId]);
}

async function seedWorkspace(pool) {
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
        '{"enabledModules":{"properties":true,"units":true,"reservations":true},"source":"GOLIVETEST_STAGEFIX"}'::jsonb,
        'golivetest-stagefix'
      )
    `,
    [workspaceId, `${marker}Workspace`],
  );

  await pool.query(
    `
      insert into workspace_users (id, workspace_id, name, email, role, status, product_role)
      values ($1::uuid, $2::uuid, 'GOLIVETEST Stage Resolver Owner', 'golivetest.stagefix@example.test', 'owner', 'active', 'customer_owner')
    `,
    [userId, workspaceId],
  );

  await pool.query(
    `
      insert into projects (id, workspace_id, name, type, status, customer_type, default_operating_model, setup_defaults)
      values
        ($1::uuid, $5::uuid, $6, 'Neubau Vertrieb', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"GOLIVETEST_STAGEFIX","pipeline":"real_estate"}'::jsonb),
        ($2::uuid, $5::uuid, $7, 'SaaS Growth', 'Aktiv', 'novalure_internal', 'novalure_internal', '{"source":"GOLIVETEST_STAGEFIX","pipeline":"growth"}'::jsonb),
        ($3::uuid, $5::uuid, $8, 'Custom Pipeline', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"GOLIVETEST_STAGEFIX","pipeline":"missing_candidates"}'::jsonb),
        ($4::uuid, $5::uuid, $9, 'Default Pipeline Fallback', 'Aktiv', 'property_developer', 'self_service_customer', '{"source":"GOLIVETEST_STAGEFIX","pipeline":"global_default"}'::jsonb)
    `,
    [
      realEstateProjectId,
      growthProjectId,
      missingStageProjectId,
      defaultPipelineProjectId,
      workspaceId,
      `${marker}Real Estate`,
      `${marker}Growth`,
      `${marker}Missing Candidate`,
      `${marker}Global Default`,
    ],
  );

  await seedPipeline(pool, {
    key: "stagefix_real_estate",
    name: `${marker}Real Estate Pipeline`,
    pipelineId: realEstatePipelineId,
    projectId: realEstateProjectId,
    stages: [
      { category: "work", key: "new", name: "Neu", probability: 5 },
      { category: "work", key: "qualify", name: "Qualifizieren", probability: 20 },
      { category: "work", key: "viewing", name: "Besichtigung/Beratung", probability: 45 },
      { category: "work", key: "offer_mandate", name: "Angebot / Mandat", probability: 70 },
      { category: "won", key: "won", name: "Gewonnen", probability: 100 },
    ],
  });

  await seedPipeline(pool, {
    key: "stagefix_growth",
    name: `${marker}Growth Pipeline`,
    pipelineId: growthPipelineId,
    projectId: growthProjectId,
    stages: [
      { category: "work", key: "new", name: "Neu", probability: 5 },
      { category: "work", key: "qualified", name: "Qualifiziert", probability: 20 },
      { category: "work", key: "offer", name: "Angebot", probability: 70 },
      { category: "work", key: "pilot", name: "Pilot", probability: 85 },
      { category: "won", key: "won", name: "Gewonnen", probability: 100 },
    ],
  });

  await seedPipeline(pool, {
    key: "stagefix_missing_candidates",
    name: `${marker}Missing Candidate Pipeline`,
    pipelineId: missingStagePipelineId,
    projectId: missingStageProjectId,
    stages: [
      { category: "work", key: "new", name: "Neu", probability: 5 },
      { category: "work", key: "custom_followup", name: "Sonder-Follow-up", probability: 40 },
    ],
  });

  await seedPipeline(pool, {
    key: "stagefix_global_default",
    name: `${marker}Global Default Pipeline`,
    pipelineId: globalDefaultPipelineId,
    projectId: null,
    stages: [
      { category: "work", key: "new", name: "Neu", probability: 5 },
      { category: "work", key: "offer", name: "Angebot", probability: 70 },
      { category: "won", key: "won", name: "Gewonnen", probability: 100 },
    ],
  });
}

async function seedPipeline(pool, input) {
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
      values ($1::uuid, $2::uuid, $3::uuid, 'property_developer', 'self_service_customer', $4, $5, 'sales', true, '{"source":"GOLIVETEST_STAGEFIX"}'::jsonb)
    `,
    [input.pipelineId, workspaceId, input.projectId, input.key, input.name],
  );

  for (const [index, stage] of input.stages.entries()) {
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
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, '{"source":"GOLIVETEST_STAGEFIX"}'::jsonb)
      `,
      [id(), input.pipelineId, workspaceId, input.projectId, stage.key, stage.name, index + 1, stage.probability, stage.category],
    );
  }
}

async function createReservationTarget(pool, projectId, label) {
  const contactId = id();
  const dealId = id();
  const unitId = id();

  await pool.query(
    `
      insert into contacts (id, workspace_id, project_id, name, role, source, intent, consent_label, email, metadata)
      values ($1::uuid, $2::uuid, $3::uuid, $4, 'Kaeufer', 'GOLIVETEST_STAGEFIX', 'Stage resolver QA', 'DSGVO ok', $5, '{"source":"GOLIVETEST_STAGEFIX"}'::jsonb)
    `,
    [contactId, workspaceId, projectId, `${marker}${label} Contact`, `${label.toLocaleLowerCase("en-US")}@stagefix.example.test`],
  );

  await pool.query(
    `
      insert into deals (
        id,
        workspace_id,
        project_id,
        contact_id,
        owner_user_id,
        name,
        stage,
        value_cents,
        probability,
        risk_level,
        source,
        next_action,
        metadata
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6,
        'Neu',
        42000000,
        10,
        'mittel',
        'GOLIVETEST_STAGEFIX',
        '',
        '{"source":"GOLIVETEST_STAGEFIX"}'::jsonb
      )
    `,
    [dealId, workspaceId, projectId, contactId, userId, `${marker}${label} Deal`],
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
      values ($1::uuid, $2::uuid, $3::uuid, $4, 1, 3, 84, 42000000, 'available', '{"source":"GOLIVETEST_STAGEFIX"}'::jsonb)
    `,
    [unitId, workspaceId, projectId, `${marker}${label}`],
  );

  return { contactId, dealId, unitId };
}

async function readDealStage(pool, dealId) {
  const result = await pool.query("select stage, next_action, probability from deals where id = $1::uuid", [dealId]);
  assert.equal(result.rows.length, 1, `Deal ${dealId} should exist`);
  return result.rows[0];
}

async function postReservation(POST, body) {
  const response = await POST(
    new Request("https://qa.local/api/crm/reservations", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-novalure-product-role": "customer_owner",
        "x-novalure-role": "owner",
        "x-novalure-user-email": "golivetest.stagefix@example.test",
        "x-novalure-user-id": userId,
        "x-novalure-user-name": "GOLIVETEST Stage Resolver Owner",
        "x-novalure-workspace-id": workspaceId,
      },
      method: "POST",
    }),
  );
  const payload = await response.json();
  return { payload, status: response.status };
}

async function runActionCase(pool, POST, input) {
  const target = await createReservationTarget(pool, input.projectId, input.label);
  const createResult = await postReservation(POST, {
      action: "create",
      contactId: target.contactId,
      dealId: target.dealId,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      nextAction: `${marker}${input.label} create`,
      unitId: target.unitId,
  });

  assert.equal(createResult.status, 200, `${input.label} bootstrap create should return HTTP 200`);
  assert.equal(createResult.payload.persisted, true, `${input.label} bootstrap create should persist`);

  let result = createResult;
  if (input.action !== "create") {
    result = await postReservation(POST, {
        action: input.action,
        contactId: target.contactId,
        dealId: target.dealId,
        nextAction: `${marker}${input.label} ${input.action}`,
        reservationId: createResult.payload.reservation?.id,
        unitId: target.unitId,
    });
  }

  const status = result.status;
  assert.equal(status, 200, `${input.label} ${input.action} should return HTTP 200`);
  assert.equal(result.payload.persisted, true, `${input.label} ${input.action} should persist`);
  const deal = await readDealStage(pool, target.dealId);
  assert.equal(deal.stage, input.expectedStage, `${input.label} ${input.action} should resolve stage`);

  console.log(
    JSON.stringify({
      action: input.action,
      expectedStage: input.expectedStage,
      httpStatus: status,
      pipeline: input.pipeline,
      resultingStage: deal.stage,
    }),
  );
}

async function runMissingCandidateCase(pool, POST) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(" "));
    originalWarn(...args);
  };

  try {
    const target = await createReservationTarget(pool, missingStageProjectId, "missing-candidate-create");
    const result = await postReservation(POST, {
        action: "create",
        contactId: target.contactId,
        dealId: target.dealId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        nextAction: `${marker}missing candidate`,
        unitId: target.unitId,
    });
    const status = result.status;
    const deal = await readDealStage(pool, target.dealId);

    assert.equal(status, 200, "missing-candidate reservation should still return HTTP 200");
    assert.equal(result.payload.persisted, true, "missing-candidate reservation should persist");
    assert.equal(deal.stage, "Neu", "missing-candidate deal stage should remain unchanged");
    assert.ok(result.payload.dealStageWarning, "missing-candidate response should expose a dealStageWarning");
    assert.ok(
      warnings.some((message) => message.includes("[reservation-stage-resolver]") && message.includes(missingStageProjectId)),
      "missing-candidate warning should be logged",
    );

    console.log(
      JSON.stringify({
        action: "create",
        httpStatus: status,
        pipeline: "missing-candidates",
        resultingStage: deal.stage,
        warningLogged: true,
        warningReason: result.payload.dealStageWarning?.reason,
      }),
    );
  } finally {
    console.warn = originalWarn;
  }
}

async function runActiveReservationGuard(pool, POST) {
  const target = await createReservationTarget(pool, realEstateProjectId, "guard-active-reservation");
  const first = await postReservation(POST, {
      action: "create",
      contactId: target.contactId,
      dealId: target.dealId,
      expiresAt: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
      nextAction: `${marker}guard first`,
      unitId: target.unitId,
  });
  assert.equal(first.status, 200, "guard first reservation should persist");

  const second = await postReservation(POST, {
      action: "create",
      contactId: target.contactId,
      dealId: target.dealId,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      nextAction: `${marker}guard duplicate`,
      unitId: target.unitId,
  });

  const status = second.status;
  assert.equal(status, 400, "second active reservation should return HTTP 400");
  assert.match(second.payload.error ?? "", /already has an active reservation/i);

  console.log(
    JSON.stringify({
      action: "duplicate-active-reservation",
      httpStatus: status,
      reason: second.payload.error,
    }),
  );
}

async function countStagefixRows(pool) {
  const result = await pool.query(
    `
      select jsonb_build_object(
        'workspaces', (select count(*)::int from workspaces where id = $1::uuid or name like $2),
        'projects', (select count(*)::int from projects where workspace_id = $1::uuid or name like $2),
        'contacts', (select count(*)::int from contacts where workspace_id = $1::uuid or name like $2),
        'deals', (select count(*)::int from deals where workspace_id = $1::uuid or name like $2),
        'units', (select count(*)::int from property_units where workspace_id = $1::uuid or unit_number like $2),
        'reservations', (select count(*)::int from property_reservations where workspace_id = $1::uuid),
        'pipelines', (select count(*)::int from crm_pipelines where workspace_id = $1::uuid or name like $2),
        'stages', (select count(*)::int from crm_pipeline_stages where workspace_id = $1::uuid)
      ) as counts
    `,
    [workspaceId, `${marker}%`],
  );
  return result.rows[0]?.counts ?? {};
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

  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { POST } = jiti("../src/app/api/crm/reservations/route.ts");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await seedWorkspace(pool);

    await runActionCase(pool, POST, {
      action: "create",
      expectedStage: "Angebot / Mandat",
      label: "real-estate-create",
      pipeline: "real-estate",
      projectId: realEstateProjectId,
    });
    await runActionCase(pool, POST, {
      action: "expire",
      expectedStage: "Qualifizieren",
      label: "real-estate-expire",
      pipeline: "real-estate",
      projectId: realEstateProjectId,
    });
    await runActionCase(pool, POST, {
      action: "convert",
      expectedStage: "Gewonnen",
      label: "real-estate-convert",
      pipeline: "real-estate",
      projectId: realEstateProjectId,
    });
    await runActionCase(pool, POST, {
      action: "create",
      expectedStage: "Angebot",
      label: "growth-create",
      pipeline: "growth",
      projectId: growthProjectId,
    });
    await runActionCase(pool, POST, {
      action: "expire",
      expectedStage: "Qualifiziert",
      label: "growth-expire",
      pipeline: "growth",
      projectId: growthProjectId,
    });
    await runActionCase(pool, POST, {
      action: "convert",
      expectedStage: "Gewonnen",
      label: "growth-convert",
      pipeline: "growth",
      projectId: growthProjectId,
    });
    await runActionCase(pool, POST, {
      action: "create",
      expectedStage: "Angebot",
      label: "global-default-create",
      pipeline: "global-default",
      projectId: defaultPipelineProjectId,
    });
    await runMissingCandidateCase(pool, POST);
    await runActiveReservationGuard(pool, POST);

    const beforeCleanup = await countStagefixRows(pool);
    await cleanup(pool);
    const afterCleanup = await countStagefixRows(pool);
    assert.deepEqual(afterCleanup, {
      contacts: 0,
      deals: 0,
      pipelines: 0,
      projects: 0,
      reservations: 0,
      stages: 0,
      units: 0,
      workspaces: 0,
    });
    console.log(JSON.stringify({ cleanup: { afterCleanup, beforeCleanup, marker } }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
