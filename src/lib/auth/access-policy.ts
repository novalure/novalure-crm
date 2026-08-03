import type { AppSession } from "@/lib/auth/session";
import type { WorkspaceRole } from "@/lib/crm-types";
import type { ProductRole } from "@/lib/product-model";

export type WorkspaceAccessTarget = {
  id: string;
  productRole: ProductRole | null;
  role: WorkspaceRole;
  status: "active" | "invited" | "suspended";
  workspaceId: string;
};

type AccessOperation = "invite" | "password_reset" | "resend_invitation" | "update";

export function authorizeWorkspaceAccessOperation(input: {
  actor: AppSession;
  operation: AccessOperation;
  target?: WorkspaceAccessTarget | null;
}) {
  const { actor, operation, target } = input;
  if (!actor.workspaceId || (target && target.workspaceId !== actor.workspaceId)) {
    return { ok: false as const, reason: "Workspace scope mismatch", status: 403 };
  }

  const isPlatformAdmin = actor.productRole === "platform_admin";
  const isWorkspaceOwner = actor.role === "owner" || actor.productRole === "customer_owner";
  const canManage =
    isPlatformAdmin ||
    isWorkspaceOwner ||
    actor.role === "admin" ||
    actor.productPermissions.includes("workspace:admin");

  if (!canManage) {
    return { ok: false as const, reason: "Workspace access management is forbidden", status: 403 };
  }

  if (!target) return operation === "invite"
    ? { ok: true as const }
    : { ok: false as const, reason: "Workspace user not found", status: 404 };

  const targetIsOwner = target.role === "owner" || target.productRole === "customer_owner";
  if (targetIsOwner && actor.userId !== target.id && !isPlatformAdmin) {
    return { ok: false as const, reason: "Only the account owner can change owner credentials", status: 403 };
  }

  if (actor.userId === target.id && operation === "update") {
    return { ok: false as const, reason: "Use the personal security settings for your own account", status: 403 };
  }

  return { ok: true as const };
}
