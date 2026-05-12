"use client";

import { useMemo, useState } from "react";
import type {
  ConsentRecord,
  Contact,
  Conversation,
  Lead,
  LeadSource,
  LeadStatus,
  LeadType,
  Project,
  WorkspaceUser,
} from "@/lib/crm-types";
import { getDashboardCopy, languageOptionsByCode, type LanguageCode } from "@/lib/i18n";

type LeadInboxProps = {
  consents: ConsentRecord[];
  contacts: Contact[];
  conversations: Conversation[];
  leads: Lead[];
  language: LanguageCode;
  projects: Project[];
  users: WorkspaceUser[];
};

type LeadView = "queue" | "hot" | "due" | "unassigned" | "handover" | "archived" | "all";
type LeadSort = "priority" | "score" | "sla" | "newest";
type LocalLead = Lead & { isLocal?: boolean };
type LeadActivity = {
  id: string;
  leadId: string;
  at: string;
  title: string;
  detail: string;
  tone: "info" | "success" | "warning";
};

const statusStyles: Record<LeadStatus, string> = {
  Neu: "bg-emerald-100 text-emerald-800",
  Qualifizieren: "bg-blue-100 text-blue-800",
  "Termin offen": "bg-amber-100 text-amber-800",
  Übergabe: "bg-violet-100 text-violet-800",
  Archiviert: "bg-slate-100 text-slate-700",
};

const sourceStyles: Record<LeadSource, string> = {
  WhatsApp: "bg-emerald-50 text-emerald-800",
  Instagram: "bg-violet-50 text-violet-800",
  "Website Funnel": "bg-blue-50 text-blue-800",
  Newsletter: "bg-amber-50 text-amber-800",
  "Microsoft 365": "bg-sky-50 text-sky-800",
  willhaben: "bg-red-50 text-red-800",
  ImmobilienScout: "bg-cyan-50 text-cyan-800",
  Empfehlung: "bg-emerald-50 text-emerald-800",
  Website: "bg-blue-50 text-blue-800",
  Manual: "bg-stone-100 text-stone-700",
};

const sourceOptions: LeadSource[] = [
  "Website Funnel",
  "Website",
  "willhaben",
  "ImmobilienScout",
  "Empfehlung",
  "WhatsApp",
  "Instagram",
  "Newsletter",
  "Microsoft 365",
  "willhaben",
  "ImmobilienScout",
  "Empfehlung",
  "Website",
  "Manual",
];

const typeOptions: LeadType[] = ["Käufer", "Verkäufer", "Investor", "Bauträger", "Makler"];
const statusOptions: LeadStatus[] = [
  "Neu",
  "Qualifizieren",
  "Termin offen",
  "Übergabe",
  "Archiviert",
];

const viewStyles = {
  active: "border-slate-950 bg-slate-950 text-white",
  idle: "border-stone-300 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50",
};

const labels = {
  de: {
    queue: "Queue",
    hot: "Hot",
    due: "SLA fällig",
    unassignedView: "Ohne Owner",
    handover: "Übergabe",
    archived: "Archiv",
    all: "Alle",
    search: "Suche",
    searchPlaceholder: "Name, Projekt, Quelle, Absicht oder nächste Aktion suchen",
    sort: "Sortierung",
    sortPriority: "Priorität",
    sortScore: "Score",
    sortSla: "SLA",
    sortNewest: "Neueste",
    createLead: "Lead erfassen",
    closeForm: "Formular schließen",
    contact: "Kontakt",
    project: "Projekt",
    source: "Quelle",
    type: "Typ",
    score: "Score",
    budget: "Budget",
    intent: "Absicht",
    nextAction: "Nächste Aktion",
    saveLead: "Lead speichern",
    required: "Kontakt, Projekt, Absicht und nächste Aktion sind Pflicht.",
    selectedLead: "Ausgewählter Lead",
    workspaceFields: "Arbeitsfelder",
    owner: "Owner",
    status: "Status",
    saveChanges: "Änderungen speichern",
    addNote: "Notiz hinzufügen",
    notePlaceholder: "Kurze Gesprächsnotiz, Einwand, Zusage oder nächster Schritt",
    createTask: "Aufgabe anlegen",
    accept: "In Pipeline übernehmen",
    archive: "Archivieren",
    restore: "Wieder öffnen",
    noResults: "Keine Leads für diese Ansicht.",
    noLead: "Kein Lead ausgewählt.",
    noContactData: "Keine Kontaktdaten",
    consentReady: "Consent geprüft",
    consentMissing: "Consent prüfen",
    activity: "Aktivität",
    originalConversation: "Original-Konversation",
    localActivity: "Lokale Aktionen",
    taskCreated: "Aufgabe wurde in dieser Sitzung angelegt",
    changed: "Lead wurde aktualisiert",
    accepted: "Pipeline-Übergabe vorbereitet",
    archivedNow: "Lead wurde archiviert",
    restored: "Lead wurde wieder geöffnet",
    noteSaved: "Notiz gespeichert",
    newLeadSaved: "Neuer Lead in der Inbox erfasst",
    unassigned: "Noch nicht zugewiesen",
    handoverChecklist: "Übergabecheck",
    qualification: "Qualifikation",
    contactData: "Kontaktdaten",
    consent: "Consent",
    action: "Aktion",
    fulfilled: "erfüllt",
    open: "offen",
    sla: "SLA",
    received: "Eingang",
  },
  en: {
    queue: "Queue",
    hot: "Hot",
    due: "SLA due",
    unassignedView: "Unassigned",
    handover: "Handover",
    archived: "Archive",
    all: "All",
    search: "Search",
    searchPlaceholder: "Search name, project, source, intent or next action",
    sort: "Sort",
    sortPriority: "Priority",
    sortScore: "Score",
    sortSla: "SLA",
    sortNewest: "Newest",
    createLead: "Capture lead",
    closeForm: "Close form",
    contact: "Contact",
    project: "Project",
    source: "Source",
    type: "Type",
    score: "Score",
    budget: "Budget",
    intent: "Intent",
    nextAction: "Next action",
    saveLead: "Save lead",
    required: "Contact, project, intent and next action are required.",
    selectedLead: "Selected lead",
    workspaceFields: "Work fields",
    owner: "Owner",
    status: "Status",
    saveChanges: "Save changes",
    addNote: "Add note",
    notePlaceholder: "Short call note, objection, promise or next step",
    createTask: "Create task",
    accept: "Move to pipeline",
    archive: "Archive",
    restore: "Reopen",
    noResults: "No leads for this view.",
    noLead: "No lead selected.",
    noContactData: "No contact data",
    consentReady: "Consent checked",
    consentMissing: "Check consent",
    activity: "Activity",
    originalConversation: "Original conversation",
    localActivity: "Local actions",
    taskCreated: "Task created in this session",
    changed: "Lead updated",
    accepted: "Pipeline handover prepared",
    archivedNow: "Lead archived",
    restored: "Lead reopened",
    noteSaved: "Note saved",
    newLeadSaved: "New lead captured in inbox",
    unassigned: "Unassigned",
    handoverChecklist: "Handover check",
    qualification: "Qualification",
    contactData: "Contact data",
    consent: "Consent",
    action: "Action",
    fulfilled: "done",
    open: "open",
    sla: "SLA",
    received: "Received",
  },
} as const;

function formatDateTime(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function minutesUntil(value: string) {
  return Math.round((new Date(value).getTime() - Date.now()) / 60000);
}

function getPriorityRank(lead: LocalLead) {
  const slaMinutes = minutesUntil(lead.slaDueAt);
  const statusRank: Record<LeadStatus, number> = {
    Neu: 0,
    Qualifizieren: 20,
    "Termin offen": 30,
    Übergabe: 60,
    Archiviert: 1000,
  };

  return statusRank[lead.status] + Math.max(0, 100 - lead.score) + Math.max(-80, slaMinutes / 10);
}

function getInitialDraft(leads: Lead[], contacts: Contact[], projects: Project[]) {
  return {
    contactId: contacts[0]?.id ?? "",
    projectId: projects[0]?.id ?? "",
    source: "Manual" as LeadSource,
    type: contacts[0]?.role ?? ("Käufer" as LeadType),
    score: 70,
    budget: "",
    intent: "",
    nextAction: "",
  };
}

export function LeadInbox({
  consents = [],
  contacts = [],
  conversations = [],
  leads = [],
  language,
  projects = [],
  users = [],
}: LeadInboxProps) {
  const copy = getDashboardCopy(language).leadInbox;
  const text = labels[language];
  const locale = languageOptionsByCode[language]?.locale ?? languageOptionsByCode.de.locale;
  const [sessionLeads, setSessionLeads] = useState<LocalLead[]>([]);
  const [leadOverrides, setLeadOverrides] = useState<Record<string, Partial<LocalLead>>>({});
  const [selectedLeadId, setSelectedLeadId] = useState<string>(leads[0]?.id ?? "");
  const [activeView, setActiveView] = useState<LeadView>("queue");
  const [sortBy, setSortBy] = useState<LeadSort>("priority");
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [leadDraft, setLeadDraft] = useState(() => getInitialDraft(leads, contacts, projects));
  const [fieldDraft, setFieldDraft] = useState({
    leadId: leads[0]?.id ?? "",
    status: leads[0]?.status ?? ("Neu" as LeadStatus),
    assignedToUserId: leads[0]?.assignedToUserId ?? "",
    nextAction: leads[0]?.nextAction ?? "",
  });
  const [noteDraft, setNoteDraft] = useState("");
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [createdTaskLeadIds, setCreatedTaskLeadIds] = useState<string[]>([]);

  const effectiveLeads = useMemo(
    () => [
      ...leads.map((lead) => ({ ...lead, ...leadOverrides[lead.id] })),
      ...sessionLeads.filter((lead) => projects.some((project) => project.id === lead.projectId)),
    ],
    [leadOverrides, leads, projects, sessionLeads],
  );

  const selectedLead = effectiveLeads.find((lead) => lead.id === selectedLeadId) ?? effectiveLeads[0];
  const activeFieldDraft = selectedLead && fieldDraft.leadId === selectedLead.id
    ? fieldDraft
    : {
        leadId: selectedLead?.id ?? "",
        status: selectedLead?.status ?? ("Neu" as LeadStatus),
        assignedToUserId: selectedLead?.assignedToUserId ?? "",
        nextAction: selectedLead?.nextAction ?? "",
      };

  const decoratedLeads = useMemo(
    () =>
      effectiveLeads.map((lead) => {
        const contact = contacts.find((item) => item.id === lead.contactId);
        const project = projects.find((item) => item.id === lead.projectId);
        const owner = users.find((item) => item.id === lead.assignedToUserId);
        const leadConsents = consents.filter((consent) => consent.contactId === lead.contactId);
        const leadConversations = conversations.filter(
          (conversation) => conversation.leadId === lead.id || conversation.contactId === lead.contactId,
        );
        const leadActivities = activities.filter((activity) => activity.leadId === lead.id);
        const hasContactData = Boolean(contact?.email || contact?.phone);
        const hasConsent = leadConsents.some((consent) => consent.status === "Opt-in" || consent.status === "Nur CRM");
        const hasAction = lead.nextAction.trim().length > 0;
        const hasQualification = lead.score >= 75 && lead.intent.trim().length > 0;

        return {
          lead,
          contact,
          project,
          owner,
          consents: leadConsents,
          conversations: leadConversations,
          activities: leadActivities,
          hasContactData,
          hasConsent,
          hasAction,
          hasQualification,
          slaMinutes: minutesUntil(lead.slaDueAt),
        };
      }),
    [activities, consents, contacts, conversations, effectiveLeads, projects, users],
  );

  const filteredLeads = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase();

    return decoratedLeads
      .filter((item) => {
        const matchesView =
          activeView === "all" ||
          (activeView === "queue" && item.lead.status !== "Archiviert" && item.lead.status !== "Übergabe") ||
          (activeView === "hot" && item.lead.score >= 85 && item.lead.status !== "Archiviert") ||
          (activeView === "due" && item.slaMinutes <= 120 && item.lead.status !== "Archiviert") ||
          (activeView === "unassigned" && !item.lead.assignedToUserId && item.lead.status !== "Archiviert") ||
          (activeView === "handover" && item.lead.status === "Übergabe") ||
          (activeView === "archived" && item.lead.status === "Archiviert");

        const searchable = [
          item.contact?.name,
          item.contact?.email,
          item.contact?.phone,
          item.project?.name,
          item.lead.source,
          item.lead.type,
          item.lead.status,
          item.lead.intent,
          item.lead.nextAction,
          item.owner?.name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return matchesView && (!normalizedQuery || searchable.includes(normalizedQuery));
      })
      .sort((a, b) => {
        if (sortBy === "score") {
          return b.lead.score - a.lead.score;
        }
        if (sortBy === "sla") {
          return new Date(a.lead.slaDueAt).getTime() - new Date(b.lead.slaDueAt).getTime();
        }
        if (sortBy === "newest") {
          return new Date(b.lead.receivedAt).getTime() - new Date(a.lead.receivedAt).getTime();
        }
        return getPriorityRank(a.lead) - getPriorityRank(b.lead);
      });
  }, [activeView, decoratedLeads, searchTerm, sortBy]);

  const selected = decoratedLeads.find((item) => item.lead.id === selectedLead?.id);
  const openLeadCount = decoratedLeads.filter((item) => item.lead.status !== "Archiviert").length;
  const hotLeadCount = decoratedLeads.filter((item) => item.lead.score >= 85 && item.lead.status !== "Archiviert").length;
  const dueLeadCount = decoratedLeads.filter((item) => item.slaMinutes <= 120 && item.lead.status !== "Archiviert").length;
  const handoverCount = decoratedLeads.filter((item) => item.lead.status === "Übergabe").length;
  const views: Array<{ id: LeadView; label: string; count: number }> = [
    { id: "queue", label: text.queue, count: decoratedLeads.filter((item) => item.lead.status !== "Archiviert" && item.lead.status !== "Übergabe").length },
    { id: "hot", label: text.hot, count: hotLeadCount },
    { id: "due", label: text.due, count: dueLeadCount },
    { id: "unassigned", label: text.unassignedView, count: decoratedLeads.filter((item) => !item.lead.assignedToUserId && item.lead.status !== "Archiviert").length },
    { id: "handover", label: text.handover, count: handoverCount },
    { id: "archived", label: text.archived, count: decoratedLeads.filter((item) => item.lead.status === "Archiviert").length },
    { id: "all", label: text.all, count: decoratedLeads.length },
  ];

  const addActivity = (leadId: string, title: string, detail: string, tone: LeadActivity["tone"]) => {
    const activity: LeadActivity = {
      id: `activity_${leadId}_${Date.now()}`,
      leadId,
      at: new Date().toISOString(),
      title,
      detail,
      tone,
    };
    setActivities((current) => [activity, ...current]);
  };

  const updateLead = (leadId: string, patch: Partial<LocalLead>) => {
    const isSessionLead = sessionLeads.some((lead) => lead.id === leadId);

    if (isSessionLead) {
      setSessionLeads((current) =>
        current.map((lead) => (lead.id === leadId ? { ...lead, ...patch } : lead)),
      );
      return;
    }

    setLeadOverrides((current) => ({
      ...current,
      [leadId]: {
        ...current[leadId],
        ...patch,
      },
    }));
  };

  const saveFieldDraft = () => {
    if (!selectedLead) {
      return;
    }

    updateLead(selectedLead.id, {
      status: activeFieldDraft.status,
      assignedToUserId: activeFieldDraft.assignedToUserId || undefined,
      nextAction: activeFieldDraft.nextAction,
    });
    addActivity(selectedLead.id, text.changed, activeFieldDraft.nextAction, "info");
    setNotice(text.changed);
  };

  const acceptLead = (leadId: string) => {
    const fallbackOwnerId = users[0]?.id;
    updateLead(leadId, {
      status: "Übergabe",
      assignedToUserId: effectiveLeads.find((lead) => lead.id === leadId)?.assignedToUserId ?? fallbackOwnerId,
    });
    addActivity(leadId, text.accepted, "Status, Owner und nächste Aktion sind für die Pipeline vorbereitet.", "success");
    setNotice(text.accepted);
  };

  const archiveLead = (leadId: string) => {
    const lead = effectiveLeads.find((item) => item.id === leadId);
    const nextStatus = lead?.status === "Archiviert" ? "Qualifizieren" : "Archiviert";
    updateLead(leadId, { status: nextStatus });
    addActivity(leadId, nextStatus === "Archiviert" ? text.archivedNow : text.restored, "", "warning");
    setNotice(nextStatus === "Archiviert" ? text.archivedNow : text.restored);
  };

  const createTask = () => {
    if (!selectedLead) {
      return;
    }

    setCreatedTaskLeadIds((current) =>
      current.includes(selectedLead.id) ? current : [...current, selectedLead.id],
    );
    addActivity(selectedLead.id, text.taskCreated, selectedLead.nextAction, "success");
    setNotice(text.taskCreated);
  };

  const addNote = () => {
    if (!selectedLead || !noteDraft.trim()) {
      return;
    }

    addActivity(selectedLead.id, text.noteSaved, noteDraft.trim(), "info");
    setNoteDraft("");
    setNotice(text.noteSaved);
  };

  const createLead = () => {
    setFormError("");

    if (!leadDraft.contactId || !leadDraft.projectId || !leadDraft.intent.trim() || !leadDraft.nextAction.trim()) {
      setFormError(text.required);
      return;
    }

    const contact = contacts.find((item) => item.id === leadDraft.contactId);
    const nextLead: LocalLead = {
      id: `lead_local_${Date.now()}`,
      workspaceId: contact?.workspaceId ?? users[0]?.workspaceId ?? "ws_novalure",
      projectId: leadDraft.projectId,
      contactId: leadDraft.contactId,
      source: leadDraft.source,
      type: leadDraft.type,
      status: "Neu",
      score: Math.min(100, Math.max(0, Number(leadDraft.score) || 0)),
      budget: leadDraft.budget.trim() || undefined,
      intent: leadDraft.intent.trim(),
      nextAction: leadDraft.nextAction.trim(),
      receivedAt: new Date().toISOString(),
      slaDueAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      assignedToUserId: users[0]?.id,
      isLocal: true,
    };

    setSessionLeads((current) => [nextLead, ...current]);
    setSelectedLeadId(nextLead.id);
    setFieldDraft({
      leadId: nextLead.id,
      status: nextLead.status,
      assignedToUserId: nextLead.assignedToUserId ?? "",
      nextAction: nextLead.nextAction,
    });
    setActiveView("queue");
    setShowCreateForm(false);
    setLeadDraft(getInitialDraft(leads, contacts, projects));
    addActivity(nextLead.id, text.newLeadSaved, nextLead.nextAction, "success");
    setNotice(text.newLeadSaved);
  };

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-4 md:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Lead Inbox
            </p>
            <h3 className="mt-1 text-xl font-semibold">{copy.title}</h3>
            <p className="mt-1 max-w-3xl break-words text-sm text-stone-600">
              {copy.description}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            {[
              { label: copy.open, value: openLeadCount },
              { label: copy.hot, value: hotLeadCount },
              { label: text.due, value: dueLeadCount },
              { label: copy.accepted, value: handoverCount },
            ].map((metric) => (
              <div className="rounded-md bg-stone-50 px-3 py-2" key={metric.label}>
                <p className="font-semibold">{metric.value}</p>
                <p className="break-words text-xs text-stone-500">{metric.label}</p>
              </div>
            ))}
          </div>
        </div>

        {notice ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
            {notice}
          </div>
        ) : null}
      </article>

      <section className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <article className="rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div className="flex flex-wrap gap-2">
              {views.map((view) => (
                <button
                  className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                    activeView === view.id ? viewStyles.active : viewStyles.idle
                  }`}
                  key={view.id}
                  onClick={() => setActiveView(view.id)}
                  type="button"
                >
                  {view.label} · {view.count}
                </button>
              ))}
            </div>
            <button
              className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={() => setShowCreateForm((current) => !current)}
              type="button"
            >
              {showCreateForm ? text.closeForm : text.createLead}
            </button>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_220px]">
            <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.search}
              <input
                className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={text.searchPlaceholder}
                type="search"
                value={searchTerm}
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.sort}
              <select
                className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) => setSortBy(event.target.value as LeadSort)}
                value={sortBy}
              >
                <option value="priority">{text.sortPriority}</option>
                <option value="score">{text.sortScore}</option>
                <option value="sla">{text.sortSla}</option>
                <option value="newest">{text.sortNewest}</option>
              </select>
            </label>
          </div>

          {showCreateForm ? (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <div className="grid gap-3 lg:grid-cols-3">
                <label className="grid gap-1 text-sm font-semibold">
                  {text.contact}
                  <select
                    className="rounded-md border border-emerald-200 bg-white px-3 py-2"
                    onChange={(event) => {
                      const contact = contacts.find((item) => item.id === event.target.value);
                      setLeadDraft((current) => ({
                        ...current,
                        contactId: event.target.value,
                        type: contact?.role ?? current.type,
                        projectId: contact?.projectId ?? current.projectId,
                      }));
                    }}
                    value={leadDraft.contactId}
                  >
                    {contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  {text.project}
                  <select
                    className="rounded-md border border-emerald-200 bg-white px-3 py-2"
                    onChange={(event) => setLeadDraft((current) => ({ ...current, projectId: event.target.value }))}
                    value={leadDraft.projectId}
                  >
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  {text.source}
                  <select
                    className="rounded-md border border-emerald-200 bg-white px-3 py-2"
                    onChange={(event) => setLeadDraft((current) => ({ ...current, source: event.target.value as LeadSource }))}
                    value={leadDraft.source}
                  >
                    {sourceOptions.map((source) => (
                      <option key={source} value={source}>
                        {source}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  {text.type}
                  <select
                    className="rounded-md border border-emerald-200 bg-white px-3 py-2"
                    onChange={(event) => setLeadDraft((current) => ({ ...current, type: event.target.value as LeadType }))}
                    value={leadDraft.type}
                  >
                    {typeOptions.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  {text.score}
                  <input
                    className="rounded-md border border-emerald-200 bg-white px-3 py-2"
                    max={100}
                    min={0}
                    onChange={(event) => setLeadDraft((current) => ({ ...current, score: Number(event.target.value) }))}
                    type="number"
                    value={leadDraft.score}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  {text.budget}
                  <input
                    className="rounded-md border border-emerald-200 bg-white px-3 py-2"
                    onChange={(event) => setLeadDraft((current) => ({ ...current, budget: event.target.value }))}
                    placeholder="bis 520.000 Euro"
                    value={leadDraft.budget}
                  />
                </label>
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <label className="grid gap-1 text-sm font-semibold">
                  {text.intent}
                  <textarea
                    className="min-h-24 rounded-md border border-emerald-200 bg-white px-3 py-2"
                    onChange={(event) => setLeadDraft((current) => ({ ...current, intent: event.target.value }))}
                    value={leadDraft.intent}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  {text.nextAction}
                  <textarea
                    className="min-h-24 rounded-md border border-emerald-200 bg-white px-3 py-2"
                    onChange={(event) => setLeadDraft((current) => ({ ...current, nextAction: event.target.value }))}
                    value={leadDraft.nextAction}
                  />
                </label>
              </div>
              {formError ? <p className="mt-3 text-sm font-semibold text-red-700">{formError}</p> : null}
              <button
                className="mt-4 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
                onClick={createLead}
                type="button"
              >
                {text.saveLead}
              </button>
            </div>
          ) : null}

          <div className="mt-5 grid gap-3 xl:grid-cols-2">
            {filteredLeads.length > 0 ? (
              filteredLeads.map((item) => {
                const isSelected = selectedLead?.id === item.lead.id;
                const isUrgent = item.slaMinutes <= 120 && item.lead.status !== "Archiviert";

                return (
                  <button
                    aria-pressed={isSelected}
                    className={`grid gap-3 rounded-lg border p-4 text-left transition ${
                      isSelected
                        ? "border-slate-950 bg-slate-950 text-white"
                        : isUrgent
                          ? "border-amber-200 bg-amber-50 text-slate-950 hover:border-amber-300"
                          : item.lead.score >= 90
                            ? "border-emerald-200 bg-emerald-50 text-slate-950 hover:border-emerald-300"
                            : "border-stone-200 bg-stone-50 text-slate-950 hover:border-emerald-200 hover:bg-emerald-50"
                    }`}
                    key={item.lead.id}
                    onClick={() => setSelectedLeadId(item.lead.id)}
                    type="button"
                  >
                    <span className="flex min-w-0 items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-semibold">
                          {item.contact?.name ?? copy.unknownContact}
                        </span>
                        <span className={`mt-1 block break-words text-xs ${isSelected ? "text-slate-300" : "text-stone-500"}`}>
                          {item.project?.name ?? copy.noProject} · {item.lead.type}
                        </span>
                      </span>
                      <span className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${isSelected ? "bg-white text-slate-950" : "bg-slate-950 text-white"}`}>
                        {item.lead.score}
                      </span>
                    </span>

                    <span className="flex flex-wrap gap-2 text-xs">
                      <span className={`rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : statusStyles[item.lead.status]}`}>
                        {item.lead.status}
                      </span>
                      <span className={`rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : sourceStyles[item.lead.source]}`}>
                        {item.lead.source}
                      </span>
                      <span className={`rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : isUrgent ? "bg-amber-100 text-amber-900" : "bg-white text-stone-700"}`}>
                        {text.sla} {formatDateTime(item.lead.slaDueAt, locale)}
                      </span>
                    </span>

                    <span className="block break-words text-sm">{item.lead.intent}</span>
                    <span className={`block rounded-md px-3 py-2 text-xs ${isSelected ? "bg-white/10 text-slate-100" : "bg-white text-stone-600"}`}>
                      {copy.nextAction}: {item.lead.nextAction}
                    </span>
                    <span className={`block break-words text-xs ${isSelected ? "text-slate-300" : "text-stone-500"}`}>
                      {copy.owner}: {item.owner?.name ?? copy.unassigned}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-6 text-sm text-stone-600 xl:col-span-2">
                {text.noResults}
              </div>
            )}
          </div>
        </article>

        <aside className="rounded-lg border border-stone-200 bg-white p-4">
          {selected ? (
            <div className="grid gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                    {text.selectedLead}
                  </p>
                  <h4 className="mt-1 break-words text-xl font-semibold">
                    {selected.contact?.name ?? copy.unknownContact}
                  </h4>
                  <p className="mt-1 break-words text-sm text-stone-600">
                    {selected.project?.name ?? copy.noProject} · {selected.lead.type}
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-950 px-2 py-1 text-xs font-semibold text-white">
                  {selected.lead.score}
                </span>
              </div>

              <div className="rounded-lg bg-stone-50 p-3">
                <p className="text-sm font-semibold">{copy.aiSummary}</p>
                <p className="mt-2 break-words text-sm text-stone-600">
                  {selected.lead.intent}. {copy.aiNextStep}: {selected.lead.nextAction}.
                  {selected.lead.budget ? ` ${copy.budget}: ${selected.lead.budget}.` : ""}
                </p>
              </div>

              <div className="grid gap-2 text-sm sm:grid-cols-2 2xl:grid-cols-1">
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.contactData}
                  </p>
                  <p className="mt-1 break-words font-semibold">
                    {selected.contact?.email ?? selected.contact?.phone ?? text.noContactData}
                  </p>
                </div>
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.received}
                  </p>
                  <p className="mt-1 break-words font-semibold">
                    {formatDateTime(selected.lead.receivedAt, locale)}
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-stone-200 p-3">
                <p className="text-sm font-semibold">{text.workspaceFields}</p>
                <div className="mt-3 grid gap-3">
                  <label className="grid gap-1 text-sm font-semibold">
                    {text.status}
                    <select
                      className="rounded-md border border-stone-300 bg-white px-3 py-2"
                      onChange={(event) => setFieldDraft({ ...activeFieldDraft, status: event.target.value as LeadStatus })}
                      value={activeFieldDraft.status}
                    >
                      {statusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold">
                    {text.owner}
                    <select
                      className="rounded-md border border-stone-300 bg-white px-3 py-2"
                      onChange={(event) => setFieldDraft({ ...activeFieldDraft, assignedToUserId: event.target.value })}
                      value={activeFieldDraft.assignedToUserId}
                    >
                      <option value="">{text.unassigned}</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold">
                    {text.nextAction}
                    <textarea
                      className="min-h-20 rounded-md border border-stone-300 bg-white px-3 py-2"
                      onChange={(event) => setFieldDraft({ ...activeFieldDraft, nextAction: event.target.value })}
                      value={activeFieldDraft.nextAction}
                    />
                  </label>
                  <button
                    className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
                    onClick={saveFieldDraft}
                    type="button"
                  >
                    {text.saveChanges}
                  </button>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3 2xl:grid-cols-1">
                <button
                  className="rounded-md bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:bg-violet-300"
                  disabled={selected.lead.status === "Übergabe"}
                  onClick={() => acceptLead(selected.lead.id)}
                  type="button"
                >
                  {selected.lead.status === "Übergabe" ? copy.acceptedButton : text.accept}
                </button>
                <button
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                  onClick={createTask}
                  type="button"
                >
                  {createdTaskLeadIds.includes(selected.lead.id) ? text.taskCreated : text.createTask}
                </button>
                <button
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                  onClick={() => archiveLead(selected.lead.id)}
                  type="button"
                >
                  {selected.lead.status === "Archiviert" ? text.restore : text.archive}
                </button>
              </div>

              <div className="rounded-lg border border-stone-200 p-3">
                <p className="text-sm font-semibold">{text.addNote}</p>
                <textarea
                  className="mt-2 min-h-20 w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder={text.notePlaceholder}
                  value={noteDraft}
                />
                <button
                  className="mt-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:bg-stone-300"
                  disabled={!noteDraft.trim()}
                  onClick={addNote}
                  type="button"
                >
                  {text.addNote}
                </button>
              </div>

              <div className="rounded-lg bg-slate-950 p-4 text-white">
                <p className="text-sm font-semibold">{text.handoverChecklist}</p>
                <div className="mt-3 grid gap-2 text-xs">
                  {[
                    [text.qualification, selected.hasQualification],
                    [text.contactData, selected.hasContactData],
                    [text.consent, selected.hasConsent],
                    [text.action, selected.hasAction],
                  ].map(([label, done]) => (
                    <div className="flex items-center justify-between gap-3 rounded-md bg-white/10 px-2 py-1" key={String(label)}>
                      <span>{label}</span>
                      <span className={done ? "font-semibold text-emerald-200" : "font-semibold text-amber-200"}>
                        {done ? text.fulfilled : text.open}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold">{copy.timeline}</p>
                <div className="mt-2 space-y-2">
                  {selected.activities.map((activity) => (
                    <div
                      className={`rounded-md border p-3 ${
                        activity.tone === "success"
                          ? "border-emerald-200 bg-emerald-50"
                          : activity.tone === "warning"
                            ? "border-amber-200 bg-amber-50"
                            : "border-stone-200 bg-stone-50"
                      }`}
                      key={activity.id}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-900">{activity.title}</p>
                        <span className="shrink-0 text-xs text-stone-500">
                          {formatDateTime(activity.at, locale)}
                        </span>
                      </div>
                      {activity.detail ? (
                        <p className="mt-2 break-words text-sm text-stone-600">{activity.detail}</p>
                      ) : null}
                    </div>
                  ))}
                  {selected.conversations.map((conversation) => (
                    <div className="rounded-md bg-stone-50 p-3" key={conversation.id}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-900">{conversation.channel}</p>
                        <span className="rounded-md bg-white px-2 py-1 text-xs text-stone-600">
                          {conversation.sentiment}
                        </span>
                      </div>
                      <p className="mt-2 break-words text-sm text-stone-600">
                        {conversation.summary}
                      </p>
                      <p className="mt-2 text-xs text-stone-400">
                        {formatDateTime(conversation.lastMessageAt, locale)}
                      </p>
                    </div>
                  ))}
                  {selected.activities.length === 0 && selected.conversations.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">
                      {text.noLead}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-500">
              {text.noLead}
            </div>
          )}
        </aside>
      </section>
    </section>
  );
}
