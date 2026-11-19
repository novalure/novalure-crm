import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { runWebsiteSalesIrelandCommand, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand } from "../src/lib/db/website-sales-ireland-repositories";
import { parseWebsiteSalesWorkbenchQuery, readWebsiteSalesWorkbench } from "../src/lib/db/website-sales-workbench-repository";
import { websiteSalesWorkbenchContract, websiteSalesWorkbenchPath, type WebsiteSalesWorkbenchQuery, type WebsiteSalesWorkbenchResponse } from "../src/lib/website-sales-workbench-types";
import { GET } from "../src/app/api/crm/website-sales/workbench/route";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";

test("Website Sales workbench reads real scoped CRM data without business writes or a core loader", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const origin = "http://127.0.0.1:3061";
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("begin"); await db.admin.query(await readFile("migrations/202_website_sales_ireland.sql", "utf8")); await db.admin.query("commit");
    const first = await seedSalesBrowser(db), foreign = await seedSalesBrowser(db);
    const ids = { project: randomUUID(), pipeline: randomUUID(), company: randomUUID(), secondCompany: randomUUID(),
      contact: "ffffffff-ffff-4fff-bfff-ffffffffffff", privateCompany: randomUUID(), privateContact: randomUUID(), archivedContact: randomUUID(), privateProject: randomUUID(),
      readActor: randomUUID(), customerWorkspace: randomUUID(), customerActor: randomUUID() };
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Website Sales Ireland','Website','WEB_DESIGN')", [ids.project, first.workspaceId]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division,data_classification) values($1,$2,'Private project must stay hidden','Website','WEB_DESIGN','PRIVATE_FRANZ')", [ids.privateProject, first.workspaceId]);
    await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'workbench-test','Canonical website pipeline','novalure_internal',true)", [ids.pipeline, first.workspaceId, ids.project]);
    await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'qualify','Qualifizieren',0,'work')", [ids.pipeline, first.workspaceId, ids.project]);
    await db.admin.query("update projects set default_pipeline_id=$2 where id=$1", [ids.project, ids.pipeline]);
    for (const [id, name] of [[ids.company, "Canonical Irish Company"], [ids.secondCompany, "Second Irish Company"]]) {
      await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,domain,city) values($1,$2,$3,$4,'Unternehmen','company.example','Dublin')", [id, first.workspaceId, ids.project, name]);
    }
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,data_classification) values($1,$2,$3,'Private company must stay hidden','Unternehmen','PRIVATE_FRANZ')", [ids.privateCompany, first.workspaceId, ids.project]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'Canonical website contact','Ansprechpartner','canonical@example.invalid')", [ids.contact, first.workspaceId, ids.project, ids.company]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,$2,$3,'List contact '||n,'Ansprechpartner','contact-'||n||'@example.invalid' from generate_series(1,55)n", [first.workspaceId, ids.project, ids.company]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,data_classification) values($1,$2,$3,$4,'Private contact must stay hidden','Ansprechpartner','PRIVATE_FRANZ')", [ids.privateContact, first.workspaceId, ids.project, ids.company]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,archived_at,archived_by_user_id) values($1,$2,$3,$4,'Archived contact must stay hidden','Ansprechpartner',now(),$5)", [ids.archivedContact, first.workspaceId, ids.project, ids.company, first.userId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Read-only scoped operator','read-workbench@example.invalid','agent','novalureServiceOps')", [ids.readActor, first.workspaceId]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [first.workspaceId, ids.project, ids.readActor]);
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Customer workspace','self_service_customer','property_developer')", [ids.customerWorkspace]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Customer owner','customer-workbench@example.invalid','owner','customer_owner')", [ids.customerActor, ids.customerWorkspace]);
    const session: AppSession = { authenticated: true, source: "database", userId: first.userId, workspaceId: first.workspaceId, workspaceName: "Synthetic workbench", name: "Synthetic owner", email: first.email,
      role: "owner", productRole: "novalureAdmin", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("novalureAdmin") };
    const options = { pool: db.pool as unknown as TenantPool };
    const command = (operation: WebsiteSalesIrelandCommand["operation"], payload: Record<string, unknown>, extra: Partial<WebsiteSalesIrelandCommand> = {}): WebsiteSalesIrelandCommand => ({ contractVersion: websiteSalesIrelandContract, operation,
      projectId: ids.project, companyId: ids.company, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload, ...extra });
    const registered = [];
    for (let n = 1; n <= 3; n++) registered.push(await runWebsiteSalesIrelandCommand(session, command("register_location", { countryCode: "IE", address: `${n} Synthetic Street, Dublin, Ireland`, sourceUrl: "https://company.example/location", sourceReference: "Synthetic session-attested source" }), options));
    const locationId = registered[0].data.location.id;
    const identity = { workspaceId: first.workspaceId, projectId: ids.project, companyId: ids.company, locationId };
    const prospect = { identity, country: "IRELAND", identityStatus: "VERIFIED", domain: null, path: "NO_WEBSITE", ownWebsiteSearch: "NONE_FOUND", obstacle: null, platformUrl: null, bookingRoute: "UNKNOWN", need: "EVIDENCED",
      evidence: ["IDENTITY", "OWN_WEBSITE_SEARCH", "BUSINESS_NEED"].map(kind => ({ identity, evidenceId: kind, kind, sourceUrl: "https://company.example/about", observedAt: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), validityCondition: "Synthetic source current", finding: "Synthetic scoped evidence", confidence: 0.9 })) };
    const investmentPlan = { requestedStage: "DIAGNOSIS", completedStage: "NONE", estimatedCostMinor: 0, availableBudgetMinor: 0, expectedNetPriceMinor: null, estimatedDeliveryCostMinor: null, minimumMarginBasisPoints: 0, requiredCapacityMinutes: 1, availableCapacityMinutes: 1, rightsVerified: false, budgetReference: null };
    const observed = await runWebsiteSalesIrelandCommand(session, command("observe", { prospect, investmentPlan }, { locationId, locationVersion: 1 }), options);
    const qualified = await runWebsiteSalesIrelandCommand(session, command("qualify", { contactId: ids.contact, opportunitySummary: "Synthetic website opportunity", nextAction: "Review evidence", expectedEvidenceDigest: observed.data.workflow!.evidenceDigest }, { locationId, expectedVersion: 1 }), options);
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: randomBytes(48).toString("base64url"),
      NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    // Persisted synthetic MFA session tests actual session middleware; no browser-login claim.
    const cookie = "v2." + randomBytes(32).toString("base64url");
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",
      [randomUUID(), createHash("sha256").update(cookie).digest("hex"), first.authIdentityId, first.userId, first.workspaceId]);
    const request = (query: string, authenticated = true) => new Request(origin + websiteSalesWorkbenchPath + "?" + query, { headers: authenticated ? { cookie: "novalure_session=" + cookie } : {} });
    const route = async (query: string): Promise<WebsiteSalesWorkbenchResponse> => {
      const response = await GET(request(query)); assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return response.json();
    };
    const read = (query: WebsiteSalesWorkbenchQuery, actor = session) => readWebsiteSalesWorkbench(actor, query, options);
    async function snapshot() {
      const tables = ["projects", "organizations", "contacts", "leads", "deals", "tasks", "crm_company_locations", "crm_website_sales_observations", "crm_website_sales_workflows", "crm_command_receipts", "crm_domain_events", "crm_offers", "crm_offer_revisions", "crm_offer_deliveries"];
      return Promise.all(tables.map(async table => ({ table, value: (await db.admin.query(`select md5(coalesce(string_agg(to_jsonb(t)::text,',' order by t.id),'')) as hash from ${table} t where workspace_id=$1`, [first.workspaceId])).rows[0].hash })));
    }

    await t.test("actual authenticated route discovers only eligible canonical projects and companies without business changes", async () => {
      const before = await snapshot();
      const projects = await route("view=projects"); assert.equal(projects.contractVersion, websiteSalesWorkbenchContract); assert.equal(projects.source, "database"); assert.equal(projects.workspaceId, first.workspaceId); assert.equal(projects.canContact, false);
      assert.equal(projects.view, "projects"); if (projects.view !== "projects") return;
      assert.deepEqual(projects.items.map(row => row.id), [ids.project]); assert.equal(projects.items[0].pipelineConfigured, true); assert.equal(projects.items[0].canWrite, true);
      const companies = await route(`view=companies&projectId=${ids.project}`); assert.equal(companies.view, "companies"); if (companies.view !== "companies") return;
      assert.deepEqual(new Set(companies.items.map(row => row.id)), new Set([ids.company, ids.secondCompany])); assert.equal(companies.canWrite, true);
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("cursor pagination is complete, bounded and duplicate-free; search remains a literal scoped name filter", async () => {
      const idsSeen = new Set<string>(); let cursor: string | undefined;
      do {
        const result = await read({ view: "contacts", projectId: ids.project, companyId: ids.company, cursor, limit: 20 });
        assert.equal(result.view, "contacts"); if (result.view !== "contacts") return;
        assert.ok(result.items.length <= 20);
        for (const row of result.items) { assert.equal(idsSeen.has(row.id), false); idsSeen.add(row.id); }
        cursor = result.page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(idsSeen.size, 56); assert.equal(idsSeen.has(ids.privateContact), false); assert.equal(idsSeen.has(ids.archivedContact), false);
      const defaultPage = await route(`view=contacts&projectId=${ids.project}&companyId=${ids.company}`);
      assert.equal(defaultPage.view, "contacts"); if (defaultPage.view !== "contacts") return;
      assert.equal(defaultPage.items.length, 25); assert.equal(defaultPage.page.hasMore, true); assert.equal(defaultPage.items.some(row => row.id === ids.contact), false);
      const searched = await read({ view: "contacts", projectId: ids.project, companyId: ids.company, q: "Canonical website", limit: 50 });
      assert.equal(searched.view, "contacts"); if (searched.view === "contacts") assert.deepEqual(searched.items.map(row => row.id), [ids.contact]);
      const literal = await read({ view: "companies", projectId: ids.project, q: "%' OR true --" });
      assert.equal(literal.view, "companies"); if (literal.view === "companies") assert.equal(literal.items.length, 0);
    });
    await t.test("location list reports stored status while detail reloads exact saved input, plan and canonical contact outside the first page", async () => {
      const before = await snapshot();
      const listed = await route(`view=locations&projectId=${ids.project}&companyId=${ids.company}&limit=2`);
      assert.equal(listed.view, "locations"); if (listed.view !== "locations") return;
      assert.equal(listed.items.length, 2); assert.equal(listed.page.hasMore, true);
      const full = await read({ view: "locations", projectId: ids.project, companyId: ids.company });
      assert.equal(full.view, "locations"); if (full.view !== "locations") return;
      const stored = full.items.find(row => row.id === locationId)!.workflow!;
      assert.equal(stored.status, "QUALIFIED"); assert.equal(stored.statusKind, "stored"); assert.equal(stored.contactId, ids.contact); assert.equal("qualificationStatus" in stored, false);
      const detail = await route(`view=detail&projectId=${ids.project}&companyId=${ids.company}&locationId=${locationId}`);
      assert.equal(detail.view, "detail"); if (detail.view !== "detail") return;
      assert.equal(detail.workflow!.id, qualified.data.workflow!.id); assert.equal(detail.workflow!.blockedReason, null); assert.equal(detail.workflow!.canContact, false);
      assert.deepEqual(detail.observation!.prospect, prospect); assert.deepEqual(detail.observation!.investmentPlan, investmentPlan);
      assert.equal(detail.observation!.evidenceDigest, detail.workflow!.evidenceDigest); assert.equal(detail.contact!.id, ids.contact); assert.equal(detail.contact!.email, "canonical@example.invalid");
      assert.equal(detail.location.registrationBasis, "SESSION_ATTESTED"); assert.deepEqual(await snapshot(), before);
    });
    await t.test("current opt-out is reflected in detail without changing the stored workflow or creating a stop command", async () => {
      await db.admin.query("update contacts set consent_label='Abgemeldet' where id=$1", [ids.contact]);
      const before = await snapshot();
      const detail = await read({ view: "detail", projectId: ids.project, companyId: ids.company, locationId });
      assert.equal(detail.view, "detail"); if (detail.view !== "detail") return;
      assert.equal(detail.workflow!.status, "QUALIFIED"); assert.equal(detail.workflow!.blockedReason, "OPT_OUT"); assert.equal(detail.canContact, false);
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("fresh effective capabilities and explicit project grants govern read access, including grant revocation", async () => {
      const scoped = { ...session, userId: ids.readActor };
      const result = await read({ view: "companies", projectId: ids.project }, scoped);
      assert.equal(result.canWrite, false, "Caller-supplied owner role cannot override persisted read-only membership");
      await db.admin.query("update project_pipeline_permissions set can_read=false where user_id=$1 and project_id=$2", [ids.readActor, ids.project]);
      await assert.rejects(read({ view: "companies", projectId: ids.project }, scoped), { code: "PROJECT_FORBIDDEN" });
      const hidden = await read({ view: "projects" }, scoped); assert.equal(hidden.view, "projects"); if (hidden.view === "projects") assert.equal(hidden.items.length, 0);
    });
    await t.test("foreign, private, customer, machine and unauthenticated reads fail closed", async () => {
      assert.equal((await GET(request("view=projects", false))).status, 401);
      for (const query of [`view=companies&projectId=${foreign.projectId}`, `view=contacts&projectId=${ids.project}&companyId=${ids.privateCompany}`,
        `view=detail&projectId=${ids.project}&companyId=${ids.secondCompany}&locationId=${locationId}`]) assert.equal((await GET(request(query))).status, 403);
      await assert.rejects(read({ view: "projects" }, { ...session, workspaceId: ids.customerWorkspace, userId: ids.customerActor, productRole: "customer_owner" }), { code: "WORKBENCH_SCOPE_DENIED" });
      await assert.rejects(read({ view: "projects" }, { ...session, serviceIdentity: { identityId: randomUUID(), role: "Evelyn.Service", consumer: "EVELYN", environment: "production", jtiHash: "0".repeat(64) } }), { code: "SESSION_REQUIRED" });
    });
    await t.test("authorized cross-workspace membership retains the mandatory existing security audit without business writes", async () => {
      assert.equal((await GET(request(`view=projects&workspaceId=${foreign.workspaceId}`))).status, 403);
      await db.admin.query("insert into workspace_users(workspace_id,name,email,role,product_role,status) values($1,'Explicit synthetic shared membership',$2,'owner','novalureAdmin','active')", [foreign.workspaceId, first.email]);
      const before = await snapshot();
      const auditBefore = Number((await db.admin.query("select count(*) from audit_logs where workspace_id=$1 and action='workspace.cross_workspace_view'", [foreign.workspaceId])).rows[0].count);
      const result = await route(`view=projects&workspaceId=${foreign.workspaceId}`);
      assert.equal(result.workspaceId, foreign.workspaceId);
      assert.equal(Number((await db.admin.query("select count(*) from audit_logs where workspace_id=$1 and action='workspace.cross_workspace_view'", [foreign.workspaceId])).rows[0].count), auditBefore + 1);
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("invalid, duplicate and cross-view parameters never broaden the query", async () => {
      for (const query of ["view=projects&limit=51", "view=projects&limit=0", "view=projects&limit=1.5", "view=projects&view=companies", "view=unknown", "view=projects&cursor=not-a-uuid",
        `view=detail&projectId=${ids.project}&companyId=${ids.company}&locationId=${locationId}&limit=25`, "view=projects&unsafe=1"]) {
        assert.throws(() => parseWebsiteSalesWorkbenchQuery(new URLSearchParams(query)));
        assert.equal((await GET(request(query))).status, 400);
      }
    });
  } finally {
    await closeLocalTestPool();
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await db.stop();
  }
});
