import { headers } from "next/headers";
import type { Metadata } from "next";
import { PublicCrmLanding } from "@/components/public-crm-landing";
import { CrmWorkspace } from "@/components/crm-workspace";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getCoreCrmData } from "@/lib/db/crm-loaders";
import { ensureWorkspaceProjectDefaultPipelines } from "@/lib/db/pipeline-default-repositories";
import {
  getCrmLandingPageCopy,
  getLoginLegalFooterCopy,
  getPublicPageCopy,
  languageRequestHeaderName,
} from "@/lib/i18n";
import { publicSiteOrigin } from "@/lib/legal";
import { getRequestCountry, resolveAuditHref } from "@/lib/public-audit";
import { resolvePublicLanguage } from "@/lib/public-language";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

const homeMetadata = {
  en: {
    title: "Novalure CRM | Private Lead Workspace for Real Estate Teams",
    description:
      "Novalure CRM brings real estate enquiries, ownership and next actions into a protected workspace for property developers, brokerage teams and project sales teams.",
    openGraphTitle: "Every real estate enquiry gets a next action.",
    openGraphDescription:
      "Private lead workspace for property developers, brokerage teams and project sales teams.",
  },
  de: {
    title: "Novalure CRM | Privater Lead-Workspace für Immobilien-Teams",
    description:
      "Novalure CRM bündelt Immobilienanfragen, Zuständigkeiten und nächste Aktionen in einem geschützten Workspace für Maklerteams, Bauträger und Projektvertriebe.",
    openGraphTitle: "Jede Immobilienanfrage bekommt den nächsten Schritt.",
    openGraphDescription:
      "Privater Lead-Workspace für Maklerteams, Bauträger und Projektvertriebe.",
  },
} as const;

function resolveHomeLanguage(
  requestHeaders: Headers,
  query: Record<string, string | string[] | undefined>,
) {
  const country = getRequestCountry(requestHeaders);
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country,
    persistedLanguage: requestHeaders.get(languageRequestHeaderName),
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
      },
    },
    openGraph: {
      title: copy.openGraphTitle,
      description: copy.openGraphDescription,
      locale: language === "de" ? "de_AT" : "en_GB",
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
  const { country, language } = resolveHomeLanguage(requestHeaders, query);

  if (!session) {
    return (
      <PublicCrmLanding
        auditHref={resolveAuditHref(country, language)}
        basePath="/"
        copy={getCrmLandingPageCopy(language)}
        language={language}
        legalCopy={getLoginLegalFooterCopy(language)}
        pageCopy={getPublicPageCopy(language)}
      />
    );
  }

  try {
    await ensureWorkspaceProjectDefaultPipelines({ session });
  } catch {
    // The workspace can render with module-level fallbacks if pipeline bootstrap is temporarily unavailable.
  }
  const coreData = await getCoreCrmData(session.workspaceId, { session });

  return (
    <CrmWorkspace
      coreData={coreData}
      initialLanguage={language}
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
