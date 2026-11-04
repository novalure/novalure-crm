import { normalizePropertyEnergyCertificate, type PropertyCountryCode, type PropertyEnergyCertificate } from "@/lib/property-country";
import type { PublicPropertyFact, PublicPropertyLanguage } from "@/lib/property-expose-details";

const text = (value: unknown) => typeof value === "string" ? value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : "";

/** The same saved-address policy is applied before website and PDF snapshots.
 * Redact only the stored full address and, when available, the stored street.
 * Do not guess at locations or remove a public city/region from unrelated text.
 */
export function sanitizePropertyExposeAddress(value: unknown, address: unknown, showAddress: boolean, language: PublicPropertyLanguage, street?: unknown) {
  let result = text(value);
  const replacement = language === "de" ? "[Adresse ausgeblendet]" : language === "es" ? "[dirección oculta]" : "[address hidden]";
  if (!showAddress) for (const privatePart of [text(address), text(street)]) {
    if (privatePart.length >= 3) result = result.split(privatePart).join(replacement);
  }
  return result;
}

/** Only approved certificate facts enter the private PDF source projection.
 * Source document IDs and free-form exemption notes are intentionally omitted.
 */
export function publicPropertyEnergySql(alias: string) {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid SQL alias");
  const keys = ["version", "countryCode", "schemeVersion", "certificateType", "energyClass", "heatingDemandKwhM2", "finalEnergyDemandKwhM2", "finalEnergyConsumptionKwhM2", "heatingEnergyKwhM2", "electricityEnergyKwhM2", "overallEfficiencyFactor", "energySource", "issuedAt", "validUntil", "certificateNumber", "registration"];
  return `case when ${alias}.canonical_payload ? 'energyCertificate' then jsonb_strip_nulls(jsonb_build_object(${keys.map(key => `'${key}',${alias}.canonical_payload->'energyCertificate'->'${key}'`).join(",")})) else null end`;
}

/** Canonical values are country-bound and share labels across both PDF paths. */
export function publicPropertyEnergyFacts(value: unknown, country: PropertyCountryCode | undefined, language: PublicPropertyLanguage, locale: string,
  legacy?: { energyClass?: unknown; energyValidUntil?: unknown }): PublicPropertyFact[] {
  const t = (de: string, en: string, es: string) => language === "de" ? de : language === "es" ? es : en;
  const facts: PublicPropertyFact[] = [];
  const energy = normalizePropertyEnergyCertificate(value);
  if (!energy || energy.countryCode !== country) {
    // A present invalid/foreign canonical certificate must not revive stale
    // legacy values or publish another country's energy identifiers.
    if (value !== undefined && value !== null) return facts;
    if (text(legacy?.energyClass)) facts.push({ label: t("Energieklasse (gespeichert)", "Energy class (saved)", "Clase energética (guardada)"), value: text(legacy?.energyClass) });
    if (text(legacy?.energyValidUntil)) facts.push({ label: t("Energieausweis gültig bis", "Energy certificate valid until", "Certificado energético válido hasta"), value: text(legacy?.energyValidUntil) });
    return facts;
  }
  const number = (key: keyof PropertyEnergyCertificate, label: string, unit = " kWh/(m²a)") => {
    const n = energy[key];
    if (typeof n === "number") facts.push({ label, value: new Intl.NumberFormat(locale).format(n) + unit });
  };
  const field = (key: keyof PropertyEnergyCertificate, label: string) => { if (text(energy[key])) facts.push({ label, value: text(energy[key]) }); };
  field("energyClass", country === "IE" ? t("BER-Einstufung", "BER rating", "Calificación BER") : t("Energieklasse", "Energy rating", "Clase energética"));
  if (country === "AT") {
    number("heatingDemandKwhM2", "HWB");
    number("finalEnergyDemandKwhM2", t("Endenergiebedarf", "Final energy demand", "Demanda de energía final"));
    number("overallEfficiencyFactor", "fGEE", "");
  } else if (country === "DE") {
    number("finalEnergyDemandKwhM2", t("Endenergiebedarf", "Final energy demand", "Demanda de energía final"));
    number("finalEnergyConsumptionKwhM2", t("Endenergieverbrauch", "Final energy consumption", "Consumo de energía final"));
    number("heatingEnergyKwhM2", t("Wärmeenergie", "Heating energy", "Energía térmica"));
    number("electricityEnergyKwhM2", t("Stromenergie", "Electricity", "Electricidad"));
    field("energySource", t("Energieträger", "Energy source", "Fuente de energía"));
  } else if (country === "ES") {
    number("finalEnergyDemandKwhM2", t("Energiekennwert", "Energy performance", "Consumo energético"));
    field("registration", t("Registrierung", "Registration", "Registro"));
  } else if (country === "IE") {
    number("finalEnergyDemandKwhM2", "EPI");
    field("certificateNumber", t("BER-Nummer", "BER number", "Número BER"));
  }
  const certificateNames: Record<string, [string, string, string]> = {
    demand: ["Bedarfsausweis", "Demand certificate", "Certificado de demanda"], consumption: ["Verbrauchsausweis", "Consumption certificate", "Certificado de consumo"],
    project: ["Projektzertifikat", "Project certificate", "Certificado de proyecto"], completed: ["Fertiggestelltes Gebäude", "Completed building", "Edificio terminado"], existing: ["Bestandsgebäude", "Existing building", "Edificio existente"],
  };
  if (energy.certificateType) {
    const labels = certificateNames[energy.certificateType];
    if (labels) facts.push({ label: t("Ausweistyp", "Certificate type", "Tipo de certificado"), value: t(...labels) });
  }
  field("issuedAt", t("Ausgestellt", "Issued", "Fecha de emisión"));
  field("validUntil", t("Gültig bis", "Valid until", "Válido hasta"));
  field("schemeVersion", country === "IE" ? t("BER-Skala", "BER scale", "Escala BER") : t("Ausweis-/Regelversion", "Certificate / scheme version", "Versión del certificado"));
  return facts;
}
