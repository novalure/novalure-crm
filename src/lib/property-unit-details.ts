import type { PropertyUnit, PropertyUnitDetails } from "@/lib/crm-types";
import { parsePropertyAreaSqm } from "@/lib/property-area-input";

export const UNIT_DETAIL_FIELDS = [
  { key: "balconyAreaSqm", column: "balcony_area_sqm", kind: "area", de: "Balkon (m²)", en: "Balcony (m²)" },
  { key: "terraceAreaSqm", column: "terrace_area_sqm", kind: "area", de: "Terrasse (m²)", en: "Terrace (m²)" },
  { key: "gardenAreaSqm", column: "garden_area_sqm", kind: "area", de: "Garten (m²)", en: "Garden (m²)" },
  { key: "loggiaAreaSqm", column: "loggia_area_sqm", kind: "area", de: "Loggia (m²)", en: "Loggia (m²)" },
  { key: "roofTerraceAreaSqm", column: "roof_terrace_area_sqm", kind: "area", de: "Dachterrasse (m²)", en: "Roof terrace (m²)" },
  { key: "undergroundParkingCount", column: "underground_parking_count", kind: "count", de: "Tiefgaragenplätze", en: "Underground parking spaces" },
  { key: "carportCount", column: "carport_count", kind: "count", de: "Carportplätze", en: "Carport spaces" },
  { key: "outdoorParkingCount", column: "outdoor_parking_count", kind: "count", de: "Außenstellplätze", en: "Outdoor parking spaces" },
  { key: "bedrooms", column: "bedrooms", kind: "count", de: "Schlafzimmer", en: "Bedrooms" },
  { key: "heatingYear", column: "heating_year", kind: "year", de: "Baujahr der Heizung", en: "Heating installation year" },
] as const;
export type UnitDetailKey = typeof UNIT_DETAIL_FIELDS[number]["key"];
export type UnitDetailsDraft = Record<UnitDetailKey, string>;
export type UnitDetailsPatch = Partial<Pick<PropertyUnitDetails, UnitDetailKey>>;

/** Preserve every cent even near the safe integer limit; do not format via float EUR. */
export function unitPriceInput(cents: number | null | undefined, options: { allowNegative?: boolean } = {}): string {
  if(cents == null) return "";
  if(!Number.isSafeInteger(cents) || cents < 0 && !options.allowNegative) throw new Error("Invalid unit price cents");
  const value=BigInt(Math.abs(cents));
  return `${cents < 0 ? "-" : ""}${value/BigInt(100)}.${String(value%BigInt(100)).padStart(2,"0")}`;
}

export function unitDetailErrorMessage(error: unknown, language: string, fallback: string): string {
  const message=error instanceof Error ? error.message : fallback;
  const field=UNIT_DETAIL_FIELDS.find(({key})=>message === `Invalid unit detail: ${key}`);
  if(!field) return message;
  const label=language === "de" ? field.de : field.en;
  return language === "de" ? `Bitte „${label}“ prüfen: ${field.kind === "area" ? "eine nicht negative Fläche mit höchstens zwei Nachkommastellen" : field.kind === "year" ? "ein ganzes Jahr zwischen 1800 und 2200" : "eine nicht negative ganze Anzahl"}.`
    : `Check “${label}”: ${field.kind === "area" ? "a nonnegative area with at most two decimal places" : field.kind === "year" ? "a whole year between 1800 and 2200" : "a nonnegative whole count"}.`;
}

export function unitDetailsDraft(unit?: Partial<PropertyUnit>): UnitDetailsDraft {
  return Object.fromEntries(UNIT_DETAIL_FIELDS.map(({ key }) => [key, unit?.[key] == null ? "" : String(unit[key])])) as UnitDetailsDraft;
}

/** Missing keys preserve stored data; explicit null/blank clears a known value. */
export function parseUnitDetailsPatch(input: Record<string, unknown>): UnitDetailsPatch {
  const values: UnitDetailsPatch = {};
  for (const { key, kind } of UNIT_DETAIL_FIELDS) {
    if (input[key] === undefined) continue;
    const raw = input[key];
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) { values[key] = null; continue; }
    const value = kind === "area" ? parsePropertyAreaSqm(raw)
      : typeof raw === "number" || typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : null;
    if (value === null || !Number.isFinite(value) || value < (kind === "year" ? 1800 : 0)
      || kind !== "area" && (!Number.isInteger(value) || value > (kind === "year" ? 2200 : key === "bedrooms" ? 100 : 10000))) {
      throw new Error(`Invalid unit detail: ${key}`);
    }
    values[key] = value;
  }
  return values;
}

export function mapUnitDetails(row: Record<string, unknown>): PropertyUnitDetails {
  const result = Object.fromEntries(UNIT_DETAIL_FIELDS.map(({ key }) => [key, row[key] == null ? null : Number(row[key])])) as PropertyUnitDetails;
  result.investorPriceCents = row.investorPriceCents == null ? null : Number(row.investorPriceCents);
  return result;
}

/** Trusted identifiers only; shared by all private loaders. */
export const UNIT_DETAIL_SELECT = [...UNIT_DETAIL_FIELDS.map(({ key, column }) => `pu.${column} as "${key}"`), 'pu.investor_price_cents as "investorPriceCents"'].join(",\n      ");
