#!/usr/bin/env node
import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";

const scrypt = promisify(scryptCallback);
const defaultQaPassword = "QA-Novalure-Local-2026!";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(".env.local");
loadEnv(".env.production.local");

function resolveDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ""
  ).trim().replace(/^['"]|['"]$/g, "");
}

function stableUuid(input) {
  const chars = createHash("sha1").update(`novalure-livegang:${input}`).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = await scrypt(password, salt, 64);
  return ["scrypt", salt, Buffer.from(derivedKey).toString("base64url")].join(":");
}

function json(value) {
  return JSON.stringify(value);
}

const qaPassword = process.env.NOVALURE_QA_SEED_PASSWORD || process.env.NOVALURE_QA_PASSWORD || defaultQaPassword;
const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  console.error("Missing DATABASE_URL/POSTGRES_URL for QA seed.");
  process.exit(1);
}

const sql = neon(databaseUrl);

async function queryOne(query, params = []) {
  const rows = await sql.query(query, params);
  return rows[0] ?? null;
}

function splitSql(sqlText) {
  return sqlText
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(path) {
  const statements = splitSql(fs.readFileSync(path, "utf8"));
  for (const statement of statements) {
    await sql.query(statement);
  }
}

await applyMigration("migrations/029_contact_owner_scope.sql");
await applyMigration("migrations/030_novalure_growth_workspace.sql");
await applyMigration("migrations/031_user_onboarding.sql");
await applyMigration("migrations/033_rename_demo_form_source.sql");
await applyMigration("migrations/034_property_department.sql");
await applyMigration("migrations/035_property_department_content.sql");

const workspaces = {
  internal: {
    id: stableUuid("workspace:internal"),
    name: "QA Novalure Internal Workspace",
    customerType: "novalure_internal",
    operatingModel: "novalure_internal",
    teamStructure: "backoffice_available",
    plan: "QA Platform",
    projectType: "internal_service",
  },
  developer: {
    id: stableUuid("workspace:developer"),
    name: "QA Bautr\u00e4ger Workspace",
    customerType: "property_developer",
    operatingModel: "self_service_customer",
    teamStructure: "project_sales_available",
    plan: "QA Developer",
    projectType: "property_development",
  },
  broker: {
    id: stableUuid("workspace:broker"),
    name: "QA Makler Workspace",
    customerType: "real_estate_broker",
    operatingModel: "self_service_customer",
    teamStructure: "small_team",
    plan: "QA Broker",
    projectType: "brokerage",
  },
};

const users = [
  {
    email: "qa-platform-admin@novalure.local",
    id: stableUuid("user:platform-admin"),
    name: "QA Platform Admin",
    productRole: "platform_admin",
    role: "owner",
    workspace: workspaces.internal,
  },
  {
    email: "qa-assistant@novalure.local",
    id: stableUuid("user:assistant"),
    name: "QA Assistant",
    productRole: "assistant_backoffice",
    role: "assistant",
    workspace: workspaces.internal,
  },
  {
    email: "qa-developer-sales@novalure.local",
    id: stableUuid("user:developer-sales"),
    name: "QA Developer Sales",
    productRole: "developer_sales",
    role: "agent",
    workspace: workspaces.developer,
  },
  {
    email: "qa-broker-sales@novalure.local",
    id: stableUuid("user:broker-sales"),
    name: "QA Broker Sales",
    productRole: "broker_agent",
    role: "agent",
    workspace: workspaces.broker,
  },
];

const qaRecords = [
  {
    contactRole: "Bautr\u00e4ger",
    dealStage: "Anfrage",
    dealValueCents: 1800000,
    intent: "QA interner Managed-Service Audit",
    leadType: "Bautr\u00e4ger",
    nextAction: "QA Audit vorbereiten",
    projectName: "QA Novalure Operations Projekt",
    taskTitle: "QA Internal Follow-up",
    workspace: workspaces.internal,
  },
  {
    contactRole: "K\u00e4ufer",
    dealStage: "Neu",
    dealValueCents: 420000,
    intent: "QA Neubau Lead Sonnenhof",
    leadType: "K\u00e4ufer",
    nextAction: "QA Beratungstermin abstimmen",
    projectName: "QA Bautr\u00e4ger Projekt Sonnenhof",
    taskTitle: "QA Bautraeger Follow-up",
    workspace: workspaces.developer,
  },
  {
    contactRole: "Verk\u00e4ufer",
    dealStage: "Neu",
    dealValueCents: 650000,
    intent: "QA Verkaufsmandat Wien",
    leadType: "Verk\u00e4ufer",
    nextAction: "QA Bewertungstermin vereinbaren",
    projectName: "QA Makler Mandate Wien",
    taskTitle: "QA Makler Follow-up",
    workspace: workspaces.broker,
  },
];

const templates = {
  internal: {
    key: "novalure_internal_pipeline",
    name: "QA Novalure interne Pipeline",
    purpose: "managed_service",
    stages: [
      ["anfrage", "Anfrage", 10, "work", 24],
      ["audit_geplant", "Audit geplant", 25, "work", 48],
      ["angebot", "Angebot", 45, "work", 72],
      ["onboarding", "Onboarding", 75, "work", 120],
      ["aktiv", "Aktiv", 100, "won", null],
      ["pausiert_verloren", "Pausiert / Verloren", 0, "lost", null],
    ],
  },
  developer: {
    key: "developer_project_sales",
    name: "QA Bautr\u00e4ger Pipeline",
    purpose: "project_sales",
    stages: [
      ["neu", "Neu", 10, "work", 12],
      ["qualifizieren", "Qualifizieren", 25, "work", 24],
      ["beratung_besichtigung", "Beratung / Besichtigung", 45, "work", 48],
      ["reservierung", "Reservierung", 70, "work", 72],
      ["vertragspruefung", "Vertragspr\u00fcfung", 85, "work", 120],
      ["gewonnen", "Gewonnen", 100, "won", null],
      ["verloren", "Verloren", 0, "lost", null],
      ["disqualifiziert", "Disqualifiziert", 0, "disqualified", null],
    ],
  },
  broker: {
    key: "broker_mandate_sales",
    name: "QA Makler Pipeline",
    purpose: "brokerage",
    stages: [
      ["neu", "Neu", 10, "work", 12],
      ["qualifizieren", "Qualifizieren", 25, "work", 24],
      ["termin_vereinbaren", "Termin vereinbaren", 35, "work", 48],
      ["besichtigung_bewertung", "Besichtigung / Bewertung", 50, "work", 72],
      ["angebot_mandat", "Angebot / Mandat", 70, "work", 96],
      ["abschlusspruefung", "Abschlusspr\u00fcfung", 85, "work", 120],
      ["gewonnen", "Gewonnen", 100, "won", null],
      ["verloren", "Verloren", 0, "lost", null],
      ["disqualifiziert", "Disqualifiziert", 0, "disqualified", null],
    ],
  },
};

function templateForWorkspace(workspace) {
  if (workspace.customerType === "novalure_internal") return templates.internal;
  if (workspace.customerType === "property_developer") return templates.developer;
  return templates.broker;
}

async function upsertWorkspace(workspace) {
  await queryOne(
    `
      insert into workspaces (
        id,
        name,
        plan,
        operating_model,
        customer_type,
        team_structure,
        active_calendar_provider,
        setup_state
      )
      values ($1::uuid, $2, $3, $4, $5, $6, 'none', $7::jsonb)
      on conflict (id) do update set
        name = excluded.name,
        plan = excluded.plan,
        operating_model = excluded.operating_model,
        customer_type = excluded.customer_type,
        team_structure = excluded.team_structure,
        active_calendar_provider = excluded.active_calendar_provider,
        setup_state = workspaces.setup_state || excluded.setup_state,
        updated_at = now()
      returning id
    `,
    [
      workspace.id,
      workspace.name,
      workspace.plan,
      workspace.operatingModel,
      workspace.customerType,
      workspace.teamStructure,
      json({ qaSeed: "livegang-8-10", seededAt: new Date().toISOString() }),
    ],
  );
}

async function upsertUser(user, passwordHash) {
  const row = await queryOne(
    `
      insert into workspace_users (
        id,
        workspace_id,
        name,
        email,
        role,
        status,
        product_role,
        password_hash
      )
      values ($1::uuid, $2::uuid, $3, lower($4), $5, 'active', $6, $7)
      on conflict (workspace_id, email) do update set
        name = excluded.name,
        role = excluded.role,
        status = 'active',
        product_role = excluded.product_role,
        password_hash = excluded.password_hash,
        updated_at = now()
      returning id
    `,
    [user.id, user.workspace.id, user.name, user.email, user.role, user.productRole, passwordHash],
  );
  return row?.id ?? user.id;
}

async function upsertProject(record) {
  const id = stableUuid(`project:${record.workspace.id}`);
  await queryOne(
    `
      insert into projects (
        id,
        workspace_id,
        name,
        type,
        status,
        customer_type,
        default_operating_model,
        setup_defaults
      )
      values ($1::uuid, $2::uuid, $3, $4, 'Aktiv', $5, $6, $7::jsonb)
      on conflict (id) do update set
        name = excluded.name,
        type = excluded.type,
        status = excluded.status,
        customer_type = excluded.customer_type,
        default_operating_model = excluded.default_operating_model,
        setup_defaults = projects.setup_defaults || excluded.setup_defaults,
        updated_at = now()
      returning id
    `,
    [
      id,
      record.workspace.id,
      record.projectName,
      record.workspace.projectType,
      record.workspace.customerType,
      record.workspace.operatingModel,
      json({ qaSeed: "livegang-8-10" }),
    ],
  );
  return id;
}

async function upsertPipeline(workspace, projectId) {
  const template = templateForWorkspace(workspace);
  const pipelineId = stableUuid(`pipeline:${projectId}:${template.key}`);
  const pipeline = await queryOne(
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
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, true, $9::jsonb)
      on conflict (workspace_id, project_id, key) where project_id is not null
      do update set
        customer_type = excluded.customer_type,
        operating_model = excluded.operating_model,
        name = excluded.name,
        purpose = excluded.purpose,
        is_default = true,
        metadata = crm_pipelines.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [
      pipelineId,
      workspace.id,
      projectId,
      workspace.customerType,
      workspace.operatingModel,
      template.key,
      template.name,
      template.purpose,
      json({ qaSeed: "livegang-8-10" }),
    ],
  );

  for (const [position, [key, name, probability, category, slaHours]] of template.stages.entries()) {
    await queryOne(
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
          sla_hours,
          metadata
        )
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::jsonb)
        on conflict (pipeline_id, key) do update set
          name = excluded.name,
          position = excluded.position,
          probability = excluded.probability,
          category = excluded.category,
          sla_hours = excluded.sla_hours,
          metadata = crm_pipeline_stages.metadata || excluded.metadata,
          updated_at = now()
        returning id
      `,
      [
        stableUuid(`stage:${pipeline.id}:${key}`),
        pipeline.id,
        workspace.id,
        projectId,
        key,
        name,
        position,
        probability,
        category,
        slaHours,
        json({ qaSeed: "livegang-8-10" }),
      ],
    );
  }

  await queryOne(
    `
      update projects
      set default_pipeline_id = $1::uuid, updated_at = now()
      where id = $2::uuid and workspace_id = $3::uuid
      returning id
    `,
    [pipeline.id, projectId, workspace.id],
  );

  return pipeline.id;
}

async function upsertCoreRecords(record, projectId) {
  const contactId = stableUuid(`contact:${record.workspace.id}`);
  const leadId = stableUuid(`lead:${record.workspace.id}`);
  const dealId = stableUuid(`deal:${record.workspace.id}`);
  const taskId = stableUuid(`task:${record.workspace.id}`);
  const owner = users.find((user) => user.workspace.id === record.workspace.id) ?? users[0];

  await queryOne(
    `
      insert into contacts (
        id,
        workspace_id,
        project_id,
        name,
        role,
        source,
        intent,
        consent_label,
        email,
        phone,
        metadata
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'Manual', $6, 'Nur CRM', $7, $8, $9::jsonb)
      on conflict (id) do update set
        project_id = excluded.project_id,
        name = excluded.name,
        role = excluded.role,
        source = excluded.source,
        intent = excluded.intent,
        consent_label = excluded.consent_label,
        email = excluded.email,
        phone = excluded.phone,
        metadata = contacts.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [
      contactId,
      record.workspace.id,
      projectId,
      `${record.workspace.name} QA Kontakt`,
      record.contactRole,
      record.intent,
      `${record.workspace.id.slice(0, 8)}@qa.novalure.local`,
      "+43 660 000000",
      json({ qaSeed: "livegang-8-10" }),
    ],
  );

  await queryOne(
    `
      insert into leads (
        id,
        workspace_id,
        project_id,
        contact_id,
        assigned_to_user_id,
        source,
        type,
        status,
        score,
        budget,
        intent,
        next_action,
        received_at,
        sla_due_at,
        last_contact_at,
        next_contact_at,
        region,
        object_type,
        rooms,
        area_sqm,
        hot_status,
        buyer_profile,
        seller_profile,
        investor_profile,
        metadata
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        'Manual',
        $6,
        'Neu',
        72,
        'QA Budget',
        $7,
        $8,
        now() - interval '2 hours',
        now() + interval '4 hours',
        now() - interval '1 hour',
        now() + interval '1 day',
        'Wien',
        'Wohnung',
        3,
        82,
        true,
        $9::jsonb,
        $10::jsonb,
        '{}'::jsonb,
        $11::jsonb
      )
      on conflict (id) do update set
        project_id = excluded.project_id,
        contact_id = excluded.contact_id,
        assigned_to_user_id = excluded.assigned_to_user_id,
        type = excluded.type,
        status = excluded.status,
        score = excluded.score,
        intent = excluded.intent,
        next_action = excluded.next_action,
        metadata = leads.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [
      leadId,
      record.workspace.id,
      projectId,
      contactId,
      owner.id,
      record.leadType,
      record.intent,
      record.nextAction,
      json({ preferredLocation: "QA Wien", budgetTo: record.dealValueCents / 100 }),
      json({ motivation: "QA Test", marketValue: record.dealValueCents / 100 }),
      json({ qaSeed: "livegang-8-10" }),
    ],
  );

  await queryOne(
    `
      insert into deals (
        id,
        workspace_id,
        project_id,
        contact_id,
        owner_user_id,
        lead_id,
        name,
        stage,
        value_cents,
        probability,
        expected_close_date,
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
        $6::uuid,
        $7,
        $8,
        $9,
        45,
        current_date + 30,
        'mittel',
        'Manual',
        $10,
        $11::jsonb
      )
      on conflict (id) do update set
        project_id = excluded.project_id,
        contact_id = excluded.contact_id,
        owner_user_id = excluded.owner_user_id,
        lead_id = excluded.lead_id,
        name = excluded.name,
        stage = excluded.stage,
        value_cents = excluded.value_cents,
        probability = excluded.probability,
        expected_close_date = excluded.expected_close_date,
        risk_level = excluded.risk_level,
        source = excluded.source,
        next_action = excluded.next_action,
        lost_reason_category = null,
        lost_reason_detail = '',
        lost_at = null,
        closed_at = null,
        metadata = deals.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [
      dealId,
      record.workspace.id,
      projectId,
      contactId,
      owner.id,
      leadId,
      `${record.workspace.name} QA Deal`,
      record.dealStage,
      record.dealValueCents,
      record.nextAction,
      json({ qaSeed: "livegang-8-10" }),
    ],
  );

  await queryOne(
    `
      insert into tasks (
        id,
        workspace_id,
        project_id,
        contact_id,
        lead_id,
        owner_user_id,
        title,
        due_at,
        priority,
        status,
        metadata
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, now() + interval '1 day', 'Mittel', 'open', $8::jsonb)
      on conflict (id) do update set
        project_id = excluded.project_id,
        contact_id = excluded.contact_id,
        lead_id = excluded.lead_id,
        owner_user_id = excluded.owner_user_id,
        title = excluded.title,
        due_at = excluded.due_at,
        priority = excluded.priority,
        status = excluded.status,
        metadata = tasks.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [taskId, record.workspace.id, projectId, contactId, leadId, owner.id, record.taskTitle, json({ qaSeed: "livegang-8-10" })],
  );

  return { contactId, dealId, leadId, taskId };
}

async function upsertPipelinePermission(workspace, projectId, user) {
  await queryOne(
    `
      insert into project_pipeline_permissions (
        id,
        workspace_id,
        project_id,
        user_id,
        can_edit_deals,
        can_move_deals,
        can_close_deals,
        can_reopen_deals,
        metadata
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, false, $5::jsonb)
      on conflict (workspace_id, project_id, user_id) do update set
        can_edit_deals = excluded.can_edit_deals,
        can_move_deals = excluded.can_move_deals,
        can_close_deals = excluded.can_close_deals,
        can_reopen_deals = excluded.can_reopen_deals,
        metadata = project_pipeline_permissions.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [
      stableUuid(`permission:${workspace.id}:${projectId}:${user.id}`),
      workspace.id,
      projectId,
      user.id,
      json({ qaSeed: "livegang-8-10", note: "Agents can close but cannot reopen terminal deals." }),
    ],
  );
}

async function upsertObjectData(record, projectId, ids) {
  if (record.workspace.customerType === "property_developer") {
    await queryOne(
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
          buyer_contact_id,
          deal_id,
          metadata
        )
        values ($1::uuid, $2::uuid, $3::uuid, 'QA-A-01', 1, 3, 82, $4, 'available', $5::uuid, $6::uuid, $7::jsonb)
        on conflict (id) do update set
          project_id = excluded.project_id,
          unit_number = excluded.unit_number,
          floor = excluded.floor,
          rooms = excluded.rooms,
          area_sqm = excluded.area_sqm,
          price_cents = excluded.price_cents,
          status = excluded.status,
          buyer_contact_id = excluded.buyer_contact_id,
          deal_id = excluded.deal_id,
          metadata = property_units.metadata || excluded.metadata,
          updated_at = now()
        returning id
      `,
      [
        stableUuid(`unit:${record.workspace.id}`),
        record.workspace.id,
        projectId,
        record.dealValueCents,
        ids.contactId,
        ids.dealId,
        json({ qaSeed: "livegang-8-10" }),
      ],
    );
  }

  if (record.workspace.customerType === "real_estate_broker") {
    await queryOne(
      `
        insert into broker_mandates (
          id,
          workspace_id,
          project_id,
          seller_lead_id,
          contact_id,
          title,
          address,
          location,
          property_type,
          condition,
          area_sqm,
          rooms,
          asking_price_cents,
          market_value_cents,
          selling_timeline,
          motivation,
          selling_reason,
          mandate_status,
          mandate_type,
          commission_rate,
          documents_status,
          marketing_status,
          expiring_broker_contract_at,
          metadata
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::uuid,
          'QA Makler Mandat Innenstadt',
          'QA Adresse 1, 1010 Wien',
          'Wien',
          'Wohnung',
          'gepflegt',
          82,
          3,
          $6,
          $6,
          '30 Tage',
          'QA Verkauf',
          'QA Test',
          'open',
          'exclusive',
          3.0,
          'qa_complete',
          'qa_ready',
          current_date + 90,
          $7::jsonb
        )
        on conflict (id) do update set
          project_id = excluded.project_id,
          seller_lead_id = excluded.seller_lead_id,
          contact_id = excluded.contact_id,
          title = excluded.title,
          asking_price_cents = excluded.asking_price_cents,
          market_value_cents = excluded.market_value_cents,
          mandate_status = excluded.mandate_status,
          metadata = broker_mandates.metadata || excluded.metadata,
          updated_at = now()
        returning id
      `,
      [
        stableUuid(`broker-mandate:${record.workspace.id}`),
        record.workspace.id,
        projectId,
        ids.leadId,
        ids.contactId,
        record.dealValueCents,
        json({ qaSeed: "livegang-8-10" }),
      ],
    );

    await queryOne(
      `
        insert into buyer_search_profiles (
          id,
          workspace_id,
          project_id,
          contact_id,
          title,
          budget_from_cents,
          budget_to_cents,
          financing_status,
          desired_location,
          property_type,
          rooms,
          area_sqm,
          must_have_criteria,
          nice_to_have_criteria,
          purchase_timeline,
          matching_status,
          metadata
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          'QA Suchprofil Wien',
          45000000,
          75000000,
          'vorqualifiziert',
          'Wien',
          'Wohnung',
          3,
          80,
          array['QA Balkon', 'QA U-Bahn'],
          array['QA Altbau'],
          '3 Monate',
          'open',
          $5::jsonb
        )
        on conflict (id) do update set
          project_id = excluded.project_id,
          contact_id = excluded.contact_id,
          title = excluded.title,
          budget_from_cents = excluded.budget_from_cents,
          budget_to_cents = excluded.budget_to_cents,
          matching_status = excluded.matching_status,
          metadata = buyer_search_profiles.metadata || excluded.metadata,
          updated_at = now()
        returning id
      `,
      [
        stableUuid(`buyer-profile:${record.workspace.id}`),
        record.workspace.id,
        projectId,
        ids.contactId,
        json({ qaSeed: "livegang-8-10" }),
      ],
    );
  }
}

async function upsertBotAndKnowledge(record, projectId) {
  if (record.workspace.customerType !== "property_developer") return;

  const botId = stableUuid(`bot:${record.workspace.id}:sales-concierge`);
  const sourceId = stableUuid(`knowledge:${record.workspace.id}:seeblick`);
  const knowledgeText = [
    "Projekt Seeblick umfasst freigegebene Wohnungen A-01, A-02 und B-12.",
    "Wohnung A-01 hat 3 Zimmer, ca. 82 m2, Balkon und einen freigegebenen Richtpreis von 420000 EUR.",
    "Wohnung A-02 hat 2 Zimmer, ca. 61 m2, Loggia und einen freigegebenen Richtpreis von 335000 EUR.",
    "Wohnung B-12 hat 4 Zimmer, ca. 104 m2, Terrasse und einen freigegebenen Richtpreis von 690000 EUR.",
    "Nicht freigegebene Preise, Reservierungen und Finanzierungszusagen muessen an das Verkaufsteam uebergeben werden.",
  ].join(" ");
  const config = {
    channels: [
      {
        id: "qa_seeblick_webchat",
        channel: "Webchat",
        active: true,
        greetingDe: "Hallo, ich beantworte Fragen nur aus freigegebenem Projektwissen.",
        greetingEn: "Hi, I answer only from approved project knowledge.",
        handoffRules: ["fehlende Wissensquelle", "Rechtsfrage", "Finanzierungszusage", "Preisverhandlung"],
        setupStatus: "connected",
        webhookPath: "/api/bots/chat",
      },
    ],
    tools: [
      { id: "tool_search_knowledge", name: "search_approved_knowledge", enabled: true },
      { id: "tool_capture_customer_data", name: "capture_customer_data", enabled: true },
      { id: "tool_escalate_to_human", name: "escalate_to_human", enabled: true },
    ],
    setupChecklist: [
      { done: true, label: "Webchat verbunden", owner: "admin" },
      { done: true, label: "Freigegebene Wissensquelle vorhanden", owner: "team" },
      { done: true, label: "Handoff-Regeln hinterlegt", owner: "team" },
    ],
    documentLibrary: [],
    actionPolicies: [
      {
        action: "Antwort senden",
        approval: "audit",
        rule: "Antworten duerfen nur aus freigegebenem Wissen mit Quelle entstehen.",
      },
      {
        action: "Unklare Frage uebergeben",
        approval: "required",
        rule: "Ohne Treffer in der Wissensbasis wird an das Verkaufsteam uebergeben.",
      },
    ],
    qaSeed: "livegang-8-10",
  };

  await queryOne(
    `
      insert into bots (
        id,
        workspace_id,
        project_id,
        name,
        description,
        role,
        status,
        model,
        strict_knowledge,
        audience,
        language,
        tone,
        answer_length,
        brand_voice,
        config
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'QA Seeblick Sales Bot',
        'Beantwortet Projektfragen nur aus freigegebenem Seeblick-Wissen und uebergibt ohne Quelle an das Team.',
        'sales_qualifier',
        'active',
        'openai/gpt-5.4',
        true,
        'Projekt Seeblick Interessenten',
        'de',
        'klar, freundlich, vorsichtig',
        'normal',
        'Novalure Real Estate Advisory',
        $4::jsonb
      )
      on conflict (id) do update set
        project_id = excluded.project_id,
        name = excluded.name,
        description = excluded.description,
        role = excluded.role,
        status = excluded.status,
        model = excluded.model,
        strict_knowledge = excluded.strict_knowledge,
        audience = excluded.audience,
        language = excluded.language,
        tone = excluded.tone,
        answer_length = excluded.answer_length,
        brand_voice = excluded.brand_voice,
        config = bots.config || excluded.config,
        updated_at = now()
      returning id
    `,
    [botId, record.workspace.id, projectId, json(config)],
  );

  await queryOne(
    `
      insert into knowledge_sources (
        id,
        workspace_id,
        project_id,
        name,
        source_type,
        status,
        coverage,
        item_count,
        location,
        metadata
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'Projektinfo Seeblick',
        'text',
        'Vector bereit',
        '100%',
        1,
        'QA Seed',
        $4::jsonb
      )
      on conflict (id) do update set
        project_id = excluded.project_id,
        name = excluded.name,
        source_type = excluded.source_type,
        status = excluded.status,
        coverage = excluded.coverage,
        item_count = excluded.item_count,
        location = excluded.location,
        metadata = knowledge_sources.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [sourceId, record.workspace.id, projectId, json({ approval: "approved", qaSeed: "livegang-8-10" })],
  );

  await queryOne(
    `
      insert into knowledge_chunks (
        source_id,
        chunk_index,
        content,
        citation_title,
        citation_url,
        token_count,
        embedding_model,
        metadata
      )
      values ($1::uuid, 0, $2, 'Projektinfo Seeblick', null, 80, 'deterministic-local-1536', $3::jsonb)
      on conflict (source_id, chunk_index) do update set
        content = excluded.content,
        citation_title = excluded.citation_title,
        token_count = excluded.token_count,
        embedding_model = excluded.embedding_model,
        metadata = knowledge_chunks.metadata || excluded.metadata
      returning id
    `,
    [sourceId, knowledgeText, json({ embeddingReady: true, qaSeed: "livegang-8-10" })],
  );
}

async function main() {
  const passwordHash = await hashPassword(qaPassword);

  for (const workspace of Object.values(workspaces)) {
    await upsertWorkspace(workspace);
  }

  for (const user of users) {
    user.id = await upsertUser(user, passwordHash);
  }

  for (const record of qaRecords) {
    const projectId = await upsertProject(record);
    await upsertPipeline(record.workspace, projectId);
    const ids = await upsertCoreRecords(record, projectId);
    await upsertObjectData(record, projectId, ids);
    await upsertBotAndKnowledge(record, projectId);
    for (const user of users.filter((item) => item.workspace.id === record.workspace.id && item.role !== "assistant")) {
      await upsertPipelinePermission(record.workspace, projectId, user);
    }
  }

  console.log("QA Livegang seed complete.");
  console.log("Workspaces:");
  for (const workspace of Object.values(workspaces)) {
    console.log(`- ${workspace.name}: ${workspace.id}`);
  }
  console.log("Users:");
  for (const user of users) {
    console.log(`- ${user.email} (${user.productRole})`);
  }
  if (qaPassword === defaultQaPassword) {
    console.log(`Default local QA password: ${defaultQaPassword}`);
    console.log("Override with NOVALURE_QA_SEED_PASSWORD for non-local test environments.");
  } else {
    console.log("QA password source: NOVALURE_QA_SEED_PASSWORD or NOVALURE_QA_PASSWORD.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
