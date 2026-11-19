/** Property location and presentation are independent of the viewer's language. */
export const propertyCountries = ["AT", "DE", "ES", "IE"] as const;
export type PropertyCountryCode = (typeof propertyCountries)[number];
export type PropertyContentLanguage = "de" | "en" | "es";
export type PropertyDisplayLocale = "de-AT" | "de-DE" | "es-ES" | "en-IE" | "de" | "en" | "es";
export type PropertyGeography = {
  version: 1;
  countryCode: PropertyCountryCode;
  region: string;
  displayLocale: PropertyDisplayLocale;
  contentLanguage: PropertyContentLanguage;
  currency: "EUR";
  bookingTimezone: string;
  source: "explicit" | "legacy_at_region";
};

export const propertyCountryDefaults = {
  AT: { name: "Österreich", displayLocale: "de-AT", contentLanguage: "de", bookingTimezone: "Europe/Vienna", regionLabel: "Bundesland" },
  DE: { name: "Deutschland", displayLocale: "de-DE", contentLanguage: "de", bookingTimezone: "Europe/Berlin", regionLabel: "Bundesland" },
  ES: { name: "España", displayLocale: "es-ES", contentLanguage: "es", bookingTimezone: "Europe/Madrid", regionLabel: "Comunidad autónoma" },
  IE: { name: "Ireland", displayLocale: "en-IE", contentLanguage: "en", bookingTimezone: "Europe/Dublin", regionLabel: "County" },
} as const;

export const austriaPropertyRegions = ["Wien", "Steiermark", "Tirol", "Salzburg", "Oberösterreich", "Niederösterreich", "Kärnten", "Burgenland", "Vorarlberg"] as const;
const folded = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/oe/g, "o").replace(/ae/g, "a").replace(/ue/g, "u").trim();
export function normalizePropertyRegion(value: unknown): string {
  if (typeof value !== "string") return "";
  const region = value.trim();
  return austriaPropertyRegions.find((candidate) => folded(candidate) === folded(region)) ?? region;
}
export function isPropertyCountryCode(value: unknown): value is PropertyCountryCode {
  return typeof value === "string" && (propertyCountries as readonly string[]).includes(value);
}
const displayLocales: readonly string[] = ["de-AT", "de-DE", "es-ES", "en-IE", "de", "en", "es"];
const contentLanguages: readonly string[] = ["de", "en", "es"];
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function timezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}

/** Strict persisted shape. Unknown countries, locales, currencies and timezones fail closed. */
export function normalizePropertyGeography(value: unknown): PropertyGeography | null {
  const input = object(value);
  if (input.version !== 1 || !isPropertyCountryCode(input.countryCode) ||
      typeof input.region !== "string" || input.region.trim().length > 200 || /[\u0000-\u001f<>]/.test(input.region) ||
      !displayLocales.includes(String(input.displayLocale)) || !contentLanguages.includes(String(input.contentLanguage)) ||
      input.currency !== "EUR" || !timezone(input.bookingTimezone) ||
      !["explicit", "legacy_at_region"].includes(String(input.source))) return null;
  return { version: 1, countryCode: input.countryCode, region: normalizePropertyRegion(input.region),
    displayLocale: input.displayLocale as PropertyDisplayLocale, contentLanguage: input.contentLanguage as PropertyContentLanguage,
    currency: "EUR", bookingTimezone: input.bookingTimezone, source: input.source as PropertyGeography["source"] };
}

export function createPropertyGeography(countryCode: PropertyCountryCode, region = ""): PropertyGeography {
  const defaults = propertyCountryDefaults[countryCode];
  return { version: 1, countryCode, region: normalizePropertyRegion(region), displayLocale: defaults.displayLocale,
    contentLanguage: defaults.contentLanguage, currency: "EUR", bookingTimezone: defaults.bookingTimezone, source: "explicit" };
}

/** Legacy AT inference is restricted to a known Austrian region and remains labelled as inferred. */
export function readPropertyGeography(input: { canonicalPayload?: Record<string, unknown> | null; region?: unknown; countryCode?: unknown }): PropertyGeography | null {
  const payload = object(input.canonicalPayload);
  if (Object.hasOwn(payload, "geography")) return normalizePropertyGeography(payload.geography);
  if (isPropertyCountryCode(input.countryCode)) return createPropertyGeography(input.countryCode, normalizePropertyRegion(input.region));
  const region = normalizePropertyRegion(input.region);
  if (!(austriaPropertyRegions as readonly string[]).includes(region)) return null;
  return { ...createPropertyGeography("AT", region), source: "legacy_at_region" };
}

/** Used at the write boundary, so a foreign address can never silently become Vienna. */
export function propertyGeographyFromInput(input: Record<string, unknown>): { ok: true; geography: PropertyGeography } | { ok: false; reason: string } {
  if (Object.hasOwn(input, "geography")) {
    const geography = normalizePropertyGeography(input.geography);
    return geography ? { ok: true, geography } : { ok: false, reason: "Invalid property geography" };
  }
  const fields = object(input.fieldValues);
  const country = input.countryCode ?? fields["location.land"];
  const region = normalizePropertyRegion(input.region ?? fields["location.bundesland"]);
  if (country !== undefined && country !== "" && !isPropertyCountryCode(country)) return { ok: false, reason: "Invalid property country; choose AT, DE, ES or IE" };
  const geography = readPropertyGeography({ countryCode: country, region });
  return geography ? { ok: true, geography } : { ok: false, reason: "Invalid property geography: choose the property country explicitly" };
}

export type PropertyEnergyCertificate = {
  version?: 1;
  countryCode?: PropertyCountryCode;
  schemeVersion?: string;
  certificateType?: "demand" | "consumption" | "project" | "completed" | "existing";
  energyClass?: string;
  heatingDemandKwhM2?: number;
  finalEnergyDemandKwhM2?: number;
  finalEnergyConsumptionKwhM2?: number;
  heatingEnergyKwhM2?: number;
  electricityEnergyKwhM2?: number;
  overallEfficiencyFactor?: number;
  energySource?: string;
  issuedAt?: string;
  validUntil?: string;
  certificateNumber?: string;
  sourceDocumentId?: string;
  registration?: string;
  exemptionReason?: string;
};
const energyTextLimits = { schemeVersion: 120, energyClass: 12, energySource: 300, certificateNumber: 100, registration: 300, exemptionReason: 2000 } as const;
const energyNumberFields = ["heatingDemandKwhM2", "finalEnergyDemandKwhM2", "finalEnergyConsumptionKwhM2", "heatingEnergyKwhM2", "electricityEnergyKwhM2", "overallEfficiencyFactor"] as const;
const energyTypes = ["demand", "consumption", "project", "completed", "existing"];
function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
/** Only the whitelisted certificate values enter the canonical record or a public snapshot. */
export function normalizePropertyEnergyCertificate(value: unknown): PropertyEnergyCertificate | null {
  const input = object(value);
  if (input.version !== 1 || !isPropertyCountryCode(input.countryCode)) return null;
  const allowed = ["version", "countryCode", "certificateType", "issuedAt", "validUntil", "sourceDocumentId", ...Object.keys(energyTextLimits), ...energyNumberFields];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return null;
  const result: PropertyEnergyCertificate = { version: 1, countryCode: input.countryCode };
  if (input.certificateType !== undefined && input.certificateType !== "") {
    if (!energyTypes.includes(String(input.certificateType))) return null;
    result.certificateType = input.certificateType as PropertyEnergyCertificate["certificateType"];
  }
  for (const [key, limit] of Object.entries(energyTextLimits) as [keyof typeof energyTextLimits, number][]) {
    if (input[key] === undefined || input[key] === "") continue;
    if (typeof input[key] !== "string" || input[key].length > limit || /[\u0000-\u001f<>]/.test(input[key])) return null;
    result[key] = input[key].trim();
  }
  for (const key of energyNumberFields) {
    if (input[key] === undefined || input[key] === null) continue;
    if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1_000_000) return null;
    result[key] = input[key];
  }
  for (const key of ["issuedAt", "validUntil"] as const) {
    if (input[key] === undefined || input[key] === "") continue;
    if (!isIsoDate(input[key])) return null;
    result[key] = input[key];
  }
  if (result.issuedAt && result.validUntil && result.issuedAt > result.validUntil) return null;
  if (input.sourceDocumentId !== undefined && input.sourceDocumentId !== "") {
    if (typeof input.sourceDocumentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sourceDocumentId)) return null;
    result.sourceDocumentId = input.sourceDocumentId;
  }
  return result;
}
export type CountryPublicationCheck = { id: string; ruleVersion: string; status: "ready" | "missing" | "review"; message: string; source: string };
/** Product preflight, not an automatic assertion of legal compliance or verified exemptions. */
export function countryPublicationChecks(input: {
  geography: PropertyGeography | null; energy?: PropertyEnergyCertificate; marketingType?: string; usageType?: string; yearBuilt?: number; asOf?: string;
}): CountryPublicationCheck[] {
  const geography = input.geography;
  if (!geography) return [{ id: "COUNTRY", ruleVersion: "2026-10-30", status: "missing", message: "Objektland und Darstellungsprofil festlegen.", source: "" }];
  const energy = input.energy ?? {};
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const isFiniteEnergy = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const hasClass = typeof energy.energyClass === "string" && energy.energyClass.trim().length > 0;
  const validEnergyClass = geography.countryCode === "AT" ? /^(?:A\+\+|A\+|[A-G])$/.test(energy.energyClass ?? "")
    : geography.countryCode === "DE" ? /^(?:A\+|[A-H])$/.test(energy.energyClass ?? "")
    : geography.countryCode === "ES" ? /^[A-G]$/.test(energy.energyClass ?? "") : hasClass;
  const check = (id: string, ready: boolean, message: string, source: string, ruleVersion = "2026-10-30"): CountryPublicationCheck =>
    ({ id, ruleVersion, status: energy.exemptionReason ? "review" : ready ? "ready" : "missing", message, source });
  const common: CountryPublicationCheck[] = [{ id: `${geography.countryCode}-LOCATION`, ruleVersion: "2026-10-30", status: geography.region ? "ready" : "review", message: "Region und örtlichen Regelumfang für diese Veröffentlichung prüfen.", source: "" }];
  if (energy.countryCode && energy.countryCode !== geography.countryCode) return [...common, { id: "ENERGY-COUNTRY", ruleVersion: "2026-10-30", status: "missing", message: "Der Energieausweis gehört zu einem anderen Länderprofil. Daten und Ausweisfassung neu prüfen.", source: "" }];
  if ((energy.validUntil && energy.validUntil < asOf) || (energy.issuedAt && energy.issuedAt > asOf)) common.push({ id: "ENERGY-DATE", ruleVersion: "2026-10-30", status: "missing", message: "Ausstellungsdatum und Gültigkeit des Energieausweises prüfen.", source: "" });
  if (geography.countryCode === "AT") {
    const current = asOf >= "2026-07-01";
    return [...common, check("AT-ENERGY", isFiniteEnergy(energy.heatingDemandKwhM2) && (current ? isFiniteEnergy(energy.finalEnergyDemandKwhM2) && validEnergyClass : isFiniteEnergy(energy.overallEfficiencyFactor)),
      current ? "HWB, Endenergiebedarf und Gesamtenergieeffizienzklasse für die Anzeigenfassung ab 01.07.2026 prüfen." : "Historische Energieangaben und damalige Regelversion prüfen.",
      "https://ris.bka.gv.at/eli/bgbl/i/2012/27/P3/NOR40278044", current ? "EAVG-2026-07-01" : "EAVG-historical-review")];
  }
  if (geography.countryCode === "DE") {
    const knownUse = input.usageType === "residential" || input.usageType === "commercial";
    const residential = input.usageType === "residential";
    const typeValid = energy.certificateType === "demand" || energy.certificateType === "consumption";
    const reading = energy.certificateType === "consumption" ? energy.finalEnergyConsumptionKwhM2 : energy.finalEnergyDemandKwhM2;
    const numbersReady = residential ? isFiniteEnergy(reading) && validEnergyClass && Number.isInteger(input.yearBuilt) && Number(input.yearBuilt) > 0
      : isFiniteEnergy(energy.heatingEnergyKwhM2) && isFiniteEnergy(energy.electricityEnergyKwhM2);
    return [...common, check("DE-ENERGY", knownUse && typeValid && Boolean(energy.energySource) && numbersReady,
      "Wohngebäude: Ausweisart, Endenergiebedarf/-verbrauch, Heizenergieträger, Baujahr und Klasse. Nichtwohngebäude: Wärme und Strom getrennt. Gemischte Nutzung manuell prüfen.", "https://www.gesetze-im-internet.de/geg/__87.html"),
      ...(!knownUse ? [{ id: "DE-USE", ruleVersion: "2026-10-30", status: "review" as const, message: "Wohn-/Nichtwohngebäude oder gemischte Nutzung ausdrücklich prüfen.", source: "https://www.gesetze-im-internet.de/geg/__87.html" }] : [])];
  }
  if (geography.countryCode === "ES") return [...common, check("ES-ENERGY", validEnergyClass && ["project", "completed", "existing"].includes(energy.certificateType ?? ""),
    "Energieklasse und Zertifikatsstufe (Projekt, fertiggestellt, Bestand) einschließlich regionaler Registrierung prüfen.", "https://www.boe.es/buscar/act.php?id=BOE-A-2021-9176"),
    { id: "ES-REGIONAL", ruleVersion: "2026-10-30", status: "review", message: "Regionale Maklerkennzeichnung, Flächenart und ggf. Kurzzeitvermietung fallbezogen prüfen; keine pauschale NRA-Sperre.", source: "https://www.boe.es/buscar/act.php?id=BOE-A-2024-26931" }];
  const validOldClass = /^(?:A[123]|B[123]|C[123]|D[12]|E[12]|F|G)$/.test(energy.energyClass ?? "");
  const validNewClass = /^(?:A0|A|B|C|D|E|F|G)$/.test(energy.energyClass ?? "");
  const classMatchesVersion = energy.schemeVersion === "SEAI-2026-05-24" ? validNewClass : energy.schemeVersion === "SEAI-pre-2026-05-24" ? validOldClass : false;
  const dateMatchesVersion = Boolean(energy.issuedAt && (energy.schemeVersion === "SEAI-2026-05-24" ? energy.issuedAt >= "2026-05-24" : energy.issuedAt < "2026-05-24"));
  const tenYearsLater = energy.issuedAt ? `${Number(energy.issuedAt.slice(0, 4)) + 10}${energy.issuedAt.slice(4)}` : "";
  return [...common, check("IE-BER", classMatchesVersion && dateMatchesVersion && tenYearsLater >= asOf && /^\d{9}$/.test(energy.certificateNumber ?? "") && isFiniteEnergy(energy.finalEnergyDemandKwhM2), "BER mit Schemafassung, Ausstellungsdatum, neunstelliger Nummer und EPI ausgeben; alte gültige Zertifikate nicht auf die neue Skala umdeuten.", "https://www.seai.ie/ber/ber-advertising"),
    { id: "IE-PSRA", ruleVersion: "2026-10-30", status: "review", message: "Zuständige PSRA-Lizenz, Angebotsprotokoll und Status Sale agreed/Sold getrennt prüfen.", source: "https://www.psr.ie/" }];
}
