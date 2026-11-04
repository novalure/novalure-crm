import type { SellerListing } from "./crm-types";
import type { PropertyDraft, PropertyDraftStore } from "./property-draft-store";
import { parsePropertyAreaSqm } from "./property-area-input";
import { parsePropertyEuroCents } from "./property-money";
import { DEFAULT_PURCHASE_ANCILLARY_RATE, readPurchaseAncillaryCalculation } from "./property-purchase-costs";
import { propertyPurchaseCostsPayload } from "./property-purchase-costs-draft";
import { normalizePropertyEnergyCertificate, normalizePropertyGeography, normalizePropertyRegion, readPropertyGeography } from "./property-country";
import { readPropertyDetails, propertyDetailsInput, propertyDetailsLegacyFields } from "./property-details";
import { propertyFullSnapshot } from "./property-full-editing";
import { propertyCoreNumberIsKnown, propertyOptionalPriceIsKnown } from "./property-core-numbers";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const propertyObjectTypes = ["Wohnung", "Haus", "Neubau", "Zinshaus", "Gewerbe", "Grundstück", "Portfolio"] as const;
const objectTypes = new Set<string>(propertyObjectTypes);

export function propertyCoreDraftKey(userId: string, workspaceId: string, propertyId: string) {
  return JSON.stringify(["property-core", userId, workspaceId, propertyId]);
}

export function propertyCoreSnapshot(listing: SellerListing): Record<string, unknown> {
  return {
    id: listing.id, workspaceId: listing.workspaceId, projectId: listing.projectId || null,
    title: listing.title, address: listing.address, region: listing.region, objectType: listing.objectType,
    areaSqm: listing.areaSqm, rooms: listing.rooms ?? null, yearBuilt: listing.yearBuilt || 0,
    priceCents: parsePropertyEuroCents(listing.targetPrice),
    publicPriceCents: listing.publicPrice == null ? null : parsePropertyEuroCents(listing.publicPrice),
  };
}

/** Validate the fixed snapshot shape before including it in an atomic SQL comparison. */
export function normalizePropertyCoreExpected(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!uuid.test(String(v.id)) || !uuid.test(String(v.workspaceId)) || (v.projectId !== null && !uuid.test(String(v.projectId)))) return null;
  if (![v.title, v.address, v.region, v.objectType].every((item) => typeof item === "string" && item.length <= 2000)) return null;
  if (parsePropertyAreaSqm(v.areaSqm) === null || !Number.isInteger(v.yearBuilt) || Number(v.yearBuilt) < 0) return null;
  if (v.rooms !== null && (typeof v.rooms !== "number" || !Number.isFinite(v.rooms) || v.rooms < 0)) return null;
  if (!Number.isSafeInteger(v.priceCents) || Number(v.priceCents) < 0) return null;
  if (v.publicPriceCents !== null && (!Number.isSafeInteger(v.publicPriceCents) || Number(v.publicPriceCents) < 0)) return null;
  const keys = ["id", "workspaceId", "projectId", "title", "address", "region", "objectType", "areaSqm", "rooms", "yearBuilt", "priceCents", "publicPriceCents"];
  return Object.fromEntries(keys.map((key) => [key, v[key]]));
}

export function createPropertyCoreDraft(listing: SellerListing): PropertyDraft {
  const calculation = readPurchaseAncillaryCalculation(listing.canonicalPayload);
  const geography = readPropertyGeography(listing);
  return {
    coreEdit: { propertyId: listing.id, workspaceId: listing.workspaceId, expected: propertyCoreSnapshot(listing), expectedAncillaryCosts: {
      amountCents: listing.purchaseAncillaryCosts == null ? null : parsePropertyEuroCents(listing.purchaseAncillaryCosts), calculation,
    }, expectedGeography: listing.canonicalPayload?.geography as Record<string, unknown> | null ?? null,
      expectedEnergyCertificate: listing.canonicalPayload?.energyCertificate as Record<string, unknown> | null ?? null, expectedUsageType: listing.usageType ?? "",expectedFullSnapshot:propertyFullSnapshot(listing) },
    propertyDetails:readPropertyDetails(listing),
    city:listing.city??"",street:listing.street??"",internalNotes:listing.internalNotes??"",
    geography,
    energyCertificate: normalizePropertyEnergyCertificate(listing.canonicalPayload?.energyCertificate) ?? { version: 1, countryCode: geography?.countryCode },
    address: listing.address, areaSqm: propertyCoreNumberIsKnown(listing.canonicalPayload, "areaSqm", listing.areaSqm) ? String(listing.areaSqm) : "", availableFrom: listing.availableFrom?.slice(0,10)??"", availableFromText: listing.availableFromText??"", availabilityNote: listing.availabilityNote??"",
    channelPriceVisibility: listing.channelPriceVisibility??{}, contactEmail: listing.contactEmail??"", contactName: listing.contactName??"", contactPhone: listing.contactPhone??"", costItems: [], fieldValues: propertyDetailsLegacyFields(readPropertyDetails(listing)),
    gdprStatus: listing.gdprStatus??"needs_review", internalReference: listing.internalReference??"", marketingType: listing.marketingType || "sale", monthlyCostsGross: listing.monthlyCostsGross==null?"":String(listing.monthlyCostsGross), objectType: listing.objectType,
    objectNumber: listing.objectNumber??"", portalMappingStatus: listing.portalMappingStatus??"needs_review", postalCode: listing.postalCode??"", price: propertyCoreNumberIsKnown(listing.canonicalPayload, "price", listing.targetPrice) ? String(listing.targetPrice) : "", priceVisibility: listing.priceVisibility??"price_on_request",
    projectId: listing.projectId || "", publicPrice: propertyOptionalPriceIsKnown(listing.canonicalPayload, "publicPrice", parsePropertyEuroCents(listing.publicPrice)) ? String(listing.publicPrice) : "",
    purchaseAncillaryCosts: listing.purchaseAncillaryCosts == null ? "" : String(listing.purchaseAncillaryCosts),
    purchaseAncillaryMode: calculation && geography?.countryCode === "AT" ? "percentage" : "manual",
    purchaseAncillaryRate: calculation ? String(calculation.rateBps / 100) : DEFAULT_PURCHASE_ANCILLARY_RATE,
    region: listing.region, rentNet: listing.rentNet==null?"":String(listing.rentNet), rentPrice: propertyOptionalPriceIsKnown(listing.canonicalPayload, "rentPrice", parsePropertyEuroCents(listing.rentPrice)) ? String(listing.rentPrice) : "", rooms: listing.rooms == null ? "" : String(listing.rooms),
    subObjectType: listing.subObjectType??"", textBlocks: {}, title: listing.title, usageType: listing.usageType ?? "", yearBuilt: listing.yearBuilt ? String(listing.yearBuilt) : "",
  };
}

export function propertyCoreUpdatePayload(draft: PropertyDraft, workspaceId: string, propertyId: string) {
  const expected = normalizePropertyCoreExpected(draft.coreEdit?.expected);
  if (!expected || expected.id !== propertyId || expected.workspaceId !== workspaceId || draft.coreEdit?.propertyId !== propertyId || draft.coreEdit.workspaceId !== workspaceId) {
    throw new Error("Invalid property editor target");
  }
  const title = draft.title.trim();
  const address = draft.address.trim();
  const complete = !!draft.coreEdit.expectedFullSnapshot;
  const areaSqm = complete && draft.areaSqm.trim() === "" ? null : parsePropertyAreaSqm(draft.areaSqm);
  const editorPrice = (value: string) => /^\d+(?:[.,]\d{1,2})?$/.test(value.trim()) ? parsePropertyEuroCents(value) : null;
  const price = complete && draft.price.trim() === "" ? null : editorPrice(draft.price);
  const emptyOptional = complete ? null : undefined;
  const publicPrice = draft.publicPrice.trim() === "" ? emptyOptional : editorPrice(draft.publicPrice);
  const rooms = draft.rooms.trim() === "" ? emptyOptional : Number(draft.rooms.replace(",", "."));
  const yearBuilt = draft.yearBuilt.trim() === "" ? emptyOptional : Number(draft.yearBuilt);
  const geography = normalizePropertyGeography(draft.geography);
  const energyCertificate = normalizePropertyEnergyCertificate(draft.energyCertificate);
  if (!title || title.length > 300 || !address || address.length > 1000 || (areaSqm === null && (!complete || draft.areaSqm.trim() !== "")) || (price === null && (!complete || draft.price.trim() !== "")) || (draft.publicPrice.trim() !== "" && publicPrice === null) ||
      !geography || geography.region !== normalizePropertyRegion(draft.region) || !energyCertificate || energyCertificate.countryCode !== geography.countryCode || !objectTypes.has(draft.objectType) || !["", "residential", "commercial", "mixed", "investment"].includes(draft.usageType) ||
      (rooms != null && (!/^\d+(?:[.,]\d)?$/.test(draft.rooms) || !Number.isFinite(rooms) || rooms > 999.9)) ||
      (yearBuilt != null && (!/^\d{1,4}$/.test(draft.yearBuilt) || yearBuilt < 1 || yearBuilt > 9999))) {
    throw new Error("Invalid property editor input");
  }
  // Only editable core values are sent. No links, publication flags or content fragments.
  const full = draft.coreEdit.expectedFullSnapshot ? {
    expectedFullSnapshot:draft.coreEdit.expectedFullSnapshot,
    objectNumber:draft.objectNumber,internalReference:draft.internalReference,postalCode:draft.postalCode,city:draft.city??"",street:draft.street??"",contactName:draft.contactName,contactEmail:draft.contactEmail,contactPhone:draft.contactPhone,
    subObjectType:draft.subObjectType,availableFrom:draft.availableFrom,availableFromText:draft.availableFromText,availabilityNote:draft.availabilityNote,internalNotes:draft.internalNotes??"",marketingType:draft.marketingType,
    ...Object.fromEntries((["rentNet","rentPrice","monthlyCostsGross"] as const).map(key=>{const value=draft[key].trim()===""?null:editorPrice(draft[key]);if(value===null&&draft[key].trim()!=="")throw new Error("Invalid property editor money");return[key,value===null?null:value/100];})),
    ...propertyDetailsInput({...draft,propertyDetails:draft.propertyDetails??readPropertyDetails({canonicalPayload:{fieldValues:draft.fieldValues}})}),
  } : {};
  return {
    operation: draft.coreEdit.expectedFullSnapshot ? "update_property_full" : "update_property_core", propertyId,
    property: { title, address, region: geography.region, objectType: draft.objectType, areaSqm, rooms, yearBuilt,
      price: price === null ? null : price / 100, publicPrice: publicPrice == null ? publicPrice : publicPrice / 100, expectedCore: expected,
      geography, expectedGeography: draft.coreEdit.expectedGeography ?? null,
      energyCertificate, expectedEnergyCertificate: draft.coreEdit.expectedEnergyCertificate ?? null,
      usageType: draft.usageType, expectedUsageType: draft.coreEdit.expectedUsageType ?? "",
      ...propertyPurchaseCostsPayload(draft), expectedAncillaryCosts: draft.coreEdit.expectedAncillaryCosts,...full },
  };
}

export type PropertyCoreSaveOutcome = { kind: "saved" | "saved_refresh_failed"; listing: SellerListing } | { kind: "busy" };

export async function savePropertyCoreDraft(input: {
  draft: PropertyDraft; workspaceId: string; propertyId: string; scopeKey: string; store: PropertyDraftStore;
  request: (url: string, init: RequestInit) => Promise<Response>; onChanged: () => void | Promise<void>;
}): Promise<PropertyCoreSaveOutcome> {
  const body = propertyCoreUpdatePayload(input.draft, input.workspaceId, input.propertyId);
  const token = input.store.acquireMutation();
  if (!token) return { kind: "busy" };
  try {
    const response = await input.request(`/api/crm/properties?workspaceId=${encodeURIComponent(input.workspaceId)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { persisted?: unknown; data?: SellerListing; error?: unknown } | null;
    if (response.status === 409) throw new Error("property_core_conflict");
    if (!response.ok || payload?.persisted !== true || payload.data?.id !== input.propertyId || payload.data?.workspaceId !== input.workspaceId) {
      throw new Error("property_core_save_unconfirmed");
    }
    input.store.clear(input.scopeKey, input.draft);
    try { await input.onChanged(); }
    catch { return { kind: "saved_refresh_failed", listing: payload.data }; }
    return { kind: "saved", listing: payload.data };
  } finally { input.store.releaseMutation(token); }
}
