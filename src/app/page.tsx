"use client";

import { useState } from "react";
import {
  automations,
  botLanguageRules,
  calendarEvents,
  contactRelationships,
  contactTimeline,
  contacts,
  consents,
  conversations,
  deals,
  funnelSteps,
  funnels,
  leads,
  knowledgeBase,
  newsletterAutomations,
  newsletterCampaigns,
  newsletterDeliverability,
  newsletterSegments,
  newsletterSuppressions,
  newsletterTemplates,
  organizations,
  sellerListings,
  pipeline,
  projects,
  tasks,
  users,
  workspace,
} from "@/lib/crm-data";
import { BotLanguageTester } from "@/components/bot-language-tester";
import { CalendarCommandCenter } from "@/components/calendar-command-center";
import { ContactCommandCenter } from "@/components/contact-command-center";
import { DashboardOverview } from "@/components/dashboard-overview";
import { DealPipelineWorkspace } from "@/components/deal-pipeline-workspace";
import { FunnelCommandCenter } from "@/components/funnel-command-center";
import { KnowledgeCommandCenter } from "@/components/knowledge-command-center";
import { LeadInbox } from "@/components/lead-inbox";
import { NewsletterCommandCenter } from "@/components/newsletter-command-center";
import { TaskCommandCenter } from "@/components/task-command-center";
import {
  getDashboardCopy,
  getLanguageLabel,
  languageOptionsByCode,
  supportedLanguages,
  type BotLanguageMode,
  type LanguageCode,
} from "@/lib/i18n";

type DashboardSection =
  | "dashboard"
  | "leadInbox"
  | "pipelines"
  | "contacts"
  | "tasks"
  | "funnels"
  | "bots"
  | "knowledge"
  | "newsletter"
  | "calendar";

const statusStyles: Record<string, string> = {
  Aktiv: "bg-emerald-100 text-emerald-800",
  Skaliert: "bg-blue-100 text-blue-800",
  Review: "bg-amber-100 text-amber-800",
  Neu: "bg-emerald-100 text-emerald-800",
  Qualifizieren: "bg-blue-100 text-blue-800",
  "Termin offen": "bg-amber-100 text-amber-800",
  Übergabe: "bg-violet-100 text-violet-800",
  Archiviert: "bg-slate-100 text-slate-700",
  Bereit: "bg-emerald-100 text-emerald-800",
  Training: "bg-violet-100 text-violet-800",
  Verbinden: "bg-blue-100 text-blue-800",
  Geplant: "bg-slate-100 text-slate-700",
};

function NavigationIcon({ section }: { section: DashboardSection }) {
  const iconClass = "h-4 w-4";

  switch (section) {
    case "dashboard":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4 5.5h6v6H4zM14 5.5h6v6h-6zM4 15h6v3.5H4zM14 15h6v3.5h-6z" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "leadInbox":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4 5h16v10l-3 4H7l-3-4z" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 15h8M9 9h6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "pipelines":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 5h4v14H5zM10 8h4v11h-4zM15 11h4v8h-4z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "contacts":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20c.9-3.4 3.4-5 7-5s6.1 1.6 7 5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "tasks":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M7 6h12M7 12h12M7 18h12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path d="m3.5 6 1 1 1.8-2M3.5 12l1 1 1.8-2M3.5 18l1 1 1.8-2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "funnels":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4 5h16l-6.2 7v5.5L10.2 19v-7z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "bots":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M7 8h10a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H9l-4 3v-3H7a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M9 12h.01M15 12h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
        </svg>
      );
    case "knowledge":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 5.5h6a3 3 0 0 1 3 3V20a3 3 0 0 0-3-3H5zM14 8.5a3 3 0 0 1 3-3h2v11.5h-2a3 3 0 0 0-3 3z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "newsletter":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4 6h16v12H4z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="m5 7 7 6 7-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "calendar":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 6h14v13H5zM5 10h14M8 4v4M16 4v4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
  }
}

function NovalureGlyph() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path d="M12 3 20 8v8l-8 5-8-5V8z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="m8.5 13 2.3 2.4 4.9-6.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

export default function Home() {
  const [activeProjectId, setActiveProjectId] = useState("all");
  const [activeSection, setActiveSection] = useState<DashboardSection>("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [language, setLanguage] = useState<LanguageCode>("de");
  const [botLanguage, setBotLanguage] = useState<LanguageCode>("de");
  const [botLanguageMode, setBotLanguageMode] = useState<BotLanguageMode>("auto");

  const copy = getDashboardCopy(language);
  const locale = languageOptionsByCode[language].locale;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const projectScopeLabel = activeProject?.name ?? copy.header.allProjects;
  const navigationItems: Array<{ id: DashboardSection; label: string }> = [
    { id: "dashboard", label: copy.navigation.overview },
    { id: "leadInbox", label: copy.navigation.leadInbox },
    { id: "pipelines", label: copy.navigation.pipelines },
    { id: "contacts", label: copy.navigation.contacts },
    { id: "tasks", label: copy.navigation.tasks },
    { id: "funnels", label: copy.navigation.funnels },
    { id: "bots", label: copy.navigation.bots },
    { id: "knowledge", label: copy.navigation.knowledge },
    { id: "newsletter", label: copy.navigation.newsletter },
    { id: "calendar", label: copy.navigation.calendar },
  ];
  const visibleLeads = activeProject
    ? leads.filter((lead) => lead.projectId === activeProject.id)
    : leads;
  const visibleContacts = activeProject
    ? contacts.filter((contact) => contact.projectId === activeProject.id)
    : contacts;
  const visibleOrganizations = activeProject
    ? organizations.filter((organization) => organization.projectId === activeProject.id)
    : organizations;
  const visibleContactRelationships = activeProject
    ? contactRelationships.filter((relationship) => relationship.projectId === activeProject.id)
    : contactRelationships;
  const visibleContactTimeline = activeProject
    ? contactTimeline.filter((item) => item.projectId === activeProject.id)
    : contactTimeline;
  const visibleTasks = activeProject
    ? tasks.filter((task) => task.projectId === activeProject.id)
    : tasks;
  const visibleConsents = activeProject
    ? consents.filter((consent) => consent.projectId === activeProject.id)
    : consents;
  const visibleConversations = activeProject
    ? conversations.filter((conversation) => conversation.projectId === activeProject.id)
    : conversations;
  const visibleDeals = activeProject
    ? deals.filter((deal) => deal.projectId === activeProject.id)
    : deals;
  const visibleCalendarEvents = activeProject
    ? calendarEvents.filter((event) => event.projectId === activeProject.id)
    : calendarEvents;
  const visibleFunnels = activeProject
    ? funnels.filter((funnel) => funnel.projectId === activeProject.id)
    : funnels;
  const visibleFunnelSteps = activeProject
    ? funnelSteps.filter((step) => step.projectId === activeProject.id)
    : funnelSteps;
  const visibleNewsletterSegments = activeProject
    ? newsletterSegments.filter(
        (segment) => !segment.projectId || segment.projectId === activeProject.id,
      )
    : newsletterSegments;
  const visibleNewsletterCampaigns = activeProject
    ? newsletterCampaigns.filter(
        (campaign) => !campaign.projectId || campaign.projectId === activeProject.id,
      )
    : newsletterCampaigns;
  const visibleNewsletterAutomations = activeProject
    ? newsletterAutomations.filter(
        (automation) => !automation.projectId || automation.projectId === activeProject.id,
      )
    : newsletterAutomations;
  const visibleKnowledgeBase = activeProject
    ? knowledgeBase.filter((item) => item.projectId === activeProject.id)
    : knowledgeBase;
  const visibleBotLanguageRules = activeProject
    ? botLanguageRules.filter(
        (rule) => !rule.projectId || rule.projectId === activeProject.id,
      )
    : botLanguageRules;
  const visiblePipeline = pipeline.map((stage) => {
    if (!activeProject) {
      return stage;
    }

    const cards = stage.cards.filter((card) =>
      visibleContacts.some((contact) => contact.name === card.name),
    );

    return {
      ...stage,
      cards,
      total: cards.length,
      value: cards.length > 0 ? activeProject.revenue : "0",
    };
  });
  return (
    <main className="min-h-screen bg-[#f4f2ec] text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-[1500px]">
        <aside
          className={`hidden shrink-0 overflow-hidden border-r border-stone-200 bg-white py-6 transition-all duration-200 xl:block ${
            sidebarCollapsed ? "w-16 px-2" : "w-80 px-5"
          }`}
        >
          <div
            className={`mb-8 flex gap-3 ${
              sidebarCollapsed ? "flex-col items-center" : "items-start justify-between"
            }`}
          >
            {sidebarCollapsed ? (
              <div className="grid h-10 w-10 place-items-center rounded-md bg-slate-950 text-white">
                <NovalureGlyph />
              </div>
            ) : (
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
                  Novalure
                </p>
                <h1 className="mt-2 text-2xl font-semibold">CRM Command Center</h1>
              </div>
            )}
            <button
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? "Navigation ausklappen" : "Navigation einklappen"}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-stone-300 bg-white text-sm font-semibold text-slate-800 hover:bg-stone-100"
              onClick={() => setSidebarCollapsed((current) => !current)}
              title={sidebarCollapsed ? "Navigation ausklappen" : "Navigation einklappen"}
              type="button"
            >
              {sidebarCollapsed ? ">>" : "<<"}
            </button>
          </div>

          <nav className="space-y-1 text-sm font-medium">
            {navigationItems.map((item) => (
              <button
                aria-label={item.label}
                className={`flex w-full items-center rounded-md py-2.5 text-left ${
                  activeSection === item.id
                    ? "bg-slate-950 text-white"
                    : "text-slate-600 hover:bg-stone-100 hover:text-slate-950"
                } ${sidebarCollapsed ? "justify-center px-0" : "justify-between px-3"}`}
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                title={item.label}
                type="button"
              >
                {sidebarCollapsed ? (
                  <span className="grid h-8 w-8 place-items-center rounded-md">
                    <NavigationIcon section={item.id} />
                  </span>
                ) : (
                  <span className="min-w-0 break-words">{item.label}</span>
                )}
                {!sidebarCollapsed && activeSection === item.id ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-300" />
                ) : null}
              </button>
            ))}
          </nav>

          {!sidebarCollapsed ? (
            <>
              <div className="mt-8 rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                  {copy.sidebar.workspace}
                </p>
                <p className="mt-2 break-words text-sm font-semibold">{workspace.name}</p>
                <p className="mt-1 break-words text-xs text-stone-600">{workspace.plan}</p>
                <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md bg-white p-3">
                    <p className="font-semibold">{workspace.activeProjects}</p>
                    <p className="break-words text-xs text-stone-500">{copy.sidebar.projects}</p>
                  </div>
                  <div className="rounded-md bg-white p-3">
                    <p className="font-semibold">{workspace.activeUsers}</p>
                    <p className="break-words text-xs text-stone-500">{copy.sidebar.users}</p>
                  </div>
                </div>
              </div>

              <details className="mt-4 rounded-lg border border-stone-200 bg-white p-4" open>
                <summary className="cursor-pointer select-none text-sm font-semibold text-slate-900">
                  {copy.sidebar.projects}
                </summary>
                <div className="mt-4 space-y-2">
                  <button
                    className={`block w-full rounded-md border p-3 text-left text-sm ${
                      activeProjectId === "all"
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-stone-200 bg-stone-50 text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                    }`}
                    onClick={() => setActiveProjectId("all")}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block break-words font-semibold">{copy.header.allProjects}</span>
                        <span
                          className={`mt-1 block break-words text-xs ${
                            activeProjectId === "all" ? "text-slate-300" : "text-stone-500"
                          }`}
                        >
                          {copy.header.allProjectsSubtitle}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
                          activeProjectId === "all"
                            ? "bg-white/10 text-white"
                            : "bg-white text-stone-700"
                        }`}
                      >
                        {projects.length}
                      </span>
                    </span>
                  </button>
                  {projects.map((project) => (
                    <button
                      className={`block w-full rounded-md border p-3 text-left text-sm ${
                        activeProjectId === project.id
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-200 bg-stone-50 text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                      }`}
                      key={project.name}
                      onClick={() => setActiveProjectId(project.id)}
                      type="button"
                    >
                      <span className="flex min-w-0 items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span
                            className={`block break-words font-semibold ${
                              activeProjectId === project.id ? "text-white" : "text-slate-900"
                            }`}
                          >
                            {project.name}
                          </span>
                          <span
                            className={`mt-1 block break-words text-xs ${
                              activeProjectId === project.id ? "text-slate-300" : "text-stone-500"
                            }`}
                          >
                            {project.type}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
                            statusStyles[project.status]
                          }`}
                        >
                          {project.status}
                        </span>
                      </span>
                      <span className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <span
                          className={`rounded-md p-2 ${
                            activeProjectId === project.id ? "bg-white/10" : "bg-white"
                          }`}
                        >
                          <span
                            className={`block font-semibold ${
                              activeProjectId === project.id ? "text-white" : "text-slate-900"
                            }`}
                          >
                            {project.leads}
                          </span>
                          <span
                            className={
                              activeProjectId === project.id ? "text-slate-300" : "text-stone-500"
                            }
                          >
                            {copy.sidebar.leads}
                          </span>
                        </span>
                        <span
                          className={`rounded-md p-2 ${
                            activeProjectId === project.id ? "bg-white/10" : "bg-white"
                          }`}
                        >
                          <span
                            className={`block break-words font-semibold ${
                              activeProjectId === project.id ? "text-white" : "text-slate-900"
                            }`}
                          >
                            {project.revenue}
                          </span>
                          <span
                            className={
                              activeProjectId === project.id ? "text-slate-300" : "text-stone-500"
                            }
                          >
                            {copy.sidebar.pipeline}
                          </span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </details>
            </>
          ) : null}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-stone-200 bg-white/90 px-4 py-4 backdrop-blur md:px-8">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-emerald-700">
                  {projectScopeLabel}
                </p>
                <h2 className="mt-1 max-w-3xl break-words text-2xl font-semibold md:text-4xl">
                  {activeProject
                    ? copy.header.projectHeadline(activeProject.type)
                    : copy.header.defaultHeadline}
                </h2>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="flex flex-col gap-1 text-xs font-semibold text-stone-600">
                  {copy.language.systemLabel}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                    onChange={(event) => {
                      const nextLanguage = event.target.value as LanguageCode;
                      setLanguage(nextLanguage);
                      if (botLanguageMode === "auto") {
                        setBotLanguage(nextLanguage);
                      }
                    }}
                    value={language}
                  >
                    {supportedLanguages.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.nativeName}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="rounded-md border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800">
                  {copy.header.importButton}
                </button>
                <button className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white">
                  {copy.header.newProjectButton}
                </button>
              </div>
            </div>
          </header>

          <div className="space-y-6 px-4 py-6 md:px-8">
            {activeSection === "dashboard" ? (
              <DashboardOverview
                calendarEvents={visibleCalendarEvents}
                contacts={visibleContacts}
                deals={visibleDeals}
                funnels={visibleFunnels}
                language={language}
                leads={visibleLeads}
                pipeline={visiblePipeline}
                projectLabel={projectScopeLabel}
                projects={projects}
                sellerListings={sellerListings.filter((listing) => !activeProject || listing.projectId === activeProject.id)}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            {activeSection === "leadInbox" ? (
              <LeadInbox
                consents={visibleConsents}
                contacts={visibleContacts}
                conversations={visibleConversations}
                leads={visibleLeads}
                language={language}
                projects={projects}
                users={users}
              />
            ) : null}

            {activeSection === "bots" ? (
              <>
            <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <article className="rounded-lg border border-stone-200 bg-white p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                      {copy.language.customerContext}
                    </p>
                    <h3 className="mt-1 text-lg font-semibold">{copy.language.systemLabel}</h3>
                    <p className="mt-2 max-w-2xl break-words text-sm text-stone-600">
                      {copy.language.helper}
                    </p>
                  </div>
                  <span className="rounded-md bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-700">
                    {projectScopeLabel}
                  </span>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <label className="grid gap-1 text-sm font-semibold text-slate-900">
                    {copy.language.systemLabel}
                    <select
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-800"
                      onChange={(event) => {
                        const nextLanguage = event.target.value as LanguageCode;
                        setLanguage(nextLanguage);
                        if (botLanguageMode === "auto") {
                          setBotLanguage(nextLanguage);
                        }
                      }}
                      value={language}
                    >
                      {supportedLanguages.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.nativeName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="rounded-md bg-stone-50 p-3 text-sm">
                    <p className="font-semibold text-slate-900">{getLanguageLabel(language)}</p>
                    <p className="mt-1 text-stone-600">{languageOptionsByCode[language].locale}</p>
                    <p className="mt-1 text-stone-500">
                      {new Intl.DateTimeFormat(locale, {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                      }).format(new Date())}
                    </p>
                  </div>
                </div>
              </article>

              <article className="rounded-lg border border-stone-200 bg-slate-950 p-5 text-white">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">
                      Bots
                    </p>
                    <h3 className="mt-1 text-lg font-semibold">{copy.bots.title}</h3>
                    <p className="mt-2 max-w-2xl break-words text-sm text-slate-300">
                      {copy.bots.description}
                    </p>
                  </div>
                  <span className="rounded-md bg-white/10 px-3 py-2 text-sm font-semibold">
                    {copy.bots.fallback}: {getLanguageLabel(botLanguage)}
                  </span>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <label className="grid gap-1 text-sm font-semibold text-slate-100">
                    {copy.language.modeLabel}
                    <select
                      className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                      onChange={(event) => {
                        const nextMode = event.target.value as BotLanguageMode;
                        setBotLanguageMode(nextMode);
                        if (nextMode === "auto") {
                          setBotLanguage(language);
                        }
                      }}
                      value={botLanguageMode}
                    >
                      <option value="auto">{copy.language.autoMode}</option>
                      <option value="fixed">{copy.language.fixedMode}</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-slate-100">
                    {copy.language.botLabel}
                    <select
                      className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                      onChange={(event) => setBotLanguage(event.target.value as LanguageCode)}
                      value={botLanguage}
                    >
                      {supportedLanguages.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.nativeName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {[copy.bots.autoRule, copy.bots.fixedRule, copy.bots.systemPrompt].map((item) => (
                    <div className="rounded-lg border border-white/10 bg-white/5 p-3" key={item}>
                      <p className="break-words text-sm text-slate-100">{item}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-100">
                      {copy.bots.activeRules}
                    </p>
                    <span className="rounded-md bg-white/10 px-2 py-1 text-xs font-semibold text-slate-200">
                      {visibleBotLanguageRules.length}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-3">
                    {visibleBotLanguageRules.length > 0 ? (
                      visibleBotLanguageRules.map((rule) => {
                        const project = projects.find((item) => item.id === rule.projectId);
                        const effectiveLanguage =
                          rule.mode === "fixed"
                            ? rule.fixedLanguage ?? rule.fallbackLanguage
                            : rule.fallbackLanguage;

                        return (
                          <div
                            className="rounded-lg border border-white/10 bg-white/5 p-3"
                            key={rule.id}
                          >
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0">
                                <p className="break-words text-sm font-semibold text-white">
                                  {rule.channel}
                                </p>
                                <p className="mt-1 break-words text-xs text-slate-300">
                                  {project?.name ?? copy.header.allProjects}
                                </p>
                              </div>
                              <span className="rounded-md bg-emerald-400/15 px-2 py-1 text-xs font-semibold text-emerald-200">
                                {rule.mode === "auto"
                                  ? copy.language.autoMode
                                  : copy.language.fixedMode}
                              </span>
                            </div>
                            <p className="mt-3 break-words text-sm text-slate-200">
                              {rule.promptRule}
                            </p>
                            <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                              <span className="rounded-md bg-slate-900 px-2 py-1 text-slate-200">
                                {copy.bots.fallback}: {getLanguageLabel(rule.fallbackLanguage)}
                              </span>
                              <span className="rounded-md bg-slate-900 px-2 py-1 text-slate-200">
                                {copy.bots.confidence}: {rule.confidence}%
                              </span>
                              <span className="rounded-md bg-slate-900 px-2 py-1 text-slate-200">
                                {copy.bots.fixedLanguage}: {getLanguageLabel(effectiveLanguage)}
                              </span>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {rule.detectionSignals.map((signal) => (
                                <span
                                  className="rounded-md bg-white/10 px-2 py-1 text-xs text-slate-300"
                                  key={signal}
                                >
                                  {signal}
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-lg border border-dashed border-white/20 bg-white/5 p-3 text-sm text-slate-300">
                        {copy.bots.noRules}
                      </div>
                    )}
                  </div>
                </div>
              </article>
            </section>

            <BotLanguageTester
              language={language}
              projects={projects}
              rules={visibleBotLanguageRules}
            />
              </>
            ) : null}

            {activeSection === "pipelines" ? (
              <DealPipelineWorkspace
                contacts={visibleContacts}
                deals={visibleDeals}
                language={language}
                organizations={visibleOrganizations}
                pipeline={visiblePipeline}
                projectLabel={projectScopeLabel}
                projects={projects}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            {["tasks", "contacts", "bots"].includes(activeSection) ? (
            <section className="grid gap-4">
              {activeSection === "tasks" ? (
                <TaskCommandCenter
                  contacts={visibleContacts}
                  language={language}
                  leads={visibleLeads}
                  projectLabel={projectScopeLabel}
                  projects={projects}
                  tasks={visibleTasks}
                />
              ) : null}

              {activeSection === "contacts" ? (
                <ContactCommandCenter
                  consents={visibleConsents}
                  contacts={visibleContacts}
                  language={language}
                  leads={visibleLeads}
                  organizations={visibleOrganizations}
                  projects={projects}
                  relationships={visibleContactRelationships}
                  tasks={visibleTasks}
                  timeline={visibleContactTimeline}
                  users={users}
                />
              ) : null}

              {activeSection === "bots" ? (
              <article className="rounded-lg border border-stone-200 bg-white p-5">
                <h3 className="text-lg font-semibold">{copy.panels.automations}</h3>
                <div className="mt-4 space-y-3">
                  {automations.map((automation) => (
                    <div className="rounded-lg border border-stone-200 p-3" key={automation.name}>
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-semibold">{automation.name}</p>
                          <p className="mt-1 break-words text-xs text-stone-500">
                            {automation.channel}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
                            statusStyles[automation.status]
                          }`}
                        >
                          {automation.status}
                        </span>
                      </div>
                      <p className="mt-3 break-words text-sm text-stone-600">
                        {automation.detail}
                      </p>
                    </div>
                  ))}
                </div>
              </article>
              ) : null}
            </section>
            ) : null}

            {activeSection === "knowledge" ? (
            <>
              <KnowledgeCommandCenter
                items={visibleKnowledgeBase}
                projectLabel={projectScopeLabel}
                projects={projects}
              />
            <section className="hidden gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <article className="rounded-lg border border-stone-200 bg-white p-5">
                <h3 className="text-lg font-semibold">{copy.panels.knowledge}</h3>
                <p className="mt-1 break-words text-sm text-stone-600">
                  {copy.panels.knowledgeDescription}
                </p>
                <div className="mt-4 space-y-3">
                  {visibleKnowledgeBase.map((item) => (
                    <div className="rounded-lg bg-stone-50 p-3" key={item.name}>
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <p className="min-w-0 break-words text-sm font-semibold">{item.name}</p>
                        <span className="shrink-0 text-sm font-semibold text-emerald-700">
                          {item.coverage}
                        </span>
                      </div>
                      <div className="mt-3 h-2 rounded-full bg-stone-200">
                        <div
                          className="h-2 rounded-full bg-emerald-700"
                          style={{ width: item.coverage }}
                        />
                      </div>
                      <p className="mt-2 break-words text-xs text-stone-500">
                        {item.items} {copy.panels.checkedEntries}
                      </p>
                    </div>
                  ))}
                  {visibleKnowledgeBase.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">
                      {copy.panels.noKnowledge}
                    </div>
                  ) : null}
                </div>
              </article>

              <article className="rounded-lg border border-stone-200 bg-slate-950 p-5 text-white">
                <h3 className="text-lg font-semibold">{copy.panels.technicalNext}</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {[
                    "Mandantenmodell für Workspaces und Rollen",
                    "Projektbezogene Leads, Deals und Tasks",
                    "Consent-Modell für Newsletter und Bot-Kanäle",
                    "Microsoft 365 OAuth und Kalender-Webhooks",
                  ].map((item) => (
                    <div className="rounded-lg border border-white/10 bg-white/5 p-3" key={item}>
                      <p className="break-words text-sm font-medium text-slate-100">{item}</p>
                    </div>
                  ))}
                </div>
              </article>
            </section>
            </>
            ) : null}

            {activeSection === "calendar" ? (
              <CalendarCommandCenter
                contacts={visibleContacts}
                events={visibleCalendarEvents}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={projects}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            {activeSection === "funnels" ? (
              <FunnelCommandCenter
                funnels={visibleFunnels}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={projects}
                steps={visibleFunnelSteps}
                users={users}
              />
            ) : null}

            {activeSection === "newsletter" ? (
              <NewsletterCommandCenter
                automations={visibleNewsletterAutomations}
                campaigns={visibleNewsletterCampaigns}
                consents={visibleConsents}
                deliverability={newsletterDeliverability}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={projects}
                segments={visibleNewsletterSegments}
                suppressions={newsletterSuppressions}
                templates={newsletterTemplates}
                users={users}
              />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
