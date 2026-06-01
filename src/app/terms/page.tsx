import type { Metadata } from "next";
import { headers } from "next/headers";
import { LanguageBlock, LegalPage, LegalSections } from "@/components/legal-page";
import type { LanguageCode } from "@/lib/i18n";
import { resolvePublicLanguage } from "@/lib/public-language";

export const metadata: Metadata = {
  title: "Terms of Service | Novalure CRM",
  description: "Terms of Service for Novalure CRM.",
};

const updated = "20 May 2026";
const pagePath = "/terms";

type TermsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pageCopy: Record<LanguageCode, { blockTitle: string; subtitle: string; title: string }> = {
  en: {
    blockTitle: "Terms of Service",
    subtitle:
      "Business terms for Novalure CRM, including CRM workspaces, customer-owned integrations and AI-assisted communication workflows.",
    title: "Terms of Service",
  },
  de: {
    blockTitle: "Nutzungsbedingungen",
    subtitle:
      "Geschäftliche Bedingungen für Novalure CRM, einschließlich CRM-Workspaces, kundeneigener Integrationen und KI-gestützter Kommunikationsabläufe.",
    title: "Nutzungsbedingungen",
  },
};

const englishSections = [
  {
    title: "1. About Novalure CRM",
    body: [
      "These Terms of Service govern access to and use of Novalure CRM, a web-based real estate CRM, funnel, communication and AI support platform operated by Novalure CLG, Ireland.",
      "Novalure CRM helps business customers manage workspaces, users, projects, contacts, leads, deals, tasks, communication channels, meeting workflows, newsletters, analytics and approved AI bot workflows.",
    ],
  },
  {
    title: "2. Business use",
    body: [
      "Novalure CRM is provided for business and professional use. It is not intended for private consumer use or for use by children. Users must have authority to act for the organisation or workspace they access.",
    ],
  },
  {
    title: "3. Customer responsibilities",
    items: [
      "Keep account credentials secure and ensure that only authorised users access a workspace.",
      "Configure roles, permissions, bots, knowledge sources, communication channels and integrations lawfully.",
      "Use only accurate, lawful and appropriately obtained customer, lead, property and communication data.",
      "Obtain and manage all required consents, notices, opt-outs and lawful bases for customer communication, marketing, AI-assisted processing and CRM use.",
      "Respect applicable real estate, consumer protection, advertising, privacy, ePrivacy, electronic communications and anti-spam rules.",
      "Review AI-generated outputs and bot configuration where the communication or decision is sensitive, regulated or high impact.",
    ],
  },
  {
    title: "4. Integrations and third-party services",
    body: [
      "Novalure CRM may connect with third-party services such as Meta, WhatsApp Business, Instagram, Facebook Messenger, Microsoft 365, Google Calendar, Vercel, database, storage, email delivery and AI providers. These services are governed by their own terms and policies.",
      "Customers are responsible for maintaining their own third-party accounts, permissions, business verification, channel approvals, message templates, rate limits and compliance with platform rules.",
    ],
  },
  {
    title: "5. AI bots and automation",
    body: [
      "AI bot features are designed as operational support tools. Customers decide which knowledge sources, channels, documents, policies, test settings, manual controls and bot behaviours are enabled.",
      "Novalure CRM may enforce safety controls such as blocked statements, approved knowledge restrictions, document rules, audit logging, test mode, manual override and kill switch functionality. These controls do not replace the customer's legal and professional responsibilities.",
    ],
  },
  {
    title: "6. Prohibited use",
    items: [
      "Do not use Novalure CRM for unlawful, deceptive, discriminatory, harassing, abusive or harmful activity.",
      "Do not upload malware, attempt unauthorised access, bypass workspace boundaries or interfere with platform security.",
      "Do not use bots to impersonate people, mislead recipients, provide unlawful advice, make prohibited claims or send messages without a lawful basis.",
      "Do not store API keys, secrets or credentials in public notes, customer-visible fields or test data.",
      "Do not use real customer data as test data unless you have a lawful basis and appropriate safeguards.",
    ],
  },
  {
    title: "7. Availability and changes",
    body: [
      "We work to provide a reliable platform, but Novalure CRM may be unavailable due to maintenance, incidents, provider outages or changes by third-party platforms. Features may be changed, improved, limited or removed where needed for security, compliance, technical or product reasons.",
    ],
  },
  {
    title: "8. Data protection",
    body: [
      "Personal data is processed as described in the Novalure CRM Privacy Policy. Where Novalure CLG acts as processor for customer CRM data, processing is carried out according to the relevant customer agreement and lawful customer instructions.",
    ],
  },
  {
    title: "9. Intellectual property",
    body: [
      "Novalure CRM, its software, design, workflows, documentation and platform content are owned by Novalure CLG or its licensors. Customers keep rights in their own uploaded content and CRM data, subject to the rights needed for Novalure CRM to provide the service.",
    ],
  },
  {
    title: "10. Governing law",
    body: [
      "These Terms are governed by the laws of Ireland, unless mandatory law provides otherwise. The courts of Ireland will have jurisdiction for disputes relating to these Terms, subject to any mandatory rights or applicable customer agreement.",
    ],
  },
  {
    title: "11. Contact",
    body: [
      "For contractual, support or legal questions, contact Novalure CLG at hello@novalure.eu.",
    ],
  },
];

const germanSections = [
  {
    title: "1. Über Novalure CRM",
    body: [
      "Diese Nutzungsbedingungen regeln den Zugriff auf und die Nutzung von Novalure CRM, einer webbasierten Immobilien-CRM-, Funnel-, Kommunikations- und KI-Unterstützungsplattform, betrieben von Novalure CLG, Irland.",
      "Novalure CRM unterstützt Geschäftskunden bei der Verwaltung von Workspaces, Nutzern, Projekten, Kontakten, Leads, Deals, Aufgaben, Kommunikationskanälen, Terminen, Newslettern, Auswertungen und freigegebenen KI-Bot-Workflows.",
    ],
  },
  {
    title: "2. Geschäftliche Nutzung",
    body: [
      "Novalure CRM ist für geschäftliche und professionelle Nutzung bestimmt. Die Plattform richtet sich nicht an private Verbraucher oder Kinder. Nutzer müssen berechtigt sein, für die Organisation oder den Workspace zu handeln, auf den sie zugreifen.",
    ],
  },
  {
    title: "3. Verantwortlichkeiten der Kunden",
    items: [
      "Zugangsdaten sicher verwahren und nur autorisierten Nutzern Zugriff auf einen Workspace geben.",
      "Rollen, Berechtigungen, Bots, Wissensquellen, Kommunikationskanäle und Integrationen rechtmäßig konfigurieren.",
      "Nur richtige, rechtmäßige und ordnungsgemäß erhobene Kunden-, Lead-, Immobilien- und Kommunikationsdaten verwenden.",
      "Erforderliche Einwilligungen, Hinweise, Opt-outs und Rechtsgrundlagen für Kundenkommunikation, Marketing, KI-gestützte Verarbeitung und CRM-Nutzung einholen und verwalten.",
      "Anwendbare Regeln zu Immobilien, Verbraucherschutz, Werbung, Datenschutz, ePrivacy, elektronischer Kommunikation und Anti-Spam beachten.",
      "KI-generierte Ausgaben und Bot-Konfigurationen prüfen, wenn Kommunikation oder Entscheidungen sensibel, reguliert oder wesentlich sind.",
    ],
  },
  {
    title: "4. Integrationen und Drittanbieter",
    body: [
      "Novalure CRM kann mit Drittanbietern wie Meta, WhatsApp Business, Instagram, Facebook Messenger, Microsoft 365, Google Calendar, Vercel, Datenbank-, Speicher-, E-Mail-Versand- und KI-Anbietern verbunden werden. Diese Dienste unterliegen eigenen Bedingungen und Richtlinien.",
      "Kunden sind für ihre eigenen Drittanbieter-Konten, Berechtigungen, Unternehmensverifizierung, Kanal-Freigaben, Nachrichtenvorlagen, Limits und die Einhaltung der Plattformregeln verantwortlich.",
    ],
  },
  {
    title: "5. KI-Bots und Automatisierung",
    body: [
      "KI-Bot-Funktionen sind als operative Unterstützung gedacht. Kunden entscheiden, welche Wissensquellen, Kanäle, Dokumente, Regeln, Testeinstellungen, manuellen Kontrollen und Bot-Verhalten aktiviert werden.",
      "Novalure CRM kann Sicherheitskontrollen wie blockierte Aussagen, Beschränkung auf freigegebenes Wissen, Dokumentregeln, Audit-Logging, Testmodus, manuelle Kontrolle und Not-Aus-Funktionen durchsetzen. Diese Kontrollen ersetzen nicht die rechtlichen und professionellen Pflichten des Kunden.",
    ],
  },
  {
    title: "6. Verbotene Nutzung",
    items: [
      "Novalure CRM darf nicht für rechtswidrige, täuschende, diskriminierende, belästigende, missbräuchliche oder schädliche Aktivitäten genutzt werden.",
      "Keine Malware hochladen, keinen unbefugten Zugriff versuchen, keine Workspace-Grenzen umgehen und die Plattformsicherheit nicht stören.",
      "Bots nicht zur Identitätstäuschung, Irreführung, unzulässigen Beratung, verbotenen Aussagen oder Kommunikation ohne Rechtsgrundlage einsetzen.",
      "API-Keys, Secrets oder Zugangsdaten nicht in öffentlichen Notizen, kundensichtbaren Feldern oder Testdaten speichern.",
      "Keine echten Kundendaten als Testdaten verwenden, sofern keine Rechtsgrundlage und geeignete Schutzmaßnahmen bestehen.",
    ],
  },
  {
    title: "7. Verfügbarkeit und Änderungen",
    body: [
      "Wir arbeiten an einer zuverlässigen Plattform, Novalure CRM kann jedoch wegen Wartung, Störungen, Ausfällen von Anbietern oder Änderungen durch Drittplattformen nicht verfügbar sein. Funktionen können aus Sicherheits-, Compliance-, technischen oder Produktgründen geändert, verbessert, begrenzt oder entfernt werden.",
    ],
  },
  {
    title: "8. Datenschutz",
    body: [
      "Personenbezogene Daten werden wie in der Datenschutzerklärung von Novalure CRM beschrieben verarbeitet. Soweit Novalure CLG als Auftragsverarbeiter für CRM-Kundendaten handelt, erfolgt die Verarbeitung nach dem jeweiligen Kundenvertrag und den rechtmäßigen Weisungen des Kunden.",
    ],
  },
  {
    title: "9. Geistiges Eigentum",
    body: [
      "Novalure CRM, Software, Design, Workflows, Dokumentation und Plattforminhalte gehören Novalure CLG oder Lizenzgebern. Kunden behalten ihre Rechte an eigenen hochgeladenen Inhalten und CRM-Daten, vorbehaltlich der Rechte, die Novalure CRM zur Bereitstellung des Dienstes benötigt.",
    ],
  },
  {
    title: "10. Anwendbares Recht",
    body: [
      "Diese Bedingungen unterliegen irischem Recht, soweit zwingendes Recht nichts anderes vorsieht. Für Streitigkeiten im Zusammenhang mit diesen Bedingungen sind die Gerichte Irlands zuständig, vorbehaltlich zwingender Rechte oder abweichender Kundenvereinbarungen.",
    ],
  },
  {
    title: "11. Kontakt",
    body: [
      "Für Vertrags-, Support- oder Rechtsfragen kontaktieren Sie Novalure CLG unter hello@novalure.eu.",
    ],
  },
];

export default async function TermsPage({ searchParams }: TermsPageProps) {
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
