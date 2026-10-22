import type { LanguageCode } from "@/lib/language-runtime";

export type LanguagePreference = "auto" | LanguageCode;
export const crmEntryRequestHeaderName = "x-novalure-crm-entry";
export const guestCrmPreferenceCookieName = "novalure.crm-language-preference";

const germanCrmCountries = new Set(["AT", "DE", "CH", "LU", "LI"]);

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "auto" || value === "de" || value === "en";
}

/** Country is used only for the UI default, never for business or access rules. */
export function resolveAutomaticCrmLanguage(country: unknown): LanguageCode {
  const normalized = typeof country === "string" ? country.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(normalized) && germanCrmCountries.has(normalized) ? "de" : "en";
}

export function resolveCrmLanguage(preference: unknown, country: unknown): LanguageCode {
  return preference === "de" || preference === "en"
    ? preference
    : resolveAutomaticCrmLanguage(country);
}

/** Only Vercel's overwritten country header is trusted in its actual runtime. */
export function getTrustedCrmCountry(headers: Pick<Headers, "get">, isVercel: boolean): string | null {
  return isVercel ? headers.get("x-vercel-ip-country") : null;
}
