import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { approvalBinding, validateApprovalTrust, verifyApprovalEvidence, type ApprovalEvidence, type ApprovalScope, type ApprovalTrust } from "@/lib/approval-reference";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, crmPayloadDigest, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
type Metadata = { idempotencyKey: string; correlationId: string };
type ApprovalRow = { id:string; scope:ApprovalScope; scope_digest:string; action_digest:string; trust_digest:string; state:string; challenge_id:string; actor_id:string; required_steps:number; version:number; created_at:Date };
function fail(code:string):never { throw new CrmCommandError(code,code,409); }
/** No HTTP route imports this harness. Keys are public trust roots supplied by local test code only. */
export function createSyntheticApprovalHarness(trust:readonly ApprovalTrust[],options:TenantTransactionOptions,limits:{maxValidityMs:number;maxAuthenticationAgeMs:number;maxStepGapMs:number}) {
  const gate=()=>{if(process.env.NODE_ENV!=="test"||process.env.CRM_SYNTHETIC_APPROVAL_TESTS!=="1"||process.env.VERCEL!==undefined||process.env.VERCEL_ENV!==undefined||process.env.VERCEL_URL!==undefined||!options.pool)fail("SYNTHETIC_APPROVAL_HARNESS_DISABLED")};
  gate();validateApprovalTrust(trust);
  const keys=Object.freeze(trust.map(key=>Object.freeze({...key})));
  const config=Object.freeze({...limits});
  if(Object.values(config).some(value=>!Number.isSafeInteger(value)||value<=0))fail("APPROVAL_TIMING_CONFIGURATION_REQUIRED");
  const trustDigest=crmPayloadDigest(keys.map(key=>({channel:key.channel,keyId:key.keyId,actorId:key.actorId,publicKey:key.publicKey.export({type:"spki",format:"pem"})})));
  const guard=async(tx:TenantTransaction,session:AppSession)=>{
    gate();const row=await tx.queryOne<{local:boolean;approverId:string|null}>(`select inet_server_addr() in ('127.0.0.1'::inet,'::1'::inet) as local,crm_offer_configured_approver($1::uuid) as "approverId"`,[session.workspaceId]);
    if(!row?.local)fail("LOCAL_SYNTHETIC_DATABASE_REQUIRED");if(row.approverId!==keys[0].actorId||session.userId!==keys[0].actorId)fail("CONFIGURED_APPROVER_REQUIRED");
  };
  const current=async(tx:TenantTransaction,scope:ApprovalScope)=>{
    const row=await tx.queryOne<{revision:number;contentDigest:string;total:string;recipient:string;status:string}>(`select o.revision,r.content_digest as "contentDigest",r.total_net_cents as total,r.content->>'recipientEmail' as recipient,o.status from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision where o.workspace_id=$1::uuid and o.project_id=$2::uuid and o.id=$3::uuid for share of o`,[scope.workspaceId,scope.projectId,scope.resourceId]);
    if(!row||Number(row.revision)!==scope.resourceVersion||row.contentDigest!==scope.contentDigest||Number(row.total)!==scope.totalNetCents||row.recipient!==scope.recipient)fail("APPROVAL_RESOURCE_CHANGED");
    if(scope.action==="contract.send"&&row.status!=="ACCEPTED")fail("ACCEPTED_OFFER_REQUIRED");
  };
  const read=async(tx:TenantTransaction,session:AppSession,id:string)=>{
    const row=await tx.queryOne<ApprovalRow>(`select * from crm_synthetic_approval_requests where workspace_id=$1::uuid and id=$2::uuid for update`,[session.workspaceId,assertCrmUuid(id)]);
    if(!row)fail("APPROVAL_NOT_ACCESSIBLE");if(row.trust_digest!==trustDigest)fail("APPROVAL_TRUST_CHANGED");
    if(row.actor_id!==session.userId)fail("CONFIGURED_APPROVER_REQUIRED");return row;
  };
  return Object.freeze({
    async request(session:AppSession,scope:ApprovalScope,metadata:Metadata){
      gate();const binding=approvalBinding(scope);if(scope.workspaceId!==session.workspaceId)fail("APPROVAL_SCOPE_MISMATCH");
      return executeCrmCommand(session,{operation:"synthetic_approval.request",resourceId:scope.resourceId,projectId:scope.projectId,payload:{scope,trustDigest,limits:config},...metadata,capability:"pipeline:write"},async(tx,ctx)=>{
        await guard(tx,ctx.session);await current(tx,scope);const now=Date.now();if(Date.parse(scope.expiresAt)<=now||Date.parse(scope.expiresAt)-now>config.maxValidityMs)fail("APPROVAL_VALIDITY_INVALID");
        const row=await tx.queryOne<{id:string;challengeId:string}>(`insert into crm_synthetic_approval_requests(workspace_id,project_id,offer_id,actor_id,created_by,scope,scope_digest,action_digest,trust_digest,required_steps,expires_at) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$4::uuid,$5::jsonb,$6,$7,$8,$9,$10::timestamptz) returning id,challenge_id as "challengeId"`,[scope.workspaceId,scope.projectId,scope.resourceId,session.userId,JSON.stringify(scope),binding.scopeDigest,binding.actionDigest,trustDigest,binding.requiredSteps,scope.expiresAt]);
        return {...row!,state:"WAITING_FIRST",...binding,environment:"simulation",synthetic:true};
      },options);
    },
    async decide(session:AppSession,id:string,evidence:ApprovalEvidence,metadata:Metadata){
      gate();const selected=await withCrmRead(session,async(tx,fresh)=>{await guard(tx,fresh);return read(tx,fresh,id)},options);return executeCrmCommand(session,{operation:"synthetic_approval.decide",resourceId:id,projectId:selected.scope.projectId,payload:{evidence},...metadata,capability:"pipeline:write"},async(tx,ctx)=>{
        await guard(tx,ctx.session);const row=await read(tx,session,id);await assertProjectGrant(tx,ctx.session,row.scope.projectId,true);await current(tx,row.scope);
        if(!["WAITING_FIRST","WAITING_WEB"].includes(row.state))fail("APPROVAL_ALREADY_DECIDED");
        const previous=await tx.queryOne<{evidence:ApprovalEvidence}>(`select evidence from crm_synthetic_approval_evidence where workspace_id=$1::uuid and approval_id=$2::uuid and channel='evelyn_whatsapp'`,[session.workspaceId,id]);
        if(Date.parse(evidence.issuedAt)<new Date(row.created_at).getTime())fail("APPROVAL_EVIDENCE_PREDATES_REQUEST");
        const proof=verifyApprovalEvidence({scope:row.scope,approvalId:id,challengeId:row.challenge_id,evidence,previous:previous?.evidence??null,trust:keys,now:Date.now(),maxAuthenticationAgeMs:config.maxAuthenticationAgeMs,maxStepGapMs:config.maxStepGapMs});
        await tx.execute(`insert into crm_synthetic_approval_evidence(workspace_id,project_id,approval_id,recorded_by,channel,nonce,evidence,evidence_digest) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::jsonb,$8)`,[session.workspaceId,row.scope.projectId,id,session.userId,evidence.channel,evidence.nonce,JSON.stringify(evidence),proof.evidenceDigest]);
        const state=evidence.decision==="REJECT"?"REJECTED":evidence.decision==="CHANGE"?"CHANGE_REQUIRED":row.required_steps===2&&!previous?"WAITING_WEB":"APPROVED",challengeId=randomUUID();
        await tx.execute(`update crm_synthetic_approval_requests set state=$3,challenge_id=$4::uuid,version=version+1 where workspace_id=$1::uuid and id=$2::uuid`,[session.workspaceId,id,state,challengeId]);
        return {id,state,challengeId,environment:"simulation",synthetic:true};
      },options);
    },
    async consume(session:AppSession,id:string,scope:ApprovalScope,metadata:Metadata){
      gate();const binding=approvalBinding(scope);return executeCrmCommand(session,{operation:"synthetic_approval.consume",resourceId:id,projectId:scope.projectId,payload:{scope},...metadata,capability:"pipeline:write"},async(tx,ctx)=>{
        await guard(tx,ctx.session);const row=await read(tx,session,id);if(binding.scopeDigest!==row.scope_digest||binding.actionDigest!==row.action_digest)fail("APPROVAL_SCOPE_MISMATCH");
        if(row.state!=="APPROVED"||Date.parse(row.scope.expiresAt)<=Date.now())fail("VALID_APPROVAL_REQUIRED");await current(tx,row.scope);
        const proofs=await tx.query<{evidence:ApprovalEvidence}>(`select evidence from crm_synthetic_approval_evidence where workspace_id=$1::uuid and approval_id=$2::uuid order by case channel when 'evelyn_whatsapp' then 1 else 2 end`,[session.workspaceId,id]);
        if(proofs.length!==row.required_steps)fail("MISSING_INDEPENDENT_APPROVAL_STEP");let previous:ApprovalEvidence|null=null;
        for(const proof of proofs){verifyApprovalEvidence({scope:row.scope,approvalId:id,challengeId:proof.evidence.challengeId,evidence:proof.evidence,previous,trust:keys,now:Date.now(),maxAuthenticationAgeMs:config.maxAuthenticationAgeMs,maxStepGapMs:config.maxStepGapMs});previous=proof.evidence}
        await tx.execute(`insert into crm_synthetic_approval_effects(workspace_id,project_id,approval_id,actor_id) values($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,[session.workspaceId,row.scope.projectId,id,session.userId]);
        await tx.execute(`update crm_synthetic_approval_requests set state='CONSUMED',version=version+1 where workspace_id=$1::uuid and id=$2::uuid`,[session.workspaceId,id]);
        return {id,state:"CONSUMED",effect:"SYNTHETIC_APPROVAL_PROBE",externalEffect:false,contractSent:false,paymentExecuted:false};
      },options);
    },
    async revoke(session:AppSession,id:string,metadata:Metadata){
      gate();const selected=await withCrmRead(session,async(tx,fresh)=>{await guard(tx,fresh);return read(tx,fresh,id)},options);return executeCrmCommand(session,{operation:"synthetic_approval.revoke",resourceId:id,projectId:selected.scope.projectId,payload:{id},...metadata,capability:"pipeline:write"},async(tx,ctx)=>{
        await guard(tx,ctx.session);const row=await read(tx,session,id);await assertProjectGrant(tx,ctx.session,row.scope.projectId,true);if(row.state==="CONSUMED")fail("APPROVAL_ALREADY_CONSUMED");
        await tx.execute(`update crm_synthetic_approval_requests set state='REVOKED',version=version+1 where workspace_id=$1::uuid and id=$2::uuid`,[session.workspaceId,id]);return {id,state:"REVOKED"};
      },options);
    },
  });
}
/** The business offer approval is separately projected; synthetic evidence never authorizes real sends. */
export async function getOfferApprovalReference(session:AppSession,id:string,options:TenantTransactionOptions={}){
 return withCrmRead(session,async(tx,fresh)=>{
  const row=await tx.queryOne<{id:string;projectId:string;resourceId:string;actionVersion:number;contentDigest:string;actorId:string;sessionReference:string;expiresAt:Date;decision:string;currentId:string|null;currentRevision:number;recipient:string;total:string}>(`select a.id,a.project_id as "projectId",a.offer_id as "resourceId",a.revision as "actionVersion",a.content_digest as "contentDigest",a.actor_id as "actorId",a.auth_session_reference as "sessionReference",a.expires_at as "expiresAt",a.decision,o.approval_id as "currentId",o.revision as "currentRevision",r.content->>'recipientEmail' as recipient,r.total_net_cents as total from crm_offer_approvals a join crm_offers o on o.workspace_id=a.workspace_id and o.id=a.offer_id join crm_offer_revisions r on r.workspace_id=a.workspace_id and r.offer_id=a.offer_id and r.revision=a.revision where a.workspace_id=$1::uuid and a.id=$2::uuid`,[fresh.workspaceId,assertCrmUuid(id)]);
  if(!row)fail("APPROVAL_NOT_ACCESSIBLE");await assertProjectGrant(tx,fresh,row.projectId);
  const binding=approvalBinding({workspaceId:fresh.workspaceId,projectId:row.projectId,resourceId:row.resourceId,resourceVersion:row.actionVersion,actionVersion:row.actionVersion,action:"offer.send",contentDigest:row.contentDigest,recipient:row.recipient,totalNetCents:Number(row.total),currency:"EUR",taxBasis:"NET",expiresAt:new Date(row.expiresAt).toISOString()});
  const authority=await tx.queryOne<{id:string|null}>(`select crm_offer_configured_approver($1::uuid) as id`,[fresh.workspaceId]);
  return {id:row.id,contractVersion:"crm-integration-v1",authority:"CRM_MANUAL_OFFER_APPROVAL",...binding,actorId:row.actorId,sessionReference:row.sessionReference,status:row.currentId===row.id&&row.currentRevision===row.actionVersion&&row.decision==="APPROVED"&&Date.parse(binding.scope.expiresAt)>Date.now()&&authority?.id===row.actorId?"APPROVED":"INVALID",independentSteps:1,contractOrPaymentAuthorized:false};
 },options);
}
