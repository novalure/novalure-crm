import type { AppSession } from "@/lib/auth/session";
import type { WorkspaceRole } from "@/lib/crm-types";
import type { ProductRole } from "@/lib/product-model";

export type CrmDeleteObjectType =
  | "campaign"
  | "calendar_event"
  | "contact"
  | "deal"
  | "funnel"
  | "lead"
  | "project"
  | "reservation"
  | "task";

export type CrmDeletePermissionRule = {
  action: "archive" | "internal_replace" | "not_exposed";
  allowedProductRoles: ProductRole[];
  allowedWorkspaceRoles: WorkspaceRole[];
  objectType: CrmDeleteObjectType;
  reversible: boolean;
};

const crmAdministratorProductRoles: ProductRole[] = [
  "platform_admin",
  "customer_owner",
  "workspace_admin",
  "novalure_onboarding",
  "novalure_customer_success",
];

export const crmDeletePermissionRules: CrmDeletePermissionRule[] = [
  {
    action: "not_exposed",
    allowedProductRoles: [],
    allowedWorkspaceRoles: [],
    objectType: "lead",
    reversible: true,
  },
  {
    action: "archive",
    allowedProductRoles: crmAdministratorProductRoles,
    allowedWorkspaceRoles: ["owner", "admin"],
    objectType: "contact",
    reversible: true,
  },
  {
    action: "not_exposed",
    allowedProductRoles: [],
    allowedWorkspaceRoles: [],
    objectType: "project",
    reversible: true,
  },
  {
    action: "not_exposed",
    allowedProductRoles: [],
    allowedWorkspaceRoles: [],
    objectType: "deal",
    reversible: true,
  },
  {
    action: "not_exposed",
    allowedProductRoles: [],
    allowedWorkspaceRoles: [],
    objectType: "task",
    reversible: true,
  },
  {
    action: "not_exposed",
    allowedProductRoles: [],
    allowedWorkspaceRoles: [],
    objectType: "calendar_event",
    reversible: true,
  },
  {
    action: "not_exposed",
    allowedProductRoles: [],
    allowedWorkspaceRoles: [],
    objectType: "campaign",
    reversible: true,
  },
  {
    action: "internal_replace",
    allowedProductRoles: ["platform_admin", "workspace_admin", "customer_owner"],
    allowedWorkspaceRoles: ["owner", "admin"],
    objectType: "funnel",
    reversible: false,
  },
  {
    action: "not_exposed",
    allowedProductRoles: [],
    allowedWorkspaceRoles: [],
    objectType: "reservation",
    reversible: true,
  },
];

export function canArchiveCrmObject(session: AppSession, objectType: CrmDeleteObjectType) {
  const rule = crmDeletePermissionRules.find((item) => item.objectType === objectType);
  if (!rule || rule.action !== "archive") return false;

  return (
    rule.allowedWorkspaceRoles.includes(session.role) ||
    (session.productRole ? rule.allowedProductRoles.includes(session.productRole) : false)
  );
}
