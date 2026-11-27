import type { PropertyDraft } from "./property-draft-store";
import { normalizePropertyEnergyCertificate, normalizePropertyGeography, type PropertyEnergyCertificate, type PropertyGeography } from "./property-country";
import { propertyObjectTypes } from "./property-core-editing";
import { parsePropertyAreaSqm } from "./property-area-input";
import { parsePropertyEuroCents } from "./property-money";

/** A small, versioned projection of the existing editor draft, not another property model. */
export type PropertyCreationDraft = Pick<PropertyDraft, "projectId" | "title" | "address" | "region" | "objectType" | "usageType" | "areaSqm" | "rooms" | "yearBuilt" | "marketingType" | "price" | "publicPrice" | "rentPrice" | "priceVisibility"> & { version: 1; geography: PropertyGeography | null; energyCertificate: PropertyEnergyCertificate };
export type PropertyCreationDraftRecord = { id: string; draft: PropertyCreationDraft; step: number; revision: number; status: "active" | "created" | "discarded"; propertyId: string | null; updatedAt: string };
export type PropertyCreationIssue = { field: string; message: string; step: number };
const stringLimits = { projectId: 36, title: 300, address: 1000, region: 200, objectType: 80, usageType: 30, areaSqm: 40, rooms: 40, yearBuilt: 40, marketingType: 20, price: 40, publicPrice: 40, rentPrice: 40, priceVisibility: 30 } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function emptyPropertyCreationDraft(projectId = ""): PropertyCreationDraft {
  return { version: 1, projectId, title: "", address: "", region: "", geography: null, energyCertificate: {}, objectType: "Wohnung", usageType: "residential", areaSqm: "", rooms: "", yearBuilt: "", marketingType: "sale", price: "", publicPrice: "", rentPrice: "", priceVisibility: "price_on_request" };
}
/** Unfinished numeric strings are retained for correction. Shape and disclosure fields remain strict. */
export function parsePropertyCreationDraft(value: unknown): PropertyCreationDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Objektentwurf prüfen");
  const v = value as Record<string, unknown>, keys = ["version", "geography", "energyCertificate", ...Object.keys(stringLimits)];
  if (v.version !== 1 || Object.keys(v).some(key => !keys.includes(key))) throw new Error("Entwurfsversion oder Felder ungültig");
  for (const [key, max] of Object.entries(stringLimits)) if (typeof v[key] !== "string" || v[key].length > max || /[\u0000-\u001f<>]/.test(v[key])) throw new Error(`Entwurfsfeld ${key} prüfen`);
  if ((v.projectId !== "" && !uuid.test(String(v.projectId))) || !propertyObjectTypes.includes(v.objectType as typeof propertyObjectTypes[number]) || !["residential", "commercial", "mixed", "investment"].includes(String(v.usageType)) || !["sale", "rent"].includes(String(v.marketingType)) || !["publish_price", "price_on_request", "hide_price"].includes(String(v.priceVisibility))) throw new Error("Objektzuordnung oder Auswahl prüfen");
  const geography = v.geography === null ? null : normalizePropertyGeography(v.geography);
  if ((v.geography !== null && !geography) || (geography && (geography.source !== "explicit" || geography.region !== String(v.region).trim())) || (!geography && v.region !== "")) throw new Error("Objektland und Region müssen übereinstimmen");
  const energyInput = v.energyCertificate;
  const energy = geography ? normalizePropertyEnergyCertificate(energyInput) : (energyInput && typeof energyInput === "object" && !Array.isArray(energyInput) && Object.keys(energyInput).length === 0 ? {} : null);
  if (!energy || (geography && energy.countryCode !== geography.countryCode) || energy.sourceDocumentId) throw new Error("Energieangaben dem Objektland zuordnen; Dokumente nach der Anlage ergänzen");
  return { ...Object.fromEntries(Object.keys(stringLimits).map(key => [key, v[key]])), version: 1, geography, energyCertificate: energy } as PropertyCreationDraft;
}
const money = (value: string) => !value.trim() ? 0 : /^\d+(?:[.,]\d{1,2})?$/.test(value.trim()) ? parsePropertyEuroCents(value) : null;
export function propertyCreationIssues(draft: PropertyCreationDraft): PropertyCreationIssue[] {
  const issues: PropertyCreationIssue[] = [];
  const add = (field: string, message: string, step: number) => { issues.push({ field, message, step }); };
  if (!draft.projectId) add("projectId", "Projekt auswählen", 0);
  if (!draft.geography) add("geography", "Objektland auswählen", 0);
  if (draft.geography && !draft.geography.region) add("region", "Region / Bundesland ergänzen", 0);
  if (!draft.title.trim()) add("title", "Objektbezeichnung ergänzen", 0);
  if (!draft.address.trim()) add("address", "Adresse ergänzen", 0);
  if (draft.areaSqm.trim() && parsePropertyAreaSqm(draft.areaSqm) === null) add("areaSqm", "Fläche als nicht negative Zahl mit höchstens zwei Nachkommastellen eingeben", 1);
  if (draft.rooms.trim() && (!/^\d+(?:[.,]\d)?$/.test(draft.rooms.trim()) || Number(draft.rooms.replace(",", ".")) > 999.9)) add("rooms", "Zimmerzahl prüfen (höchstens eine Nachkommastelle)", 1);
  if (draft.yearBuilt.trim() && (!/^\d{1,4}$/.test(draft.yearBuilt.trim()) || Number(draft.yearBuilt) < 1)) add("yearBuilt", "Baujahr von 1 bis 9999 eingeben", 1);
  for (const field of ["price", "publicPrice", "rentPrice"] as const) if (money(draft[field]) === null) add(field, "EUR-Betrag als nicht negative Zahl mit höchstens zwei Nachkommastellen eingeben", 2);
  return issues;
}
export function propertyCreationPayload(draft: PropertyCreationDraft): Record<string, unknown> {
  const normalized = parsePropertyCreationDraft(draft), issues = propertyCreationIssues(normalized);
  if (issues.length) throw new Error(issues.map(issue => issue.message).join(" · "));
  return { projectId: normalized.projectId, title: normalized.title.trim(), address: normalized.address.trim(), region: normalized.geography!.region, geography: normalized.geography, energyCertificate: normalized.energyCertificate, objectType: normalized.objectType, usageType: normalized.usageType, marketingType: normalized.marketingType, areaSqm: normalized.areaSqm.trim() ? parsePropertyAreaSqm(normalized.areaSqm) : 0, rooms: normalized.rooms.trim() ? Number(normalized.rooms.replace(",", ".")) : undefined, yearBuilt: normalized.yearBuilt.trim() ? Number(normalized.yearBuilt) : undefined, price: money(normalized.price)! / 100, publicPrice: normalized.publicPrice.trim() ? money(normalized.publicPrice)! / 100 : undefined, rentPrice: normalized.rentPrice.trim() ? money(normalized.rentPrice)! / 100 : undefined, priceVisibility: normalized.priceVisibility, gdprStatus: "needs_review", portalMappingStatus: "needs_review" };
}
