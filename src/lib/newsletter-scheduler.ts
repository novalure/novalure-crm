import 'server-only';
import {randomUUID} from 'node:crypto';
import type {AppSession} from '@/lib/auth/session';
import {getRolePermissions,isAppRole} from '@/lib/auth/permissions';
import {getProductRoleCapabilities,isProductRole} from '@/lib/product-model';
import {CrmCommandError} from '@/lib/crm-command';
import {withTenantTransaction} from '@/lib/db/tenant-client';
import {runWithTenantTransaction} from '@/lib/db/transaction-context';
import {areQueueWorkersPaused,createCronRun,isCronAuthorized} from '@/lib/cron/runtime';
import {newsletterScheduledScopes,type NewsletterScheduledScope} from '@/lib/newsletter-schedule';
import {assertNewsletterScheduleDispatch,claimDueNewsletter,settleNewsletterSchedule} from '@/lib/db/newsletter-schedule-repository';
import {sendNewsletterBatch,type NewsletterWorkspaceOptions} from '@/lib/db/newsletter-workspace-repository';
async function delegatedSession(scope:NewsletterScheduledScope,options:NewsletterWorkspaceOptions):Promise<AppSession>{return withTenantTransaction({workspaceId:scope.workspaceId,actorId:scope.actorId},tx=>runWithTenantTransaction({workspaceId:scope.workspaceId,actorId:scope.actorId},tx,async()=>{const member=await tx.queryOne<{role:string;productRole:string;identityId:string|null}>('select role,product_role as "productRole",auth_identity_id as "identityId" from crm_lock_active_member($1::uuid,$2::uuid)',[scope.workspaceId,scope.actorId]);if(!member?.identityId||!isAppRole(member.role)||!isProductRole(member.productRole))throw new CrmCommandError('NEWSLETTER_ACTOR_REVOKED','Die delegierte Mitgliedschaft ist nicht aktiv.',403);return {authenticated:true,source:'database',workspaceId:scope.workspaceId,userId:scope.actorId,authIdentityId:member.identityId,workspaceName:'',name:'Delegierter Mailingversand',email:'',role:member.role,productRole:member.productRole,permissions:getRolePermissions(member.role),productPermissions:getProductRoleCapabilities(member.productRole)};}),options);}
/** Host secret + exact scope config + stored MFA delegation are all required; no request-provided impersonation. */
export async function handleNewsletterCron(request:Request,env:NodeJS.ProcessEnv=process.env,options:NewsletterWorkspaceOptions={}){
 if(request.method!=='GET'||new URL(request.url).search||!env.CRON_SECRET?.trim()||!isCronAuthorized(request,env))return Response.json({error:'Unauthorized'},{status:401});if(areQueueWorkersPaused(env))return Response.json({ok:true,paused:true});
 let scopes:NewsletterScheduledScope[];try{scopes=newsletterScheduledScopes(env);}catch{return Response.json({ok:false,code:'NEWSLETTER_SCOPE_INVALID'},{status:503});}const host=createCronRun({route:'newsletter',softDeadlineMs:45000}),results:Array<{projectId:string;status:string;code?:string|null}>=[];
 for(const scope of scopes){if(!host.shouldContinue()||areQueueWorkersPaused(env))break;try{
  const session=await delegatedSession(scope,options),claim=await claimDueNewsletter(session,scope.projectId,options);if(!claim){results.push({projectId:scope.projectId,status:'idle'});continue;}if('blocked'in claim){results.push({projectId:scope.projectId,status:'blocked',code:claim.code});continue;}
  let errorCode:string|null=null,nextAllowedAt:string|null=null;try{const batch=await sendNewsletterBatch(session,{campaignId:claim.campaignId,expectedRevision:claim.revision},{idempotencyKey:randomUUID(),correlationId:claim.leaseToken},{...options,dispatchGuard:(tx,fresh)=>assertNewsletterScheduleDispatch(tx,fresh,claim)});nextAllowedAt=batch.nextAllowedAt;if(batch.policyReviewRequired)errorCode='contact_policy_review';}catch(error){errorCode=error instanceof CrmCommandError?error.code:'NEWSLETTER_DISPATCH_UNKNOWN';}
  const outcome=await settleNewsletterSchedule(session,claim,errorCode,{...options,nextAllowedAt});results.push({projectId:scope.projectId,...outcome});
 }catch(error){results.push({projectId:scope.projectId,status:'blocked',code:error instanceof CrmCommandError?error.code:'NEWSLETTER_UNAVAILABLE'});}}
 const ok=results.every(row=>row.status!=='blocked');return Response.json({ok,configured:scopes.length,attempted:results.length,runId:host.runId,results},{status:ok?200:503});
}
