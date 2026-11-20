import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID,
  CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions } from "../src/lib/crm-machine-auth";
import { handleWebsiteSalesMachine, websiteSalesMachinePath } from "../src/lib/website-sales-machine";
import { registerWebsiteSalesMachineAccess } from "../src/lib/website-sales-machine-registration";
import { runWebsiteSalesIrelandCommand, websiteSalesIrelandContract } from "../src/lib/db/website-sales-ireland-repositories";
import { executeSalesOperationsCommand } from "../src/lib/db/website-sales-operations-repositories";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

type Target = "workflow" | "studio" | "lifecycle" | "autonomy";
type Scope = { tenantId: string; projectId: string; crmWorkspaceId: string; crmProjectId: string; companyId: string; locationId: string };
type Identity = { workloadId: string; grantId: string; departmentId: "SALES"; agentId: string; taskId: string };
type Result = { contractVersion: string; persisted: boolean; commandId: string; auditReference: string; correlationId: string;
  data: Record<string, unknown> & { workflow?: { id: string; version: number; evidenceDigest: string; leadId: string | null; dealId: string | null; nextTaskId: string | null };
    artifactId?: string; refreshId?: string }; currentData?: unknown };
type Runtime = { enqueue(target: Target, command: Record<string, unknown>): Promise<{ id: string }>;
  run(id: string): Promise<Result>; status(id: string): Promise<{ status: string } | null>; originalCommand(id: string): Promise<Record<string, unknown> | null> };
type Cipher = object;
type Store = object;
type Machine = object;
type ExternalRuntime = {
  WebsiteSalesCommandCipher: new (active: string, keys: Map<string, Uint8Array>) => Cipher;
  WebsiteSalesMachineTransport: new (options: { origin: string; workspaceId: string; environment: "local"; identity: Identity;
    getWorkloadToken: () => Promise<string>; getDelegationPrivateKey: () => Promise<string> }) => Machine;
  WebsiteSalesRuntime: new (options: { scope: Scope; store: Store; cipher: Cipher; machine: Machine; environment: "local" }) => Runtime;
};
type QueryClient = { query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };
type ExternalStore = { PostgresWebsiteSalesExecutionStore: new (transactions: { run<T>(scope: Scope, callback: (client: QueryClient) => Promise<T>): Promise<T> }) => Store };

// Deliberately outside generic CI: an absent companion is a failed prerequisite, never a skipped success.
const source = process.env.EVELYN_WEBSITE_SALES_RUNTIME_SOURCE;
if (!source || !path.isAbsolute(source) || path.basename(source) !== "website-sales-runtime.ts") {
  throw new Error("EVELYN_WEBSITE_SALES_RUNTIME_SOURCE must be the absolute real Evelyn website-sales-runtime.ts path");
}
const evelynRoot = path.resolve(path.dirname(source), "../..");

test("real Evelyn runtime and encrypted PostgreSQL store → signed loopback HTTP → CRM handler and PostgreSQL recover committed response loss", { timeout: 240000 }, async t => {
  const external = await import(pathToFileURL(source).href) as ExternalRuntime;
  const storage = await import(pathToFileURL(path.join(path.dirname(source), "website-sales-execution-store.ts")).href) as ExternalStore;
  const allocations = await import(pathToFileURL(path.join(path.dirname(source), "website-sales-allocation.ts")).href) as {
    websiteSalesAllocationOperationId(id: string, purpose: "stage" | "claim" | "settle"): string;
    createWebsiteSalesAllocationExecutor(input: { allocationId: string; expectedAllocationVersion: number; resourceGrants: unknown[] }, ports: {
      original(id: string): Promise<Record<string, unknown> | null>; execute(target: Target, request: Record<string, unknown>): Promise<Result>;
    }): { original(target: Target, id: string): Promise<Record<string, unknown> | null>; execute(target: Target, request: Record<string, unknown>): Promise<Result> };
  };
  t.diagnostic(`Evelyn runtime source SHA256 ${createHash("sha256").update(await readFile(source)).digest("hex")}; synthetic OIDC verifier, real Ed25519/HTTP/PostgreSQL; no provider acceptance claim`);
  const db = await startLocalSalesDb();
  let server: Server | undefined, executionPool: Pool | undefined;
  const ids = { actor: randomUUID(), project: randomUUID(), company: randomUUID(), contact: randomUUID(),
    pipeline: randomUUID(), workload: randomUUID(), grant: randomUUID(), task: randomUUID() };
  const pair = generateKeyPairSync("ed25519"), commandKey = randomBytes(32), deploymentId = randomUUID();
  const options = { pool: db.pool as unknown as TenantPool };
  const agentId = "evelyn.sales.website-1"; // The actual registered CRM identifier contract is text, not UUID-only.
  const bearer = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
  const oidc = (): CrmMachineAuthOptions => {
    const seconds = Math.floor(Date.now()/1000);
    return { env: { NODE_ENV: "production", VERCEL_ENV: "production", CRM_MACHINE_AUTH_ENABLED: "1" }, verifier: async () => ({
      payload: { iss: CRM_MACHINE_ISSUER, aud: CRM_MACHINE_AUDIENCE, sub: CRM_MACHINE_SUBJECT, project_id: CRM_MACHINE_PROJECT_ID,
        owner_id: CRM_MACHINE_OWNER_ID, environment: CRM_MACHINE_ENVIRONMENT, iat: seconds-5, nbf: seconds-5, exp: seconds+3600, jti: randomUUID() },
      protectedHeader: { alg: "RS256", typ: "JWT", kid: "synthetic-connected-verifier" },
    }) } as CrmMachineAuthOptions;
  };
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    for (const file of ["170_crm_personal_mailbox.sql", "202_website_sales_ireland.sql", "203_website_sales_machine.sql", "204_website_sales_studio.sql", "205_website_sales_lifecycle.sql", "206_website_sales_operations.sql", "207_website_sales_conversations.sql"]) {
      await db.admin.query("begin");
      try { await db.admin.query(await readFile(`migrations/${file}`, "utf8")); await db.admin.query("commit"); }
      catch (error) { await db.admin.query("rollback"); throw error; }
    }
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC connected Sales','novalure_internal','novalure_internal') on conflict(id) do nothing", [CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC registered actor','synthetic-actor@example.invalid','agent','novalure_operator','active')", [ids.actor, CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'SYNTHETIC connected Website Sales','Website','WEB_DESIGN')", [ids.project, CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [CRM_MACHINE_WORKSPACE_ID, ids.project, ids.actor]);
    await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'connected-test','Canonical connected pipeline','novalure_internal',true)", [ids.pipeline, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'qualify','Qualifizieren',0,'work')", [ids.pipeline, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("update projects set default_pipeline_id=$2 where id=$1", [ids.project, ids.pipeline]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'Synthetic connected company','Unternehmen','WEB_DESIGN')", [ids.company, CRM_MACHINE_WORKSPACE_ID, ids.project]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'Synthetic connected contact','Ansprechpartner','synthetic-contact@example.invalid')", [ids.contact, CRM_MACHINE_WORKSPACE_ID, ids.project, ids.company]);
    const session: AppSession = { authenticated: true, source: "database", userId: ids.actor, workspaceId: CRM_MACHINE_WORKSPACE_ID,
      workspaceName: "Synthetic connected Sales", name: "Synthetic actor", email: "synthetic-actor@example.invalid", role: "agent", productRole: "novalure_operator",
      permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_operator") };
    const registered = await runWebsiteSalesIrelandCommand(session, { contractVersion: websiteSalesIrelandContract, operation: "register_location", projectId: ids.project, companyId: ids.company,
      idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { countryCode: "IE", address: "1 Synthetic Street, Dublin, Ireland", sourceUrl: "https://example.invalid/company", sourceReference: "Synthetic connected registration only" } }, options);
    const locationId = registered.data.location.id;
    // A protected, non-superuser/non-BYPASS owner provisions only this exact existing resource.
    await db.admin.query("create role connected_sales_registrar nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    for (const table of ["crm_website_sales_machine_workloads", "crm_website_sales_machine_grants"]) {
      await db.admin.query(`alter table ${table} owner to connected_sales_registrar`);
      await db.admin.query(`create policy connected_registrar_owner on ${table} for all to connected_sales_registrar using(true) with check(true)`);
    }
    await db.admin.query("grant usage on schema public to connected_sales_registrar; grant execute on function crm_lock_website_sales_machine_grant(uuid,uuid) to connected_sales_registrar");
    const registrar = await db.admin.connect();
    try {
      await registrar.query("set role connected_sales_registrar");
      await registerWebsiteSalesMachineAccess(registrar, { workloadId: ids.workload, workloadActorId: ids.actor, grantId: ids.grant, actorId: ids.actor,
        projectId: ids.project, companyId: ids.company, locationId, departmentId: "SALES", agentId, taskId: ids.task,
        scopes: ["crm.website-sales.read", "crm.website-sales.observe", "crm.website-sales.qualify", "crm.website-sales.studio.read", "crm.website-sales.studio.create-diagnosis", "crm.website-sales.lifecycle.read", "crm.website-sales.lifecycle.refresh-evidence", "crm.website-sales.reconcile",
          "crm.website-sales.autonomy.read", "crm.website-sales.autonomy.plan-portfolio", "crm.website-sales.autonomy.claim-allocation", "crm.website-sales.autonomy.settle-allocation"],
        publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), authorityReference: "SYNTHETIC connected contract acceptance", expiresAt: null });
    } finally { try { await registrar.query("rollback"); await registrar.query("reset role"); } finally { registrar.release(); } }

    // Install the actual independent Evelyn foundation and Sales ledger unchanged in this disposable cluster.
    for (const role of ["evelyn_prod_owner", "evelyn_prod_migration", "evelyn_prod_recovery"]) await db.admin.query(`create role ${role} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await db.admin.query("alter role evelyn_prod_recovery noinherit; create role evelyn_prod_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    await db.admin.query("do $$ begin if not exists(select 1 from pg_roles where rolname='neon_superuser') then create role neon_superuser nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;end $$");
    await db.admin.query("grant create on database postgres to evelyn_prod_owner; grant evelyn_prod_owner to evelyn_prod_migration; grant evelyn_prod_migration to qa_admin");
    await db.admin.query(await readFile(path.join(evelynRoot, "migrations/production/001_foundation.sql"), "utf8"));
    await db.admin.query(await readFile(path.join(evelynRoot, "migrations/sales/001_website_sales_execution.sql"), "utf8"));
    await db.admin.query(await readFile(path.join(evelynRoot, "migrations/sales/002_website_sales_operations_target.sql"), "utf8"));
    executionPool = new Pool({ host: "127.0.0.1", port: db.port, user: "evelyn_prod_runtime", database: "postgres", max: 4 });
    const scope: Scope = { tenantId: randomUUID(), projectId: randomUUID(), crmWorkspaceId: CRM_MACHINE_WORKSPACE_ID, crmProjectId: ids.project, companyId: ids.company, locationId };
    assert.notEqual(scope.tenantId, scope.crmWorkspaceId); assert.notEqual(scope.projectId, scope.crmProjectId);
    await db.admin.query("insert into evelyn_prod.runtime_scope(runtime_role,tenant_id,project_id,deployment_id,synthetic) values('evelyn_prod_runtime',$1,$2,$3,true)", [scope.tenantId, scope.projectId, deploymentId]);
    await db.admin.query(`insert into evelyn_prod.website_sales_runtime_bindings(binding_id,runtime_role,tenant_id,project_id,crm_workspace_id,crm_project_id,company_id,location_id,deployment_id,authority_reference,enabled,expires_at)
      values($1,'evelyn_prod_runtime',$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC connected scope only',true,now()+interval '10 minutes')`, [randomUUID(), scope.tenantId, scope.projectId, scope.crmWorkspaceId, scope.crmProjectId, scope.companyId, scope.locationId, deploymentId]);
    const transactions = { async run<T>(selected: Scope, callback: (client: QueryClient) => Promise<T>) {
      const client = await executionPool!.connect();
      try { await client.query("begin"); await client.query("set local search_path=pg_catalog,evelyn_prod");
        await client.query("select set_config('evelyn.tenant_id',$1,true),set_config('evelyn.project_id',$2,true)", [selected.tenantId, selected.projectId]);
        const result = await callback(client as unknown as QueryClient); await client.query("commit"); return result;
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    } };
    let origin = "", loseNextExecute = false, loseOperation: string | null = null;
    const calls: string[] = [], serverErrors: string[] = [];
    server = createServer((incoming, outgoing) => { void (async () => {
      try {
        if (incoming.method !== "POST" || incoming.url !== websiteSalesMachinePath) { outgoing.writeHead(404).end(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of incoming) { const buffer = Buffer.from(chunk); bytes += buffer.byteLength; if (bytes > 131072) { outgoing.writeHead(413).end(); return; } chunks.push(buffer); }
        const body = Buffer.concat(chunks), envelope = JSON.parse(body.toString("utf8")) as { target: Target; operation: string; request?: { operation: string } };
        calls.push(`${envelope.target}:${envelope.operation}`);
        const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
        const response = await handleWebsiteSalesMachine(new Request(origin+websiteSalesMachinePath, { method: "POST", headers, body }), { ...options, machineAuth: oidc() });
        const payload = await response.text();
        if (response.status === 409) { const code = (JSON.parse(payload) as { code?: unknown }).code; t.diagnostic(`CRM bounded conflict: ${typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "UNCLASSIFIED"}`); }
        if ((loseNextExecute || loseOperation === envelope.request?.operation) && envelope.operation === "execute" && response.ok) { loseNextExecute = false; loseOperation = null; outgoing.destroy(); return; }
        outgoing.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" }); outgoing.end(payload);
      } catch (error) { serverErrors.push(error instanceof Error ? error.name : "UNKNOWN"); outgoing.writeHead(503).end(); }
    })(); });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address !== "string"); origin = `http://127.0.0.1:${address.port}`;
    const identity: Identity = { workloadId: ids.workload, grantId: ids.grant, departmentId: "SALES", agentId, taskId: ids.task };
    const freshRuntime = () => new external.WebsiteSalesRuntime({ scope,
      store: new storage.PostgresWebsiteSalesExecutionStore(transactions), cipher: new external.WebsiteSalesCommandCipher("connected-v1", new Map([["connected-v1", commandKey]])),
      machine: new external.WebsiteSalesMachineTransport({ origin, workspaceId: scope.crmWorkspaceId, environment: "local", identity,
        getWorkloadToken: async () => bearer, getDelegationPrivateKey: async () => pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString() }), environment: "local" });
    const snapshot = async () => (await db.admin.query(`select (select count(*) from crm_website_sales_observations)::int as observations,
      (select count(*) from crm_website_studio_artifacts)::int as artifacts,(select count(*) from crm_website_sales_refreshes)::int as refreshes,
      (select count(*) from leads)::int as leads,(select count(*) from deals)::int as deals,(select count(*) from tasks)::int as tasks,
      (select count(*) from crm_offer_deliveries)::int as deliveries`)).rows[0];
    const command = (contractVersion: string, operation: string, payload: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({ contractVersion, operation,
      projectId: ids.project, companyId: ids.company, locationId, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload, ...fields });
    const prospect = (newer = false) => {
      const bound = { workspaceId: CRM_MACHINE_WORKSPACE_ID, projectId: ids.project, companyId: ids.company, locationId };
      return { identity: bound, country: "IRELAND", identityStatus: "VERIFIED", domain: null, path: "NO_WEBSITE", ownWebsiteSearch: "NONE_FOUND", obstacle: null,
        platformUrl: null, bookingRoute: "UNKNOWN", need: "EVIDENCED", evidence: ["IDENTITY", "OWN_WEBSITE_SEARCH", "BUSINESS_NEED"].map(kind => ({ identity: bound, kind,
          evidenceId: kind.toLowerCase(), sourceUrl: "https://example.invalid/evidence/"+kind, observedAt: new Date(Date.now()-(newer ? 1000 : 60000)).toISOString(), validUntil: new Date(Date.now()+86400000).toISOString(),
          finding: newer ? "New synthetic scoped observation" : "Synthetic scoped observation", validityCondition: "Synthetic source remains current", confidence: 0.9 })) };
    };
    const recover = async (target: Target, input: Record<string, unknown>, effect: () => Promise<void>) => {
      const initial = freshRuntime(), row = await initial.enqueue(target, input); loseNextExecute = true;
      await assert.rejects(initial.run(row.id), (error: unknown) => !!error && typeof error === "object" && "outcome" in error && error.outcome === "UNKNOWN");
      assert.equal((await initial.status(row.id))?.status, "UNKNOWN"); await effect();
      const before = await snapshot(), resumed = await freshRuntime().run(row.id);
      assert.equal(resumed.persisted, true); assert.equal(resumed.contractVersion, input.contractVersion); assert.equal(resumed.correlationId, input.correlationId);
      assert.equal((await freshRuntime().status(row.id))?.status, "COMMITTED"); assert.deepEqual(await snapshot(), before);
      const cached = await freshRuntime().run(row.id); assert.equal(cached.commandId, resumed.commandId); assert.deepEqual(await snapshot(), before);
      assert.deepEqual(calls.slice(-3), [`${target}:execute`, `${target}:reconcile`, `${target}:reconcile`]);
      return resumed;
    };
    let observed: Result;
    await t.test("workflow response lost after actual commit is reconciled by a fresh runtime and then revalidated on cached reread", async () => {
      observed = await recover("workflow", command(websiteSalesIrelandContract, "observe", { prospect: prospect() }, { locationVersion: 1 }), async () => { assert.equal((await snapshot()).observations, 1); });
      assert.ok(observed.data.workflow);
      const privateEnvelope = (await db.admin.query("select encrypted_request,encrypted_result,status from evelyn_prod.website_sales_execution")).rows[0];
      assert.equal(privateEnvelope.status, "COMMITTED"); assert.ok(!JSON.stringify(privateEnvelope).includes("Synthetic scoped observation"));
    });
    const qualified = await freshRuntime().enqueue("workflow", command(websiteSalesIrelandContract, "qualify", {
      contactId: ids.contact, opportunitySummary: "Synthetic connected research opportunity", nextAction: "Review evidence internally", expectedEvidenceDigest: observed!.data.workflow!.evidenceDigest,
    }, { expectedVersion: observed!.data.workflow!.version }));
    const qualification = await freshRuntime().run(qualified.id); assert.ok(qualification.data.workflow);
    await t.test("Studio real diagnosis uses the same flat committed receipt recovery contract and registered text agent ID", async () => {
      await recover("studio", command("website-sales-studio-api-v1", "create_diagnosis", {
        version: 1, previousArtifactDigest: null, recommendations: [{ text: "Synthetic scoped observation", evidenceIds: ["business_need"] }],
        scope: { included: ["Proposed structure"], excluded: ["Publication and payments"] }, investmentPlan: { estimatedCostMinor: 0, availableBudgetMinor: 0,
          expectedNetPriceMinor: 250000, estimatedDeliveryCostMinor: 50000, minimumMarginBasisPoints: 3000, requiredCapacityMinutes: 60, availableCapacityMinutes: 600, rightsVerified: true, budgetReference: null },
      }, { workflowId: qualification.data.workflow!.id, expectedWorkflowVersion: qualification.data.workflow!.version, expectedEvidenceDigest: qualification.data.workflow!.evidenceDigest }), async () => { assert.equal((await snapshot()).artifacts, 1); });
    });
    let refreshed: Result;
    await t.test("lifecycle refresh is reconciled without duplicating the canonical lead deal task or observation", async () => {
      refreshed = await recover("lifecycle", command("website-sales-lifecycle-v1", "refresh_evidence", { prospect: prospect(true), locationVersion: 1 }, { expectedVersion: qualification.data.workflow!.version }), async () => {
        const counts = await snapshot(); assert.equal(counts.refreshes, 1); assert.equal(counts.observations, 2); assert.equal(counts.leads, 1); assert.equal(counts.deals, 1); assert.equal(counts.tasks, 1);
      });
    });
    await t.test("actual CRM allocation and actual Evelyn worker recover claim, stage and settlement response loss without a second effect", async () => {
      const ownerId = randomUUID();
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic policy owner','synthetic-owner@example.invalid','owner','novalure_operator','active')", [ownerId, CRM_MACHINE_WORKSPACE_ID]);
      const owner: AppSession = { ...session, userId: ownerId, role: "owner", permissions: getRolePermissions("owner") };
      const past = new Date(Date.now() - 60000).toISOString(), future = new Date(Date.now() + 3600000).toISOString();
      const configured = await executeSalesOperationsCommand(owner, { contractVersion: "website-sales-operations-v1", operation: "configure_portfolio", projectId: ids.project, companyId: ids.company, locationId,
        expectedVersion: 0, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { title: "Synthetic approved resource window", budgetMinor: 30, capacityMinutes: 10, windowStart: past, windowEnd: future,
          managedResources: [{ projectId: ids.project, companyId: ids.company, locationId }], stageEstimates: [{ stage: "DIAGNOSIS", estimatedCostMinor: 30, requiredMinutes: 10 }],
          policy: { enabled: true, validFrom: past, validUntil: future, maxOpportunities: 1, maxPerCompany: 1, maxCostPerOpportunityMinor: 30, maxMinutesPerOpportunity: 10,
            minimumKnownSignals: 2, minimumScore: 1, weights: { FIT: 5000, NEED: 5000, INTENT: 0, URGENCY: 0, ENGAGEMENT: 0 } } } }, options);
      const workflow = refreshed!.data.workflow!; assert(workflow);
      const planCommand = command("website-sales-operations-v1", "plan_portfolio", { portfolioId: configured.data.portfolioId, resourceGrants: [], candidates: [{ projectId: ids.project,
        companyId: ids.company, locationId, workflowId: workflow.id, expectedWorkflowVersion: workflow.version, expectedEvidenceDigest: workflow.evidenceDigest, requestedStage: "DIAGNOSIS", purpose: "INTERNAL_RESEARCH", dialogSourceId: null }] }, { expectedVersion: configured.data.version });
      const planned = await freshRuntime().enqueue("autonomy", planCommand), plannedReceipt = await freshRuntime().run(planned.id);
      const allocationId = (plannedReceipt.data.allocationIds as string[])[0]!; assert(allocationId);
      const stageId = allocations.websiteSalesAllocationOperationId(allocationId, "stage");
      const previous = (await db.admin.query("select artifact_digest from crm_website_studio_artifacts where workflow_id=$1 and kind='DIAGNOSIS' order by version desc limit 1", [workflow.id])).rows[0];
      const stage = command("website-sales-studio-api-v1", "create_diagnosis", { version: 2, previousArtifactDigest: previous.artifact_digest,
        recommendations: [{ text: "New synthetic scoped observation", evidenceIds: ["business_need"] }], scope: { included: ["Proposed structure"], excluded: ["Publication and payments"] },
        investmentPlan: { estimatedCostMinor: 30, availableBudgetMinor: 30, expectedNetPriceMinor: 250000, estimatedDeliveryCostMinor: 50000, minimumMarginBasisPoints: 3000,
          requiredCapacityMinutes: 10, availableCapacityMinutes: 10, rightsVerified: true, budgetReference: `crm-allocation:${allocationId}:1` } },
      { idempotencyKey: stageId, workflowId: workflow.id, expectedWorkflowVersion: workflow.version, expectedEvidenceDigest: workflow.evidenceDigest });
      const worker = () => allocations.createWebsiteSalesAllocationExecutor({ allocationId, expectedAllocationVersion: 1, resourceGrants: [] }, {
        original: id => freshRuntime().originalCommand(id), execute: async (target, request) => { const runtime = freshRuntime(), row = await runtime.enqueue(target, request); return runtime.run(row.id); } });
      for (const phase of ["claim_allocation", "create_diagnosis", "settle_allocation"]) {
        loseOperation = phase; const original = await worker().original("studio", stageId);
        await assert.rejects(worker().execute("studio", original ?? stage), (error: unknown) => !!error && typeof error === "object" && "outcome" in error && error.outcome === "UNKNOWN");
        assert.equal(loseOperation, null, `${phase} actually committed before its response was lost`);
      }
      await worker().execute("studio", (await worker().original("studio", stageId))!);
      assert.equal((await snapshot()).artifacts, 2); assert.equal((await db.admin.query("select count(*) from crm_website_sales_ops_effects where allocation_id=$1", [allocationId])).rows[0].count, "1");
      const allocation = (await db.admin.query("select status,version from crm_website_sales_ops_allocations where id=$1", [allocationId])).rows[0];
      assert.deepEqual(allocation, { status: "COMPLETED", version: 3 });
      assert.equal((await db.admin.query("select count(*) from evelyn_prod.website_sales_execution where target='autonomy'")).rows[0].count, "3");
      assert.equal((await snapshot()).deliveries, 0);
    });
    await t.test("revocation denies committed cached data and all effects remain internal", async () => {
      await db.admin.query("update crm_website_sales_machine_grants set revoked_at=clock_timestamp() where id=$1", [ids.grant]);
      const row = (await db.admin.query("select operation_id from evelyn_prod.website_sales_execution order by created_at limit 1")).rows[0];
      await assert.rejects(freshRuntime().run(row.operation_id), /SALES_HTTP_403/);
      assert.equal((await snapshot()).deliveries, 0); assert.equal((await db.admin.query("select count(*) from crm_offer_approvals")).rows[0].count, "0"); assert.deepEqual(serverErrors, []);
    });
  } finally {
    if (server?.listening) { const closing = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await closing; }
    await executionPool?.end(); await db.stop();
  }
});
