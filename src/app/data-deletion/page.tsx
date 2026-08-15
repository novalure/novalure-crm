import type { Metadata } from "next";
import { headers } from "next/headers";
import { LanguageBlock, LegalPage, LegalSections } from "@/components/legal-page";
import type { LanguageCode } from "@/lib/i18n";
import { resolvePublicLanguage } from "@/lib/public-language";

export const metadata: Metadata = {
  title: "Data Deletion Instructions | Novalure CRM",
  description:
    "Instructions for requesting deletion of Novalure CRM and Meta-derived data.",
};

const updated = "20 May 2026";
const pagePath = "/data-deletion";

type DataDeletionPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pageCopy: Record<LanguageCode, { blockTitle: string; subtitle: string; title: string }> = {
  en: {
    blockTitle: "Data Deletion Instructions",
    subtitle:
      "How to disconnect Meta access and request deletion of Novalure CRM data, including Meta-derived identifiers, CRM records and communication data.",
    title: "Data Deletion Instructions",
  },
  de: {
    blockTitle: "Anleitung zur Datenlöschung",
    subtitle:
      "So trennen Sie Meta-Zugriff und beantragen die Löschung von Novalure CRM Daten, einschließlich Meta-bezogener Kennungen, CRM-Datensätze und Kommunikationsdaten.",
    title: "Anleitung zur Datenlöschung",
  },
};

const englishSections = [
  {
    title: "1. What this page is for",
    body: [
      "This page explains how users, workspace customers and Meta users can request deletion of personal data held by Novalure CRM, including data received through Facebook Login for Business, WhatsApp Business, Instagram or Facebook Messenger integrations.",
    ],
  },
  {
    title: "2. Remove Novalure CRM access from Meta",
    items: [
      "Open Facebook or Meta account settings.",
      "Go to Settings and privacy, then Apps and Websites or Business Integrations.",
      "Find Novalure CRM or Novalure CRM MessagingWA.",
      "Choose Remove or disconnect access.",
      "If you manage a business asset, also review connected Pages, Instagram accounts, WhatsApp Business accounts and business integrations in Meta Business Settings.",
    ],
  },
  {
    title: "3. Request deletion from Novalure CRM",
    body: [
      "Email hello@novalure.eu with the subject line Data Deletion Request. Include the email address used for your Novalure CRM account, the workspace or company name if known, and whether your request relates to a Meta account, WhatsApp number, Instagram account, Facebook Page, CRM contact record or newsletter subscription.",
      "Do not send passwords, access tokens, ID documents or sensitive customer files by email unless we specifically request them through a secure process.",
    ],
  },
  {
    title: "4. What we will delete or disconnect",
    items: [
      "Account, workspace membership or profile data where deletion is legally and technically possible.",
      "Meta-derived identifiers and integration records connected to your account or workspace.",
      "Stored access tokens or channel credentials controlled by Novalure CRM.",
      "CRM contact, lead, conversation, bot message and timeline records where Novalure CLG is the controller or where the relevant workspace customer instructs deletion.",
      "Newsletter subscription data, except opt-out suppression records needed to respect future opt-outs.",
    ],
  },
  {
    title: "5. When a workspace customer controls the data",
    body: [
      "If your personal data is stored in a workspace controlled by a Novalure CRM customer, that customer may be the data controller. In that case, we may forward your request to the customer, ask you to contact them directly, or process the request according to that customer's lawful instructions.",
    ],
  },
  {
    title: "6. Timing and exceptions",
    body: [
      "We aim to respond to deletion requests without undue delay and generally within one month, subject to identity checks, legal exceptions, technical backup cycles and the need to coordinate with the relevant workspace customer.",
      "Some records may need to be retained where required for legal obligations, security, fraud prevention, dispute handling, audit logs, opt-out compliance or other legitimate reasons permitted by Irish and EU data protection law.",
    ],
  },
  {
    title: "7. Confirmation",
    body: [
      "Where appropriate, we will confirm completion of deletion or explain why certain data cannot be deleted immediately. Requests can be sent through the email process described above.",
    ],
  },
];

const germanSections = [
  {
    title: "1. Zweck dieser Seite",
    body: [
      "Diese Seite erklärt, wie Nutzer, Workspace-Kunden und Meta-Nutzer die Löschung personenbezogener Daten bei Novalure CRM beantragen können, einschließlich Daten aus Facebook Login for Business, WhatsApp Business, Instagram oder Facebook Messenger Integrationen.",
    ],
  },
  {
    title: "2. Zugriff von Novalure CRM bei Meta entfernen",
    items: [
      "Facebook- oder Meta-Kontoeinstellungen öffnen.",
      "Zu Einstellungen und Privatsphäre, danach Apps und Websites oder Business-Integrationen gehen.",
      "Novalure CRM oder Novalure CRM MessagingWA suchen.",
      "Entfernen oder Zugriff trennen auswählen.",
      "Wenn Sie ein Business-Asset verwalten, prüfen Sie zusätzlich verbundene Seiten, Instagram-Konten, WhatsApp-Business-Konten und Business-Integrationen in den Meta Business Settings.",
    ],
  },
  {
    title: "3. Löschung bei Novalure CRM beantragen",
    body: [
      "Senden Sie eine E-Mail an hello@novalure.eu mit dem Betreff Datenlöschungsanfrage. Geben Sie die E-Mail-Adresse Ihres Novalure CRM Kontos, den Workspace- oder Unternehmensnamen falls bekannt und den Bezug der Anfrage an, zum Beispiel Meta-Konto, WhatsApp-Nummer, Instagram-Konto, Facebook-Seite, CRM-Kontaktdatensatz oder Newsletter-Abonnement.",
      "Senden Sie keine Passwörter, Zugriffstoken, Ausweisdokumente oder sensiblen Kundendateien per E-Mail, außer wir fordern dies ausdrücklich über einen sicheren Prozess an.",
    ],
  },
  {
    title: "4. Was wir löschen oder trennen",
    items: [
      "Konto-, Workspace-Mitgliedschafts- oder Profildaten, soweit eine Löschung rechtlich und technisch möglich ist.",
      "Meta-bezogene Kennungen und Integrationsdatensätze, die mit Ihrem Konto oder Workspace verbunden sind.",
      "Gespeicherte Zugriffstoken oder Kanal-Zugangsdaten, die von Novalure CRM verwaltet werden.",
      "CRM-Kontakt-, Lead-, Konversations-, Bot-Nachrichten- und Timeline-Daten, soweit Novalure CLG Verantwortlicher ist oder der relevante Workspace-Kunde die Löschung anweist.",
      "Newsletter-Abonnementdaten, ausgenommen Opt-out-Sperrlisten, die benötigt werden, um künftige Abmeldungen zu respektieren.",
    ],
  },
  {
    title: "5. Wenn ein Workspace-Kunde die Daten kontrolliert",
    body: [
      "Wenn Ihre personenbezogenen Daten in einem Workspace gespeichert sind, der von einem Novalure CRM Kunden kontrolliert wird, kann dieser Kunde der Verantwortliche sein. In diesem Fall können wir Ihre Anfrage an den Kunden weiterleiten, Sie an den Kunden verweisen oder die Anfrage nach dessen rechtmäßigen Weisungen bearbeiten.",
    ],
  },
  {
    title: "6. Fristen und Ausnahmen",
    body: [
      "Wir bemühen uns, Löschanfragen ohne unangemessene Verzögerung und grundsätzlich innerhalb eines Monats zu beantworten, vorbehaltlich Identitätsprüfung, gesetzlicher Ausnahmen, technischer Backup-Zyklen und der Abstimmung mit dem relevanten Workspace-Kunden.",
      "Einige Datensätze müssen gegebenenfalls aufbewahrt werden, wenn dies für rechtliche Pflichten, Sicherheit, Betrugsprävention, Streitbeilegung, Audit-Logs, Opt-out-Compliance oder andere nach irischem und EU-Datenschutzrecht zulässige Gründe erforderlich ist.",
    ],
  },
  {
    title: "7. Bestätigung",
    body: [
      "Soweit angemessen, bestätigen wir den Abschluss der Löschung oder erklären, warum bestimmte Daten nicht sofort gelöscht werden können. Anfragen können über den oben beschriebenen E-Mail-Prozess gesendet werden.",
    ],
  },
];

export default async function DataDeletionPage({ searchParams }: DataDeletionPageProps) {
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
    </LegalPage>
  );
}
