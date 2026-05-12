"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  Contact,
  Deal,
  DealStage,
  Organization,
  PipelineStage,
  Project,
  Task,
  WorkspaceUser,
} from "@/lib/crm-types";
import { getDashboardCopy, languageOptionsByCode, type LanguageCode } from "@/lib/i18n";

type DealPipelineWorkspaceProps = {
  contacts: Contact[];
  deals: Deal[];
  language: LanguageCode;
  organizations: Organization[];
  pipeline: PipelineStage[];
  projectLabel: string;
  projects: Project[];
  tasks: Task[];
  users: WorkspaceUser[];
};

type DealPatch = Partial<
  Pick<Deal, "expectedCloseDate" | "nextAction" | "ownerUserId" | "probability" | "riskLevel" | "stage" | "value">
>;

type DealView = {
  contact?: Contact;
  deal: Deal;
  organization?: Organization;
  owner?: WorkspaceUser;
  project?: Project;
};

type StageFilter = DealStage | "all";
type RiskFilter = Deal["riskLevel"] | "all";

const DEAL_PATCH_STORAGE_KEY = "novalure-pipeline-deal-patches-v1";
const MANUAL_DEAL_STORAGE_KEY = "novalure-pipeline-manual-deals-v1";
const TODAY = new Date("2026-05-11T00:00:00+02:00").getTime();

const riskStyles: Record<Deal["riskLevel"], string> = {
  niedrig: "border-emerald-200 bg-emerald-50 text-emerald-900",
  mittel: "border-amber-200 bg-amber-50 text-amber-900",
  hoch: "border-red-200 bg-red-50 text-red-900",
};

const labels = {
  de: {
    title: "Dealpipeline",
    description:
      "Arbeite Deals nach Phase, Risiko, Besitzer und nächstem Schritt. Änderungen bleiben lokal gespeichert und sind für den HubSpot-Starter-Abgleich vorbereitet.",
    forecast: "Gewichteter Forecast",
    openDeals: "Offene Deals",
    closeSoon: "Abschluesse 60 Tage",
    riskDeals: "Deals mit Risiko",
    search: "Suche",
    searchPlaceholder: "Deal, Kontakt, Firma, Projekt oder Aktion suchen",
    owner: "Besitzer",
    risk: "Risiko",
    stage: "Phase",
    all: "Alle",
    createDeal: "Deal anlegen",
    close: "Schliessen",
    create: "Erstellen",
    selectedDeal: "Ausgewählter Deal",
    contact: "Kontakt",
    organization: "Organisation",
    project: "Projekt",
    source: "Quelle",
    value: "Wert",
    probability: "Wahrscheinlichkeit",
    expectedClose: "Erwarteter Abschluss",
    nextStep: "Nächster Schritt",
    taskContext: "Passende Aufgaben",
    noTasks: "Keine offene Aufgabe für diesen Deal.",
    moveBack: "Zurück",
    moveForward: "Nächste Phase",
    save: "Änderungen speichern",
    saved: "Pipeline-Änderungen gespeichert.",
    reset: "Lokale Änderungen zuruecksetzen",
    fieldMapping: "HubSpot Starter Feldmapping",
    importReady: "bereit",
    missing: "fehlt",
    stageHealth: "Phasen-Gesundheit",
    emptyStage: "Keine Deals in dieser Phase.",
    score: "Score",
    avgProbability: "Ø Wahrscheinlichkeit",
    noDeals: "Keine Deals für diesen Filter.",
    newDealName: "Dealname",
    amount: "Betrag",
    closeDate: "Abschlussdatum",
    contactLabel: "Kontakt",
    contactMissing: "Kein Kontakt vorhanden",
    pipelineSetup: "Pipeline-Setup",
    setupDescription:
      "Die Phasen bleiben mit dem vorhandenen Projektfilter synchron. Deal, Kontakt, Organisation, Besitzer und Aufgaben sind sichtbar verbunden.",
  },
  en: {
    title: "Deal pipeline",
    description:
      "Work deals by stage, risk, owner and next step. Changes stay locally saved and are prepared for a HubSpot Starter sync.",
    forecast: "Weighted forecast",
    openDeals: "Open deals",
    closeSoon: "Closings 60 days",
    riskDeals: "Risk deals",
    search: "Search",
    searchPlaceholder: "Search deal, contact, company, project or action",
    owner: "Owner",
    risk: "Risk",
    stage: "Stage",
    all: "All",
    createDeal: "Create deal",
    close: "Close",
    create: "Create",
    selectedDeal: "Selected deal",
    contact: "Contact",
    organization: "Organization",
    project: "Project",
    source: "Source",
    value: "Value",
    probability: "Probability",
    expectedClose: "Expected close",
    nextStep: "Next step",
    taskContext: "Related tasks",
    noTasks: "No open task for this deal.",
    moveBack: "Back",
    moveForward: "Next stage",
    save: "Save changes",
    saved: "Pipeline changes saved.",
    reset: "Reset local changes",
    fieldMapping: "HubSpot Starter field mapping",
    importReady: "ready",
    missing: "missing",
    stageHealth: "Stage health",
    emptyStage: "No deals in this stage.",
    score: "Score",
    avgProbability: "Avg. probability",
    noDeals: "No deals for this filter.",
    newDealName: "Deal name",
    amount: "Amount",
    closeDate: "Close date",
    contactLabel: "Contact",
    contactMissing: "No contact available",
    pipelineSetup: "Pipeline setup",
    setupDescription:
      "Stages stay synchronized with the current project filter. Deal, contact, organization, owner and tasks remain visibly connected.",
  },
} as const;

function loadStoredRecord<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const stored = window.localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function parseEuroValue(value: string) {
  const lowerValue = value.toLowerCase();
  const isMillion = lowerValue.includes("mio");
  const normalized = lowerValue
    .replace(/mio\.?/g, "")
    .replace(/eur/g, "")
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
  return new Intl.NumberFormat(locale, {
    currency: "EUR",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

function sanitizeAmount(value: string) {
  const trimmed = value.trim();
  return trimmed || "0";
}

export function DealPipelineWorkspace({
  contacts,
  deals,
  language,
  organizations,
  pipeline,
  projectLabel,
  projects,
  tasks,
  users,
}: DealPipelineWorkspaceProps) {
  const copy = getDashboardCopy(language);
  const text = labels[language];
  const locale = languageOptionsByCode[language].locale;
  const stageTitles = useMemo(() => pipeline.map((stage) => stage.title), [pipeline]);
  const initialContact = contacts[0];
  const [dealPatches, setDealPatches] = useState<Record<string, DealPatch>>(() =>
    loadStoredRecord<Record<string, DealPatch>>(DEAL_PATCH_STORAGE_KEY, {}),
  );
  const [manualDeals, setManualDeals] = useState<Deal[]>(() =>
    loadStoredRecord<Deal[]>(MANUAL_DEAL_STORAGE_KEY, []),
  );
  const [selectedDealId, setSelectedDealId] = useState(deals[0]?.id ?? "");
  const [searchTerm, setSearchTerm] = useState("");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [newDeal, setNewDeal] = useState({
    contactId: initialContact?.id ?? "",
    expectedCloseDate: "2026-06-30",
    name: initialContact ? `${initialContact.name} Deal` : "",
    probability: 50,
    stage: stageTitles[0] ?? ("Neuer Lead" as DealStage),
    value: "250.000",
  });

  useEffect(() => {
    window.localStorage.setItem(DEAL_PATCH_STORAGE_KEY, JSON.stringify(dealPatches));
  }, [dealPatches]);

  useEffect(() => {
    window.localStorage.setItem(MANUAL_DEAL_STORAGE_KEY, JSON.stringify(manualDeals));
  }, [manualDeals]);

  const scopedManualDeals = useMemo(
    () => manualDeals.filter((deal) => contacts.some((contact) => contact.id === deal.contactId)),
    [contacts, manualDeals],
  );
  const workingDeals = useMemo(
    () =>
      [...deals, ...scopedManualDeals].map((deal) => ({
        ...deal,
        ...dealPatches[deal.id],
      })),
    [dealPatches, deals, scopedManualDeals],
  );
  const dealViews = useMemo<DealView[]>(
    () =>
      workingDeals.map((deal) => {
        const contact = contacts.find((item) => item.id === deal.contactId);
        const organization = deal.organizationId
          ? organizations.find((item) => item.id === deal.organizationId)
          : contact?.organizationId
            ? organizations.find((item) => item.id === contact.organizationId)
            : undefined;
        const project = projects.find((item) => item.id === deal.projectId);
        const owner = deal.ownerUserId ? users.find((item) => item.id === deal.ownerUserId) : undefined;

        return { contact, deal, organization, owner, project };
      }),
    [contacts, organizations, projects, users, workingDeals],
  );

  const filteredDealViews = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase();

    return dealViews.filter((item) => {
      const matchesStage = stageFilter === "all" || item.deal.stage === stageFilter;
      const matchesRisk = riskFilter === "all" || item.deal.riskLevel === riskFilter;
      const matchesOwner = ownerFilter === "all" || item.deal.ownerUserId === ownerFilter;
      const searchable = [
        item.deal.name,
        item.deal.nextAction,
        item.deal.source,
        item.contact?.name,
        item.contact?.intent,
        item.organization?.name,
        item.project?.name,
        item.owner?.name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return matchesStage && matchesRisk && matchesOwner && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [dealViews, ownerFilter, riskFilter, searchTerm, stageFilter]);

  const selectedDealView =
    dealViews.find((item) => item.deal.id === selectedDealId) ?? filteredDealViews[0] ?? dealViews[0];
  const selectedDeal = selectedDealView?.deal;
  const selectedTasks = selectedDealView?.contact
    ? tasks.filter((task) => task.contactId === selectedDealView.contact?.id && task.status === "open")
    : [];
  const weightedForecast = workingDeals.reduce(
    (sum, deal) => sum + parseEuroValue(deal.value) * (deal.probability / 100),
    0,
  );
  const closeSoonDeals = workingDeals.filter((deal) => {
    const closeDate = new Date(deal.expectedCloseDate).getTime();
    return closeDate >= TODAY && closeDate <= TODAY + 60 * 24 * 60 * 60 * 1000;
  });
  const riskyDeals = workingDeals.filter((deal) => deal.riskLevel === "hoch" || deal.probability < 45);
  const ownerOptions = users.filter((user) => workingDeals.some((deal) => deal.ownerUserId === user.id));
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

  const moveDeal = (deal: Deal, direction: -1 | 1) => {
    const currentIndex = stageTitles.indexOf(deal.stage);
    const nextStage = stageTitles[currentIndex + direction];

    if (nextStage) {
      patchDeal(deal.id, { stage: nextStage });
    }
  };

  const createDeal = () => {
    const contact = contacts.find((item) => item.id === createContactId);
    if (!contact) {
      return;
    }

    const project = projects.find((item) => item.id === contact.projectId);
    const deal: Deal = {
      id: `deal_manual_${Date.now()}`,
      workspaceId: contact.workspaceId,
      projectId: contact.projectId,
      contactId: contact.id,
      organizationId: contact.organizationId,
      ownerUserId: users[0]?.id,
      name: newDeal.name.trim() || `${contact.name} Deal`,
      stage: newDeal.stage,
      value: sanitizeAmount(newDeal.value),
      probability: Number(newDeal.probability),
      expectedCloseDate: newDeal.expectedCloseDate,
      riskLevel: Number(newDeal.probability) < 45 ? "hoch" : Number(newDeal.probability) < 65 ? "mittel" : "niedrig",
      source: contact.source,
      nextAction: contact.intent || copy.leadInbox.pipelineHandover,
    };

    setManualDeals((current) => [deal, ...current]);
    setSelectedDealId(deal.id);
    setStageFilter("all");
    setRiskFilter("all");
    setOwnerFilter("all");
    setSearchTerm("");
    setIsCreateOpen(false);
    setSavedMessage(language === "de" ? `Deal für ${project?.name ?? contact.project} angelegt.` : "Deal created.");
  };

  const resetLocalState = () => {
    setDealPatches({});
    setManualDeals([]);
    setSelectedDealId(deals[0]?.id ?? "");
    setSavedMessage(language === "de" ? "Lokale Pipeline-Änderungen wurden entfernt." : "Local pipeline changes removed.");
  };

  const dealFieldRows = selectedDeal
    ? [
        ["dealname", selectedDeal.name],
        ["amount", selectedDeal.value],
        ["dealstage", selectedDeal.stage],
        ["pipeline", selectedDealView.project?.defaultPipelineId],
        ["closedate", selectedDeal.expectedCloseDate],
        ["hubspot_owner_id", selectedDealView.owner?.email],
        ["associated_contact", selectedDealView.contact?.name],
        ["associated_company", selectedDealView.organization?.name],
      ]
    : [];

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-4 md:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {projectLabel}
            </p>
            <h3 className="mt-1 text-2xl font-semibold">{text.title}</h3>
            <p className="mt-2 max-w-4xl break-words text-sm text-stone-600">{text.description}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              className="rounded-md border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-stone-100"
              onClick={resetLocalState}
              type="button"
            >
              {text.reset}
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

        <div className="mt-5 grid gap-3 md:grid-cols-4">
          {[
            { label: text.forecast, value: formatEuro(weightedForecast, locale), detail: copy.metrics.pipelineValue },
            { label: text.openDeals, value: String(workingDeals.length), detail: projectLabel },
            { label: text.closeSoon, value: String(closeSoonDeals.length), detail: text.expectedClose },
            { label: text.riskDeals, value: String(riskyDeals.length), detail: text.stageHealth },
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
                  value={newDeal.stage}
                >
                  {stageTitles.map((stage) => (
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
              disabled={contacts.length === 0}
              onClick={createDeal}
              type="button"
            >
              {text.create}
            </button>
          </div>
        ) : null}
      </article>

      <article className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px_220px]">
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
            {text.stage}
            <select
              className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
              onChange={(event) => setStageFilter(event.target.value as StageFilter)}
              value={stageFilter}
            >
              <option value="all">{text.all}</option>
              {stageTitles.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.risk}
            <select
              className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
              onChange={(event) => setRiskFilter(event.target.value as RiskFilter)}
              value={riskFilter}
            >
              <option value="all">{text.all}</option>
              <option value="niedrig">niedrig</option>
              <option value="mittel">mittel</option>
              <option value="hoch">hoch</option>
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {text.owner}
            <select
              className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
              onChange={(event) => setOwnerFilter(event.target.value)}
              value={ownerFilter}
            >
              <option value="all">{text.all}</option>
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </article>

      <section className="grid gap-4 2xl:grid-cols-[1fr_400px]">
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white p-3">
          <div className="grid min-w-[1180px] grid-cols-5 gap-3">
            {stageTitles.map((stage) => {
              const stageDeals = filteredDealViews.filter((item) => item.deal.stage === stage);
              const stageValue = stageDeals.reduce((sum, item) => sum + parseEuroValue(item.deal.value), 0);
              const avgProbability =
                stageDeals.length > 0
                  ? Math.round(stageDeals.reduce((sum, item) => sum + item.deal.probability, 0) / stageDeals.length)
                  : 0;

              return (
                <section className="rounded-lg bg-stone-100 p-3" key={stage}>
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="break-words text-sm font-semibold">{stage}</h4>
                      <p className="mt-1 break-words text-xs text-stone-500">
                        {stageValue > 0 ? formatEuro(stageValue, locale) : text.emptyStage}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">
                      {stageDeals.length}
                    </span>
                  </div>
                  <div className="mb-3 rounded-md bg-white px-2 py-1.5 text-xs font-semibold text-stone-600">
                    {text.avgProbability}: {avgProbability}%
                  </div>

                  <div className="space-y-3">
                    {stageDeals.length > 0 ? (
                      stageDeals
                        .sort((a, b) => b.deal.probability - a.deal.probability)
                        .map((item) => {
                          const isSelected = selectedDeal?.id === item.deal.id;

                          return (
                            <button
                              aria-pressed={isSelected}
                              className={`w-full rounded-lg border bg-white p-3 text-left shadow-sm transition ${
                                isSelected
                                  ? "border-slate-950 ring-2 ring-slate-950/10"
                                  : "border-stone-200 hover:border-emerald-300"
                              }`}
                              key={item.deal.id}
                              onClick={() => setSelectedDealId(item.deal.id)}
                              type="button"
                            >
                              <span className="flex min-w-0 items-start justify-between gap-2">
                                <span className="min-w-0">
                                  <span className="block break-words text-sm font-semibold text-slate-950">
                                    {item.deal.name}
                                  </span>
                                  <span className="mt-1 block break-words text-xs font-medium uppercase tracking-[0.12em] text-emerald-700">
                                    {item.contact?.name ?? item.organization?.name ?? item.deal.source}
                                  </span>
                                </span>
                                <span className="shrink-0 rounded-md bg-slate-950 px-2 py-1 text-xs font-semibold text-white">
                                  {item.deal.probability}%
                                </span>
                              </span>
                              <span className="mt-3 block break-words text-sm text-stone-600">
                                {formatEuro(parseEuroValue(item.deal.value), locale)} · {item.project?.name ?? projectLabel}
                              </span>
                              <span className="mt-3 grid gap-2 text-xs">
                                <span className="break-words rounded-md bg-blue-50 px-2 py-1.5 font-semibold text-blue-800">
                                  {item.deal.nextAction}
                                </span>
                                <span className={`rounded-md border px-2 py-1 font-semibold ${riskStyles[item.deal.riskLevel]}`}>
                                  {text.risk}: {item.deal.riskLevel}
                                </span>
                              </span>
                            </button>
                          );
                        })
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
                  [text.project, selectedDealView.project?.name ?? projectLabel],
                  [text.contact, selectedDealView.contact?.name],
                  [text.organization, selectedDealView.organization?.name],
                  [text.owner, selectedDealView.owner?.name],
                  [text.source, selectedDeal.source],
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
                    <option value="niedrig">niedrig</option>
                    <option value="mittel">mittel</option>
                    <option value="hoch">hoch</option>
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
                  disabled={stageTitles.indexOf(selectedDeal.stage) <= 0}
                  onClick={() => moveDeal(selectedDeal, -1)}
                  type="button"
                >
                  {text.moveBack}
                </button>
                <button
                  className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-300"
                  disabled={stageTitles.indexOf(selectedDeal.stage) >= stageTitles.length - 1}
                  onClick={() => moveDeal(selectedDeal, 1)}
                  type="button"
                >
                  {text.moveForward}
                </button>
              </div>
              <button
                className="mt-3 w-full rounded-md bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
                onClick={() => setSavedMessage(text.saved)}
                type="button"
              >
                {text.save}
              </button>

              <div className="mt-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-950">{text.taskContext}</p>
                  <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">
                    {selectedTasks.length}
                  </span>
                </div>
                <div className="mt-2 space-y-2">
                  {selectedTasks.length > 0 ? (
                    selectedTasks.map((task) => (
                      <div className="rounded-md border border-stone-200 p-3 text-sm" key={task.id}>
                        <p className="break-words font-semibold text-slate-950">{task.title}</p>
                        <p className="mt-1 break-words text-xs text-stone-500">
                          {task.due} · {task.priority}
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
              HubSpot Starter
            </span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead className="border-b border-stone-200 text-xs uppercase tracking-[0.12em] text-stone-500">
                <tr>
                  <th className="py-2 pr-3 font-semibold">Novalure</th>
                  <th className="py-2 pr-3 font-semibold">Wert</th>
                  <th className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {dealFieldRows.map(([field, value]) => (
                  <tr key={field}>
                    <td className="py-3 pr-3 font-semibold text-slate-900">{field}</td>
                    <td className="py-3 pr-3 text-stone-600">{value ?? "-"}</td>
                    <td className="py-3">
                      <span
                        className={`rounded-md px-2 py-1 text-xs font-semibold ${
                          value ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
                        }`}
                      >
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
          <div className="mt-4 grid gap-3 text-sm">
            {stageTitles.map((stage) => {
              const stageDeals = workingDeals.filter((deal) => deal.stage === stage);
              const value = stageDeals.reduce((sum, deal) => sum + parseEuroValue(deal.value), 0);

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
                </div>
              );
            })}
          </div>
        </article>
      </section>
    </section>
  );
}
