import "server-only";
import type { AppSession } from "./auth/session";
import { getRolePermissions, isAppRole } from "./auth/permissions";
import { getProductRoleCapabilities, isProductRole } from "./product-model";
import { assertCrmUuid, CrmCommandError, type TenantTransactionOptions } from "./crm-command";
import { withTenantTransaction } from "./db/tenant-client";
import { runWithTenantTransaction } from "./db/transaction-context";
import { runPersonalMailboxSync } from "./db/crm-mailbox-sync-repository";
import { mailboxAutomaticScopeKey, type MailboxSyncScope } from "./crm-mailbox-sync";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "./cron/runtime";
import type { MailboxTransport } from "./integrations/mailbox-provider";
export function configuredMailboxSyncScopes(env:NodeJS.ProcessEnv=process.env):MailboxSyncScope[]{
 let parsed:unknown;try{parsed=JSON.parse(env.NOVALURE_MAILBOX_SYNC_SCOPES?.trim()||'[]');}catch{throw new CrmCommandError('MAIL_SYNC_SCOPE_INVALID','Postfach-Zeitplankonfiguration ungültig',503);}
 if(!Array.isArray(parsed)||parsed.length>50)throw new CrmCommandError('MAIL_SYNC_SCOPE_INVALID','Höchstens 50 ausdrücklich eingerichtete Postfachverbindungen zulässig',503);
 const seen=new Set<string>();return parsed.map(value=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!=='actorId,connectionId,workspaceId')throw new CrmCommandError('MAIL_SYNC_SCOPE_INVALID','Postfachumfang benötigt Workspace, Nutzer und Verbindung',503);const row=value as Record<string,unknown>,scope={workspaceId:assertCrmUuid(row.workspaceId),actorId:assertCrmUuid(row.actorId),connectionId:assertCrmUuid(row.connectionId)},key=mailboxAutomaticScopeKey(scope);if(seen.has(key))throw new CrmCommandError('MAIL_SYNC_SCOPE_INVALID','Postfachumfang doppelt',503);seen.add(key);return scope;});
}
type Options=TenantTransactionOptions&{transport?:MailboxTransport;env?:NodeJS.ProcessEnv};
/** The host supplies a closed allowlist, and the owner must separately opt in. No public actor parameter. */
export async function processConfiguredMailboxSync(scope:MailboxSyncScope,options:Options={}){
 const env=options.env??process.env;if(areQueueWorkersPaused(env))return {status:'paused'};
 if(!configuredMailboxSyncScopes(env).some(row=>mailboxAutomaticScopeKey(row)===mailboxAutomaticScopeKey(scope)))throw new CrmCommandError('MAIL_SYNC_SCOPE_INVALID','Verbindung ist nicht für diesen Hostlauf eingerichtet',403);
 const session=await withTenantTransaction({workspaceId:scope.workspaceId,actorId:scope.actorId},tx=>runWithTenantTransaction({workspaceId:scope.workspaceId,actorId:scope.actorId},tx,async()=>{
  const member=await tx.queryOne<{role:string;productRole:string;identityId:string|null}>(`select role,product_role as "productRole",auth_identity_id as "identityId" from crm_lock_active_member($1::uuid,$2::uuid)`,[scope.workspaceId,scope.actorId]);
  if(!member?.identityId||!isAppRole(member.role)||!isProductRole(member.productRole)||member.productRole==='external_partner'||!getRolePermissions(member.role).includes('crm:read'))throw new CrmCommandError('MAIL_SYNC_ACTOR_REVOKED','Persönliche Postfachmitgliedschaft ist nicht mehr aktiv',403);
  const identity=await tx.queryOne<{identity:unknown}>(`select crm_mailbox_delegated_identity($1::uuid,$2::uuid) as identity`,[scope.workspaceId,scope.actorId]);if(!identity?.identity)throw new CrmCommandError('MAIL_SYNC_IDENTITY_REVOKED','Persönliche Identität ist nicht mehr aktiv',403);
  return {authenticated:true,source:'database',workspaceId:scope.workspaceId,userId:scope.actorId,workspaceName:'',name:'Delegierter persönlicher Postfachabgleich',email:'',role:member.role,productRole:member.productRole,authIdentityId:member.identityId,permissions:getRolePermissions(member.role),productPermissions:getProductRoleCapabilities(member.productRole)} satisfies AppSession;
 }),options);
 return runPersonalMailboxSync(session,scope.connectionId,{...options,budgetMs:10000});
}
export async function handleMailboxSyncCron(request:Request,env:NodeJS.ProcessEnv=process.env,options:Options={}){
 if(request.method!=='GET'||new URL(request.url).search||!env.CRON_SECRET?.trim()||!isCronAuthorized(request,env))return Response.json({error:'Unauthorized'},{status:401});
 if(areQueueWorkersPaused(env))return Response.json({ok:true,paused:true});
 let scopes:MailboxSyncScope[];try{scopes=configuredMailboxSyncScopes(env);}catch{return Response.json({ok:false,code:'MAIL_SYNC_SCOPE_INVALID'},{status:503});}
 const host=createCronRun({route:'mailbox-sync',softDeadlineMs:45000}),results:{status:string;code?:string}[]=[];
 // A long backlog at the beginning must not starve later personal connections.
 // Rotate the starting point each two-minute schedule window; every connection
 // still keeps its own durable due time, lease and checkpoint.
 const start=scopes.length?Math.floor(Date.now()/120000)%scopes.length:0,ordered=[...scopes.slice(start),...scopes.slice(0,start)];
 for(const scope of ordered){if(!host.shouldContinue()||areQueueWorkersPaused(env))break;try{const result=await processConfiguredMailboxSync(scope,{...options,env});results.push({status:result.status});}catch(error){results.push({status:'blocked',code:error instanceof CrmCommandError?error.code:'MAIL_SYNC_UNAVAILABLE'});}}
 const ok=results.every(row=>row.status!=='blocked');return Response.json({ok,runId:host.runId,configured:scopes.length,attempted:results.length,results,durationMs:host.durationMs()},{status:ok?200:503,headers:{'Cache-Control':'no-store'}});
}
