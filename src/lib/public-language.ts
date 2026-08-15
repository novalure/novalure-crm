import type { LanguageCode } from "@/lib/language-runtime";

export type PublicLanguageCode = LanguageCode | "es";

export const publicLanguageRequestHeaderName = "x-novalure-public-language";

const germanDefaultCountries = new Set(["AT", "CH", "DE", "LU"]);
const spanishDefaultCountries = new Set([
  "AR",
  "BO",
  "CL",
  "CO",
  "CR",
  "CU",
  "DO",
  "EC",
  "ES",
  "GQ",
  "GT",
  "HN",
  "MX",
  "NI",
  "PA",
  "PE",
  "PR",
  "PT",
  "PY",
  "SV",
  "UY",
  "VE",
]);

function firstQueryValue(value: string | string[] | null | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function isPublicLanguageCode(value: unknown): value is PublicLanguageCode {
  return value === "de" || value === "en" || value === "es";
}

function normalizePublicLanguage(value: string | string[] | null | undefined): PublicLanguageCode | null {
  const normalized = firstQueryValue(value).trim().toLowerCase();
  if (isPublicLanguageCode(normalized)) return normalized;
  return null;
}

function acceptedPublicLanguage(acceptLanguage: string | null | undefined): PublicLanguageCode | null {
  const locales = (acceptLanguage ?? "")
    .split(",")
    .map((part) => part.trim().split(";")[0]?.toLowerCase())
    .filter(Boolean);

  for (const locale of locales) {
    if (locale === "de" || locale === "de-at" || locale === "de-ch" || locale === "de-de" || locale === "de-lu") {
      return "de";
    }

    if (locale === "es" || locale.startsWith("es-")) {
      return "es";
    }

    if (locale === "en" || locale.startsWith("en-")) {
      return "en";
    }
  }

  return null;
}

export function toAppLanguage(language: PublicLanguageCode): LanguageCode {
  return language === "de" ? "de" : "en";
}

export function resolvePublicSiteLanguage(input: {
  acceptLanguage?: string | null;
  country?: string | null;
  persistedLanguage?: string | string[] | null;
  requestedLanguage?: string | string[] | null | undefined;
}): PublicLanguageCode {
  const requested = normalizePublicLanguage(input.requestedLanguage);
  if (requested) return requested;

  const persisted = normalizePublicLanguage(input.persistedLanguage);
  if (persisted) return persisted;

  const country = input.country?.trim().toUpperCase();
  if (country) {
    if (germanDefaultCountries.has(country)) return "de";
    if (spanishDefaultCountries.has(country)) return "es";
    return "en";
  }

  return acceptedPublicLanguage(input.acceptLanguage) ?? "en";
}

export function resolvePublicLanguage(input: Parameters<typeof resolvePublicSiteLanguage>[0]): LanguageCode {
  return toAppLanguage(resolvePublicSiteLanguage(input));
}

export function withPublicLanguage(href: string, language: PublicLanguageCode) {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}lang=${language}`;
}
