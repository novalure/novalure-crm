import assert from "node:assert/strict";
process.env.NOVALURE_AUTH_ENCRYPTION_KEY ||= "synthetic-only-web-expose-media-encryption-key";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createSellerListingRecord } from "../src/lib/db/property-department-repositories";
import { buildWebExposeSnapshot, publishWebExpose, webExposeHash, type WebExposePublishInput } from "../src/lib/db/web-expose-repository";
import { createPropertyGeography } from "../src/lib/property-country";
import { normalizeWebExposeResourceUrl, parseWebExposeResourceInput, type WebExposeResource } from "../src/lib/web-expose-media";
import { readWebExposeUploadForm, validateWebExposeUpload, validateWebExposeVideoContent } from "../src/lib/web-expose-media-validation";
import { archiveWebExposeResource, getWebExposeResourceFile, loadWebExposeMedia, saveWebExposeResource, uploadWebExposeResource } from "../src/lib/web-expose-media-repository";
import { getPrivateMediaBlobToken, mediaAssetPath, saveLeadProofFile, type MediaAsset } from "../src/lib/media-store";
import { deleteDatabaseMedia } from "../src/lib/media-lifecycle";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC", "base64");
const linkInput = { kind: "external_link", assetId: null, url: "https://example.invalid/property-tour", title: "Synthetic tour", position: 0, visibility: "private", status: "draft" };
test("resources validate HTTPS destinations, exact file/link combinations and explicit publication states", () => {
  assert.equal(normalizeWebExposeResourceUrl("https://example.invalid/tour?q=apartment"), "https://example.invalid/tour?q=apartment");
  for (const url of ["javascript:alert(1)", "http://example.invalid", "https://127.0.0.1/", "https://[::1]/", "https://user:pass@example.invalid", "https://crm.internal/x", "https://example.invalid/?access_token=secret"]) assert.equal(normalizeWebExposeResourceUrl(url), null, url);
  assert.equal(parseWebExposeResourceInput(linkInput).kind, "external_link");
  assert.throws(() => parseWebExposeResourceInput({ ...linkInput, assetId: "invalid" }));
  assert.throws(() => parseWebExposeResourceInput({ ...linkInput, visibility: "published" }));
  assert.throws(() => parseWebExposeResourceInput({ ...linkInput, kind: "document" }));
});
test("uploads decode images, parse static PDF and reject executable/malformed or oversized files", async () => {
  assert.deepEqual(await validateWebExposeUpload(new File([Uint8Array.from(png)], "synthetic.png", { type: "image/png" }), "image"), new Uint8Array(png));
  await assert.rejects(validateWebExposeUpload(new File(["not a PNG"], "synthetic.png", { type: "image/png" }), "image"));
  await assert.rejects(validateWebExposeUpload(new File([new Uint8Array(4194305)], "synthetic.png", { type: "image/png" }), "image"));
  const pdf = await PDFDocument.create(); pdf.addPage([200, 200]);
  const pdfBytes = await pdf.save(); assert.ok((await validateWebExposeUpload(new File([Uint8Array.from(pdfBytes)], "floorplan.pdf", { type: "application/pdf" }), "floorplan")).length > 0);
  await assert.rejects(validateWebExposeUpload(new File(["%PDF-1.7\nmalformed\n%%EOF"], "bad.pdf", { type: "application/pdf" }), "document"));
  const atom = (type: string, content: Buffer) => { const bytes = Buffer.alloc(content.length + 8); bytes.writeUInt32BE(bytes.length); bytes.write(type, 4); content.copy(bytes, 8); return bytes; };
  const mp4 = Buffer.concat([atom("ftyp", Buffer.from("isom0000isom")), atom("moov", Buffer.from("synthetic-vide-track")), atom("mdat", Buffer.alloc(32))]);
  assert.equal(validateWebExposeVideoContent(mp4, "video/mp4"), true); assert.equal(validateWebExposeVideoContent(mp4.subarray(0, 32), "video/mp4"), false);
  assert.equal(validateWebExposeVideoContent(Buffer.from("fake-webm"), "video/webm"), false);
  const form = new FormData(); form.set("file", new File([Uint8Array.from(png)], "synthetic.png", { type: "image/png" })); form.set("kind", "image"); form.set("title", "Synthetic");
  assert.equal((await readWebExposeUploadForm(new Request("https://example.invalid", { method: "POST", body: form }))).get("title"), "Synthetic");
  await assert.rejects(readWebExposeUploadForm(new Request("https://example.invalid", { method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "99999999" } })), /UPLOAD_TOO_LARGE/);
});
test("resource upload, review, private preview and public revocation are real scoped database operations", { timeout: 180000 }, async (t) => {
  // Tests never touch a configured remote object store.
  assert.equal(Boolean(getPrivateMediaBlobToken() || process.env.BLOB_READ_WRITE_TOKEN || process.env.NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN || process.env.VERCEL === "1"), false, "Run these fixtures with local private media storage only");
  const db = await startLocalSalesDb(), files: string[] = [];
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    for (const name of ["155_web_expose.sql", "159_lead_qualification.sql", "163_web_expose_resources.sql"]) await db.admin.query(await readFile(`migrations/${name}`, "utf8"));
    // Generic sales fixtures deliberately omit the independently gated Studio cutover.
    // Install its empty FK dependency and its unchanged production counter only;
    // this does not claim that the complete Studio gateway migration was exercised.
    await db.admin.query(`alter table media_assets add column studio_enquiry_operation_id uuid,add unique(id,workspace_id,studio_enquiry_operation_id);
      create table studio_enquiry_assets(media_asset_id uuid,workspace_id text,operation_id uuid,
       foreign key(media_asset_id,workspace_id,operation_id) references media_assets(id,workspace_id,studio_enquiry_operation_id));`);
    const studioSql = await readFile("migrations/100_studio_enquiry_production.sql", "utf8");
    await db.admin.query(studioSql.slice(studioSql.indexOf("create function public.crm_studio_media_reference_counts")));
    const workspaceId = randomUUID(), userId = randomUUID(), viewerId = randomUUID(), projectId = randomUUID(), hiddenProject = randomUUID(), contactId = randomUUID(), leadId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC media','self_service_customer','real_estate_broker')", [workspaceId]);
    for (const [id, role, productRole] of [[userId, "owner", "customer_owner"], [viewerId, "agent", "broker_agent"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic',$3,$4,$5,'active')", [id, workspaceId, `media-${id}@example.invalid`, role, productRole]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC project','Service'),($3,$2,'SYNTHETIC hidden','Service')", [projectId, workspaceId, hiddenProject]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [workspaceId, projectId, viewerId]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role) values($1,$2,$3,'Synthetic','Käufer')", [contactId, workspaceId, projectId]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status) values($1,$2,$3,$4,$5,'Website','Käufer','Neu')", [leadId, workspaceId, projectId, contactId, userId]);
    const session = { authenticated: true, userId, workspaceId, workspaceName: "Synthetic", name: "Synthetic", email: `media-${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
    const viewer = { ...session, userId: viewerId, role: "agent", productRole: "broker_agent", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("broker_agent") } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool }, run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    const saved = await run((_tx, scoped) => createSellerListingRecord({ session: scoped, property: { title: "SYNTHETIC media property", address: "Synthetic street 1", region: "Wien", geography: createPropertyGeography("AT", "Wien"), energyCertificate: { version: 1, countryCode: "AT", heatingDemandKwhM2: 32, finalEnergyDemandKwhM2: 50, energyClass: "B" }, areaSqm: 80, rooms: 3, yearBuilt: 2000, price: 100000, usageType: "residential", objectType: "Wohnung", projectId } }));
    assert.ok(saved.persisted, JSON.stringify(saved)); if (!saved.persisted) return; const propertyId = saved.data.id;
    const snapshotInput: WebExposePublishInput = { propertyId, language: "de", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal", controller: "Synthetic", showAddress: false, showContact: false, reviewed: true, resourceIds: [], includeLegacyMedia: false };
    let uploaded: WebExposeResource, tour: WebExposeResource;
    const registerFile = async (assetId: string) => {
      const asset = (await db.admin.query('select id,workspace_id as "workspaceId",relative_path as "relativePath",storage_provider as "storageProvider" from media_assets where id=$1', [assetId])).rows[0] as MediaAsset;
      const file = mediaAssetPath(asset); assert.ok(file.startsWith(path.resolve(".data/media/uploads") + path.sep)); files.push(file);
    };
    await t.test("direct upload saves private bytes and idempotent replay returns the same resource", async () => {
      const input = { propertyId, kind: "image" as const, title: "Synthetic image caption", file: new File([Uint8Array.from(png)], "synthetic.png", { type: "image/png" }), idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const result = await uploadWebExposeResource(session, input, options); uploaded = result.data; assert.ok(uploaded.assetId); await registerFile(uploaded.assetId!);
      assert.equal(uploaded.status, "draft"); assert.equal(uploaded.visibility, "private"); assert.equal(uploaded.mimeType, "image/png"); assert.equal(uploaded.contentHash?.length, 64);
      const replay = await uploadWebExposeResource(session, input, options); assert.equal(replay.replayed, true); assert.equal(replay.data.id, uploaded.id);
      const preview = await run((tx, scoped) => getWebExposeResourceFile(tx, scoped, propertyId, uploaded.id)); assert.deepEqual(preview.content.body, png);
      await assert.rejects(run((tx, scoped) => buildWebExposeSnapshot(tx, scoped, { ...snapshotInput, resourceIds: [uploaded.id] })), /freigegeben/);
    });
    await t.test("approval requires review, CAS prevents lost updates and selection order enters the published snapshot", async () => {
      const fileInput = { kind: uploaded.kind, assetId: uploaded.assetId, url: null, title: uploaded.title, position: 0, visibility: "published", status: "approved" };
      await assert.rejects(run((tx, scoped) => saveWebExposeResource(tx, scoped, propertyId, fileInput, { resourceId: uploaded.id, expectedRevision: 1 })), /ausdrücklich prüfen/);
      uploaded = await run((tx, scoped) => saveWebExposeResource(tx, scoped, propertyId, fileInput, { resourceId: uploaded.id, expectedRevision: 1, reviewed: true }));
      await assert.rejects(run((tx, scoped) => saveWebExposeResource(tx, scoped, propertyId, fileInput, { resourceId: uploaded.id, expectedRevision: 1, reviewed: true })), /geändert/);
      tour = await run((tx, scoped) => saveWebExposeResource(tx, scoped, propertyId, { ...linkInput, status: "approved", visibility: "published" }, { reviewed: true }));
      snapshotInput.resourceIds = [tour.id, uploaded.id];
      const built = await run((tx, scoped) => buildWebExposeSnapshot(tx, scoped, snapshotInput)); assert.deepEqual(built.snapshot.resources?.map((item) => item.id), [tour.id, uploaded.id]);
      const published = await run((tx, scoped) => publishWebExpose(tx, scoped, { ...snapshotInput, expectedSourceFingerprint: built.sourceFingerprint }));
      const hash = webExposeHash(published.path.split("/").at(-1)!);
      const read = async () => (await db.pool.query("select crm_web_expose_live_resources($1) as data", [hash])).rows[0].data as WebExposeResource[];
      assert.deepEqual((await read()).map((item) => item.id), [tour.id, uploaded.id]);
      assert.ok((await db.pool.query("select crm_web_expose_asset($1,$2::uuid) as data", [hash, uploaded.assetId])).rows[0].data);
      const attachmentId = randomUUID();
      await db.admin.query("insert into property_media(id,workspace_id,project_id,property_id,media_asset_id,media_type,title,category,visibility,status) values($1,$2,$3,$4,$5,'image','Synthetic reclassification','general','private','draft')", [attachmentId, workspaceId, projectId, propertyId, uploaded.assetId]);
      for (const category of ["internal", "contract", "funding", "proof"]) {
        await db.admin.query("update property_media set category=$2 where id=$1", [attachmentId, category]);
        assert.deepEqual((await read()).map((item) => item.id), [tour.id], `Later ${category} classification must immediately revoke resource visibility`);
        assert.equal((await db.pool.query("select crm_web_expose_asset($1,$2::uuid) as data", [hash, uploaded.assetId])).rows[0].data, null);
      }
      await db.admin.query("update property_media set category='general' where id=$1", [attachmentId]);
      const documentId = randomUUID();
      await db.admin.query("insert into property_documents(id,workspace_id,project_id,property_id,media_asset_id,title,category,visibility,status) values($1,$2,$3,$4,$5,'Synthetic internal attachment','internal','private','draft')", [documentId, workspaceId, projectId, propertyId, uploaded.assetId]);
      assert.deepEqual((await read()).map((item) => item.id), [tour.id]);
      assert.equal((await db.pool.query("select crm_web_expose_asset($1,$2::uuid) as data", [hash, uploaded.assetId])).rows[0].data, null);
      await db.admin.query("delete from property_documents where id=$1", [documentId]);
      await db.admin.query("delete from property_media where id=$1", [attachmentId]);
      tour = await run((tx, scoped) => saveWebExposeResource(tx, scoped, propertyId, { ...linkInput, title: tour.title, url: "https://example.invalid/new-tour", status: "approved", visibility: "published" }, { resourceId: tour.id, expectedRevision: tour.revision, reviewed: true }));
      assert.deepEqual((await read()).map((item) => item.id), [uploaded.id], "Changing a destination must not silently replace a frozen public URL");
      await run((tx, scoped) => archiveWebExposeResource(tx, scoped, propertyId, uploaded.id, uploaded.revision));
      assert.deepEqual(await read(), []); assert.equal((await db.pool.query("select crm_web_expose_asset($1,$2::uuid) as data", [hash, uploaded.assetId])).rows[0].data, null);
      await assert.rejects(run((tx, scoped) => getWebExposeResourceFile(tx, scoped, propertyId, uploaded.id)), /nicht verfügbar/);
      await db.admin.query("update web_expose_links set revoked_at=now() where id=$1", [published.linkId]); assert.deepEqual(await read(), []);
    });
    await t.test("legacy gallery metadata and offered sections disappear immediately after internal reclassification", async () => {
      const attachmentId=randomUUID();
      await db.admin.query("insert into property_media(id,workspace_id,project_id,property_id,media_asset_id,media_type,title,category,visibility,status) values($1,$2,$3,$4,$5,'image','SENSITIVE-LEGACY-CAPTION','general','public','approved')",[attachmentId,workspaceId,projectId,propertyId,uploaded.assetId]);
      const input={...snapshotInput,includeLegacyMedia:true,resourceIds:[]};
      const built=await run((tx,scoped)=>buildWebExposeSnapshot(tx,scoped,input));assert.equal(built.snapshot.media.length,1);
      const published=await run((tx,scoped)=>publishWebExpose(tx,scoped,{...input,expectedSourceFingerprint:built.sourceFingerprint}));
      const hash=webExposeHash(published.path.split('/').at(-1)!);
      const read=async()=>(await db.pool.query("select crm_web_expose_lookup($1) as data",[hash])).rows[0].data;
      assert.equal((await read()).snapshot.media.length,1);
      for(const category of ['internal','proof','contract','funding']){
        await db.admin.query("update property_media set category=$2 where id=$1",[attachmentId,category]);
        assert.deepEqual((await read()).snapshot.media,[]);
        assert.doesNotMatch(JSON.stringify(await read()),/SENSITIVE-LEGACY-CAPTION/);
        assert.equal((await db.pool.query("select crm_web_expose_asset($1,$2) as data",[hash,uploaded.assetId])).rows[0].data,null);
        const preview=await run((tx,scoped)=>buildWebExposeSnapshot(tx,scoped,input));assert.deepEqual(preview.snapshot.media,[]);
        const sessionHash=webExposeHash(randomUUID());
        assert.equal((await db.pool.query("select crm_web_expose_start($1,$2,$3) as ok",[hash,sessionHash,webExposeHash(randomUUID())])).rows[0].ok,true);
        const sections=(await db.admin.query("select offered_sections from web_expose_sessions where token_hash=$1",[sessionHash])).rows[0].offered_sections;
        assert.equal(sections.includes('gallery'),false);
      }
      await db.admin.query("delete from property_media where id=$1",[attachmentId]);
    });
    await t.test("RLS enforces project read/write separately and private proof files never enter marketing", async () => {
      const state = await run((tx, scoped) => loadWebExposeMedia(tx, scoped, propertyId), viewer); assert.equal(state.canEdit, false); assert.equal(state.resources.length, 1);
      await assert.rejects(run((tx, scoped) => saveWebExposeResource(tx, scoped, propertyId, linkInput), viewer));
      const proof = await run((_tx, scoped) => saveLeadProofFile({ workspaceId, actorId: scoped.userId, leadId, file: new File([Uint8Array.from(png)], "proof.png", { type: "image/png" }) })); await registerFile(proof.id);
      await assert.rejects(run((tx, scoped) => saveWebExposeResource(tx, scoped, propertyId, { kind: "image", assetId: proof.id, url: null, title: "Forbidden proof", position: 0, status: "draft", visibility: "private" })), /private Marketingdatei/);
      await assert.rejects(run((tx) => tx.query("insert into web_expose_resources(workspace_id,property_id,kind,asset_id,title,created_by) values($1,$2,'image',$3,'Forbidden proof',$4)", [workspaceId, propertyId, proof.id, userId])), /protected evidence|private marketing/i);
      const ownerState = await run((tx, scoped) => loadWebExposeMedia(tx, scoped, propertyId)); assert.equal(ownerState.library.some((entry) => entry.assetId === proof.id), false);
      await db.admin.query("update project_pipeline_permissions set can_read=false where user_id=$1", [viewerId]);
      await assert.rejects(run((tx, scoped) => loadWebExposeMedia(tx, scoped, propertyId), viewer));
      assert.equal((await db.pool.query("select count(*)::int as n from web_expose_resources")).rows[0].n, 0);
    });
    await t.test("reference counting protects archived public resources before any physical deletion", async () => {
      const row = (await db.admin.query('select id,workspace_id as "workspaceId",folder,storage_access as "storageAccess",is_public as "isPublic" from media_assets where id=$1', [uploaded.assetId])).rows[0] as MediaAsset;
      let deleted = false;
      await assert.rejects(deleteDatabaseMedia({ assetId: uploaded.assetId!, workspaceId, actorId: userId, assetSelect: 'ma.id,ma.workspace_id as "workspaceId",ma.folder,ma.storage_access as "storageAccess",ma.is_public as "isPublic",ma.public_token as "publicToken"', normalizeAsset: () => row, deleteFile: async () => { deleted = true; }, pool: options.pool }), { code: "MEDIA_DELETE_IN_USE" });
      assert.equal(deleted, false);
      const counts = await run((tx) => tx.queryOne<{ resource_count: number }>("select * from crm_web_expose_media_reference_counts($1)", [uploaded.assetId])); assert.equal(counts?.resource_count, 1);
    });
  } finally { for (const file of files) await unlink(file).catch(() => undefined); await db.stop(); }
});
