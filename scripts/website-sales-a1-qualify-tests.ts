import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { getRolePermissions } from "../src/lib/auth/permissions";
import type { AppSession } from "../src/lib/auth/session";
import { crmPayloadDigest } from "../src/lib/crm-command";
import {
  CRM_MACHINE_AUDIENCE, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID,
  CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions,
} from "../src/lib/crm-machine-auth";
import type { TenantPool } from "../src/lib/db/tenant-client";
import {
  runWebsiteSalesIrelandCommand, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand,
} from "../src/lib/db/website-sales-ireland-repositories";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { studioEnquiryCrmProject } from "../src/lib/studio-enquiry-contract";
import { websiteSalesFormId } from "../src/lib/website-sales-ingestion";
import {
  handleWebsiteSalesMachine, websiteSalesMachineContract, websiteSalesMachineDelegationDomain,
  websiteSalesMachinePath, websiteSalesMachineScopes,
} from "../src/lib/website-sales-machine";
import { registerWebsiteSalesMachineAccess } from "../src/lib/website-sales-machine-registration";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const projectId = studioEnquiryCrmProject;
const workspaceId = CRM_MACHINE_WORKSPACE_ID;
const ids = { actor: randomUUID(), workload: randomUUID(), sourceWorkload: randomUUID(), grant: randomUUID(),
  sourceGrant: randomUUID(), company: randomUUID(), contact: randomUUID(), lead: randomUUID(), deal: randomUUID(),
  transfer: randomUUID(), submission: randomUUID(), task: randomUUID(), intakeTask: randomUUID() };
const key = generateKeyPairSync("ed25519");
const bearer = "eyJ" + "a".repeat(20) + "." + "b".repeat(24) + "." + "c".repeat(24);
const payloadHash = "a".repeat(64);

function auth(): CrmMachineAuthOptions {
  const now = Math.floor(Date.now() / 1000);
  return {
    env: { CRM_MACHINE_AUTH_ENABLED: "1", VERCEL_ENV: "production", NODE_ENV: "production" },
    verifier: async () => ({
      protectedHeader: { alg: "RS256", typ: "JWT", kid: "isolated-a1-fixture" },
      payload: { iss: CRM_MACHINE_ISSUER, aud: CRM_MACHINE_AUDIENCE, owner_id: CRM_MACHINE_OWNER_ID,
        project_id: CRM_MACHINE_PROJECT_ID, sub: CRM_MACHINE_SUBJECT, environment: "production",
        iat: now - 2, nbf: now - 2, exp: now + 60, jti: randomUUID() },
    }),
  };
}
function command(operation: WebsiteSalesIrelandCommand["operation"], payload: Record<string, unknown>, extras = {}): WebsiteSalesIrelandCommand {
  return {
    contractVersion: websiteSalesIrelandContract, operation, projectId, companyId: ids.company, payload, ...extras,
    idempotencyKey: randomUUID(), correlationId: randomUUID(),
  };
}
function envelope(request: WebsiteSalesIrelandCommand, operation = "execute") {
  return { contractVersion: websiteSalesMachineContract, target: "workflow", operation, request };
}
function credential(body: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ issuedAt: now, expiresAt: now + 60, nonce: randomUUID(), requestHash: crmPayloadDigest(body) })).toString("base64url");
  const signature = sign(null, Buffer.from(`${websiteSalesMachineDelegationDomain}.${ids.grant}.${payload}`), key.privateKey).toString("base64url");
  return `v1.${ids.grant}.${payload}.${signature}`;
}
async function call(body: unknown, pool?: TenantPool, delegation = credential(body)) {
  const response = await handleWebsiteSalesMachine(new Request(`https://crm.invalid${websiteSalesMachinePath}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-evelyn-delegation": delegation },
    body: JSON.stringify(body),
  }), { pool, machineAuth: auth() });
  return { status: response.status, body: await response.json() };
}

test("A1 machine rejects other operations, surfaces and unsigned transfer fields before database access", async () => {
  const deniedPool = { connect() { assert.fail("Rejected data must not reach the database"); } } as unknown as TenantPool;
  assert.deepEqual(websiteSalesMachineScopes, ["crm.website-sales.read", "crm.website-sales.qualify", "crm.website-sales.reconcile"]);
  for (const operation of ["register_location", "observe", "stop", "prepare_offer", "Task.Create", "SendOffer"]) {
    assert.equal((await call(envelope({ ...command("observe", {}), operation } as WebsiteSalesIrelandCommand), deniedPool)).body.code, "SALES_OPERATION_NOT_GRANTED");
  }
  assert.equal((await call({ ...envelope(command("qualify", {})), target: "studio" }, deniedPool)).body.code, "SALES_OPERATION_NOT_GRANTED");
  const input = command("qualify", { contactId: ids.contact, expectedEvidenceDigest: payloadHash, nextAction: "Review",
    opportunitySummary: "Synthetic scope" }, { locationId: randomUUID(), expectedVersion: 1 });
  assert.equal((await call(envelope(input), deniedPool)).body.code, "STUDIO_TRANSFER_REQUIRED");
  const wrongTarget = { ...input, payload: { ...input.payload, studioTransfer: { actorId: ids.actor } } };
  assert.equal((await call(envelope(wrongTarget), deniedPool)).status, 400);
});

test("A1 qualify persists one atomic task and the exact receipt using staged local PostgreSQL", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  t.after(() => db.stop());
  const pool = db.pool as unknown as TenantPool;
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  const install = async (name: string, role?: string) => {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      if (role) await client.query(`set local role ${role}`);
      await client.query(await readFile(`migrations/staged/${name}`, "utf8"));
      await client.query("commit");
    } finally { await client.query("rollback"); client.release(); }
  };
  await install("202_website_sales_ireland.sql");
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Synthetic A1','novalure_internal','novalure_internal') on conflict(id) do nothing", [workspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic Sales actor','a1@example.invalid','agent','novalure_operator','active')", [ids.actor, workspaceId]);
  assert.deepEqual((await db.admin.query("select division from projects where id=$1 and workspace_id=$2", [projectId, workspaceId])).rows,
    [{ division: "REAL_ESTATE_GROWTH" }]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspaceId, projectId, ids.actor]);
  await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'Synthetic company','Unternehmen','REAL_ESTATE_GROWTH')", [ids.company, workspaceId, projectId]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,consent_label) values($1,$2,$3,$4,'Synthetic contact','Ansprechpartner','Nur CRM')", [ids.contact, workspaceId, projectId, ids.company]);
  await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,source,type,status) values($1,$2,$3,$4,'Novalure Studio Form','Website Sales','Neu')", [ids.lead, workspaceId, projectId, ids.contact]);
  await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,lead_id,name,stage,source) values($1,$2,$3,$4,$5,'Synthetic existing deal','Qualifiziert','Novalure Studio Form')", [ids.deal, workspaceId, projectId, ids.contact, ids.lead]);
  await db.admin.query("insert into tasks(id,workspace_id,project_id,contact_id,lead_id,title,status) values($1,$2,$3,$4,$5,'Original intake task','open')",
    [ids.intakeTask, workspaceId, projectId, ids.contact, ids.lead]);
  await db.admin.query("insert into forms(id,workspace_id,project_id,name,slug,status) values($1,$2,$3,'Synthetic Studio intake','synthetic-a1','aktiv')", [websiteSalesFormId, workspaceId, projectId]);
  await db.admin.query("insert into form_submissions(id,workspace_id,project_id,form_id,lead_id,deal_id,contact_id,task_id,mode) values($1,$2,$3,$4,$5,$6,$7,$8,'live')",
    [ids.submission, workspaceId, projectId, websiteSalesFormId, ids.lead, ids.deal, ids.contact, ids.intakeTask]);

  // Reader-side PostgreSQL and OIDC boundaries have their own exact tests.
  // This local stand-in checks the originating workload and full transfer tuple on every Sales invocation.
  await db.admin.query(`create table a1_source_fixture (
    workload_id uuid, grant_id uuid, workspace_id uuid, project_id uuid, operation_id uuid, revision integer,
    payload_hash text, lead_id uuid, submission_id uuid, enabled boolean not null default true
  );
  create function public.crm_authenticate_autonomous_workload(text,text,text,text,text,uuid,text)
  returns table(id uuid,workspace_id uuid,identity_id text) language sql stable security definer set search_path=pg_catalog,public as $$
    select workload_id,workspace_id,'EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY'::text from a1_source_fixture where workspace_id=$6
  $$;
  create function public.crm_studio_source_transfer_matches(uuid,uuid,uuid,uuid,uuid,integer,text,uuid,uuid)
  returns boolean language sql volatile security definer set search_path=pg_catalog,public as $$
    select exists(select 1 from a1_source_fixture where enabled and (workload_id,grant_id,workspace_id,project_id,operation_id,revision,payload_hash,lead_id,submission_id)=($1,$2,$3,$4,$5,$6,$7,$8,$9))
  $$;
  grant select on form_submissions to novalure_tenant_app;`);
  await db.admin.query("insert into a1_source_fixture values($1,$2,$3,$4,$5,1,$6,$7,$8)",
    [ids.sourceWorkload, ids.sourceGrant, workspaceId, projectId, ids.transfer, payloadHash, ids.lead, ids.submission]);
  await db.admin.query("create role sales_machine_installer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
  await db.admin.query("grant usage,create on schema public to sales_machine_installer; grant references,select on workspaces,workspace_users,projects,organizations,crm_company_locations to sales_machine_installer; grant select,update on workspaces,workspace_users,project_pipeline_permissions to sales_machine_installer; grant execute on function crm_reject_immutable_mutation() to sales_machine_installer");
  for (const table of ["workspaces", "workspace_users", "project_pipeline_permissions", "projects", "organizations", "crm_company_locations"])
    await db.admin.query(`alter table ${table} owner to sales_machine_installer`);
  await install("203_website_sales_machine.sql", "sales_machine_installer");

  const session: AppSession = { authenticated: true, source: "database", userId: ids.actor,
    workspaceId, workspaceName: "Synthetic A1", name: "Synthetic operator", email: "a1@example.invalid",
    role: "agent", productRole: "novalure_operator", permissions: getRolePermissions("agent"),
    productPermissions: getProductRoleCapabilities("novalure_operator") };
  const registered = await runWebsiteSalesIrelandCommand(session, command("register_location", {
    countryCode: "IE", address: "10 Synthetic Street, Dublin", sourceUrl: "https://example.invalid/address", sourceReference: "Synthetic address evidence",
  }), { pool });
  const locationId = registered.data.location.id;
  const identity = { workspaceId, projectId, companyId: ids.company, locationId };
  const observed = await runWebsiteSalesIrelandCommand(session, command("observe", {
    prospect: { identity, country: "IRELAND", identityStatus: "VERIFIED", domain: null, path: "NO_WEBSITE",
      ownWebsiteSearch: "NONE_FOUND", obstacle: null, platformUrl: null, bookingRoute: "UNKNOWN", need: "EVIDENCED",
      evidence: ["IDENTITY", "OWN_WEBSITE_SEARCH", "BUSINESS_NEED"].map(kind => ({ evidenceId: kind, identity, kind,
        sourceUrl: "https://example.invalid/evidence", finding: "Synthetic current research", confidence: 0.9,
        observedAt: new Date(Date.now() - 30_000).toISOString(), validUntil: new Date(Date.now() + 120_000).toISOString(), validityCondition: "Synthetic evidence remains current" })),
    },
  }, { locationId, locationVersion: registered.data.location.version }), { pool });
  const workflow = observed.data.workflow!;
  assert.equal(workflow.qualificationStatus, "READY");
  const registrar = await db.admin.connect();
  try {
    await registrar.query("set role sales_machine_installer");
    await registerWebsiteSalesMachineAccess(registrar, { workloadId: ids.workload, workloadActorId: ids.actor, grantId: ids.grant,
      actorId: ids.actor, projectId, companyId: ids.company, locationId, departmentId: "SALES", agentId: "evelyn.sales.a1",
      taskId: ids.task, scopes: websiteSalesMachineScopes, publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      authorityReference: "Synthetic current A1 sales assignment", expiresAt: null });
  } finally { await registrar.query("reset role"); registrar.release(); }
  const original = command("qualify", { contactId: ids.contact, opportunitySummary: "Synthetic opportunity", nextAction: "Review internally",
    expectedEvidenceDigest: workflow.evidenceDigest, studioTransfer: {
      sourceGrantId: ids.sourceGrant, operationId: ids.transfer, revision: 1, payloadHash, leadId: ids.lead, submissionId: ids.submission,
    } }, { locationId, expectedVersion: workflow.version });

  const totals = async () => (await db.admin.query(`select
    (select count(*)::int from tasks where workspace_id=$1 and project_id=$2) as tasks,
    (select count(*)::int from leads where workspace_id=$1 and project_id=$2) as leads,
    (select count(*)::int from deals where workspace_id=$1 and project_id=$2) as deals,
    (select count(*)::int from crm_command_receipts where workspace_id=$1 and operation='website_sales.ireland.qualify') as receipts`, [workspaceId, projectId])).rows[0];
  const baseline = await totals();
  assert.equal((await call(envelope({ ...original, projectId: randomUUID() }), pool)).body.code, "SALES_RESOURCE_DENIED");
  const transfer = original.payload.studioTransfer as Record<string, unknown>;
  const changed = { ...original, payload: { ...original.payload, studioTransfer: { ...transfer, revision: 2 } } };
  assert.equal((await call(envelope(changed), pool)).body.code, "STUDIO_SOURCE_TRANSFER_UNCONFIRMED");
  assert.equal((await call(envelope({ ...original, payload: { ...original.payload, contactId: randomUUID() } }), pool)).body.code, "STUDIO_INBOUND_CONTACT_CONFLICT");
  const stale = { ...original, payload: { ...original.payload, expectedEvidenceDigest: payloadHash } };
  assert.equal((await call(envelope(stale), pool)).body.code, "CURRENT_EVIDENCE_REQUIRED");
  await assert.rejects(db.admin.query("update organizations set division='WEB_DESIGN' where id=$1", [ids.company]),
    /CRM_DIVISION_PROJECT_MISMATCH/);
  await db.admin.query("update contacts set consent_label='Opt-out' where id=$1", [ids.contact]);
  assert.equal((await call(envelope(original), pool)).body.code, "OPT_OUT");
  await db.admin.query("update contacts set consent_label='Nur CRM' where id=$1", [ids.contact]);
  assert.deepEqual(await totals(), baseline);

  // Simulate late failure after the exact internal task insertion. No partial commit.
  await db.admin.query(`create function a1_test_abort_qualify() returns trigger language plpgsql as $$ begin
    if new.status='QUALIFIED' then raise exception 'synthetic test rollback'; end if; return new;
    end $$;
    create trigger a1_test_abort before update on crm_website_sales_workflows for each row execute function a1_test_abort_qualify()`);
  assert.equal((await call(envelope(original), pool)).status, 503);
  assert.deepEqual(await totals(), baseline);
  await db.admin.query("drop trigger a1_test_abort on crm_website_sales_workflows");

  const signed = credential(envelope(original));
  const first = await call(envelope(original), pool, signed);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.workflow.leadId, ids.lead);
  assert.equal(first.body.data.workflow.dealId, ids.deal);
  assert.equal(first.body.data.workflow.canContact, false);
  assert.ok(first.body.data.workflow.nextTaskId);
  assert.equal((await call(envelope(original), pool, signed)).body.code, "NONCE_REPLAY");
  const replay = await call(envelope(original), pool);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.data.workflow.nextTaskId, first.body.data.workflow.nextTaskId);
  assert.deepEqual(await totals(), { ...baseline, tasks: baseline.tasks + 1, receipts: baseline.receipts + 1 });

  await db.admin.query("update a1_source_fixture set enabled=false");
  assert.equal((await call(envelope(original), pool)).body.code, "STUDIO_SOURCE_TRANSFER_UNCONFIRMED");
  const receipt = await call(envelope(original, "reconcile"), pool);
  assert.equal(receipt.body.status, "COMMITTED");
  assert.equal(receipt.body.auditReference, first.body.auditReference);
  assert.deepEqual(receipt.body.data, first.body.data);
  assert.equal((await call(envelope(changed, "reconcile"), pool)).body.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await totals(), { ...baseline, tasks: baseline.tasks + 1, receipts: baseline.receipts + 1 });
  assert.deepEqual((await db.admin.query("select title,status from tasks where id=$1", [ids.intakeTask])).rows,
    [{ title: "Original intake task", status: "open" }]);
});
