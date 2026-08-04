import type { LanguageCode } from "@/lib/i18n";

type CardCopy = {
  title: string;
  body: string;
};

type PipelineCardCopy = {
  source: string;
  title: string;
  action: string;
};

type LandingV2Copy = {
  nav: {
    preview: string;
    audit: string;
    faq: string;
    login: string;
    auditCta: string;
    menuOpen: string;
    menuClose: string;
  };
  hero: {
    title: string;
    titleAccent: string;
    description: string;
    primaryCta: string;
    secondaryCta: string;
    accessLine: string;
    regions: readonly string[];
  };
  leadCard: {
    reminder: string;
    type: string;
    status: string;
    title: string;
    received: string;
    rows: readonly (readonly [string, string])[];
    firstStage: string;
    progress: string;
    lastStage: string;
    note: string;
  };
  problem: {
    eyebrow: string;
    title: string;
    cards: readonly CardCopy[];
    funnelCaption: string;
    funnel: readonly { label: string; value: number }[];
    funnelNote: string;
  };
  preview: {
    eyebrow: string;
    title: string;
    description: string;
    pipelineCaption: string;
    columns: readonly {
      title: string;
      cards: readonly PipelineCardCopy[];
    }[];
    inboxCaption: string;
    inbox: readonly { time: string; title: string; status: string; owner: string }[];
    visibleTitle: string;
    protectedTitle: string;
    visible: readonly string[];
    protected: readonly string[];
  };
  audiences: {
    eyebrow: string;
    title: string;
    resultLabel: string;
    items: readonly (CardCopy & { result: string })[];
  };
  audit: {
    eyebrow: string;
    title: string;
    steps: readonly CardCopy[];
    outcomesTitle: string;
    outcomes: readonly string[];
    cta: string;
  };
  privacy: {
    eyebrow: string;
    title: string;
    items: readonly CardCopy[];
  };
  faq: {
    eyebrow: string;
    title: string;
    items: readonly { question: string; answer: string }[];
  };
  finalCta: {
    title: string;
    description: string;
    cta: string;
  };
  labels: {
    example: string;
    noRealData: string;
  };
};

const copy = {
  de: {
    nav: {
      preview: "Vorschau",
      audit: "Audit",
      faq: "FAQ",
      login: "Team-Login",
      auditCta: "Audit anfragen",
      menuOpen: "Menü öffnen",
      menuClose: "Menü schließen",
    },
    hero: {
      title: "Jede Immobilienanfrage bekommt Kontext, Zuständigkeit und",
      titleAccent: "den nächsten Schritt.",
      description:
        "Novalure CRM ist der private Lead-Workspace für Immobilien-Teams in Irland, Großbritannien, im DACH-Raum und der übrigen EU: Anfragen, Zuständigkeiten, Termine und Pipeline an einem Ort – vertraulich geführt.",
      primaryCta: "Pipeline-Audit anfragen",
      secondaryCta: "CRM-Vorschau ansehen",
      accessLine: "Kein Self-Service-Abo · Zugang nach Prüfung",
      regions: ["Irland", "UK", "DACH", "Übrige EU"],
    },
    leadCard: {
      reminder: "Rückruf heute, 15:00",
      type: "Verkäuferanfrage",
      status: "Qualifiziert",
      title: "Lead № 2481",
      received: "Eingang heute, 11:42 Uhr",
      rows: [
        ["Quelle", "Empfehlung"],
        ["Status", "Qualifiziert"],
        ["Zuständig", "S. Müller"],
        ["Nächste Aktion", "Rückruf heute, 15:00"],
        ["Pipeline-Phase", "Erstgespräch geplant"],
      ],
      firstStage: "Neu",
      progress: "Phase 3 von 5",
      lastStage: "Abschluss",
      note: "Anonymisierte Beispielansicht · keine echten Kundendaten",
    },
    problem: {
      eyebrow: "Das Problem",
      title: "Umsatz geht zwischen Anfrage und nächster Aktion verloren.",
      cards: [
        {
          title: "Keine sichtbare nächste Aktion",
          body: "Anfragen liegen im Postfach, ohne dass jemand den nächsten Schritt sieht.",
        },
        {
          title: "Follow-up hängt an Personen",
          body: "Ob nachgefasst wird, hängt daran, wer gerade daran denkt.",
        },
        {
          title: "Kampagnen zu früh bewertet",
          body: "Kampagnen werden nach Klicks beurteilt, bevor ein Lead qualifiziert ist.",
        },
        {
          title: "Termine und Pipeline getrennt",
          body: "Der Kalender weiß nichts vom Pipeline-Stand – und umgekehrt.",
        },
      ],
      funnelCaption: "Wo Anfragen verloren gehen · Beispielwerte",
      funnel: [
        { label: "Anfragen eingegangen", value: 100 },
        { label: "Beantwortet", value: 64 },
        { label: "Nächste Aktion terminiert", value: 31 },
        { label: "Termin stattgefunden", value: 18 },
      ],
      funnelNote: "Schematische Darstellung – keine echten Kundendaten.",
    },
    preview: {
      eyebrow: "CRM-Vorschau",
      title: "Sichtbar ist die Struktur – geschützt sind die Daten.",
      description:
        "Die Lead-Karte oben und die Ausschnitte hier sind echte Ansichten aus dem Workspace – vollständig anonymisiert: Namen maskiert, Preise und Notizen unsichtbar.",
      pipelineCaption: "Pipeline",
      columns: [
        {
          title: "Neu",
          cards: [
            { source: "Portal", title: "Käuferanfrage · M. ●●●", action: "Erstkontakt offen" },
            { source: "Kampagne", title: "Käuferanfrage · A. ●●●", action: "Zuteilung offen" },
          ],
        },
        {
          title: "Qualifiziert",
          cards: [
            { source: "Empfehlung", title: "Verkäuferanfrage · S. ●●●", action: "Rückruf heute, 15:00" },
            { source: "Portal", title: "Käuferanfrage · R. ●●●", action: "Exposé senden" },
          ],
        },
        {
          title: "Erstgespräch",
          cards: [
            { source: "Kampagne", title: "Käuferanfrage · T. ●●●", action: "Termin Fr, 14:00" },
            { source: "Portal", title: "Verkäuferanfrage · K. ●●●", action: "Unterlagen prüfen" },
          ],
        },
        {
          title: "Besichtigung",
          cards: [
            { source: "Empfehlung", title: "Käuferanfrage · J. ●●●", action: "Objekt Do, 9:00" },
          ],
        },
      ],
      inboxCaption: "Anfragen-Eingang",
      inbox: [
        { time: "09:12", title: "Käuferanfrage · Portal", status: "Neu", owner: "SM" },
        { time: "10:05", title: "Verkäuferanfrage · Empfehlung", status: "Qualifiziert", owner: "SM" },
        { time: "11:42", title: "Käuferanfrage · Kampagne", status: "Neu", owner: "LK" },
        { time: "13:20", title: "Verkäuferanfrage · Portal", status: "Qualifiziert", owner: "LK" },
      ],
      visibleTitle: "In der Vorschau sichtbar",
      protectedTitle: "Öffentlich geschützt",
      visible: ["Quelle der Anfrage", "Status", "Zuständigkeit im Team", "Nächste Aktion mit Termin", "Pipeline-Phase"],
      protected: ["Kundennamen", "Kontaktdaten", "Preise und Konditionen", "Interne Notizen"],
    },
    audiences: {
      eyebrow: "Zielgruppen",
      title: "Gebaut für Teams, die Anfragen gemeinsam bearbeiten.",
      resultLabel: "Ergebnis",
      items: [
        {
          title: "Bauträger",
          body: "Projektanfragen laufen sortiert nach Projekt und Einheit in eine gemeinsame Pipeline.",
          result: "Vertriebsstand je Projekt auf einen Blick.",
        },
        {
          title: "Maklerteams",
          body: "Jede Anfrage hat eine zuständige Person und einen terminierten nächsten Schritt.",
          result: "Kein Lead bleibt unbeantwortet liegen.",
        },
        {
          title: "Projektvertriebe",
          body: "Kampagnen, Erstgespräche und Reservierungen hängen an einem Datensatz zusammen.",
          result: "Kampagnen werden am Abschluss gemessen, nicht am Klick.",
        },
      ],
    },
    audit: {
      eyebrow: "Pipeline-Audit",
      title: "Erst das Audit, dann der Workspace.",
      steps: [
        { title: "Audit", body: "Gemeinsame Durchsicht Ihrer Lead-Wege, von der ersten Anfrage bis zum Termin." },
        { title: "Engpassanalyse", body: "Wir benennen, wo Anfragen liegen bleiben – und was das kostet." },
        { title: "Setup-Entscheidung", body: "Sie entscheiden auf klarer Grundlage, ob Novalure zu Ihrem Vertrieb passt." },
        { title: "CRM-reife Lead-Bearbeitung", body: "Ihr Team arbeitet mit Zuständigkeiten, Fristen und einer gepflegten Pipeline." },
      ],
      outcomesTitle: "Was Sie nach dem Audit haben",
      outcomes: [
        "Eine dokumentierte Aufnahme Ihrer heutigen Lead-Wege",
        "Die Engpässe, priorisiert nach Umsatzwirkung",
        "Eine klare Empfehlung – für oder gegen ein Setup",
        "Einen Fahrplan für die ersten Wochen",
      ],
      cta: "Pipeline-Audit anfragen",
    },
    privacy: {
      eyebrow: "Zugriff & Datenschutz",
      title: "Ihr Workspace bleibt privat.",
      items: [
        {
          title: "Zugang nur per Einladung",
          body: "Ihr Team arbeitet in einem geschlossenen Workspace – Zugänge entstehen nach dem Audit, nicht über ein Formular.",
        },
        {
          title: "Keine öffentlichen Kundendaten",
          body: "Diese Seite zeigt ausschließlich anonymisierte Beispiele; Namen, Kontaktdaten und Preise bleiben im Workspace.",
        },
        {
          title: "Rechtliches ohne Login",
          body: "Impressum, Datenschutzerklärung und alle rechtlichen Seiten sind jederzeit ohne Anmeldung erreichbar.",
        },
      ],
    },
    faq: {
      eyebrow: "Fragen",
      title: "Fünf Fragen, kurz beantwortet.",
      items: [
        {
          question: "Gibt es ein Abo oder eine Preisliste?",
          answer: "Nein. Novalure wird nicht als Abo verkauft. Ob ein Workspace-Setup sinnvoll ist, klären wir im Pipeline-Audit – danach erhalten Sie ein Angebot für Ihr Setup.",
        },
        {
          question: "Kann ich das CRM vorab testen?",
          answer: "Eine offene Demo gibt es nicht. Die anonymisierte Lead-Karte oben zeigt die Struktur; im Audit sehen Sie den Workspace live, an Ihren eigenen Abläufen.",
        },
        {
          question: "Wie läuft das Pipeline-Audit ab?",
          answer: "Ein Termin mit den Personen, die heute Anfragen bearbeiten: Wir gehen Ihre Lead-Wege gemeinsam durch, benennen die Engpässe, und Sie erhalten eine schriftliche Empfehlung.",
        },
        {
          question: "Ist Novalure ein fertiges CRM von der Stange?",
          answer: "Nein. Novalure ist ein Workspace, der auf Ihren Vertriebsprozess eingerichtet wird – Phasen, Zuständigkeiten und Fristen folgen Ihrem Team, nicht umgekehrt.",
        },
        {
          question: "Für wen ist Novalure gedacht?",
          answer: "Für Maklerteams, Bauträger und Projektvertriebe in Irland, Großbritannien, im DACH-Raum und der übrigen EU, die Anfragen im Team bearbeiten und den Überblick über die nächste Aktion behalten wollen.",
        },
      ],
    },
    finalCta: {
      title: "Erst prüfen. Dann den passenden CRM-Workspace bauen.",
      description: "Das Pipeline-Audit ist der erste Schritt – und die Grundlage für alles Weitere.",
      cta: "Pipeline-Audit anfragen",
    },
    labels: {
      example: "Anonymisierte Beispielansicht",
      noRealData: "Keine echten Kundendaten",
    },
  },
  en: {
    nav: {
      preview: "Preview",
      audit: "Audit",
      faq: "FAQ",
      login: "Team login",
      auditCta: "Request audit",
      menuOpen: "Open menu",
      menuClose: "Close menu",
    },
    hero: {
      title: "Every real estate enquiry gets context, ownership and",
      titleAccent: "the next step.",
      description:
        "Novalure CRM is the private lead workspace for real estate teams in Ireland, the United Kingdom, the DACH region and the wider EU: enquiries, ownership, appointments and pipeline in one place – managed confidentially.",
      primaryCta: "Request pipeline audit",
      secondaryCta: "View CRM preview",
      accessLine: "No self-service subscription · Access after review",
      regions: ["Ireland", "UK", "DACH", "Wider EU"],
    },
    leadCard: {
      reminder: "Callback today, 15:00",
      type: "Seller enquiry",
      status: "Qualified",
      title: "Lead no. 2481",
      received: "Received today, 11:42",
      rows: [
        ["Source", "Referral"],
        ["Status", "Qualified"],
        ["Owner", "S. Miller"],
        ["Next action", "Callback today, 15:00"],
        ["Pipeline stage", "Initial call scheduled"],
      ],
      firstStage: "New",
      progress: "Stage 3 of 5",
      lastStage: "Closed",
      note: "Anonymised example view · no real customer data",
    },
    problem: {
      eyebrow: "The problem",
      title: "Revenue is lost between the enquiry and the next action.",
      cards: [
        {
          title: "No visible next action",
          body: "Enquiries sit in an inbox without anyone seeing the next step.",
        },
        {
          title: "Follow-up depends on people",
          body: "Whether anyone follows up depends on who happens to remember.",
        },
        {
          title: "Campaigns judged too early",
          body: "Campaigns are judged by clicks before a lead has been qualified.",
        },
        {
          title: "Appointments and pipeline separated",
          body: "The calendar knows nothing about pipeline status – and vice versa.",
        },
      ],
      funnelCaption: "Where enquiries are lost · sample values",
      funnel: [
        { label: "Enquiries received", value: 100 },
        { label: "Answered", value: 64 },
        { label: "Next action scheduled", value: 31 },
        { label: "Appointment completed", value: 18 },
      ],
      funnelNote: "Schematic illustration – no real customer data.",
    },
    preview: {
      eyebrow: "CRM preview",
      title: "The structure is visible – the data stays protected.",
      description:
        "The lead card above and the extracts shown here are real workspace views, fully anonymised: names masked, prices and notes hidden.",
      pipelineCaption: "Pipeline",
      columns: [
        {
          title: "New",
          cards: [
            { source: "Portal", title: "Buyer enquiry · M. ●●●", action: "Initial contact pending" },
            { source: "Campaign", title: "Buyer enquiry · A. ●●●", action: "Assignment pending" },
          ],
        },
        {
          title: "Qualified",
          cards: [
            { source: "Referral", title: "Seller enquiry · S. ●●●", action: "Callback today, 15:00" },
            { source: "Portal", title: "Buyer enquiry · R. ●●●", action: "Send brochure" },
          ],
        },
        {
          title: "Initial call",
          cards: [
            { source: "Campaign", title: "Buyer enquiry · T. ●●●", action: "Appointment Fri, 14:00" },
            { source: "Portal", title: "Seller enquiry · K. ●●●", action: "Review documents" },
          ],
        },
        {
          title: "Viewing",
          cards: [
            { source: "Referral", title: "Buyer enquiry · J. ●●●", action: "Property Thu, 9:00" },
          ],
        },
      ],
      inboxCaption: "Enquiry inbox",
      inbox: [
        { time: "09:12", title: "Buyer enquiry · Portal", status: "New", owner: "SM" },
        { time: "10:05", title: "Seller enquiry · Referral", status: "Qualified", owner: "SM" },
        { time: "11:42", title: "Buyer enquiry · Campaign", status: "New", owner: "LK" },
        { time: "13:20", title: "Seller enquiry · Portal", status: "Qualified", owner: "LK" },
      ],
      visibleTitle: "Visible in the preview",
      protectedTitle: "Protected from public view",
      visible: ["Enquiry source", "Status", "Team ownership", "Next action with due time", "Pipeline stage"],
      protected: ["Customer names", "Contact details", "Prices and terms", "Internal notes"],
    },
    audiences: {
      eyebrow: "Who it is for",
      title: "Built for teams that work enquiries together.",
      resultLabel: "Outcome",
      items: [
        {
          title: "Property developers",
          body: "Project enquiries flow into one shared pipeline, organised by project and unit.",
          result: "Sales status for every project at a glance.",
        },
        {
          title: "Brokerage teams",
          body: "Every enquiry has an owner and a scheduled next step.",
          result: "No lead is left unanswered.",
        },
        {
          title: "Project sales teams",
          body: "Campaigns, initial calls and reservations stay connected to one record.",
          result: "Campaigns are measured by completions, not clicks.",
        },
      ],
    },
    audit: {
      eyebrow: "Pipeline audit",
      title: "Audit first. Workspace second.",
      steps: [
        { title: "Audit", body: "We review your lead paths together, from first enquiry to appointment." },
        { title: "Bottleneck analysis", body: "We identify where enquiries stall – and what that costs." },
        { title: "Setup decision", body: "You decide on a clear basis whether Novalure fits your sales operation." },
        { title: "CRM-ready lead operations", body: "Your team works with ownership, deadlines and a maintained pipeline." },
      ],
      outcomesTitle: "What you have after the audit",
      outcomes: [
        "A documented view of your current lead paths",
        "Bottlenecks prioritised by revenue impact",
        "A clear recommendation for or against a setup",
        "A roadmap for the first few weeks",
      ],
      cta: "Request pipeline audit",
    },
    privacy: {
      eyebrow: "Access & privacy",
      title: "Your workspace stays private.",
      items: [
        {
          title: "Invitation-only access",
          body: "Your team works in a closed workspace – access follows the audit and is not created through a public form.",
        },
        {
          title: "No public customer data",
          body: "This page shows anonymised examples only; names, contact details and prices remain in the workspace.",
        },
        {
          title: "Legal information without login",
          body: "The imprint, privacy policy and all legal pages remain available without signing in.",
        },
      ],
    },
    faq: {
      eyebrow: "Questions",
      title: "Five questions, answered briefly.",
      items: [
        {
          question: "Is there a subscription or public price list?",
          answer: "No. Novalure is not sold as a subscription. The pipeline audit determines whether a workspace setup makes sense; you then receive a proposal for your setup.",
        },
        {
          question: "Can I test the CRM in advance?",
          answer: "There is no open demo. The anonymised lead card above shows the structure; during the audit, you see the workspace live in the context of your own processes.",
        },
        {
          question: "How does the pipeline audit work?",
          answer: "It is a session with the people who handle enquiries today. We review your lead paths together, identify bottlenecks and provide a written recommendation.",
        },
        {
          question: "Is Novalure an off-the-shelf CRM?",
          answer: "No. Novalure is a workspace configured around your sales process – stages, ownership and deadlines follow your team, not the other way round.",
        },
        {
          question: "Who is Novalure for?",
          answer: "Brokerage teams, property developers and project sales teams in Ireland, the United Kingdom, the DACH region and the wider EU that manage enquiries together and need visibility of the next action.",
        },
      ],
    },
    finalCta: {
      title: "Review first. Then build the right CRM workspace.",
      description: "The pipeline audit is the first step – and the basis for everything that follows.",
      cta: "Request pipeline audit",
    },
    labels: {
      example: "Anonymised example view",
      noRealData: "No real customer data",
    },
  },
} as const satisfies Record<LanguageCode, LandingV2Copy>;

export function getPublicCrmLandingV2Copy(language: LanguageCode): LandingV2Copy {
  return copy[language] ?? copy.en;
}
