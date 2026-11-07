import 'server-only';
import type {AppSession} from './auth/session';
import {getRolePermissions,isAppRole} from './auth/permissions';
import {getProductRoleCapabilities,isProductRole} from './product-model';
import {assertCrmUuid,assertProjectGrant,CrmCommandError,withCrmRead,type TenantTransaction,type TenantTransactionOptions} from './crm-command';
import {withTenantTransaction} from './db/tenant-client';
import {runWithTenantTransaction} from './db/transaction-context';
import {areQueueWorkersPaused,createCronRun,isCronAuthorized} from './cron/runtime';
import {prepareLeadProofRetention,processLeadProofRetention} from './lead-proof-retention-repository';
type Scope={workspaceId:string;actorId:string;policyId:string};
function configuredScopes(env:NodeJS.ProcessEnv):Scope[]{
 const value:unknown=JSON.parse(env.NOVALURE_PROOF_RETENTION_SCOPES?.trim()||'[]');if(!Array.isArray(value)||value.length>20)throw new Error('Invalid retention scope');const seen=new Set<string>();
 return value.map(item=>{if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join()!=='actorId,policyId,workspaceId')throw new Error('Invalid retention scope');const row=item as Record<string,unknown>,scope={workspaceId:assertCrmUuid(row.workspaceId),actorId:assertCrmUuid(row.actorId),policyId:assertCrmUuid(row.policyId)};if(seen.has(scope.policyId))throw new Error('Duplicate retention scope');seen.add(scope.policyId);return scope;});
}
export function proofRetentionSchedulerReadiness(scope:Scope,granted:boolean,env:NodeJS.ProcessEnv=process.env){
 if(areQueueWorkersPaused(env))return{ready:false,reason:'paused'};if(!granted)return{ready:false,reason:'mfa_delegation_required'};if(!env.CRON_SECRET?.trim())return{ready:false,reason:'cron_auth_unavailable'};
 try{const ready=configuredScopes(env).some(s=>s.workspaceId===scope.workspaceId&&s.actorId===scope.actorId&&s.policyId===scope.policyId);return{ready,reason:ready?'ready':'not_configured'};}catch{return{ready:false,reason:'invalid_configuration'};}
}
/** Private to this purpose worker. A host cannot supply arbitrary actors/projects in a request. */
async function delegated<T>(scope:Scope,callback:(tx:TenantTransaction,session:AppSession,projectId:string)=>Promise<T>,options:TenantTransactionOptions){
 return withTenantTransaction({workspaceId:scope.workspaceId,actorId:scope.actorId},tx=>runWithTenantTransaction({workspaceId:scope.workspaceId,actorId:scope.actorId},tx,async()=>{
  const member=await tx.queryOne<{role:string;productRole:string;identityId:string|null}>(`select role,product_role as "productRole",auth_identity_id as "identityId" from crm_lock_active_member($1::uuid,$2::uuid)`,[scope.workspaceId,scope.actorId]);
  if(!member?.identityId||!isAppRole(member.role)||!isProductRole(member.productRole)||!['owner','admin'].includes(member.role))throw new CrmCommandError('RETENTION_ACTOR_REVOKED','Verwaltungsberechtigung wurde entzogen.',403);
  if(!(await tx.queryOne<{active:boolean}>(`select credential_state='active' and disabled_at is null and mfa_enabled_at is not null as active from auth_identities where id=$1::uuid for share`,[member.identityId]))?.active)throw new CrmCommandError('RETENTION_IDENTITY_REVOKED','Persönliche Delegation ist nicht mehr aktiv.',403);
  const p=await tx.queryOne<{projectId:string;enabled:boolean;granted:boolean}>(`select project_id as "projectId",enabled,(schedule_actor_id=$3::uuid and schedule_identity_id=$4::uuid and schedule_version=version) as granted from lead_proof_retention_policies where workspace_id=$1::uuid and id=$2::uuid for share`,[scope.workspaceId,scope.policyId,scope.actorId,member.identityId]);
  if(p&&!p.enabled)throw new CrmCommandError('RETENTION_POLICY_PAUSED','Diese Aufbewahrungsrichtlinie ist pausiert.',409);
  if(!p||!p.granted)throw new CrmCommandError('RETENTION_DELEGATION_REQUIRED','Diese Aufbewahrungsrichtlinie ist nicht aktiv delegiert.',403);
  const session:AppSession={authenticated:true,source:'database',workspaceId:scope.workspaceId,userId:scope.actorId,workspaceName:'',name:'Delegierte Nachweisaufbewahrung',email:'',role:member.role,productRole:member.productRole,permissions:getRolePermissions(member.role),productPermissions:getProductRoleCapabilities(member.productRole)};
  return withCrmRead(session,async()=>{await assertProjectGrant(tx,session,p.projectId,true);return callback(tx,session,p.projectId);});
 }),options);
}
export async function handleProofRetentionCron(request:Request,env:NodeJS.ProcessEnv=process.env,options:TenantTransactionOptions={}){
 if(request.method!=='GET'||new URL(request.url).search||!env.CRON_SECRET?.trim()||!isCronAuthorized(request,env))return Response.json({error:'Unauthorized'},{status:401});if(areQueueWorkersPaused(env))return Response.json({ok:true,paused:true});
 let scopes:Scope[];try{scopes=configuredScopes(env);}catch{return Response.json({ok:false,code:'RETENTION_SCOPE_INVALID'},{status:503});}
 const host=createCronRun({route:'lead-proof-retention'}),results:{policyId:string;status:string;deleted?:number;code?:string}[]=[];
 for(const scope of scopes){if(!host.shouldContinue()||areQueueWorkersPaused(env))break;try{
  const jobs=await delegated(scope,async(tx,session,projectId)=>{
   const due=await tx.query<{leadId:string;proofId:string}>(`select p.lead_id as "leadId",p.id as "proofId" from lead_qualification_proofs p join lead_proof_retention_policies r on r.workspace_id=p.workspace_id and r.project_id=p.project_id left join lead_proof_retention_jobs j on j.workspace_id=p.workspace_id and j.proof_id=p.id where p.workspace_id=$1::uuid and p.project_id=$2::uuid and r.id=$3::uuid and p.kind in('financing_confirmation','funds_evidence') and p.usable_until+make_interval(days=>r.grace_days)<=clock_timestamp() and (j.id is null or j.status='queued') and not exists(select 1 from lead_proof_retention_holds h where h.workspace_id=p.workspace_id and h.proof_id=p.id and h.active) order by p.usable_until,p.id limit 2`,[scope.workspaceId,projectId,scope.policyId]);
   const ids:string[]=[];for(const row of due)ids.push((await prepareLeadProofRetention(tx,session,row)).id);return ids;
  },options);
  let deleted=0;for(const job of jobs){if(!host.shouldContinue()||areQueueWorkersPaused(env))break;await delegated(scope,async(tx,session,projectId)=>{const result=await processLeadProofRetention(tx,session,job);await tx.execute(`insert into audit_logs(workspace_id,project_id,actor_user_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3::uuid,'lead_proof.scheduled_retention','lead_proof_retention_job',$4::uuid,jsonb_build_object('actorType','DELEGATED_PROOF_RETENTION_JOB','hostRunId',$5::text,'policyId',$6::text))`,[scope.workspaceId,projectId,scope.actorId,job,host.runId,scope.policyId]);return result;},options);deleted++;}
  results.push({policyId:scope.policyId,status:'completed',deleted});
 }catch(error){results.push({policyId:scope.policyId,status:error instanceof CrmCommandError&&error.code==='RETENTION_POLICY_PAUSED'?'paused':'blocked',code:error instanceof CrmCommandError?error.code:'RETENTION_UNAVAILABLE'});}}
 const ok=results.every(result=>result.status!=='blocked');return Response.json({ok,configured:scopes.length,attempted:results.length,runId:host.runId,results},{status:ok?200:503});
}
