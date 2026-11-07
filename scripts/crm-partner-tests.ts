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
import { createCrmPartnerRequest, linkCrmPartnerReservation, loadCrmPartnerWorkspace, saveCrmPartnerGrant, withdrawCrmPartnerRequest } from "../src/lib/db/crm-partner-repository";
import { runPropertySalesCommand } from "../src/lib/db/property-sales-repositories";
import type { PartnerProjection } from "../src/lib/crm-partner";

test("partner cooperation isolates explicit shares and uses the existing reservation request", { timeout: 180000 }, async (t) => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 }); await db.admin.query(await readFile("migrations/167_crm_partner_cooperation.sql", "utf8"));
    const workspaceId = randomUUID(), userId = randomUUID(), partnerId = randomUUID(), otherId = randomUUID(), projectId = randomUUID(), foreignProject = randomUUID(), propertyId = randomUUID(), contactId = randomUUID(), leadId = randomUUID(), unitId = randomUUID(), otherUnit = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC partners','self_service_customer','real_estate_broker')", [workspaceId]);
    for (const [id, role, productRole] of [[userId, "owner", "customer_owner"], [partnerId, "assistant", "external_partner"], [otherId, "agent", "external_partner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic',$3,$4,$5,'active')", [id, workspaceId, `partner-${id}@example.invalid`, role, productRole]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC project','Service'),($3,$2,'SYNTHETIC other','Service')", [projectId, workspaceId, foreignProject]);
    // Even a legacy full project grant must no longer expose private CRM data.
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspaceId, projectId, partnerId]);
    await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,city,object_type,area_sqm,rooms,target_price_cents,price_visibility,internal_notes,canonical_payload) values($1,$2,$3,'Synthetic approved facts','PRIVATE-ADDRESS','Wien','Wien','Wohnung',80,3,12345678,'hide_price','PRIVATE-INTERNAL-NOTES','{\"geography\":{\"version\":1,\"countryCode\":\"AT\",\"region\":\"Wien\",\"displayLocale\":\"de-AT\",\"contentLanguage\":\"de\",\"currency\":\"EUR\",\"bookingTimezone\":\"Europe/Vienna\",\"source\":\"explicit\"}}')", [propertyId, workspaceId, projectId]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,role,email,phone) values($1,$2,$3,$4,'PRIVATE-CUSTOMER','Käufer','PRIVATE@example.invalid','PRIVATE-PHONE')", [contactId, workspaceId, projectId, partnerId]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,status,buyer_profile,sales_qualification) values($1,$2,$3,$4,$5,'Käufer','Qualifiziert','{\"budget\":\"PRIVATE-FINANCES\"}',$6::jsonb)", [leadId, workspaceId, projectId, contactId, partnerId, JSON.stringify({ desiredUnitId: unitId })]);
    for (const [id, project] of [[unitId, projectId], [otherUnit, foreignProject]]) await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,area_sqm,rooms,status,metadata) values($1,$2,$3,'SYNTHETIC-U1',80,3,'available',$4::jsonb)", [id, workspaceId, project, JSON.stringify({ sellerListingId: propertyId })]);
    await db.admin.query("insert into lead_sales_handovers(workspace_id,project_id,lead_id,qualification_version,recipient_user_id,actor_id,source_reference) values($1,$2,$3,1,$4,$4,'SYNTHETIC handover')", [workspaceId, projectId, leadId, userId]);
    const assetId = randomUUID();
    await db.admin.query("insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public) values($1,$2,'PRIVATE CONTRACT','private.pdf','ordinary-library','application/pdf',100,'',$3,'local','private',false)", [assetId, workspaceId, `${workspaceId}/${assetId}.pdf`]);
    await db.admin.query("insert into property_documents(workspace_id,project_id,property_id,media_asset_id,title,category,visibility,status) values($1,$2,$3,$4,'PRIVATE CONTRACT','contract','private','draft')", [workspaceId, projectId, propertyId, assetId]);
    const session = { authenticated: true, userId, workspaceId, workspaceName: "Synthetic", name: "Synthetic", email: `partner-${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
    const partner = { ...session, userId: partnerId, role: "assistant", productRole: "external_partner", permissions: getRolePermissions("assistant"), productPermissions: getProductRoleCapabilities("external_partner") } as AppSession;
    const other = { ...partner, userId: otherId, role: "agent", permissions: getRolePermissions("agent") } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool }, run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    const expire = new Date(Date.now() + 10 * 86400000).toISOString();
    let propertyGrant: { id: string; revision: number }, leadGrant: { id: string; revision: number }, requestId: string;
    const readPartner = async (actor = partner) => { const state = await run((tx, scoped) => loadCrmPartnerWorkspace(tx, scoped, null), actor); assert.equal(state.mode, "partner"); return state.mode === "partner" ? state.data : { properties: [], leads: [], requests: [] } as PartnerProjection; };
    await t.test("legacy broad/owned grants reveal no source CRM rows or private files", async () => {
      for (const table of ["projects", "contacts", "leads", "seller_listings", "property_units", "property_reservations", "media_assets", "property_documents"]) assert.equal((await run((tx) => tx.query(`select id from ${table}`), partner)).length, 0, table);
      assert.deepEqual(await readPartner(), { properties: [], leads: [], requests: [] });
      await assert.rejects(run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "property", targetId: propertyId, status: "active", expiresAt: expire, reviewed: true, expectedRevision: 0 }), partner));
    });
    await t.test("independent shares disclose only reviewed object facts or neutral lead status", async () => {
      propertyGrant = await run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "property", targetId: propertyId, status: "active", expiresAt: expire, reviewed: true, expectedRevision: 0 })) as typeof propertyGrant;
      let projection = await readPartner(); assert.equal(projection.properties.length, 1); assert.equal(projection.leads.length, 0); assert.equal(projection.properties[0].snapshot.price, null); assert.equal(projection.properties[0].units.length, 1); assert.doesNotMatch(JSON.stringify(projection), /PRIVATE|123456|buyer_profile|contactId|contact_id/);
      leadGrant = await run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "lead", targetId: leadId, label: "PARTNER-REF-001", status: "active", expiresAt: expire, reviewed: true, expectedRevision: 0 })) as typeof leadGrant;
      projection = await readPartner(); assert.equal(projection.leads[0].label, "PARTNER-REF-001"); assert.doesNotMatch(JSON.stringify(projection), /PRIVATE|leadId|budget|email|phone/);
      assert.equal((await readPartner(other)).properties.length, 0);
      await assert.rejects(run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "property", targetId: propertyId, status: "active", expiresAt: expire, reviewed: true, expectedRevision: 0 })), /geändert/);
    });
    await t.test("partner request is nonbinding, scoped, deduplicated and becomes only canonical requested", async () => {
      const key = randomUUID(), input = { grantId: propertyGrant.id, unitId, leadGrantId: leadGrant.id, reference: "SYNTHETIC interest", expiresAt: new Date(Date.now() + 86400000).toISOString() };
      const request = await run((tx, scoped) => createCrmPartnerRequest(tx, scoped, input, key), partner); requestId = String(request?.id);
      assert.equal((await run((tx, scoped) => createCrmPartnerRequest(tx, scoped, input, key), partner))?.id, requestId);
      await assert.rejects(run((tx, scoped) => createCrmPartnerRequest(tx, scoped, { ...input, reference: "different" }, key), partner), /Vorgangskennung/);
      await assert.rejects(run((tx, scoped) => createCrmPartnerRequest(tx, scoped, { ...input, unitId: otherUnit }, randomUUID()), partner));
      await assert.rejects(run((tx, scoped) => createCrmPartnerRequest(tx, scoped, input, randomUUID()), other));
      assert.equal((await db.admin.query("select status from property_units where id=$1", [unitId])).rows[0].status, "available"); assert.equal((await db.admin.query("select count(*)::int as n from property_reservations")).rows[0].n, 0);
      const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const linked = await linkCrmPartnerReservation(session, { projectId, requestId, leadId, unitVersion: 1, expectedRevision: 1 }, metadata, options); assert.equal(linked.data?.status, "linked");
      assert.equal((await linkCrmPartnerReservation(session, { projectId, requestId, leadId, unitVersion: 1, expectedRevision: 1 }, metadata, options)).replayed, true);
      const reservation = (await db.admin.query("select id,status from property_reservations")).rows[0]; assert.equal(reservation.status, "requested"); assert.equal((await db.admin.query("select status from property_units where id=$1", [unitId])).rows[0].status, "available");
      const view = await readPartner(); assert.equal(view.requests[0].reservationStatus, "requested");
      await assert.rejects(runPropertySalesCommand(partner, { action: "reservation.confirm", projectId, expectedVersion: 1, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { reservationId: reservation.id, unitVersion: 1, sourceReference: "Forbidden" } }, options));
      await assert.rejects(runPropertySalesCommand(session, { action: "reservation.confirm", projectId, expectedVersion: 1, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { reservationId: reservation.id, unitVersion: 1, sourceReference: "No project authority" } }, options), /authority/);
    });
    await t.test("withdrawal and grant revocation are immediate without affecting another share", async () => {
      // A different unit permits an independent nonbinding request for withdrawal.
      const fresh = randomUUID(); await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,metadata) values($1,$2,$3,'SYNTHETIC-U2','available',$4::jsonb)", [fresh, workspaceId, projectId, JSON.stringify({ sellerListingId: propertyId })]);
      propertyGrant = await run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "property", targetId: propertyId, status: "active", expiresAt: expire, reviewed: true, expectedRevision: 1 })) as typeof propertyGrant;
      const created = await run((tx, scoped) => createCrmPartnerRequest(tx, scoped, { grantId: propertyGrant.id, unitId: fresh, reference: "Withdraw me", expiresAt: new Date(Date.now() + 86400000).toISOString() }, randomUUID()), partner);
      await run((tx, scoped) => withdrawCrmPartnerRequest(tx, scoped, String(created?.id), 1), partner); await run((tx, scoped) => withdrawCrmPartnerRequest(tx, scoped, String(created?.id), 1), partner);
      await run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "lead", targetId: leadId, label: "PARTNER-REF-001", status: "revoked", expiresAt: expire, reviewed: true, expectedRevision: 1 }));
      let projection = await readPartner(); assert.equal(projection.leads.length, 0); assert.equal(projection.properties.length, 1);
      await run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "property", targetId: propertyId, status: "revoked", expiresAt: expire, reviewed: true, expectedRevision: 2 }));
      projection = await readPartner(); assert.equal(projection.properties.length, 0); assert.equal(projection.requests.length, 0);
      await assert.rejects(run((tx, scoped) => createCrmPartnerRequest(tx, scoped, { grantId: propertyGrant.id, unitId: fresh, reference: "revoked", expiresAt: new Date(Date.now() + 86400000).toISOString() }, randomUUID()), partner), /nicht mehr verfügbar/);
    });
    await t.test("projection and guards work with a non-BYPASS table/function owner under FORCE RLS", async () => {
      await db.admin.query("create role partner_fixture_owner nologin nosuperuser nobypassrls;grant usage,create on schema public to partner_fixture_owner;grant select on workspaces,project_pipeline_permissions to partner_fixture_owner");
      for (const table of ["crm_partner_property_grants", "crm_partner_lead_grants", "crm_partner_requests", "seller_listings", "property_units", "leads", "property_reservations", "workspace_users"]) await db.admin.query(`alter table ${table} owner to partner_fixture_owner`);
      for (const signature of ["crm_partner_actor(uuid)", "crm_partner_property_allowed(uuid)", "crm_partner_scope_guard()", "crm_partner_projection()"] ) await db.admin.query(`alter function ${signature} owner to partner_fixture_owner`);
      assert.equal((await readPartner()).properties.length, 0);
      propertyGrant = await run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "property", targetId: propertyId, status: "active", expiresAt: expire, reviewed: true, expectedRevision: 3 })) as typeof propertyGrant;
      assert.equal((await readPartner()).properties.length, 1);
      assert.equal((await run((tx) => tx.query("select id from contacts"), partner)).length, 0);
      const projection = await readPartner(), unit = projection.properties[0].units.find((item) => item.number === "SYNTHETIC-U2"); assert.ok(unit);
      const created = await run((tx, scoped) => createCrmPartnerRequest(tx, scoped, { grantId: propertyGrant.id, unitId: unit!.id, reference: "Non-BYPASS write", expiresAt: new Date(Date.now() + 86400000).toISOString() }, randomUUID()), partner);
      assert.ok(created?.id); await run((tx, scoped) => withdrawCrmPartnerRequest(tx, scoped, String(created?.id), 1), partner);
      await db.admin.query("update workspace_users set status='invited' where id=$1", [partnerId]);
      await assert.rejects(readPartner());
      const revoked = await run((tx, scoped) => saveCrmPartnerGrant(tx, scoped, { projectId, partnerId, kind: "property", targetId: propertyId, status: "revoked", expiresAt: expire, reviewed: true, expectedRevision: propertyGrant.revision })); assert.ok(revoked?.id);
    });
  } finally { await db.stop(); }
});
