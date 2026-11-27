import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { AppSession } from "../src/lib/auth/session";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { createSellerListingRecord } from "../src/lib/db/property-department-repositories";
import { createPropertyGeography } from "../src/lib/property-country";
import { uploadWebExposeBrandAsset, readWebExposeBrandAssets, revokeWebExposeBrandAsset } from "../src/lib/db/web-expose-brand-repository";
import { saveWebExposeTemplate, freezeWebExposeTemplate } from "../src/lib/db/web-expose-template-repository";
import { webExposeTemplateSections, parseFrozenWebExposeTemplate } from "../src/lib/web-expose-templates";
import { buildWebExposeSnapshot, publishWebExpose, lookupWebExpose, type WebExposePublishInput } from "../src/lib/db/web-expose-repository";
import { uploadWebExposeResource, saveWebExposeResource } from "../src/lib/web-expose-media-repository";
import { buildPublicWebExposePdf, WebExposePdfError } from "../src/lib/web-expose-pdf";
import { getPrivateMediaBlobToken, mediaAssetPath, readMediaAssetContent, saveLeadProofFile, type MediaAsset } from "../src/lib/media-store";
import { deleteDatabaseMedia, MediaLifecycleError } from "../src/lib/media-lifecycle";
import { GET as publicMedia } from "../src/app/api/public/exposes/[token]/media/[assetId]/route";

const meta = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
const file = (bytes: Uint8Array, name: string) => new File([Uint8Array.from(bytes)], name, { type: "image/png" });

test("company artwork remains private, versioned and revocable across actual publication, web and PDF", { timeout: 180000 }, async t => {
  assert.equal(Boolean(getPrivateMediaBlobToken() || process.env.BLOB_READ_WRITE_TOKEN || process.env.NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN || process.env.VERCEL === "1"), false, "Synthetic fixture requires local storage");
  const db = await startLocalSalesDb(), files: string[] = [];
  const previous = Object.fromEntries(["NODE_ENV", "DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_AUTH_ENCRYPTION_KEY"].map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    for (const name of ["155_web_expose.sql", "159_lead_qualification.sql", "163_web_expose_resources.sql", "166_web_expose_live_inventory.sql", "175_web_expose_templates.sql", "184_web_expose_brand_layout.sql"]) await db.admin.query(await readFile(`migrations/${name}`, "utf8"));
    // The generic fixture deliberately omits the separate Studio cutover. Install
    // only its empty media-reference dependency, as in existing media DB checks.
    await db.admin.query(`alter table media_assets add column studio_enquiry_operation_id uuid,add unique(id,workspace_id,studio_enquiry_operation_id);
      create table studio_enquiry_assets(media_asset_id uuid,workspace_id text,operation_id uuid,
      foreign key(media_asset_id,workspace_id,operation_id) references media_assets(id,workspace_id,studio_enquiry_operation_id));`);
    const studio = await readFile("migrations/100_studio_enquiry_production.sql", "utf8");
    await db.admin.query(studio.slice(studio.indexOf("create function public.crm_studio_media_reference_counts")));
    const workspaceId = randomUUID(), userId = randomUUID(), staffId = randomUUID(), foreignWorkspace = randomUUID(), foreignUser = randomUUID(), projectId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Artwork','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')", [workspaceId, foreignWorkspace]);
    for (const [id, w, role, product] of [[userId, workspaceId, "owner", "customer_owner"], [staffId, workspaceId, "agent", "broker_agent"], [foreignUser, foreignWorkspace, "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC User',$3,$4,$5,'active')", [id, w, `${id}@example.invalid`, role, product]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Layout project','Service')", [projectId, workspaceId]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspaceId, projectId, staffId]);
    const session: AppSession = { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC Artwork", name: "SYNTHETIC Owner", email: "owner@example.invalid", role: "owner", productRole: "customer_owner", permissions: [], productPermissions: [] };
    const staff: AppSession = { ...session, userId: staffId, role: "agent", productRole: "broker_agent" };
    const foreign: AppSession = { ...session, userId: foreignUser, workspaceId: foreignWorkspace };
    const options = { pool: db.pool as unknown as TenantPool };
    const run = <T>(callback: (tx: TenantTransaction, fresh: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, callback, options);
    Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_AUTH_ENCRYPTION_KEY: "synthetic-company-artwork-key-only" });
    const logoBytes = await sharp(Buffer.from('<svg width="480" height="120"><rect width="480" height="120" rx="12" fill="#164e63"/><text x="28" y="78" font-family="sans-serif" font-size="46" fill="white">SYNTHETIC</text></svg>')).png().toBuffer();
    const letterBytes = await sharp(Buffer.from('<svg width="840" height="1188"><rect width="840" height="1188" fill="#f6f3ec"/><rect width="840" height="72" fill="#164e63"/><rect y="1128" width="840" height="60" fill="#164e63"/><path d="M0 350L180 0M0 550L290 0" stroke="#e8dac1" stroke-width="45"/></svg>')).png().toBuffer();
    const picture = await sharp(Buffer.from('<svg width="1000" height="700"><rect width="1000" height="700" fill="#d4c6ad"/><path d="M0 500L500 80L1000 500" fill="#667b7a"/><rect x="200" y="500" width="600" height="200" fill="#f6f3ec"/><rect x="440" y="490" width="130" height="210" fill="#164e63"/></svg>')).png().toBuffer();
    const track = async (assetId: string) => {
      const asset = (await db.admin.query('select id,workspace_id as "workspaceId",relative_path as "relativePath",storage_provider as "storageProvider" from media_assets where id=$1', [assetId])).rows[0] as MediaAsset;
      const target = mediaAssetPath(asset);
      assert.ok(target.startsWith(path.resolve(".data/media/uploads") + path.sep)); files.push(target);
    };
    let logoId = "", letterId = "";
    await t.test("new raster upload needs review and manager rights; replay stores bytes only once", async () => {
      await assert.rejects(uploadWebExposeBrandAsset(session, { file: file(logoBytes, "synthetic-logo.png"), purpose: "logo", reviewed: false }, meta(), options));
      await assert.rejects(uploadWebExposeBrandAsset(session, { file: file(Buffer.from("invalid"), "synthetic-logo.png"), purpose: "logo", reviewed: true }, meta(), options));
      await assert.rejects(uploadWebExposeBrandAsset(staff, { file: file(logoBytes, "synthetic-logo.png"), purpose: "logo", reviewed: true }, meta(), options));
      const input = { file: file(logoBytes, "synthetic-logo.png"), purpose: "logo" as const, reviewed: true }, metadata = meta();
      const logo = await uploadWebExposeBrandAsset(session, input, metadata, options), replay = await uploadWebExposeBrandAsset(session, input, metadata, options);
      logoId = logo.data.id; await track(logoId); assert.equal(replay.data.id, logoId); assert.equal(replay.replayed, true);
      letterId = (await uploadWebExposeBrandAsset(session, { file: file(letterBytes, "synthetic-letterhead.png"), purpose: "letterhead", reviewed: true }, meta(), options)).data.id; await track(letterId);
      const assets = await readWebExposeBrandAssets(session, options); assert.equal(assets.length, 2); assert.equal(assets.every(asset => asset.approved), true);
      assert.equal((await readWebExposeBrandAssets(foreign, options)).length, 0);
    });
    const property = await run((_tx, fresh) => createSellerListingRecord({ session: fresh, property: { title: "SYNTHETIC Garden residence", address: "Synthetic street 1", region: "Wien", geography: createPropertyGeography("AT", "Wien"), energyCertificate: { version: 1, countryCode: "AT", heatingDemandKwhM2: 32, finalEnergyDemandKwhM2: 50, energyClass: "B" }, areaSqm: 82, rooms: 3, yearBuilt: 2000, price: 395000, usageType: "residential", objectType: "Wohnung", projectId } }));
    assert.ok(property.persisted); if (!property.persisted) return;
    const propertyId = property.data.id, resources: string[] = [];
    for (let index = 0; index < 4; index++) {
      const upload = await uploadWebExposeResource(session, { propertyId, kind: "image", file: file(picture, `synthetic-photo-${index}.png`), title: `SYNTHETIC Image ${index + 1}`, ...meta() }, options);
      await track(upload.data.assetId!);
      const r = upload.data;
      const approved = await run((tx, fresh) => saveWebExposeResource(tx, fresh, propertyId, { kind: r.kind, assetId: r.assetId, url: null, title: r.title, position: index, visibility: "published", status: "approved" }, { resourceId: r.id, expectedRevision: r.revision, reviewed: true }));
      resources.push(approved.id);
    }
    let publishedToken = "", versionId = "", frozenBefore = "";
    const output = path.resolve("qa/livelisted-marketing-implementation-2026-11-04/brand-layouts"); await mkdir(output, { recursive: true });
    await t.test("all three layouts freeze approved artwork and generate readable linked PDFs from actual public links", async () => {
      for (const [layout, language, grid] of [["classic", "de", 1], ["editorial", "en", 2], ["compact", "es", 3]] as const) {
        const configuration = { schemaVersion: 1, name: `SYNTHETIC ${layout}`, companyName: "SYNTHETIC Property Group", accentColor: "#164e63", sectionOrder: [...webExposeTemplateSections], layout, imageGrid: grid, logoAssetId: logoId, letterheadAssetId: letterId };
        const saved = await saveWebExposeTemplate(session, { id: null, expectedRevision: null, configuration }, meta(), options);
        const frozen = await run((tx, fresh) => freezeWebExposeTemplate(tx, fresh, saved.data.versionId), staff);
        assert.ok(frozen); assert.equal(frozen.brandAssets?.length, 2);
        const input: WebExposePublishInput = { propertyId, language, title: "SYNTHETIC Garden residence", description: "SYNTHETIC QA property with approved artwork, a calm image gallery and a clear enquiry route. The company layout remains fixed to this publication while media access is checked again for every request.", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal", controller: "SYNTHETIC Property Group", showAddress: false, showContact: true, reviewed: true, resourceIds: resources, includeLegacyMedia: false, templateVersionId: saved.data.versionId };
        const preview = await run((tx, fresh) => buildWebExposeSnapshot(tx, fresh, input));
        const published = await run((tx, fresh) => publishWebExpose(tx, fresh, { ...input, expectedSourceFingerprint: preview.sourceFingerprint }));
        const token = published.path.split("/").at(-1)!;
        const live = await lookupWebExpose(token); assert.ok(live); assert.equal(live.snapshot.template?.layout, layout); assert.equal(live.snapshot.template?.imageGrid, grid);
        const previewData = path.join(output, `SYNTHETIC-${layout}-${language}.json`);
        const htmlPath = path.join(output, `SYNTHETIC-${layout}-${language}.html`);
        await writeFile(previewData, JSON.stringify({ data: live, token }));
        execFileSync(process.execPath, ["--import", "tsx", "scripts/lib/render-web-expose-preview.tsx", previewData, htmlPath], { cwd: process.cwd(), windowsHide: true, stdio: "pipe" });
        const html = await readFile(htmlPath, "utf8");
        assert.match(html, new RegExp(`data-expose-layout="${layout}"`)); assert.match(html, new RegExp(`/media/${logoId}`));
        const media = await publicMedia(new Request(`http://localhost/api/public/exposes/${token}/media/${logoId}`), { params: Promise.resolve({ token, assetId: logoId }) });
        assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), logoBytes);
        const pdf = await buildPublicWebExposePdf(token, { origin: "https://synthetic.example.invalid" });
        const parsed = await PDFDocument.load(pdf.bytes); assert.ok(parsed.getPageCount() >= 2); assert.equal(parsed.getAuthor(), "SYNTHETIC Property Group");
        await writeFile(path.join(output, `SYNTHETIC-${layout}-${language}.pdf`), pdf.bytes);
        await writeFile(path.join(output, `SYNTHETIC-${layout}-${language}.html`), html);
        publishedToken = token; versionId = saved.data.versionId; frozenBefore = JSON.stringify(live.snapshot.template);
        await saveWebExposeTemplate(session, { id: saved.data.id, expectedRevision: 1, configuration: { ...configuration, name: "SYNTHETIC Revised", companyName: "SYNTHETIC Later Company", layout: "compact" } }, meta(), options);
        assert.equal(JSON.stringify((await lookupWebExpose(token))?.snapshot.template), frozenBefore);
      }
    });
    await t.test("unbound, foreign and private document IDs cannot be smuggled into a frozen company template", async () => {
      await assert.rejects(saveWebExposeTemplate(foreign, { id: null, expectedRevision: null, configuration: { schemaVersion: 1, name: "SYNTHETIC Foreign", companyName: "SYNTHETIC", accentColor: "#164e63", sectionOrder: [...webExposeTemplateSections], logoAssetId: logoId } }, meta(), options));
      const template = JSON.parse(frozenBefore);
      assert.throws(() => parseFrozenWebExposeTemplate({ ...template, brandAssets: [] }));
      assert.throws(() => parseFrozenWebExposeTemplate({ ...template, brandAssets: [template.brandAssets[0], template.brandAssets[0]] }));
      assert.equal(await run(tx => tx.queryOne("update web_expose_brand_assets set approved=false,revision=revision+1 where asset_id=$1::uuid returning asset_id", [logoId]), staff), null);
      assert.equal((await readWebExposeBrandAssets(session, options)).find(asset => asset.assetId === logoId)?.approved, true);
      const privateContact = randomUUID(), privateLead = randomUUID();
      await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC Private proof owner','Käufer')", [privateContact, workspaceId, projectId]);
      await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status) values($1,$2,$3,$4,$5,'Website','Käufer','Neu')", [privateLead, workspaceId, projectId, privateContact, userId]);
      const privateProof = await run(() => saveLeadProofFile({ actorId: userId, workspaceId, leadId: privateLead, file: file(logoBytes, "SYNTHETIC-private-proof.png") }));
      const privateId = privateProof.id; await track(privateId);
      await assert.rejects(saveWebExposeTemplate(session, { id: null, expectedRevision: null, configuration: { schemaVersion: 1, name: "SYNTHETIC Invalid proof", companyName: "SYNTHETIC", accentColor: "#164e63", sectionOrder: [...webExposeTemplateSections], logoAssetId: privateId } }, meta(), options));
      const wrong = await publicMedia(new Request("http://localhost/"), { params: Promise.resolve({ token: "X".repeat(43), assetId: logoId }) }); assert.equal(wrong.status, 404);
      let fileDeletionCalled = false;
      await assert.rejects(deleteDatabaseMedia({ assetId: logoId, workspaceId, actorId: userId, pool: db.pool as unknown as TenantPool, assetSelect: 'ma.id,ma.workspace_id as "workspaceId",ma.folder,ma.relative_path as "relativePath",ma.storage_provider as "storageProvider",ma.storage_access as "storageAccess",ma.is_public as "isPublic",ma.public_token as "publicToken"', normalizeAsset: row => row as MediaAsset, deleteFile: async () => { fileDeletionCalled = true; } }), error => error instanceof MediaLifecycleError && error.code === "MEDIA_DELETE_IN_USE");
      assert.equal(fileDeletionCalled, false);
    });
    await t.test("the extended media reference protocol still deletes an unreferenced ordinary asset", async () => {
      const ordinary = randomUUID();
      await db.admin.query("insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public) values($1,$2,'SYNTHETIC Unreferenced','unreferenced.png','marketing','image/png',1,'','synthetic-only','local','private',false)", [ordinary, workspaceId]);
      let fileDeletionCalled = false;
      const removed = await deleteDatabaseMedia({ assetId: ordinary, workspaceId, actorId: userId, pool: db.pool as unknown as TenantPool, assetSelect: 'ma.id,ma.workspace_id as "workspaceId",ma.folder,ma.relative_path as "relativePath",ma.storage_provider as "storageProvider",ma.storage_access as "storageAccess",ma.is_public as "isPublic",ma.public_token as "publicToken"', normalizeAsset: row => row as MediaAsset, deleteFile: async () => { fileDeletionCalled = true; } });
      assert.equal(removed?.id, ordinary); assert.equal(fileDeletionCalled, true);
      assert.equal((await db.admin.query("select id from media_assets where id=$1", [ordinary])).rowCount, 0);
    });
    await t.test("revocation removes artwork from old links and new PDF fetches without changing historical publication", async () => {
      await revokeWebExposeBrandAsset(session, logoId, 1, meta(), options);
      const response = await publicMedia(new Request("http://localhost/"), { params: Promise.resolve({ token: publishedToken, assetId: logoId }) }); assert.equal(response.status, 404);
      const row = await run(tx => tx.queryOne<{ allowed: boolean }>("select crm_brand_asset_allowed($1::uuid,$2::uuid,'logo') as allowed", [workspaceId, logoId])); assert.equal(row?.allowed, false);
      const data = await lookupWebExpose(publishedToken); assert.ok(data); assert.equal(JSON.stringify(data.snapshot.template), frozenBefore);
      const pdf = await buildPublicWebExposePdf(publishedToken, { origin: "https://synthetic.example.invalid" }); assert.ok(pdf.bytes.byteLength > 1000);
      await assert.rejects(run((tx, fresh) => freezeWebExposeTemplate(tx, fresh, versionId)), /geändert|archiviert|freigegeben/);
      const assets = await readWebExposeBrandAssets(session, options); assert.equal(assets.find(asset => asset.assetId === logoId)?.approved, false);
      assert.equal((await db.admin.query("select data->'template' from (select snapshot as data from web_expose_versions where snapshot->'template'->>'versionId'=$1) versions", [versionId])).rowCount, 1);
    });
    await t.test("a revocation while PDF bytes are being assembled prevents returning an obsolete authorization result", async () => {
      let revoked = false;
      await assert.rejects(buildPublicWebExposePdf(publishedToken, { origin: "https://synthetic.example.invalid", read: async asset => {
        const content = await readMediaAssetContent(asset);
        if (asset.id === letterId && !revoked) { revoked = true; await revokeWebExposeBrandAsset(session, letterId, 1, meta(), options); }
        return content;
      } }), error => error instanceof WebExposePdfError && error.status === 404);
      assert.equal(revoked, true);
    });
    await writeFile(path.join(output, "verification.json"), JSON.stringify({ syntheticOnly: true, generatedLayouts: ["classic-de", "editorial-en", "compact-es"], checks: "Actual uploads, approved immutable template versions, private preview, public image response, public PDF, fixed publication after later edit, original IDs, revoke and deletion reference guard" }, null, 2));
  } finally {
    await closeLocalTestPool();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const target of files) await unlink(target).catch(() => undefined);
    await db.stop();
  }
});
