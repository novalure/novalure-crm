import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { getNewsletterUnsubscribePageCopy, type LanguageCode } from "@/lib/i18n";
import { buildPublicPageMetadata, resolvePublicPageLanguage } from "@/lib/page-metadata";
import { withPublicLanguage } from "@/lib/public-language";
import { UnsubscribeConfirmation } from "./unsubscribe-confirmation";

export const dynamic = "force-dynamic";
const pagePath = "/unsubscribe";

type UnsubscribePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: UnsubscribePageProps): Promise<Metadata> {
  const requestHeaders = await headers();
  const query = searchParams ? await searchParams : {};
  const language = resolvePublicPageLanguage(requestHeaders, query);
  const copy = getNewsletterUnsubscribePageCopy(language);
  return {
    ...buildPublicPageMetadata({
      description: language === "de"
        ? "Sichere Newsletter-Abmeldung für Novalure CRM Nachrichten."
        : "Secure newsletter unsubscribe for Novalure CRM messages.",
      language,
      path: pagePath,
      title: copy.title,
    }),
    referrer: "no-referrer",
    robots: { follow: false, index: false },
  };
}

function getUnsubscribeLanguageHref(language: LanguageCode, preview: boolean) {
  const params = new URLSearchParams({ lang: language });
  if (preview) params.set("preview", "1");
  return `/unsubscribe?${params.toString()}`;
}

export default async function UnsubscribePage({ searchParams }: UnsubscribePageProps) {
  const query = searchParams ? await searchParams : {};
  const headersList = await headers();
  const language: LanguageCode = resolvePublicPageLanguage(headersList, query);
  const copy = getNewsletterUnsubscribePageCopy(language);
  const preview = query.preview === "1";

  return (
    <PublicSiteShell
      currentPath="/unsubscribe"
      language={language}
      languageHrefs={{
        de: getUnsubscribeLanguageHref("de", preview),
        en: getUnsubscribeLanguageHref("en", preview),
      }}
    >
      <section className={subpageStyles.statusWrap}>
        <div className={subpageStyles.statusCard}>
          <p className={subpageStyles.eyebrow}>{copy.title}</p>
          <UnsubscribeConfirmation language={language} preview={preview} />
          <Link className={subpageStyles.secondaryButton} href={withPublicLanguage("/", language)}>
            {copy.backToSite}
          </Link>
        </div>
      </section>
    </PublicSiteShell>
  );
}
