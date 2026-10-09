import { headers } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CrmWorkspace } from "@/components/crm-workspace";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getCoreCrmData } from "@/lib/db/crm-loaders";
import { languageRequestHeaderName } from "@/lib/i18n";
import { publicSiteOrigin } from "@/lib/legal";
import { getRequestCountry } from "@/lib/public-audit";
import {
  publicLanguageRequestHeaderName,
  resolvePublicSiteLanguage,
  toAppLanguage,
} from "@/lib/public-language";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

const homeMetadata = {
  en: {
    title: "Novalure | Staff Login",
    description:
      "Internal access for authorised Novalure users.",
    openGraphTitle: "Novalure Staff Login",
    openGraphDescription: "Internal access for authorised Novalure users.",
  },
  de: {
    title: "Novalure | Mitarbeiter-Login",
    description:
      "Interner Zugang für autorisierte Novalure-Nutzer.",
    openGraphTitle: "Novalure Mitarbeiter-Login",
    openGraphDescription: "Interner Zugang für autorisierte Novalure-Nutzer.",
  },
  es: {
    title: "Novalure | Acceso del personal",
    description:
      "Acceso interno para usuarios autorizados de Novalure.",
    openGraphTitle: "Novalure Acceso del personal",
    openGraphDescription: "Acceso interno para usuarios autorizados de Novalure.",
  },
} as const;

function resolveHomeLanguage(
  requestHeaders: Headers,
  query: Record<string, string | string[] | undefined>,
) {
  const country = getRequestCountry(requestHeaders);
  const language = resolvePublicSiteLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country,
    persistedLanguage: requestHeaders.get(publicLanguageRequestHeaderName) ?? requestHeaders.get(languageRequestHeaderName),
    requestedLanguage: query.lang,
  });

  return { country, language };
}

export async function generateMetadata({ searchParams }: HomeProps): Promise<Metadata> {
  const requestHeaders = await headers();
  const query = searchParams ? await searchParams : {};
  const { language } = resolveHomeLanguage(requestHeaders, query);
  const copy = homeMetadata[language];
  const canonicalUrl = new URL("/", publicSiteOrigin);
  canonicalUrl.searchParams.set("lang", language);

  return {
    title: copy.title,
    description: copy.description,
    alternates: {
      canonical: canonicalUrl.toString(),
      languages: {
        de: `${publicSiteOrigin}/?lang=de`,
        en: `${publicSiteOrigin}/?lang=en`,
        es: `${publicSiteOrigin}/?lang=es`,
      },
    },
    openGraph: {
      title: copy.openGraphTitle,
      description: copy.openGraphDescription,
      locale: language === "de" ? "de_AT" : language === "es" ? "es_ES" : "en_GB",
      siteName: "Novalure CRM",
      type: "website",
      url: canonicalUrl.toString(),
    },
  };
}

export default async function Home({ searchParams }: HomeProps) {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  const query = searchParams ? await searchParams : {};
  const { language } = resolveHomeLanguage(requestHeaders, query);
  const appLanguage = toAppLanguage(language);

  if (!session) {
    redirect(`/login?lang=${language}`);
  }

  const coreData = await getCoreCrmData(session.workspaceId, { session });

  return (
    <CrmWorkspace
      coreData={coreData}
      initialLanguage={appLanguage}
      sessionProductRole={session.productRole}
      sessionRole={session.role}
      sessionUserId={session.userId}
      sessionUserName={session.name}
      sessionWorkspace={{
        activeCalendarProvider: session.workspaceActiveCalendarProvider ?? undefined,
        customerType: session.workspaceCustomerType ?? undefined,
        id: session.workspaceId,
        name: session.workspaceName,
        operatingModel: session.workspaceOperatingModel ?? undefined,
        publicKey: session.workspacePublicKey ?? undefined,
        setupState: session.workspaceSetupState ?? undefined,
        teamStructure: session.workspaceTeamStructure ?? undefined,
      }}
    />
  );
}
