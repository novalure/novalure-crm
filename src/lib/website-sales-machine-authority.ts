import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AppSession } from "./auth/session";
import { CrmCommandError } from "./crm-command";

type Scope = { projectId: string; companyId: string; locationId?: string };
export type WebsiteSalesMachineAuthority = Readonly<{
  workspaceId: string; actorId: string; identityId: string; grantId: string; workloadId: string;
  departmentId: "SALES"; agentId: string; taskId: string; scope: Scope;
  operation: string; mode: "execute" | "read" | "reconcile"; target: "workflow" | "studio" | "lifecycle" | "autonomy";
  resources?: readonly Readonly<{companyId:string;locationId:string;grantId:string;digest:string}>[];
}>;
const authority = new AsyncLocalStorage<WebsiteSalesMachineAuthority>();

/** Server composition only: installed after OIDC, saved grant and delegation verification.
 * No request field or generic service session can create this context. */
export function withWebsiteSalesMachineAuthority<T>(value: WebsiteSalesMachineAuthority, callback: () => Promise<T>) {
  return authority.run(Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }) }), callback);
}

export function websiteSalesActorAuthority(session: AppSession, scope: Scope, operation: string, target: "workflow" | "studio" | "lifecycle" | "autonomy" = "workflow") {
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
    agentId: bound.agentId, taskId: bound.taskId, ...(bound.resources?{resourceGrants:bound.resources}: {}) };
}

/** Read/write admission for additional exact resources verified and locked by the machine receiver. */
export function websiteSalesResourceAuthority(session:AppSession,scope:Scope){
 if(!session.serviceIdentity)return;
 const bound=authority.getStore();
 if(!bound||bound.workspaceId!==session.workspaceId||bound.actorId!==session.userId||bound.identityId!==session.serviceIdentity.identityId||bound.scope.projectId!==scope.projectId||
  !(bound.scope.companyId===scope.companyId&&bound.scope.locationId===scope.locationId)&&!bound.resources?.some(r=>r.companyId===scope.companyId&&r.locationId===scope.locationId))
  throw new CrmCommandError("SALES_RESOURCE_DENIED","A current exact resource grant is required",403);
}

/** The one allowed compound sub-operation: ingesting a canonical reply terminates its old workflow sequence. */
export function withWebsiteSalesLifecycleStop<T>(session: AppSession, run: () => Promise<T>) {
  if (!session.serviceIdentity) return run();
  const current = authority.getStore();
  if (!current || current.target !== "lifecycle" || current.operation !== "ingest_reply" || current.mode !== "execute") {
    throw new CrmCommandError("SALES_MACHINE_AUTHORITY_REQUIRED", "A verified reply-ingestion context is required", 403);
  }
  websiteSalesActorAuthority(session, current.scope, "ingest_reply", "lifecycle");
  return authority.run(Object.freeze({ ...current, target: "workflow", operation: "stop" }), run);
}

/** Canonical topic ingestion may only stop the old sequence; it never grants drafting or delivery rights. */
export function withWebsiteSalesConversationStop<T>(session:AppSession,run:()=>Promise<T>){
 if(!session.serviceIdentity)return run();
 const current=authority.getStore();
 if(!current||current.target!=="autonomy"||current.mode!=="execute"||!["advance_conversation","record_topic","stop_conversation"].includes(current.operation))
  throw new CrmCommandError("SALES_MACHINE_AUTHORITY_REQUIRED","A verified conversation-ingestion context is required",403);
 websiteSalesActorAuthority(session,current.scope,current.operation,"autonomy");
 return authority.run(Object.freeze({...current,target:"workflow",operation:"stop"}),run);
}
