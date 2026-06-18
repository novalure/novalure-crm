"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GridLayout, useContainerWidth, type LayoutItem } from "react-grid-layout";
import {
  CRM_LEAD_SOURCES,
  type CalendarEvent,
  type Contact,
  type Deal,
  type Funnel,
  type Lead,
  type PipelineStage,
  type Project,
  type Region,
  type SellerListing,
  type Task,
  type WorkspaceUser,
} from "@/lib/crm-types";
import {
  getCrmLeadTypeKey,
  getCrmLeadTypeLabel,
  getCrmSourceKey,
  getCrmSourceLabel,
  getCrmStatusKey,
  getCrmStatusLabel,
  getCrmSystemTextLabel,
  getDashboardOverviewCopy,
  languageOptionsByCode,
  type LanguageCode,
} from "@/lib/i18n";

const NOW = new Date();
const COMMISSION_RATE = 0.03;
const MONTH_TARGET_COMMISSION = 120000;
const VIEW_STORAGE_KEY = "novalure-dashboard-views-v4";
const LAST_VIEW_STORAGE_KEY = "novalure-dashboard-last-view-v4";
const CLOSED_DEAL_STAGES = new Set<string>(["Gewonnen", "Verloren", "Disqualifiziert", "Abschluss"]);
const WON_DEAL_STAGES = new Set<string>(["Gewonnen", "Abschluss"]);
const VIEWING_DEAL_STAGES = new Set<string>([
  "Besichtigung/Beratung",
  "Angebot/Reservierung",
  "Abschlussprüfung",
  "Gewonnen",
  "Besichtigung",
  "Abschluss",
]);

const leadTypeOptions = ["Käufer", "Verkäufer", "Investor"] as const;
const periodOptions = ["Heute", "Woche", "Monat", "Quartal", "YTD", "Custom"] as const;
const regionOptions: Array<Region | "Alle"> = ["Alle", "Tirol", "Steiermark"];
const sourceOptions = CRM_LEAD_SOURCES;

const PDF_EXPORT_BACKGROUND = "#f4f2ec";
const PDF_EXPORT_MARGIN_MM = 8;
const DISPLAY_TIME_ZONE = "Europe/Vienna";

function prepareDashboardPdfClone(clonedDocument: Document) {
  const root = clonedDocument.querySelector('[data-dashboard-pdf-root="true"]');
  if (!root) return;

  const style = clonedDocument.createElement("style");
  style.textContent = `
    [data-dashboard-pdf-root="true"] {
      background: ${PDF_EXPORT_BACKGROUND} !important;
      color: #08233f !important;
    }

    [data-dashboard-pdf-root="true"],
    [data-dashboard-pdf-root="true"] * {
      border-color: rgba(74, 144, 226, 0.28) !important;
      box-shadow: none !important;
      color: #08233f !important;
      text-shadow: none !important;
    }

    [data-dashboard-pdf-root="true"] [class*="bg-"] {
      background: #eef7ff !important;
      background-image: none !important;
    }

    [data-dashboard-pdf-root="true"] .bg-stone-100,
    [data-dashboard-pdf-root="true"] .bg-stone-200,
    [data-dashboard-pdf-root="true"] .bg-slate-100,
    [data-dashboard-pdf-root="true"] .bg-blue-50,
    [data-dashboard-pdf-root="true"] .bg-emerald-50,
    [data-dashboard-pdf-root="true"] .bg-amber-50,
    [data-dashboard-pdf-root="true"] .bg-red-50,
    [data-dashboard-pdf-root="true"] .bg-violet-50,
    [data-dashboard-pdf-root="true"] [class*="bg-[conic-gradient"] {
      background: #d8ecff !important;
      background-image: none !important;
    }

    [data-dashboard-pdf-root="true"] .bg-blue-700,
    [data-dashboard-pdf-root="true"] .bg-emerald-700,
    [data-dashboard-pdf-root="true"] .bg-slate-950,
    [data-dashboard-pdf-root="true"] button.bg-emerald-700,
    [data-dashboard-pdf-root="true"] button.bg-slate-950 {
      background: #4a90e2 !important;
      background-image: none !important;
      color: #ffffff !important;
    }

    [data-dashboard-pdf-root="true"] .text-white,
    [data-dashboard-pdf-root="true"] button.bg-emerald-700 *,
    [data-dashboard-pdf-root="true"] button.bg-slate-950 * {
      color: #ffffff !important;
    }

    [data-dashboard-pdf-root="true"] input,
    [data-dashboard-pdf-root="true"] select,
    [data-dashboard-pdf-root="true"] textarea {
      background: #ffffff !important;
      color: #08233f !important;
    }
  `;
  clonedDocument.head.appendChild(style);
}

type LeadTypeFilter = (typeof leadTypeOptions)[number];
type PeriodOption = (typeof periodOptions)[number];
type WidgetId =
  | "activeLeads"
  | "pipelineValue"
  | "monthlyClosings"
  | "overdueFollowupsKpi"
  | "hotLeadsKpi"
  | "conversionRate"
  | "averageClosingDays"
  | "newRequestsWeek"
  | "funnel"
  | "sourceBar"
  | "requestsLine"
  | "statusDonut"
  | "overdueFollowupsList"
  | "todayTasks"
  | "hotLeadsList"
  | "newLeadsWeek"
  | "expiringMandates"
  | "matchSuggestions";

type DashboardFilters = {
  leadTypes: LeadTypeFilter[];
  period: PeriodOption;
  employeeId: "all" | "mine" | string;
  region: Region | "Alle";
  sources: string[];
};

type DashboardView = {
  id: string;
  name: string;
  filters: DashboardFilters;
  layout: LayoutItem[];
  widgets: WidgetId[];
};

type DashboardOverviewProps = {
  calendarEvents: CalendarEvent[];
  contacts: Contact[];
  deals: Deal[];
  funnels: Funnel[];
  language: LanguageCode;
  leads: Lead[];
  pipeline: PipelineStage[];
  projectLabel: string;
  projects: Project[];
  sellerListings: SellerListing[];
  tasks: Task[];
  users: WorkspaceUser[];
};

const widgetCatalog: Record<WidgetId, { kind: "KPI" | "Diagramm" | "Liste" }> = {
  activeLeads: { kind: "KPI" },
  pipelineValue: { kind: "KPI" },
  monthlyClosings: { kind: "KPI" },
  overdueFollowupsKpi: { kind: "KPI" },
  hotLeadsKpi: { kind: "KPI" },
  conversionRate: { kind: "KPI" },
  averageClosingDays: { kind: "KPI" },
  newRequestsWeek: { kind: "KPI" },
  funnel: { kind: "Diagramm" },
  sourceBar: { kind: "Diagramm" },
  requestsLine: { kind: "Diagramm" },
  statusDonut: { kind: "Diagramm" },
  overdueFollowupsList: { kind: "Liste" },
  todayTasks: { kind: "Liste" },
  hotLeadsList: { kind: "Liste" },
  newLeadsWeek: { kind: "Liste" },
  expiringMandates: { kind: "Liste" },
  matchSuggestions: { kind: "Liste" },
};

const defaultFilters: DashboardFilters = {
  leadTypes: ["Käufer", "Verkäufer", "Investor"],
  period: "Monat",
  employeeId: "all",
  region: "Alle",
  sources: [...sourceOptions],
};

const defaultWidgets: WidgetId[] = [
  "activeLeads",
  "pipelineValue",
  "monthlyClosings",
  "overdueFollowupsKpi",
  "funnel",
  "overdueFollowupsList",
  "todayTasks",
  "sourceBar",
];

const defaultWidgetSet = new Set<WidgetId>(defaultWidgets);

const defaultLayout: LayoutItem[] = [
  { i: "activeLeads", x: 0, y: 0, w: 3, h: 4, minW: 3, minH: 4 },
  { i: "pipelineValue", x: 3, y: 0, w: 3, h: 4, minW: 3, minH: 4 },
  { i: "monthlyClosings", x: 6, y: 0, w: 3, h: 4, minW: 3, minH: 4 },
  { i: "overdueFollowupsKpi", x: 9, y: 0, w: 3, h: 4, minW: 3, minH: 4 },
  { i: "funnel", x: 0, y: 4, w: 12, h: 7, minW: 6, minH: 6 },
  { i: "overdueFollowupsList", x: 0, y: 11, w: 6, h: 7, minW: 4, minH: 6 },
  { i: "todayTasks", x: 6, y: 11, w: 6, h: 7, minW: 4, minH: 6 },
  { i: "sourceBar", x: 0, y: 18, w: 12, h: 7, minW: 6, minH: 6 },
];

function getWidgetSize(widget: WidgetId) {
  if (["funnel", "sourceBar"].includes(widget)) {
    return { h: 7, minH: 6, minW: 6, w: 12 };
  }

  if (["requestsLine", "statusDonut", "overdueFollowupsList", "todayTasks", "hotLeadsList", "newLeadsWeek", "expiringMandates", "matchSuggestions"].includes(widget)) {
    return { h: 7, minH: 6, minW: 4, w: 6 };
  }

  return { h: 4, minH: 4, minW: 3, w: 3 };
}

function packLayout(widgets: WidgetId[]) {
  const packed: LayoutItem[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  widgets.forEach((widget) => {
    const size = getWidgetSize(widget);

    if (cursorX + size.w > 12) {
      cursorX = 0;
      cursorY += rowHeight || size.h;
      rowHeight = 0;
    }

    packed.push({
      h: size.h,
      i: widget,
      minH: size.minH,
      minW: size.minW,
      w: size.w,
      x: cursorX,
      y: cursorY,
    });
    cursorX += size.w;
    rowHeight = Math.max(rowHeight, size.h);
  });

  return packed;
}

function normalizeLayout(widgets: WidgetId[], sourceLayout: LayoutItem[] = []) {
  const sourceById = new Map(sourceLayout.map((item) => [item.i, item]));
  const needsReflow = widgets.some((widget) => {
    const size = getWidgetSize(widget);
    const existing = sourceById.get(widget);
    return !existing || (existing.w || 0) < size.minW || (existing.h || 0) < size.minH;
  });

  if (needsReflow) {
    return packLayout(widgets);
  }

  return widgets.map((widget) => {
    const size = getWidgetSize(widget);
    const existing = sourceById.get(widget)!;
    const width = Math.min(12, Math.max(existing.w || size.w, size.minW));

    return {
      ...existing,
      h: Math.max(existing.h || size.h, size.minH),
      i: widget,
      minH: size.minH,
      minW: size.minW,
      w: width,
      x: Math.min(Math.max(existing.x ?? 0, 0), 12 - width),
      y: Math.max(existing.y ?? 0, 0),
    };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}

function orderWidgetsForTopInsertion(widgets: WidgetId[]) {
  const uniqueWidgets = widgets.filter((widget, index) => widgets.indexOf(widget) === index);
  const topKpis = uniqueWidgets.filter((widget) => widgetCatalog[widget].kind === "KPI");
  const addedWidgets = uniqueWidgets.filter((widget) => widgetCatalog[widget].kind !== "KPI" && !defaultWidgetSet.has(widget));
  const defaultLowerWidgets = uniqueWidgets.filter((widget) => widgetCatalog[widget].kind !== "KPI" && defaultWidgetSet.has(widget));

  return [...topKpis, ...addedWidgets, ...defaultLowerWidgets];
}

function buildLayout(widgets: WidgetId[]) {
  return normalizeLayout(widgets, []);
}

const presetViews: DashboardView[] = [
  { id: "default", name: "Standardansicht", filters: defaultFilters, layout: normalizeLayout(defaultWidgets, defaultLayout), widgets: defaultWidgets },
  { id: "daily", name: "Meine Tagesansicht", filters: { ...defaultFilters, period: "Heute", employeeId: "mine" }, layout: buildLayout(["activeLeads", "overdueFollowupsKpi", "todayTasks", "hotLeadsList", "matchSuggestions"]), widgets: ["activeLeads", "overdueFollowupsKpi", "todayTasks", "hotLeadsList", "matchSuggestions"] },
  { id: "weekly", name: "Wochen-Review", filters: { ...defaultFilters, period: "Woche" }, layout: buildLayout(["activeLeads", "pipelineValue", "conversionRate", "newRequestsWeek", "funnel", "sourceBar", "requestsLine"]), widgets: ["activeLeads", "pipelineValue", "conversionRate", "newRequestsWeek", "funnel", "sourceBar", "requestsLine"] },
  { id: "seller", name: "Verkäufer-Fokus", filters: { ...defaultFilters, leadTypes: ["Verkäufer"], period: "Monat" }, layout: buildLayout(["activeLeads", "pipelineValue", "overdueFollowupsKpi", "expiringMandates", "overdueFollowupsList", "matchSuggestions"]), widgets: ["activeLeads", "pipelineValue", "overdueFollowupsKpi", "expiringMandates", "overdueFollowupsList", "matchSuggestions"] },
  { id: "ceo", name: "Geschäftsführer-Sicht", filters: { ...defaultFilters, period: "YTD" }, layout: buildLayout(["pipelineValue", "monthlyClosings", "conversionRate", "averageClosingDays", "sourceBar", "statusDonut", "funnel"]), widgets: ["pipelineValue", "monthlyClosings", "conversionRate", "averageClosingDays", "sourceBar", "statusDonut", "funnel"] },
  { id: "investor", name: "Investor-Akquise", filters: { ...defaultFilters, leadTypes: ["Investor"], period: "Monat" }, layout: buildLayout(["activeLeads", "pipelineValue", "hotLeadsKpi", "hotLeadsList", "matchSuggestions", "sourceBar"]), widgets: ["activeLeads", "pipelineValue", "hotLeadsKpi", "hotLeadsList", "matchSuggestions", "sourceBar"] },
];

function normalizeView(view: DashboardView): DashboardView {
  return {
    ...view,
    filters: {
      ...defaultFilters,
      ...view.filters,
      leadTypes: view.filters.leadTypes.length > 0 ? view.filters.leadTypes : defaultFilters.leadTypes,
      sources: view.filters.sources.length > 0 ? view.filters.sources : defaultFilters.sources,
    },
    layout: normalizeLayout(view.widgets, view.layout),
  };
}

function isWidgetId(value: string): value is WidgetId {
  return value in widgetCatalog;
}

function normalizeServerView(value: unknown): DashboardView | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const widgets = Array.isArray(record.widgets)
    ? record.widgets.map(String).filter(isWidgetId)
    : [];
  const layout = Array.isArray(record.layout) ? record.layout as LayoutItem[] : [];
  const filters = record.filters && typeof record.filters === "object"
    ? record.filters as DashboardFilters
    : defaultFilters;
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";

  if (!id || !name || widgets.length === 0) return null;

  return normalizeView({ filters, id, layout, name, widgets });
}

function loadStoredViews() {
  if (typeof window === "undefined") return presetViews.map(normalizeView);
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    const customViews = stored ? (JSON.parse(stored) as DashboardView[]) : [];
    return [...presetViews, ...customViews].map(normalizeView);
  } catch {
    return presetViews.map(normalizeView);
  }
}

function formatEuro(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { currency: "EUR", maximumFractionDigits: 0, style: "currency" }).format(value);
}

function parseEuroValue(value: string) {
  const lowerValue = value.toLowerCase();
  const isMillion = lowerValue.includes("mio");
  const normalized = lowerValue.replace(/mio\.?/g, "").replace(/eur/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? (isMillion ? parsed * 1_000_000 : parsed) : 0;
}

function daysBetween(from: string, to = NOW.toISOString()) {
  return Math.max(0, Math.floor((parseDateForComparison(to).getTime() - parseDateForComparison(from).getTime()) / 86400000));
}

function isInPeriod(value: string, period: PeriodOption) {
  const date = parseDateForComparison(value);
  const todayStart = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - 6);
  const monthStart = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
  const quarterStart = new Date(NOW.getFullYear(), Math.floor(NOW.getMonth() / 3) * 3, 1);
  const yearStart = new Date(NOW.getFullYear(), 0, 1);

  if (period === "Heute") return date >= todayStart && date < tomorrowStart;
  if (period === "Woche") return date >= weekStart && date <= NOW;
  if (period === "Monat" || period === "Custom") return date >= monthStart && date <= NOW;
  if (period === "Quartal") return date >= quarterStart && date <= NOW;
  return date >= yearStart && date <= NOW;
}

function parseDateForComparison(value: string) {
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12, 0, 0, 0);
  }

  return new Date(value);
}

function isSameLocalDay(value: string, comparison = NOW) {
  const date = parseDateForComparison(value);
  return (
    date.getFullYear() === comparison.getFullYear() &&
    date.getMonth() === comparison.getMonth() &&
    date.getDate() === comparison.getDate()
  );
}

function getAging(lead: Lead) {
  const days = daysBetween(lead.lastContactAt ?? lead.receivedAt);
  if (days < 7) return { days, className: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  if (days <= 14) return { days, className: "border-yellow-200 bg-yellow-50 text-yellow-900" };
  if (days <= 30) return { days, className: "border-orange-200 bg-orange-50 text-orange-900" };
  return { days, className: "border-red-200 bg-red-50 text-red-900" };
}

function getLeadName(lead: Lead, contacts: Contact[], language: LanguageCode) {
  return contacts.find((contact) => contact.id === lead.contactId)?.name ?? getCrmSystemTextLabel(lead.intent, language);
}

function getDealLead(deal: Deal, leads: Lead[]) {
  return leads.find((lead) => lead.id === deal.leadId) ?? leads.find((lead) => lead.contactId === deal.contactId);
}

function compactNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" }).format(value);
}

export function DashboardOverview({
  calendarEvents,
  contacts,
  deals,
  funnels,
  language,
  leads,
  projectLabel,
  sellerListings,
  tasks,
  users,
}: DashboardOverviewProps) {
  const locale = languageOptionsByCode[language].locale;
  const copy = getDashboardOverviewCopy(language);
  const periodLabels = copy.periods as Record<string, string>;
  const regionLabels = copy.regions as Record<string, string>;
  const widgetKindLabels = copy.widgetKinds as Record<string, string>;
  const presetViewLabels = copy.presetViews as Record<string, string>;
  const getViewName = (view: DashboardView) => presetViewLabels[view.id] ?? view.name;
  const dashboardRef = useRef<HTMLDivElement>(null);
  const { containerRef, mounted, width } = useContainerWidth({ initialWidth: 900 });
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const viewportGridLimit =
    viewportWidth === null
      ? width
      : viewportWidth - (viewportWidth >= 1280 ? 400 : 48);
  const gridWidth = Math.max(320, Math.min(width, viewportGridLimit));
  const [views, setViews] = useState<DashboardView[]>(loadStoredViews);
  const [activeViewId, setActiveViewId] = useState(() => (typeof window === "undefined" ? "default" : window.localStorage.getItem(LAST_VIEW_STORAGE_KEY) ?? "default"));
  const initialView = normalizeView(views.find((view) => view.id === activeViewId) ?? presetViews[0]);
  const [filters, setFilters] = useState<DashboardFilters>(initialView.filters);
  const [widgets, setWidgets] = useState<WidgetId[]>(initialView.widgets);
  const [layout, setLayout] = useState<LayoutItem[]>(initialView.layout);
  const [activeFunnelType, setActiveFunnelType] = useState<LeadTypeFilter>("Käufer");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [settingsWidget, setSettingsWidget] = useState<WidgetId | null>(null);
  const [collapsedWidgets, setCollapsedWidgets] = useState<WidgetId[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadPersistedViews() {
      try {
        const response = await fetch("/api/crm/dashboard-views", { cache: "no-store" });
        if (!response.ok) return;

        const payload = await response.json() as { views?: unknown[] };
        const persistedViews = (payload.views ?? []).map(normalizeServerView).filter((view): view is DashboardView => Boolean(view));

        if (!cancelled && persistedViews.length > 0) {
          setViews([...presetViews.map(normalizeView), ...persistedViews]);
        }
      } catch {
        // Browser storage remains the offline fallback for private local demos.
      }
    }

    void loadPersistedViews();

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredLeads = useMemo(
    () => leads.filter((lead) => {
      const employeeMatch = filters.employeeId === "all" || (filters.employeeId === "mine" ? lead.assignedToUserId === users[0]?.id : lead.assignedToUserId === filters.employeeId);
      return filters.leadTypes.includes(getCrmLeadTypeKey(lead.type) as LeadTypeFilter) && isInPeriod(lead.receivedAt, filters.period) && employeeMatch && (filters.region === "Alle" || lead.region === filters.region) && filters.sources.includes(getCrmSourceKey(lead.source) as (typeof sourceOptions)[number]);
    }),
    [filters, leads, users],
  );

  const filteredDeals = useMemo(
    () => deals.filter((deal) => {
      const linkedLead = getDealLead(deal, leads);
      return !linkedLead || filteredLeads.some((lead) => lead.id === linkedLead.id || lead.contactId === deal.contactId);
    }),
    [deals, filteredLeads, leads],
  );

  const openDeals = filteredDeals.filter((deal) => !CLOSED_DEAL_STAGES.has(deal.stage));
  const overdueLeads = filteredLeads.filter((lead) => new Date(lead.nextContactAt ?? lead.slaDueAt).getTime() < NOW.getTime());
  const hotLeads = filteredLeads.filter((lead) => lead.score > 80 || lead.hotStatus);
  const activeLeadsByType = leadTypeOptions.map((type) => ({ type, count: filteredLeads.filter((lead) => getCrmLeadTypeKey(lead.type) === type).length }));
  const openPipelineValue = openDeals.reduce((sum, deal) => sum + parseEuroValue(deal.value), 0);
  const weightedPipelineValue = openDeals.reduce((sum, deal) => sum + parseEuroValue(deal.value) * (deal.probability / 100), 0);
  const pipelineCommission = weightedPipelineValue * COMMISSION_RATE;
  const monthClosings = filteredDeals.filter((deal) => WON_DEAL_STAGES.has(deal.stage) && isInPeriod(deal.expectedCloseDate, "Monat"));
  const monthClosingCommission = monthClosings.reduce((sum, deal) => sum + parseEuroValue(deal.value) * COMMISSION_RATE, 0);
  const stageVisits = Math.max(1, filteredLeads.length);
  const viewingDeals = filteredDeals.filter((deal) => VIEWING_DEAL_STAGES.has(deal.stage)).length;
  const closingDeals = filteredDeals.filter((deal) => WON_DEAL_STAGES.has(deal.stage)).length;
  const conversionRate = Math.round((closingDeals / stageVisits) * 100);
  const avgClosingDays = Math.round(filteredDeals.reduce((sum, deal) => {
    const lead = getDealLead(deal, leads);
    return sum + (lead ? daysBetween(lead.receivedAt, deal.expectedCloseDate) : 34);
  }, 0) / Math.max(1, filteredDeals.length));
  const weekRequests = filteredLeads.filter((lead) => isInPeriod(lead.receivedAt, "Woche"));

  const sourceRows = sourceOptions.map((source) => {
    const sourceLeads = filteredLeads.filter((lead) => getCrmSourceKey(lead.source) === source);
    const sourceClosings = filteredDeals.filter((deal) => getCrmSourceKey(deal.source) === source && WON_DEAL_STAGES.has(deal.stage)).length;
    return { source, count: sourceLeads.length, conversion: Math.round((sourceClosings / Math.max(1, sourceLeads.length)) * 100) };
  }).filter((row) => row.count > 0).sort((a, b) => b.count - a.count);

  const statusRows = ["Neu", "Qualifizieren", "Termin offen", "Übergabe", "Archiviert"].map((status) => ({
    status,
    count: filteredLeads.filter((lead) => getCrmStatusKey(lead.status) === status).length,
  }));
  const totalStatus = Math.max(1, statusRows.reduce((sum, row) => sum + row.count, 0));
  const requestTrend = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(NOW);
    day.setDate(NOW.getDate() - (6 - index));
    const key = day.toISOString().slice(0, 10);
    return { key, label: new Intl.DateTimeFormat(locale, { timeZone: DISPLAY_TIME_ZONE, weekday: "short" }).format(day), count: filteredLeads.filter((lead) => lead.receivedAt.slice(0, 10) === key).length };
  });
  const trendMax = Math.max(1, ...requestTrend.map((item) => item.count));
  const todayItems = [
    ...tasks
      .filter((task) => {
        const due = task.due.toLowerCase();
        return task.status === "open" && (due.includes("heute") || due.includes("today") || isSameLocalDay(task.due));
      })
      .map((task) => ({ id: task.id, title: task.title, meta: task.due, priority: task.priority })),
    ...calendarEvents.filter((event) => isSameLocalDay(event.startsAt)).map((event) => ({ id: event.id, title: event.title, meta: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: DISPLAY_TIME_ZONE }).format(new Date(event.startsAt)), priority: event.location })),
  ];
  const mandateRows = sellerListings.filter((listing) => listing.mandateEndsAt).map((listing) => ({ listing, daysLeft: daysBetween(NOW.toISOString(), listing.mandateEndsAt) })).filter((item) => item.daysLeft <= 60).sort((a, b) => a.daysLeft - b.daysLeft);
  const matchRows = sellerListings.flatMap((listing) => filteredLeads.filter((lead) => {
    const leadType = getCrmLeadTypeKey(lead.type);
    return leadType === "Käufer" || leadType === "Investor";
  }).map((lead) => {
    const budgetTo = lead.buyerProfile?.budgetTo ?? lead.investorProfile?.investmentVolumeTo ?? 0;
    const budgetFrom = lead.buyerProfile?.budgetFrom ?? lead.investorProfile?.investmentVolumeFrom ?? 0;
    const priceMatch = listing.targetPrice >= budgetFrom && listing.targetPrice <= budgetTo;
    const regionMatch = lead.region === listing.region;
    const typeMatch = lead.objectType === listing.objectType || (getCrmLeadTypeKey(lead.type) === "Investor" && Boolean(listing.expectedGrossYield));
    const yieldMatch = lead.investorProfile ? (listing.expectedGrossYield ?? 0) >= lead.investorProfile.netYieldExpectation : true;
    const score = [priceMatch, regionMatch, typeMatch, yieldMatch].filter(Boolean).length * 25;
    return { lead, listing, score };
  }).filter((match) => match.score >= 50)).sort((a, b) => b.score - a.score).slice(0, 5);

  const applyView = (viewId: string) => {
    const view = normalizeView(views.find((item) => item.id === viewId) ?? presetViews[0]);
    setActiveViewId(view.id);
    setFilters(view.filters);
    setWidgets(view.widgets);
    setLayout(view.layout);
    if (typeof window !== "undefined") window.localStorage.setItem(LAST_VIEW_STORAGE_KEY, view.id);
  };

  const saveCurrentView = async () => {
    const name = window.prompt(copy.prompts.viewName, copy.prompts.newView);
    if (!name?.trim()) return;
    const customViewId =
      "custom_" +
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "") +
      "_" +
      String(views.length + 1);
    let nextView: DashboardView = normalizeView({ id: customViewId, name: name.trim(), filters, layout, widgets });
    try {
      const response = await fetch("/api/crm/dashboard-views", {
        body: JSON.stringify({
          filters,
          id: activeViewId.startsWith("custom_") ? activeViewId : undefined,
          isDefault: true,
          layout,
          name: name.trim(),
          widgets,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = response.ok ? await response.json() as { view?: unknown } : null;
      nextView = normalizeServerView(payload?.view) ?? nextView;
    } catch {
      // Persisted API is primary; local storage keeps the private demo usable when it is unavailable.
    }
    const customViews = [...views.filter((view) => !presetViews.some((preset) => preset.id === view.id)), nextView];
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(customViews));
    setViews([...presetViews, ...customViews]);
    setActiveViewId(nextView.id);
    window.localStorage.setItem(LAST_VIEW_STORAGE_KEY, nextView.id);
  };

  const toggleLeadType = (type: LeadTypeFilter) => {
    setFilters((current) => ({ ...current, leadTypes: current.leadTypes.includes(type) ? current.leadTypes.filter((item) => item !== type) : [...current.leadTypes, type] }));
  };

  const toggleSource = (source: string) => {
    setFilters((current) => ({ ...current, sources: current.sources.includes(source) ? current.sources.filter((item) => item !== source) : [...current.sources, source] }));
  };

  const addWidget = (widget: WidgetId) => {
    if (widgets.includes(widget)) return;
    const nextWidgets = orderWidgetsForTopInsertion([...widgets, widget]);
    setWidgets(nextWidgets);
    setLayout(packLayout(nextWidgets));
  };

  const removeWidget = (widget: WidgetId) => {
    setWidgets((current) => current.filter((item) => item !== widget));
    setLayout((current) => current.filter((item) => item.i !== widget));
  };

  const exportPdf = async () => {
    if (!dashboardRef.current) return;
    setExporting(true);
    setExportError("");
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);
      const canvas = await html2canvas(dashboardRef.current, {
        backgroundColor: PDF_EXPORT_BACKGROUND,
        logging: false,
        onclone: prepareDashboardPdfClone,
        scale: Math.min(2, window.devicePixelRatio || 1.5),
        useCORS: true,
      });
      const imageData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imageWidth = pageWidth - PDF_EXPORT_MARGIN_MM * 2;
      const imageHeight = (canvas.height * imageWidth) / canvas.width;
      const pageContentHeight = pageHeight - PDF_EXPORT_MARGIN_MM * 2;
      let heightLeft = imageHeight;
      let imageTop = PDF_EXPORT_MARGIN_MM;

      pdf.addImage(imageData, "PNG", PDF_EXPORT_MARGIN_MM, imageTop, imageWidth, imageHeight);
      heightLeft -= pageContentHeight;

      while (heightLeft > 0) {
        imageTop = PDF_EXPORT_MARGIN_MM - (imageHeight - heightLeft);
        pdf.addPage();
        pdf.addImage(imageData, "PNG", PDF_EXPORT_MARGIN_MM, imageTop, imageWidth, imageHeight);
        heightLeft -= pageContentHeight;
      }

      pdf.save("novalure-clg-dashboard.pdf");
    } catch (error) {
      console.error("Dashboard PDF export failed", error);
      setExportError(copy.header.exportPdfError);
    } finally {
      setExporting(false);
    }
  };

  const renderKpi = (label: string, value: string, detail: string, tone = "bg-white") => (
    <div className={"flex h-full min-h-0 flex-col justify-between rounded-lg border border-stone-200 p-4 " + tone}>
      <div>
        <p className="crm-kpi-label text-xs font-semibold uppercase leading-4 text-stone-500">{label}</p>
        <p className="mt-3 break-words text-3xl font-semibold leading-tight text-slate-950">{value}</p>
      </div>
      <p className="mt-3 break-words text-sm leading-5 text-stone-600">{detail}</p>
    </div>
  );

  const renderWidgetContent = (widget: WidgetId) => {
    if (collapsedWidgets.includes(widget)) return <div className="text-sm text-stone-500">{copy.grid.collapsed}</div>;
    switch (widget) {
      case "activeLeads":
        return renderKpi(copy.kpis.activeLeads, String(filteredLeads.length), activeLeadsByType.map((item) => getCrmLeadTypeLabel(item.type, language) + ": " + item.count).join(" | "), "bg-emerald-50");
      case "pipelineValue":
        return renderKpi(copy.kpis.pipelineValue, formatEuro(pipelineCommission, locale), copy.kpis.expectedCommission(openDeals.length, formatEuro(openPipelineValue, locale), formatEuro(weightedPipelineValue, locale)), "bg-blue-50");
      case "monthlyClosings":
        return renderKpi(copy.kpis.monthlyClosings, formatEuro(monthClosingCommission, locale), copy.kpis.target + ": " + formatEuro(MONTH_TARGET_COMMISSION, locale) + " | " + Math.round((monthClosingCommission / MONTH_TARGET_COMMISSION) * 100) + "%", "bg-violet-50");
      case "overdueFollowupsKpi":
        return renderKpi(copy.kpis.overdueFollowups, String(overdueLeads.length), overdueLeads.slice(0, 2).map((lead) => getLeadName(lead, contacts, language)).join(" | ") || copy.kpis.noCriticalFollowups, overdueLeads.length ? "bg-red-50" : "bg-emerald-50");
      case "hotLeadsKpi":
        return renderKpi(copy.kpis.hotLeads, String(hotLeads.length), copy.kpis.hotLeadRule, "bg-amber-50");
      case "conversionRate":
        return renderKpi(copy.kpis.conversionRate, conversionRate + "%", copy.kpis.conversionDetail(filteredLeads.length, viewingDeals, closingDeals), "bg-white");
      case "averageClosingDays":
        return renderKpi(copy.kpis.averageClosingDays, String(avgClosingDays), copy.kpis.averageClosingDetail, "bg-white");
      case "newRequestsWeek":
        return renderKpi(copy.kpis.newRequestsWeek, String(weekRequests.length), weekRequests.map((lead) => getCrmSourceLabel(lead.source, language)).slice(0, 3).join(" | "), "bg-white");
      case "funnel":
        return <FunnelWidget activeType={activeFunnelType} copy={copy.funnel} filteredDeals={filteredDeals} filteredLeads={filteredLeads} language={language} leads={leads} onTypeChange={setActiveFunnelType} />;
      case "sourceBar":
        return sourceRows.length > 0 ? (
          <div className="grid gap-3">{sourceRows.map((row) => <div className="grid gap-1" key={row.source}><div className="flex justify-between gap-3 text-sm"><span className="font-semibold">{getCrmSourceLabel(row.source, language)}</span><span className="text-stone-500">{row.count} {copy.kpis.leads} | {row.conversion}% {copy.kpis.conversionAbbr}</span></div><div className="h-3 rounded-full bg-stone-100"><div className="h-3 rounded-full bg-blue-700" style={{ width: String(Math.max(10, (row.count / Math.max(1, filteredLeads.length)) * 100)) + "%" }} /></div></div>)}</div>
        ) : (
          <div className="grid min-h-32 place-items-center rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-center text-sm font-medium text-stone-500">
            {copy.charts.noSourceData}
          </div>
        );
      case "requestsLine":
        return <div className="flex h-full items-end gap-2 pt-4">{requestTrend.map((item) => <div className="flex flex-1 flex-col items-center gap-2" key={item.key}><div className="w-full rounded-t-md bg-emerald-700" style={{ height: String(Math.max(12, (item.count / trendMax) * 120)) + "px" }} /><span className="text-xs font-semibold text-stone-500">{item.label}</span></div>)}</div>;
      case "statusDonut":
        return <div className="grid gap-3 sm:grid-cols-[150px_1fr]"><div className="grid aspect-square place-items-center rounded-full bg-[conic-gradient(#059669_0_25%,#2563eb_25%_50%,#f59e0b_50%_75%,#7c3aed_75%_90%,#94a3b8_90%_100%)]"><div className="grid h-24 w-24 place-items-center rounded-full bg-white text-lg font-semibold">{filteredLeads.length}</div></div><div className="grid content-center gap-2">{statusRows.map((row) => <div className="flex justify-between text-sm" key={row.status}><span>{getCrmStatusLabel(row.status, language)}</span><span>{Math.round((row.count / totalStatus) * 100)}%</span></div>)}</div></div>;
      case "overdueFollowupsList":
        return <ListRows rows={overdueLeads.sort((a, b) => getAging(b).days - getAging(a).days).map((lead) => ({ id: lead.id, title: getLeadName(lead, contacts, language), meta: getCrmSystemTextLabel(lead.nextAction, language) + " | " + copy.lists.daysWithoutContact(getAging(lead).days), className: getAging(lead).className }))} empty={copy.lists.noOverdueFollowups} />;
      case "todayTasks":
        return <ListRows rows={todayItems.map((item) => ({ id: item.id, title: item.title, meta: item.meta + " | " + item.priority, className: "border-stone-200 bg-stone-50 text-slate-900" }))} empty={copy.lists.nothingDueToday} />;
      case "hotLeadsList":
        return <ListRows rows={hotLeads.map((lead) => ({ id: lead.id, title: getLeadName(lead, contacts, language), meta: copy.lists.score + " " + lead.score + " | " + getCrmSystemTextLabel(lead.intent, language), className: getAging(lead).className }))} empty={copy.lists.noHotLeads} />;
      case "newLeadsWeek":
        return <ListRows rows={weekRequests.map((lead) => ({ id: lead.id, title: getLeadName(lead, contacts, language), meta: getCrmSourceLabel(lead.source, language) + " | " + new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", timeZone: DISPLAY_TIME_ZONE }).format(new Date(lead.receivedAt)), className: "border-blue-200 bg-blue-50 text-blue-950" }))} empty={copy.lists.noNewLeadsWeek} />;
      case "expiringMandates":
        return <ListRows rows={mandateRows.map(({ listing, daysLeft }) => ({ id: listing.id, title: listing.title, meta: copy.lists.expiresInDays(daysLeft) + " | " + formatEuro(listing.targetPrice, locale), className: daysLeft <= 30 ? "border-orange-200 bg-orange-50 text-orange-950" : "border-yellow-200 bg-yellow-50 text-yellow-950" }))} empty={copy.lists.noExpiringMandates} />;
      case "matchSuggestions":
        return <ListRows rows={matchRows.map((match) => ({ id: match.listing.id + "_" + match.lead.id, title: getLeadName(match.lead, contacts, language) + " -> " + match.listing.title, meta: copy.lists.match + " " + match.score + "% | " + match.listing.region + " | " + compactNumber(match.listing.targetPrice, locale) + " EUR", className: "border-emerald-200 bg-emerald-50 text-emerald-950" }))} empty={copy.lists.noMatchSuggestions} />;
    }
  };

  const gridLayout = normalizeLayout(widgets, layout);
  const softWarning = widgets.length > 12;
  const hasMeasuredGrid = mounted && viewportWidth !== null;
  const stackedWidgets = !hasMeasuredGrid || gridWidth < 760;
  const renderWidgetArticle = (widget: WidgetId, draggable = false) => (
    <article className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm" key={widget}>
      <div className={`${draggable ? "widget-drag-handle cursor-move" : ""} border-b border-stone-100 px-4 py-3`}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-32 flex-1">
            <p className="line-clamp-2 text-sm font-semibold leading-5 text-slate-950" style={{ overflowWrap: "normal", wordBreak: "normal" }}>{copy.widgets[widget].title}</p>
            <p className="mt-1 line-clamp-2 text-xs leading-4 text-stone-500" style={{ overflowWrap: "normal", wordBreak: "normal" }}>{copy.widgets[widget].description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              aria-label={collapsedWidgets.includes(widget) ? copy.grid.expand : copy.grid.collapse}
              className="grid h-7 w-7 place-items-center rounded-md border border-stone-200 text-xs font-semibold"
              onClick={() => setCollapsedWidgets((current) => current.includes(widget) ? current.filter((item) => item !== widget) : [...current, widget])}
              title={collapsedWidgets.includes(widget) ? copy.grid.expand : copy.grid.collapse}
              type="button"
            >
              {collapsedWidgets.includes(widget) ? "+" : "-"}
            </button>
            <button
              aria-label={copy.grid.settingsTitle}
              className="grid h-7 w-7 place-items-center rounded-md border border-stone-200 text-slate-700"
              onClick={() => setSettingsWidget(settingsWidget === widget ? null : widget)}
              title={copy.grid.settingsTitle}
              type="button"
            >
              <SettingsGlyph />
            </button>
            <button
              aria-label={copy.grid.remove}
              className="grid h-7 w-7 place-items-center rounded-md border border-red-200 text-xs font-semibold text-red-700"
              onClick={() => removeWidget(widget)}
              title={copy.grid.remove}
              type="button"
            >
              x
            </button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {settingsWidget === widget ? <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600">{copy.grid.settings}</div> : null}
        {renderWidgetContent(widget)}
      </div>
    </article>
  );

  return (
    <section className="space-y-4" data-dashboard-pdf-root="true" ref={dashboardRef}>
      <div className="rounded-lg border border-stone-200 bg-white p-4 md:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{projectLabel}</p>
            <h3 className="mt-1 text-2xl font-semibold">{copy.header.title}</h3>
            <p className="mt-1 max-w-4xl break-words text-sm text-stone-600">{copy.header.description}</p>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <select className="max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold sm:w-auto" onChange={(event) => applyView(event.target.value)} value={activeViewId}>{views.map((view) => <option key={view.id} value={view.id}>{getViewName(view)}</option>)}</select>
            <button className="max-w-full whitespace-normal rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => void saveCurrentView()} type="button">{copy.header.saveView}</button>
            <button className="max-w-full whitespace-normal rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => applyView("default")} type="button">{copy.header.resetView}</button>
            <button className="max-w-full whitespace-normal rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:bg-stone-400" disabled={exporting} onClick={exportPdf} type="button">{exporting ? copy.header.exportingPdf : copy.header.exportPdf}</button>
          </div>
        </div>
        {exportError ? <p className="mt-3 text-sm font-semibold text-red-700">{exportError}</p> : null}

        <div className="mt-5 grid gap-3 xl:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_1.2fr]">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.filters.leadType}</p>
            <div className="mt-2 flex flex-wrap gap-2">{leadTypeOptions.map((type) => <label className="flex items-center gap-2 rounded-md bg-white px-2 py-1.5 text-sm font-semibold" key={type}><input checked={filters.leadTypes.includes(type)} onChange={() => toggleLeadType(type)} type="checkbox" />{getCrmLeadTypeLabel(type, language)}</label>)}</div>
          </div>
          <label className="grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.filters.period}<select className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900" onChange={(event) => setFilters((current) => ({ ...current, period: event.target.value as PeriodOption }))} value={filters.period}>{periodOptions.map((period) => <option key={period} value={period}>{periodLabels[period] ?? period}</option>)}</select></label>
          <label className="grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.filters.employee}<select className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900" onChange={(event) => setFilters((current) => ({ ...current, employeeId: event.target.value }))} value={filters.employeeId}><option value="all">{copy.filters.all}</option><option value="mine">{copy.filters.mine}</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
          <label className="grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.filters.region}<select className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900" onChange={(event) => setFilters((current) => ({ ...current, region: event.target.value as Region | "Alle" }))} value={filters.region}>{regionOptions.map((region) => <option key={region} value={region}>{regionLabels[region] ?? region}</option>)}</select></label>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.filters.source}</p>
            <div className="mt-2 flex max-h-24 flex-wrap gap-2 overflow-auto">{sourceOptions.map((source) => <label className="flex items-center gap-2 rounded-md bg-white px-2 py-1.5 text-xs font-semibold" key={source}><input checked={filters.sources.includes(source)} onChange={() => toggleSource(source)} type="checkbox" />{getCrmSourceLabel(source, language)}</label>)}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0"><p className="text-sm font-semibold">{copy.grid.title}</p><p className="mt-1 text-sm text-stone-500">{copy.grid.description(funnels.length)}</p>{softWarning ? <p className="mt-2 text-sm font-semibold text-amber-700">{copy.grid.warning}</p> : null}</div>
        <button className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white" onClick={() => setLibraryOpen((current) => !current)} type="button">{copy.grid.addWidget}</button>
      </div>

      {libraryOpen ? <div className="grid gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 md:grid-cols-3">{(Object.keys(widgetCatalog) as WidgetId[]).map((id) => <button className="rounded-lg border border-emerald-200 bg-white p-3 text-left text-sm hover:border-emerald-500 disabled:opacity-50" disabled={widgets.includes(id)} key={id} onClick={() => addWidget(id)} type="button"><span className="block font-semibold">{copy.widgets[id].title}</span><span className="mt-1 block text-xs text-stone-500">{widgetKindLabels[widgetCatalog[id].kind] ?? widgetCatalog[id].kind} | {copy.widgets[id].description}</span></button>)}</div> : null}

      <div className="min-w-0 overflow-hidden" ref={containerRef}>
        {stackedWidgets ? (
          <div className="grid gap-4">
            {widgets.map((widget) => renderWidgetArticle(widget))}
          </div>
        ) : (
          <GridLayout
            className="layout dashboard-grid"
            dragConfig={{ bounded: true, handle: ".widget-drag-handle" }}
            gridConfig={{ cols: 12, containerPadding: null, margin: [16, 16], rowHeight: 72 }}
            layout={gridLayout}
            onLayoutChange={(nextLayout) => setLayout([...nextLayout])}
            resizeConfig={{ enabled: true }}
            width={gridWidth}
          >
            {widgets.map((widget) => renderWidgetArticle(widget, true))}
          </GridLayout>
        )}
      </div>
    </section>
  );
}

function SettingsGlyph() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M15 7a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM7 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM13 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function FunnelWidget({
  activeType,
  copy,
  filteredDeals,
  filteredLeads,
  language,
  leads,
  onTypeChange,
}: {
  activeType: LeadTypeFilter;
  copy: {
    inquiry: string;
    qualified: string;
    viewing: string;
    closing: string;
  };
  filteredDeals: Deal[];
  filteredLeads: Lead[];
  language: LanguageCode;
  leads: Lead[];
  onTypeChange: (type: LeadTypeFilter) => void;
}) {
  const typeLeads = filteredLeads.filter((lead) => getCrmLeadTypeKey(lead.type) === activeType);
  const typeDeals = filteredDeals.filter((deal) => getCrmLeadTypeKey(getDealLead(deal, leads)?.type ?? "") === activeType);
  const rows = [
    { label: copy.inquiry, count: typeLeads.length },
    {
      label: copy.qualified,
      count: typeDeals.filter((deal) =>
        ["Qualifizieren", "Termin vereinbaren", "Termin gebucht", "Besichtigung/Beratung", "Angebot/Reservierung", "Abschlussprüfung", "Gewonnen"].includes(deal.stage),
      ).length,
    },
    {
      label: copy.viewing,
      count: typeDeals.filter((deal) =>
        ["Besichtigung/Beratung", "Angebot/Reservierung", "Abschlussprüfung", "Gewonnen"].includes(deal.stage),
      ).length,
    },
    { label: copy.closing, count: typeDeals.filter((deal) => deal.stage === "Gewonnen").length },
  ];
  const max = Math.max(1, ...rows.map((row) => row.count));

  return <div><div className="mb-4 flex flex-wrap gap-2">{leadTypeOptions.map((type) => <button className={"rounded-md border px-3 py-1.5 text-sm font-semibold " + (activeType === type ? "border-slate-950 bg-slate-950 text-white" : "border-stone-300 bg-white text-stone-700")} key={type} onClick={() => onTypeChange(type)} type="button">{getCrmLeadTypeLabel(type, language)}</button>)}</div><div className="grid gap-3">{rows.map((row) => <div className="grid gap-1" key={row.label}><div className="flex justify-between text-sm"><span className="font-semibold">{row.label}</span><span>{row.count}</span></div><div className="h-8 overflow-hidden rounded-md bg-stone-100"><div className="h-full rounded-md bg-emerald-700" style={{ width: String(Math.max(8, (row.count / max) * 100)) + "%" }} /></div></div>)}</div></div>;
}

function ListRows({ rows, empty }: { rows: Array<{ id: string; title: string; meta: string; className: string }>; empty: string }) {
  if (rows.length === 0) return <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">{empty}</div>;
  return <div className="grid gap-2">{rows.map((row) => <div className={"rounded-lg border p-3 " + row.className} key={row.id}><p className="break-words text-sm font-semibold">{row.title}</p><p className="mt-1 break-words text-xs opacity-80">{row.meta}</p></div>)}</div>;
}
