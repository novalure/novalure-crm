"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CoreCrmModuleSources,
  CoreCrmModuleSource,
} from "@/lib/db/crm-loaders";
import type {
  Automation,
  CalendarEvent,
  ConsentRecord,
  Contact,
  CrmBot,
  CrmBotConversation,
  CustomerWorkspaceAccess,
  Deal,
  Funnel,
  KnowledgeItem,
  Lead,
  LeadSequenceDefinition,
  NewsletterCampaign,
  NewsletterSuppression,
  NewsletterSegment,
  PropertyReservation,
  PropertyUnit,
  Project,
  Task,
  WorkspaceUser,
} from "@/lib/crm-types";
import {
  analyzeBotGovernance,
  analyzeConsentGating,
  analyzeDataHygiene,
  analyzeSpeedToLead,
  buildCrmMaturityAssessment,
  type CrmAnalysisAudience,
  type CrmAnalysisPriority,
  type CrmMaturityAction,
  type CrmMaturityModuleId,
  type CrmMaturitySignal,
  type CrmMaturityStatus,
  summarizeCustomerAccess,
  summarizeInventory,
} from "@/lib/crm-analysis";
import {
  formatCurrency,
  formatNumber,
  getCrmAnalysisBotCopy,
  type LanguageCode,
} from "@/lib/i18n";

type AnalysisAudience = "all" | "developer" | "novalure";
type AnalysisPriority = "all" | "p0" | "p1" | "p2";
type FeatureStatus = "ready" | "partial" | "gap";
type AnalysisTab = "overview" | "sprint" | "features" | "recommendations" | "playbook";

const CLOSED_DEAL_STAGES = new Set<string>(["Gewonnen", "Verloren", "Disqualifiziert", "Abschluss"]);

type CrmAnalysisBotProps = {
  automations: Automation[];
  bots: CrmBot[];
  calendarEvents: CalendarEvent[];
  consents: ConsentRecord[];
  contacts: Contact[];
  crmBotConversations: CrmBotConversation[];
  customerWorkspaces: CustomerWorkspaceAccess[];
  dataSource: CoreCrmModuleSource;
  deals: Deal[];
  funnels: Funnel[];
  knowledgeItems: KnowledgeItem[];
  language: LanguageCode;
  leadSequences: LeadSequenceDefinition[];
  leads: Lead[];
  missingTables?: string[];
  moduleSources?: CoreCrmModuleSources;
  newsletterCampaigns: NewsletterCampaign[];
  newsletterSuppressions: NewsletterSuppression[];
  newsletterSegments: NewsletterSegment[];
  propertyReservations: PropertyReservation[];
  propertyUnits: PropertyUnit[];
  projectLabel: string;
  projects: Project[];
  tasks: Task[];
  users: WorkspaceUser[];
};

type FeatureCard = {
  id: string;
  status: FeatureStatus;
  title: string;
  evidence: string;
  nextStep: string;
};

type RecommendationCard = {
  audience: Exclude<AnalysisAudience, "all"> | "both";
  effort: string;
  impact: string;
  nextStep: string;
  priority: Exclude<AnalysisPriority, "all">;
  title: string;
  why: string;
};

type RecommendationRuntimeSummary = {
  botAnswerChecks: number;
  botAnswerReviewIssues: number;
  bulkFollowUpBatches: number;
  cleanupActions: number;
  consentCoverage: Array<{
    allowed: number;
    blocked: number;
    channel: string;
    purpose: string;
  }>;
  conversionSnapshots: number;
  fallbackAudits: number;
  followUpActions: number;
  latestConversionSnapshot: {
    closedRevenueCents: number;
    leadsCount: number;
    reservationsCount: number;
    unitSalesVelocity: number;
    wonDealsCount: number;
  } | null;
  onboardingRiskAlerts: number;
  offerMilestones: number;
  outreachDeliveries: number;
  permissionAuditWarnings: number;
  unitAuditEvents: number;
  viewingSlots: number;
};

type ScoreGapRecommendationCopy = Record<
  CrmMaturityModuleId,
  {
    impact: string;
    nextStep: string;
    title: string;
    why: string;
  }
>;

const scoreGapRecommendationConfig: Record<
  CrmMaturityModuleId,
  {
    audience: RecommendationCard["audience"];
    effort: "small" | "medium" | "large";
    priority: Exclude<AnalysisPriority, "all">;
  }
> = {
  analyticsAttribution: { audience: "both", effort: "medium", priority: "p1" },
  botGovernance: { audience: "both", effort: "small", priority: "p1" },
  calendarTeams: { audience: "both", effort: "medium", priority: "p1" },
  dataPersistence: { audience: "both", effort: "medium", priority: "p0" },
  dealPipeline: { audience: "both", effort: "medium", priority: "p1" },
  developerInventory: { audience: "developer", effort: "medium", priority: "p1" },
  funnelsForms: { audience: "both", effort: "medium", priority: "p1" },
  leadInbox: { audience: "both", effort: "medium", priority: "p1" },
  newsletterConsent: { audience: "both", effort: "small", priority: "p2" },
  novalureCustomerAccess: { audience: "novalure", effort: "medium", priority: "p1" },
  tasksSequences: { audience: "both", effort: "medium", priority: "p1" },
};

const statusStyles: Record<FeatureStatus, string> = {
  ready: "border-emerald-200 bg-emerald-50 text-emerald-900",
  partial: "border-amber-200 bg-amber-50 text-amber-900",
  gap: "border-rose-200 bg-rose-50 text-rose-900",
};

const priorityStyles: Record<CrmAnalysisPriority, string> = {
  p0: "border-slate-950 bg-slate-950 text-white",
  p1: "border-blue-200 bg-blue-50 text-blue-950",
  p2: "border-stone-200 bg-stone-50 text-stone-800",
};

const maturityStatusStyles: Record<CrmMaturityStatus, string> = {
  working: "border-emerald-200 bg-emerald-50 text-emerald-900",
  partial: "border-amber-200 bg-amber-50 text-amber-900",
  missing: "border-stone-200 bg-stone-50 text-stone-800",
  risk: "border-rose-200 bg-rose-50 text-rose-900",
};

function Badge({
  children,
  className,
}: {
  children: React.ReactNode;
  className: string;
}) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

function getAudienceMatch(
  selectedAudience: AnalysisAudience,
  recommendationAudience: RecommendationCard["audience"],
) {
  return (
    selectedAudience === "all" ||
    recommendationAudience === "both" ||
    recommendationAudience === selectedAudience
  );
}

function getActionAudienceMatch(
  selectedAudience: AnalysisAudience,
  actionAudience: CrmAnalysisAudience,
) {
  return selectedAudience === "all" || actionAudience === "both" || actionAudience === selectedAudience;
}

function renderSignalText(
  signal: CrmMaturitySignal,
  labels: Record<string, string | ((value: string) => string)>,
  language: LanguageCode,
) {
  const label = labels[signal.id];
  const formattedValue = signal.value === undefined ? "" : formatNumber(signal.value, language);

  if (typeof label === "function") {
    return label(formattedValue);
  }

  if (label) {
    return label;
  }

  return signal.value === undefined ? signal.id : `${signal.id}: ${formattedValue}`;
}

function actionCopyFor(
  action: CrmMaturityAction,
  labels: Record<string, string | undefined>,
) {
  return labels[action.id] ?? action.id;
}

export function CrmAnalysisBot({
  automations,
  bots,
  calendarEvents,
  consents,
  contacts,
  crmBotConversations,
  customerWorkspaces,
  dataSource,
  deals,
  funnels,
  knowledgeItems,
  language,
  leadSequences,
  leads,
  missingTables = [],
  moduleSources,
  newsletterCampaigns,
  newsletterSuppressions,
  newsletterSegments,
  propertyReservations,
  propertyUnits,
  projectLabel,
  projects,
  tasks,
  users,
}: CrmAnalysisBotProps) {
  const copy = getCrmAnalysisBotCopy(language);
  const [activeTab, setActiveTab] = useState<AnalysisTab>("overview");
  const [audience, setAudience] = useState<AnalysisAudience>("all");
  const [priority, setPriority] = useState<AnalysisPriority>("all");
  const [runtimeNotice, setRuntimeNotice] = useState("");
  const [runtimeSummary, setRuntimeSummary] = useState<RecommendationRuntimeSummary | null>(null);
  const missingTablesPayload = JSON.stringify(missingTables);
  const moduleSourcesPayload = JSON.stringify(moduleSources ?? {});

  const loadRuntimeSummary = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/crm/recommendation-runtime", { cache: "no-store", signal });
    if (!response.ok) return;

    const payload = (await response.json()) as { summary?: RecommendationRuntimeSummary };
    if (payload.summary) {
      setRuntimeSummary(payload.summary);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function syncRuntimeAudit() {
      try {
        await fetch("/api/crm/recommendation-runtime", {
          body: JSON.stringify({
            missingTables: JSON.parse(missingTablesPayload) as string[],
            moduleSources: JSON.parse(moduleSourcesPayload) as Record<string, string>,
            operation: "fallback_audit",
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        }).catch(() => undefined);
        await loadRuntimeSummary(controller.signal);
      } catch (error) {
        if ((error as { name?: string }).name !== "AbortError") {
          setRuntimeNotice(copy.runtime.loadError);
        }
      }
    }

    void syncRuntimeAudit();

    return () => controller.abort();
  }, [copy.runtime.loadError, loadRuntimeSummary, missingTablesPayload, moduleSourcesPayload]);

  async function runRuntimeChecks() {
    setRuntimeNotice(copy.runtime.checking);

    await fetch("/api/crm/recommendation-runtime", {
      body: JSON.stringify({
        missingTables,
        moduleSources: moduleSources ?? {},
        operation: "complete_analysis_recommendations",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    await loadRuntimeSummary();
    setRuntimeNotice(copy.runtime.saved);
  }

  const counts = useMemo(() => {
    const openTasks = tasks.filter((task) => task.status !== "done").length;
    const hotLeads = leads.filter((lead) => lead.hotStatus || lead.score >= 80).length;
    const teamsMeetings = calendarEvents.filter(
      (event) => event.teamsJoinUrl || event.meetingProvider === "microsoft-teams",
    ).length;
    const approvedKnowledge = knowledgeItems.filter((item) => item.status === "approved").length;
    const strictKnowledgeBots = bots.filter((bot) => bot.strictKnowledge).length;
    const optInRecords = consents.filter((consent) => consent.status === "Opt-in").length;
    const consentCoverage =
      contacts.length > 0 ? Math.round((optInRecords / contacts.length) * 100) : 0;
    const openDeals = deals.filter((deal) => !CLOSED_DEAL_STAGES.has(deal.stage)).length;

    return {
      activeAutomations: automations.filter((automation) =>
        ["Bereit", "Training", "Geplant"].includes(automation.status),
      ).length,
      activeFunnels: funnels.filter((funnel) => funnel.status === "aktiv").length,
      approvedKnowledge,
      consentCoverage,
      hotLeads,
      openDeals,
      openTasks,
      strictKnowledgeBots,
      teamsMeetings,
    };
  }, [automations, bots, calendarEvents, consents, contacts, deals, funnels, knowledgeItems, leads, tasks]);

  const analysisSignals = useMemo(() => {
    const speedToLeadAlerts = analyzeSpeedToLead(leads, contacts, users);
    const consentDecisions = analyzeConsentGating(contacts, consents, newsletterSuppressions);
    const dataHygieneIssues = analyzeDataHygiene(contacts, leads, consents);
    const inventory = summarizeInventory(propertyUnits, propertyReservations);
    const botGovernance = analyzeBotGovernance(bots, knowledgeItems, crmBotConversations);
    const customerAccess = summarizeCustomerAccess(customerWorkspaces);
    const maturity = buildCrmMaturityAssessment({
      bots,
      calendarEvents,
      consentDecisions,
      contacts,
      crmBotConversations,
      customerWorkspaces,
      dataHygieneIssues,
      dataSource,
      deals,
      funnels,
      knowledgeItems,
      leadSequences,
      leads,
      missingTables,
      moduleSources,
      newsletterCampaigns,
      newsletterSegments,
      newsletterSuppressions,
      propertyReservations,
      propertyUnits,
      speedToLeadAlerts,
      tasks,
    });

    return {
      botGovernance,
      consentDecisions,
      customerAccess,
      dataHygieneIssues,
      inventory,
      maturity,
      speedToLeadAlerts,
    };
  }, [
    bots,
    calendarEvents,
    consents,
    contacts,
    crmBotConversations,
    customerWorkspaces,
    dataSource,
    deals,
    funnels,
    knowledgeItems,
    leadSequences,
    leads,
    missingTables,
    moduleSources,
    newsletterCampaigns,
    newsletterSegments,
    newsletterSuppressions,
    propertyReservations,
    propertyUnits,
    tasks,
    users,
  ]);

  const features = useMemo<FeatureCard[]>(
    () => [
      {
        id: "dashboard",
        status: "ready",
        title: copy.features.dashboard.title,
        evidence: copy.features.dashboard.evidence,
        nextStep: copy.features.dashboard.nextStep,
      },
      {
        id: "leadOps",
        status: leads.length > 0 && contacts.length > 0 ? "ready" : "partial",
        title: copy.features.leadOps.title,
        evidence: copy.features.leadOps.evidence(formatNumber(leads.length, language), formatNumber(contacts.length, language)),
        nextStep: copy.features.leadOps.nextStep,
      },
      {
        id: "pipeline",
        status: deals.length > 0 ? "partial" : "gap",
        title: copy.features.pipeline.title,
        evidence: copy.features.pipeline.evidence(formatNumber(deals.length, language)),
        nextStep: copy.features.pipeline.nextStep,
      },
      {
        id: "tasks",
        status: leadSequences.length > 0 ? "ready" : "partial",
        title: copy.features.tasks.title,
        evidence: copy.features.tasks.evidence(formatNumber(tasks.length, language), formatNumber(leadSequences.length, language)),
        nextStep: copy.features.tasks.nextStep,
      },
      {
        id: "funnels",
        status: funnels.length > 0 ? "partial" : "gap",
        title: copy.features.funnels.title,
        evidence: copy.features.funnels.evidence(formatNumber(funnels.length, language)),
        nextStep: copy.features.funnels.nextStep,
      },
      {
        id: "meetings",
        status: counts.teamsMeetings > 0 ? "partial" : "gap",
        title: copy.features.meetings.title,
        evidence: copy.features.meetings.evidence(formatNumber(counts.teamsMeetings, language)),
        nextStep: copy.features.meetings.nextStep,
      },
      {
        id: "bots",
        status: bots.length > 0 && counts.strictKnowledgeBots > 0 ? "ready" : "partial",
        title: copy.features.bots.title,
        evidence: copy.features.bots.evidence(formatNumber(bots.length, language), formatNumber(counts.approvedKnowledge, language)),
        nextStep: copy.features.bots.nextStep,
      },
      {
        id: "newsletter",
        status: newsletterCampaigns.length > 0 && newsletterSegments.length > 0 ? "partial" : "gap",
        title: copy.features.newsletter.title,
        evidence: copy.features.newsletter.evidence(formatNumber(newsletterSegments.length, language), formatNumber(newsletterCampaigns.length, language)),
        nextStep: copy.features.newsletter.nextStep,
      },
      {
        id: "inventory",
        status: propertyUnits.length > 0 ? "ready" : "gap",
        title: copy.features.inventory.title,
        evidence:
          propertyUnits.length > 0
            ? copy.features.inventory.evidenceReady(formatNumber(propertyUnits.length, language))
            : copy.features.inventory.evidence,
        nextStep:
          propertyUnits.length > 0
            ? copy.features.inventory.nextStepReady
            : copy.features.inventory.nextStep,
      },
      {
        id: "analytics",
        status: "partial",
        title: copy.features.analytics.title,
        evidence: copy.features.analytics.evidence,
        nextStep: copy.features.analytics.nextStep,
      },
    ],
    [
      bots.length,
      contacts.length,
      copy.features,
      counts.approvedKnowledge,
      counts.strictKnowledgeBots,
      counts.teamsMeetings,
      deals.length,
      funnels.length,
      language,
      leads.length,
      leadSequences.length,
      newsletterCampaigns.length,
      newsletterSegments.length,
      propertyUnits.length,
      tasks.length,
    ],
  );

  const coverage = analysisSignals.maturity.score;
  const maturityGap = Math.max(0, 100 - analysisSignals.maturity.score);
  const overdueAlerts = analysisSignals.speedToLeadAlerts.filter((alert) => alert.state === "overdue");
  const dueSoonAlerts = analysisSignals.speedToLeadAlerts.filter((alert) => alert.state === "dueSoon");
  const blockedConsentDecisions = analysisSignals.consentDecisions.filter((decision) => !decision.allowed);
  const allowedConsentDecisions = analysisSignals.consentDecisions.filter((decision) => decision.allowed);
  const riskHygieneIssues = analysisSignals.dataHygieneIssues.filter((issue) => issue.severity === "risk");
  const maturityEvidenceLabels = copy.sprint.maturityEvidence as Record<
    string,
    string | ((value: string) => string)
  >;
  const maturityPresentLabels = copy.sprint.maturityPresent as Record<
    string,
    string | ((value: string) => string)
  >;
  const maturityMissingLabels = copy.sprint.maturityMissing as Record<
    string,
    string | ((value: string) => string)
  >;
  const maturityActionLabels = copy.sprint.maturityActions as Record<string, string | undefined>;
  const maturityNextStepLabels = copy.sprint.maturityNextSteps as Record<string, string | undefined>;
  const maturityRiskLabels = copy.sprint.maturityRisks as Record<string, string | undefined>;
  const maturityModuleLabels = copy.sprint.maturityModuleLabels as Record<CrmMaturityModuleId, string>;
  const scoreGapRecommendationCopy = copy.scoreGapRecommendations as ScoreGapRecommendationCopy;
  const scoreGapModules = analysisSignals.maturity.modules
    .filter((module) => module.score < module.weight)
    .sort((left, right) => right.weight - right.score - (left.weight - left.score));
  const topScoreGaps = scoreGapModules.slice(0, 4);
  const adaptiveRecommendations = scoreGapModules.map<RecommendationCard>((module) => {
    const labels = scoreGapRecommendationCopy[module.id];
    const config = scoreGapRecommendationConfig[module.id];
    const missingText =
      module.missing.length > 0
        ? module.missing
            .slice(0, 2)
            .map((signal) => renderSignalText(signal, maturityMissingLabels, language))
            .join(" ")
        : copy.scoreGap.fallbackMissing;

    return {
      audience: config.audience,
      effort: copy.sprint.efforts[config.effort],
      impact: labels.impact,
      nextStep: labels.nextStep,
      priority: config.priority,
      title: labels.title,
      why: copy.scoreGap.recommendationWhy(`${module.score}/${module.weight}`, labels.why, missingText),
    };
  });
  const recommendations =
    adaptiveRecommendations.length > 0
      ? adaptiveRecommendations
      : (copy.recommendations as readonly RecommendationCard[]);
  const filteredRecommendations = recommendations.filter(
    (recommendation) =>
      getAudienceMatch(audience, recommendation.audience) &&
      (priority === "all" || recommendation.priority === priority),
  );
  const p0Count = recommendations.filter((recommendation) => recommendation.priority === "p0").length;
  const filteredMissingItems = analysisSignals.maturity.missingItems.filter(
    (item) => getActionAudienceMatch(audience, item.audience) && (priority === "all" || item.priority === priority),
  );
  const filteredNextSteps = analysisSignals.maturity.nextSteps.filter(
    (item) => getActionAudienceMatch(audience, item.audience) && (priority === "all" || item.priority === priority),
  );
  const workingModuleCount = analysisSignals.maturity.modules.filter((module) => module.status === "working").length;
  const partialModuleCount = analysisSignals.maturity.modules.filter((module) => module.status === "partial").length;
  const riskOrMissingModuleCount = analysisSignals.maturity.modules.filter(
    (module) => module.status === "risk" || module.status === "missing",
  ).length;

  const dataSourceLabel =
    dataSource === "database"
      ? copy.dataSource.database
      : dataSource === "fallback"
        ? copy.dataSource.fallback
        : copy.dataSource.mock;
  const moduleSourceRows = moduleSources
    ? Object.entries(moduleSources).map(([key, source]) => ({
        key,
        label: copy.moduleSources.labels[key as keyof typeof copy.moduleSources.labels] ?? key,
        source,
      }))
    : [];
  const tabItems: Array<{ id: AnalysisTab; label: string }> = [
    { id: "overview", label: copy.tabs.overview },
    { id: "sprint", label: copy.tabs.sprint },
    { id: "features", label: copy.tabs.features },
    { id: "recommendations", label: copy.tabs.recommendations },
    { id: "playbook", label: copy.tabs.playbook },
  ];
  const sprintMetrics = [
    { label: copy.sprint.currentScore, value: `${analysisSignals.maturity.score}%` },
    { label: copy.sprint.workingModules, value: formatNumber(workingModuleCount, language) },
    { label: copy.sprint.partialModules, value: formatNumber(partialModuleCount, language) },
    { label: copy.sprint.riskOrMissingModules, value: formatNumber(riskOrMissingModuleCount, language) },
  ];
  const inventoryMetrics = [
    { label: copy.sprint.totalUnits, value: formatNumber(analysisSignals.inventory.total, language) },
    { label: copy.sprint.availableUnits, value: formatNumber(analysisSignals.inventory.available, language) },
    { label: copy.sprint.reservedUnits, value: formatNumber(analysisSignals.inventory.reserved, language) },
    { label: copy.sprint.inventoryValue, value: formatCurrency(analysisSignals.inventory.totalValueCents / 100, language) },
  ];
  const hasRuntimeFallbackRisk = Boolean(
    missingTables.length ||
      moduleSourceRows.some((row) => row.source !== "database") ||
      (runtimeSummary && runtimeSummary.fallbackAudits > 0),
  );

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {copy.eyebrow}
            </p>
            <h3 className="mt-2 break-words text-2xl font-semibold text-slate-950">
              {copy.title}
            </h3>
            <p className="mt-2 max-w-4xl break-words text-sm leading-6 text-stone-600">
              {copy.description}
            </p>
            <p className="mt-3 break-words text-sm font-medium text-slate-700">
              {copy.scopeLabel}: {projectLabel}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[360px]">
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.metrics.coverage}
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">{coverage}%</p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.metrics.dataSource}
              </p>
              <p className="mt-2 break-words text-sm font-semibold text-slate-950">
                {dataSourceLabel}
              </p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.metrics.hotLeads}
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {formatNumber(counts.hotLeads, language)}
              </p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.metrics.p0}
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {formatNumber(p0Count, language)}
              </p>
            </div>
          </div>
        </div>

        {moduleSourceRows.length > 0 ? (
          <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-950">{copy.moduleSources.title}</p>
                <p className="mt-1 break-words text-xs leading-5 text-stone-600">
                  {copy.moduleSources.description}
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">
                {copy.moduleSources.productionReadiness}: {copy.dataSource[dataSource]}
              </span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {moduleSourceRows.map((row) => (
                <div className="rounded-md border border-stone-200 bg-white p-2" key={row.key}>
                  <p className="break-words text-xs font-semibold text-slate-950">{row.label}</p>
                  <p className="mt-1 text-xs text-stone-600">
                    {copy.moduleSources.status[row.source]}
                  </p>
                </div>
              ))}
            </div>
            {missingTables.length > 0 ? (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                <span className="font-semibold">{copy.moduleSources.missingTables}</span>{" "}
                {missingTables.join(", ")}
              </div>
            ) : null}
            {hasRuntimeFallbackRisk ? (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
                {copy.runtime.fallbackWarning}
              </div>
            ) : null}
          </div>
        ) : null}

        {topScoreGaps.length > 0 ? (
          <div className="mt-5 rounded-lg border border-stone-200 bg-white p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-950">{copy.scoreGap.title}</p>
                <p className="mt-1 break-words text-xs leading-5 text-stone-600">
                  {copy.scoreGap.description(coverage, maturityGap)}
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">
                {copy.scoreGap.totalOpen(maturityGap)}
              </span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {topScoreGaps.map((module) => {
                const openPoints = module.weight - module.score;
                const missingText =
                  module.missing.length > 0
                    ? renderSignalText(module.missing[0], maturityMissingLabels, language)
                    : copy.scoreGap.fallbackMissing;

                return (
                  <div className="rounded-md border border-stone-200 bg-stone-50 p-3" key={module.id}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="break-words text-xs font-semibold text-slate-950">
                        {maturityModuleLabels[module.id]}
                      </p>
                      <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-semibold text-amber-800">
                        {copy.scoreGap.moduleDelta(openPoints)}
                      </span>
                    </div>
                    <p className="mt-2 text-xs font-semibold text-stone-700">
                      {module.score}/{module.weight}
                    </p>
                    <p className="mt-1 break-words text-xs leading-5 text-stone-600">{missingText}</p>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {runtimeSummary ? (
          <div className="mt-5 rounded-lg border border-stone-200 bg-white p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-950">{copy.runtime.title}</p>
                <p className="mt-1 break-words text-xs leading-5 text-stone-600">
                  {copy.runtime.description}
                </p>
              </div>
              <button
                className="shrink-0 rounded-md border border-stone-300 px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-stone-50"
                onClick={() => void runRuntimeChecks()}
                type="button"
              >
                {copy.runtime.runChecks}
              </button>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [copy.runtime.fallbacks, runtimeSummary.fallbackAudits],
                [copy.runtime.followUps, runtimeSummary.followUpActions],
                [copy.runtime.salesWorkflows, runtimeSummary.viewingSlots + runtimeSummary.offerMilestones + runtimeSummary.unitAuditEvents],
                [copy.runtime.botChecks, runtimeSummary.botAnswerChecks],
                [copy.runtime.botReviewIssues, runtimeSummary.botAnswerReviewIssues],
                [copy.runtime.conversions, runtimeSummary.conversionSnapshots],
                [copy.runtime.onboardingRisks, runtimeSummary.onboardingRiskAlerts],
                [copy.runtime.cleanup, runtimeSummary.cleanupActions],
                [copy.runtime.bulkBatches, runtimeSummary.bulkFollowUpBatches],
                [copy.runtime.outreachDeliveries, runtimeSummary.outreachDeliveries],
                [copy.runtime.permissionWarnings, runtimeSummary.permissionAuditWarnings],
                [
                  copy.runtime.consentDecisions,
                  runtimeSummary.consentCoverage.reduce((sum, row) => sum + row.allowed + row.blocked, 0),
                ],
              ].map(([label, value]) => (
                <div className="rounded-md border border-stone-200 bg-stone-50 p-2" key={label}>
                  <p className="break-words text-xs font-semibold text-stone-600">{label}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-950">
                    {formatNumber(value as number, language)}
                  </p>
                </div>
              ))}
            </div>
            {runtimeSummary.latestConversionSnapshot ? (
              <p className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs font-semibold text-slate-800">
                {copy.runtime.latestSnapshot(
                  formatNumber(runtimeSummary.latestConversionSnapshot.leadsCount, language),
                  formatCurrency(runtimeSummary.latestConversionSnapshot.closedRevenueCents / 100, language),
                  formatNumber(runtimeSummary.latestConversionSnapshot.unitSalesVelocity, language),
                )}
              </p>
            ) : null}
            {runtimeSummary.consentCoverage.length ? (
              <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.runtime.consentCoverageTitle}
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {runtimeSummary.consentCoverage.slice(0, 6).map((row) => (
                    <div className="rounded-md bg-white px-3 py-2 text-xs" key={`${row.channel}:${row.purpose}`}>
                      <p className="font-semibold text-slate-950">{row.channel} / {row.purpose}</p>
                      <p className="mt-1 text-stone-600">
                        {copy.runtime.allowedBlocked(
                          formatNumber(row.allowed, language),
                          formatNumber(row.blocked, language),
                        )}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {runtimeNotice ? (
              <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900">
                {runtimeNotice}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          {tabItems.map((tab) => (
            <button
              className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                activeTab === tab.id
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
              }`}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "overview" ? (
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h4 className="text-lg font-semibold text-slate-950">{copy.overview.title}</h4>
            <p className="mt-1 break-words text-sm leading-6 text-stone-600">
              {copy.overview.description}
            </p>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {copy.overview.strengths.map((strength) => (
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={strength.title}>
                  <p className="text-sm font-semibold text-slate-950">{strength.title}</p>
                  <p className="mt-2 break-words text-sm leading-6 text-stone-600">
                    {strength.description}
                  </p>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h4 className="text-lg font-semibold text-slate-950">{copy.overview.signals}</h4>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 p-3">
                <span className="break-words text-sm text-stone-700">{copy.signalLabels.projects}</span>
                <strong className="shrink-0 text-sm text-slate-950">{formatNumber(projects.length, language)}</strong>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 p-3">
                <span className="break-words text-sm text-stone-700">{copy.signalLabels.openDeals}</span>
                <strong className="shrink-0 text-sm text-slate-950">{formatNumber(counts.openDeals, language)}</strong>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 p-3">
                <span className="break-words text-sm text-stone-700">{copy.signalLabels.openTasks}</span>
                <strong className="shrink-0 text-sm text-slate-950">{formatNumber(counts.openTasks, language)}</strong>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 p-3">
                <span className="break-words text-sm text-stone-700">{copy.signalLabels.consentCoverage}</span>
                <strong className="shrink-0 text-sm text-slate-950">{counts.consentCoverage}%</strong>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 p-3">
                <span className="break-words text-sm text-stone-700">{copy.signalLabels.botConversations}</span>
                <strong className="shrink-0 text-sm text-slate-950">{formatNumber(crmBotConversations.length, language)}</strong>
              </div>
            </div>
          </article>
        </div>
      ) : null}

      {activeTab === "sprint" ? (
        <div className="space-y-4">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.title}</h4>
                <p className="mt-2 max-w-4xl break-words text-sm leading-6 text-stone-600">
                  {copy.sprint.description}
                </p>
                <div className="mt-4 max-w-4xl">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-slate-800">
                    <span>{copy.sprint.currentScore}</span>
                    <span>{coverage}%</span>
                  </div>
                  <div className="mt-2 h-3 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className="h-full rounded-full bg-emerald-600"
                      style={{ width: `${Math.min(100, coverage)}%` }}
                    />
                  </div>
                  <p className="mt-2 break-words text-sm leading-6 text-stone-600">
                    {copy.sprint.currentState(coverage, maturityGap)}
                  </p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[420px]">
                {sprintMetrics.map((metric) => (
                  <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" key={metric.label}>
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {metric.label}
                    </p>
                    <p className="mt-2 break-words text-2xl font-semibold text-slate-950">
                      {metric.value}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-semibold text-slate-800">
                {copy.filters.audience}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => setAudience(event.target.value as AnalysisAudience)}
                  value={audience}
                >
                  <option value="all">{copy.audiences.all}</option>
                  <option value="developer">{copy.audiences.developer}</option>
                  <option value="novalure">{copy.audiences.novalure}</option>
                </select>
              </label>
              <label className="grid gap-2 text-sm font-semibold text-slate-800">
                {copy.filters.priority}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => setPriority(event.target.value as AnalysisPriority)}
                  value={priority}
                >
                  <option value="all">{copy.priorities.all}</option>
                  <option value="p0">{copy.priorities.p0}</option>
                  <option value="p1">{copy.priorities.p1}</option>
                  <option value="p2">{copy.priorities.p2}</option>
                </select>
              </label>
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.currentStateTitle}</h4>
            <p className="mt-2 break-words text-sm leading-6 text-stone-600">
              {copy.sprint.currentStateDetail}
            </p>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {analysisSignals.maturity.modules.map((module) => (
                <div className="rounded-lg border border-stone-200 p-4" key={module.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-slate-950">
                        {copy.sprint.maturityModuleLabels[module.id]}
                      </p>
                      <p className="mt-1 break-words text-sm leading-6 text-stone-600">
                        {copy.sprint.maturityModuleDescriptions[module.id]}
                      </p>
                    </div>
                    <Badge className={maturityStatusStyles[module.status]}>
                      {copy.sprint.maturityStatus[module.status]}
                    </Badge>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className="h-full rounded-full bg-slate-950"
                      style={{ width: `${Math.min(100, module.percent)}%` }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-stone-500">
                    <span>
                      {copy.sprint.moduleScore}: {module.percent}%
                    </span>
                    <span>
                      {copy.sprint.weight}: {module.score}/{module.weight}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                        {copy.sprint.evidenceTitle}
                      </p>
                      <ul className="mt-2 space-y-1 text-sm leading-6 text-stone-700">
                        {module.evidence.map((item) => (
                          <li className="break-words" key={`${module.id}-${item.id}`}>
                            {renderSignalText(item, maturityEvidenceLabels, language)}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                        {copy.sprint.presentTitle}
                      </p>
                      <ul className="mt-2 space-y-1 text-sm leading-6 text-stone-700">
                        {module.present.map((item) => (
                          <li className="break-words" key={`${module.id}-${item.id}`}>
                            {renderSignalText(item, maturityPresentLabels, language)}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                        {copy.sprint.missingTitle}
                      </p>
                      <ul className="mt-2 space-y-1 text-sm leading-6 text-stone-700">
                        {module.missing.map((item) => (
                          <li className="break-words" key={`${module.id}-${item.id}`}>
                            {renderSignalText(item, maturityMissingLabels, language)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.sprint.moduleNextStepTitle}
                    </p>
                    <p className="mt-2 break-words text-sm leading-6 text-slate-700">
                      {maturityNextStepLabels[module.nextStepId] ?? module.nextStepId}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <div className="grid gap-4 xl:grid-cols-3">
            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.missingFunctionsTitle}</h4>
              <div className="mt-4 space-y-3">
                {filteredMissingItems.map((item) => (
                  <div className="rounded-lg border border-stone-200 p-3" key={item.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={priorityStyles[item.priority]}>{copy.priorities[item.priority]}</Badge>
                      <Badge className="border-stone-200 bg-stone-50 text-stone-700">
                        {copy.audiences[item.audience]}
                      </Badge>
                    </div>
                    <p className="mt-3 break-words text-sm font-semibold text-slate-950">
                      {actionCopyFor(item, maturityActionLabels)}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-stone-500">
                      {copy.sprint.maturityModuleLabels[item.moduleId]} · {copy.recommendationLabels.effort}: {copy.sprint.efforts[item.effort]}
                    </p>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.nextDevelopmentTitle}</h4>
              <div className="mt-4 space-y-3">
                {filteredNextSteps.map((item) => (
                  <div className="rounded-lg border border-stone-200 p-3" key={item.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={priorityStyles[item.priority]}>{copy.priorities[item.priority]}</Badge>
                      <Badge className="border-stone-200 bg-stone-50 text-stone-700">
                        {copy.audiences[item.audience]}
                      </Badge>
                    </div>
                    <p className="mt-3 break-words text-sm font-semibold text-slate-950">
                      {actionCopyFor(item, maturityActionLabels)}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-stone-500">
                      {copy.sprint.maturityModuleLabels[item.moduleId]} · {copy.recommendationLabels.effort}: {copy.sprint.efforts[item.effort]}
                    </p>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.risksComplianceTitle}</h4>
              <div className="mt-4 space-y-3">
                {analysisSignals.maturity.risks.length > 0 ? (
                  analysisSignals.maturity.risks.map((risk) => (
                    <div className="rounded-lg border border-stone-200 p-3" key={risk.id}>
                      <Badge
                        className={
                          risk.level === "high"
                            ? "border-rose-200 bg-rose-50 text-rose-900"
                            : risk.level === "medium"
                              ? "border-amber-200 bg-amber-50 text-amber-900"
                              : "border-stone-200 bg-stone-50 text-stone-800"
                        }
                      >
                        {copy.sprint.riskLevels[risk.level]}
                      </Badge>
                      <p className="mt-3 break-words text-sm font-semibold text-slate-950">
                        {maturityRiskLabels[risk.id] ?? risk.id}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-stone-500">
                        {copy.sprint.maturityModuleLabels[risk.moduleId]}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                    {copy.sprint.noRisks}
                  </p>
                )}
              </div>
            </article>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.inventoryTitle}</h4>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {inventoryMetrics.map((metric) => (
                  <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" key={metric.label}>
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {metric.label}
                    </p>
                    <p className="mt-2 break-words text-lg font-semibold text-slate-950">
                      {metric.value}
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-800">
                  {copy.sprint.expiringReservations}
                </p>
                <div className="mt-2 space-y-2">
                  {analysisSignals.inventory.expiringReservations.length > 0 ? (
                    analysisSignals.inventory.expiringReservations.map((reservation) => (
                      <p className="break-words text-sm text-amber-950" key={reservation.id}>
                        {reservation.nextAction}
                      </p>
                    ))
                  ) : (
                    <p className="text-sm text-amber-950">{copy.sprint.noReservations}</p>
                  )}
                </div>
              </div>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.speedTitle}</h4>
              <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.overdueSla}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(overdueAlerts.length, language)}
                  </dd>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.dueSoonSla}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(dueSoonAlerts.length, language)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 space-y-2">
                {analysisSignals.speedToLeadAlerts.filter((alert) => alert.state !== "covered").length > 0 ? (
                  analysisSignals.speedToLeadAlerts
                    .filter((alert) => alert.state !== "covered")
                    .slice(0, 4)
                    .map((alert) => (
                      <div className="rounded-lg border border-stone-200 p-3" key={alert.id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="break-words text-sm font-semibold text-slate-950">
                            {alert.contactName}
                          </p>
                          <Badge
                            className={
                              alert.state === "overdue"
                                ? "border-rose-200 bg-rose-50 text-rose-900"
                                : "border-amber-200 bg-amber-50 text-amber-900"
                            }
                          >
                            {copy.sprint.speedStates[alert.state]}
                          </Badge>
                        </div>
                        <p className="mt-1 break-words text-sm leading-6 text-stone-600">
                          {alert.ownerName}: {alert.nextAction}
                        </p>
                      </div>
                    ))
                ) : (
                  <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                    {copy.sprint.noAlerts}
                  </p>
                )}
              </div>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.consentTitle}</h4>
              <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.allowedActions}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(allowedConsentDecisions.length, language)}
                  </dd>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.blockedActions}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(blockedConsentDecisions.length, language)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 space-y-2">
                {blockedConsentDecisions.length > 0 ? (
                  blockedConsentDecisions.slice(0, 5).map((decision) => (
                    <div className="rounded-lg border border-stone-200 p-3" key={decision.id}>
                      <p className="break-words text-sm font-semibold text-slate-950">
                        {decision.contactName} - {decision.channel}
                      </p>
                      <p className="mt-1 text-sm text-stone-600">
                        {copy.sprint.consentReasons[decision.reason]}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                    {copy.sprint.noConsentBlocks}
                  </p>
                )}
              </div>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.customerAccessTitle}</h4>
              <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.activationScore}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {analysisSignals.customerAccess.averageActivationScore}%
                  </dd>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.priorityAccounts}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(analysisSignals.customerAccess.priorityAccounts.length, language)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 space-y-2">
                {analysisSignals.customerAccess.priorityAccounts.map((account) => (
                  <div className="rounded-lg border border-stone-200 p-3" key={account.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="break-words text-sm font-semibold text-slate-950">
                        {account.customerName}
                      </p>
                      <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">
                        {account.activationScore}%
                      </span>
                    </div>
                    <p className="mt-1 break-words text-sm leading-6 text-stone-600">
                      {account.nextOnboardingAction}
                    </p>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.botGovernanceTitle}</h4>
              <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.approvedKnowledge}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(analysisSignals.botGovernance.approvedKnowledgeItems, language)}
                  </dd>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.activeChannels}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(analysisSignals.botGovernance.activeChannels, language)}
                  </dd>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.reviewKnowledge}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(analysisSignals.botGovernance.needsReviewKnowledgeItems, language)}
                  </dd>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.evaluationReadiness}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {analysisSignals.botGovernance.evaluationReadiness}%
                  </dd>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.moduleScore}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {analysisSignals.botGovernance.score}%
                  </dd>
                </div>
              </dl>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold text-slate-950">{copy.sprint.hygieneTitle}</h4>
              <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.hygieneIssues}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(analysisSignals.dataHygieneIssues.length, language)}
                  </dd>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.sprint.riskIssues}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-slate-950">
                    {formatNumber(riskHygieneIssues.length, language)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 space-y-2">
                {analysisSignals.dataHygieneIssues.length > 0 ? (
                  analysisSignals.dataHygieneIssues.slice(0, 6).map((issue) => (
                    <div className="rounded-lg border border-stone-200 p-3" key={issue.id}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="break-words text-sm font-semibold text-slate-950">
                          {issue.entityLabel}
                        </p>
                        <Badge
                          className={
                            issue.severity === "risk"
                              ? "border-rose-200 bg-rose-50 text-rose-900"
                              : "border-amber-200 bg-amber-50 text-amber-900"
                          }
                        >
                          {copy.sprint.hygieneKinds[issue.kind]}
                        </Badge>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                    {copy.sprint.noHygieneIssues}
                  </p>
                )}
              </div>
            </article>
          </div>
        </div>
      ) : null}

      {activeTab === "features" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {features.map((feature) => (
            <article className="rounded-lg border border-stone-200 bg-white p-5" key={feature.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h4 className="min-w-0 break-words text-lg font-semibold text-slate-950">
                  {feature.title}
                </h4>
                <Badge className={statusStyles[feature.status]}>{copy.status[feature.status]}</Badge>
              </div>
              <p className="mt-3 break-words text-sm leading-6 text-stone-600">{feature.evidence}</p>
              <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.nextStep}
                </p>
                <p className="mt-2 break-words text-sm leading-6 text-slate-700">{feature.nextStep}</p>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {activeTab === "recommendations" ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-semibold text-slate-800">
                {copy.filters.audience}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => setAudience(event.target.value as AnalysisAudience)}
                  value={audience}
                >
                  <option value="all">{copy.audiences.all}</option>
                  <option value="developer">{copy.audiences.developer}</option>
                  <option value="novalure">{copy.audiences.novalure}</option>
                </select>
              </label>
              <label className="grid gap-2 text-sm font-semibold text-slate-800">
                {copy.filters.priority}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => setPriority(event.target.value as AnalysisPriority)}
                  value={priority}
                >
                  <option value="all">{copy.priorities.all}</option>
                  <option value="p0">{copy.priorities.p0}</option>
                  <option value="p1">{copy.priorities.p1}</option>
                  <option value="p2">{copy.priorities.p2}</option>
                </select>
              </label>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {filteredRecommendations.map((recommendation) => (
              <article className="rounded-lg border border-stone-200 bg-white p-5" key={`${recommendation.priority}-${recommendation.title}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={priorityStyles[recommendation.priority]}>
                    {copy.priorities[recommendation.priority]}
                  </Badge>
                  <Badge className="border-stone-200 bg-stone-50 text-stone-700">
                    {copy.audiences[recommendation.audience]}
                  </Badge>
                </div>
                <h4 className="mt-4 break-words text-lg font-semibold text-slate-950">
                  {recommendation.title}
                </h4>
                <p className="mt-2 break-words text-sm leading-6 text-stone-600">
                  {recommendation.why}
                </p>
                <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-stone-200 p-3">
                    <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.recommendationLabels.impact}
                    </dt>
                    <dd className="mt-1 break-words text-sm text-slate-800">{recommendation.impact}</dd>
                  </div>
                  <div className="rounded-lg border border-stone-200 p-3">
                    <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.recommendationLabels.effort}
                    </dt>
                    <dd className="mt-1 break-words text-sm text-slate-800">{recommendation.effort}</dd>
                  </div>
                </dl>
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-emerald-800">
                    {copy.nextStep}
                  </p>
                  <p className="mt-2 break-words text-sm leading-6 text-emerald-950">
                    {recommendation.nextStep}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {activeTab === "playbook" ? (
        <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h4 className="text-lg font-semibold text-slate-950">{copy.playbook.title}</h4>
            <p className="mt-2 break-words text-sm leading-6 text-stone-600">
              {copy.playbook.description}
            </p>
            <pre className="mt-4 max-h-[460px] overflow-auto whitespace-pre-wrap rounded-lg border border-stone-200 bg-slate-950 p-4 text-sm leading-6 text-white">
              {copy.playbook.prompt}
            </pre>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h4 className="text-lg font-semibold text-slate-950">{copy.sources.title}</h4>
            <p className="mt-2 break-words text-sm leading-6 text-stone-600">
              {copy.sources.description}
            </p>
            <div className="mt-4 space-y-3">
              {copy.sources.items.map((source) => (
                <a
                  className="block rounded-lg border border-stone-200 p-3 text-sm font-semibold text-blue-900 hover:bg-blue-50"
                  href={source.url}
                  key={source.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <span className="block break-words">{source.title}</span>
                  <span className="mt-1 block break-words text-xs font-normal leading-5 text-stone-600">
                    {source.note}
                  </span>
                </a>
              ))}
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
