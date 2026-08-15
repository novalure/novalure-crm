import type { Metadata } from "next";
import type { LanguageCode } from "@/lib/i18n";
import { publicSiteOrigin } from "@/lib/legal";
import { languageRequestHeaderName } from "@/lib/language-runtime";
import { resolvePublicLanguage } from "@/lib/public-language";

export type PublicPageSearchParams = Record<string, string | string[] | undefined>;

export function resolvePublicPageLanguage(
  requestHeaders: Pick<Headers, "get">,
  query: PublicPageSearchParams,
): LanguageCode {
  return resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: requestHeaders.get("x-vercel-ip-country"),
    persistedLanguage: requestHeaders.get(languageRequestHeaderName),
    requestedLanguage: query.lang,
  });
}

export function buildPublicPageMetadata(input: {
  description: string;
  language: LanguageCode;
  path: string;
  title: string;
}): Metadata {
  const canonicalUrl = new URL(input.path, publicSiteOrigin);
  canonicalUrl.searchParams.set("lang", input.language);

  return {
    alternates: {
      canonical: canonicalUrl.toString(),
      languages: {
        de: new URL(`${input.path}?lang=de`, publicSiteOrigin).toString(),
        en: new URL(`${input.path}?lang=en`, publicSiteOrigin).toString(),
      },
    },
    description: input.description,
    title: `${input.title} | Novalure CRM`,
  };
}
