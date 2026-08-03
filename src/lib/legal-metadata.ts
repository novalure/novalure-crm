import type { Metadata } from "next";
import { headers } from "next/headers";
import type { LanguageCode } from "@/lib/i18n";
import { publicSiteOrigin } from "@/lib/legal";
import { resolvePublicLanguage } from "@/lib/public-language";

export async function buildLegalPageMetadata(input: {
  copy: Record<LanguageCode, { subtitle: string; title: string }>;
  path: string;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const [requestHeaders, query] = await Promise.all([
    headers(),
    input.searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>),
  ]);
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: requestHeaders.get("x-vercel-ip-country"),
    requestedLanguage: query.lang,
  });
  const page = input.copy[language];
  const canonical = `${publicSiteOrigin}${input.path}?lang=${language}`;
  return {
    alternates: {
      canonical,
      languages: {
        de: `${publicSiteOrigin}${input.path}?lang=de`,
        en: `${publicSiteOrigin}${input.path}?lang=en`,
      },
    },
    description: page.subtitle,
    openGraph: {
      alternateLocale: language === "de" ? ["en_IE"] : ["de_DE"],
      description: page.subtitle,
      locale: language === "de" ? "de_DE" : "en_IE",
      siteName: "Novalure CRM",
      title: `${page.title} | Novalure CRM`,
      type: "website",
      url: canonical,
    },
    title: `${page.title} | Novalure CRM`,
  };
}
