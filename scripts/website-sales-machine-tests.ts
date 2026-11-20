import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { crmPayloadDigest } from "../src/lib/crm-command";
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID,
  CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions } from "../src/lib/crm-machine-auth";
import { handleWebsiteSalesMachine, websiteSalesMachineContract, websiteSalesMachinePath, websiteSalesMachineDelegationDomain,
  type WebsiteSalesMachineRequest, type WebsiteSalesMachineOptions } from "../src/lib/website-sales-machine";
import { registerWebsiteSalesMachineAccess, type WebsiteSalesMachineRegistration } from "../src/lib/website-sales-machine-registration";
import { websiteSalesIrelandContract, runWebsiteSalesIrelandCommand, type WebsiteSalesIrelandCommand } from "../src/lib/db/website-sales-ireland-repositories";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

type Workflow = { version: number; evidenceDigest: string; status: string; canContact: false; offerDraftId: string; blockedReason: string | null };
type View = { location: { id: string }; workflow: Workflow };
type Reply = { code: string; status: string; data: View; currentData: View; machine: { departmentId: string }; replayed: boolean; persisted: boolean };

test("dedicated Sales machine authority and receipt reconciliation use real PostgreSQL and canonical CRM effects", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  const ids = { workload: randomUUID(), actor: randomUUID(), project: randomUUID(), company: randomUUID(),
    contact: randomUUID(), task: randomUUID(), grant: randomUUID(), locationGrant: randomUUID(), pipeline: randomUUID(),
    foreignWorkspace: randomUUID(), foreignActor: randomUUID(), foreignProject: randomUUID(), foreignCompany: randomUUID() };
  const key = generateKeyPairSync("ed25519");
  const bearer = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
  const options = { pool: db.pool as unknown as TenantPool };
  const auth = (now?: Date): CrmMachineAuthOptions => {
    const seconds = Math.floor((now ?? new Date()).valueOf() / 1000);
    return { now, env: { CRM_MACHINE_AUTH_ENABLED: "1", VERCEL_ENV: "production", NODE_ENV: "production" }, verifier: async () => ({
      payload: { aud: CRM_MACHINE_AUDIENCE, iss: CRM_MACHINE_ISSUER, sub: CRM_MACHINE_SUBJECT, project_id: CRM_MACHINE_PROJECT_ID,
        owner_id: CRM_MACHINE_OWNER_ID, environment: CRM_MACHINE_ENVIRONMENT, iat: seconds - 5, nbf: seconds - 5, exp: seconds + 3600, jti: randomUUID() },
      protectedHeader: { alg: "RS256", typ: "JWT", kid: "local-sales-verifier" },
    }) } as CrmMachineAuthOptions;
  };
  const command = (operation: WebsiteSalesIrelandCommand["operation"], payload: Record<string, unknown>, fields: Partial<WebsiteSalesIrelandCommand> = {}): WebsiteSalesIrelandCommand => ({
    contractVersion: websiteSalesIrelandContract, operation, projectId: ids.project, companyId: ids.company,
    idempotencyKey: randomUUID(), correlationId: randomUUID(), payload, ...fields,
  });
  const envelope = (request: WebsiteSalesIrelandCommand, operation: "execute" | "reconcile" = "execute"): WebsiteSalesMachineRequest => ({ contractVersion: websiteSalesMachineContract, operation, request });
  const credential = (body: unknown, grantId = ids.grant, privateKey: KeyObject = key.privateKey, fields: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ issuedAt: now, expiresAt: now + 60, nonce: randomUUID(), requestHash: crmPayloadDigest(body), ...fields })).toString("base64url");
    return `v1.${grantId}.${payload}.${sign(null, Buffer.from(`${websiteSalesMachineDelegationDomain}.${grantId}.${payload}`), privateKey).toString("base64url")}`;
  };
  const call = async (body: unknown, grantId = ids.grant, headers: Record<string, string> = {}, extra: WebsiteSalesMachineOptions = {}, signed = credential(body, grantId)) => {
    const response = await handleWebsiteSalesMachine(new Request(`https://crm.example.invalid${websiteSalesMachinePath}`, {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-evelyn-delegation": signed, ...headers }, body: JSON.stringify(body),
    }), { ...options, machineAuth: auth(), ...extra });
    return { status: response.status, body: await response.json() as Reply };
  };
  const registration = (fields: Partial<WebsiteSalesMachineRegistration> = {}): WebsiteSalesMachineRegistration => ({
    workloadId: ids.workload, workloadActorId: ids.actor, grantId: ids.grant, actorId: ids.actor, projectId: ids.project,
    companyId: ids.company, locationId: null, departmentId: "SALES", agentId: "evelyn.sales.website-1", taskId: ids.task,
    scopes: ["crm.website-sales.register-location", "crm.website-sales.reconcile"], publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    authorityReference: "SYNTHETIC local dedicated Sales registration", expiresAt: null, ...fields,
  });
  const provision = async (input = registration()) => {
    const client = await db.admin.connect();
    try { await client.query("set role sales_machine_installer"); return await registerWebsiteSalesMachineAccess(client, input); }
    finally { await client.query("reset role"); client.release(); }
  };
  const totals = async () => (await db.admin.query(`select (select count(*) from crm_command_receipts)::int as receipts,
    (select count(*) from crm_domain_events)::int as events,(select count(*) from leads)::int as leads,
    (select count(*) from deals)::int as deals,(select count(*) from crm_offers)::int as offers,
    (select count(*) from crm_offer_deliveries)::int as deliveries`)).rows[0];
  let locationId: string;
  let observe: WebsiteSalesIrelandCommand;
  let workflow: Workflow;
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("begin");
    await db.admin.query(await readFile("migrations/202_website_sales_ireland.sql", "utf8"));
    await db.admin.query("commit");
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Synthetic internal Sales','novalure_internal','novalure_internal'),($2,'Other internal tenant','novalure_internal','novalure_internal') on conflict(id) do nothing", [CRM_MACHINE_WORKSPACE_ID, ids.foreignWorkspace]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic Sales actor','machine@example.invalid','agent','novalure_operator','active'),($3,$4,'Foreign actor','foreign@example.invalid','agent','novalure_operator','active')", [ids.actor, CRM_MACHINE_WORKSPACE_ID, ids.foreignActor, ids.foreignWorkspace]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Synthetic Ireland websites','Website','WEB_DESIGN'),($3,$4,'Foreign project','Website','WEB_DESIGN')", [ids.project, CRM_MACHINE_WORKSPACE_ID, ids.foreignProject, ids.foreignWorkspace]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [CRM_MACHINE_WORKSPACE_ID, ids.project, ids.actor]);
    await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'machine-test','Canonical Sales pipeline','novalure_internal',true)", [ids.pipeline, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'qualify','Qualifizieren',0,'work')", [ids.pipeline, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("update projects set default_pipeline_id=$2 where id=$1", [ids.project, ids.pipeline]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'Synthetic Irish company','Unternehmen','WEB_DESIGN'),($4,$5,$6,'Foreign company','Unternehmen','WEB_DESIGN')", [ids.company, CRM_MACHINE_WORKSPACE_ID, ids.project, ids.foreignCompany, ids.foreignWorkspace, ids.foreignProject]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'Synthetic contact','Ansprechpartner','contact@example.invalid')", [ids.contact, CRM_MACHINE_WORKSPACE_ID, ids.project, ids.company]);
    await db.admin.query("create role sales_machine_installer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    await db.admin.query("grant usage,create on schema public to sales_machine_installer; grant references,select on workspaces,workspace_users,projects,organizations,crm_company_locations to sales_machine_installer; grant select,update on workspaces,workspace_users,project_pipeline_permissions to sales_machine_installer; grant execute on function crm_reject_immutable_mutation() to sales_machine_installer");
    for (const table of ["workspaces", "workspace_users", "project_pipeline_permissions", "projects", "organizations", "crm_company_locations"]) await db.admin.query(`alter table ${table} owner to sales_machine_installer`);
    // Prove installer policies under FORCE RLS with no personal tenant context or privileged owner.
    for (const table of ["workspaces", "workspace_users", "project_pipeline_permissions"]) {
      await db.admin.query(`alter table ${table} enable row level security; alter table ${table} force row level security`);
      await db.admin.query(`create policy sales_machine_fixture on ${table} for select to novalure_tenant_app using(${table === "workspaces" ? "id" : "workspace_id"}=nullif(current_setting('app.tenant_id',true),'')::uuid)`);
    }
    const installer = await db.admin.connect();
    try { await installer.query("set role sales_machine_installer"); await installer.query("begin"); await installer.query(await readFile("migrations/203_website_sales_machine.sql", "utf8")); await installer.query("commit"); }
    finally { try { await installer.query("rollback"); await installer.query("reset role"); } finally { installer.release(); } }

    await t.test("new migration seeds no workload, grant or business authority; OIDC alone is denied", async () => {
      const request = envelope(command("register_location", { countryCode: "IE", address: "1 Main Street, Dublin", sourceUrl: "https://example.invalid/location", sourceReference: "Synthetic fact" }));
      assert.equal((await call(request)).status, 403);
      assert.equal((await db.admin.query("select count(*) from crm_website_sales_machine_grants")).rows[0].count, "0");
    });
    await t.test("only protected owner registers exact scope idempotently; runtime cannot mint or inspect rights", async () => {
      assert.equal((await provision()).status, "REGISTERED"); assert.equal((await provision()).status, "REGISTERED");
      const runtime = await db.pool.connect();
      try {
        await assert.rejects(runtime.query("select * from crm_website_sales_machine_grants"), /permission denied/);
        await assert.rejects(registerWebsiteSalesMachineAccess(runtime, registration()), /BOOTSTRAP_OWNER_REQUIRED/);
      } finally { runtime.release(); }
      await assert.rejects(provision(registration({ agentId: "different-agent" })), /GRANT_CONFLICT/);
      await assert.rejects(provision(registration({ grantId: randomUUID(), companyId: ids.foreignCompany })), /foreign key/);
    });
    await t.test("cookies, origin, wrong key, tampering, expired delegation and body authority overrides fail without effects", async () => {
      const request = envelope(command("register_location", { countryCode: "IE", address: "2 Main Street, Dublin", sourceUrl: "https://example.invalid/location", sourceReference: "Synthetic fact" }));
      const before = await totals();
      const headerCases: Record<string, string>[] = [{ cookie: "arbitrary" }, { origin: "https://crm.example.invalid" }, { authorization: "Bearer invalid" }, { "x-evelyn-delegation": "" }];
      for (const headers of headerCases) assert.equal((await call(request, ids.grant, headers)).status, 401);
      assert.equal((await call(request, ids.grant, {}, {}, credential(request, ids.grant, generateKeyPairSync("ed25519").privateKey))).status, 401);
      assert.equal((await call(request, ids.grant, {}, {}, credential(request, ids.grant, key.privateKey, { requestHash: "a".repeat(64) }))).status, 401);
      assert.equal((await call(request, ids.grant, {}, {}, credential(request, ids.grant, key.privateKey, { issuedAt: 1, expiresAt: 2 }))).status, 401);
      assert.equal((await call({ ...request, actorId: ids.actor })).status, 400);
      assert.equal((await call({ ...request, target: "studio" })).status, 403);
      assert.equal((await call(request, ids.grant, {}, { machineAuth: { ...auth(), env: { CRM_MACHINE_AUTH_ENABLED: "0", VERCEL_ENV: "production", NODE_ENV: "production" } } })).status, 403);
      assert.deepEqual(await totals(), before);
    });
    await t.test("company-only grant registers canonical branch, distinguishes delegation basis, replays once and conflicts on changed body", async () => {
      const request = envelope(command("register_location", { countryCode: "IE", address: "3 Main Street, Dublin", sourceUrl: "https://example.invalid/location", sourceReference: "Synthetic registered source" }));
      const signed = credential(request);
      const first = await call(request, ids.grant, {}, {}, signed); assert.equal(first.status, 200, JSON.stringify(first.body));
      locationId = first.body.data.location.id;
      assert.equal(first.body.machine.departmentId, "SALES"); assert.equal(first.body.persisted, true);
      assert.equal((await db.admin.query("select registration_basis from crm_company_locations where id=$1", [locationId])).rows[0].registration_basis, "REGISTERED_DELEGATION");
      assert.equal((await call(request, ids.grant, {}, {}, signed)).body.code, "NONCE_REPLAY");
      const replay = await call(request); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.data.location.id, locationId);
      const changed = { ...request, request: { ...request.request, payload: { ...("payload" in request.request ? request.request.payload : {}), address: "Changed street, Dublin" } } };
      assert.equal((await call(changed)).status, 409);
      const result = await call({ ...request, operation: "reconcile" }); assert.equal(result.body.status, "COMMITTED"); assert.equal(result.body.currentData.location.id, locationId);
    });
    const prospect = () => {
      const identity = { workspaceId: CRM_MACHINE_WORKSPACE_ID, projectId: ids.project, companyId: ids.company, locationId };
      return { identity, country: "IRELAND", identityStatus: "VERIFIED", domain: null, path: "NO_WEBSITE", ownWebsiteSearch: "NONE_FOUND", obstacle: null, platformUrl: null, bookingRoute: "UNKNOWN", need: "EVIDENCED",
        evidence: ["IDENTITY", "OWN_WEBSITE_SEARCH", "BUSINESS_NEED"].map(kind => ({ evidenceId: kind.toLowerCase(), identity, kind, sourceUrl: "https://example.invalid/" + kind,
          observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), validityCondition: "Synthetic source remains current", finding: "Synthetic scoped source fact", confidence: 0.9 })) };
    };
    await t.test("registration does not create authority over the new location; separate explicit Location grant is required", async () => {
      observe = command("observe", { prospect: prospect() }, { locationId, locationVersion: 1 });
      assert.equal((await call(envelope(observe))).status, 403);
      await provision(registration({ grantId: ids.locationGrant, locationId, scopes: ["crm.website-sales.read", "crm.website-sales.observe", "crm.website-sales.qualify", "crm.website-sales.prepare-draft", "crm.website-sales.stop", "crm.website-sales.reconcile"] }));
      const result = await call(envelope(observe), ids.locationGrant); assert.equal(result.status, 200, JSON.stringify(result.body)); workflow = result.body.data.workflow;
      assert.equal(workflow.status, "OBSERVED"); assert.equal(workflow.canContact, false);
      assert.equal((await call(envelope({ ...observe, companyId: ids.foreignCompany }), ids.locationGrant)).status, 403);
      assert.equal((await call(envelope({ ...observe, locationId: randomUUID() }), ids.locationGrant)).status, 403);
    });
    await t.test("scoped workflow creates canonical lead/deal/task and versioned DRAFT, with no approval or delivery", async () => {
      const qualified = await call(envelope(command("qualify", { contactId: ids.contact, opportunitySummary: "Synthetic opportunity", nextAction: "Review internally", expectedEvidenceDigest: workflow.evidenceDigest }, { locationId, expectedVersion: workflow.version })), ids.locationGrant);
      assert.equal(qualified.status, 200, JSON.stringify(qualified.body)); workflow = qualified.body.data.workflow;
      const content = { subject: "Synthetic proposal", recipientName: "Synthetic contact", recipientEmail: "contact@example.invalid", scope: "Website diagnosis", paymentPlan: "For owner review", discounts: "None", specialTerms: "Draft only", riskComplianceNotes: "No contact authority", terms: "Subject to owner approval", validUntil: new Date(Date.now() + 86400000).toISOString(), currency: "EUR", taxBasis: "NET", items: [{ description: "Website work", quantity: 1, unitNetCents: 250000 }] };
      const result = await call(envelope(command("prepare_offer", { content, expectedEvidenceDigest: workflow.evidenceDigest }, { locationId, expectedVersion: workflow.version })), ids.locationGrant);
      assert.equal(result.status, 200, JSON.stringify(result.body)); workflow = result.body.data.workflow;
      assert.equal(workflow.status, "OFFER_DRAFT"); assert.equal(workflow.canContact, false);
      const rows = (await db.admin.query("select o.status,o.approval_id,l.score,d.stage from crm_offers o join deals d on d.id=o.deal_id join leads l on l.id=d.lead_id where o.id=$1", [workflow.offerDraftId])).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].status, "DRAFT"); assert.equal(rows[0].approval_id, null); assert.equal(rows[0].score, 0); assert.equal(rows[0].stage, "Qualifizieren");
      assert.equal((await totals()).deliveries, 0);
      for (const operation of ["send", "approve", "queue_send", "ConfirmSale"]) assert.equal((await call(envelope({ ...observe, operation } as WebsiteSalesIrelandCommand), ids.locationGrant)).status, 400);
    });
    await t.test("read and exact-original reconciliation return current state, never repeat effects, and expose NOT_FOUND honestly", async () => {
      const before = await totals();
      const read = await call({ contractVersion: websiteSalesMachineContract, operation: "read", request: { projectId: ids.project, companyId: ids.company, locationId, correlationId: randomUUID() } }, ids.locationGrant);
      assert.equal(read.status, 200); assert.equal(read.body.data.workflow.status, "OFFER_DRAFT");
      const result = await call(envelope(observe, "reconcile"), ids.locationGrant);
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.status, "COMMITTED"); assert.equal(result.body.currentData.workflow.status, "OFFER_DRAFT");
      assert.equal((await call(envelope({ ...observe, idempotencyKey: randomUUID() }, "reconcile"), ids.locationGrant)).body.status, "NOT_FOUND");
      assert.equal((await call(envelope({ ...observe, correlationId: randomUUID() }, "reconcile"), ids.locationGrant)).status, 409);
      assert.equal((await call(envelope({ ...observe, payload: { ...observe.payload, investmentPlan: {} } }, "reconcile"), ids.locationGrant)).status, 409);
      assert.deepEqual(await totals(), before);
    });
    await t.test("another valid grant cannot claim the original receipt, even for the same actor and location", async () => {
      const second = randomUUID();
      await provision(registration({ grantId: second, locationId, scopes: ["crm.website-sales.observe", "crm.website-sales.reconcile"] }));
      assert.equal((await call(envelope(observe, "reconcile"), second)).status, 409);
    });
    await t.test("revocation and delegation expiry during a real command-lock wait deny receipt exposure with zero business writes", async () => {
      for (const mode of ["revocation", "expiry"] as const) {
        const before = await totals(), clock = new Date();
        let signal!: () => void;
        const entering = new Promise<void>(resolve => { signal = resolve; });
        const intercepted: TenantPool = { connect: async () => {
          const connection = await db.pool.connect();
          return { release: connection.release.bind(connection), query: async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("pg_advisory_xact_lock")
              && Array.isArray(args[1]) && String(args[1][0]).startsWith("crm-command:")) signal();
            return Reflect.apply(connection.query, connection, args);
          } };
        } } as unknown as TenantPool;
        const blocker = await db.admin.connect();
        try {
          await blocker.query("begin");
          await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`crm-command:${CRM_MACHINE_WORKSPACE_ID}:${observe.idempotencyKey}`]);
          const pending = call(envelope(observe, "reconcile"), ids.locationGrant, {}, { pool: intercepted, machineAuth: auth(clock) });
          await entering;
          if (mode === "revocation") await db.admin.query("update crm_website_sales_machine_grants set revoked_at=clock_timestamp() where id=$1", [ids.locationGrant]);
          else clock.setTime(clock.valueOf() + 120000);
          await blocker.query("commit");
          const result = await pending;
          assert.equal(result.status, mode === "revocation" ? 403 : 401, JSON.stringify(result.body));
          assert.deepEqual(await totals(), before);
        } finally {
          await blocker.query("rollback"); blocker.release();
          if (mode === "revocation") await db.admin.query("update crm_website_sales_machine_grants set revoked_at=null where id=$1", [ids.locationGrant]);
        }
      }
    });
    await t.test("chunked multibyte oversized requests stop at the byte limit without a receipt or effect", async () => {
      const before = await totals(), encoded = new TextEncoder().encode(JSON.stringify({ oversized: "€".repeat(50000) }));
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded.subarray(0, 70000)); controller.enqueue(encoded.subarray(70000)); }, cancel() { cancelled = true; } });
      const response = await handleWebsiteSalesMachine(new Request("https://crm.example.invalid" + websiteSalesMachinePath, {
        method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-evelyn-delegation": credential(envelope(observe), ids.locationGrant) },
        body: stream, duplex: "half",
      } as RequestInit), { ...options, machineAuth: auth() });
      assert.equal(response.status, 413); assert.equal(cancelled, true); assert.deepEqual(await totals(), before);
    });
    await t.test("opt-out and terminal stop remain current when reconciling a historical successful observation", async () => {
      await db.admin.query("update contacts set consent_label='Abgemeldet' where id=$1", [ids.contact]);
      const result = await call(envelope(observe, "reconcile"), ids.locationGrant);
      assert.equal(result.status, 200); assert.equal(result.body.currentData.workflow.blockedReason, "OPT_OUT");
      const stopped = await call(envelope(command("stop", { reason: "OPT_OUT", sourceReference: "Synthetic explicit opt-out" }, { locationId, expectedVersion: workflow.version })), ids.locationGrant);
      assert.equal(stopped.status, 200); assert.equal(stopped.body.data.workflow.status, "STOPPED");
      const again = await call(envelope(observe, "reconcile"), ids.locationGrant);
      assert.equal(again.body.currentData.workflow.status, "STOPPED"); assert.equal(again.body.currentData.workflow.canContact, false);
    });
    await t.test("kill switch, revoked grants, revoked project rights and role changes deny reconciliation before exposing receipts", async () => {
      for (const [table, id, patch, restore] of [
        ["crm_website_sales_machine_workloads", ids.workload, "kill_switch_active=true", "kill_switch_active=false"],
        ["crm_website_sales_machine_grants", ids.locationGrant, "revoked_at=clock_timestamp()", "revoked_at=null"],
        ["workspace_users", ids.actor, "status='suspended'", "status='active'"],
      ]) {
        await db.admin.query(`update ${table} set ${patch} where id=$1`, [id]);
        try { assert.equal((await call(envelope(observe, "reconcile"), ids.locationGrant)).status, 403); }
        finally { await db.admin.query(`update ${table} set ${restore} where id=$1`, [id]); }
      }
      await db.admin.query("update project_pipeline_permissions set can_edit_deals=false where project_id=$1 and user_id=$2", [ids.project, ids.actor]);
      try { assert.equal((await call(envelope(observe, "reconcile"), ids.locationGrant)).status, 403); }
      finally { await db.admin.query("update project_pipeline_permissions set can_edit_deals=true where project_id=$1 and user_id=$2", [ids.project, ids.actor]); }
    });
    await t.test("nonce audit is immutable and tenant scoped; unscoped service sessions remain denied", async () => {
      const runtime = await db.pool.connect();
      try {
        await runtime.query("begin"); await runtime.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [ids.foreignWorkspace, ids.foreignActor]);
        assert.equal((await runtime.query("select count(*) from crm_website_sales_machine_events")).rows[0].count, "0");
        await runtime.query("rollback");
        await assert.rejects(runtime.query("truncate crm_website_sales_machine_events"), /permission denied/);
        await runtime.query("begin"); await runtime.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [CRM_MACHINE_WORKSPACE_ID, ids.actor]);
        await assert.rejects(runtime.query(`insert into crm_website_sales_machine_events(grant_id,nonce,workspace_id,actor_user_id,project_id,company_id,
          location_id,department_id,agent_id,task_id,action,request_hash,oidc_jti_hash,audit_reference,outcome)
          values($1,$2,$3,$4,$5,$6,null,'SALES','evelyn.sales.website-1',$7,'crm.website-sales.read',$8,$8,$9,'SUCCESS')`,
        [ids.locationGrant, randomUUID(), CRM_MACHINE_WORKSPACE_ID, ids.actor, ids.project, ids.company, ids.task, "a".repeat(64), randomUUID()]), /saved resource and scope/);
        await runtime.query("rollback");
      } finally { runtime.release(); }
      await assert.rejects(db.admin.query("update crm_website_sales_machine_grants set agent_id='changed' where id=$1", [ids.locationGrant]), /Replace a revoked Sales/);
      const session = { authenticated: true, source: "database", userId: ids.actor, workspaceId: CRM_MACHINE_WORKSPACE_ID,
        serviceIdentity: { identityId: "unregistered", role: "Evelyn.Service", consumer: "EVELYN", environment: "production", jtiHash: "a".repeat(64) } };
      await assert.rejects(runWebsiteSalesIrelandCommand(session as Parameters<typeof runWebsiteSalesIrelandCommand>[0], observe, options), { code: "SESSION_REQUIRED" });
    });
    await t.test("actual Next route denies missing authentication without falling through to a session adapter", async () => {
      const route = await import("../src/app/api/integrations/evelyn/website-sales/route");
      assert.equal((await route.POST(new Request("https://crm.example.invalid" + websiteSalesMachinePath, { method: "POST" }))).status, 401);
    });
  } finally { await db.stop(); }
});
