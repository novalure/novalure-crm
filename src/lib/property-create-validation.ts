import { resolvePropertyAreaSqm } from "./property-area-input";
import { parsePropertyEuroCents, isEmptyMoneyInput } from "./property-money";
import { propertyObjectTypes } from "./property-core-editing";
import { parsePropertyLinkInput, parsePropertyRelationshipInput } from "./property-link-input";

/** Validate creation before coercion can erase malformed values or round rooms/years. */
export function validatePropertyCreationInput(property: Record<string, unknown>): string | null {
  const fields = property.fieldValues && typeof property.fieldValues === "object" && !Array.isArray(property.fieldValues)
    ? property.fieldValues as Record<string, unknown> : {};
  const area = resolvePropertyAreaSqm(property);
  if (!area.ok) return area.reason;
  const links = parsePropertyLinkInput(property);
  if (!links.ok) return links.reason;
  const relationships = parsePropertyRelationshipInput(property);
  if (!relationships.ok) return relationships.reason;
  for (const [key, limit] of Object.entries({ title: 300, address: 1000, city: 1000, postalCode: 1000, street: 1000,
    objectNumber: 1000, internalReference: 1000, externalPortalId: 1000, openimmoObjectId: 1000,
    contactName: 1000, contactEmail: 1000, contactPhone: 1000, subObjectType: 1000, subObjectTypeCustom: 1000,
    availableFromText: 1000, availabilityNote: 1000, internalNotes: 10000 })) {
    const value = property[key];
    if (value != null && (typeof value !== "string" || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/.test(value))) return `Invalid property ${key}`;
  }
  const type = property.objectType ?? fields["classification.objektart"];
  if (type != null && type !== "" && !(propertyObjectTypes as readonly unknown[]).includes(type)) return "Invalid property object type";
  if (property.marketingType != null && !["sale", "rent", "sale_or_rent"].includes(String(property.marketingType))) return "Invalid property marketing type";
  if (property.usageType != null && !["", "residential", "commercial", "mixed", "investment"].includes(String(property.usageType))) return "Invalid property use";
  for (const [key, value, max, precision] of [
    ["rooms", property.rooms ?? fields["rooms.zimmer"], 999.9, 1],
    ["yearBuilt", property.yearBuilt ?? fields["construction.baujahr"], 9999, 0],
  ] as const) {
    if (value == null || value === "") continue;
    const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
    const parsed = Number(raw.replace(",", "."));
    if (!(precision ? /^\d+(?:[.,]\d)?$/ : /^\d+$/).test(raw) || !Number.isFinite(parsed) || parsed < (key === "yearBuilt" ? 1 : 0) || parsed > max) return `Invalid property ${key}`;
  }
  for (const key of ["price", "publicPrice", "rentPrice", "rentNet", "monthlyCostsGross", "purchaseAncillaryCosts"] as const) {
    const value = property[key] ?? fields[key === "price" ? "costs.kaufpreis" : key === "rentPrice" ? "costs.mietpreis_brutto" : key];
    if (!isEmptyMoneyInput(value) && parsePropertyEuroCents(value) === null) return `Invalid property money: ${key}`;
  }
  for (const key of ["availableFrom"] as const) {
    const value = property[key];
    if (value == null || value === "") continue;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return `Invalid property ${key}`;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) return `Invalid property ${key}`;
  }
  if (property.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(property.contactEmail))) return "Invalid property contact email";
  if (property.priceVisibility != null && !["publish_price", "price_on_request", "hide_price"].includes(String(property.priceVisibility))) return "Invalid property price visibility";
  return null;
}
