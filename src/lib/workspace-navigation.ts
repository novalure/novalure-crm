export type WorkspaceNavigationItem = { id: string; label: string };

export type WorkspaceNavigationGroupId =
  | "overview"
  | "contacts"
  | "sales"
  | "properties"
  | "tasks"
  | "calendar"
  | "marketing"
  | "knowledge"
  | "management";

export type WorkspaceNavigationGroup<T extends WorkspaceNavigationItem = WorkspaceNavigationItem> = {
  id: WorkspaceNavigationGroupId;
  label: string;
  items: T[];
  isUtility: boolean;
};

const groupEntries: Record<WorkspaceNavigationGroupId, readonly string[]> = {
  overview: ["dashboard", "dailyQueue", "analytics", "projectAnalytics"],
  contacts: ["contacts", "communication", "buyerProfiles"],
  sales: [
    "leadInbox", "sellerLeads", "buyerLeads", "developerLeads", "studioWebsiteEnquiries",
    "pipelines", "projectPipeline", "deals", "slaCockpit", "demosTrials",
  ],
  properties: ["properties", "objectsMandates", "units", "reservations", "projects", "projectOverview"],
  tasks: ["tasks", "followUpQueue"],
  calendar: ["calendar", "appointments", "consultations"],
  marketing: ["marketing", "funnels", "forms", "newsletter", "sequences"],
  knowledge: ["aiAssistant", "knowledge", "studioKnowledgeAi", "bots", "analysis", "botGovernance"],
  management: [
    "settings", "billing", "aiBillingAdmin", "customerAccess", "customerWorkspaces",
    "customerReport", "customerSuccess", "customerSwitch", "managedService", "onboarding",
    "serviceCockpit", "ticketsSupport", "usersRoles", "workspaces", "dataHygiene",
    "approvals", "auditLog", "systemReleases", "governanceCompliance",
  ],
};

const groupOrder = Object.keys(groupEntries) as WorkspaceNavigationGroupId[];
const entryGroups = new Map(
  groupOrder.flatMap((groupId) => groupEntries[groupId].map((entryId) => [entryId, groupId] as const)),
);

const groupLabels = {
  de: {
    overview: "Übersicht", contacts: "Kontakte", sales: "Vertrieb", properties: "Immobilien & Projekte",
    tasks: "Aufgaben", calendar: "Termine", marketing: "Marketing", knowledge: "Wissen & KI",
    management: "Verwaltung",
  },
  en: {
    overview: "Overview", contacts: "Contacts", sales: "Sales", properties: "Properties & projects",
    tasks: "Tasks", calendar: "Calendar", marketing: "Marketing", knowledge: "Knowledge & AI",
    management: "Management",
  },
  es: {
    overview: "Resumen", contacts: "Contactos", sales: "Ventas", properties: "Inmuebles y proyectos",
    tasks: "Tareas", calendar: "Agenda", marketing: "Marketing", knowledge: "Conocimiento e IA",
    management: "Administración",
  },
};

export function getWorkspaceNavigationGroupId(entryId: string): WorkspaceNavigationGroupId {
  // Future authorized modules remain reachable without adding access to any other module.
  return entryGroups.get(entryId) ?? "management";
}

/** Organizes only the entries already authorized by the workspace; never adds an entry. */
export function getWorkspaceNavigationGroups<T extends WorkspaceNavigationItem>(
  items: readonly T[],
  language: string,
): WorkspaceNavigationGroup<T>[] {
  const labels = language === "de" ? groupLabels.de : language === "es" ? groupLabels.es : groupLabels.en;
  const grouped = new Map<WorkspaceNavigationGroupId, T[]>();
  for (const item of items) {
    const groupId = getWorkspaceNavigationGroupId(item.id);
    const groupItems = grouped.get(groupId) ?? [];
    groupItems.push(item);
    grouped.set(groupId, groupItems);
  }

  return groupOrder.flatMap((groupId) => {
    const groupItems = grouped.get(groupId);
    return groupItems?.length ? [{
      id: groupId,
      label: labels[groupId],
      items: groupItems,
      isUtility: groupId === "management",
    }] : [];
  });
}

/** Clicking the active area preserves its selected page; another area opens its first available page. */
export function getWorkspaceNavigationTarget<T extends WorkspaceNavigationItem>(
  group: WorkspaceNavigationGroup<T>,
  activeId: string,
): T | undefined {
  return group.items.find((item) => item.id === activeId) ?? group.items[0];
}
