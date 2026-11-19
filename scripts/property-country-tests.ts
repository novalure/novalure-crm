import assert from "node:assert/strict";
import { test } from "node:test";
import { countryPublicationChecks, createPropertyGeography, normalizePropertyEnergyCertificate, normalizePropertyGeography, propertyGeographyFromInput, readPropertyGeography } from "../src/lib/property-country";
import { getPropertyCountryRequirements, getPropertyCountryRequirementSource } from "../src/lib/property-country-requirements";
import { createPropertyCoreDraft, propertyCoreUpdatePayload } from "../src/lib/property-core-editing";
import type { SellerListing } from "../src/lib/crm-types";

test("country resolver preserves foreign regions and only infers legacy Austria from a known region", () => {
  assert.equal(readPropertyGeography({ region: "Bayern" }), null);
  assert.equal(readPropertyGeography({ region: "Dublin" }), null);
  assert.equal(readPropertyGeography({ region: "" }), null);
  assert.equal(readPropertyGeography({ region: "Niederoesterreich" })?.countryCode, "AT");
  assert.equal(readPropertyGeography({ region: "Niederoesterreich" })?.source, "legacy_at_region");
  assert.equal(propertyGeographyFromInput({ region: "Bayern" }).ok, false);
  const result = propertyGeographyFromInput({ countryCode: "DE", region: "Bayern" });
  assert.ok(result.ok); assert.equal(result.geography.region, "Bayern"); assert.equal(result.geography.countryCode, "DE");
  assert.equal(propertyGeographyFromInput({ countryCode: "GB", region: "Wien" }).ok, false);
});

test("country, content language, display format and booking timezone remain independent", () => {
  const geography = { ...createPropertyGeography("ES", "Catalunya"), contentLanguage: "en", displayLocale: "en-IE", bookingTimezone: "Atlantic/Canary" };
  const parsed = normalizePropertyGeography(geography);
  assert.ok(parsed); assert.equal(parsed.countryCode, "ES"); assert.equal(parsed.contentLanguage, "en"); assert.equal(parsed.displayLocale, "en-IE");
  assert.equal(parsed.bookingTimezone, "Atlantic/Canary");
  for (const patch of [{ countryCode: "US" }, { version: 2 }, { displayLocale: "garbage" }, { contentLanguage: "fr" }, { currency: "USD" }, { bookingTimezone: "Europe/Nowhere" }, { region: "<script>" }]) {
    assert.equal(normalizePropertyGeography({ ...geography, ...patch }), null);
  }
  assert.equal(readPropertyGeography({ region: "Wien", canonicalPayload: { geography: { broken: true } } }), null);
});

test("publication review distinguishes missing data, explicit exceptions, and both Irish certificate generations", () => {
  const at = createPropertyGeography("AT", "Wien");
  assert.equal(countryPublicationChecks({ geography: at, asOf: "2026-11-04", energy: { heatingDemandKwhM2: 32 } }).find((check) => check.id === "AT-ENERGY")?.status, "missing");
  assert.equal(countryPublicationChecks({ geography: at, energy: { heatingDemandKwhM2: 32, finalEnergyDemandKwhM2: 51, energyClass: "B" } }).find((check) => check.id === "AT-ENERGY")?.status, "ready");
  assert.equal(countryPublicationChecks({ geography: at, energy: { exemptionReason: "Needs review" } }).find((check) => check.id === "AT-ENERGY")?.status, "review");
  const ie = createPropertyGeography("IE", "Dublin");
  for (const [schemeVersion, energyClass, expected] of [["SEAI-pre-2026-05-24", "A2", "ready"], ["SEAI-2026-05-24", "A0", "ready"], ["SEAI-2026-05-24", "B2", "missing"], ["", "A0", "missing"]]) {
    assert.equal(countryPublicationChecks({ geography: ie, energy: { schemeVersion, energyClass, issuedAt: schemeVersion === "SEAI-pre-2026-05-24" ? "2026-05-01" : "2026-06-01", certificateNumber: "123456789", finalEnergyDemandKwhM2: 50 } }).find((check) => check.id === "IE-BER")?.status, expected);
  }
});

test("certificate boundary validates dates and data and DE uses the correct building-specific metric", () => {
  const base = { version: 1, countryCode: "DE" };
  for (const patch of [{ issuedAt: "2026-99-40" }, { issuedAt: "2026-02-30" }, { energySource: "<script>" }, { finalEnergyDemandKwhM2: -1 }, { certificateType: "anything" }, { internalNotes: "private" }, { countryCode: "FR" }]) assert.equal(normalizePropertyEnergyCertificate({ ...base, ...patch }), null);
  assert.ok(normalizePropertyEnergyCertificate({ ...base, issuedAt: "2026-02-28", energySource: "Heat pump", finalEnergyDemandKwhM2: 0 }));
  const geography = createPropertyGeography("DE", "Bayern");
  const energy = { certificateType: "consumption" as const, energySource: "Gas", energyClass: "C", finalEnergyConsumptionKwhM2: 80 };
  const status = (usageType: string, certificate: typeof energy, yearBuilt?: number) => countryPublicationChecks({ geography, energy: certificate, usageType, yearBuilt }).find((check) => check.id === "DE-ENERGY")?.status;
  assert.equal(status("residential", energy, 2000), "ready");
  assert.equal(status("residential", energy), "missing");
  assert.equal(status("commercial", energy, 2000), "missing");
  assert.equal(countryPublicationChecks({ geography, usageType: "commercial", energy: { certificateType: "demand", energySource: "Gas", heatingEnergyKwhM2: 30, electricityEnergyKwhM2: 20 } }).find((check) => check.id === "DE-ENERGY")?.status, "ready");
});

test("all 36 country requirements retain resolvable primary sources", () => {
  let count = 0;
  for (const country of ["AT", "DE", "ES", "IE"] as const) {
    const requirements = getPropertyCountryRequirements(country);
    count += requirements.length;
    for (const requirement of requirements) for (const source of requirement.sources) assert.ok(getPropertyCountryRequirementSource(source)?.url.startsWith("https://"), `${requirement.id}:${source}`);
  }
  assert.equal(count, 36);
});

test("country-aware core saves keep the comparison snapshot and reject AT percentage calculations abroad", () => {
  const listing = { id: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "", title: "Synthetic", address: "Dublin", region: "Dublin", objectType: "Wohnung", areaSqm: 80, yearBuilt: 2020, marketValue: 100, targetPrice: 100, sellerLeadId: "", createdAt: "2026-11-04", canonicalPayload: { geography: createPropertyGeography("IE", "Dublin") } } as SellerListing;
  const draft = createPropertyCoreDraft(listing);
  draft.title = "Changed";
  const payload = propertyCoreUpdatePayload(draft, listing.workspaceId!, listing.id);
  assert.equal(payload.property.region, "Dublin"); assert.equal(payload.property.geography.countryCode, "IE");
  assert.deepEqual(payload.property.expectedGeography, listing.canonicalPayload?.geography);
  draft.purchaseAncillaryMode = "percentage";
  assert.throws(() => propertyCoreUpdatePayload(draft, listing.workspaceId!, listing.id), /ancillary country/);
});
