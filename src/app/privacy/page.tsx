import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  LanguageBlock,
  LegalPage,
  LegalReferences,
  LegalSections,
} from "@/components/legal-page";
import type { LanguageCode } from "@/lib/i18n";
import { resolvePublicLanguage } from "@/lib/public-language";

export const metadata: Metadata = {
  title: "Privacy Policy | Novalure CRM",
  description:
    "Privacy Policy for Novalure CRM under Irish and EU data protection law.",
};

const updated = "20 May 2026";
const pagePath = "/privacy";

type PrivacyPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pageCopy: Record<LanguageCode, { blockTitle: string; subtitle: string; title: string }> = {
  en: {
    blockTitle: "Privacy Policy",
    subtitle:
      "Privacy information for Novalure CRM under Irish and EU data protection law, including GDPR, Meta channel integrations and AI-supported CRM communication.",
    title: "Privacy Policy",
  },
  de: {
    blockTitle: "Datenschutzerklärung",
    subtitle:
      "Datenschutzinformationen für Novalure CRM nach irischem und EU-Datenschutzrecht, einschließlich DSGVO, Meta-Kanalintegrationen und KI-gestützter CRM-Kommunikation.",
    title: "Datenschutzerklärung",
  },
};

const englishSections = [
  {
    title: "1. Who we are",
    body: [
      "Novalure CRM is operated by Novalure CLG, Ireland. This Privacy Policy explains how Novalure CLG processes personal data in connection with the Novalure CRM website, application, customer relationship management platform, AI communication tools and integrations with Meta technologies such as WhatsApp Business, Instagram and Facebook Messenger.",
      "For privacy questions, data subject requests or deletion requests, contact us at hello@novalure.eu with the subject line Privacy Request. If a dedicated Data Protection Officer is appointed later, their contact details will be added to this notice.",
    ],
  },
  {
    title: "2. Applicable law",
    body: [
      "Novalure CLG is established in Ireland and processes personal data in accordance with the EU General Data Protection Regulation (GDPR), the Irish Data Protection Act 2018 and, where relevant, Irish and EU rules on electronic communications and marketing.",
      "The Irish Data Protection Commission is the lead supervisory authority for Irish data protection matters. Individuals may also contact the supervisory authority in their EU Member State of residence.",
    ],
  },
  {
    title: "3. Controller and processor roles",
    body: [
      "For our own website, account administration, security, billing, product improvement, support, marketing and platform operation, Novalure CLG acts as a data controller.",
      "For CRM records, lead data, customer communications, contact histories, uploaded knowledge documents and messages that our business customers enter into or connect to Novalure CRM, Novalure CLG generally acts as a processor on behalf of the relevant workspace customer. The workspace customer remains responsible for deciding why and how their own customer and lead data is processed.",
      "If you are a lead, buyer, seller, tenant, landlord or other contact of one of our workspace customers, you may also need to contact that workspace customer directly because they may be the primary controller for your CRM record.",
    ],
  },
  {
    title: "4. Personal data we process",
    items: [
      "Account and workspace data: name, email address, role, organisation, workspace membership, authentication and permission data.",
      "CRM and real estate data: contact details, lead interests, project assignments, property preferences, deal stages, tasks, notes, communication history and appointment information.",
      "Messaging data: WhatsApp, Instagram, Facebook Messenger, email and form messages, message metadata, channel identifiers, timestamps, delivery status and conversation context.",
      "Meta integration data: app-scoped IDs, Page IDs, Instagram business account IDs, WhatsApp business account IDs, phone number IDs, access tokens and permissions needed to connect customer-owned Meta assets. Access tokens are stored encrypted where stored by Novalure CRM.",
      "Calendar and meeting data: availability settings, booking details, meeting links, reminders and connected Microsoft 365 or Google calendar information where enabled.",
      "Newsletter and consent data: subscription status, opt-in and opt-out records, segments, campaign delivery information and consent evidence.",
      "Technical and security data: IP address, browser and device data, logs, audit trails, webhook events, security events and diagnostic information.",
      "AI and bot data: bot instructions, approved knowledge sources, knowledge chunks, conversation summaries, policy decisions, audit logs and generated draft or final responses.",
    ],
  },
  {
    title: "5. Purposes of processing",
    items: [
      "To provide, secure and maintain the Novalure CRM platform.",
      "To enable customers to manage workspaces, roles, projects, contacts, deals, tasks, funnels, communication and analytics.",
      "To connect customer-approved WhatsApp Business, Instagram, Facebook Messenger, Microsoft 365, calendar, email and newsletter integrations.",
      "To receive, route and respond to customer communications through configured bots and communication channels.",
      "To store and update leads, contacts, deals, tasks, appointments and audit logs.",
      "To enforce bot policy rules, knowledge restrictions, manual override, test mode, opt-out rules, document sending rules and safety controls.",
      "To provide support, troubleshoot problems, prevent abuse, improve reliability and comply with legal obligations.",
      "To send service messages and, where permitted, marketing or newsletter messages.",
    ],
  },
  {
    title: "6. Legal bases",
    items: [
      "Contract: processing necessary to provide Novalure CRM and related services to customers and users.",
      "Legitimate interests: platform security, fraud prevention, product reliability, internal analytics, support, audit logging and business-to-business communication, balanced against individual rights.",
      "Consent: optional marketing, newsletter subscriptions, certain cookies, optional integrations and other processing where consent is required.",
      "Legal obligation: accounting, tax, regulatory, dispute, compliance and data protection obligations.",
      "Customer instructions: where Novalure CLG acts as processor, processing is carried out under the relevant customer agreement and lawful instructions.",
    ],
  },
  {
    title: "7. AI bots, automation and approved knowledge",
    body: [
      "Novalure CRM may use AI-supported bots to classify enquiries, prepare replies, answer routine questions, update CRM records, prepare appointment workflows, suggest next actions and create audit records. Bots are designed to use approved workspace knowledge and configured tools rather than unrestricted internet search.",
      "Bot actions are subject to policy controls such as blocked statements, document approval rules, knowledge restrictions, test mode, kill switch, manual override and audit logging. Customers remain responsible for configuring their bots lawfully and for monitoring automated customer communication.",
      "Novalure CRM does not intend to make solely automated decisions that produce legal effects or similarly significant effects for individuals. AI output should be treated as operational support unless a customer separately configures and lawfully validates a specific automated decision process.",
    ],
  },
  {
    title: "8. Sharing and recipients",
    body: [
      "We share personal data only where necessary for the purposes described in this Policy, with customer-authorised recipients, service providers, professional advisers, authorities where legally required and integration providers selected by the customer.",
    ],
    items: [
      "Hosting, database, storage, security and deployment providers.",
      "Communication providers such as Meta/WhatsApp/Instagram/Facebook, email providers and calendar providers when integrations are enabled.",
      "AI, embedding or language model providers used to generate responses, summaries, classifications or knowledge search results.",
      "Payment, support, analytics, monitoring, legal, accounting and compliance providers where applicable.",
    ],
  },
  {
    title: "9. International transfers",
    body: [
      "Some providers may process personal data outside Ireland or the European Economic Area. Where this happens, we rely on an adequacy decision, Standard Contractual Clauses, supplementary safeguards or another transfer mechanism permitted by GDPR.",
    ],
  },
  {
    title: "10. Retention",
    body: [
      "We keep personal data only for as long as needed for the purposes described in this Policy, for the duration of the customer relationship, as instructed by the workspace customer, or as required by law.",
      "CRM data is generally retained while the relevant workspace account remains active or until the customer deletes or exports it. Security and audit logs may be retained for a reasonable period to protect the platform and prove compliance. Backups may remain for a limited technical retention period before deletion or overwrite.",
      "Marketing consent records and opt-out records may be retained to respect preferences and demonstrate compliance.",
    ],
  },
  {
    title: "11. Your rights",
    body: [
      "Subject to legal conditions and exceptions, individuals may have the right to be informed, access their data, correct inaccurate data, request erasure, restrict processing, object to processing, receive data portability, withdraw consent and complain to a supervisory authority.",
      "Requests can be sent to hello@novalure.eu. If your data was processed by one of our workspace customers, we may forward or refer your request to that customer as the relevant controller.",
    ],
  },
  {
    title: "12. Security",
    body: [
      "We use technical and organisational measures designed to protect personal data, including role-based access, workspace boundaries, encryption where appropriate, audit logs, webhook validation, access token protection and operational monitoring. No system is completely secure, but we work to reduce risk and respond to incidents appropriately.",
    ],
  },
  {
    title: "13. Cookies and similar technologies",
    body: [
      "Novalure CRM may use necessary cookies or similar technologies for login, security, session management and platform operation. Optional analytics or marketing cookies will be used only where legally permitted and, where required, with consent.",
    ],
  },
  {
    title: "14. Children",
    body: [
      "Novalure CRM is a business platform and is not intended for children. Customers should not intentionally submit personal data of children unless they have a lawful basis and appropriate safeguards.",
    ],
  },
  {
    title: "15. Changes to this Policy",
    body: [
      "We may update this Privacy Policy to reflect legal, operational or product changes. The latest version will be published on this page with an updated date.",
    ],
  },
];

const germanSections = [
  {
    title: "1. Wer wir sind",
    body: [
      "Novalure CRM wird von Novalure CLG, Irland, betrieben. Diese Datenschutzerklärung beschreibt, wie Novalure CLG personenbezogene Daten im Zusammenhang mit der Novalure CRM Website, der Anwendung, der CRM-Plattform, KI-Kommunikationsfunktionen und Integrationen mit Meta-Technologien wie WhatsApp Business, Instagram und Facebook Messenger verarbeitet.",
      "Für Datenschutzfragen, Betroffenenanfragen oder Löschanfragen kontaktieren Sie uns bitte unter hello@novalure.eu mit dem Betreff Datenschutzanfrage. Falls später ein Datenschutzbeauftragter benannt wird, werden dessen Kontaktdaten in diese Erklärung aufgenommen.",
    ],
  },
  {
    title: "2. Anwendbares Recht",
    body: [
      "Novalure CLG ist in Irland ansässig und verarbeitet personenbezogene Daten nach der Datenschutz-Grundverordnung der EU (DSGVO), dem irischen Data Protection Act 2018 sowie, soweit einschlägig, nach irischen und europaeischen Regeln zu elektronischer Kommunikation und Marketing.",
      "Die irische Data Protection Commission ist die zuständige Aufsichtsbehörde für irische Datenschutzfragen. Betroffene Personen können sich auch an die Aufsichtsbehörde ihres EU-Mitgliedstaats wenden.",
    ],
  },
  {
    title: "3. Rollen als Verantwortlicher und Auftragsverarbeiter",
    body: [
      "Für unsere eigene Website, Kontoverwaltung, Sicherheit, Abrechnung, Produktverbesserung, Support, Marketing und den Plattformbetrieb handelt Novalure CLG als Verantwortlicher.",
      "Für CRM-Datensätze, Lead-Daten, Kundenkommunikation, Kontakthistorien, hochgeladene Wissensdokumente und Nachrichten, die unsere Geschäftskunden in Novalure CRM eintragen oder anbinden, handelt Novalure CLG in der Regel als Auftragsverarbeiter im Auftrag des jeweiligen Workspace-Kunden. Der Workspace-Kunde bleibt dafür verantwortlich, warum und wie seine Kunden- und Lead-Daten verarbeitet werden.",
      "Wenn Sie Lead, Käufer, Verkäufer, Mieter, Vermieter oder sonstiger Kontakt eines unserer Workspace-Kunden sind, müssen Sie sich gegebenenfalls direkt an diesen Kunden wenden, da dieser der primäre Verantwortliche für Ihren CRM-Datensatz sein kann.",
    ],
  },
  {
    title: "4. Welche personenbezogenen Daten wir verarbeiten",
    items: [
      "Konto- und Workspace-Daten: Name, E-Mail-Adresse, Rolle, Organisation, Workspace-Mitgliedschaft, Authentifizierungs- und Berechtigungsdaten.",
      "CRM- und Immobiliendaten: Kontaktdaten, Lead-Interessen, Projektzuordnungen, Immobilienpräferenzen, Deal-Stufen, Aufgaben, Notizen, Kommunikationshistorie und Termininformationen.",
      "Nachrichtendaten: WhatsApp-, Instagram-, Facebook-Messenger-, E-Mail- und Formularnachrichten, Nachrichten-Metadaten, Kanal-IDs, Zeitstempel, Zustellstatus und Gesprächskontext.",
      "Meta-Integrationsdaten: app-spezifische IDs, Seiten-IDs, Instagram-Business-Konto-IDs, WhatsApp-Business-Konto-IDs, Telefonnummern-IDs, Zugriffstoken und Berechtigungen, die für die Verbindung kundeneigener Meta-Assets erforderlich sind. Zugriffstoken werden, soweit sie in Novalure CRM gespeichert werden, verschlüsselt gespeichert.",
      "Kalender- und Meetingdaten: Verfügbarkeitseinstellungen, Buchungsdetails, Meeting-Links, Erinnerungen und verbundene Microsoft-365- oder Google-Kalenderdaten, soweit aktiviert.",
      "Newsletter- und Einwilligungsdaten: Abonnementstatus, Opt-in- und Opt-out-Nachweise, Segmente, Kampagnenzustellung und Einwilligungsnachweise.",
      "Technische und Sicherheitsdaten: IP-Adresse, Browser- und Gerätedaten, Protokolle, Audit-Trails, Webhook-Ereignisse, Sicherheitsereignisse und Diagnoseinformationen.",
      "KI- und Bot-Daten: Bot-Anweisungen, freigegebene Wissensquellen, Wissensausschnitte, Konversationszusammenfassungen, Policy-Entscheidungen, Audit-Logs und generierte Entwürfe oder finale Antworten.",
    ],
  },
  {
    title: "5. Zwecke der Verarbeitung",
    items: [
      "Bereitstellung, Absicherung und Wartung der Novalure CRM Plattform.",
      "Ermöglichung der Verwaltung von Workspaces, Rollen, Projekten, Kontakten, Deals, Aufgaben, Funnels, Kommunikation und Analytics.",
      "Anbindung kundenseitig freigegebener WhatsApp-Business-, Instagram-, Facebook-Messenger-, Microsoft-365-, Kalender-, E-Mail- und Newsletter-Integrationen.",
      "Empfang, Routing und Beantwortung von Kundenkommunikation über konfigurierte Bots und Kommunikationskanäle.",
      "Speicherung und Aktualisierung von Leads, Kontakten, Deals, Aufgaben, Terminen und Audit-Logs.",
      "Durchsetzung von Bot-Policy-Regeln, Wissensbeschränkungen, manueller Kontrolle, Testmodus, Opt-out-Regeln, Regeln für Dokumentversand und Sicherheitskontrollen.",
      "Support, Fehlerbehebung, Missbrauchsprävention, Verbesserung der Zuverlässigkeit und Erfüllung rechtlicher Pflichten.",
      "Versand von Servicenachrichten und, soweit erlaubt, Marketing- oder Newsletter-Nachrichten.",
    ],
  },
  {
    title: "6. Rechtsgrundlagen",
    items: [
      "Vertragserfüllung: Verarbeitung, die zur Bereitstellung von Novalure CRM und zugehörigen Leistungen erforderlich ist.",
      "Berechtigte Interessen: Plattformsicherheit, Betrugsprävention, Produktzuverlässigkeit, interne Analysen, Support, Audit-Logging und B2B-Kommunikation, jeweils abgewogen gegen die Rechte betroffener Personen.",
      "Einwilligung: optionale Marketing- und Newsletter-Abonnements, bestimmte Cookies, optionale Integrationen und andere Verarbeitungsvorgänge, bei denen eine Einwilligung erforderlich ist.",
      "Rechtliche Verpflichtung: Buchhaltung, Steuern, regulatorische Pflichten, Streitigkeiten, Compliance und Datenschutzpflichten.",
      "Kundenweisungen: Soweit Novalure CLG als Auftragsverarbeiter handelt, erfolgt die Verarbeitung auf Grundlage des jeweiligen Kundenvertrags und rechtmäßiger Weisungen.",
    ],
  },
  {
    title: "7. KI-Bots, Automatisierung und freigegebenes Wissen",
    body: [
      "Novalure CRM kann KI-gestützte Bots einsetzen, um Anfragen zu klassifizieren, Antworten vorzubereiten, Routinefragen zu beantworten, CRM-Datensätze zu aktualisieren, Terminabläufe vorzubereiten, nächste Schritte vorzuschlagen und Audit-Einträge zu erstellen. Bots sind darauf ausgelegt, freigegebenes Workspace-Wissen und konfigurierte Tools zu verwenden, nicht eine freie Internetsuche.",
      "Bot-Aktionen unterliegen Policy-Kontrollen wie blockierten Aussagen, Dokumentfreigaberegeln, Wissensbeschränkungen, Testmodus, Not-Aus, manueller Übersteuerung und Audit-Logging. Kunden bleiben dafür verantwortlich, ihre Bots rechtmäßig zu konfigurieren und automatisierte Kundenkommunikation zu überwachen.",
      "Novalure CRM beabsichtigt nicht, ausschließlich automatisierte Entscheidungen zu treffen, die rechtliche Wirkung oder ähnlich erhebliche Auswirkungen für betroffene Personen haben. KI-Ausgaben sind als operative Unterstützung zu verstehen, sofern ein Kunde nicht separat einen spezifischen automatisierten Entscheidungsprozess rechtmäßig konfiguriert und validiert.",
    ],
  },
  {
    title: "8. Weitergabe und Empfänger",
    body: [
      "Wir geben personenbezogene Daten nur weiter, soweit dies für die in dieser Erklärung beschriebenen Zwecke erforderlich ist, an vom Kunden autorisierte Empfänger, Dienstleister, professionelle Berater, Behörden bei rechtlicher Verpflichtung und vom Kunden ausgewählte Integrationsanbieter.",
    ],
    items: [
      "Hosting-, Datenbank-, Speicher-, Sicherheits- und Deployment-Anbieter.",
      "Kommunikationsanbieter wie Meta/WhatsApp/Instagram/Facebook, E-Mail-Anbieter und Kalenderanbieter, wenn Integrationen aktiviert sind.",
      "KI-, Embedding- oder Sprachmodell-Anbieter, die Antworten, Zusammenfassungen, Klassifizierungen oder Wissenssuchen erzeugen.",
      "Zahlungs-, Support-, Analyse-, Monitoring-, Rechts-, Buchhaltungs- und Compliance-Anbieter, soweit einschlägig.",
    ],
  },
  {
    title: "9. Internationale Übermittlungen",
    body: [
      "Einige Anbieter können personenbezogene Daten außerhalb Irlands oder des Europäischen Wirtschaftsraums verarbeiten. In diesen Fällen stützen wir uns auf einen Angemessenheitsbeschluss, Standardvertragsklauseln, ergänzende Schutzmaßnahmen oder einen anderen nach der DSGVO zulässigen Übermittlungsmechanismus.",
    ],
  },
  {
    title: "10. Speicherdauer",
    body: [
      "Wir speichern personenbezogene Daten nur so lange, wie es für die in dieser Erklärung beschriebenen Zwecke, für die Dauer der Kundenbeziehung, nach Weisung des Workspace-Kunden oder aufgrund gesetzlicher Pflichten erforderlich ist.",
      "CRM-Daten werden grundsätzlich so lange gespeichert, wie der relevante Workspace aktiv ist oder bis der Kunde sie löscht oder exportiert. Sicherheits- und Audit-Logs können für einen angemessenen Zeitraum gespeichert werden, um die Plattform zu schützen und Compliance nachzuweisen. Backups können für eine begrenzte technische Aufbewahrungsdauer bestehen bleiben, bevor sie gelöscht oder überschrieben werden.",
      "Marketing-Einwilligungen und Opt-out-Nachweise können gespeichert werden, um Präferenzen zu beachten und Compliance nachzuweisen.",
    ],
  },
  {
    title: "11. Ihre Rechte",
    body: [
      "Vorbehaltlich gesetzlicher Voraussetzungen und Ausnahmen können betroffene Personen das Recht auf Information, Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Widerspruch, Datenübertragbarkeit, Widerruf einer Einwilligung und Beschwerde bei einer Aufsichtsbehörde haben.",
      "Anfragen können an hello@novalure.eu gesendet werden. Wenn Ihre Daten durch einen unserer Workspace-Kunden verarbeitet wurden, können wir Ihre Anfrage an diesen Kunden als zuständigen Verantwortlichen weiterleiten oder Sie an ihn verweisen.",
    ],
  },
  {
    title: "12. Sicherheit",
    body: [
      "Wir setzen technische und organisatorische Maßnahmen ein, um personenbezogene Daten zu schützen, darunter rollenbasierte Zugriffe, Workspace-Grenzen, Verschlüsselung soweit angemessen, Audit-Logs, Webhook-Validierung, Schutz von Zugriffstoken und operative Überwachung. Kein System ist vollständig sicher, aber wir arbeiten daran, Risiken zu reduzieren und auf Vorfälle angemessen zu reagieren.",
    ],
  },
  {
    title: "13. Cookies und ähnliche Technologien",
    body: [
      "Novalure CRM kann notwendige Cookies oder ähnliche Technologien für Login, Sicherheit, Sitzungsverwaltung und Plattformbetrieb verwenden. Optionale Analyse- oder Marketing-Cookies werden nur eingesetzt, soweit dies rechtlich zulässig ist und, falls erforderlich, mit Einwilligung.",
    ],
  },
  {
    title: "14. Kinder",
    body: [
      "Novalure CRM ist eine Business-Plattform und richtet sich nicht an Kinder. Kunden sollten personenbezogene Daten von Kindern nicht absichtlich übermitteln, sofern sie keine Rechtsgrundlage und geeignete Schutzmaßnahmen haben.",
    ],
  },
  {
    title: "15. Änderungen dieser Erklärung",
    body: [
      "Wir können diese Datenschutzerklärung aktualisieren, um rechtliche, betriebliche oder produktbezogene Änderungen abzubilden. Die jeweils aktuelle Version wird mit aktualisiertem Datum auf dieser Seite veröffentlicht.",
    ],
  },
];

export default async function PrivacyPage({ searchParams }: PrivacyPageProps) {
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
