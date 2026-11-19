import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { exposeSourceSql, type ExposeSource } from "../src/lib/db/property-expose-repositories";
import { buildPropertyExposeDocument } from "../src/lib/property-expose-service";
import { renderPropertyExposePdf } from "../src/lib/property-expose-pdf";
import { createPropertyGeography } from "../src/lib/property-country";

async function renderedText(document: ReturnType<typeof buildPropertyExposeDocument>) {
  const task = getDocument({ data: Uint8Array.from(await renderPropertyExposePdf(document)), useSystemFonts: false, disableFontFace: true, standardFontDataUrl: path.resolve("node_modules/pdfjs-dist/standard_fonts").replaceAll("\\", "/") + "/" });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      pages.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
    }
    return pages.join(" ");
  } finally {
    await task.destroy();
  }
}

test("developer PDF sale and zero prices require the matching current unit confirmation", { timeout: 120000 }, async () => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 186 });
    const workspaceId = randomUUID(), projectId = randomUUID(), propertyId = randomUUID(), unitId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,customer_type) values($1,'SYNTHETIC zero price','real_estate_broker')", [workspaceId]);
    await db.admin.query("insert into projects(id,workspace_id,name,type,customer_type) values($1,$2,'SYNTHETIC developer','Bautraeger','property_developer')", [projectId, workspaceId]);
    await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,area_sqm,price_cents,status) values($1,$2,$3,'SYNTHETIC ZERO',75,0,'available')", [unitId, workspaceId, projectId]);
    const canonical = { geography: createPropertyGeography("AT", "Wien"), coreNumericState: { version: 1, areaSqm: "known", price: "known", publicPrice: "known", rentPrice: "known" } };
    await db.admin.query("insert into seller_listings(id,workspace_id,project_id,unit_id,title,address,region,area_sqm,object_type,marketing_type,target_price_cents,price_visibility,canonical_payload) values($1,$2,$3,$4,'SYNTHETIC ZERO','SYNTHETIC PRIVATE ADDRESS','Wien',75,'Wohnung','sale',0,'publish_price',$5::jsonb)", [propertyId, workspaceId, projectId, unitId, JSON.stringify(canonical)]);
    const source = async () => (await db.admin.query(`select ${exposeSourceSql} as source from seller_listings p where id=$1`, [propertyId])).rows[0].source as ExposeSource;
    const build = (saved: ExposeSource, showPrice = true) => buildPropertyExposeDocument({ propertyId, workspaceId, projectId, source: saved, registryRaw: null, registry: { schemaVersion: 1, revision: "initial", preferredSource: "generated", activeDocumentId: null, versions: [] }, sourceFingerprint: "synthetic" }, { template: "compact", language: "de", address: "hidden", showPrice, showContact: false, imageIds: [], floorPlanIds: [] }, []);
    for (const mode of ["asking", "public", "rent"] as const) {
      await db.admin.query("update property_units set metadata='{}' where id=$1", [unitId]);
      await db.admin.query("update seller_listings set marketing_type=$2,public_price_cents=$3::bigint,rent_price_cents=$4::bigint where id=$1", [propertyId, mode === "rent" ? "rent" : "sale", mode === "public" ? 0 : null, mode === "rent" ? 0 : null]);
      const unconfirmed = await source();
      assert.equal(unconfirmed.listing.developer, true); assert.equal(unconfirmed.listing.confirmedCurrentPrice, false);
      assert.throws(() => build(unconfirmed), { code: "EXPOSE_PRICE_UNCONFIRMED" });
      assert.equal(build(unconfirmed, false).price, undefined, "hiding price remains valid");
      await db.admin.query("update property_units set metadata=jsonb_build_object('priceConfirmation',jsonb_build_object('sourceReference','SYNTHETIC approved zero','priceCents','0')) where id=$1", [unitId]);
      const confirmed = await source(); assert.equal(confirmed.listing.confirmedCurrentPrice, true);
      assert.match(await renderedText(build(confirmed)), /0,00/, "authorized zero survives actual PDF bytes");
      await db.admin.query("update property_units set metadata=jsonb_set(metadata,'{priceConfirmation,priceCents}','\"1\"') where id=$1", [unitId]);
      const mismatched = await source(); assert.throws(() => build(mismatched), { code: "EXPOSE_PRICE_UNCONFIRMED" });
      await db.admin.query("update projects set type='Service',customer_type='real_estate_broker' where id=$1", [projectId]);
      const nonDeveloper = await source(); assert.equal(nonDeveloper.listing.developer, false); assert.ok(build(nonDeveloper).price?.includes("0,00"));
      await db.admin.query("update projects set type='Bautraeger',customer_type='property_developer' where id=$1", [projectId]);
    }

    const sale = 38765432, investor = 49876543, rent = 198765;
    const foreignWorkspaceId = randomUUID(), foreignProjectId = randomUUID(), foreignUnitId = randomUUID();
    const saleConfirmation = { sourceReference: "SYNTHETIC confirmed sale", priceCents: sale };
    await db.admin.query("insert into workspaces(id,name) values($1,'SYNTHETIC foreign workspace')", [foreignWorkspaceId]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC foreign project','Service')", [foreignProjectId, foreignWorkspaceId]);
    await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,area_sqm,price_cents,status,metadata) values($1,$2,$3,'SYNTHETIC FOREIGN',75,$4,'available',$5)", [foreignUnitId, foreignWorkspaceId, foreignProjectId, sale, { priceConfirmation: saleConfirmation }]);
    await db.admin.query("update property_units set price_cents=$2,investor_price_cents=$3,metadata='{}' where id=$1", [unitId, sale, investor]);
    // Mirror the supported product transition: save as a broker, then assign the developer.
    await db.admin.query("update projects set type='Service',customer_type='real_estate_broker' where id=$1", [projectId]);
    await db.admin.query("update seller_listings set marketing_type='sale',target_price_cents=$2,public_price_cents=$2,rent_price_cents=null where id=$1", [propertyId, sale]);
    await db.admin.query("update projects set type='Bautraeger',customer_type='property_developer' where id=$1", [projectId]);
    const unconfirmedSale = await source();
    assert.equal(unconfirmedSale.listing.confirmedCurrentPrice, false, "the foreign workspace confirmation cannot satisfy the current property scope");
    assert.throws(() => build(unconfirmedSale), { code: "EXPOSE_PRICE_UNCONFIRMED" });
    assert.doesNotMatch(await renderedText(build(unconfirmedSale, false)), /387[.\s]654|498[.\s]765/);

    const investorConfirmation = { sourceReference: "SYNTHETIC confirmed investor price", investorPriceCents: investor };
    await db.admin.query("update property_units set metadata=$2 where id=$1", [unitId, { investorPriceConfirmation: investorConfirmation }]);
    const investorOnly = await source();
    assert.throws(() => build(investorOnly), { code: "EXPOSE_PRICE_UNCONFIRMED" });
    await db.admin.query("update property_units set metadata=$2 where id=$1", [unitId, { priceConfirmation: { ...saleConfirmation, priceCents: sale - 1 }, investorPriceConfirmation: investorConfirmation }]);
    const mismatchedSale = await source();
    assert.throws(() => build(mismatchedSale), { code: "EXPOSE_PRICE_UNCONFIRMED" });
    await db.admin.query("update property_units set metadata=$2 where id=$1", [unitId, { priceConfirmation: saleConfirmation, investorPriceConfirmation: investorConfirmation }]);
    const confirmedSale = await source();
    assert.equal(confirmedSale.listing.confirmedCurrentPrice, true);
    const saleText = await renderedText(build(confirmedSale));
    assert.match(saleText, /387[.\s]654,32/);
    assert.doesNotMatch(saleText, /498[.\s]765/);

    await db.admin.query("update seller_listings set marketing_type='sale_or_rent' where id=$1", [propertyId]);
    assert.match(await renderedText(build(await source())), /387[.\s]654,32/);
    await db.admin.query("update property_units set metadata=$2 where id=$1", [unitId, { investorPriceConfirmation: investorConfirmation }]);
    const unconfirmedMixed = await source();
    assert.throws(() => build(unconfirmedMixed), { code: "EXPOSE_PRICE_UNCONFIRMED" });
    await db.admin.query("update property_units set metadata=$2 where id=$1", [unitId, { priceConfirmation: saleConfirmation, investorPriceConfirmation: investorConfirmation }]);

    await db.admin.query("update seller_listings set marketing_type='rent',rent_price_cents=$2 where id=$1", [propertyId, rent]);
    const rental = await source();
    assert.equal(rental.listing.confirmedCurrentPrice, false);
    const rentText = await renderedText(build(rental));
    assert.match(rentText, /1[.\s]987,65/);
    assert.doesNotMatch(rentText, /387[.\s]654|498[.\s]765/);
  } finally { await db.stop(); }
});
