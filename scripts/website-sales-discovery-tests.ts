import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { matchWebsiteSalesDiscovery, registerWebsiteSalesDiscovery } from "../src/lib/db/website-sales-discovery-repositories";
import { runWebsiteSalesIrelandCommand } from "../src/lib/db/website-sales-ireland-repositories";
import { websiteSalesDiscoveryContract as contractVersion, type WebsiteSalesDiscoveryCandidate, type WebsiteSalesDiscoveryRegister } from "../src/lib/website-sales-discovery";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

test("Discovery reuses canonical CRM companies, branches and contacts without a second sales pipeline", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("begin"); await db.admin.query(await readFile("migrations/202_website_sales_ireland.sql", "utf8")); await db.admin.query("commit");
    const workspace = randomUUID(), actor = randomUUID(), project = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Synthetic discovery','novalure_internal','novalure_internal')", [workspace]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Discovery actor','discovery@example.invalid','agent','novalure_sales')", [actor, workspace]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Ireland discovery','Website','WEB_DESIGN')", [project, workspace]);
    const session: AppSession = { authenticated: true, source: "database", workspaceId: workspace, userId: actor, workspaceName: "Synthetic", name: "Synthetic", email: "discovery@example.invalid",
      role: "agent", productRole: "novalure_sales", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_sales") };
    const options = { pool: db.pool as unknown as TenantPool };
    function candidate(companyName = "Synthetic Irish Co", address = "1 Test Street, Dublin, Ireland", email = "public@example.invalid"): WebsiteSalesDiscoveryCandidate {
      return { candidateId: randomUUID(), countryCode: "IE", companyName, address, locationLabel: address, domain: "shared.example",
        sourceReferences: [{ sourceId: "public-company", sourceUrl: "https://public.example/company", contentDigest: "a".repeat(64), quote: `${companyName}. ${address}. Public Contact ${email}. shared.example`,
          observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString() }],
        contacts: [{ name: "Public Contact", email, sourceReferenceId: "public-company" }] };
    }
    const match = (value: WebsiteSalesDiscoveryCandidate) => matchWebsiteSalesDiscovery(session, { contractVersion, operation: "match", projectId: project, candidate: value }, options);
    async function registration(value: WebsiteSalesDiscoveryCandidate): Promise<WebsiteSalesDiscoveryRegister> {
      const found = await match(value);
      return { contractVersion, operation: "register", projectId: project, candidate: value, expectedMatchDigest: found.matchDigest,
        decision: { companyId: found.companies.find(company => company.reasons.includes("EXACT_NORMALIZED_NAME"))?.companyId ?? null,
          locationId: found.identity?.locationId ?? null, contactId: found.contactId, createCompany: !found.companies.some(company => company.reasons.includes("EXACT_NORMALIZED_NAME")),
          createContact: !found.contactId, reviewed: true, reason: "Checked public company and location source against the canonical CRM" }, idempotencyKey: randomUUID(), correlationId: randomUUID() };
    }
    const run = (input: WebsiteSalesDiscoveryRegister) => registerWebsiteSalesDiscovery(session, input, options);
    let first: Awaited<ReturnType<typeof registration>>;
    let canonical: { companyId: string; locationId: string; contactId: string };
    await t.test("NEW creates exactly one company, location and contact with source-bound receipt; no lead/deal/task", async () => {
      const value = candidate(); assert.equal((await match(value)).status, "NEW"); first = await registration(value);
      const result = await run(first); assert.ok("data" in result); const data = result.data;
      assert.ok(data?.contactId); canonical = { ...data.identity, contactId: data.contactId };
      assert.equal(data.candidateDigest, (await match(value)).candidateDigest); assert.equal(data.canContact, false);
      const count = (await db.admin.query("select (select count(*)::int from organizations where project_id=$1) as companies,(select count(*)::int from contacts where project_id=$1) as contacts,(select count(*)::int from crm_company_locations where project_id=$1) as locations,(select count(*)::int from leads where project_id=$1) as leads,(select count(*)::int from deals where project_id=$1) as deals", [project])).rows[0];
      assert.deepEqual(count, { companies: 1, contacts: 1, locations: 1, leads: 0, deals: 0 });
    });
    await t.test("same canonical branch matches after reload, exact replay/reconcile preserve IDs", async () => {
      const found = await match(first!.candidate); assert.equal(found.status, "MATCH"); assert.equal(found.identity?.companyId, canonical.companyId); assert.equal(found.contactId, canonical.contactId);
      const replay = await run(first!); assert.ok("data" in replay); assert.equal(replay.replayed, true); assert.equal(replay.data.identity.locationId, canonical.locationId);
      const reconciled = await run({ ...first!, operation: "reconcile" }); assert.ok("status" in reconciled); assert.equal(reconciled.status, "COMMITTED");
      await assert.rejects(run({ ...first!, decision: { ...first!.decision, reason: "Different selected reason with same command identity" } }), { code: "IDEMPOTENCY_CONFLICT" });
    });
    await t.test("same company with another branch remains separate; shared domain never merges companies", async () => {
      const branch = candidate("Synthetic Irish Co", "2 Test Street, Cork, Ireland", "cork@example.invalid");
      const found = await match(branch); assert.equal(found.status, "NEW"); assert.equal(found.companies[0]?.companyId, canonical.companyId);
      const request = await registration(branch); const result = await run(request); assert.ok("data" in result); assert.equal(result.data.identity.companyId, canonical.companyId); assert.notEqual(result.data.identity.locationId, canonical.locationId);
      const franchise = candidate("Different Franchise Co", "3 Franchise Street, Cork, Ireland", "franchise@example.invalid");
      const shared = await match(franchise); assert.equal(shared.status, "AMBIGUOUS"); assert.equal(shared.identity, null);
      const review = await registration(franchise);
      await assert.rejects(run({ ...review, decision: { ...review.decision, reviewed: false } }), { code: "DISCOVERY_REVIEW_REQUIRED" });
      const registered = await run(review); assert.ok("data" in registered); assert.notEqual(registered.data.identity.companyId, canonical.companyId);
    });
    await t.test("concurrent new registrations re-match under lock and never duplicate the same company", async () => {
      const value = candidate("New Concurrent Co", "8 Race Street, Dublin, Ireland", "race@example.invalid"); value.domain = null;
      const a = await registration(value), b = { ...a, idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const settled = await Promise.allSettled([run(a), run(b)]);
      assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
      const failure = settled.find(result => result.status === "rejected"); assert.ok(failure && failure.status === "rejected"); assert.equal(failure.reason.code, "DISCOVERY_MATCH_CHANGED");
      const count = await db.admin.query("select count(*)::int as count from organizations where workspace_id=$1 and name='New Concurrent Co'", [workspace]); assert.equal(count.rows[0].count, 1);
    });
    await t.test("ambiguous same-name companies require explicit current selection and cannot create a duplicate", async () => {
      await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'Synthetic Irish Co','Unternehmen','WEB_DESIGN')", [randomUUID(), workspace, project]);
      const value = candidate("Synthetic Irish Co", "9 New Street, Dublin, Ireland", "nine@example.invalid"); const found = await match(value); assert.equal(found.status, "AMBIGUOUS");
      const request = await registration(value);
      await assert.rejects(run({ ...request, decision: { ...request.decision, createCompany: true, companyId: null } }), { code: "DISCOVERY_EXISTING_COMPANY_REQUIRES_SELECTION" });
      await assert.rejects(run({ ...request, expectedMatchDigest: "f".repeat(64) }), { code: "DISCOVERY_MATCH_CHANGED" });
    });
    await t.test("foreign project, service identity, unsupported country, stale/unsupported facts are rejected", async () => {
      await assert.rejects(matchWebsiteSalesDiscovery(session, { contractVersion, operation: "match", projectId: randomUUID(), candidate: candidate() }, options), { code: "PROJECT_FORBIDDEN" });
      await assert.rejects(matchWebsiteSalesDiscovery({ ...session, serviceIdentity: { identityId: randomUUID(), role: "Evelyn.Service", consumer: "EVELYN", environment: "production", jtiHash: "0".repeat(64) } }, { contractVersion, operation: "match", projectId: project, candidate: candidate() }, options), { code: "DISCOVERY_SESSION_REQUIRED" });
      const stale = candidate(); stale.sourceReferences[0]!.validUntil = new Date(Date.now() - 1000).toISOString(); await assert.rejects(match(stale), { code: "DISCOVERY_CURRENT_SOURCE_REQUIRED" });
      const unsupported = candidate(); unsupported.sourceReferences[0]!.quote = "An unrelated company at a different address"; await assert.rejects(match(unsupported));
      await assert.rejects(matchWebsiteSalesDiscovery(session, { contractVersion, operation: "match", projectId: project, candidate: { ...candidate(), countryCode: "AT" } }, options));
    });
    await t.test("reviewed Studio inbound linkage preserves its existing contact, lead, deal and original source", async () => {
      const value = candidate("Studio Inbound Café", "12 Studio Street, Dublin, Ireland", "inbound@example.invalid"); value.domain = null;
      const contact = randomUUID(), lead = randomUUID(), deal = randomUUID(), pipeline = randomUUID();
      await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role,email,consent_label) values($1,$2,$3,'Public Contact','Ansprechpartner','inbound@example.invalid','Nur CRM')", [contact, workspace, project]);
      await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,source,type,status,division,metadata) values($1,$2,$3,$4,'Novalure Studio Form','Website Sales','Neu','WEB_DESIGN','{\"originalEnquiry\":true}'::jsonb)", [lead, workspace, project, contact]);
      await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,lead_id,name,stage,source,division) values($1,$2,$3,$4,$5,'Original Studio enquiry','Research intake','Novalure Studio Form','WEB_DESIGN')", [deal, workspace, project, contact, lead]);
      await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'discovery-test','Existing website pipeline','novalure_internal',true)", [pipeline, workspace, project]);
      await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'qualify','Research intake',0,'work')", [pipeline, workspace, project]);
      await db.admin.query("update projects set default_pipeline_id=$2 where id=$1", [project, pipeline]);
      const found = await match(value); assert.equal(found.contacts[0]!.companyId, null); assert.equal(found.existingLeads[0]!.leadId, lead);
      const original = await registration(value); const saved = await run({ ...original, decision: { ...original.decision, contactId: contact, createContact: false } });
      assert.ok("data" in saved); assert.equal(saved.data.contactId, contact); const identity = saved.data.identity;
      const prospect = { identity, country: "IRELAND", identityStatus: "VERIFIED", domain: null, path: "NO_WEBSITE", ownWebsiteSearch: "NONE_FOUND", obstacle: null, platformUrl: null, bookingRoute: "UNKNOWN", need: "EVIDENCED",
        evidence: ["IDENTITY", "OWN_WEBSITE_SEARCH", "BUSINESS_NEED"].map(kind => ({ evidenceId: kind, identity, kind, sourceUrl: "https://public.example/company", finding: "Synthetic current public research fact", confidence: 0.9,
          observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), validityCondition: "Source fact remains current" })) };
      const observed = await runWebsiteSalesIrelandCommand(session, { contractVersion: "website-sales-ireland-v1", operation: "observe", projectId: project, companyId: identity.companyId, locationId: identity.locationId,
        locationVersion: saved.data.locationVersion, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { prospect } }, options);
      const qualified = await runWebsiteSalesIrelandCommand(session, { contractVersion: "website-sales-ireland-v1", operation: "qualify", projectId: project, companyId: identity.companyId, locationId: identity.locationId,
        expectedVersion: observed.data.workflow!.version, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { contactId: contact, opportunitySummary: "Current internal website research", nextAction: "Review current findings", expectedEvidenceDigest: observed.data.workflow!.evidenceDigest } }, options);
      assert.equal(qualified.data.workflow!.leadId, lead); assert.equal(qualified.data.workflow!.dealId, deal);
      const state = (await db.admin.query("select l.source,l.metadata->>'originalEnquiry' original,(select count(*)::int from leads where contact_id=$1) leads,(select count(*)::int from deals where contact_id=$1) deals,c.organization_id company from leads l join contacts c on c.id=l.contact_id where l.id=$2", [contact, lead])).rows[0];
      assert.deepEqual(state, { source: "Novalure Studio Form", original: "true", leads: 1, deals: 1, company: identity.companyId });
    });
  } finally { await db.stop(); }
});
