import { headers } from "next/headers";
import type { Metadata } from "next";
import { PublicCrmLanding } from "@/components/public-crm-landing";
import { CrmWorkspace } from "@/components/crm-workspace";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getCoreCrmData } from "@/lib/db/crm-loaders";
import { ensureWorkspaceProjectDefaultPipelines } from "@/lib/db/pipeline-default-repositories";
import { getCrmLandingPageCopy, getLoginLegalFooterCopy, getPublicPageCopy } from "@/lib/i18n";
import { getRequestCountry, resolveAuditHref } from "@/lib/public-audit";
import { resolvePublicLanguage } from "@/lib/public-language";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Novalure CRM | Real Estate Lead Operations",
  description:
    "The protected CRM workspace behind Novalure's real estate lead system, with private Pipeline Audit request and secondary team login.",
};

export default async function Home({ searchParams }: HomeProps) {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);

  if (!session) {
    const query = searchParams ? await searchParams : {};
    const country = getRequestCountry(requestHeaders);
    const language = resolvePublicLanguage({
      acceptLanguage: requestHeaders.get("accept-language"),
      country,
      requestedLanguage: query.lang,
    });

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
  const coreData = await getCoreCrmData(session.workspaceId);

  return (
    <CrmWorkspace
      coreData={coreData}
      sessionProductRole={session.productRole}
      sessionRole={session.role}
      sessionWorkspace={{
        activeCalendarProvider: session.workspaceActiveCalendarProvider ?? undefined,
        customerType: session.workspaceCustomerType ?? undefined,
        id: session.workspaceId,
        name: session.workspaceName,
        operatingModel: session.workspaceOperatingModel ?? undefined,
        setupState: session.workspaceSetupState ?? undefined,
        teamStructure: session.workspaceTeamStructure ?? undefined,
      }}
    />
  );
}
