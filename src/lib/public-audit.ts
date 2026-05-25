import type { LanguageCode } from "@/lib/i18n";

const dachCountries = new Set(["AT", "CH", "DE"]);

export const germanAuditHref = "https://www.novalure.eu/de/kontakt#book-audit";
export const internationalAuditHref = "https://www.novalure.eu/en/contact";

export function getRequestCountry(requestHeaders: Headers) {
  return (
    requestHeaders.get("x-vercel-ip-country") ??
    requestHeaders.get("cf-ipcountry") ??
    requestHeaders.get("x-country-code")
  );
}

export function resolveAuditHref(country: string | null, language: LanguageCode) {
  const normalizedCountry = country?.trim().toUpperCase();
  if (normalizedCountry) {
    return dachCountries.has(normalizedCountry) ? germanAuditHref : internationalAuditHref;
  }

  return language === "de" ? germanAuditHref : internationalAuditHref;
}
