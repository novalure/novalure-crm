import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { getWebsiteSalesIrelandWorkflow, runWebsiteSalesIrelandCommand, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand } from "../src/lib/db/website-sales-ireland-repositories";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

test("Website Sales Ireland uses canonical CRM rows, durable evidence, scoped transactions and draft-only effects", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("begin");
    await db.admin.query(await readFile("migrations/202_website_sales_ireland.sql", "utf8"));
    await db.admin.query("commit");
    const ids = { workspace: randomUUID(), otherWorkspace: randomUUID(), actor: randomUUID(), otherActor: randomUUID(), project: randomUUID(), otherProject: randomUUID(), company: randomUUID(), otherCompany: randomUUID(), contact: randomUUID(), pipeline: randomUUID(), qualifiedStage: randomUUID() };
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Synthetic internal Sales','novalure_internal','novalure_internal'),($2,'Other internal tenant','novalure_internal','novalure_internal')", [ids.workspace, ids.otherWorkspace]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Synthetic Sales','sales@example.invalid','agent','novalure_sales'),($3,$4,'Other Sales','other@example.invalid','agent','novalure_sales')", [ids.actor, ids.workspace, ids.otherActor, ids.otherWorkspace]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Ireland website sales','Website','WEB_DESIGN'),($3,$4,'Other tenant sales','Website','WEB_DESIGN')", [ids.project, ids.workspace, ids.otherProject, ids.otherWorkspace]);
    await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'website-ireland-test','Existing website pipeline','novalure_internal',true)", [ids.pipeline, ids.workspace, ids.project]);
    await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'request','Research intake',0,'work')", [ids.pipeline, ids.workspace, ids.project]);
    await db.admin.query("insert into crm_pipeline_stages(id,pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,$4,'qualify','Custom research qualification',1,'work')", [ids.qualifiedStage, ids.pipeline, ids.workspace, ids.project]);
    await db.admin.query("update projects set default_pipeline_id=$2 where id=$1", [ids.project, ids.pipeline]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'Synthetic Irish company','Unternehmen','WEB_DESIGN'),($4,$5,$6,'Other company','Unternehmen','WEB_DESIGN')", [ids.company, ids.workspace, ids.project, ids.otherCompany, ids.otherWorkspace, ids.otherProject]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'Existing synthetic contact','Ansprechpartner','existing@example.invalid')", [ids.contact, ids.workspace, ids.project, ids.company]);
    const session: AppSession = { authenticated: true, source: "database", workspaceId: ids.workspace, userId: ids.actor, workspaceName: "Synthetic Sales", name: "Synthetic Sales", email: "sales@example.invalid", role: "agent", productRole: "novalure_sales", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_sales") };
    const otherSession: AppSession = { ...session, workspaceId: ids.otherWorkspace, userId: ids.otherActor };
    const options = { pool: db.pool as unknown as TenantPool };
    const command = (operation: WebsiteSalesIrelandCommand["operation"], payload: Record<string, unknown>, fields: Partial<WebsiteSalesIrelandCommand> = {}): WebsiteSalesIrelandCommand => ({ contractVersion: websiteSalesIrelandContract, operation, projectId: ids.project, companyId: ids.company, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload, ...fields });
    const run = (input: WebsiteSalesIrelandCommand, actor = session) => runWebsiteSalesIrelandCommand(actor, input, options);
    const register = (address = `${randomUUID()} Test Street, Dublin, Ireland`) => run(command("register_location", { countryCode: "IE", address, sourceUrl: "https://example.invalid/company/location", sourceReference: "Synthetic registered company location; no external verification asserted" }));
    const prospect = (locationId: string, end = new Date(Date.now() + 86400000).toISOString()) => {
      const identity = { workspaceId: ids.workspace, projectId: ids.project, companyId: ids.company, locationId };
      return { identity, country: "IRELAND", identityStatus: "VERIFIED", domain: null, path: "NO_WEBSITE", ownWebsiteSearch: "NONE_FOUND", obstacle: null, platformUrl: null, bookingRoute: "UNKNOWN", need: "EVIDENCED", evidence: ["IDENTITY", "OWN_WEBSITE_SEARCH", "BUSINESS_NEED"].map(kind => ({ evidenceId: kind.toLowerCase(), identity, kind, sourceUrl: "https://example.invalid/evidence/" + kind, observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: end, validityCondition: "Synthetic source remains current", finding: "Synthetic scoped source fact", confidence: 0.9 })) };
    };
    const observed = async () => {
      const registered = await register();
      const locationId = registered.data.location.id;
      const request = command("observe", { prospect: prospect(locationId) }, { locationId, locationVersion: 1 });
      const result = await run(request);
      return { registered, locationId, request, result, row: result.data.workflow! };
    };
    const qualified = async () => {
      const data = await observed();
      const request = command("qualify", { contactId: ids.contact, opportunitySummary: "Synthetic website acquisition opportunity", nextAction: "Review evidence internally", expectedEvidenceDigest: data.row.evidenceDigest }, { locationId: data.locationId, expectedVersion: data.row.version });
      const result = await run(request);
      return { ...data, qualifyRequest: request, result, row: result.data.workflow! };
    };
    const offerContent = () => ({ subject: "Website proposal draft", recipientName: "Existing synthetic contact", recipientEmail: "existing@example.invalid", scope: "Website diagnosis and design", paymentPlan: "For owner review", discounts: "None", specialTerms: "Draft only", riskComplianceNotes: "No contact authority granted", terms: "Subject to owner approval", validUntil: new Date(Date.now() + 86400000).toISOString(), currency: "EUR", taxBasis: "NET", items: [{ description: "Website project", quantity: 1, unitNetCents: 250000 }] });

    await t.test("registered branch identity is durable, deduplicated by company/address and independent of domain", async () => {
      const first = await register("1 Test Street, Dublin, Ireland");
      const same = await register(" 1   Test Street, Dublin, Ireland ");
      const branch = await register("2 Test Street, Cork, Ireland");
      assert.equal(first.data.location.id, same.data.location.id);
      assert.notEqual(first.data.location.id, branch.data.location.id);
      assert.equal(first.data.location.workspaceId, ids.workspace);
      assert.equal(first.data.location.companyId, ids.company);
    });
    await t.test("receipt replay and changed payload conflict, stale CAS and foreign evidence fail closed", async () => {
      const data = await observed();
      assert.equal((await run(data.request)).replayed, true);
      await assert.rejects(run({ ...data.request, payload: { prospect: { ...(data.request.payload.prospect as object), need: "NOT_ESTABLISHED" } } }), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(run(command("observe", data.request.payload, { locationId: data.locationId, locationVersion: 1, expectedVersion: 99 })), { code: "VERSION_OR_STATE_CONFLICT" });
      const foreign = prospect(data.locationId);
      foreign.identity.workspaceId = ids.otherWorkspace;
      await assert.rejects(run(command("observe", { prospect: foreign }, { locationId: data.locationId, locationVersion: 1, expectedVersion: data.row.version })), { code: "PROSPECT_SCOPE_DENIED" });
    });
    await t.test("actual lead/deal/task and existing canonical offer draft commit together with audit and no outbound", async () => {
      const data = await qualified();
      assert.equal(data.row.status, "QUALIFIED");
      const reply = await run(command("prepare_offer", { content: offerContent(), expectedEvidenceDigest: data.row.evidenceDigest }, { locationId: data.locationId, expectedVersion: data.row.version }));
      assert.equal(reply.data.workflow?.status, "OFFER_DRAFT");
      const rows = await db.admin.query(`select l.contact_id,d.organization_id,d.stage,d.metadata,t.lead_id,o.status,o.approval_id,
        (select count(*)::int from crm_offer_deliveries where workspace_id=$1) as deliveries
        from leads l join deals d on d.lead_id=l.id join tasks t on t.lead_id=l.id join crm_offers o on o.deal_id=d.id where l.id=$2`, [ids.workspace, data.row.leadId]);
      assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].contact_id, ids.contact); assert.equal(rows.rows[0].organization_id, ids.company);
      assert.equal(rows.rows[0].status, "DRAFT"); assert.equal(rows.rows[0].approval_id, null); assert.equal(rows.rows[0].deliveries, 0);
      assert.equal(rows.rows[0].stage, "Custom research qualification");
      assert.deepEqual(rows.rows[0].metadata.websiteSalesPipeline, { pipelineId: ids.pipeline, stageId: ids.qualifiedStage, stageName: "Custom research qualification" });
      assert.equal(reply.data.workflow?.canContact, false);
      assert.equal(Number((await db.admin.query("select count(*) from audit_logs where id=$1", [reply.auditReference])).rows[0].count), 1);
    });
    await t.test("concurrent distinct qualification requests persist one canonical chain", async () => {
      const data = await observed();
      const make = () => command("qualify", { contactId: ids.contact, opportunitySummary: "Concurrent opportunity", nextAction: "Review internally", expectedEvidenceDigest: data.row.evidenceDigest }, { locationId: data.locationId, expectedVersion: data.row.version });
      const results = await Promise.allSettled([run(make()), run(make())]);
      assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
      assert.equal(Number((await db.admin.query("select count(*) from leads where metadata->>'websiteSalesWorkflowId'=$1", [data.row.id])).rows[0].count), 1);
    });
    await t.test("missing configured project pipeline rejects qualification without creating hidden deals", async () => {
      const data = await observed();
      await db.admin.query("update projects set default_pipeline_id=null where id=$1", [ids.project]);
      try {
        await assert.rejects(run(command("qualify", { contactId: ids.contact, opportunitySummary: "No pipeline attempt", nextAction: "No hidden deal", expectedEvidenceDigest: data.row.evidenceDigest }, { locationId: data.locationId, expectedVersion: 1 })), { code: "PROJECT_PIPELINE_REQUIRED" });
      } finally { await db.admin.query("update projects set default_pipeline_id=$2 where id=$1", [ids.project, ids.pipeline]); }
      assert.equal(Number((await db.admin.query("select count(*) from deals where metadata->>'websiteSalesWorkflowId'=$1", [data.row.id])).rows[0].count), 0);
    });
    await t.test("concurrent drafts at two locations preserve the canonical offer lock order", async () => {
      const branches = await Promise.all([qualified(), qualified()]);
      let reached = 0;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const controlledPool = { connect: async () => {
        const connection = await db.pool.connect();
        return {
          release: connection.release.bind(connection),
          query: (...args: unknown[]) => {
            const result: unknown = Reflect.apply(connection.query, connection, args);
            if (!(result instanceof Promise) || typeof args[0] !== "string" || !args[0].includes("select o.name from organizations o")) return result;
            return result.then(async value => {
              reached++;
              if (reached === 2) release();
              await barrier;
              return value;
            });
          },
        };
      } } as unknown as TenantPool;
      const results = await Promise.allSettled(branches.map(branch => runWebsiteSalesIrelandCommand(session,
        command("prepare_offer", { content: offerContent(), expectedEvidenceDigest: branch.row.evidenceDigest }, { locationId: branch.locationId, expectedVersion: branch.row.version }), { pool: controlledPool })));
      assert.equal(results.filter(result => result.status === "fulfilled").length, 2, "Both independent branch drafts must commit without an organization-lock upgrade deadlock");
    });
    await t.test("server recomputes unclear and stale qualification; caller cannot force READY or stale digest", async () => {
      const registered = await register();
      const locationId = registered.data.location.id;
      const old = prospect(locationId, new Date(Date.now() - 1000).toISOString());
      const saved = await run(command("observe", { prospect: old }, { locationId, locationVersion: 1 }));
      assert.equal(saved.data.workflow?.qualificationStatus, "NEEDS_CLARIFICATION");
      await assert.rejects(run(command("qualify", { contactId: ids.contact, opportunitySummary: "Invalid stale attempt", nextAction: "No effect", expectedEvidenceDigest: saved.data.workflow!.evidenceDigest }, { locationId, expectedVersion: 1 })), { code: "CURRENT_EVIDENCE_REQUIRED" });
      const fresh = await observed();
      await assert.rejects(run(command("qualify", { contactId: ids.contact, opportunitySummary: "Changed digest attempt", nextAction: "No effect", expectedEvidenceDigest: "0".repeat(64) }, { locationId: fresh.locationId, expectedVersion: 1 })), { code: "CURRENT_EVIDENCE_REQUIRED" });
    });
    await t.test("contact and tenant scope checks precede writes and stored receipt disclosure", async () => {
      const data = await observed();
      await assert.rejects(run(data.request, otherSession), { code: "PROJECT_FORBIDDEN" });
      await assert.rejects(getWebsiteSalesIrelandWorkflow(otherSession, { projectId: ids.project, companyId: ids.company, locationId: data.locationId }, options), { code: "PROJECT_FORBIDDEN" });
      await assert.rejects(run(command("qualify", { contactId: randomUUID(), opportunitySummary: "Foreign contact", nextAction: "No effect", expectedEvidenceDigest: data.row.evidenceDigest }, { locationId: data.locationId, expectedVersion: 1 })), { code: "CONTACT_SCOPE_DENIED" });
      await assert.rejects(run(data.request, { ...session, serviceIdentity: { identityId: randomUUID(), role: "Evelyn.Service", consumer: "EVELYN", environment: "production", jtiHash: "0".repeat(64) } }), { code: "SESSION_REQUIRED" });
    });
    await t.test("injected audit failure rolls back every business write and permits same-key retry", async () => {
      const data = await observed();
      const input = command("qualify", { contactId: ids.contact, opportunitySummary: "Atomic opportunity", nextAction: "Review internally", expectedEvidenceDigest: data.row.evidenceDigest }, { locationId: data.locationId, expectedVersion: 1 });
      await db.admin.query("create function website_sales_test_abort() returns trigger language plpgsql as $$begin if new.action='website_sales.ireland.qualify' then raise exception 'synthetic audit failure';end if;return new;end$$;create trigger website_sales_test_abort before insert on audit_logs for each row execute function website_sales_test_abort()");
      try { await assert.rejects(run(input), /synthetic audit failure/); }
      finally { await db.admin.query("drop trigger website_sales_test_abort on audit_logs;drop function website_sales_test_abort()"); }
      assert.equal(Number((await db.admin.query("select count(*) from leads where metadata->>'websiteSalesWorkflowId'=$1", [data.row.id])).rows[0].count), 0);
      assert.equal((await run(input)).data.workflow?.status, "QUALIFIED");
    });
    await t.test("investment decision is persisted and never authorizes spend", async () => {
      const registered = await register(); const locationId = registered.data.location.id;
      const saved = await run(command("observe", { prospect: prospect(locationId), investmentPlan: { requestedStage: "DEMO", completedStage: "NONE", completedStageEvidence: null, estimatedCostMinor: 500, availableBudgetMinor: 0, expectedNetPriceMinor: null, estimatedDeliveryCostMinor: null, minimumMarginBasisPoints: 3000, requiredCapacityMinutes: 60, availableCapacityMinutes: 0, rightsVerified: false, budgetReference: null } }, { locationId, locationVersion: 1 }));
      assert.equal(saved.data.workflow?.investmentDecision?.stage, "DIAGNOSIS");
      assert.equal(saved.data.workflow?.investmentDecision?.spendAuthorized, false);
      const row = (await db.admin.query("select investment_plan,investment_decision from crm_website_sales_observations where location_id=$1", [locationId])).rows[0];
      assert.equal(row.investment_plan.requestedStage, "DEMO"); assert.equal(row.investment_decision.externalEffectAllowed, false);
    });
    await t.test("canonical incoming reply blocks a draft without exposing conversation content", async () => {
      const replyContact = randomUUID();
      await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'Reply test contact','Ansprechpartner','reply@example.invalid')", [replyContact, ids.workspace, ids.project, ids.company]);
      const data = await observed();
      const first = await run(command("qualify", { contactId: replyContact, opportunitySummary: "Reply test opportunity", nextAction: "Review internally", expectedEvidenceDigest: data.row.evidenceDigest }, { locationId: data.locationId, expectedVersion: 1 }));
      await db.admin.query("insert into conversations(workspace_id,project_id,contact_id,channel,direction,summary) values($1,$2,$3,'E-Mail','inbound','Private incoming content must not appear in the projection')", [ids.workspace, ids.project, replyContact]);
      const snapshot = await getWebsiteSalesIrelandWorkflow(session, { projectId: ids.project, companyId: ids.company, locationId: data.locationId }, options);
      assert.equal(snapshot.workflow?.blockedReason, "REPLY_RECEIVED");
      assert.equal(JSON.stringify(snapshot).includes("Private incoming content"), false);
      await assert.rejects(run(command("prepare_offer", { content: offerContent(), expectedEvidenceDigest: first.data.workflow!.evidenceDigest }, { locationId: data.locationId, expectedVersion: first.data.workflow!.version })), { code: "REPLY_RECEIVED" });
      const stop = await run(command("stop", { reason: "REPLY_RECEIVED", sourceReference: "Recorded inbound CRM reply" }, { locationId: data.locationId, expectedVersion: first.data.workflow!.version }));
      assert.equal(stop.data.workflow?.status, "STOPPED");
    });
    await t.test("reply stop is terminal, closes task, and old receipt returns current stopped state", async () => {
      const data = await qualified();
      const stopped = await run(command("stop", { reason: "REPLY_RECEIVED", sourceReference: "Synthetic actual reply recorded" }, { locationId: data.locationId, expectedVersion: data.row.version }));
      assert.equal(stopped.data.workflow?.status, "STOPPED");
      assert.equal((await run(data.qualifyRequest)).data.workflow?.status, "STOPPED");
      assert.equal((await db.admin.query("select status from tasks where id=$1", [data.row.nextTaskId])).rows[0].status, "done");
      await assert.rejects(run(command("observe", { prospect: prospect(data.locationId) }, { locationId: data.locationId, locationVersion: 1, expectedVersion: stopped.data.workflow!.version })), { code: "WORKFLOW_STOPPED" });
    });
    await t.test("explicit opt-out blocks the same contact at another company location", async () => {
      // A fresh contact avoids treating the preceding reply as renewed acquisition interest.
      const freshContact = randomUUID();
      await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'Separate consent test','Ansprechpartner','consent@example.invalid')", [freshContact, ids.workspace, ids.project, ids.company]);
      const data = await observed();
      const first = await run(command("qualify", { contactId: freshContact, opportunitySummary: "Consent opportunity", nextAction: "Review internally", expectedEvidenceDigest: data.row.evidenceDigest }, { locationId: data.locationId, expectedVersion: 1 }));
      await run(command("stop", { reason: "OPT_OUT", sourceReference: "Synthetic opt-out" }, { locationId: data.locationId, expectedVersion: first.data.workflow!.version }));
      const other = await observed();
      await assert.rejects(run(command("qualify", { contactId: freshContact, opportunitySummary: "No reactivation", nextAction: "No effect", expectedEvidenceDigest: other.row.evidenceDigest }, { locationId: other.locationId, expectedVersion: 1 })), { code: "OPT_OUT" });
    });
    await t.test("new tables force RLS and have no public or destructive runtime access", async () => {
      const rows = await db.admin.query("select c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege($1,c.oid,'DELETE') as can_delete,has_table_privilege($1,c.oid,'TRUNCATE') as can_truncate from pg_class c where c.relname=any($2::text[])", [db.role, ["crm_company_locations", "crm_website_sales_observations", "crm_website_sales_workflows"]]);
      assert.equal(rows.rows.length, 3);
      for (const row of rows.rows) { assert.equal(row.relrowsecurity, true); assert.equal(row.relforcerowsecurity, true); assert.equal(row.can_delete, false); assert.equal(row.can_truncate, false); }
      const scope = await db.pool.connect();
      try {
        await scope.query("begin");
        await assert.rejects(scope.query("select summary from conversations"), { code: "42501" });
        await scope.query("rollback");
        await scope.query("begin");
        await scope.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [ids.workspace, ids.actor]);
        await assert.rejects(scope.query("select crm_website_sales_has_reply($1,$2,$3,now())", [ids.otherWorkspace, ids.otherProject, ids.contact]), { code: "42501" });
        await scope.query("rollback");
      } finally { scope.release(); }
    });
  } finally { await db.stop(); }
});
