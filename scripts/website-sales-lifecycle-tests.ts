import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { executeOfferCommand } from "../src/lib/db/offer-repositories";
import { runWebsiteSalesIrelandCommand, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand } from "../src/lib/db/website-sales-ireland-repositories";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { withCrmRead } from "../src/lib/crm-command";
import { executeWebsiteSalesLifecycleCommand as execute, readWebsiteSalesLifecycle as read, reconcileWebsiteSalesLifecycleCommand as reconcile } from "../src/lib/db/website-sales-lifecycle-repositories";
import { websiteSalesLifecycleContract, type WebsiteSalesLifecycleCommand } from "../src/lib/website-sales-lifecycle-types";

test("Website Sales lifecycle refreshes canonical records and processes owner-authorized canonical replies", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("begin");
    await db.admin.query(await readFile("migrations/202_website_sales_ireland.sql", "utf8"));
    await db.admin.query("commit");
    for (const file of ["170_crm_personal_mailbox.sql", "203_website_sales_machine.sql", "204_website_sales_studio.sql", "205_website_sales_lifecycle.sql"]) {
      await db.admin.query("begin");
      try { await db.admin.query(await readFile(`migrations/${file}`, "utf8")); await db.admin.query("commit"); }
      catch (error) { await db.admin.query("rollback"); throw error; }
    }
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
    const data = await qualified(), scope = { projectId: ids.project, companyId: ids.company, locationId: data.locationId };
    let current = data.row;
    const lifecycle = (operation: WebsiteSalesLifecycleCommand["operation"], payload: Record<string, unknown>): WebsiteSalesLifecycleCommand => ({ contractVersion: websiteSalesLifecycleContract,
      operation, ...scope, expectedVersion: current.version, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload });
    const counts = async () => (await db.admin.query("select (select count(*) from leads)::int as leads,(select count(*) from deals)::int as deals,(select count(*) from tasks)::int as tasks,(select count(*) from crm_offers)::int as offers,(select count(*) from crm_offer_deliveries)::int as deliveries")).rows[0];
    let refresh: WebsiteSalesLifecycleCommand;
    await t.test("newer evidence invalidates the old DRAFT permanently and canonical offer actions enforce it", async () => {
      const draft = await run(command("prepare_offer", { content: offerContent(), expectedEvidenceDigest: current.evidenceDigest }, { locationId: scope.locationId, expectedVersion: current.version }));
      current = draft.data.workflow!;
      const old = (await db.admin.query("select id,version,revision from crm_offers where id=$1", [current.offerDraftId])).rows[0];
      const before = await counts(), nextProspect = prospect(scope.locationId);
      nextProspect.evidence = nextProspect.evidence.map(e => ({ ...e, observedAt: new Date(Date.now()-1000).toISOString(), finding: "New synthetic source inspection" }));
      refresh = lifecycle("refresh_evidence", { prospect: nextProspect, locationVersion: 1 });
      const result = await execute(session, refresh, options); current = result.data.workflow;
      assert.equal(current.status, "QUALIFIED"); assert.equal(current.leadId, data.row.leadId); assert.equal(current.dealId, data.row.dealId); assert.equal(current.nextTaskId, data.row.nextTaskId);
      assert.deepEqual(await counts(), before);
      const canonical = (operation: "approve" | "revise") => executeOfferCommand(session, { operation, projectId: ids.project, offerId: old.id, expectedVersion: Number(old.version), idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: operation === "revise" ? { content: offerContent() } : {} }, options);
      await assert.rejects(canonical("approve"), { code: "OFFER_EVIDENCE_INVALIDATED" });
      await assert.rejects(canonical("revise"), { code: "OFFER_EVIDENCE_INVALIDATED" });
      const renewed = await run(command("prepare_offer", { content: offerContent(), expectedEvidenceDigest: current.evidenceDigest }, { locationId: scope.locationId, expectedVersion: current.version }));
      current = renewed.data.workflow!; assert.equal(current.offerDraftId, old.id); assert.equal(current.status, "OFFER_DRAFT");
      assert.equal(Number((await db.admin.query("select revision from crm_offers where id=$1", [old.id])).rows[0].revision), 2);
      assert.equal((await db.admin.query("select count(*) from crm_website_sales_offer_invalidations where offer_id=$1 and revision=1", [old.id])).rows[0].count, "1");
      assert.deepEqual(await counts(), before);
    });
    await t.test("refresh replay returns current state; changed body, stale CAS and foreign scope cannot create another chain", async () => {
      assert.equal((await execute(session, refresh, options)).data.workflow.version, current.version);
      await assert.rejects(execute(session, { ...refresh, payload: { ...refresh.payload, locationVersion: 2 } }, options), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(execute(session, { ...refresh, idempotencyKey: randomUUID() }, options), { code: "VERSION_CONFLICT" });
      await assert.rejects(execute(otherSession, refresh, options), { code: "PROJECT_FORBIDDEN" });
      const before = await counts(), receipt = await reconcile(session, refresh, options); assert.equal(receipt.status, "COMMITTED");
      if (receipt.status === "COMMITTED") assert.equal(receipt.currentData.workflow.version, current.version);
      assert.deepEqual(await counts(), before);
    });
    const messageId = randomUUID(), connectionId = randomUUID();
    await t.test("real canonical message association exposes no private body and requires the personal owner's explicit bounded consent", async () => {
      await withCrmRead(session, async tx => {
        await tx.execute("insert into crm_mailbox_connections(id,workspace_id,user_id,provider,account_label,status,granted_scopes) values($1,$2,$3,'microsoft','SYNTHETIC local mailbox','disconnected','[]'::jsonb)", [connectionId, ids.workspace, ids.actor]);
        await tx.execute("insert into crm_mailbox_messages(id,workspace_id,user_id,connection_id,provider_id,subject,from_label,from_address,received_at,body_text,content_hash) values($1,$2,$3,$4,'synthetic-message-1','Synthetic reply','Existing contact','existing@example.invalid',now(),'Automatic reply: out of office. I am interested.','synthetic-source-hash')", [messageId, ids.workspace, ids.actor, connectionId]);
        await tx.execute("insert into crm_mailbox_links(workspace_id,user_id,message_id,project_id,lead_id,contact_id,confirmed_reply,review_reason) values($1,$2,$3,$4,$5,$6,true,'Synthetic personally reviewed canonical association')", [ids.workspace, ids.actor, messageId, ids.project, current.leadId, ids.contact]);
      }, options);
      let view = await read(session, scope, options); assert.equal(view.inboundCandidates[0]?.classification, "UNCLEAR");
      assert.ok(!JSON.stringify(view).includes("I am interested"));
      const allow = lifecycle("authorize_reply_classification", { canonicalMessageId: messageId, allowBoundedClassification: true });
      assert.ok((await execute(session, allow, options)).data.replyPermissionId);
      view = await read(session, scope, options); assert.equal(view.inboundCandidates[0]?.classification, "OUT_OF_OFFICE");
      await execute(session, lifecycle("authorize_reply_classification", { canonicalMessageId: messageId, allowBoundedClassification: false }), options);
      assert.equal((await read(session, scope, options)).inboundCandidates[0]?.classification, "UNCLEAR");
      await execute(session, lifecycle("authorize_reply_classification", { canonicalMessageId: messageId, allowBoundedClassification: true }), options);
    });
    await t.test("out-of-office stops the old sequence, closes its pending task and creates one internal timing-review task", async () => {
      const request = lifecycle("ingest_reply", { canonicalMessageId: messageId }), before = await counts();
      const result = await execute(session, request, options); current = result.data.workflow;
      assert.equal(result.data.classification, "OUT_OF_OFFICE"); assert.equal(current.status, "STOPPED"); assert.equal(current.stopReason, "REPLY_RECEIVED");
      assert.ok(result.data.nextTaskId); assert.equal((await counts()).tasks, before.tasks+1); assert.equal((await counts()).deliveries, 0);
      assert.equal((await db.admin.query("select status from tasks where id=$1", [data.row.nextTaskId])).rows[0].status, "done");
      assert.equal((await execute(session, request, options)).data.responseId, result.data.responseId);
      const again = await execute(session, lifecycle("ingest_reply", { canonicalMessageId: messageId }), options); assert.equal(again.data.responseId, result.data.responseId);
      assert.equal((await counts()).tasks, before.tasks+1);
    });
    await t.test("handoff requires stored customer attestation and scope-bound signed QA; foreign read and destructive writes fail", async () => {
      await assert.rejects(execute(session, lifecycle("create_handoff", { customerAcceptanceId: randomUUID() }), options), { code: "CURRENT_CUSTOMER_ACCEPTANCE_REQUIRED" });
      await assert.rejects(read(otherSession, scope, options), { code: "PROJECT_FORBIDDEN" });
      await assert.rejects(withCrmRead(session, tx => tx.execute("delete from crm_website_sales_inbound_events"), options), { code: "42501" });
      const forced = (await db.admin.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in('crm_website_sales_refreshes','crm_website_sales_offer_invalidations','crm_website_sales_reply_permissions','crm_website_sales_reply_revocations','crm_website_sales_inbound_events','crm_website_sales_customer_acceptances','crm_website_sales_handoffs')")).rows;
      assert.equal(forced.length, 7); assert.ok(forced.every(row => row.relrowsecurity && row.relforcerowsecurity));
    });
  } finally { await db.stop(); }
});
