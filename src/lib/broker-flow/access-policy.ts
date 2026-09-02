import type { AppSession } from "@/lib/auth/session";

const brokerFinancialProductRoles = new Set<AppSession["productRole"]>([
  "platform_admin",
  "novalureAdmin",
  "customer_owner",
  "workspace_admin",
]);

const brokerProjectEditProductRoles = new Set<AppSession["productRole"]>([
  "developer_sales",
  "project_sales_member",
]);

export function canManageBrokerFinancials(session: AppSession) {
  if (session.role === "assistant") return false;
  return session.role === "owner"
    || session.role === "admin"
    || brokerFinancialProductRoles.has(session.productRole);
}

export function canUseBrokerProjectEditScope(session: AppSession) {
  return brokerProjectEditProductRoles.has(session.productRole);
}
