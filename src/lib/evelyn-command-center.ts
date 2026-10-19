import type { CalendarEvent, CustomerWorkspaceAccess, Lead, Project, Task } from "@/lib/crm-types";
import type { CoreCrmDataKey, CoreCrmModuleSource, CoreCrmModuleSources } from "@/lib/db/crm-loaders";
import { isBusinessKpiRecord } from "@/lib/website-sales-kpi";

export type EvelynCommandSection = "leadInbox" | "tasks" | "calendar" | "projects" | "contacts" | "pipelines" | "knowledge" | "bots" | "customerAccess";
export type EvelynScopeStatus = "ready" | "loading" | "invalid";
export type EvelynMetricState = "ready" | "loading" | "invalid" | "unavailable" | "restricted" | "error";
export type EvelynMetricId = "leads" | "tasks" | "projects" | "calendarEvents" | "customers" | "offers";

/** Inputs have already passed the existing server authorization and selected scope. */
export type EvelynCommandData = {
  leads: readonly Lead[];
  tasks: readonly Task[];
  calendarEvents: readonly CalendarEvent[];
  projects: readonly Project[];
  moduleSources: Partial<CoreCrmModuleSources>;
  moduleErrors?: Partial<Record<CoreCrmDataKey, string>>;
  collectionCompleteness?: "LIMITED";
  scopeStatus: EvelynScopeStatus;
  allowedSections: readonly EvelynCommandSection[];
  customerAccess?: readonly CustomerWorkspaceAccess[];
  /** Customer access is not part of CoreCrmDataResult: its provenance is separate. */
  customerAccessSource?: CoreCrmModuleSource;
  customerAccessError?: string;
};

export type EvelynMetric = {
  id: EvelynMetricId;
  state: EvelynMetricState;
  value?: number;
};

export type EvelynRecordActivity = {
  id: string;
  kind: "lead" | "customer";
  title: string;
  occurredAt: string;
  section: EvelynCommandSection;
};

function businessRecords<T extends object>(records: readonly T[]): T[] {
  return records.filter(record => isBusinessKpiRecord(record as T & { syntheticTest?: boolean }));
}

/** No requests, clock-dependent KPI rules, inferred offers or generated AI activity. */
export function buildEvelynCommandOverview(input: EvelynCommandData) {
  function state(section: EvelynCommandSection, source?: CoreCrmModuleSource, error?: string): EvelynMetricState {
    if (input.scopeStatus !== "ready") return input.scopeStatus;
    if (!input.allowedSections.includes(section)) return "restricted";
    if (error) return "error";
    return source === "database" ? "ready" : "unavailable";
  }
  const states = {
    leads: state("leadInbox", input.moduleSources.leads, input.moduleErrors?.leads),
    tasks: state("tasks", input.moduleSources.tasks, input.moduleErrors?.tasks),
    projects: state("projects", input.moduleSources.projects, input.moduleErrors?.projects),
    calendarEvents: state("calendar", input.moduleSources.calendarEvents, input.moduleErrors?.calendarEvents),
    customers: state("customerAccess", input.customerAccess ? input.customerAccessSource : undefined, input.customerAccessError),
  };
  // A relation to a known synthetic lead cannot become a business KPI in another module.
  const syntheticLeadIds = new Set(input.moduleSources.leads === "database" && !input.moduleErrors?.leads
    ? input.leads.filter(lead => !isBusinessKpiRecord(lead)).map(lead => lead.id)
    : []);
  const leads = states.leads === "ready" ? businessRecords(input.leads) : [];
  const tasks = states.tasks === "ready"
    ? businessRecords(input.tasks).filter(task => !task.leadId || !syntheticLeadIds.has(task.leadId))
    : [];
  const projects = states.projects === "ready" ? businessRecords(input.projects) : [];
  const calendarEvents = states.calendarEvents === "ready"
    ? businessRecords(input.calendarEvents).filter(event => !event.leadId || !syntheticLeadIds.has(event.leadId))
    : [];
  const customers = states.customers === "ready" ? businessRecords(input.customerAccess ?? []) : [];
  const newLeads = leads.filter(lead => lead.status === "Neu");
  const openTasks = tasks.filter(task => task.status === "open");
  const activeProjects = projects.filter(project => project.status === "Aktiv" || project.status === "Skaliert");
  const activeCustomers = customers.filter(customer => customer.status === "active");
  const metrics: EvelynMetric[] = [
    { id: "leads", state: states.leads, ...(states.leads === "ready" ? { value: newLeads.length } : {}) },
    { id: "tasks", state: states.tasks, ...(states.tasks === "ready" ? { value: openTasks.length } : {}) },
    { id: "projects", state: states.projects, ...(states.projects === "ready" ? { value: activeProjects.length } : {}) },
    { id: "calendarEvents", state: states.calendarEvents, ...(states.calendarEvents === "ready" ? { value: calendarEvents.length } : {}) },
    { id: "customers", state: states.customers, ...(states.customers === "ready" ? { value: activeCustomers.length } : {}) },
    // Existing offers are loaded by the per-deal controller, not this collection.
    { id: "offers", state: "unavailable" },
  ];
  const activity: EvelynRecordActivity[] = [
    ...leads.map(lead => ({ id: `lead:${lead.id}`, kind: "lead" as const, title: lead.intent, occurredAt: lead.receivedAt, section: "leadInbox" as const })),
    ...customers.map(customer => ({ id: `customer:${customer.id}`, kind: "customer" as const, title: customer.customerName, occurredAt: customer.lastCustomerActivityAt, section: "customerAccess" as const })),
  ].filter(item => Number.isFinite(Date.parse(item.occurredAt)))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, 5);
  const appointments = calendarEvents.filter(event => Number.isFinite(Date.parse(event.startsAt)))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 3);

  return { metrics, newLeads, openTasks, activeProjects, activeCustomers, activity, appointments, limited: input.collectionCompleteness === "LIMITED" };
}
