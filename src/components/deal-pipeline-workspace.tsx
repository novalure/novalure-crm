"use client";

import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import type {
  CalendarEvent,
  Contact,
  CrmPipeline,
  CrmPipelineStage,
  Deal,
  DealCloseReasonCategory,
  DealStage,
  DealStageHistoryEntry,
  Lead,
  LeadSource,
  Organization,
  PipelineStage,
  Project,
  ProjectPipelinePermission,
  PropertyReservation,
  PropertyUnit,
  SellerListing,
  Task,
  WorkspaceUser,
} from "@/lib/crm-types";
import {
  getCrmRiskLabel,
  getCrmSourceLabel,
  getCrmTaskDueLabel,
  getDealPipelineCommandCopy,
  getLocale,
  displayTimeZone,
  type LanguageCode,
} from "@/lib/i18n";

type DealPipelineWorkspaceProps = {
  calendarEvents: CalendarEvent[];
  contacts: Contact[];
  deals: Deal[];
  language: LanguageCode;
  leads: Lead[];
  organizations: Organization[];
  pipeline: PipelineStage[];
  projectPipelinePermissions: ProjectPipelinePermission[];
  crmPipelines: CrmPipeline[];
  crmPipelineStages: CrmPipelineStage[];
  projectLabel: string;
  workspaceId?: string;
  projects: Project[];
  propertyReservations: PropertyReservation[];
  propertyUnits: PropertyUnit[];
  sellerListings: SellerListing[];
  tasks: Task[];
  users: WorkspaceUser[];
  onDealsChanged?: () => Promise<boolean | void> | boolean | void;
};

type DealPatch = Partial<
  Pick<Deal, "expectedCloseDate" | "nextAction" | "ownerUserId" | "probability" | "riskLevel" | "stage" | "value">
>;

type WarningItem = {
  id: "blockedUnit" | "highRisk" | "longStage" | "noNextAction" | "noTask" | "overdueTask" | "reservationDue";
  tone: "amber" | "red" | "slate";
};

type DealView = {
  contact?: Contact;
  deal: Deal;
  lead?: Lead;
  leadType: string;
  linkedTasks: Task[];
  listing?: SellerListing;
  nextTask?: Task;
  organization?: Organization;
  owner?: WorkspaceUser;
  project?: Project;
  relevantEvent?: CalendarEvent;
  reservation?: PropertyReservation;
  stageAgeDays: number;
  unit?: PropertyUnit;
  warnings: WarningItem[];
};

type StageChangeReview = {
  dealId: string;
  reason: string;
  reasonCategory: DealCloseReasonCategory | "";
  reasonRequired: boolean;
  targetStage: DealStage;
  warnings: string[];
};

type StageHistoryEntry = Partial<DealStageHistoryEntry> & {
  actor: string;
  changedAt: string;
  fromStage: DealStage;
  id: string;
  reason?: string;
  reasonCategory?: DealCloseReasonCategory;
  reasonDetail?: string;
  toStage: DealStage;
};

type StageFilter = DealStage | "all";
type RiskFilter = Deal["riskLevel"] | "all";
type LeadTypeFilter = Lead["type"] | Contact["role"] | "all";
type SourceFilter = LeadSource | "all";
type PriorityFilter = Task["priority"] | "all";
type PeriodFilter = "all" | "today" | "week" | "month" | "quarter";

const WORK_STAGE_TITLES: DealStage[] = [
  "Neu",
  "Qualifizieren",
  "Termin vereinbaren",
  "Termin gebucht",
  "Besichtigung/Beratung",
  "Angebot/Reservierung",
  "Abschlussprüfung",
];

const END_STAGE_TITLES: DealStage[] = ["Gewonnen", "Verloren", "Disqualifiziert"];
const ORDERED_STAGE_TITLES: DealStage[] = [...WORK_STAGE_TITLES, ...END_STAGE_TITLES];
const CLOSE_REASON_OPTIONS: DealCloseReasonCategory[] = [
  "budget",
  "timing",
  "competitor",
  "no_response",
  "not_qualified",
  "project_mismatch",
  "duplicate",
  "other",
];
const PERIOD_OPTIONS: PeriodFilter[] = ["all", "today", "week", "month", "quarter"];
const PRIORITY_OPTIONS: Array<Task["priority"]> = ["Hoch", "Mittel", "Normal"];

const NOW = new Date();
const TODAY_START = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()).getTime();

const riskStyles: Record<Deal["riskLevel"], string> = {
  niedrig: "border-emerald-200 bg-emerald-50 text-emerald-900",
  mittel: "border-amber-200 bg-amber-50 text-amber-900",
  hoch: "border-red-200 bg-red-50 text-red-900",
};

const warningStyles: Record<WarningItem["tone"], string> = {
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  red: "border-red-200 bg-red-50 text-red-900",
  slate: "border-slate-200 bg-slate-100 text-slate-800",
};

const priorityRank: Record<Task["priority"], number> = {
  Hoch: 0,
  Mittel: 1,
  Normal: 2,
};

const legacyStageMap: Record<string, DealStage> = {
  Abschluss: "Gewonnen",
  "Beratungstermin": "Beratung / Besichtigung",
  Besichtigung: "Besichtigung/Beratung",
  "Neuer Lead": "Neu",
  Qualifiziert: "Qualifizieren",
  "Verkauft": "Gewonnen",
};

type StageConfig = {
  category: string;
  key: string;
  name: DealStage;
  pipelineId?: string;
  position: number;
  probability: number;
  slaHours?: number;
};

function isClosedStageCategory(category: string) {
  const normalized = category.toLowerCase();
  return ["closed", "won", "lost", "disqualified"].includes(normalized);
}

function isLostStageName(stage: string) {
  return stage === "Verloren" || stage === "Disqualifiziert" || stage === "Pausiert / Verloren";
}

function getFallbackStageConfigs(): StageConfig[] {
  return ORDERED_STAGE_TITLES.map((stage, index) => ({
    category: END_STAGE_TITLES.includes(stage) ? (stage === "Gewonnen" ? "won" : "lost") : "work",
    key: stage.toLowerCase().replace(/\s+/g, "_"),
    name: stage,
    position: index,
    probability: stage === "Gewonnen" ? 100 : isLostStageName(stage) ? 0 : Math.min(95, 10 + index * 12),
  }));
}

function getStageConfigs(input: {
  crmPipelineStages: CrmPipelineStage[];
  deals: Deal[];
  pipeline: PipelineStage[];
  projectFilter: string;
}): StageConfig[] {
  const dealProjectIds = new Set(input.deals.map((deal) => deal.projectId).filter(Boolean));
  const candidateStages = input.crmPipelineStages
    .filter((stage) => {
      if (input.projectFilter !== "all") return stage.projectId === input.projectFilter;
      return !stage.projectId || dealProjectIds.size === 0 || dealProjectIds.has(stage.projectId);
    })
    .sort((a, b) => a.position - b.position);

  const seen = new Set<string>();
  const dbStages = candidateStages.flatMap((stage) => {
    const key = stage.name.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      category: stage.category,
      key: stage.key,
      name: stage.name as DealStage,
      pipelineId: stage.pipelineId,
      position: stage.position,
      probability: stage.probability,
      slaHours: stage.slaHours,
    } satisfies StageConfig];
  });

  if (dbStages.length > 0) return dbStages;

  if (input.pipeline.length > 0) {
    return input.pipeline.map((stage, index) => ({
      category: END_STAGE_TITLES.includes(stage.title) ? (stage.title === "Gewonnen" ? "won" : "lost") : "work",
      key: stage.title.toLowerCase().replace(/\s+/g, "_"),
      name: stage.title,
      position: index,
      probability: stage.title === "Gewonnen" ? 100 : isLostStageName(stage.title) ? 0 : Math.min(95, 10 + index * 12),
    }));
  }

  return getFallbackStageConfigs();
}

function normalizeDealStage(stage: string, orderedStages: DealStage[] = ORDERED_STAGE_TITLES): DealStage {
  if ((orderedStages as string[]).includes(stage)) {
    return stage as DealStage;
  }

  const legacyStage = legacyStageMap[stage];
  if (legacyStage && (orderedStages as string[]).includes(legacyStage)) {
    return legacyStage;
  }

  return orderedStages[0] ?? "Neu";
}

function isEndStage(stage: string, endStages: DealStage[] = END_STAGE_TITLES) {
  return (endStages as string[]).includes(stage);
}

function parseEuroValue(value: string) {
  const lowerValue = value.toLowerCase();
  const isMillion = lowerValue.includes("mio");
  const normalized = lowerValue
    .replace(/mio\.?/g, "")
    .replace(/eur/g, "")
    .replace(/€/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized.replace(/[^\d.]/g, ""));

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return isMillion ? parsed * 1_000_000 : parsed;
}

function formatEuro(value: number, locale: string) {
  if (!Number.isFinite(value)) {
    return locale.startsWith("de") ? "Wert offen" : "Value pending";
  }

  return new Intl.NumberFormat(locale, {
    currency: "EUR",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

function formatDate(value: string | undefined, locale: string) {
  if (!value) {
    return "-";
  }

  const date = parseDisplayDate(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", timeZone: displayTimeZone, year: "numeric" }).format(date);
}

function formatDateTime(value: string | undefined, locale: string) {
  if (!value) {
    return "-";
  }

  const date = parseDisplayDate(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: displayTimeZone,
  }).format(date);
}

function sanitizeAmount(value: string) {
  const trimmed = value.trim();
  return trimmed || "0";
}

function getDaysBetween(start: string | undefined, end = NOW) {
  if (!start) {
    return 0;
  }

  const startTime = parseDisplayDate(start).getTime();
  if (!Number.isFinite(startTime)) {
    return 0;
  }

  return Math.max(0, Math.round((end.getTime() - startTime) / (24 * 60 * 60 * 1000)));
}

function isTaskOverdue(task: Task) {
  const due = task.due.toLowerCase();
  const timeMatch = due.match(/(\d{1,2}):(\d{2})/);

  if ((due.includes("heute") || due.includes("today")) && timeMatch) {
    const dueMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
    const nowMinutes = NOW.getHours() * 60 + NOW.getMinutes();
    return dueMinutes < nowMinutes;
  }

  const parsed = parseDisplayDate(task.due).getTime();
  return Number.isFinite(parsed) && parsed < NOW.getTime();
}

function sortTasksByFocus(a: Task, b: Task) {
  const overdueDelta = Number(isTaskOverdue(b)) - Number(isTaskOverdue(a));
  if (overdueDelta !== 0) {
    return overdueDelta;
  }

  return priorityRank[a.priority] - priorityRank[b.priority];
}

function isPeriodMatch(value: string, period: PeriodFilter) {
  if (period === "all") {
    return true;
  }

  const time = parseDisplayDate(value).getTime();
  if (!Number.isFinite(time)) {
    return false;
  }

  const day = 24 * 60 * 60 * 1000;
  const delta = time - TODAY_START;

  if (period === "today") {
    return delta >= 0 && delta < day;
  }

  if (period === "week") {
    return delta >= 0 && delta <= 7 * day;
  }

  if (period === "month") {
    return delta >= 0 && delta <= 30 * day;
  }

  return delta >= 0 && delta <= 90 * day;
}

function parseDisplayDate(value: string) {
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12, 0, 0, 0);
  }

  return new Date(value);
}

function getLinkedLead(deal: Deal, leads: Lead[], contact?: Contact) {
  return leads.find((lead) => lead.id === deal.leadId) ?? leads.find((lead) => lead.contactId === contact?.id);
}

function getLinkedTasks(deal: Deal, tasks: Task[], contact?: Contact, lead?: Lead) {
  return tasks
    .filter(
      (task) =>
        task.status === "open" &&
        ((contact?.id && task.contactId === contact.id) || (lead?.id && task.leadId === lead.id)),
    )
    .sort(sortTasksByFocus);
}

function getRelevantEvent(deal: Deal, calendarEvents: CalendarEvent[], contact?: Contact, lead?: Lead) {
  return calendarEvents
    .filter(
      (event) =>
        new Date(event.startsAt).getTime() >= NOW.getTime() &&
        ((contact?.id && event.contactId === contact.id) || (lead?.id && event.leadId === lead.id) || event.projectId === deal.projectId),
    )
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];
}

function getLeadBudget(lead: Lead | undefined, locale: string) {
  if (!lead) {
    return "";
  }

  if (lead.budget) {
    return lead.budget;
  }

  if (lead.buyerProfile) {
    return `${formatEuro(lead.buyerProfile.budgetFrom, locale)} - ${formatEuro(lead.buyerProfile.budgetTo, locale)}`;
  }

  if (lead.investorProfile) {
    return `${formatEuro(lead.investorProfile.investmentVolumeFrom, locale)} - ${formatEuro(lead.investorProfile.investmentVolumeTo, locale)}`;
  }

  if (lead.sellerProfile) {
    const sellerValue = lead.sellerProfile.askingPrice || lead.sellerProfile.marketValue;
    return Number.isFinite(sellerValue) && sellerValue > 0 ? formatEuro(sellerValue, locale) : "";
  }

  return "";
}

function mapStageHistoryEntry(entry: DealStageHistoryEntry): StageHistoryEntry {
  return {
    actor: entry.changedByName ?? entry.changedByUserId ?? "CRM",
    changedAt: entry.changedAt,
    dealId: entry.dealId,
    fromStage: entry.fromStage ?? entry.toStage,
    id: entry.id,
    projectId: entry.projectId,
    reason: entry.reason,
    reasonCategory: entry.reasonCategory,
    reasonDetail: entry.reasonDetail,
    toStage: entry.toStage,
    workspaceId: entry.workspaceId,
  };
}

export function DealPipelineWorkspace({
  calendarEvents,
  contacts,
  deals,
  language,
  leads,
  organizations,
  onDealsChanged,
  pipeline,
  projectPipelinePermissions,
  crmPipelines,
  crmPipelineStages,
  projectLabel,
  projects,
  propertyReservations,
  propertyUnits,
  sellerListings,
  tasks,
  users,
  workspaceId,
}: DealPipelineWorkspaceProps) {
  const text = getDealPipelineCommandCopy(language);
  const textValue = (key: string, fallback: string) => {
    const value = (text as Record<string, unknown>)[key];
    return typeof value === "string" ? value : fallback;
  };
  const locale = getLocale(language);
  const initialContact = contacts[0];
  const [dealPatches, setDealPatches] = useState<Record<string, DealPatch>>({});
  const [persistedDealOverrides, setPersistedDealOverrides] = useState<Record<string, Deal>>({});
  const [manualDeals, setManualDeals] = useState<Deal[]>([]);
  const [stageHistory, setStageHistory] = useState<Record<string, StageHistoryEntry[]>>({});
  const [selectedDealId, setSelectedDealId] = useState(deals[0]?.id ?? "");
  const [searchTerm, setSearchTerm] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [leadTypeFilter, setLeadTypeFilter] = useState<LeadTypeFilter>("all");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [withoutTask, setWithoutTask] = useState(false);
  const [draggedDealId, setDraggedDealId] = useState("");
  const [dropStage, setDropStage] = useState<DealStage | "">("");
  const [stageReview, setStageReview] = useState<StageChangeReview | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [savingDealId, setSavingDealId] = useState("");
  const [creatingDeal, setCreatingDeal] = useState(false);
  const [newDeal, setNewDeal] = useState({
    contactId: initialContact?.id ?? "",
    expectedCloseDate: "2026-06-30",
    name: initialContact ? `${initialContact.name} Deal` : "",
    probability: 50,
    stage: WORK_STAGE_TITLES[0],
    value: "250.000",
  });
  const activeStageConfigs = useMemo(
    () => getStageConfigs({ crmPipelineStages, deals, pipeline, projectFilter }),
    [crmPipelineStages, deals, pipeline, projectFilter],
  );
  const orderedStageTitles = useMemo(
    () => activeStageConfigs.map((stage) => stage.name),
    [activeStageConfigs],
  );
  const endStageTitles = useMemo(
    () => activeStageConfigs
      .filter((stage) => isClosedStageCategory(stage.category) || END_STAGE_TITLES.includes(stage.name))
      .map((stage) => stage.name),
    [activeStageConfigs],
  );
  const workStageTitles = useMemo(
    () => activeStageConfigs
      .filter((stage) => !endStageTitles.includes(stage.name))
      .map((stage) => stage.name),
    [activeStageConfigs, endStageTitles],
  );
  const stageConfigByName = useMemo<Map<DealStage, StageConfig>>(
    () => new Map(activeStageConfigs.map((stage) => [stage.name, stage])),
    [activeStageConfigs],
  );
  const firstWorkStage = workStageTitles[0] ?? orderedStageTitles[0] ?? "Neu";
  const activePipelineNames = crmPipelines
    .filter((item) => !projectFilter || projectFilter === "all" || item.projectId === projectFilter)
    .map((item) => item.name);
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const visiblePipelinePermissions = useMemo(
    () =>
      projectPipelinePermissions.filter(
        (permission) => projectFilter === "all" || permission.projectId === projectFilter,
      ),
    [projectFilter, projectPipelinePermissions],
  );
  const workspaceQuery = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";

  useEffect(() => {
    if (!selectedDealId) return;

    let cancelled = false;
    void fetch(`/api/crm/deals/${encodeURIComponent(selectedDealId)}/stage-history${workspaceQuery}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { history?: DealStageHistoryEntry[]; source?: string } | null) => {
        const history = payload?.history;
        if (cancelled || payload?.source !== "database" || !Array.isArray(history)) return;
        setStageHistory((current) => ({
          ...current,
          [selectedDealId]: history.map(mapStageHistoryEntry),
        }));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [selectedDealId, workspaceQuery]);

  const scopedManualDeals = useMemo(
    () =>
      manualDeals.filter(
        (deal) => contacts.some((contact) => contact.id === deal.contactId) && !deals.some((item) => item.id === deal.id),
      ),
    [contacts, deals, manualDeals],
  );
  const workingDeals = useMemo(
    () =>
      [...deals, ...scopedManualDeals].map((deal) => {
        const serverDeal = persistedDealOverrides[deal.id] ?? deal;
        const patchedDeal = {
          ...serverDeal,
          ...dealPatches[deal.id],
        };

        return {
          ...patchedDeal,
          stage: normalizeDealStage(patchedDeal.stage, orderedStageTitles),
        };
      }),
    [dealPatches, deals, orderedStageTitles, persistedDealOverrides, scopedManualDeals],
  );

  const dealViews = useMemo<DealView[]>(
    () =>
      workingDeals.map((deal) => {
        const contact = contacts.find((item) => item.id === deal.contactId);
        const lead = getLinkedLead(deal, leads, contact);
        const organization = deal.organizationId
          ? organizations.find((item) => item.id === deal.organizationId)
          : contact?.organizationId
            ? organizations.find((item) => item.id === contact.organizationId)
            : undefined;
        const project = projects.find((item) => item.id === deal.projectId);
        const owner = deal.ownerUserId ? users.find((item) => item.id === deal.ownerUserId) : undefined;
        const linkedTasks = getLinkedTasks(deal, tasks, contact, lead);
        const nextTask = linkedTasks[0];
        const relevantEvent = getRelevantEvent(deal, calendarEvents, contact, lead);
        const unit = propertyUnits.find(
          (item) => item.dealId === deal.id || (contact?.id && item.buyerContactId === contact.id),
        );
        const reservation = propertyReservations.find(
          (item) => item.dealId === deal.id || (contact?.id && item.contactId === contact.id),
        );
        const listing = sellerListings.find((item) => item.sellerLeadId === lead?.id);
        const latestHistory = stageHistory[deal.id]?.find((entry) => entry.toStage === deal.stage);
        const stageAgeDays = getDaysBetween(latestHistory?.changedAt ?? lead?.lastContactAt ?? lead?.receivedAt);
        const warnings: WarningItem[] = [];

        if (unit?.status === "blocked") {
          warnings.push({ id: "blockedUnit", tone: "red" });
        }

        if (deal.riskLevel === "hoch" || deal.probability < 45) {
          warnings.push({ id: "highRisk", tone: "red" });
        }

        if (nextTask && isTaskOverdue(nextTask)) {
          warnings.push({ id: "overdueTask", tone: "red" });
        }

        if (!nextTask && !isEndStage(deal.stage, endStageTitles)) {
          warnings.push({ id: "noTask", tone: "amber" });
        }

        if (!deal.nextAction.trim() && !isEndStage(deal.stage, endStageTitles)) {
          warnings.push({ id: "noNextAction", tone: "amber" });
        }

        if (stageAgeDays > 21 && !isEndStage(deal.stage, endStageTitles)) {
          warnings.push({ id: "longStage", tone: "amber" });
        }

        if (
          reservation &&
          reservation.status !== "converted" &&
          new Date(reservation.expiresAt).getTime() <= NOW.getTime() + 3 * 24 * 60 * 60 * 1000
        ) {
          warnings.push({ id: "reservationDue", tone: "amber" });
        }

        return {
          contact,
          deal,
          lead,
          leadType: lead?.type ?? contact?.role ?? "-",
          linkedTasks,
          listing,
          nextTask,
          organization,
          owner,
          project,
          relevantEvent,
          reservation,
          stageAgeDays,
          unit,
          warnings,
        };
      }),
    [
      calendarEvents,
      contacts,
      leads,
      organizations,
      projects,
      propertyReservations,
      propertyUnits,
      sellerListings,
      endStageTitles,
      stageHistory,
      tasks,
      users,
      workingDeals,
    ],
  );

  const projectOptions = useMemo(
    () => projects.filter((project) => dealViews.some((item) => item.deal.projectId === project.id)),
    [dealViews, projects],
  );
  const leadTypeOptions = useMemo(
    () => Array.from(new Set(dealViews.map((item) => item.leadType).filter((item) => item !== "-"))) as LeadTypeFilter[],
    [dealViews],
  );
  const ownerOptions = useMemo(
    () => users.filter((user) => dealViews.some((item) => item.deal.ownerUserId === user.id)),
    [dealViews, users],
  );
  const sourceOptions = useMemo(
    () => Array.from(new Set(workingDeals.map((deal) => deal.source))) as LeadSource[],
    [workingDeals],
  );

  const filteredDealViews = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase();

    return dealViews.filter((item) => {
      const matchesProject = projectFilter === "all" || item.deal.projectId === projectFilter;
      const matchesLeadType = leadTypeFilter === "all" || item.leadType === leadTypeFilter;
      const matchesStage = stageFilter === "all" || item.deal.stage === stageFilter;
      const matchesSource = sourceFilter === "all" || item.deal.source === sourceFilter;
      const matchesRisk = riskFilter === "all" || item.deal.riskLevel === riskFilter;
      const matchesOwner = ownerFilter === "all" || item.deal.ownerUserId === ownerFilter;
      const matchesPriority = priorityFilter === "all" || item.nextTask?.priority === priorityFilter;
      const matchesPeriod = isPeriodMatch(item.deal.expectedCloseDate, periodFilter);
      const matchesOverdue = !onlyOverdue || item.linkedTasks.some(isTaskOverdue);
      const matchesWithoutTask = !withoutTask || item.linkedTasks.length === 0;
      const searchable = [
        item.deal.name,
        item.deal.nextAction,
        item.deal.source,
        item.contact?.name,
        item.contact?.intent,
        item.lead?.intent,
        item.organization?.name,
        item.project?.name,
        item.owner?.name,
        item.unit?.unitNumber,
        item.listing?.title,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        matchesProject &&
        matchesLeadType &&
        matchesStage &&
        matchesSource &&
        matchesRisk &&
        matchesOwner &&
        matchesPriority &&
        matchesPeriod &&
        matchesOverdue &&
        matchesWithoutTask &&
        (!normalizedQuery || searchable.includes(normalizedQuery))
      );
    });
  }, [
    dealViews,
    leadTypeFilter,
    onlyOverdue,
    ownerFilter,
    periodFilter,
    priorityFilter,
    projectFilter,
    riskFilter,
    searchTerm,
    sourceFilter,
    stageFilter,
    withoutTask,
  ]);

  const selectedDealView =
    dealViews.find((item) => item.deal.id === selectedDealId) ?? filteredDealViews[0] ?? dealViews[0];
  const selectedDeal = selectedDealView?.deal;
  const selectedHistory = selectedDeal ? stageHistory[selectedDeal.id] ?? [] : [];
  const visibleOpenDealViews = filteredDealViews.filter((item) => !isEndStage(item.deal.stage, endStageTitles));
  const openPipelineValue = visibleOpenDealViews.reduce(
    (sum, item) => sum + parseEuroValue(item.deal.value),
    0,
  );
  const weightedForecast = visibleOpenDealViews.reduce(
    (sum, item) => sum + parseEuroValue(item.deal.value) * (item.deal.probability / 100),
    0,
  );
  const closeSoonDeals = visibleOpenDealViews.filter((item) => {
    const closeDate = parseDisplayDate(item.deal.expectedCloseDate).getTime();
    return closeDate >= TODAY_START && closeDate <= TODAY_START + 60 * 24 * 60 * 60 * 1000;
  });
  const riskyDeals = visibleOpenDealViews.filter((item) => item.deal.riskLevel === "hoch" || item.deal.probability < 45);
  const dealsWithoutNextAction = visibleOpenDealViews.filter((item) => !item.deal.nextAction.trim());
  const overdueExpectedCloseDeals = visibleOpenDealViews.filter((item) => {
    const closeDate = parseDisplayDate(item.deal.expectedCloseDate).getTime();
    return Number.isFinite(closeDate) && closeDate < TODAY_START;
  });
  const lostReasonSummary = filteredDealViews
    .filter((item) => isLostStageName(item.deal.stage))
    .reduce<Record<string, number>>((summary, item) => {
      const key = item.deal.lostReasonCategory ?? "other";
      summary[key] = (summary[key] ?? 0) + 1;
      return summary;
    }, {});
  const lostReasonSummaryText = Object.entries(lostReasonSummary)
    .map(([category, count]) => `${text.reasonCategoryLabels[category as DealCloseReasonCategory] ?? category}: ${count}`)
    .join(" · ") || textValue("noLostReasons", language === "de" ? "Noch keine Verlustgründe" : "No lost reasons yet");
  const createContactId = contacts.some((contact) => contact.id === newDeal.contactId)
    ? newDeal.contactId
    : contacts[0]?.id ?? "";

  const patchDeal = (dealId: string, patch: DealPatch) => {
    setSavedMessage("");
    setDealPatches((current) => ({
      ...current,
      [dealId]: {
        ...current[dealId],
        ...patch,
      },
    }));
  };

  const removePersistedStagePatch = (dealId: string) => {
    setDealPatches((current) => {
      const existing = current[dealId];
      if (!existing || !("stage" in existing)) return current;

      const rest: DealPatch = { ...existing };
      delete rest.stage;
      if (Object.keys(rest).length === 0) {
        const next = { ...current };
        delete next[dealId];
        return next;
      }

      return { ...current, [dealId]: rest };
    });
  };

  const removeDealPatch = (dealId: string) => {
    setDealPatches((current) => {
      if (!current[dealId]) return current;

      const next = { ...current };
      delete next[dealId];
      return next;
    });
  };

  const persistDeal = async (deal: Deal, reason?: string) => {
    try {
      const response = await fetch(`/api/crm/deals${workspaceQuery}`, {
        body: JSON.stringify({ deal, reason }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) return null;

      const payload = await response.json() as { deal?: Deal };
      return payload.deal ?? null;
    } catch {
      return null;
    }
  };

  const persistStageChange = async (input: {
    dealId: string;
    reason?: string;
    reasonCategory?: DealCloseReasonCategory;
    reasonDetail?: string;
    toStage: DealStage;
  }) => {
    try {
      const response = await fetch(`/api/crm/deals/${encodeURIComponent(input.dealId)}/stage${workspaceQuery}`, {
        body: JSON.stringify({
          reason: input.reason,
          reasonCategory: input.reasonCategory,
          reasonDetail: input.reasonDetail,
          toStage: input.toStage,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) return null;

      const payload = await response.json() as { deal?: Deal; history?: DealStageHistoryEntry | null };
      return {
        deal: payload.deal ?? null,
        history: payload.history ? mapStageHistoryEntry(payload.history) : null,
      };
    } catch {
      return null;
    }
  };

  const refreshDealsFromSource = async () => {
    if (!onDealsChanged) {
      return false;
    }

    try {
      const refreshed = await onDealsChanged();
      return refreshed !== false;
    } catch {
      return false;
    }
  };

  const removeServerSyncedDealOverlay = (dealId: string, previousDealId = dealId) => {
    setPersistedDealOverrides((current) => {
      if (!current[dealId] && !current[previousDealId]) return current;

      const next = { ...current };
      delete next[dealId];
      delete next[previousDealId];
      return next;
    });
    setManualDeals((current) => current.filter((item) => item.id !== dealId && item.id !== previousDealId));
  };

  const getObjectLabel = (item: DealView | undefined) => {
    if (!item) {
      return text.noObject;
    }

    if (item.unit) {
      return `${item.unit.unitNumber} · ${item.unit.rooms} Zimmer · ${item.unit.areaSqm} m² · ${text.unitStatus[item.unit.status]}`;
    }

    if (item.listing) {
      return item.listing.title;
    }

    if (item.lead?.objectType || item.lead?.region) {
      return [item.lead.objectType, item.lead.region].filter(Boolean).join(" · ");
    }

    return text.noObject;
  };

  const getStageGateWarnings = (item: DealView | undefined, targetStage: DealStage) => {
    const warnings: string[] = [];

    if (!item) {
      return warnings;
    }

    if (["Termin gebucht", "Besichtigung/Beratung"].includes(targetStage) && !item.relevantEvent) {
      warnings.push(text.missingMeeting);
    }

    if (targetStage === "Angebot/Reservierung") {
      if (!item.unit && !item.listing) {
        warnings.push(text.missingUnit);
      }

      if (!item.nextTask) {
        warnings.push(text.missingNextTask);
      }

      if (!parseEuroValue(item.deal.value)) {
        warnings.push(text.missingValue);
      }

      warnings.push(text.reservationCheck);
    }

    if (["Abschlussprüfung", "Abschlusspruefung", "Vertragsprüfung", "Vertragspruefung", "Gewonnen", "Aktiv"].includes(targetStage)) {
      if (!item.deal.expectedCloseDate) {
        warnings.push(text.missingCloseDate);
      }

      if (!parseEuroValue(item.deal.value)) {
        warnings.push(text.missingValue);
      }
    }

    if (targetStage === "Verloren" || targetStage === "Pausiert / Verloren") {
      warnings.push(text.lostReasonRequired);
    }

    if (targetStage === "Disqualifiziert") {
      warnings.push(text.disqualifiedReasonRequired);
    }

    return warnings;
  };

  const commitStageChange = async (
    deal: Deal,
    targetStage: DealStage,
    reason?: string,
    reasonCategory?: DealCloseReasonCategory,
  ) => {
    const nextStage = normalizeDealStage(targetStage, orderedStageTitles);

    if (deal.stage === nextStage && !reason?.trim()) {
      setStageReview(null);
      setDropStage("");
      setDraggedDealId("");
      return;
    }

    const localHistoryId = `stage_${deal.id}_${deal.stage}_${nextStage}_${stageHistory[deal.id]?.length ?? 0}`;
    const closeReasonCategory = nextStage === "Gewonnen" ? "won" : reasonCategory;
    const reasonDetail = reason?.trim() || "";

    patchDeal(deal.id, { stage: nextStage });
    setStageHistory((current) => ({
      ...current,
      [deal.id]: [
        {
          actor: text.historyLocalActor,
          changedAt: new Date().toISOString(),
          fromStage: deal.stage,
          id: localHistoryId,
          reason: reasonDetail || undefined,
          reasonCategory: closeReasonCategory,
          reasonDetail: reasonDetail || undefined,
          toStage: nextStage,
        },
        ...(current[deal.id] ?? []),
      ],
    }));
    setSelectedDealId(deal.id);
    setSavedMessage(text.stageMoved(deal.name, nextStage));
    setStageReview(null);
    setDropStage("");
    setDraggedDealId("");
    const persisted = await persistStageChange({
      dealId: deal.id,
      reason: reasonDetail || undefined,
      reasonCategory: closeReasonCategory,
      reasonDetail: reasonDetail || undefined,
      toStage: nextStage,
    });

    if (!persisted?.deal) {
      patchDeal(deal.id, { stage: deal.stage });
      setStageHistory((current) => ({
        ...current,
        [deal.id]: (current[deal.id] ?? []).filter((entry) => entry.id !== localHistoryId),
      }));
      setSavedMessage(text.stageMoveFailed);
      return;
    }

    const persistedDeal = persisted.deal;
    setPersistedDealOverrides((current) => ({
      ...current,
      [persistedDeal.id]: persistedDeal,
    }));
    removePersistedStagePatch(deal.id);

    if (persisted.history) {
      setStageHistory((current) => ({
        ...current,
        [deal.id]: [
          persisted.history as StageHistoryEntry,
          ...(current[deal.id] ?? []).filter((entry) => entry.id !== localHistoryId),
        ],
      }));
    }

    setSavedMessage(text.stageMoved(persistedDeal.name, persistedDeal.stage));
    setManualDeals((current) =>
      current.map((item) => (item.id === deal.id ? persistedDeal : item)),
    );
    if (persistedDeal.id !== deal.id) {
      setDealPatches((current) => {
        const next = { ...current };
        delete next[deal.id];
        return next;
      });
      setSelectedDealId(persistedDeal.id);
    }

    const refreshed = await refreshDealsFromSource();
    if (refreshed) {
      removeServerSyncedDealOverlay(persistedDeal.id, deal.id);
    }
  };

  const requestStageChange = (deal: Deal, targetStage: DealStage) => {
    const nextStage = normalizeDealStage(targetStage, orderedStageTitles);
    const item = dealViews.find((view) => view.deal.id === deal.id);
    const warnings = getStageGateWarnings(item, nextStage);
    const reasonRequired = nextStage === "Verloren" || nextStage === "Disqualifiziert" || nextStage === "Pausiert / Verloren";

    if (warnings.length > 0 || reasonRequired) {
      setStageReview({
        dealId: deal.id,
        reason: "",
        reasonCategory: "",
        reasonRequired,
        targetStage: nextStage,
        warnings,
      });
      return;
    }

    void commitStageChange(deal, nextStage);
  };

  const moveDeal = (deal: Deal, direction: -1 | 1) => {
    const currentIndex = orderedStageTitles.indexOf(deal.stage);
    const nextStage = orderedStageTitles[currentIndex + direction];

    if (nextStage) {
      requestStageChange(deal, nextStage);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLElement>, dealId: string) => {
    setDraggedDealId(dealId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dealId);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>, stage: DealStage) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropStage(stage);
  };

  const handleDrop = (event: DragEvent<HTMLElement>, stage: DealStage) => {
    event.preventDefault();
    const dealId = event.dataTransfer.getData("text/plain") || draggedDealId;
    const deal = workingDeals.find((item) => item.id === dealId);

    if (deal) {
      requestStageChange(deal, stage);
    }
  };

  const selectCardWithKeyboard = (event: KeyboardEvent<HTMLElement>, dealId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedDealId(dealId);
    }
  };

  const createDeal = async () => {
    if (creatingDeal) {
      return;
    }

    const contact = contacts.find((item) => item.id === createContactId);
    if (!contact) {
      return;
    }

    setCreatingDeal(true);
    setSavedMessage("");
    const project = projects.find((item) => item.id === contact.projectId);
    const now = new Date();
    const probability = Number(newDeal.probability);
    const createStage = workStageTitles.includes(newDeal.stage) ? newDeal.stage : firstWorkStage;
    const deal: Deal = {
      id: `deal_manual_${now.getTime()}`,
      workspaceId: contact.workspaceId,
      projectId: contact.projectId,
      contactId: contact.id,
      organizationId: contact.organizationId,
      ownerUserId: users[0]?.id,
      name: newDeal.name.trim() || `${contact.name} Deal`,
      stage: normalizeDealStage(createStage, orderedStageTitles),
      value: sanitizeAmount(newDeal.value),
      probability,
      expectedCloseDate: newDeal.expectedCloseDate,
      riskLevel: probability < 45 ? "hoch" : probability < 65 ? "mittel" : "niedrig",
      source: contact.source,
      nextAction: contact.intent || text.defaultNextAction,
    };

    try {
      const persistedDeal = await persistDeal(deal);
      if (!persistedDeal) {
        setSavedMessage(text.createFailed);
        return;
      }

      setManualDeals((current) => [persistedDeal, ...current.filter((item) => item.id !== persistedDeal.id)]);
      setSelectedDealId(persistedDeal.id);
      setStageFilter("all");
      setRiskFilter("all");
      setOwnerFilter("all");
      setProjectFilter("all");
      setLeadTypeFilter("all");
      setSourceFilter("all");
      setPriorityFilter("all");
      setSearchTerm("");
      setNewDeal((current) => ({
        ...current,
        name: "",
        probability: 50,
        stage: firstWorkStage,
        value: "250.000",
      }));
      setIsCreateOpen(false);
      setSavedMessage(text.createdDeal(project?.name ?? contact.project));

      const refreshed = await refreshDealsFromSource();
      if (refreshed) {
        removeServerSyncedDealOverlay(persistedDeal.id);
      }
    } finally {
      setCreatingDeal(false);
    }
  };

  const discardDraftChanges = () => {
    setDealPatches({});
    setSavedMessage(text.draftDiscarded);
  };

  const clearQuickFilters = () => {
    setOnlyOverdue(false);
    setWithoutTask(false);
  };

  const stageReviewDealView = stageReview ? dealViews.find((item) => item.deal.id === stageReview.dealId) : undefined;
  const stageReviewDeal = stageReviewDealView?.deal;
  const canConfirmReview = Boolean(
    !stageReview?.reasonRequired ||
      (stageReview.reasonCategory && stageReview.reason.trim().length >= 3),
  );
  const dealFieldRows = selectedDeal
    ? [
        ["deal_name", selectedDeal.name],
        ["amount", selectedDeal.value],
        ["pipeline_stage", selectedDeal.stage],
        ["project_pipeline", selectedDealView.project?.defaultPipelineId],
        ["expected_close_date", selectedDeal.expectedCloseDate],
        ["owner_email", selectedDealView.owner?.email],
        ["linked_contact", selectedDealView.contact?.name],
        ["linked_organization", selectedDealView.organization?.name],
      ]
    : [];

  const renderDealCard = (item: DealView, compact = false) => {
    const isSelected = selectedDeal?.id === item.deal.id;
    const firstWarning = item.warnings[0];
    const budgetLabel = getLeadBudget(item.lead, locale) || formatEuro(parseEuroValue(item.deal.value), locale);

    return (
      <article
        aria-label={item.deal.name}
        className={`cursor-grab rounded-lg border bg-white p-3 text-left shadow-sm transition active:cursor-grabbing ${
          isSelected ? "border-slate-950 ring-2 ring-slate-950/10" : "border-stone-200 hover:border-emerald-300"
        }`}
        draggable
        key={item.deal.id}
        onClick={() => setSelectedDealId(item.deal.id)}
        onDragEnd={() => {
          setDraggedDealId("");
          setDropStage("");
        }}
        onDragStart={(event) => handleDragStart(event, item.deal.id)}
        onKeyDown={(event) => selectCardWithKeyboard(event, item.deal.id)}
        role="button"
        tabIndex={0}
      >
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold text-slate-950">{item.deal.name}</p>
            <p className="mt-1 break-words text-xs font-semibold uppercase tracking-[0.12em] text-emerald-700">
              {item.contact?.name ?? item.organization?.name ?? getCrmSourceLabel(item.deal.source, language)}
            </p>
          </div>
          <span className="shrink-0 rounded-md bg-slate-950 px-2 py-1 text-xs font-semibold text-white">
            {item.deal.probability}%
          </span>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-semibold">
          <span className="rounded-md bg-stone-100 px-2 py-1 text-stone-700">{item.leadType}</span>
          <span className="rounded-md bg-blue-50 px-2 py-1 text-blue-800">{budgetLabel}</span>
        </div>

        {!compact ? (
          <>
            <p className="mt-3 break-words text-xs font-semibold text-stone-700">
              {item.project?.name ?? projectLabel} · {getObjectLabel(item)}
            </p>
            <div className="mt-3 grid gap-2 text-xs">
              <span className="break-words rounded-md bg-blue-50 px-2 py-1.5 font-semibold text-blue-800">
                {item.nextTask
                  ? `${item.nextTask.title} · ${getCrmTaskDueLabel(item.nextTask.due, language)}`
                  : item.deal.nextAction || text.defaultNextAction}
              </span>
              <span className="break-words rounded-md bg-stone-50 px-2 py-1.5 font-semibold text-stone-700">
                {item.relevantEvent ? formatDateTime(item.relevantEvent.startsAt, locale) : text.noAppointment}
              </span>
              <span className={`rounded-md border px-2 py-1 font-semibold ${riskStyles[item.deal.riskLevel]}`}>
                {text.risk}: {getCrmRiskLabel(item.deal.riskLevel, language)}
              </span>
            </div>
          </>
        ) : null}

        {firstWarning ? (
          <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-semibold">
            {item.warnings.slice(0, compact ? 1 : 2).map((warning) => (
              <span className={`rounded-md border px-2 py-1 ${warningStyles[warning.tone]}`} key={warning.id}>
                {text.warningLabels[warning.id]}
              </span>
            ))}
          </div>
        ) : null}

        <p className="mt-3 break-words text-xs text-stone-500">
          {item.owner?.name ?? "-"} · {getCrmSourceLabel(item.deal.source, language)} · {text.daysShort(item.stageAgeDays)}
        </p>
      </article>
    );
  };

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-4 md:p-5">
        <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {projectLabel}
            </p>
            <h3 className="mt-1 text-2xl font-semibold">{text.title}</h3>
            <p className="mt-2 max-w-4xl break-words text-sm text-stone-600">{text.description}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap 2xl:justify-end">
            <button
              className="rounded-md border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:text-stone-400"
              disabled={Object.keys(dealPatches).length === 0}
              onClick={discardDraftChanges}
              type="button"
            >
              {text.discardDraft}
            </button>
            <button
              className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={() => setIsCreateOpen((current) => !current)}
              type="button"
            >
              {isCreateOpen ? text.close : text.createDeal}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            { label: textValue("openPipelineValue", language === "de" ? "Offener Pipelinewert" : "Open pipeline value"), value: formatEuro(openPipelineValue, locale), detail: text.totalValue },
            { label: textValue("forecast", language === "de" ? "Gewichteter Forecast" : "Weighted forecast"), value: formatEuro(weightedForecast, locale), detail: text.weightedValue },
            { label: textValue("openDeals", language === "de" ? "Offene Deals" : "Open deals"), value: String(visibleOpenDealViews.length), detail: projectLabel },
            { label: textValue("closeSoon", language === "de" ? "Abschlüsse 60 Tage" : "Closings 60 days"), value: String(closeSoonDeals.length), detail: text.expectedClose },
            { label: textValue("noNextActionDeals", language === "de" ? "Ohne nächste Aktion" : "No next action"), value: String(dealsWithoutNextAction.length), detail: text.nextStep },
            { label: textValue("overdueExpectedClose", language === "de" ? "Überfällige Abschlüsse" : "Overdue close dates"), value: String(overdueExpectedCloseDeals.length), detail: text.expectedClose },
            { label: textValue("riskDeals", language === "de" ? "Deals mit Risiko" : "Risk deals"), value: String(riskyDeals.length), detail: text.stageHealth },
            { label: textValue("lostReasons", language === "de" ? "Verlustgründe" : "Lost reasons"), value: String(Object.values(lostReasonSummary).reduce((sum, count) => sum + count, 0)), detail: lostReasonSummaryText },
          ].map((metric) => (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" key={metric.label}>
              <p className="break-words text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {metric.label}
              </p>
              <p className="mt-2 break-words text-xl font-semibold text-slate-950">{metric.value}</p>
              <p className="mt-1 break-words text-xs text-stone-500">{metric.detail}</p>
            </div>
          ))}
        </div>

        {savedMessage ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
            {savedMessage}
          </div>
        ) : null}

        {isCreateOpen ? (
          <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 xl:col-span-2">
                {text.newDealName}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => setNewDeal((current) => ({ ...current, name: event.target.value }))}
                  value={newDeal.name}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.contactLabel}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  disabled={contacts.length === 0}
                  onChange={(event) => setNewDeal((current) => ({ ...current, contactId: event.target.value }))}
                  value={createContactId}
                >
                  {contacts.length > 0 ? (
                    contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))
                  ) : (
                    <option>{text.contactMissing}</option>
                  )}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.stage}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => setNewDeal((current) => ({ ...current, stage: event.target.value as DealStage }))}
                  value={workStageTitles.includes(newDeal.stage) ? newDeal.stage : firstWorkStage}
                >
                  {workStageTitles.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.amount}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => setNewDeal((current) => ({ ...current, value: event.target.value }))}
                  value={newDeal.value}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.probability}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  max={100}
                  min={0}
                  onChange={(event) => setNewDeal((current) => ({ ...current, probability: Number(event.target.value) }))}
                  type="number"
                  value={newDeal.probability}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.closeDate}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => setNewDeal((current) => ({ ...current, expectedCloseDate: event.target.value }))}
                  type="date"
                  value={newDeal.expectedCloseDate}
                />
              </label>
            </div>
            <button
              className="mt-4 rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-300"
              disabled={contacts.length === 0 || creatingDeal}
              onClick={() => void createDeal()}
              type="button"
            >
              {creatingDeal ? text.creating : text.create}
            </button>
          </div>
        ) : null}
      </article>

      <article className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.search}
            <input
              className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={text.searchPlaceholder}
              type="search"
              value={searchTerm}
            />
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.projectFilter}
            <select className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950" onChange={(event) => setProjectFilter(event.target.value)} value={projectFilter}>
              <option value="all">{text.all}</option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.leadType}
            <select className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950" onChange={(event) => setLeadTypeFilter(event.target.value as LeadTypeFilter)} value={leadTypeFilter}>
              <option value="all">{text.all}</option>
              {leadTypeOptions.map((leadType) => (
                <option key={leadType} value={leadType}>{leadType}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.stage}
            <select className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950" onChange={(event) => setStageFilter(event.target.value as StageFilter)} value={stageFilter}>
              <option value="all">{text.all}</option>
              {orderedStageTitles.map((stage) => (
                <option key={stage} value={stage}>{stage}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.owner}
            <select className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950" onChange={(event) => setOwnerFilter(event.target.value)} value={ownerFilter}>
              <option value="all">{text.all}</option>
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>{owner.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.source}
            <select className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950" onChange={(event) => setSourceFilter(event.target.value as SourceFilter)} value={sourceFilter}>
              <option value="all">{text.all}</option>
              {sourceOptions.map((source) => (
                <option key={source} value={source}>{getCrmSourceLabel(source, language)}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.risk}
            <select className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950" onChange={(event) => setRiskFilter(event.target.value as RiskFilter)} value={riskFilter}>
              <option value="all">{text.all}</option>
              <option value="niedrig">{getCrmRiskLabel("niedrig", language)}</option>
              <option value="mittel">{getCrmRiskLabel("mittel", language)}</option>
              <option value="hoch">{getCrmRiskLabel("hoch", language)}</option>
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.period}
            <select className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950" onChange={(event) => setPeriodFilter(event.target.value as PeriodFilter)} value={periodFilter}>
              {PERIOD_OPTIONS.map((period) => (
                <option key={period} value={period}>{text.periods[period]}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <label className="flex min-w-0 items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-stone-700">
            <input checked={onlyOverdue} onChange={(event) => setOnlyOverdue(event.target.checked)} type="checkbox" />
            <span className="break-words">{text.onlyOverdue}</span>
          </label>
          <label className="flex min-w-0 items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-stone-700">
            <input checked={withoutTask} onChange={(event) => setWithoutTask(event.target.checked)} type="checkbox" />
            <span className="break-words">{text.withoutTask}</span>
          </label>
          <label className="flex min-w-0 items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-stone-700">
            <span className="break-words">{text.priority}</span>
            <select className="min-w-24 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm" onChange={(event) => setPriorityFilter(event.target.value as PriorityFilter)} value={priorityFilter}>
              <option value="all">{text.all}</option>
              {PRIORITY_OPTIONS.map((priority) => (
                <option key={priority} value={priority}>{priority}</option>
              ))}
            </select>
          </label>
          <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100" onClick={clearQuickFilters} type="button">
            {text.clearQuickFilters}
          </button>
        </div>
      </article>

      <section className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid gap-4">
          <article className="rounded-lg border border-stone-200 bg-white p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h4 className="text-lg font-semibold text-slate-950">{text.endStatus}</h4>
                <p className="mt-1 max-w-3xl text-sm text-stone-500">{text.endStatusDescription}</p>
              </div>
              <p className="text-sm font-semibold text-stone-500">{text.dragHint}</p>
            </div>
            <div className="mt-4 overflow-x-auto">
              <div
                className="grid min-w-[720px] gap-2"
                style={{ gridTemplateColumns: `repeat(${Math.max(endStageTitles.length, 1)}, minmax(220px, 1fr))` }}
              >
                {endStageTitles.map((stage) => {
                  const stageDeals = filteredDealViews.filter((item) => item.deal.stage === stage);
                  const stageValue = stageDeals.reduce((sum, item) => sum + parseEuroValue(item.deal.value), 0);
                  const stageMeta = stageConfigByName.get(stage);

                  return (
                    <section
                      className={`rounded-lg border border-dashed p-3 transition ${
                        dropStage === stage ? "border-emerald-400 bg-emerald-50" : "border-stone-300 bg-stone-50"
                      }`}
                      key={stage}
                      onDragOver={(event) => handleDragOver(event, stage)}
                      onDrop={(event) => handleDrop(event, stage)}
                    >
                      <div className="mb-3 flex items-start justify-between gap-2">
                        <div>
                          <h5 className="text-sm font-semibold text-slate-950">{stage}</h5>
                          <p className="mt-1 text-xs text-stone-500">
                            {stageDeals.length} · {formatEuro(stageValue, locale)}
                          </p>
                          {stageMeta ? (
                            <p className="mt-1 text-xs font-semibold text-stone-500">
                              {stageMeta.probability}%{stageMeta.slaHours ? ` · SLA ${stageMeta.slaHours}h` : ""}
                            </p>
                          ) : null}
                        </div>
                        <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{stageDeals.length}</span>
                      </div>
                      <div className="space-y-2">
                        {stageDeals.length > 0 ? stageDeals.map((item) => renderDealCard(item, true)) : (
                          <div className="rounded-md border border-dashed border-stone-300 bg-white p-3 text-sm text-stone-500">{text.dropHere}</div>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </article>

          <article className="rounded-lg border border-stone-200 bg-white p-3">
            <div className="mb-3 flex flex-col gap-1 px-1 md:flex-row md:items-end md:justify-between">
              <div>
                <h4 className="text-lg font-semibold text-slate-950">{text.workBoard}</h4>
                <p className="text-sm text-stone-500">{text.dragHint}</p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(workStageTitles.length, 1)}, minmax(210px, 1fr))`,
                  minWidth: `${Math.max(workStageTitles.length, 1) * 210}px`,
                }}
              >
                {workStageTitles.map((stage, index) => {
                  const stageDeals = filteredDealViews
                    .filter((item) => item.deal.stage === stage)
                    .sort((a, b) => b.deal.probability - a.deal.probability);
                  const stageValue = stageDeals.reduce((sum, item) => sum + parseEuroValue(item.deal.value), 0);
                  const weightedValue = stageDeals.reduce(
                    (sum, item) => sum + parseEuroValue(item.deal.value) * (item.deal.probability / 100),
                    0,
                  );
                  const overdueTasks = stageDeals.filter((item) => item.linkedTasks.some(isTaskOverdue)).length;
                  const avgStageDays = stageDeals.length
                    ? Math.round(stageDeals.reduce((sum, item) => sum + item.stageAgeDays, 0) / stageDeals.length)
                    : 0;
                  const nextStage = workStageTitles[index + 1];
                  const stageMeta = stageConfigByName.get(stage);

                  return (
                    <section
                      className={`rounded-lg p-3 transition ${
                        dropStage === stage ? "bg-emerald-50 ring-2 ring-emerald-300" : "bg-stone-100"
                      }`}
                      key={stage}
                      onDragOver={(event) => handleDragOver(event, stage)}
                      onDrop={(event) => handleDrop(event, stage)}
                    >
                      <div className="mb-3 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h4 className="break-words text-sm font-semibold">{stage}</h4>
                          <p className="mt-1 break-words text-xs text-stone-500">
                            {nextStage ? text.nextStageHint(nextStage) : text.stageHealth}
                          </p>
                          {stageMeta ? (
                            <p className="mt-1 break-words text-xs font-semibold text-stone-500">
                              {stageMeta.probability}%{stageMeta.slaHours ? ` · SLA ${stageMeta.slaHours}h` : ""}
                            </p>
                          ) : null}
                        </div>
                        <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">
                          {stageDeals.length}
                        </span>
                      </div>

                      <div className="mb-3 grid gap-1.5 text-[11px]">
                        <div className="flex items-start justify-between gap-2 rounded-md bg-white px-2 py-1.5">
                          <span className="break-words font-semibold text-stone-500">{text.totalValue}</span>
                          <span className="shrink-0 font-semibold text-slate-950">{formatEuro(stageValue, locale)}</span>
                        </div>
                        <div className="flex items-start justify-between gap-2 rounded-md bg-white px-2 py-1.5">
                          <span className="break-words font-semibold text-stone-500">{text.weightedValue}</span>
                          <span className="shrink-0 font-semibold text-slate-950">{formatEuro(weightedValue, locale)}</span>
                        </div>
                        <div className="flex items-start justify-between gap-2 rounded-md bg-white px-2 py-1.5">
                          <span className="break-words font-semibold text-stone-500">{text.overdueTasks}</span>
                          <span className="shrink-0 font-semibold text-slate-950">{overdueTasks}</span>
                        </div>
                        <div className="flex items-start justify-between gap-2 rounded-md bg-white px-2 py-1.5">
                          <span className="break-words font-semibold text-stone-500">{text.avgStageDays}</span>
                          <span className="shrink-0 font-semibold text-slate-950">{text.daysShort(avgStageDays)}</span>
                        </div>
                      </div>

                      <div className="space-y-3">
                        {stageDeals.length > 0 ? (
                          stageDeals.map((item) => renderDealCard(item))
                        ) : (
                          <div className="rounded-lg border border-dashed border-stone-300 bg-white p-3 text-sm text-stone-500">
                            {text.emptyStage}
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </article>
        </div>

        <aside className="rounded-lg border border-stone-200 bg-white p-4 md:p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
            {text.selectedDeal}
          </p>
          <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
            {selectedDeal?.name ?? text.noDeals}
          </h4>

          {selectedDeal ? (
            <>
              <div className="mt-4 grid gap-3 text-sm">
                {[
                  [text.stage, selectedDeal.stage],
                  [text.project, selectedDealView.project?.name ?? projectLabel],
                  [text.contact, selectedDealView.contact?.name],
                  [text.organization, selectedDealView.organization?.name],
                  [text.leadType, selectedDealView.leadType],
                  [text.objectContext, getObjectLabel(selectedDealView)],
                  [text.owner, selectedDealView.owner?.name],
                  [text.source, getCrmSourceLabel(selectedDeal.source, language)],
                  [text.nextAppointment, selectedDealView.relevantEvent ? formatDateTime(selectedDealView.relevantEvent.startsAt, locale) : text.noAppointment],
                ].map(([label, value]) => (
                  <div className="grid gap-1 rounded-md bg-stone-50 p-3" key={label}>
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {label}
                    </span>
                    <span className="break-words font-semibold text-slate-900">{value ?? "-"}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid gap-3">
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.stageSelect}
                  <select
                    className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) => requestStageChange(selectedDeal, event.target.value as DealStage)}
                    value={selectedDeal.stage}
                  >
                    {orderedStageTitles.map((stage) => (
                      <option key={stage} value={stage}>{stage}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.value}
                  <input
                    className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) => patchDeal(selectedDeal.id, { value: event.target.value })}
                    value={selectedDeal.value}
                  />
                </label>
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.probability}: {selectedDeal.probability}%
                  <input
                    className="mt-2 w-full accent-slate-950"
                    max={100}
                    min={0}
                    onChange={(event) => patchDeal(selectedDeal.id, { probability: Number(event.target.value) })}
                    type="range"
                    value={selectedDeal.probability}
                  />
                </label>
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.expectedClose}
                  <input
                    className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) => patchDeal(selectedDeal.id, { expectedCloseDate: event.target.value })}
                    type="date"
                    value={selectedDeal.expectedCloseDate}
                  />
                </label>
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.risk}
                  <select
                    className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) => patchDeal(selectedDeal.id, { riskLevel: event.target.value as Deal["riskLevel"] })}
                    value={selectedDeal.riskLevel}
                  >
                    <option value="niedrig">{getCrmRiskLabel("niedrig", language)}</option>
                    <option value="mittel">{getCrmRiskLabel("mittel", language)}</option>
                    <option value="hoch">{getCrmRiskLabel("hoch", language)}</option>
                  </select>
                </label>
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.nextStep}
                  <textarea
                    className="mt-2 min-h-20 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) => patchDeal(selectedDeal.id, { nextAction: event.target.value })}
                    value={selectedDeal.nextAction}
                  />
                </label>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={orderedStageTitles.indexOf(selectedDeal.stage) <= 0}
                  onClick={() => moveDeal(selectedDeal, -1)}
                  type="button"
                >
                  {text.moveBack}
                </button>
                <button
                  className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-300"
                  disabled={orderedStageTitles.indexOf(selectedDeal.stage) >= orderedStageTitles.length - 1}
                  onClick={() => moveDeal(selectedDeal, 1)}
                  type="button"
                >
                  {text.moveForward}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[
                  ...endStageTitles.map((stage) => [
                    stage,
                    stage === "Gewonnen" || stage === "Aktiv" ? text.endWon : stage === "Disqualifiziert" ? text.endDisqualified : text.endLost,
                    stage === "Gewonnen" || stage === "Aktiv"
                      ? "bg-emerald-700 hover:bg-emerald-800"
                      : stage === "Disqualifiziert"
                        ? "bg-red-700 hover:bg-red-800"
                        : "bg-slate-800 hover:bg-slate-700",
                  ] as const),
                ].map(([stage, label, classes]) => (
                  <button
                    className={`min-h-10 rounded-md px-2 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-300 ${classes}`}
                    disabled={selectedDeal.stage === stage}
                    key={stage}
                    onClick={() => requestStageChange(selectedDeal, stage as DealStage)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                className="mt-3 w-full rounded-md bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-stone-300"
                disabled={savingDealId === selectedDeal.id}
                onClick={() => {
                  if (!selectedDeal) return;
                  setSavingDealId(selectedDeal.id);
                  void persistDeal(selectedDeal).then(async (persistedDeal) => {
                    if (!persistedDeal) {
                      setSavedMessage(text.saveFailed);
                      return;
                    }

                    setPersistedDealOverrides((current) => ({
                      ...current,
                      [persistedDeal.id]: persistedDeal,
                    }));
                    removeDealPatch(selectedDeal.id);
                    setManualDeals((current) =>
                      current.map((item) => (item.id === selectedDeal.id ? persistedDeal : item)),
                    );
                    if (persistedDeal.id !== selectedDeal.id) {
                      setSelectedDealId(persistedDeal.id);
                    }
                    setSavedMessage(text.saved);
                    const refreshed = await refreshDealsFromSource();
                    if (refreshed) {
                      removeServerSyncedDealOverlay(persistedDeal.id, selectedDeal.id);
                    }
                  }).finally(() => {
                    setSavingDealId("");
                  });
                }}
                type="button"
              >
                {text.save}
              </button>

              <div className="mt-4">
                <p className="text-sm font-semibold text-slate-950">{text.warnings}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedDealView.warnings.length > 0 ? selectedDealView.warnings.map((warning) => (
                    <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${warningStyles[warning.tone]}`} key={warning.id}>
                      {text.warningLabels[warning.id]}
                    </span>
                  )) : (
                    <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-600">{text.noWarnings}</span>
                  )}
                </div>
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-950">{text.taskContext}</p>
                  <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">
                    {selectedDealView.linkedTasks.length}
                  </span>
                </div>
                <div className="mt-2 space-y-2">
                  {selectedDealView.linkedTasks.length > 0 ? (
                    selectedDealView.linkedTasks.map((task) => (
                      <div className="rounded-md border border-stone-200 p-3 text-sm" key={task.id}>
                        <p className="break-words font-semibold text-slate-950">{task.title}</p>
                        <p className="mt-1 break-words text-xs text-stone-500">
                          {getCrmTaskDueLabel(task.due, language)} · {task.priority}
                        </p>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-500">
                      {text.noTasks}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-4">
                <p className="text-sm font-semibold text-slate-950">{text.stageHistory}</p>
                <div className="mt-2 space-y-2">
                  {selectedHistory.length > 0 ? selectedHistory.map((entry) => (
                    <div className="rounded-md border border-stone-200 p-3 text-sm" key={entry.id}>
                      <p className="break-words font-semibold text-slate-950">
                        {entry.fromStage} → {entry.toStage}
                      </p>
                      <p className="mt-1 break-words text-xs text-stone-500">
                        {formatDate(entry.changedAt, locale)} · {entry.actor}
                      </p>
                      {entry.reasonCategory ? (
                        <p className="mt-2 break-words text-xs font-semibold text-stone-700">
                          {text.reasonCategory}: {text.reasonCategoryLabels[entry.reasonCategory]}
                        </p>
                      ) : null}
                      {entry.reason ? (
                        <p className="mt-2 break-words text-xs font-semibold text-stone-700">
                          {text.historyReason}: {entry.reason}
                        </p>
                      ) : null}
                      {entry.reasonDetail && entry.reasonDetail !== entry.reason ? (
                        <p className="mt-2 break-words text-xs font-semibold text-stone-700">
                          {text.reasonDetail}: {entry.reasonDetail}
                        </p>
                      ) : null}
                    </div>
                  )) : (
                    <div className="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-500">
                      {text.stageHistoryPlaceholder}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </aside>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_0.8fr]">
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <h4 className="text-lg font-semibold">{text.fieldMapping}</h4>
              <p className="mt-1 max-w-3xl break-words text-sm text-stone-500">
                {selectedDeal?.name ?? text.noDeals}
              </p>
            </div>
            <span className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              {text.importReady}
            </span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead className="border-b border-stone-200 text-xs uppercase tracking-[0.12em] text-stone-500">
                <tr>
                  <th className="py-2 pr-3 font-semibold">{text.fieldColumn}</th>
                  <th className="py-2 pr-3 font-semibold">{text.valueColumn}</th>
                  <th className="py-2 font-semibold">{text.statusColumn}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {dealFieldRows.map(([field, value]) => (
                  <tr key={field}>
                    <td className="py-3 pr-3 font-semibold text-slate-900">{field}</td>
                    <td className="py-3 pr-3 text-stone-600">{value ?? "-"}</td>
                    <td className="py-3">
                      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${value ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
                        {value ? text.importReady : text.missing}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="rounded-lg border border-stone-200 bg-slate-950 p-5 text-white">
          <h4 className="text-lg font-semibold">{text.pipelineSetup}</h4>
          <p className="mt-2 break-words text-sm text-slate-300">{text.setupDescription}</p>
          <p className="mt-2 break-words text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
            {activePipelineNames.length > 0 ? activePipelineNames.join(" · ") : text.staticFallback}
          </p>
          <div className="mt-4 grid gap-3 text-sm">
            {orderedStageTitles.map((stage) => {
              const stageDeals = workingDeals.filter((deal) => deal.stage === stage);
              const value = stageDeals.reduce((sum, deal) => sum + parseEuroValue(deal.value), 0);
              const configured = Boolean(stageConfigByName.get(stage)) || pipeline.some((item) => normalizeDealStage(item.title, orderedStageTitles) === stage);

              return (
                <div className="rounded-lg border border-white/10 bg-white/5 p-3" key={stage}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="break-words font-semibold text-slate-100">{stage}</span>
                    <span className="rounded-md bg-white/10 px-2 py-1 text-xs font-semibold text-slate-200">
                      {stageDeals.length}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-xs text-slate-300">
                    {value > 0 ? formatEuro(value, locale) : text.emptyStage}
                  </p>
                  {!configured ? (
                    <p className="mt-1 text-xs font-semibold text-amber-200">{text.stageHistoryPlaceholder}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="mt-5 border-t border-white/10 pt-4">
            <h5 className="text-sm font-semibold text-slate-100">{text.pipelinePermissions}</h5>
            <p className="mt-1 break-words text-xs text-slate-400">{text.pipelinePermissionsDescription}</p>
            <div className="mt-3 grid gap-2">
              {visiblePipelinePermissions.length > 0 ? (
                visiblePipelinePermissions.map((permission) => {
                  const projectName = projectsById.get(permission.projectId)?.name ?? projectLabel;
                  const actorLabel = permission.userName ?? permission.userEmail ?? permission.userId;
                  const roleLabel = permission.productRole ?? permission.userRole ?? text.permissionRoleFallback;
                  const permissionFlags = [
                    [text.permissionEdit, permission.canEditDeals],
                    [text.permissionMove, permission.canMoveDeals],
                    [text.permissionClose, permission.canCloseDeals],
                    [text.permissionReopen, permission.canReopenDeals],
                  ] as const;

                  return (
                    <div className="rounded-lg border border-white/10 bg-white/5 p-3" key={permission.id}>
                      <div className="flex min-w-0 flex-col gap-1">
                        <p className="break-words text-sm font-semibold text-slate-100">{actorLabel}</p>
                        <p className="break-words text-xs text-slate-400">{projectName} · {roleLabel}</p>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {permissionFlags.map(([label, allowed]) => (
                          <span
                            className={`rounded-md px-2 py-1 text-xs font-semibold ${
                              allowed ? "bg-emerald-400/15 text-emerald-100" : "bg-red-400/15 text-red-100"
                            }`}
                            key={label}
                            title={allowed ? text.permissionAllowed : text.permissionBlocked}
                          >
                            {label}: {allowed ? text.permissionAllowed : text.permissionBlocked}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-lg border border-dashed border-white/15 bg-white/5 p-3 text-sm text-slate-300">
                  {text.pipelinePermissionsEmpty}
                </div>
              )}
            </div>
          </div>
        </article>
      </section>

      {stageReview && stageReviewDeal ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 px-4 py-6">
          <section aria-modal="true" className="w-full max-w-xl rounded-lg border border-stone-200 bg-white p-5 shadow-2xl" role="dialog">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{stageReview.targetStage}</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-950">{text.reviewTitle}</h3>
            <p className="mt-2 text-sm text-stone-600">{text.reviewDescription}</p>
            <div className="mt-4 rounded-md bg-stone-50 p-3">
              <p className="text-sm font-semibold text-slate-950">{stageReviewDeal.name}</p>
              <p className="mt-1 text-xs text-stone-500">{stageReviewDeal.stage} → {stageReview.targetStage}</p>
            </div>
            {stageReview.warnings.length > 0 ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-slate-950">{text.reviewWarnings}</p>
                <ul className="mt-2 space-y-2 text-sm text-stone-700">
                  {stageReview.warnings.map((warning) => (
                    <li className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 font-semibold text-amber-900" key={warning}>
                      {warning}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {stageReview.reasonRequired ? (
              <div className="mt-4 grid gap-3">
                <label className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.reasonCategory}
                  <select
                    className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setStageReview((current) =>
                        current
                          ? { ...current, reasonCategory: event.target.value as DealCloseReasonCategory }
                          : current,
                      )
                    }
                    value={stageReview.reasonCategory}
                  >
                    <option value="">{text.reasonCategoryPlaceholder}</option>
                    {CLOSE_REASON_OPTIONS.map((category) => (
                      <option key={category} value={category}>
                        {text.reasonCategoryLabels[category]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.reasonDetail}
                  <textarea
                    className="mt-2 min-h-24 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) => setStageReview((current) => current ? { ...current, reason: event.target.value } : current)}
                    placeholder={text.reasonPlaceholder}
                    value={stageReview.reason}
                  />
                </label>
              </div>
            ) : null}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100" onClick={() => setStageReview(null)} type="button">
                {text.cancel}
              </button>
              <button
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-300"
                disabled={!canConfirmReview}
                onClick={() =>
                  void commitStageChange(
                    stageReviewDeal,
                    stageReview.targetStage,
                    stageReview.reason,
                    stageReview.reasonCategory || undefined,
                  )
                }
                type="button"
              >
                {text.confirmMove}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
