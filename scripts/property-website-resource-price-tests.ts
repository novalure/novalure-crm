import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { applySalesSchema } from "./lib/local-sales-db.mjs";
import { startReachabilityDb } from "./lib/property-reachability-local-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { GET as mediaGet } from "../src/app/api/public/exposes/[token]/media/[assetId]/route";
import { getRolePermissions } from "../src/lib/auth/permissions";
import type { AppSession } from "../src/lib/auth/session";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { attachPropertyDocument, createSellerListingRecord } from "../src/lib/db/property-department-repositories";
import { buildWebExposeSnapshot, lookupWebExpose, publishWebExpose, webExposeHash, type WebExposePublishInput } from "../src/lib/db/web-expose-repository";
import { getPrivateMediaBlobToken } from "../src/lib/media-store";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createPropertyGeography } from "../src/lib/property-country";
import { mutatePropertyExpose, readPropertyExposePdf } from "../src/lib/property-expose-service";
import { saveWebExposeResource } from "../src/lib/web-expose-media-repository";

test("stored system PDF price approval is enforced for links and floorplans by the public runtime role", { timeout: 180_000 }, async () => {
  assert.equal(Boolean(getPrivateMediaBlobToken() || process.env.BLOB_READ_WRITE_TOKEN || process.env.NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN || process.env.VERCEL === "1"), false);
  const db = await startReachabilityDb();
  const environment = {
    DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,
    NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_AUTH_STRICT: "1",
    NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"),
  };
  const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  try {
    await applySalesSchema(db);
    const fixture = await seedSalesBrowser(db);
    Object.assign(process.env, environment);
    globalThis.fetch = async () => { throw Error("Synthetic local resource tests forbid network fetch"); };
    await db.admin.query("update projects set type='Service',customer_type='real_estate_broker' where id=$1", [fixture.projectId]);
    const session: AppSession = {
      authenticated: true, workspaceId: fixture.workspaceId, userId: fixture.userId, authIdentityId: fixture.authIdentityId,
      workspaceName: "Synthetic", name: "Synthetic", email: fixture.email, role: "owner", productRole: "novalureAdmin",
      permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("novalureAdmin"), source: "database",
    };
    const run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>) => withCrmRead(session, work);
    const created = await run((_tx, scoped) => createSellerListingRecord({ session: scoped, property: {
      projectId: fixture.projectId, title: "Synthetic stored resource policy", address: "Synthetic private address",
      objectType: "Wohnung", usageType: "residential", marketingType: "rent", price: 315000, rentPrice: 1743.21,
      areaSqm: 80, rooms: 3, yearBuilt: 2000, geography: { ...createPropertyGeography("ES", "Andalucía"), displayLocale: "en-IE" },
      priceVisibility: "publish_price", channelPriceVisibility: { "Eigene Website": "publish_price", "Exposé": "publish_price" },
      energyCertificate: { version: 1, countryCode: "ES", certificateType: "existing", energyClass: "B", finalEnergyDemandKwhM2: 51.25 },
    } }));
    assert.ok(created.persisted);
    const propertyId = created.data.id;
    const generate = (expectedRevision: string, showPrice: boolean, floorPlanIds: string[] = []) => run((_tx, scoped) => mutatePropertyExpose(scoped, {
      operation: "generate", propertyId, expectedRevision, confirmed: true,
      options: { template: "compact", language: "es", address: floorPlanIds.length ? "full" : "hidden", showPrice, showContact: false, imageIds: [], floorPlanIds },
    }));
    const priced = await generate("initial", true);
    const priceFree = await generate(priced.data.revision, false);
    const asset = async (documentId: string | undefined) => {
      const result = await db.admin.query("select media_asset_id as id from property_documents where id=$1 and workspace_id=$2 and property_id=$3", [documentId, fixture.workspaceId, propertyId]);
      assert.equal(result.rowCount, 1);
      return String(result.rows[0].id);
    };
    const pricedId = await asset(priced.documentId), priceFreeId = await asset(priceFree.documentId);
    const attachment = await attachPropertyDocument({ session, projectId: fixture.projectId, propertyId, document: {
      mediaAssetId: pricedId, title: "Synthetic embedded historical PDF", category: "floorplan", visibility: "private", status: "draft",
    } });
    assert.ok(attachment.persisted);
    const composed = await generate(priceFree.data.revision, false, [`document:${attachment.data.id}`]);
    assert.ok(composed.documentId);
    const composedId = await asset(composed.documentId);
    const originalComposed = await run((_tx, scoped) => readPropertyExposePdf(scoped, propertyId, composed.documentId!));
    const documentParser = getDocument({ data: Uint8Array.from(originalComposed.bytes), useSystemFonts: false, disableFontFace: true,
      standardFontDataUrl: path.resolve("node_modules/pdfjs-dist/standard_fonts").replaceAll("\\", "/") + "/" });
    try {
      const pdf = await documentParser.promise;
      let text = "";
      for (let page = 1; page <= pdf.numPages; page++) {
        text += (await (await pdf.getPage(page)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ");
      }
      assert.match(text, /€1,743\.21/, "the embedded original contains a price despite the outer generated price field being disabled");
    } finally { await documentParser.destroy(); }
    const approve = (assetId: string, kind: "document" | "floorplan") => run((tx, scoped) => saveWebExposeResource(tx, scoped, propertyId, {
      kind, assetId, url: null, title: `Synthetic ${kind}`, position: 0, visibility: "published", status: "approved",
    }, { reviewed: true }));
    const document = await approve(pricedId, "document"), floorplan = await approve(pricedId, "floorplan"), benign = await approve(priceFreeId, "document");
    const composition = await approve(composedId, "document");
    const publish = async () => {
      const input: WebExposePublishInput = {
        propertyId, language: "es", title: "Synthetic stored resource policy", description: "Synthetic local resource policy",
        controller: "Synthetic", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal",
        reviewed: true, showAddress: false, showContact: false, includeLegacyMedia: false, resourceIds: [document.id, floorplan.id, benign.id, composition.id],
      };
      const preview = await run((tx, scoped) => buildWebExposeSnapshot(tx, scoped, input));
      const result = await run((tx, scoped) => publishWebExpose(tx, scoped, { ...input, expectedSourceFingerprint: preview.sourceFingerprint }));
      return result.path.split("/").at(-1)!;
    };
    const token = await publish();

    // Match the production owner's FORCE RLS constraints in the disposable database.
    await db.admin.query("create role resource_definer_qa nologin nosuperuser nobypassrls inherit; grant usage on schema public to resource_definer_qa");
    for (const table of ["web_expose_versions", "web_expose_links", "web_expose_resources", "web_expose_brand_assets", "seller_listings", "workspace_users",
      "workspaces", "projects", "property_units", "property_media", "property_documents", "media_assets", "media_asset_shares", "knowledge_source_versions"]) {
      await db.admin.query(`alter table public.${table} owner to resource_definer_qa`);
    }
    const functions = (await db.admin.query("select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'crm_web_expose_%' and p.prosecdef")).rows;
    for (const fn of functions) await db.admin.query(`alter function ${fn.signature} owner to resource_definer_qa`);
    await db.admin.query("alter function crm_brand_asset_allowed(uuid,uuid,text,text) owner to resource_definer_qa");

    const media = (assetId: string, range?: string) => mediaGet(new Request(`http://127.0.0.1/api/public/exposes/${token}/media/${assetId}`, {
      headers: range ? { range } : undefined,
    }), { params: Promise.resolve({ token, assetId }) });
    const visible = async () => (await lookupWebExpose(token))?.snapshot.resources?.map(resource => resource.id);
    assert.deepEqual(await visible(), [document.id, floorplan.id, benign.id, composition.id]);
    const publicAsset = await db.pool.query("select crm_web_expose_asset($1,$2::uuid) as data", [webExposeHash(token), pricedId]);
    assert.equal(publicAsset.rows[0].data?.id, pricedId);
    const original = await media(pricedId, "bytes=0-4");
    assert.equal(original.status, 206);
    assert.equal(await original.text(), "%PDF-");
    for (const policy of ["price_on_request", "hide_price"]) {
      await db.admin.query("update seller_listings set channel_price_visibility=jsonb_set(channel_price_visibility,'{Eigene Website}',to_jsonb($2::text)) where id=$1", [propertyId, policy]);
      assert.deepEqual(await visible(), [benign.id]);
      assert.equal((await media(composedId)).status, 404);
      for (const range of [undefined, "bytes=0-4", "invalid"]) {
        const hidden = await media(pricedId, range);
        assert.equal(hidden.status, 404);
        assert.equal(hidden.headers.get("content-range"), null);
        assert.equal((await hidden.arrayBuffer()).byteLength, 0);
      }
      const allowed = await media(priceFreeId, "bytes=0-4");
      assert.equal(allowed.status, 206);
      assert.equal(await allowed.text(), "%PDF-");
    }
    await db.admin.query("update property_documents set metadata='{}'::jsonb where id=$1", [priceFree.documentId]);
    assert.deepEqual((await visible()) ?? [], []);
    assert.equal((await media(priceFreeId)).status, 404, "legacy or mismatched provenance never implies a price-free system PDF");
  } finally {
    globalThis.fetch = oldFetch;
    await closeLocalTestPool();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await db.stop();
  }
});
