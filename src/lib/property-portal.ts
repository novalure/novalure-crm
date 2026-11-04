import type { CountryPublicationCheck, PropertyEnergyCertificate, PropertyGeography } from "./property-country";
import { formatApprovedPropertyCosts, publicPropertyCostKeys, type PublicPropertyDetailGroup, type PublicPropertyPortalDetails } from "./property-expose-details";

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
  details?: PublicPropertyPortalDetails;
  detailGroups?: PublicPropertyDetailGroup[];
  costs?: Record<string, unknown>[];
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
  const language = source.geography.contentLanguage;
  const costs = source.priceVisibility === "publish_price" ? (source.costs ?? []).filter(cost => cost.exposeVisible !== false && publicPropertyCostKeys.includes(String(cost.costKey))) : [];
  const costSum = (key: string, period: "monthlyGrossCents" | "oneTimeGrossCents") => {
    const amounts = costs.filter(cost => cost.costKey === key).map(cost => Number(cost[period])).filter(value => Number.isSafeInteger(value) && value > 0);
    const total = amounts.reduce((sum, value) => sum + value, 0);
    return amounts.length && Number.isSafeInteger(total) ? (total / 100).toFixed(2) : null;
  };
  if (!remove) {
    if (source.priceVisibility === "publish_price" && source.priceCents !== null) prices += tag(rental && !purchase ? "warmmiete" : "kaufpreis", (source.priceCents / 100).toFixed(2));
    else if (source.priceVisibility === "price_on_request" && purchase) prices += '<kaufpreis auf_anfrage="true">0</kaufpreis>';
    const requested = source.priceVisibility === "price_on_request" && !purchase ? (language === "de" ? "Preis auf Anfrage" : language === "es" ? "Precio a consultar" : "Price on request") : "";
    // Only explicitly public cost rows enter native gross-cost fields or the public price text.
    const costText = formatApprovedPropertyCosts(costs, language, source.geography.displayLocale).map(cost => `${cost.label}: ${cost.value}`).join("; ");
    prices = `<preise>${prices}${tag("nebenkosten", costSum("operating_costs", "monthlyGrossCents"))}${tag("heizkosten", costSum("heating_costs", "monthlyGrossCents"))}${tag("provisionbrutto", costSum(purchase ? "broker_commission_purchase" : "broker_commission_rent", "oneTimeGrossCents"))}<waehrung iso_waehrung="EUR"/>${tag("freitext_preis", costText || requested)}${tag("kaution", costSum("deposit", "oneTimeGrossCents"))}</preise>`;
  }
  let description = source.description;
  if (!profile.includeAddress && source.fullAddress.length > 3) description = description.split(source.fullAddress).join("[Adresse ausgeblendet]");
  const details = source.details;
  const hasPrimaryAreas = details && [details.livingAreaSqm, details.usableAreaSqm, details.totalAreaSqm, details.plotAreaSqm].some(value => typeof value === "number");
  const fallbackArea = (kind: "living" | "usable" | "plot") => !hasPrimaryAreas && source.areaSqm > 0 && (kind === "plot" ? profile.propertyType === "land" : profile.propertyType !== "land" && (kind === "living" ? source.usageType === "residential" : source.usageType !== "residential")) ? source.areaSqm : null;
  const extra = (key: string, value: string | number | null | undefined) => value === null || value === undefined ? "" : `<user_defined_simplefield feldname="${key}">${xml(value)}</user_defined_simplefield>`;
  const areas = `<flaechen>${tag("wohnflaeche", details?.livingAreaSqm ?? fallbackArea("living"))}${tag("nutzflaeche", details?.usableAreaSqm ?? fallbackArea("usable"))}${tag("gesamtflaeche", details?.totalAreaSqm)}${tag("lagerflaeche", details?.storageAreaSqm)}${tag("freiflaeche", details?.freeAreaSqm)}${tag("bueroflaeche", details?.officeAreaSqm)}${tag("grundstuecksflaeche", details?.plotAreaSqm ?? fallbackArea("plot"))}${tag("anzahl_zimmer", source.rooms)}${tag("anzahl_schlafzimmer", details?.bedrooms)}${tag("anzahl_badezimmer", details?.bathrooms)}${tag("anzahl_sep_wc", details?.separateWcs)}${tag("anzahl_balkone", details?.balconies)}${tag("anzahl_terrassen", details?.terraces)}${tag("anzahl_logia", details?.loggias)}${tag("gartenflaeche", details?.gardenAreaSqm)}${tag("kellerflaeche", details?.cellarAreaSqm)}${extra("balcony_area_sqm", details?.balconyAreaSqm)}${extra("terrace_area_sqm", details?.terraceAreaSqm)}${extra("loggia_area_sqm", details?.loggiaAreaSqm)}${extra("roof_terrace_area_sqm", details?.roofTerraceAreaSqm)}</flaechen>`;
  const boolTag = (name: string, value: boolean | null | undefined) => value === null || value === undefined ? "" : tag(name, value ? "true" : "false");
  const carrier: Record<string, string> = { gas: "GAS", oil: "OEL", electric: "ELEKTRO", biomass: "BIOENERGIE", solar: "SOLAR", district: "FERN" };
  const parking = details ? [["GARAGE", details.garageCount], ["TIEFGARAGE", details.undergroundParkingCount], ["CARPORT", details.carportCount], ["FREIPLATZ", details.outdoorParkingCount]].flatMap(([key, value]) => typeof value === "number" ? [`${key}="${value > 0}"`] : []).join(" ") : "";
  const equipment = details ? `<ausstattung>${boolTag("wg_geeignet", details.sharedFlat)}${details.heatingSystem === "district" ? '<heizungsart FERN="true"/>' : ""}${details.heatingSystem && Object.hasOwn(carrier, details.heatingSystem) ? `<befeuerung ${carrier[details.heatingSystem]}="true"/>` : ""}${typeof details.elevator === "boolean" ? `<fahrstuhl PERSONEN="${details.elevator}"/>` : ""}${parking ? `<stellplatzart ${parking}/>` : ""}${boolTag("barrierefrei", details.accessible)}${boolTag("sauna", details.sauna)}${boolTag("wasch_trockenraum", details.laundryRoom)}${boolTag("wintergarten", details.winterGarden)}${boolTag("rampe", details.ramp)}${extra("heating_installation_year", details.heatingYear)}${extra("heating_system", details.heatingSystem)}${extra("garage_count", details.garageCount)}${extra("underground_parking_count", details.undergroundParkingCount)}${extra("carport_count", details.carportCount)}${extra("outdoor_parking_count", details.outdoorParkingCount)}</ausstattung>` : "";
  let equipmentText = (source.detailGroups ?? []).map(group => `${group.heading}: ${group.facts.map(fact => `${fact.label}: ${fact.value}`).join("; ")}`).join("\n");
  if (!profile.includeAddress && source.fullAddress.length > 3) equipmentText = equipmentText.split(source.fullAddress).join("[Adresse ausgeblendet]");
  const attachments = !remove && profile.includeMedia && source.media.length ? `<anhaenge>${source.media.map((m) => `<anhang location="EXTERN" gruppe="${m.kind === "floorplan" ? "GRUNDRISS" : "BILD"}">${tag("anhangtitel", m.title)}${tag("format", m.format)}<daten>${tag("pfad", m.fileName)}</daten></anhang>`).join("")}</anhaenge>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<openimmo><uebertragung art="OFFLINE" umfang="TEIL" modus="${action}" version="1.2.7" sendersoftware="Novalure CRM" senderversion="1" timestamp="${xml(createdAt)}"/><anbieter>${tag("anbieternr", profile.providerId)}${tag("firma", profile.providerName)}${tag("openimmo_anid", profile.agencyId)}<immobilie><objektkategorie><nutzungsart WOHNEN="${source.usageType === "residential"}" GEWERBE="${source.usageType === "commercial"}" ANLAGE="${source.usageType === "investment"}"/><vermarktungsart KAUF="${purchase}" MIETE_PACHT="${rental}"/><objektart><${types[profile.propertyType]}/></objektart></objektkategorie><geo>${geo}</geo><kontaktperson>${tag("email_zentrale", profile.contactEmail)}${tag("name", profile.contactName)}</kontaktperson>${prices}${!remove ? `${areas}${equipment}<zustand_angaben>${tag("baujahr", source.yearBuilt)}${energyXml(source)}</zustand_angaben><freitexte>${tag("objekttitel", source.title)}${tag("ausstatt_beschr", equipmentText)}${tag("objektbeschreibung", description)}</freitexte>${attachments}<verwaltung_objekt>${tag("objektadresse_freigeben", profile.includeAddress ? "true" : "false")}</verwaltung_objekt>` : ""}<verwaltung_techn>${tag("objektnr_extern", profile.externalObjectId)}<aktion aktionart="${action}"/>${tag("openimmo_obid", source.propertyId)}${tag("stand_vom", createdAt.slice(0, 10))}${tag("sprache", source.geography.contentLanguage)}</verwaltung_techn></immobilie></anbieter></openimmo>`;
}
