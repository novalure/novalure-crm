import type { LanguageCode } from "@/lib/i18n";

const germanDefaultCountries = new Set(["AT", "CH", "DE"]);

function firstQueryValue(value: string | string[] | null | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function normalizeLanguage(value: string | string[] | null | undefined): LanguageCode | null {
  const normalized = firstQueryValue(value).trim().toLowerCase();
  if (normalized === "de" || normalized === "en") return normalized;
  return null;
}

function acceptsGermanForDach(acceptLanguage: string | null | undefined) {
  return (acceptLanguage ?? "")
    .split(",")
    .map((part) => part.trim().split(";")[0]?.toLowerCase())
    .some((locale) => locale === "de" || locale === "de-at" || locale === "de-ch" || locale === "de-de");
}

export function resolvePublicLanguage(input: {
  acceptLanguage?: string | null;
  country?: string | null;
  persistedLanguage?: string | string[] | null;
  requestedLanguage?: string | string[] | undefined;
}): LanguageCode {
  const requested = normalizeLanguage(input.requestedLanguage);
  if (requested) return requested;

  const persisted = normalizeLanguage(input.persistedLanguage);
  if (persisted) return persisted;

  const country = input.country?.trim().toUpperCase();
  if (country) return germanDefaultCountries.has(country) ? "de" : "en";

  return acceptsGermanForDach(input.acceptLanguage) ? "de" : "en";
}

export function withPublicLanguage(href: string, language: LanguageCode) {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}lang=${language}`;
}
