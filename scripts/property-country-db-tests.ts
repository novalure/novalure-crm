import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createSellerListingRecord, updateSellerListingRecord } from "../src/lib/db/property-department-repositories";
import { createPropertyGeography, type PropertyEnergyCertificate } from "../src/lib/property-country";
import { createPropertyCoreDraft, propertyCoreUpdatePayload } from "../src/lib/property-core-editing";
import type { SellerListing } from "../src/lib/crm-types";

test("country persistence and optimistic certificate updates run in an isolated tenant database", { timeout: 180000 }, async (t) => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    const workspaceId = randomUUID(), userId = randomUUID(), projectId = randomUUID(), foreignWorkspace = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC country','novalure_internal','novalure_internal'),($2,'SYNTHETIC foreign','novalure_internal','novalure_internal')", [workspaceId, foreignWorkspace]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic country owner',$3,'owner','novalureAdmin','active')", [userId, workspaceId, `country-${userId}@example.invalid`]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC country project','Service')", [projectId, workspaceId]);
    const session = { authenticated: true, userId, workspaceId, workspaceName: "Synthetic country", name: "Synthetic", email: `country-${userId}@example.invalid`, role: "owner", productRole: "novalureAdmin", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("novalureAdmin"), source: "database" } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool };
    const run = <T>(work: () => Promise<T>) => withCrmRead(session, work, options);
    const listings: SellerListing[] = [];
    await t.test("AT, DE, ES and IE keep their own region, locale and language after create", async () => {
      for (const [country, region] of [["AT", "Tirol"], ["DE", "Bayern"], ["ES", "Catalunya"], ["IE", "Dublin"]] as const) {
        const result = await run(() => createSellerListingRecord({ session, property: { title: `SYNTHETIC ${country}`, address: `SYNTHETIC address ${country}`, geography: createPropertyGeography(country, region), region, projectId, price: 100000, areaSqm: 50, objectType: "Wohnung", usageType: "residential" } }));
        assert.equal(result.persisted, true, JSON.stringify(result));
        if (!result.persisted) return;
        listings.push(result.data); assert.equal(result.data.region, region); assert.equal(result.data.countryCode, country);
        const stored = (await db.admin.query("select canonical_payload->'geography' as geography,region from seller_listings where id=$1", [result.data.id])).rows[0];
        assert.equal(stored.geography.countryCode, country); assert.equal(stored.region, region);
      }
      const bad = await run(() => createSellerListingRecord({ session, property: { title: "Unresolved", address: "Synthetic", region: "Bayern", projectId } }));
      assert.equal(bad.persisted, false);
      assert.equal(Number((await db.admin.query("select count(*) from seller_listings where workspace_id=$1", [workspaceId])).rows[0].count), 4);
    });
    await t.test("certificate data persists, rejects stale edits and retains the original region", async () => {
      const listing = listings.find((item) => item.countryCode === "IE")!;
      const draft = createPropertyCoreDraft(listing);
      const energy: PropertyEnergyCertificate = { version: 1, countryCode: "IE", schemeVersion: "SEAI-2026-05-24", energyClass: "A0", issuedAt: "2026-06-01", validUntil: "2036-06-01", certificateNumber: "123456789", finalEnergyDemandKwhM2: 15 };
      draft.energyCertificate = energy;
      const payload = propertyCoreUpdatePayload(draft, workspaceId, listing.id);
      const saved = await run(() => updateSellerListingRecord({ session, propertyId: listing.id, property: payload.property }));
      assert.equal(saved.persisted, true, JSON.stringify(saved));
      if (!saved.persisted) return;
      assert.deepEqual(saved.data.canonicalPayload?.energyCertificate, energy); assert.equal(saved.data.region, "Dublin");
      const stale = await run(() => updateSellerListingRecord({ session, propertyId: listing.id, property: { ...payload.property, energyCertificate: { ...energy, energyClass: "B" } } }));
      assert.equal(stale.persisted, false); if (!stale.persisted) assert.match(stale.reason, /Conflict/);
      const stored = (await db.admin.query("select canonical_payload->'energyCertificate' as energy from seller_listings where id=$1", [listing.id])).rows[0];
      assert.deepEqual(stored.energy, energy);
      const mismatch = await run(() => updateSellerListingRecord({ session, propertyId: listing.id, property: { energyCertificate: { ...energy, countryCode: "DE" }, expectedEnergyCertificate: energy } }));
      assert.equal(mismatch.persisted, false);
      const foreign = await run(() => updateSellerListingRecord({ session, propertyId: randomUUID(), property: payload.property }));
      assert.equal(foreign.persisted, false);
    });
    await t.test("geography CAS and use CAS prevent one browser from overwriting another", async () => {
      const listing = listings.find((item) => item.countryCode === "DE")!;
      const firstDraft = createPropertyCoreDraft(listing), secondDraft = createPropertyCoreDraft(listing);
      firstDraft.geography = { ...firstDraft.geography!, displayLocale: "en-IE" }; firstDraft.usageType = "commercial";
      const first = propertyCoreUpdatePayload(firstDraft, workspaceId, listing.id);
      const saved = await run(() => updateSellerListingRecord({ session, propertyId: listing.id, property: first.property }));
      assert.equal(saved.persisted, true, JSON.stringify(saved));
      secondDraft.title = "Stale overwrite";
      const second = propertyCoreUpdatePayload(secondDraft, workspaceId, listing.id);
      const rejected = await run(() => updateSellerListingRecord({ session, propertyId: listing.id, property: second.property }));
      assert.equal(rejected.persisted, false);
      const stored = (await db.admin.query("select canonical_payload->'geography'->>'displayLocale' as locale,usage_type as use,title from seller_listings where id=$1", [listing.id])).rows[0];
      assert.equal(stored.locale, "en-IE"); assert.equal(stored.use, "commercial"); assert.notEqual(stored.title, "Stale overwrite");
    });
    await t.test("legacy region-only updates remain coherent without changing the explicit country or guessing a foreign one", async () => {
      const listing = listings.find((item) => item.countryCode === "DE")!;
      const updated = await run(() => updateSellerListingRecord({ session, propertyId: listing.id, property: { region: "Baden-Württemberg" } })); assert.equal(updated.persisted, true, JSON.stringify(updated)); if (!updated.persisted) return;
      assert.equal(updated.data.region, "Baden-Württemberg"); assert.equal(updated.data.canonicalPayload?.geography && (updated.data.canonicalPayload.geography as Record<string, unknown>).region, "Baden-Württemberg");
      assert.equal((updated.data.canonicalPayload?.geography as Record<string, unknown>).countryCode, "DE"); assert.equal((updated.data.canonicalPayload?.geography as Record<string, unknown>).displayLocale, "en-IE");
      const geo = updated.data.canonicalPayload?.geography as Record<string, unknown>;
      const cleared = await run(() => updateSellerListingRecord({ session, propertyId: listing.id, property: { region: "", geography: { ...geo, region: "" }, expectedGeography: geo } })); assert.equal(cleared.persisted, true, JSON.stringify(cleared));
      const stored = (await db.admin.query("select region,federal_state,canonical_payload->'geography'->>'region' as geo_region from seller_listings where id=$1", [listing.id])).rows[0]; assert.deepEqual(stored, { region: "", federal_state: "", geo_region: "" });
      const legacy = await run(() => createSellerListingRecord({ session, property: { title: "SYNTHETIC inferred AT", address: "Synthetic", region: "Tirol", objectType: "Wohnung", projectId, price: 100000, purchaseAncillaryCalculation: { mode: "percentage", rateBps: 460, version: 1, jurisdiction: "AT" } } })); assert.equal(legacy.persisted, true, JSON.stringify(legacy)); if (!legacy.persisted) return;
      const foreign = await run(() => updateSellerListingRecord({ session, propertyId: legacy.data.id, property: { region: "Catalunya" } })); assert.equal(foreign.persisted, true, JSON.stringify(foreign)); if (!foreign.persisted) return;
      assert.equal(foreign.data.region, "Catalunya"); assert.equal(foreign.data.countryCode, undefined); assert.equal(foreign.data.canonicalPayload?.geography, null); assert.equal(foreign.data.canonicalPayload?.purchaseAncillaryCalculation, undefined);
      const ancillary = (await db.admin.query("select purchase_ancillary_costs_cents from seller_listings where id=$1", [legacy.data.id])).rows[0]; assert.equal(ancillary.purchase_ancillary_costs_cents, null);
      const contradictory = await run(() => updateSellerListingRecord({ session, propertyId: listings[0].id, property: { region: "Bayern", geography: createPropertyGeography("AT", "Tirol"), expectedGeography: listings[0].canonicalPayload?.geography } })); assert.equal(contradictory.persisted, false);
    });
  } finally { await db.stop(); }
});
