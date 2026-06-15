import type { Project } from "@/lib/crm-types";

export type TechnicalAppRole = "owner" | "admin" | "agent" | "assistant";

export type WorkspaceOperatingModel =
  | "self_service_customer"
  | "managed_by_novalure"
  | "hybrid"
  | "novalure_internal";

export type WorkspaceCustomerType =
  | "real_estate_broker"
  | "property_developer"
  | "hybrid_real_estate"
  | "novalure_internal";

export type WorkspaceTeamStructure =
  | "no_sales_team"
  | "small_team"
  | "project_sales_available"
  | "backoffice_available";

export type CalendarProviderChoice = "microsoft" | "google" | "none";

export type ProductRole =
  | "platform_admin"
  | "novalureGrowth"
  | "novalureServiceOps"
  | "novalureAdmin"
  | "novalure_sales"
  | "novalure_onboarding"
  | "novalure_customer_success"
  | "novalure_operator"
  | "customer_owner"
  | "workspace_admin"
  | "team_member"
  | "broker_agent"
  | "developer_sales"
  | "project_sales_member"
  | "assistant_backoffice"
  | "external_partner"
  | "viewer";

export type ProductCapability =
  | "analytics:read"
  | "bots:publish"
  | "calendar:manage"
  | "customer-access:manage"
  | "customer-access:read"
  | "funnels:publish"
  | "growth-workspace:operate"
  | "knowledge:write"
  | "managed-service:operate"
  | "newsletter:send"
  | "novalure:internal"
  | "pipeline:write"
  | "reservations:write"
  | "settings:manage"
  | "workspace:admin"
  | "workspace:operate"
  | "workspace:read";

export type WorkspaceProductContext = {
  activeCalendarProvider: CalendarProviderChoice;
  connectedCalendarProviders: CalendarProviderChoice[];
  customerType: WorkspaceCustomerType;
  enabledModules: WorkspaceEnabledModules;
  isNovalureGrowthWorkspace: boolean;
  operatingModel: WorkspaceOperatingModel;
  productRole: ProductRole;
  setupState?: Record<string, unknown> | null;
  teamStructure: WorkspaceTeamStructure;
  workspaceId: string;
  workspaceName: string;
  workspacePlan: string;
};

export const NOVALURE_GROWTH_WORKSPACE_ID = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
export const NOVALURE_GROWTH_WORKSPACE_NAME = "Novalure Growth";
export const NOVALURE_GROWTH_WORKSPACE_SLUG = "novalure-growth";

export const NOVALURE_GROWTH_PIPELINE_STAGES = [
  { key: "new", name: "Neu", probability: 5 },
  { key: "qualified", name: "Qualifiziert", probability: 20 },
  { key: "demo_booked", name: "Demo gebucht", probability: 35 },
  { key: "demo_held", name: "Demo gehalten", probability: 50 },
  { key: "offer", name: "Angebot", probability: 65 },
  { key: "pilot", name: "Pilot", probability: 80 },
  { key: "won", name: "Gewonnen", probability: 100, category: "won" },
  { key: "lost", name: "Verloren", probability: 0, category: "lost" },
] as const;

export const NOVALURE_GROWTH_LEAD_SOURCES = [
  "Website",
  "Empfehlung",
  "LinkedIn",
  "Partner",
  "Event",
  "Newsletter",
  "Outbound",
  "Formular",
] as const;

export type NovalureGrowthLeadSource = (typeof NOVALURE_GROWTH_LEAD_SOURCES)[number];

export type WorkspaceModuleKey =
  | "dashboard"
  | "leadInbox"
  | "contacts"
  | "pipeline"
  | "deals"
  | "tasks"
  | "calendar"
  | "communication"
  | "funnels"
  | "newsletter"
  | "bots"
  | "knowledge"
  | "analytics"
  | "settings"
  | "objectsMandates"
  | "units"
  | "reservations"
  | "projectOverview";

export type WorkspaceEnabledModules = Record<WorkspaceModuleKey, boolean>;

export const workspaceModuleKeys: WorkspaceModuleKey[] = [
  "dashboard",
  "leadInbox",
  "contacts",
  "pipeline",
  "deals",
  "tasks",
  "calendar",
  "communication",
  "funnels",
  "newsletter",
  "bots",
  "knowledge",
  "analytics",
  "settings",
  "objectsMandates",
  "units",
  "reservations",
  "projectOverview",
];

export const defaultWorkspaceEnabledModules: WorkspaceEnabledModules = workspaceModuleKeys.reduce(
  (modules, key) => {
    modules[key] = true;
    return modules;
  },
  {} as WorkspaceEnabledModules,
);

export const novalureGrowthDisabledModules: WorkspaceModuleKey[] = [
  "objectsMandates",
  "units",
  "reservations",
  "projectOverview",
];

export const workspaceOperatingModels: WorkspaceOperatingModel[] = [
  "self_service_customer",
  "managed_by_novalure",
  "hybrid",
  "novalure_internal",
];

export const workspaceCustomerTypes: WorkspaceCustomerType[] = [
  "real_estate_broker",
  "property_developer",
  "hybrid_real_estate",
  "novalure_internal",
];

export const workspaceTeamStructures: WorkspaceTeamStructure[] = [
  "no_sales_team",
  "small_team",
  "project_sales_available",
  "backoffice_available",
];

export const calendarProviderChoices: CalendarProviderChoice[] = ["microsoft", "google", "none"];

const novalureWorkspaceSignals = ["novalure", "internal", "jarvis"];
const developerSignals = ["developer", "bautr", "neubau", "unit", "einheit", "projektvertrieb"];
const brokerSignals = ["broker", "makler", "seller", "verk", "buyer", "kaeufer", "kaufer", "mandat"];

const productRoleCapabilities: Record<ProductRole, ProductCapability[]> = {
  platform_admin: [
    "analytics:read",
    "bots:publish",
    "calendar:manage",
    "customer-access:manage",
    "customer-access:read",
    "funnels:publish",
    "knowledge:write",
    "managed-service:operate",
    "newsletter:send",
    "novalure:internal",
    "pipeline:write",
    "reservations:write",
    "settings:manage",
    "workspace:admin",
    "workspace:operate",
    "workspace:read",
  ],
  novalureGrowth: [
    "analytics:read",
    "calendar:manage",
    "funnels:publish",
    "growth-workspace:operate",
    "knowledge:write",
    "newsletter:send",
    "pipeline:write",
    "workspace:operate",
    "workspace:read",
  ],
  novalureServiceOps: [
    "analytics:read",
    "calendar:manage",
    "customer-access:read",
    "knowledge:write",
    "managed-service:operate",
    "novalure:internal",
    "workspace:operate",
    "workspace:read",
  ],
  novalureAdmin: [
    "analytics:read",
    "bots:publish",
    "customer-access:manage",
    "customer-access:read",
    "knowledge:write",
    "managed-service:operate",
    "novalure:internal",
    "settings:manage",
    "workspace:admin",
    "workspace:operate",
    "workspace:read",
  ],
  novalure_sales: [
    "analytics:read",
    "calendar:manage",
    "customer-access:read",
    "funnels:publish",
    "managed-service:operate",
    "novalure:internal",
    "pipeline:write",
    "workspace:operate",
    "workspace:read",
  ],
  novalure_onboarding: [
    "analytics:read",
    "bots:publish",
    "calendar:manage",
    "customer-access:manage",
    "customer-access:read",
    "funnels:publish",
    "knowledge:write",
    "managed-service:operate",
    "novalure:internal",
    "pipeline:write",
    "settings:manage",
    "workspace:admin",
    "workspace:operate",
    "workspace:read",
  ],
  novalure_customer_success: [
    "analytics:read",
    "calendar:manage",
    "customer-access:manage",
    "customer-access:read",
    "managed-service:operate",
    "novalure:internal",
    "pipeline:write",
    "settings:manage",
    "workspace:operate",
    "workspace:read",
  ],
  novalure_operator: [
    "analytics:read",
    "calendar:manage",
    "managed-service:operate",
    "novalure:internal",
    "pipeline:write",
    "reservations:write",
    "workspace:operate",
    "workspace:read",
  ],
  customer_owner: [
    "analytics:read",
    "bots:publish",
    "calendar:manage",
    "funnels:publish",
    "knowledge:write",
    "newsletter:send",
    "pipeline:write",
    "reservations:write",
    "settings:manage",
    "workspace:admin",
    "workspace:operate",
    "workspace:read",
  ],
  workspace_admin: [
    "analytics:read",
    "bots:publish",
    "calendar:manage",
    "funnels:publish",
    "knowledge:write",
    "newsletter:send",
    "pipeline:write",
    "reservations:write",
    "settings:manage",
    "workspace:admin",
    "workspace:operate",
    "workspace:read",
  ],
  team_member: [
    "analytics:read",
    "calendar:manage",
    "funnels:publish",
    "pipeline:write",
    "workspace:operate",
    "workspace:read",
  ],
  broker_agent: [
    "analytics:read",
    "calendar:manage",
    "funnels:publish",
    "newsletter:send",
    "pipeline:write",
    "workspace:operate",
    "workspace:read",
  ],
  developer_sales: [
    "analytics:read",
    "calendar:manage",
    "pipeline:write",
    "reservations:write",
    "workspace:operate",
    "workspace:read",
  ],
  project_sales_member: [
    "analytics:read",
    "calendar:manage",
    "pipeline:write",
    "reservations:write",
    "workspace:operate",
    "workspace:read",
  ],
  assistant_backoffice: [
    "analytics:read",
    "calendar:manage",
    "pipeline:write",
    "workspace:operate",
    "workspace:read",
  ],
  external_partner: ["analytics:read", "workspace:read"],
  viewer: ["analytics:read", "workspace:read"],
};

export const productRoles: ProductRole[] = Object.keys(productRoleCapabilities) as ProductRole[];

export function isProductRole(value: unknown): value is ProductRole {
  return typeof value === "string" && productRoles.includes(value as ProductRole);
}

export function isWorkspaceOperatingModel(value: unknown): value is WorkspaceOperatingModel {
  return typeof value === "string" && workspaceOperatingModels.includes(value as WorkspaceOperatingModel);
}

export function isWorkspaceCustomerType(value: unknown): value is WorkspaceCustomerType {
  return typeof value === "string" && workspaceCustomerTypes.includes(value as WorkspaceCustomerType);
}

export function isWorkspaceTeamStructure(value: unknown): value is WorkspaceTeamStructure {
  return typeof value === "string" && workspaceTeamStructures.includes(value as WorkspaceTeamStructure);
}

export function isCalendarProviderChoice(value: unknown): value is CalendarProviderChoice {
  return typeof value === "string" && calendarProviderChoices.includes(value as CalendarProviderChoice);
}

export function getProductRoleCapabilities(role: ProductRole) {
  return productRoleCapabilities[role] ?? productRoleCapabilities.viewer;
}

export function hasProductCapability(role: ProductRole, capability: ProductCapability) {
  return getProductRoleCapabilities(role).includes(capability);
}

export function hasAnyProductCapability(role: ProductRole, capabilities: ProductCapability[]) {
  return capabilities.some((capability) => hasProductCapability(role, capability));
}

export function isNovalureProductRole(role: ProductRole) {
  return hasProductCapability(role, "novalure:internal");
}

export function mapProductRoleToTechnicalRole(role: ProductRole): TechnicalAppRole {
  if (role === "platform_admin" || role === "novalureAdmin" || role === "customer_owner") return "owner";
  if (
    role === "novalureServiceOps" ||
    role === "novalure_onboarding" ||
    role === "novalure_customer_success" ||
    role === "workspace_admin"
  ) {
    return "admin";
  }
  if (
    role === "novalureGrowth" ||
    role === "novalure_sales" ||
    role === "novalure_operator" ||
    role === "broker_agent" ||
    role === "developer_sales" ||
    role === "project_sales_member" ||
    role === "team_member"
  ) {
    return "agent";
  }
  return "assistant";
}

export function isNovalureGrowthLeadSource(value: unknown): value is NovalureGrowthLeadSource {
  return typeof value === "string" && NOVALURE_GROWTH_LEAD_SOURCES.includes(value as NovalureGrowthLeadSource);
}

export function isNovalureGrowthWorkspace(input: {
  setupState?: Record<string, unknown> | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
}) {
  const setupState = input.setupState ?? {};
  const workspaceKey = typeof setupState.workspaceKey === "string" ? setupState.workspaceKey : "";
  const slug = typeof setupState.slug === "string" ? setupState.slug : "";
  return (
    input.workspaceId === NOVALURE_GROWTH_WORKSPACE_ID ||
    input.workspaceName === NOVALURE_GROWTH_WORKSPACE_NAME ||
    workspaceKey === NOVALURE_GROWTH_WORKSPACE_SLUG ||
    slug === NOVALURE_GROWTH_WORKSPACE_SLUG
  );
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function getWorkspaceEnabledModules(input: {
  setupState?: Record<string, unknown> | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
} = {}): WorkspaceEnabledModules {
  const configured = getRecord(input.setupState?.enabledModules);
  const modules = { ...defaultWorkspaceEnabledModules };

  if (isNovalureGrowthWorkspace(input)) {
    for (const key of novalureGrowthDisabledModules) {
      modules[key] = false;
    }
  }

  for (const key of workspaceModuleKeys) {
    if (typeof configured[key] === "boolean") {
      modules[key] = configured[key] as boolean;
    }
  }

  return modules;
}

export function isWorkspaceModuleEnabled(
  modules: WorkspaceEnabledModules,
  key: WorkspaceModuleKey,
) {
  return modules[key] !== false;
}

export function resolveProductRole(input: {
  productRole?: ProductRole | null;
  technicalRole: TechnicalAppRole;
  workspaceName?: string | null;
}) {
  if (input.productRole) return input.productRole;
  if (input.workspaceName === NOVALURE_GROWTH_WORKSPACE_NAME) return "novalureGrowth";

  const internalWorkspace = isNovalureWorkspaceName(input.workspaceName);
  if (internalWorkspace) {
    if (input.technicalRole === "owner") return "platform_admin";
    if (input.technicalRole === "admin") return "novalure_customer_success";
    if (input.technicalRole === "agent") return "novalure_operator";
    return "assistant_backoffice";
  }

  if (input.technicalRole === "owner") return "customer_owner";
  if (input.technicalRole === "admin") return "workspace_admin";
  if (input.technicalRole === "agent") return "team_member";
  return "assistant_backoffice";
}

export function inferCustomerType(input: {
  customerType?: WorkspaceCustomerType | null;
  projects?: Pick<Project, "name" | "type">[];
  workspaceName?: string | null;
}): WorkspaceCustomerType {
  if (input.customerType) return input.customerType;
  if (isNovalureWorkspaceName(input.workspaceName)) return "novalure_internal";

  const source = [
    input.workspaceName,
    ...(input.projects ?? []).flatMap((project) => [project.name, project.type]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const hasDeveloperSignal = developerSignals.some((signal) => source.includes(signal));
  const hasBrokerSignal = brokerSignals.some((signal) => source.includes(signal));

  if (hasDeveloperSignal && hasBrokerSignal) return "hybrid_real_estate";
  if (hasDeveloperSignal) return "property_developer";
  return "real_estate_broker";
}

export function inferOperatingModel(input: {
  operatingModel?: WorkspaceOperatingModel | null;
  productRole: ProductRole;
  workspaceName?: string | null;
}): WorkspaceOperatingModel {
  if (input.operatingModel) return input.operatingModel;
  if (isNovalureWorkspaceName(input.workspaceName)) return "novalure_internal";
  if (hasProductCapability(input.productRole, "managed-service:operate")) return "managed_by_novalure";
  return "self_service_customer";
}

export function createWorkspaceProductContext(input: {
  activeCalendarProvider?: CalendarProviderChoice | null;
  connectedCalendarProviders?: CalendarProviderChoice[];
  customerType?: WorkspaceCustomerType | null;
  operatingModel?: WorkspaceOperatingModel | null;
  productRole?: ProductRole | null;
  projects?: Pick<Project, "name" | "type">[];
  setupState?: Record<string, unknown> | null;
  teamStructure?: WorkspaceTeamStructure | null;
  technicalRole: TechnicalAppRole;
  workspaceId: string;
  workspaceName: string;
  workspacePlan?: string | null;
}): WorkspaceProductContext {
  const productRole = resolveProductRole({
    productRole: input.productRole,
    technicalRole: input.technicalRole,
    workspaceName: input.workspaceName,
  });
  const customerType = inferCustomerType({
    customerType: input.customerType,
    projects: input.projects,
    workspaceName: input.workspaceName,
  });
  const operatingModel = inferOperatingModel({
    operatingModel: input.operatingModel,
    productRole,
    workspaceName: input.workspaceName,
  });
  const enabledModules = getWorkspaceEnabledModules({
    setupState: input.setupState,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
  });

  return {
    activeCalendarProvider: input.activeCalendarProvider ?? "none",
    connectedCalendarProviders: input.connectedCalendarProviders ?? [],
    customerType,
    enabledModules,
    isNovalureGrowthWorkspace: isNovalureGrowthWorkspace({
      setupState: input.setupState,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
    }),
    operatingModel,
    productRole,
    setupState: input.setupState,
    teamStructure: input.teamStructure ?? inferTeamStructure(customerType, operatingModel),
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    workspacePlan: input.workspacePlan ?? "Growth Workspace",
  };
}

function inferTeamStructure(
  customerType: WorkspaceCustomerType,
  operatingModel: WorkspaceOperatingModel,
): WorkspaceTeamStructure {
  if (operatingModel === "managed_by_novalure") return "no_sales_team";
  if (customerType === "property_developer") return "project_sales_available";
  if (customerType === "novalure_internal") return "small_team";
  return "small_team";
}

function isNovalureWorkspaceName(value: string | null | undefined) {
  const normalized = value?.toLowerCase() ?? "";
  return novalureWorkspaceSignals.some((signal) => normalized.includes(signal));
}
