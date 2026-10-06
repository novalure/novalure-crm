import type { SellerListing } from "./crm-types";
import type { PropertyDraft, PropertyDraftStore } from "./property-draft-store";
import { parsePropertyAreaSqm } from "./property-area-input";
import { parsePropertyEuroCents } from "./property-money";
import { DEFAULT_PURCHASE_ANCILLARY_RATE, readPurchaseAncillaryCalculation } from "./property-purchase-costs";
import { propertyPurchaseCostsPayload } from "./property-purchase-costs-draft";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const regions = new Set(["Wien", "Steiermark", "Tirol", "Salzburg", "Oberösterreich", "Niederösterreich", "Kärnten", "Burgenland", "Vorarlberg"]);
const objectTypes = new Set(["Wohnung", "Haus", "Neubau", "Zinshaus", "Gewerbe", "Grundstück", "Portfolio"]);

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
  return {
    coreEdit: { propertyId: listing.id, workspaceId: listing.workspaceId, expected: propertyCoreSnapshot(listing), expectedAncillaryCosts: {
      amountCents: listing.purchaseAncillaryCosts == null ? null : parsePropertyEuroCents(listing.purchaseAncillaryCosts), calculation,
    } },
    address: listing.address, areaSqm: String(listing.areaSqm), availableFrom: "", availableFromText: "", availabilityNote: "",
    channelPriceVisibility: {}, contactEmail: "", contactName: "", contactPhone: "", costItems: [], fieldValues: {},
    gdprStatus: "", internalReference: "", marketingType: listing.marketingType || "sale", monthlyCostsGross: "", objectType: listing.objectType,
    objectNumber: "", portalMappingStatus: "", postalCode: "", price: String(listing.targetPrice), priceVisibility: "publish_price",
    projectId: listing.projectId || "", publicPrice: listing.publicPrice == null ? "" : String(listing.publicPrice),
    purchaseAncillaryCosts: listing.purchaseAncillaryCosts == null ? "" : String(listing.purchaseAncillaryCosts),
    purchaseAncillaryMode: calculation ? "percentage" : "manual",
    purchaseAncillaryRate: calculation ? String(calculation.rateBps / 100) : DEFAULT_PURCHASE_ANCILLARY_RATE,
    region: listing.region, rentNet: "", rentPrice: "", rooms: listing.rooms == null ? "" : String(listing.rooms),
    subObjectType: "", textBlocks: {}, title: listing.title, usageType: "", yearBuilt: listing.yearBuilt ? String(listing.yearBuilt) : "",
  };
}

export function propertyCoreUpdatePayload(draft: PropertyDraft, workspaceId: string, propertyId: string) {
  const expected = normalizePropertyCoreExpected(draft.coreEdit?.expected);
  if (!expected || expected.id !== propertyId || expected.workspaceId !== workspaceId || draft.coreEdit?.propertyId !== propertyId || draft.coreEdit.workspaceId !== workspaceId) {
    throw new Error("Invalid property editor target");
  }
  const title = draft.title.trim();
  const address = draft.address.trim();
  const areaSqm = parsePropertyAreaSqm(draft.areaSqm);
  const editorPrice = (value: string) => /^\d+(?:[.,]\d{1,2})?$/.test(value.trim()) ? parsePropertyEuroCents(value) : null;
  const price = editorPrice(draft.price);
  const publicPrice = draft.publicPrice.trim() === "" ? undefined : editorPrice(draft.publicPrice);
  const rooms = draft.rooms.trim() === "" ? undefined : Number(draft.rooms.replace(",", "."));
  const yearBuilt = draft.yearBuilt.trim() === "" ? undefined : Number(draft.yearBuilt);
  if (!title || title.length > 300 || !address || address.length > 1000 || areaSqm === null || price === null || publicPrice === null ||
      !regions.has(draft.region) || !objectTypes.has(draft.objectType) ||
      (rooms !== undefined && (!/^\d+(?:[.,]\d)?$/.test(draft.rooms) || !Number.isFinite(rooms) || rooms > 999.9)) ||
      (yearBuilt !== undefined && (!/^\d{1,4}$/.test(draft.yearBuilt) || yearBuilt < 1 || yearBuilt > 9999))) {
    throw new Error("Invalid property editor input");
  }
  // Only editable core values are sent. No links, publication flags or content fragments.
  return {
    operation: "update_property_core", propertyId,
    property: { title, address, region: draft.region, objectType: draft.objectType, areaSqm, rooms, yearBuilt,
      price: price / 100, publicPrice: publicPrice === undefined ? undefined : publicPrice / 100, expectedCore: expected,
      ...propertyPurchaseCostsPayload(draft), expectedAncillaryCosts: draft.coreEdit.expectedAncillaryCosts },
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
