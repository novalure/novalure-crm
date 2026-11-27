import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { SaxesParser } from "saxes";
import { createPropertyGeography } from "../src/lib/property-country";
import { buildPropertyPortalXml, parsePropertyPortalProfile, type PropertyPortalProfile, type PropertyPortalSource } from "../src/lib/property-portal";
import { createPropertyPortalZip } from "../src/lib/property-portal-package";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createSellerListingRecord } from "../src/lib/db/property-department-repositories";
import { downloadPropertyPortalExport, loadPropertyPortalState, preparePropertyPortalExport, previewPropertyPortal, savePropertyPortalProfile } from "../src/lib/db/property-portal-repository";
import { mediaAssetPath, type MediaAsset } from "../src/lib/media-store";

type ZipEntry = { fileName: string };
type ZipFile = EventEmitter & { readEntry(): void; openReadStream(entry: ZipEntry, callback: (error: Error | null, stream: Readable) => void): void };
const unzip = (bytes: Buffer) => new Promise<Record<string, Buffer>>((resolve, reject) => {
  const reader = createRequire(import.meta.url)("yauzl") as { fromBuffer(buffer: Buffer, options: { lazyEntries: boolean }, callback: (error: Error | null, zip: ZipFile) => void): void };
  reader.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) { reject(error); return; }
    const entries: Record<string, Buffer> = {};
    zip.on("error", reject); zip.on("end", () => resolve(entries));
    zip.on("entry", (entry: ZipEntry) => zip.openReadStream(entry, (readError, stream) => {
      if (readError) { reject(readError); return; }
      const chunks: Buffer[] = []; stream.on("data", (chunk: Buffer) => chunks.push(chunk)); stream.on("error", reject); stream.on("end", () => { entries[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
    }));
    zip.readEntry();
  });
});

const profile: PropertyPortalProfile = { portalName: "SYNTHETIC recipient", providerName: "Synthetic & Sons", providerId: "SYNTHETIC-123", agencyId: "SYNTHETIC-AGENCY", externalObjectId: "SYNTHETIC-OBJECT", contactName: "Synthetic Agent", contactEmail: "synthetic-agent@example.invalid", propertyType: "apartment", includeAddress: false, includeMedia: true };
const source: PropertyPortalSource = { propertyId: "22222222-2222-4222-8222-222222222222", projectId: null, title: 'Synthetic <title> & "escape"', city: "Wien", postalCode: "1010", street: "PRIVATE-STREET", houseNumber: "20", fullAddress: "PRIVATE-STREET 20 1010 Wien", description: "Synthetic & description PRIVATE-STREET 20 1010 Wien", areaSqm: 80.5, rooms: 3, yearBuilt: 2000, marketingType: "sale", usageType: "residential", priceCents: 12345678, priceVisibility: "publish_price", geography: createPropertyGeography("AT", "Wien"), energy: { version: 1, countryCode: "AT", energyClass: "B", heatingDemandKwhM2: 32, finalEnergyDemandKwhM2: 50, exemptionReason: "PRIVATE-REVIEW-NOTE" }, updatedAt: "2026-11-04", media: [] };
test("OpenImmo export escapes text, follows release flags and never leaks internal review notes or hidden prices", () => {
  const output = buildPropertyPortalXml(source, profile, "CHANGE", "2026-11-04T10:00:00.000Z");
  const parser = new SaxesParser({ xmlns: true }); parser.write(output).close();
  assert.match(output, /Synthetic &lt;title&gt; &amp; &quot;escape&quot;/); assert.match(output, /123456\.78/); assert.doesNotMatch(output, /PRIVATE-/);
  assert.match(output, /umfang="TEIL"/); assert.match(output, /iso_land="AUT"/); assert.match(output, /aktionart="CHANGE"/);
  const hidden = buildPropertyPortalXml({ ...source, priceVisibility: "hide_price" }, profile, "CHANGE", "2026-11-04T10:00:00Z"); assert.doesNotMatch(hidden, /123456|kaufpreis|warmmiete/);
  const requested = buildPropertyPortalXml({ ...source, priceVisibility: "price_on_request" }, profile, "CHANGE", "2026-11-04T10:00:00Z"); assert.match(requested, /kaufpreis auf_anfrage="true">0</); assert.doesNotMatch(requested, /123456/);
  const removed = buildPropertyPortalXml(source, profile, "DELETE", "2026-11-04T10:00:00Z"); assert.match(removed, /aktionart="DELETE"/); assert.doesNotMatch(removed, /123456|PRIVATE-|objektbeschreibung|energiepass/);
  assert.throws(() => parsePropertyPortalProfile({ ...profile, password: "do-not-store" }), /INVALID_PORTAL_PROFILE/);
  assert.throws(() => createPropertyPortalZip({ "../escape.xml": "test" }), /INVALID_PORTAL_ARCHIVE_NAME/);
});
test("generated CHANGE and DELETE exports validate against the official downloaded OpenImmo 1.2.7d XSD", async (t) => {
  const schema = ".npm-cache/qa/openimmo-reference/openimmo_127d.xsd";
  try { await access(schema); } catch { t.skip("Official XSD not supplied locally. Download the official archive; parser tests do not claim XSD validation."); return; }
  if (process.platform !== "win32") { t.skip("This reference-validation helper uses the Windows .NET XML Schema validator."); return; }
  await mkdir(".npm-cache/qa/openimmo-reference/generated", { recursive: true });
  for (const action of ["CHANGE", "DELETE"] as const) {
    const path = `.npm-cache/qa/openimmo-reference/generated/${action}.xml`;
    await writeFile(path, buildPropertyPortalXml({ ...source, media: [{ id: randomUUID(), assetId: randomUUID(), fileName: "media-synthetic.png", title: "Synthetic image", format: "PNG", kind: "image", sizeBytes: 100, updatedAt: "2026-11-04" }] }, profile, action, "2026-11-04T10:00:00Z"));
    const result = spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/validate-openimmo.ps1", "-SchemaPath", schema, "-XmlPath", path], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, `${action}: ${result.stdout}\n${result.stderr}`);
  }
});
test("portal profiles and frozen packages persist with tenant/project rights and stale preview protection", { timeout: 180000 }, async (t) => {
  const db = await startLocalSalesDb();
  const fixtureFiles: string[] = [];
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 }); await db.admin.query(await readFile("migrations/156_property_portal_exports.sql", "utf8")); await db.admin.query(await readFile("migrations/172_property_portal_release_checks.sql", "utf8"));
    const workspaceId = randomUUID(), userId = randomUUID(), viewerId = randomUUID(), projectId = randomUUID(), foreignWorkspace = randomUUID(), foreignUser = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC portal','self_service_customer','real_estate_broker'),($2,'SYNTHETIC foreign','self_service_customer','real_estate_broker')", [workspaceId, foreignWorkspace]);
    for (const [id, ws, role, productRole] of [[userId, workspaceId, "owner", "customer_owner"], [viewerId, workspaceId, "agent", "broker_agent"], [foreignUser, foreignWorkspace, "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic portal member',$3,$4,$5,'active')", [id, ws, `portal-${id}@example.invalid`, role, productRole]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC portal project','Service')", [projectId, workspaceId]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [workspaceId, projectId, viewerId]);
    const session = { authenticated: true, userId, workspaceId, workspaceName: "Synthetic portal", name: "Synthetic", email: `portal-${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
    const viewer = { ...session, userId: viewerId, role: "agent", productRole: "broker_agent" } as AppSession, foreign = { ...session, userId: foreignUser, workspaceId: foreignWorkspace } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool }, run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    const created = await run((_tx, scoped) => createSellerListingRecord({ session: scoped, property: { title: "Synthetic <portal>", address: source.fullAddress, region: "Wien", city: "Wien", postalCode: "1010", geography: source.geography, energyCertificate: source.energy, areaSqm: 80.5, rooms: 3, yearBuilt: 2000, price: 123456.78, usageType: "residential", objectType: "Wohnung", projectId, internalNotes: "PRIVATE-INTERNAL" } }));
    assert.ok(created.persisted, JSON.stringify(created)); if (!created.persisted) return;
    const propertyId = created.data.id;
    await db.admin.query("insert into property_text_blocks(workspace_id,project_id,property_id,text_key,channel,title,content,status,visibility) values($1,$2,$3,'portal','Immobilienportal','Synthetic portal','Approved synthetic public description','approved','channel')", [workspaceId, projectId, propertyId]);
    await t.test("profile revisions persist without passwords and reject stale updates", async () => {
      const saved = await run((tx, scoped) => savePropertyPortalProfile(tx, scoped, propertyId, profile, 0)); assert.equal(saved.revision, 1);
      await assert.rejects(run((tx, scoped) => savePropertyPortalProfile(tx, scoped, propertyId, profile, 0)), /Profil|Portalprofil/);
      const loaded = await run((tx, scoped) => loadPropertyPortalState(tx, scoped, propertyId)); assert.equal(loaded.profiles.length, 1); assert.equal(loaded.transport, "not_connected");
      await assert.rejects(run((tx, scoped) => savePropertyPortalProfile(tx, scoped, propertyId, { ...profile, password: "not-accepted" }, 1)));
    });
    let jobId = "";
    await t.test("prepare rejects stale data, stores a real package and keeps it out of transport queues", async () => {
      const preview = await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "CHANGE"));
      assert.equal(preview.checks.some((check) => check.status === "missing"), false, JSON.stringify(preview.checks));
      await db.admin.query("update seller_listings set title='Updated synthetic' where id=$1", [propertyId]);
      await assert.rejects(run((tx, scoped) => preparePropertyPortalExport(tx, scoped, { propertyId, portalName: profile.portalName, action: "CHANGE", expectedSourceFingerprint: preview.sourceFingerprint, reviewed: true, idempotencyKey: randomUUID() })), /Vorschau/);
      const fresh = await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "CHANGE"));
      const key = randomUUID(), input = { propertyId, portalName: profile.portalName, action: "CHANGE" as const, expectedSourceFingerprint: fresh.sourceFingerprint, reviewed: true, idempotencyKey: key };
      const prepared = await run((tx, scoped) => preparePropertyPortalExport(tx, scoped, input)); jobId = prepared.id; assert.equal(prepared.status, "prepared");
      const repeat = await run((tx, scoped) => preparePropertyPortalExport(tx, scoped, input)); assert.equal(repeat.id, prepared.id);
      const zip = await run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, jobId));
      const contents = await unzip(zip); assert.ok(contents["openimmo.xml"]); assert.equal(JSON.parse(contents["manifest.json"].toString()).delivery, "not_transferred");
      const record = (await db.admin.query("select status,metadata from property_export_jobs where id=$1", [jobId])).rows[0];
      assert.equal(record.status, "prepared"); assert.equal(record.metadata.transport, "not_connected"); assert.match(record.metadata.xml, /Updated synthetic/); assert.doesNotMatch(record.metadata.xml, /PRIVATE-/);
      assert.equal(Number((await db.admin.query("select count(*) from property_export_jobs where status in ('queued','retry','running')")).rows[0].count), 0);
    });
    await t.test("only approved image bytes enter the ZIP and withdrawing media approval blocks an old package", async () => {
      const assetId = randomUUID(), mediaId = randomUUID();
      const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC", "base64");
      const descriptor = { id: assetId, workspaceId, name: "Synthetic PNG", originalName: "synthetic.png", folder: "marketing-library", relativePath: `${workspaceId}/${assetId}.png`, mimeType: "image/png", sizeBytes: bytes.length, url: "", storageProvider: "local", storageAccess: "private", createdAt: new Date().toISOString(), isPublic: false, hasActivePublicShare: false } as MediaAsset;
      const filePath = mediaAssetPath(descriptor);
      assert.ok(filePath.startsWith(path.resolve(".data/media/uploads") + path.sep), "Media test must stay in the workspace's local media root");
      await mkdir(path.dirname(filePath), { recursive: true }); await writeFile(filePath, bytes); fixtureFiles.push(filePath);
      await db.admin.query("insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public) values($1,$2,'Synthetic PNG','synthetic.png',$3,'image/png',$4,'',$5,'local','private',false)", [assetId, workspaceId, descriptor.folder, bytes.length, descriptor.relativePath]);
      await db.admin.query("insert into property_media(id,workspace_id,project_id,property_id,media_asset_id,media_type,title,visibility,status) values($1,$2,$3,$4,$5,'image','Synthetic approved image','channel','approved')", [mediaId, workspaceId, projectId, propertyId, assetId]);
      const preview = await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "CHANGE")); assert.equal(preview.source.media.length, 1);
      const prepared = await run((tx, scoped) => preparePropertyPortalExport(tx, scoped, { propertyId, portalName: profile.portalName, action: "CHANGE", expectedSourceFingerprint: preview.sourceFingerprint, reviewed: true, idempotencyKey: randomUUID() }));
      const contents = await unzip(await run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, prepared.id)));
      assert.deepEqual(contents[`media-${mediaId}.png`], bytes); assert.match(contents["openimmo.xml"].toString(), new RegExp(`media-${mediaId}\\.png`));
      await db.admin.query("update seller_listings set price_visibility='hide_price' where id=$1", [propertyId]);
      await assert.rejects(run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, prepared.id)), { code: "PREVIEW_CHANGED" });
      await db.admin.query("update seller_listings set price_visibility='publish_price' where id=$1", [propertyId]);
      const makeCurrent = async () => { const current = await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "CHANGE")); return run((tx, scoped) => preparePropertyPortalExport(tx, scoped, { propertyId, portalName: profile.portalName, action: "CHANGE", expectedSourceFingerprint: current.sourceFingerprint, reviewed: true, idempotencyKey: randomUUID() })); };
      for (const category of ["internal", "contract", "funding", "proof"]) {
        const currentJob = await makeCurrent(); await db.admin.query("update property_media set category=$2 where id=$1", [mediaId, category]);
        await assert.rejects(run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, currentJob.id)), { code: "MEDIA_REVOKED" });
        assert.equal((await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "CHANGE"))).source.media.length, 0);
        await db.admin.query("update property_media set category='general' where id=$1", [mediaId]);
      }
      const otherProject = randomUUID(), otherProperty = randomUUID(), confidentialDocument = randomUUID(), currentJob = await makeCurrent();
      await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC confidential other project','Service')", [otherProject, workspaceId]);
      await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm) values($1,$2,$3,'SYNTHETIC other','Synthetic other','Wien','Wohnung',80)", [otherProperty, workspaceId, otherProject]);
      await db.admin.query("insert into property_documents(id,workspace_id,project_id,property_id,media_asset_id,title,category,visibility,status) values($1,$2,$3,$4,$5,'SYNTHETIC confidential reference','contract','private','draft')", [confidentialDocument, workspaceId, otherProject, otherProperty, assetId]);
      assert.equal((await run((tx) => tx.query("select id from property_documents where id=$1", [confidentialDocument]), viewer)).length, 0);
      await assert.rejects(run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, currentJob.id), viewer), { code: "MEDIA_REVOKED" });
      // Exercise the authoritative predicate with a real non-BYPASS owner.
      await db.admin.query("create role portal_release_fixture_owner nologin nosuperuser nobypassrls;grant usage on schema public to portal_release_fixture_owner;grant select on workspaces,workspace_users,project_pipeline_permissions,seller_listings,property_media,property_documents,media_assets to portal_release_fixture_owner");
      for (const table of ["workspaces", "workspace_users", "project_pipeline_permissions", "seller_listings", "property_media", "property_documents", "media_assets"]) await db.admin.query(`alter table ${table} owner to portal_release_fixture_owner`);
      await db.admin.query("alter function crm_property_portal_media_allowed(uuid,uuid,uuid) owner to portal_release_fixture_owner");
      assert.equal((await run((tx) => tx.queryOne<{ allowed: boolean }>("select crm_property_portal_media_allowed($1,$2,$3) as allowed", [workspaceId, propertyId, assetId]), viewer))?.allowed, false);
      await db.admin.query("delete from property_documents where id=$1", [confidentialDocument]);
      assert.equal((await run((tx) => tx.queryOne<{ allowed: boolean }>("select crm_property_portal_media_allowed($1,$2,$3) as allowed", [workspaceId, propertyId, assetId]), viewer))?.allowed, true);
      await db.admin.query("update property_media set status='needs_review' where id=$1", [mediaId]);
      await assert.rejects(run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, prepared.id)), /Bildfreigabe/);
    });
    await t.test("read-only project grants can inspect but cannot prepare; foreign or revoked grants cannot download", async () => {
      const state = await run((tx, scoped) => loadPropertyPortalState(tx, scoped, propertyId), viewer); assert.ok(state.jobs.length >= 2); assert.equal(state.canPrepare, false);
      await assert.rejects(run((tx, scoped) => savePropertyPortalProfile(tx, scoped, propertyId, profile, 1), viewer));
      await assert.rejects(run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, jobId), foreign));
      await db.admin.query("update project_pipeline_permissions set can_read=false where workspace_id=$1 and user_id=$2", [workspaceId, viewerId]);
      await assert.rejects(run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, jobId), viewer));
    });
    await t.test("removal package works when current advertising data is incomplete and cancellation blocks download", async () => {
      await db.admin.query("update seller_listings set canonical_payload=canonical_payload-'energyCertificate' where id=$1", [propertyId]);
      const removal = await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "DELETE"));
      assert.equal(removal.checks.some((check) => check.status === "missing"), false); assert.match(removal.xml, /aktionart="DELETE"/);
      const saved = await run((tx, scoped) => preparePropertyPortalExport(tx, scoped, { propertyId, portalName: profile.portalName, action: "DELETE", expectedSourceFingerprint: removal.sourceFingerprint, reviewed: true, idempotencyKey: randomUUID() })); assert.equal(saved.status, "prepared");
      await run((tx) => tx.query("update property_export_jobs set status='cancelled' where id=$1", [saved.id]));
      await assert.rejects(run((tx, scoped) => downloadPropertyPortalExport(tx, scoped, propertyId, saved.id)), /nicht verfügbar/);
    });
  } finally { await db.stop(); for (const file of fixtureFiles) await unlink(file); }
});
