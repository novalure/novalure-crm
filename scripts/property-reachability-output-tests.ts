import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { applySalesSchema } from "./lib/local-sales-db.mjs";
import { startReachabilityDb } from "./lib/property-reachability-local-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { getRequestSession } from "../src/lib/auth/session";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { withCrmRead } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { POST as propertyPost } from "../src/app/api/crm/properties/route";
import { POST as webExposePost } from "../src/app/api/crm/web-exposes/route";
import { exposeFingerprint, loadPropertyExposeSnapshot } from "../src/lib/db/property-expose-repositories";
import { lookupWebExpose } from "../src/lib/db/web-expose-repository";
import { buildPropertyExposeDocument, getPropertyExposeState } from "../src/lib/property-expose-service";
import { renderPropertyExposePdf } from "../src/lib/property-expose-pdf";
import type { PropertyExposeDocument, PropertyExposeOptions } from "../src/lib/property-expose";
import { createPropertyGeography } from "../src/lib/property-country";

async function inspectPdf(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, disableFontFace: true,
    standardFontDataUrl: path.resolve("node_modules/pdfjs-dist/standard_fonts").replaceAll("\\", "/") + "/" });
  const pdf = await task.promise; let text = "";
  try { for (let n = 1; n <= pdf.numPages; n++) text += (await (await pdf.getPage(n)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ") + "\n"; }
  finally { await task.destroy(); }
  const parsed = await PDFDocument.load(bytes), language = parsed.catalog.get(PDFName.of("Lang"));
  return { text, language: language instanceof PDFString ? language.decodeText() : String(language), pages: parsed.getPageCount() };
}

test("saved-row output locale and disclosure behavior through actual local CRM handlers", { timeout: 600_000 }, async t => {
  const db = await startReachabilityDb();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("PROPERTY_OUTPUT_REACHABILITY_EXTERNAL_FETCH_FORBIDDEN"); };
  const observations: Record<string, unknown>[] = [];
  const references = path.join(db.directory, "output-references");
  try {
    await mkdir(references, { recursive: true });
    await applySalesSchema(db);
    const fixture = await seedSalesBrowser(db);
    // This isolated scenario is an ordinary broker project. Developer price authority
    // is exercised separately, and must not be fabricated to reach publication.
    await db.admin.query("update projects set type='Service',customer_type='real_estate_broker' where id=$1", [fixture.projectId]);
    const secret = randomBytes(48).toString("base64url"), cookie = "v2." + randomBytes(32).toString("base64url"), origin = "http://127.0.0.1:3000";
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret,
      NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    await db.admin.query("update auth_identities set mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1", [fixture.authIdentityId]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), fixture.authIdentityId, fixture.userId, fixture.workspaceId]);
    const request = (pathname: string, body: unknown) => new Request(origin + pathname + `?workspaceId=${fixture.workspaceId}`, { method: "POST", headers: {
      "content-type": "application/json", origin, "sec-fetch-site": "same-origin", cookie: "novalure_session=" + cookie,
      "Idempotency-Key": randomUUID(), "X-Correlation-Id": randomUUID(), "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname, secret, sessionCookie: cookie })!.token,
    }, body: JSON.stringify(body) });
    const session = await getRequestSession(new Request(origin, { headers: { cookie: "novalure_session=" + cookie } }));
    assert.ok(session?.authenticated); assert.equal(session.source, "cookie"); assert.equal(session.workspaceId, fixture.workspaceId); assert.equal(session.userId, fixture.userId);
    const boundSession = (await db.admin.query("select count(*)::integer as n from auth_sessions where token_hash=$1 and workspace_id=$2 and workspace_user_id=$3 and auth_identity_id=$4 and mfa_verified_at is not null and expires_at>now()", [createHash("sha256").update(cookie).digest("hex"), fixture.workspaceId, fixture.userId, fixture.authIdentityId])).rows[0];
    assert.equal(boundSession.n, 1, "cookie transport must resolve the actual persisted local MFA-verified session binding");
    const run = <T>(work: () => Promise<T>) => withCrmRead(session, work, { pool: db.pool as unknown as TenantPool });
    const geography = { ...createPropertyGeography("ES", "Andalucía"), displayLocale: "en-IE" as const };
    const privateMarkers = ["PRIVATE-SAVED-NOTE-REACHABILITY", "PRIVATE-SAVED-SELLER-REACHABILITY", "PRIVATE-SAVED-REGISTER-REACHABILITY"];
    const base = { operation: "create_property", projectId: fixture.projectId, title: "SYNTHETIC locale property", address: "SYNTHETIC PRIVATE STREET 999, TESTCITY", street: "SYNTHETIC PRIVATE STREET", city: "SYNTHETIC TESTCITY", region: geography.region,
      geography, energyCertificate: { version: 1, countryCode: "ES", certificateType: "existing", energyClass: "B", finalEnergyDemandKwhM2: 51.25, registration: "SYNTHETIC-UNVERIFIED" },
      areaSqm: 85.75, rooms: 2.5, yearBuilt: 2024, price: 1234.56, publicPrice: 1234.56, objectType: "Wohnung", usageType: "residential", marketingType: "sale", priceVisibility: "publish_price",
      internalNotes: privateMarkers[0], contactName: privateMarkers[1], contactEmail: "synthetic-private@example.invalid", fieldValues: { "cadastre.es_referencia_catastral": privateMarkers[2], "seller.name": privateMarkers[1], "notes.interne_notizen": privateMarkers[0] } };
    const create = async (patch: Record<string, unknown> = {}) => {
      const response = await propertyPost(request("/api/crm/properties", { ...base, ...patch }));
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json(); assert.equal(body.persisted, true); return body.data.id as string;
    };
    const webInput = (propertyId: string, patch: Record<string, unknown> = {}) => ({ action: "preview", propertyId, language: "es", description: "SYNTHETIC authored public description", showAddress: false, showContact: false, reviewed: false,
      controller: "SYNTHETIC LOCAL TEST", legalUrl: "https://example.invalid/legal", privacyUrl: "https://example.invalid/privacy", ...patch });
    const preview = async (propertyId: string, patch: Record<string, unknown> = {}) => {
      const response = await webExposePost(request("/api/crm/web-exposes", webInput(propertyId, patch)));
      assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
    };
    const propertyId = await create();
    const snapshot = await run(() => loadPropertyExposeSnapshot(fixture.workspaceId, propertyId));
    await t.test("private saved notes, seller fields and register markers are not automatically projected", async () => {
      const stored = (await db.admin.query("select internal_notes,canonical_payload,contact_name,address,street from seller_listings where id=$1", [propertyId])).rows[0];
      assert.equal(stored.internal_notes, privateMarkers[0]); assert.equal(stored.contact_name, privateMarkers[1]);
      assert.equal(stored.canonical_payload.fieldValues["notes.interne_notizen"], privateMarkers[0]);
      assert.equal(stored.canonical_payload.fieldValues["seller.name"], privateMarkers[1]);
      assert.equal(stored.canonical_payload.fieldValues["cadastre.es_referencia_catastral"], privateMarkers[2]);
      assert.deepEqual(stored.canonical_payload.geography, geography, "the actual create handler must persist the normalized independent profile");
      assert.equal(stored.address, base.address); assert.equal(stored.street, base.street);
      const result = await preview(propertyId);
      for (const marker of privateMarkers) assert.ok(!JSON.stringify(result.snapshot).includes(marker));
      assert.ok(!JSON.stringify(result.snapshot).includes(base.address)); assert.ok(!JSON.stringify(result.snapshot).includes(base.street));
      const hiddenAddress = await preview(propertyId, { title: `SYNTHETIC ${base.address}`, description: `SYNTHETIC ${base.street}` });
      assert.ok(!hiddenAddress.snapshot.title.includes(base.address)); assert.ok(!hiddenAddress.snapshot.description.includes(base.street));
      assert.ok(hiddenAddress.snapshot.title.includes("[dirección oculta]")); assert.ok(hiddenAddress.snapshot.description.includes("[dirección oculta]"));
      const visibleAddress = await preview(propertyId, { showAddress: true });
      assert.equal(visibleAddress.snapshot.location, base.address, "positive control proves the stored full address is available when selected");
      const document = buildPropertyExposeDocument(snapshot, { template: "full", language: "es", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []);
      for (const marker of privateMarkers) assert.ok(!JSON.stringify(document).includes(marker));
      assert.ok(!JSON.stringify(document).includes(base.address)); assert.ok(!JSON.stringify(document).includes(base.street));
      observations.push({ kind: "PRIVATE_COLUMN_EXCLUSION", privateValuesActuallyStored: true, exactSourceLocations: ["seller_listings.internal_notes", "canonical_payload.fieldValues.notes.interne_notizen", "canonical_payload.fieldValues.seller.name", "canonical_payload.fieldValues.cadastre.es_referencia_catastral"], storedGeography: stored.canonical_payload.geography, privateMarkersAbsentFromWebSnapshotAndPrivatePdfDocument: true, addressHiddenFromWebSnapshotAndPrivatePdfDocument: true });
    });
    for (const language of ["de", "en", "es"] as const) await t.test(`saved ES display profile en-IE survives ${language} document labels and PDF metadata`, async () => {
      const options: PropertyExposeOptions = { template: "full", language, address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [], description: "SYNTHETIC source text; not automatically translated" };
      const document = buildPropertyExposeDocument(snapshot, options, []);
      observations.push({ kind: "LOCALE", language, stored: geography.displayLocale, projected: snapshot.source.listing.geography ?? null, documentLocale: Reflect.get(document, "locale") ?? null, price: document.price, facts: document.facts });
      assert.equal(Reflect.get(document, "locale"), "en-IE");
      const amount = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(1234.56);
      assert.ok(document.price?.includes(amount));
      assert.ok(document.price?.startsWith(language === "de" ? "Kaufpreis:" : language === "es" ? "Precio de compra:" : "Purchase price:"));
      const publicFacts = [...document.facts, ...(document.detailGroups ?? []).flatMap(group => group.facts)];
      const areaLabels = language === "de" ? ["Fläche", "Wohnfläche"] : language === "es" ? ["Superficie", "Superficie habitable"] : ["Area", "Living area"];
      assert.ok(publicFacts.some(fact => fact.value === "85.75 m²" && areaLabels.includes(fact.label)));
      assert.ok(document.energy.some(fact => fact.value === "51.25 kWh/(m²a)"));
      const webResult = await preview(propertyId, { language });
      assert.equal(webResult.snapshot.locale, "en-IE"); assert.equal(webResult.snapshot.countryCode, "ES"); assert.equal(webResult.snapshot.price, amount);
      document.title = "NOTLIVEOUTPUT - " + document.title; document.createdAt = "2026-11-04T12:00:00.000Z";
      const bytes = await renderPropertyExposePdf(document), parsed = await inspectPdf(bytes);
      assert.equal(parsed.language, language, "PDF content language must not become the number-format locale");
      assert.ok(parsed.text.includes(new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeZone: "Europe/Vienna" }).format(new Date(document.createdAt))));
      await writeFile(path.join(references, `NOTLIVEOUTPUT-locale-${language}.pdf`), bytes);
    });
    await t.test("legacy locale-absent renderer contract retains its date fallback and rejects invalid supplied locales", async () => {
      const legacy = structuredClone(snapshot); delete legacy.source.listing.geography;
      const options: PropertyExposeOptions = { template: "full", language: "en", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] };
      const document = buildPropertyExposeDocument(legacy, options, []);
      assert.equal(Reflect.get(document, "locale"), undefined);
      document.title = "NOTLIVEOUTPUT - legacy source"; document.createdAt = "2026-11-04T12:00:00.000Z";
      const bytes = await renderPropertyExposePdf(document), parsed = await inspectPdf(bytes);
      assert.ok(parsed.text.includes(new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Europe/Vienna" }).format(new Date(document.createdAt))));
      await writeFile(path.join(references, "NOTLIVEOUTPUT-locale-legacy.pdf"), bytes);
      await assert.rejects(renderPropertyExposePdf({ ...document, locale: "en-US" } as unknown as PropertyExposeDocument), { code: "INVALID_DOCUMENT" });
    });
    await t.test("display-format-only edit changes source fingerprint and marks historical registry metadata stale without replacing it", async () => {
      const before = await run(() => loadPropertyExposeSnapshot(fixture.workspaceId, propertyId));
      const oldBytes = await readFile(path.join(references, "NOTLIVEOUTPUT-locale-legacy.pdf"));
      const oldHash = createHash("sha256").update(oldBytes).digest("hex"), assetId = randomUUID(), documentId = randomUUID();
      // Explicit synthetic historical registry fixture. This is a readonly registry
      // and metadata-availability test, not an upload/generation-route acceptance.
      const version = { id: documentId, assetId, source: "generated", fileName: "SYNTHETIC-historical-reference.pdf", createdAt: "2026-11-04T12:00:00.000Z", sizeBytes: oldBytes.length, pageCount: (await PDFDocument.load(oldBytes)).getPageCount(), versionLabel: "v1", sourceFingerprint: before.sourceFingerprint, sha256: oldHash };
      const registry = { schemaVersion: 1, revision: randomUUID(), preferredSource: "generated", activeDocumentId: documentId, versions: [version] };
      await db.admin.query("insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public) values($1,$2,'SYNTHETIC historical reference','SYNTHETIC historical reference',$3,'application/pdf',$4,'','SYNTHETIC-METADATA-ONLY-NOT-UPLOADED','local','private',false)", [assetId, fixture.workspaceId, `properties/${propertyId}`, oldBytes.length]);
      await db.admin.query("insert into property_documents(id,workspace_id,project_id,property_id,media_asset_id,title,category,visibility,status) values($1,$2,$3,$4,$5,'SYNTHETIC historical reference','novalure_expose','private','draft')", [documentId, fixture.workspaceId, fixture.projectId, propertyId, assetId]);
      await db.admin.query("update seller_listings set canonical_payload=jsonb_set(canonical_payload,'{expose}',$2::jsonb) where id=$1", [propertyId, JSON.stringify(registry)]);
      const initialState = await run(() => getPropertyExposeState(session, propertyId));
      assert.equal(initialState.versions[0].stale, false); assert.equal(initialState.versions[0].available, true);
      const nextGeography = { ...geography, displayLocale: "es-ES" };
      const changed = await propertyPost(request("/api/crm/properties", { operation: "update_property_core", propertyId, property: { geography: nextGeography, expectedGeography: geography } }));
      assert.equal(changed.status, 200, await changed.clone().text());
      const after = await run(() => loadPropertyExposeSnapshot(fixture.workspaceId, propertyId)), state = await run(() => getPropertyExposeState(session, propertyId));
      const retained = (await db.admin.query("select canonical_payload->'expose' as registry,canonical_payload->'geography' as geography from seller_listings where id=$1", [propertyId])).rows[0];
      const regenerated = buildPropertyExposeDocument(after, { template: "full", language: "en", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []);
      const unchangedBefore = structuredClone(before.source), unchangedAfter = structuredClone(after.source);
      delete unchangedBefore.listing.geography; delete unchangedAfter.listing.geography;
      assert.deepEqual(unchangedAfter, unchangedBefore, "display-format edit must preserve all other source inputs");
      observations.push({ kind: "FORMAT_FINGERPRINT_AND_READONLY_REGISTRY", historicalRegistryFixtureOnly: true, before: before.sourceFingerprint, after: after.sourceFingerprint, oldRegistryRetained: exposeFingerprint(retained.registry) === exposeFingerprint(registry), oldActiveDocumentRetained: state.activeDocumentId === documentId, metadataAvailable: state.versions[0].available, stale: state.versions[0].stale, regeneratedDocumentLocale: Reflect.get(regenerated, "locale") ?? null, qualification: "No historical upload, backend-byte download or regeneration persistence is claimed" });
      assert.deepEqual(retained.geography, nextGeography); assert.equal(after.sourceFingerprint, exposeFingerprint(after.source));
      assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
      assert.deepEqual(retained.registry, registry); assert.equal(state.activeDocumentId, documentId); assert.equal(state.versions.length, 1);
      assert.equal(state.versions[0].available, true); assert.equal(state.versions[0].stale, true); assert.equal(state.versions[0].sourceFingerprint, before.sourceFingerprint);
      assert.equal(createHash("sha256").update(await readFile(path.join(references, "NOTLIVEOUTPUT-locale-legacy.pdf"))).digest("hex"), oldHash);
      assert.equal(Reflect.get(regenerated, "locale"), "es-ES");
    });
    for (const visibility of ["hide_price", "price_on_request"] as const) await t.test(`${visibility} controls structured price; intentional authored price text is recorded separately`, async () => {
      const id = await create({ title: "SYNTHETIC disclosure observation", priceVisibility: visibility });
      const authored = "SYNTHETIC intentionally authored 1234.56 EUR", result = await preview(id, { title: authored, description: authored });
      assert.equal(result.snapshot.price, null); assert.deepEqual(result.snapshot.costs, []);
      observations.push({ kind: "AUTHORED_TEXT_SEPARATE_FROM_COLUMN_PROJECTION", visibility, structuredPrice: result.snapshot.price, structuredCosts: result.snapshot.costs, authoredTitleRetained: result.snapshot.title.includes("1234.56"), authoredDescriptionRetained: result.snapshot.description.includes("1234.56"), qualification: "Observation only; no generic text-DLP contract is asserted" });
    });
    await t.test("public getter rechecks current visibility while authored frozen text is independently observed", async () => {
      const authored = "SYNTHETIC previously authored 1234.56 EUR";
      const input = webInput(propertyId, { title: authored, description: authored, reviewed: true });
      const before = await preview(propertyId, input);
      const response = await webExposePost(request("/api/crm/web-exposes", { ...input, action: "publish", expectedSourceFingerprint: before.sourceFingerprint }));
      assert.equal(response.status, 200, await response.clone().text());
      const published = (await response.json()).data, token = published.path.split("/").at(-1)!;
      const visible = await lookupWebExpose(token); assert.ok(visible); assert.equal(visible.snapshot.priceVisibility, "publish_price"); assert.ok(visible.snapshot.price);
      const hidden = await propertyPost(request("/api/crm/properties", { operation: "update_property_core", propertyId, property: { priceVisibility: "hide_price", channelPriceVisibility: { Website: "hide_price" } } }));
      assert.equal(hidden.status, 200, await hidden.clone().text());
      const current = await lookupWebExpose(token); assert.ok(current); assert.equal(current.snapshot.priceVisibility, "hide_price"); assert.equal(current.snapshot.price, null); assert.deepEqual(current.snapshot.costs, []);
      observations.push({ kind: "PUBLISHED_TEXT_AFTER_CURRENT_VISIBILITY_CHANGE", localDatabaseOnly: true, actualCreatePreviewPublishUpdateAndPublicGetter: true, structuredPrice: current.snapshot.price, structuredVisibility: current.snapshot.priceVisibility, authoredTitleRetained: current.snapshot.title.includes("1234.56"), authoredDescriptionRetained: current.snapshot.description.includes("1234.56"), qualification: "No claim that retained intentional prose is automatic private-column leakage; no pixel/filename/URL/caption proof" });
    });
  } finally {
    try { await writeFile(path.join(db.directory, "property-output-observations.json"), JSON.stringify({ scope: "LOCAL_REAL_HANDLER_AND_POSTGRES_ONLY_NO_BROWSER_OR_EXTERNAL_PUBLICATION", observations }, null, 2) + "\n"); }
    finally { try { await closeLocalTestPool(); } finally { try { await db.stop(); } finally { globalThis.fetch = previousFetch; } } }
  }
});
