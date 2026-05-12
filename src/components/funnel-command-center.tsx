"use client";

import { useMemo, useState } from "react";
import { FunnelBlueprintDesigner } from "@/components/funnel-blueprint-designer";
import { FunnelRenderer } from "@/components/funnel-renderer";
import { buildFunnelBlueprint } from "@/lib/funnel-builder-adapter";
import type { Funnel, FunnelStep, Lead, Project, WorkspaceUser } from "@/lib/crm-types";
import { type LanguageCode } from "@/lib/i18n";

type FunnelCommandCenterProps = {
  funnels: Funnel[];
  language: LanguageCode;
  leads: Lead[];
  projectLabel: string;
  projects: Project[];
  steps: FunnelStep[];
  users: WorkspaceUser[];
};

type FunnelView = "all" | "active" | "optimize" | "blocked" | "bots";
type BuilderTab =
  | "overview"
  | "editor"
  | "design"
  | "steps"
  | "logic"
  | "messages"
  | "tracking"
  | "analytics"
  | "privacy"
  | "experiments"
  | "handover"
  | "workspace"
  | "preview";
type EditableStepType =
  | "Landingpage"
  | "Auswahlfrage"
  | "Mehrfachauswahl"
  | "Kontaktformular"
  | "Bot"
  | "Kalender"
  | "Danke-Seite"
  | "Adresse"
  | "Upload"
  | "Video"
  | "Payment"
  | "Loader"
  | "Ergebnisseite";

type EditableStep = FunnelStep & {
  type: EditableStepType;
  question: string;
  options: string[];
  score: number;
  required: boolean;
  crmField: string;
  condition: string;
  target: string;
  analyticsEvent: string;
};

type EditableFunnel = Funnel & {
  adaptationBrief: string;
  templateUseCase: "Immobilien Käufer" | "Immobilien Verkäufer" | "Termin" | "B2B Lead" | "Newsletter" | "Custom";
  brandPreset: string;
  highlightColor: string;
  customDomain: string;
  mobileFirstMode: boolean;
  headerMode: "Logo" | "Navigation" | "Minimal";
  landingPageBlocks: string[];
  designerHeroTitle: string;
  designerHeroSubtitle: string;
  designerCtaLabel: string;
  designerLogoText: string;
  designerBackgroundColor: string;
  designerTextColor: string;
  designerBlockText: string;
  designerFontPreset: "System" | "Editorial" | "Modern" | "Serif";
  designerButtonRadius: string;
  designerBlockRadius: string;
  designerSectionSpacing: string;
  bookingProvider: "CRM Kalender" | "Calendly" | "Meeting-Kalender" | "Cal.com" | "Externer Kalender";
  leadMagnet: string;
  newsletterSegment: string;
  doubleOptIn: boolean;
  whatsappInbox: boolean;
  emailSequence: string;
  messageCondition: string;
  messageDelay: string;
  replySender: string;
  crmStage: string;
  followUp: string;
  leadDestination: "Lead Inbox" | "Pipeline" | "Kalender" | "Newsletter Segment";
  metaPixelId: string;
  metaCapiToken: string;
  gaMeasurementId: string;
  gtmId: string;
  matomoSiteId: string;
  consentMode: "intern" | "bereit" | "aktiv";
  cookieConsent: "Standalone Banner" | "Website Consent" | "Openli" | "Custom Code";
  dataRetention: string;
  sensitiveMode: string;
  webhookUrl: string;
  abVariant: string;
  trafficSplit: string;
  winningRule: string;
  workspaceAccess: "Intern" | "Kunde Betrachter" | "Kunde Bearbeiter" | "Agentur White Label";
  statusTemplate: string;
  notificationRecipients: string;
  leadQualityRule: string;
  triggerLeadInbox: boolean;
  triggerTask: boolean;
  triggerAppointment: boolean;
};

type TrackingEvent = {
  id: string;
  label: string;
  meta: string;
  ga: string;
  enabled: boolean;
};

const statusStyles = {
  aktiv: "border-emerald-200 bg-emerald-50 text-emerald-900",
  optimieren: "border-amber-200 bg-amber-50 text-amber-900",
  entwurf: "border-stone-200 bg-stone-50 text-stone-700",
  "prüfen": "border-amber-200 bg-amber-50 text-amber-900",
  blockiert: "border-red-200 bg-red-50 text-red-900",
} as const;

const channelStyles = {
  Website: "bg-blue-50 text-blue-800",
  Landingpage: "bg-emerald-50 text-emerald-800",
  WhatsApp: "bg-teal-50 text-teal-800",
  Instagram: "bg-violet-50 text-violet-800",
  Newsletter: "bg-amber-50 text-amber-800",
} as const;

const stepTypes: EditableStepType[] = [
  "Landingpage",
  "Auswahlfrage",
  "Mehrfachauswahl",
  "Kontaktformular",
  "Bot",
  "Kalender",
  "Danke-Seite",
  "Adresse",
  "Upload",
  "Video",
  "Payment",
  "Loader",
  "Ergebnisseite",
];

const defaultTrackingEvents: TrackingEvent[] = [
  { id: "page_view", label: "Funnel geladen", meta: "PageView", ga: "page_view", enabled: true },
  { id: "funnel_start", label: "Funnel gestartet", meta: "ViewContent", ga: "funnel_start", enabled: true },
  { id: "step_view", label: "Schritt angesehen", meta: "ViewContent", ga: "funnel_step_view", enabled: true },
  { id: "answer", label: "Antwort gewählt", meta: "CustomizeProduct", ga: "funnel_answer", enabled: true },
  { id: "lead", label: "Lead gesendet", meta: "Lead", ga: "generate_lead", enabled: true },
  { id: "appointment", label: "Termin gebucht", meta: "Schedule", ga: "book_appointment", enabled: true },
];

const adaptationPrompt = [
  "Baue den CRM-Funnel-Builder als eine einheitliche Softwareanwendung aus.",
  "Verbinde Funnel-Editor, Landingpage, mobile Vorschau, CRM-Pipeline, Follow-up, Tracking, Datenschutz und Analyse in einem Workspace.",
  "Der Nutzer muss neue Funnels erstellen, einem Projekt zuordnen, Lead-Ziele bestimmen, Schritte bearbeiten, Logik definieren, Termine buchen, E-Mail/WhatsApp-Sequenzen starten und Leads direkt im CRM sehen können.",
  "Nutze Best Practices von Heyflow und Perspective: Mobile-first, direkte Bearbeitung, bedingte Pfade, Variablen, Lead Scoring, Meta Pixel plus CAPI, GA4/GTM/Matomo, UTM-Tracking, Consent, Sensitive Fields, A/B-Testing, Workspaces, Rollen, White Label und Status-Trigger.",
].join(" ");

const leadQualityRules = [
  "Telefon + E-Mail erforderlich, Score ab 60",
  "Budget + Zeitraum + Projektinteresse erforderlich",
  "Double Opt-in vor Automation",
  "Terminbuchung vor Pipeline-Übergabe",
];
const statusTemplateOptions = [
  "Immobilien Vertrieb",
  "B2B Qualifizierung",
  "Newsletter Double Opt-in",
  "Terminbuchung",
  "Agentur Kundenreport",
];
const fieldLabelClass = "grid min-w-0 gap-1 text-sm font-semibold text-slate-900";
const inputClass = "w-full min-w-0 max-w-full rounded-md border border-stone-300 px-3 py-2 text-sm";
const selectClass = "w-full min-w-0 max-w-full rounded-md border border-stone-300 px-3 py-2 text-sm";
const textareaClass = "w-full min-h-24 min-w-0 max-w-full resize-y rounded-md border border-stone-300 px-3 py-2 text-sm";
const cardClass = "min-w-0 rounded-lg border border-stone-200 bg-white p-4";
const mutedCardClass = "min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4";

const labels = {
  de: {
    title: "Funnel und Leadgewinnung",
    description:
      "Eine CRM-Anwendung: Funnel auswählen, bearbeiten, testen, messen und direkt an Leads, Pipeline, Aufgaben und Kalender übergeben.",
    all: "Alle",
    active: "Aktiv",
    optimize: "Optimieren",
    blocked: "Blockiert",
    bots: "Bot-Schritte",
    search: "Suche",
    searchPlaceholder: "Funnel, Kanal, Zielgruppe oder Engpass suchen",
    visits: "Besuche",
    leads: "Leads",
    conversion: "Conversion",
    avgConversion: "Ø Conversion",
    liveLeads: "Leads im Projektfilter",
    selectedFunnel: "Ausgewählter Funnel",
    noFunnels: "Keine Funnel für diese Ansicht.",
    save: "Änderungen speichern",
    addStep: "Schritt hinzufügen",
    duplicate: "Duplizieren",
    remove: "Löschen",
  },
  en: {
    title: "Funnels and lead generation",
    description:
      "One CRM application: select, edit, test, measure and hand funnels over to leads, pipeline, tasks and calendar.",
    all: "All",
    active: "Active",
    optimize: "Optimize",
    blocked: "Blocked",
    bots: "Bot steps",
    search: "Search",
    searchPlaceholder: "Search funnel, channel, audience or bottleneck",
    visits: "Visits",
    leads: "Leads",
    conversion: "Conversion",
    avgConversion: "Avg conversion",
    liveLeads: "Leads in project filter",
    selectedFunnel: "Selected funnel",
    noFunnels: "No funnels for this view.",
    save: "Save changes",
    addStep: "Add step",
    duplicate: "Duplicate",
    remove: "Delete",
  },
} as const;

function formatNumber(value: number, language: LanguageCode) {
  return new Intl.NumberFormat(language === "de" ? "de-AT" : "en-US").format(value);
}

function formatPercent(value: number, language: LanguageCode) {
  return new Intl.NumberFormat(language === "de" ? "de-AT" : "en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(value);
}

function normalizeFunnel(funnel: Funnel): EditableFunnel {
  const isNewsletter = funnel.entryChannel === "Newsletter";
  const isAppointment = funnel.goal.toLowerCase().includes("termin") || funnel.goal.toLowerCase().includes("besichtigung");

  return {
    ...funnel,
    adaptationBrief: adaptationPrompt,
    templateUseCase:
      funnel.audience === "Verkäufer"
        ? "Immobilien Verkäufer"
        : isNewsletter
          ? "Newsletter"
          : isAppointment
            ? "Termin"
            : funnel.audience === "Käufer"
              ? "Immobilien Käufer"
              : "Custom",
    brandPreset: "Projekt-Branding übernehmen",
    highlightColor: "#047857",
    customDomain: "",
    mobileFirstMode: true,
    headerMode: "Logo",
    landingPageBlocks: ["Hero", "Projektvideo", "Testimonials", "Kalender"],
    designerHeroTitle: funnel.goal,
    designerHeroSubtitle: `${funnel.audience} erhalten in wenigen Schritten die passenden Informationen und einen direkten Kontakt zum Team.`,
    designerCtaLabel: isAppointment ? "Termin sichern" : "Lead starten",
    designerLogoText: funnel.name.split(" ")[0] ?? "Novalure",
    designerBackgroundColor: "#ffffff",
    designerTextColor: "#020617",
    designerBlockText: "Kundenvorteile, Vertrauen und nächster Schritt klar darstellen.",
    designerFontPreset: "System",
    designerButtonRadius: "8",
    designerBlockRadius: "8",
    designerSectionSpacing: "16",
    bookingProvider: "CRM Kalender",
    leadMagnet: isNewsletter ? "Projekt-Update und Investment-Checkliste" : "",
    newsletterSegment: isNewsletter ? `${funnel.audience} Segment` : "",
    doubleOptIn: isNewsletter,
    whatsappInbox: funnel.entryChannel === "WhatsApp",
    emailSequence: isAppointment
      ? "Sofort bestätigen, nach 2 Stunden Termin erinnern, nach 1 Tag Sales-Aufgabe"
      : "Sofort bestätigen, nach 1 Tag Mehrwert senden, nach 3 Tagen Beratung anbieten",
    messageCondition: "Wenn kein Termin gebucht wurde oder Score über 60 liegt",
    messageDelay: "Sofort, 2 Stunden, 1 Tag",
    replySender: "Novalure Sales",
    crmStage: funnel.status === "aktiv" ? "Qualifiziert" : "Lead Inbox",
    followUp:
      funnel.entryChannel === "WhatsApp"
        ? "WhatsApp Rückfrage und Bewertungsaufgabe"
        : "E-Mail Sequenz, Aufgabe und Kalenderlink",
    leadDestination: "Lead Inbox",
    metaPixelId: "",
    metaCapiToken: "",
    gaMeasurementId: "",
    gtmId: "",
    matomoSiteId: "",
    consentMode: "intern",
    cookieConsent: "Website Consent",
    dataRetention: "Antworten 6 Monate speichern, sensible Felder sofort minimieren",
    sensitiveMode: "Telefon, E-Mail, Budget, Adresse und Uploads markieren",
    webhookUrl: "",
    abVariant: "Basis vs. kuerzere mobile Variante",
    trafficSplit: "50/50",
    winningRule: "Gewinner nach Conversion Rate und qualifizierten Leads wählen",
    workspaceAccess: "Intern",
    statusTemplate: "Immobilien Vertrieb",
    notificationRecipients: "Franz, Sales Graz",
    leadQualityRule: leadQualityRules[1],
    triggerLeadInbox: true,
    triggerTask: true,
    triggerAppointment: isAppointment,
  };
}

function normalizeStep(step: FunnelStep, index: number): EditableStep {
  const inferredType: EditableStepType =
    step.botRuleId ? "Bot" : step.channel === "Landingpage" ? "Landingpage" : index === 0 ? "Auswahlfrage" : "Kontaktformular";

  return {
    ...step,
    type: inferredType,
    question: step.name,
    options:
      inferredType === "Kontaktformular"
        ? ["Name", "E-Mail", "Telefon"]
        : ["Ja, passt", "Noch unsicher", "Nicht relevant"],
    score: Math.max(10, Math.round(step.conversionRate * 3)),
    required: true,
    crmField: step.name.toLowerCase().replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, ""),
    condition: "Wenn Antwort qualifiziert ist",
    target: "Nächster Schritt",
    analyticsEvent: index === 0 ? "funnel_start" : "step_view",
  };
}

function createFunnel({
  project,
  user,
  workspaceId,
}: {
  project: Project;
  user?: WorkspaceUser;
  workspaceId: string;
}): EditableFunnel {
  const id = `funnel_new_${Date.now()}`;

  return {
    id,
    workspaceId,
    projectId: project.id,
    name: `${project.name} Neuer Funnel`,
    goal: "Qualifizierte Leads erfassen und an Vertrieb übergeben",
    audience: "Käufer",
    entryChannel: "Website",
    status: "entwurf",
    visits: 0,
    leads: 0,
    conversionRate: 0,
    ownerUserId: user?.id,
    adaptationBrief: adaptationPrompt,
    templateUseCase: "Immobilien Käufer",
    brandPreset: "Projekt-Branding übernehmen",
    highlightColor: "#047857",
    customDomain: "",
    mobileFirstMode: true,
    headerMode: "Logo",
    landingPageBlocks: ["Hero", "Projektvideo", "Testimonials", "Kalender"],
    designerHeroTitle: "Qualifizierte Leads erfassen und an Vertrieb übergeben",
    designerHeroSubtitle: "Der Kunde beantwortet wenige Fragen, wird qualifiziert und landet direkt im richtigen CRM-Ziel.",
    designerCtaLabel: "Lead starten",
    designerLogoText: project.name,
    designerBackgroundColor: "#ffffff",
    designerTextColor: "#020617",
    designerBlockText: "Kundenvorteile, Vertrauen und nächster Schritt klar darstellen.",
    designerFontPreset: "System",
    designerButtonRadius: "8",
    designerBlockRadius: "8",
    designerSectionSpacing: "16",
    bookingProvider: "CRM Kalender",
    leadMagnet: "",
    newsletterSegment: "",
    doubleOptIn: false,
    whatsappInbox: false,
    emailSequence: "Sofort bestätigen, nach 2 Stunden Termin erinnern, nach 1 Tag Sales-Aufgabe",
    messageCondition: "Wenn kein Termin gebucht wurde oder Score über 60 liegt",
    messageDelay: "Sofort, 2 Stunden, 1 Tag",
    replySender: "Novalure Sales",
    crmStage: "Lead Inbox",
    followUp: "Lead prüfen, Aufgabe erstellen und bei Hot Lead Termin anbieten",
    leadDestination: "Lead Inbox",
    metaPixelId: "",
    metaCapiToken: "",
    gaMeasurementId: "",
    gtmId: "",
    matomoSiteId: "",
    consentMode: "intern",
    cookieConsent: "Website Consent",
    dataRetention: "Antworten 6 Monate speichern, sensible Felder sofort minimieren",
    sensitiveMode: "Telefon, E-Mail, Budget, Adresse und Uploads markieren",
    webhookUrl: "",
    abVariant: "Basis vs. kuerzere mobile Variante",
    trafficSplit: "50/50",
    winningRule: "Gewinner nach Conversion Rate und qualifizierten Leads wählen",
    workspaceAccess: "Intern",
    statusTemplate: "Immobilien Vertrieb",
    notificationRecipients: "Franz, Sales Graz",
    leadQualityRule: leadQualityRules[1],
    triggerLeadInbox: true,
    triggerTask: true,
    triggerAppointment: false,
  };
}

function createDefaultSteps(funnel: EditableFunnel): EditableStep[] {
  return [
    {
      ...createStep(funnel, 0),
      name: "Einstiegsfrage",
      type: "Auswahlfrage",
      question: "Wofür interessieren Sie sich?",
      options: ["Besichtigung", "Beratung", "Informationen erhalten"],
      score: 12,
      crmField: "interest",
      analyticsEvent: "funnel_start",
    },
    {
      ...createStep(funnel, 1),
      name: "Qualifizierung",
      type: "Auswahlfrage",
      question: "Wann ist der nächste Schritt relevant?",
      options: ["Sofort", "In 30 Tagen", "Nur Recherche"],
      score: 18,
      crmField: "timeline",
      analyticsEvent: "step_view",
    },
    {
      ...createStep(funnel, 2),
      name: "Kontaktformular",
      type: "Kontaktformular",
      channel: "Website",
      question: "Wie erreichen wir Sie am besten?",
      options: ["Name", "E-Mail", "Telefon"],
      score: 25,
      crmField: "contact",
      analyticsEvent: "lead",
    },
  ];
}

function createStep(funnel: EditableFunnel, index: number): EditableStep {
  return {
    id: `step_new_${Date.now()}`,
    workspaceId: funnel.workspaceId,
    projectId: funnel.projectId,
    funnelId: funnel.id,
    name: `Neuer Schritt ${index + 1}`,
    channel: funnel.entryChannel === "Website" ? "Website" : funnel.entryChannel,
    status: "entwurf",
    visits: 0,
    leads: 0,
    conversionRate: 0,
    dropOffReason: "Noch keine Daten vorhanden.",
    nextOptimization: "Frage, Score und CRM-Feld definieren.",
    type: "Auswahlfrage",
    question: `Neue Qualifizierungsfrage ${index + 1}`,
    options: ["Option A", "Option B", "Option C"],
    score: 10,
    required: true,
    crmField: `funnel_step_${index + 1}`,
    condition: "Wenn Antwort Option A ist",
    target: "Nächster Schritt",
    analyticsEvent: "step_view",
  };
}

export function FunnelCommandCenter({
  funnels,
  language,
  leads,
  projectLabel,
  projects,
  steps,
  users,
}: FunnelCommandCenterProps) {
  const text = labels[language];
  const [activeView, setActiveView] = useState<FunnelView>("all");
  const [activeTab, setActiveTab] = useState<BuilderTab>("overview");
  const [searchTerm, setSearchTerm] = useState("");
  const [localFunnelIds, setLocalFunnelIds] = useState<string[]>([]);
  const [selectedFunnelId, setSelectedFunnelId] = useState(funnels[0]?.id ?? "");
  const [editedFunnels, setEditedFunnels] = useState<Record<string, EditableFunnel>>(() =>
    Object.fromEntries(funnels.map((funnel) => [funnel.id, normalizeFunnel(funnel)])),
  );
  const [editedSteps, setEditedSteps] = useState<Record<string, EditableStep[]>>(() =>
    Object.fromEntries(
      funnels.map((funnel) => [
        funnel.id,
        steps
          .filter((step) => step.funnelId === funnel.id)
          .map((step, index) => normalizeStep(step, index)),
      ]),
    ),
  );
  const [selectedStepId, setSelectedStepId] = useState("");
  const [trackingEvents, setTrackingEvents] = useState(defaultTrackingEvents);
  const [monitor, setMonitor] = useState<Array<{ label: string; detail: string; status: string }>>([
    { label: "Funnel geladen", detail: "Interner CRM-Monitor bereit", status: "intern" },
  ]);
  const [notice, setNotice] = useState("Änderungen werden in diesem CRM-Workspace sofort als Entwurf geführt.");
  const sourceFunnels = useMemo(
    () => [
      ...funnels,
      ...localFunnelIds
        .map((id) => editedFunnels[id])
        .filter((funnel): funnel is EditableFunnel => Boolean(funnel)),
    ],
    [editedFunnels, funnels, localFunnelIds],
  );

  const decoratedFunnels = useMemo(
    () =>
      sourceFunnels.map((funnel) => {
        const editable = editedFunnels[funnel.id] ?? normalizeFunnel(funnel);
        const project = projects.find((item) => item.id === editable.projectId);
        const owner = editable.ownerUserId ? users.find((item) => item.id === editable.ownerUserId) : undefined;
        const funnelSteps = editedSteps[editable.id] ?? [];
        const bottleneck = funnelSteps
          .filter((step) => step.status === "prüfen" || step.status === "blockiert")
          .sort((a, b) => a.conversionRate - b.conversionRate)[0];

        return { funnel: editable, project, owner, steps: funnelSteps, bottleneck };
      }),
    [editedFunnels, editedSteps, projects, sourceFunnels, users],
  );

  const filteredFunnels = decoratedFunnels.filter((item) => {
    const normalizedQuery = searchTerm.trim().toLowerCase();
    const hasBotStep = item.steps.some((step) => step.botRuleId || step.type === "Bot");
    const hasBlockedStep = item.steps.some((step) => step.status === "blockiert");
    const matchesView =
      activeView === "all" ||
      (activeView === "active" && item.funnel.status === "aktiv") ||
      (activeView === "optimize" && item.funnel.status === "optimieren") ||
      (activeView === "blocked" && hasBlockedStep) ||
      (activeView === "bots" && hasBotStep);
    const searchable = [
      item.funnel.name,
      item.funnel.goal,
      item.funnel.audience,
      item.funnel.entryChannel,
      item.funnel.status,
      item.project?.name,
      item.owner?.name,
      item.steps.map((step) => `${step.name} ${step.dropOffReason} ${step.nextOptimization}`).join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return matchesView && (!normalizedQuery || searchable.includes(normalizedQuery));
  });

  const selected = 
    decoratedFunnels.find((item) => item.funnel.id === selectedFunnelId) ??
    filteredFunnels[0] ??
    decoratedFunnels[0];
  const selectedSteps = selected ? editedSteps[selected.funnel.id] ?? [] : [];
  const selectedStep = selectedSteps.find((step) => step.id === selectedStepId) ?? selectedSteps[0];
  const selectedBlueprint = selected
    ? buildFunnelBlueprint({
        funnel: selected.funnel,
        owner: selected.owner,
        project: selected.project,
        steps: selectedSteps,
      })
    : null;
  const selectedPreviewUrl = selectedBlueprint
    ? `/preview/${selectedBlueprint.id}?device=mobile&mode=test&token=local`
    : "";
  const totalVisits = decoratedFunnels.reduce((sum, item) => sum + item.funnel.visits, 0);
  const totalLeads = decoratedFunnels.reduce((sum, item) => sum + item.funnel.leads, 0);
  const avgConversion = totalVisits > 0 ? (totalLeads / totalVisits) * 100 : 0;
  const blockedSteps = decoratedFunnels.flatMap((item) => item.steps).filter((step) => step.status === "blockiert");
  const botSteps = decoratedFunnels.flatMap((item) => item.steps).filter((step) => step.botRuleId || step.type === "Bot");
  const relatedLeads = selected ? leads.filter((lead) => lead.projectId === selected.funnel.projectId) : leads;
  const tabs: Array<{ id: BuilderTab; label: string }> = [
    { id: "overview", label: "Übersicht" },
    { id: "editor", label: "Funnel bearbeiten" },
    { id: "design", label: "Design" },
    { id: "steps", label: "Schritte" },
    { id: "logic", label: "Logik" },
    { id: "messages", label: "Messages" },
    { id: "tracking", label: "Tracking" },
    { id: "analytics", label: "Analyse" },
    { id: "privacy", label: "Datenschutz" },
    { id: "experiments", label: "A/B-Tests" },
    { id: "handover", label: "CRM-Übergabe" },
    { id: "workspace", label: "Workspace" },
    { id: "preview", label: "Vorschau" },
  ];
  const views: Array<{ id: FunnelView; label: string; count: number }> = [
    { id: "all", label: text.all, count: decoratedFunnels.length },
    { id: "active", label: text.active, count: decoratedFunnels.filter((item) => item.funnel.status === "aktiv").length },
    { id: "optimize", label: text.optimize, count: decoratedFunnels.filter((item) => item.funnel.status === "optimieren").length },
    { id: "blocked", label: text.blocked, count: blockedSteps.length },
    { id: "bots", label: text.bots, count: botSteps.length },
  ];

  function updateSelectedFunnel(patch: Partial<EditableFunnel>) {
    if (!selected) return;
    const nextFunnel = { ...selected.funnel, ...patch };
    setEditedFunnels((current) => ({
      ...current,
      [selected.funnel.id]: nextFunnel,
    }));
    if (patch.projectId || patch.entryChannel) {
      setEditedSteps((current) => ({
        ...current,
        [selected.funnel.id]: (current[selected.funnel.id] ?? []).map((step) => ({
          ...step,
          projectId: nextFunnel.projectId,
          channel: nextFunnel.entryChannel === "Website" ? "Website" : nextFunnel.entryChannel,
        })),
      }));
    }
  }

  function updateStep(stepId: string, patch: Partial<EditableStep>) {
    if (!selected) return;
    setEditedSteps((current) => ({
      ...current,
      [selected.funnel.id]: (current[selected.funnel.id] ?? []).map((step) =>
        step.id === stepId ? { ...step, ...patch } : step,
      ),
    }));
  }

  function addStep() {
    if (!selected) return;
    setEditedSteps((current) => {
      const currentSteps = current[selected.funnel.id] ?? [];
      const nextStep = createStep(selected.funnel, currentSteps.length);
      setSelectedStepId(nextStep.id);
      return {
        ...current,
        [selected.funnel.id]: [...currentSteps, nextStep],
      };
    });
    setActiveTab("steps");
    setNotice("Neuer Funnel-Schritt wurde im CRM-Builder angelegt.");
  }

  function createNewFunnel() {
    const project = projects.find((item) => item.name === projectLabel) ?? projects[0];
    const owner = users[0];
    const workspaceId = funnels[0]?.workspaceId ?? project?.workspaceId ?? "ws_novalure";

    if (!project) return;

    const funnel = createFunnel({ project, user: owner, workspaceId });
    const funnelSteps = createDefaultSteps(funnel);
    setEditedFunnels((current) => ({ ...current, [funnel.id]: funnel }));
    setEditedSteps((current) => ({ ...current, [funnel.id]: funnelSteps }));
    setLocalFunnelIds((current) => [...current, funnel.id]);
    setSelectedFunnelId(funnel.id);
    setSelectedStepId(funnelSteps[0]?.id ?? "");
    setActiveView("all");
    setActiveTab("editor");
    pushMonitor("Neuer Funnel", `${funnel.name} wurde für ${project.name} angelegt`, "CRM");
    setNotice("Neuer Funnel erstellt: Projekt, Lead-Ziel, Pipeline und Verantwortlicher können jetzt bearbeitet werden.");
  }

  function duplicateStep() {
    if (!selected || !selectedStep) return;
    const copy: EditableStep = {
      ...selectedStep,
      id: `step_copy_${Date.now()}`,
      name: `${selectedStep.name} Kopie`,
      question: `${selectedStep.question} Kopie`,
    };
    setEditedSteps((current) => ({
      ...current,
      [selected.funnel.id]: [...(current[selected.funnel.id] ?? []), copy],
    }));
    setSelectedStepId(copy.id);
    setNotice("Schritt wurde dupliziert und bleibt Teil desselben CRM-Funnels.");
  }

  function removeStep() {
    if (!selected || !selectedStep || selectedSteps.length <= 1) return;
    setEditedSteps((current) => ({
      ...current,
      [selected.funnel.id]: (current[selected.funnel.id] ?? []).filter((step) => step.id !== selectedStep.id),
    }));
    setSelectedStepId(selectedSteps[0]?.id ?? "");
    setNotice("Schritt wurde aus dem Funnel-Entwurf entfernt.");
  }

  function pushMonitor(label: string, detail: string, status = "intern") {
    setMonitor((current) => [{ label, detail, status }, ...current].slice(0, 8));
  }

  function saveDraft() {
    if (!selected) return;
    pushMonitor("Funnel gespeichert", `${selected.funnel.name} als CRM-Entwurf aktualisiert`, "CRM");
    setNotice("Gespeichert: Funnel, Schritte, Logik, Tracking und CRM-Übergabe sind zusammengeführt.");
  }

  function simulateTracking(event: TrackingEvent) {
    if (!selected) return;
    const status = selected.funnel.consentMode === "aktiv" ? "Pixel + GA4" : "intern";
    pushMonitor(event.label, `Meta ${event.meta} / GA4 ${event.ga}`, status);
  }

  function selectFunnel(id: string) {
    setSelectedFunnelId(id);
    setSelectedStepId((editedSteps[id] ?? [])[0]?.id ?? "");
  }

  if (!selected) {
    return (
      <section className="rounded-lg border border-stone-200 bg-white p-5 text-sm text-stone-600">
        {text.noFunnels}
      </section>
    );
  }

  const generatedSnippet = `<script>
  window.novalureFunnel = {
    funnelId: "${selected.funnel.id}",
    metaPixelId: "${selected.funnel.metaPixelId || "META_PIXEL_ID"}",
    metaCapi: "${selected.funnel.metaCapiToken ? "configured" : "server-token-fehlt"}",
    gaMeasurementId: "${selected.funnel.gaMeasurementId || "G-XXXXXXXX"}",
    gtmId: "${selected.funnel.gtmId || "GTM-XXXXXXX"}",
    matomoSiteId: "${selected.funnel.matomoSiteId || "optional"}",
    consentMode: "${selected.funnel.consentMode}",
    leadDestination: "${selected.funnel.leadDestination}",
    webhookUrl: "${selected.funnel.webhookUrl || "optional"}"
  };
  // Events: PageView, ViewContent, Lead, Schedule, generate_lead
  // Browser Pixel und Server CAPI teilen sich eine Event-ID zur Deduplizierung.
</script>`;

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {projectLabel}
            </p>
            <h3 className="mt-1 text-2xl font-semibold">{text.title}</h3>
            <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">
              {text.description}
            </p>
            <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
              {notice}
            </p>
          </div>
          <div className="grid min-w-0 gap-3 xl:min-w-[360px]">
            <button
              className="rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
              onClick={createNewFunnel}
              type="button"
            >
              Neuen Funnel erstellen
            </button>
            <div className="grid min-w-0 grid-cols-2 gap-2 text-sm 2xl:grid-cols-4">
              {[
                { label: text.visits, value: formatNumber(totalVisits, language) },
                { label: text.leads, value: formatNumber(totalLeads, language) },
                { label: text.avgConversion, value: `${formatPercent(avgConversion, language)}%` },
                { label: text.liveLeads, value: leads.length },
              ].map((metric) => (
                <div className="min-w-0 rounded-md bg-stone-50 p-3" key={metric.label}>
                  <p className="font-semibold">{metric.value}</p>
                  <p className="break-words text-xs text-stone-500">{metric.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </article>

      <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex flex-wrap gap-2">
            {views.map((view) => (
              <button
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  activeView === view.id
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-stone-200 bg-stone-50 text-stone-700 hover:border-emerald-200 hover:bg-emerald-50"
                }`}
                key={view.id}
                onClick={() => setActiveView(view.id)}
                type="button"
              >
                {view.label} · {view.count}
              </button>
            ))}
          </div>

          <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.search}
            <input
              className="mt-2 w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={text.searchPlaceholder}
              type="search"
              value={searchTerm}
            />
          </label>

          <div className="mt-5 grid gap-3">
            {filteredFunnels.map((item) => {
              const isSelected = selected.funnel.id === item.funnel.id;

              return (
                <button
                  aria-pressed={isSelected}
                  className={`min-w-0 rounded-lg border p-4 text-left transition ${
                    isSelected
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-stone-200 bg-stone-50 text-slate-950 hover:border-emerald-200 hover:bg-emerald-50"
                  }`}
                  key={item.funnel.id}
                  onClick={() => selectFunnel(item.funnel.id)}
                  type="button"
                >
                  <span className="flex min-w-0 items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-semibold">{item.funnel.name}</span>
                      <span className={`mt-1 block break-words text-xs ${isSelected ? "text-slate-300" : "text-stone-500"}`}>
                        {item.project?.name ?? projectLabel} · {item.funnel.goal}
                      </span>
                    </span>
                    <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${isSelected ? "border-white/10 bg-white/10 text-white" : statusStyles[item.funnel.status]}`}>
                      {item.funnel.status}
                    </span>
                  </span>
                  <span className="mt-3 grid min-w-0 gap-2 text-xs">
                    <span className={`min-w-0 rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : channelStyles[item.funnel.entryChannel]}`}>
                      {item.funnel.entryChannel}
                    </span>
                    <span className={`min-w-0 rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"}`}>
                      {formatNumber(item.funnel.visits, language)} Besuche · {item.funnel.leads} Leads
                    </span>
                    <span className={`min-w-0 rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-emerald-300/20 text-emerald-100" : "bg-emerald-50 text-emerald-800"}`}>
                      {formatPercent(item.funnel.conversionRate, language)}% Conversion
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-w-0 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                {text.selectedFunnel}
              </p>
              <h4 className="mt-1 break-words text-2xl font-semibold text-slate-950">
                {selected.funnel.name}
              </h4>
              <p className="mt-2 break-words text-sm text-stone-600">
                {selected.project?.name ?? projectLabel} · {selected.funnel.audience} · {selected.funnel.entryChannel}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800" onClick={addStep} type="button">
                {text.addStep}
              </button>
              <button className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white" onClick={saveDraft} type="button">
                {text.save}
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <button
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  activeTab === tab.id
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-stone-200 bg-stone-50 text-stone-700 hover:border-emerald-200 hover:bg-emerald-50"
                }`}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "overview" ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-3">
              {[
                ["Ziel", selected.funnel.goal],
                ["Lead-Ziel", selected.funnel.leadDestination],
                ["CRM-Phase", selected.funnel.crmStage],
                ["Follow-up", selected.funnel.followUp],
                ["Besuche", formatNumber(selected.funnel.visits, language)],
                ["Leads", selected.funnel.leads],
                ["Conversion", `${formatPercent(selected.funnel.conversionRate, language)}%`],
              ].map(([label, value]) => (
                <div className="rounded-lg bg-stone-50 p-4" key={label}>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
                  <p className="mt-2 break-words text-sm font-semibold text-slate-950">{value}</p>
                </div>
              ))}
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950 xl:col-span-3">
                <p className="text-sm font-semibold">Ein CRM, ein Funnel-Workspace</p>
                <p className="mt-2 break-words text-sm">
                  Diese Ansicht bearbeitet denselben Funnel, der links gelistet ist. Schritte, Logik, Tracking, Analyse und Übergabe sind Tabs derselben CRM-Anwendung.
                </p>
              </div>
              <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-emerald-950 xl:col-span-3">
                <p className="text-sm font-semibold">Adaptierungs-Prompt für diesen Builder</p>
                <p className="mt-2 break-words text-sm">{selected.funnel.adaptationBrief}</p>
              </div>
            </div>
          ) : null}

          {activeTab === "editor" ? (
            <div className="mt-5 grid min-w-0 gap-4 xl:grid-cols-2">
              <label className={fieldLabelClass}>
                Funnel-Vorlage
                <select className={selectClass} value={selected.funnel.templateUseCase} onChange={(event) => updateSelectedFunnel({ templateUseCase: event.target.value as EditableFunnel["templateUseCase"] })}>
                  <option>Immobilien Käufer</option>
                  <option>Immobilien Verkäufer</option>
                  <option>Termin</option>
                  <option>B2B Lead</option>
                  <option>Newsletter</option>
                  <option>Custom</option>
                </select>
              </label>
              <label className={fieldLabelClass}>
                Funnel-Name
                <input className={inputClass} value={selected.funnel.name} onChange={(event) => updateSelectedFunnel({ name: event.target.value })} />
              </label>
              <label className={fieldLabelClass}>
                Projekt
                <select
                  className={selectClass}
                  value={selected.funnel.projectId}
                  onChange={(event) => updateSelectedFunnel({ projectId: event.target.value })}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name} · {project.type}
                    </option>
                  ))}
                </select>
              </label>
              <label className={fieldLabelClass}>
                Ziel
                <input className={inputClass} value={selected.funnel.goal} onChange={(event) => updateSelectedFunnel({ goal: event.target.value })} />
              </label>
              <label className={fieldLabelClass}>
                Zielgruppe
                <select className={selectClass} value={selected.funnel.audience} onChange={(event) => updateSelectedFunnel({ audience: event.target.value as EditableFunnel["audience"] })}>
                  <option>Käufer</option>
                  <option>Verkäufer</option>
                  <option>Investor</option>
                  <option>Bauträger</option>
                </select>
              </label>
              <label className={fieldLabelClass}>
                Einstiegskanal
                <select className={selectClass} value={selected.funnel.entryChannel} onChange={(event) => updateSelectedFunnel({ entryChannel: event.target.value as EditableFunnel["entryChannel"] })}>
                  <option>Website</option>
                  <option>Landingpage</option>
                  <option>WhatsApp</option>
                  <option>Instagram</option>
                  <option>Newsletter</option>
                </select>
              </label>
              <label className={fieldLabelClass}>
                Status
                <select className={selectClass} value={selected.funnel.status} onChange={(event) => updateSelectedFunnel({ status: event.target.value as EditableFunnel["status"] })}>
                  <option value="aktiv">aktiv</option>
                  <option value="optimieren">optimieren</option>
                  <option value="entwurf">entwurf</option>
                </select>
              </label>
              <label className={fieldLabelClass}>
                Verantwortlich
                <select className={selectClass} value={selected.funnel.ownerUserId ?? ""} onChange={(event) => updateSelectedFunnel({ ownerUserId: event.target.value })}>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                  ))}
                </select>
              </label>
              <label className={fieldLabelClass}>
                Leads laufen nach
                <select
                  className={selectClass}
                  value={selected.funnel.leadDestination}
                  onChange={(event) =>
                    updateSelectedFunnel({
                      leadDestination: event.target.value as EditableFunnel["leadDestination"],
                      triggerAppointment: event.target.value === "Kalender",
                      triggerLeadInbox: event.target.value !== "Newsletter Segment",
                    })
                  }
                >
                  <option>Lead Inbox</option>
                  <option>Pipeline</option>
                  <option>Kalender</option>
                  <option>Newsletter Segment</option>
                </select>
              </label>
              <label className={fieldLabelClass}>
                Pipeline-Phase
                <input
                  className={inputClass}
                  value={selected.funnel.crmStage}
                  onChange={(event) => updateSelectedFunnel({ crmStage: event.target.value })}
                />
              </label>
              <label className={fieldLabelClass}>
                Terminbuchung
                <select className={selectClass} value={selected.funnel.bookingProvider} onChange={(event) => updateSelectedFunnel({ bookingProvider: event.target.value as EditableFunnel["bookingProvider"], triggerAppointment: true })}>
                  <option>CRM Kalender</option>
                  <option>Calendly</option>
                  <option>Meeting-Kalender</option>
                  <option>Cal.com</option>
                  <option>Externer Kalender</option>
                </select>
              </label>
            </div>
          ) : null}
          {activeTab === "design" ? (
            <div className="mt-5 min-w-0">
              {selectedBlueprint ? (
                <FunnelBlueprintDesigner
                  initialBlueprint={selectedBlueprint}
                  key={selectedBlueprint.id}
                  onEvent={(event) => pushMonitor(event.label, event.detail, event.status)}
                />
              ) : null}
            </div>
          ) : null}

          {activeTab === "steps" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
              <div className="grid min-w-0 gap-2">
                {selectedSteps.map((step, index) => (
                  <button
                    className={`min-w-0 rounded-lg border p-3 text-left ${selectedStep?.id === step.id ? "border-slate-950 bg-slate-950 text-white" : "border-stone-200 bg-stone-50 text-slate-950"}`}
                    key={step.id}
                    onClick={() => setSelectedStepId(step.id)}
                    type="button"
                  >
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] opacity-70">Schritt {index + 1}</span>
                    <span className="mt-1 block break-words text-sm font-semibold">{step.name}</span>
                    <span className="mt-2 block break-words text-xs opacity-70">{step.type} · Score {step.score} · {step.conversionRate}%</span>
                  </button>
                ))}
              </div>
              {selectedStep ? (
                <div className={mutedCardClass}>
                  <div className="grid min-w-0 gap-4">
                    <label className={fieldLabelClass}>Name<input className={inputClass} value={selectedStep.name} onChange={(event) => updateStep(selectedStep.id, { name: event.target.value })} /></label>
                    <label className={fieldLabelClass}>Frage oder Inhalt<textarea className={textareaClass} value={selectedStep.question} onChange={(event) => updateStep(selectedStep.id, { question: event.target.value })} /></label>
                    <label className={fieldLabelClass}>Typ<select className={selectClass} value={selectedStep.type} onChange={(event) => updateStep(selectedStep.id, { type: event.target.value as EditableStepType })}>{stepTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
                    <label className={fieldLabelClass}>Antwortoptionen<textarea className={textareaClass} value={selectedStep.options.join("\n")} onChange={(event) => updateStep(selectedStep.id, { options: event.target.value.split("\n").filter(Boolean) })} /></label>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                      <label className={fieldLabelClass}>Score<input className={inputClass} type="number" value={selectedStep.score} onChange={(event) => updateStep(selectedStep.id, { score: Number(event.target.value) })} /></label>
                      <label className={fieldLabelClass}>CRM-Feld<input className={inputClass} value={selectedStep.crmField} onChange={(event) => updateStep(selectedStep.id, { crmField: event.target.value })} /></label>
                      <label className={`${fieldLabelClass} sm:col-span-2`}>Pflicht<select className={selectClass} value={String(selectedStep.required)} onChange={(event) => updateStep(selectedStep.id, { required: event.target.value === "true" })}><option value="true">Ja</option><option value="false">Nein</option></select></label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={duplicateStep} type="button">{text.duplicate}</button>
                      <button className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900" onClick={removeStep} type="button">{text.remove}</button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "logic" ? (
            <div className="mt-5 grid min-w-0 gap-3">
              {selectedSteps.map((step, index) => (
                <div className={`${mutedCardClass} grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(180px,0.7fr)]`} key={step.id}>
                  <label className={fieldLabelClass}>Wenn<input className={inputClass} value={step.condition} onChange={(event) => updateStep(step.id, { condition: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Dann zu<input className={inputClass} value={step.target} onChange={(event) => updateStep(step.id, { target: event.target.value })} /></label>
                  <div className="min-w-0 rounded-md bg-white p-3 text-sm"><p className="font-semibold">Map</p><p className="mt-1 break-words text-stone-600">Schritt {index + 1}: {step.name}</p></div>
                </div>
              ))}
            </div>
          ) : null}

          {activeTab === "messages" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={mutedCardClass}>
                <p className="text-sm font-semibold">Follow-up Automation</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className={fieldLabelClass}>Sequenz<textarea className={textareaClass} value={selected.funnel.emailSequence} onChange={(event) => updateSelectedFunnel({ emailSequence: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Bedingung<input className={inputClass} value={selected.funnel.messageCondition} onChange={(event) => updateSelectedFunnel({ messageCondition: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Delays<input className={inputClass} value={selected.funnel.messageDelay} onChange={(event) => updateSelectedFunnel({ messageDelay: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Absender<input className={inputClass} value={selected.funnel.replySender} onChange={(event) => updateSelectedFunnel({ replySender: event.target.value })} /></label>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">WhatsApp, DOI und Lead Magnet</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className="flex min-w-0 items-start gap-2 text-sm font-semibold"><input className="mt-0.5 shrink-0" checked={selected.funnel.whatsappInbox} onChange={(event) => updateSelectedFunnel({ whatsappInbox: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">WhatsApp Inbox am Lead aktivieren</span></label>
                  <label className="flex min-w-0 items-start gap-2 text-sm font-semibold"><input className="mt-0.5 shrink-0" checked={selected.funnel.doubleOptIn} onChange={(event) => updateSelectedFunnel({ doubleOptIn: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">Double Opt-in / OTP vor Automation</span></label>
                  <label className={fieldLabelClass}>Lead Magnet<input className="w-full min-w-0 max-w-full rounded-md border border-blue-200 px-3 py-2 text-sm" placeholder="PDF, Checkliste, Bewertung, Projekt-Update" value={selected.funnel.leadMagnet} onChange={(event) => updateSelectedFunnel({ leadMagnet: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Newsletter Segment<input className="w-full min-w-0 max-w-full rounded-md border border-blue-200 px-3 py-2 text-sm" value={selected.funnel.newsletterSegment} onChange={(event) => updateSelectedFunnel({ newsletterSegment: event.target.value })} /></label>
                </div>
              </div>
              <div className={`${cardClass} 2xl:col-span-2`}>
                <p className="text-sm font-semibold">CRM-Status-Trigger</p>
                <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {["Neu", "Qualifiziert", "Termin offen", "Besichtigung gebucht"].map((stage, index) => (
                    <div className="rounded-md bg-stone-50 p-3 text-sm" key={stage}>
                      <p className="font-semibold">{stage}</p>
                      <p className="mt-1 text-stone-600">{index === 0 ? "Sofort bestätigen" : index === 1 ? "Sales informieren" : index === 2 ? "Reminder senden" : "Vorbereitung senden"}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "tracking" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={`${mutedCardClass} grid gap-3`}>
                <p className="text-sm font-semibold">Pixel, Analytics und Consent</p>
                <label className={fieldLabelClass}>Meta Pixel ID<input className={inputClass} value={selected.funnel.metaPixelId} onChange={(event) => updateSelectedFunnel({ metaPixelId: event.target.value })} placeholder="123456789012345" /></label>
                <label className={fieldLabelClass}>Meta Conversion API Token<input className={inputClass} value={selected.funnel.metaCapiToken} onChange={(event) => updateSelectedFunnel({ metaCapiToken: event.target.value })} placeholder="Server Token für deduplizierte Events" /></label>
                <label className={fieldLabelClass}>Google Analytics GA4 ID<input className={inputClass} value={selected.funnel.gaMeasurementId} onChange={(event) => updateSelectedFunnel({ gaMeasurementId: event.target.value })} placeholder="G-XXXXXXXXXX" /></label>
                <label className={fieldLabelClass}>Google Tag Manager<input className={inputClass} value={selected.funnel.gtmId} onChange={(event) => updateSelectedFunnel({ gtmId: event.target.value })} placeholder="GTM-XXXXXXX" /></label>
                <label className={fieldLabelClass}>Matomo Site ID<input className={inputClass} value={selected.funnel.matomoSiteId} onChange={(event) => updateSelectedFunnel({ matomoSiteId: event.target.value })} placeholder="Optional für eigenes Tracking" /></label>
                <label className={fieldLabelClass}>Consent und Sendestatus<select className={selectClass} value={selected.funnel.consentMode} onChange={(event) => updateSelectedFunnel({ consentMode: event.target.value as EditableFunnel["consentMode"] })}><option value="intern">Nur intern überwachen</option><option value="bereit">Bereit, wartet auf Consent</option><option value="aktiv">Aktiv senden</option></select></label>
              </div>
              <div className="grid min-w-0 gap-2">
                {trackingEvents.map((event) => (
                  <label className="flex min-w-0 items-start gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm" key={event.id}>
                    <input checked={event.enabled} className="mt-1 h-4 w-4 shrink-0" onChange={() => setTrackingEvents((current) => current.map((item) => item.id === event.id ? { ...item, enabled: !item.enabled } : item))} type="checkbox" />
                    <span className="min-w-0"><span className="block font-semibold">{event.label}</span><span className="block break-words text-xs text-stone-500">Meta: {event.meta} · GA4: {event.ga}</span></span>
                    <button className="ml-auto shrink-0 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold" onClick={(buttonEvent) => { buttonEvent.preventDefault(); simulateTracking(event); }} type="button">Test</button>
                  </label>
                ))}
              </div>
              <div className={`${cardClass} 2xl:col-span-2`}>
                <p className="text-sm font-semibold">Server-Side Events und CRM-Datenfluss</p>
                <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-2">
                  <label className={fieldLabelClass}>Webhook oder Automations-Endpunkt<input className={inputClass} value={selected.funnel.webhookUrl} onChange={(event) => updateSelectedFunnel({ webhookUrl: event.target.value })} placeholder="https://hooks.crm.local/funnel-lead" /></label>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3 text-sm text-stone-700">
                    <p className="font-semibold text-stone-950">Event-Deduplizierung</p>
                    <p className="mt-1 break-words">Browser Pixel und Conversion API verwenden dieselbe Event-ID. UTM, gclid, fbclid, Projekt, Funnel, Schritt und Lead-Score werden am Lead gespeichert.</p>
                  </div>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-stone-200 bg-slate-950 p-4 text-white 2xl:col-span-2">
                <p className="text-sm font-semibold">Live Event Monitor</p>
                <div className="mt-3 grid gap-2">
                  {monitor.map((item, index) => (
                    <div className="rounded-md bg-white/10 p-3 text-sm" key={`${item.label}_${index}`}><p className="font-semibold">{item.label} · {item.status}</p><p className="mt-1 break-words text-slate-300">{item.detail}</p></div>
                  ))}
                </div>
                <pre className="mt-4 max-w-full overflow-auto rounded-md bg-black/30 p-3 text-xs text-slate-200">{generatedSnippet}</pre>
              </div>
            </div>
          ) : null}

          {activeTab === "analytics" ? (
            <div className="mt-5 grid gap-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4"><p className="text-xs uppercase tracking-[0.16em] text-stone-500">Besuche</p><p className="mt-2 text-2xl font-semibold">{selected.funnel.visits.toLocaleString("de-DE")}</p></div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4"><p className="text-xs uppercase tracking-[0.16em] text-stone-500">Leads</p><p className="mt-2 text-2xl font-semibold">{selected.funnel.leads}</p></div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4"><p className="text-xs uppercase tracking-[0.16em] text-stone-500">Conversion</p><p className="mt-2 text-2xl font-semibold">{selected.funnel.conversionRate.toFixed(1)}%</p></div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4"><p className="text-xs uppercase tracking-[0.16em] text-stone-500">Hot Leads</p><p className="mt-2 text-2xl font-semibold">{relatedLeads.filter((lead) => lead.score >= 80).length}</p></div>
              </div>
              <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
                <div className="grid gap-3">
                  {selectedSteps.map((step) => (
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={step.id}>
                      <div className="flex items-center justify-between gap-3 text-sm"><p className="font-semibold">{step.name}</p><span>{step.visits - step.leads} Absprünge</span></div>
                      <div className="mt-3 h-3 overflow-hidden rounded-full bg-stone-200"><div className="h-3 rounded-full bg-emerald-700" style={{ width: `${Math.max(4, Math.min(100, step.conversionRate))}%` }} /></div>
                      <p className="mt-2 break-words text-xs text-stone-600">{step.dropOffReason}</p>
                    </div>
                  ))}
                </div>
                <div className="grid gap-3">
                  {["utm_source: meta", "utm_campaign: immobilien_graz_q2", "device: mobile", "gclid/fbclid gespeichert"].map((item) => (
                    <div className="rounded-lg border border-stone-200 bg-white p-4 text-sm font-semibold" key={item}>{item}</div>
                  ))}
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                    <p className="font-semibold">Nächste Optimierung</p>
                    <p className="mt-1">Größter Hebel: Step mit höchstem Drop-off zuerst testen, dann Quelle, Gerät und Variante vergleichen.</p>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "privacy" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={mutedCardClass}>
                <p className="text-sm font-semibold">Consent, Datenschutz und Datenhaltung</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className={fieldLabelClass}>Cookie Consent<select className={selectClass} value={selected.funnel.cookieConsent} onChange={(event) => updateSelectedFunnel({ cookieConsent: event.target.value as EditableFunnel["cookieConsent"] })}><option>Standalone Banner</option><option>Website Consent</option><option>Openli</option><option>Custom Code</option></select></label>
                  <label className={fieldLabelClass}>Datenaufbewahrung<input className={inputClass} value={selected.funnel.dataRetention} onChange={(event) => updateSelectedFunnel({ dataRetention: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Sensitive Fields<input className={inputClass} value={selected.funnel.sensitiveMode} onChange={(event) => updateSelectedFunnel({ sensitiveMode: event.target.value })} /></label>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">Compliance-Checkliste</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  {["Consent vor Pixel-Feuerung", "Double Opt-in für Newsletter-Leads", "Export und Löschung am Lead", "Rollenrechte für Kunden-Workspace", "Tracking nur mit Event-ID und Zweck"].map((item) => (
                    <label className="flex min-w-0 items-start gap-2" key={item}><input className="mt-0.5 shrink-0" defaultChecked type="checkbox" /> <span className="min-w-0 break-words">{item}</span></label>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "experiments" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={mutedCardClass}>
                <p className="text-sm font-semibold">A/B-Test Steuerung</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className={fieldLabelClass}>Variante<input className={inputClass} value={selected.funnel.abVariant} onChange={(event) => updateSelectedFunnel({ abVariant: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Traffic Split<input className={inputClass} value={selected.funnel.trafficSplit} onChange={(event) => updateSelectedFunnel({ trafficSplit: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Gewinner-Regel<input className={inputClass} value={selected.funnel.winningRule} onChange={(event) => updateSelectedFunnel({ winningRule: event.target.value })} /></label>
                </div>
              </div>
              <div className={cardClass}>
                <p className="text-sm font-semibold">Testideen aus Analyse</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  {["Hero-Versprechen gegen konkreten Termin-Nutzen testen", "Mehrstufiges Formular gegen Kontaktformular am Ende testen", "WhatsApp-Follow-up gegen E-Mail-Sequenz testen", "Kalender vor Kontaktformular bei Hot Leads testen"].map((item) => (
                    <div className="min-w-0 rounded-md bg-stone-50 p-3 break-words" key={item}>{item}</div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "handover" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
              <div className="min-w-0 self-start rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">CRM-Übergabe</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  <label className="flex min-w-0 items-start gap-2"><input className="mt-0.5 shrink-0" checked={selected.funnel.triggerLeadInbox} onChange={(event) => updateSelectedFunnel({ triggerLeadInbox: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">Lead Inbox Eintrag erzeugen</span></label>
                  <label className="flex min-w-0 items-start gap-2"><input className="mt-0.5 shrink-0" checked={selected.funnel.triggerTask} onChange={(event) => updateSelectedFunnel({ triggerTask: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">Aufgabe für Verantwortlichen erzeugen</span></label>
                  <label className="flex min-w-0 items-start gap-2"><input className="mt-0.5 shrink-0" checked={selected.funnel.triggerAppointment} onChange={(event) => updateSelectedFunnel({ triggerAppointment: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">Hot Leads zum Kalender führen</span></label>
                </div>
              </div>
              <div className={mutedCardClass}>
                <div className="grid min-w-0 gap-4">
                <label className={fieldLabelClass}>
                  Leads laufen nach
                  <select
                    className={selectClass}
                    value={selected.funnel.leadDestination}
                    onChange={(event) =>
                      updateSelectedFunnel({
                        leadDestination: event.target.value as EditableFunnel["leadDestination"],
                      })
                    }
                  >
                    <option>Lead Inbox</option>
                    <option>Pipeline</option>
                    <option>Kalender</option>
                    <option>Newsletter Segment</option>
                  </select>
                </label>
                <label className={fieldLabelClass}>Pipeline-Phase<input className={inputClass} value={selected.funnel.crmStage} onChange={(event) => updateSelectedFunnel({ crmStage: event.target.value })} /></label>
                <label className={fieldLabelClass}>Status-Vorlage<select className={selectClass} value={selected.funnel.statusTemplate} onChange={(event) => updateSelectedFunnel({ statusTemplate: event.target.value })}>{statusTemplateOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
                <label className={fieldLabelClass}>Lead-Qualitätsregel<select className={selectClass} value={selected.funnel.leadQualityRule} onChange={(event) => updateSelectedFunnel({ leadQualityRule: event.target.value })}>{leadQualityRules.map((option) => <option key={option}>{option}</option>)}</select></label>
                <label className={fieldLabelClass}>Benachrichtigungen<input className={inputClass} value={selected.funnel.notificationRecipients} onChange={(event) => updateSelectedFunnel({ notificationRecipients: event.target.value })} placeholder="Sales, Projektleitung, Kunde" /></label>
                <label className={fieldLabelClass}>Follow-up<textarea className={textareaClass} value={selected.funnel.followUp} onChange={(event) => updateSelectedFunnel({ followUp: event.target.value })} /></label>
                </div>
              </div>
              <div className={`${cardClass} 2xl:col-span-2`}>
                <p className="text-sm font-semibold">Verknüpfte Leads im aktuellen Projekt</p>
                <div className="mt-3 grid min-w-0 gap-2">
                  {relatedLeads.map((lead) => (
                    <div className="grid min-w-0 gap-2 rounded-md bg-stone-50 p-3 text-sm xl:grid-cols-[minmax(0,1fr)_96px_minmax(160px,auto)]" key={lead.id}>
                      <span className="min-w-0 break-words font-semibold">{lead.intent}</span><span className="shrink-0">Score {lead.score}</span><span className="min-w-0 break-words">{lead.nextAction}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "workspace" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={mutedCardClass}>
                <p className="text-sm font-semibold">Workspace, Kundenrechte und Agentur-Modus</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className={fieldLabelClass}>Zugriff<select className={selectClass} value={selected.funnel.workspaceAccess} onChange={(event) => updateSelectedFunnel({ workspaceAccess: event.target.value as EditableFunnel["workspaceAccess"] })}><option>Intern</option><option>Kunde Betrachter</option><option>Kunde Bearbeiter</option><option>Agentur White Label</option></select></label>
                  <label className={fieldLabelClass}>Brand Preset<input className={inputClass} value={selected.funnel.brandPreset} onChange={(event) => updateSelectedFunnel({ brandPreset: event.target.value })} /></label>
                  <label className={fieldLabelClass}>Eigene Domain<input className={inputClass} value={selected.funnel.customDomain} onChange={(event) => updateSelectedFunnel({ customDomain: event.target.value })} placeholder="funnels.novalure.local/wohnpark-graz" /></label>
                </div>
              </div>
              <div className={cardClass}>
                <p className="text-sm font-semibold">Projekt-Kontext</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  <div className="min-w-0 rounded-md bg-stone-50 p-3"><span className="block text-xs uppercase tracking-[0.16em] text-stone-500">Projekt</span><span className="block min-w-0 break-words font-semibold">{selected.project?.name ?? projectLabel}</span></div>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3"><span className="block text-xs uppercase tracking-[0.16em] text-stone-500">Lead-Ziel</span><span className="block min-w-0 break-words font-semibold">{selected.funnel.leadDestination}</span></div>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3"><span className="block text-xs uppercase tracking-[0.16em] text-stone-500">Owner</span><span className="block min-w-0 break-words font-semibold">{users.find((user) => user.id === selected.funnel.ownerUserId)?.name ?? "Nicht zugewiesen"}</span></div>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "preview" ? (
            <div className="mt-5 grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4">
                {selectedBlueprint ? (
                  <FunnelRenderer
                    blueprint={selectedBlueprint}
                    device={selected.funnel.mobileFirstMode ? "mobile" : "desktop"}
                    mode="test"
                    onEvent={(event) => pushMonitor(event.label, event.detail, event.status)}
                  />
                ) : null}
              </div>
              <div className="min-w-0 rounded-lg border border-stone-200 bg-white p-4">
                <p className="text-sm font-semibold">Preview und Testmodus</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  <div className="min-w-0 rounded-md bg-stone-50 p-3">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Schema</span>
                    <span className="block break-words font-semibold">Funnel Blueprint v{selectedBlueprint?.schemaVersion}</span>
                  </div>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Felder</span>
                    <span className="block break-words font-semibold">17 Feldtypen vorbereitet</span>
                  </div>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">CRM-Ziel</span>
                    <span className="block break-words font-semibold">{selected.funnel.leadDestination} / {selected.funnel.crmStage}</span>
                  </div>
                  <a className="block min-w-0 rounded-md bg-slate-950 px-3 py-2 text-center text-sm font-semibold text-white" href={selectedPreviewUrl} rel="noreferrer" target="_blank">
                    Preview-URL öffnen
                  </a>
                </div>
              </div>
            </div>
          ) : null}

        </section>
      </section>
    </section>
  );
}


