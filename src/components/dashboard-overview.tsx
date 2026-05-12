"use client";

import { useMemo, useRef, useState } from "react";
import { GridLayout, useContainerWidth, type LayoutItem } from "react-grid-layout";
import type {
  CalendarEvent,
  Contact,
  Deal,
  Funnel,
  Lead,
  PipelineStage,
  Project,
  Region,
  SellerListing,
  Task,
  WorkspaceUser,
} from "@/lib/crm-types";
import { languageOptionsByCode, type LanguageCode } from "@/lib/i18n";

const NOW = new Date("2026-05-11T15:30:00+02:00");
const COMMISSION_RATE = 0.03;
const MONTH_TARGET_COMMISSION = 120000;
const VIEW_STORAGE_KEY = "novalure-dashboard-views-v4";
const LAST_VIEW_STORAGE_KEY = "novalure-dashboard-last-view-v4";

const leadTypeOptions = ["Käufer", "Verkäufer", "Investor"] as const;
const periodOptions = ["Heute", "Woche", "Monat", "Quartal", "YTD", "Custom"] as const;
const regionOptions: Array<Region | "Alle"> = ["Alle", "Tirol", "Steiermark"];
const sourceOptions = [
  "Website Funnel",
  "Website",
  "willhaben",
  "ImmobilienScout",
  "Empfehlung",
  "WhatsApp",
  "Instagram",
  "Newsletter",
  "Microsoft 365",
  "Manual",
] as const;

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

const widgetCatalog: Record<WidgetId, { title: string; description: string; kind: "KPI" | "Diagramm" | "Liste" }> = {
  activeLeads: { title: "Aktive Leads gesamt", description: "Käufer, Verkäufer und Investoren", kind: "KPI" },
  pipelineValue: { title: "Pipeline-Wert in EUR", description: "Erwartete Provision aus offenen Deals", kind: "KPI" },
  monthlyClosings: { title: "Abschlüsse Monat", description: "Provision vs. Zielwert", kind: "KPI" },
  overdueFollowupsKpi: { title: "Überfällige Follow-ups", description: "SLA und nächster Kontakt", kind: "KPI" },
  hotLeadsKpi: { title: "Hot Leads", description: "Score über 80 oder Status heiß", kind: "KPI" },
  conversionRate: { title: "Conversion-Rate", description: "Anfrage zu Besichtigung zu Abschluss", kind: "KPI" },
  averageClosingDays: { title: "Ø Tage bis Closing", description: "Vom Eingang bis erwartetem Abschluss", kind: "KPI" },
  newRequestsWeek: { title: "Neue Anfragen Woche", description: "Eingänge im aktuellen Zeitraum", kind: "KPI" },
  funnel: { title: "Funnel nach Lead-Typ", description: "Tabs im Widget", kind: "Diagramm" },
  sourceBar: { title: "Leads pro Quelle", description: "Mit Conversion-Rate je Quelle", kind: "Diagramm" },
  requestsLine: { title: "Anfragen-Entwicklung", description: "Zeitverlauf der neuen Leads", kind: "Diagramm" },
  statusDonut: { title: "Lead-Verteilung nach Status", description: "Statusmix als Donut", kind: "Diagramm" },
  overdueFollowupsList: { title: "Überfällige Follow-ups", description: "Aging-Ampel je Lead", kind: "Liste" },
  todayTasks: { title: "Heute zu tun", description: "Termine, Rückrufe, Besichtigungen", kind: "Liste" },
  hotLeadsList: { title: "Hot Leads", description: "Die wichtigsten Kontakte", kind: "Liste" },
  newLeadsWeek: { title: "Neue Leads diese Woche", description: "Aktuelle Eingänge", kind: "Liste" },
  expiringMandates: { title: "Auslaufende Maklerverträge", description: "30/60 Tage", kind: "Liste" },
  matchSuggestions: { title: "Match-Vorschläge", description: "Käufer/Investor zu neuem Listing", kind: "Liste" },
};

const defaultFilters: DashboardFilters = {
  leadTypes: ["Käufer", "Verkäufer", "Investor"],
  period: "Woche",
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
  return Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86400000));
}

function isInPeriod(value: string, period: PeriodOption) {
  const date = new Date(value);
  if (period === "Heute") return date.toDateString() === NOW.toDateString();
  if (period === "Woche") return date >= new Date("2026-05-04T00:00:00+02:00") && date <= NOW;
  if (period === "Monat" || period === "Custom") return date.getFullYear() === 2026 && date.getMonth() === 4;
  if (period === "Quartal") return date >= new Date("2026-04-01T00:00:00+02:00") && date <= NOW;
  return date >= new Date("2026-01-01T00:00:00+02:00") && date <= NOW;
}

function getAging(lead: Lead) {
  const days = daysBetween(lead.lastContactAt ?? lead.receivedAt);
  if (days < 7) return { days, className: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  if (days <= 14) return { days, className: "border-yellow-200 bg-yellow-50 text-yellow-900" };
  if (days <= 30) return { days, className: "border-orange-200 bg-orange-50 text-orange-900" };
  return { days, className: "border-red-200 bg-red-50 text-red-900" };
}

function getLeadName(lead: Lead, contacts: Contact[]) {
  return contacts.find((contact) => contact.id === lead.contactId)?.name ?? lead.intent;
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
  const dashboardRef = useRef<HTMLDivElement>(null);
  const { containerRef, mounted, width } = useContainerWidth({ initialWidth: 1180 });
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

  const filteredLeads = useMemo(
    () => leads.filter((lead) => {
      const employeeMatch = filters.employeeId === "all" || (filters.employeeId === "mine" ? lead.assignedToUserId === users[0]?.id : lead.assignedToUserId === filters.employeeId);
      return filters.leadTypes.includes(lead.type as LeadTypeFilter) && isInPeriod(lead.receivedAt, filters.period) && employeeMatch && (filters.region === "Alle" || lead.region === filters.region) && filters.sources.includes(lead.source);
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

  const openDeals = filteredDeals.filter((deal) => deal.stage !== "Abschluss");
  const overdueLeads = filteredLeads.filter((lead) => new Date(lead.nextContactAt ?? lead.slaDueAt).getTime() < NOW.getTime());
  const hotLeads = filteredLeads.filter((lead) => lead.score > 80 || lead.hotStatus);
  const activeLeadsByType = leadTypeOptions.map((type) => ({ type, count: filteredLeads.filter((lead) => lead.type === type).length }));
  const pipelineCommission = openDeals.reduce((sum, deal) => sum + parseEuroValue(deal.value) * (deal.probability / 100) * COMMISSION_RATE, 0);
  const monthClosings = filteredDeals.filter((deal) => deal.stage === "Abschluss" && isInPeriod(deal.expectedCloseDate, "Monat"));
  const monthClosingCommission = monthClosings.reduce((sum, deal) => sum + parseEuroValue(deal.value) * COMMISSION_RATE, 0);
  const stageVisits = Math.max(1, filteredLeads.length);
  const viewingDeals = filteredDeals.filter((deal) => deal.stage === "Besichtigung").length;
  const closingDeals = filteredDeals.filter((deal) => deal.stage === "Abschluss").length;
  const conversionRate = Math.round((closingDeals / stageVisits) * 100);
  const avgClosingDays = Math.round(filteredDeals.reduce((sum, deal) => {
    const lead = getDealLead(deal, leads);
    return sum + (lead ? daysBetween(lead.receivedAt, deal.expectedCloseDate) : 34);
  }, 0) / Math.max(1, filteredDeals.length));
  const weekRequests = filteredLeads.filter((lead) => isInPeriod(lead.receivedAt, "Woche"));

  const sourceRows = sourceOptions.map((source) => {
    const sourceLeads = filteredLeads.filter((lead) => lead.source === source);
    const sourceClosings = filteredDeals.filter((deal) => deal.source === source && deal.stage === "Abschluss").length;
    return { source, count: sourceLeads.length, conversion: Math.round((sourceClosings / Math.max(1, sourceLeads.length)) * 100) };
  }).filter((row) => row.count > 0).sort((a, b) => b.count - a.count);

  const statusRows = ["Neu", "Qualifizieren", "Termin offen", "Übergabe", "Archiviert"].map((status) => ({
    status,
    count: filteredLeads.filter((lead) => lead.status === status).length,
  }));
  const totalStatus = Math.max(1, statusRows.reduce((sum, row) => sum + row.count, 0));
  const requestTrend = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(NOW);
    day.setDate(NOW.getDate() - (6 - index));
    const key = day.toISOString().slice(0, 10);
    return { key, label: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(day), count: filteredLeads.filter((lead) => lead.receivedAt.slice(0, 10) === key).length };
  });
  const trendMax = Math.max(1, ...requestTrend.map((item) => item.count));
  const todayItems = [
    ...tasks.filter((task) => task.status === "open" && task.due.includes("Heute")).map((task) => ({ id: task.id, title: task.title, meta: task.due, priority: task.priority })),
    ...calendarEvents.filter((event) => event.startsAt.slice(0, 10) === "2026-05-11").map((event) => ({ id: event.id, title: event.title, meta: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(event.startsAt)), priority: event.location })),
  ];
  const mandateRows = sellerListings.filter((listing) => listing.mandateEndsAt).map((listing) => ({ listing, daysLeft: daysBetween(NOW.toISOString(), listing.mandateEndsAt) })).filter((item) => item.daysLeft <= 60).sort((a, b) => a.daysLeft - b.daysLeft);
  const matchRows = sellerListings.flatMap((listing) => filteredLeads.filter((lead) => lead.type === "Käufer" || lead.type === "Investor").map((lead) => {
    const budgetTo = lead.buyerProfile?.budgetTo ?? lead.investorProfile?.investmentVolumeTo ?? 0;
    const budgetFrom = lead.buyerProfile?.budgetFrom ?? lead.investorProfile?.investmentVolumeFrom ?? 0;
    const priceMatch = listing.targetPrice >= budgetFrom && listing.targetPrice <= budgetTo;
    const regionMatch = lead.region === listing.region;
    const typeMatch = lead.objectType === listing.objectType || (lead.type === "Investor" && Boolean(listing.expectedGrossYield));
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

  const saveCurrentView = () => {
    const name = window.prompt("Name für diese Ansicht", "Neue Ansicht");
    if (!name?.trim()) return;
    const nextView: DashboardView = normalizeView({ id: "custom_" + Date.now(), name: name.trim(), filters, layout, widgets });
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
    const nextWidgets = [...widgets, widget];
    setWidgets(nextWidgets);
    setLayout((current) => normalizeLayout(nextWidgets, current));
  };

  const removeWidget = (widget: WidgetId) => {
    setWidgets((current) => current.filter((item) => item !== widget));
    setLayout((current) => current.filter((item) => item.i !== widget));
  };

  const exportPdf = async () => {
    if (!dashboardRef.current) return;
    setExporting(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);
      const canvas = await html2canvas(dashboardRef.current, { backgroundColor: "#f4f2ec", scale: 1.5 });
      const imageData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = (canvas.height * pageWidth) / canvas.width;
      pdf.addImage(imageData, "PNG", 0, 0, pageWidth, Math.min(pageHeight, pdf.internal.pageSize.getHeight()));
      pdf.save("novalure-clg-dashboard.pdf");
    } finally {
      setExporting(false);
    }
  };

  const renderKpi = (label: string, value: string, detail: string, tone = "bg-white") => (
    <div className={"flex h-full min-h-0 flex-col justify-between rounded-lg border border-stone-200 p-4 " + tone}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
        <p className="mt-3 break-words text-3xl font-semibold leading-tight text-slate-950">{value}</p>
      </div>
      <p className="mt-3 break-words text-sm leading-5 text-stone-600">{detail}</p>
    </div>
  );

  const renderWidgetContent = (widget: WidgetId) => {
    if (collapsedWidgets.includes(widget)) return <div className="text-sm text-stone-500">Widget ist zugeklappt.</div>;
    switch (widget) {
      case "activeLeads":
        return renderKpi("Aktive Leads", String(filteredLeads.length), activeLeadsByType.map((item) => item.type + ": " + item.count).join(" | "), "bg-emerald-50");
      case "pipelineValue":
        return renderKpi("Pipeline-Wert", formatEuro(pipelineCommission, locale), "Erwartete Provision aus " + openDeals.length + " offenen Deals", "bg-blue-50");
      case "monthlyClosings":
        return renderKpi("Abschlüsse Monat", formatEuro(monthClosingCommission, locale), "Ziel: " + formatEuro(MONTH_TARGET_COMMISSION, locale) + " | " + Math.round((monthClosingCommission / MONTH_TARGET_COMMISSION) * 100) + "%", "bg-violet-50");
      case "overdueFollowupsKpi":
        return renderKpi("Überfällige Follow-ups", String(overdueLeads.length), overdueLeads.slice(0, 2).map((lead) => getLeadName(lead, contacts)).join(" | ") || "Keine kritischen Follow-ups", overdueLeads.length ? "bg-red-50" : "bg-emerald-50");
      case "hotLeadsKpi":
        return renderKpi("Hot Leads", String(hotLeads.length), "Lead-Score > 80 oder Status heiß", "bg-amber-50");
      case "conversionRate":
        return renderKpi("Conversion-Rate", conversionRate + "%", "Anfrage " + filteredLeads.length + " -> Besichtigung " + viewingDeals + " -> Abschluss " + closingDeals, "bg-white");
      case "averageClosingDays":
        return renderKpi("Ø Tage bis Closing", String(avgClosingDays), "Aus Eingangsdatum und erwartetem Abschluss", "bg-white");
      case "newRequestsWeek":
        return renderKpi("Neue Anfragen Woche", String(weekRequests.length), weekRequests.map((lead) => lead.source).slice(0, 3).join(" | "), "bg-white");
      case "funnel":
        return <FunnelWidget activeType={activeFunnelType} filteredDeals={filteredDeals} filteredLeads={filteredLeads} leads={leads} onTypeChange={setActiveFunnelType} />;
      case "sourceBar":
        return <div className="grid gap-3">{sourceRows.map((row) => <div className="grid gap-1" key={row.source}><div className="flex justify-between gap-3 text-sm"><span className="font-semibold">{row.source}</span><span className="text-stone-500">{row.count} Leads | {row.conversion}% Conv.</span></div><div className="h-3 rounded-full bg-stone-100"><div className="h-3 rounded-full bg-blue-700" style={{ width: String(Math.max(10, (row.count / Math.max(1, filteredLeads.length)) * 100)) + "%" }} /></div></div>)}</div>;
      case "requestsLine":
        return <div className="flex h-full items-end gap-2 pt-4">{requestTrend.map((item) => <div className="flex flex-1 flex-col items-center gap-2" key={item.key}><div className="w-full rounded-t-md bg-emerald-700" style={{ height: String(Math.max(12, (item.count / trendMax) * 120)) + "px" }} /><span className="text-xs font-semibold text-stone-500">{item.label}</span></div>)}</div>;
      case "statusDonut":
        return <div className="grid gap-3 sm:grid-cols-[150px_1fr]"><div className="grid aspect-square place-items-center rounded-full bg-[conic-gradient(#059669_0_25%,#2563eb_25%_50%,#f59e0b_50%_75%,#7c3aed_75%_90%,#94a3b8_90%_100%)]"><div className="grid h-24 w-24 place-items-center rounded-full bg-white text-lg font-semibold">{filteredLeads.length}</div></div><div className="grid content-center gap-2">{statusRows.map((row) => <div className="flex justify-between text-sm" key={row.status}><span>{row.status}</span><span>{Math.round((row.count / totalStatus) * 100)}%</span></div>)}</div></div>;
      case "overdueFollowupsList":
        return <ListRows rows={overdueLeads.sort((a, b) => getAging(b).days - getAging(a).days).map((lead) => ({ id: lead.id, title: getLeadName(lead, contacts), meta: lead.nextAction + " | " + getAging(lead).days + " Tage ohne Kontakt", className: getAging(lead).className }))} empty="Keine überfälligen Follow-ups." />;
      case "todayTasks":
        return <ListRows rows={todayItems.map((item) => ({ id: item.id, title: item.title, meta: item.meta + " | " + item.priority, className: "border-stone-200 bg-stone-50 text-slate-900" }))} empty="Heute ist nichts offen." />;
      case "hotLeadsList":
        return <ListRows rows={hotLeads.map((lead) => ({ id: lead.id, title: getLeadName(lead, contacts), meta: "Score " + lead.score + " | " + lead.intent, className: getAging(lead).className }))} empty="Keine Hot Leads im Filter." />;
      case "newLeadsWeek":
        return <ListRows rows={weekRequests.map((lead) => ({ id: lead.id, title: getLeadName(lead, contacts), meta: lead.source + " | " + new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" }).format(new Date(lead.receivedAt)), className: "border-blue-200 bg-blue-50 text-blue-950" }))} empty="Keine neuen Leads diese Woche." />;
      case "expiringMandates":
        return <ListRows rows={mandateRows.map(({ listing, daysLeft }) => ({ id: listing.id, title: listing.title, meta: "läuft in " + daysLeft + " Tagen aus | " + formatEuro(listing.targetPrice, locale), className: daysLeft <= 30 ? "border-orange-200 bg-orange-50 text-orange-950" : "border-yellow-200 bg-yellow-50 text-yellow-950" }))} empty="Keine auslaufenden Verträge in 60 Tagen." />;
      case "matchSuggestions":
        return <ListRows rows={matchRows.map((match) => ({ id: match.listing.id + "_" + match.lead.id, title: getLeadName(match.lead, contacts) + " -> " + match.listing.title, meta: "Match " + match.score + "% | " + match.listing.region + " | " + compactNumber(match.listing.targetPrice, locale) + " EUR", className: "border-emerald-200 bg-emerald-50 text-emerald-950" }))} empty="Keine Match-Vorschläge im aktuellen Filter." />;
    }
  };

  const gridLayout = normalizeLayout(widgets, layout);
  const softWarning = widgets.length > 12;

  return (
    <section className="space-y-4" ref={dashboardRef}>
      <div className="rounded-lg border border-stone-200 bg-white p-4 md:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{projectLabel}</p>
            <h3 className="mt-1 text-2xl font-semibold">Novalure CLG</h3>
            <p className="mt-1 max-w-4xl break-words text-sm text-stone-600">Eine zentrale Ansicht für Käufer-, Verkäufer- und Investoren-Leads mit globalen Filtern, speicherbaren Views, Match-Vorschlägen und exportierbarer Arbeitsansicht.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onChange={(event) => applyView(event.target.value)} value={activeViewId}>{views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select>
            <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={saveCurrentView} type="button">View speichern</button>
            <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => applyView("default")} type="button">Standardansicht</button>
            <button className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:bg-stone-400" disabled={exporting} onClick={exportPdf} type="button">{exporting ? "PDF wird erstellt" : "PDF exportieren"}</button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 xl:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_1.2fr]">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Lead-Typ</p>
            <div className="mt-2 flex flex-wrap gap-2">{leadTypeOptions.map((type) => <label className="flex items-center gap-2 rounded-md bg-white px-2 py-1.5 text-sm font-semibold" key={type}><input checked={filters.leadTypes.includes(type)} onChange={() => toggleLeadType(type)} type="checkbox" />{type}</label>)}</div>
          </div>
          <label className="grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Zeitraum<select className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900" onChange={(event) => setFilters((current) => ({ ...current, period: event.target.value as PeriodOption }))} value={filters.period}>{periodOptions.map((period) => <option key={period} value={period}>{period}</option>)}</select></label>
          <label className="grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Mitarbeiter<select className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900" onChange={(event) => setFilters((current) => ({ ...current, employeeId: event.target.value }))} value={filters.employeeId}><option value="all">Alle</option><option value="mine">Nur eigene</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
          <label className="grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Region<select className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900" onChange={(event) => setFilters((current) => ({ ...current, region: event.target.value as Region | "Alle" }))} value={filters.region}>{regionOptions.map((region) => <option key={region} value={region}>{region}</option>)}</select></label>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Lead-Quelle</p>
            <div className="mt-2 flex max-h-24 flex-wrap gap-2 overflow-auto">{sourceOptions.map((source) => <label className="flex items-center gap-2 rounded-md bg-white px-2 py-1.5 text-xs font-semibold" key={source}><input checked={filters.sources.includes(source)} onChange={() => toggleSource(source)} type="checkbox" />{source}</label>)}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0"><p className="text-sm font-semibold">Widget-Grid</p><p className="mt-1 text-sm text-stone-500">Widgets lassen sich verschieben, vergrößern, entfernen und als View speichern. Aktive Funnel: {funnels.length}.</p>{softWarning ? <p className="mt-2 text-sm font-semibold text-amber-700">Mehr als 12 Widgets aktiv. Die Ansicht kann unübersichtlich werden.</p> : null}</div>
        <button className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white" onClick={() => setLibraryOpen((current) => !current)} type="button">+ Widget hinzufügen</button>
      </div>

      {libraryOpen ? <div className="grid gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 md:grid-cols-3">{(Object.keys(widgetCatalog) as WidgetId[]).map((id) => <button className="rounded-lg border border-emerald-200 bg-white p-3 text-left text-sm hover:border-emerald-500 disabled:opacity-50" disabled={widgets.includes(id)} key={id} onClick={() => addWidget(id)} type="button"><span className="block font-semibold">{widgetCatalog[id].title}</span><span className="mt-1 block text-xs text-stone-500">{widgetCatalog[id].kind} | {widgetCatalog[id].description}</span></button>)}</div> : null}

      <div ref={containerRef}>
        {mounted ? (
          <GridLayout
            className="layout dashboard-grid"
            dragConfig={{ bounded: true, handle: ".widget-drag-handle" }}
            gridConfig={{ cols: 12, containerPadding: null, margin: [16, 16], rowHeight: 72 }}
            layout={gridLayout}
            onLayoutChange={(nextLayout) => setLayout([...nextLayout])}
            resizeConfig={{ enabled: true }}
            width={width}
          >
        {widgets.map((widget) => (
          <article className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm" key={widget}>
            <div className="widget-drag-handle cursor-move border-b border-stone-100 px-4 py-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold leading-5 text-slate-950">{widgetCatalog[widget].title}</p>
                  <p className="mt-1 line-clamp-2 break-words text-xs leading-4 text-stone-500">{widgetCatalog[widget].description}</p>
                </div>
                <div className="grid shrink-0 grid-cols-3 gap-1">
                  <button className="grid h-7 w-7 place-items-center rounded-md border border-stone-200 text-xs font-semibold" onClick={() => setCollapsedWidgets((current) => current.includes(widget) ? current.filter((item) => item !== widget) : [...current, widget])} title={collapsedWidgets.includes(widget) ? "Widget aufklappen" : "Widget zuklappen"} type="button">{collapsedWidgets.includes(widget) ? "+" : "-"}</button>
                  <button className="grid h-7 w-7 place-items-center rounded-md border border-stone-200 text-xs font-semibold" onClick={() => setSettingsWidget(settingsWidget === widget ? null : widget)} title="Widget-Einstellungen" type="button">Opt</button>
                  <button className="grid h-7 w-7 place-items-center rounded-md border border-red-200 text-xs font-semibold text-red-700" onClick={() => removeWidget(widget)} title="Widget entfernen" type="button">x</button>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {settingsWidget === widget ? <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600">Widget-Einstellung: Dieses Widget folgt aktuell den globalen Filtern. Ein eigener Zeitraum je Widget ist als nächster Ausbaupunkt vorbereitet.</div> : null}
              {renderWidgetContent(widget)}
            </div>
          </article>
        ))}
      </GridLayout>
        ) : null}
      </div>
    </section>
  );
}

function FunnelWidget({
  activeType,
  filteredDeals,
  filteredLeads,
  leads,
  onTypeChange,
}: {
  activeType: LeadTypeFilter;
  filteredDeals: Deal[];
  filteredLeads: Lead[];
  leads: Lead[];
  onTypeChange: (type: LeadTypeFilter) => void;
}) {
  const typeLeads = filteredLeads.filter((lead) => lead.type === activeType);
  const typeDeals = filteredDeals.filter((deal) => getDealLead(deal, leads)?.type === activeType);
  const rows = [
    { label: "Anfrage", count: typeLeads.length },
    { label: "Qualifiziert", count: typeDeals.filter((deal) => ["Qualifiziert", "Termin gebucht", "Besichtigung", "Abschluss"].includes(deal.stage)).length },
    { label: "Besichtigung", count: typeDeals.filter((deal) => ["Besichtigung", "Abschluss"].includes(deal.stage)).length },
    { label: "Abschluss", count: typeDeals.filter((deal) => deal.stage === "Abschluss").length },
  ];
  const max = Math.max(1, ...rows.map((row) => row.count));

  return <div><div className="mb-4 flex flex-wrap gap-2">{leadTypeOptions.map((type) => <button className={"rounded-md border px-3 py-1.5 text-sm font-semibold " + (activeType === type ? "border-slate-950 bg-slate-950 text-white" : "border-stone-300 bg-white text-stone-700")} key={type} onClick={() => onTypeChange(type)} type="button">{type}</button>)}</div><div className="grid gap-3">{rows.map((row) => <div className="grid gap-1" key={row.label}><div className="flex justify-between text-sm"><span className="font-semibold">{row.label}</span><span>{row.count}</span></div><div className="h-8 overflow-hidden rounded-md bg-stone-100"><div className="h-full rounded-md bg-emerald-700" style={{ width: String(Math.max(8, (row.count / max) * 100)) + "%" }} /></div></div>)}</div></div>;
}

function ListRows({ rows, empty }: { rows: Array<{ id: string; title: string; meta: string; className: string }>; empty: string }) {
  if (rows.length === 0) return <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">{empty}</div>;
  return <div className="grid gap-2">{rows.map((row) => <div className={"rounded-lg border p-3 " + row.className} key={row.id}><p className="break-words text-sm font-semibold">{row.title}</p><p className="mt-1 break-words text-xs opacity-80">{row.meta}</p></div>)}</div>;
}
