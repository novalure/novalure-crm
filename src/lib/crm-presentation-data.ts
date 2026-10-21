import type { CoreCrmDataKey, CoreCrmDataResult } from "@/lib/db/crm-loaders";
import type { CrmSnapshot } from "@/lib/crm-source";

const sectionCollections: Record<string, CoreCrmDataKey[]> = {
  contacts: ["contacts"], leadInbox: ["leads"], projects: ["projects"], tasks: ["tasks"],
  properties: ["projects", "propertyUnits", "propertyBuildings", "sellerListings", "propertyReservations", "brokerMandates", "buyerSearchProfiles", "propertyCostItems", "propertyDocuments", "propertyMedia", "propertyTextBlocks"],
  units: ["propertyUnits"], objectsMandates: ["sellerListings", "brokerMandates"],
  reservations: ["propertyReservations"], pipelines: ["deals", "crmPipelines", "crmPipelineStages"],
  dailyQueue: ["leads", "tasks", "calendarEvents", "contacts", "deals", "projects"], calendar: ["calendarEvents"],
  funnels: ["funnels"], newsletter: ["newsletterCampaigns", "newsletterSegments"],
  forms: ["funnels"], bots: ["crmBots"], analytics: ["leads", "deals"],
};

/** Unknown module data is an unavailable view, never a verified empty collection. */
export function unavailableCrmSectionCollections(data: CoreCrmDataResult, section: string) {
  return (sectionCollections[section] ?? []).filter(key => data.moduleSources[key] !== "database" || Boolean(data.moduleErrors?.[key]));
}

/** View projection only: preserves source/error metadata and server DTO contracts. */
export function selectAuthoritativeCrmPresentation(data: CoreCrmDataResult): CoreCrmDataResult {
  const result = { ...data };
  const collections: CoreCrmDataKey[] = ["brokerMandates", "buyerSearchProfiles", "calendarEvents", "contacts", "crmBots", "crmPipelineStages", "crmPipelines", "editorPreflightRuns", "leads", "deals", "funnelSteps", "funnels", "newsletterCampaigns", "newsletterSegments", "projectPipelinePermissions", "propertyBuildings", "propertyCostItems", "propertyDocuments", "propertyMedia", "propertyReservations", "propertyTextBlocks", "propertyUnits", "projects", "sellerListings", "tasks"];
  for (const key of collections) {
    if (data.moduleSources[key] !== "database" || data.moduleErrors?.[key]) Object.assign(result, { [key]: [] });
  }
  if (data.source !== "database" || sectionCollections.dailyQueue.some(key => data.moduleSources[key] !== "database" || data.moduleErrors?.[key])) {
    result.dailyQueue = { generatedAt: "", sections: [] };
  }
  return result;
}

/** Legacy auxiliary collections have no authorized read adapter in CoreCrmData. */
export const unavailableCrmRelatedData: Pick<CrmSnapshot,
  "automations" | "botCallInsights" | "botLeadWorkflows" | "botLanguageRules" |
  "contactRelationships" | "contactTimeline" | "consents" | "conversations" |
  "crmBotConversations" | "crmBotTools" | "customerWorkspaceAccess" | "knowledgeBase" |
  "leadSequenceEvents" | "leadSequences" | "newsletterAutomations" |
  "newsletterDeliverability" | "newsletterSuppressions" | "newsletterTemplates" |
  "organizations" | "pipeline"
> = {
  automations: [], botCallInsights: [], botLeadWorkflows: [], botLanguageRules: [],
  contactRelationships: [], contactTimeline: [], consents: [], conversations: [],
  crmBotConversations: [], crmBotTools: [], customerWorkspaceAccess: [], knowledgeBase: [],
  leadSequenceEvents: [], leadSequences: [], newsletterAutomations: [],
  newsletterDeliverability: [], newsletterSuppressions: [], newsletterTemplates: [],
  organizations: [], pipeline: [],
};
