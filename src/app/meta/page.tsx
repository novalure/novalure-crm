import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  LanguageBlock,
  LegalPage,
  LegalReferences,
  LegalSections,
} from "@/components/legal-page";
import type { LanguageCode } from "@/lib/i18n";
import { companyLegalDetails, publicSiteOrigin } from "@/lib/legal";
import { resolvePublicLanguage, withPublicLanguage } from "@/lib/public-language";

export const metadata: Metadata = {
  title: "Meta Developer Disclosures | Novalure CRM",
  description:
    "Public Meta and Facebook developer disclosures for Novalure CRM integrations.",
};

const updated = "20 May 2026";
const pagePath = "/meta";

type MetaDisclosuresPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pageCopy: Record<LanguageCode, { blockTitle: string; subtitle: string; title: string }> = {
  en: {
    blockTitle: "Meta Developer Disclosures",
    subtitle:
      "Public information for Meta App Dashboard review, Facebook Login for Business, Instagram, Messenger and WhatsApp Business integrations.",
    title: "Meta Developer Disclosures",
  },
  de: {
    blockTitle: "Meta-Developer-Hinweise",
    subtitle:
      "Öffentliche Informationen für Meta App Dashboard Review, Facebook Login for Business, Instagram, Messenger und WhatsApp Business Integrationen.",
    title: "Meta-Developer-Hinweise",
  },
};

function publicUrl(path: string, language: LanguageCode) {
  return new URL(withPublicLanguage(path, language), publicSiteOrigin).toString();
}

function getEnglishSections(language: LanguageCode) {
  return [
    {
      title: "1. Public URLs for Meta App Dashboard",
      items: [
        `Privacy Policy URL: ${publicUrl("/privacy", language)}`,
        `User Data Deletion Instructions URL: ${publicUrl("/data-deletion", language)}`,
        `Terms of Service URL: ${publicUrl("/terms", language)}`,
        `Service provider and legal contact: ${publicUrl("/imprint", language)}`,
      ],
    },
    {
      title: "2. What Meta-related data may be processed",
      items: [
        "Facebook Login for Business identifiers, app-scoped IDs and account metadata when a user or workspace connects Meta access.",
        "Facebook Page IDs, Instagram business account IDs, WhatsApp Business account IDs, phone number IDs, channel permissions and webhook metadata.",
        "Messages, timestamps, delivery states, conversation context and CRM records created from customer-authorised Meta channels.",
        "Access tokens or channel credentials where needed to operate a customer-authorised integration. Stored credentials are intended to be protected and encrypted where stored by Novalure CRM.",
      ],
    },
    {
      title: "3. Data deletion and removal",
      body: [
        "Users can remove Novalure CRM access in their Facebook or Meta account settings. They can also request deletion through the public data deletion instructions page.",
        "If a workspace customer controls the underlying CRM record, Novalure CRM may need to coordinate deletion with that workspace customer as the relevant controller.",
      ],
    },
    {
      title: "4. Developer contact",
      body: [
        `Meta-related privacy, platform, data deletion and developer review requests can be sent to ${companyLegalDetails.email}.`,
      ],
    },
  ];
}

function getGermanSections(language: LanguageCode) {
  return [
    {
      title: "1. Öffentliche URLs für das Meta App Dashboard",
      items: [
        `Privacy Policy URL: ${publicUrl("/privacy", language)}`,
        `User Data Deletion Instructions URL: ${publicUrl("/data-deletion", language)}`,
        `Terms of Service URL: ${publicUrl("/terms", language)}`,
        `Anbieter- und Rechtskontakt: ${publicUrl("/imprint", language)}`,
      ],
    },
    {
      title: "2. Welche Meta-bezogenen Daten verarbeitet werden können",
      items: [
        "Facebook Login for Business Kennungen, app-spezifische IDs und Konto-Metadaten, wenn ein Nutzer oder Workspace Meta-Zugriff verbindet.",
        "Facebook-Seiten-IDs, Instagram-Business-Konto-IDs, WhatsApp-Business-Konto-IDs, Telefonnummern-IDs, Kanalberechtigungen und Webhook-Metadaten.",
        "Nachrichten, Zeitstempel, Zustellstatus, Gesprächskontext und CRM-Datensätze aus kundenseitig autorisierten Meta-Kanälen.",
        "Zugriffstoken oder Kanal-Zugangsdaten, soweit sie für den Betrieb einer kundenseitig autorisierten Integration erforderlich sind. Gespeicherte Zugangsdaten sollen geschützt und, soweit sie in Novalure CRM gespeichert werden, verschlüsselt gespeichert werden.",
      ],
    },
    {
      title: "3. Datenlöschung und Trennung",
      body: [
        "Nutzer können den Zugriff von Novalure CRM in ihren Facebook- oder Meta-Kontoeinstellungen entfernen. Sie können außerdem eine Löschung über die öffentliche Anleitung zur Datenlöschung beantragen.",
        "Wenn ein Workspace-Kunde den zugrunde liegenden CRM-Datensatz kontrolliert, muss Novalure CRM die Löschung gegebenenfalls mit diesem Workspace-Kunden als zuständigem Verantwortlichen abstimmen.",
      ],
    },
    {
      title: "4. Developer-Kontakt",
      body: [
        `Meta-bezogene Datenschutz-, Plattform-, Datenlöschungs- und Developer-Review-Anfragen können an ${companyLegalDetails.email} gesendet werden.`,
      ],
    },
  ];
}

export default async function MetaDisclosuresPage({ searchParams }: MetaDisclosuresPageProps) {
  const requestHeaders = await headers();
  const query = searchParams ? await searchParams : {};
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: requestHeaders.get("x-vercel-ip-country"),
    requestedLanguage: query.lang,
  });
  const page = pageCopy[language];

  return (
    <LegalPage
      language={language}
      path={pagePath}
      title={page.title}
      subtitle={page.subtitle}
      updated={updated}
    >
      <LanguageBlock eyebrow={language === "de" ? "Deutsch" : "English"} title={page.blockTitle}>
        <LegalSections sections={language === "de" ? getGermanSections(language) : getEnglishSections(language)} />
      </LanguageBlock>
      <LegalReferences language={language} />
    </LegalPage>
  );
}
