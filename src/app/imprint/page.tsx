import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  LanguageBlock,
  LegalPage,
  LegalReferences,
  LegalSections,
} from "@/components/legal-page";
import type { LanguageCode } from "@/lib/i18n";
import { companyLegalDetails } from "@/lib/legal";
import { resolvePublicLanguage } from "@/lib/public-language";

export const metadata: Metadata = {
  title: "Legal Imprint | Novalure CRM",
  description:
    "Company and contact information for Novalure CLG, an Irish company limited by guarantee.",
};

const updated = "December 2025";
const pagePath = "/imprint";

type ImprintPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pageCopy: Record<LanguageCode, { blockTitle: string; subtitle: string; title: string }> = {
  en: {
    blockTitle: "Legal Imprint",
    subtitle:
      "Company and contact information for Novalure CLG, an Irish company limited by guarantee.",
    title: "Legal Imprint",
  },
  de: {
    blockTitle: "Impressum",
    subtitle:
      "Unternehmens- und Kontaktinformationen für Novalure CLG, eine irische company limited by guarantee.",
    title: "Impressum",
  },
};

const englishSections = [
  {
    title: "1. Company information",
    body: [
      "This imprint is based on the company information provided in Novalure CLG's General Terms and Conditions.",
    ],
    items: [
      companyLegalDetails.companyName,
      companyLegalDetails.legalForm,
      `Registered with: ${companyLegalDetails.registeredWith}`,
      `Registration number: ${companyLegalDetails.companyNumber}`,
      `Registered office: ${companyLegalDetails.registeredOffice}`,
      `E-mail: ${companyLegalDetails.email}`,
    ],
  },
  {
    title: "2. Business activity",
    body: [
      "Novalure CLG operates as an independent international advisory and consulting firm specialising in real estate-related structuring, project advisory and investor sourcing services.",
    ],
  },
  {
    title: "3. Regulatory position",
    body: [
      "Novalure provides non-regulated advisory and consulting services. Novalure does not act as a regulated real estate broker, financial intermediary, investment firm, credit institution, payment service provider, trustee or escrow agent.",
    ],
  },
  {
    title: "4. No handling of client or investor funds",
    body: [
      "Novalure never holds, receives, manages or administers client funds, investor funds or third-party assets. All payments between clients and third parties are conducted directly between those parties.",
    ],
  },
  {
    title: "5. Legal review notice",
    body: [
      "This imprint should be reviewed by qualified legal counsel before publication. Company registration number, VAT number and any additional mandatory disclosure details should be added if legally required.",
    ],
  },
];

const germanSections = [
  {
    title: "1. Unternehmensangaben",
    body: [
      "Dieses Impressum basiert auf den Unternehmensangaben aus den Allgemeinen Geschäftsbedingungen von Novalure CLG.",
    ],
    items: [
      companyLegalDetails.companyName,
      "Company limited by guarantee nach irischem Recht",
      `Eingetragen bei: ${companyLegalDetails.registeredWith}`,
      `Registrierungsnummer: ${companyLegalDetails.companyNumber}`,
      `Eingetragener Sitz: ${companyLegalDetails.registeredOffice}`,
      `E-Mail: ${companyLegalDetails.email}`,
    ],
  },
  {
    title: "2. Geschäftstätigkeit",
    body: [
      "Novalure CLG ist eine unabhängige internationale Beratungs- und Consulting-Firma mit Schwerpunkt auf immobilienbezogener Strukturierung, Projektberatung und Investorensourcing.",
    ],
  },
  {
    title: "3. Regulatorische Einordnung",
    body: [
      "Novalure erbringt nicht regulierte Beratungs- und Consulting-Leistungen. Novalure handelt nicht als regulierter Immobilienmakler, Finanzintermediär, Wertpapierfirma, Kreditinstitut, Zahlungsdienstleister, Treuhänder oder Escrow-Agent.",
    ],
  },
  {
    title: "4. Kein Umgang mit Kunden- oder Investorengeldern",
    body: [
      "Novalure hält, empfängt, verwaltet oder administriert keine Kundengelder, Investorengelder oder Vermögenswerte Dritter. Alle Zahlungen zwischen Kunden und Dritten erfolgen direkt zwischen diesen Parteien.",
    ],
  },
  {
    title: "5. Rechtlicher Prüfhinweis",
    body: [
      "Dieses Impressum sollte vor der Veröffentlichung durch qualifizierte Rechtsberatung geprüft werden. Registrierungsnummer, Umsatzsteuer-Identifikationsnummer und weitere verpflichtende Angaben sollten ergänzt werden, sofern dies rechtlich erforderlich ist.",
    ],
  },
];

export default async function ImprintPage({ searchParams }: ImprintPageProps) {
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
        <LegalSections sections={language === "de" ? germanSections : englishSections} />
      </LanguageBlock>
      <LegalReferences language={language} />
    </LegalPage>
  );
}
