"use client";

import { useEffect, useMemo, useState } from "react";
import { FunnelBlueprintDesigner } from "@/components/funnel-blueprint-designer";
import { FunnelRenderer } from "@/components/funnel-renderer";
import { buildFunnelBlueprint } from "@/lib/funnel-builder-adapter";
import type { Funnel, FunnelStep, Lead, Project, WorkspaceUser } from "@/lib/crm-types";
import type { FunnelBlueprint } from "@/lib/funnel-schema";
import {
  formatNumber,
  getCrmEnumLabel,
  getCrmLeadTypeLabel,
  getCrmSourceLabel,
  getCrmStatusLabel,
  getCrmSystemTextLabel,
  getFunnelBookingProviderLabel,
  getFunnelCommandCenterCopy,
  getFunnelDestinationLabel,
  getFunnelStepTypeLabel,
  getFunnelTemplateUseCaseLabel,
  getFunnelWorkspaceAccessLabel,
  getLocale,
  type LanguageCode,
} from "@/lib/i18n";

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
type FunnelCommandCenterText = ReturnType<typeof getFunnelCommandCenterCopy>;

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

const trackingEventConfigs = [
  { id: "page_view", labelKey: "pageView", meta: "PageView", ga: "page_view", enabled: true },
  { id: "funnel_start", labelKey: "start", meta: "ViewContent", ga: "funnel_start", enabled: true },
  { id: "step_view", labelKey: "stepView", meta: "ViewContent", ga: "funnel_step_view", enabled: true },
  { id: "answer", labelKey: "answer", meta: "CustomizeProduct", ga: "funnel_answer", enabled: true },
  { id: "lead", labelKey: "lead", meta: "Lead", ga: "generate_lead", enabled: true },
  { id: "appointment", labelKey: "appointment", meta: "Schedule", ga: "book_appointment", enabled: true },
] as const;

const fieldLabelClass = "grid min-w-0 gap-1 text-sm font-semibold text-slate-900";
const inputClass = "w-full min-w-0 max-w-full rounded-md border border-stone-300 px-3 py-2 text-sm";
const selectClass = "w-full min-w-0 max-w-full rounded-md border border-stone-300 px-3 py-2 text-sm";
const textareaClass = "w-full min-h-24 min-w-0 max-w-full resize-y rounded-md border border-stone-300 px-3 py-2 text-sm";
const cardClass = "min-w-0 rounded-lg border border-stone-200 bg-white p-4";
const mutedCardClass = "min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4";

function formatPercent(value: number, language: LanguageCode) {
  return new Intl.NumberFormat(getLocale(language), {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(value);
}

function isUuid(value: string | undefined | null) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function getFunnelLiveReadiness(blueprint: FunnelBlueprint, funnel: EditableFunnel) {
  const formFields = collectFunnelFormFields(blueprint);
  const blockers: string[] = [];

  if (!blueprint.name.trim()) blockers.push("name_missing");
  if (!blueprint.projectId.trim()) blockers.push("project_missing");
  if (formFields.length === 0) blockers.push("contact_form_missing");
  if (!hasPrivacyConsentField(formFields)) blockers.push("privacy_consent_missing");
  if (!blueprint.crmHandover.destination.trim()) blockers.push("crm_handover_missing");

  for (const field of formFields) {
    if (field.required && !String(field.label ?? "").trim()) {
      blockers.push("required_field_label_missing");
    }
  }

  const status = blockers.length
    ? "blocked"
    : funnel.status === "aktiv"
      ? "live"
      : funnel.status === "optimieren"
        ? "optimize"
        : "test";

  return {
    blockers: Array.from(new Set(blockers)),
    publicTokenAvailable: isUuid(funnel.id),
    status,
  };
}

function collectFunnelFormFields(blueprint: FunnelBlueprint) {
  return blueprint.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.rows.flatMap((row) =>
        row.columns.flatMap((column) =>
          column.elements.flatMap((element) => element.type === "form" ? element.fields ?? [] : []),
        ),
      ),
    ),
  );
}

function hasPrivacyConsentField(fields: ReturnType<typeof collectFunnelFormFields>) {
  return fields.some((field) => {
    const searchable = [
      field.type,
      field.crmField,
      field.label,
      field.helpText,
    ].map((value) => String(value ?? "").toLowerCase()).join(" ");

    return searchable.includes("privacy")
      || searchable.includes("datenschutz")
      || searchable.includes("consent")
      || searchable.includes("dsgvo")
      || searchable.includes("gdpr");
  });
}

function normalizeFunnel(funnel: Funnel, text: FunnelCommandCenterText): EditableFunnel {
  const isNewsletter = funnel.entryChannel === "Newsletter";
  const isAppointment = funnel.goal.toLowerCase().includes("termin") || funnel.goal.toLowerCase().includes("besichtigung");

  return {
    ...funnel,
    adaptationBrief: text.defaults.adaptationPrompt,
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
    brandPreset: text.defaults.brandPreset,
    highlightColor: "#047857",
    customDomain: "",
    mobileFirstMode: true,
    headerMode: "Logo",
    landingPageBlocks: ["Hero", "Projektvideo", "Testimonials", "Kalender"],
    designerHeroTitle: funnel.goal,
    designerHeroSubtitle: text.defaults.designerSubtitle(funnel.audience),
    designerCtaLabel: isAppointment ? text.defaults.designerCtaAppointment : text.defaults.designerCtaLead,
    designerLogoText: funnel.name.split(" ")[0] ?? "Novalure",
    designerBackgroundColor: "#ffffff",
    designerTextColor: "#020617",
    designerBlockText: text.defaults.designerBlockText,
    designerFontPreset: "System",
    designerButtonRadius: "8",
    designerBlockRadius: "8",
    designerSectionSpacing: "16",
    bookingProvider: "CRM Kalender",
    leadMagnet: isNewsletter ? text.defaults.leadMagnet : "",
    newsletterSegment: isNewsletter ? `${funnel.audience} Segment` : "",
    doubleOptIn: isNewsletter,
    whatsappInbox: funnel.entryChannel === "WhatsApp",
    emailSequence: isAppointment
      ? text.defaults.emailSequenceAppointment
      : text.defaults.emailSequenceLead,
    messageCondition: text.defaults.messageCondition,
    messageDelay: text.defaults.messageDelay,
    replySender: "Novalure Sales",
    crmStage: funnel.status === "aktiv" ? "Qualifiziert" : "Lead Inbox",
    followUp:
      funnel.entryChannel === "WhatsApp"
        ? text.defaults.followUpWhatsapp
        : text.defaults.followUpDefault,
    leadDestination: "Lead Inbox",
    metaPixelId: "",
    metaCapiToken: "",
    gaMeasurementId: "",
    gtmId: "",
    matomoSiteId: "",
    consentMode: "intern",
    cookieConsent: "Website Consent",
    dataRetention: text.defaults.dataRetention,
    sensitiveMode: text.defaults.sensitiveMode,
    webhookUrl: "",
    abVariant: text.defaults.newFunnelAbVariant,
    trafficSplit: "50/50",
    winningRule: text.defaults.winningRule,
    workspaceAccess: "Intern",
    statusTemplate: text.statusTemplateOptions[0],
    notificationRecipients: "Franz, Sales Graz",
    leadQualityRule: text.leadQualityRules[1],
    triggerLeadInbox: true,
    triggerTask: true,
    triggerAppointment: isAppointment,
  };
}

function normalizeStep(step: FunnelStep, index: number, text: FunnelCommandCenterText): EditableStep {
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
    condition: text.defaults.conditionQualified,
    target: text.defaults.nextStep,
    analyticsEvent: index === 0 ? "funnel_start" : "step_view",
  };
}

function createFunnel({
  text,
  project,
  user,
  workspaceId,
}: {
  text: FunnelCommandCenterText;
  project: Project;
  user?: WorkspaceUser;
  workspaceId: string;
}): EditableFunnel {
  const id = `funnel_new_${new Date().getTime()}`;

  return {
    id,
    workspaceId,
    projectId: project.id,
    name: text.defaults.newFunnelName(project.name),
    goal: text.defaults.newFunnelGoal,
    audience: "Käufer",
    entryChannel: "Website",
    status: "entwurf",
    visits: 0,
    leads: 0,
    conversionRate: 0,
    ownerUserId: user?.id,
    adaptationBrief: text.defaults.adaptationPrompt,
    templateUseCase: "Immobilien Käufer",
    brandPreset: text.defaults.brandPreset,
    highlightColor: "#047857",
    customDomain: "",
    mobileFirstMode: true,
    headerMode: "Logo",
    landingPageBlocks: ["Hero", "Projektvideo", "Testimonials", "Kalender"],
    designerHeroTitle: text.defaults.newFunnelGoal,
    designerHeroSubtitle: text.defaults.newFunnelSubtitle,
    designerCtaLabel: text.defaults.designerCtaLead,
    designerLogoText: project.name,
    designerBackgroundColor: "#ffffff",
    designerTextColor: "#020617",
    designerBlockText: text.defaults.designerBlockText,
    designerFontPreset: "System",
    designerButtonRadius: "8",
    designerBlockRadius: "8",
    designerSectionSpacing: "16",
    bookingProvider: "CRM Kalender",
    leadMagnet: "",
    newsletterSegment: "",
    doubleOptIn: false,
    whatsappInbox: false,
    emailSequence: text.defaults.emailSequenceAppointment,
    messageCondition: text.defaults.messageCondition,
    messageDelay: text.defaults.messageDelay,
    replySender: "Novalure Sales",
    crmStage: "Lead Inbox",
    followUp: text.defaults.newFunnelFollowUp,
    leadDestination: "Lead Inbox",
    metaPixelId: "",
    metaCapiToken: "",
    gaMeasurementId: "",
    gtmId: "",
    matomoSiteId: "",
    consentMode: "intern",
    cookieConsent: "Website Consent",
    dataRetention: text.defaults.dataRetention,
    sensitiveMode: text.defaults.sensitiveMode,
    webhookUrl: "",
    abVariant: text.defaults.newFunnelAbVariant,
    trafficSplit: "50/50",
    winningRule: text.defaults.winningRule,
    workspaceAccess: "Intern",
    statusTemplate: text.statusTemplateOptions[0],
    notificationRecipients: "Franz, Sales Graz",
    leadQualityRule: text.leadQualityRules[1],
    triggerLeadInbox: true,
    triggerTask: true,
    triggerAppointment: false,
  };
}

function createDefaultSteps(funnel: EditableFunnel, text: FunnelCommandCenterText): EditableStep[] {
  return [
    {
      ...createStep(funnel, 0, text),
      name: text.defaults.entryStepName,
      type: "Auswahlfrage",
      question: text.defaults.entryStepQuestion,
      options: [...text.defaults.entryStepOptions],
      score: 12,
      crmField: "interest",
      analyticsEvent: "funnel_start",
    },
    {
      ...createStep(funnel, 1, text),
      name: text.defaults.qualifyStepName,
      type: "Auswahlfrage",
      question: text.defaults.qualifyStepQuestion,
      options: [...text.defaults.qualifyStepOptions],
      score: 18,
      crmField: "timeline",
      analyticsEvent: "step_view",
    },
    {
      ...createStep(funnel, 2, text),
      name: text.defaults.contactStepName,
      type: "Kontaktformular",
      channel: "Website",
      question: text.defaults.contactStepQuestion,
      options: [...text.defaults.contactStepOptions],
      score: 25,
      crmField: "contact",
      analyticsEvent: "lead",
    },
  ];
}

function createStep(funnel: EditableFunnel, index: number, text: FunnelCommandCenterText): EditableStep {
  return {
    id: `step_new_${new Date().getTime()}`,
    workspaceId: funnel.workspaceId,
    projectId: funnel.projectId,
    funnelId: funnel.id,
    name: text.defaults.newStepName(index),
    channel: funnel.entryChannel === "Website" ? "Website" : funnel.entryChannel,
    status: "entwurf",
    visits: 0,
    leads: 0,
    conversionRate: 0,
    dropOffReason: text.defaults.noData,
    nextOptimization: text.defaults.nextOptimization,
    type: "Auswahlfrage",
    question: text.defaults.newStepQuestion(index),
    options: ["Option A", "Option B", "Option C"],
    score: 10,
    required: true,
    crmField: `funnel_step_${index + 1}`,
    condition: text.defaults.conditionOptionA,
    target: text.defaults.nextStep,
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
  const text = getFunnelCommandCenterCopy(language);
  const [activeView, setActiveView] = useState<FunnelView>("all");
  const [activeTab, setActiveTab] = useState<BuilderTab>("overview");
  const [searchTerm, setSearchTerm] = useState("");
  const [localFunnelIds, setLocalFunnelIds] = useState<string[]>([]);
  const [selectedFunnelId, setSelectedFunnelId] = useState(funnels[0]?.id ?? "");
  const [editedFunnels, setEditedFunnels] = useState<Record<string, EditableFunnel>>(() =>
    Object.fromEntries(funnels.map((funnel) => [funnel.id, normalizeFunnel(funnel, text)])),
  );
  const [editedSteps, setEditedSteps] = useState<Record<string, EditableStep[]>>(() =>
    Object.fromEntries(
      funnels.map((funnel) => [
        funnel.id,
        steps
          .filter((step) => step.funnelId === funnel.id)
          .map((step, index) => normalizeStep(step, index, text)),
      ]),
    ),
  );
  const [selectedStepId, setSelectedStepId] = useState("");
  const [trackingEvents, setTrackingEvents] = useState<TrackingEvent[]>(() =>
    trackingEventConfigs.map(({ labelKey, ...event }) => ({
      ...event,
      label: text.tracking.events[labelKey],
    })),
  );
  const [monitor, setMonitor] = useState<Array<{ label: string; detail: string; status: string }>>([
    { label: text.monitorLoaded, detail: text.monitorReady, status: text.internal },
  ]);
  const [notice, setNotice] = useState<string>(text.draftNotice);
  const [draftSaving, setDraftSaving] = useState(false);
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
        const editable = editedFunnels[funnel.id] ?? normalizeFunnel(funnel, text);
        const project = projects.find((item) => item.id === editable.projectId);
        const owner = editable.ownerUserId ? users.find((item) => item.id === editable.ownerUserId) : undefined;
        const funnelSteps = editedSteps[editable.id] ?? [];
        const bottleneck = funnelSteps
          .filter((step) => step.status === "prüfen" || step.status === "blockiert")
          .sort((a, b) => a.conversionRate - b.conversionRate)[0];

        return { funnel: editable, project, owner, steps: funnelSteps, bottleneck };
      }),
    [editedFunnels, editedSteps, projects, sourceFunnels, text, users],
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
    ? `/preview/${selectedBlueprint.id}?device=mobile&mode=test&lang=${language}&token=local`
    : "";
  const selectedReadiness = selectedBlueprint && selected ? getFunnelLiveReadiness(selectedBlueprint, selected.funnel) : null;
  const totalVisits = decoratedFunnels.reduce((sum, item) => sum + item.funnel.visits, 0);
  const totalLeads = decoratedFunnels.reduce((sum, item) => sum + item.funnel.leads, 0);
  const avgConversion = totalVisits > 0 ? (totalLeads / totalVisits) * 100 : 0;
  const blockedSteps = decoratedFunnels.flatMap((item) => item.steps).filter((step) => step.status === "blockiert");
  const botSteps = decoratedFunnels.flatMap((item) => item.steps).filter((step) => step.botRuleId || step.type === "Bot");
  const relatedLeads = selected ? leads.filter((lead) => lead.projectId === selected.funnel.projectId) : leads;
  const tabs: Array<{ id: BuilderTab; label: string }> = [
    { id: "overview", label: text.tabs.overview },
    { id: "editor", label: text.tabs.editor },
    { id: "design", label: text.tabs.design },
    { id: "steps", label: text.tabs.steps },
    { id: "logic", label: text.tabs.logic },
    { id: "messages", label: text.tabs.messages },
    { id: "tracking", label: text.tabs.tracking },
    { id: "analytics", label: text.tabs.analytics },
    { id: "privacy", label: text.tabs.privacy },
    { id: "experiments", label: text.tabs.experiments },
    { id: "handover", label: text.tabs.handover },
    { id: "workspace", label: text.tabs.workspace },
    { id: "preview", label: text.tabs.preview },
  ];
  const customerTabIds: BuilderTab[] = ["overview", "editor", "design", "steps", "logic", "handover", "preview"];
  const primaryTabs = tabs.filter((tab) => customerTabIds.includes(tab.id));
  const advancedTabs = tabs.filter((tab) => !customerTabIds.includes(tab.id));
  const isDesignerMode = activeTab === "design";
  const backToFunnelsLabel = language === "de" ? "Zurück zur Funnel-Liste" : "Back to funnel list";
  const editorModeLabel = language === "de" ? "Editor-Modus" : "Editor mode";
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
      const nextStep = createStep(selected.funnel, currentSteps.length, text);
      setSelectedStepId(nextStep.id);
      return {
        ...current,
        [selected.funnel.id]: [...currentSteps, nextStep],
      };
    });
    setActiveTab("steps");
    setNotice(text.newStepNotice);
  }

  function createNewFunnel() {
    const project = projects.find((item) => item.name === projectLabel) ?? projects[0];
    const owner = users[0];
    const workspaceId = funnels[0]?.workspaceId ?? project?.workspaceId ?? "ws_novalure";

    if (!project) return;

    const funnel = createFunnel({ text, project, user: owner, workspaceId });
    const funnelSteps = createDefaultSteps(funnel, text);
    setEditedFunnels((current) => ({ ...current, [funnel.id]: funnel }));
    setEditedSteps((current) => ({ ...current, [funnel.id]: funnelSteps }));
    setLocalFunnelIds((current) => [...current, funnel.id]);
    setSelectedFunnelId(funnel.id);
    setSelectedStepId(funnelSteps[0]?.id ?? "");
    setActiveView("all");
    setActiveTab("editor");
    pushMonitor(text.newFunnel, text.newFunnelDetail(funnel.name, project.name), "CRM");
    setNotice(text.newFunnelNotice);
  }

  function duplicateStep() {
    if (!selected || !selectedStep) return;
    const copy: EditableStep = {
      ...selectedStep,
      id: `step_copy_${new Date().getTime()}`,
      name: `${selectedStep.name} ${text.stepCopySuffix}`,
      question: `${selectedStep.question} ${text.stepCopySuffix}`,
    };
    setEditedSteps((current) => ({
      ...current,
      [selected.funnel.id]: [...(current[selected.funnel.id] ?? []), copy],
    }));
    setSelectedStepId(copy.id);
    setNotice(text.duplicateNotice);
  }

  function removeStep() {
    if (!selected || !selectedStep || selectedSteps.length <= 1) return;
    setEditedSteps((current) => ({
      ...current,
      [selected.funnel.id]: (current[selected.funnel.id] ?? []).filter((step) => step.id !== selectedStep.id),
    }));
    setSelectedStepId(selectedSteps[0]?.id ?? "");
    setNotice(text.removeNotice);
  }

  function pushMonitor(label: string, detail: string, status = "intern") {
    setMonitor((current) => [{ label, detail, status }, ...current].slice(0, 8));
  }

  async function saveDraft() {
    if (!selected || draftSaving) return;
    const originalId = selected.funnel.id;
    setDraftSaving(true);

    try {
      const response = await fetch("/api/crm/funnels", {
        body: JSON.stringify({ funnel: selected.funnel, steps: selectedSteps }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(text.saveFailed);
      }

      const payload = await response.json() as { funnel?: EditableFunnel; stepIds?: string[] };
      if (!payload.funnel?.id) {
        throw new Error(text.saveFailed);
      }

      const persistedFunnel = { ...selected.funnel, ...payload.funnel };
      const persistedSteps = selectedSteps.map((step, index) => ({
        ...step,
        funnelId: persistedFunnel.id,
        id: payload.stepIds?.[index] ?? step.id,
        projectId: persistedFunnel.projectId,
        workspaceId: persistedFunnel.workspaceId,
      }));

      setEditedFunnels((current) => {
        const next = { ...current };
        delete next[originalId];
        return { ...next, [persistedFunnel.id]: persistedFunnel };
      });
      setEditedSteps((current) => {
        const next = { ...current };
        delete next[originalId];
        return { ...next, [persistedFunnel.id]: persistedSteps };
      });
      setLocalFunnelIds((current) => [
        persistedFunnel.id,
        ...current.filter((id) => id !== originalId && id !== persistedFunnel.id),
      ]);
      setSelectedFunnelId(persistedFunnel.id);
      setSelectedStepId(persistedSteps[0]?.id ?? "");
      pushMonitor(text.saved, text.savedDetail(persistedFunnel.name), "CRM");
      setNotice(text.savedNotice);
    } catch {
      setNotice(text.saveFailed);
    } finally {
      setDraftSaving(false);
    }
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

  useEffect(() => {
    if (!isDesignerMode) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isDesignerMode]);

  if (!selected) {
    return (
      <section className="rounded-lg border border-stone-200 bg-white p-5 text-sm text-stone-600">
        {text.noFunnels}
      </section>
    );
  }

  if (isDesignerMode && selectedBlueprint) {
    return (
      <section className="fixed inset-0 z-50 flex min-h-0 flex-col bg-[#eef7ff] text-slate-950">
        <header className="shrink-0 border-b border-stone-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
          <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <button
                className="shrink-0 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                onClick={() => setActiveTab("overview")}
                type="button"
              >
                {backToFunnelsLabel}
              </button>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                  {editorModeLabel}
                </p>
                <h3 className="mt-1 break-words text-xl font-semibold text-slate-950">
                  {selected.funnel.name}
                </h3>
                <p className="mt-1 break-words text-xs text-stone-600">
                  {selected.project?.name ?? projectLabel} · {getCrmLeadTypeLabel(selected.funnel.audience, language)} · {getCrmSourceLabel(selected.funnel.entryChannel, language)}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                onClick={() => setActiveTab("steps")}
                type="button"
              >
                {text.tabs.steps}
              </button>
              <button
                className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={draftSaving}
                onClick={() => void saveDraft()}
                type="button"
              >
                {draftSaving ? text.saving : text.save}
              </button>
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden px-3 py-3">
          <FunnelBlueprintDesigner
            initialBlueprint={selectedBlueprint}
            key={selectedBlueprint.id}
            language={language}
            onEvent={(event) => pushMonitor(event.label, event.detail, event.status)}
            variant="immersive"
          />
        </div>
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
              {text.createFunnel}
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
                      {getCrmStatusLabel(item.funnel.status, language)}
                    </span>
                  </span>
                  <span className="mt-3 grid min-w-0 gap-2 text-xs">
                    <span className={`min-w-0 rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : channelStyles[item.funnel.entryChannel]}`}>
                      {getCrmSourceLabel(item.funnel.entryChannel, language)}
                    </span>
                    <span className={`min-w-0 rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"}`}>
                      {formatNumber(item.funnel.visits, language)} {text.visits} · {formatNumber(item.funnel.leads, language)} {text.leads}
                    </span>
                    <span className={`min-w-0 rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-emerald-300/20 text-emerald-100" : "bg-emerald-50 text-emerald-800"}`}>
                      {formatPercent(item.funnel.conversionRate, language)}% {text.conversion}
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
                {selected.project?.name ?? projectLabel} · {getCrmLeadTypeLabel(selected.funnel.audience, language)} · {getCrmSourceLabel(selected.funnel.entryChannel, language)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800" onClick={addStep} type="button">
                {text.addStep}
              </button>
              <button
                className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={draftSaving}
                onClick={() => void saveDraft()}
                type="button"
              >
                {draftSaving ? text.saving : text.save}
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {primaryTabs.map((tab) => (
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
            <details className="relative">
              <summary className={`list-none rounded-md border px-3 py-2 text-sm font-semibold ${
                advancedTabs.some((tab) => activeTab === tab.id)
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-stone-200 bg-stone-50 text-stone-700 hover:border-emerald-200 hover:bg-emerald-50"
              }`}>
                {text.tabs.advanced}
              </summary>
              <div className="absolute right-0 z-20 mt-2 grid min-w-56 gap-1 rounded-lg border border-stone-200 bg-white p-2 shadow-lg">
                {advancedTabs.map((tab) => (
                  <button
                    className={`rounded-md px-3 py-2 text-left text-sm font-semibold ${activeTab === tab.id ? "bg-slate-950 text-white" : "text-stone-700 hover:bg-stone-50"}`}
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </details>
          </div>

          {activeTab === "overview" ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-3">
              {[
                [text.overview.goal, selected.funnel.goal],
                [text.overview.leadTarget, getFunnelDestinationLabel(selected.funnel.leadDestination, language)],
                [text.overview.crmStage, selected.funnel.crmStage],
                [text.overview.followUp, selected.funnel.followUp],
                [text.visits, formatNumber(selected.funnel.visits, language)],
                [text.leads, formatNumber(selected.funnel.leads, language)],
                [text.conversion, `${formatPercent(selected.funnel.conversionRate, language)}%`],
              ].map(([label, value]) => (
                <div className="rounded-lg bg-stone-50 p-4" key={label}>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
                  <p className="mt-2 break-words text-sm font-semibold text-slate-950">{value}</p>
                </div>
              ))}
              {selectedReadiness ? (
                <div className={`rounded-lg border p-4 xl:col-span-3 ${selectedReadiness.status === "blocked" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-emerald-200 bg-emerald-50 text-emerald-950"}`}>
                  <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{text.overview.liveReadinessTitle}</p>
                      <p className="mt-2 break-words text-sm">
                        {text.overview.liveStatus}: {
                          selectedReadiness.status === "blocked"
                            ? text.overview.liveStatusBlocked
                            : selectedReadiness.status === "live"
                              ? text.overview.liveStatusLive
                              : selectedReadiness.status === "optimize"
                                ? text.overview.liveStatusOptimize
                                : text.overview.liveStatusTest
                        }
                      </p>
                      <p className="mt-1 break-words text-sm">
                        {text.overview.publicToken}: {selectedReadiness.publicTokenAvailable ? text.overview.publicTokenAvailable : text.overview.publicTokenMissing}
                      </p>
                    </div>
                    <span className="rounded-md bg-white px-3 py-2 text-xs font-semibold">
                      {selectedReadiness.blockers.length ? text.overview.preflightBlockers : text.overview.preflightReady}
                    </span>
                  </div>
                  {selectedReadiness.blockers.length ? (
                    <ul className="mt-3 grid gap-2 text-sm">
                      {selectedReadiness.blockers.map((blocker) => {
                        const key = blocker.split(":")[0] as keyof typeof text.overview.preflightBlockerNames;
                        return <li className="break-words" key={blocker}>- {text.overview.preflightBlockerNames[key] ?? blocker}</li>;
                      })}
                    </ul>
                  ) : null}
                  <p className="mt-3 break-words text-sm">{text.overview.liveLinkHint}</p>
                </div>
              ) : null}
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950 xl:col-span-3">
                <p className="text-sm font-semibold">{text.overview.workspaceTitle}</p>
                <p className="mt-2 break-words text-sm">
                  {text.overview.workspaceDescription}
                </p>
              </div>
              <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-emerald-950 xl:col-span-3">
                <p className="text-sm font-semibold">{text.overview.builderPromptTitle}</p>
                <p className="mt-2 break-words text-sm">{selected.funnel.adaptationBrief}</p>
              </div>
            </div>
          ) : null}

          {activeTab === "editor" ? (
            <div className="mt-5 grid min-w-0 gap-4 xl:grid-cols-2">
              <label className={fieldLabelClass}>
                {text.editor.template}
                <select className={selectClass} value={selected.funnel.templateUseCase} onChange={(event) => updateSelectedFunnel({ templateUseCase: event.target.value as EditableFunnel["templateUseCase"] })}>
                  {(["Immobilien Käufer", "Immobilien Verkäufer", "Termin", "B2B Lead", "Newsletter", "Custom"] as const).map((option) => (
                    <option key={option} value={option}>{getFunnelTemplateUseCaseLabel(option, language)}</option>
                  ))}
                </select>
              </label>
              <label className={fieldLabelClass}>
                {text.editor.name}
                <input className={inputClass} value={selected.funnel.name} onChange={(event) => updateSelectedFunnel({ name: event.target.value })} />
              </label>
              <label className={fieldLabelClass}>
                {text.editor.project}
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
                {text.editor.goal}
                <input className={inputClass} value={selected.funnel.goal} onChange={(event) => updateSelectedFunnel({ goal: event.target.value })} />
              </label>
              <label className={fieldLabelClass}>
                {text.editor.audience}
                <select className={selectClass} value={selected.funnel.audience} onChange={(event) => updateSelectedFunnel({ audience: event.target.value as EditableFunnel["audience"] })}>
                  {(["Käufer", "Verkäufer", "Investor", "Bauträger"] as const).map((option) => (
                    <option key={option} value={option}>{getCrmLeadTypeLabel(option, language)}</option>
                  ))}
                </select>
              </label>
              <label className={fieldLabelClass}>
                {text.editor.channel}
                <select className={selectClass} value={selected.funnel.entryChannel} onChange={(event) => updateSelectedFunnel({ entryChannel: event.target.value as EditableFunnel["entryChannel"] })}>
                  {(["Website", "Landingpage", "WhatsApp", "Instagram", "Newsletter"] as const).map((option) => (
                    <option key={option} value={option}>{getCrmSourceLabel(option, language)}</option>
                  ))}
                </select>
              </label>
              <label className={fieldLabelClass}>
                {text.editor.status}
                <select className={selectClass} value={selected.funnel.status} onChange={(event) => updateSelectedFunnel({ status: event.target.value as EditableFunnel["status"] })}>
                  <option value="aktiv">{text.statusOptions.aktiv}</option>
                  <option value="optimieren">{text.statusOptions.optimieren}</option>
                  <option value="entwurf">{text.statusOptions.entwurf}</option>
                </select>
              </label>
              <label className={fieldLabelClass}>
                {text.editor.owner}
                <select className={selectClass} value={selected.funnel.ownerUserId ?? ""} onChange={(event) => updateSelectedFunnel({ ownerUserId: event.target.value })}>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                  ))}
                </select>
              </label>
              <label className={fieldLabelClass}>
                {text.editor.leadDestination}
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
                  {(["Lead Inbox", "Pipeline", "Kalender", "Newsletter Segment"] as const).map((option) => (
                    <option key={option} value={option}>{getFunnelDestinationLabel(option, language)}</option>
                  ))}
                </select>
              </label>
              <label className={fieldLabelClass}>
                {text.editor.pipelineStage}
                <input
                  className={inputClass}
                  value={selected.funnel.crmStage}
                  onChange={(event) => updateSelectedFunnel({ crmStage: event.target.value })}
                />
              </label>
              <label className={fieldLabelClass}>
                {text.editor.booking}
                <select className={selectClass} value={selected.funnel.bookingProvider} onChange={(event) => updateSelectedFunnel({ bookingProvider: event.target.value as EditableFunnel["bookingProvider"], triggerAppointment: true })}>
                  {(["CRM Kalender", "Calendly", "Meeting-Kalender", "Cal.com", "Externer Kalender"] as const).map((option) => (
                    <option key={option} value={option}>{getFunnelBookingProviderLabel(option, language)}</option>
                  ))}
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
                  language={language}
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
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] opacity-70">{text.stepsPanel.step} {index + 1}</span>
                    <span className="mt-1 block break-words text-sm font-semibold">{step.name}</span>
                    <span className="mt-2 block break-words text-xs opacity-70">{getFunnelStepTypeLabel(step.type, language)} · {text.stepsPanel.score} {step.score} · {step.conversionRate}%</span>
                  </button>
                ))}
              </div>
              {selectedStep ? (
                <div className={mutedCardClass}>
                  <div className="grid min-w-0 gap-4">
                    <label className={fieldLabelClass}>{text.stepsPanel.name}<input className={inputClass} value={selectedStep.name} onChange={(event) => updateStep(selectedStep.id, { name: event.target.value })} /></label>
                    <label className={fieldLabelClass}>{text.stepsPanel.question}<textarea className={textareaClass} value={selectedStep.question} onChange={(event) => updateStep(selectedStep.id, { question: event.target.value })} /></label>
                    <label className={fieldLabelClass}>{text.stepsPanel.type}<select className={selectClass} value={selectedStep.type} onChange={(event) => updateStep(selectedStep.id, { type: event.target.value as EditableStepType })}>{stepTypes.map((type) => <option key={type} value={type}>{getFunnelStepTypeLabel(type, language)}</option>)}</select></label>
                    <label className={fieldLabelClass}>{text.stepsPanel.options}<textarea className={textareaClass} value={selectedStep.options.join("\n")} onChange={(event) => updateStep(selectedStep.id, { options: event.target.value.split("\n").filter(Boolean) })} /></label>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                      <label className={fieldLabelClass}>{text.stepsPanel.score}<input className={inputClass} type="number" value={selectedStep.score} onChange={(event) => updateStep(selectedStep.id, { score: Number(event.target.value) })} /></label>
                      <label className={fieldLabelClass}>{text.stepsPanel.crmField}<input className={inputClass} value={selectedStep.crmField} onChange={(event) => updateStep(selectedStep.id, { crmField: event.target.value })} /></label>
                      <label className={`${fieldLabelClass} sm:col-span-2`}>{text.stepsPanel.required}<select className={selectClass} value={String(selectedStep.required)} onChange={(event) => updateStep(selectedStep.id, { required: event.target.value === "true" })}><option value="true">{text.stepsPanel.yes}</option><option value="false">{text.stepsPanel.no}</option></select></label>
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
                  <label className={fieldLabelClass}>{text.logic.when}<input className={inputClass} value={step.condition} onChange={(event) => updateStep(step.id, { condition: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.logic.then}<input className={inputClass} value={step.target} onChange={(event) => updateStep(step.id, { target: event.target.value })} /></label>
                  <div className="min-w-0 rounded-md bg-white p-3 text-sm"><p className="font-semibold">{text.logic.map}</p><p className="mt-1 break-words text-stone-600">{text.stepsPanel.step} {index + 1}: {step.name}</p></div>
                </div>
              ))}
            </div>
          ) : null}

          {activeTab === "messages" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={mutedCardClass}>
                <p className="text-sm font-semibold">{text.messages.automation}</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className={fieldLabelClass}>{text.messages.sequence}<textarea className={textareaClass} value={selected.funnel.emailSequence} onChange={(event) => updateSelectedFunnel({ emailSequence: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.messages.condition}<input className={inputClass} value={selected.funnel.messageCondition} onChange={(event) => updateSelectedFunnel({ messageCondition: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.messages.delays}<input className={inputClass} value={selected.funnel.messageDelay} onChange={(event) => updateSelectedFunnel({ messageDelay: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.messages.sender}<input className={inputClass} value={selected.funnel.replySender} onChange={(event) => updateSelectedFunnel({ replySender: event.target.value })} /></label>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">{text.messages.channelTitle}</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className="flex min-w-0 items-start gap-2 text-sm font-semibold"><input className="mt-0.5 shrink-0" checked={selected.funnel.whatsappInbox} onChange={(event) => updateSelectedFunnel({ whatsappInbox: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">{text.messages.whatsapp}</span></label>
                  <label className="flex min-w-0 items-start gap-2 text-sm font-semibold"><input className="mt-0.5 shrink-0" checked={selected.funnel.doubleOptIn} onChange={(event) => updateSelectedFunnel({ doubleOptIn: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">{text.messages.doubleOptIn}</span></label>
                  <label className={fieldLabelClass}>{text.messages.leadMagnet}<input className="w-full min-w-0 max-w-full rounded-md border border-blue-200 px-3 py-2 text-sm" placeholder={text.messages.leadMagnetPlaceholder} value={selected.funnel.leadMagnet} onChange={(event) => updateSelectedFunnel({ leadMagnet: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.messages.newsletterSegment}<input className="w-full min-w-0 max-w-full rounded-md border border-blue-200 px-3 py-2 text-sm" value={selected.funnel.newsletterSegment} onChange={(event) => updateSelectedFunnel({ newsletterSegment: event.target.value })} /></label>
                </div>
              </div>
              <div className={`${cardClass} 2xl:col-span-2`}>
                <p className="text-sm font-semibold">{text.messages.statusTriggers}</p>
                <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {text.messages.statusTriggerStages.map((stage, index) => (
                    <div className="rounded-md bg-stone-50 p-3 text-sm" key={stage}>
                      <p className="font-semibold">{stage}</p>
                      <p className="mt-1 text-stone-600">{text.messages.triggerDescriptions[index] ?? text.messages.triggerDescriptions[0]}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "tracking" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={`${mutedCardClass} grid gap-3`}>
                <p className="text-sm font-semibold">{text.tracking.setupTitle}</p>
                <label className={fieldLabelClass}>Meta Pixel ID<input className={inputClass} value={selected.funnel.metaPixelId} onChange={(event) => updateSelectedFunnel({ metaPixelId: event.target.value })} placeholder="123456789012345" /></label>
                <label className={fieldLabelClass}>{text.tracking.metaCapi}<input className={inputClass} value={selected.funnel.metaCapiToken} onChange={(event) => updateSelectedFunnel({ metaCapiToken: event.target.value })} placeholder={text.tracking.metaCapiPlaceholder} /></label>
                <label className={fieldLabelClass}>Google Analytics GA4 ID<input className={inputClass} value={selected.funnel.gaMeasurementId} onChange={(event) => updateSelectedFunnel({ gaMeasurementId: event.target.value })} placeholder="G-XXXXXXXXXX" /></label>
                <label className={fieldLabelClass}>Google Tag Manager<input className={inputClass} value={selected.funnel.gtmId} onChange={(event) => updateSelectedFunnel({ gtmId: event.target.value })} placeholder="GTM-XXXXXXX" /></label>
                <label className={fieldLabelClass}>{text.tracking.matomo}<input className={inputClass} value={selected.funnel.matomoSiteId} onChange={(event) => updateSelectedFunnel({ matomoSiteId: event.target.value })} placeholder={text.tracking.matomoPlaceholder} /></label>
                <label className={fieldLabelClass}>{text.tracking.consent}<select className={selectClass} value={selected.funnel.consentMode} onChange={(event) => updateSelectedFunnel({ consentMode: event.target.value as EditableFunnel["consentMode"] })}><option value="intern">{text.consentModeOptions.intern}</option><option value="bereit">{text.consentModeOptions.bereit}</option><option value="aktiv">{text.consentModeOptions.aktiv}</option></select></label>
              </div>
              <div className="grid min-w-0 gap-2">
                {trackingEvents.map((event) => (
                  <label className="flex min-w-0 items-start gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm" key={event.id}>
                    <input checked={event.enabled} className="mt-1 h-4 w-4 shrink-0" onChange={() => setTrackingEvents((current) => current.map((item) => item.id === event.id ? { ...item, enabled: !item.enabled } : item))} type="checkbox" />
                    <span className="min-w-0"><span className="block font-semibold">{event.label}</span><span className="block break-words text-xs text-stone-500">Meta: {event.meta} · GA4: {event.ga}</span></span>
                    <button className="ml-auto shrink-0 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold" onClick={(buttonEvent) => { buttonEvent.preventDefault(); simulateTracking(event); }} type="button">{text.tracking.test}</button>
                  </label>
                ))}
              </div>
              <div className={`${cardClass} 2xl:col-span-2`}>
                <p className="text-sm font-semibold">{text.tracking.serverTitle}</p>
                <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-2">
                  <label className={fieldLabelClass}>{text.tracking.webhook}<input className={inputClass} value={selected.funnel.webhookUrl} onChange={(event) => updateSelectedFunnel({ webhookUrl: event.target.value })} placeholder="https://hooks.crm.local/funnel-lead" /></label>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3 text-sm text-stone-700">
                    <p className="font-semibold text-stone-950">{text.tracking.dedupeTitle}</p>
                    <p className="mt-1 break-words">{text.tracking.dedupeText}</p>
                  </div>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-stone-200 bg-slate-950 p-4 text-white 2xl:col-span-2">
                <p className="text-sm font-semibold">{text.tracking.monitor}</p>
                <div className="mt-3 grid gap-2">
                  {monitor.map((item, index) => (
                    <div className="rounded-md bg-white/10 p-3 text-sm" key={`${item.label}_${index}`}><p className="font-semibold">{item.label} · {getCrmEnumLabel(item.status, language)}</p><p className="mt-1 break-words text-slate-300">{item.detail}</p></div>
                  ))}
                </div>
                <pre className="mt-4 max-w-full overflow-auto rounded-md bg-black/30 p-3 text-xs text-slate-200">{generatedSnippet}</pre>
              </div>
            </div>
          ) : null}

          {activeTab === "analytics" ? (
            <div className="mt-5 grid gap-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4"><p className="text-xs uppercase tracking-[0.16em] text-stone-500">{text.visits}</p><p className="mt-2 text-2xl font-semibold">{formatNumber(selected.funnel.visits, language)}</p></div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4"><p className="text-xs uppercase tracking-[0.16em] text-stone-500">{text.leads}</p><p className="mt-2 text-2xl font-semibold">{formatNumber(selected.funnel.leads, language)}</p></div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4"><p className="text-xs uppercase tracking-[0.16em] text-stone-500">{text.conversion}</p><p className="mt-2 text-2xl font-semibold">{formatPercent(selected.funnel.conversionRate, language)}%</p></div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4"><p className="text-xs uppercase tracking-[0.16em] text-stone-500">{text.analytics.hotLeads}</p><p className="mt-2 text-2xl font-semibold">{formatNumber(relatedLeads.filter((lead) => lead.score >= 80).length, language)}</p></div>
              </div>
              <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
                <div className="grid gap-3">
                  {selectedSteps.map((step) => (
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={step.id}>
                      <div className="flex items-center justify-between gap-3 text-sm"><p className="font-semibold">{step.name}</p><span>{formatNumber(step.visits - step.leads, language)} {text.analytics.dropOffs}</span></div>
                      <div className="mt-3 h-3 overflow-hidden rounded-full bg-stone-200"><div className="h-3 rounded-full bg-emerald-700" style={{ width: `${Math.max(4, Math.min(100, step.conversionRate))}%` }} /></div>
                      <p className="mt-2 break-words text-xs text-stone-600">{step.dropOffReason}</p>
                    </div>
                  ))}
                </div>
                <div className="grid gap-3">
                  {text.analytics.sourceSignals.map((item) => (
                    <div className="rounded-lg border border-stone-200 bg-white p-4 text-sm font-semibold" key={item}>{item}</div>
                  ))}
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                    <p className="font-semibold">{text.analytics.nextOptimization}</p>
                    <p className="mt-1">{text.analytics.nextOptimizationText}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "privacy" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={mutedCardClass}>
                <p className="text-sm font-semibold">{text.privacy.title}</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className={fieldLabelClass}>{text.privacy.cookieConsent}<select className={selectClass} value={selected.funnel.cookieConsent} onChange={(event) => updateSelectedFunnel({ cookieConsent: event.target.value as EditableFunnel["cookieConsent"] })}><option>Standalone Banner</option><option>Website Consent</option><option>Openli</option><option>Custom Code</option></select></label>
                  <label className={fieldLabelClass}>{text.privacy.retention}<input className={inputClass} value={selected.funnel.dataRetention} onChange={(event) => updateSelectedFunnel({ dataRetention: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.privacy.sensitiveFields}<input className={inputClass} value={selected.funnel.sensitiveMode} onChange={(event) => updateSelectedFunnel({ sensitiveMode: event.target.value })} /></label>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">{text.privacy.checklist}</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  {text.privacy.checklistItems.map((item) => (
                    <label className="flex min-w-0 items-start gap-2" key={item}><input className="mt-0.5 shrink-0" defaultChecked type="checkbox" /> <span className="min-w-0 break-words">{item}</span></label>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "experiments" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={mutedCardClass}>
                <p className="text-sm font-semibold">{text.experiments.title}</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className={fieldLabelClass}>{text.experiments.variant}<input className={inputClass} value={selected.funnel.abVariant} onChange={(event) => updateSelectedFunnel({ abVariant: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.experiments.trafficSplit}<input className={inputClass} value={selected.funnel.trafficSplit} onChange={(event) => updateSelectedFunnel({ trafficSplit: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.experiments.winningRule}<input className={inputClass} value={selected.funnel.winningRule} onChange={(event) => updateSelectedFunnel({ winningRule: event.target.value })} /></label>
                </div>
              </div>
              <div className={cardClass}>
                <p className="text-sm font-semibold">{text.experiments.ideasTitle}</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  {text.experiments.ideas.map((item) => (
                    <div className="min-w-0 rounded-md bg-stone-50 p-3 break-words" key={item}>{item}</div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "handover" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
              <div className="min-w-0 self-start rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">{text.handover.title}</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  <label className="flex min-w-0 items-start gap-2"><input className="mt-0.5 shrink-0" checked={selected.funnel.triggerLeadInbox} onChange={(event) => updateSelectedFunnel({ triggerLeadInbox: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">{text.handover.leadInbox}</span></label>
                  <label className="flex min-w-0 items-start gap-2"><input className="mt-0.5 shrink-0" checked={selected.funnel.triggerTask} onChange={(event) => updateSelectedFunnel({ triggerTask: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">{text.handover.task}</span></label>
                  <label className="flex min-w-0 items-start gap-2"><input className="mt-0.5 shrink-0" checked={selected.funnel.triggerAppointment} onChange={(event) => updateSelectedFunnel({ triggerAppointment: event.target.checked })} type="checkbox" /> <span className="min-w-0 break-words">{text.handover.appointment}</span></label>
                </div>
              </div>
              <div className={mutedCardClass}>
                <div className="grid min-w-0 gap-4">
                <label className={fieldLabelClass}>
                  {text.editor.leadDestination}
                  <select
                    className={selectClass}
                    value={selected.funnel.leadDestination}
                    onChange={(event) =>
                      updateSelectedFunnel({
                        leadDestination: event.target.value as EditableFunnel["leadDestination"],
                      })
                    }
                  >
                    {(["Lead Inbox", "Pipeline", "Kalender", "Newsletter Segment"] as const).map((option) => (
                      <option key={option} value={option}>{getFunnelDestinationLabel(option, language)}</option>
                    ))}
                  </select>
                </label>
                <label className={fieldLabelClass}>{text.editor.pipelineStage}<input className={inputClass} value={selected.funnel.crmStage} onChange={(event) => updateSelectedFunnel({ crmStage: event.target.value })} /></label>
                <label className={fieldLabelClass}>{text.handover.statusTemplate}<select className={selectClass} value={selected.funnel.statusTemplate} onChange={(event) => updateSelectedFunnel({ statusTemplate: event.target.value })}>{text.statusTemplateOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
                <label className={fieldLabelClass}>{text.handover.qualityRule}<select className={selectClass} value={selected.funnel.leadQualityRule} onChange={(event) => updateSelectedFunnel({ leadQualityRule: event.target.value })}>{text.leadQualityRules.map((option) => <option key={option}>{option}</option>)}</select></label>
                <label className={fieldLabelClass}>{text.handover.notifications}<input className={inputClass} value={selected.funnel.notificationRecipients} onChange={(event) => updateSelectedFunnel({ notificationRecipients: event.target.value })} placeholder={text.handover.notificationsPlaceholder} /></label>
                <label className={fieldLabelClass}>{text.overview.followUp}<textarea className={textareaClass} value={selected.funnel.followUp} onChange={(event) => updateSelectedFunnel({ followUp: event.target.value })} /></label>
                </div>
              </div>
              <div className={`${cardClass} 2xl:col-span-2`}>
                <p className="text-sm font-semibold">{text.handover.linkedLeads}</p>
                <div className="mt-3 grid min-w-0 gap-2">
                  {relatedLeads.map((lead) => (
                    <div className="grid min-w-0 gap-2 rounded-md bg-stone-50 p-3 text-sm xl:grid-cols-[minmax(0,1fr)_96px_minmax(160px,auto)]" key={lead.id}>
                      <span className="min-w-0 break-words font-semibold">{getCrmSystemTextLabel(lead.intent, language)}</span><span className="shrink-0">Score {lead.score}</span><span className="min-w-0 break-words">{getCrmSystemTextLabel(lead.nextAction, language)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "workspace" ? (
            <div className="mt-5 grid min-w-0 gap-4 2xl:grid-cols-2">
              <div className={mutedCardClass}>
                <p className="text-sm font-semibold">{text.workspace.title}</p>
                <div className="mt-3 grid min-w-0 gap-3">
                  <label className={fieldLabelClass}>{text.workspace.access}<select className={selectClass} value={selected.funnel.workspaceAccess} onChange={(event) => updateSelectedFunnel({ workspaceAccess: event.target.value as EditableFunnel["workspaceAccess"] })}>{(["Intern", "Kunde Betrachter", "Kunde Bearbeiter", "Agentur White Label"] as const).map((option) => <option key={option} value={option}>{getFunnelWorkspaceAccessLabel(option, language)}</option>)}</select></label>
                  <label className={fieldLabelClass}>{text.workspace.brandPreset}<input className={inputClass} value={selected.funnel.brandPreset} onChange={(event) => updateSelectedFunnel({ brandPreset: event.target.value })} /></label>
                  <label className={fieldLabelClass}>{text.workspace.customDomain}<input className={inputClass} value={selected.funnel.customDomain} onChange={(event) => updateSelectedFunnel({ customDomain: event.target.value })} placeholder="funnels.novalure.local/wohnpark-graz" /></label>
                </div>
              </div>
              <div className={cardClass}>
                <p className="text-sm font-semibold">{text.workspace.projectContext}</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  <div className="min-w-0 rounded-md bg-stone-50 p-3"><span className="block text-xs uppercase tracking-[0.16em] text-stone-500">{text.workspace.project}</span><span className="block min-w-0 break-words font-semibold">{selected.project?.name ?? projectLabel}</span></div>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3"><span className="block text-xs uppercase tracking-[0.16em] text-stone-500">{text.workspace.leadGoal}</span><span className="block min-w-0 break-words font-semibold">{getFunnelDestinationLabel(selected.funnel.leadDestination, language)}</span></div>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3"><span className="block text-xs uppercase tracking-[0.16em] text-stone-500">{text.workspace.owner}</span><span className="block min-w-0 break-words font-semibold">{users.find((user) => user.id === selected.funnel.ownerUserId)?.name ?? text.workspace.unassigned}</span></div>
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
                    language={language}
                    mode="test"
                    onEvent={(event) => pushMonitor(event.label, event.detail, event.status)}
                  />
                ) : null}
              </div>
              <div className="min-w-0 rounded-lg border border-stone-200 bg-white p-4">
                <p className="text-sm font-semibold">{text.preview.title}</p>
                <div className="mt-3 grid min-w-0 gap-2 text-sm">
                  <div className="min-w-0 rounded-md bg-stone-50 p-3">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.preview.schema}</span>
                    <span className="block break-words font-semibold">Funnel Blueprint v{selectedBlueprint?.schemaVersion}</span>
                  </div>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.preview.fields}</span>
                    <span className="block break-words font-semibold">{text.preview.preparedFields}</span>
                  </div>
                  <div className="min-w-0 rounded-md bg-stone-50 p-3">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.preview.crmTarget}</span>
                    <span className="block break-words font-semibold">{getFunnelDestinationLabel(selected.funnel.leadDestination, language)} / {selected.funnel.crmStage}</span>
                  </div>
                  <a className="block min-w-0 rounded-md bg-slate-950 px-3 py-2 text-center text-sm font-semibold text-white" href={selectedPreviewUrl} rel="noreferrer" target="_blank">
                    {text.preview.openUrl}
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


