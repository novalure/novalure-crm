import type { ProductRole, TechnicalAppRole } from "@/lib/product-model";

export type ContactAccessActor = {
  productRole: ProductRole;
  role: TechnicalAppRole;
  userId?: string | null;
};

export type ContactVisibilityScope =
  | { kind: "workspace" }
  | { kind: "own"; userId: string }
  | { kind: "none" };

const workspaceContactManagerRoles = new Set<ProductRole>([
  "platform_admin",
  "novalureGrowth",
  "novalureAdmin",
  "novalure_sales",
  "novalure_onboarding",
  "novalure_customer_success",
  "novalure_operator",
  "customer_owner",
  "workspace_admin",
]);

const contactWriterRoles = new Set<ProductRole>([
  "platform_admin",
  "novalureGrowth",
  "novalureAdmin",
  "novalure_sales",
  "novalure_onboarding",
  "novalure_customer_success",
  "novalure_operator",
  "customer_owner",
  "workspace_admin",
  "team_member",
  "broker_agent",
  "developer_sales",
  "project_sales_member",
  "assistant_backoffice",
]);

export function canViewAllWorkspaceContacts(actor: ContactAccessActor) {
  if (actor.role === "owner" || actor.role === "admin") return true;
  return workspaceContactManagerRoles.has(actor.productRole);
}

export function canAssignContactOwner(actor: ContactAccessActor) {
  return canViewAllWorkspaceContacts(actor);
}

export function canWriteContacts(actor: ContactAccessActor) {
  return contactWriterRoles.has(actor.productRole);
}

export function getContactVisibilityScope(actor: ContactAccessActor): ContactVisibilityScope {
  if (canViewAllWorkspaceContacts(actor)) {
    return { kind: "workspace" };
  }

  return actor.userId ? { kind: "own", userId: actor.userId } : { kind: "none" };
}
