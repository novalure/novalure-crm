import type { CountryPublicationCheck, PropertyEnergyCertificate, PropertyGeography } from "./property-country";

export const openImmoReference = "https://www.openimmo.de/go.php/p/24/download.htm";
export const openImmoSchemaRelease = "1.2.7d";
export const portalPropertyTypes = ["apartment", "house", "land", "office", "investment", "other"] as const;
export type PortalPropertyType = typeof portalPropertyTypes[number];
export type PropertyPortalProfile = {
  portalName: string; providerName: string; providerId: string; agencyId: string; externalObjectId: string;
  contactName: string; contactEmail: string; propertyType: PortalPropertyType;
  includeAddress: boolean; includeMedia: boolean;
};
export type PropertyPortalSource = {
  propertyId: string; projectId: string | null; title: string; city: string; postalCode: string; street: string; houseNumber: string;
  fullAddress: string; description: string; areaSqm: number; rooms: number | null; yearBuilt: number | null;
  marketingType: string; usageType: string; priceCents: number | null; priceVisibility: string;
  geography: PropertyGeography; energy: PropertyEnergyCertificate; updatedAt: string;
  media: { id: string; assetId: string; fileName: string; title: string; format: string; kind: "image" | "floorplan"; sizeBytes: number; updatedAt: string }[];
};
export type PropertyPortalPreview = { source: PropertyPortalSource; profile: PropertyPortalProfile; revision: number; action: "CHANGE" | "DELETE"; sourceFingerprint: string; checks: CountryPublicationCheck[]; xml: string; transport: "not_connected" };
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;
export function parsePropertyPortalProfile(value: unknown): PropertyPortalProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PORTAL_PROFILE");
  const p = value as Record<string, unknown>;
  const keys = ["portalName", "providerName", "providerId", "agencyId", "externalObjectId", "contactName", "contactEmail", "propertyType", "includeAddress", "includeMedia"];
  if (Object.keys(p).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(p, key)) ||
      ["portalName", "providerName", "contactName"].some((key) => typeof p[key] !== "string" || !p[key].trim() || p[key].length > 200 || /[\u0000-\u001f<>]/.test(p[key])) ||
      ["providerId", "agencyId", "externalObjectId"].some((key) => typeof p[key] !== "string" || !idPattern.test(p[key])) ||
      typeof p.contactEmail !== "string" || p.contactEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(p.contactEmail) ||
      !(portalPropertyTypes as readonly unknown[]).includes(p.propertyType) || typeof p.includeAddress !== "boolean" || typeof p.includeMedia !== "boolean") throw new Error("INVALID_PORTAL_PROFILE");
  return { portalName: String(p.portalName).trim(), providerName: String(p.providerName).trim(), providerId: String(p.providerId), agencyId: String(p.agencyId), externalObjectId: String(p.externalObjectId), contactName: String(p.contactName).trim(), contactEmail: String(p.contactEmail).trim(), propertyType: p.propertyType as PortalPropertyType, includeAddress: p.includeAddress, includeMedia: p.includeMedia };
}
function xml(value: string | number) { return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
const tag = (name: string, value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "" : `<${name}>${xml(value)}</${name}>`;
const types = { apartment: "wohnung", house: "haus", land: "grundstueck", office: "buero_praxen", investment: "zinshaus_renditeobjekt", other: "sonstige" } as const;
const isoCountries = { AT: "AUT", DE: "DEU", ES: "ESP", IE: "IRL" } as const;
function energyXml(source: PropertyPortalSource) {
  const e = source.energy;
  const kind = e.certificateType === "demand" ? "BEDARF" : e.certificateType === "consumption" ? "VERBRAUCH" : null;
  const details = [e.schemeVersion ? `Schema: ${e.schemeVersion}` : "", e.certificateNumber ? `Certificate: ${e.certificateNumber}` : "", e.registration ? `Registration: ${e.registration}` : ""].filter(Boolean).join("; ");
  return `<energiepass>${tag("epart", kind)}${tag("gueltig_bis", e.validUntil)}${tag("energieverbrauchkennwert", e.finalEnergyConsumptionKwhM2)}${tag("endenergiebedarf", e.finalEnergyDemandKwhM2)}${tag("primaerenergietraeger", e.energySource)}${tag("stromwert", e.electricityEnergyKwhM2)}${tag("waermewert", e.heatingEnergyKwhM2)}${tag("wertklasse", e.energyClass)}${tag("ausstelldatum", e.issuedAt)}${tag("gebaeudeart", source.usageType === "residential" ? "wohn" : source.usageType === "commercial" ? "nichtwohn" : null)}${tag("epasstext", details)}${tag("hwbwert", e.heatingDemandKwhM2)}${tag("fgeewert", e.overallEfficiencyFactor)}${source.geography.countryCode === "AT" ? tag("fgeeklasse", e.energyClass) : ""}</energiepass>`;
}
/** Explicit offline incremental package. No full sync can accidentally remove unrelated listings. */
export function buildPropertyPortalXml(source: PropertyPortalSource, profile: PropertyPortalProfile, action: "CHANGE" | "DELETE", createdAt: string): string {
  const remove = action === "DELETE";
  const purchase = source.marketingType !== "rent";
  const rental = source.marketingType === "rent" || source.marketingType === "sale_or_rent";
  const geo = remove ? "<plz/>" : `${source.postalCode ? tag("plz", source.postalCode) : ""}${tag("ort", source.city) || (source.postalCode ? "" : "<plz/>")}${profile.includeAddress ? tag("strasse", source.street) + tag("hausnummer", source.houseNumber) : ""}${tag("bundesland", source.geography.region)}<land iso_land="${isoCountries[source.geography.countryCode]}"/>`;
  let prices = "";
  if (!remove) {
    if (source.priceVisibility === "publish_price" && source.priceCents !== null) prices += tag(rental && !purchase ? "warmmiete" : "kaufpreis", (source.priceCents / 100).toFixed(2));
    else if (source.priceVisibility === "price_on_request") prices += purchase ? '<kaufpreis auf_anfrage="true">0</kaufpreis>' : tag("freitext_preis", "Preis auf Anfrage");
    // No valuation, costs, yield or derived prices are included when price is hidden.
    prices = `<preise>${prices}<waehrung iso_waehrung="EUR"/></preise>`;
  }
  let description = source.description;
  if (!profile.includeAddress && source.fullAddress.length > 3) description = description.split(source.fullAddress).join("[Adresse ausgeblendet]");
  const attachments = !remove && profile.includeMedia && source.media.length ? `<anhaenge>${source.media.map((m) => `<anhang location="EXTERN" gruppe="${m.kind === "floorplan" ? "GRUNDRISS" : "BILD"}">${tag("anhangtitel", m.title)}${tag("format", m.format)}<daten>${tag("pfad", m.fileName)}</daten></anhang>`).join("")}</anhaenge>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<openimmo><uebertragung art="OFFLINE" umfang="TEIL" modus="${action}" version="1.2.7" sendersoftware="Novalure CRM" senderversion="1" timestamp="${xml(createdAt)}"/><anbieter>${tag("anbieternr", profile.providerId)}${tag("firma", profile.providerName)}${tag("openimmo_anid", profile.agencyId)}<immobilie><objektkategorie><nutzungsart WOHNEN="${source.usageType === "residential"}" GEWERBE="${source.usageType === "commercial"}" ANLAGE="${source.usageType === "investment"}"/><vermarktungsart KAUF="${purchase}" MIETE_PACHT="${rental}"/><objektart><${types[profile.propertyType]}/></objektart></objektkategorie><geo>${geo}</geo><kontaktperson>${tag("email_zentrale", profile.contactEmail)}${tag("name", profile.contactName)}</kontaktperson>${prices}${!remove ? `<flaechen>${tag(profile.propertyType === "land" ? "grundstuecksflaeche" : source.usageType === "residential" ? "wohnflaeche" : "nutzflaeche", source.areaSqm)}${tag("anzahl_zimmer", source.rooms)}</flaechen><zustand_angaben>${tag("baujahr", source.yearBuilt)}${energyXml(source)}</zustand_angaben><freitexte>${tag("objekttitel", source.title)}${tag("objektbeschreibung", description)}</freitexte>${attachments}<verwaltung_objekt>${tag("objektadresse_freigeben", profile.includeAddress ? "true" : "false")}</verwaltung_objekt>` : ""}<verwaltung_techn>${tag("objektnr_extern", profile.externalObjectId)}<aktion aktionart="${action}"/>${tag("openimmo_obid", source.propertyId)}${tag("stand_vom", createdAt.slice(0, 10))}${tag("sprache", source.geography.contentLanguage)}</verwaltung_techn></immobilie></anbieter></openimmo>`;
}
