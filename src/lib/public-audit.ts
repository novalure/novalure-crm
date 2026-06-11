import type { LanguageCode } from "@/lib/i18n";

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
  void country;
  return language === "de" ? germanAuditHref : internationalAuditHref;
}
