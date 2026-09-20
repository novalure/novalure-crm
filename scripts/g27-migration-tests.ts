import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import pg, { type Pool } from "pg";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const upgradeMigrations = [
  "080_crm_command_safety.sql",
  "081_crm_offer_workflow.sql",
  "082_crm_property_sales_workflow.sql",
  "083_crm_core_cas.sql",
  "084_crm_contract_service_boundary.sql",
  "085_crm_approval_evidence.sql",
  "086_crm_evelyn_preview_contract.sql",
] as const;

const sqlError = (code: string) => (error: unknown) => (error as { code?: string })?.code === code;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
};
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const snapshotHash = (snapshot: unknown) => digest({ hashContractVersion: "financial-snapshot-hash-v1", snapshot });
const policyHash = (policy: unknown) => digest({ hashContractVersion: "crm-financial-policy-content-hash-v1", policy });
const evelynDerivedId = (key: string, suffix: string) => {
  const bytes = createHash("sha256").update(`crm-evelyn:${key}:${suffix}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

async function nativePgTool(name: "pg_dump" | "pg_restore", args: string[]) {
  const executable = process.env.CRM_QA_PG_BIN
    ? path.join(path.resolve(process.env.CRM_QA_PG_BIN), name + (process.platform === "win32" ? ".exe" : ""))
    : name;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|comspec|pathext|lang|lc_all)$/i.test(key))),
  };
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} exceeded 60 second local QA limit`));
    }, 60_000);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(new Error(`${name} required via CRM_QA_PG_BIN/PATH; no skip is permitted`, { cause: error }));
    });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${name} failed (${code}): ${output.slice(-2000)}`));
    });
  });
}

async function g27Catalog(pool: Pool) {
  const result = await pool.query(`
    select 'column' kind,table_name relation,column_name name,
      concat(data_type,':',numeric_precision,':',numeric_scale,':',is_nullable,':',column_default) definition
      from information_schema.columns where table_schema='public'
        and table_name='crm_conversion_snapshots' and column_name='closed_revenue_cents'
    union all select 'constraint',conrelid::regclass::text,conname,pg_get_constraintdef(oid)
      from pg_constraint where connamespace='public'::regnamespace
        and conrelid::regclass::text in('crm_financial_policy_versions','crm_financial_snapshots','crm_financial_events','crm_evelyn_contract_revisions')
    union all select 'function','public',proname||oidvectortypes(proargtypes),pg_get_functiondef(oid)
      from pg_proc where pronamespace='public'::regnamespace and prokind='f'
        and (proname like 'crm_financial_%' or proname in('crm_record_deal_financial_fixation','crm_record_property_sale_financial_fixation','crm_evelyn_contract_revision_financial_guard','crm_deal_stage_permission_guard'))
    union all select 'index',tablename,indexname,indexdef from pg_indexes
      where schemaname='public' and tablename in('crm_financial_policy_versions','crm_financial_snapshots','crm_financial_events','crm_evelyn_contract_revisions')
    union all select 'policy',tablename,policyname,concat(cmd,':',qual,':',with_check) from pg_policies
      where schemaname='public' and tablename in('crm_financial_policy_versions','crm_financial_snapshots','crm_financial_events')
    union all select 'relation','public',relname,concat('rls=',relrowsecurity,':force=',relforcerowsecurity) from pg_class
      where relnamespace='public'::regnamespace and relname in('crm_financial_policy_versions','crm_financial_snapshots','crm_financial_events')
    union all select 'trigger',tgrelid::regclass::text,tgname,pg_get_triggerdef(oid) from pg_trigger
      where not tgisinternal and (tgrelid::regclass::text in('crm_financial_policy_versions','crm_financial_snapshots','crm_financial_events')
        or tgname in('crm_deal_financial_fixation','crm_deal_financial_fixation_insert','crm_property_sale_financial_fixation','crm_evelyn_contract_revision_financial_binding','crm_deal_stage_permission_insert','crm_deal_stage_permission_update'))
    order by 1,2,3,4
  `);
  return digest(result.rows);
}

async function g27Data(pool: Pool) {
  return (await pool.query(`
    select jsonb_build_object(
      'ledger',coalesce((select jsonb_agg(to_jsonb(row_value) order by version) from (
        select version,name,checksum from novalure_schema_migrations where version='087_crm_financial_snapshots'
      ) row_value),'[]'::jsonb),
      'policies',coalesce((select jsonb_agg(to_jsonb(row_value) order by workspace_id,project_id,policy_kind,policy_id,policy_version) from crm_financial_policy_versions row_value),'[]'::jsonb),
      'snapshots',coalesce((select jsonb_agg(to_jsonb(row_value) order by workspace_id,resource_type,resource_id,business_version) from crm_financial_snapshots row_value),'[]'::jsonb),
      'events',coalesce((select jsonb_agg(to_jsonb(row_value) order by sequence) from crm_financial_events row_value),'[]'::jsonb),
      'revisions',coalesce((select jsonb_agg(to_jsonb(row_value) order by workspace_id,action_id,version) from crm_evelyn_contract_revisions row_value),'[]'::jsonb),
      'conversionSnapshots',coalesce((select jsonb_agg(to_jsonb(row_value) order by id) from (
        select id,workspace_id,project_id,source,period_start,period_end,closed_revenue_cents::text closed_revenue_minor_units
        from crm_conversion_snapshots
      ) row_value),'[]'::jsonb)
    ) state
  `)).rows[0].state;
}

async function applyMigration(db: Awaited<ReturnType<typeof startLocalSalesDb>>, name: string) {
  const sql = await readFile(path.join("migrations", name), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query(
      "insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3) on conflict(version) do nothing",
      [name.replace(/\.sql$/, ""), name, checksum],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function goldenSnapshot() {
  const id = (suffix: string) => `20000000-0000-4000-8000-000000000${suffix}`;
  const reference = (name: string, version: string, digit: string) => ({
    id: `SYNTHETIC:${name}`,
    version,
    contentHash: digit.repeat(64),
  });
  const money = (minorUnits: string) => ({ minorUnits, currency: "EUR", minorUnitExponent: 2 });
  return {
    snapshotSchemaVersion: "financial-snapshot-v1",
    snapshotId: id("201"),
    businessVersion: 1,
    tenantId: id("203"),
    resourceId: id("205"),
    reviewState: "COMPLETE",
    effectiveAt: "2026-09-18T12:00:00.000Z",
    currency: "EUR",
    minorUnitExponent: 2,
    currencyDefinition: {
      standard: "ISO-4217",
      code: "EUR",
      minorUnitExponent: 2,
      registryReference: reference("currency-registry", "2026-09-18", "1"),
      verifiedAt: "2026-09-18T12:00:00.000Z",
    },
    jurisdiction: "SYNTHETIC:BUSINESS",
    components: [{
      componentId: "line-setup",
      kind: "LINE",
      net: money("2037000"),
      tax: money("10000"),
      gross: money("2047000"),
      pricingReference: reference("line-price", "1", "2"),
      taxComponents: [{
        componentId: "tax-setup",
        amount: money("10000"),
        policy: {
          reference: reference("tax-policy", "7", "3"),
          jurisdiction: "SYNTHETIC:TAX",
          sourceProvenance: {
            authority: "SYNTHETIC authority",
            sourceReference: "SYNTHETIC controlled source",
            jurisdiction: "SYNTHETIC:TAX",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            effectiveTo: null,
            policyVersion: "7",
            verifiedAt: "2026-09-18T12:00:00.000Z",
          },
        },
      }],
    }],
    totals: { net: money("2037000"), tax: money("10000"), gross: money("2047000") },
    roundingPolicy: reference("rounding", "4", "4"),
    pricingReference: reference("accepted-offer", "9", "5"),
    provenance: {
      sourceSystem: "SYNTHETIC CRM",
      sourceRecordId: id("206"),
      sourceVersion: "11",
      sourceHash: "6".repeat(64),
      recordedAt: "2026-09-18T12:00:00.000Z",
      recordedBy: id("207"),
    },
  };
}

type Fixture = ReturnType<typeof fixtureIds>;
function fixtureIds() {
  const offer = randomUUID();
  return {
    workspace: randomUUID(), foreignWorkspace: randomUUID(), owner: randomUUID(), foreignOwner: randomUUID(), secondActor: randomUUID(),
    project: randomUUID(), foreignProject: randomUUID(), organization: randomUUID(), contact: randomUUID(), developerContact: randomUUID(), lead: randomUUID(),
    dealBound: randomUUID(), dealUnbound: randomUUID(), offer, offerRevision: randomUUID(), approval: randomUUID(), authSession: randomUUID(),
    action: evelynDerivedId(offer, "contract"), saleBound: randomUUID(), saleUnbound: randomUUID(), unitBound: randomUUID(), unitUnbound: randomUUID(),
    reservationBound: randomUUID(), reservationUnbound: randomUUID(), authority: randomUUID(), audit: randomUUID(),
    propertyCost: randomUUID(), propertyCostItemA: randomUUID(), propertyCostItemB: randomUUID(),
    conversionSnapshot: randomUUID(),
  };
}

async function seedLegacy(db: Awaited<ReturnType<typeof startLocalSalesDb>>, ids: Fixture) {
  await db.admin.query(
    "insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC G27','self_service_customer','property_developer',$3::jsonb),($2,'SYNTHETIC foreign','self_service_customer','real_estate_broker','{}')",
    [ids.workspace, ids.foreignWorkspace, JSON.stringify({ salesApprovalUserId: ids.owner })],
  );
  const actor = await db.admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$3,'SYNTHETIC owner',$4,'owner','customer_owner','active'),($2,$3,'SYNTHETIC other',$5,'agent','developer_sales','active') returning id,auth_identity_id",
    [ids.owner, ids.secondActor, ids.workspace, `${ids.owner}@example.invalid`, `${ids.secondActor}@example.invalid`],
  );
  const identity = actor.rows.find(row => row.id === ids.owner)?.auth_identity_id;
  await db.admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC foreign owner',$3,'owner','customer_owner','active')",
    [ids.foreignOwner, ids.foreignWorkspace, `${ids.foreignOwner}@example.invalid`],
  );
  await db.admin.query(
    "insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,created_at,last_seen_at,expires_at) values($1,$2,$3,$4,$5,'2026-08-31T10:00:00Z','2026-08-31T10:00:00Z','2026-08-31T10:00:00Z','2030-01-01T00:00:00Z')",
    [ids.authSession, "7".repeat(64), identity, ids.owner, ids.workspace],
  );
  await db.admin.query(
    "insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC G27 project','Bauträger'),($3,$4,'SYNTHETIC foreign project','Service')",
    [ids.project, ids.workspace, ids.foreignProject, ids.foreignWorkspace],
  );
  await db.admin.query(
    "insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",
    [ids.workspace, ids.project, ids.secondActor],
  );
  await db.admin.query(
    "insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC developer','Bauträger')",
    [ids.organization, ids.workspace, ids.project],
  );
  await db.admin.query("update projects set developer_organization_id=$2 where id=$1", [ids.project, ids.organization]);
  await db.admin.query(
    "insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,role,email) values($1,$3,$4,$5,$6,'SYNTHETIC buyer','Kunde','buyer@example.invalid'),($2,$3,$4,$5,$6,'SYNTHETIC developer','Bauträger','developer@example.invalid')",
    [ids.contact, ids.developerContact, ids.workspace, ids.project, ids.organization, ids.owner],
  );
  await db.admin.query(
    "insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status) values($1,$2,$3,$4,$5,'Manual','Käufer','Qualifiziert')",
    [ids.lead, ids.workspace, ids.project, ids.contact, ids.owner],
  );
  await db.admin.query(
    "insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents,version,closed_at) values($1,$3,$4,$5,$6,$7,$8,'SYNTHETIC bound win','Gewonnen',2037000,4,'2026-09-01T10:00:00Z'),($2,$3,$4,$5,$6,$7,$8,'SYNTHETIC ambiguous win','Gewonnen',987654321,3,'2026-09-02T10:00:00Z')",
    [ids.dealBound, ids.dealUnbound, ids.workspace, ids.project, ids.contact, ids.organization, ids.lead, ids.owner],
  );
  const content = { subject: "SYNTHETIC accepted offer", recipientName: "SYNTHETIC buyer", recipientEmail: "buyer@example.invalid", terms: "SYNTHETIC", validUntil: "2027-01-01T00:00:00.000Z", currency: "EUR", taxBasis: "NET", items: [{ description: "Setup", quantity: 1, unitNetCents: 2037000 }] };
  const contentDigest = digest({
    action: "offer.send", workspaceId: ids.workspace, projectId: ids.project, offerId: ids.offer, revision: 1,
    contactId: ids.contact, leadId: ids.lead, organizationId: ids.organization, content, totalNetCents: 2037000,
  });
  await db.admin.query(
    "insert into crm_offers(id,workspace_id,project_id,deal_id,contact_id,lead_id,organization_id,status,revision,version,follow_up_status,response_reference,response_actor_id,created_by,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,'ACCEPTED',1,7,'STOPPED','SYNTHETIC accepted',$8,$8,'2026-08-31T10:00:00.123Z','2026-09-01T10:00:00Z')",
    [ids.offer, ids.workspace, ids.project, ids.dealBound, ids.contact, ids.lead, ids.organization, ids.owner],
  );
  await db.admin.query(
    "insert into crm_offer_revisions(id,workspace_id,project_id,offer_id,revision,content,content_digest,total_net_cents,created_by,created_at) values($1,$2,$3,$4,1,$5::jsonb,$6,2037000,$7,'2026-08-31T10:00:00.123Z')",
    [ids.offerRevision, ids.workspace, ids.project, ids.offer, JSON.stringify(content), contentDigest, ids.owner],
  );
  await db.admin.query(
    "insert into crm_offer_approvals(id,workspace_id,project_id,offer_id,revision,content_digest,actor_id,auth_session_reference,decision,expires_at,created_at) values($1,$2,$3,$4,1,$5,$6,$7,'APPROVED','2027-01-01T00:00:00Z','2026-08-31T11:00:00Z')",
    [ids.approval, ids.workspace, ids.project, ids.offer, contentDigest, ids.owner, ids.authSession],
  );
  await db.admin.query("update crm_offers set approval_id=$2 where id=$1", [ids.offer, ids.approval]);
  await db.admin.query(
    "insert into deal_stage_history(workspace_id,project_id,deal_id,from_stage,to_stage,changed_by_user_id,reason,reason_category,changed_at,metadata) values($1,$2,$3,'Verhandlung','Gewonnen',$5,'Offer accepted','won','2026-09-01T10:00:00.000Z',$6::jsonb),($1,$2,$4,'Verhandlung','Gewonnen',$5,'Legacy won','won','2026-09-02T10:00:00.000Z','{}')",
    [ids.workspace, ids.project, ids.dealBound, ids.dealUnbound, ids.owner, JSON.stringify({
      offerId: ids.offer, revision: 1, contentDigest, approvalReference: ids.approval,
      responseReference: "SYNTHETIC accepted", auditReference: randomUUID(), correlationId: randomUUID(), contractSent: false,
    })],
  );
  const action = { tenantId: ids.workspace, actionId: ids.action, actionVersion: 1, actionType: "contract.send", resourceId: ids.action, amount: 2037000 };
  await db.admin.query(
    "insert into crm_evelyn_contract_actions(id,workspace_id,project_id,offer_id,created_by,correlation_id,version,offer_version,offer_revision,source_approval_id,source_content_digest) values($1,$2,$3,$4,$5,$6,1,7,1,$7,$8)",
    [ids.action, ids.workspace, ids.project, ids.offer, ids.owner, randomUUID(), ids.approval, contentDigest],
  );
  await db.admin.query(
    "insert into crm_evelyn_contract_revisions(workspace_id,project_id,action_id,version,created_by,action,action_hash,created_at) values($1,$2,$3,1,$4,$5::jsonb,$6,'2026-09-01T11:00:00Z')",
    [ids.workspace, ids.project, ids.action, ids.owner, JSON.stringify(action), digest(action)],
  );
  await db.admin.query(
    "insert into crm_project_sales_authorities(id,workspace_id,project_id,user_id,developer_organization_id,contact_id,can_confirm_price,can_confirm_reservation,can_confirm_sale,assignment_source,assigned_by) values($1,$2,$3,$4,$5,$6,true,true,true,'SYNTHETIC authority',$4)",
    [ids.authority, ids.workspace, ids.project, ids.owner, ids.organization, ids.developerContact],
  );
  await db.admin.query(
    "insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents,version,buyer_contact_id) values($1,$3,$4,'SYN-B','sold',999,9,$5),($2,$3,$4,'SYN-C','sold',888,9,$5)",
    [ids.unitBound, ids.unitUnbound, ids.workspace, ids.project, ids.contact],
  );
  await db.admin.query(
    "insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,status,expires_at,buyer_lead_id,version,confirmation) values($1,$3,$4,$5,$7,'converted','2027-01-01T00:00:00Z',$8,3,'{}'),($2,$3,$4,$6,$7,'converted','2027-01-01T00:00:00Z',$8,3,'{}')",
    [ids.reservationBound, ids.reservationUnbound, ids.workspace, ids.project, ids.unitBound, ids.unitUnbound, ids.contact, ids.lead],
  );
  await db.admin.query(
    "insert into property_sales(id,workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,authority_id,confirmed_by,source_reference,confirmed_at,unit_version) values($1,$3,$4,$5,$7,$9,$10,$11,$12,'SYNTHETIC sale B','2026-09-03T10:00:00Z',4),($2,$3,$4,$6,$8,$9,$10,$11,$12,'SYNTHETIC sale C','2026-09-04T10:00:00Z',8)",
    [ids.saleBound, ids.saleUnbound, ids.workspace, ids.project, ids.unitBound, ids.unitUnbound, ids.reservationBound, ids.reservationUnbound, ids.lead, ids.contact, ids.authority, ids.owner],
  );
  await db.admin.query(
    "insert into property_unit_audit_events(id,workspace_id,project_id,unit_id,actor_user_id,event_type,before,after,reason,created_at) values($1,$2,$3,$4,$5,'authorized_sales_transition',$6::jsonb,$7::jsonb,'SYNTHETIC sold','2026-09-03T10:00:00Z')",
    [ids.audit, ids.workspace, ids.project, ids.unitBound, ids.owner, JSON.stringify({ status: "reserved", priceCents: "35000000", version: 3 }), JSON.stringify({ status: "sold", version: 4, saleId: ids.saleBound })],
  );
  await db.admin.query(
    "insert into seller_listings(id,workspace_id,project_id,seller_lead_id,title,address,region,object_type,area_sqm,market_value_cents,target_price_cents,created_at,updated_at) values($1,$2,$3,$4,'SYNTHETIC cost property','SYNTHETIC address','SYNTHETIC','apartment',50,0,0,'2026-08-01T09:00:00Z','2026-08-01T09:00:00Z')",
    [ids.propertyCost, ids.workspace, ids.project, ids.lead],
  );
  await db.admin.query(`
    insert into property_cost_items(
      id,workspace_id,project_id,property_id,cost_key,group_key,label,
      monthly_net_cents,monthly_vat_cents,monthly_gross_cents,
      one_time_net_cents,one_time_vat_cents,one_time_gross_cents,vat_percent,
      optional,commission_relevant,expose_visible,position,created_at,updated_at
    ) values
      ($1,$3,$4,$5,'operating','monthly','SYNTHETIC operating',1000,200,1200,0,0,0,20,false,false,true,2,'2026-08-02T09:00:00Z','2026-08-03T09:00:00Z'),
      ($2,$3,$4,$5,'commission','purchase','SYNTHETIC commission',500,99,600,10000,2000,12000,null,true,true,false,1,'2026-08-01T08:00:00Z','2026-08-04T09:00:00Z')
  `, [ids.propertyCostItemA, ids.propertyCostItemB, ids.workspace, ids.project, ids.propertyCost]);
  return { contentDigest };
}

async function withTenant<T>(db: Awaited<ReturnType<typeof startLocalSalesDb>>, tenant: string, actor: string, run: (client: import("pg").PoolClient) => Promise<T>) {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [tenant, actor]);
    const result = await run(client);
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function commitTenant<T>(db: Awaited<ReturnType<typeof startLocalSalesDb>>, tenant: string, actor: string, run: (client: import("pg").PoolClient) => Promise<T>) {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [tenant, actor]);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

test("G27 migration installs fresh and upgrades realistic legacy evidence without guessing", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { includeSales: false });
    for (const name of upgradeMigrations) await applyMigration(db, name);
    const ids = fixtureIds();
    await seedLegacy(db, ids);
    await applyMigration(db, "087_crm_financial_snapshots.sql");

    await t.test("Evelyn snapshot and CRM policy hash domains match their golden vectors", async () => {
      const snapshot = goldenSnapshot();
      const policy = { policySchemaVersion: "crm-currency-policy-v1", kind: "CURRENCY", standard: "ISO-4217", code: "EUR", minorUnitExponent: 2, verifiedAt: "2026-09-18T12:00:00.000Z" };
      const row = (await db.admin.query(
        "select crm_financial_snapshot_v1_valid($1::jsonb) valid,crm_financial_snapshot_hash($1::jsonb) snapshot_hash,crm_financial_policy_hash($2::jsonb) policy_hash",
        [JSON.stringify(snapshot), JSON.stringify(policy)],
      )).rows[0];
      assert.equal(row.valid, true);
      assert.equal(snapshotHash(snapshot), "38f8d55c2596589418a2e0c77945bd593f59e1f2c6944b20f4e6a5bd2a17a878");
      assert.equal(row.snapshot_hash, snapshotHash(snapshot));
      assert.equal(policyHash(policy), "d343ef3595f49cdf5e312702c053371f4b22c0efd7fb0d7696a758530b2c6ee5");
      assert.equal(row.policy_hash, policyHash(policy));
    });

    await t.test("SQL validators reject explicit JSON null in every required text and instant field", async () => {
      const requiredPaths: Array<Array<string | number>> = [
        ["snapshotSchemaVersion"],
        ["currencyDefinition", "standard"],
        ["currencyDefinition", "code"],
        ["currencyDefinition", "verifiedAt"],
        ["components", 0, "kind"],
        ["components", 0, "taxComponents", 0, "policy", "jurisdiction"],
        ["components", 0, "taxComponents", 0, "policy", "sourceProvenance", "authority"],
        ["components", 0, "taxComponents", 0, "policy", "sourceProvenance", "sourceReference"],
        ["components", 0, "taxComponents", 0, "policy", "sourceProvenance", "jurisdiction"],
        ["components", 0, "taxComponents", 0, "policy", "sourceProvenance", "effectiveFrom"],
        ["components", 0, "taxComponents", 0, "policy", "sourceProvenance", "policyVersion"],
        ["components", 0, "taxComponents", 0, "policy", "sourceProvenance", "verifiedAt"],
        ["provenance", "recordedAt"],
      ];

      for (const path of requiredPaths) {
        const candidate = structuredClone(goldenSnapshot()) as Record<string | number, unknown>;
        let parent: Record<string | number, unknown> = candidate;
        for (const segment of path.slice(0, -1)) {
          parent = parent[segment] as Record<string | number, unknown>;
        }
        parent[path.at(-1)!] = null;
        const valid = (await db.admin.query(
          "select crm_financial_snapshot_v1_valid($1::jsonb) valid",
          [JSON.stringify(candidate)],
        )).rows[0].valid;
        assert.equal(valid, false, `${path.join(".")} must fail closed when explicitly null`);
      }

      const roundingPolicy = {
        policySchemaVersion: "crm-rounding-policy-v1",
        kind: "ROUNDING",
        mode: null,
        currencyExponent: 2,
        scope: "TAX_COMPONENT",
      };
      const roundingValid = (await db.admin.query(
        "select crm_financial_policy_payload_valid($1::jsonb) valid",
        [JSON.stringify(roundingPolicy)],
      )).rows[0].valid;
      assert.equal(roundingValid, false, "ROUNDING.mode must fail closed when explicitly null");

      const taxPolicy = {
        policySchemaVersion: "crm-tax-policy-v1",
        kind: "TAX",
        jurisdiction: "AT",
        treatment: "SYNTHETIC standard tax",
        category: "SYNTHETIC standard",
        rate: { basis: "NET", numerator: "20", denominator: "100" },
        sourceProvenance: {
          authority: "SYNTHETIC authority",
          sourceReference: "SYNTHETIC controlled source",
          jurisdiction: "AT",
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          effectiveTo: null,
          policyVersion: "1",
          verifiedAt: "2026-09-18T12:00:00.000Z",
        },
      };
      assert.equal((await db.admin.query(
        "select crm_financial_policy_payload_valid($1::jsonb) valid",
        [JSON.stringify(taxPolicy)],
      )).rows[0].valid, true);

      const scalarMutations: Array<[string, (candidate: Record<string, unknown>) => void]> = [
        ["jurisdiction", candidate => {
          candidate.jurisdiction = 123;
          (candidate.sourceProvenance as Record<string, unknown>).jurisdiction = 123;
        }],
        ["treatment", candidate => { candidate.treatment = 123; }],
        ["category", candidate => { candidate.category = 123; }],
        ["rate.numerator", candidate => { (candidate.rate as Record<string, unknown>).numerator = 20; }],
        ["rate.denominator", candidate => { (candidate.rate as Record<string, unknown>).denominator = 100; }],
        ["sourceProvenance.authority", candidate => { (candidate.sourceProvenance as Record<string, unknown>).authority = 123; }],
        ["sourceProvenance.sourceReference", candidate => { (candidate.sourceProvenance as Record<string, unknown>).sourceReference = 123; }],
        ["sourceProvenance.policyVersion", candidate => { (candidate.sourceProvenance as Record<string, unknown>).policyVersion = 1; }],
      ];
      for (const [label, mutate] of scalarMutations) {
        const candidate = structuredClone(taxPolicy) as unknown as Record<string, unknown>;
        mutate(candidate);
        assert.equal((await db.admin.query(
          "select crm_financial_policy_payload_valid($1::jsonb) valid",
          [JSON.stringify(candidate)],
        )).rows[0].valid, false, `TAX.${label} must remain a JSON string`);
      }
    });

    await t.test("backfill classifies only immutable evidence and excludes mutable current amounts", async () => {
      const rows = (await db.admin.query(
        "select resource_type,resource_id,legacy_classification,review_state,canonical_snapshot,legacy_evidence,snapshot_hash from crm_financial_snapshots order by resource_type,resource_id",
      )).rows;
      assert.equal(rows.length, 6);
      assert.deepEqual((await db.admin.query("select legacy_classification,count(*)::int count from crm_financial_snapshots group by legacy_classification order by legacy_classification")).rows, [
        { legacy_classification: "B", count: 4 },
        { legacy_classification: "C", count: 2 },
      ]);
      assert.ok(rows.every(row => row.review_state === "NEEDS_REVIEW" && row.canonical_snapshot.reviewState === "NEEDS_REVIEW"));
      assert.ok(rows.every(row => row.snapshot_hash === snapshotHash(row.canonical_snapshot)));
      const offer = rows.find(row => row.resource_type === "OFFER");
      const boundDeal = rows.find(row => row.resource_type === "DEAL" && row.resource_id === ids.dealBound);
      const unboundDeal = rows.find(row => row.resource_type === "DEAL" && row.resource_id === ids.dealUnbound);
      const boundSale = rows.find(row => row.resource_type === "PROPERTY_SALE" && row.resource_id === ids.saleBound);
      const unboundSale = rows.find(row => row.resource_type === "PROPERTY_SALE" && row.resource_id === ids.saleUnbound);
      const propertyCosts = rows.find(row => row.resource_type === "PROPERTY_COST_MATRIX" && row.resource_id === ids.propertyCost);
      assert.equal(offer?.canonical_snapshot.totals.net.minorUnits, "2037000");
      assert.equal(boundDeal?.canonical_snapshot.totals.net.minorUnits, "2037000");
      assert.equal(unboundDeal?.canonical_snapshot.totals.net, null);
      assert.equal(unboundDeal?.legacy_evidence.mutableDealValueExcluded, true);
      assert.doesNotMatch(JSON.stringify(unboundDeal), /987654321/);
      assert.equal(boundSale?.legacy_evidence.saleTimePriceMinorUnits, "35000000");
      assert.equal(boundSale?.canonical_snapshot.totals.net, null, "price evidence is not mislabeled as net without currency/tax semantics");
      assert.equal(unboundSale?.legacy_evidence.saleTimePriceMinorUnits, null);
      assert.doesNotMatch(JSON.stringify(unboundSale), /\b888\b/);
      assert.equal(propertyCosts?.canonical_snapshot.currency, null);
      assert.deepEqual(propertyCosts?.canonical_snapshot.totals, { net: null, tax: null, gross: null });
      assert.equal(propertyCosts?.canonical_snapshot.effectiveAt, null);
      assert.equal(propertyCosts?.legacy_evidence.currencyUnknown, true);
      assert.equal(propertyCosts?.legacy_evidence.taxPolicyUnknown, true);
      assert.equal(propertyCosts?.legacy_evidence.roundingPolicyUnknown, true);
      assert.deepEqual(propertyCosts?.legacy_evidence.items.map((item: Record<string, unknown>) => ({
        costKey: item.costKey,
        monthlyNetMinorUnits: item.monthlyNetMinorUnits,
        monthlyTaxMinorUnits: item.monthlyTaxMinorUnits,
        monthlyGrossMinorUnits: item.monthlyGrossMinorUnits,
      })), [
        { costKey: "commission", monthlyNetMinorUnits: "500", monthlyTaxMinorUnits: "99", monthlyGrossMinorUnits: "600" },
        { costKey: "operating", monthlyNetMinorUnits: "1000", monthlyTaxMinorUnits: "200", monthlyGrossMinorUnits: "1200" },
      ]);
      const propertyCostEvidenceHash = digest({
        contractVersion: "property-cost-legacy-evidence-v1",
        evidence: propertyCosts?.legacy_evidence,
      });
      assert.equal(propertyCosts?.canonical_snapshot.pricingReference.contentHash, propertyCostEvidenceHash);
      assert.equal(propertyCosts?.canonical_snapshot.provenance.sourceHash, propertyCostEvidenceHash);
      assert.ok(propertyCosts?.canonical_snapshot.missingFields.includes("taxPolicy"));
      assert.equal((await db.admin.query("select count(*)::int count from crm_financial_events where event_type='LEGACY_NEEDS_REVIEW'")).rows[0].count, 6);
    });

    await t.test("backfill rerun is deterministic and V1 rows retain explicit defaults", async () => {
      const before = (await db.admin.query("select id,snapshot_hash,canonical_snapshot,legacy_evidence from crm_financial_snapshots order by id")).rows;
      assert.deepEqual((await db.admin.query("select * from crm_backfill_g27_financial_snapshots()")).rows, [{ inserted_snapshots: 0, inserted_events: 0 }]);
      assert.deepEqual((await db.admin.query("select id,snapshot_hash,canonical_snapshot,legacy_evidence from crm_financial_snapshots order by id")).rows, before);
      const legacy = (await db.admin.query("select approval_contract_version,financial_snapshot_id,financial_snapshot_hash from crm_evelyn_contract_revisions where action_id=$1", [ids.action])).rows[0];
      assert.deepEqual(legacy, { approval_contract_version: "v1", financial_snapshot_id: null, financial_snapshot_hash: null });
      const defaultRow = (await db.admin.query("select column_default from information_schema.columns where table_name='crm_evelyn_contract_revisions' and column_name='approval_contract_version'")).rows[0];
      assert.match(defaultRow.column_default, /'v1'/);
      const revenueColumn = (await db.admin.query(`
        select data_type,numeric_precision,numeric_scale from information_schema.columns
        where table_schema='public' and table_name='crm_conversion_snapshots' and column_name='closed_revenue_cents'
      `)).rows[0];
      assert.deepEqual(revenueColumn, { data_type: "numeric", numeric_precision: 78, numeric_scale: 0 });
      const moneyV2Maximum = "9".repeat(78);
      const storedAggregate = (await db.admin.query(`
        insert into crm_conversion_snapshots(
          id,workspace_id,project_id,source,period_start,period_end,closed_revenue_cents
        ) values($1,$2,$3,'SYNTHETIC G27 MoneyV2 aggregate','2026-09-01T00:00:00Z','2026-10-01T00:00:00Z',$4::numeric)
        returning closed_revenue_cents::text value
      `, [ids.conversionSnapshot, ids.workspace, ids.project, moneyV2Maximum])).rows[0].value;
      assert.equal(storedAggregate, moneyV2Maximum, "a valid 78-digit MoneyV2 aggregate must not overflow int64 storage");
    });

    await t.test("shape, hash, uniqueness, supersedes and V1/V2 constraints fail closed", async () => {
      const base = (await db.admin.query("select * from crm_financial_snapshots where resource_type='DEAL' and resource_id=$1", [ids.dealUnbound])).rows[0];
      const malformed = structuredClone(base.canonical_snapshot);
      malformed.snapshotId = randomUUID(); malformed.resourceId = randomUUID();
      malformed.currency = "EUR"; malformed.minorUnitExponent = 2;
      malformed.totals.net = { minorUnits: "01", currency: "EUR", minorUnitExponent: 2 };
      assert.equal((await db.admin.query("select crm_financial_snapshot_v1_valid($1::jsonb) valid", [JSON.stringify(malformed)])).rows[0].valid, false);

      const next = structuredClone(base.canonical_snapshot);
      next.snapshotId = randomUUID(); next.resourceId = randomUUID();
      await assert.rejects(db.admin.query(
        "insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,created_by,correlation_id) values($1,$2,$3,'DEAL',$4,1,'NEEDS_REVIEW',$5::jsonb,$6,$7,$8)",
        [next.snapshotId, ids.workspace, ids.project, next.resourceId, JSON.stringify(next), "0".repeat(64), ids.owner, randomUUID()],
      ), sqlError("23514"));

      const duplicate = structuredClone(base.canonical_snapshot);
      duplicate.snapshotId = randomUUID();
      await assert.rejects(db.admin.query(
        "insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,created_by,correlation_id) values($1,$2,$3,'DEAL',$4,$5,'NEEDS_REVIEW',$6::jsonb,$7,$8,$9)",
        [duplicate.snapshotId, ids.workspace, ids.project, base.resource_id, base.business_version, JSON.stringify(duplicate), snapshotHash(duplicate), ids.owner, randomUUID()],
      ), sqlError("23505"));

      const wrongContinuation = structuredClone(base.canonical_snapshot);
      wrongContinuation.snapshotId = randomUUID(); wrongContinuation.resourceId = randomUUID(); wrongContinuation.businessVersion = Number(base.business_version) + 1;
      await assert.rejects(db.admin.query(
        "insert into crm_financial_snapshots(id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,canonical_snapshot,snapshot_hash,supersedes_snapshot_id,created_by,correlation_id) values($1,$2,$3,'DEAL',$4,$5,'NEEDS_REVIEW',$6::jsonb,$7,$8,$9,$10)",
        [wrongContinuation.snapshotId, ids.workspace, ids.project, wrongContinuation.resourceId, wrongContinuation.businessVersion, JSON.stringify(wrongContinuation), snapshotHash(wrongContinuation), base.id, ids.owner, randomUUID()],
      ), sqlError("23514"));
      await assert.rejects(db.admin.query(
        "insert into crm_financial_events(workspace_id,project_id,snapshot_id,event_type,financial_snapshot_hash,actor_id,correlation_id) values($1,$2,$3,'SNAPSHOT_RECORDED',$4,$5,$6)",
        [ids.workspace, ids.project, base.id, "0".repeat(64), ids.owner, randomUUID()],
      ), sqlError("23514"));

      const indexes = (await db.admin.query("select indexdef from pg_indexes where tablename='crm_financial_snapshots'")).rows.map(row => row.indexdef).join("\n");
      assert.match(indexes, /workspace_id, resource_type, resource_id, business_version/);
      assert.match(indexes, /workspace_id, supersedes_snapshot_id/);
      await assert.rejects(db.admin.query("update crm_financial_snapshots set review_state='VERIFIED' where id=$1", [base.id]), sqlError("55000"));
      await assert.rejects(db.admin.query("delete from crm_financial_snapshots where id=$1", [base.id]), sqlError("55000"));
      await assert.rejects(db.admin.query("truncate crm_financial_events"), sqlError("55000"));
    });

    await t.test("tenant inserts may upgrade V1 to V2 but the database rejects every later V1 downgrade", async () => {
      const currencyPolicy = {
        policySchemaVersion: "crm-currency-policy-v1", kind: "CURRENCY", standard: "ISO-4217",
        code: "EUR", minorUnitExponent: 2, verifiedAt: "2026-09-18T12:00:00.000Z",
      };
      const roundingPolicy = {
        policySchemaVersion: "crm-rounding-policy-v1", kind: "ROUNDING", mode: "HALF_UP",
        currencyExponent: 2, scope: "TAX_COMPONENT",
      };
      const taxPolicy = {
        policySchemaVersion: "crm-tax-policy-v1", kind: "TAX", jurisdiction: "SYNTHETIC:TAX",
        treatment: "SYNTHETIC net tax", category: "SYNTHETIC standard",
        rate: { basis: "NET", numerator: "20", denominator: "100" },
        sourceProvenance: {
          authority: "SYNTHETIC authority", sourceReference: "SYNTHETIC controlled source",
          jurisdiction: "SYNTHETIC:TAX", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
          policyVersion: "1", verifiedAt: "2026-09-18T12:00:00.000Z",
        },
      };
      const references = {
        currency: { id: "SYNTHETIC:currency:EUR", version: "1", contentHash: policyHash(currencyPolicy) },
        rounding: { id: "SYNTHETIC:rounding:HALF_UP", version: "1", contentHash: policyHash(roundingPolicy) },
        tax: { id: "SYNTHETIC:tax:20", version: "1", contentHash: policyHash(taxPolicy) },
      };
      for (const [kind, policyId, payload, source] of [
        ["CURRENCY", references.currency.id, currencyPolicy, "SYNTHETIC ISO registry"],
        ["ROUNDING", references.rounding.id, roundingPolicy, "SYNTHETIC rounding decision"],
        ["TAX", references.tax.id, taxPolicy, taxPolicy.sourceProvenance.sourceReference],
      ] as const) {
        await db.admin.query(`
          insert into crm_financial_policy_versions(
            workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,
            jurisdiction,effective_from,effective_to,source_reference,verified_at,created_by,correlation_id
          ) values($1,$2,$3,$4,'1',$5,$6::jsonb,$7,$8::timestamptz,null,$9,'2026-09-18T12:00:00Z',$10,$11)
        `, [ids.workspace, ids.project, kind, policyId, policyHash(payload), JSON.stringify(payload),
          kind === "TAX" ? "SYNTHETIC:TAX" : null, kind === "TAX" ? "2026-01-01T00:00:00Z" : null,
          source, ids.owner, randomUUID()]);
      }
      await db.admin.query(`
        insert into crm_financial_policy_versions(
          workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,
          effective_from,effective_to,source_reference,verified_at,created_by,correlation_id
        ) values($1,$2,'ROUNDING','SYNTHETIC:rounding:future','1',$3,$4::jsonb,
          '2027-01-01T00:00:00Z',null,'SYNTHETIC future rounding','2026-09-18T12:00:00Z',$5,$6)
      `, [ids.workspace, ids.project, policyHash(roundingPolicy), JSON.stringify(roundingPolicy), ids.owner, randomUUID()]);
      const money = (minorUnits: string) => ({ minorUnits, currency: "EUR", minorUnitExponent: 2 });
      const offerDigest = (await db.admin.query(
        "select content_digest from crm_offer_revisions where workspace_id=$1 and offer_id=$2 and revision=1",
        [ids.workspace, ids.offer],
      )).rows[0].content_digest as string;
      const v2Snapshot = {
        snapshotSchemaVersion: "financial-snapshot-v1",
        snapshotId: evelynDerivedId(ids.action, "financial:2"), businessVersion: 2,
        tenantId: ids.workspace, resourceId: ids.action, reviewState: "COMPLETE",
        effectiveAt: "2026-09-01T10:00:00.000Z", currency: "EUR", minorUnitExponent: 2,
        currencyDefinition: { standard: "ISO-4217", code: "EUR", minorUnitExponent: 2,
          registryReference: references.currency, verifiedAt: currencyPolicy.verifiedAt },
        jurisdiction: "SYNTHETIC:TAX",
        components: [{
          componentId: "line:001", kind: "LINE", net: money("2037000"), tax: money("407400"), gross: money("2444400"),
          taxComponents: [{ componentId: "line:001:tax:standard", amount: money("407400"),
            policy: { reference: references.tax, jurisdiction: "SYNTHETIC:TAX", sourceProvenance: taxPolicy.sourceProvenance } }],
          pricingReference: { id: ids.offer, version: "1", contentHash: offerDigest },
        }],
        totals: { net: money("2037000"), tax: money("407400"), gross: money("2444400") },
        roundingPolicy: references.rounding,
        pricingReference: { id: ids.offer, version: "1", contentHash: offerDigest },
        provenance: { sourceSystem: "novalure-crm", sourceRecordId: ids.offer, sourceVersion: "1",
          sourceHash: offerDigest, recordedAt: "2026-08-31T10:00:00.123Z", recordedBy: ids.owner },
      };
      const v2SnapshotHash = snapshotHash(v2Snapshot);
      const insertVerified = (candidate: typeof v2Snapshot) => db.admin.query(`
        insert into crm_financial_snapshots(
          id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
          canonical_snapshot,snapshot_hash,created_by,correlation_id
        ) values($1,$2,$3,'CONTRACT',$4,2,'VERIFIED',$5::jsonb,$6,$7,$8)
      `, [candidate.snapshotId, ids.workspace, ids.project, ids.action, JSON.stringify(candidate),
        snapshotHash(candidate), ids.owner, randomUUID()]);
      const forgedTax = structuredClone(v2Snapshot);
      forgedTax.components[0].tax.minorUnits = "407401";
      forgedTax.components[0].gross.minorUnits = "2444401";
      forgedTax.components[0].taxComponents[0].amount.minorUnits = "407401";
      forgedTax.totals.tax.minorUnits = "407401";
      forgedTax.totals.gross.minorUnits = "2444401";
      await assert.rejects(insertVerified(forgedTax), sqlError("23514"));
      const unknownPolicy = structuredClone(v2Snapshot);
      unknownPolicy.components[0].taxComponents[0].policy.reference.id = "SYNTHETIC:tax:unknown";
      unknownPolicy.components[0].taxComponents[0].policy.reference.contentHash = "f".repeat(64);
      await assert.rejects(insertVerified(unknownPolicy), sqlError("23514"));
      const futureRounding = structuredClone(v2Snapshot);
      futureRounding.roundingPolicy.id = "SYNTHETIC:rounding:future";
      await assert.rejects(insertVerified(futureRounding), sqlError("23514"));
      const forgedSource = structuredClone(v2Snapshot);
      forgedSource.provenance.sourceHash = "e".repeat(64);
      await assert.rejects(insertVerified(forgedSource), sqlError("23514"));
      const v2Action = {
        tenantId: ids.workspace,
        actionId: ids.action,
        actionVersion: 2,
        actionType: "contract.send",
        resourceId: ids.action,
        actionContractVersion: "approval-action-v2",
        resourceVersion: 2,
        financialSnapshot: v2Snapshot,
        financialSnapshotHash: v2SnapshotHash,
      };
      await withTenant(db, ids.workspace, ids.owner, async client => {
        await client.query(`
          insert into crm_financial_snapshots(
            id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
            canonical_snapshot,snapshot_hash,created_by,correlation_id
          ) values($1,$2,$3,'CONTRACT',$4,2,'VERIFIED',$5::jsonb,$6,$7,$8)
        `, [v2Snapshot.snapshotId, ids.workspace, ids.project, ids.action, JSON.stringify(v2Snapshot),
          v2SnapshotHash, ids.owner, randomUUID()]);
        await client.query("update crm_evelyn_contract_actions set version=version+1 where id=$1", [ids.action]);
        await client.query(`
          insert into crm_evelyn_contract_revisions(
            workspace_id,project_id,action_id,version,created_by,action,action_hash,
            approval_contract_version,financial_snapshot_id,financial_snapshot_hash
          ) values($1,$2,$3,2,$4,$5::jsonb,$6,'v2',$7,$8)
        `, [ids.workspace, ids.project, ids.action, ids.owner, JSON.stringify(v2Action), digest(v2Action),
          v2Snapshot.snapshotId, v2SnapshotHash]);
        await client.query("update crm_evelyn_contract_actions set version=version+1 where id=$1", [ids.action]);
        const downgradedAction = {
          tenantId: ids.workspace,
          actionId: ids.action,
          actionVersion: 3,
          actionType: "contract.send",
          resourceId: ids.action,
          amount: 2037000,
        };
        await assert.rejects(client.query(`
          insert into crm_evelyn_contract_revisions(
            workspace_id,project_id,action_id,version,created_by,action,action_hash,approval_contract_version
          ) values($1,$2,$3,3,$4,$5::jsonb,$6,'v1')
        `, [ids.workspace, ids.project, ids.action, ids.owner, JSON.stringify(downgradedAction), digest(downgradedAction)]),
        sqlError("23514"));
      });
    });

    await t.test("current prices and later policy rows cannot rewrite historical snapshots", async () => {
      const policyCountBefore = Number((await db.admin.query(
        "select count(*)::int count from crm_financial_policy_versions",
      )).rows[0].count);
      const before = (await db.admin.query("select canonical_snapshot,snapshot_hash from crm_financial_snapshots where resource_type='PROPERTY_SALE' and resource_id=$1", [ids.saleBound])).rows[0];
      await db.admin.query("update property_units set price_cents=77777777 where id=$1", [ids.unitBound]);
      const policy = { policySchemaVersion: "crm-rounding-policy-v1", kind: "ROUNDING", mode: "HALF_EVEN", currencyExponent: 2, scope: "TAX_COMPONENT" };
      await db.admin.query(
        "insert into crm_financial_policy_versions(workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,source_reference,verified_at,created_by,correlation_id) values($1,$2,'ROUNDING','SYNTHETIC:rounding','1',$3,$4::jsonb,'SYNTHETIC decision','2026-09-18T12:00:00Z',$5,$6)",
        [ids.workspace, ids.project, policyHash(policy), JSON.stringify(policy), ids.owner, randomUUID()],
      );
      const after = (await db.admin.query("select canonical_snapshot,snapshot_hash from crm_financial_snapshots where resource_type='PROPERTY_SALE' and resource_id=$1", [ids.saleBound])).rows[0];
      assert.deepEqual(after, before);
      assert.equal((await db.admin.query("select count(*)::int count from crm_financial_policy_versions")).rows[0].count, policyCountBefore + 1);
      await assert.rejects(db.admin.query(
        "insert into crm_financial_policy_versions(workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,source_reference,verified_at,created_by,correlation_id) values($1,$2,'ROUNDING','SYNTHETIC:bad','1',$3,$4::jsonb,'SYNTHETIC bad','2026-09-18T12:00:00Z',$5,$6)",
        [ids.workspace, ids.project, "0".repeat(64), JSON.stringify(policy), ids.owner, randomUUID()],
      ), sqlError("23514"));
      const malformedPolicy = { ...policy, unexpected: true };
      await assert.rejects(db.admin.query(
        "insert into crm_financial_policy_versions(workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,source_reference,verified_at,created_by,correlation_id) values($1,$2,'ROUNDING','SYNTHETIC:malformed','1',$3,$4::jsonb,'SYNTHETIC bad shape','2026-09-18T12:00:00Z',$5,$6)",
        [ids.workspace, ids.project, policyHash(malformedPolicy), JSON.stringify(malformedPolicy), ids.owner, randomUUID()],
      ), sqlError("23514"));
    });

    await t.test("FORCE RLS hides cross-tenant rows and rejects cross-tenant and wrong-actor writes", async () => {
      const force = await db.admin.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in('crm_financial_policy_versions','crm_financial_snapshots','crm_financial_events') order by relname");
      assert.equal(force.rows.length, 3); assert.ok(force.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
      const costDeleteBoundary = (await db.admin.query(`
        select
          has_table_privilege('novalure_tenant_app','property_cost_items','DELETE') delete_granted,
          relation.relrowsecurity rls_enabled,
          relation.relforcerowsecurity rls_forced,
          exists(
            select 1 from pg_policies
            where schemaname='public' and tablename='property_cost_items'
              and policyname='crm_sales_write' and cmd='ALL'
              and 'novalure_tenant_app'=any(roles)
          ) scoped_policy
        from pg_class relation where relation.oid='public.property_cost_items'::regclass
      `)).rows[0];
      assert.deepEqual(costDeleteBoundary, {
        delete_granted: true,
        rls_enabled: true,
        rls_forced: true,
        scoped_policy: true,
      });
      const ownCostDelete = await withTenant(db, ids.workspace, ids.owner, client => client.query(
        "delete from property_cost_items where id=$1 returning id",
        [ids.propertyCostItemA],
      ));
      assert.deepEqual(ownCostDelete.rows, [{ id: ids.propertyCostItemA }]);
      const foreignCostDelete = await withTenant(db, ids.foreignWorkspace, ids.foreignOwner, client => client.query(
        "delete from property_cost_items where id=$1 returning id",
        [ids.propertyCostItemA],
      ));
      assert.deepEqual(foreignCostDelete.rows, []);
      assert.equal((await db.admin.query("select count(*)::int count from property_cost_items where id=$1", [ids.propertyCostItemA])).rows[0].count, 1);
      const own = await withTenant(db, ids.workspace, ids.owner, client => client.query("select count(*)::int count from crm_financial_snapshots"));
      assert.equal(own.rows[0].count, 6);
      const foreign = await withTenant(db, ids.foreignWorkspace, ids.foreignOwner, client => client.query("select count(*)::int count from crm_financial_snapshots"));
      assert.equal(foreign.rows[0].count, 0);
      const policy = { policySchemaVersion: "crm-rounding-policy-v1", kind: "ROUNDING", mode: "TRUNCATE", currencyExponent: 2, scope: "TAX_COMPONENT" };
      const inserted = await withTenant(db, ids.workspace, ids.owner, client => client.query(
        "insert into crm_financial_policy_versions(workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,source_reference,verified_at,created_by,correlation_id) values($1,$2,'ROUNDING','SYNTHETIC:runtime','1',$3,$4::jsonb,'SYNTHETIC runtime','2026-09-18T12:00:00Z',$5,$6) returning policy_id",
        [ids.workspace, ids.project, policyHash(policy), JSON.stringify(policy), ids.owner, randomUUID()],
      ));
      assert.equal(inserted.rows[0].policy_id, "SYNTHETIC:runtime");
      await assert.rejects(withTenant(db, ids.workspace, ids.owner, client => client.query(
        "insert into crm_financial_policy_versions(workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,source_reference,verified_at,created_by,correlation_id) values($1,$2,'ROUNDING','SYNTHETIC:cross','1',$3,$4::jsonb,'SYNTHETIC','2026-09-18T12:00:00Z',$5,$6)",
        [ids.foreignWorkspace, ids.foreignProject, policyHash(policy), JSON.stringify(policy), ids.foreignOwner, randomUUID()],
      )), sqlError("42501"));
      await assert.rejects(withTenant(db, ids.workspace, ids.owner, client => client.query(
        "insert into crm_financial_policy_versions(workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,source_reference,verified_at,created_by,correlation_id) values($1,$2,'ROUNDING','SYNTHETIC:wrong-actor','1',$3,$4::jsonb,'SYNTHETIC','2026-09-18T12:00:00Z',$5,$6)",
        [ids.workspace, ids.project, policyHash(policy), JSON.stringify(policy), ids.secondActor, randomUUID()],
      )), sqlError("42501"));
    });

    await t.test("G27 helpers and trigger functions expose no PUBLIC execution privilege", async () => {
      const publicExecute = await db.admin.query(`
        select procedure.oid::regprocedure::text signature
        from pg_proc procedure
        join lateral aclexplode(coalesce(procedure.proacl,acldefault('f',procedure.proowner))) privilege on true
        where procedure.pronamespace='public'::regnamespace
          and (procedure.proname like 'crm_financial_%'
            or procedure.proname in(
              'crm_backfill_g27_financial_snapshots','crm_evelyn_contract_revision_financial_guard',
              'crm_deal_stage_permission_guard','crm_record_deal_financial_fixation',
              'crm_record_property_sale_financial_fixation'
            ))
          and privilege.grantee=0 and privilege.privilege_type='EXECUTE'
        order by 1
      `);
      assert.deepEqual(publicExecute.rows, []);

      const restrictedRuntimeFunctions = await db.admin.query(`
        select procedure.proname,
          has_function_privilege('novalure_tenant_app',procedure.oid,'EXECUTE') tenant_execute
        from pg_proc procedure
        where procedure.pronamespace='public'::regnamespace
          and procedure.proname in(
            'crm_backfill_g27_financial_snapshots','crm_financial_snapshot_authority_guard',
            'crm_financial_snapshot_supersedes_guard','crm_financial_event_guard',
            'crm_evelyn_contract_revision_financial_guard','crm_deal_stage_permission_guard',
            'crm_record_deal_financial_fixation','crm_record_property_sale_financial_fixation'
          )
        order by procedure.proname
      `);
      assert.deepEqual(restrictedRuntimeFunctions.rows, [
        { proname: 'crm_backfill_g27_financial_snapshots', tenant_execute: false },
        { proname: 'crm_deal_stage_permission_guard', tenant_execute: false },
        { proname: 'crm_evelyn_contract_revision_financial_guard', tenant_execute: false },
        { proname: 'crm_financial_event_guard', tenant_execute: false },
        { proname: 'crm_financial_snapshot_authority_guard', tenant_execute: false },
        { proname: 'crm_financial_snapshot_supersedes_guard', tenant_execute: false },
        { proname: 'crm_record_deal_financial_fixation', tenant_execute: false },
        { proname: 'crm_record_property_sale_financial_fixation', tenant_execute: false },
      ]);
    });

    await t.test("a can_edit-only runtime actor cannot author policy, snapshot, or event authority", async () => {
      const rounding = { policySchemaVersion: "crm-rounding-policy-v1", kind: "ROUNDING", mode: "TRUNCATE", currencyExponent: 2, scope: "TAX_COMPONENT" };
      await assert.rejects(withTenant(db, ids.workspace, ids.secondActor, client => client.query(`
        insert into crm_financial_policy_versions(
          workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,
          source_reference,verified_at,created_by,correlation_id
        ) values($1,$2,'ROUNDING','SYNTHETIC:forged-can-edit','1',$3,$4::jsonb,
          'SYNTHETIC forged','2026-09-18T12:00:00Z',$5,$6)
      `, [ids.workspace, ids.project, policyHash(rounding), JSON.stringify(rounding), ids.secondActor, randomUUID()])), sqlError("42501"));

      const forgedDeal = randomUUID();
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,'SYNTHETIC forged snapshot target','Verhandlung',1,1)",
        [forgedDeal, ids.workspace, ids.project, ids.secondActor],
      );
      const source = (await db.admin.query(
        "select canonical_snapshot from crm_financial_snapshots where workspace_id=$1 and resource_type='DEAL' and resource_id=$2",
        [ids.workspace, ids.dealUnbound],
      )).rows[0].canonical_snapshot;
      const pending = structuredClone(source);
      pending.snapshotId = randomUUID(); pending.resourceId = forgedDeal; pending.businessVersion = 1;
      await assert.rejects(withTenant(db, ids.workspace, ids.secondActor, client => client.query(`
        insert into crm_financial_snapshots(
          id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
          canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id
        ) values($1,$2,$3,'DEAL',$4,1,'NEEDS_REVIEW',$5::jsonb,$6,'B',$7::jsonb,$8,$9)
      `, [pending.snapshotId, ids.workspace, ids.project, forgedDeal, JSON.stringify(pending), snapshotHash(pending),
        JSON.stringify({ source: "forged-authority" }), ids.secondActor, randomUUID()])), sqlError("42501"));

      const legacy = (await db.admin.query(
        "select id,project_id,snapshot_hash from crm_financial_snapshots where workspace_id=$1 and resource_type='DEAL' and resource_id=$2",
        [ids.workspace, ids.dealUnbound],
      )).rows[0];
      await assert.rejects(withTenant(db, ids.workspace, ids.secondActor, client => client.query(`
        insert into crm_financial_events(
          workspace_id,project_id,snapshot_id,event_type,financial_snapshot_hash,actor_id,correlation_id,details
        ) values($1,$2,$3,'LEGACY_NEEDS_REVIEW',$4,$5,$6,$7::jsonb)
      `, [ids.workspace, legacy.project_id, legacy.id, legacy.snapshot_hash, ids.secondActor, randomUUID(),
        JSON.stringify({ resourceType: "DEAL", fixation: "forged" })])), sqlError("42501"));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_policy_versions where policy_id='SYNTHETIC:forged-can-edit'",
      )).rows[0].count, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where resource_id=$1",
        [forgedDeal],
      )).rows[0].count, 0);
    });

    await t.test("database stage guard enforces move, close, reopen and manager semantics for every terminal stage", async () => {
      const deal = randomUUID();
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,'SYNTHETIC stage capability target','Verhandlung',1,1)",
        [deal, ids.workspace, ids.project, ids.secondActor],
      );
      await commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "update deals set stage='Angebot' where id=$1", [deal],
      ));
      await db.admin.query(
        "update project_pipeline_permissions set can_move_deals=false,can_close_deals=false,can_reopen_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3",
        [ids.workspace, ids.project, ids.secondActor],
      );
      await assert.rejects(commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "update deals set stage='Verhandlung' where id=$1", [deal],
      )), sqlError("42501"));
      for (const stage of ["Gewonnen", "Verloren", "Disqualifiziert", "Pausiert / Verloren"]) {
        await assert.rejects(commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
          "update deals set stage=$2 where id=$1", [deal, stage],
        )), sqlError("42501"), `can_close_deals=false must reject ${stage}`);
      }
      await assert.rejects(commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,'SYNTHETIC direct terminal insert','Pausiert / Verloren',1,1)",
        [randomUUID(), ids.workspace, ids.project, ids.secondActor],
      )), sqlError("42501"));

      await db.admin.query(
        "update project_pipeline_permissions set can_close_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3",
        [ids.workspace, ids.project, ids.secondActor],
      );
      await commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "update deals set stage='Verloren' where id=$1", [deal],
      ));
      await assert.rejects(commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "update deals set stage='Angebot' where id=$1", [deal],
      )), sqlError("42501"));
      await db.admin.query(
        "update project_pipeline_permissions set can_reopen_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3",
        [ids.workspace, ids.project, ids.secondActor],
      );
      await commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "update deals set stage='Angebot' where id=$1", [deal],
      ));

      const managerDeal = randomUUID();
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,'SYNTHETIC manager stage target','Verhandlung',1,1)",
        [managerDeal, ids.workspace, ids.project, ids.owner],
      );
      await commitTenant(db, ids.workspace, ids.owner, client => client.query(
        "update deals set stage='Disqualifiziert' where id=$1", [managerDeal],
      ));
      assert.deepEqual((await db.admin.query(
        "select stage from deals where id in($1,$2) order by id", [deal, managerDeal],
      )).rows.map(row => row.stage).sort(), ["Angebot", "Disqualifiziert"].sort());
      await db.admin.query(
        "update project_pipeline_permissions set can_move_deals=true,can_close_deals=false,can_reopen_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3",
        [ids.workspace, ids.project, ids.secondActor],
      );
    });

    await t.test("future deal and property terminal transitions atomically fix evidence without current-value fallback", async () => {
      const projectlessDeal = randomUUID(), unrelatedAgent = randomUUID();
      await db.admin.query(
        "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC unrelated agent',$3,'agent','developer_sales','active')",
        [unrelatedAgent, ids.workspace, `${unrelatedAgent}@example.invalid`],
      );
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version) values($1,$2,null,$3,'SYNTHETIC projectless owned deal','Verhandlung',1234567,1)",
        [projectlessDeal, ids.workspace, ids.owner],
      );
      await commitTenant(db, ids.workspace, ids.owner, client => client.query(
        "update deals set stage='Gewonnen',closed_at='2026-09-20T09:00:00Z',version=version+1 where id=$1",
        [projectlessDeal],
      ));
      const projectlessSnapshot = await withTenant(db, ids.workspace, ids.owner, client => client.query(
        "select id,project_id,review_state,canonical_snapshot from crm_financial_snapshots where resource_type='DEAL' and resource_id=$1",
        [projectlessDeal],
      ));
      assert.equal(projectlessSnapshot.rows.length, 1);
      assert.equal(projectlessSnapshot.rows[0].project_id, null);
      assert.equal(projectlessSnapshot.rows[0].review_state, "NEEDS_REVIEW");
      assert.equal(projectlessSnapshot.rows[0].canonical_snapshot.totals.net, null);
      const projectlessEvents = await withTenant(db, ids.workspace, ids.owner, client => client.query(
        "select event_type from crm_financial_events where snapshot_id=$1",
        [projectlessSnapshot.rows[0].id],
      ));
      assert.deepEqual(projectlessEvents.rows, [{ event_type: "LEGACY_NEEDS_REVIEW" }]);
      assert.equal((await withTenant(db, ids.workspace, unrelatedAgent, client => client.query(
        "select count(*)::int count from crm_financial_snapshots where id=$1",
        [projectlessSnapshot.rows[0].id],
      ))).rows[0].count, 0);

      const directWonDeal = randomUUID();
      await assert.rejects(commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents,closed_at,version) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC direct won permission','Gewonnen',8888888,'2026-09-20T09:30:00Z',1)",
        [directWonDeal, ids.workspace, ids.project, ids.contact, ids.organization, ids.lead, ids.secondActor],
      )), sqlError("42501"));
      assert.equal((await db.admin.query("select count(*)::int count from deals where id=$1", [directWonDeal])).rows[0].count, 0);

      await db.admin.query(
        "update project_pipeline_permissions set can_close_deals=true,can_reopen_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3",
        [ids.workspace, ids.project, ids.secondActor],
      );
      await commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents,closed_at,version) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC direct won permitted','Gewonnen',8888888,'2026-09-20T09:30:00Z',1)",
        [directWonDeal, ids.workspace, ids.project, ids.contact, ids.organization, ids.lead, ids.secondActor],
      ));
      const directSnapshot = (await db.admin.query(
        "select id,business_version,legacy_classification,canonical_snapshot from crm_financial_snapshots where resource_type='DEAL' and resource_id=$1",
        [directWonDeal],
      )).rows[0];
      assert.equal(directSnapshot.business_version, "1");
      assert.equal(directSnapshot.legacy_classification, "C");
      assert.equal(directSnapshot.canonical_snapshot.totals.net, null);
      assert.doesNotMatch(JSON.stringify(directSnapshot), /8888888/);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_events where snapshot_id=$1 and event_type='LEGACY_NEEDS_REVIEW'",
        [directSnapshot.id],
      )).rows[0].count, 1);

      await commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "update deals set stage='Verhandlung',closed_at=null,version=version+1 where id=$1",
        [directWonDeal],
      ));
      await commitTenant(db, ids.workspace, ids.secondActor, client => client.query(
        "update deals set stage='Gewonnen',closed_at='2026-09-23T09:30:00Z',version=version+1,value_cents=9999999 where id=$1",
        [directWonDeal],
      ));
      assert.deepEqual((await db.admin.query(
        "select count(*)::int count,min(business_version)::text min_version,max(business_version)::text max_version from crm_financial_snapshots where resource_type='DEAL' and resource_id=$1",
        [directWonDeal],
      )).rows[0], { count: 1, min_version: "1", max_version: "1" });

      const dealC = randomUUID();
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC future ambiguous','Verhandlung',7654321,1)",
        [dealC, ids.workspace, ids.project, ids.contact, ids.organization, ids.lead, ids.owner],
      );
      await commitTenant(db, ids.workspace, ids.owner, client => client.query(
        "update deals set stage='Gewonnen',closed_at='2026-09-20T10:00:00Z',version=version+1,value_cents=9999999 where id=$1",
        [dealC],
      ));
      const cBefore = (await db.admin.query("select * from crm_financial_snapshots where resource_type='DEAL' and resource_id=$1", [dealC])).rows[0];
      assert.equal(cBefore.legacy_classification, "C");
      assert.equal(cBefore.canonical_snapshot.totals.net, null);
      assert.doesNotMatch(JSON.stringify(cBefore), /7654321|9999999/);
      await db.admin.query("update deals set value_cents=42 where id=$1", [dealC]);
      const cAfter = (await db.admin.query("select canonical_snapshot,snapshot_hash from crm_financial_snapshots where id=$1", [cBefore.id])).rows[0];
      assert.deepEqual(cAfter, { canonical_snapshot: cBefore.canonical_snapshot, snapshot_hash: cBefore.snapshot_hash });

      const dealB = randomUUID(), offerB = randomUUID(), revisionB = randomUUID();
      const contentB = { subject: "SYNTHETIC future accepted offer", recipientName: "SYNTHETIC buyer", recipientEmail: "buyer@example.invalid", terms: "SYNTHETIC", validUntil: "2027-01-01T00:00:00.000Z", currency: "EUR", taxBasis: "NET", items: [{ description: "Setup", quantity: 1, unitNetCents: 509900 }] };
      const digestB = digest(contentB);
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC future bound','Verhandlung',1,1)",
        [dealB, ids.workspace, ids.project, ids.contact, ids.organization, ids.lead, ids.owner],
      );
      await db.admin.query(
        "insert into crm_offers(id,workspace_id,project_id,deal_id,contact_id,lead_id,organization_id,status,revision,version,follow_up_status,response_reference,response_actor_id,created_by) values($1,$2,$3,$4,$5,$6,$7,'ACCEPTED',1,2,'STOPPED','SYNTHETIC accepted',$8,$8)",
        [offerB, ids.workspace, ids.project, dealB, ids.contact, ids.lead, ids.organization, ids.owner],
      );
      await db.admin.query(
        "insert into crm_offer_revisions(id,workspace_id,project_id,offer_id,revision,content,content_digest,total_net_cents,created_by,created_at) values($1,$2,$3,$4,1,$5::jsonb,$6,509900,$7,'2026-09-19T09:00:00Z')",
        [revisionB, ids.workspace, ids.project, offerB, JSON.stringify(contentB), digestB, ids.owner],
      );
      await commitTenant(db, ids.workspace, ids.owner, async client => {
        await client.query(
          "update deals set stage='Gewonnen',closed_at='2026-09-20T11:00:00Z',version=version+1,value_cents=509900 where id=$1",
          [dealB],
        );
        await client.query(
          "insert into deal_stage_history(workspace_id,project_id,deal_id,from_stage,to_stage,changed_by_user_id,reason,reason_category,changed_at,metadata) values($1,$2,$3,'Verhandlung','Gewonnen',$4,'Offer accepted','won','2026-09-20T11:00:00Z',$5::jsonb)",
          [ids.workspace, ids.project, dealB, ids.owner, JSON.stringify({ offerId: offerB, revision: 1, contentDigest: digestB })],
        );
      });
      const bound = await db.admin.query("select resource_type,canonical_snapshot,legacy_classification from crm_financial_snapshots where resource_id in($1,$2) order by resource_type", [dealB, offerB]);
      assert.equal(bound.rows.length, 2);
      assert.ok(bound.rows.every(row => row.legacy_classification === "B" && row.canonical_snapshot.totals.net.minorUnits === "509900"));

      const saleB = randomUUID(), unitB = randomUUID(), reservationB = randomUUID();
      const saleC = randomUUID(), unitC = randomUUID(), reservationC = randomUUID();
      await db.admin.query(
        "insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents,version,buyer_contact_id) values($1,$3,$4,'SYN-FWD-B','sold',123,5,$5),($2,$3,$4,'SYN-FWD-C','sold',456,5,$5)",
        [unitB, unitC, ids.workspace, ids.project, ids.contact],
      );
      await db.admin.query(
        "insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,status,expires_at,buyer_lead_id,version,confirmation) values($1,$3,$4,$5,$7,'converted','2027-01-01T00:00:00Z',$8,3,'{}'),($2,$3,$4,$6,$7,'converted','2027-01-01T00:00:00Z',$8,3,'{}')",
        [reservationB, reservationC, ids.workspace, ids.project, unitB, unitC, ids.contact, ids.lead],
      );
      await commitTenant(db, ids.workspace, ids.owner, async client => {
        await client.query(
          "insert into property_sales(id,workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,authority_id,confirmed_by,source_reference,confirmed_at,unit_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'SYNTHETIC future sale B','2026-09-21T10:00:00Z',5)",
          [saleB, ids.workspace, ids.project, unitB, reservationB, ids.lead, ids.contact, ids.authority, ids.owner],
        );
        await client.query(
          "insert into property_unit_audit_events(workspace_id,project_id,unit_id,actor_user_id,event_type,before,after,reason,created_at) values($1,$2,$3,$4,'authorized_sales_transition',$5::jsonb,$6::jsonb,'SYNTHETIC future sold','2026-09-21T10:00:00Z')",
          [ids.workspace, ids.project, unitB, ids.owner, JSON.stringify({ status: "reserved", priceCents: "41000000", version: 4 }), JSON.stringify({ status: "sold", version: 5, saleId: saleB })],
        );
      });
      await commitTenant(db, ids.workspace, ids.owner, client => client.query(
        "insert into property_sales(id,workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,authority_id,confirmed_by,source_reference,confirmed_at,unit_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'SYNTHETIC future sale C','2026-09-21T11:00:00Z',5)",
        [saleC, ids.workspace, ids.project, unitC, reservationC, ids.lead, ids.contact, ids.authority, ids.owner],
      ));
      const sales = (await db.admin.query("select resource_id,legacy_classification,canonical_snapshot,legacy_evidence,snapshot_hash from crm_financial_snapshots where resource_type='PROPERTY_SALE' and resource_id in($1,$2)", [saleB, saleC])).rows;
      const fixedB = sales.find(row => row.resource_id === saleB), fixedC = sales.find(row => row.resource_id === saleC);
      assert.equal(fixedB?.legacy_classification, "B"); assert.equal(fixedB?.legacy_evidence.saleTimePriceMinorUnits, "41000000");
      assert.equal(fixedC?.legacy_classification, "C"); assert.equal(fixedC?.legacy_evidence.saleTimePriceMinorUnits, null);
      assert.doesNotMatch(JSON.stringify(fixedC), /\b456\b/);
      const fixedSnapshot = { canonical_snapshot: fixedB?.canonical_snapshot, snapshot_hash: fixedB?.snapshot_hash };
      await db.admin.query("update property_units set price_cents=99000000 where id=$1", [unitB]);
      assert.deepEqual((await db.admin.query("select canonical_snapshot,snapshot_hash from crm_financial_snapshots where resource_type='PROPERTY_SALE' and resource_id=$1", [saleB])).rows[0], fixedSnapshot);
    });

    await t.test("deal and property-sale fixation aborts on pre-seeded mismatching rows under the logical lock", async () => {
      const deal = randomUUID();
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,'SYNTHETIC preseed deal','Verhandlung',999999,1)",
        [deal, ids.workspace, ids.project, ids.owner],
      );
      const dealSnapshotId = (await db.admin.query(
        "select crm_financial_deterministic_uuid($1) id",
        [`deal:${ids.workspace}:${deal}:2`],
      )).rows[0].id as string;
      const dealPreseed = {
        snapshotSchemaVersion: "financial-snapshot-v1", snapshotId: dealSnapshotId, businessVersion: 2,
        tenantId: ids.workspace, resourceId: deal, reviewState: "NEEDS_REVIEW",
        effectiveAt: "2026-09-24T10:00:00.000Z", currency: null, minorUnitExponent: null,
        currencyDefinition: null, jurisdiction: null, components: null,
        totals: { net: null, tax: null, gross: null }, roundingPolicy: null, pricingReference: null, provenance: null,
        missingFields: ["components", "currency", "currencyDefinition", "jurisdiction", "minorUnitExponent", "pricingReference", "provenance", "roundingPolicy", "taxPolicy", "totals.gross", "totals.net", "totals.tax"],
      };
      await db.admin.query(`
        insert into crm_financial_snapshots(
          id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
          canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at
        ) values($1,$2,$3,'DEAL',$4,2,'NEEDS_REVIEW',$5::jsonb,$6,'C',$7::jsonb,$8,$9,'2026-09-24T10:00:00Z')
      `, [dealSnapshotId, ids.workspace, ids.project, deal, JSON.stringify(dealPreseed), snapshotHash(dealPreseed),
        JSON.stringify({ source: "deal-won-transition-without-bound-economic-evidence", dealId: deal, mutableDealValueExcluded: false }),
        ids.owner, randomUUID()]);
      await assert.rejects(commitTenant(db, ids.workspace, ids.owner, client => client.query(
        "update deals set stage='Gewonnen',closed_at='2026-09-24T10:00:00Z',version=version+1 where id=$1", [deal],
      )), sqlError("23514"));
      assert.equal((await db.admin.query("select stage from deals where id=$1", [deal])).rows[0].stage, "Verhandlung");
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_events where snapshot_id=$1", [dealSnapshotId],
      )).rows[0].count, 0);

      const sameTransactionDeal = randomUUID();
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,'SYNTHETIC same transaction preseed','Verhandlung',777777,1)",
        [sameTransactionDeal, ids.workspace, ids.project, ids.secondActor],
      );
      const sameTransactionSnapshotId = (await db.admin.query(
        "select crm_financial_deterministic_uuid($1) id",
        [`deal:${ids.workspace}:${sameTransactionDeal}:2`],
      )).rows[0].id as string;
      const sameTransactionCorrelation = randomUUID();
      const sameTransactionPreseed = {
        ...dealPreseed,
        snapshotId: sameTransactionSnapshotId,
        resourceId: sameTransactionDeal,
        effectiveAt: "2099-01-01T00:00:00.000Z",
      };
      await assert.rejects(commitTenant(db, ids.workspace, ids.secondActor, async client => {
        await client.query(
          "update deals set stage='Gewonnen',closed_at='2026-09-24T10:30:00Z',version=version+1 where id=$1",
          [sameTransactionDeal],
        );
        await client.query(`
          insert into crm_financial_snapshots(
            id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
            canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at
          ) values($1,$2,$3,'DEAL',$4,2,'NEEDS_REVIEW',$5::jsonb,$6,'C',$7::jsonb,$8,$9,'2026-09-24T10:30:00Z')
        `, [sameTransactionSnapshotId, ids.workspace, ids.project, sameTransactionDeal,
          JSON.stringify(sameTransactionPreseed), snapshotHash(sameTransactionPreseed),
          JSON.stringify({ source: "deal-won-transition-without-bound-economic-evidence",
            dealId: sameTransactionDeal, mutableDealValueExcluded: true }),
          ids.secondActor, sameTransactionCorrelation]);
        await client.query(`
          insert into crm_financial_events(
            workspace_id,project_id,snapshot_id,event_type,financial_snapshot_hash,actor_id,correlation_id,details
          ) values($1,$2,$3,'LEGACY_NEEDS_REVIEW',$4,$5,$6,$7::jsonb)
        `, [ids.workspace, ids.project, sameTransactionSnapshotId, snapshotHash(sameTransactionPreseed),
          ids.secondActor, sameTransactionCorrelation,
          JSON.stringify({ legacyClassification: "C", resourceType: "DEAL", fixation: "deal-won-transition" })]);
      }), sqlError("42501"));
      assert.equal((await db.admin.query(
        "select stage from deals where id=$1", [sameTransactionDeal],
      )).rows[0].stage, "Verhandlung");
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where id=$1", [sameTransactionSnapshotId],
      )).rows[0].count, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_events where snapshot_id=$1", [sameTransactionSnapshotId],
      )).rows[0].count, 0);

      const sale = randomUUID(), unit = randomUUID(), reservation = randomUUID();
      await db.admin.query(
        "insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents,version,buyer_contact_id) values($1,$2,$3,'SYN-PRESEED','sold',123,5,$4)",
        [unit, ids.workspace, ids.project, ids.contact],
      );
      await db.admin.query(
        "insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,status,expires_at,buyer_lead_id,version,confirmation) values($1,$2,$3,$4,$5,'converted','2027-01-01T00:00:00Z',$6,3,'{}')",
        [reservation, ids.workspace, ids.project, unit, ids.contact, ids.lead],
      );
      const saleSnapshotId = (await db.admin.query(
        "select crm_financial_deterministic_uuid($1) id",
        [`property-sale:${ids.workspace}:${sale}`],
      )).rows[0].id as string;
      const salePreseed = {
        snapshotSchemaVersion: "financial-snapshot-v1", snapshotId: saleSnapshotId, businessVersion: 1,
        tenantId: ids.workspace, resourceId: sale, reviewState: "NEEDS_REVIEW",
        effectiveAt: "2026-09-24T11:00:00.000Z", currency: null, minorUnitExponent: null,
        currencyDefinition: null, jurisdiction: null, components: null,
        totals: { net: null, tax: null, gross: null }, roundingPolicy: null, pricingReference: null,
        provenance: { sourceSystem: "novalure-crm", sourceRecordId: sale, sourceVersion: "5",
          sourceHash: "d".repeat(64), recordedAt: "2026-09-24T11:00:00.000Z", recordedBy: ids.owner },
        missingFields: ["components", "currency", "currencyDefinition", "jurisdiction", "minorUnitExponent", "pricingReference", "roundingPolicy", "taxPolicy", "totals.gross", "totals.net", "totals.tax"],
      };
      await assert.rejects(commitTenant(db, ids.workspace, ids.owner, async client => {
        await client.query(`
          insert into property_sales(
            id,workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,
            authority_id,confirmed_by,source_reference,confirmed_at,unit_version
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'SYNTHETIC preseed sale','2026-09-24T11:00:00Z',5)
        `, [sale, ids.workspace, ids.project, unit, reservation, ids.lead, ids.contact, ids.authority, ids.owner]);
        await client.query(`
          insert into crm_financial_snapshots(
            id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
            canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id,created_at
          ) values($1,$2,$3,'PROPERTY_SALE',$4,1,'NEEDS_REVIEW',$5::jsonb,$6,'C',$7::jsonb,$8,$9,'2026-09-24T11:00:00Z')
        `, [saleSnapshotId, ids.workspace, ids.project, sale, JSON.stringify(salePreseed), snapshotHash(salePreseed),
          JSON.stringify({ source: "property-sale-without-bound-price-event", saleId: sale, unitId: unit,
            unitVersion: 5, saleTimePriceMinorUnits: null, evidenceHash: "d".repeat(64) }), ids.owner, randomUUID()]);
        await client.query(`
          insert into property_unit_audit_events(
            workspace_id,project_id,unit_id,actor_user_id,event_type,before,after,reason,created_at
          ) values($1,$2,$3,$4,'authorized_sales_transition',$5::jsonb,$6::jsonb,
            'SYNTHETIC preseed mismatch','2026-09-24T11:00:00Z')
        `, [ids.workspace, ids.project, unit, ids.owner,
          JSON.stringify({ status: "reserved", priceCents: "43000000", version: 4 }),
          JSON.stringify({ status: "sold", version: 5, saleId: sale })]);
      }), sqlError("42501"));
      assert.equal((await db.admin.query("select count(*)::int count from property_sales where id=$1", [sale])).rows[0].count, 0);
      assert.equal((await db.admin.query("select count(*)::int count from crm_financial_snapshots where id=$1", [saleSnapshotId])).rows[0].count, 0);
    });

    await t.test("snapshot or event failure rolls the terminal business transition back", async () => {
      const deal = randomUUID(), sale = randomUUID(), unit = randomUUID(), reservation = randomUUID();
      await db.admin.query(
        "insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents,version) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC rollback deal','Verhandlung',12345,1)",
        [deal, ids.workspace, ids.project, ids.contact, ids.organization, ids.lead, ids.owner],
      );
      await db.admin.query(
        "insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents,version,buyer_contact_id) values($1,$2,$3,'SYN-ROLLBACK','sold',123,5,$4)",
        [unit, ids.workspace, ids.project, ids.contact],
      );
      await db.admin.query(
        "insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,status,expires_at,buyer_lead_id,version,confirmation) values($1,$2,$3,$4,$5,'converted','2027-01-01T00:00:00Z',$6,3,'{}')",
        [reservation, ids.workspace, ids.project, unit, ids.contact, ids.lead],
      );
      await db.admin.query("create function qa_g27_reject_financial_event() returns trigger language plpgsql as $$ begin raise exception 'INJECTED_G27_EVENT_FAILURE'; end $$");
      await db.admin.query("create trigger qa_g27_reject_financial_event before insert on crm_financial_events for each row execute function qa_g27_reject_financial_event()");
      try {
        await assert.rejects(commitTenant(db, ids.workspace, ids.owner, client => client.query(
          "update deals set stage='Gewonnen',closed_at='2026-09-22T10:00:00Z',version=version+1 where id=$1",
          [deal],
        )), /INJECTED_G27_EVENT_FAILURE/);
        assert.equal((await db.admin.query("select stage from deals where id=$1", [deal])).rows[0].stage, "Verhandlung");
        assert.equal((await db.admin.query("select count(*)::int count from crm_financial_snapshots where resource_id=$1", [deal])).rows[0].count, 0);

        await assert.rejects(commitTenant(db, ids.workspace, ids.owner, async client => {
          await client.query(
            "insert into property_sales(id,workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,authority_id,confirmed_by,source_reference,confirmed_at,unit_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'SYNTHETIC rollback sale','2026-09-22T11:00:00Z',5)",
            [sale, ids.workspace, ids.project, unit, reservation, ids.lead, ids.contact, ids.authority, ids.owner],
          );
          await client.query(
            "insert into property_unit_audit_events(workspace_id,project_id,unit_id,actor_user_id,event_type,before,after,reason,created_at) values($1,$2,$3,$4,'authorized_sales_transition',$5::jsonb,$6::jsonb,'SYNTHETIC rollback','2026-09-22T11:00:00Z')",
            [ids.workspace, ids.project, unit, ids.owner, JSON.stringify({ status: "reserved", priceCents: "42000000", version: 4 }), JSON.stringify({ status: "sold", version: 5, saleId: sale })],
          );
        }), /INJECTED_G27_EVENT_FAILURE/);
        assert.equal((await db.admin.query("select count(*)::int count from property_sales where id=$1", [sale])).rows[0].count, 0);
        assert.equal((await db.admin.query("select count(*)::int count from property_unit_audit_events where after->>'saleId'=$1", [sale])).rows[0].count, 0);
        assert.equal((await db.admin.query("select count(*)::int count from crm_financial_snapshots where resource_id=$1", [sale])).rows[0].count, 0);
      } finally {
        await db.admin.query("drop trigger qa_g27_reject_financial_event on crm_financial_events");
        await db.admin.query("drop function qa_g27_reject_financial_event()");
      }
    });

    await t.test("native pg_dump/pg_restore round trip preserves G27 schema, ledger, data, RLS and immutability", async () => {
      const toolVersions = {
        dump: (await nativePgTool("pg_dump", ["--version"])).trim(),
        restore: (await nativePgTool("pg_restore", ["--version"])).trim(),
      };
      assert.match(toolVersions.dump, /PostgreSQL\) 18\./);
      assert.match(toolVersions.restore, /PostgreSQL\) 18\./);

      const archive = path.join(db.directory, "g27-financial-full.dump");
      const connectionArgs = ["--host=127.0.0.1", `--port=${db.port}`, "--username=qa_admin", "--no-password"];
      const sourceCatalog = await g27Catalog(db.admin);
      const sourceData = await g27Data(db.admin);
      const sourceWorkspaceSnapshots = Number((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1",
        [ids.workspace],
      )).rows[0].count);
      const sourceLedger = (await db.admin.query(
        "select version,name,checksum from novalure_schema_migrations where version='087_crm_financial_snapshots'",
      )).rows;
      assert.equal(sourceLedger.length, 1);

      await nativePgTool("pg_dump", [
        ...connectionArgs,
        "--dbname=postgres",
        "--format=custom",
        `--file=${archive}`,
      ]);
      const restoredDatabase = `g27_restore_${randomUUID().replaceAll("-", "")}`;
      await db.admin.query(`create database ${restoredDatabase} template template0`);
      await nativePgTool("pg_restore", [
        ...connectionArgs,
        `--dbname=${restoredDatabase}`,
        "--exit-on-error",
        "--single-transaction",
        archive,
      ]);

      const restoredAdmin = new pg.Pool({
        host: "127.0.0.1", port: db.port, user: "qa_admin", database: restoredDatabase, max: 2,
        connectionTimeoutMillis: 5_000, query_timeout: 15_000,
      });
      const restoredRuntime = new pg.Pool({
        host: "127.0.0.1", port: db.port, user: db.role, database: restoredDatabase, max: 2,
        connectionTimeoutMillis: 5_000, query_timeout: 15_000,
      });
      try {
        assert.equal(await g27Catalog(restoredAdmin), sourceCatalog);
        assert.deepEqual(await g27Data(restoredAdmin), sourceData);
        assert.deepEqual((await restoredAdmin.query(
          "select version,name,checksum from novalure_schema_migrations where version='087_crm_financial_snapshots'",
        )).rows, sourceLedger);
        assert.deepEqual((await restoredAdmin.query(`
          select data_type,numeric_precision,numeric_scale from information_schema.columns
          where table_schema='public' and table_name='crm_conversion_snapshots' and column_name='closed_revenue_cents'
        `)).rows[0], { data_type: "numeric", numeric_precision: 78, numeric_scale: 0 });

        const restoredSnapshotId = (await restoredAdmin.query(
          "select id from crm_financial_snapshots where workspace_id=$1 order by id limit 1",
          [ids.workspace],
        )).rows[0].id;
        await assert.rejects(restoredAdmin.query(
          "update crm_financial_snapshots set review_state='VERIFIED' where id=$1",
          [restoredSnapshotId],
        ), sqlError("55000"));
        await assert.rejects(restoredAdmin.query(
          "truncate crm_financial_events",
        ), sqlError("55000"));

        const visibleCount = async (tenant: string, actor: string) => {
          const client = await restoredRuntime.connect();
          try {
            await client.query("begin");
            await client.query(
              "select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",
              [tenant, actor],
            );
            const count = Number((await client.query("select count(*)::int count from crm_financial_snapshots")).rows[0].count);
            await client.query("rollback");
            return count;
          } catch (error) {
            await client.query("rollback");
            throw error;
          } finally {
            client.release();
          }
        };
        assert.equal(await visibleCount(ids.workspace, ids.owner), sourceWorkspaceSnapshots);
        assert.equal(await visibleCount(ids.foreignWorkspace, ids.foreignOwner), 0);
        assert.deepEqual(await g27Data(db.admin), sourceData, "restore verification must not mutate the source database");
      } finally {
        await restoredRuntime.end();
        await restoredAdmin.end();
      }
    });
  } finally {
    await db.stop();
  }

  await t.test("fresh install creates empty G27 structures and no real policy seeds", async () => {
    const fresh = await startLocalSalesDb();
    try {
      const migrations = await applySalesSchema(fresh);
      assert.equal(migrations.at(-1), "087_crm_financial_snapshots.sql");
      const counts = (await fresh.admin.query("select (select count(*)::int from crm_financial_policy_versions) policies,(select count(*)::int from crm_financial_snapshots) snapshots,(select count(*)::int from crm_financial_events) events")).rows[0];
      assert.deepEqual(counts, { policies: 0, snapshots: 0, events: 0 });
    } finally {
      await fresh.stop();
    }
  });
});
