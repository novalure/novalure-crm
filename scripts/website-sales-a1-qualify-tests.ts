import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SignJWT, jwtVerify, type JWTVerifyOptions } from "jose";
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
import { studioEnquiryCrmProject, studioEnquiryProject } from "../src/lib/studio-enquiry-contract";
import { studioSourcePreviewAudience } from "../src/lib/studio-source-reader";
import { websiteSalesFormId } from "../src/lib/website-sales-ingestion";
import {
  handleWebsiteSalesMachine, websiteSalesMachineContract, websiteSalesMachineDelegationDomain,
  websiteSalesMachinePath, websiteSalesMachineScopes,
} from "../src/lib/website-sales-machine";
import { registerWebsiteSalesMachineAccess } from "../src/lib/website-sales-machine-registration";
import { websiteSalesPreviewAudience, websiteSalesPreviewIdentity, websiteSalesPreviewSubject } from "../src/lib/website-sales-preview-auth";
import { applySalesSchema, LocalSalesPool, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const projectId = studioEnquiryCrmProject;
const workspaceId = CRM_MACHINE_WORKSPACE_ID;
const ids = { actor: randomUUID(), workload: randomUUID(), sourceWorkload: randomUUID(), grant: randomUUID(),
  sourceGrant: randomUUID(), company: randomUUID(), contact: randomUUID(), lead: randomUUID(), deal: randomUUID(),
  transfer: randomUUID(), submission: randomUUID(), task: randomUUID(), intakeTask: randomUUID() };
const key = generateKeyPairSync("ed25519");
const oidcKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const payloadHash = "a".repeat(64);
const previewHost = "sales-a1-synthetic.vercel.app";
const previewTarget = { deploymentId: "dpl_SalesA1Synthetic", revision: "b".repeat(40) };
const previewGrantId = randomUUID();

type Profile = "production" | "preview";
function runtime(profile: Profile): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { CRM_MACHINE_AUTH_ENABLED: "1", VERCEL_ENV: profile, NODE_ENV: "test" };
  if (profile === "production") return base;
  return { ...base, CRM_WEBSITE_SALES_PREVIEW_ENABLED: "1", VERCEL: "1", VERCEL_URL: previewHost,
    VERCEL_PROJECT_ID: studioEnquiryProject, VERCEL_DEPLOYMENT_ID: previewTarget.deploymentId, VERCEL_GIT_COMMIT_SHA: previewTarget.revision,
    DATABASE_URL: "postgresql://novalure_app:test@ep-summer-dew-bht4t903-pooler.synthetic.neon.tech/neondb?sslmode=verify-full" };
}
const verifier: NonNullable<CrmMachineAuthOptions["verifier"]> = async (jwt, options) =>
  jwtVerify(jwt, oidcKey.publicKey, options as JWTVerifyOptions) as ReturnType<NonNullable<CrmMachineAuthOptions["verifier"]>>;
async function oidcToken(profile: Profile, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: CRM_MACHINE_ISSUER, owner_id: CRM_MACHINE_OWNER_ID, project_id: CRM_MACHINE_PROJECT_ID,
    aud: profile === "preview" ? websiteSalesPreviewAudience : CRM_MACHINE_AUDIENCE,
    sub: profile === "preview" ? websiteSalesPreviewSubject : CRM_MACHINE_SUBJECT, environment: profile,
    iat: now - 2, nbf: now - 2, exp: now + 60, jti: randomUUID(), ...overrides,
  }).setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "isolated-a1-fixture" }).sign(oidcKey.privateKey);
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
function credential(body: unknown, grantId = ids.grant) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ issuedAt: now, expiresAt: now + 60, nonce: randomUUID(), requestHash: crmPayloadDigest(body) })).toString("base64url");
  const signature = sign(null, Buffer.from(`${websiteSalesMachineDelegationDomain}.${grantId}.${payload}`), key.privateKey).toString("base64url");
  return `v1.${grantId}.${payload}.${signature}`;
}
async function call(body: unknown, pool?: TenantPool, delegation?: string, options: {
  env?: NodeJS.ProcessEnv; token?: string; host?: string;
} = {}) {
  const env = options.env ?? runtime("production");
  const profile = env.VERCEL_ENV === "preview" ? "preview" : "production";
  const bearer = options.token ?? await oidcToken(profile);
  const signed = delegation ?? credential(body, profile === "preview" ? previewGrantId : ids.grant);
  const response = await handleWebsiteSalesMachine(new Request(`https://${options.host ?? env.VERCEL_URL ?? "crm.invalid"}${websiteSalesMachinePath}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-evelyn-delegation": signed },
    body: JSON.stringify(body),
  }), { pool, machineAuth: { env, verifier } });
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

test("A1 Preview requires its own signed OIDC token and the enabled native receiver before SQL", async () => {
  let connections = 0;
  const deniedPool = { connect() { connections++; throw new Error("Unexpected database"); } } as unknown as TenantPool;
  const body = { contractVersion: websiteSalesMachineContract, operation: "read",
    request: { projectId, companyId: ids.company, locationId: randomUUID(), correlationId: randomUUID() } };
  const env = runtime("preview"), preview = await oidcToken("preview");
  const production = await oidcToken("production"), source = await oidcToken("preview", { aud: studioSourcePreviewAudience });
  const wrongProject = await oidcToken("preview", { project_id: "prj_Unregistered" });
  const wrongEnvironment = await oidcToken("preview", { environment: "production" });
  const wrongOwner = await oidcToken("preview", { owner_id: "team_Unregistered" });
  for (const options of [
    { env, token: production }, { env, token: source }, { env, token: wrongProject },
    { env, token: wrongEnvironment }, { env, token: wrongOwner },
    { env, token: preview, host: "foreign-receiver.vercel.app" },
    { env: { ...env, CRM_WEBSITE_SALES_PREVIEW_ENABLED: "0" }, token: preview },
    { env: { ...env, VERCEL_PROJECT_ID: "prj_Unregistered" }, token: preview },
    { env: { ...env, VERCEL_TARGET_ENV: "production" }, token: preview },
    { env: { ...env, DATABASE_URL: env.DATABASE_URL!.replace("summer-dew-bht4t903", "spring-night") }, token: preview },
    { env: { ...env, DATABASE_URL: env.DATABASE_URL!.replace("novalure_app", "neondb_owner") }, token: preview },
  ]) assert.equal((await call(body, deniedPool, undefined, options)).body.code, "SALES_PREVIEW_ACCESS_DENIED");
  assert.equal((await call(body, deniedPool, undefined, { env: runtime("production"), token: preview })).status, 401);
  assert.equal(connections, 0);
});

for (const profile of ["production", "preview"] as const) {
test(`A1 ${profile} qualify persists one atomic task and the exact receipt using staged local PostgreSQL`, { timeout: 240_000 }, async t => {
  const cluster = await startLocalSalesDb();
  let previewAdmin: LocalSalesPool | undefined, previewRuntime: LocalSalesPool | undefined;
  t.after(async () => {
    try { await Promise.all([previewAdmin?.end(), previewRuntime?.end()]); }
    finally { await cluster.stop(); }
  });
  const local = { host: "127.0.0.1", port: cluster.port, database: "neondb" };
  if (profile === "preview") {
    await cluster.admin.query("create database neondb");
    await cluster.admin.query(`alter database neondb set neon.project_id='long-fog-84900593';
      alter database neondb set neon.branch_id='br-summer-mountain-bh7w67e3';
      alter role novalure_app login`);
    previewAdmin = new LocalSalesPool({ ...local, user: "qa_admin" });
    previewRuntime = new LocalSalesPool({ ...local, user: "novalure_app" });
  }
  const db = { ...cluster, admin: previewAdmin ?? cluster.admin, pool: previewRuntime ?? cluster.pool };
  const pool = db.pool as unknown as TenantPool;
  const activeGrantId = profile === "preview" ? previewGrantId : ids.grant;
  const invoke = (body: unknown, delegation?: string) => call(body, pool, delegation, { env: runtime(profile) });
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  if (profile === "preview") await db.admin.query("grant novalure_tenant_app to novalure_app");
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
  grant select on form_submissions to novalure_tenant_app;`);
  if (profile === "production") {
    await db.admin.query(`create function public.crm_studio_source_transfer_matches(uuid,uuid,uuid,uuid,uuid,integer,text,uuid,uuid)
      returns boolean language sql volatile security definer set search_path=pg_catalog,public as $$
      select exists(select 1 from a1_source_fixture where enabled
        and (workload_id,grant_id,workspace_id,project_id,operation_id,revision,payload_hash,lead_id,submission_id)=($1,$2,$3,$4,$5,$6,$7,$8,$9))
      $$`);
  } else {
    // Install the actual Preview SOURCE check with isolated predecessor rows.
    await db.admin.query(`create role sales_source_fixture_owner nologin noinherit;
      grant create on schema public to sales_source_fixture_owner;
      create table studio_enquiry_transfers (
        operation_id uuid primary key, workspace_id uuid, revision integer, payload_hash text,
        snapshot_text text, state text, lead_id uuid, submission_id uuid, accepted_at timestamptz
      );
      alter table studio_enquiry_transfers owner to sales_source_fixture_owner;
      alter table studio_enquiry_transfers enable row level security;
      alter table studio_enquiry_transfers force row level security`);
    await install("evelyn_studio_source.sql", "sales_source_fixture_owner");
    const owner = await db.admin.connect();
    try {
      await owner.query("set role sales_source_fixture_owner");
      await owner.query("insert into crm_studio_source_activation(profile) values('preview')");
      await owner.query(`insert into crm_studio_source_grants
        (id,profile,workspace_id,crm_project_id,receiver_project,deployment_id,revision,credential_hash,authority_reference,expires_at)
        values($1,'preview',$2,$3,$4,$5,$6,$7,'Synthetic Preview SOURCE grant',clock_timestamp()+interval '1 hour')`,
      [ids.sourceGrant, workspaceId, projectId, studioEnquiryProject, previewTarget.deploymentId, previewTarget.revision, "c".repeat(64)]);
    } finally { await owner.query("reset role"); owner.release(); }
    await db.admin.query(`insert into studio_enquiry_transfers(operation_id,workspace_id,revision,payload_hash,snapshot_text,state,lead_id,submission_id)
      values($1,$2,1,$3,'{"syntheticTest":false}','reserved',$4,$5)`, [ids.transfer, workspaceId, payloadHash, ids.lead, ids.submission]);
    await db.admin.query("update studio_enquiry_transfers set state='accepted',accepted_at=clock_timestamp() where operation_id=$1", [ids.transfer]);
  }
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
  const observe = async (expiresAt: number, expectedVersion?: number) => runWebsiteSalesIrelandCommand(session, command("observe", {
    prospect: { identity, country: "IRELAND", identityStatus: "VERIFIED", domain: null, path: "NO_WEBSITE",
      ownWebsiteSearch: "NONE_FOUND", obstacle: null, platformUrl: null, bookingRoute: "UNKNOWN", need: "EVIDENCED",
      evidence: ["IDENTITY", "OWN_WEBSITE_SEARCH", "BUSINESS_NEED"].map(kind => ({ evidenceId: kind, identity, kind,
        sourceUrl: "https://example.invalid/evidence", finding: "Synthetic current research", confidence: 0.9,
        observedAt: new Date(Date.now() - 30_000).toISOString(), validUntil: new Date(expiresAt).toISOString(), validityCondition: "Synthetic evidence remains current" })),
    },
  }, { locationId, locationVersion: registered.data.location.version, expectedVersion }), { pool });
  let workflow = (await observe(Date.now() + 120_000)).data.workflow!;
  assert.equal(workflow.qualificationStatus, "READY");
  const registrar = await db.admin.connect();
  try {
    await registrar.query("set role sales_machine_installer");
    const registration = { workloadId: ids.workload, workloadActorId: ids.actor, grantId: ids.grant,
      actorId: ids.actor, projectId, companyId: ids.company, locationId, departmentId: "SALES" as const, agentId: "evelyn.sales.a1",
      taskId: ids.task, scopes: websiteSalesMachineScopes, publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      authorityReference: "Synthetic current A1 sales assignment", expiresAt: null };
    const preview = { ...previewTarget, sourceGrantId: ids.sourceGrant };
    const previewRegistration = { ...registration, workloadId: randomUUID(), grantId: previewGrantId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), preview };
    await registerWebsiteSalesMachineAccess(registrar, registration);
    if (profile === "preview") {
      await registerWebsiteSalesMachineAccess(registrar, previewRegistration);
    } else {
      await assert.rejects(registerWebsiteSalesMachineAccess(registrar, previewRegistration), /SALES_PREVIEW_TARGET_REQUIRED/);
    }
  } finally { await registrar.query("reset role"); registrar.release(); }
  const qualify = (observed: typeof workflow) => command("qualify", { contactId: ids.contact,
    opportunitySummary: "Synthetic opportunity", nextAction: "Review internally",
    expectedEvidenceDigest: observed.evidenceDigest, studioTransfer: {
      sourceGrantId: ids.sourceGrant, operationId: ids.transfer, revision: 1, payloadHash, leadId: ids.lead, submissionId: ids.submission,
    } }, { locationId, expectedVersion: observed.version });

  const totals = async () => (await db.admin.query(`select
    (select count(*)::int from tasks where workspace_id=$1 and project_id=$2) as tasks,
    (select count(*)::int from leads where workspace_id=$1 and project_id=$2) as leads,
    (select count(*)::int from deals where workspace_id=$1 and project_id=$2) as deals,
    (select count(*)::int from crm_command_receipts where workspace_id=$1 and operation='website_sales.ireland.qualify') as receipts`, [workspaceId, projectId])).rows[0];
  if (profile === "production") {
    await t.test("a Lead UPDATE lock carries valid evidence across its real expiry and rolls back every effect", async () => {
      const expiresAt = Date.now() + 5_000;
      const expiring = (await observe(expiresAt, workflow.version)).data.workflow!;
      assert.equal(expiring.qualificationStatus, "READY");
      const request = qualify(expiring);
      const snapshot = async () => ({
        totals: await totals(),
        state: (await db.admin.query(`select
          (select jsonb_build_object('status',status,'version',version,'task',next_task_id)
            from crm_website_sales_workflows where id=$1) as workflow,
          (select jsonb_build_object('version',version,'metadata',metadata) from leads where id=$2) as lead,
          (select jsonb_build_object('version',version,'metadata',metadata,'company',organization_id) from deals where id=$3) as deal,
          (select count(*)::int from audit_logs where after->>'correlationId'=$4) as audit,
          (select count(*)::int from crm_domain_events where correlation_id=$4::text::uuid) as events,
          (select count(*)::int from crm_website_sales_machine_events where grant_id=$5) as machine_events`,
        [expiring.id, ids.lead, ids.deal, request.correlationId, activeGrantId])).rows[0],
      });
      const before = await snapshot();
      const blocker = await db.admin.connect();
      let pending: ReturnType<typeof invoke> | undefined;
      try {
        await blocker.query("begin");
        await blocker.query("select id from leads where id=$1 for update", [ids.lead]);
        const blockerPid = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
        pending = invoke(envelope(request));
        let waitingAfterReady = false;
        while (!waitingAfterReady && Date.now() < expiresAt) {
          waitingAfterReady = (await db.admin.query(`select exists(
            select 1 from pg_stat_activity where wait_event_type='Lock' and $1::int=any(pg_blocking_pids(pid))
              and query like 'update leads l set metadata=%') as waiting`, [blockerPid])).rows[0].waiting;
          if (!waitingAfterReady) await delay(20);
        }
        assert.equal(waitingAfterReady, true, "the transfer must reach the late Lead update while evidence is valid");
        assert.ok(Date.now() < expiresAt, "the Lead update must be blocked before expiry");
        await delay(Math.max(0, expiresAt - Date.now()) + 25);
        assert.ok(Date.now() >= expiresAt);
        await blocker.query("commit");
        const result = await pending;
        assert.equal(result.status, 409);
        assert.equal(result.body.code, "CURRENT_EVIDENCE_REQUIRED");
        assert.deepEqual(await snapshot(), before);
      } finally {
        try { await blocker.query("rollback"); } finally { blocker.release(); }
        await pending;
      }
      workflow = (await observe(Date.now() + 120_000, expiring.version)).data.workflow!;
    });
  }
  const original = qualify(workflow);
  const baseline = await totals();
  if (profile === "preview") {
    const read = { contractVersion: websiteSalesMachineContract, operation: "read",
      request: { projectId, companyId: ids.company, locationId, correlationId: randomUUID() } };
    assert.equal((await invoke(read)).body.data.workflow.qualificationStatus, "READY");
    assert.equal((await invoke(envelope(original), credential(envelope(original), ids.grant))).body.code, "SALES_ACCESS_DENIED");
    assert.equal((await call(envelope(original), pool, credential(envelope(original), previewGrantId))).body.code, "SALES_ACCESS_DENIED");
    for (const mismatch of [{ VERCEL_GIT_COMMIT_SHA: "e".repeat(40) }, { VERCEL_DEPLOYMENT_ID: "dpl_Other" }]) {
      assert.equal((await call(envelope(original), pool, undefined, { env: { ...runtime("preview"), ...mismatch } })).body.code,
        "SALES_ACCESS_DENIED");
    }
    const wrongRole = new LocalSalesPool({ ...local, user: db.role });
    try {
      assert.equal((await call(envelope(original), wrongRole as unknown as TenantPool, undefined, { env: runtime("preview") })).body.code,
        "SALES_ACCESS_DENIED");
    } finally { await wrongRole.end(); }
    await db.admin.query("alter role novalure_app set neon.branch_id='br-foreign'");
    const wrongBranch = new LocalSalesPool({ ...local, user: "novalure_app" });
    try {
      assert.equal((await call(envelope(original), wrongBranch as unknown as TenantPool, undefined, { env: runtime("preview") })).body.code,
        "SALES_ACCESS_DENIED");
    } finally {
      await wrongBranch.end();
      await db.admin.query("alter role novalure_app reset neon.branch_id");
    }
  }
  assert.equal((await invoke(envelope({ ...original, projectId: randomUUID() }))).body.code, "SALES_RESOURCE_DENIED");
  const transfer = original.payload.studioTransfer as Record<string, unknown>;
  const changed = { ...original, payload: { ...original.payload, studioTransfer: { ...transfer, revision: 2 } } };
  assert.equal((await invoke(envelope(changed))).body.code, "STUDIO_SOURCE_TRANSFER_UNCONFIRMED");
  assert.equal((await invoke(envelope({ ...original, payload: { ...original.payload, contactId: randomUUID() } }))).body.code, "STUDIO_INBOUND_CONTACT_CONFLICT");
  const stale = { ...original, payload: { ...original.payload, expectedEvidenceDigest: payloadHash } };
  assert.equal((await invoke(envelope(stale))).body.code, "CURRENT_EVIDENCE_REQUIRED");
  await assert.rejects(db.admin.query("update organizations set division='WEB_DESIGN' where id=$1", [ids.company]),
    /CRM_DIVISION_PROJECT_MISMATCH/);
  await db.admin.query("update contacts set consent_label='Opt-out' where id=$1", [ids.contact]);
  assert.equal((await invoke(envelope(original))).body.code, "OPT_OUT");
  await db.admin.query("update contacts set consent_label='Nur CRM' where id=$1", [ids.contact]);
  assert.deepEqual(await totals(), baseline);

  // Simulate late failure after the exact internal task insertion. No partial commit.
  await db.admin.query(`create function a1_test_abort_qualify() returns trigger language plpgsql as $$ begin
    if new.status='QUALIFIED' then raise exception 'synthetic test rollback'; end if; return new;
    end $$;
    create trigger a1_test_abort before update on crm_website_sales_workflows for each row execute function a1_test_abort_qualify()`);
  assert.equal((await invoke(envelope(original))).status, 503);
  assert.deepEqual(await totals(), baseline);
  await db.admin.query("drop trigger a1_test_abort on crm_website_sales_workflows");

  const signed = credential(envelope(original), activeGrantId);
  const first = await invoke(envelope(original), signed);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.workflow.leadId, ids.lead);
  assert.equal(first.body.data.workflow.dealId, ids.deal);
  assert.equal(first.body.data.workflow.canContact, false);
  assert.ok(first.body.data.workflow.nextTaskId);
  assert.equal((await invoke(envelope(original), signed)).body.code, "NONCE_REPLAY");
  const replay = await invoke(envelope(original));
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.data.workflow.nextTaskId, first.body.data.workflow.nextTaskId);
  assert.deepEqual(await totals(), { ...baseline, tasks: baseline.tasks + 1, receipts: baseline.receipts + 1 });

  if (profile === "preview") {
    const audit = (await db.admin.query("select after->'actor' as actor from audit_logs where id=$1", [first.body.auditReference])).rows[0].actor;
    assert.equal(audit.actorType, "SERVICE_IDENTITY");
    assert.equal(audit.identityId, websiteSalesPreviewIdentity);
    assert.equal(audit.environment, "preview");
    assert.equal(audit.role, "Evelyn.QA");
    await db.admin.query("update crm_studio_source_grants set revoked_at=clock_timestamp() where id=$1", [ids.sourceGrant]);
  } else {
    await db.admin.query("update a1_source_fixture set enabled=false");
  }
  assert.equal((await invoke(envelope(original))).body.code, "STUDIO_SOURCE_TRANSFER_UNCONFIRMED");
  const receipt = await invoke(envelope(original, "reconcile"));
  assert.equal(receipt.body.status, "COMMITTED");
  assert.equal(receipt.body.auditReference, first.body.auditReference);
  assert.deepEqual(receipt.body.data, first.body.data);
  assert.equal((await invoke(envelope(changed, "reconcile"))).body.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await totals(), { ...baseline, tasks: baseline.tasks + 1, receipts: baseline.receipts + 1 });
  assert.deepEqual((await db.admin.query("select title,status from tasks where id=$1", [ids.intakeTask])).rows,
    [{ title: "Original intake task", status: "open" }]);
});
}
