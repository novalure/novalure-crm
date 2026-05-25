import type {
  CalendarEvent,
  Contact,
  BrokerMandate,
  BuyerSearchProfile,
  CrmPipeline,
  CrmPipelineStage,
  CrmBot,
  Deal,
  EditorPreflightRun,
  Funnel,
  FunnelStep,
  Lead,
  NewsletterCampaign,
  NewsletterSegment,
  PropertyBuilding,
  ProjectPipelinePermission,
  PropertyReservation,
  PropertyUnit,
  Project,
  Task,
} from "@/lib/crm-types";
import {
  calendarEvents as mockCalendarEvents,
  contacts as mockContacts,
  crmBots as mockCrmBots,
  deals as mockDeals,
  funnelSteps as mockFunnelSteps,
  funnels as mockFunnels,
  leads as mockLeads,
  newsletterCampaigns as mockNewsletterCampaigns,
  newsletterSegments as mockNewsletterSegments,
  propertyBuildings as mockPropertyBuildings,
  propertyReservations as mockPropertyReservations,
  propertyUnits as mockPropertyUnits,
  projects as mockProjects,
  tasks as mockTasks,
} from "@/lib/crm-data";
import { hasDatabaseUrl, queryRows } from "@/lib/db/client";
import { crmTables } from "@/lib/db/schema";
import { defaultLanguage, getLocale } from "@/lib/i18n";

type CoreCrmData = {
  brokerMandates: BrokerMandate[];
  calendarEvents: CalendarEvent[];
  contacts: Contact[];
  buyerSearchProfiles: BuyerSearchProfile[];
  crmBots: CrmBot[];
  crmPipelineStages: CrmPipelineStage[];
  crmPipelines: CrmPipeline[];
  editorPreflightRuns: EditorPreflightRun[];
  leads: Lead[];
  deals: Deal[];
  funnelSteps: FunnelStep[];
  funnels: Funnel[];
  newsletterCampaigns: NewsletterCampaign[];
  newsletterSegments: NewsletterSegment[];
  projectPipelinePermissions: ProjectPipelinePermission[];
  propertyBuildings: PropertyBuilding[];
  propertyReservations: PropertyReservation[];
  propertyUnits: PropertyUnit[];
  projects: Project[];
  tasks: Task[];
};

type TableStatusRow = {
  exists: boolean;
  tableName: string;
};

export type CoreCrmDataKey = keyof CoreCrmData;
export type CoreCrmModuleSource = "database" | "mock" | "fallback";
export type CoreCrmModuleSources = Record<CoreCrmDataKey, CoreCrmModuleSource>;

export type CoreCrmDataResult = CoreCrmData & {
  source: "database" | "mock" | "fallback";
  error?: string;
  missingTables?: string[];
  moduleErrors?: Partial<Record<CoreCrmDataKey, string>>;
  moduleSources: CoreCrmModuleSources;
};

const coreCrmDataKeys = [
  "brokerMandates",
  "calendarEvents",
  "contacts",
  "buyerSearchProfiles",
  "crmPipelineStages",
  "crmPipelines",
  "editorPreflightRuns",
  "crmBots",
  "leads",
  "deals",
  "funnelSteps",
  "funnels",
  "newsletterCampaigns",
  "newsletterSegments",
  "projectPipelinePermissions",
  "propertyBuildings",
  "propertyReservations",
  "propertyUnits",
  "projects",
  "tasks",
] as const satisfies CoreCrmDataKey[];

const coreProductionKeys = [
  "calendarEvents",
  "contacts",
  "leads",
  "deals",
  "projects",
  "tasks",
] as const satisfies CoreCrmDataKey[];

type ContactRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  organizationId: string | null;
  name: string;
  role: Contact["role"];
  project: string | null;
  source: Contact["source"];
  intent: string;
  consent: string;
  email: string | null;
  phone: string | null;
};

type LeadRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  contactId: string | null;
  assignedToUserId: string | null;
  source: Lead["source"];
  type: Lead["type"];
  status: Lead["status"];
  score: number;
  budget: string | null;
  intent: string;
  nextAction: string;
  receivedAt: string | Date;
  slaDueAt: string | Date | null;
  lastContactAt: string | Date | null;
  nextContactAt: string | Date | null;
  region: Lead["region"] | null;
  objectType: Lead["objectType"] | null;
  rooms: number | string | null;
  areaSqm: number | string | null;
  hotStatus: boolean;
  buyerProfile: Lead["buyerProfile"] | null;
  sellerProfile: Lead["sellerProfile"] | null;
  investorProfile: Lead["investorProfile"] | null;
};

type DealRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  contactId: string | null;
  organizationId: string | null;
  ownerUserId: string | null;
  leadId: string | null;
  name: string;
  stage: Deal["stage"];
  valueCents: number | string;
  probability: number;
  expectedCloseDate: string | Date | null;
  lostReasonCategory: Deal["lostReasonCategory"] | null;
  lostReasonDetail: string | null;
  lostAt: string | Date | null;
  closedAt: string | Date | null;
  riskLevel: Deal["riskLevel"];
  source: Deal["source"];
  nextAction: string;
};

type TaskRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  contactId: string | null;
  leadId: string | null;
  title: string;
  project: string | null;
  due: string | Date | null;
  priority: Task["priority"];
  status: Task["status"];
};

type CalendarEventRow = {
  contactId: string | null;
  endsAt: string | Date;
  id: string;
  leadId: string | null;
  location: string;
  metadata: unknown;
  outcomeGoal: string;
  ownerUserId: string | null;
  preparation: unknown;
  projectId: string | null;
  startsAt: string | Date;
  status: string;
  teamsJoinUrl: string | null;
  title: string;
  workspaceId: string;
};

type ProjectRow = {
  customerType: Project["customerType"] | null;
  defaultOperatingModel: Project["defaultOperatingModel"] | null;
  defaultPipelineId: string | null;
  id: string;
  leads: number | string;
  revenueCents: number | string;
  setupDefaults: Project["setupDefaults"] | null;
  status: Project["status"];
  type: string;
  name: string;
  workspaceId: string;
};

type BrokerMandateRow = {
  address: string;
  areaSqm: number | string | null;
  askingPriceCents: number | string | null;
  commissionRate: number | string | null;
  condition: string | null;
  contactId: string | null;
  documentsStatus: string | null;
  expiringBrokerContractAt: string | Date | null;
  id: string;
  location: string | null;
  mandateStatus: string;
  mandateType: string | null;
  marketValueCents: number | string | null;
  marketingStatus: string | null;
  metadata: Record<string, unknown> | null;
  motivation: string | null;
  projectId: string | null;
  propertyType: BrokerMandate["propertyType"] | null;
  rooms: number | string | null;
  sellerLeadId: string | null;
  sellingReason: string | null;
  sellingTimeline: string | null;
  title: string;
  updatedAt: string | Date;
  workspaceId: string;
  yearBuilt: number | string | null;
};

type BuyerSearchProfileRow = {
  areaSqm: number | string | null;
  budgetFromCents: number | string | null;
  budgetToCents: number | string | null;
  buyerLeadId: string | null;
  contactId: string | null;
  desiredLocation: string | null;
  financingStatus: BuyerSearchProfile["financingStatus"] | null;
  id: string;
  matchingStatus: string;
  metadata: Record<string, unknown> | null;
  mustHaveCriteria: string[] | null;
  niceToHaveCriteria: string[] | null;
  projectId: string | null;
  propertyType: BuyerSearchProfile["propertyType"] | null;
  purchaseTimeline: string | null;
  rooms: number | string | null;
  title: string;
  updatedAt: string | Date;
  workspaceId: string;
};

type CrmPipelineRow = {
  customerType: CrmPipeline["customerType"] | null;
  id: string;
  isDefault: boolean;
  key: string;
  metadata: Record<string, unknown> | null;
  name: string;
  operatingModel: CrmPipeline["operatingModel"] | null;
  projectId: string | null;
  purpose: string;
  workspaceId: string;
};

type CrmPipelineStageRow = {
  category: string;
  id: string;
  key: string;
  metadata: Record<string, unknown> | null;
  name: string;
  pipelineId: string;
  position: number | string;
  probability: number | string;
  projectId: string | null;
  slaHours: number | string | null;
  workspaceId: string;
};

type ProjectPipelinePermissionRow = {
  canCloseDeals: boolean;
  canEditDeals: boolean;
  canMoveDeals: boolean;
  canReopenDeals: boolean;
  id: string;
  metadata: Record<string, unknown> | null;
  productRole: ProjectPipelinePermission["productRole"] | null;
  projectId: string;
  updatedAt: string | Date;
  userEmail: string | null;
  userId: string;
  userName: string | null;
  userRole: ProjectPipelinePermission["userRole"] | null;
  workspaceId: string;
};

type EditorPreflightRunRow = {
  blockers: string[] | null;
  checks: EditorPreflightRun["checks"] | null;
  createdAt: string | Date;
  editorType: EditorPreflightRun["editorType"];
  entityId: string | null;
  id: string;
  metadata: Record<string, unknown> | null;
  projectId: string | null;
  status: EditorPreflightRun["status"];
  warnings: string[] | null;
  workspaceId: string;
};

type PropertyBuildingRow = {
  address: string;
  completionDate: string | Date | null;
  floors: number | string;
  id: string;
  name: string;
  projectId: string;
  workspaceId: string;
};

type PropertyUnitRow = {
  areaSqm: number | string;
  buildingId: string | null;
  buyerContactId: string | null;
  dealId: string | null;
  floor: number | string;
  id: string;
  priceCents: number | string;
  projectId: string;
  reservationId: string | null;
  rooms: number | string;
  status: string;
  unitNumber: string;
  updatedAt: string | Date;
  workspaceId: string;
};

type PropertyReservationRow = {
  contactId: string;
  contractMilestone: string;
  dealId: string | null;
  depositCents: number | string;
  expiresAt: string | Date;
  id: string;
  nextAction: string;
  projectId: string;
  status: string;
  unitId: string;
  workspaceId: string;
};

type FunnelRow = {
  audience: Funnel["audience"];
  conversionRate: number | string;
  entryChannel: Funnel["entryChannel"];
  goal: string;
  id: string;
  leads: number | string;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  status: Funnel["status"];
  visits: number | string;
  workspaceId: string;
};

type FunnelStepRow = {
  botRuleId: string | null;
  channel: FunnelStep["channel"];
  conversionRate: number | string;
  dropOffReason: string;
  funnelId: string;
  id: string;
  leads: number | string;
  name: string;
  nextOptimization: string;
  projectId: string | null;
  status: FunnelStep["status"];
  visits: number | string;
  workspaceId: string;
};

type NewsletterSegmentRow = {
  audience: NewsletterSegment["audience"];
  contacts: number | string;
  health: NewsletterSegment["health"];
  id: string;
  language: NewsletterSegment["language"];
  name: string;
  optIns: number | string;
  projectId: string | null;
  resendAudienceId: string | null;
  rules: unknown;
  source: NewsletterSegment["source"];
  workspaceId: string;
};

type NewsletterCampaignRow = {
  contentBlocks: unknown;
  goal: string;
  id: string;
  metrics: unknown;
  name: string;
  previewText: string;
  projectId: string | null;
  recipients: number | string;
  segmentId: string | null;
  sendAt: string | Date | null;
  status: NewsletterCampaign["status"];
  subject: string;
  workspaceId: string;
};

type CrmBotRow = {
  audience: string;
  brandVoice: string;
  config: unknown;
  createdAt: string | Date;
  description: string;
  id: string;
  language: CrmBot["language"];
  model: string;
  name: string;
  projectId: string | null;
  role: CrmBot["role"];
  status: CrmBot["status"];
  strictKnowledge: boolean;
  tone: string;
  answerLength: CrmBot["answerLength"];
  updatedAt: string | Date;
  workspaceId: string;
};

export function getMockCoreCrmData(): CoreCrmDataResult {
  return {
    source: "mock",
    moduleSources: createModuleSources("mock"),
    brokerMandates: [],
    buyerSearchProfiles: [],
    calendarEvents: mockCalendarEvents,
    contacts: mockContacts,
    crmPipelineStages: [],
    crmPipelines: [],
    editorPreflightRuns: [],
    crmBots: mockCrmBots,
    leads: mockLeads,
    deals: mockDeals,
    funnelSteps: mockFunnelSteps,
    funnels: mockFunnels,
    newsletterCampaigns: mockNewsletterCampaigns,
    newsletterSegments: mockNewsletterSegments,
    projectPipelinePermissions: [],
    propertyBuildings: mockPropertyBuildings,
    propertyReservations: mockPropertyReservations,
    propertyUnits: mockPropertyUnits,
    projects: mockProjects,
    tasks: mockTasks,
  };
}

export async function getCoreCrmData(workspaceId?: string): Promise<CoreCrmDataResult> {
  if (!hasDatabaseUrl()) {
    return getMockCoreCrmData();
  }

  const moduleResults = await Promise.all([
    loadModule("brokerMandates", () => loadBrokerMandates(workspaceId), []),
    loadModule("buyerSearchProfiles", () => loadBuyerSearchProfiles(workspaceId), []),
    loadModule("calendarEvents", () => loadCalendarEvents(workspaceId), mockCalendarEvents),
    loadModule("contacts", () => loadContacts(workspaceId), mockContacts),
    loadModule("crmPipelineStages", () => loadCrmPipelineStages(workspaceId), []),
    loadModule("crmPipelines", () => loadCrmPipelines(workspaceId), []),
    loadModule("editorPreflightRuns", () => loadEditorPreflightRuns(workspaceId), []),
    loadModule("leads", () => loadLeads(workspaceId), mockLeads),
    loadModule("deals", () => loadDeals(workspaceId), mockDeals),
    loadModule("tasks", () => loadTasks(workspaceId), mockTasks),
    loadModule("projects", () => loadProjects(workspaceId), mockProjects),
    loadModule("funnels", () => loadFunnels(workspaceId), mockFunnels),
    loadModule("funnelSteps", () => loadFunnelSteps(workspaceId), mockFunnelSteps),
    loadModule("newsletterSegments", () => loadNewsletterSegments(workspaceId), mockNewsletterSegments),
    loadModule("newsletterCampaigns", () => loadNewsletterCampaigns(workspaceId), mockNewsletterCampaigns),
    loadModule("projectPipelinePermissions", () => loadProjectPipelinePermissions(workspaceId), []),
    loadModule("crmBots", () => loadCrmBots(workspaceId), mockCrmBots),
    loadModule("propertyBuildings", () => loadPropertyBuildings(workspaceId), mockPropertyBuildings),
    loadModule("propertyUnits", () => loadPropertyUnits(workspaceId), mockPropertyUnits),
    loadModule("propertyReservations", () => loadPropertyReservations(workspaceId), mockPropertyReservations),
  ]);

  const data = {} as CoreCrmData;
  const moduleSources = createModuleSources("fallback");
  const moduleErrors: Partial<Record<CoreCrmDataKey, string>> = {};
  const missingTables = new Set<string>();

  for (const result of moduleResults) {
    data[result.key] = result.data as never;
    moduleSources[result.key] = result.source;
    if (result.error) moduleErrors[result.key] = result.error;
    if (result.missingTable) missingTables.add(result.missingTable);
  }

  try {
    const schemaMissingTables = await listMissingExpectedTables();
    for (const tableName of schemaMissingTables) {
      missingTables.add(tableName);
    }
  } catch {
    // Core data should still render if the broad readiness check cannot run.
  }

  if (moduleSources.propertyUnits === "database" && moduleSources.propertyReservations === "database") {
    data.propertyUnits = attachReservationIds(data.propertyUnits, data.propertyReservations);
  }

  const hasDatabaseCore = coreProductionKeys.some((key) => moduleSources[key] === "database");
  const hasAnyError = Object.keys(moduleErrors).length > 0;

  return {
    ...data,
    error: hasAnyError ? Object.values(moduleErrors).join("; ") : undefined,
    missingTables: Array.from(missingTables).sort(),
    moduleErrors,
    moduleSources,
    source: hasDatabaseCore ? "database" : "fallback",
  };
}

async function listMissingExpectedTables() {
  const tableStatus = await queryRows<TableStatusRow>(
    `
      select
        expected.table_name as "tableName",
        (t.table_name is not null) as "exists"
      from unnest($1::text[]) as expected(table_name)
      left join information_schema.tables t
        on t.table_schema = 'public'
       and t.table_name = expected.table_name
      order by expected.table_name
    `,
    [[...crmTables]],
  );

  return tableStatus.filter((table) => !table.exists).map((table) => table.tableName);
}

function createModuleSources(source: CoreCrmModuleSource): CoreCrmModuleSources {
  return coreCrmDataKeys.reduce((sources, key) => {
    sources[key] = source;
    return sources;
  }, {} as CoreCrmModuleSources);
}

async function loadModule<Key extends CoreCrmDataKey>(
  key: Key,
  loader: () => Promise<CoreCrmData[Key]>,
  fallback: CoreCrmData[Key],
): Promise<{
  data: CoreCrmData[Key];
  error?: string;
  key: Key;
  missingTable?: string;
  source: CoreCrmModuleSource;
}> {
  try {
    return {
      data: await loader(),
      key,
      source: "database",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database module loader failed";
    return {
      data: fallback,
      error: message,
      key,
      missingTable: extractMissingRelation(message),
      source: "fallback",
    };
  }
}

function extractMissingRelation(message: string) {
  const match = message.match(/relation "([^"]+)" does not exist/i);
  return match?.[1];
}

function attachReservationIds(units: PropertyUnit[], reservations: PropertyReservation[]) {
  const activeReservationByUnit = new Map<string, string>();
  reservations
    .filter((reservation) => reservation.status === "hold" || reservation.status === "reserved")
    .sort((left, right) => new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime())
    .forEach((reservation) => {
      if (!activeReservationByUnit.has(reservation.unitId)) {
        activeReservationByUnit.set(reservation.unitId, reservation.id);
      }
    });

  return units.map((unit) => ({
    ...unit,
    reservationId: unit.reservationId ?? activeReservationByUnit.get(unit.id),
  }));
}

export async function loadProjects(workspaceId?: string): Promise<Project[]> {
  const rows = await queryRows<ProjectRow>(
    `
    select
      p.id,
      p.workspace_id as "workspaceId",
      p.name,
      p.type,
      p.status,
      p.customer_type as "customerType",
      p.default_operating_model as "defaultOperatingModel",
      p.default_pipeline_id as "defaultPipelineId",
      p.setup_defaults as "setupDefaults",
      count(distinct l.id)::int as leads,
      coalesce(sum(case when d.stage not in ('Gewonnen', 'Verloren', 'Disqualifiziert') then d.value_cents else 0 end), 0) as "revenueCents"
    from projects p
    left join leads l on l.project_id = p.id and l.workspace_id = p.workspace_id
    left join deals d on d.project_id = p.id and d.workspace_id = p.workspace_id
    ${workspaceId ? "where p.workspace_id = $1" : ""}
    group by p.id
    order by p.created_at asc
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    customerType: row.customerType ?? undefined,
    defaultOperatingModel: row.defaultOperatingModel ?? undefined,
    defaultPipelineId: row.defaultPipelineId ?? "",
    id: row.id,
    leads: Number(row.leads ?? 0),
    name: row.name,
    revenue: formatEuroFromCents(row.revenueCents),
    setupDefaults: row.setupDefaults ?? undefined,
    status: row.status,
    type: row.type,
    workspaceId: row.workspaceId,
  }));
}

export async function loadBrokerMandates(workspaceId?: string): Promise<BrokerMandate[]> {
  const rows = await queryRows<BrokerMandateRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      seller_lead_id as "sellerLeadId",
      contact_id as "contactId",
      title,
      address,
      location,
      property_type as "propertyType",
      condition,
      area_sqm as "areaSqm",
      rooms,
      year_built as "yearBuilt",
      asking_price_cents as "askingPriceCents",
      market_value_cents as "marketValueCents",
      selling_timeline as "sellingTimeline",
      motivation,
      selling_reason as "sellingReason",
      mandate_status as "mandateStatus",
      mandate_type as "mandateType",
      commission_rate as "commissionRate",
      documents_status as "documentsStatus",
      marketing_status as "marketingStatus",
      expiring_broker_contract_at as "expiringBrokerContractAt",
      metadata,
      updated_at as "updatedAt"
    from broker_mandates
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by updated_at desc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    address: row.address,
    areaSqm: toOptionalNumber(row.areaSqm),
    askingPrice: centsToNumber(row.askingPriceCents),
    commissionRate: toOptionalNumber(row.commissionRate),
    condition: row.condition ?? undefined,
    contactId: row.contactId ?? undefined,
    documentsStatus: row.documentsStatus ?? undefined,
    expiringBrokerContractAt: toOptionalIso(row.expiringBrokerContractAt),
    id: row.id,
    location: row.location ?? undefined,
    mandateStatus: row.mandateStatus,
    mandateType: row.mandateType ?? undefined,
    marketValue: centsToNumber(row.marketValueCents),
    marketingStatus: row.marketingStatus ?? undefined,
    metadata: row.metadata ?? undefined,
    motivation: row.motivation ?? undefined,
    projectId: row.projectId ?? undefined,
    propertyType: row.propertyType ?? undefined,
    rooms: toOptionalNumber(row.rooms),
    sellerLeadId: row.sellerLeadId ?? undefined,
    sellingReason: row.sellingReason ?? undefined,
    sellingTimeline: row.sellingTimeline ?? undefined,
    title: row.title,
    updatedAt: toIso(row.updatedAt),
    workspaceId: row.workspaceId,
    yearBuilt: toOptionalNumber(row.yearBuilt),
  }));
}

export async function loadBuyerSearchProfiles(workspaceId?: string): Promise<BuyerSearchProfile[]> {
  const rows = await queryRows<BuyerSearchProfileRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      buyer_lead_id as "buyerLeadId",
      contact_id as "contactId",
      title,
      budget_from_cents as "budgetFromCents",
      budget_to_cents as "budgetToCents",
      financing_status as "financingStatus",
      desired_location as "desiredLocation",
      property_type as "propertyType",
      rooms,
      area_sqm as "areaSqm",
      must_have_criteria as "mustHaveCriteria",
      nice_to_have_criteria as "niceToHaveCriteria",
      purchase_timeline as "purchaseTimeline",
      matching_status as "matchingStatus",
      metadata,
      updated_at as "updatedAt"
    from buyer_search_profiles
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by updated_at desc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    areaSqm: toOptionalNumber(row.areaSqm),
    budgetFrom: centsToNumber(row.budgetFromCents),
    budgetTo: centsToNumber(row.budgetToCents),
    buyerLeadId: row.buyerLeadId ?? undefined,
    contactId: row.contactId ?? undefined,
    desiredLocation: row.desiredLocation ?? undefined,
    financingStatus: row.financingStatus ?? undefined,
    id: row.id,
    matchingStatus: row.matchingStatus,
    metadata: row.metadata ?? undefined,
    mustHaveCriteria: row.mustHaveCriteria ?? [],
    niceToHaveCriteria: row.niceToHaveCriteria ?? [],
    projectId: row.projectId ?? undefined,
    propertyType: row.propertyType ?? undefined,
    purchaseTimeline: row.purchaseTimeline ?? undefined,
    rooms: toOptionalNumber(row.rooms),
    title: row.title,
    updatedAt: toIso(row.updatedAt),
    workspaceId: row.workspaceId,
  }));
}

export async function loadCrmPipelines(workspaceId?: string): Promise<CrmPipeline[]> {
  const rows = await queryRows<CrmPipelineRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      customer_type as "customerType",
      operating_model as "operatingModel",
      key,
      name,
      purpose,
      is_default as "isDefault",
      metadata
    from crm_pipelines
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by is_default desc, created_at asc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    customerType: row.customerType ?? undefined,
    id: row.id,
    isDefault: row.isDefault,
    key: row.key,
    metadata: row.metadata ?? undefined,
    name: row.name,
    operatingModel: row.operatingModel ?? undefined,
    projectId: row.projectId ?? undefined,
    purpose: row.purpose,
    workspaceId: row.workspaceId,
  }));
}

export async function loadCrmPipelineStages(workspaceId?: string): Promise<CrmPipelineStage[]> {
  const rows = await queryRows<CrmPipelineStageRow>(
    `
    select
      id,
      pipeline_id as "pipelineId",
      workspace_id as "workspaceId",
      project_id as "projectId",
      key,
      name,
      position,
      probability,
      category,
      sla_hours as "slaHours",
      metadata
    from crm_pipeline_stages
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by pipeline_id asc, position asc
    limit 1000
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    category: row.category,
    id: row.id,
    key: row.key,
    metadata: row.metadata ?? undefined,
    name: row.name,
    pipelineId: row.pipelineId,
    position: Number(row.position),
    probability: Number(row.probability),
    projectId: row.projectId ?? undefined,
    slaHours: toOptionalNumber(row.slaHours),
    workspaceId: row.workspaceId,
  }));
}

export async function loadProjectPipelinePermissions(workspaceId?: string): Promise<ProjectPipelinePermission[]> {
  const rows = await queryRows<ProjectPipelinePermissionRow>(
    `
    select
      p.id,
      p.workspace_id as "workspaceId",
      p.project_id as "projectId",
      p.user_id as "userId",
      wu.name as "userName",
      wu.email as "userEmail",
      wu.role as "userRole",
      wu.product_role as "productRole",
      p.can_edit_deals as "canEditDeals",
      p.can_move_deals as "canMoveDeals",
      p.can_close_deals as "canCloseDeals",
      p.can_reopen_deals as "canReopenDeals",
      p.metadata,
      p.updated_at as "updatedAt"
    from project_pipeline_permissions p
    left join workspace_users wu
      on wu.id = p.user_id
     and wu.workspace_id = p.workspace_id
    ${workspaceId ? "where p.workspace_id = $1" : ""}
    order by p.project_id asc, coalesce(wu.name, wu.email, p.user_id::text) asc
    limit 1000
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    canCloseDeals: row.canCloseDeals,
    canEditDeals: row.canEditDeals,
    canMoveDeals: row.canMoveDeals,
    canReopenDeals: row.canReopenDeals,
    id: row.id,
    metadata: row.metadata ?? undefined,
    productRole: row.productRole ?? undefined,
    projectId: row.projectId,
    updatedAt: toIso(row.updatedAt),
    userEmail: row.userEmail ?? undefined,
    userId: row.userId,
    userName: row.userName ?? undefined,
    userRole: row.userRole ?? undefined,
    workspaceId: row.workspaceId,
  }));
}

export async function loadEditorPreflightRuns(workspaceId?: string): Promise<EditorPreflightRun[]> {
  const rows = await queryRows<EditorPreflightRunRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      editor_type as "editorType",
      entity_id as "entityId",
      status,
      checks,
      blockers,
      warnings,
      metadata,
      created_at as "createdAt"
    from editor_preflight_runs
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by created_at desc
    limit 100
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    blockers: row.blockers ?? [],
    checks: row.checks ?? [],
    createdAt: toIso(row.createdAt),
    editorType: row.editorType,
    entityId: row.entityId ?? undefined,
    id: row.id,
    metadata: row.metadata ?? undefined,
    projectId: row.projectId ?? undefined,
    status: row.status,
    warnings: row.warnings ?? [],
    workspaceId: row.workspaceId,
  }));
}

export async function loadPropertyBuildings(workspaceId?: string): Promise<PropertyBuilding[]> {
  const rows = await queryRows<PropertyBuildingRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      name,
      address,
      completion_date as "completionDate",
      floors
    from property_buildings
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by name asc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    address: row.address,
    completionDate: toDateOnly(row.completionDate),
    floors: Number(row.floors ?? 0),
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
  }));
}

export async function loadPropertyUnits(workspaceId?: string): Promise<PropertyUnit[]> {
  const rows = await queryRows<PropertyUnitRow>(
    `
    select
      pu.id,
      pu.workspace_id as "workspaceId",
      pu.project_id as "projectId",
      pu.building_id as "buildingId",
      pu.unit_number as "unitNumber",
      pu.floor,
      pu.rooms,
      pu.area_sqm as "areaSqm",
      pu.price_cents as "priceCents",
      pu.status,
      pu.buyer_contact_id as "buyerContactId",
      pu.deal_id as "dealId",
      null::uuid as "reservationId",
      pu.updated_at as "updatedAt"
    from property_units pu
    ${workspaceId ? "where pu.workspace_id = $1" : ""}
    order by pu.project_id, pu.unit_number asc
    limit 2000
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    areaSqm: Number(row.areaSqm ?? 0),
    buildingId: row.buildingId ?? "",
    buyerContactId: row.buyerContactId ?? undefined,
    dealId: row.dealId ?? undefined,
    floor: Number(row.floor ?? 0),
    id: row.id,
    priceCents: Number(row.priceCents ?? 0),
    projectId: row.projectId,
    reservationId: row.reservationId ?? undefined,
    rooms: Number(row.rooms ?? 0),
    status: normalizePropertyUnitStatus(row.status),
    unitNumber: row.unitNumber,
    updatedAt: toIso(row.updatedAt),
    workspaceId: row.workspaceId,
  }));
}

export async function loadPropertyReservations(workspaceId?: string): Promise<PropertyReservation[]> {
  const rows = await queryRows<PropertyReservationRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      unit_id as "unitId",
      contact_id as "contactId",
      deal_id as "dealId",
      status,
      expires_at as "expiresAt",
      deposit_cents as "depositCents",
      contract_milestone as "contractMilestone",
      next_action as "nextAction"
    from property_reservations
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by expires_at asc
    limit 2000
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    contactId: row.contactId,
    contractMilestone: normalizeContractMilestone(row.contractMilestone),
    dealId: row.dealId ?? undefined,
    depositCents: Number(row.depositCents ?? 0),
    expiresAt: toIso(row.expiresAt),
    id: row.id,
    nextAction: row.nextAction,
    projectId: row.projectId,
    status: normalizePropertyReservationStatus(row.status),
    unitId: row.unitId,
    workspaceId: row.workspaceId,
  }));
}

export async function loadFunnels(workspaceId?: string): Promise<Funnel[]> {
  const rows = await queryRows<FunnelRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      owner_user_id as "ownerUserId",
      name,
      goal,
      audience,
      entry_channel as "entryChannel",
      status,
      visits,
      leads_count as leads,
      conversion_rate as "conversionRate"
    from funnels
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by updated_at desc
    limit 250
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    audience: row.audience,
    conversionRate: Number(row.conversionRate ?? 0),
    entryChannel: row.entryChannel,
    goal: row.goal,
    id: row.id,
    leads: Number(row.leads ?? 0),
    name: row.name,
    ownerUserId: row.ownerUserId ?? undefined,
    projectId: row.projectId ?? "",
    status: row.status,
    visits: Number(row.visits ?? 0),
    workspaceId: row.workspaceId,
  }));
}

export async function loadFunnelSteps(workspaceId?: string): Promise<FunnelStep[]> {
  const rows = await queryRows<FunnelStepRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      funnel_id as "funnelId",
      name,
      channel,
      status,
      visits,
      leads_count as leads,
      conversion_rate as "conversionRate",
      drop_off_reason as "dropOffReason",
      next_optimization as "nextOptimization",
      bot_rule_id as "botRuleId"
    from funnel_steps
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by funnel_id, position asc, created_at asc
    limit 1000
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    botRuleId: row.botRuleId ?? undefined,
    channel: row.channel,
    conversionRate: Number(row.conversionRate ?? 0),
    dropOffReason: row.dropOffReason,
    funnelId: row.funnelId,
    id: row.id,
    leads: Number(row.leads ?? 0),
    name: row.name,
    nextOptimization: row.nextOptimization,
    projectId: row.projectId ?? "",
    status: row.status,
    visits: Number(row.visits ?? 0),
    workspaceId: row.workspaceId,
  }));
}

export async function loadNewsletterSegments(workspaceId?: string): Promise<NewsletterSegment[]> {
  const rows = await queryRows<NewsletterSegmentRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      name,
      audience,
      language,
      source,
      contacts_count as contacts,
      opt_ins as "optIns",
      health,
      rules,
      null::text as "resendAudienceId"
    from newsletter_segments
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by updated_at desc
    limit 250
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    audience: row.audience,
    contacts: Number(row.contacts ?? 0),
    health: row.health,
    id: row.id,
    language: row.language,
    name: row.name,
    optIns: Number(row.optIns ?? 0),
    projectId: row.projectId ?? undefined,
    resendAudienceId: row.resendAudienceId ?? undefined,
    rules: normalizeRules(row.rules),
    source: row.source,
    workspaceId: row.workspaceId,
  }));
}

export async function loadNewsletterCampaigns(workspaceId?: string): Promise<NewsletterCampaign[]> {
  const rows = await queryRows<NewsletterCampaignRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      segment_id as "segmentId",
      name,
      subject,
      preview_text as "previewText",
      status,
      goal,
      recipients,
      send_at as "sendAt",
      metrics,
      content_blocks as "contentBlocks"
    from newsletter_campaigns
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by updated_at desc
    limit 250
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => {
    const metrics = asRecord(row.metrics);

    return {
      bounceRate: optionalNumber(metrics.bounceRate),
      clickRate: optionalNumber(metrics.clickRate),
      contentBlocks: normalizeRules(row.contentBlocks),
      goal: row.goal,
      id: row.id,
      name: row.name,
      openRate: optionalNumber(metrics.openRate),
      previewText: row.previewText,
      projectId: row.projectId ?? undefined,
      recipients: Number(row.recipients ?? 0),
      segmentId: row.segmentId ?? "",
      sendAt: toOptionalIso(row.sendAt),
      status: row.status,
      subject: row.subject,
      unsubscribeRate: optionalNumber(metrics.unsubscribeRate),
      workspaceId: row.workspaceId,
    };
  });
}

export async function loadCrmBots(workspaceId?: string): Promise<CrmBot[]> {
  const rows = await queryRows<CrmBotRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      name,
      description,
      role,
      status,
      model,
      strict_knowledge as "strictKnowledge",
      audience,
      language,
      tone,
      answer_length as "answerLength",
      brand_voice as "brandVoice",
      config,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from bots
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by updated_at desc
    limit 100
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => {
    const config = asRecord(row.config);

    return {
      actionPolicies: Array.isArray(config.actionPolicies) ? config.actionPolicies as CrmBot["actionPolicies"] : [],
      answerLength: row.answerLength,
      audience: row.audience,
      brandVoice: row.brandVoice,
      channels: Array.isArray(config.channels) ? config.channels as CrmBot["channels"] : [],
      createdAt: toIso(row.createdAt),
      description: row.description,
      documentLibrary: Array.isArray(config.documentLibrary) ? config.documentLibrary as CrmBot["documentLibrary"] : [],
      id: row.id,
      language: row.language,
      modelConfig: asBotModelConfig(config.modelConfig, row.model),
      name: row.name,
      projectId: row.projectId ?? undefined,
      role: row.role,
      setupChecklist: Array.isArray(config.setupChecklist) ? config.setupChecklist as CrmBot["setupChecklist"] : [],
      status: row.status,
      strictKnowledge: row.strictKnowledge,
      tone: row.tone,
      tools: Array.isArray(config.tools) ? config.tools as CrmBot["tools"] : [],
      updatedAt: toIso(row.updatedAt),
      workspaceId: row.workspaceId,
    };
  });
}

export async function loadCalendarEvents(workspaceId?: string): Promise<CalendarEvent[]> {
  const rows = await queryRows<CalendarEventRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      contact_id as "contactId",
      lead_id as "leadId",
      owner_user_id as "ownerUserId",
      title,
      starts_at as "startsAt",
      ends_at as "endsAt",
      location,
      status,
      preparation,
      outcome_goal as "outcomeGoal",
      teams_join_url as "teamsJoinUrl",
      metadata
    from calendar_events
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by starts_at asc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => {
    const metadata = asRecord(row.metadata);

    return {
      calendarProvider: getCalendarProviderFromMetadata(metadata),
      contactId: row.contactId ?? undefined,
      endsAt: toIso(row.endsAt),
      externalCalendarId:
        typeof metadata.externalCalendarId === "string" ? metadata.externalCalendarId : undefined,
      googleMeetJoinUrl:
        typeof metadata.googleMeetJoinUrl === "string" ? metadata.googleMeetJoinUrl : undefined,
      id: row.id,
      leadId: row.leadId ?? undefined,
      location: normalizeCalendarLocation(row.location),
      meetingProvider: getMeetingProviderFromMetadata(metadata),
      outcomeGoal: row.outcomeGoal,
      ownerUserId: row.ownerUserId ?? undefined,
      preparation: normalizeStringArray(row.preparation),
      projectId: row.projectId ?? "",
      startsAt: toIso(row.startsAt),
      status: normalizeCalendarStatus(row.status),
      teamsJoinUrl: row.teamsJoinUrl ?? undefined,
      title: row.title,
      workspaceId: row.workspaceId,
    };
  });
}

export async function loadContacts(workspaceId?: string): Promise<Contact[]> {
  const rows = await queryRows<ContactRow>(
    `
    select
      c.id,
      c.workspace_id as "workspaceId",
      c.project_id as "projectId",
      c.organization_id as "organizationId",
      c.name,
      c.role,
      p.name as project,
      c.source,
      c.intent,
      c.consent_label as consent,
      c.email,
      c.phone
    from contacts c
    left join projects p on p.id = c.project_id and p.workspace_id = c.workspace_id
    ${workspaceId ? "where c.workspace_id = $1 and c.archived_at is null" : "where c.archived_at is null"}
    order by c.updated_at desc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? "",
    organizationId: row.organizationId ?? undefined,
    name: row.name,
    role: row.role,
    project: row.project ?? "",
    source: row.source,
    intent: row.intent,
    consent: row.consent,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
  }));
}

export async function loadLeads(workspaceId?: string): Promise<Lead[]> {
  const rows = await queryRows<LeadRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      contact_id as "contactId",
      assigned_to_user_id as "assignedToUserId",
      source,
      type,
      status,
      score,
      budget,
      intent,
      next_action as "nextAction",
      received_at as "receivedAt",
      sla_due_at as "slaDueAt",
      last_contact_at as "lastContactAt",
      next_contact_at as "nextContactAt",
      region,
      object_type as "objectType",
      rooms,
      area_sqm as "areaSqm",
      hot_status as "hotStatus",
      buyer_profile as "buyerProfile",
      seller_profile as "sellerProfile",
      investor_profile as "investorProfile"
    from leads
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by received_at desc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? "",
    contactId: row.contactId ?? "",
    assignedToUserId: row.assignedToUserId ?? undefined,
    source: row.source,
    type: row.type,
    status: row.status,
    score: Number(row.score),
    budget: row.budget ?? undefined,
    intent: row.intent,
    nextAction: row.nextAction,
    receivedAt: toIso(row.receivedAt),
    slaDueAt: toIso(row.slaDueAt),
    lastContactAt: toOptionalIso(row.lastContactAt),
    nextContactAt: toOptionalIso(row.nextContactAt),
    region: row.region ?? undefined,
    objectType: row.objectType ?? undefined,
    rooms: toOptionalNumber(row.rooms),
    areaSqm: toOptionalNumber(row.areaSqm),
    hotStatus: row.hotStatus,
    buyerProfile: row.buyerProfile ?? undefined,
    sellerProfile: row.sellerProfile ?? undefined,
    investorProfile: row.investorProfile ?? undefined,
  }));
}

export async function loadDeals(workspaceId?: string): Promise<Deal[]> {
  const rows = await queryRows<DealRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      contact_id as "contactId",
      organization_id as "organizationId",
      owner_user_id as "ownerUserId",
      lead_id as "leadId",
      name,
      stage,
      value_cents as "valueCents",
      probability,
      expected_close_date::text as "expectedCloseDate",
      lost_reason_category as "lostReasonCategory",
      lost_reason_detail as "lostReasonDetail",
      lost_at as "lostAt",
      closed_at as "closedAt",
      risk_level as "riskLevel",
      source,
      next_action as "nextAction"
    from deals
    ${workspaceId ? "where workspace_id = $1" : ""}
    order by updated_at desc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? "",
    contactId: row.contactId ?? "",
    organizationId: row.organizationId ?? undefined,
    ownerUserId: row.ownerUserId ?? undefined,
    leadId: row.leadId ?? undefined,
    name: row.name,
    stage: row.stage,
    value: formatEuroFromCents(row.valueCents),
    probability: Number(row.probability),
    expectedCloseDate: toDateOnly(row.expectedCloseDate),
    lostReasonCategory: row.lostReasonCategory ?? undefined,
    lostReasonDetail: row.lostReasonDetail || undefined,
    lostAt: toOptionalIso(row.lostAt),
    closedAt: toOptionalIso(row.closedAt),
    riskLevel: row.riskLevel,
    source: row.source,
    nextAction: row.nextAction,
  }));
}

export async function loadTasks(workspaceId?: string): Promise<Task[]> {
  const rows = await queryRows<TaskRow>(
    `
    select
      t.id,
      t.workspace_id as "workspaceId",
      t.project_id as "projectId",
      t.contact_id as "contactId",
      t.lead_id as "leadId",
      t.title,
      p.name as project,
      t.due_at as due,
      t.priority,
      t.status
    from tasks t
    left join projects p on p.id = t.project_id
    ${workspaceId ? "where t.workspace_id = $1" : ""}
    order by t.due_at asc nulls last, t.created_at desc
    limit 500
  `,
    workspaceId ? [workspaceId] : [],
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? "",
    contactId: row.contactId ?? undefined,
    leadId: row.leadId ?? undefined,
    title: row.title,
    project: row.project ?? "",
    due: toIso(row.due),
    priority: row.priority,
    status: row.status,
  }));
}

function toIso(value: string | Date | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function toOptionalIso(value: string | Date | null) {
  return value ? toIso(value) : undefined;
}

function toDateOnly(value: string | Date | null) {
  if (!value) return "";
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? "";
}

function toOptionalNumber(value: number | string | null) {
  if (value === null || value === undefined || value === "") return undefined;
  return Number(value);
}

function centsToNumber(value: number | string | null) {
  const number = toOptionalNumber(value);
  return number === undefined ? undefined : number / 100;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).filter(Boolean);
}

function normalizePropertyUnitStatus(value: string): PropertyUnit["status"] {
  if (value === "reserved") return "reserved";
  if (value === "sold") return "sold";
  if (value === "blocked") return "blocked";
  return "available";
}

function normalizePropertyReservationStatus(value: string): PropertyReservation["status"] {
  if (value === "reserved") return "reserved";
  if (value === "expired") return "expired";
  if (value === "converted") return "converted";
  return "hold";
}

function normalizeContractMilestone(value: string): PropertyReservation["contractMilestone"] {
  if (value === "offer_sent") return "offer_sent";
  if (value === "financing_check") return "financing_check";
  if (value === "contract_draft") return "contract_draft";
  if (value === "signed") return "signed";
  return "not_started";
}

function asBotModelConfig(value: unknown, model: string): CrmBot["modelConfig"] {
  const config = asRecord(value);

  return {
    costTag: typeof config.costTag === "string" ? config.costTag : "crm-bot",
    fallbackModel: typeof config.fallbackModel === "string" ? config.fallbackModel : model,
    maxSteps: typeof config.maxSteps === "number" ? config.maxSteps : 4,
    primaryModel: typeof config.primaryModel === "string" ? config.primaryModel : model,
    temperature: typeof config.temperature === "number" ? config.temperature : 0.2,
  };
}

function normalizeCalendarLocation(value: string): CalendarEvent["location"] {
  if (value === "Teams") return "Teams";
  if (value === "Google Meet") return "Google Meet";
  if (value === "Vor Ort") return "Vor Ort";
  if (value === "Telefon") return "Telefon";
  return "Extern";
}

function normalizeCalendarStatus(value: string): CalendarEvent["status"] {
  if (value === "vorbereiten") return "vorbereiten";
  if (value === "bestätigt" || value === "bestaetigt") return "bestätigt";
  if (value === "nachfassen") return "nachfassen";
  return "geplant";
}

function getCalendarProviderFromMetadata(
  metadata: Record<string, unknown>,
): CalendarEvent["calendarProvider"] {
  if (metadata.calendarProvider === "google") return "google";
  if (metadata.calendarProvider === "manual") return "manual";
  if (metadata.calendarProvider === "microsoft") return "microsoft";
  return undefined;
}

function getMeetingProviderFromMetadata(
  metadata: Record<string, unknown>,
): CalendarEvent["meetingProvider"] {
  if (metadata.meetingProvider === "google-meet") return "google-meet";
  if (metadata.meetingProvider === "manual-link") return "manual-link";
  if (metadata.meetingProvider === "phone") return "phone";
  if (metadata.meetingProvider === "microsoft-teams") return "microsoft-teams";
  return undefined;
}

function formatEuroFromCents(value: number | string) {
  const cents = Number(value || 0);
  return new Intl.NumberFormat(getLocale(defaultLanguage), {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
