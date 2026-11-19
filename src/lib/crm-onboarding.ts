import { createPropertyGeography, isPropertyCountryCode, type PropertyCountryCode, type PropertyEnergyCertificate } from "./property-country";
export const onboardingStepIds = ["property", "units", "inquiry", "ownership", "next_task", "expose", "country_review", "automations", "channels"] as const;
export type CrmOnboardingStepId = typeof onboardingStepIds[number];
export type CrmOnboardingProgress = { countryCode: PropertyCountryCode; reviewedSteps: CrmOnboardingStepId[] };
export type CrmExampleTag = { schemaVersion: 1; templateVersion: 1; scenarioId: string; countryCode: PropertyCountryCode; synthetic: true };
export function parseCrmOnboardingProgress(value: unknown): CrmOnboardingProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ONBOARDING");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["countryCode", "reviewedSteps"].includes(key)) || !isPropertyCountryCode(input.countryCode) || !Array.isArray(input.reviewedSteps) || input.reviewedSteps.some((step) => !(onboardingStepIds as readonly unknown[]).includes(step)) || new Set(input.reviewedSteps).size !== input.reviewedSteps.length) throw new Error("INVALID_ONBOARDING");
  return { countryCode: input.countryCode, reviewedSteps: input.reviewedSteps as CrmOnboardingStepId[] };
}
export const onboardingExamplePlaces = { AT: { region: "Wien", city: "Wien", address: "BEISPIEL · Fiktiver Wohnpark AT 1" }, DE: { region: "Bayern", city: "München", address: "BEISPIEL · Fiktiver Wohnpark DE 1" }, ES: { region: "Catalunya", city: "Barcelona", address: "EJEMPLO · Residencia ficticia ES 1" }, IE: { region: "Dublin", city: "Dublin", address: "EXAMPLE · Fictional residence IE 1" } } as const;
export function buildCrmExampleScenario(countryCode: PropertyCountryCode, scenarioId: string) {
  const place = onboardingExamplePlaces[countryCode], tag: CrmExampleTag = { schemaVersion: 1, templateVersion: 1, scenarioId, countryCode, synthetic: true };
  const energy: PropertyEnergyCertificate = { version: 1, countryCode,
    ...(countryCode === "AT" ? { heatingDemandKwhM2: 32, finalEnergyDemandKwhM2: 50, energyClass: "B" }
      : countryCode === "DE" ? { certificateType: "demand" as const, energySource: "BEISPIEL · Wärmepumpe", finalEnergyDemandKwhM2: 50, energyClass: "B" }
        : countryCode === "ES" ? { certificateType: "existing" as const, finalEnergyDemandKwhM2: 50, energyClass: "B", registration: "EJEMPLO-NO-VALIDO" }
          : { schemeVersion: "SEAI-2026-05-24", energyClass: "A0", issuedAt: "2026-06-01", validUntil: "2036-06-01", certificateNumber: "000000000", finalEnergyDemandKwhM2: 15 }) };
  return { tag, geography: createPropertyGeography(countryCode, place.region), energy, place, projectName: `BEISPIEL / EXAMPLE · ${countryCode} · Immobilienablauf`, propertyTitle: `BEISPIEL / EXAMPLE · ${place.city} · Wohnprojekt`, contactName: "BEISPIEL / EXAMPLE · Fiktive Kaufanfrage", email: `example-${scenarioId}@example.invalid`, taskTitle: "BEISPIEL / EXAMPLE · Anfrage prüfen und nächste Aktion festlegen" };
}
export const onboardingGuide = {
  de: [
    ["property", "Immobilie und Land", "Objekt anlegen und Land, Region, Inhaltssprache, Format und Terminzeitzone getrennt prüfen.", "properties"],
    ["units", "Einheiten und Verfügbarkeit", "Reale Einheiten mit Fläche und Status führen. Vormerkung, Reservierung und bestätigter Verkauf sind getrennte Fachaktionen.", "properties"],
    ["inquiry", "Anfrage und Kontakt", "Eine Anfrage mit Quelle und Objektbezug erfassen. Ein persönlicher Exposé-Link beweist keine Identität.", "leads"],
    ["ownership", "Verantwortliche Person", "Aktives berechtigtes Teammitglied zuweisen. Eine Zuständigkeit erweitert keine Datenrechte.", "leads"],
    ["next_task", "Nächster Schritt", "Konkrete nächste Aufgabe mit Zuständigkeit und Fälligkeit speichern und erst nach Bestätigung als erledigt betrachten.", "tasks"],
    ["expose", "Website-Exposé und Medien", "Bilder, Grundrisse, PDFs und Videos prüfen und auswählen, Länderangaben und Vorschau kontrollieren, danach eine Sprachversion veröffentlichen. Nutzungsstatistik benötigt Einwilligung.", "properties"],
    ["country_review", "Länderprüfung", "Die versionierten Anforderungen für das gewählte Objektland und dessen Region prüfen. Eine ausgefüllte Maske ersetzt keine fachliche Freigabe.", "properties"],
    ["automations", "Ablauf aufbauen", "Auslöser, Bedingung, Aufgabe, Wartezeit und Ende verbinden, am berechtigten Testfall simulieren und eine geprüfte Version aktivieren.", "flows"],
    ["channels", "Externe Kanäle", "Portalpaket, vorbereitete Mail und bestätigte externe Zustellung unterscheiden. Zugang und Freigabe werden nur bei tatsächlich angeschlossenem Anbieter wirksam.", "properties"],
  ],
  en: [
    ["property", "Property and country", "Create a property and review country, region, content language, formatting and booking timezone separately.", "properties"],
    ["units", "Units and availability", "Use actual units with area and status. Holds, reservations and confirmed sales are separate business actions.", "properties"],
    ["inquiry", "Inquiry and contact", "Record an inquiry with source and property context. A personal website link does not prove identity.", "leads"],
    ["ownership", "Responsible person", "Assign an active authorised team member. Assignment does not expand data permissions.", "leads"],
    ["next_task", "Next action", "Save a specific next task with an owner and due date, and wait for confirmed persistence.", "tasks"],
    ["expose", "Property website and media", "Review and select pictures, floorplans, PDFs and videos, check country fields and preview, then publish a language version. Usage statistics require consent.", "properties"],
    ["country_review", "Country review", "Review the versioned requirements for the property country and region. Completed fields do not replace professional review.", "properties"],
    ["automations", "Build a flow", "Connect a trigger, conditions, tasks, delays and an end, simulate an authorised case, then activate a reviewed version.", "flows"],
    ["channels", "External channels", "Distinguish a portal package or prepared email from confirmed external delivery. Connections and approvals only work with an actual provider.", "properties"],
  ],
} as const;
