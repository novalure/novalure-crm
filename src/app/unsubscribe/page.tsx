import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { recordNewsletterUnsubscribe } from "@/lib/db/runtime-repositories";
import {
  getNewsletterUnsubscribePageCopy,
  type LanguageCode,
} from "@/lib/i18n";
import { buildPublicPageMetadata, resolvePublicPageLanguage } from "@/lib/page-metadata";
import { withPublicLanguage } from "@/lib/public-language";

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
  return buildPublicPageMetadata({
    description: language === "de"
      ? "Sichere Newsletter-Abmeldung für Novalure CRM Nachrichten."
      : "Secure newsletter unsubscribe for Novalure CRM messages.",
    language,
    path: pagePath,
    title: copy.title,
  });
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function getUnsubscribeLanguageHref(
  language: LanguageCode,
  query: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams({ lang: language });
  for (const key of ["email", "workspaceId", "wid", "campaignId", "campaign"]) {
    const value = firstQueryValue(query[key]).trim();
    if (value) params.set(key, value);
  }
  return `/unsubscribe?${params.toString()}`;
}

export default async function UnsubscribePage({ searchParams }: UnsubscribePageProps) {
  const query = searchParams ? await searchParams : {};
  const headersList = await headers();
  const language: LanguageCode = resolvePublicPageLanguage(headersList, query);
  const copy = getNewsletterUnsubscribePageCopy(language);
  const email = firstQueryValue(query.email).trim();
  const workspaceId = (firstQueryValue(query.workspaceId) || firstQueryValue(query.wid)).trim();
  const campaignId = (firstQueryValue(query.campaignId) || firstQueryValue(query.campaign)).trim();
  const result =
    email && workspaceId
      ? await recordNewsletterUnsubscribe({
          campaignId,
          email,
          metadata: {
            userAgent: headersList.get("user-agent") ?? "",
          },
          source: "Newsletter-Abmeldelink",
          workspaceId,
        })
      : null;
  const isRecorded = Boolean(result?.persisted);

  return (
    <PublicSiteShell
      currentPath="/unsubscribe"
      language={language}
      languageHrefs={{
        de: getUnsubscribeLanguageHref("de", query),
        en: getUnsubscribeLanguageHref("en", query),
      }}
    >
      <section className={subpageStyles.statusWrap}>
        <div className={subpageStyles.statusCard}>
          <p className={subpageStyles.eyebrow}>{copy.title}</p>
          <h1>{isRecorded ? copy.recordedTitle : copy.missingTitle}</h1>
          <p>{isRecorded ? copy.recordedDescription : copy.missingDescription}</p>
          <Link
            className={subpageStyles.secondaryButton}
            href={withPublicLanguage("/", language)}
          >
            {copy.backToSite}
          </Link>
        </div>
      </section>
    </PublicSiteShell>
  );
}
