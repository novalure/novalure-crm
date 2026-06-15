"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CRM_LEAD_SOURCES,
  type ConsentRecord,
  type Contact,
  type ContactRelationship,
  type ContactTimelineItem,
  type Lead,
  type LeadStatus,
  type LeadType,
  type Organization,
  type Project,
  type Task,
  type WorkspaceUser,
} from "@/lib/crm-types";
import {
  getContactCommandCenterCopy,
  getCrmConsentChannelLabel,
  getCrmConsentStatusLabel,
  getCrmLeadTypeLabel,
  getCrmLifecycleLabel,
  getCrmOrganizationTypeLabel,
  getCrmRelationshipInfluenceLabel,
  getCrmRelationshipRoleLabel,
  getCrmSourceKey,
  getCrmSourceLabel,
  getCrmTaskDueLabel,
  getCrmTaskPriorityLabel,
  type LanguageCode,
} from "@/lib/i18n";

type ContactCommandCenterProps = {
  canAssignOwner?: boolean;
  canWriteContacts?: boolean;
  consents: ConsentRecord[];
  contacts: Contact[];
  currentUserId?: string;
  language: LanguageCode;
  leads: Lead[];
  onContactsChanged?: () => Promise<void> | void;
  organizations: Organization[];
  projects: Project[];
  relationships: ContactRelationship[];
  showTechnicalFields?: boolean;
  tasks: Task[];
  timeline: ContactTimelineItem[];
  users: WorkspaceUser[];
};

type ContactView = "all" | "hot" | "missingData" | "missingConsent" | "duplicates";
type ContactDetailTab =
  | "overview"
  | "person"
  | "contactRoutes"
  | "address"
  | "company"
  | "realEstate"
  | "crm"
  | "consent"
  | "relationships"
  | "timeline"
  | "admin";
type ContactEditableField =
  | "name"
  | "role"
  | "project"
  | "source"
  | "intent"
  | "consent"
  | "email"
  | "phone"
  | "organizationId"
  | "ownerUserId";
type ContactKind = "person" | "company" | "companyContact";

const LEGACY_CONTACT_STORAGE_KEY = "novalure-contact-records-v1";

const defaultRoleOptions: Contact["role"][] = ["Käufer", "Verkäufer", "Investor", "Bauträger", "Makler"];
const defaultSourceOptions: Contact["source"][] = [...CRM_LEAD_SOURCES];
const crmLeadSourceSet = new Set<string>(CRM_LEAD_SOURCES);

function isCrmLeadSource(value: string): value is Contact["source"] {
  return crmLeadSourceSet.has(value);
}

function getContactSourceOptionValue(source: string): Contact["source"] {
  const sourceKey = getCrmSourceKey(source);
  return isCrmLeadSource(sourceKey) ? sourceKey : "Manual";
}

type ContactFeedback = {
  message: string;
  tone: "error" | "success";
};

type ContactPostCreateAction = "lead" | "task" | null;

type ContactTaskDraft = {
  description: string;
  due: string;
  priority: Task["priority"];
  title: string;
};

type ContactLeadDraft = {
  intent: string;
  nextAction: string;
  score: string;
  status: LeadStatus;
  type: LeadType;
};

const leadTypeOptions: LeadType[] = ["Käufer", "Verkäufer", "Investor", "Bauträger", "Makler"];
const leadStatusOptions: LeadStatus[] = ["Neu", "Qualifizieren", "Termin offen", "Übergabe", "Archiviert"];

function toDateTimeLocalInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function createContactTaskDraft(contact: Contact): ContactTaskDraft {
  const due = new Date();
  due.setDate(due.getDate() + 1);
  due.setHours(9, 0, 0, 0);

  return {
    description: contact.intent,
    due: toDateTimeLocalInput(due),
    priority: "Normal",
    title: `${contact.name}: Follow-up`,
  };
}

function createContactLeadDraft(contact: Contact): ContactLeadDraft {
  return {
    intent: contact.intent || contact.name,
    nextAction: "Kontakt qualifizieren",
    score: "50",
    status: "Neu",
    type: leadTypeOptions.includes(contact.role) ? contact.role : "Käufer",
  };
}

function createContactDraft(input: {
  contacts: Contact[];
  currentUserId?: string;
  organizations: Organization[];
  projects: Project[];
}): Contact {
  const project = input.projects[0];

  return {
    consent: "Nur CRM",
    email: "",
    id: "",
    intent: "",
    name: "",
    organizationId: undefined,
    ownerUserId: input.currentUserId || input.contacts[0]?.ownerUserId,
    phone: "",
    project: project?.name ?? "",
    projectId: project?.id ?? "",
    role: input.contacts[0]?.role ?? "Käufer",
    source: "Manual",
    workspaceId: input.contacts[0]?.workspaceId ?? project?.workspaceId ?? "",
  };
}

const lifecycleStyles = {
  Lead: "bg-blue-50 text-blue-800",
  Opportunity: "bg-emerald-50 text-emerald-800",
  Kunde: "bg-violet-50 text-violet-800",
  Partner: "bg-amber-50 text-amber-800",
} as const;

const outcomeStyles = {
  offen: "bg-blue-50 text-blue-800",
  erledigt: "bg-emerald-50 text-emerald-800",
  risiko: "bg-red-50 text-red-800",
  info: "bg-stone-100 text-stone-700",
} as const;

const qualityStyles = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  missing: "border-red-200 bg-red-50 text-red-900",
} as const;

export function ContactCommandCenter({
  canAssignOwner = false,
  canWriteContacts = true,
  consents,
  contacts,
  currentUserId,
  language,
  leads,
  onContactsChanged,
  organizations,
  projects,
  relationships,
  showTechnicalFields = false,
  tasks,
  timeline,
  users,
}: ContactCommandCenterProps) {
  const copy = getContactCommandCenterCopy(language);
  const [serverContactOverlays, setServerContactOverlays] = useState<Contact[]>([]);
  const [contactPatches, setContactPatches] = useState<Record<string, Partial<Contact>>>({});
  const [archivedContactIds, setArchivedContactIds] = useState<Set<string>>(() => new Set());
  const contactRecords = useMemo(() => {
    const activeContacts = contacts.filter((contact) => !archivedContactIds.has(contact.id));
    const activeOverlays = serverContactOverlays.filter((contact) => !archivedContactIds.has(contact.id));
    const overlayById = new Map(activeOverlays.map((contact) => [contact.id, contact]));
    const contactIds = new Set(activeContacts.map((contact) => contact.id));
    const mergedContacts = [
      ...activeOverlays.filter((contact) => !contactIds.has(contact.id)),
      ...activeContacts.map((contact) => overlayById.get(contact.id) ?? contact),
    ];

    return mergedContacts.map((contact) => ({
      ...contact,
      ...(contactPatches[contact.id] ?? {}),
    }));
  }, [archivedContactIds, contactPatches, contacts, serverContactOverlays]);
  const [selectedContactId, setSelectedContactId] = useState(contacts[0]?.id ?? "");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeView, setActiveView] = useState<ContactView>("all");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [archiveConfirmContactId, setArchiveConfirmContactId] = useState("");
  const [feedback, setFeedback] = useState<ContactFeedback | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<ContactDetailTab>("overview");
  const [newContactKind, setNewContactKind] = useState<ContactKind>("person");
  const [newContact, setNewContact] = useState<Contact>(() =>
    createContactDraft({ contacts, currentUserId, organizations, projects }),
  );
  const [postCreateAction, setPostCreateAction] = useState<ContactPostCreateAction>(null);
  const [postCreateContact, setPostCreateContact] = useState<Contact | null>(null);
  const [postCreateTaskDraft, setPostCreateTaskDraft] = useState<ContactTaskDraft | null>(null);
  const [postCreateLeadDraft, setPostCreateLeadDraft] = useState<ContactLeadDraft | null>(null);
  const [postCreateSaving, setPostCreateSaving] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.removeItem(LEGACY_CONTACT_STORAGE_KEY);
    } catch {
      // Ignore browser storage restrictions; contacts are loaded from server props.
    }
  }, []);

  const effectiveSelectedContactId = contactRecords.some((contact) => contact.id === selectedContactId)
    ? selectedContactId
    : contactRecords[0]?.id ?? "";
  const hasSelectedContact = contactRecords.length > 0;
  const selectedContact =
    contactRecords.find((contact) => contact.id === effectiveSelectedContactId) ??
    contactRecords[0] ??
    createContactDraft({ contacts: contactRecords, currentUserId, organizations, projects });
  const selectedOrganization = selectedContact?.organizationId
    ? organizations.find((organization) => organization.id === selectedContact.organizationId)
    : undefined;
  const selectedProject = selectedContact
    ? projects.find((project) => project.id === selectedContact.projectId)
    : undefined;
  const selectedLead = selectedContact
    ? leads.find((lead) => lead.contactId === selectedContact.id)
    : undefined;
  const selectedRelationships = selectedContact
    ? relationships.filter((relationship) => relationship.contactId === selectedContact.id)
    : [];
  const selectedConsents = selectedContact
    ? consents.filter((consent) => consent.contactId === selectedContact.id)
    : [];
  const selectedTasks = selectedContact
    ? tasks.filter((task) => task.contactId === selectedContact.id)
    : [];
  const selectedTimeline = selectedContact
    ? timeline
        .filter((item) => item.contactId === selectedContact.id)
        .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    : [];
  const contactOwner = selectedContact?.ownerUserId
    ? users.find((user) => user.id === selectedContact.ownerUserId)
    : selectedOrganization?.ownerUserId
      ? users.find((user) => user.id === selectedOrganization.ownerUserId)
    : undefined;
  const primaryRelationships = relationships.filter((relationship) => relationship.isPrimary);
  const duplicateSignals = useMemo(
    () =>
      contactRecords.filter((contact, index) =>
        contactRecords.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            ((contact.email && contact.email === other.email) ||
              (contact.phone && contact.phone === other.phone)),
        ),
      ),
    [contactRecords],
  );
  const selectedDuplicateSignals = selectedContact
    ? contactRecords.filter(
        (contact) =>
          contact.id !== selectedContact.id &&
          ((selectedContact.email && contact.email === selectedContact.email) ||
            (selectedContact.phone && contact.phone === selectedContact.phone)),
      )
    : [];
  const consentContactIds = useMemo(
    () => new Set(consents.map((consent) => consent.contactId)),
    [consents],
  );
  const filteredContacts = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase();

    return contactRecords.filter((contact) => {
      const organization = contact.organizationId
        ? organizations.find((item) => item.id === contact.organizationId)
        : undefined;
      const lead = leads.find((item) => item.contactId === contact.id);
      const hasDuplicate = duplicateSignals.some((item) => item.id === contact.id);
      const hasContactData = Boolean(contact.email || contact.phone);
      const matchesView =
        activeView === "all" ||
        (activeView === "hot" && Boolean(lead && lead.score >= 85)) ||
        (activeView === "missingData" && !hasContactData) ||
        (activeView === "missingConsent" && !consentContactIds.has(contact.id)) ||
        (activeView === "duplicates" && hasDuplicate);
      const searchable = [
        contact.name,
        contact.email,
        contact.phone,
        contact.role,
        contact.source,
        contact.intent,
        organization?.name,
        organization?.city,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return matchesView && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [activeView, consentContactIds, contactRecords, duplicateSignals, leads, organizations, searchTerm]);
  const dataModelMapping = [
    {
      label: copy.mapping.name,
      novalure: selectedContact.name,
      targetField: "first_name, last_name",
      ready: Boolean(selectedContact.name),
    },
    {
      label: copy.mapping.email,
      novalure: selectedContact.email,
      targetField: "email",
      ready: Boolean(selectedContact.email),
    },
    {
      label: copy.mapping.phone,
      novalure: selectedContact.phone,
      targetField: "phone / mobile_phone",
      ready: Boolean(selectedContact.phone),
    },
    {
      label: copy.mapping.organization,
      novalure: selectedOrganization?.name,
      targetField: "linked_organization",
      ready: Boolean(selectedOrganization),
    },
    {
      label: copy.mapping.lifecycle,
      novalure: selectedOrganization?.lifecycleStage
        ? getCrmLifecycleLabel(selectedOrganization.lifecycleStage, language)
        : undefined,
      targetField: "contact_status",
      ready: Boolean(selectedOrganization?.lifecycleStage),
    },
    {
      label: copy.mapping.source,
      novalure: getCrmSourceLabel(selectedContact.source, language),
      targetField: "analytics_source / record_source",
      ready: Boolean(selectedContact.source),
    },
    {
      label: copy.mapping.owner,
      novalure: contactOwner?.name,
      targetField: "owner_id",
      ready: Boolean(contactOwner),
    },
  ];
  const qualityChecks = [
    {
      label: copy.qualityContactChannel,
      detail: selectedContact.email ?? selectedContact.phone ?? "",
      status: selectedContact.email || selectedContact.phone ? "ok" : "missing",
    },
    {
      label: copy.qualityOrganization,
      detail: selectedOrganization?.name ?? "",
      status: selectedOrganization ? "ok" : "warning",
    },
    {
      label: copy.qualityDealRole,
      detail: selectedRelationships
        .map((relationship) => getCrmRelationshipRoleLabel(relationship.role, language))
        .join(", "),
      status: selectedRelationships.length > 0 ? "ok" : "warning",
    },
    {
      label: copy.qualityConsent,
      detail: selectedConsents
        .map((consent) => `${getCrmConsentChannelLabel(consent.channel, language)}: ${getCrmConsentStatusLabel(consent.status, language)}`)
        .join(", "),
      status: selectedConsents.length > 0 ? "ok" : "warning",
    },
    {
      label: copy.qualityNextAction,
      detail: selectedLead?.nextAction ?? "",
      status: selectedLead?.nextAction ? "ok" : "warning",
    },
    {
      label: copy.qualityNoDuplicate,
      detail: selectedDuplicateSignals.map((contact) => contact.name).join(", "),
      status: selectedDuplicateSignals.length === 0 ? "ok" : "warning",
    },
  ] as const;
  const qualityScore = Math.round(
    (qualityChecks.filter((check) => check.status === "ok").length / qualityChecks.length) * 100,
  );
  const readyMappingCount = dataModelMapping.filter((item) => item.ready).length;
  const contactDetailTabs: Array<{ id: ContactDetailTab; label: string }> = [
    { id: "overview", label: copy.tabs.overview },
    { id: "person", label: copy.tabs.person },
    { id: "contactRoutes", label: copy.tabs.contactRoutes },
    { id: "address", label: copy.tabs.address },
    { id: "company", label: copy.tabs.company },
    { id: "realEstate", label: copy.tabs.realEstate },
    { id: "crm", label: copy.tabs.crm },
    { id: "consent", label: copy.tabs.consent },
    { id: "relationships", label: copy.tabs.relationships },
    { id: "timeline", label: copy.tabs.timeline },
    ...(showTechnicalFields ? [{ id: "admin" as const, label: copy.tabs.admin }] : []),
  ];
  const recommendedByTab: Record<ContactDetailTab, string[]> = {
    admin: [copy.adminFieldIds, copy.adminImportSource, copy.adminMapping],
    address: [copy.street, copy.postalCode, copy.city, copy.country],
    company: [copy.companyName, copy.companyType, copy.companyWebsite, copy.decisionMaker],
    consent: [copy.newsletterAllowed, copy.phoneAllowed, copy.whatsappAllowed, copy.legalBasis],
    contactRoutes: [copy.email, copy.phone, copy.mobileWhatsapp, copy.preferredContactRoute],
    crm: [copy.project, copy.owner, copy.nextAction, copy.source],
    overview: [copy.name, copy.project, copy.owner, copy.nextAction],
    person: [copy.salutation, copy.firstName, copy.lastName, copy.preferredName],
    realEstate: [copy.role, copy.budget, copy.desiredLocation, copy.financing],
    relationships: [copy.organizationRecord, copy.relationshipMap, copy.openDeals],
    timeline: [copy.lastActivity, copy.openTasks, copy.timeline],
  };

  const contactViews: Array<{ id: ContactView; label: string; count: number }> = [
    { id: "all", label: copy.allContacts, count: contactRecords.length },
    {
      id: "hot",
      label: copy.hotLeads,
      count: contactRecords.filter((contact) =>
        leads.some((lead) => lead.contactId === contact.id && lead.score >= 85),
      ).length,
    },
    {
      id: "missingData",
      label: copy.incompleteData,
      count: contactRecords.filter((contact) => !contact.email && !contact.phone).length,
    },
    {
      id: "missingConsent",
      label: copy.missingConsentView,
      count: contactRecords.filter((contact) => !consentContactIds.has(contact.id)).length,
    },
    { id: "duplicates", label: copy.duplicatesView, count: duplicateSignals.length },
  ];
  const roleOptions = Array.from(new Set([...defaultRoleOptions, ...contactRecords.map((contact) => contact.role)]));
  const sourceOptions = Array.from(
    new Set([
      ...defaultSourceOptions,
      ...contactRecords.map((contact) => contact.source).filter(isCrmLeadSource),
    ]),
  );
  const showFeedback = (tone: ContactFeedback["tone"], message: string) => {
    setFeedback({ message, tone });
  };
  const clearFeedback = () => setFeedback(null);
  const refreshAfterContactChange = async (overlayContactIdToClear?: string) => {
    await onContactsChanged?.();
    if (overlayContactIdToClear) {
      setServerContactOverlays((current) =>
        current.filter((contact) => contact.id !== overlayContactIdToClear),
      );
    }
  };
  const removeContactPatch = (contactId: string) => {
    setContactPatches((current) => {
      const next = { ...current };
      delete next[contactId];
      return next;
    });
  };
  const updateSelectedContact = (field: ContactEditableField, value: string) => {
    if (!selectedContact) return;
    clearFeedback();
    setContactPatches((current) => ({
      ...current,
      [selectedContact.id]: {
        ...(current[selectedContact.id] ?? {}),
        [field]: value,
      },
    }));
  };
  const updateNewContact = (field: ContactEditableField, value: string) => {
    setNewContact((current) => ({
      ...current,
      [field]: value || undefined,
    }));
  };
  const persistContact = async (contact: Contact) => {
    try {
      const response = await fetch("/api/crm/contacts", {
        body: JSON.stringify({ contact }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as { contact?: Contact; error?: string } | null;

      if (!response.ok) return { error: payload?.error ?? copy.saveFailed };

      return payload?.contact ? { contact: payload.contact } : { error: copy.saveFailed };
    } catch {
      return { error: copy.networkError };
    }
  };
  const createContact = async (nextAction: ContactPostCreateAction = null) => {
    if (!newContact.name.trim() && !newContact.email?.trim() && !newContact.phone?.trim()) {
      showFeedback("error", copy.validationRequired);
      return;
    }

    const project = projects.find((item) => item.id === newContact.projectId) ?? projects[0];
    const createdContact: Contact = {
      ...newContact,
      id: "",
      workspaceId: newContact.workspaceId || contacts[0]?.workspaceId || project?.workspaceId || "",
      projectId: project?.id ?? contacts[0]?.projectId ?? "",
      organizationId: newContact.organizationId,
      ownerUserId: canAssignOwner ? newContact.ownerUserId : undefined,
      name: newContact.name.trim() || newContact.email || newContact.phone || copy.newContactFallback,
      project: project?.name ?? newContact.project,
      intent: newContact.intent || copy.manualIntent,
      consent: newContact.consent || "Nur CRM",
      source: newContact.source || ("Manual" as Contact["source"]),
      role: newContact.role || contactRecords[0]?.role,
      email: newContact.email?.trim() || undefined,
      phone: newContact.phone?.trim() || undefined,
    };

    const result = await persistContact(createdContact);
    if (!result.contact) {
      showFeedback("error", result.error);
      return;
    }
    const persistedContact = result.contact;

    setServerContactOverlays((current) => [persistedContact, ...current.filter((contact) => contact.id !== persistedContact.id)]);
    setSelectedContactId(persistedContact.id);
    setNewContact(createContactDraft({ contacts: [persistedContact, ...contacts], currentUserId, organizations, projects }));
    setIsCreateOpen(false);
    setActiveView("all");
    if (nextAction === "task") {
      setPostCreateAction("task");
      setPostCreateContact(persistedContact);
      setPostCreateTaskDraft(createContactTaskDraft(persistedContact));
      setPostCreateLeadDraft(null);
      showFeedback("success", copy.taskFlowDescription);
    } else if (nextAction === "lead") {
      setPostCreateAction("lead");
      setPostCreateContact(persistedContact);
      setPostCreateLeadDraft(createContactLeadDraft(persistedContact));
      setPostCreateTaskDraft(null);
      showFeedback("success", copy.leadFlowDescription);
    } else {
      setPostCreateAction(null);
      setPostCreateContact(null);
      setPostCreateTaskDraft(null);
      setPostCreateLeadDraft(null);
      showFeedback("success", copy.contactAdded);
    }
    void onContactsChanged?.();
  };
  const savePostCreateTask = async () => {
    if (!postCreateContact || !postCreateTaskDraft?.title.trim()) {
      showFeedback("error", copy.validationRequired);
      return;
    }

    setPostCreateSaving(true);
    try {
      const response = await fetch("/api/crm/tasks", {
        body: JSON.stringify({
          task: {
            contactId: postCreateContact.id,
            description: postCreateTaskDraft.description.trim() || undefined,
            due: postCreateTaskDraft.due ? new Date(postCreateTaskDraft.due).toISOString() : "",
            priority: postCreateTaskDraft.priority,
            projectId: postCreateContact.projectId,
            status: "open",
            title: postCreateTaskDraft.title.trim(),
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; task?: Task };
      if (!response.ok || !payload.task) throw new Error(payload.error ?? copy.saveFailed);

      setPostCreateAction(null);
      setPostCreateContact(null);
      setPostCreateTaskDraft(null);
      showFeedback("success", copy.linkedTaskCreated);
      void onContactsChanged?.();
    } catch (error) {
      showFeedback("error", error instanceof Error ? error.message : copy.saveFailed);
    } finally {
      setPostCreateSaving(false);
    }
  };
  const savePostCreateLead = async () => {
    if (!postCreateContact || !postCreateLeadDraft?.intent.trim()) {
      showFeedback("error", copy.validationRequired);
      return;
    }

    setPostCreateSaving(true);
    try {
      const response = await fetch("/api/crm/leads", {
        body: JSON.stringify({
          lead: {
            contactId: postCreateContact.id,
            hotStatus: Number(postCreateLeadDraft.score) >= 80,
            intent: postCreateLeadDraft.intent.trim(),
            nextAction: postCreateLeadDraft.nextAction.trim(),
            projectId: postCreateContact.projectId,
            receivedAt: new Date().toISOString(),
            score: Number(postCreateLeadDraft.score) || 0,
            source: postCreateContact.source,
            status: postCreateLeadDraft.status,
            type: postCreateLeadDraft.type,
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; lead?: Lead };
      if (!response.ok || !payload.lead) throw new Error(payload.error ?? copy.saveFailed);

      setPostCreateAction(null);
      setPostCreateContact(null);
      setPostCreateLeadDraft(null);
      showFeedback("success", copy.linkedLeadCreated);
      void onContactsChanged?.();
    } catch (error) {
      showFeedback("error", error instanceof Error ? error.message : copy.saveFailed);
    } finally {
      setPostCreateSaving(false);
    }
  };
  const saveSelectedContact = async () => {
    if (!canWriteContacts) return;
    if (!selectedContact) return;
    if (!selectedContact.name.trim() && !selectedContact.email?.trim() && !selectedContact.phone?.trim()) {
      showFeedback("error", copy.validationRequired);
      return;
    }

    const result = await persistContact(selectedContact);
    if (!result.contact) {
      showFeedback("error", result.error);
      return;
    }
    const persistedContact = result.contact;

    setServerContactOverlays((current) => [
      persistedContact,
      ...current.filter((contact) => contact.id !== persistedContact.id),
    ]);
    removeContactPatch(selectedContact.id);
    setSelectedContactId(persistedContact.id);
    showFeedback("success", copy.changesSaved);
    void refreshAfterContactChange(persistedContact.id);
  };
  const archiveSelectedContact = async () => {
    if (!canAssignOwner) return;
    if (!selectedContact) return;

    try {
      const response = await fetch(`/api/crm/contacts?id=${encodeURIComponent(selectedContact.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;

      if (!response.ok) {
        showFeedback("error", payload?.error ?? copy.archiveFailed);
        return;
      }

      setServerContactOverlays((current) => current.filter((contact) => contact.id !== selectedContact.id));
      removeContactPatch(selectedContact.id);
      setArchivedContactIds((current) => new Set([...current, selectedContact.id]));
      setSelectedContactId(contactRecords.find((contact) => contact.id !== selectedContact.id)?.id ?? "");
      setArchiveConfirmContactId("");
      showFeedback("success", copy.contactArchived);
      void onContactsChanged?.();
    } catch {
      showFeedback("error", copy.networkError);
    }
  };

  if (!hasSelectedContact && !canWriteContacts) {
    return (
      <section className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        {copy.noContact}
      </section>
    );
  }

  return (
    <section className="min-w-0 space-y-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {copy.moduleLabel}
            </p>
            <h3 className="mt-1 text-xl font-semibold">{copy.title}</h3>
            <p className="mt-2 max-w-4xl break-words text-sm text-stone-600">
              {copy.description}
            </p>
            {canWriteContacts ? (
              <button
                className="mt-4 rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                onClick={() => {
                  setIsCreateOpen(true);
                  setArchiveConfirmContactId("");
                  clearFeedback();
                }}
                type="button"
              >
                {copy.addContact}
              </button>
            ) : (
              <p className="mt-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-medium text-stone-600">
                {copy.readOnlyContacts}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div className="rounded-md bg-stone-50 p-3">
              <p className="font-semibold">{contactRecords.length}</p>
              <p className="text-xs text-stone-500">{copy.people}</p>
            </div>
            <div className="rounded-md bg-stone-50 p-3">
              <p className="font-semibold">{organizations.length}</p>
              <p className="text-xs text-stone-500">{copy.organizations}</p>
            </div>
            <div className="rounded-md bg-stone-50 p-3">
              <p className="font-semibold">{primaryRelationships.length}</p>
              <p className="text-xs text-stone-500">{copy.primaryRoles}</p>
            </div>
            <div className="rounded-md bg-stone-50 p-3">
              <p className="font-semibold">{duplicateSignals.length}</p>
              <p className="text-xs text-stone-500">{copy.duplicateSignals}</p>
            </div>
            </div>
          </div>
        </div>
        {feedback ? (
          <div
            className={`mt-4 rounded-md border px-3 py-2 text-sm font-semibold ${
              feedback.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-red-200 bg-red-50 text-red-900"
            }`}
          >
            {feedback.message}
          </div>
        ) : null}
        {isCreateOpen && canWriteContacts ? (
          <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <h4 className="text-lg font-semibold">
                {copy.createContactTitle}
              </h4>
              <button
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                onClick={() => setIsCreateOpen(false)}
                type="button"
              >
                {copy.close}
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.contactKind}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => setNewContactKind(event.target.value as ContactKind)}
                  value={newContactKind}
                >
                  {copy.contactKindOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.name}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("name", event.target.value)}
                  value={newContact.name}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.email}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("email", event.target.value)}
                  type="email"
                  value={newContact.email ?? ""}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.phone}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("phone", event.target.value)}
                  value={newContact.phone ?? ""}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.role}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("role", event.target.value)}
                  value={newContact.role}
                >
                  {roleOptions.map((role) => (
                    <option key={role} value={role}>
                      {getCrmLeadTypeLabel(role, language)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.source}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("source", event.target.value)}
                  value={newContact.source}
                >
                  {sourceOptions.map((source) => (
                    <option key={source} value={source}>
                      {getCrmSourceLabel(source, language)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.project}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => {
                    const project = projects.find((item) => item.id === event.target.value);
                    setNewContact((current) => ({
                      ...current,
                      projectId: project?.id ?? current.projectId,
                      project: project?.name ?? current.project,
                    }));
                  }}
                  value={newContact.projectId}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.organizationRecord}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setNewContact((current) => ({
                      ...current,
                      organizationId: event.target.value || undefined,
                    }))
                  }
                  value={newContact.organizationId ?? ""}
                >
                  <option value="">{copy.noOrganization}</option>
                  {organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.need}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("intent", event.target.value)}
                  value={newContact.intent}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.consent}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("consent", event.target.value)}
                  value={newContact.consent}
                />
              </label>
            </div>
            <p className="mt-4 rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
              {copy.quickCreateHelp}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {[
                { action: null, label: copy.saveContact },
                { action: "task" as const, label: copy.saveAndTask },
                { action: "lead" as const, label: copy.saveAndLead },
              ].map((button) => (
                <button
                  className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                  key={button.label}
                  onClick={() => void createContact(button.action)}
                  type="button"
                >
                  {button.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {postCreateAction === "task" && postCreateContact && postCreateTaskDraft ? (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
            <h4 className="text-lg font-semibold">{copy.taskFlowTitle}</h4>
            <p className="mt-1 break-words text-sm text-emerald-900">{copy.taskFlowDescription}</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] md:col-span-2">
                {copy.taskTitle}
                <input
                  className="mt-2 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setPostCreateTaskDraft((current) => current ? { ...current, title: event.target.value } : current)
                  }
                  value={postCreateTaskDraft.title}
                />
              </label>
              {canAssignOwner ? (
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.owner}
                  <select
                    className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) => updateNewContact("ownerUserId", event.target.value)}
                    value={newContact.ownerUserId ?? ""}
                  >
                    <option value="">{copy.unassigned}</option>
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="text-xs font-semibold uppercase tracking-[0.12em] md:col-span-2">
                {copy.taskDescription}
                <textarea
                  className="mt-2 min-h-20 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setPostCreateTaskDraft((current) => current ? { ...current, description: event.target.value } : current)
                  }
                  value={postCreateTaskDraft.description}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em]">
                {copy.taskDue}
                <input
                  className="mt-2 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setPostCreateTaskDraft((current) => current ? { ...current, due: event.target.value } : current)
                  }
                  type="datetime-local"
                  value={postCreateTaskDraft.due}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em]">
                {copy.taskPriority}
                <select
                  className="mt-2 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setPostCreateTaskDraft((current) =>
                      current ? { ...current, priority: event.target.value as Task["priority"] } : current,
                    )
                  }
                  value={postCreateTaskDraft.priority}
                >
                  {(["Hoch", "Mittel", "Normal"] as Task["priority"][]).map((priority) => (
                    <option key={priority} value={priority}>
                      {getCrmTaskPriorityLabel(priority, language)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={postCreateSaving}
                onClick={() => void savePostCreateTask()}
                type="button"
              >
                {copy.createLinkedTask}
              </button>
              <button
                className="rounded-md border border-emerald-300 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-100"
                onClick={() => {
                  setPostCreateAction(null);
                  setPostCreateContact(null);
                  setPostCreateTaskDraft(null);
                  showFeedback("success", copy.followUpCancelled);
                }}
                type="button"
              >
                {copy.cancelArchive}
              </button>
            </div>
          </div>
        ) : null}

        {postCreateAction === "lead" && postCreateContact && postCreateLeadDraft ? (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
            <h4 className="text-lg font-semibold">{copy.leadFlowTitle}</h4>
            <p className="mt-1 break-words text-sm text-emerald-900">{copy.leadFlowDescription}</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] md:col-span-2">
                {copy.leadIntent}
                <input
                  className="mt-2 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setPostCreateLeadDraft((current) => current ? { ...current, intent: event.target.value } : current)
                  }
                  value={postCreateLeadDraft.intent}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em]">
                {copy.leadType}
                <select
                  className="mt-2 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setPostCreateLeadDraft((current) =>
                      current ? { ...current, type: event.target.value as LeadType } : current,
                    )
                  }
                  value={postCreateLeadDraft.type}
                >
                  {leadTypeOptions.map((type) => (
                    <option key={type} value={type}>
                      {getCrmLeadTypeLabel(type, language)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em]">
                {copy.leadStatus}
                <select
                  className="mt-2 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setPostCreateLeadDraft((current) =>
                      current ? { ...current, status: event.target.value as LeadStatus } : current,
                    )
                  }
                  value={postCreateLeadDraft.status}
                >
                  {leadStatusOptions.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em]">
                {copy.leadScore}
                <input
                  className="mt-2 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  max={100}
                  min={0}
                  onChange={(event) =>
                    setPostCreateLeadDraft((current) => current ? { ...current, score: event.target.value } : current)
                  }
                  type="number"
                  value={postCreateLeadDraft.score}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em]">
                {copy.leadNextAction}
                <input
                  className="mt-2 w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setPostCreateLeadDraft((current) => current ? { ...current, nextAction: event.target.value } : current)
                  }
                  value={postCreateLeadDraft.nextAction}
                />
              </label>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={postCreateSaving}
                onClick={() => void savePostCreateLead()}
                type="button"
              >
                {copy.assignLinkedLead}
              </button>
              <button
                className="rounded-md border border-emerald-300 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-100"
                onClick={() => {
                  setPostCreateAction(null);
                  setPostCreateContact(null);
                  setPostCreateLeadDraft(null);
                  showFeedback("success", copy.followUpCancelled);
                }}
                type="button"
              >
                {copy.cancelArchive}
              </button>
            </div>
          </div>
        ) : null}
      </article>

      <section className="grid min-w-0 gap-4 2xl:grid-cols-[340px_minmax(0,1fr)]">
        <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold">{copy.people}</h4>
            <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">
              {filteredContacts.length}/{contactRecords.length}
            </span>
          </div>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {copy.search}
            <input
              className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={copy.searchPlaceholder}
              type="search"
              value={searchTerm}
            />
          </label>
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {copy.savedViews}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {contactViews.map((view) => (
                <button
                  className={`rounded-md border px-2 py-1 text-xs font-semibold ${
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
          </div>
          <div className="mt-4 space-y-2">
            {filteredContacts.length > 0 ? (
              filteredContacts.map((contact) => {
              const organization = contact.organizationId
                ? organizations.find((item) => item.id === contact.organizationId)
                : undefined;
              const lead = leads.find((item) => item.contactId === contact.id);
              const contactTimeline = timeline
                .filter((item) => item.contactId === contact.id)
                .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
              const isSelected = selectedContact.id === contact.id;

              return (
                <button
                  aria-pressed={isSelected}
                  className={`block w-full rounded-lg border p-3 text-left text-sm ${
                    isSelected
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-stone-200 bg-stone-50 text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                  }`}
                  key={contact.id}
                  onClick={() => {
                    setSelectedContactId(contact.id);
                    setArchiveConfirmContactId("");
                  }}
                  type="button"
                >
                  <span className="block break-words font-semibold">{contact.name}</span>
                  <span
                    className={`mt-1 block break-words text-xs ${
                      isSelected ? "text-slate-300" : "text-stone-500"
                    }`}
                  >
                      {getCrmLeadTypeLabel(contact.role, language)} · {organization?.name ?? copy.noOrganization}
                  </span>
                  <span
                    className={`mt-2 block break-words text-xs ${
                      isSelected ? "text-slate-300" : "text-stone-500"
                    }`}
                  >
                    {copy.lastActivity}: {contactTimeline[0]?.title ?? "-"}
                  </span>
                  <span className="mt-3 flex flex-wrap gap-2">
                    <span
                      className={`rounded-md px-2 py-1 text-xs font-semibold ${
                        isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                      }`}
                    >
                      {getCrmSourceLabel(contact.source, language)}
                    </span>
                    {lead ? (
                      <span
                        className={`rounded-md px-2 py-1 text-xs font-semibold ${
                          isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                        }`}
                      >
                        {copy.score} {lead.score}
                      </span>
                    ) : null}
                    <span
                      className={`rounded-md px-2 py-1 text-xs font-semibold ${
                        isSelected ? "bg-emerald-300/20 text-emerald-100" : "bg-emerald-50 text-emerald-800"
                      }`}
                    >
                      {contact.intent}
                    </span>
                  </span>
                </button>
              );
            })
            ) : (
              <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">
                {copy.noFilteredContacts}
              </div>
            )}
          </div>
        </article>

        <section className="grid min-w-0 gap-4">
          <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
            <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    {copy.personRecord}
                  </p>
                  <h4 className="mt-1 break-words text-2xl font-semibold">
                    {selectedContact.name}
                  </h4>
                  <p className="mt-1 break-words text-sm text-stone-600">
                    {getCrmLeadTypeLabel(selectedContact.role, language)} · {getCrmSourceLabel(selectedContact.source, language)}
                  </p>
                </div>
                {selectedLead ? (
                  <span className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white">
                    {copy.leadScore}: {selectedLead.score}
                  </span>
                ) : null}
              </div>

              <div className="mt-5 rounded-lg border border-stone-200 bg-white p-3">
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {contactDetailTabs.map((tab) => (
                    <button
                      className={`shrink-0 rounded-md border px-3 py-2 text-xs font-semibold ${
                        activeDetailTab === tab.id
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-200 bg-stone-50 text-stone-700 hover:border-emerald-200 hover:bg-emerald-50"
                      }`}
                      key={tab.id}
                      onClick={() => setActiveDetailTab(tab.id)}
                      type="button"
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 rounded-md bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.recommendedForTab}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {recommendedByTab[activeDetailTab].map((field) => (
                      <span className="rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-700" key={field}>
                        {field}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <h5 className="text-sm font-semibold">
                    {copy.editContact}
                  </h5>
                  {canWriteContacts ? (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      {canAssignOwner && archiveConfirmContactId === selectedContact.id ? (
                        <>
                          <button
                            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:border-stone-400 hover:bg-stone-100"
                            onClick={() => setArchiveConfirmContactId("")}
                            type="button"
                          >
                            {copy.cancelArchive}
                          </button>
                          <button
                            className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
                            onClick={() => void archiveSelectedContact()}
                            type="button"
                          >
                            {copy.confirmArchive}
                          </button>
                        </>
                      ) : canAssignOwner ? (
                        <button
                          className="rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:border-red-300 hover:bg-red-50"
                          onClick={() => setArchiveConfirmContactId(selectedContact.id)}
                          type="button"
                        >
                          {copy.archiveContact}
                        </button>
                      ) : null}
                      <button
                        className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                        onClick={() => void saveSelectedContact()}
                        type="button"
                      >
                        {copy.saveChanges}
                      </button>
                    </div>
                  ) : (
                    <p className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-600">
                      {copy.readOnlyContacts}
                    </p>
                  )}
                </div>
                {archiveConfirmContactId === selectedContact.id ? (
                  <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    {copy.archiveConfirm(selectedContact.name)}
                  </p>
                ) : null}
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.name}
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("name", event.target.value)}
                      value={selectedContact.name}
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.role}
                    <select
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("role", event.target.value)}
                      value={selectedContact.role}
                    >
                      {roleOptions.map((role) => (
                        <option key={role} value={role}>
                          {getCrmLeadTypeLabel(role, language)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.email}
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("email", event.target.value)}
                      type="email"
                      value={selectedContact.email ?? ""}
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.phone}
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("phone", event.target.value)}
                      value={selectedContact.phone ?? ""}
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.source}
                    <select
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("source", event.target.value)}
                      value={getContactSourceOptionValue(selectedContact.source)}
                    >
                      {sourceOptions.map((source) => (
                        <option key={source} value={source}>
                          {getCrmSourceLabel(source, language)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.organizationRecord}
                    <select
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("organizationId", event.target.value)}
                      value={selectedContact.organizationId ?? ""}
                    >
                      <option value="">{copy.noOrganization}</option>
                      {organizations.map((organization) => (
                        <option key={organization.id} value={organization.id}>
                          {organization.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {canAssignOwner ? (
                    <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.owner}
                      <select
                        className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                        onChange={(event) => updateSelectedContact("ownerUserId", event.target.value)}
                        value={selectedContact.ownerUserId ?? ""}
                      >
                        <option value="">{copy.unassigned}</option>
                        {users.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.need}
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("intent", event.target.value)}
                      value={selectedContact.intent}
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 md:col-span-2">
                    {copy.consentNote}
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("consent", event.target.value)}
                      value={selectedContact.consent}
                    />
                  </label>
                </div>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2">
                <div className="rounded-md bg-stone-50 p-3 text-sm">
                  <p className="font-semibold text-slate-900">{copy.project}</p>
                  <p className="mt-1 break-words text-stone-600">
                    {selectedProject?.name ?? selectedContact.project}
                  </p>
                </div>
                <div className="rounded-md bg-stone-50 p-3 text-sm">
                  <p className="font-semibold text-slate-900">{copy.nextAction}</p>
                  <p className="mt-1 break-words text-stone-600">
                    {selectedLead?.nextAction ?? selectedContact.intent}
                  </p>
                </div>
                <div className="rounded-md bg-stone-50 p-3 text-sm">
                  <p className="font-semibold text-slate-900">{copy.email}</p>
                  <p className="mt-1 break-words text-stone-600">
                    {selectedContact.email ?? copy.noValue}
                  </p>
                </div>
                <div className="rounded-md bg-stone-50 p-3 text-sm">
                  <p className="font-semibold text-slate-900">{copy.phone}</p>
                  <p className="mt-1 break-words text-stone-600">
                    {selectedContact.phone ?? copy.noValue}
                  </p>
                </div>
              </div>
            </article>

            <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                {copy.organizationRecord}
              </p>
              <h4 className="mt-1 break-words text-xl font-semibold">
                {selectedOrganization?.name ?? copy.noOrganization}
              </h4>
              {selectedOrganization ? (
                <>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <span
                      className={`rounded-md px-2 py-1 font-semibold ${
                        lifecycleStyles[selectedOrganization.lifecycleStage]
                      }`}
                    >
                      {getCrmLifecycleLabel(selectedOrganization.lifecycleStage, language)}
                    </span>
                    <span className="rounded-md bg-stone-100 px-2 py-1 font-semibold text-stone-700">
                      {getCrmOrganizationTypeLabel(selectedOrganization.type, language)}
                    </span>
                    <span className="rounded-md bg-stone-100 px-2 py-1 font-semibold text-stone-700">
                      {selectedOrganization.city}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                    <div className="rounded-md bg-stone-50 p-3">
                      <p className="font-semibold">{selectedOrganization.openDeals}</p>
                      <p className="text-xs text-stone-500">{copy.openDeals}</p>
                    </div>
                    <div className="rounded-md bg-stone-50 p-3">
                      <p className="font-semibold">{selectedOrganization.activeContacts}</p>
                      <p className="text-xs text-stone-500">{copy.people}</p>
                    </div>
                  </div>
                  <p className="mt-4 break-words text-sm text-stone-600">
                    {copy.owner}: {contactOwner?.name ?? copy.unassigned}
                  </p>
                </>
              ) : null}
            </article>
          </section>

          <section className="grid min-w-0 gap-4 lg:grid-cols-3">
            <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-lg font-semibold">{copy.dataQuality}</h4>
                  <p className="mt-1 text-sm text-stone-500">{copy.importReadiness}</p>
                </div>
                <span className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white">
                  {qualityScore}%
                </span>
              </div>
              <div className="mt-4 space-y-2">
                {qualityChecks.map((check) => (
                  <div
                    className={`rounded-md border p-3 text-sm ${qualityStyles[check.status]}`}
                    key={check.label}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{check.label}</span>
                      <span className="rounded-md bg-white/60 px-2 py-1 text-xs font-semibold">
                        {check.status === "ok"
                          ? copy.ready
                          : check.status === "missing"
                            ? copy.missing
                            : copy.warning}
                      </span>
                    </div>
                    {check.detail ? (
                      <p className="mt-1 break-words text-xs opacity-75">{check.detail}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </article>

            <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold">{copy.relationshipMap}</h4>
              <div className="mt-4 space-y-3">
                {selectedRelationships.map((relationship) => (
                  <div className="rounded-md bg-stone-50 p-3" key={relationship.id}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-semibold">{getCrmRelationshipRoleLabel(relationship.role, language)}</span>
                      <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">
                        {getCrmRelationshipInfluenceLabel(relationship.influence, language)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-stone-500">
                      {relationship.isPrimary ? copy.primaryRelationship : copy.secondaryRelationship}
                    </p>
                  </div>
                ))}
              </div>
            </article>

            <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold">{copy.consent}</h4>
              <div className="mt-4 flex flex-wrap gap-2">
                {selectedConsents.map((consent) => (
                  <span
                    className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800"
                    key={consent.id}
                  >
                    {getCrmConsentChannelLabel(consent.channel, language)}: {getCrmConsentStatusLabel(consent.status, language)}
                  </span>
                ))}
                {selectedConsents.length === 0 ? (
                  <span className="text-sm text-stone-500">{copy.noConsent}</span>
                ) : null}
              </div>
              <h4 className="mt-5 text-lg font-semibold">{copy.openTasks}</h4>
              <div className="mt-3 space-y-2">
                {selectedTasks.map((task) => (
                  <div className="rounded-md bg-stone-50 p-3 text-sm" key={task.id}>
                    <p className="font-semibold">{task.title}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      {getCrmTaskDueLabel(task.due, language)} · {getCrmTaskPriorityLabel(task.priority, language)}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
            {showTechnicalFields ? (
              <details className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
                <summary className="cursor-pointer text-lg font-semibold">{copy.dataModelMapping}</summary>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-lg font-semibold">{copy.dataModelMapping}</h4>
                    <p className="mt-1 break-words text-sm text-stone-500">
                      {readyMappingCount}/{dataModelMapping.length} {copy.ready}
                    </p>
                  </div>
                  <span className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
                    {copy.recordBundle}
                  </span>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                    <thead className="border-b border-stone-200 text-xs uppercase tracking-[0.12em] text-stone-500">
                      <tr>
                        <th className="py-2 pr-3 font-semibold">{copy.tableNovalure}</th>
                        <th className="py-2 pr-3 font-semibold">{copy.tableValue}</th>
                        <th className="py-2 pr-3 font-semibold">{copy.tableTargetField}</th>
                        <th className="py-2 font-semibold">{copy.tableStatus}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {dataModelMapping.map((item) => (
                        <tr key={item.label}>
                          <td className="py-3 pr-3 font-semibold text-slate-900">{item.label}</td>
                          <td className="py-3 pr-3 text-stone-600">
                            {item.novalure ?? copy.noValue}
                          </td>
                          <td className="py-3 pr-3 text-stone-600">{item.targetField}</td>
                          <td className="py-3">
                            <span
                              className={`rounded-md px-2 py-1 text-xs font-semibold ${
                                item.ready
                                  ? "bg-emerald-50 text-emerald-800"
                                  : "bg-amber-50 text-amber-800"
                              }`}
                            >
                              {item.ready ? copy.ready : copy.warning}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}

            <article className="rounded-lg border border-stone-200 bg-slate-950 p-5 text-white">
              <h4 className="text-lg font-semibold">{copy.dataPrincipleTitle}</h4>
              <div className="mt-4 space-y-3 text-sm text-slate-200">
                {copy.dataPrinciples.map((principle) => (
                  <p className="break-words" key={principle}>{principle}</p>
                ))}
              </div>
            </article>
          </section>

          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h4 className="text-lg font-semibold">{copy.timeline}</h4>
            <div className="mt-4 space-y-3">
              {selectedTimeline.map((item) => (
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={item.id}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold">{item.title}</p>
                      <p className="mt-1 break-words text-sm text-stone-600">{item.detail}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
                        outcomeStyles[item.outcome]
                      }`}
                    >
                      {item.channel}
                    </span>
                  </div>
                </div>
              ))}
              {selectedTimeline.length === 0 ? (
                <div className="rounded-lg border border-dashed border-stone-300 p-4 text-sm text-stone-500">
                  {copy.noTimeline}
                </div>
              ) : null}
            </div>
          </article>
        </section>
      </section>
    </section>
  );
}


