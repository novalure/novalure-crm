"use client";

import { useMemo, useRef, useState } from "react";
import {
  CRM_LEAD_SOURCES,
  type BrokerMandate,
  type BuyerSearchProfile,
  type ConsentRecord,
  type Contact,
  type Conversation,
  type FinancingStatus,
  type Lead,
  type LeadSource,
  type LeadStatus,
  type LeadType,
  type PropertyType,
  type Project,
  type WorkspaceUser,
} from "@/lib/crm-types";
import {
  getCrmLeadTypeLabel,
  getCrmEnumLabel,
  getCrmFinancingStatusLabel,
  getCrmPropertyTypeLabel,
  getCrmSourceKey,
  getCrmSourceLabel,
  getCrmStatusLabel,
  getCrmSystemTextLabel,
  getDashboardCopy,
  getLeadInboxCommandCopy,
  getLocale,
  type LanguageCode,
} from "@/lib/i18n";

type LeadInboxProps = {
  brokerMandates?: BrokerMandate[];
  buyerSearchProfiles?: BuyerSearchProfile[];
  consents: ConsentRecord[];
  contacts: Contact[];
  conversations: Conversation[];
  leads: Lead[];
  language: LanguageCode;
  onLeadsChanged?: () => Promise<boolean | void> | boolean | void;
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
type LeadDraftRequiredField = "projectId" | "intent" | "nextAction";
type LeadDraftFieldErrors = Partial<Record<LeadDraftRequiredField, string>>;
type NoticeTone = "error" | "info" | "success";

const statusStyles: Record<LeadStatus, string> = {
  Neu: "bg-emerald-100 text-emerald-800",
  Qualifiziert: "bg-green-100 text-green-800",
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
  Inbound: "bg-cyan-50 text-cyan-800",
  Empfehlung: "bg-emerald-50 text-emerald-800",
  Website: "bg-blue-50 text-blue-800",
  LinkedIn: "bg-sky-50 text-sky-800",
  Partner: "bg-teal-50 text-teal-800",
  Event: "bg-purple-50 text-purple-800",
  Outbound: "bg-orange-50 text-orange-800",
  Formular: "bg-indigo-50 text-indigo-800",
  Manual: "bg-stone-100 text-stone-700",
};

const sourceOptions: LeadSource[] = [...CRM_LEAD_SOURCES];

function getLeadSourceStyle(source: string) {
  const sourceKey = getCrmSourceKey(source) as LeadSource;
  return sourceStyles[sourceKey] ?? sourceStyles.Manual;
}

const typeOptions: LeadType[] = ["Käufer", "Verkäufer", "Investor", "Bauträger", "Makler"];
const propertyTypeOptions: PropertyType[] = ["Wohnung", "Haus", "Neubau", "Zinshaus", "Gewerbe", "Grundstück", "Portfolio"];
const financingStatusOptions: FinancingStatus[] = ["offen", "vorqualifiziert", "Eigenmittel", "Finanzierungszusage"];
const statusOptions: LeadStatus[] = [
  "Neu",
  "Qualifiziert",
  "Qualifizieren",
  "Termin offen",
  "Übergabe",
  "Archiviert",
];

const viewStyles = {
  active: "border-slate-950 bg-slate-950 text-white",
  idle: "border-stone-300 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50",
};

function formatDateTime(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMoney(value: number | undefined, locale: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";

  return new Intl.NumberFormat(locale, {
    currency: "EUR",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

function minutesUntil(value: string) {
  return Math.round((new Date(value).getTime() - new Date().getTime()) / 60000);
}

function getPriorityRank(lead: LocalLead) {
  const slaMinutes = minutesUntil(lead.slaDueAt);
  const statusRank: Record<LeadStatus, number> = {
    Neu: 0,
    Qualifiziert: 15,
    Qualifizieren: 20,
    "Termin offen": 30,
    Übergabe: 60,
    Archiviert: 1000,
  };

  return statusRank[lead.status] + Math.max(0, 100 - lead.score) + Math.max(-80, slaMinutes / 10);
}

function toOptionalNumber(value: string) {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function splitCriteria(value: string) {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getInitialDraft(leads: Lead[], contacts: Contact[], projects: Project[]) {
  return {
    contactId: "",
    projectId: projects[0]?.id ?? "",
    source: "Manual" as LeadSource,
    type: "Käufer" as LeadType,
    score: 70,
    budget: "",
    address: "",
    areaSqm: "",
    askingPrice: "",
    budgetFrom: "",
    budgetTo: "",
    condition: "",
    financingStatus: "offen" as FinancingStatus,
    marketValue: "",
    mustCriteria: "",
    niceCriteria: "",
    objectType: "Wohnung" as PropertyType,
    purchaseTimeline: "",
    rooms: "",
    sellingReason: "",
    sellingTimeline: "",
    yearBuilt: "",
    intent: "",
    nextAction: "",
  };
}

export function LeadInbox({
  brokerMandates = [],
  buyerSearchProfiles = [],
  consents = [],
  contacts = [],
  conversations = [],
  leads = [],
  language,
  onLeadsChanged,
  projects = [],
  users = [],
}: LeadInboxProps) {
  const copy = getDashboardCopy(language).leadInbox;
  const text = getLeadInboxCommandCopy(language);
  const locale = getLocale(language);
  const [sessionLeads, setSessionLeads] = useState<LocalLead[]>([]);
  const [leadOverrides, setLeadOverrides] = useState<Record<string, Partial<LocalLead>>>({});
  const [selectedLeadId, setSelectedLeadId] = useState<string>(leads[0]?.id ?? "");
  const [activeView, setActiveView] = useState<LeadView>("queue");
  const [sortBy, setSortBy] = useState<LeadSort>("priority");
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("success");
  const [leadDraft, setLeadDraft] = useState(() => getInitialDraft(leads, contacts, projects));
  const [leadDraftErrors, setLeadDraftErrors] = useState<LeadDraftFieldErrors>({});
  const [fieldDraft, setFieldDraft] = useState({
    leadId: leads[0]?.id ?? "",
    status: leads[0]?.status ?? ("Neu" as LeadStatus),
    assignedToUserId: leads[0]?.assignedToUserId ?? "",
    nextAction: leads[0]?.nextAction ?? "",
  });
  const [noteDraft, setNoteDraft] = useState("");
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [createdTaskLeadIds, setCreatedTaskLeadIds] = useState<string[]>([]);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [leadSaving, setLeadSaving] = useState(false);
  const [formSuccess, setFormSuccess] = useState("");
  const [fieldSaving, setFieldSaving] = useState(false);
  const [fieldFeedback, setFieldFeedback] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const leadSavingRef = useRef(false);
  const projectFieldRef = useRef<HTMLSelectElement | null>(null);
  const intentFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const nextActionFieldRef = useRef<HTMLTextAreaElement | null>(null);

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
        const brokerMandate = brokerMandates.find((mandate) => mandate.sellerLeadId === lead.id);
        const buyerSearchProfile = buyerSearchProfiles.find((profile) => profile.buyerLeadId === lead.id);
        const hasContactData = Boolean(contact?.email || contact?.phone);
        const hasConsent = leadConsents.some((consent) => consent.status === "Opt-in" || consent.status === "Nur CRM");
        const hasAction = lead.nextAction.trim().length > 0;
        const hasQualification = lead.score >= 75 && lead.intent.trim().length > 0;
        const leadIntentLabel = getCrmSystemTextLabel(lead.intent, language);
        const leadNextActionLabel = getCrmSystemTextLabel(lead.nextAction, language);

        return {
          lead,
          contact,
          project,
          owner,
          consents: leadConsents,
          conversations: leadConversations,
          activities: leadActivities,
          brokerMandate,
          buyerSearchProfile,
          hasContactData,
          hasConsent,
          hasAction,
          hasQualification,
          leadIntentLabel,
          leadNextActionLabel,
          slaMinutes: minutesUntil(lead.slaDueAt),
        };
      }),
    [activities, brokerMandates, buyerSearchProfiles, consents, contacts, conversations, effectiveLeads, language, projects, users],
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
          getCrmSourceKey(item.lead.source),
          getCrmSourceLabel(item.lead.source, language),
          item.lead.type,
          item.lead.status,
          item.lead.intent,
          item.lead.nextAction,
          item.leadIntentLabel,
          item.leadNextActionLabel,
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
  }, [activeView, decoratedLeads, language, searchTerm, sortBy]);

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

  const noticeClassName =
    noticeTone === "error"
      ? "border-red-200 bg-red-50 text-red-800"
      : noticeTone === "info"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-emerald-200 bg-emerald-50 text-emerald-900";

  const showNotice = (message: string, tone: NoticeTone = "success") => {
    setNoticeTone(tone);
    setNotice(message);
  };

  const requiredFieldMessage = (label: string) =>
    language === "de" ? `${label} ist Pflicht.` : `${label} is required.`;

  const getLeadDraftErrors = () => {
    const nextErrors: LeadDraftFieldErrors = {};

    if (!leadDraft.projectId) nextErrors.projectId = requiredFieldMessage(text.project);
    if (!leadDraft.intent.trim()) nextErrors.intent = requiredFieldMessage(text.intent);
    if (!leadDraft.nextAction.trim()) nextErrors.nextAction = requiredFieldMessage(text.nextAction);

    return nextErrors;
  };

  const clearLeadDraftError = (field: LeadDraftRequiredField) => {
    setLeadDraftErrors((current) => {
      if (!current[field]) return current;
      const nextErrors = { ...current };
      delete nextErrors[field];
      return nextErrors;
    });
  };

  const focusFirstInvalidLeadField = (errors: LeadDraftFieldErrors) => {
    const target = errors.projectId
      ? projectFieldRef.current
      : errors.intent
        ? intentFieldRef.current
        : errors.nextAction
          ? nextActionFieldRef.current
          : null;

    target?.focus();
  };

  const addActivity = (leadId: string, title: string, detail: string, tone: LeadActivity["tone"]) => {
    const now = new Date();
    const activity: LeadActivity = {
      id: `activity_${leadId}_${now.getTime()}`,
      leadId,
      at: now.toISOString(),
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

  const clearPersistedLeadLocalState = (leadId: string) => {
    setLeadOverrides((current) => {
      if (!current[leadId]) return current;
      const next = { ...current };
      delete next[leadId];
      return next;
    });
    setSessionLeads((current) => current.filter((lead) => lead.id !== leadId));
  };

  const refreshPersistedLeads = async (leadId: string) => {
    const refreshed = await onLeadsChanged?.();
    if (refreshed !== false) {
      clearPersistedLeadLocalState(leadId);
    }
  };

  const persistLead = async (lead: Partial<LocalLead>) => {
    const response = await fetch("/api/crm/leads", {
      body: JSON.stringify({ lead }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(text.saveError);
    }

    const payload = await response.json() as { lead?: Lead };
    if (!payload.lead) {
      throw new Error(text.saveError);
    }
    return payload.lead;
  };

  const saveFieldDraft = async () => {
    if (!selectedLead || fieldSaving) {
      return;
    }

    const patch = {
      status: activeFieldDraft.status,
      assignedToUserId: activeFieldDraft.assignedToUserId || undefined,
      nextAction: activeFieldDraft.nextAction,
    } satisfies Partial<LocalLead>;

    try {
      setFieldSaving(true);
      setFieldFeedback(null);
      await persistLead({ ...selectedLead, ...patch });
      updateLead(selectedLead.id, patch);
      addActivity(selectedLead.id, text.changed, activeFieldDraft.nextAction, "info");
      await refreshPersistedLeads(selectedLead.id);
      showNotice(text.changed);
      setFieldFeedback({ message: text.changed, tone: "success" });
    } catch {
      showNotice(text.saveError, "error");
      setFieldFeedback({ message: text.saveError, tone: "error" });
    } finally {
      setFieldSaving(false);
    }
  };

  const acceptLead = async (leadId: string) => {
    const fallbackOwnerId = users[0]?.id;
    const lead = effectiveLeads.find((item) => item.id === leadId);
    const patch = {
      status: "Übergabe",
      assignedToUserId: lead?.assignedToUserId ?? fallbackOwnerId,
    } satisfies Partial<LocalLead>;

    try {
      await persistLead({ ...(lead ?? {}), ...patch, id: leadId });
      updateLead(leadId, patch);
      addActivity(leadId, text.accepted, text.acceptedDetail, "success");
      await refreshPersistedLeads(leadId);
      showNotice(text.accepted);
      setActionFeedback({ message: text.accepted, tone: "success" });
    } catch {
      showNotice(text.saveError, "error");
      setActionFeedback({ message: text.saveError, tone: "error" });
    }
  };

  const archiveLead = async (leadId: string) => {
    const lead = effectiveLeads.find((item) => item.id === leadId);
    const nextStatus = lead?.status === "Archiviert" ? "Qualifizieren" : "Archiviert";
    const patch = { status: nextStatus } satisfies Partial<LocalLead>;

    try {
      await persistLead({ ...(lead ?? {}), ...patch, id: leadId });
      updateLead(leadId, patch);
      addActivity(leadId, nextStatus === "Archiviert" ? text.archivedNow : text.restored, "", "warning");
      await refreshPersistedLeads(leadId);
      const message = nextStatus === "Archiviert" ? text.archivedNow : text.restored;
      showNotice(message);
      setActionFeedback({ message, tone: "success" });
    } catch {
      showNotice(text.saveError, "error");
      setActionFeedback({ message: text.saveError, tone: "error" });
    }
  };

  const createTask = async () => {
    if (!selectedLead) {
      return;
    }

    const contact = contacts.find((item) => item.id === selectedLead.contactId);
    const response = await fetch("/api/crm/recommendation-runtime", {
      body: JSON.stringify({
        actionType: selectedLead.hotStatus || selectedLead.score >= 80 ? "hot_lead_follow_up" : "lead_follow_up",
        channel: contact?.email ? "E-Mail" : contact?.phone ? "WhatsApp" : "Telefon",
        contactId: selectedLead.contactId,
        email: contact?.email ?? null,
        leadId: selectedLead.id,
        operation: "follow_up_action",
        outcome: "planned",
        phone: contact?.phone ?? null,
        projectId: selectedLead.projectId,
        purpose: "salesFollowUp",
        taskTitle: selectedLead.nextAction || selectedLead.intent,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      showNotice(text.saveError, "error");
      setActionFeedback({ message: text.saveError, tone: "error" });
      return;
    }

    setCreatedTaskLeadIds((current) =>
      current.includes(selectedLead.id) ? current : [...current, selectedLead.id],
    );
    addActivity(selectedLead.id, text.taskCreated, selectedLead.nextAction, "success");
    const payload = (await response.json().catch(() => ({}))) as { data?: { allowed?: boolean } };
    const message = payload.data?.allowed === false ? text.consentBlocked : text.taskCreated;
    showNotice(message, payload.data?.allowed === false ? "error" : "success");
    setActionFeedback({ message, tone: payload.data?.allowed === false ? "error" : "success" });
  };

  const prepareBulkFollowUp = async () => {
    const candidates = filteredLeads
      .filter((item) => item.lead.status !== "Archiviert")
      .slice(0, 25);

    if (!candidates.length) {
      showNotice(text.bulkFollowUpEmpty, "info");
      return;
    }

    setBulkSaving(true);
    try {
      const response = await fetch("/api/crm/recommendation-runtime", {
        body: JSON.stringify({
          actionType: "lead_inbox_bulk_follow_up",
          leads: candidates.map((item) => ({
            channel: item.contact?.email ? "E-Mail" : item.contact?.phone ? "WhatsApp" : "Telefon",
            contactId: item.lead.contactId,
            email: item.contact?.email ?? null,
            leadId: item.lead.id,
            ownerUserId: item.lead.assignedToUserId ?? null,
            phone: item.contact?.phone ?? null,
            projectId: item.lead.projectId,
            taskTitle: item.lead.nextAction || item.lead.intent,
          })),
          operation: "bulk_follow_up_actions",
          outcome: "planned",
          purpose: "salesFollowUp",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const payload = (await response.json().catch(() => ({}))) as {
        data?: { blockedCount?: number; failedCount?: number; succeededCount?: number };
      };
      if (!response.ok) throw new Error(text.saveError);

      const leadIds = candidates.map((item) => item.lead.id);
      setCreatedTaskLeadIds((current) => Array.from(new Set([...current, ...leadIds])));
      candidates.slice(0, 5).forEach((item) => {
        addActivity(item.lead.id, text.bulkFollowUp, item.lead.nextAction, "success");
      });
      showNotice(
        text.bulkFollowUpDone(
          payload.data?.succeededCount ?? candidates.length,
          payload.data?.blockedCount ?? 0,
          payload.data?.failedCount ?? 0,
        ),
      );
    } catch {
      showNotice(text.saveError, "error");
    } finally {
      setBulkSaving(false);
    }
  };

  const addNote = async () => {
    if (!selectedLead || !noteDraft.trim()) {
      return;
    }

    const detail = noteDraft.trim();
    try {
      const response = await fetch("/api/crm/notes", {
        body: JSON.stringify({
          note: {
            contactId: selectedLead.contactId || undefined,
            detail,
            leadId: selectedLead.id,
            projectId: selectedLead.projectId,
            title: text.noteSaved,
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) throw new Error(text.saveError);

      addActivity(selectedLead.id, text.noteSaved, detail, "info");
      setNoteDraft("");
      showNotice(text.noteSaved);
    } catch {
      showNotice(text.saveError, "error");
    }
  };

  const createLead = async (createTaskAfterSave = false) => {
    if (leadSavingRef.current) return;

    setFormError("");
    setFormSuccess("");
    setLeadDraftErrors({});

    const nextErrors = getLeadDraftErrors();
    if (Object.keys(nextErrors).length > 0) {
      setLeadDraftErrors(nextErrors);
      setFormError(text.required);
      focusFirstInvalidLeadField(nextErrors);
      return;
    }

    leadSavingRef.current = true;
    setLeadSaving(true);
    const contact = contacts.find((item) => item.id === leadDraft.contactId);
    const now = new Date();
    const nextLead: LocalLead = {
      id: `lead_local_${now.getTime()}`,
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
      receivedAt: now.toISOString(),
      slaDueAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      objectType: leadDraft.objectType,
      rooms: toOptionalNumber(leadDraft.rooms),
      areaSqm: toOptionalNumber(leadDraft.areaSqm),
      buyerProfile:
        leadDraft.type === "Käufer"
          ? {
              budgetFrom: toOptionalNumber(leadDraft.budgetFrom) ?? 0,
              budgetTo: toOptionalNumber(leadDraft.budgetTo) ?? 0,
              desiredLocation: leadDraft.address.trim() || undefined,
              financingStatus: leadDraft.financingStatus,
              mustHaveCriteria: splitCriteria(leadDraft.mustCriteria),
              niceToHaveCriteria: splitCriteria(leadDraft.niceCriteria),
              propertyType: leadDraft.objectType,
              purchaseTimeline: leadDraft.purchaseTimeline.trim() || undefined,
              useCase: "Eigennutzung",
            }
          : undefined,
      sellerProfile:
        leadDraft.type === "Verkäufer"
          ? {
              address: leadDraft.address.trim(),
              askingPrice: toOptionalNumber(leadDraft.askingPrice) ?? 0,
              brokerContractStatus: "offen",
              commissionRate: 0,
              competingBroker: false,
              marketValue: toOptionalNumber(leadDraft.marketValue) ?? 0,
              objectCondition: leadDraft.condition.trim() || undefined,
              sellingReason: leadDraft.sellingReason.trim(),
              sellingTimeline: leadDraft.sellingTimeline.trim() || undefined,
              yearBuilt: toOptionalNumber(leadDraft.yearBuilt) ?? 0,
            }
          : undefined,
      assignedToUserId: users[0]?.id,
      isLocal: true,
    };

    try {
      const persistedLead = await persistLead(nextLead);
      const savedLead: LocalLead = { ...(persistedLead ?? nextLead), isLocal: false };

      setSessionLeads((current) => [savedLead, ...current]);
      setSelectedLeadId(savedLead.id);
      setFieldDraft({
        leadId: savedLead.id,
        status: savedLead.status,
        assignedToUserId: savedLead.assignedToUserId ?? "",
        nextAction: savedLead.nextAction,
      });
      setActiveView("queue");
      setShowCreateForm(false);
      setLeadDraft(getInitialDraft(leads, contacts, projects));
      setLeadDraftErrors({});
      addActivity(savedLead.id, text.newLeadSaved, savedLead.nextAction, "success");
      showNotice(text.newLeadSaved);
      setFormSuccess(text.newLeadSaved);
      await refreshPersistedLeads(savedLead.id);
      if (createTaskAfterSave) {
        await fetch("/api/crm/recommendation-runtime", {
          body: JSON.stringify({
            actionType: savedLead.hotStatus || savedLead.score >= 80 ? "hot_lead_follow_up" : "lead_follow_up",
            channel: contact?.email ? "E-Mail" : contact?.phone ? "WhatsApp" : "Telefon",
            contactId: savedLead.contactId || null,
            email: contact?.email ?? null,
            leadId: savedLead.id,
            operation: "follow_up_action",
            outcome: "planned",
            phone: contact?.phone ?? null,
            projectId: savedLead.projectId,
            purpose: "salesFollowUp",
            taskTitle: savedLead.nextAction || savedLead.intent,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }).catch(() => undefined);
        setCreatedTaskLeadIds((current) =>
          current.includes(savedLead.id) ? current : [...current, savedLead.id],
        );
      }
    } catch {
      setFormError(text.saveError);
      setFormSuccess("");
      showNotice(text.saveError, "error");
    } finally {
      leadSavingRef.current = false;
      setLeadSaving(false);
    }
  };

  return (
    <section className="grid min-w-0 max-w-full gap-4 overflow-hidden">
      <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-4 md:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {text.moduleLabel}
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
                <p className="crm-kpi-label text-xs text-stone-500">{metric.label}</p>
              </div>
            ))}
          </div>
        </div>

        {notice ? (
          <div
            className={`mt-4 rounded-md border px-3 py-2 text-sm font-semibold ${noticeClassName}`}
            role={noticeTone === "error" ? "alert" : "status"}
          >
            {notice}
          </div>
        ) : null}
      </article>

      <section className="grid min-w-0 max-w-full gap-4 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-4">
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
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={bulkSaving || filteredLeads.length === 0}
                onClick={() => {
                  void prepareBulkFollowUp();
                }}
                type="button"
              >
                {bulkSaving ? text.saving : text.bulkFollowUp}
              </button>
              <button
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onClick={() => {
                  setFormError("");
                  setFormSuccess("");
                  setLeadDraftErrors({});
                  setActionFeedback(null);
                  setShowCreateForm((current) => !current);
                }}
                type="button"
              >
                {showCreateForm ? text.closeForm : text.createLead}
              </button>
            </div>
          </div>

          {!showCreateForm && formSuccess ? (
            <p className="mt-3 text-sm font-semibold text-emerald-700">{formSuccess}</p>
          ) : null}

          <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
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
            <div className="mt-4 min-w-0 max-w-full overflow-hidden rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <div className="grid min-w-0 gap-3 lg:grid-cols-4">
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
                    <option value="">{text.contactUnknown}</option>
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
                    aria-describedby={leadDraftErrors.projectId ? "lead-project-error" : undefined}
                    aria-invalid={Boolean(leadDraftErrors.projectId)}
                    className={`rounded-md border bg-white px-3 py-2 outline-none ${
                      leadDraftErrors.projectId ? "border-red-300 focus:border-red-600" : "border-emerald-200 focus:border-emerald-600"
                    }`}
                    onChange={(event) => {
                      clearLeadDraftError("projectId");
                      setLeadDraft((current) => ({ ...current, projectId: event.target.value }));
                    }}
                    ref={projectFieldRef}
                    value={leadDraft.projectId}
                  >
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  {leadDraftErrors.projectId ? (
                    <span className="text-xs font-semibold text-red-700" id="lead-project-error" role="alert">
                      {leadDraftErrors.projectId}
                    </span>
                  ) : null}
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
                        {getCrmSourceLabel(source, language)}
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
                        {getCrmLeadTypeLabel(type, language)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
                <label className="grid gap-1 text-sm font-semibold">
                  {text.intent}
                  <textarea
                    aria-describedby={leadDraftErrors.intent ? "lead-intent-error" : undefined}
                    aria-invalid={Boolean(leadDraftErrors.intent)}
                    className={`min-h-24 rounded-md border bg-white px-3 py-2 outline-none ${
                      leadDraftErrors.intent ? "border-red-300 focus:border-red-600" : "border-emerald-200 focus:border-emerald-600"
                    }`}
                    onChange={(event) => {
                      clearLeadDraftError("intent");
                      setLeadDraft((current) => ({ ...current, intent: event.target.value }));
                    }}
                    ref={intentFieldRef}
                    value={leadDraft.intent}
                  />
                  {leadDraftErrors.intent ? (
                    <span className="text-xs font-semibold text-red-700" id="lead-intent-error" role="alert">
                      {leadDraftErrors.intent}
                    </span>
                  ) : null}
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  {text.nextAction}
                  <textarea
                    aria-describedby={leadDraftErrors.nextAction ? "lead-next-action-error" : undefined}
                    aria-invalid={Boolean(leadDraftErrors.nextAction)}
                    className={`min-h-24 rounded-md border bg-white px-3 py-2 outline-none ${
                      leadDraftErrors.nextAction ? "border-red-300 focus:border-red-600" : "border-emerald-200 focus:border-emerald-600"
                    }`}
                    onChange={(event) => {
                      clearLeadDraftError("nextAction");
                      setLeadDraft((current) => ({ ...current, nextAction: event.target.value }));
                    }}
                    ref={nextActionFieldRef}
                    value={leadDraft.nextAction}
                  />
                  {leadDraftErrors.nextAction ? (
                    <span className="text-xs font-semibold text-red-700" id="lead-next-action-error" role="alert">
                      {leadDraftErrors.nextAction}
                    </span>
                  ) : null}
                </label>
              </div>
              {leadDraft.type === "Verkäufer" || leadDraft.type === "Käufer" ? (
                <details className="mt-3 rounded-md border border-emerald-200 bg-white p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-950">{text.advancedFieldsTitle}</summary>
                  <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <label className="grid gap-1 text-sm font-semibold">
                      {text.score}
                      <input
                        className="rounded-md border border-emerald-200 px-3 py-2"
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
                        className="rounded-md border border-emerald-200 px-3 py-2"
                        onChange={(event) => setLeadDraft((current) => ({ ...current, budget: event.target.value }))}
                        placeholder={text.budgetPlaceholder}
                        value={leadDraft.budget}
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-semibold">
                      {text.address}
                      <input
                        className="rounded-md border border-emerald-200 px-3 py-2"
                        onChange={(event) => setLeadDraft((current) => ({ ...current, address: event.target.value }))}
                        value={leadDraft.address}
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-semibold">
                      {text.type}
                      <select
                        className="rounded-md border border-emerald-200 px-3 py-2"
                        onChange={(event) => setLeadDraft((current) => ({ ...current, objectType: event.target.value as PropertyType }))}
                        value={leadDraft.objectType}
                      >
                        {propertyTypeOptions.map((propertyType) => (
                          <option key={propertyType} value={propertyType}>
                            {getCrmPropertyTypeLabel(propertyType, language)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-sm font-semibold">
                      {text.rooms}
                      <input
                        className="rounded-md border border-emerald-200 px-3 py-2"
                        onChange={(event) => setLeadDraft((current) => ({ ...current, rooms: event.target.value }))}
                        type="number"
                        value={leadDraft.rooms}
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-semibold">
                      {text.livingArea}
                      <input
                        className="rounded-md border border-emerald-200 px-3 py-2"
                        onChange={(event) => setLeadDraft((current) => ({ ...current, areaSqm: event.target.value }))}
                        type="number"
                        value={leadDraft.areaSqm}
                      />
                    </label>
                    {leadDraft.type === "Verkäufer" ? (
                      <>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.yearBuilt}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, yearBuilt: event.target.value }))}
                            type="number"
                            value={leadDraft.yearBuilt}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.askingPrice}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, askingPrice: event.target.value }))}
                            type="number"
                            value={leadDraft.askingPrice}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.marketValue}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, marketValue: event.target.value }))}
                            type="number"
                            value={leadDraft.marketValue}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.condition}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, condition: event.target.value }))}
                            value={leadDraft.condition}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.sellingTimeline}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, sellingTimeline: event.target.value }))}
                            value={leadDraft.sellingTimeline}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold xl:col-span-2">
                          {text.sellingReason}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, sellingReason: event.target.value }))}
                            value={leadDraft.sellingReason}
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.budgetFrom}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, budgetFrom: event.target.value }))}
                            type="number"
                            value={leadDraft.budgetFrom}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.budgetTo}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, budgetTo: event.target.value }))}
                            type="number"
                            value={leadDraft.budgetTo}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.financingStatus}
                          <select
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, financingStatus: event.target.value as FinancingStatus }))}
                            value={leadDraft.financingStatus}
                          >
                            {financingStatusOptions.map((status) => (
                              <option key={status} value={status}>
                                {getCrmFinancingStatusLabel(status, language)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="grid gap-1 text-sm font-semibold">
                          {text.purchaseTimeline}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, purchaseTimeline: event.target.value }))}
                            value={leadDraft.purchaseTimeline}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold md:col-span-2">
                          {text.mustCriteria}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, mustCriteria: event.target.value }))}
                            value={leadDraft.mustCriteria}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold md:col-span-2">
                          {text.niceCriteria}
                          <input
                            className="rounded-md border border-emerald-200 px-3 py-2"
                            onChange={(event) => setLeadDraft((current) => ({ ...current, niceCriteria: event.target.value }))}
                            value={leadDraft.niceCriteria}
                          />
                        </label>
                      </>
                    )}
                  </div>
                </details>
              ) : null}
              {formError ? <p className="mt-3 text-sm font-semibold text-red-700" role="alert">{formError}</p> : null}
              {formSuccess ? <p className="mt-3 text-sm font-semibold text-emerald-700" role="status">{formSuccess}</p> : null}
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <button
                  className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
                  disabled={leadSaving}
                  onClick={() => {
                    void createLead();
                  }}
                  type="button"
                >
                  {leadSaving ? text.saving : text.saveLead}
                </button>
                <button
                  className="rounded-md border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:text-stone-400"
                  disabled={leadSaving}
                  onClick={() => {
                    void createLead(true);
                  }}
                  type="button"
                >
                  {leadSaving ? text.saving : text.saveAndCreateTask}
                </button>
                <button
                  className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                  onClick={() => {
                    setShowCreateForm(false);
                    setFormError("");
                    setFormSuccess("");
                    setLeadDraftErrors({});
                    setLeadDraft(getInitialDraft(leads, contacts, projects));
                  }}
                  type="button"
                >
                  {text.cancel}
                </button>
              </div>
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
                    onClick={() => {
                      setSelectedLeadId(item.lead.id);
                      setFieldFeedback(null);
                      setActionFeedback(null);
                    }}
                    type="button"
                  >
                    <span className="flex min-w-0 items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-semibold">
                          {item.contact?.name ?? copy.unknownContact}
                        </span>
                        <span className={`mt-1 block break-words text-xs ${isSelected ? "text-slate-300" : "text-stone-500"}`}>
                          {item.project?.name ?? copy.noProject} · {getCrmLeadTypeLabel(item.lead.type, language)}
                        </span>
                      </span>
                      <span className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${isSelected ? "bg-white text-slate-950" : "bg-slate-950 text-white"}`}>
                        {item.lead.score}
                      </span>
                    </span>

                    <span className="flex flex-wrap gap-2 text-xs">
                      <span className={`rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : statusStyles[item.lead.status]}`}>
                        {getCrmStatusLabel(item.lead.status, language)}
                      </span>
                      <span className={`rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : getLeadSourceStyle(item.lead.source)}`}>
                        {getCrmSourceLabel(item.lead.source, language)}
                      </span>
                      <span className={`rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : isUrgent ? "bg-amber-100 text-amber-900" : "bg-white text-stone-700"}`}>
                        {text.sla} {formatDateTime(item.lead.slaDueAt, locale)}
                      </span>
                    </span>

                    <span className="block break-words text-sm">{item.leadIntentLabel}</span>
                    <span className={`block rounded-md px-3 py-2 text-xs ${isSelected ? "bg-white/10 text-slate-100" : "bg-white text-stone-600"}`}>
                      {copy.nextAction}: {item.leadNextActionLabel}
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
                    {selected.project?.name ?? copy.noProject} · {getCrmLeadTypeLabel(selected.lead.type, language)}
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-950 px-2 py-1 text-xs font-semibold text-white">
                  {selected.lead.score}
                </span>
              </div>

              <div className="rounded-lg bg-stone-50 p-3">
                <p className="text-sm font-semibold">{copy.aiSummary}</p>
                <p className="mt-2 break-words text-sm text-stone-600">
                  {selected.leadIntentLabel}. {copy.aiNextStep}: {selected.leadNextActionLabel}.
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

              {selected.brokerMandate || selected.buyerSearchProfile ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-sm font-semibold text-slate-950">
                    {selected.brokerMandate ? text.mandateEntityTitle : text.searchProfileEntityTitle}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-emerald-800">
                    {text.profilePersisted}
                  </p>
                  {selected.brokerMandate ? (
                    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                      <p className="rounded-md bg-white p-2">
                        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{text.address}</span>
                        <span className="break-words font-semibold">{selected.brokerMandate.address || "-"}</span>
                      </p>
                      <p className="rounded-md bg-white p-2">
                        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{text.mandateStatus}</span>
                        <span className="break-words font-semibold">{getCrmEnumLabel(selected.brokerMandate.mandateStatus, language)}</span>
                      </p>
                      <p className="rounded-md bg-white p-2">
                        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{text.marketValue}</span>
                        <span className="break-words font-semibold">{formatMoney(selected.brokerMandate.marketValue, locale)}</span>
                      </p>
                      <p className="rounded-md bg-white p-2">
                        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{text.documentsStatus}</span>
                        <span className="break-words font-semibold">{selected.brokerMandate.documentsStatus ? getCrmEnumLabel(selected.brokerMandate.documentsStatus, language) : "-"}</span>
                      </p>
                    </div>
                  ) : selected.buyerSearchProfile ? (
                    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                      <p className="rounded-md bg-white p-2">
                        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{text.budgetRange}</span>
                        <span className="break-words font-semibold">
                          {formatMoney(selected.buyerSearchProfile.budgetFrom, locale)} - {formatMoney(selected.buyerSearchProfile.budgetTo, locale)}
                        </span>
                      </p>
                      <p className="rounded-md bg-white p-2">
                        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{text.financingStatus}</span>
                        <span className="break-words font-semibold">{selected.buyerSearchProfile.financingStatus ? getCrmFinancingStatusLabel(selected.buyerSearchProfile.financingStatus, language) : "-"}</span>
                      </p>
                      <p className="rounded-md bg-white p-2">
                        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{text.address}</span>
                        <span className="break-words font-semibold">{selected.buyerSearchProfile.desiredLocation ?? "-"}</span>
                      </p>
                      <p className="rounded-md bg-white p-2">
                        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{text.matchingStatus}</span>
                        <span className="break-words font-semibold">{getCrmEnumLabel(selected.buyerSearchProfile.matchingStatus, language)}</span>
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

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
                          {getCrmStatusLabel(status, language)}
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
                    className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
                    disabled={fieldSaving}
                    onClick={() => {
                      void saveFieldDraft();
                    }}
                    type="button"
                  >
                    {fieldSaving ? text.saving : text.saveChanges}
                  </button>
                  {fieldFeedback ? (
                    <p
                      className={`text-sm font-semibold ${
                        fieldFeedback.tone === "success" ? "text-emerald-700" : "text-red-700"
                      }`}
                    >
                      {fieldFeedback.message}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3 2xl:grid-cols-1">
                <button
                  className="rounded-md bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:bg-violet-300"
                  disabled={selected.lead.status === "Übergabe"}
                  onClick={() => {
                    void acceptLead(selected.lead.id);
                  }}
                  type="button"
                >
                  {selected.lead.status === "Übergabe" ? copy.acceptedButton : text.accept}
                </button>
                <button
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                  onClick={() => {
                    void createTask();
                  }}
                  type="button"
                >
                  {createdTaskLeadIds.includes(selected.lead.id) ? text.taskCreated : text.createTask}
                </button>
                <button
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                  onClick={() => {
                    void archiveLead(selected.lead.id);
                  }}
                  type="button"
                >
                  {selected.lead.status === "Archiviert" ? text.restore : text.archive}
                </button>
                {actionFeedback ? (
                  <p
                    className={`text-sm font-semibold sm:col-span-3 2xl:col-span-1 ${
                      actionFeedback.tone === "success" ? "text-emerald-700" : "text-red-700"
                    }`}
                  >
                    {actionFeedback.message}
                  </p>
                ) : null}
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
