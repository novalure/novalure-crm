import { createHash,randomBytes,randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { decryptAuthValue,encryptAuthValue } from "@/lib/auth/auth-security";
import { assertCrmUuid,CrmCommandError,crmPayloadDigest,executeCrmCommand,withCrmRead,type TenantTransaction,type TenantTransactionOptions } from "@/lib/crm-command";
import { queryOne } from "@/lib/db/client";
import { upsertContactRecord } from "@/lib/db/crm-write-repositories";
import { recordBuyerProfileCompletion } from "@/lib/automation/source-events";
import { recordAutomationEvent } from "@/lib/automation/repository";
import { qualificationLead,saveLeadMatchingProfile } from "@/lib/lead-qualification-repository";
import { normalizeCustomerRequestPayload,customerRequestPurposes,type CustomerRequestLanguage,type CustomerRequestPurpose,type CustomerRequestState,type CustomerRequestUpload,type CustomerRequestSubmission } from "./lead-customer-request";
import { deleteCustomerRequestUpload,readCustomerRequestUpload,storeCustomerRequestUpload,validateCustomerRequestUpload } from "./lead-customer-request-storage";
type Row=Record<string,unknown>;
type PublicInfo={id:string;workspaceId:string;leadId:string;purpose:CustomerRequestPurpose;language:CustomerRequestLanguage;controller:string;privacyUrl:string;submitted:boolean};
export type CustomerRequestPublicQuery=(sql:string,params:unknown[])=>Promise<{result:unknown}|null>;
const defaultQuery:CustomerRequestPublicQuery=(sql,params)=>queryOne<{result:unknown}>(sql,params);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function tokenHash(token:string){if(!/^[a-zA-Z0-9_-]{43}$/.test(token))throw new CrmCommandError('REQUEST_UNAVAILABLE','Dieser Link ist nicht verfügbar.',404);return hash(token);}
function requestPath(row:{id:string;workspaceId:string;leadId:string;purpose:string;tokenHash:string;ciphertext:string}){
 const value=decryptAuthValue<{purpose:string;requestId:string;workspaceId:string;leadId:string;requestPurpose:string;token:string}>(row.ciphertext);
 if(!value||value.purpose!=='lead-customer-request'||value.requestId!==row.id||value.workspaceId!==row.workspaceId||value.leadId!==row.leadId||value.requestPurpose!==row.purpose||hash(value.token)!==row.tokenHash)throw new CrmCommandError('REQUEST_KEY_UNAVAILABLE','Der Kundenlink kann derzeit nicht wiederhergestellt werden.',503);
 return `/request/${value.token}`;
}
export async function saveCustomerRequestSettings(tx:TenantTransaction,session:AppSession,input:{controller:string;privacyUrl:string}){
 if(!(await tx.queryOne<{allowed:boolean}>('select crm_workspace_manager($1::uuid) as allowed',[session.workspaceId]))?.allowed)throw new CrmCommandError('FORBIDDEN','Nur die Workspace-Verwaltung kann diese Angaben ändern.',403);
 const controller=typeof input.controller==='string'?input.controller.trim():'';let privacy:URL;try{privacy=new URL(input.privacyUrl);}catch{throw new CrmCommandError('INVALID_PRIVACY_URL','Eine vollständige HTTPS-Datenschutzadresse ist erforderlich.');}
 if(controller.length<2||controller.length>300||privacy.protocol!=='https:'||privacy.username||privacy.password||privacy.href.length>2000)throw new CrmCommandError('INVALID_REQUEST_SETTINGS','Firmenangabe oder Datenschutzadresse ist ungültig.');
 await tx.execute(`insert into lead_customer_request_settings(workspace_id,controller,privacy_url,updated_by) values($1::uuid,$2,$3,$4::uuid) on conflict(workspace_id) do update set controller=excluded.controller,privacy_url=excluded.privacy_url,updated_by=excluded.updated_by,updated_at=clock_timestamp()`,[session.workspaceId,controller,privacy.href,session.userId]);return{controller,privacyUrl:privacy.href};
}
export async function createCustomerRequest(tx:TenantTransaction,session:AppSession,input:{leadId:string;purpose:CustomerRequestPurpose;language:CustomerRequestLanguage;days?:number;draftId?:string}){
 const lead=await qualificationLead(tx,session,input.leadId,true),example=record(record(lead.metadata).onboardingExample);
 if(example.synthetic===true)throw new CrmCommandError('SYNTHETIC_EXAMPLE_ISOLATED','Beispieldaten erhalten keine öffentlichen Kundenlinks.',409);
 if(!(customerRequestPurposes as readonly string[]).includes(input.purpose)||!['de','en','es'].includes(input.language))throw new CrmCommandError('INVALID_REQUEST_PURPOSE','Zweck oder Sprache ist ungültig.');
 if(input.draftId){const existing=await tx.queryOne<Row>(`select id,lead_id,purpose from lead_customer_requests where workspace_id=$1::uuid and draft_id=$2::uuid`,[session.workspaceId,assertCrmUuid(input.draftId)]);if(existing){if(existing.lead_id!==input.leadId||existing.purpose!==input.purpose)throw new CrmCommandError('REQUEST_SCOPE_MISMATCH','Kundenlink und Anforderung passen nicht zusammen.',409);return{id:String(existing.id)};}}
 const settings=await tx.queryOne<{controller:string;privacyUrl:string}>(`select controller,privacy_url as "privacyUrl" from lead_customer_request_settings where workspace_id=$1::uuid`,[session.workspaceId]);
 if(!settings)throw new CrmCommandError('REQUEST_SETTINGS_REQUIRED','Zuerst Firmenangabe und Datenschutzlink für Kundenformulare hinterlegen.',409);
 const days=input.days??7;if(!Number.isInteger(days)||days<1||days>30)throw new CrmCommandError('INVALID_REQUEST_EXPIRY','Gültigkeit muss 1 bis 30 Tage betragen.');
 const id=randomUUID(),token=randomBytes(32).toString('base64url'),digest=hash(token);let encrypted:string;
 try{encrypted=encryptAuthValue({purpose:'lead-customer-request',requestId:id,workspaceId:session.workspaceId,leadId:input.leadId,requestPurpose:input.purpose,token});}catch{throw new CrmCommandError('REQUEST_KEY_UNAVAILABLE','Der geschützte Schlüsselspeicher ist nicht eingerichtet.',503);}
 await tx.execute(`insert into lead_customer_requests(id,workspace_id,project_id,lead_id,created_by,draft_id,purpose,language,token_hash,token_ciphertext,controller,privacy_url,expires_at) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12,clock_timestamp()+($13::int*interval '1 day'))`,[id,session.workspaceId,lead.project_id,input.leadId,session.userId,input.draftId??null,input.purpose,input.language,digest,encrypted,settings.controller,settings.privacyUrl,days]);return{id};
}
export async function prepareAutomationCustomerRequest(tx:TenantTransaction,session:AppSession,input:{draftId:string;leadId:string;purpose:CustomerRequestPurpose;language?:CustomerRequestLanguage}){
 return createCustomerRequest(tx,session,{...input,language:input.language??'de',days:7});
}
export async function getAutomationCustomerRequestLink(tx:TenantTransaction,session:AppSession,draftId:string,origin:string){
 const row=await tx.queryOne<Row>(`select r.id,r.workspace_id as "workspaceId",r.lead_id as "leadId",r.purpose,r.token_hash as "tokenHash",r.token_ciphertext as ciphertext,r.expires_at>clock_timestamp() and r.revoked_at is null as active,exists(select 1 from lead_customer_request_submissions s where s.request_id=r.id) as submitted from lead_customer_requests r where r.workspace_id=$1::uuid and r.draft_id=$2::uuid for share of r`,[session.workspaceId,assertCrmUuid(draftId)]);
 if(!row||!row.active||row.submitted)return null;await qualificationLead(tx,session,String(row.leadId));
 const path=requestPath(row as Parameters<typeof requestPath>[0]),base=new URL(origin);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new CrmCommandError('INVALID_APP_ORIGIN','Anwendungsadresse ist ungültig.');return{url:new URL(path,base.origin).href,purpose:String(row.purpose)};
}
export async function getCustomerRequestState(session:AppSession,leadId:string,options:TenantTransactionOptions={}):Promise<CustomerRequestState>{
 return withCrmRead(session,async(tx,fresh)=>{
  await qualificationLead(tx,fresh,leadId);
  const settings=await tx.queryOne<{controller:string;privacyUrl:string}>(`select controller,privacy_url as "privacyUrl" from lead_customer_request_settings where workspace_id=$1::uuid`,[fresh.workspaceId]);
  const canConfigure=(await tx.queryOne<{allowed:boolean}>('select crm_workspace_manager($1::uuid) as allowed',[fresh.workspaceId]))?.allowed===true;
  const raw=await tx.query<Row>(`select r.id,r.workspace_id as "workspaceId",r.lead_id as "leadId",r.purpose,r.language,r.expires_at as "expiresAt",r.expires_at<=clock_timestamp() as expired,r.revoked_at as "revokedAt",r.token_hash as "tokenHash",r.token_ciphertext as ciphertext,exists(select 1 from lead_customer_request_submissions s where s.request_id=r.id) as submitted from lead_customer_requests r where r.workspace_id=$1::uuid and r.lead_id=$2::uuid order by r.created_at desc limit 50`,[fresh.workspaceId,leadId]);
  const requests=raw.map(row=>{let path:string|null=null;try{path=requestPath(row as Parameters<typeof requestPath>[0]);}catch{/* An unavailable key must not expose ciphertext. */}return{id:String(row.id),purpose:row.purpose as CustomerRequestPurpose,language:row.language as CustomerRequestLanguage,expiresAt:String(row.expiresAt),expired:row.expired===true,revokedAt:row.revokedAt?String(row.revokedAt):null,submitted:row.submitted===true,path};});
  const submissions=await tx.query<CustomerRequestSubmission>(`select s.id,s.request_id as "requestId",r.purpose,s.payload,s.file->>'name' as "fileName",s.status,s.review_reason as reason,s.version,s.created_at as "createdAt",s.file_purged_at as "filePurgedAt",s.file_purge_started_at is not null as "filePurgeStarted",(s.file is not null and s.adopted_proof_id is null and s.file_purged_at is null and (s.status='rejected' or (s.status='pending' and s.created_at<clock_timestamp()-interval '30 days'))) as "filePurgeEligible" from lead_customer_request_submissions s join lead_customer_requests r on r.id=s.request_id and r.workspace_id=s.workspace_id where s.workspace_id=$1::uuid and s.lead_id=$2::uuid order by s.created_at desc limit 50`,[fresh.workspaceId,leadId]);
  return{settings,canConfigure,requests,submissions};
 },options);
}
export async function revokeCustomerRequest(tx:TenantTransaction,session:AppSession,leadId:string,requestId:string){await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`web-expose-automation-workspace:${session.workspaceId}`]);await qualificationLead(tx,session,leadId,true);const row=await tx.queryOne(`update lead_customer_requests set revoked_at=coalesce(revoked_at,clock_timestamp()) where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid returning id`,[session.workspaceId,leadId,assertCrmUuid(requestId)]);if(!row)throw new CrmCommandError('NOT_FOUND','Kundenlink ist nicht verfügbar.',404);return{id:requestId,revoked:true};}
export async function lookupPublicCustomerRequest(token:string,query:CustomerRequestPublicQuery=defaultQuery):Promise<PublicInfo|null>{const row=await query('select crm_lead_request_lookup($1) as result',[tokenHash(token)]);return row?.result as PublicInfo|null;}
export async function submitPublicCustomerRequest(token:string,key:string,payload:unknown,file?:File,query:CustomerRequestPublicQuery=defaultQuery){
 const digest=tokenHash(token),info=await lookupPublicCustomerRequest(token,query);if(!info)throw new CrmCommandError('REQUEST_UNAVAILABLE','Dieser Link ist nicht verfügbar.',404);
 const normalized=normalizeCustomerRequestPayload(info.purpose,payload);if(!key||key.length<16||key.length>128)throw new CrmCommandError('INVALID_REQUEST_KEY','Ungültige Anfragekennung.');
 if(info.submitted){
  const validated=file?await validateCustomerRequestUpload(file):null;
  const result=await query('select crm_lead_request_submit($1,$2,$3,$4::jsonb,null) as result',[digest,key,crmPayloadDigest({payload:normalized,file:validated?{hash:validated.hash,name:validated.name,mime:validated.mime,size:validated.size}:null}),JSON.stringify(normalized)]);
  const output=result?.result as {accepted?:boolean;reference?:string;error?:string}|null;
  if(!output?.accepted)throw new CrmCommandError('ALREADY_SUBMITTED','Ihre Einreichung ist bereits eingegangen.',409);return output;
 }
 let upload:CustomerRequestUpload|undefined;
 try{
  if(info.purpose==='purchasing_power'){if(!file)throw new CrmCommandError('FILE_REQUIRED','Bitte einen Nachweis wählen.');upload=await storeCustomerRequestUpload({workspaceId:info.workspaceId,leadId:info.leadId,requestId:info.id},file);}else if(file)throw new CrmCommandError('UNEXPECTED_FILE','Für diese Anfrage ist keine Datei vorgesehen.');
  const result=await query('select crm_lead_request_submit($1,$2,$3,$4::jsonb,$5::jsonb) as result',[digest,key,crmPayloadDigest({payload:normalized,file:upload?{hash:upload.hash,name:upload.name,mime:upload.mime,size:upload.size}:null}),JSON.stringify(normalized),upload?JSON.stringify(upload):null]);
  const output=result?.result as {accepted?:boolean;reference?:string;error?:string}|null;
  if(!output?.accepted)throw new CrmCommandError(output?.error==='already_submitted'?'ALREADY_SUBMITTED':'REQUEST_REJECTED',output?.error==='already_submitted'?'Ihre Einreichung ist bereits eingegangen.':'Die Einreichung konnte nicht übernommen werden.',409);
  // Two identical uploads can race before the unique submission is committed. Only its referenced file remains.
  if(upload){const retained=await query('select crm_lead_request_upload_retained($1,$2::uuid) as result',[digest,upload.id]);if(retained?.result===false)await deleteCustomerRequestUpload(upload);}
  return output;
 }catch(error){if(upload){const retained=await query('select crm_lead_request_upload_retained($1,$2::uuid) as result',[digest,upload.id]).catch(()=>null);if(retained?.result===false)await deleteCustomerRequestUpload(upload).catch(()=>undefined);}throw error;}
}
export async function reviewCustomerRequestSubmission(tx:TenantTransaction,session:AppSession,input:{leadId:string;submissionId:string;expectedVersion:number;accept:boolean;reason:string}){
 const lead=await qualificationLead(tx,session,input.leadId,true),reason=typeof input.reason==='string'?input.reason.trim():'';if(reason.length<10||reason.length>1000)throw new CrmCommandError('REVIEW_REASON_REQUIRED','Die Übernahme oder Ablehnung benötigt eine Begründung.');
 const row=await tx.queryOne<Row>(`select s.*,r.purpose from lead_customer_request_submissions s join lead_customer_requests r on r.id=s.request_id and r.workspace_id=s.workspace_id where s.workspace_id=$1::uuid and s.lead_id=$2::uuid and s.id=$3::uuid for update of s`,[session.workspaceId,input.leadId,assertCrmUuid(input.submissionId)]);
 if(!row||row.status!=='pending'||row.file_purge_started_at||Number(row.version)!==input.expectedVersion)throw new CrmCommandError('SUBMISSION_CHANGED','Die Einreichung wurde bereits bearbeitet oder geändert.',409);
 let proofId:string|null=null;
 if(input.accept){
  const payload=record(normalizeCustomerRequestPayload(row.purpose as CustomerRequestPurpose,row.payload));
  if(row.purpose==='contact_details'){
   const contact=await tx.queryOne<{version:string|number}>(`select version from contacts where workspace_id=$1::uuid and id=$2::uuid for update`,[session.workspaceId,lead.contact_id]);if(!contact)throw new CrmCommandError('CONTACT_UNAVAILABLE','Kontakt ist nicht verfügbar.',404);
   const saved=await upsertContactRecord({session,requireExisting:true,expectedVersion:Number(contact.version),contact:{id:String(lead.contact_id),projectId:String(lead.project_id),name:String(payload.name),email:String(payload.email),phone:String(payload.phone)}});if(!saved.persisted)throw new CrmCommandError('CONTACT_WRITE_REJECTED',saved.reason,409);
  }else if(row.purpose==='search_profile'){
   await saveLeadMatchingProfile(tx,session,input.leadId,payload);const profile=await tx.queryOne<{id:string}>(`select id from buyer_search_profiles where workspace_id=$1::uuid and buyer_lead_id=$2::uuid`,[session.workspaceId,input.leadId]);if(profile)await recordBuyerProfileCompletion(session,profile.id);
  }else{
   const upload=row.file as CustomerRequestUpload;if(!upload||upload.workspaceId!==session.workspaceId||upload.leadId!==input.leadId||upload.requestId!==row.request_id)throw new CrmCommandError('INVALID_PRIVATE_UPLOAD','Privater Dateibezug ist ungültig.',409);
   await readCustomerRequestUpload(upload);const assetId=randomUUID();proofId=randomUUID();
   await tx.execute(`insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public,public_token) values($1::uuid,$2,$3,$3,$4,$5,$6,$7,$8,$9,'private',false,null)`,[assetId,session.workspaceId,upload.name,`lead-proof-private-${input.leadId}`,upload.mime,upload.size,`/api/media/files/${assetId}`,upload.pathname,upload.provider]);
   await tx.execute(`insert into lead_qualification_proofs(id,workspace_id,project_id,lead_id,media_asset_id,kind,purpose,content_hash,uploaded_by,usable_until) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'other','Angeforderten Kundennachweis manuell übernommen',$6,$7::uuid,clock_timestamp()+interval '90 days')`,[proofId,session.workspaceId,lead.project_id,input.leadId,assetId,upload.hash,session.userId]);
   await recordAutomationEvent(tx,{workspaceId:session.workspaceId,projectId:String(lead.project_id),leadId:input.leadId,eventId:`proof-uploaded:${proofId}`,trigger:'proof_uploaded',context:{proofId,proofAccepted:false}},{enroll:false});
  }
 }
 await tx.execute(`update lead_customer_request_submissions set status=$4,review_reason=$5,reviewed_by=$6::uuid,reviewed_at=clock_timestamp(),adopted_proof_id=$7::uuid,version=version+1 where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid`,[session.workspaceId,input.leadId,input.submissionId,input.accept?'accepted':'rejected',reason,session.userId,proofId]);
 return{id:input.submissionId,status:input.accept?'accepted':'rejected',proofId,proofNeedsReview:!!proofId};
}
export async function getCustomerRequestSubmissionUpload(session:AppSession,submissionId:string,options:TenantTransactionOptions={}){
 return withCrmRead(session,async(tx,fresh)=>{const row=await tx.queryOne<Row>(`select lead_id,file from lead_customer_request_submissions where workspace_id=$1::uuid and id=$2::uuid and status='pending' and created_at>clock_timestamp()-interval '30 days' and file is not null and file_purge_started_at is null`,[fresh.workspaceId,assertCrmUuid(submissionId)]);if(!row)throw new CrmCommandError('FILE_UNAVAILABLE','Einreichungsdatei ist nicht verfügbar.',404);await qualificationLead(tx,fresh,String(row.lead_id));return row.file as CustomerRequestUpload;},options);
}

/** Durable intent is committed before storage deletion. A retry continues that same intent; no success is reported before deletion succeeds. */
export async function purgeCustomerRequestSubmissionFile(session:AppSession,input:{leadId:string;submissionId:string;reason:string},metadata:{idempotencyKey:string;correlationId:string},options:TenantTransactionOptions={}){
 const projectId=await withCrmRead(session,async(tx,fresh)=>String((await qualificationLead(tx,fresh,input.leadId)).project_id),options);
 const reason=input.reason?.trim();if(!reason||reason.length<10||reason.length>1000)throw new CrmCommandError('PURGE_REASON_REQUIRED','Die Dateilöschung benötigt eine konkrete Begründung.');
 const prepared=await executeCrmCommand(session,{operation:'lead_request.file_purge.prepare',projectId,resourceId:assertCrmUuid(input.submissionId),capability:'pipeline:write',payload:input,...metadata},async(tx,context)=>{
  await qualificationLead(tx,context.session,input.leadId,true);const row=await tx.queryOne<Row>(`select * from lead_customer_request_submissions where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid for update`,[session.workspaceId,input.leadId,input.submissionId]);
  if(!row)throw new CrmCommandError('NOT_FOUND','Einreichung nicht verfügbar.',404);if(row.file_purged_at)return{id:input.submissionId};
  if(!row.file||row.adopted_proof_id||!(row.status==='rejected'||(row.status==='pending'&&new Date(String(row.created_at)).valueOf()<Date.now()-30*86400000)))throw new CrmCommandError('PURGE_NOT_ALLOWED','Nur abgelehnte oder seit 30 Tagen ungeprüfte, nicht übernommene Dateien können hier gelöscht werden.',409);
  if(!row.file_purge_started_at)await tx.execute(`update lead_customer_request_submissions set file_purge_started_at=clock_timestamp(),file_purge_actor=$4::uuid,file_purge_reason=$5,version=version+1 where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid`,[session.workspaceId,input.leadId,input.submissionId,context.actorId,reason]);
  return{id:input.submissionId};
 },options);
 const upload=await withCrmRead(session,async(tx,fresh)=>{await qualificationLead(tx,fresh,input.leadId);const row=await tx.queryOne<Row>(`select file,file_purged_at,file_purge_started_at,adopted_proof_id from lead_customer_request_submissions where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid`,[session.workspaceId,input.leadId,input.submissionId]);if(row?.file_purged_at)return null;if(!row?.file_purge_started_at||row.adopted_proof_id||!row.file)throw new CrmCommandError('PURGE_CHANGED','Der Dateivorgang hat sich geändert.',409);return row.file as CustomerRequestUpload;},options);
 if(upload){await deleteCustomerRequestUpload(upload);await executeCrmCommand(session,{operation:'lead_request.file_purge.complete',projectId,resourceId:input.submissionId,capability:'pipeline:write',payload:{submissionId:input.submissionId},idempotencyKey:randomUUID(),correlationId:metadata.correlationId},async(tx,context)=>{await qualificationLead(tx,context.session,input.leadId,true);await tx.execute(`update lead_customer_request_submissions set file_purged_at=clock_timestamp(),file_purge_actor=$4::uuid,version=version+1 where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid and file_purged_at is null and file_purge_started_at is not null and adopted_proof_id is null`,[session.workspaceId,input.leadId,input.submissionId,context.actorId]);return{id:input.submissionId,purged:true};},options);}
 return{...prepared,data:{id:input.submissionId,purged:true}};
}
