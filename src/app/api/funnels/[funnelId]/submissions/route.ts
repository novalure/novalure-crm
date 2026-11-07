import {readFunnelJson} from '@/lib/funnel-http';
import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {requirePermission} from '@/lib/auth/session';
import {CrmCommandError,crmCommandErrorResponse,crmPayloadDigest,withCrmRead,assertProjectGrant} from '@/lib/crm-command';
import {queryOne,withPublicSubmissionTransaction} from '@/lib/db/client';
import {persistFunnelSubmission,persistFunnelTestSubmission} from '@/lib/db/runtime-repositories';
import {getStoredFunnel,getPublishedFunnel} from '@/lib/funnel-store';
import {parseFunnelSubmission,runFunnelPreflight} from '@/lib/funnel-validation';
import {hasProductCapability} from '@/lib/product-model';
type RouteContext={params:Promise<{funnelId:string}>};
const token=(request:Request)=>new URL(request.url).searchParams.get('token')??request.headers.get('x-novalure-funnel-token')??'';
export async function POST(request:Request,context:RouteContext){try{
 const {funnelId}=await context.params,body=await readFunnelJson(request,85000);
 if(body.mode!=='test'&&body.mode!=='live')throw new CrmCommandError('INVALID_MODE','Anfragemodus prüfen.');
 if(body.mode==='test'){
  const auth=await requirePermission(request,'funnels:write');if(!auth.ok)return auth.response;
  const saved=await getStoredFunnel(funnelId,auth.session);if(!saved)return NextResponse.json({error:'Funnel nicht gefunden.'},{status:404});
  const payload=parseFunnelSubmission(body,saved.blueprint);
  const persistence=await withCrmRead(auth.session,async(tx,fresh)=>{await assertProjectGrant(tx,fresh,saved.projectId,true);return persistFunnelTestSubmission({session:fresh,blueprint:saved.blueprint,payload,score:0});});
  if(!persistence.persisted)throw new CrmCommandError('PERSISTENCE_REQUIRED','Testanfrage wurde nicht gespeichert.',503);
  return NextResponse.json({ok:true,mode:'test',persisted:true,submissionId:persistence.ids.submissionId,persistence});
 }
 const published=await getPublishedFunnel(funnelId,token(request));if(!published)throw new CrmCommandError('FUNNEL_UNAVAILABLE','Dieser Funnel ist nicht veröffentlicht oder der Link ist ungültig.',404);
 const payload=parseFunnelSubmission(body,published.blueprint),preflight=runFunnelPreflight(published.blueprint);
 const requestKey=request.headers.get('idempotency-key')??'';
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey))throw new CrmCommandError('IDEMPOTENCY_REQUIRED','Bitte die Anfrage erneut über das Formular senden.');
 const idempotencyKey='funnel:'+createHash('sha256').update(published.funnelId+':'+published.versionId+':'+requestKey).digest('hex');
 if(!preflight.ok)throw new CrmCommandError('PUBLISH_BLOCKED','Dieser Funnel nimmt derzeit keine Anfragen entgegen.',409);
 const persistence=await withPublicSubmissionTransaction({actorId:published.session.userId,workspaceId:published.session.workspaceId},async()=>{
  // Lock original scope and recheck publication after opening the same write transaction.
  const row=await queryOne<{id:string}>(`select id from funnels where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and status='aktiv' for update`,[published.session.workspaceId,published.blueprint.projectId,published.funnelId]);
  const member=await queryOne<{role:string;productRole:string}>('select role,product_role as "productRole" from crm_lock_active_member($1::uuid,$2::uuid)',[published.session.workspaceId,published.session.userId]);
  const allowed=await queryOne<{allowed:boolean}>('select crm_lock_project_access($1::uuid,$2::uuid,true) as allowed',[published.session.workspaceId,published.blueprint.projectId]);
  const current=await getPublishedFunnel(funnelId,token(request));
  if(!row||!member||!allowed?.allowed||!hasProductCapability(member.productRole as typeof published.session.productRole,'funnels:publish')||current?.versionId!==published.versionId)throw new CrmCommandError('FUNNEL_REVOKED','Funnel oder Projektfreigabe wurde geändert.',409);
  const prior=await queryOne<{id:string;payload:unknown}>('select id,raw_payload as payload from funnel_submissions where workspace_id=$1::uuid and idempotency_key=$2',[published.session.workspaceId,idempotencyKey]);
  if(prior){if(crmPayloadDigest(prior.payload)!==crmPayloadDigest(payload))throw new CrmCommandError('IDEMPOTENCY_CONFLICT','Die Anfrage wurde mit anderen Angaben bereits gesendet.',409);return {persisted:true as const,ids:{submissionId:prior.id}};}
  return persistFunnelSubmission({session:published.session,blueprint:published.blueprint,payload,score:0,idempotencyKey});
 });
 if(!persistence.persisted||!persistence.ids.submissionId)throw new CrmCommandError('PERSISTENCE_REQUIRED','Die Anfrage wurde nicht gespeichert.',503);
 // Public response contains no contact/lead/task IDs or internal scoring.
 return NextResponse.json({ok:true,mode:'live',persisted:true,submissionId:persistence.ids.submissionId});
 }catch(error){return crmCommandErrorResponse(error);}}
