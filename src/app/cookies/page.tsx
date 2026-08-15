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
  title: "Cookie Notice | Novalure CRM",
  description:
    "Cookie and tracking technology notice for Novalure CRM under Irish ePrivacy and EU data protection rules.",
};

const updated = "20 May 2026";
const pagePath = "/cookies";

type CookieNoticePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pageCopy: Record<LanguageCode, { blockTitle: string; subtitle: string; title: string }> = {
  en: {
    blockTitle: "Cookie Notice",
    subtitle:
      "Information about necessary platform cookies and optional tracking technologies under Irish ePrivacy and EU data protection rules.",
    title: "Cookie Notice",
  },
  de: {
    blockTitle: "Cookie-Hinweis",
    subtitle:
      "Informationen über notwendige Plattform-Cookies und optionale Tracking-Technologien nach irischem ePrivacy- und EU-Datenschutzrecht.",
    title: "Cookie-Hinweis",
  },
};

const englishSections = [
  {
    title: "1. What this notice covers",
    body: [
      "This Cookie Notice explains how Novalure CRM uses cookies and similar technologies on the public website, login page, CRM application, booking pages, forms and embedded funnel experiences.",
      `For questions about cookies or privacy, contact ${companyLegalDetails.businessName} at ${companyLegalDetails.email}.`,
    ],
  },
  {
    title: "2. Strictly necessary cookies",
    body: [
      "Strictly necessary cookies and similar technologies are used to make the service work, keep users signed in, protect sessions, remember essential choices and keep the platform secure. These technologies do not require consent where they are necessary to provide a service requested by the user.",
    ],
    items: [
      "novalure_session: authentication and session continuity for signed-in CRM users; expiry is currently up to 8 hours.",
      "Security and routing technologies from hosting or infrastructure providers where needed to deliver the website, prevent abuse or maintain availability.",
      "Short-lived form, booking or embed state where needed to submit a request or complete a requested workflow.",
    ],
  },
  {
    title: "3. Optional analytics and marketing technologies",
    body: [
      "Optional analytics, advertising, remarketing, conversion tracking or similar technologies are used only where legally permitted and, where required, after consent. They may include tools connected to Meta, Google, HubSpot, newsletter, campaign or CRM reporting workflows when a customer or workspace enables them.",
      "If optional technologies are enabled, the consent layer should identify the provider, purpose, retention period and withdrawal method before the technology is used.",
    ],
  },
  {
    title: "4. Managing choices",
    body: [
      "Users can withhold or withdraw consent for optional cookies through the relevant consent banner or preference tool where optional tracking is enabled. Browser settings can also block or delete cookies, but strictly necessary cookies may be required for login and requested platform functions.",
    ],
  },
  {
    title: "5. Workspace customer responsibility",
    body: [
      "Workspace customers who embed Novalure CRM forms, booking flows or funnels on their own websites are responsible for configuring their own consent banner, cookie categorisation and visitor notices for the specific tools they enable.",
    ],
  },
  {
    title: "6. Changes",
    body: [
      "This Cookie Notice may be updated when cookies, tracking technologies, providers, product features or legal requirements change.",
    ],
  },
];

const germanSections = [
  {
    title: "1. Wofür dieser Hinweis gilt",
    body: [
      "Dieser Cookie-Hinweis erklärt, wie Novalure CRM Cookies und ähnliche Technologien auf der öffentlichen Website, Login-Seite, CRM-Anwendung, Buchungsseiten, Formularen und eingebetteten Funnel-Erlebnissen verwendet.",
      `Bei Fragen zu Cookies oder Datenschutz kontaktieren Sie ${companyLegalDetails.businessName} unter ${companyLegalDetails.email}.`,
    ],
  },
  {
    title: "2. Unbedingt erforderliche Cookies",
    body: [
      "Unbedingt erforderliche Cookies und ähnliche Technologien werden genutzt, damit der Dienst funktioniert, Nutzer angemeldet bleiben, Sessions geschützt werden, notwendige Einstellungen erhalten bleiben und die Plattform sicher betrieben werden kann. Diese Technologien benötigen keine Einwilligung, soweit sie für einen vom Nutzer angeforderten Dienst erforderlich sind.",
    ],
    items: [
      "novalure_session: Authentifizierung und Session-Fortsetzung für angemeldete CRM-Nutzer; die Laufzeit beträgt derzeit bis zu 8 Stunden.",
      "Sicherheits- und Routing-Technologien von Hosting- oder Infrastruktur-Anbietern, soweit sie für Auslieferung, Missbrauchsschutz oder Verfügbarkeit erforderlich sind.",
      "Kurzlebiger Formular-, Buchungs- oder Embed-Status, soweit er für eine Anfrage oder einen angeforderten Ablauf benötigt wird.",
    ],
  },
  {
    title: "3. Optionale Analyse- und Marketing-Technologien",
    body: [
      "Optionale Analyse-, Werbe-, Remarketing-, Conversion-Tracking- oder ähnliche Technologien werden nur eingesetzt, soweit dies rechtlich zulässig ist und, falls erforderlich, nach Einwilligung. Dazu können Tools für Meta, Google, HubSpot, Newsletter, Kampagnen oder CRM-Reporting gehören, wenn ein Kunde oder Workspace sie aktiviert.",
      "Wenn optionale Technologien aktiviert werden, sollte der Consent-Layer Anbieter, Zweck, Speicherdauer und Widerrufsmöglichkeit nennen, bevor die Technologie genutzt wird.",
    ],
  },
  {
    title: "4. Auswahl verwalten",
    body: [
      "Nutzer können eine Einwilligung für optionale Cookies über den jeweiligen Consent-Banner oder das Präferenz-Tool verweigern oder widerrufen, soweit optionales Tracking aktiviert ist. Browsereinstellungen können Cookies ebenfalls blockieren oder löschen; unbedingt erforderliche Cookies können jedoch für Login und angeforderte Plattformfunktionen notwendig sein.",
    ],
  },
  {
    title: "5. Verantwortung von Workspace-Kunden",
    body: [
      "Workspace-Kunden, die Novalure CRM Formulare, Buchungsabläufe oder Funnels auf eigenen Websites einbetten, sind für ihren eigenen Consent-Banner, die Cookie-Kategorisierung und Besucherhinweise für die konkret aktivierten Tools verantwortlich.",
    ],
  },
  {
    title: "6. Änderungen",
    body: [
      "Dieser Cookie-Hinweis kann aktualisiert werden, wenn sich Cookies, Tracking-Technologien, Anbieter, Produktfunktionen oder rechtliche Anforderungen ändern.",
    ],
  },
];

export default async function CookieNoticePage({ searchParams }: CookieNoticePageProps) {
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
