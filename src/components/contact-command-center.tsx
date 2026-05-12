"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  ConsentRecord,
  Contact,
  ContactRelationship,
  ContactTimelineItem,
  Lead,
  Organization,
  Project,
  Task,
  WorkspaceUser,
} from "@/lib/crm-types";
import { type LanguageCode } from "@/lib/i18n";

type ContactCommandCenterProps = {
  consents: ConsentRecord[];
  contacts: Contact[];
  language: LanguageCode;
  leads: Lead[];
  organizations: Organization[];
  projects: Project[];
  relationships: ContactRelationship[];
  tasks: Task[];
  timeline: ContactTimelineItem[];
  users: WorkspaceUser[];
};

type ContactView = "all" | "hot" | "missingData" | "missingConsent" | "duplicates";
type ContactEditableField = "name" | "role" | "project" | "source" | "intent" | "consent" | "email" | "phone";

const CONTACT_STORAGE_KEY = "novalure-contact-records-v1";

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
  consents,
  contacts,
  language,
  leads,
  organizations,
  projects,
  relationships,
  tasks,
  timeline,
  users,
}: ContactCommandCenterProps) {
  const [contactRecords, setContactRecords] = useState<Contact[]>(() => {
    if (typeof window === "undefined") {
      return contacts;
    }

    try {
      const stored = window.localStorage.getItem(CONTACT_STORAGE_KEY);
      if (!stored) {
        return contacts;
      }

      const parsed = JSON.parse(stored) as Contact[];
      return Array.isArray(parsed) && parsed.length ? parsed : contacts;
    } catch {
      return contacts;
    }
  });
  const [selectedContactId, setSelectedContactId] = useState(contactRecords[0]?.id ?? "");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeView, setActiveView] = useState<ContactView>("all");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [newContact, setNewContact] = useState<Contact>(() => ({
    id: "",
    workspaceId: contacts[0]?.workspaceId ?? "workspace_novalure",
    projectId: projects[0]?.id ?? "",
    organizationId: organizations[0]?.id,
    name: "",
    role: contacts[0]?.role ?? ("Verkäufer" as Contact["role"]),
    project: projects[0]?.name ?? "",
    source: "Manual",
    intent: "",
    consent: "Nur CRM",
    email: "",
    phone: "",
  }));

  useEffect(() => {
    window.localStorage.setItem(CONTACT_STORAGE_KEY, JSON.stringify(contactRecords));
  }, [contactRecords]);

  const selectedContact =
    contactRecords.find((contact) => contact.id === selectedContactId) ?? contactRecords[0];
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
  const contactOwner = selectedOrganization?.ownerUserId
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
      label: "Name",
      novalure: selectedContact.name,
      targetField: "first_name, last_name",
      ready: Boolean(selectedContact.name),
    },
    {
      label: "E-Mail",
      novalure: selectedContact.email,
      targetField: "email",
      ready: Boolean(selectedContact.email),
    },
    {
      label: "Telefon",
      novalure: selectedContact.phone,
      targetField: "phone / mobile_phone",
      ready: Boolean(selectedContact.phone),
    },
    {
      label: "Organisation",
      novalure: selectedOrganization?.name,
      targetField: "linked_organization",
      ready: Boolean(selectedOrganization),
    },
    {
      label: "Lifecycle",
      novalure: selectedOrganization?.lifecycleStage,
      targetField: "contact_status",
      ready: Boolean(selectedOrganization?.lifecycleStage),
    },
    {
      label: "Quelle",
      novalure: selectedContact.source,
      targetField: "analytics_source / record_source",
      ready: Boolean(selectedContact.source),
    },
    {
      label: "Besitzer",
      novalure: contactOwner?.name,
      targetField: "owner_id",
      ready: Boolean(contactOwner),
    },
  ];
  const qualityChecks = [
    {
      label: language === "de" ? "Kontaktweg vorhanden" : "Contact channel present",
      detail: selectedContact.email ?? selectedContact.phone ?? "",
      status: selectedContact.email || selectedContact.phone ? "ok" : "missing",
    },
    {
      label: language === "de" ? "Organisation verknüpft" : "Organization linked",
      detail: selectedOrganization?.name ?? "",
      status: selectedOrganization ? "ok" : "warning",
    },
    {
      label: language === "de" ? "Rolle im Deal erklärt" : "Deal role explained",
      detail: selectedRelationships.map((relationship) => relationship.role).join(", "),
      status: selectedRelationships.length > 0 ? "ok" : "warning",
    },
    {
      label: language === "de" ? "Consent dokumentiert" : "Consent documented",
      detail: selectedConsents.map((consent) => `${consent.channel}: ${consent.status}`).join(", "),
      status: selectedConsents.length > 0 ? "ok" : "warning",
    },
    {
      label: language === "de" ? "Nächste Aktion vorhanden" : "Next action present",
      detail: selectedLead?.nextAction ?? "",
      status: selectedLead?.nextAction ? "ok" : "warning",
    },
    {
      label: language === "de" ? "Keine Dublette erkannt" : "No duplicate detected",
      detail: selectedDuplicateSignals.map((contact) => contact.name).join(", "),
      status: selectedDuplicateSignals.length === 0 ? "ok" : "warning",
    },
  ] as const;
  const qualityScore = Math.round(
    (qualityChecks.filter((check) => check.status === "ok").length / qualityChecks.length) * 100,
  );
  const readyMappingCount = dataModelMapping.filter((item) => item.ready).length;

  const copy =
    language === "de"
      ? {
          title: "Kontakte, Organisationen und Beziehungen",
          description:
            "Aufbau wie in führenden CRM-Systemen: Person, Organisation, Deal-Kontext, Consent und Timeline bleiben getrennt, aber sichtbar verbunden.",
          people: "Personen",
          organizations: "Organisationen",
          primaryRoles: "Primäre Rollen",
          duplicateSignals: "Dublettensignale",
          savedViews: "Gespeicherte Ansichten",
          allContacts: "Alle Kontakte",
          hotLeads: "Heiße Leads",
          incompleteData: "Fehlende Daten",
          missingConsentView: "Consent fehlt",
          duplicatesView: "Dubletten",
          search: "Suche",
          searchPlaceholder: "Kontakt, Firma, Ort oder Quelle suchen",
          noFilteredContacts: "Keine Kontakte für diese Ansicht.",
          dataQuality: "Datenqualität",
          dataModelMapping: "Datenfeld-Mapping",
          importReadiness: "Importbereitschaft",
          personRecord: "Personendatensatz",
          organizationRecord: "Organisation",
          relationshipMap: "Beziehungen",
          timeline: "Timeline",
          openTasks: "Offene Aufgaben",
          consent: "Consent",
          project: "Projekt",
          owner: "Besitzer",
          leadScore: "Lead-Score",
          nextAction: "Nächste Aktion",
          noContact: "Kein Kontakt im aktuellen Projektfilter.",
          noOrganization: "Keine Organisation verknüpft",
          noTimeline: "Noch keine Timeline-Einträge",
          lastActivity: "Letzte Aktivität",
          ready: "bereit",
          missing: "fehlt",
          warning: "prüfen",
        }
      : {
          title: "Contacts, organizations and relationships",
          description:
            "Built around proven contact data models: person, organization, deal context, consent and timeline stay separate but visibly connected.",
          people: "People",
          organizations: "Organizations",
          primaryRoles: "Primary roles",
          duplicateSignals: "Duplicate signals",
          savedViews: "Saved views",
          allContacts: "All contacts",
          hotLeads: "Hot leads",
          incompleteData: "Missing data",
          missingConsentView: "Missing consent",
          duplicatesView: "Duplicates",
          search: "Search",
          searchPlaceholder: "Search contact, company, city or source",
          noFilteredContacts: "No contacts for this view.",
          dataQuality: "Data quality",
          dataModelMapping: "Data field mapping",
          importReadiness: "Import readiness",
          personRecord: "Person record",
          organizationRecord: "Organization",
          relationshipMap: "Relationships",
          timeline: "Timeline",
          openTasks: "Open tasks",
          consent: "Consent",
          project: "Project",
          owner: "Owner",
          leadScore: "Lead score",
          nextAction: "Next action",
          noContact: "No contact for the current project filter.",
          noOrganization: "No organization linked",
          noTimeline: "No timeline entries yet",
          lastActivity: "Last activity",
          ready: "ready",
          missing: "missing",
          warning: "review",
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
  const roleOptions = Array.from(new Set(contactRecords.map((contact) => contact.role)));
  const sourceOptions = Array.from(new Set([...contactRecords.map((contact) => contact.source), "Manual" as const]));
  const updateSelectedContact = (field: ContactEditableField, value: string) => {
    if (!selectedContact) return;
    setSavedMessage("");
    setContactRecords((current) =>
      current.map((contact) =>
        contact.id === selectedContact.id
          ? {
              ...contact,
              [field]: value || undefined,
            }
          : contact,
      ),
    );
  };
  const updateNewContact = (field: ContactEditableField, value: string) => {
    setNewContact((current) => ({
      ...current,
      [field]: value || undefined,
    }));
  };
  const createContact = () => {
    if (!newContact.name.trim() && !newContact.email?.trim() && !newContact.phone?.trim()) {
      setSavedMessage(
        language === "de"
          ? "Bitte mindestens Name, E-Mail oder Telefon eintragen."
          : "Enter at least a name, email, or phone number.",
      );
      return;
    }

    const project = projects.find((item) => item.id === newContact.projectId) ?? projects[0];
    const createdContact: Contact = {
      ...newContact,
      id: `contact_manual_${Date.now()}`,
      workspaceId: newContact.workspaceId || contacts[0]?.workspaceId || "workspace_novalure",
      projectId: project?.id ?? contacts[0]?.projectId ?? "",
      organizationId: newContact.organizationId || organizations[0]?.id,
      name: newContact.name.trim() || newContact.email || newContact.phone || "Neuer Kontakt",
      project: project?.name ?? newContact.project,
      intent: newContact.intent || "Manuell erfasst",
      consent: newContact.consent || "Nur CRM",
      source: newContact.source || ("Manual" as Contact["source"]),
      role: newContact.role || contactRecords[0]?.role,
      email: newContact.email?.trim() || undefined,
      phone: newContact.phone?.trim() || undefined,
    };

    setContactRecords((current) => [createdContact, ...current]);
    setSelectedContactId(createdContact.id);
    setNewContact({
      ...createdContact,
      id: "",
      name: "",
      email: "",
      phone: "",
      intent: "",
      consent: "Nur CRM",
    });
    setIsCreateOpen(false);
    setActiveView("all");
    setSavedMessage(language === "de" ? "Kontakt wurde hinzugefügt." : "Contact added.");
  };
  const saveSelectedContact = () => {
    setSavedMessage(language === "de" ? "Änderungen gespeichert." : "Changes saved.");
  };

  if (!selectedContact) {
    return (
      <section className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        {copy.noContact}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Kontakt-Datenmodell
            </p>
            <h3 className="mt-1 text-xl font-semibold">{copy.title}</h3>
            <p className="mt-2 max-w-4xl break-words text-sm text-stone-600">
              {copy.description}
            </p>
            <button
              className="mt-4 rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={() => {
                setIsCreateOpen(true);
                setSavedMessage("");
              }}
              type="button"
            >
              {language === "de" ? "Kontakt hinzufügen" : "Add contact"}
            </button>
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
        {savedMessage ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
            {savedMessage}
          </div>
        ) : null}
        {isCreateOpen ? (
          <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <h4 className="text-lg font-semibold">
                {language === "de" ? "Neuen Kontakt manuell erstellen" : "Create contact manually"}
              </h4>
              <button
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                onClick={() => setIsCreateOpen(false)}
                type="button"
              >
                {language === "de" ? "Schliessen" : "Close"}
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                Name
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("name", event.target.value)}
                  value={newContact.name}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                E-Mail
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("email", event.target.value)}
                  type="email"
                  value={newContact.email ?? ""}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                Telefon
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("phone", event.target.value)}
                  value={newContact.phone ?? ""}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                Rolle
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("role", event.target.value)}
                  value={newContact.role}
                >
                  {roleOptions.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                Quelle
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("source", event.target.value)}
                  value={newContact.source}
                >
                  {sourceOptions.map((source) => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                Projekt
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
                Bedarf
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("intent", event.target.value)}
                  value={newContact.intent}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                Consent
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateNewContact("consent", event.target.value)}
                  value={newContact.consent}
                />
              </label>
            </div>
            <button
              className="mt-4 rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={createContact}
              type="button"
            >
              {language === "de" ? "Kontakt speichern" : "Save contact"}
            </button>
          </div>
        ) : null}
      </article>

      <section className="grid gap-4 xl:grid-cols-[340px_1fr]">
        <article className="rounded-lg border border-stone-200 bg-white p-4">
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
                  onClick={() => setSelectedContactId(contact.id)}
                  type="button"
                >
                  <span className="block break-words font-semibold">{contact.name}</span>
                  <span
                    className={`mt-1 block break-words text-xs ${
                      isSelected ? "text-slate-300" : "text-stone-500"
                    }`}
                  >
                    {contact.role} · {organization?.name ?? copy.noOrganization}
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
                      {contact.source}
                    </span>
                    {lead ? (
                      <span
                        className={`rounded-md px-2 py-1 text-xs font-semibold ${
                          isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                        }`}
                      >
                        Score {lead.score}
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

        <section className="grid gap-4">
          <section className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    {copy.personRecord}
                  </p>
                  <h4 className="mt-1 break-words text-2xl font-semibold">
                    {selectedContact.name}
                  </h4>
                  <p className="mt-1 break-words text-sm text-stone-600">
                    {selectedContact.role} · {selectedContact.source}
                  </p>
                </div>
                {selectedLead ? (
                  <span className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white">
                    {copy.leadScore}: {selectedLead.score}
                  </span>
                ) : null}
              </div>

              <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <h5 className="text-sm font-semibold">
                    {language === "de" ? "Kontakt bearbeiten" : "Edit contact"}
                  </h5>
                  <button
                    className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    onClick={saveSelectedContact}
                    type="button"
                  >
                    {language === "de" ? "Änderungen speichern" : "Save changes"}
                  </button>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    Name
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("name", event.target.value)}
                      value={selectedContact.name}
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    Rolle
                    <select
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("role", event.target.value)}
                      value={selectedContact.role}
                    >
                      {roleOptions.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    E-Mail
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("email", event.target.value)}
                      type="email"
                      value={selectedContact.email ?? ""}
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    Telefon
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("phone", event.target.value)}
                      value={selectedContact.phone ?? ""}
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    Quelle
                    <select
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("source", event.target.value)}
                      value={selectedContact.source}
                    >
                      {sourceOptions.map((source) => (
                        <option key={source} value={source}>
                          {source}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    Bedarf
                    <input
                      className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                      onChange={(event) => updateSelectedContact("intent", event.target.value)}
                      value={selectedContact.intent}
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 md:col-span-2">
                    Consent / Notiz
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
                  <p className="font-semibold text-slate-900">E-Mail</p>
                  <p className="mt-1 break-words text-stone-600">
                    {selectedContact.email ?? "Noch nicht erfasst"}
                  </p>
                </div>
                <div className="rounded-md bg-stone-50 p-3 text-sm">
                  <p className="font-semibold text-slate-900">Telefon</p>
                  <p className="mt-1 break-words text-stone-600">
                    {selectedContact.phone ?? "Noch nicht erfasst"}
                  </p>
                </div>
              </div>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
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
                      {selectedOrganization.lifecycleStage}
                    </span>
                    <span className="rounded-md bg-stone-100 px-2 py-1 font-semibold text-stone-700">
                      {selectedOrganization.type}
                    </span>
                    <span className="rounded-md bg-stone-100 px-2 py-1 font-semibold text-stone-700">
                      {selectedOrganization.city}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                    <div className="rounded-md bg-stone-50 p-3">
                      <p className="font-semibold">{selectedOrganization.openDeals}</p>
                      <p className="text-xs text-stone-500">Open Deals</p>
                    </div>
                    <div className="rounded-md bg-stone-50 p-3">
                      <p className="font-semibold">{selectedOrganization.activeContacts}</p>
                      <p className="text-xs text-stone-500">{copy.people}</p>
                    </div>
                  </div>
                  <p className="mt-4 break-words text-sm text-stone-600">
                    {copy.owner}: {contactOwner?.name ?? "Nicht zugewiesen"}
                  </p>
                </>
              ) : null}
            </article>
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            <article className="rounded-lg border border-stone-200 bg-white p-5">
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

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold">{copy.relationshipMap}</h4>
              <div className="mt-4 space-y-3">
                {selectedRelationships.map((relationship) => (
                  <div className="rounded-md bg-stone-50 p-3" key={relationship.id}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-semibold">{relationship.role}</span>
                      <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">
                        {relationship.influence}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-stone-500">
                      {relationship.isPrimary ? "Primäre Beziehung" : "Weitere Beziehung"}
                    </p>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <h4 className="text-lg font-semibold">{copy.consent}</h4>
              <div className="mt-4 flex flex-wrap gap-2">
                {selectedConsents.map((consent) => (
                  <span
                    className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800"
                    key={consent.id}
                  >
                    {consent.channel}: {consent.status}
                  </span>
                ))}
                {selectedConsents.length === 0 ? (
                  <span className="text-sm text-stone-500">Noch kein Consent erfasst</span>
                ) : null}
              </div>
              <h4 className="mt-5 text-lg font-semibold">{copy.openTasks}</h4>
              <div className="mt-3 space-y-2">
                {selectedTasks.map((task) => (
                  <div className="rounded-md bg-stone-50 p-3 text-sm" key={task.id}>
                    <p className="font-semibold">{task.title}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      {task.due} · {task.priority}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-lg font-semibold">{copy.dataModelMapping}</h4>
                  <p className="mt-1 break-words text-sm text-stone-500">
                    {readyMappingCount}/{dataModelMapping.length} {copy.ready}
                  </p>
                </div>
                <span className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
                  Contact + Company
                </span>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                  <thead className="border-b border-stone-200 text-xs uppercase tracking-[0.12em] text-stone-500">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">Novalure</th>
                      <th className="py-2 pr-3 font-semibold">Wert</th>
                      <th className="py-2 pr-3 font-semibold">Zielfeld</th>
                      <th className="py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {dataModelMapping.map((item) => (
                      <tr key={item.label}>
                        <td className="py-3 pr-3 font-semibold text-slate-900">{item.label}</td>
                        <td className="py-3 pr-3 text-stone-600">
                          {item.novalure ?? "Noch nicht erfasst"}
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
            </article>

            <article className="rounded-lg border border-stone-200 bg-slate-950 p-5 text-white">
              <h4 className="text-lg font-semibold">Datenmodell-Prinzip</h4>
              <div className="mt-4 space-y-3 text-sm text-slate-200">
                <p className="break-words">Personen enthalten Kommunikationsdaten.</p>
                <p className="break-words">Organisationen bündeln Haushalt, Firma oder Bauträger.</p>
                <p className="break-words">Beziehungen erklären Rolle und Einfluss im Deal.</p>
                <p className="break-words">Aktivitäten bilden die Timeline und nächste Aktion.</p>
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


