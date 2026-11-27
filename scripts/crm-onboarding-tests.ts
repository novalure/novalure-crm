import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { parseCrmOnboardingProgress } from "../src/lib/crm-onboarding";
import { createCrmOnboardingExample, loadCrmOnboarding, saveCrmOnboardingProgress } from "../src/lib/db/crm-onboarding-repository";
import { buildWebExposeSnapshot, publishWebExpose, type WebExposePublishInput } from "../src/lib/db/web-expose-repository";
import { preparePropertyPortalExport } from "../src/lib/db/property-portal-repository";

test("onboarding progress accepts only supported country and guide steps", () => {
  assert.deepEqual(parseCrmOnboardingProgress({ countryCode: "IE", reviewedSteps: ["expose"] }), { countryCode: "IE", reviewedSteps: ["expose"] });
  assert.throws(() => parseCrmOnboardingProgress({ countryCode: "FR", reviewedSteps: [] }));
  assert.throws(() => parseCrmOnboardingProgress({ countryCode: "AT", reviewedSteps: ["expose", "expose"] }));
  assert.throws(() => parseCrmOnboardingProgress({ countryCode: "AT", reviewedSteps: [], complete: true }));
});
test("example onboarding persists isolated four-country CRM scenarios and personal guide progress", { timeout: 180000 }, async (t) => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    for (const file of ["155_web_expose.sql", "156_property_portal_exports.sql", "164_crm_onboarding_examples.sql"]) await db.admin.query(await readFile(`migrations/${file}`, "utf8"));
    const workspaceId = randomUUID(), userId = randomUUID(), agentId = randomUUID(), foreignWorkspaceId = randomUUID(), foreignId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC onboarding','self_service_customer','real_estate_broker'),($2,'SYNTHETIC foreign','self_service_customer','real_estate_broker')", [workspaceId, foreignWorkspaceId]);
    for (const [id, ws, role, productRole] of [[userId, workspaceId, "owner", "customer_owner"], [agentId, workspaceId, "agent", "broker_agent"], [foreignId, foreignWorkspaceId, "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic',$3,$4,$5,'active')", [id, ws, `onboarding-${id}@example.invalid`, role, productRole]);
    const session = { authenticated: true, userId, workspaceId, workspaceName: "Synthetic", name: "Synthetic", email: `onboarding-${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
    const agent = { ...session, userId: agentId, role: "agent", productRole: "broker_agent", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("broker_agent") } as AppSession;
    const foreign = { ...session, userId: foreignId, workspaceId: foreignWorkspaceId } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool }, run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    const examples: { id: string; projectId: string; propertyId: string; leadId: string }[] = [];
    await t.test("each country creates its actual geography, real entities and only one retained scenario", async () => {
      for (const countryCode of ["AT", "DE", "ES", "IE"] as const) {
        const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
        const created = await createCrmOnboardingExample(session, countryCode, metadata, options); assert.equal(created.data.created, true); examples.push(created.data);
        const retry = await createCrmOnboardingExample(session, countryCode, metadata, options); assert.equal(retry.replayed, true); assert.equal(retry.data.id, created.data.id);
        const another = await createCrmOnboardingExample(session, countryCode, { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options); assert.equal(another.data.created, false); assert.equal(another.data.projectId, created.data.projectId);
        const property = (await db.admin.query("select title,canonical_payload from seller_listings where id=$1", [created.data.propertyId])).rows[0];
        assert.match(property.title, /BEISPIEL/); assert.equal(property.canonical_payload.geography.countryCode, countryCode); assert.equal(property.canonical_payload.onboardingExample.synthetic, true);
        assert.equal(property.canonical_payload.geography.contentLanguage, countryCode === "ES" ? "es" : countryCode === "IE" ? "en" : "de");
        const units = (await db.admin.query("select metadata,status from property_units where project_id=$1 and coalesce(metadata->>'hidden','false')<>'true'", [created.data.projectId])).rows;
        assert.equal(units.length, 2); assert.ok(units.every((row) => row.metadata.onboardingExample.synthetic && row.status === "available"));
      }
      const state = await run(loadCrmOnboarding); assert.equal(state.examples.length, 4); assert.equal(state.canCreateExample, true); assert.deepEqual(state.observed, { properties: 0, units: 0, inquiries: 0, assigned: 0, nextTasks: 0 });
      assert.equal(state.features?.expose, true); assert.equal(state.features?.portals, true); assert.equal(state.features?.automations, false);
      assert.equal((await db.admin.query("select count(*)::int as n from web_expose_links")).rows[0].n, 0); assert.equal((await db.admin.query("select count(*)::int as n from property_export_jobs")).rows[0].n, 0);
      const contacts = (await db.admin.query("select email,consent_label from contacts where workspace_id=$1", [workspaceId])).rows; assert.equal(contacts.length, 4); assert.ok(contacts.every((row) => row.email.endsWith("@example.invalid") && /Keine Einwilligung/.test(row.consent_label)));
    });
    await t.test("example markers survive ordinary edits, propagate to new children and prevent moving into real projects", async () => {
      const example = examples[0];
      await run((tx) => tx.query("update leads set metadata='null',next_action='Practised action' where id=$1 and workspace_id=$2", [example.leadId, workspaceId]));
      const lead = (await db.admin.query("select metadata from leads where id=$1", [example.leadId])).rows[0]; assert.equal(lead.metadata.onboardingExample.synthetic, true); assert.equal(lead.metadata.websiteSales.syntheticTest, true);
      const task = await run((tx) => tx.queryOne<{ title: string; metadata: { onboardingExample: { synthetic: boolean } } }>("insert into tasks(workspace_id,project_id,title,status) values($1,$2,'Practise task','open') returning title,metadata", [workspaceId, example.projectId])); assert.match(task!.title, /BEISPIEL/); assert.equal(task?.metadata.onboardingExample.synthetic, true);
      const projectId = randomUUID(); await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC real project','Service')", [projectId, workspaceId]);
      await assert.rejects(run((tx) => tx.query("update leads set project_id=$2 where id=$1", [example.leadId, projectId])), /separate project/);
      await assert.rejects(run((tx, scoped) => preparePropertyPortalExport(tx, scoped, { propertyId: example.propertyId, portalName: "Synthetic", action: "CHANGE", expectedSourceFingerprint: "synthetic", reviewed: true, idempotencyKey: randomUUID() })), /Beispielobjekte/);
      const input: WebExposePublishInput = { propertyId: example.propertyId, language: "de", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal", controller: "Synthetic", showAddress: false, showContact: false, reviewed: true };
      const preview = await run((tx, scoped) => buildWebExposeSnapshot(tx, scoped, input)); assert.equal(preview.snapshot.countryCode, "AT");
      await assert.rejects(run((tx, scoped) => publishWebExpose(tx, scoped, { ...input, expectedSourceFingerprint: preview.sourceFingerprint })), /Beispiel|example/i);
    });
    await t.test("progress is personal and uses version checks while manager/project rights protect examples", async () => {
      const requestId = randomUUID(), progress = { countryCode: "IE", reviewedSteps: ["property", "expose"] };
      const saved = await run((tx, scoped) => saveCrmOnboardingProgress(tx, scoped, progress, 0, requestId), agent); assert.equal(saved.revision, 1);
      assert.equal((await run((tx, scoped) => saveCrmOnboardingProgress(tx, scoped, progress, 0, requestId), agent)).replayed, true);
      await assert.rejects(run((tx, scoped) => saveCrmOnboardingProgress(tx, scoped, progress, 0, randomUUID()), agent), /geändert/);
      assert.equal((await run(loadCrmOnboarding)).progress.revision, 0); const hidden = await run(loadCrmOnboarding, agent); assert.equal(hidden.examples.length, 0); assert.equal(hidden.canCreateExample, false);
      assert.equal((await run(loadCrmOnboarding, foreign)).examples.length, 0);
      await assert.rejects(createCrmOnboardingExample(agent, "AT", { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options), /Workspace-Verantwortliche/);
      await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [workspaceId, examples[0].projectId, agentId]);
      assert.equal((await run(loadCrmOnboarding, agent)).examples.length, 1);
      await db.admin.query("update project_pipeline_permissions set can_read=false where user_id=$1", [agentId]); assert.equal((await run(loadCrmOnboarding, agent)).examples.length, 0);
      assert.equal((await db.pool.query("select count(*)::int as n from crm_onboarding_progress")).rows[0].n, 0);
    });
    await t.test("a failed child insert rolls back the entire project scenario", async () => {
      await db.admin.query("create function synthetic_onboarding_failure() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC failure';end$$;create trigger synthetic_onboarding_failure before insert on contacts for each row execute function synthetic_onboarding_failure()");
      try { await assert.rejects(createCrmOnboardingExample(foreign, "AT", { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options), /SYNTHETIC failure/); }
      finally { await db.admin.query("drop trigger synthetic_onboarding_failure on contacts;drop function synthetic_onboarding_failure()"); }
      assert.equal((await db.admin.query("select count(*)::int as n from projects where workspace_id=$1", [foreignWorkspaceId])).rows[0].n, 0); assert.equal((await db.admin.query("select count(*)::int as n from seller_listings where workspace_id=$1", [foreignWorkspaceId])).rows[0].n, 0);
    });
  } finally { await db.stop(); }
});
