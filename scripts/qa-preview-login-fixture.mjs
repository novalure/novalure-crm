#!/usr/bin/env node

import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "@neondatabase/serverless";
import { assertQaTarget } from "./qa-target-guard.mjs";

const scrypt = promisify(scryptCallback);
const mode = process.argv[2] ?? "status";
const dataPrefix = "CODEXTEST_PREVIEW_";

if (!new Set(["cleanup", "seed", "status"]).has(mode)) {
  throw new Error("Usage: node scripts/qa-preview-login-fixture.mjs <seed|status|cleanup>");
}

const qaTarget = await assertQaTarget();
const fixtureKey = `${qaTarget.expectedProjectId}:${qaTarget.expectedBranchId}:preview-login`;

function stableUuid(key) {
  const chars = createHash("sha256")
    .update(`${fixtureKey}:${key}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = await scrypt(password, salt, 64);
  return ["scrypt", salt, Buffer.from(derivedKey).toString("base64url")].join(":");
}

const ids = {
  buyerContact: stableUuid("contact:buyer"),
  buyerDeal: stableUuid("deal:buyer"),
  buyerLead: stableUuid("lead:buyer"),
  pipeline: stableUuid("pipeline"),
  project: stableUuid("project"),
  sellerContact: stableUuid("contact:seller"),
  sellerDeal: stableUuid("deal:seller"),
  sellerLead: stableUuid("lead:seller"),
  sellerListing: stableUuid("seller-listing"),
  taskBuyer: stableUuid("task:buyer"),
  taskSeller: stableUuid("task:seller"),
  unitAvailable: stableUuid("unit:available"),
  unitReserved: stableUuid("unit:reserved"),
  unitSold: stableUuid("unit:sold"),
  user: stableUuid("user"),
  workspace: stableUuid("workspace"),
};

const stageDefinitions = [
  ["neu", "Neu", 0, 10, "work"],
  ["qualifizieren", "Qualifizieren", 1, 25, "work"],
  ["angebot_mandat", "Angebot / Mandat", 2, 70, "work"],
  ["gewonnen", "Gewonnen", 3, 100, "won"],
  ["verloren", "Verloren", 4, 0, "lost"],
];

const fixtureEmail = process.env.NOVALURE_QA_PREVIEW_EMAIL?.trim().toLowerCase();
const fixturePassword = process.env.NOVALURE_QA_PREVIEW_PASSWORD;
const fixtureName = `${dataPrefix}User`;
const workspaceName = `${dataPrefix}Workspace`;

function requireSeedCredentials() {
  if (!fixtureEmail || !fixtureEmail.startsWith("codextest_preview_")) {
    throw new Error("NOVALURE_QA_PREVIEW_EMAIL must start with codextest_preview_.");
  }
  if (!fixturePassword || fixturePassword.length < 16) {
    throw new Error("NOVALURE_QA_PREVIEW_PASSWORD must contain at least 16 characters.");
  }
}

async function status(client) {
  const result = await client.query(
    `
      select
        (select count(*)::int from workspaces where id = $1::uuid) as workspaces,
        (select count(*)::int from workspace_users where workspace_id = $1::uuid) as users,
        (select count(*)::int from projects where workspace_id = $1::uuid) as projects,
        (select count(*)::int from contacts where workspace_id = $1::uuid) as contacts,
        (select count(*)::int from leads where workspace_id = $1::uuid) as leads,
        (select count(*)::int from deals where workspace_id = $1::uuid) as deals,
        (select count(*)::int from tasks where workspace_id = $1::uuid) as tasks,
        (select count(*)::int from property_units where workspace_id = $1::uuid) as units,
        (select count(*)::int from seller_listings where workspace_id = $1::uuid) as properties
    `,
    [ids.workspace],
  );
  return result.rows[0];
}

async function seed(client) {
  requireSeedCredentials();
  const passwordHash = await hashPassword(fixturePassword);

  await client.query("begin");
  try {
    await client.query(
      `
        insert into workspaces (
          id, name, plan, operating_model, customer_type, team_structure,
          active_calendar_provider, setup_state
        )
        values (
          $1::uuid, $2, 'Preview QA', 'hybrid', 'hybrid_real_estate',
          'small_team', 'none',
          jsonb_build_object('qaPrefix', $3::text, 'previewFixture', true)
        )
        on conflict (id) do update set
          name = excluded.name,
          plan = excluded.plan,
          operating_model = excluded.operating_model,
          customer_type = excluded.customer_type,
          team_structure = excluded.team_structure,
          active_calendar_provider = excluded.active_calendar_provider,
          setup_state = workspaces.setup_state || excluded.setup_state,
          updated_at = now()
      `,
      [ids.workspace, workspaceName, dataPrefix],
    );

    await client.query(
      `
        insert into workspace_users (
          id, workspace_id, name, email, role, status, product_role, password_hash
        )
        values ($1::uuid, $2::uuid, $3, $4, 'agent', 'active', 'team_member', $5)
        on conflict (workspace_id, email) do update set
          name = excluded.name,
          role = excluded.role,
          status = excluded.status,
          product_role = excluded.product_role,
          password_hash = excluded.password_hash,
          updated_at = now()
      `,
      [ids.user, ids.workspace, fixtureName, fixtureEmail, passwordHash],
    );

    await client.query(
      `
        insert into projects (
          id, workspace_id, name, type, status, customer_type,
          default_operating_model, setup_defaults
        )
        values (
          $1::uuid, $2::uuid, $3, 'property_development', 'Aktiv',
          'hybrid_real_estate', 'hybrid',
          jsonb_build_object('qaPrefix', $4::text, 'previewFixture', true)
        )
        on conflict (id) do update set
          name = excluded.name,
          status = excluded.status,
          setup_defaults = projects.setup_defaults || excluded.setup_defaults,
          updated_at = now()
      `,
      [ids.project, ids.workspace, `${dataPrefix}Projekt Seeblick`, dataPrefix],
    );

    await client.query(
      `
        insert into crm_pipelines (
          id, workspace_id, project_id, customer_type, operating_model,
          key, name, purpose, is_default, metadata
        )
        values (
          $1::uuid, $2::uuid, $3::uuid, 'hybrid_real_estate', 'hybrid',
          'preview_qa_pipeline', $4, 'sales', true,
          jsonb_build_object('qaPrefix', $5::text, 'previewFixture', true)
        )
        on conflict (id) do update set
          name = excluded.name,
          is_default = true,
          metadata = crm_pipelines.metadata || excluded.metadata,
          updated_at = now()
      `,
      [ids.pipeline, ids.workspace, ids.project, `${dataPrefix}Pipeline`, dataPrefix],
    );

    for (const [key, name, position, probability, category] of stageDefinitions) {
      await client.query(
        `
          insert into crm_pipeline_stages (
            id, pipeline_id, workspace_id, project_id, key, name,
            position, probability, category, metadata
          )
          values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9,
            jsonb_build_object('qaPrefix', $10::text, 'previewFixture', true)
          )
          on conflict (pipeline_id, key) do update set
            name = excluded.name,
            position = excluded.position,
            probability = excluded.probability,
            category = excluded.category,
            metadata = crm_pipeline_stages.metadata || excluded.metadata,
            updated_at = now()
        `,
        [stableUuid(`stage:${key}`), ids.pipeline, ids.workspace, ids.project, key, name, position, probability, category, dataPrefix],
      );
    }

    await client.query(
      "update projects set default_pipeline_id = $1::uuid, updated_at = now() where id = $2::uuid",
      [ids.pipeline, ids.project],
    );

    const contacts = [
      [ids.buyerContact, `${dataPrefix}Kaeufer Anna`, "Kaeufer", "preview-buyer@novalure.local"],
      [ids.sellerContact, `${dataPrefix}Verkaeufer Max`, "Verkaeufer", "preview-seller@novalure.local"],
    ];
    for (const [id, name, role, email] of contacts) {
      await client.query(
        `
          insert into contacts (
            id, workspace_id, project_id, owner_user_id, name, role,
            source, intent, consent_label, email, metadata
          )
          values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
            'Manual', 'Preview-Abnahme', 'Nur CRM', $7,
            jsonb_build_object('qaPrefix', $8::text, 'previewFixture', true)
          )
          on conflict (id) do update set
            owner_user_id = excluded.owner_user_id,
            name = excluded.name,
            role = excluded.role,
            metadata = contacts.metadata || excluded.metadata,
            updated_at = now()
        `,
        [id, ids.workspace, ids.project, ids.user, name, role, email, dataPrefix],
      );
    }

    const leads = [
      [ids.buyerLead, ids.buyerContact, "Kaeufer", 86, "Wohnung Seeblick kaufen"],
      [ids.sellerLead, ids.sellerContact, "Verkaeufer", 74, "Wohnung Seeblick verkaufen"],
    ];
    for (const [id, contactId, type, score, intent] of leads) {
      await client.query(
        `
          insert into leads (
            id, workspace_id, project_id, contact_id, assigned_to_user_id,
            source, type, status, score, intent, next_action, received_at,
            region, object_type, rooms, area_sqm, metadata
          )
          values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            'Manual', $6, 'Neu', $7, $8, 'Preview-Kontakt aufnehmen',
            now() - interval '2 hours', 'Wien', 'Wohnung', 3, 82,
            jsonb_build_object('qaPrefix', $9::text, 'previewFixture', true)
          )
          on conflict (id) do update set
            assigned_to_user_id = excluded.assigned_to_user_id,
            status = excluded.status,
            score = excluded.score,
            intent = excluded.intent,
            metadata = leads.metadata || excluded.metadata,
            updated_at = now()
        `,
        [id, ids.workspace, ids.project, contactId, ids.user, type, score, intent, dataPrefix],
      );
    }

    const deals = [
      [ids.buyerDeal, ids.buyerContact, ids.buyerLead, `${dataPrefix}Kaeufer Deal`, "Qualifizieren", 54000000, 25],
      [ids.sellerDeal, ids.sellerContact, ids.sellerLead, `${dataPrefix}Verkaeufer Deal`, "Angebot / Mandat", 69000000, 70],
    ];
    for (const [id, contactId, leadId, name, stage, valueCents, probability] of deals) {
      await client.query(
        `
          insert into deals (
            id, workspace_id, project_id, contact_id, owner_user_id, lead_id,
            name, stage, value_cents, probability, expected_close_date,
            risk_level, source, next_action, metadata
          )
          values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
            $7, $8, $9, $10, current_date + 30,
            'mittel', 'Manual', 'Preview-Follow-up',
            jsonb_build_object('qaPrefix', $11::text, 'previewFixture', true)
          )
          on conflict (id) do update set
            owner_user_id = excluded.owner_user_id,
            stage = excluded.stage,
            value_cents = excluded.value_cents,
            probability = excluded.probability,
            metadata = deals.metadata || excluded.metadata,
            updated_at = now()
        `,
        [id, ids.workspace, ids.project, contactId, ids.user, leadId, name, stage, valueCents, probability, dataPrefix],
      );
    }

    const tasks = [
      [ids.taskBuyer, ids.buyerContact, ids.buyerLead, `${dataPrefix}Kaeufer anrufen`],
      [ids.taskSeller, ids.sellerContact, ids.sellerLead, `${dataPrefix}Bewertung vorbereiten`],
    ];
    for (const [id, contactId, leadId, title] of tasks) {
      await client.query(
        `
          insert into tasks (
            id, workspace_id, project_id, contact_id, lead_id, owner_user_id,
            title, due_at, priority, status, metadata
          )
          values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
            $7, now() + interval '1 day', 'Mittel', 'open',
            jsonb_build_object('qaPrefix', $8::text, 'previewFixture', true)
          )
          on conflict (id) do update set
            owner_user_id = excluded.owner_user_id,
            title = excluded.title,
            status = excluded.status,
            metadata = tasks.metadata || excluded.metadata,
            updated_at = now()
        `,
        [id, ids.workspace, ids.project, contactId, leadId, ids.user, title, dataPrefix],
      );
    }

    const units = [
      [ids.unitAvailable, `${dataPrefix}A-01`, 1, 3, 82, 54000000, "available", null, null],
      [ids.unitReserved, `${dataPrefix}A-02`, 1, 2, 61, 33500000, "reserved", ids.buyerContact, ids.buyerDeal],
      [ids.unitSold, `${dataPrefix}B-12`, 3, 4, 104, 69000000, "sold", ids.sellerContact, ids.sellerDeal],
    ];
    for (const [id, unitNumber, floor, rooms, area, price, statusValue, buyerContactId, dealId] of units) {
      await client.query(
        `
          insert into property_units (
            id, workspace_id, project_id, unit_number, floor, rooms,
            area_sqm, price_cents, status, buyer_contact_id, deal_id, metadata
          )
          values (
            $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
            $7, $8, $9, $10::uuid, $11::uuid,
            jsonb_build_object('qaPrefix', $12::text, 'previewFixture', true)
          )
          on conflict (id) do update set
            unit_number = excluded.unit_number,
            status = excluded.status,
            buyer_contact_id = excluded.buyer_contact_id,
            deal_id = excluded.deal_id,
            metadata = property_units.metadata || excluded.metadata,
            updated_at = now()
        `,
        [id, ids.workspace, ids.project, unitNumber, floor, rooms, area, price, statusValue, buyerContactId, dealId, dataPrefix],
      );
    }

    await client.query(
      `
        insert into seller_listings (
          id, workspace_id, project_id, seller_lead_id, title, address,
          region, object_type, area_sqm, rooms, market_value_cents,
          target_price_cents, mandate_ends_at
        )
        values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
          'Seeblick 12, 1010 Wien', 'Wien', 'Wohnung', 104, 4,
          69000000, 71000000, current_date + 90
        )
        on conflict (id) do update set
          seller_lead_id = excluded.seller_lead_id,
          title = excluded.title,
          market_value_cents = excluded.market_value_cents,
          target_price_cents = excluded.target_price_cents,
          updated_at = now()
      `,
      [ids.sellerListing, ids.workspace, ids.project, ids.sellerLead, `${dataPrefix}Seeblick Residenz`],
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function cleanup(client) {
  await client.query("begin");
  try {
    const identity = await client.query(
      "select auth_identity_id from workspace_users where workspace_id = $1::uuid and id = $2::uuid",
      [ids.workspace, ids.user],
    );
    const identityId = identity.rows[0]?.auth_identity_id ?? null;
    await client.query("delete from workspaces where id = $1::uuid", [ids.workspace]);
    if (identityId) {
      await client.query(
        `
          delete from auth_identities identity
          where identity.id = $1::uuid
            and not exists (
              select 1 from workspace_users user_row where user_row.auth_identity_id = identity.id
            )
        `,
        [identityId],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

const pool = new Pool({ allowExitOnIdle: true, connectionString: qaTarget.databaseUrl, max: 1 });
const client = await pool.connect();

try {
  if (mode === "seed") await seed(client);
  if (mode === "cleanup") await cleanup(client);

  const counts = await status(client);
  console.log(JSON.stringify({
    branchId: qaTarget.expectedBranchId,
    counts,
    dataPrefix,
    email: fixtureEmail ?? null,
    ids,
    mode,
    workspaceName,
  }, null, 2));
} finally {
  client.release();
  await pool.end();
}
