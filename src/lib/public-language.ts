import type { LanguageCode } from "@/lib/language-runtime";
import { evaluateLaunchScope } from "@/lib/launch-scope";

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

export function isPublicLanguageLaunchEnabled(value: unknown): value is PublicLanguageCode {
  if (!isPublicLanguageCode(value)) return false;
  return value !== "es" || evaluateLaunchScope("publicSpanishLocale").allowed;
}

function normalizePublicLanguage(value: string | string[] | null | undefined): PublicLanguageCode | null {
  const normalized = firstQueryValue(value).trim().toLowerCase();
  if (isPublicLanguageLaunchEnabled(normalized)) return normalized;
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

    if ((locale === "es" || locale.startsWith("es-")) && isPublicLanguageLaunchEnabled("es")) {
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
    if (spanishDefaultCountries.has(country) && isPublicLanguageLaunchEnabled("es")) return "es";
    return "en";
  }

  return acceptedPublicLanguage(input.acceptLanguage) ?? "en";
}

export function resolvePublicLanguage(input: Parameters<typeof resolvePublicSiteLanguage>[0]): LanguageCode {
  return toAppLanguage(resolvePublicSiteLanguage(input));
}

export function withPublicLanguage(href: string, language: PublicLanguageCode) {
  const hashIndex = href.indexOf("#");
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const hrefWithoutHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const queryIndex = hrefWithoutHash.indexOf("?");
  const path = queryIndex >= 0 ? hrefWithoutHash.slice(0, queryIndex) : hrefWithoutHash;
  const query = queryIndex >= 0 ? hrefWithoutHash.slice(queryIndex + 1) : "";
  const searchParams = new URLSearchParams(query);
  searchParams.set("lang", isPublicLanguageLaunchEnabled(language) ? language : "en");
  return `${path}?${searchParams.toString()}${hash}`;
}
