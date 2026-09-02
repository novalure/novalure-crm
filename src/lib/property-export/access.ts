import type { AppSession } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { getPropertyActionStates } from "@/lib/property-department";
import { hasProductCapability } from "@/lib/product-model";

const workspacePropertyManagerRoles = new Set<AppSession["productRole"]>([
  "platform_admin",
  "novalureGrowth",
  "novalureAdmin",
  "novalure_onboarding",
  "novalure_customer_success",
  "novalure_operator",
  "customer_owner",
  "workspace_admin",
  "team_member",
]);

const projectScopedPropertyRoles = new Set<AppSession["productRole"]>([
  "developer_sales",
  "project_sales_member",
]);

type PropertyExportAccessActor = Pick<AppSession, "productRole" | "role">;

/** Mirrors the property command-center export policy, including launch scope. */
export function canAccessPropertyExports(session: PropertyExportAccessActor) {
  return getPropertyActionStates({
    productRole: session.productRole,
    technicalRole: session.role,
  }).exportChannel.enabled;
}

/** Revalidates the write permission and operating capability used by the enqueue route. */
export function canProcessPropertyExports(session: PropertyExportAccessActor) {
  return can(session.role, "crm:write") &&
    hasProductCapability(session.productRole, "workspace:operate") &&
    canAccessPropertyExports(session);
}

export function hasWorkspacePropertyRecordScope(session: AppSession) {
  return session.role === "owner" ||
    session.role === "admin" ||
    workspacePropertyManagerRoles.has(session.productRole);
}

export function hasProjectPropertyRecordScope(session: AppSession) {
  return projectScopedPropertyRoles.has(session.productRole);
}
