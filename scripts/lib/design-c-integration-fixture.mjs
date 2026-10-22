import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "../../src/lib/auth/passwords.ts";
import {
  STUDIO_PROJECT_ID,
  STUDIO_WORKSPACE_ID,
} from "../../src/lib/studio-navigation.ts";
import { seedSalesBrowser } from "./sales-browser-fixture.mjs";
import {
  applySalesSchema,
  LocalSalesPool,
  startLocalSalesDb,
} from "./local-sales-db.mjs";

/**
 * Same disposable identity/database rehearsal as the existing Knowledge
 * production-predecessor test. Every pinned migration runs unchanged; these
 * local role names satisfy its real guard without weakening production SQL.
 */
export async function startDesignCIntegrationDatabase({ accountLanguagePreference = false } = {}) {
  const cluster = await startLocalSalesDb();
  let owner, bootstrap, runtime;
  try {
    await cluster.admin.query(
      "create role neondb_owner login nosuperuser bypassrls createdb createrole",
    );
    await cluster.admin.query(
      "create role qa_schema_bootstrap login superuser",
    );
    await cluster.admin.query("create database neondb owner neondb_owner");
    await cluster.admin.query("alter role novalure_app login inherit");
    const connection = {
      host: "127.0.0.1",
      port: cluster.port,
      database: "neondb",
      max: 4,
    };
    owner = new LocalSalesPool({ ...connection, user: "neondb_owner" });
    bootstrap = new LocalSalesPool({
      ...connection,
      user: "qa_schema_bootstrap",
    });
    runtime = new LocalSalesPool({ ...connection, user: cluster.role });
    const applied = await applySalesSchema(
      { ...cluster, admin: bootstrap, pool: runtime },
      { maxMigrationNumber: 90 },
    );
    await bootstrap.query(
      "reassign owned by qa_schema_bootstrap to neondb_owner",
    );
    await cluster.admin.query("alter role novalure_app noinherit");
    await cluster.admin.query(
      "grant novalure_tenant_app to novalure_app with inherit true,set false,admin false",
    );
    for (const filename of [
      "091_production_runtime_forced_rls_cutover.sql",
      "092_crm_production_machine_identity.sql",
      "093_crm_machine_internal_context.sql",
      "094_website_sales_ingestion.sql",
      "095_form_tenant_isolation.sql",
      "096_public_integration_gateway.sql",
      "100_studio_enquiry_production.sql",
      "101_knowledge_center.sql",
      "102_knowledge_document_processing.sql",
      "103_knowledge_assistant_service.sql",
      "104_knowledge_publication_workflow.sql",
      "105_knowledge_website_monitoring.sql",
      "106_crm_operational_readers.sql",
      "108_knowledge_connected_assistant_quota.sql",
      // Current browser acceptance needs the additive personal-language table;
      // predecessor-only database tests keep their original schema by default.
      ...(accountLanguagePreference ? ["110_account_ui_language_preference.sql"] : []),
    ]) {
      const sql = await readFile(path.resolve("migrations", filename), "utf8");
      const client = await owner.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          "insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)",
          [
            filename.slice(0, -4),
            filename,
            createHash("sha256")
              .update(sql.replace(/\r\n/g, "\n"))
              .digest("hex"),
          ],
        );
        await client.query("commit");
        applied.push(filename);
      } catch (error) {
        await client.query("rollback");
        throw new Error(
          `Unchanged Design C predecessor migration ${filename} failed: ${error.message}`,
          { cause: error },
        );
      } finally {
        client.release();
      }
    }
    const identity = await runtime.query(
      "select current_database() as database,current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
    );
    assert.deepEqual(identity.rows[0], {
      database: "neondb",
      role: cluster.role,
      rolsuper: false,
      rolbypassrls: false,
    });
    await writeFile(
      path.join(cluster.directory, "design-c-predecessor-evidence.json"),
      JSON.stringify(
        {
          syntheticOnly: true,
          productionAccess: 0,
          unmodifiedPinnedMigrations: true,
          optionalRagExcluded: true,
          manual062Excluded: true,
          preview097Through099Excluded: true,
          applied,
          runtime: identity.rows[0],
        },
        null,
        2,
      ),
    );
    let stopping;
    return {
      ...cluster,
      admin: bootstrap,
      pool: runtime,
      database: "neondb",
      fixtureMode: "design-c-actual-predecessors",
      stop() {
        if (stopping) return stopping;
        stopping = (async () => {
          await Promise.allSettled([
            owner.end(),
            bootstrap.end(),
            runtime.end(),
          ]);
          await cluster.stop();
        })();
        return stopping;
      },
    };
  } catch (error) {
    await Promise.allSettled([owner?.end(), bootstrap?.end(), runtime?.end()]);
    await cluster.stop();
    throw error;
  }
}

// Called only after the browser runner has verified the disposable loopback DB.
// No session, MFA secret, provider binding or authentication bypass is seeded.
export async function seedDesignCIntegration({ admin, role }) {
  const operator = await seedSalesBrowser({ admin, role });
  operator.name = "SYNTHETIC DESIGN C INTERNAL";
  operator.requiresMfa = true;
  await admin.query(
    "update workspaces set name='SYNTHETIC DESIGN C INTERNAL' where id=$1",
    [operator.workspaceId],
  );
  const secondProjectId = randomUUID();
  await admin.query(
    "insert into projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,'SYNTHETIC SECOND PROJECT','Bauträger','property_developer','novalure_internal')",
    [secondProjectId, operator.workspaceId],
  );
  await admin.query(
    "insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role) values($1,$2,$3,$4,'SYNTHETIC SECOND PROJECT CONTACT','second-project@example.invalid','Bauträger')",
    [randomUUID(), operator.workspaceId, secondProjectId, operator.userId],
  );

  async function customerWorkspace(name, foreign = false) {
    const workspaceId = randomUUID(),
      projectId = randomUUID(),
      userId = randomUUID();
    const email = `synthetic-design-c-${userId}@example.invalid`;
    const password = randomBytes(32).toString("base64url");
    await admin.query(
      "insert into workspaces(id,name,operating_model,customer_type) values($1,$2,'self_service_customer','property_developer')",
      [workspaceId, name],
    );
    const identity = await admin.query(
      "insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,$3,$4,'owner','customer_owner','active',now()) returning auth_identity_id",
      [userId, workspaceId, `${name} owner`, email],
    );
    const authIdentityId = identity.rows[0].auth_identity_id;
    await admin.query(
      "update auth_identities set credential_state='active',password_hash=$2 where id=$1",
      [authIdentityId, await hashPassword(password)],
    );
    await admin.query(
      "insert into projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,$3,'Bauträger','property_developer','self_service_customer')",
      [projectId, workspaceId, `${name} PROJECT`],
    );
    const contactId = randomUUID(),
      botId = randomUUID(),
      buildingId = randomUUID(),
      unitId = randomUUID();
    await admin.query(
      "insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,$6,'Käufer')",
      [
        contactId,
        workspaceId,
        projectId,
        userId,
        foreign
          ? "SYNTHETIC FOREIGN PRIVATE SENTINEL"
          : "SYNTHETIC CUSTOMER CONTACT",
        `contact-${contactId.replaceAll("-", "")}@example.invalid`,
      ],
    );
    await admin.query(
      "insert into property_buildings(id,workspace_id,project_id,name) values($1,$2,$3,$4)",
      [buildingId, workspaceId, projectId, `${name} BUILDING`],
    );
    await admin.query(
      "insert into property_units(id,workspace_id,project_id,building_id,unit_number,rooms,area_sqm,price_cents,status) values($1,$2,$3,$4,$5,3,82,49200000,'available')",
      [
        unitId,
        workspaceId,
        projectId,
        buildingId,
        foreign ? "FOREIGN-PRIVATE-UNIT" : "SYNTHETIC-C-01",
      ],
    );
    await admin.query(
      "insert into bots(id,workspace_id,project_id,name,role,status) values($1,$2,$3,$4,'advisor','Entwurf')",
      [botId, workspaceId, projectId, `${name} ASSISTANT`],
    );
    await admin.query(
      "insert into company_profiles(profile_scope,workspace_id,legal_name,display_name,country_code,public_email) values('workspace_owner',$1,$2,$2,'AT',$3)",
      [
        workspaceId,
        `${name} COMPANY`,
        `company-${workspaceId}@example.invalid`,
      ],
    );
    await admin.query(
      `insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits)
      values($1,true,20,10485760,50,'SYNTHETIC-LOCAL-DESIGN-C','{"websiteImport":true,"webchatAccess":true,"voiceAccess":true}'::jsonb,'{"maxAreas":10,"maxWebsites":3,"maxScansPerMonth":3,"maxUsers":10,"maxAssistants":10}'::jsonb)`,
      [workspaceId],
    );
    return {
      workspaceId,
      projectId,
      userId,
      authIdentityId,
      requiresMfa: true,
      email,
      password,
      contactId,
      botId,
      unitId,
      name,
    };
  }

  const customer = await customerWorkspace("SYNTHETIC DESIGN C CUSTOMER");
  const foreign = await customerWorkspace("SYNTHETIC DESIGN C FOREIGN", true);
  // A normal explicit membership grants the operator the second workspace.
  await admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'SYNTHETIC scoped operator',$3,'owner','customer_owner','active',now())",
    [randomUUID(), customer.workspaceId, operator.email],
  );
  // Migration 030 already creates the canonical Studio workspace/project in
  // this disposable DB. Add normal membership instead of forging a profile.
  await admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'SYNTHETIC Studio operator',$3,'owner','novalureAdmin','active',now())",
    [randomUUID(), STUDIO_WORKSPACE_ID, operator.email],
  );
  await admin.query(
    "insert into contacts(id,workspace_id,project_id,name,email,role) values($1,$2,$3,'SYNTHETIC STUDIO CONTACT','studio-design-c@example.invalid','Bauträger')",
    [randomUUID(), STUDIO_WORKSPACE_ID, STUDIO_PROJECT_ID],
  );
  const viewer = {
    requiresMfa: false,
    workspaceId: customer.workspaceId,
    userId: randomUUID(),
    email: `synthetic-viewer-${randomUUID()}@example.invalid`,
    password: randomBytes(32).toString("base64url"),
  };
  const identity = await admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'SYNTHETIC read-only customer',$3,'assistant','viewer','active',now()) returning auth_identity_id",
    [viewer.userId, viewer.workspaceId, viewer.email],
  );
  viewer.authIdentityId = identity.rows[0].auth_identity_id;
  await admin.query(
    "update auth_identities set credential_state='active',password_hash=$2 where id=$1",
    [viewer.authIdentityId, await hashPassword(viewer.password)],
  );
  const sessions = await admin.query(
    "select count(*)::int as count from auth_sessions where auth_identity_id=any($1::uuid[])",
    [[operator.authIdentityId, customer.authIdentityId, viewer.authIdentityId]],
  );
  assert.equal(
    sessions.rows[0].count,
    0,
    "All integration accounts must begin without a session",
  );
  return {
    operator,
    customer,
    foreign: {
      workspaceId: foreign.workspaceId,
      projectId: foreign.projectId,
      contactId: foreign.contactId,
      unitId: foreign.unitId,
      botId: foreign.botId,
    },
    viewer,
    secondProjectId,
    studio: { workspaceId: STUDIO_WORKSPACE_ID, projectId: STUDIO_PROJECT_ID },
  };
}

/** Representative records for the four read contracts; no provider is invoked. */
export async function seedDesignCReaderRows({ admin, accounts }) {
  const identity = await admin.query(
    "select current_database() as database,current_user as role",
  );
  assert.deepEqual(identity.rows[0], { database: "neondb", role: "qa_admin" });
  const secret = "SYNTHETIC_READER_SECRET_DO_NOT_RETURN";
  const groups = {};
  for (const [key, workspaceId, projectId, contactId, existingBotId] of [
    [
      "alpha",
      accounts.operator.workspaceId,
      accounts.operator.projectId,
      accounts.operator.developerContactId,
    ],
    ["beta", accounts.operator.workspaceId, accounts.secondProjectId],
    [
      "customer",
      accounts.customer.workspaceId,
      accounts.customer.projectId,
      accounts.customer.contactId,
      accounts.customer.botId,
    ],
    [
      "foreign",
      accounts.foreign.workspaceId,
      accounts.foreign.projectId,
      accounts.foreign.contactId,
      accounts.foreign.botId,
    ],
  ]) {
    const botId = existingBotId || randomUUID();
    const label =
      key === "foreign"
        ? "SYNTHETIC FOREIGN PRIVATE SENTINEL"
        : `SYNTHETIC READER ${key.toUpperCase()}`;
    if (!existingBotId)
      await admin.query(
        "insert into bots(id,workspace_id,project_id,name,role,status) values($1,$2,$3,$4,'assistant','Entwurf')",
        [botId, workspaceId, projectId, `${label} BOT`],
      );
    const conversationId = randomUUID(),
      approvalId = randomUUID(),
      accountId = randomUUID(),
      webhookId = randomUUID(),
      documentId = randomUUID();
    // The unchanged Knowledge history trigger requires an actual saved actor
    // context and canonical lower-case channel even for synthetic provisioning.
    const actor = await admin.query(
      "select id from workspace_users where workspace_id=$1 and status='active' and role='owner' order by id limit 1",
      [workspaceId],
    );
    assert.equal(actor.rows.length, 1);
    const client = await admin.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",
        [workspaceId, actor.rows[0].id],
      );
      await client.query(
        "insert into bot_conversations(id,workspace_id,project_id,bot_id,contact_id,title,metadata) values($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [
          conversationId,
          workspaceId,
          projectId,
          botId,
          contactId || null,
          `${label} CONVERSATION`,
          JSON.stringify({ channel: "webchat" }),
        ],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await admin.query(
      "insert into approval_requests(id,workspace_id,project_id,entity_type,entity_id,action,summary,payload,status) values($1,$2,$3,'bot_conversation',$4,'send_document',$5,$6::jsonb,'pending')",
      [
        approvalId,
        workspaceId,
        projectId,
        conversationId,
        `${label} APPROVAL`,
        JSON.stringify({
          botName: `${label} BOT`,
          channel: "Webchat",
          prompt: `${label} MESSAGE`,
          qualification: { score: 42, stage: "new" },
          requestedActions: { document: true, meeting: false },
          credentials: { accessToken: secret },
          rawProviderResponse: { token: secret },
        }),
      ],
    );
    await admin.query(
      "insert into bot_channel_accounts(id,workspace_id,bot_id,channel,provider,account_label,external_account_id,active,setup_status,credentials_ref,metadata) values($1,$2,$3,'Webchat','synthetic-local',$4,$5,true,'connected',$6,$7::jsonb)",
      [
        accountId,
        workspaceId,
        botId,
        `${label} ACCOUNT`,
        `synthetic-${accountId.replaceAll("-", "")}`,
        secret,
        JSON.stringify({
          credentials: { accessToken: secret },
          privateToken: secret,
        }),
      ],
    );
    await admin.query(
      "insert into bot_channel_webhooks(id,workspace_id,channel_account_id,channel,external_message_id,event_type,payload,normalized_message,status) values($1,$2,$3,'Webchat',$4,'message',$5::jsonb,$6::jsonb,'received')",
      [
        webhookId,
        workspaceId,
        accountId,
        `evt_${createHash("sha256").update(webhookId).digest("hex")}`,
        JSON.stringify({ token: secret, headers: { authorization: secret } }),
        JSON.stringify({
          text: `${label} MESSAGE`,
          senderName: "Synthetic reader",
          credentials: { accessToken: secret },
          rawProviderResponse: { token: secret },
        }),
      ],
    );
    await admin.query(
      "insert into bot_document_sends(id,workspace_id,bot_id,conversation_id,contact_id,channel,document_name,status,approval_request_id,metadata) values($1,$2,$3,$4,$5,'Webchat',$6,'approval_required',$7,$8::jsonb)",
      [
        documentId,
        workspaceId,
        botId,
        conversationId,
        contactId || null,
        `${label} DOCUMENT`,
        approvalId,
        JSON.stringify({
          documentUrl: `https://private.invalid/${secret}`,
          asset: { token: secret },
          providerResponse: { accessToken: secret },
          customerData: { name: "Synthetic reader" },
        }),
      ],
    );
    groups[key] = {
      workspaceId,
      projectId,
      botId,
      conversationId,
      approvalId,
      accountId,
      webhookId,
      documentId,
      label,
    };
  }
  await admin.query(
    "insert into provider_connections(workspace_id,provider,status,account_label,scopes,config) values($1,'google-calendar','connected','SYNTHETIC READER CUSTOMER CALENDAR',ARRAY['calendar.read'],$2::jsonb)",
    [
      accounts.customer.workspaceId,
      JSON.stringify({
        accessTokenEncrypted: secret,
        refreshTokenEncrypted: secret,
        clientSecret: secret,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ],
  );
  return { groups, secret };
}
