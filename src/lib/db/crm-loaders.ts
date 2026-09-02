import type {
  AppSession,
} from "@/lib/auth/session";
import { canUseBrokerProjectEditScope } from "@/lib/broker-flow/access-policy";
import type {
  CalendarEvent,
  Contact,
  BrokerMandate,
  BuyerSearchProfile,
  CrmPipeline,
  CrmPipelineStage,
  CrmBot,
  DailyQueueData,
  Deal,
  EditorPreflightRun,
  Funnel,
  FunnelStep,
  Lead,
  NewsletterCampaign,
  NewsletterSegment,
  PropertyBuilding,
  PropertyCostItem,
  PropertyDocumentItem,
  PropertyMediaItem,
  PropertyPriceVisibility,
  ProjectPipelinePermission,
  PropertyReservation,
  PropertyTextBlock,
  PropertyUnit,
  Project,
  SellerListing,
  Task,
} from "@/lib/crm-types";
import {
  canViewAllWorkspaceContacts,
  getContactVisibilityScope,
  type ContactVisibilityScope,
} from "@/lib/contact-access";
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
  sellerListings as mockSellerListings,
  tasks as mockTasks,
} from "@/lib/crm-data";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { crmTables } from "@/lib/db/schema";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { defaultLanguage, getLocale } from "@/lib/i18n";
import { buildPropertyAssets, type PropertyAssetSummary } from "@/lib/property-department";
import { hasProductCapability, type ProductCapability } from "@/lib/product-model";

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
  propertyCostItems: PropertyCostItem[];
  propertyDocuments: PropertyDocumentItem[];
  propertyMedia: PropertyMediaItem[];
  propertyReservations: PropertyReservation[];
  propertyTextBlocks: PropertyTextBlock[];
  propertyUnits: PropertyUnit[];
  projects: Project[];
  sellerListings: SellerListing[];
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
  dailyQueue: DailyQueueData;
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
  "propertyCostItems",
  "propertyDocuments",
  "propertyMedia",
  "propertyReservations",
  "propertyTextBlocks",
  "propertyUnits",
  "projects",
  "sellerListings",
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
  ownerUserId: string | null;
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
  ownerUserId: string | null;
  title: string;
  metadata: Record<string, unknown> | null;
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
  ownerUserId: string | null;
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
  createdByUserId: string | null;
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

type SellerListingRow = {
  address: string;
  areaSqm: number | string;
  availableFrom: string | Date | null;
  availableFromText: string | null;
  availabilityNote: string | null;
  canonicalPayload: Record<string, unknown> | null;
  city: string | null;
  channelPriceVisibility: Record<string, unknown> | null;
  contactEmail: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactUserId: string | null;
  costsSummary: Record<string, unknown> | null;
  createdAt: string | Date;
  documentStatus: string | null;
  documentSummary: Record<string, unknown> | null;
  energyClass: string | null;
  energyValidUntil: string | Date | null;
  expectedGrossYield: number | string | null;
  externalPortalId: string | null;
  federalState: string | null;
  gdprStatus: string | null;
  id: string;
  internalReference: string | null;
  internalNotes: string | null;
  mandateId: string | null;
  mandateEndsAt: string | Date | null;
  marketValueCents: number | string;
  marketingType: string | null;
  mediaSummary: Record<string, unknown> | null;
  monthlyCostsGrossCents: number | string | null;
  objectType: SellerListing["objectType"];
  objectNumber: string | null;
  openimmoObjectId: string | null;
  ownerContactId: string | null;
  ownerUserId: string | null;
  portalMappingStatus: string | null;
  postalCode: string | null;
  priceVisibility: string | null;
  projectId: string | null;
  propertyStatus: string | null;
  publicPriceCents: number | string | null;
  purchaseAncillaryCostsCents: number | string | null;
  region: SellerListing["region"];
  rentNetCents: number | string | null;
  rentPriceCents: number | string | null;
  rooms: number | string | null;
  sellerLeadId: string | null;
  street: string | null;
  subObjectType: string | null;
  subObjectTypeCustom: string | null;
  targetPriceCents: number | string;
  textSummary: Record<string, unknown> | null;
  title: string;
  unitId: string | null;
  usageType: string | null;
  workspaceId: string;
  yearBuilt: number | string | null;
};

type PropertyTextBlockRow = {
  channel: string;
  content: string;
  createdAt: string | Date;
  id: string;
  metadata: Record<string, unknown> | null;
  position: number | string;
  projectId: string | null;
  propertyId: string | null;
  seoDescription: string | null;
  seoTitle: string | null;
  status: string;
  textKey: string;
  title: string;
  unitId: string | null;
  updatedAt: string | Date;
  visibility: string;
  workspaceId: string;
};

type PropertyCostItemRow = {
  commissionRelevant: boolean;
  costKey: string;
  createdAt: string | Date;
  exposeVisible: boolean;
  groupKey: string;
  id: string;
  internalNote: string | null;
  label: string;
  metadata: Record<string, unknown> | null;
  monthlyGrossCents: number | string;
  monthlyNetCents: number | string;
  monthlyVatCents: number | string;
  oneTimeGrossCents: number | string;
  oneTimeNetCents: number | string;
  oneTimeVatCents: number | string;
  optional: boolean;
  position: number | string;
  projectId: string | null;
  propertyId: string | null;
  unitId: string | null;
  updatedAt: string | Date;
  vatPercent: number | string | null;
  workspaceId: string;
};

type PropertyMediaRow = {
  altText: string | null;
  assetName: string | null;
  category: string;
  createdAt: string | Date;
  id: string;
  isCover: boolean;
  mediaAssetId: string | null;
  mediaType: string;
  metadata: Record<string, unknown> | null;
  mimeType: string | null;
  position: number | string;
  projectId: string | null;
  propertyId: string | null;
  status: string;
  title: string;
  unitId: string | null;
  updatedAt: string | Date;
  visibility: string;
  workspaceId: string;
};

type PropertyDocumentRow = {
  approvedAt: string | Date | null;
  approvedByUserId: string | null;
  assetName: string | null;
  category: string;
  content: Record<string, unknown> | null;
  createdAt: string | Date;
  documentDate: string | Date | null;
  id: string;
  mediaAssetId: string | null;
  metadata: Record<string, unknown> | null;
  mimeType: string | null;
  projectId: string | null;
  propertyId: string | null;
  requiredForPublication: boolean;
  sentAt: string | Date | null;
  status: string;
  title: string;
  unitId: string | null;
  updatedAt: string | Date;
  versionLabel: string | null;
  visibility: string;
  workspaceId: string;
};

type FunnelRow = {
  audience: Funnel["audience"];
  blueprintRevision: number | string;
  conversionRate: number | string;
  entryChannel: Funnel["entryChannel"];
  goal: string;
  id: string;
  leads: number | string;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  status: Funnel["status"];
  updatedAt: string | Date;
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

export type PropertyUnitPaginationOptions = {
  limit?: number;
  offset?: number;
  projectId?: string | null;
  q?: string | null;
  status?: PropertyUnit["status"] | null;
};

export type PropertyUnitPaginationResult = {
  units: PropertyUnit[];
  pagination: {
    hasMore: boolean;
    limit: number;
    nextOffset: number | null;
    offset: number;
    total: number;
  };
  summary: {
    availableUnits: number;
    blockedUnits: number;
    inventoryValueCents: number;
    reservedUnits: number;
    soldUnits: number;
    soldValueCents: number;
    totalSalesValueCents: number;
    totalUnits: number;
  };
};

export type PropertyAssetPaginationOptions = {
  actorUserId?: string | null;
  allowProjectEditGrants?: boolean;
  limit?: number;
  offset?: number;
  projectId?: string | null;
  q?: string | null;
  status?: string | null;
  workspaceWide?: boolean;
};

const actorScopedPropertyKeys = [
  "brokerMandates",
  "buyerSearchProfiles",
  "propertyBuildings",
  "propertyCostItems",
  "propertyDocuments",
  "propertyMedia",
  "propertyReservations",
  "propertyTextBlocks",
  "propertyUnits",
  "sellerListings",
] as const satisfies CoreCrmDataKey[];

type CrmActorVisibilityScope =
  | { kind: "workspace" }
  | {
      allowProjectEditVisibility: boolean;
      kind: "actor";
      userId: string;
    };

type ActorPropertyProjectScope = {
  customerViewProjectIds: ReadonlySet<string>;
  editableProjectIds: ReadonlySet<string>;
  viewableProjectIds: ReadonlySet<string>;
};

function getCrmActorVisibilityScope(session?: AppSession): CrmActorVisibilityScope {
  if (!session || canViewAllWorkspaceContacts(session)) return { kind: "workspace" };
  return {
    allowProjectEditVisibility: canUseBrokerProjectEditScope(session),
    kind: "actor",
    userId: session.userId,
  };
}

export type PropertyAssetPaginationResult = {
  assets: PropertyAssetSummary[];
  pagination: {
    hasMore: boolean;
    limit: number;
    nextOffset: number | null;
    offset: number;
    total: number;
  };
};

class MissingWorkspaceScopeError extends Error {
  constructor(loaderName: string) {
    super(`${loaderName} requires an explicit workspaceId`);
    this.name = "MissingWorkspaceScopeError";
  }
}

function requireWorkspaceId(workspaceId: string | null | undefined, loaderName: string) {
  const scopedWorkspaceId = workspaceId?.trim();
  if (!scopedWorkspaceId) {
    throw new MissingWorkspaceScopeError(loaderName);
  }
  return scopedWorkspaceId;
}

function filterWorkspaceItems<T extends { workspaceId: string }>(items: T[], workspaceId: string) {
  return items.filter((item) => item.workspaceId === workspaceId);
}

async function loadActorPropertyProjectIds(session: AppSession) {
  const rows = await withTenantTransaction(
    { actorId: session.userId, workspaceId: session.workspaceId },
    (transaction) => transaction.query<{ accessKind: "edit" | "view"; projectId: string }>(
      `
        select permission.project_id as "projectId", 'edit'::text as "accessKind"
        from public.project_pipeline_permissions permission
        where permission.workspace_id = $1::uuid
          and permission.user_id = $2::uuid
          and permission.can_edit_deals = true
          and $3::boolean
        union all
        select access.project_id as "projectId", 'view'::text as "accessKind"
        from public.customer_project_access access
        where access.workspace_id = $1::uuid
          and access.user_id = $2::uuid
          and access.status = 'active'
          and access.can_view_project = true
      `,
      [
        session.workspaceId,
        session.userId,
        canUseBrokerProjectEditScope(session),
      ],
    ),
  );

  return {
    customerViewProjectIds: new Set(rows.filter((row) => row.accessKind === "view").map((row) => row.projectId)),
    editableProjectIds: new Set(rows.filter((row) => row.accessKind === "edit").map((row) => row.projectId)),
    viewableProjectIds: new Set(rows.map((row) => row.projectId)),
  };
}

function applyActorPropertyScope(
  data: CoreCrmData,
  session: AppSession,
  projectScope: ActorPropertyProjectScope,
) {
  if (canViewAllWorkspaceContacts(session)) return;

  const actorLeadIds = new Set(
    data.leads
      .filter((lead) => lead.assignedToUserId === session.userId)
      .map((lead) => lead.id),
  );
  const actorContactIds = new Set(data.contacts.map((contact) => contact.id));
  const directlyVisibleListings = data.sellerListings.filter((listing) => (
    listing.ownerUserId === session.userId || actorLeadIds.has(listing.sellerLeadId)
  ));
  const directlyVisibleListingIds = new Set(directlyVisibleListings.map((listing) => listing.id));
  const visibleListings = data.sellerListings
    .filter((listing) => (
      directlyVisibleListingIds.has(listing.id) || projectScope.viewableProjectIds.has(listing.projectId)
    ))
    .map((listing) => {
      const customerViewOnly = projectScope.customerViewProjectIds.has(listing.projectId) &&
        !projectScope.editableProjectIds.has(listing.projectId) &&
        !directlyVisibleListingIds.has(listing.id);
      if (!customerViewOnly) return listing;
      return {
        ...listing,
        canonicalPayload: undefined,
        contactEmail: undefined,
        contactName: undefined,
        contactPhone: undefined,
        contactUserId: undefined,
        internalNotes: undefined,
        ownerContactId: undefined,
        ownerUserId: undefined,
      };
    });
  const visibleListingIds = new Set(visibleListings.map((listing) => listing.id));
  const visibleProjectIds = new Set(projectScope.viewableProjectIds);

  data.sellerListings = visibleListings;
  data.projectPipelinePermissions = data.projectPipelinePermissions.filter(
    (permission) => permission.userId === session.userId,
  );
  data.brokerMandates = data.brokerMandates.filter((mandate) => (
    (mandate.projectId ? projectScope.editableProjectIds.has(mandate.projectId) : false) ||
    (mandate.sellerLeadId ? actorLeadIds.has(mandate.sellerLeadId) : false) ||
    (mandate.contactId ? actorContactIds.has(mandate.contactId) : false)
  ));
  data.buyerSearchProfiles = data.buyerSearchProfiles.filter((profile) => (
    profile.ownerUserId === session.userId ||
    (profile.projectId ? projectScope.editableProjectIds.has(profile.projectId) : false) ||
    (profile.buyerLeadId ? actorLeadIds.has(profile.buyerLeadId) : false) ||
    (profile.contactId ? actorContactIds.has(profile.contactId) : false)
  ));
  const directlyVisibleUnitIds = new Set(
    directlyVisibleListings.map((listing) => listing.unitId).filter((id): id is string => Boolean(id)),
  );
  data.propertyUnits = data.propertyUnits
    .filter((item) => visibleProjectIds.has(item.projectId) || directlyVisibleUnitIds.has(item.id))
    .map((unit) => {
      const customerViewOnly = projectScope.customerViewProjectIds.has(unit.projectId) &&
        !projectScope.editableProjectIds.has(unit.projectId) &&
        !directlyVisibleUnitIds.has(unit.id);
      if (!customerViewOnly) return unit;
      return {
        ...unit,
        buyerContactId: undefined,
        dealId: undefined,
        reservationId: undefined,
      };
    });

  const visibleUnitIds = new Set(data.propertyUnits.map((unit) => unit.id));
  const visibleBuildingIds = new Set(data.propertyUnits.map((unit) => unit.buildingId));
  data.propertyBuildings = data.propertyBuildings.filter((item) => (
    visibleProjectIds.has(item.projectId) || visibleBuildingIds.has(item.id)
  ));
  const isVisiblePropertyRelation = (item: {
    projectId?: string;
    propertyId?: string;
    unitId?: string;
  }) => (
    (item.projectId ? visibleProjectIds.has(item.projectId) : false) ||
    (item.propertyId ? visibleListingIds.has(item.propertyId) : false) ||
    (item.unitId ? visibleUnitIds.has(item.unitId) : false)
  );

  data.propertyCostItems = data.propertyCostItems
    .filter(isVisiblePropertyRelation)
    .filter((item) => (
      !item.projectId ||
      !projectScope.customerViewProjectIds.has(item.projectId) ||
      projectScope.editableProjectIds.has(item.projectId) ||
      directlyVisibleListingIds.has(item.propertyId ?? "") ||
      item.exposeVisible
    ))
    .map((item) => ({ ...item, internalNote: undefined }));
  data.propertyDocuments = data.propertyDocuments
    .filter(isVisiblePropertyRelation)
    .filter((item) => (
      !item.projectId ||
      !projectScope.customerViewProjectIds.has(item.projectId) ||
      projectScope.editableProjectIds.has(item.projectId) ||
      directlyVisibleListingIds.has(item.propertyId ?? "") ||
      (["public", "channel"].includes(item.visibility) && ["approved", "sent"].includes(item.status))
    ));
  data.propertyMedia = data.propertyMedia
    .filter(isVisiblePropertyRelation)
    .filter((item) => (
      !item.projectId ||
      !projectScope.customerViewProjectIds.has(item.projectId) ||
      projectScope.editableProjectIds.has(item.projectId) ||
      directlyVisibleListingIds.has(item.propertyId ?? "") ||
      (["public", "channel"].includes(item.visibility) && ["approved", "published"].includes(item.status))
    ));
  data.propertyTextBlocks = data.propertyTextBlocks
    .filter(isVisiblePropertyRelation)
    .filter((item) => (
      !item.projectId ||
      !projectScope.customerViewProjectIds.has(item.projectId) ||
      projectScope.editableProjectIds.has(item.projectId) ||
      directlyVisibleListingIds.has(item.propertyId ?? "") ||
      (["public", "channel"].includes(item.visibility) && ["approved", "published"].includes(item.status))
    ));
  data.propertyReservations = data.propertyReservations.filter((reservation) => (
    projectScope.editableProjectIds.has(reservation.projectId) ||
    directlyVisibleUnitIds.has(reservation.unitId)
  ));
}

function canReadEditorPreflightType(session: AppSession, editorType: EditorPreflightRun["editorType"]) {
  const capabilityByType: Record<EditorPreflightRun["editorType"], ProductCapability> = {
    bot: "bots:publish",
    calendar: "calendar:manage",
    funnel: "funnels:publish",
    newsletter: "newsletter:send",
  };
  return hasProductCapability(session.productRole, capabilityByType[editorType]);
}

function applyActorAuxiliaryScope(
  data: CoreCrmData,
  session: AppSession,
  projectScope: ActorPropertyProjectScope,
) {
  if (canViewAllWorkspaceContacts(session)) return;

  const visibleProjectIds = new Set(data.projects.map((project) => project.id));
  data.crmPipelines = data.crmPipelines.filter((pipeline) => (
    !pipeline.projectId || visibleProjectIds.has(pipeline.projectId)
  ));
  const visiblePipelineIds = new Set(data.crmPipelines.map((pipeline) => pipeline.id));
  data.crmPipelineStages = data.crmPipelineStages.filter((stage) => (
    visiblePipelineIds.has(stage.pipelineId) &&
    (!stage.projectId || visibleProjectIds.has(stage.projectId))
  ));

  if (hasProductCapability(session.productRole, "funnels:publish")) {
    data.funnels = data.funnels.filter((funnel) => (
      funnel.ownerUserId === session.userId ||
      (Boolean(funnel.projectId) && projectScope.editableProjectIds.has(funnel.projectId))
    ));
  } else {
    data.funnels = [];
  }
  const visibleFunnelIds = new Set(data.funnels.map((funnel) => funnel.id));
  data.funnelSteps = data.funnelSteps.filter((step) => visibleFunnelIds.has(step.funnelId));

  if (hasProductCapability(session.productRole, "newsletter:send")) {
    data.newsletterCampaigns = data.newsletterCampaigns.filter((campaign) => (
      campaign.ownerUserId === session.userId ||
      (campaign.projectId ? projectScope.editableProjectIds.has(campaign.projectId) : false)
    ));
    data.newsletterSegments = data.newsletterSegments.filter((segment) => (
      segment.projectId ? projectScope.editableProjectIds.has(segment.projectId) : false
    ));
  } else {
    data.newsletterCampaigns = [];
    data.newsletterSegments = [];
  }

  data.crmBots = hasProductCapability(session.productRole, "bots:publish")
    ? data.crmBots.filter((bot) => (
        bot.projectId ? projectScope.editableProjectIds.has(bot.projectId) : false
      ))
    : [];

  data.editorPreflightRuns = data.editorPreflightRuns.filter((run) => (
    run.createdByUserId === session.userId &&
    canReadEditorPreflightType(session, run.editorType) &&
    (!run.projectId || visibleProjectIds.has(run.projectId))
  ));
}

function getSessionScopedFallbackData(data: CoreCrmDataResult, session?: AppSession) {
  if (!session || canViewAllWorkspaceContacts(session)) return data;

  const scoped: CoreCrmDataResult = {
    ...data,
    calendarEvents: data.calendarEvents.filter((event) => event.ownerUserId === session.userId),
    contacts: data.contacts.filter((contact) => contact.ownerUserId === session.userId),
    deals: data.deals.filter((deal) => deal.ownerUserId === session.userId),
    leads: data.leads.filter((lead) => lead.assignedToUserId === session.userId),
    projectPipelinePermissions: data.projectPipelinePermissions.filter(
      (permission) => permission.userId === session.userId,
    ),
    tasks: data.tasks.filter((task) => task.ownerUserId === session.userId),
  };
  const editableProjectIds = new Set(
    scoped.projectPipelinePermissions
      .filter((permission) => (
        canUseBrokerProjectEditScope(session) && permission.canEditDeals
      ))
      .map((permission) => permission.projectId),
  );
  applyActorPropertyScope(scoped, session, {
    customerViewProjectIds: new Set(),
    editableProjectIds,
    viewableProjectIds: editableProjectIds,
  });

  const visibleProjectIds = new Set([
    ...scoped.calendarEvents.map((event) => event.projectId),
    ...scoped.contacts.map((contact) => contact.projectId),
    ...scoped.deals.map((deal) => deal.projectId),
    ...scoped.leads.map((lead) => lead.projectId),
    ...scoped.sellerListings.map((listing) => listing.projectId),
    ...scoped.tasks.map((task) => task.projectId),
    ...editableProjectIds,
  ].filter(Boolean));
  scoped.projects = scoped.projects
    .filter((project) => visibleProjectIds.has(project.id))
    .map((project) => ({
      ...project,
      leads: scoped.leads.filter((lead) => lead.projectId === project.id).length,
      revenue: "€0",
    }));
  applyActorAuxiliaryScope(scoped, session, {
    customerViewProjectIds: new Set(),
    editableProjectIds,
    viewableProjectIds: editableProjectIds,
  });
  scoped.dailyQueue = buildDailyQueueData({
    calendarEvents: scoped.calendarEvents,
    contacts: scoped.contacts,
    deals: scoped.deals,
    leads: scoped.leads,
    tasks: scoped.tasks,
  });
  return scoped;
}

export function getMockCoreCrmData(workspaceId: string): CoreCrmDataResult {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "getMockCoreCrmData");
  const calendarEvents = filterWorkspaceItems(mockCalendarEvents, scopedWorkspaceId);
  const contacts = filterWorkspaceItems(mockContacts, scopedWorkspaceId);
  const crmBots = filterWorkspaceItems(mockCrmBots, scopedWorkspaceId);
  const leads = filterWorkspaceItems(mockLeads, scopedWorkspaceId);
  const deals = filterWorkspaceItems(mockDeals, scopedWorkspaceId);
  const funnelSteps = filterWorkspaceItems(mockFunnelSteps, scopedWorkspaceId);
  const funnels = filterWorkspaceItems(mockFunnels, scopedWorkspaceId);
  const newsletterCampaigns = filterWorkspaceItems(mockNewsletterCampaigns, scopedWorkspaceId);
  const newsletterSegments = filterWorkspaceItems(mockNewsletterSegments, scopedWorkspaceId);
  const propertyBuildings = filterWorkspaceItems(mockPropertyBuildings, scopedWorkspaceId);
  const propertyReservations = filterWorkspaceItems(mockPropertyReservations, scopedWorkspaceId);
  const propertyUnits = filterWorkspaceItems(mockPropertyUnits, scopedWorkspaceId);
  const projects = filterWorkspaceItems(mockProjects, scopedWorkspaceId);
  const sellerListings = filterWorkspaceItems(mockSellerListings, scopedWorkspaceId);
  const tasks = filterWorkspaceItems(mockTasks, scopedWorkspaceId);

  return {
    source: "mock",
    moduleSources: createModuleSources("mock"),
    brokerMandates: [],
    buyerSearchProfiles: [],
    calendarEvents,
    contacts,
    crmPipelineStages: [],
    crmPipelines: [],
    editorPreflightRuns: [],
    crmBots,
    dailyQueue: buildDailyQueueData({
      calendarEvents,
      contacts,
      deals,
      leads,
      tasks,
    }),
    leads,
    deals,
    funnelSteps,
    funnels,
    newsletterCampaigns,
    newsletterSegments,
    projectPipelinePermissions: [],
    propertyBuildings,
    propertyCostItems: [],
    propertyDocuments: [],
    propertyMedia: [],
    propertyReservations,
    propertyTextBlocks: [],
    propertyUnits,
    projects,
    sellerListings,
    tasks,
  };
}

export async function getCoreCrmData(
  workspaceId: string,
  options: { session?: AppSession } = {},
): Promise<CoreCrmDataResult> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "getCoreCrmData");
  const fallbackData = getMockCoreCrmData(scopedWorkspaceId);
  const actorScope = getCrmActorVisibilityScope(options.session);

  if (!hasDatabaseUrl()) {
    return getSessionScopedFallbackData(fallbackData, options.session);
  }

  const contactScope = options.session
    ? getContactVisibilityScope(options.session)
    : ({ kind: "workspace" } satisfies ContactVisibilityScope);
  const moduleFallbackData = getSessionScopedFallbackData(fallbackData, options.session);

  const moduleResults = await Promise.all([
    loadModule(
      "brokerMandates",
      () => options.session ? loadBrokerMandates(options.session) : Promise.resolve([]),
      moduleFallbackData.brokerMandates,
    ),
    loadModule(
      "buyerSearchProfiles",
      () => options.session ? loadBuyerSearchProfiles(options.session) : Promise.resolve([]),
      moduleFallbackData.buyerSearchProfiles,
    ),
    loadModule("calendarEvents", () => loadCalendarEvents(scopedWorkspaceId, actorScope), moduleFallbackData.calendarEvents),
    loadModule("contacts", () => loadContacts(scopedWorkspaceId, contactScope), moduleFallbackData.contacts),
    loadModule("crmPipelineStages", () => loadCrmPipelineStages(scopedWorkspaceId), moduleFallbackData.crmPipelineStages),
    loadModule("crmPipelines", () => loadCrmPipelines(scopedWorkspaceId), moduleFallbackData.crmPipelines),
    loadModule("editorPreflightRuns", () => loadEditorPreflightRuns(scopedWorkspaceId), moduleFallbackData.editorPreflightRuns),
    loadModule("leads", () => loadLeads(scopedWorkspaceId, actorScope), moduleFallbackData.leads),
    loadModule("deals", () => loadDeals(scopedWorkspaceId, actorScope), moduleFallbackData.deals),
    loadModule("tasks", () => loadTasks(scopedWorkspaceId, actorScope), moduleFallbackData.tasks),
    loadModule("projects", () => loadProjects(scopedWorkspaceId, actorScope), moduleFallbackData.projects),
    loadModule("funnels", () => loadFunnels(scopedWorkspaceId), moduleFallbackData.funnels),
    loadModule("funnelSteps", () => loadFunnelSteps(scopedWorkspaceId), moduleFallbackData.funnelSteps),
    loadModule("newsletterSegments", () => loadNewsletterSegments(scopedWorkspaceId), moduleFallbackData.newsletterSegments),
    loadModule("newsletterCampaigns", () => loadNewsletterCampaigns(scopedWorkspaceId), moduleFallbackData.newsletterCampaigns),
    loadModule(
      "projectPipelinePermissions",
      () => loadProjectPipelinePermissions(scopedWorkspaceId, actorScope),
      moduleFallbackData.projectPipelinePermissions,
    ),
    loadModule("crmBots", () => loadCrmBots(scopedWorkspaceId), moduleFallbackData.crmBots),
    loadModule("propertyBuildings", () => loadPropertyBuildings(scopedWorkspaceId), moduleFallbackData.propertyBuildings),
    loadModule("propertyCostItems", () => loadPropertyCostItems(scopedWorkspaceId), moduleFallbackData.propertyCostItems),
    loadModule("propertyDocuments", () => loadPropertyDocuments(scopedWorkspaceId), moduleFallbackData.propertyDocuments),
    loadModule("propertyMedia", () => loadPropertyMedia(scopedWorkspaceId), moduleFallbackData.propertyMedia),
    loadModule("propertyUnits", () => loadPropertyUnits(scopedWorkspaceId), moduleFallbackData.propertyUnits),
    loadModule(
      "propertyReservations",
      () => loadPropertyReservations(scopedWorkspaceId),
      moduleFallbackData.propertyReservations,
    ),
    loadModule("propertyTextBlocks", () => loadPropertyTextBlocks(scopedWorkspaceId), moduleFallbackData.propertyTextBlocks),
    loadModule("sellerListings", () => loadSellerListings(scopedWorkspaceId), moduleFallbackData.sellerListings),
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

  if (options.session && !canViewAllWorkspaceContacts(options.session)) {
    let projectScope: ActorPropertyProjectScope = {
      customerViewProjectIds: new Set(),
      editableProjectIds: new Set(),
      viewableProjectIds: new Set(),
    };
    try {
      projectScope = await loadActorPropertyProjectIds(options.session);
      applyActorPropertyScope(data, options.session, projectScope);
    } catch (error) {
      // Owner-linked records can still be identified from the already-scoped
      // contact and actor assignment data. Project grants fail closed.
      applyActorPropertyScope(data, options.session, {
        customerViewProjectIds: new Set(),
        editableProjectIds: new Set(),
        viewableProjectIds: new Set(),
      });
      const message = error instanceof Error ? error.message : "Actor property scope could not be resolved";
      for (const key of actorScopedPropertyKeys) {
        moduleErrors[key] = `Actor property scope failed closed: ${message}`;
      }
    }
    applyActorAuxiliaryScope(data, options.session, projectScope);
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
    dailyQueue: buildDailyQueueData({
      calendarEvents: data.calendarEvents,
      contacts: data.contacts,
      deals: data.deals,
      leads: data.leads,
      tasks: data.tasks,
    }),
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
    if (error instanceof MissingWorkspaceScopeError) {
      throw error;
    }
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

function parseDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysSince(value: string | undefined, now = new Date()) {
  const date = parseDate(value);
  if (!date) return 0;
  return Math.max(0, Math.floor((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000));
}

function businessDaysSince(value: string | undefined, now = new Date()) {
  const date = parseDate(value);
  if (!date) return 0;
  let cursor = startOfDay(date);
  const end = startOfDay(now);
  let count = 0;
  while (cursor < end) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function isToday(value: string | undefined, now = new Date()) {
  const date = parseDate(value);
  return Boolean(
    date &&
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate(),
  );
}

function hasNextAction(value: string | undefined) {
  return Boolean(value?.trim());
}

function contactName(contacts: Contact[], contactId: string | undefined, fallback: string) {
  return contacts.find((contact) => contact.id === contactId)?.name ?? fallback;
}

function hasOpenTask(tasks: Task[], deal: Deal) {
  return tasks.some((task) =>
    task.status === "open" &&
    (task.leadId === deal.leadId || task.contactId === deal.contactId || task.projectId === deal.projectId)
  );
}

function buildDailyQueueData(input: {
  calendarEvents: CalendarEvent[];
  contacts: Contact[];
  deals: Deal[];
  leads: Lead[];
  tasks: Task[];
}): DailyQueueData {
  const now = new Date();
  const hotLeads = input.leads
    .filter((lead) =>
      (lead.status === "Qualifiziert" || lead.status === "Qualifizieren" || lead.hotStatus || lead.score >= 80) &&
      daysSince(lead.receivedAt, now) <= 14 &&
      !lead.nextContactAt
    )
    .slice(0, 12)
    .map((lead) => ({
      actionLabel: "Lead Inbox",
      actionSection: "leadInbox" as const,
      daysInStage: daysSince(lead.receivedAt, now),
      id: `hot-lead-${lead.id}`,
      nextAction: hasNextAction(lead.nextAction) ? lead.nextAction : "Kontakt aufnehmen",
      owner: lead.assignedToUserId ?? "Unassigned",
      source: lead.source,
      stage: lead.status,
      title: contactName(input.contacts, lead.contactId, lead.intent),
    }));

  const demoFollowUps = input.deals
    .filter((deal) =>
      deal.stage === "Demo gehalten" &&
      businessDaysSince(deal.expectedCloseDate || undefined, now) >= 2
    )
    .slice(0, 12)
    .map((deal) => ({
      actionLabel: "Aufgabe erstellen",
      actionSection: "tasks" as const,
      daysInStage: businessDaysSince(deal.expectedCloseDate || undefined, now),
      id: `demo-follow-up-${deal.id}`,
      nextAction: hasNextAction(deal.nextAction) ? deal.nextAction : "Demo-Follow-up senden",
      owner: deal.ownerUserId ?? "Unassigned",
      source: deal.source,
      stage: deal.stage,
      title: deal.name,
    }));

  const overdueOffers = input.deals
    .filter((deal) => {
      const expectedClose = parseDate(deal.expectedCloseDate);
      return deal.stage === "Angebot" && (!expectedClose || expectedClose < startOfDay(now));
    })
    .slice(0, 12)
    .map((deal) => ({
      actionLabel: "Pipeline öffnen",
      actionSection: "pipelines" as const,
      daysInStage: daysSince(deal.expectedCloseDate || undefined, now),
      id: `overdue-offer-${deal.id}`,
      nextAction: hasNextAction(deal.nextAction) ? deal.nextAction : "Angebot nachfassen",
      owner: deal.ownerUserId ?? "Unassigned",
      source: deal.source,
      stage: deal.stage,
      title: deal.name,
    }));

  const todayAppointments = input.calendarEvents
    .filter((event) => isToday(event.startsAt, now))
    .slice(0, 12)
    .map((event) => ({
      actionLabel: "Termin öffnen",
      actionSection: "calendar" as const,
      daysInStage: 0,
      id: `appointment-${event.id}`,
      nextAction: event.outcomeGoal || "Termin vorbereiten",
      owner: event.ownerUserId ?? "Unassigned",
      source: event.location,
      stage: event.status,
      title: event.title,
    }));

  const pilotAttention = input.deals
    .filter((deal) => {
      const closeDate = parseDate(deal.expectedCloseDate);
      const pilotEndingSoon = closeDate
        ? closeDate.getTime() <= new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).getTime()
        : false;
      return deal.stage === "Pilot" && (hasOpenTask(input.tasks, deal) || pilotEndingSoon);
    })
    .slice(0, 12)
    .map((deal) => ({
      actionLabel: "Task prüfen",
      actionSection: "tasks" as const,
      daysInStage: daysSince(deal.expectedCloseDate || undefined, now),
      id: `pilot-${deal.id}`,
      nextAction: hasNextAction(deal.nextAction) ? deal.nextAction : "Pilot-Check-in planen",
      owner: deal.ownerUserId ?? "Unassigned",
      source: deal.source,
      stage: deal.stage,
      title: deal.name,
    }));

  return {
    generatedAt: now.toISOString(),
    sections: [
      {
        cards: hotLeads,
        emptyText: { de: "Keine heißen Leads - Lead-Zentrale prüfen.", en: "No hot leads - check Lead Inbox." },
        id: "hotLeads",
        title: { de: "Heiße Leads", en: "Hot leads" },
      },
      {
        cards: demoFollowUps,
        emptyText: { de: "Keine Demo-Follow-ups fällig.", en: "No demo follow-ups due." },
        id: "demoFollowUps",
        title: { de: "Demo-Follow-ups", en: "Demo follow-ups" },
      },
      {
        cards: overdueOffers,
        emptyText: { de: "Keine überfälligen Angebote.", en: "No overdue offers." },
        id: "overdueOffers",
        title: { de: "Überfällige Angebote", en: "Overdue offers" },
      },
      {
        cards: todayAppointments,
        emptyText: { de: "Heute keine Termine.", en: "No appointments today." },
        id: "todayAppointments",
        title: { de: "Heutige Termine", en: "Today's appointments" },
      },
      {
        cards: pilotAttention,
        emptyText: { de: "Keine Pilotkunden mit Handlungsbedarf.", en: "No pilot customers need action." },
        id: "pilotAttention",
        title: { de: "Pilotkunden mit Handlungsbedarf", en: "Pilot customers needing action" },
      },
    ],
  };
}

export async function loadProjects(
  workspaceId: string,
  visibilityScope: CrmActorVisibilityScope = { kind: "workspace" },
): Promise<Project[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadProjects");
  const params: unknown[] = [scopedWorkspaceId];
  const actorEntityFilter = visibilityScope.kind === "actor"
    ? `and (
        assigned_to_user_id = $2::uuid
        or ($3::boolean and project_id is not null and exists (
          select 1 from public.project_pipeline_permissions permission
          where permission.workspace_id = leads.workspace_id
            and permission.project_id = leads.project_id
            and permission.user_id = $2::uuid
            and permission.can_edit_deals = true
        ))
      )`
    : "";
  const actorDealFilter = visibilityScope.kind === "actor"
    ? `and (
        owner_user_id = $2::uuid
        or ($3::boolean and project_id is not null and exists (
          select 1 from public.project_pipeline_permissions permission
          where permission.workspace_id = deals.workspace_id
            and permission.project_id = deals.project_id
            and permission.user_id = $2::uuid
            and permission.can_edit_deals = true
        ))
      )`
    : "";
  const actorProjectFilter = visibilityScope.kind === "actor"
    ? `and (
        exists (
          select 1 from public.customer_project_access access
          where access.workspace_id = p.workspace_id
            and access.project_id = p.id
            and access.user_id = $2::uuid
            and access.status = 'active'
            and access.can_view_project = true
        )
        or ($3::boolean and exists (
          select 1 from public.project_pipeline_permissions permission
          where permission.workspace_id = p.workspace_id
            and permission.project_id = p.id
            and permission.user_id = $2::uuid
            and permission.can_edit_deals = true
        ))
        or exists (
          select 1 from public.contacts contact
          where contact.workspace_id = p.workspace_id
            and contact.project_id = p.id
            and contact.owner_user_id = $2::uuid
            and contact.archived_at is null
        )
        or exists (
          select 1 from public.leads lead
          where lead.workspace_id = p.workspace_id
            and lead.project_id = p.id
            and lead.assigned_to_user_id = $2::uuid
        )
        or exists (
          select 1 from public.deals deal
          where deal.workspace_id = p.workspace_id
            and deal.project_id = p.id
            and deal.owner_user_id = $2::uuid
        )
        or exists (
          select 1 from public.tasks task
          where task.workspace_id = p.workspace_id
            and task.project_id = p.id
            and task.owner_user_id = $2::uuid
        )
        or exists (
          select 1 from public.calendar_events event
          where event.workspace_id = p.workspace_id
            and event.project_id = p.id
            and event.owner_user_id = $2::uuid
        )
        or exists (
          select 1 from public.seller_listings listing
          where listing.workspace_id = p.workspace_id
            and listing.project_id = p.id
            and (
              listing.owner_user_id = $2::uuid
              or exists (
                select 1 from public.leads seller_lead
                where seller_lead.workspace_id = listing.workspace_id
                  and seller_lead.id = listing.seller_lead_id
                  and seller_lead.assigned_to_user_id = $2::uuid
              )
            )
        )
      )`
    : "";
  if (visibilityScope.kind === "actor") {
    params.push(visibilityScope.userId, visibilityScope.allowProjectEditVisibility);
  }
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
      coalesce(l.leads, 0)::int as leads,
      coalesce(d.revenue_cents, 0)::bigint as "revenueCents"
    from projects p
    left join (
      select
        workspace_id,
        project_id,
        count(*)::int as leads
      from leads
      where workspace_id = $1
        ${actorEntityFilter}
      group by workspace_id, project_id
    ) l on l.project_id = p.id and l.workspace_id = p.workspace_id
    left join (
      select
        workspace_id,
        project_id,
        sum(value_cents)::bigint as revenue_cents
      from deals
      where workspace_id = $1
        and stage not in ('Gewonnen', 'Verloren', 'Disqualifiziert')
        ${actorDealFilter}
      group by workspace_id, project_id
    ) d on d.project_id = p.id and d.workspace_id = p.workspace_id
    where p.workspace_id = $1
      ${actorProjectFilter}
    order by p.created_at asc
  `,
    params,
  );

  return rows.map(mapProjectRow);
}

function mapProjectRow(row: ProjectRow): Project {
  return {
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
  };
}

export async function loadBrokerMandates(session: AppSession): Promise<BrokerMandate[]> {
  const scopedWorkspaceId = requireWorkspaceId(session.workspaceId, "loadBrokerMandates");
  const rows = await withTenantTransaction(
    { actorId: session.userId, workspaceId: scopedWorkspaceId },
    (transaction) => transaction.query<BrokerMandateRow>(
      `
      select
        mandate.id,
        mandate.workspace_id as "workspaceId",
        mandate.project_id as "projectId",
        mandate.seller_lead_id as "sellerLeadId",
        mandate.contact_id as "contactId",
        mandate.title,
        mandate.address,
        mandate.location,
        mandate.property_type as "propertyType",
        mandate.condition,
        mandate.area_sqm as "areaSqm",
        mandate.rooms,
        mandate.year_built as "yearBuilt",
        mandate.asking_price_cents as "askingPriceCents",
        mandate.market_value_cents as "marketValueCents",
        mandate.selling_timeline as "sellingTimeline",
        mandate.motivation,
        mandate.selling_reason as "sellingReason",
        mandate.mandate_status as "mandateStatus",
        mandate.mandate_type as "mandateType",
        mandate.commission_rate as "commissionRate",
        mandate.documents_status as "documentsStatus",
        mandate.marketing_status as "marketingStatus",
        mandate.expiring_broker_contract_at as "expiringBrokerContractAt",
        mandate.metadata,
        mandate.updated_at as "updatedAt"
      from broker_mandates mandate
      where mandate.workspace_id = $1::uuid
        and (
          $2::boolean
          or exists (
            select 1 from leads seller_lead
            where seller_lead.workspace_id = mandate.workspace_id
              and seller_lead.id = mandate.seller_lead_id
              and seller_lead.assigned_to_user_id = $3::uuid
          )
          or exists (
            select 1 from contacts mandate_contact
            where mandate_contact.workspace_id = mandate.workspace_id
              and mandate_contact.id = mandate.contact_id
              and mandate_contact.owner_user_id = $3::uuid
          )
          or (
            $4::boolean and exists (
              select 1 from project_pipeline_permissions permission
              where permission.workspace_id = mandate.workspace_id
                and permission.project_id = mandate.project_id
                and permission.user_id = $3::uuid
                and permission.can_edit_deals = true
            )
          )
        )
      order by mandate.updated_at desc, mandate.id
      limit 500
    `,
      [
        scopedWorkspaceId,
        canViewAllWorkspaceContacts(session),
        session.userId,
        canUseBrokerProjectEditScope(session),
      ],
    ),
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

export async function loadBuyerSearchProfiles(session: AppSession): Promise<BuyerSearchProfile[]> {
  const scopedWorkspaceId = requireWorkspaceId(session.workspaceId, "loadBuyerSearchProfiles");
  const rows = await withTenantTransaction(
    { actorId: session.userId, workspaceId: scopedWorkspaceId },
    (transaction) => transaction.query<BuyerSearchProfileRow>(
      `
      select
        profile.id,
        profile.workspace_id as "workspaceId",
        profile.project_id as "projectId",
        profile.buyer_lead_id as "buyerLeadId",
        profile.contact_id as "contactId",
        profile.title,
        profile.budget_from_cents as "budgetFromCents",
        profile.budget_to_cents as "budgetToCents",
        profile.financing_status as "financingStatus",
        profile.desired_location as "desiredLocation",
        profile.property_type as "propertyType",
        profile.rooms,
        profile.area_sqm as "areaSqm",
        profile.must_have_criteria as "mustHaveCriteria",
        profile.nice_to_have_criteria as "niceToHaveCriteria",
        profile.owner_user_id as "ownerUserId",
        profile.purchase_timeline as "purchaseTimeline",
        profile.matching_status as "matchingStatus",
        profile.metadata,
        profile.updated_at as "updatedAt"
      from buyer_search_profiles profile
      where profile.workspace_id = $1::uuid
        and (
          $2::boolean
          or profile.owner_user_id = $3::uuid
          or exists (
            select 1 from leads buyer_lead
            where buyer_lead.workspace_id = profile.workspace_id
              and buyer_lead.id = profile.buyer_lead_id
              and buyer_lead.assigned_to_user_id = $3::uuid
          )
          or exists (
            select 1 from contacts buyer_contact
            where buyer_contact.workspace_id = profile.workspace_id
              and buyer_contact.id = profile.contact_id
              and buyer_contact.owner_user_id = $3::uuid
          )
          or (
            $4::boolean and exists (
              select 1 from project_pipeline_permissions permission
              where permission.workspace_id = profile.workspace_id
                and permission.project_id = profile.project_id
                and permission.user_id = $3::uuid
                and permission.can_edit_deals = true
            )
          )
        )
      order by profile.updated_at desc, profile.id
      limit 500
    `,
      [
        scopedWorkspaceId,
        canViewAllWorkspaceContacts(session),
        session.userId,
        canUseBrokerProjectEditScope(session),
      ],
    ),
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
    ownerUserId: row.ownerUserId ?? undefined,
    projectId: row.projectId ?? undefined,
    propertyType: row.propertyType ?? undefined,
    purchaseTimeline: row.purchaseTimeline ?? undefined,
    rooms: toOptionalNumber(row.rooms),
    title: row.title,
    updatedAt: toIso(row.updatedAt),
    workspaceId: row.workspaceId,
  }));
}

export async function loadCrmPipelines(workspaceId: string): Promise<CrmPipeline[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadCrmPipelines");
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
    where workspace_id = $1
    order by is_default desc, created_at asc
    limit 500
  `,
    [scopedWorkspaceId],
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

export async function loadCrmPipelineStages(workspaceId: string): Promise<CrmPipelineStage[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadCrmPipelineStages");
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
    where workspace_id = $1
    order by pipeline_id asc, position asc
    limit 1000
  `,
    [scopedWorkspaceId],
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

export async function loadProjectPipelinePermissions(
  workspaceId: string,
  visibilityScope: CrmActorVisibilityScope = { kind: "workspace" },
): Promise<ProjectPipelinePermission[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadProjectPipelinePermissions");
  const params: unknown[] = [scopedWorkspaceId];
  const actorFilter = visibilityScope.kind === "actor"
    ? `and p.user_id = $2::uuid
       and (
         ($3::boolean and p.can_edit_deals = true)
         or exists (
           select 1 from public.customer_project_access access
           where access.workspace_id = p.workspace_id
             and access.project_id = p.project_id
             and access.user_id = $2::uuid
             and access.status = 'active'
             and access.can_view_project = true
         )
         or exists (
           select 1 from public.contacts contact
           where contact.workspace_id = p.workspace_id
             and contact.project_id = p.project_id
             and contact.owner_user_id = $2::uuid
             and contact.archived_at is null
         )
         or exists (
           select 1 from public.leads lead
           where lead.workspace_id = p.workspace_id
             and lead.project_id = p.project_id
             and lead.assigned_to_user_id = $2::uuid
         )
         or exists (
           select 1 from public.deals deal
           where deal.workspace_id = p.workspace_id
             and deal.project_id = p.project_id
             and deal.owner_user_id = $2::uuid
         )
         or exists (
           select 1 from public.tasks task
           where task.workspace_id = p.workspace_id
             and task.project_id = p.project_id
             and task.owner_user_id = $2::uuid
         )
         or exists (
           select 1 from public.calendar_events event
           where event.workspace_id = p.workspace_id
             and event.project_id = p.project_id
             and event.owner_user_id = $2::uuid
         )
       )`
    : "";
  if (visibilityScope.kind === "actor") {
    params.push(visibilityScope.userId, visibilityScope.allowProjectEditVisibility);
  }
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
    where p.workspace_id = $1
      ${actorFilter}
    order by p.project_id asc, coalesce(wu.name, wu.email, p.user_id::text) asc
    limit 1000
  `,
    params,
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

export async function loadEditorPreflightRuns(workspaceId: string): Promise<EditorPreflightRun[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadEditorPreflightRuns");
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
      created_by_user_id as "createdByUserId",
      created_at as "createdAt"
    from editor_preflight_runs
    where workspace_id = $1
    order by created_at desc
    limit 100
  `,
    [scopedWorkspaceId],
  );

  return rows.map((row) => ({
    blockers: row.blockers ?? [],
    checks: row.checks ?? [],
    createdAt: toIso(row.createdAt),
    createdByUserId: row.createdByUserId ?? undefined,
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

export async function loadSellerListings(workspaceId: string): Promise<SellerListing[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadSellerListings");
  const rows = await queryRows<SellerListingRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      seller_lead_id as "sellerLeadId",
      title,
      address,
      region,
      object_type as "objectType",
      area_sqm as "areaSqm",
      rooms,
      year_built as "yearBuilt",
      market_value_cents as "marketValueCents",
      target_price_cents as "targetPriceCents",
      expected_gross_yield as "expectedGrossYield",
      mandate_ends_at as "mandateEndsAt",
      created_at as "createdAt",
      object_number as "objectNumber",
      internal_reference as "internalReference",
      external_portal_id as "externalPortalId",
      openimmo_object_id as "openimmoObjectId",
      unit_id as "unitId",
      mandate_id as "mandateId",
      owner_contact_id as "ownerContactId",
      owner_user_id as "ownerUserId",
      contact_user_id as "contactUserId",
      contact_name as "contactName",
      contact_phone as "contactPhone",
      contact_email as "contactEmail",
      marketing_type as "marketingType",
      usage_type as "usageType",
      sub_object_type as "subObjectType",
      sub_object_type_custom as "subObjectTypeCustom",
      available_from as "availableFrom",
      available_from_text as "availableFromText",
      availability_note as "availabilityNote",
      price_visibility as "priceVisibility",
      channel_price_visibility as "channelPriceVisibility",
      public_price_cents as "publicPriceCents",
      rent_price_cents as "rentPriceCents",
      rent_net_cents as "rentNetCents",
      monthly_costs_gross_cents as "monthlyCostsGrossCents",
      purchase_ancillary_costs_cents as "purchaseAncillaryCostsCents",
      costs_summary as "costsSummary",
      gdpr_status as "gdprStatus",
      portal_mapping_status as "portalMappingStatus",
      media_summary as "mediaSummary",
      document_summary as "documentSummary",
      text_summary as "textSummary",
      postal_code as "postalCode",
      city,
      federal_state as "federalState",
      street,
      property_status as "propertyStatus",
      document_status as "documentStatus",
      energy_certificate_valid_until as "energyValidUntil",
      hwb_class as "energyClass",
      internal_notes as "internalNotes",
      canonical_payload as "canonicalPayload"
    from seller_listings
    where workspace_id = $1
    order by created_at desc
    limit 500
  `,
    [scopedWorkspaceId],
  );

  return rows.map(mapSellerListingRow);
}

function mapSellerListingRow(row: SellerListingRow): SellerListing {
  return {
    address: row.address,
    areaSqm: Number(row.areaSqm ?? 0),
    canonicalPayload: row.canonicalPayload ?? undefined,
    city: row.city ?? undefined,
    createdAt: toIso(row.createdAt),
    documentStatus: row.documentStatus ?? undefined,
    energyClass: row.energyClass ?? undefined,
    energyValidUntil: toOptionalIso(row.energyValidUntil),
    availableFrom: toOptionalIso(row.availableFrom),
    availableFromText: row.availableFromText ?? undefined,
    availabilityNote: row.availabilityNote ?? undefined,
    channelPriceVisibility: normalizePriceVisibilityMap(row.channelPriceVisibility),
    contactEmail: row.contactEmail ?? undefined,
    contactName: row.contactName ?? undefined,
    contactPhone: row.contactPhone ?? undefined,
    contactUserId: row.contactUserId ?? undefined,
    costsSummary: row.costsSummary ?? undefined,
    documentSummary: row.documentSummary ?? undefined,
    expectedGrossYield: toOptionalNumber(row.expectedGrossYield),
    externalPortalId: row.externalPortalId ?? undefined,
    federalState: row.federalState ?? undefined,
    gdprStatus: row.gdprStatus ?? undefined,
    id: row.id,
    internalReference: row.internalReference ?? undefined,
    internalNotes: row.internalNotes ?? undefined,
    mandateId: row.mandateId ?? undefined,
    mandateEndsAt: toOptionalIso(row.mandateEndsAt),
    marketingType: row.marketingType ?? undefined,
    marketValue: centsToNumber(row.marketValueCents) ?? 0,
    mediaSummary: row.mediaSummary ?? undefined,
    monthlyCostsGross: centsToNumber(row.monthlyCostsGrossCents),
    objectType: row.objectType,
    objectNumber: row.objectNumber ?? undefined,
    openimmoObjectId: row.openimmoObjectId ?? undefined,
    ownerContactId: row.ownerContactId ?? undefined,
    ownerUserId: row.ownerUserId ?? undefined,
    portalMappingStatus: row.portalMappingStatus ?? undefined,
    postalCode: row.postalCode ?? undefined,
    priceVisibility: normalizePriceVisibility(row.priceVisibility),
    projectId: row.projectId ?? "",
    propertyStatus: row.propertyStatus ?? undefined,
    publicPrice: centsToNumber(row.publicPriceCents),
    purchaseAncillaryCosts: centsToNumber(row.purchaseAncillaryCostsCents),
    region: row.region,
    rentNet: centsToNumber(row.rentNetCents),
    rentPrice: centsToNumber(row.rentPriceCents),
    rooms: toOptionalNumber(row.rooms),
    sellerLeadId: row.sellerLeadId ?? "",
    street: row.street ?? undefined,
    subObjectType: row.subObjectType ?? undefined,
    subObjectTypeCustom: row.subObjectTypeCustom ?? undefined,
    targetPrice: centsToNumber(row.targetPriceCents) ?? 0,
    textSummary: row.textSummary ?? undefined,
    title: row.title,
    unitId: row.unitId ?? undefined,
    usageType: row.usageType ?? undefined,
    workspaceId: row.workspaceId,
    yearBuilt: toOptionalNumber(row.yearBuilt) ?? 0,
  };
}

function buildSellerListingWhereClause(workspaceId: string, options: PropertyAssetPaginationOptions) {
  const params: unknown[] = [workspaceId];
  const clauses = ["sl.workspace_id = $1::uuid"];

  if (options.actorUserId) {
    params.push(
      options.actorUserId,
      options.workspaceWide === true,
      options.allowProjectEditGrants === true,
    );
    const actorParameter = `$${params.length - 2}`;
    const workspaceWideParameter = `$${params.length - 1}`;
    const projectEditParameter = `$${params.length}`;
    clauses.push(`(
      ${workspaceWideParameter}::boolean
      or sl.owner_user_id = ${actorParameter}::uuid
      or exists (
        select 1 from leads scoped_seller_lead
         where scoped_seller_lead.workspace_id = sl.workspace_id
           and scoped_seller_lead.id = sl.seller_lead_id
           and scoped_seller_lead.assigned_to_user_id = ${actorParameter}::uuid
      )
      or exists (
        select 1 from project_pipeline_permissions scoped_permission
         where scoped_permission.workspace_id = sl.workspace_id
           and scoped_permission.project_id = sl.project_id
           and scoped_permission.user_id = ${actorParameter}::uuid
           and scoped_permission.can_edit_deals = true
           and ${projectEditParameter}::boolean
      )
      or exists (
        select 1 from customer_project_access scoped_customer_access
         where scoped_customer_access.workspace_id = sl.workspace_id
           and scoped_customer_access.project_id = sl.project_id
           and scoped_customer_access.user_id = ${actorParameter}::uuid
           and scoped_customer_access.status = 'active'
           and scoped_customer_access.can_view_project = true
      )
    )`);
  }

  if (options.projectId) {
    params.push(options.projectId);
    clauses.push(`sl.project_id = $${params.length}::uuid`);
  }

  const status = options.status?.trim();
  if (status) {
    params.push(status);
    clauses.push(`sl.property_status = $${params.length}::text`);
  }

  const query = options.q?.trim();
  if (query) {
    params.push(`%${query}%`);
    clauses.push(
      `(sl.title ilike $${params.length}::text or sl.object_number ilike $${params.length}::text or sl.address ilike $${params.length}::text)`,
    );
  }

  return {
    params,
    whereClause: clauses.join(" and "),
  };
}

function uniqueIds(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export async function loadPaginatedPropertyAssets(
  workspaceId: string,
  options: PropertyAssetPaginationOptions = {},
): Promise<PropertyAssetPaginationResult> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPaginatedPropertyAssets");
  const limit = clampInteger(options.limit, 50, 1, 200);
  const offset = clampInteger(options.offset, 0, 0, 100_000);
  const filter = buildSellerListingWhereClause(scopedWorkspaceId, options);

  const count = await queryOne<{ total: number | string }>(
    `
    select count(*)::int as total
    from seller_listings sl
    where ${filter.whereClause}
  `,
    filter.params,
  );

  const rows = await queryRows<SellerListingRow>(
    `
    select
      sl.id,
      sl.workspace_id as "workspaceId",
      sl.project_id as "projectId",
      sl.seller_lead_id as "sellerLeadId",
      sl.title,
      sl.address,
      sl.region,
      sl.object_type as "objectType",
      sl.area_sqm as "areaSqm",
      sl.rooms,
      sl.year_built as "yearBuilt",
      sl.market_value_cents as "marketValueCents",
      sl.target_price_cents as "targetPriceCents",
      sl.expected_gross_yield as "expectedGrossYield",
      sl.mandate_ends_at as "mandateEndsAt",
      sl.created_at as "createdAt",
      sl.object_number as "objectNumber",
      sl.internal_reference as "internalReference",
      sl.external_portal_id as "externalPortalId",
      sl.openimmo_object_id as "openimmoObjectId",
      sl.unit_id as "unitId",
      sl.mandate_id as "mandateId",
      sl.owner_contact_id as "ownerContactId",
      sl.owner_user_id as "ownerUserId",
      sl.contact_user_id as "contactUserId",
      sl.contact_name as "contactName",
      sl.contact_phone as "contactPhone",
      sl.contact_email as "contactEmail",
      sl.marketing_type as "marketingType",
      sl.usage_type as "usageType",
      sl.sub_object_type as "subObjectType",
      sl.sub_object_type_custom as "subObjectTypeCustom",
      sl.available_from as "availableFrom",
      sl.available_from_text as "availableFromText",
      sl.availability_note as "availabilityNote",
      sl.price_visibility as "priceVisibility",
      sl.channel_price_visibility as "channelPriceVisibility",
      sl.public_price_cents as "publicPriceCents",
      sl.rent_price_cents as "rentPriceCents",
      sl.rent_net_cents as "rentNetCents",
      sl.monthly_costs_gross_cents as "monthlyCostsGrossCents",
      sl.purchase_ancillary_costs_cents as "purchaseAncillaryCostsCents",
      sl.costs_summary as "costsSummary",
      sl.gdpr_status as "gdprStatus",
      sl.portal_mapping_status as "portalMappingStatus",
      sl.media_summary as "mediaSummary",
      sl.document_summary as "documentSummary",
      sl.text_summary as "textSummary",
      sl.postal_code as "postalCode",
      sl.city,
      sl.federal_state as "federalState",
      sl.street,
      sl.property_status as "propertyStatus",
      sl.document_status as "documentStatus",
      sl.energy_certificate_valid_until as "energyValidUntil",
      sl.hwb_class as "energyClass",
      sl.internal_notes as "internalNotes",
      sl.canonical_payload as "canonicalPayload"
    from seller_listings sl
    where ${filter.whereClause}
    order by sl.created_at desc, sl.id desc
    limit $${filter.params.length + 1}::int
    offset $${filter.params.length + 2}::int
  `,
    [...filter.params, limit, offset],
  );

  const sellerListings = rows.map(mapSellerListingRow);
  const listingIds = uniqueIds(sellerListings.map((listing) => listing.id));
  const listingIdSet = new Set(listingIds);
  const listingPosition = new Map(listingIds.map((id, index) => [id, index]));
  const projectIds = uniqueIds(sellerListings.map((listing) => listing.projectId));
  const unitIds = uniqueIds(sellerListings.map((listing) => listing.unitId));

  const [
    projects,
    units,
    reservations,
    buildings,
    propertyCostItems,
    propertyDocuments,
    propertyMedia,
    propertyTextBlocks,
  ] = await Promise.all([
    loadProjectsForPropertyAssets(scopedWorkspaceId, projectIds),
    loadPropertyUnitsForAssetSummaries(scopedWorkspaceId, projectIds, unitIds),
    loadPropertyReservationsForAssetSummaries(scopedWorkspaceId, projectIds),
    loadPropertyBuildingsForAssetSummaries(scopedWorkspaceId, projectIds),
    loadPropertyCostItemsForAssets(scopedWorkspaceId, listingIds),
    loadPropertyDocumentsForAssets(scopedWorkspaceId, listingIds),
    loadPropertyMediaForAssets(scopedWorkspaceId, listingIds),
    loadPropertyTextBlocksForAssets(scopedWorkspaceId, listingIds),
  ]);

  const assets = buildPropertyAssets({
    brokerMandates: [],
    buildings,
    propertyCostItems,
    propertyDocuments,
    propertyMedia,
    propertyTextBlocks,
    projects,
    reservations,
    sellerListings,
    units,
  })
    .filter((asset) => asset.sellerListingId && listingIdSet.has(asset.sellerListingId))
    .sort((left, right) => {
      const leftPosition = listingPosition.get(left.sellerListingId ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = listingPosition.get(right.sellerListingId ?? "") ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition;
    });

  const total = Number(count?.total ?? 0);
  const nextOffset = offset + sellerListings.length;
  const hasMore = nextOffset < total;

  return {
    assets,
    pagination: {
      hasMore,
      limit,
      nextOffset: hasMore ? nextOffset : null,
      offset,
      total,
    },
  };
}

async function loadProjectsForPropertyAssets(workspaceId: string, projectIds: string[]): Promise<Project[]> {
  if (!projectIds.length) return [];

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
      coalesce(l.leads, 0)::int as leads,
      coalesce(d.revenue_cents, 0)::bigint as "revenueCents"
    from projects p
    left join (
      select workspace_id, project_id, count(*)::int as leads
      from leads
      where workspace_id = $1::uuid and project_id = any($2::uuid[])
      group by workspace_id, project_id
    ) l on l.project_id = p.id and l.workspace_id = p.workspace_id
    left join (
      select workspace_id, project_id, sum(value_cents)::bigint as revenue_cents
      from deals
      where workspace_id = $1::uuid
        and project_id = any($2::uuid[])
        and stage not in ('Gewonnen', 'Verloren', 'Disqualifiziert')
      group by workspace_id, project_id
    ) d on d.project_id = p.id and d.workspace_id = p.workspace_id
    where p.workspace_id = $1::uuid and p.id = any($2::uuid[])
    order by p.created_at asc
  `,
    [workspaceId, projectIds],
  );

  return rows.map(mapProjectRow);
}

async function loadPropertyUnitsForAssetSummaries(
  workspaceId: string,
  projectIds: string[],
  unitIds: string[],
): Promise<PropertyUnit[]> {
  if (!projectIds.length && !unitIds.length) return [];

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
    where pu.workspace_id = $1::uuid
      and (pu.project_id = any($2::uuid[]) or pu.id = any($3::uuid[]))
    order by pu.project_id asc, pu.unit_number asc, pu.id asc
  `,
    [workspaceId, projectIds, unitIds],
  );

  return rows.map(mapPropertyUnitRow);
}

async function loadPropertyReservationsForAssetSummaries(
  workspaceId: string,
  projectIds: string[],
): Promise<PropertyReservation[]> {
  if (!projectIds.length) return [];

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
    where workspace_id = $1::uuid and project_id = any($2::uuid[])
    order by expires_at asc
  `,
    [workspaceId, projectIds],
  );

  return rows.map((row) => ({
    contactId: row.contactId,
    contractMilestone: row.contractMilestone as PropertyReservation["contractMilestone"],
    dealId: row.dealId ?? undefined,
    depositCents: Number(row.depositCents ?? 0),
    expiresAt: toIso(row.expiresAt),
    id: row.id,
    nextAction: row.nextAction,
    projectId: row.projectId,
    status: row.status as PropertyReservation["status"],
    unitId: row.unitId,
    workspaceId: row.workspaceId,
  }));
}

async function loadPropertyBuildingsForAssetSummaries(
  workspaceId: string,
  projectIds: string[],
): Promise<PropertyBuilding[]> {
  if (!projectIds.length) return [];

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
    where workspace_id = $1::uuid and project_id = any($2::uuid[])
    order by name asc
  `,
    [workspaceId, projectIds],
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

async function loadPropertyCostItemsForAssets(
  workspaceId: string,
  propertyIds: string[],
): Promise<PropertyCostItem[]> {
  if (!propertyIds.length) return [];

  const rows = await queryRows<{ id: string; propertyId: string }>(
    `
    select id, property_id as "propertyId"
    from property_cost_items
    where workspace_id = $1::uuid and property_id = any($2::uuid[])
  `,
    [workspaceId, propertyIds],
  );

  return rows.map((row) => ({ id: row.id, propertyId: row.propertyId }) as PropertyCostItem);
}

async function loadPropertyDocumentsForAssets(
  workspaceId: string,
  propertyIds: string[],
): Promise<PropertyDocumentItem[]> {
  if (!propertyIds.length) return [];

  const rows = await queryRows<{
    category: string;
    id: string;
    propertyId: string;
    status: string;
    visibility: string;
  }>(
    `
    select id, property_id as "propertyId", category, status, visibility
    from property_documents
    where workspace_id = $1::uuid and property_id = any($2::uuid[])
  `,
    [workspaceId, propertyIds],
  );

  return rows.map((row) => ({
    category: row.category,
    id: row.id,
    propertyId: row.propertyId,
    status: row.status,
    visibility: row.visibility,
  }) as PropertyDocumentItem);
}

async function loadPropertyMediaForAssets(
  workspaceId: string,
  propertyIds: string[],
): Promise<PropertyMediaItem[]> {
  if (!propertyIds.length) return [];

  const rows = await queryRows<{
    category: string;
    id: string;
    isCover: boolean;
    mediaType: string;
    mimeType: string | null;
    propertyId: string;
    visibility: string;
  }>(
    `
    select
      pm.id,
      pm.property_id as "propertyId",
      pm.media_type as "mediaType",
      ma.mime_type as "mimeType",
      pm.category,
      pm.visibility,
      pm.is_cover as "isCover"
    from property_media pm
    left join media_assets ma on ma.id = pm.media_asset_id and ma.workspace_id = pm.workspace_id::text
    where pm.workspace_id = $1::uuid and pm.property_id = any($2::uuid[])
  `,
    [workspaceId, propertyIds],
  );

  return rows.map((row) => ({
    category: row.category,
    id: row.id,
    isCover: row.isCover,
    mediaType: row.mediaType,
    mimeType: row.mimeType ?? undefined,
    propertyId: row.propertyId,
    visibility: row.visibility,
  }) as PropertyMediaItem);
}

async function loadPropertyTextBlocksForAssets(
  workspaceId: string,
  propertyIds: string[],
): Promise<PropertyTextBlock[]> {
  if (!propertyIds.length) return [];

  const rows = await queryRows<{ content: string; id: string; propertyId: string }>(
    `
    select id, property_id as "propertyId", content
    from property_text_blocks
    where workspace_id = $1::uuid and property_id = any($2::uuid[])
  `,
    [workspaceId, propertyIds],
  );

  return rows.map((row) => ({
    content: row.content,
    id: row.id,
    propertyId: row.propertyId,
  }) as PropertyTextBlock);
}

export async function loadPropertyTextBlocks(workspaceId: string): Promise<PropertyTextBlock[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPropertyTextBlocks");
  const rows = await queryRows<PropertyTextBlockRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      property_id as "propertyId",
      unit_id as "unitId",
      text_key as "textKey",
      channel,
      title,
      content,
      seo_title as "seoTitle",
      seo_description as "seoDescription",
      visibility,
      status,
      position,
      metadata,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from property_text_blocks
    where workspace_id = $1
    order by property_id nulls last, unit_id nulls last, channel asc, position asc, text_key asc
    limit 1500
  `,
    [scopedWorkspaceId],
  );

  return rows.map((row) => ({
    channel: row.channel,
    content: row.content,
    createdAt: toIso(row.createdAt),
    id: row.id,
    metadata: row.metadata ?? undefined,
    position: Number(row.position ?? 0),
    projectId: row.projectId ?? undefined,
    propertyId: row.propertyId ?? undefined,
    seoDescription: row.seoDescription ?? undefined,
    seoTitle: row.seoTitle ?? undefined,
    status: row.status,
    textKey: row.textKey,
    title: row.title,
    unitId: row.unitId ?? undefined,
    updatedAt: toIso(row.updatedAt),
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  }));
}

export async function loadPropertyCostItems(workspaceId: string): Promise<PropertyCostItem[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPropertyCostItems");
  const rows = await queryRows<PropertyCostItemRow>(
    `
    select
      id,
      workspace_id as "workspaceId",
      project_id as "projectId",
      property_id as "propertyId",
      unit_id as "unitId",
      cost_key as "costKey",
      group_key as "groupKey",
      label,
      monthly_net_cents as "monthlyNetCents",
      monthly_vat_cents as "monthlyVatCents",
      monthly_gross_cents as "monthlyGrossCents",
      one_time_net_cents as "oneTimeNetCents",
      one_time_vat_cents as "oneTimeVatCents",
      one_time_gross_cents as "oneTimeGrossCents",
      vat_percent as "vatPercent",
      optional,
      commission_relevant as "commissionRelevant",
      expose_visible as "exposeVisible",
      internal_note as "internalNote",
      position,
      metadata,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from property_cost_items
    where workspace_id = $1
    order by property_id nulls last, unit_id nulls last, group_key asc, position asc, label asc
    limit 1500
  `,
    [scopedWorkspaceId],
  );

  return rows.map((row) => ({
    commissionRelevant: row.commissionRelevant,
    costKey: row.costKey,
    createdAt: toIso(row.createdAt),
    exposeVisible: row.exposeVisible,
    groupKey: row.groupKey,
    id: row.id,
    internalNote: row.internalNote ?? undefined,
    label: row.label,
    metadata: row.metadata ?? undefined,
    monthlyGrossCents: Number(row.monthlyGrossCents ?? 0),
    monthlyNetCents: Number(row.monthlyNetCents ?? 0),
    monthlyVatCents: Number(row.monthlyVatCents ?? 0),
    oneTimeGrossCents: Number(row.oneTimeGrossCents ?? 0),
    oneTimeNetCents: Number(row.oneTimeNetCents ?? 0),
    oneTimeVatCents: Number(row.oneTimeVatCents ?? 0),
    optional: row.optional,
    position: Number(row.position ?? 0),
    projectId: row.projectId ?? undefined,
    propertyId: row.propertyId ?? undefined,
    unitId: row.unitId ?? undefined,
    updatedAt: toIso(row.updatedAt),
    vatPercent: toOptionalNumber(row.vatPercent),
    workspaceId: row.workspaceId,
  }));
}

export async function loadPropertyMedia(workspaceId: string): Promise<PropertyMediaItem[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPropertyMedia");
  const rows = await queryRows<PropertyMediaRow>(
    `
    select
      pm.id,
      pm.workspace_id as "workspaceId",
      pm.project_id as "projectId",
      pm.property_id as "propertyId",
      pm.unit_id as "unitId",
      pm.media_asset_id as "mediaAssetId",
      pm.media_type as "mediaType",
      pm.title,
      pm.alt_text as "altText",
      pm.category,
      pm.visibility,
      pm.is_cover as "isCover",
      pm.position,
      pm.status,
      pm.metadata,
      pm.created_at as "createdAt",
      pm.updated_at as "updatedAt",
      ma.name as "assetName",
      ma.mime_type as "mimeType"
    from property_media pm
    left join media_assets ma
      on ma.id = pm.media_asset_id
     and ma.workspace_id = pm.workspace_id::text
    where pm.workspace_id = $1
    order by pm.property_id nulls last, pm.unit_id nulls last, pm.position asc, pm.created_at desc
    limit 1500
  `,
    [scopedWorkspaceId],
  );

  return rows.map((row) => ({
    altText: row.altText ?? undefined,
    assetName: row.assetName ?? undefined,
    category: row.category,
    createdAt: toIso(row.createdAt),
    id: row.id,
    isCover: row.isCover,
    mediaAssetId: row.mediaAssetId ?? undefined,
    mediaType: row.mediaType,
    metadata: row.metadata ?? undefined,
    mimeType: row.mimeType ?? undefined,
    position: Number(row.position ?? 0),
    projectId: row.projectId ?? undefined,
    propertyId: row.propertyId ?? undefined,
    publicUrl: null,
    status: row.status,
    title: row.title || row.assetName || "Medium",
    unitId: row.unitId ?? undefined,
    updatedAt: toIso(row.updatedAt),
    url: row.mediaAssetId ? `/api/media/files/${row.mediaAssetId}` : undefined,
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  }));
}

export async function loadPropertyDocuments(workspaceId: string): Promise<PropertyDocumentItem[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPropertyDocuments");
  const rows = await queryRows<PropertyDocumentRow>(
    `
    select
      pd.id,
      pd.workspace_id as "workspaceId",
      pd.project_id as "projectId",
      pd.property_id as "propertyId",
      pd.unit_id as "unitId",
      pd.media_asset_id as "mediaAssetId",
      pd.title,
      pd.category,
      pd.status,
      pd.visibility,
      pd.required_for_publication as "requiredForPublication",
      pd.document_date as "documentDate",
      pd.version_label as "versionLabel",
      pd.content,
      pd.approved_by_user_id as "approvedByUserId",
      pd.approved_at as "approvedAt",
      pd.sent_at as "sentAt",
      pd.metadata,
      pd.created_at as "createdAt",
      pd.updated_at as "updatedAt",
      ma.name as "assetName",
      ma.mime_type as "mimeType"
    from property_documents pd
    left join media_assets ma
      on ma.id = pd.media_asset_id
     and ma.workspace_id = pd.workspace_id::text
    where pd.workspace_id = $1
    order by pd.property_id nulls last, pd.unit_id nulls last, pd.category asc, pd.updated_at desc
    limit 1500
  `,
    [scopedWorkspaceId],
  );

  return rows.map((row) => ({
    approvedAt: toOptionalIso(row.approvedAt),
    approvedByUserId: row.approvedByUserId ?? undefined,
    assetName: row.assetName ?? undefined,
    category: row.category,
    content: row.content ?? undefined,
    createdAt: toIso(row.createdAt),
    documentDate: toOptionalIso(row.documentDate),
    id: row.id,
    mediaAssetId: row.mediaAssetId ?? undefined,
    metadata: row.metadata ?? undefined,
    mimeType: row.mimeType ?? undefined,
    projectId: row.projectId ?? undefined,
    propertyId: row.propertyId ?? undefined,
    publicUrl: null,
    requiredForPublication: row.requiredForPublication,
    sentAt: toOptionalIso(row.sentAt),
    status: row.status,
    title: row.title || row.assetName || "Dokument",
    unitId: row.unitId ?? undefined,
    updatedAt: toIso(row.updatedAt),
    url: row.mediaAssetId ? `/api/media/files/${row.mediaAssetId}` : undefined,
    versionLabel: row.versionLabel ?? undefined,
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  }));
}

export async function loadPropertyBuildings(workspaceId: string): Promise<PropertyBuilding[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPropertyBuildings");
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
    where workspace_id = $1
    order by name asc
    limit 500
  `,
    [scopedWorkspaceId],
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

export async function loadPropertyUnits(workspaceId: string): Promise<PropertyUnit[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPropertyUnits");
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
    where pu.workspace_id = $1
    order by pu.project_id, pu.unit_number asc
    limit 2000
  `,
    [scopedWorkspaceId],
  );

  return rows.map(mapPropertyUnitRow);
}

function mapPropertyUnitRow(row: PropertyUnitRow): PropertyUnit {
  return {
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
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value as number)));
}

function buildPropertyUnitWhereClause(workspaceId: string, options: PropertyUnitPaginationOptions) {
  const params: unknown[] = [workspaceId];
  const clauses = ["pu.workspace_id = $1::uuid"];

  if (options.projectId) {
    params.push(options.projectId);
    clauses.push(`pu.project_id = $${params.length}::uuid`);
  }

  if (options.status) {
    params.push(options.status);
    clauses.push(`pu.status = $${params.length}::text`);
  }

  const query = options.q?.trim();
  if (query) {
    params.push(`%${query}%`);
    clauses.push(`pu.unit_number ilike $${params.length}::text`);
  }

  return {
    params,
    whereClause: clauses.join(" and "),
  };
}

export async function loadPaginatedPropertyUnits(
  workspaceId: string,
  options: PropertyUnitPaginationOptions = {},
): Promise<PropertyUnitPaginationResult> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPaginatedPropertyUnits");
  const limit = clampInteger(options.limit, 50, 1, 200);
  const offset = clampInteger(options.offset, 0, 0, 100_000);
  const filter = buildPropertyUnitWhereClause(scopedWorkspaceId, options);

  const summary = await queryOne<{
    availableUnits: number | string;
    blockedUnits: number | string;
    inventoryValueCents: number | string;
    reservedUnits: number | string;
    soldUnits: number | string;
    soldValueCents: number | string;
    totalSalesValueCents: number | string;
    totalUnits: number | string;
  }>(
    `
    select
      count(*)::int as "totalUnits",
      count(*) filter (where pu.status = 'available')::int as "availableUnits",
      count(*) filter (where pu.status = 'reserved')::int as "reservedUnits",
      count(*) filter (where pu.status = 'sold')::int as "soldUnits",
      count(*) filter (where pu.status = 'blocked')::int as "blockedUnits",
      coalesce(sum(pu.price_cents), 0)::bigint as "totalSalesValueCents",
      coalesce(sum(pu.price_cents) filter (where pu.status <> 'sold'), 0)::bigint as "inventoryValueCents",
      coalesce(sum(pu.price_cents) filter (where pu.status = 'sold'), 0)::bigint as "soldValueCents"
    from property_units pu
    where ${filter.whereClause}
  `,
    filter.params,
  );

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
    where ${filter.whereClause}
    order by pu.project_id asc, pu.unit_number asc, pu.id asc
    limit $${filter.params.length + 1}::int
    offset $${filter.params.length + 2}::int
  `,
    [...filter.params, limit, offset],
  );

  const units = rows.map(mapPropertyUnitRow);
  const total = Number(summary?.totalUnits ?? 0);
  const nextOffset = offset + units.length;
  const hasMore = nextOffset < total;

  return {
    units,
    pagination: {
      hasMore,
      limit,
      nextOffset: hasMore ? nextOffset : null,
      offset,
      total,
    },
    summary: {
      availableUnits: Number(summary?.availableUnits ?? 0),
      blockedUnits: Number(summary?.blockedUnits ?? 0),
      inventoryValueCents: Number(summary?.inventoryValueCents ?? 0),
      reservedUnits: Number(summary?.reservedUnits ?? 0),
      soldUnits: Number(summary?.soldUnits ?? 0),
      soldValueCents: Number(summary?.soldValueCents ?? 0),
      totalSalesValueCents: Number(summary?.totalSalesValueCents ?? 0),
      totalUnits: total,
    },
  };
}

export async function loadPropertyReservations(workspaceId: string): Promise<PropertyReservation[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadPropertyReservations");
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
    where workspace_id = $1
    order by expires_at asc
    limit 2000
  `,
    [scopedWorkspaceId],
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

export async function loadFunnels(workspaceId: string): Promise<Funnel[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadFunnels");
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
      conversion_rate as "conversionRate",
      coalesce(
        case
          when jsonb_typeof(tracking->'blueprintRevision') = 'number'
            then (tracking->>'blueprintRevision')::bigint
          else null
        end,
        0
      ) as "blueprintRevision",
      updated_at as "updatedAt"
    from funnels
    where workspace_id = $1
    order by updated_at desc
    limit 250
  `,
    [scopedWorkspaceId],
  );

  return rows.map((row) => ({
    audience: row.audience,
    blueprintRevision: Number(row.blueprintRevision ?? 0),
    conversionRate: Number(row.conversionRate ?? 0),
    entryChannel: row.entryChannel,
    goal: row.goal,
    id: row.id,
    leads: Number(row.leads ?? 0),
    name: row.name,
    ownerUserId: row.ownerUserId ?? undefined,
    projectId: row.projectId ?? "",
    status: row.status,
    updatedAt: toIso(row.updatedAt),
    visits: Number(row.visits ?? 0),
    workspaceId: row.workspaceId,
  }));
}

export async function loadFunnelSteps(workspaceId: string): Promise<FunnelStep[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadFunnelSteps");
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
    where workspace_id = $1
    order by funnel_id, position asc, created_at asc
    limit 1000
  `,
    [scopedWorkspaceId],
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

export async function loadNewsletterSegments(workspaceId: string): Promise<NewsletterSegment[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadNewsletterSegments");
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
    where workspace_id = $1
    order by updated_at desc
    limit 250
  `,
    [scopedWorkspaceId],
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

export async function loadNewsletterCampaigns(workspaceId: string): Promise<NewsletterCampaign[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadNewsletterCampaigns");
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
    where workspace_id = $1
    order by updated_at desc
    limit 250
  `,
    [scopedWorkspaceId],
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

export async function loadCrmBots(workspaceId: string): Promise<CrmBot[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadCrmBots");
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
    where workspace_id = $1
    order by updated_at desc
    limit 100
  `,
    [scopedWorkspaceId],
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

export async function loadCalendarEvents(
  workspaceId: string,
  visibilityScope: CrmActorVisibilityScope = { kind: "workspace" },
): Promise<CalendarEvent[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadCalendarEvents");
  const params: unknown[] = [scopedWorkspaceId];
  const actorFilter = visibilityScope.kind === "actor"
    ? `and (
        owner_user_id = $2::uuid
        or ($3::boolean and project_id is not null and exists (
          select 1 from public.project_pipeline_permissions permission
          where permission.workspace_id = calendar_events.workspace_id
            and permission.project_id = calendar_events.project_id
            and permission.user_id = $2::uuid
            and permission.can_edit_deals = true
        ))
      )`
    : "";
  if (visibilityScope.kind === "actor") {
    params.push(visibilityScope.userId, visibilityScope.allowProjectEditVisibility);
  }
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
    where workspace_id = $1
      ${actorFilter}
    order by starts_at asc
    limit 500
  `,
    params,
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
      notes: typeof metadata.notes === "string" ? metadata.notes : undefined,
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

export async function loadContacts(
  workspaceId: string,
  visibilityScope: ContactVisibilityScope = { kind: "workspace" },
): Promise<Contact[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadContacts");

  if (visibilityScope.kind === "none") {
    return [];
  }

  const filters = ["c.archived_at is null"];
  const params: string[] = [scopedWorkspaceId];
  filters.push("c.workspace_id = $1");

  if (visibilityScope.kind === "own") {
    params.push(visibilityScope.userId);
    filters.push(`c.owner_user_id = $${params.length}`);
  }

  const rows = await queryRows<ContactRow>(
    `
    select
      c.id,
      c.workspace_id as "workspaceId",
      c.project_id as "projectId",
      c.organization_id as "organizationId",
      c.owner_user_id as "ownerUserId",
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
    where ${filters.join(" and ")}
    order by c.updated_at desc
    limit 500
  `,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? "",
    organizationId: row.organizationId ?? undefined,
    ownerUserId: row.ownerUserId ?? undefined,
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

export async function loadLeads(
  workspaceId: string,
  visibilityScope: CrmActorVisibilityScope = { kind: "workspace" },
): Promise<Lead[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadLeads");
  const params: unknown[] = [scopedWorkspaceId];
  const actorFilter = visibilityScope.kind === "actor"
    ? `and (
        assigned_to_user_id = $2::uuid
        or ($3::boolean and project_id is not null and exists (
          select 1 from public.project_pipeline_permissions permission
          where permission.workspace_id = leads.workspace_id
            and permission.project_id = leads.project_id
            and permission.user_id = $2::uuid
            and permission.can_edit_deals = true
        ))
      )`
    : "";
  if (visibilityScope.kind === "actor") {
    params.push(visibilityScope.userId, visibilityScope.allowProjectEditVisibility);
  }
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
    where workspace_id = $1
      ${actorFilter}
    order by received_at desc
    limit 500
  `,
    params,
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

export async function loadDeals(
  workspaceId: string,
  visibilityScope: CrmActorVisibilityScope = { kind: "workspace" },
): Promise<Deal[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadDeals");
  const params: unknown[] = [scopedWorkspaceId];
  const actorFilter = visibilityScope.kind === "actor"
    ? `and (
        owner_user_id = $2::uuid
        or ($3::boolean and project_id is not null and exists (
          select 1 from public.project_pipeline_permissions permission
          where permission.workspace_id = deals.workspace_id
            and permission.project_id = deals.project_id
            and permission.user_id = $2::uuid
            and permission.can_edit_deals = true
        ))
      )`
    : "";
  if (visibilityScope.kind === "actor") {
    params.push(visibilityScope.userId, visibilityScope.allowProjectEditVisibility);
  }
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
    where workspace_id = $1
      ${actorFilter}
    order by updated_at desc
    limit 500
  `,
    params,
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

export async function loadTasks(
  workspaceId: string,
  visibilityScope: CrmActorVisibilityScope = { kind: "workspace" },
): Promise<Task[]> {
  const scopedWorkspaceId = requireWorkspaceId(workspaceId, "loadTasks");
  const params: unknown[] = [scopedWorkspaceId];
  const actorFilter = visibilityScope.kind === "actor"
    ? `and (
        t.owner_user_id = $2::uuid
        or ($3::boolean and t.project_id is not null and exists (
          select 1 from public.project_pipeline_permissions permission
          where permission.workspace_id = t.workspace_id
            and permission.project_id = t.project_id
            and permission.user_id = $2::uuid
            and permission.can_edit_deals = true
        ))
      )`
    : "";
  if (visibilityScope.kind === "actor") {
    params.push(visibilityScope.userId, visibilityScope.allowProjectEditVisibility);
  }
  const rows = await queryRows<TaskRow>(
    `
    select
      t.id,
      t.workspace_id as "workspaceId",
      t.project_id as "projectId",
      t.contact_id as "contactId",
      t.lead_id as "leadId",
      t.owner_user_id as "ownerUserId",
      t.title,
      t.metadata,
      p.name as project,
      t.due_at as due,
      t.priority,
      t.status
    from tasks t
    left join projects p on p.id = t.project_id and p.workspace_id = t.workspace_id
    where t.workspace_id = $1
      ${actorFilter}
    order by t.due_at asc nulls last, t.created_at desc
    limit 500
  `,
    params,
  );

  return rows.map((row) => ({
    description: typeof row.metadata?.description === "string" ? row.metadata.description : undefined,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? "",
    contactId: row.contactId ?? undefined,
    leadId: row.leadId ?? undefined,
    ownerUserId: row.ownerUserId ?? undefined,
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

function normalizePriceVisibility(value: unknown): PropertyPriceVisibility {
  if (value === "price_on_request") return "price_on_request";
  if (value === "hide_price") return "hide_price";
  return "publish_price";
}

function normalizePriceVisibilityMap(value: Record<string, unknown> | null | undefined) {
  const entries = Object.entries(asRecord(value)).map(([key, item]) => [key, normalizePriceVisibility(item)] as const);
  return Object.fromEntries(entries);
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
  if (value === "bestätigt" || value === "besta\u0065tigt") return "bestätigt";
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
