import type { Metadata } from "next";
import { headers } from "next/headers";
import { publicSiteOrigin } from "@/lib/legal";
import { getRequestCountry } from "@/lib/public-audit";
import {
  publicLanguageRequestHeaderName,
  resolvePublicSiteLanguage,
  withPublicLanguage,
  type PublicLanguageCode,
} from "@/lib/public-language";

export type PublicProductPath = "/" | "/bautraeger" | "/makler" | "/funktionen" | "/demo";

export type PublicProductPageProps = {
  searchParams: Promise<{ lang?: string | string[] }>;
};

export async function getPublicProductLanguage(requestedLanguage?: string | string[]) {
  const requestHeaders = await headers();
  return resolvePublicSiteLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: getRequestCountry(requestHeaders),
    persistedLanguage: requestHeaders.get(publicLanguageRequestHeaderName),
    requestedLanguage,
  });
}

export function publicProductAlternates(path: PublicProductPath): Record<PublicLanguageCode | "x-default", string> {
  const url = new URL(path, publicSiteOrigin).href;
  return {
    de: withPublicLanguage(url, "de"),
    en: withPublicLanguage(url, "en"),
    es: withPublicLanguage(url, "es"),
    "x-default": url,
  };
}

const openGraphLocales: Record<PublicLanguageCode, string> = {
  de: "de_AT",
  en: "en_GB",
  es: "es_ES",
};

export function publicProductMetadata({ path, language, title, description }: {
  path: PublicProductPath;
  language: PublicLanguageCode;
  title: string;
  description: string;
}): Metadata {
  const languages = publicProductAlternates(path);
  return {
    title,
    description,
    alternates: { canonical: languages[language], languages },
    openGraph: {
      type: "website",
      siteName: "Novalure CRM",
      title,
      description,
      locale: openGraphLocales[language],
      url: languages[language],
    },
    twitter: { card: "summary", title, description },
  };
}
