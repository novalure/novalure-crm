import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AppSession } from "./auth/session";
import { CrmCommandError } from "./crm-command";

type Scope = { projectId: string; companyId: string; locationId?: string };
export type WebsiteSalesMachineAuthority = Readonly<{
  workspaceId: string; actorId: string; identityId: string; grantId: string; workloadId: string;
  departmentId: "SALES"; agentId: string; taskId: string; scope: Scope;
  operation: string; mode: "execute" | "read" | "reconcile"; target: "workflow" | "studio";
}>;
const authority = new AsyncLocalStorage<WebsiteSalesMachineAuthority>();

/** Server composition only: installed after OIDC, saved grant and delegation verification.
 * No request field or generic service session can create this context. */
export function withWebsiteSalesMachineAuthority<T>(value: WebsiteSalesMachineAuthority, callback: () => Promise<T>) {
  return authority.run(Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }) }), callback);
}

export function websiteSalesActorAuthority(session: AppSession, scope: Scope, operation: string, target: "workflow" | "studio" = "workflow") {
  if (!session.authenticated || session.source === "demo") throw new CrmCommandError("SESSION_REQUIRED", "Authenticated CRM actor required", 401);
  if (!session.serviceIdentity) return null;
  const bound = authority.getStore();
  if (!bound) throw new CrmCommandError("SESSION_REQUIRED", "Session or explicit Sales contract required", 401);
  if (bound.actorId !== session.userId || bound.workspaceId !== session.workspaceId
    || bound.identityId !== session.serviceIdentity.identityId || bound.target !== target || bound.scope.projectId !== scope.projectId
    || bound.scope.companyId !== scope.companyId || bound.scope.locationId !== scope.locationId
    || operation !== "read" && bound.operation !== operation) {
    throw new CrmCommandError("SALES_MACHINE_AUTHORITY_REQUIRED", "Explicit scoped Sales contract required", 403);
  }
  return { workloadId: bound.workloadId, grantId: bound.grantId, departmentId: bound.departmentId,
    agentId: bound.agentId, taskId: bound.taskId };
}
