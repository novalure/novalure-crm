import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createSellerListingRecord } from "../src/lib/db/property-department-repositories";
import { exposeFingerprint, exposeSourceSql, readExposeRegistry, type ExposeSnapshot, type ExposeSource } from "../src/lib/db/property-expose-repositories";
import { buildPropertyExposeDocument, parsePropertyExposeOptions } from "../src/lib/property-expose-service";
import { renderPropertyExposePdf } from "../src/lib/property-expose-pdf";
import { renderWebExposePdf } from "../src/lib/web-expose-pdf";
import { buildWebExposeSnapshot, publishWebExpose } from "../src/lib/db/web-expose-repository";
import { previewPropertyPortal, savePropertyPortalProfile } from "../src/lib/db/property-portal-repository";
import { buildPropertyPortalXml, type PropertyPortalProfile, type PropertyPortalSource } from "../src/lib/property-portal";
import { createPropertyGeography } from "../src/lib/property-country";
import { formatApprovedPropertyCosts, publicPropertyDetailGroups, publicPropertyPortalDetails, publicPropertyUnitFacts } from "../src/lib/property-expose-details";
import type { PropertyExposeLanguage, PropertyExposeOptions } from "../src/lib/property-expose";
import type { WebExposeSnapshot } from "../src/lib/web-expose";

process.env.NOVALURE_AUTH_ENCRYPTION_KEY ||= "synthetic-property-details-only-encryption-key-20261104";
const canonical = {
  propertyDetails: { version: 1, values: {
    "areas.wohnfl_che": 80.5, "areas.nutzfl_che": 93.25, "areas.balkonfl_che": 12.5,
    "areas.terrassenfl_che": 18, "areas.gartenfl_che": 42, "rooms.schlafzimmer": 3,
    "rooms.b_der": 2, "rooms.balkone": 1, "equipment.fahrstuhl": true, "classification.barrierefrei": false,
    "construction.heizung": "heat_pump", "construction.heizungsjahr": 2021,
    "cadastre.es_referencia_catastral": "PRIVATE-CADASTRE", "seller.name": "PRIVATE-SELLER", "notes.interne_notizen": "PRIVATE-NOTES",
    "costs.abgeberprovision": "PRIVATE-INTERNAL-COMMISSION", "location.schl_sselinfo": "PRIVATE-KEYS",
  }, legacy: { unknown: "PRIVATE-LEGACY" } },
  fieldValues: { "equipment.k_che": "Einbauküche", "cadastre.einlagezahl": "PRIVATE-LANDREGISTER" },
};
const approvedCosts = [
  { costKey: "operating_costs", label: "Betriebskosten", monthlyGrossCents: "12345", oneTimeGrossCents: "0" },
  { costKey: "heating_costs", label: "Heizkosten", monthlyGrossCents: "5500", oneTimeGrossCents: "0" },
];
const profile: PropertyPortalProfile = { portalName: "SYNTHETIC Offline", providerName: "Synthetic agency", providerId: "SYNTHETIC", agencyId: "SYNTHETIC", externalObjectId: "SYNTHETIC-DETAILS", contactName: "Synthetic public contact", contactEmail: "public@example.invalid", propertyType: "apartment", includeAddress: false, includeMedia: false };
const output = path.resolve(".npm-cache/qa/property-public-details");
const pdfOptions = (language: PropertyExposeLanguage): PropertyExposeOptions => ({ template: "full", language, address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] });
function documentSnapshot(): ExposeSnapshot {
  const source: ExposeSource = { listing: { title: "SYNTHETIC property details", objectNumber: "SYNTHETIC-1", objectType: "Wohnung", areaSqm: 80.5, rooms: 4, yearBuilt: 2000,
    marketingType: "sale", publicPriceCents: 25000000, priceVisibility: "publish_price", countryCode: "AT", publicDetails: canonical, energyClass: "B" },
    costs: approvedCosts, texts: [{ content: "Synthetic public property description." }], media: [], company: null };
  return { propertyId: randomUUID(), workspaceId: randomUUID(), projectId: randomUUID(), registryRaw: null, registry: readExposeRegistry(null), source, sourceFingerprint: exposeFingerprint(source) };
}
async function pdfText(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, disableFontFace: true,
    standardFontDataUrl: path.resolve("node_modules/pdfjs-dist/standard_fonts").replaceAll("\\", "/") + "/" });
  const pdf = await task.promise; let text = "";
  for (let i = 1; i <= pdf.numPages; i++) { const page = await pdf.getPage(i); const content = await page.getTextContent(); text += content.items.map(item => "str" in item ? item.str : "").join(" ") + "\n"; }
  const pages = pdf.numPages; await task.destroy(); return { text, pages };
}

test("public property details use the explicit whitelist, preserve unknown, and translate DE/EN/ES labels and enums", () => {
  for (const [language, words] of [["de", ["Wohnfläche", "Nutzfläche", "Schlafzimmer", "Wärmepumpe"]], ["en", ["Living area", "Usable area", "Bedrooms", "Heat pump"]], ["es", ["Superficie habitable", "Superficie útil", "Dormitorios", "Bomba de calor"]]] as const) {
    const groups = publicPropertyDetailGroups({ canonicalPayload: canonical }, language), json = JSON.stringify(groups);
    for (const word of words) assert.ok(json.includes(word), `${language}: missing ${word}`);
    assert.doesNotMatch(json, /PRIVATE-|cadastre|seller|legacy|schl_ssel/);
    assert.ok(groups.flatMap(group => group.facts).some(fact => fact.value === "2021"));
    assert.equal(groups.flatMap(group => group.facts).some(fact => /Sauna/.test(fact.label)), false, "unknown is omitted, never converted to false");
  }
  assert.deepEqual(publicPropertyUnitFacts({}, "en"), []);
  assert.deepEqual(publicPropertyDetailGroups({ canonicalPayload: { propertyDetails: { version: 1, values: { "areas.wohnfl_che": 0 } } } }, "de"), [], "legacy primary zero is not advertised as a known living area");
  const unit = publicPropertyUnitFacts({ balconyAreaSqm: 0, bedrooms: 2, heatingYear: 2022, investorPriceCents: 999999999 } as never, "es");
  assert.ok(unit.some(fact => fact.value === "0 m²")); assert.ok(unit.some(fact => fact.value === "2022"));
  assert.doesNotMatch(JSON.stringify(unit), /999999999|investor/i);
});

test("approved cost labels reject internal commissions, private notes and nonpublic rows", () => {
  const facts = formatApprovedPropertyCosts([...approvedCosts,
    { costKey: "seller_commission", label: "PRIVATE-COMMISSION", monthlyGrossCents: 999999 },
    { costKey: "operating_costs", exposeVisible: false, monthlyGrossCents: 888888 },
  ], "es");
  assert.equal(facts.length, 2); assert.match(JSON.stringify(facts), /Gastos de comunidad/); assert.doesNotMatch(JSON.stringify(facts), /PRIVATE|999|888/);
  for (const language of ["de", "en", "es"] as const) {
    assert.equal(parsePropertyExposeOptions(pdfOptions(language)).language, language);
    const snapshot = documentSnapshot(); snapshot.source.listing.priceVisibility = "hide_price";
    const doc = buildPropertyExposeDocument(snapshot, pdfOptions(language), []);
    assert.equal(doc.price, undefined); assert.deepEqual(doc.costs, []); assert.doesNotMatch(JSON.stringify(doc), /250000|12345|55,00/);
  }
});

test("both PDF paths contain the same public details and genuine translated labels without private or hidden amounts", async () => {
  await mkdir(output, { recursive: true });
  for (const language of ["de", "en", "es"] as const) {
    const doc = buildPropertyExposeDocument(documentSnapshot(), pdfOptions(language), []);
    const classic = await renderPropertyExposePdf(doc), classicText = await pdfText(classic);
    const web: WebExposeSnapshot = { schemaVersion: 1, language, locale: language === "de" ? "de-AT" : language === "es" ? "es-ES" : "en-IE", countryCode: language === "es" ? "ES" : language === "en" ? "IE" : "AT",
      title: doc.title, description: doc.sections[0].text, location: "Synthetic location", price: doc.price ?? null, priceVisibility: "publish_price",
      facts: doc.facts, detailGroups: doc.detailGroups, costs: doc.costs, media: [], units: [], contact: { name: "", email: "", phone: "" },
      controller: "Synthetic public agency", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal", publishedAt: "2026-11-04T10:00:00Z" };
    const website = await renderWebExposePdf({ snapshot: web, images: [], plans: [], links: [], pageUrl: "https://example.invalid/expose/synthetic" }), webText = await pdfText(website);
    await writeFile(path.join(output, `SYNTHETIC-classic-${language}.pdf`), classic);
    await writeFile(path.join(output, `SYNTHETIC-web-${language}.pdf`), website);
    for (const result of [classicText, webText]) {
      assert.ok(result.pages >= 1 && result.pages <= 2, `short ${language} ${result === classicText ? "classic" : "web"} brochure has ${result.pages} pages; no notes/contact-only third page`); assert.doesNotMatch(result.text, /PRIVATE-|investor/i);
      assert.match(result.text, language === "de" ? /Schlafzimmer/ : language === "en" ? /Bedrooms/ : /Dormitorios/);
      assert.match(result.text, language === "de" ? /Wärmepumpe/ : language === "en" ? /Heat pump/ : /Bomba de calor/);
      assert.match(result.text, /2021/);
    }
    const hidden = await pdfText(await renderWebExposePdf({ snapshot: { ...web, priceVisibility: "hide_price", price: "PRIVATE-HIDDEN-PRICE", costs: [{ label: "PRIVATE-HIDDEN-COST", value: "987654 EUR" }] }, images: [], plans: [], links: [], pageUrl: "https://example.invalid/expose/synthetic" }));
    assert.doesNotMatch(hidden.text, /PRIVATE-HIDDEN|987654/);
  }
});

test("native and separate OpenImmo details validate against the actual official 1.2.7d XSD for CHANGE and DELETE", async () => {
  await mkdir(output, { recursive: true });
  const source: PropertyPortalSource = { propertyId: randomUUID(), projectId: null, title: "Synthetic public details", city: "Wien", postalCode: "1010", street: "", houseNumber: "", fullAddress: "PRIVATE-ADDRESS", description: "Public description", areaSqm: 999, rooms: 4, yearBuilt: 2000, marketingType: "sale", usageType: "residential", priceCents: 25000000, priceVisibility: "publish_price", geography: createPropertyGeography("AT", "Wien"), energy: { version: 1, countryCode: "AT", energyClass: "B", heatingDemandKwhM2: 30 }, updatedAt: "2026-11-04", media: [], details: publicPropertyPortalDetails({ canonicalPayload: canonical }), detailGroups: publicPropertyDetailGroups({ canonicalPayload: canonical }, "de"), costs: approvedCosts };
  for (const action of ["CHANGE", "DELETE"] as const) {
    const xml = buildPropertyPortalXml(source, profile, action, "2026-11-04T10:00:00Z"), file = path.join(output, `${action}.xml`);
    assert.doesNotMatch(xml, /PRIVATE-|investor/i);
    if (action === "CHANGE") {
      assert.match(xml, /<wohnflaeche>80.5<\/wohnflaeche><nutzflaeche>93.25/); assert.match(xml, /<anzahl_schlafzimmer>3/);
      assert.match(xml, /feldname="balcony_area_sqm">12.5/); assert.match(xml, /feldname="terrace_area_sqm">18/);
      assert.match(xml, /feldname="heating_installation_year">2021/); assert.match(xml, /<fahrstuhl PERSONEN="true"/);
      assert.doesNotMatch(xml, /<balkon_terrasse_flaeche>|<wohnflaeche>999/);
      const hidden = buildPropertyPortalXml({ ...source, priceVisibility: "hide_price" }, profile, action, "2026-11-04T10:00:00Z");
      assert.doesNotMatch(hidden, /250000|123\.45|55\.00|<nebenkosten>|<heizkosten>/);
    } else assert.doesNotMatch(xml, /wohnflaeche|schlafzimmer|heating_installation|250000/);
    await writeFile(file, xml);
    const validation = spawnSync("powershell.exe", ["-NoProfile", "-File", "scripts/validate-openimmo.ps1", "-SchemaPath", ".npm-cache/qa/openimmo-reference/openimmo_127d.xsd", "-XmlPath", file], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.equal(validation.status, 0, `${action}: ${validation.stdout}\n${validation.stderr}`);
  }
});

test("actual DB projections agree across web, classic PDF and portal, and use only the selected unit and public cost rows", { timeout: 180000 }, async () => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    for (const migration of ["154_automation_graph.sql", "155_web_expose.sql", "156_property_portal_exports.sql", "166_web_expose_live_inventory.sql", "172_property_portal_release_checks.sql", "175_web_expose_templates.sql", "186_property_unit_details.sql"]) await db.admin.query(await readFile(`migrations/${migration}`, "utf8"));
    const workspaceId = randomUUID(), userId = randomUUID(), projectId = randomUUID(), unitId = randomUUID(), unrelatedUnit = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC public details','self_service_customer','real_estate_broker')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic owner','owner@example.invalid','owner','customer_owner','active')", [userId, workspaceId]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC details project','Service')", [projectId, workspaceId]);
    const session: AppSession = { authenticated: true, workspaceId, userId, workspaceName: "Synthetic", name: "Synthetic owner", email: "owner@example.invalid", role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" };
    const run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>) => withCrmRead(session, work, { pool: db.pool as unknown as TenantPool });
    const saved = await run((_tx, scoped) => createSellerListingRecord({ session: scoped, property: { title: "SYNTHETIC public details", address: "PRIVATE-ADDRESS", city: "Wien", postalCode: "1010", region: "Wien", geography: createPropertyGeography("AT", "Wien"), energyCertificate: { version: 1, countryCode: "AT", heatingDemandKwhM2: 32, finalEnergyDemandKwhM2: 50, energyClass: "B" }, areaSqm: 80.5, rooms: 4, yearBuilt: 2000, price: 250000, usageType: "residential", objectType: "Wohnung", projectId, internalNotes: "PRIVATE-INTERNAL" } }));
    assert.ok(saved.persisted, JSON.stringify(saved)); if (!saved.persisted) return;
    const propertyId = saved.data.id;
    for (const [id, number, balcony, investor] of [[unitId, "SYNTHETIC-A1", 8.5, 999999999], [unrelatedUnit, "PRIVATE-UNRELATED", 9876, 888888888]] as const) await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,rooms,area_sqm,price_cents,status,balcony_area_sqm,bedrooms,heating_year,investor_price_cents) values($1,$2,$3,$4,4,80.5,25000000,'available',$5,2,2022,$6)", [id, workspaceId, projectId, number, balcony, investor]);
    await db.admin.query("update seller_listings set unit_id=$2,canonical_payload=canonical_payload||$3::jsonb,land_area_sqm=500,cellar_count=1,key_info='PRIVATE-LEGACY-KEY',seller_commission='PRIVATE-SELLER-FEE',equipment=$4::jsonb where id=$1", [propertyId, unitId, JSON.stringify(canonical), JSON.stringify({ fahrstuhl: true, unknown: "PRIVATE-EQUIPMENT-KEY" })]);
    await db.admin.query("insert into property_text_blocks(workspace_id,project_id,property_id,text_key,channel,title,content,status,visibility) values($1,$2,$3,'expose','all','Synthetic','Synthetic public description','approved','public')", [workspaceId, projectId, propertyId]);
    for (const [key, monthly, visible, scope] of [["operating_costs", 12345, true, null], ["heating_costs", 5500, true, unitId], ["heating_costs", 56789, false, null], ["seller_commission", 999999, true, null], ["heating_costs", 987654, true, unrelatedUnit]] as const) await db.admin.query("insert into property_cost_items(workspace_id,project_id,property_id,unit_id,cost_key,group_key,label,monthly_gross_cents,expose_visible) values($1,$2,$3,$4,$5,'monthly',$5,$6,$7)", [workspaceId, projectId, propertyId, scope, key, monthly, visible]);
    const input = { propertyId, language: "de" as const, privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal", controller: "Synthetic public agency", showAddress: false, showContact: false, reviewed: true };
    const web = await run((tx, scoped) => buildWebExposeSnapshot(tx, scoped, input));
    assert.equal(web.checks.some(check => check.status === "missing"), false, JSON.stringify(web.checks));
    assert.doesNotMatch(JSON.stringify(web.snapshot), /PRIVATE|999999999|888888888|9876|56789|999999|seller_commission|cadastre|legacy/);
    assert.equal(web.snapshot.units.length, 1); assert.equal(web.snapshot.units[0].id, unitId); assert.equal(web.snapshot.costs?.length, 2);
    assert.ok(web.snapshot.units[0].facts?.some(fact => fact.value === "8,5 m²"));
    assert.ok(web.snapshot.detailGroups?.some(group => group.facts.some(fact => fact.label === "Grundfläche" && fact.value === "500 m²")), "legacy125 public column is promoted");
    const classic = async () => run(async tx => {
      const row = await tx.queryOne<{ source: ExposeSource }>(`select ${exposeSourceSql} as source from seller_listings p where p.id=$1 and p.workspace_id=$2`, [propertyId, workspaceId]);
      assert.ok(row); return { propertyId, workspaceId, projectId, source: row.source, registryRaw: null, registry: readExposeRegistry(null), sourceFingerprint: exposeFingerprint(row.source) } satisfies ExposeSnapshot;
    });
    const classicSource = await classic(); assert.doesNotMatch(JSON.stringify(classicSource.source), /PRIVATE-(?:CADASTRE|SELLER|NOTES|LEGACY|KEYS|LANDREGISTER|EQUIPMENT)|seller_commission|999999999/);
    const doc = buildPropertyExposeDocument(classicSource, pdfOptions("de"), []); assert.equal(doc.costs.length, 2); assert.ok(doc.detailGroups?.some(group => group.id === "linked-unit" && group.facts.some(fact => fact.value === "8,5 m²")));
    await run((tx, scoped) => savePropertyPortalProfile(tx, scoped, propertyId, profile, 0));
    const portal = await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "CHANGE"));
    assert.equal(portal.source.details?.balconyAreaSqm, 8.5); assert.equal(portal.source.details?.bedrooms, 2);
    assert.match(portal.xml, /feldname="balcony_area_sqm">8.5/); assert.doesNotMatch(portal.xml, /PRIVATE|999999|987654|56789/);
    await db.admin.query("update seller_listings set canonical_payload=jsonb_set(canonical_payload,'{propertyDetails,values,areas.wohnfl_che}','81.5') where id=$1", [propertyId]);
    const changed = await run((tx, scoped) => buildWebExposeSnapshot(tx, scoped, input));
    assert.notEqual(changed.sourceFingerprint, web.sourceFingerprint); assert.notEqual((await classic()).sourceFingerprint, classicSource.sourceFingerprint);
    assert.notEqual((await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "CHANGE"))).sourceFingerprint, portal.sourceFingerprint);
    await assert.rejects(run((tx, scoped) => publishWebExpose(tx, scoped, { ...input, expectedSourceFingerprint: web.sourceFingerprint })), { code: "PREVIEW_CHANGED" });
    await db.admin.query("update seller_listings set price_visibility='hide_price' where id=$1", [propertyId]);
    assert.deepEqual((await run((tx, scoped) => buildWebExposeSnapshot(tx, scoped, input))).snapshot.costs, []);
    assert.deepEqual(buildPropertyExposeDocument(await classic(), pdfOptions("de"), []).costs, []);
    const hiddenPortal = await run((tx, scoped) => previewPropertyPortal(tx, scoped, propertyId, profile.portalName, "CHANGE"));
    assert.deepEqual(hiddenPortal.source.costs, []); assert.doesNotMatch(hiddenPortal.xml, /250000|123\.45|55\.00|<nebenkosten>|<heizkosten>/);
  } finally { await db.stop(); }
});
