import type { Contact, Lead, Project } from "@/lib/crm-types";

const normalRoleHiddenRecordPatterns = [
  /\bqa\b/i,
  /qa crm audit/i,
  /qa contact db first ui/i,
  /qa date deal/i,
  /qa public lead/i,
  /example\.test/i,
  /\bAUTO-[A-Z0-9-]+/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /\uFFFD/,
  /\u00c3/,
];

export function isVisibleBusinessRecord(values: Array<string | number | null | undefined>) {
  const searchable = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .join(" ");

  return !normalRoleHiddenRecordPatterns.some((pattern) => pattern.test(searchable));
}

type BusinessLead = Pick<
  Lead,
  "workspaceId" | "projectId" | "contactId" | "hasStudioEnquiry" | "intent" | "nextAction" | "source" | "status"
>;
type BusinessContact = Pick<
  Contact,
  "id" | "workspaceId" | "projectId" | "name" | "email" | "phone" | "intent" | "source"
>;

// This presentation filter accepts only rows in the active workspace and its
// available projects. Server authorization and RLS remain authoritative; the
// caller still applies the narrower selected-project scope after this filter.
export function selectVisibleBusinessRecords<L extends BusinessLead, C extends BusinessContact>({
  leads,
  contacts,
  projects,
  workspaceId,
}: {
  leads: readonly L[];
  contacts: readonly C[];
  projects: readonly Pick<Project, "id" | "workspaceId">[];
  workspaceId: string;
}) {
  const projectIds = new Set(
    projects.filter((project) => project.workspaceId === workspaceId).map((project) => project.id),
  );
  const studioLeads = new Set(
    leads.filter(
      (lead) =>
        lead.hasStudioEnquiry === true &&
        lead.workspaceId === workspaceId &&
        projectIds.has(lead.projectId),
    ),
  );
  const studioContactKeys = new Set(
    [...studioLeads].map((lead) => JSON.stringify([lead.projectId, lead.contactId])),
  );

  return {
    leads: leads.filter(
      (lead) =>
        lead.workspaceId === workspaceId &&
        projectIds.has(lead.projectId) &&
        (studioLeads.has(lead) ||
          isVisibleBusinessRecord([lead.intent, lead.nextAction, lead.source, lead.status])),
    ),
    contacts: contacts.filter(
      (contact) =>
        contact.workspaceId === workspaceId &&
        projectIds.has(contact.projectId) &&
        (studioContactKeys.has(JSON.stringify([contact.projectId, contact.id])) ||
          isVisibleBusinessRecord([contact.name, contact.email, contact.phone, contact.intent, contact.source])),
    ),
  };
}
