import {
  propertyDetailDefinitions, propertyDetailId, propertyDetailLegacyColumns, readPropertyDetails,
  type PropertyDetailDefinition,
} from "@/lib/property-details";

export type PublicPropertyLanguage = "de" | "en" | "es";
export type PublicPropertyFact = { label: string; value: string };
export type PublicPropertyDetailGroup = { id: string; heading: string; facts: PublicPropertyFact[] };
export type PublicPropertyUnitDetails = {
  balconyAreaSqm?: number | null; terraceAreaSqm?: number | null; gardenAreaSqm?: number | null;
  loggiaAreaSqm?: number | null; roofTerraceAreaSqm?: number | null; bedrooms?: number | null;
  heatingYear?: number | null; undergroundParkingCount?: number | null;
  carportCount?: number | null; outdoorParkingCount?: number | null;
};
export type PublicPropertyPortalDetails = {
  livingAreaSqm: number | null; usableAreaSqm: number | null; totalAreaSqm: number | null; plotAreaSqm: number | null;
  officeAreaSqm: number | null; storageAreaSqm: number | null; freeAreaSqm: number | null;
  balconyAreaSqm: number | null; terraceAreaSqm: number | null; gardenAreaSqm: number | null; loggiaAreaSqm: number | null; cellarAreaSqm: number | null; roofTerraceAreaSqm: number | null;
  bedrooms: number | null; bathrooms: number | null; separateWcs: number | null; balconies: number | null; terraces: number | null; loggias: number | null;
  garageCount: number | null; undergroundParkingCount: number | null; carportCount: number | null; outdoorParkingCount: number | null;
  heatingYear: number | null; heatingSystem: string | null; elevator: boolean | null; accessible: boolean | null;
  sharedFlat: boolean | null; sauna: boolean | null; laundryRoom: boolean | null; winterGarden: boolean | null; ramp: boolean | null;
};
const ids = (group: string, labels: string[]) => labels.map(label => propertyDetailId(group, label));
/** Deliberate public fact allowlist. Never publish a generic legacy/notes/financial object. */
export const publicPropertyDetailIds = new Set([
  ...ids("areas", ["Grundfläche", "Wohnfläche", "Nutzfläche", "Verbaute Fläche", "Bürofläche", "Lagerfläche", "Freie Fläche", "Befristete Fläche", "Rohdachbodenfläche", "Gesamtfläche", "Balkonfläche", "Terrassenfläche", "Gartenfläche", "Loggiafläche", "Kellerfläche"]),
  ...ids("rooms", ["Zimmer", "Halbe Zimmer", "Gärten", "Keller", "Balkone", "Terrassen", "Loggien", "WCs", "Bäder", "Garagen", "Abstellräume", "Raumhöhe", "Schlafzimmer"]),
  ...ids("classification", ["Objektart", "Unterobjektart", "Wohnen", "Gewerbe", "Anlage", "Barrierefrei", "Zentral begehbar", "Baugrund", "Ferienimmobilie"]),
  ...ids("construction", ["Bauart", "Beziehbar ab", "Baujahr", "Etagen", "Dachgeschosse", "Mezzanin", "Etage", "Moeblierung", "Zustand", "Erschliessung", "Hauszustand", "Schluesselfertig", "Belagsfertig", "Letzte Sanierung"]),
  ...ids("equipment", ["Boden", "Küche", "Stellplatzart", "Befeuerung", "Heizungsart", "Bad", "Balkon-/Terrassenausrichtung", "Fahrstuhl", "TV/EDV", "Gastronomie", "Rampe", "Sauna", "Sport", "Wasch-/Trockenraum", "Alarmanlage", "Bus/Bahn-Naehe", "WG-geeignet", "Wintergarten", "Fahrradraum", "Abstellraum", "Seniorengerecht"]),
  "construction.heizungsjahr", "construction.heizung", "classification.location_type",
  "classification.location_lake", "classification.location_mountains", "classification.location_city", "classification.location_rural",
]);
const definitions = propertyDetailDefinitions.filter(def => def.public && publicPropertyDetailIds.has(def.id));
const primaryAreaIds = new Set(ids("areas", ["Grundfläche", "Wohnfläche", "Nutzfläche", "Verbaute Fläche", "Bürofläche", "Lagerfläche", "Freie Fläche", "Befristete Fläche", "Rohdachbodenfläche", "Gesamtfläche"]));
const groupLabels: Record<string, [string, string, string]> = {
  areas: ["Flächen", "Areas", "Superficies"], rooms: ["Räume und Außenbereiche", "Rooms and outdoor spaces", "Habitaciones y espacios exteriores"],
  classification: ["Eigenschaften und Lage", "Features and setting", "Características y entorno"],
  construction: ["Gebäude und Heizung", "Building and heating", "Edificio y calefacción"],
  equipment: ["Ausstattung", "Amenities", "Equipamiento"],
};
const index = (language: PublicPropertyLanguage) => language === "de" ? 0 : language === "en" ? 1 : 2;
const enumLabels: Record<string, [string, string, string]> = {
  heat_pump: ["Wärmepumpe", "Heat pump", "Bomba de calor"], district: ["Fernwärme", "District heating", "Calefacción urbana"],
  gas: ["Gas", "Gas", "Gas"], oil: ["Öl", "Oil", "Gasóleo"], electric: ["Elektrisch", "Electric", "Eléctrica"],
  biomass: ["Biomasse", "Biomass", "Biomasa"], solar: ["Solar", "Solar", "Solar"], other: ["Sonstige", "Other", "Otro"],
  city: ["Stadt", "City", "Urbana"], rural: ["Ländlich", "Rural", "Rural"], lake: ["See", "Lake", "Lago"],
  mountains: ["Berge", "Mountains", "Montaña"], coastal: ["Küste", "Coastal", "Costa"],
};
export function publicPropertyLocale(language: PublicPropertyLanguage, country?: string | null) {
  return language === "es" ? "es-ES" : language === "en" ? country === "IE" ? "en-IE" : "en-GB" : country === "AT" ? "de-AT" : "de-DE";
}
const label = (definition: PropertyDetailDefinition, language: PublicPropertyLanguage) => language === "de" ? definition.labelDE : language === "es" ? definition.labelES : definition.labelEN;
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
function valueText(definition: PropertyDetailDefinition, value: unknown, language: PublicPropertyLanguage, locale: string) {
  if (typeof value === "boolean") return value ? ["Ja", "Yes", "Sí"][index(language)] : ["Nein", "No", "No"][index(language)];
  if (typeof value === "number" && Number.isFinite(value)) return /(?:baujahr|heizungsjahr|letzte_sanierung)$/.test(definition.id) ? String(value) : new Intl.NumberFormat(locale).format(value) + (definition.unit ? ` ${definition.unit}` : "");
  if (typeof value !== "string" || !clean(value)) return null;
  if (definition.kind === "enum") return enumLabels[value]?.[index(language)] ?? null;
  if (definition.kind === "date") return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value + "T00:00:00Z"));
  return clean(value);
}
export function publicPropertyDetailGroups(source: { canonicalPayload?: unknown } | Record<string, unknown>, language: PublicPropertyLanguage,
  locale = publicPropertyLocale(language), exclude: readonly string[] = []): PublicPropertyDetailGroup[] {
  const details = readPublicPropertyDetails(source), groups = new Map<string, PublicPropertyDetailGroup>();
  for (const definition of definitions) {
    if (definition.id === "classification.objektart" || exclude.includes(definition.id)) continue;
    if (primaryAreaIds.has(definition.id) && details.values[definition.id] === 0) continue;
    const value = valueText(definition, details.values[definition.id], language, locale);
    if (value === null) continue;
    let group = groups.get(definition.group);
    if (!group) { group = { id: definition.group, heading: groupLabels[definition.group][index(language)], facts: [] }; groups.set(definition.group, group); }
    group.facts.push({ label: label(definition, language), value });
  }
  return [...groups.values()];
}

/** Use only the caller's exactly linked unit. No object/project values are accepted here. */
export function publicPropertyUnitFacts(unit: PublicPropertyUnitDetails, language: PublicPropertyLanguage, locale = publicPropertyLocale(language)): PublicPropertyFact[] {
  const fields: [keyof PublicPropertyUnitDetails, [string, string, string], string][] = [
    ["balconyAreaSqm", ["Balkonfläche", "Balcony area", "Superficie del balcón"], " m²"],
    ["terraceAreaSqm", ["Terrassenfläche", "Terrace area", "Superficie de terraza"], " m²"],
    ["gardenAreaSqm", ["Gartenfläche", "Garden area", "Superficie de jardín"], " m²"],
    ["loggiaAreaSqm", ["Loggiafläche", "Loggia area", "Superficie de galería"], " m²"],
    ["roofTerraceAreaSqm", ["Dachterrassenfläche", "Roof terrace area", "Superficie de azotea"], " m²"],
    ["bedrooms", ["Schlafzimmer", "Bedrooms", "Dormitorios"], ""],
    ["heatingYear", ["Baujahr der Heizung", "Heating installation year", "Año de la calefacción"], ""],
    ["undergroundParkingCount", ["Tiefgaragenplätze", "Underground parking spaces", "Plazas de garaje subterráneo"], ""],
    ["carportCount", ["Carportplätze", "Carport spaces", "Plazas de aparcamiento cubierto"], ""],
    ["outdoorParkingCount", ["Außenstellplätze", "Outdoor parking spaces", "Plazas de aparcamiento exterior"], ""],
  ];
  return fields.flatMap(([key, labels, suffix]) => {
    const value = unit[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [{ label: labels[index(language)], value: key === "heatingYear" ? String(value) : new Intl.NumberFormat(locale).format(value) + suffix }] : [];
  });
}

export function publicPropertyPortalDetails(source: { canonicalPayload?: unknown } | Record<string, unknown>, unit?: PublicPropertyUnitDetails | null): PublicPropertyPortalDetails {
  const details = readPublicPropertyDetails(source);
  const number = (id: string) => publicPropertyDetailIds.has(id) && typeof details.values[id] === "number" && (!primaryAreaIds.has(id) || Number(details.values[id]) > 0) ? details.values[id] as number : null;
  const bool = (id: string) => publicPropertyDetailIds.has(id) && typeof details.values[id] === "boolean" ? details.values[id] as boolean : null;
  const unitNumber = (key: keyof PublicPropertyUnitDetails, fallback: number | null = null) => {
    const value = unit?.[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    livingAreaSqm: number("areas.wohnfl_che"), usableAreaSqm: number("areas.nutzfl_che"), totalAreaSqm: number("areas.gesamtfl_che"), plotAreaSqm: number("areas.grundfl_che"),
    officeAreaSqm: number("areas.b_rofl_che"), storageAreaSqm: number("areas.lagerfl_che"), freeAreaSqm: number("areas.freie_fl_che"),
    balconyAreaSqm: unitNumber("balconyAreaSqm", number("areas.balkonfl_che")), terraceAreaSqm: unitNumber("terraceAreaSqm", number("areas.terrassenfl_che")), gardenAreaSqm: unitNumber("gardenAreaSqm", number("areas.gartenfl_che")), loggiaAreaSqm: unitNumber("loggiaAreaSqm", number("areas.loggiafl_che")), cellarAreaSqm: number("areas.kellerfl_che"), roofTerraceAreaSqm: unitNumber("roofTerraceAreaSqm"),
    bedrooms: unitNumber("bedrooms", number("rooms.schlafzimmer")), bathrooms: number("rooms.b_der"), separateWcs: number("rooms.wcs"), balconies: number("rooms.balkone"), terraces: number("rooms.terrassen"), loggias: number("rooms.loggien"),
    garageCount: number("rooms.garagen"), undergroundParkingCount: unitNumber("undergroundParkingCount"), carportCount: unitNumber("carportCount"), outdoorParkingCount: unitNumber("outdoorParkingCount"),
    heatingYear: unitNumber("heatingYear", number("construction.heizungsjahr")), heatingSystem: typeof details.values["construction.heizung"] === "string" ? details.values["construction.heizung"] : null,
    elevator: bool("equipment.fahrstuhl"), accessible: bool("classification.barrierefrei"), sharedFlat: bool("equipment.wg_geeignet"), sauna: bool("equipment.sauna"), laundryRoom: bool("equipment.wasch_trockenraum"), winterGarden: bool("equipment.wintergarten"), ramp: bool("equipment.rampe"),
  };
}

export function readPublicPropertyDetails(source: { canonicalPayload?: unknown } | Record<string, unknown>) {
  const root = source as Record<string, unknown>;
  const legacy = root.legacyRow && typeof root.legacyRow === "object" && !Array.isArray(root.legacyRow) ? root.legacyRow as Record<string, unknown> : {};
  return readPropertyDetails(source, legacy);
}

/** SQL returns public keys only, including compatible legacy values; private JSON never enters the snapshot. */
export function publicPropertyDetailPayloadSql(alias: string) {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid SQL alias");
  const keys = definitions.flatMap(def => [def.id, def.id.replace(/fl_che/g, "flaeche")]).map(id => `'${id.replace(/'/g, "''")}'`).join(",");
  const selected = (path: string) => `coalesce((select jsonb_object_agg(detail.key,detail.value) from jsonb_each(case when jsonb_typeof(${alias}.canonical_payload${path})='object' then ${alias}.canonical_payload${path} else '{}'::jsonb end) detail where detail.key in (${keys})), '{}'::jsonb)`;
  const columns = [...new Set(definitions.map(def => propertyDetailLegacyColumns[def.id]).filter(Boolean))];
  const equipmentKeys = definitions.filter(def => def.group === "equipment").map(def => `'${def.id.slice(10)}'`).join(",");
  const legacy = `jsonb_build_object(${columns.map(column => `'${column}',to_jsonb(${alias})->'${column}'`).join(",")},'equipment',coalesce((select jsonb_object_agg(item.key,item.value) from jsonb_each(case when jsonb_typeof(to_jsonb(${alias})->'equipment')='object' then to_jsonb(${alias})->'equipment' else '{}'::jsonb end) item where item.key in (${equipmentKeys})),'{}'::jsonb))`;
  return `jsonb_build_object('canonicalPayload',jsonb_build_object('propertyDetails',jsonb_build_object('version',1,'values',${selected("->'propertyDetails'->'values'")}), 'fieldValues',${selected("->'fieldValues'")}), 'legacyRow',${legacy})`;
}

export const publicUnitDetailsSql = (alias: string) => {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid SQL alias");
  return `jsonb_build_object(${Object.entries({ balconyAreaSqm: "balcony_area_sqm", terraceAreaSqm: "terrace_area_sqm", gardenAreaSqm: "garden_area_sqm", loggiaAreaSqm: "loggia_area_sqm", roofTerraceAreaSqm: "roof_terrace_area_sqm", bedrooms: "bedrooms", heatingYear: "heating_year", undergroundParkingCount: "underground_parking_count", carportCount: "carport_count", outdoorParkingCount: "outdoor_parking_count" }).map(([key, column]) => `'${key}',to_jsonb(${alias})->'${column}'`).join(",")})`;
};

const costLabels: Record<string, [string, string, string]> = {
  operating_costs: ["Betriebskosten", "Operating costs", "Gastos de comunidad"], heating_costs: ["Heizkosten", "Heating costs", "Gastos de calefacción"],
  repair_reserve: ["Rücklage", "Reserve fund", "Fondo de reserva"], other_monthly: ["Sonstige monatliche Kosten", "Other monthly costs", "Otros gastos mensuales"],
  transfer_tax: ["Grunderwerbsteuer", "Property transfer tax", "Impuesto de transmisión"], land_register_fee: ["Grundbucheintragung", "Land registration", "Inscripción registral"],
  contract_setup: ["Vertragserrichtung", "Contract preparation", "Formalización del contrato"], broker_commission_purchase: ["Provision Kauf", "Buyer brokerage fee", "Honorarios de compra"],
  deposit: ["Kaution", "Deposit", "Fianza"], stamp_duty: ["Vergebührung", "Stamp duty", "Tasas"], broker_commission_rent: ["Provision Miete", "Tenant brokerage fee", "Honorarios de alquiler"],
};
export const publicPropertyCostKeys = Object.keys(costLabels);
/** Input must already be selected by expose_visible and exact property/unit scope. */
export function formatApprovedPropertyCosts(rows: Record<string, unknown>[], language: PublicPropertyLanguage, locale = publicPropertyLocale(language)): PublicPropertyFact[] {
  const money = (value: unknown) => {
    const cents = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(cents) && cents > 0 ? new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(cents / 100) : null;
  };
  return rows.flatMap(row => {
    if (row.exposeVisible === false) return [];
    const key = typeof row.costKey === "string" ? row.costKey : Object.keys(costLabels).find(key => costLabels[key][0] === row.label);
    if (!key || !costLabels[key]) return [];
    const monthly = money(row.monthlyGrossCents), once = money(row.oneTimeGrossCents), title = costLabels[key][index(language)];
    return [...(monthly ? [{ label: `${title} (${["monatlich", "monthly", "mensual"][index(language)]})`, value: monthly }] : []),
      ...(once ? [{ label: `${title} (${["einmalig", "one-time", "único"][index(language)]})`, value: once }] : [])];
  });
}
