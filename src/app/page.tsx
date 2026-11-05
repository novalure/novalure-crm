import { headers } from "next/headers";
import type { Metadata } from "next";
import { PublicCrmLanding } from "@/components/public-crm-landing";
import { CrmWorkspace } from "@/components/crm-workspace";
import { getCrmRequestLanguage } from "@/lib/auth/request-language";
import { PartnerPortal } from "@/components/partner-portal";
import { getCoreCrmData } from "@/lib/db/crm-loaders";
import {
  getCrmLandingPageCopy,
  getLoginLegalFooterCopy,
  getPublicPageCopy,
  languageRequestHeaderName,
} from "@/lib/i18n";
import { getRequestCountry } from "@/lib/public-audit";
import {
  publicLanguageRequestHeaderName,
  resolvePublicSiteLanguage,
  toAppLanguage,
} from "@/lib/public-language";
import { publicProductAlternates } from "@/lib/public-product-page";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

const homeMetadata = {
  en: {
    title: "Real Estate CRM for Property Developers | Novalure CRM",
    description:
      "Manage new-build sales in Novalure CRM. Track projects, units, property brochures, buyer enquiries, viewings and reservations in one place.",
    openGraphTitle: "Keep every unit and buyer enquiry in view",
    openGraphDescription:
      "Novalure CRM connects projects, unit availability and buyer enquiries for property developers and sales teams.",
  },
  de: {
    title: "CRM für Bauträger und Projektvertrieb | Novalure CRM",
    description:
      "Steuern Sie Ihren Neubauvertrieb mit Novalure CRM. Projekte, Einheiten, Exposés, Kaufanfragen, Besichtigungen und Reservierungen an einem Ort.",
    openGraphTitle: "Jede Einheit und jede Kaufanfrage im Blick",
    openGraphDescription:
      "Novalure CRM verbindet Projektbestand, Exposés und Kaufanfragen für Bauträger und Vertriebsteams.",
  },
  es: {
    title: "CRM para promotoras inmobiliarias | Novalure CRM",
    description:
      "Gestiona la venta de obra nueva con Novalure CRM. Centraliza promociones, unidades, fichas web, consultas de compradores, visitas y reservas.",
    openGraphTitle: "Todas las unidades y consultas de compradores a la vista",
    openGraphDescription:
      "Novalure CRM conecta promociones, disponibilidad y consultas de compradores para promotoras y equipos comerciales.",
  },
} as const;

function resolveHomeLanguage(
  requestHeaders: Headers,
  query: Record<string, string | string[] | undefined>,
) {
  return resolvePublicSiteLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: getRequestCountry(requestHeaders),
    persistedLanguage: requestHeaders.get(publicLanguageRequestHeaderName) ?? requestHeaders.get(languageRequestHeaderName),
    requestedLanguage: query.lang,
  });
}

export async function generateMetadata({ searchParams }: HomeProps): Promise<Metadata> {
  const requestHeaders = await headers();
  const query = searchParams ? await searchParams : {};
  const publicLanguage = resolveHomeLanguage(requestHeaders, query);
  const crmLanguage = await getCrmRequestLanguage();
  const language = crmLanguage.session ? crmLanguage.language : publicLanguage;
  const copy = homeMetadata[language];
  const languages = publicProductAlternates("/");
  const canonicalUrl = languages[language];

  return {
    title: copy.title,
    description: copy.description,
    alternates: {
      canonical: canonicalUrl,
      languages,
    },
    openGraph: {
      title: copy.openGraphTitle,
      description: copy.openGraphDescription,
      locale: language === "de" ? "de_AT" : language === "es" ? "es_ES" : "en_GB",
      siteName: "Novalure CRM",
      type: "website",
      url: canonicalUrl,
    },
    twitter: {
      card: "summary",
      title: copy.openGraphTitle,
      description: copy.openGraphDescription,
    },
  };
}

export default async function Home({ searchParams }: HomeProps) {
  const requestHeaders = await headers();
  const crmLanguage = await getCrmRequestLanguage();
  const { session } = crmLanguage;
  const query = searchParams ? await searchParams : {};
  const language = resolveHomeLanguage(requestHeaders, query);
  const appLanguage = toAppLanguage(language);

  if (!session) {
    return (
      <PublicCrmLanding
        copy={getCrmLandingPageCopy(appLanguage)}
        language={language}
        legalCopy={getLoginLegalFooterCopy(appLanguage)}
        pageCopy={getPublicPageCopy(appLanguage)}
      />
    );
  }

  if(session.productRole==="external_partner")return <PartnerPortal workspaceId={session.workspaceId} workspaceName={session.workspaceName} userName={session.name} language={appLanguage}/>;
  const coreData = await getCoreCrmData(session.workspaceId, { session });

  return (
    <CrmWorkspace
      key={session.authIdentityId ?? session.userId}
      coreData={coreData}
      initialLanguage={crmLanguage.language}
      initialLanguagePreference={crmLanguage.preference}
      automaticLanguage={crmLanguage.automaticLanguage}
      languagePreferenceAvailable={crmLanguage.preferenceAvailable}
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
