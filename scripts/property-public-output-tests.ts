import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createPropertyGeography, type PropertyCountryCode, type PropertyEnergyCertificate } from "../src/lib/property-country";
import { publicPropertyEnergyFacts, publicPropertyEnergySql } from "../src/lib/property-expose-public-content";
import { propertyOptionalPriceIsKnown } from "../src/lib/property-core-numbers";
import { buildPropertyExposeDocument } from "../src/lib/property-expose-service";
import { exposeSourceSql, type ExposeSource } from "../src/lib/db/property-expose-repositories";
import { buildWebExposeSnapshot, lookupWebExpose, webExposeHash, webExposeToken, type WebExposePublishInput } from "../src/lib/db/web-expose-repository";
import { renderPropertyExposePdf } from "../src/lib/property-expose-pdf";
import { renderWebExposePdf } from "../src/lib/web-expose-pdf";
import type { WebExposePublic, WebExposeSnapshot } from "../src/lib/web-expose";

const out = path.resolve(process.env.PROPERTY_OUTPUT_QA_DIR || ".npm-cache/qa/property-public-output");
const hiddenStreet = "SYNTHETIC PRIVATE STREET";
const hiddenAddress = "SYNTHETIC PRIVATE STREET 19, 1010 Wien";
const privateMarker = /PRIVATE-INTERNAL|PRIVATE-OWNER|PRIVATE-REGISTER|PRIVATE-ENERGY-NOTE/;
async function inspect(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl: path.resolve("node_modules/pdfjs-dist/standard_fonts").replaceAll("\\", "/") + "/" });
  const pdf = await task.promise; let text = ""; const pageTexts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) { const page = await pdf.getPage(i); const content = await page.getTextContent(); const pageText = content.items.map(v => "str" in v ? v.str : "").join(" "); pageTexts.push(pageText); text += pageText + "\n"; }
  const pages = pdf.numPages; await task.destroy(); return { text, pages, pageTexts };
}
const energy = (countryCode: PropertyCountryCode): PropertyEnergyCertificate => ({ version: 1, countryCode,
  ...(countryCode === "AT" ? { heatingDemandKwhM2: 32.5, finalEnergyDemandKwhM2: 51.25, overallEfficiencyFactor: 0, energyClass: "B" }
    : countryCode === "DE" ? { certificateType: "consumption", energySource: "SYNTHETIC Heat pump", finalEnergyConsumptionKwhM2: 68.75, heatingEnergyKwhM2: 31.5, electricityEnergyKwhM2: 12.25, energyClass: "C" }
      : countryCode === "ES" ? { certificateType: "completed", finalEnergyDemandKwhM2: 47.5, energyClass: "B", registration: "SYNTHETIC ES-REG-701" }
        : { schemeVersion: "SEAI-2026-05-24", energyClass: "A0", issuedAt: "2026-06-01", validUntil: "2036-06-01", certificateNumber: "123456789", finalEnergyDemandKwhM2: 15.25 }),
  sourceDocumentId: "77777777-7777-4777-8777-777777777777", exemptionReason: "PRIVATE-ENERGY-NOTE" });

test("energy output is country-bound, includes canonical zero and never revives a foreign certificate", () => {
  for (const country of ["AT", "DE", "ES", "IE"] as const) {
    const facts = publicPropertyEnergyFacts(energy(country), country, "de", "de-AT"); assert.ok(facts.length >= 3);
    assert.doesNotMatch(JSON.stringify(facts), /PRIVATE-ENERGY-NOTE|77777777/);
    assert.deepEqual(publicPropertyEnergyFacts(energy(country), country === "AT" ? "DE" : "AT", "de", "de-AT", { energyClass: "STALE" }), []);
  }
  assert.equal(publicPropertyEnergyFacts(energy("AT"), "AT", "de", "de-AT").find(f => f.label === "fGEE")?.value, "0");
  assert.equal(publicPropertyEnergyFacts(null, undefined, "en", "en-IE", { energyClass: "B" })[0].value, "B");
  assert.throws(() => publicPropertyEnergySql("p; drop table anything"));
  assert.equal(propertyOptionalPriceIsKnown({ base: { priceCents: "0" } }, "publicPrice", 0), false);
  assert.equal(propertyOptionalPriceIsKnown({ coreNumericState: { version: 1, price: "unknown" } }, "publicPrice", 0), false);
  assert.equal(propertyOptionalPriceIsKnown({ coreNumericState: { version: 1, price: "unknown", publicPrice: "known" } }, "publicPrice", 0), true);
});

test("public website and both actual PDF paths redact titles, retain country energy and enforce live numeric guards", { timeout: 180000 }, async t => {
  const db = await startLocalSalesDb();
  const htmlJobs: { input: string; output: string }[] = []; const verification: unknown[] = [];
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    for (const name of ["155_web_expose.sql", "163_web_expose_resources.sql", "166_web_expose_live_inventory.sql", "190_property_inventory_knownness.sql"]) await db.admin.query(await readFile("migrations/" + name, "utf8"));
    const workspaceId = randomUUID(), userId = randomUUID(), projectId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC Output QA','self_service_customer','real_estate_broker')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Owner','synthetic@example.invalid','owner','customer_owner','active')", [userId, workspaceId]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Output Project','Service')", [projectId, workspaceId]);
    const session = { authenticated: true, workspaceId, userId, workspaceName: "SYNTHETIC Output QA", name: "Synthetic", email: "synthetic@example.invalid", role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
    const run = <T>(work: (tx: TenantTransaction, fresh: AppSession) => Promise<T>) => withCrmRead(session, work, { pool: db.pool as unknown as TenantPool });
    await mkdir(out, { recursive: true });
    const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#d8e6e1" } }).png().toBuffer();
    const fixtures: { id: string; snapshot: WebExposeSnapshot; source: ExposeSource; resourceId: string }[] = [];
    for (const [country, region] of [["AT", "Wien"], ["DE", "Bayern"], ["ES", "Catalunya"], ["IE", "Dublin"]] as const) {
      const id = randomUUID(), asset = randomUUID(), media = randomUUID(), resourceId = randomUUID();
      const payload = { geography: createPropertyGeography(country, region), energyCertificate: energy(country), coreNumericState: { version: 1, areaSqm: "known", price: "known", unrelated: "PRIVATE-INTERNAL" }, internalNotes: "PRIVATE-INTERNAL", privateOwner: "PRIVATE-OWNER", fieldValues: { "land_register.einlagezahl": "PRIVATE-REGISTER" } };
      await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,city,postal_code,region,object_type,area_sqm,rooms,year_built,target_price_cents,price_visibility,marketing_type,usage_type,canonical_payload,data_classification,data_purpose) values($1,$2,$3,$4,$5,'SYNTHETIC City','1010',$6,'Wohnung',75.25,3.5,2020,34500025,'publish_price','sale','residential',$7::jsonb,'CUSTOMER_TENANT','crm_sales')", [id, workspaceId, projectId, "SYNTHETIC " + hiddenAddress, hiddenAddress, region, JSON.stringify(payload)]);
      await db.admin.query("update seller_listings set street=$2 where id=$1", [id, hiddenStreet]);
      await db.admin.query("insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public) values($1,$2,'SYNTHETIC Image','synthetic.png',$3,'image/png',$4,'','synthetic-only','local','private',false)", [asset, workspaceId, "properties/" + id, png.length]);
      await db.admin.query("insert into property_media(id,workspace_id,project_id,property_id,media_asset_id,media_type,title,category,visibility,status) values($1,$2,$3,$4,$5,'image',$6,'general','public','approved')", [media, workspaceId, projectId, id, asset, "SYNTHETIC image " + hiddenAddress]);
      await run(tx => tx.execute("insert into web_expose_resources(id,workspace_id,property_id,kind,url,title,created_by,status,visibility,approved_by,approved_at) values($1,$2,$3,'external_link','https://example.invalid/tour',$4,$5,'approved','published',$5,now())", [resourceId, workspaceId, id, "SYNTHETIC tour " + hiddenAddress, userId]));
      const source = (await db.admin.query(`select ${exposeSourceSql} as source from seller_listings p where id=$1`, [id])).rows[0].source as ExposeSource;
      assert.doesNotMatch(JSON.stringify(source), privateMarker); assert.doesNotMatch(JSON.stringify(source), /77777777/);
      for (const language of ["de", "en", "es"] as const) await t.test(`${country} ${language} website, web PDF and generated property PDF`, async () => {
        const input: WebExposePublishInput = { propertyId: id, language, title: language === "en" ? "SYNTHETIC custom " + hiddenStreet : undefined, description: "SYNTHETIC description " + hiddenAddress, showAddress: false, showContact: false, reviewed: true, controller: "SYNTHETIC Agency", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal", resourceIds: [resourceId] };
        const built = await run((tx, fresh) => buildWebExposeSnapshot(tx, fresh, input));
        assert.ok(!JSON.stringify(built.snapshot).includes(hiddenStreet)); assert.doesNotMatch(JSON.stringify(built.snapshot), privateMarker);
        assert.equal(built.snapshot.location, "SYNTHETIC City", "a public city remains visible when hiding the saved street");
        const internal = buildPropertyExposeDocument({ propertyId: id, workspaceId, projectId, source, registryRaw: null, registry: { schemaVersion: 1, revision: "initial", preferredSource: "generated", activeDocumentId: null, versions: [] }, sourceFingerprint: "synthetic" }, { template: "full", language, address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [], description: "SYNTHETIC description " + hiddenAddress }, [{ id: media, kind: "image", bytes: png, mimeType: "image/png", caption: "SYNTHETIC image " + hiddenAddress }]);
        const webBytes = await renderWebExposePdf({ snapshot: built.snapshot, images: [{ id: asset, kind: "image", bytes: png, width: 320, height: 180, title: built.snapshot.media[0].title }], plans: [], links: [{ kind: "external_link", title: built.snapshot.resources![0].title, url: "https://example.invalid/tour" }], pageUrl: "https://example.invalid/expose/synthetic" });
        const propertyBytes = await renderPropertyExposePdf(internal);
        const expectedMarker = country === "AT" ? "HWB" : country === "DE" ? "68" : country === "ES" ? "ES-REG-701" : "123456789";
        for (const [kind, bytes] of [["web", webBytes], ["property", propertyBytes]] as const) {
          const parsed = await inspect(bytes); assert.ok(parsed.pages > 0); assert.ok(parsed.text.includes(expectedMarker)); assert.ok(parsed.text.includes("SYNTHETIC"));
          assert.ok(!parsed.text.includes(hiddenStreet)); assert.doesNotMatch(parsed.text, privateMarker);
          if (kind === "web") for (const group of built.snapshot.detailGroups ?? []) {
            const page = parsed.pageTexts.find(p => p.includes(group.heading));
            assert.ok(page?.includes(group.facts[0].label), "public PDF must keep a detail heading with its first fact");
          }
          assert.ok(!(await PDFDocument.load(bytes)).getTitle()?.includes(hiddenAddress));
          await writeFile(path.join(out, `SYNTHETIC-${country}-${language}-${kind}.pdf`), bytes);
          verification.push({ country, language, kind, bytes: bytes.length, pages: parsed.pages, addressHidden: true, canonicalEnergyPresent: true, privateMarkersAbsent: true });
        }
        const data: WebExposePublic = { versionId: randomUUID(), intendedRecipient: false, snapshot: built.snapshot };
        const inputPath = path.join(out, `SYNTHETIC-${country}-${language}.json`), outputPath = path.join(out, `SYNTHETIC-${country}-${language}.html`);
        await writeFile(inputPath, JSON.stringify(data)); htmlJobs.push({ input: inputPath, output: outputPath });
        if (language === "de") fixtures.push({ id, snapshot: built.snapshot, source, resourceId });
      });
    }
    await t.test("actual website HTML inherits redacted property, media and resource titles in all languages", async () => {
      const jobs = path.join(out, "html-jobs.json"); await writeFile(jobs, JSON.stringify(htmlJobs));
      execFileSync(process.execPath, ["--import", "tsx", "scripts/property-public-output-website-render.tsx", jobs], { cwd: process.cwd(), windowsHide: true, timeout: 30000, stdio: "pipe" });
      for (const file of htmlJobs) { const html = await readFile(file.output, "utf8"); assert.ok(!html.includes(hiddenStreet)); assert.doesNotMatch(html, privateMarker); assert.match(html, /SYNTHETIC image|SYNTHETIC tour/); }
    });
    const fixture = fixtures[0], version = randomUUID(), link = randomUUID(), token = webExposeToken(), unit = randomUUID();
    await t.test("both snapshot paths retain explicit zero area and price without publishing unknown zero", async () => {
      for (const state of ["known", "unknown"] as const) {
        await db.admin.query("update seller_listings set area_sqm=0,target_price_cents=0,public_price_cents=null,canonical_payload=jsonb_set(canonical_payload,'{coreNumericState}',jsonb_build_object('version',1,'price',$2::text,'areaSqm',$2::text)) where id=$1", [fixture.id, state]);
        const input: WebExposePublishInput = { propertyId: fixture.id, language: "de", description: "SYNTHETIC", showAddress: false, showContact: false, reviewed: true, controller: "SYNTHETIC", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal" };
        const web = await run((tx, fresh) => buildWebExposeSnapshot(tx, fresh, input));
        const source = (await db.admin.query(`select ${exposeSourceSql} as source from seller_listings p where id=$1`, [fixture.id])).rows[0].source;
        const doc = buildPropertyExposeDocument({ propertyId: fixture.id, workspaceId, projectId, source, registryRaw: null, registry: { schemaVersion: 1, revision: "initial", preferredSource: "generated", activeDocumentId: null, versions: [] }, sourceFingerprint: "synthetic" }, { template: "full", language: "de", address: "hidden", showPrice: state === "known", showContact: false, imageIds: [], floorPlanIds: [] }, []);
        assert.equal(Boolean(web.snapshot.price?.includes("0,00")), state === "known");
        assert.equal(web.snapshot.facts.some(f => f.label === "Wohnfläche" && f.value === "0 m²"), state === "known");
        assert.equal(doc.facts.some(f => f.label === "Fläche" && f.value === "0 m²"), state === "known");
        assert.equal(Boolean(doc.price?.includes("0,00")), state === "known");
      }
    });
    fixture.snapshot.units = [{ id: unit, number: "SYNTHETIC A1", area: "75", rooms: "3", price: null, status: "available" }];
    await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,area_sqm,price_cents,status,metadata) values($1,$2,$3,'SYNTHETIC A1',75,0,'available',$4)", [unit, workspaceId, projectId, JSON.stringify({ sellerListingId: fixture.id })]);
    await db.admin.query("insert into web_expose_versions(id,workspace_id,property_id,project_id,created_by,language,version,snapshot,source_fingerprint) values($1,$2,$3,$4,$5,'de',1,$6,'synthetic')", [version, workspaceId, fixture.id, projectId, userId, JSON.stringify(fixture.snapshot)]);
    await db.admin.query("insert into web_expose_links(id,workspace_id,version_id,token_hash,label) values($1,$2,$3,$4,'SYNTHETIC')", [link, workspaceId, version, webExposeHash(token)]);
    const inventory = async () => (await db.pool.query("select crm_web_expose_inventory($1) as data", [webExposeHash(token)])).rows[0].data;
    const setPrice = async (price: number, state: "known" | "unknown" | null) => db.admin.query("update seller_listings set target_price_cents=$2,public_price_cents=null,canonical_payload=case when $3::text is null then canonical_payload-'coreNumericState' else jsonb_set(canonical_payload,'{coreNumericState}',jsonb_build_object('version',1,'price',$3::text,'areaSqm','known')) end where id=$1", [fixture.id, price, state]);
    await t.test("public capability inventory distinguishes known zero, unknown, legacy zero and a separate public price", async () => {
      const assertSnapshotZero = async (known: boolean) => {
        const web = await run((tx, fresh) => buildWebExposeSnapshot(tx, fresh, { propertyId: fixture.id, language: "de", description: "SYNTHETIC", showAddress: false, showContact: false, reviewed: true, controller: "SYNTHETIC", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal" }));
        assert.equal(Boolean(web.snapshot.price?.includes("0,00")), known);
        const source = (await db.admin.query(`select ${exposeSourceSql} as source from seller_listings p where id=$1`, [fixture.id])).rows[0].source;
        const build = () => buildPropertyExposeDocument({ propertyId: fixture.id, workspaceId, projectId, source, registryRaw: null, registry: { schemaVersion: 1, revision: "initial", preferredSource: "generated", activeDocumentId: null, versions: [] }, sourceFingerprint: "synthetic" }, { template: "full", language: "de", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []);
        if (known) assert.ok(build().price?.includes("0,00")); else assert.throws(build, { code: "EXPOSE_PRICE_MISSING" });
      };
      await setPrice(0, "known"); assert.equal((await inventory()).priceCents, "0"); assert.equal((await inventory()).units[0].priceCents, null);
      const publicPage = await run(() => lookupWebExpose(token)); assert.ok(publicPage?.snapshot.price?.includes("0,00"));
      await setPrice(0, "unknown"); assert.equal((await inventory()).priceCents, null);
      await setPrice(0, null); assert.equal((await inventory()).priceCents, null);
      await db.admin.query("update seller_listings set public_price_cents=0,canonical_payload=canonical_payload||'{\"base\":{\"priceCents\":\"0\"}}'::jsonb where id=$1", [fixture.id]); assert.equal((await inventory()).priceCents, null, "actual legacy guided blank has nullable public 0 as well as asking 0");
      await db.admin.query("update seller_listings set target_price_cents=12345 where id=$1", [fixture.id]); assert.equal((await inventory()).priceCents, null, "legacy public 0 must not be replaced by a known positive private asking price");
      const legacySource = (await db.admin.query(`select ${exposeSourceSql} as source from seller_listings p where id=$1`, [fixture.id])).rows[0].source;
      assert.throws(() => buildPropertyExposeDocument({ propertyId: fixture.id, workspaceId, projectId, source: legacySource, registryRaw: null, registry: { schemaVersion: 1, revision: "initial", preferredSource: "generated", activeDocumentId: null, versions: [] }, sourceFingerprint: "synthetic" }, { template: "full", language: "de", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []), { code: "EXPOSE_PRICE_MISSING" });
      const legacyWeb = await run((tx, fresh) => buildWebExposeSnapshot(tx, fresh, { propertyId: fixture.id, language: "de", description: "SYNTHETIC", showAddress: false, showContact: false, reviewed: true, controller: "SYNTHETIC", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal" })); assert.equal(legacyWeb.snapshot.price, null);
      await db.admin.query("update seller_listings set marketing_type='rent',rent_price_cents=0 where id=$1", [fixture.id]); assert.equal((await inventory()).priceCents, null, "legacy rental zero also stays fail-closed");
      await db.admin.query("update seller_listings set marketing_type='sale',rent_price_cents=null where id=$1", [fixture.id]);
      await setPrice(12345, null); assert.equal((await inventory()).priceCents, "12345");
      await setPrice(0, "unknown"); await db.admin.query("update seller_listings set public_price_cents=0 where id=$1", [fixture.id]); assert.equal((await inventory()).priceCents, null, "a version stamp from an unrelated area edit does not make legacy public 0 known");
      await assertSnapshotZero(false);
      await db.admin.query("update seller_listings set canonical_payload=jsonb_set(canonical_payload,'{coreNumericState,publicPrice}','\"known\"') where id=$1", [fixture.id]); assert.equal((await inventory()).priceCents, "0");
      await assertSnapshotZero(true);
      await db.admin.query("update seller_listings set marketing_type='rent',rent_price_cents=0,public_price_cents=null where id=$1", [fixture.id]); assert.equal((await inventory()).priceCents, null, "public-price knownness never grants rental-price knownness");
      await assertSnapshotZero(false);
      await db.admin.query("update seller_listings set canonical_payload=jsonb_set(canonical_payload,'{coreNumericState,rentPrice}','\"known\"') where id=$1", [fixture.id]); assert.equal((await inventory()).priceCents, "0");
      await assertSnapshotZero(true);
      await db.admin.query("update seller_listings set marketing_type='sale',rent_price_cents=null,public_price_cents=null where id=$1", [fixture.id]);
    });
    await t.test("known zero is still hidden by visibility, developer authority and capability withdrawal", async () => {
      assert.equal((await db.pool.query("select rolbypassrls from pg_roles where rolname=current_user")).rows[0].rolbypassrls, false);
      assert.equal((await db.pool.query("select crm_web_expose_inventory($1) as data", [webExposeHash(webExposeToken())])).rows[0].data, null);
      await setPrice(0, "known");
      for (const visibility of ["hide_price", "price_on_request"]) { await db.admin.query("update seller_listings set price_visibility=$2 where id=$1", [fixture.id, visibility]); assert.equal((await inventory()).priceCents, null); }
      await db.admin.query("update seller_listings set price_visibility='publish_price',unit_id=$2 where id=$1", [fixture.id, unit]);
      await db.admin.query("update projects set customer_type='property_developer' where id=$1", [projectId]); assert.equal((await inventory()).priceCents, null);
      await db.admin.query("update property_units set metadata=metadata||jsonb_build_object('priceConfirmation',jsonb_build_object('sourceReference','SYNTHETIC approval','priceCents','0')) where id=$1", [unit]);
      assert.equal((await inventory()).priceCents, "0"); assert.equal((await inventory()).units[0].priceCents, "0");
      await db.admin.query("update property_units set metadata=metadata||'{\"hidden\":true}'::jsonb where id=$1", [unit]); assert.deepEqual((await inventory()).units, []);
      await db.admin.query("update property_units set metadata=metadata- 'hidden' where id=$1", [unit]);
      await db.admin.query("update seller_listings set property_status='paused' where id=$1", [fixture.id]); assert.equal(await inventory(), null);
      await db.admin.query("update seller_listings set property_status='ready' where id=$1", [fixture.id]);
      await db.admin.query("update web_expose_links set revoked_at=now() where id=$1", [link]); assert.equal(await inventory(), null);
      await db.admin.query("update web_expose_links set revoked_at=null where id=$1", [link]);
      await db.admin.query("update web_expose_links set expires_at=now()-interval '1 hour' where id=$1", [link]); assert.equal(await inventory(), null);
      await db.admin.query("update web_expose_links set expires_at=null where id=$1", [link]);
      await db.admin.query("update web_expose_versions set active=false where id=$1", [version]); assert.equal(await inventory(), null);
      await db.admin.query("update web_expose_versions set active=true where id=$1", [version]);
      const otherProject = randomUUID(), otherUnit = randomUUID(); await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC foreign project','Service')", [otherProject, workspaceId]);
      await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,area_sqm,price_cents,status) values($1,$2,$3,'SYNTHETIC FOREIGN',50,10000,'available')", [otherUnit, workspaceId, otherProject]);
      await db.admin.query("update web_expose_versions set snapshot=jsonb_set(snapshot,'{units}',snapshot->'units'||$2::jsonb) where id=$1", [version, JSON.stringify([{ id: otherUnit, number: "MUST-NOT-LEAK-FOREIGN", price: "100" }])]);
      assert.equal((await inventory()).units.some((u: { id: string }) => u.id === otherUnit), false);
      const privateId = randomUUID(), privateVersion = randomUUID(), privateToken = webExposeToken();
      await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm,data_classification,data_purpose) select $1,workspace_id,project_id,'SYNTHETIC private','PRIVATE',region,object_type,area_sqm,'PRIVATE_FRANZ','crm_sales' from seller_listings where id=$2", [privateId, fixture.id]);
      await db.admin.query("insert into web_expose_versions(id,workspace_id,property_id,project_id,created_by,language,version,snapshot,source_fingerprint) values($1,$2,$3,$4,$5,'de',1,$6,'synthetic')", [privateVersion, workspaceId, privateId, projectId, userId, JSON.stringify(fixture.snapshot)]);
      await db.admin.query("insert into web_expose_links(workspace_id,version_id,token_hash,label) values($1,$2,$3,'SYNTHETIC private')", [workspaceId, privateVersion, webExposeHash(privateToken)]);
      assert.equal((await db.pool.query("select crm_web_expose_inventory($1) as data", [webExposeHash(privateToken)])).rows[0].data, null);
    });
    await t.test("live resource availability does not restore unsanitized frozen titles", async () => {
      const page = await run(() => lookupWebExpose(token)); assert.ok(page); assert.ok(page.snapshot.resources?.length); assert.ok(!JSON.stringify(page.snapshot).includes(hiddenAddress));
    });
    await writeFile(path.join(out, "verification.json"), JSON.stringify({ base: "11c4384c0c5a360e448f441c822edc1057d9fe17", syntheticOnly: true, liveCalls: false, generated: verification }, null, 2));
  } finally { await db.stop(); }
});
