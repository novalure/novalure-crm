import registry from "./property-country-requirements.json";
import type { PropertyCountryCode } from "./property-country";

/** Frozen source-backed product requirements from the approved report, not completion claims. */
export const propertyCountryRuleVersion = registry.version;
export function getPropertyCountryRequirements(country: PropertyCountryCode) {
  return registry.countries.find((item) => item.country === country)?.requirements ?? [];
}
export function getPropertyCountryRequirementSource(id: string): { title: string; url: string } | null {
  const sources: Record<string, { title: string; url: string }> = registry.sources;
  return sources[id] ?? null;
}
