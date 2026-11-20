import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppSession } from "../auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, executeCrmCommand, reconcileCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { websiteSalesActorAuthority } from "../website-sales-machine-authority";
import { qualifyWebsiteProspect, type WebsiteInvestmentInput, type WebsiteProspectInput } from "../website-prospect";
import { buildWebsiteDemo, createWebsiteConcept, createWebsiteDiagnosis, verifyWebsiteStudioArtifact, WebsiteStudioError, type WebsiteStudioArtifact, type WebsiteConceptArtifact, type WebsiteDiagnosisArtifact } from "../website-sales-studio";
import { assertWebsiteStudioQaActor, verifyWebsiteStudioQaCertificate } from "../website-sales-studio-qa";
import { websiteSalesStudioContract, type StudioScope, type WebsiteSalesStudioCommand, type WebsiteSalesStudioRead, type StudioArtifactRecord, type WebsiteStudioQaCertificate } from "../website-sales-studio-types";
import { queryAuthenticationRows } from "./tenant-client";
const uuid=z.uuid(),sha=z.hash("sha256"),short=z.string().trim().min(1).max(1000),claim=z.strictObject({text:short,evidenceIds:z.array(z.string().trim().min(1).max(100)).min(1).max(20)}),scopeSchema=z.strictObject({included:z.array(short).min(1).max(12),excluded:z.array(short).min(1).max(12)});
const investment=z.strictObject({estimatedCostMinor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),availableBudgetMinor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),expectedNetPriceMinor:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),estimatedDeliveryCostMinor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),minimumMarginBasisPoints:z.number().int().min(0).max(10000),requiredCapacityMinutes:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),availableCapacityMinutes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),rightsVerified:z.boolean(),budgetReference:short.nullable()});
const revision={version:z.number().int().positive().max(100000),previousArtifactDigest:sha.nullable()};
const payloadSchemas={
 create_diagnosis:z.strictObject({...revision,recommendations:z.array(claim).min(1).max(12),scope:scopeSchema,investmentPlan:investment}),
 create_concept:z.strictObject({...revision,diagnosisDigest:sha,objective:short,hero:claim,sections:z.array(z.strictObject({title:short,body:claim})).min(1).max(6),visualDirection:z.enum(["STUDIO_BLUE","BOTANICAL_GREEN","CRAFT_OCHRE"]),scope:scopeSchema,investmentPlan:investment}),
 accept_concept:z.strictObject({artifactId:uuid}),build_demo:z.strictObject({...revision,conceptDigest:sha,investmentPlan:investment}),
 submit_qa:z.strictObject({artifactId:uuid,certificate:z.unknown()}),create_preview:z.strictObject({artifactId:uuid,contactId:uuid,expiresAt:z.iso.datetime({offset:true})}),revoke_preview:z.strictObject({grantId:uuid,expectedVersion:z.number().int().positive()}),
};
const commandSchema=z.strictObject({contractVersion:z.literal(websiteSalesStudioContract),operation:z.enum(["create_diagnosis","create_concept","accept_concept","build_demo","submit_qa","create_preview","revoke_preview"]),projectId:uuid,companyId:uuid,locationId:uuid,workflowId:uuid,expectedWorkflowVersion:z.number().int().positive(),expectedEvidenceDigest:sha,idempotencyKey:z.uuidv4(),correlationId:uuid,payload:z.record(z.string(),z.unknown())});
function fail(code:string,status=409):never{throw new CrmCommandError(code,code,status);}
export function parseWebsiteSalesStudioCommand(raw:unknown):WebsiteSalesStudioCommand {
 if(Buffer.byteLength(JSON.stringify(raw)??"","utf8")>120000)fail("STUDIO_COMMAND_TOO_LARGE",413);
 const parsed=commandSchema.safeParse(raw);if(!parsed.success)fail("INVALID_STUDIO_COMMAND",400);
 const payload=payloadSchemas[parsed.data.operation].safeParse(parsed.data.payload);if(!payload.success)fail("INVALID_STUDIO_PAYLOAD",400);
 return {...parsed.data,payload:payload.data};
}
type Current={id:string;version:number;status:string;contactId:string|null;createdAt:string|Date;prospect:WebsiteProspectInput;evidenceDigest:string;companyName:string;address:string;locationVersion:number;currentLocationVersion:number;blockedReason:string|null};
async function current(tx:TenantTransaction,session:AppSession,scope:StudioScope,lock=false):Promise<Current>{
 await assertProjectGrant(tx,session,scope.projectId,lock);
 if(lock)await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`website-sales-location:${session.workspaceId}:${scope.locationId}`]);
 const row=await tx.queryOne<Current>(`select w.id,w.version,w.status,w.contact_id as "contactId",w.created_at as "createdAt",w.location_version as "locationVersion",l.version as "currentLocationVersion",o.prospect,o.evidence_digest as "evidenceDigest",c.name as "companyName",l.address,w.stop_reason as "blockedReason"
 from crm_website_sales_workflows w join crm_website_sales_observations o on o.workspace_id=w.workspace_id and o.id=w.observation_id
 join crm_company_locations l on l.workspace_id=w.workspace_id and l.id=w.location_id
 join organizations c on c.workspace_id=w.workspace_id and c.id=w.company_id and c.project_id=w.project_id
 join projects p on p.workspace_id=w.workspace_id and p.id=w.project_id
 where w.workspace_id=$1 and w.project_id=$2 and w.company_id=$3 and w.location_id=$4 and p.division='WEB_DESIGN' and c.data_classification='NOVALURE_INTERNAL' ${lock?"for update of w":""}`,[session.workspaceId,scope.projectId,scope.companyId,scope.locationId]);
 if(!row)fail("STUDIO_SCOPE_DENIED",403);
 row.version=Number(row.version);row.blockedReason=row.status==="STOPPED"?row.blockedReason??"STOPPED":null;
 const q=qualifyWebsiteProspect(row.prospect,new Date().toISOString());
 if(q.identity.workspaceId!==session.workspaceId||q.identity.projectId!==scope.projectId||q.identity.companyId!==scope.companyId||q.identity.locationId!==scope.locationId)fail("STUDIO_SCOPE_DENIED",403);
 if(q.status!=="READY"||q.evidenceDigest!==row.evidenceDigest||Number(row.locationVersion)!==Number(row.currentLocationVersion))row.blockedReason??="STALE_OR_UNQUALIFIED_EVIDENCE";
 if(row.contactId){
  const contact=await tx.queryOne<{consent:string;archived:unknown}>(`select consent_label as consent,archived_at as archived from contacts where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4 ${lock?"for share":""}`,[session.workspaceId,scope.projectId,scope.companyId,row.contactId]);
  if(!contact||contact.archived)row.blockedReason??="CONTACT_UNAVAILABLE";
  else if(/(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)/i.test(contact.consent??""))row.blockedReason??="OPT_OUT";
  const blocked=await tx.queryOne(`select 1 where exists(select 1 from crm_website_sales_workflows where workspace_id=$1 and contact_id=$2 and status='STOPPED' and stop_reason in('OPT_OUT','REPLY_RECEIVED','UNKNOWN_DELIVERY'))
   or exists(select 1 from consent_records where workspace_id=$1 and contact_id=$2 and status ~* '(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)')
   or exists(select 1 from newsletter_suppressions s join contacts c on c.workspace_id=s.workspace_id and lower(c.email)=lower(s.email) where c.workspace_id=$1 and c.id=$2)
   or crm_website_sales_has_reply($1,$3,$2,$4::timestamptz)`,[session.workspaceId,row.contactId,scope.projectId,row.createdAt]);
  if(blocked)row.blockedReason??="CONTACT_STOPPED";
 }
 return row;
}
type ArtifactRow={id:string;createdBy:string;artifact:WebsiteStudioArtifact};
async function artifactRows(tx:TenantTransaction,workspaceId:string,workflowId:string){return tx.query<ArtifactRow>(`select id,created_by as "createdBy",artifact from crm_website_studio_artifacts where workspace_id=$1 and workflow_id=$2 order by created_at desc,id desc limit 25`,[workspaceId,workflowId]);}
async function artifactBy(tx:TenantTransaction,workspaceId:string,workflowId:string,value:string,byDigest=false):Promise<ArtifactRow>{const row=await tx.queryOne<ArtifactRow>(`select id,created_by as "createdBy",artifact from crm_website_studio_artifacts where workspace_id=$1 and workflow_id=$2 and ${byDigest?"artifact_digest":"id"}=$3`,[workspaceId,workflowId,value]);if(!row)fail("STUDIO_ARTIFACT_NOT_FOUND",404);return row;}
async function latest(tx:TenantTransaction,workspaceId:string,workflowId:string,kind:string){return tx.queryOne<{version:number;digest:string}>(`select version,artifact_digest as digest from crm_website_studio_artifacts where workspace_id=$1 and workflow_id=$2 and kind=$3 order by version desc limit 1`,[workspaceId,workflowId,kind]);}
async function qaFor(tx:TenantTransaction,session:AppSession,row:ArtifactRow,workflowId:string){
 if(row.artifact.kind!=="DEMO")fail("STUDIO_DEMO_REQUIRED");
 const candidates=await tx.query<{id:string;certificate:WebsiteStudioQaCertificate}>(`select id,certificate from crm_website_studio_qa where workspace_id=$1 and artifact_id=$2 and expires_at>now() order by expires_at desc limit 20`,[session.workspaceId,row.id]);
 for(const candidate of candidates){try{const certificate=verifyWebsiteStudioQaCertificate(candidate.certificate,row.artifact,workflowId,row.createdBy);return {id:candidate.id,certificate};}catch{}}
 fail("SIGNED_RENDERED_QA_REQUIRED");
}
export async function readWebsiteSalesStudio(session:AppSession,scope:StudioScope,options:TenantTransactionOptions={}):Promise<WebsiteSalesStudioRead>{
 websiteSalesActorAuthority(session,scope,"read","studio");Object.values(scope).forEach(id=>assertCrmUuid(id));
 return withCrmRead(session,async(tx,fresh)=>{
  const row=await current(tx,fresh,scope),rows=await artifactRows(tx,fresh.workspaceId,row.id),artifacts:StudioArtifactRecord[]=[];
  let total=0;for(const item of rows){total+=Buffer.byteLength(JSON.stringify(item.artifact));if(total>1500000)break;
   const accepted=!!await tx.queryOne("select id from crm_website_studio_acceptances where workspace_id=$1 and artifact_id=$2",[fresh.workspaceId,item.id]);
   let qa:StudioArtifactRecord["qa"]=null;if(item.artifact.kind==="DEMO"&&!row.blockedReason){try{const verified=verifyWebsiteStudioArtifact(item.artifact,row.prospect,new Date().toISOString());if(verified.kind!=="DEMO")fail("STUDIO_DEMO_REQUIRED");await assertCurrentDemoParent(tx,fresh.workspaceId,row.id,verified);const q=await qaFor(tx,fresh,item,row.id);qa={certificateId:q.id,expiresAt:q.certificate.payload.expiresAt};}catch{}}
   artifacts.push({...item,accepted,qa});
  }
  const previews=await tx.query<{id:string;artifactId:string;contactId:string;expiresAt:string;revokedAt:string|null;version:number}>(`select id,artifact_id as "artifactId",contact_id as "contactId",expires_at::text as "expiresAt",revoked_at::text as "revokedAt",version from crm_website_studio_preview_grants where workspace_id=$1 and workflow_id=$2 order by created_at desc,id desc limit 25`,[fresh.workspaceId,row.id]);
  const canWrite=!!(await tx.queryOne<{allowed:boolean}>("select crm_project_access($1,$2,true) as allowed",[fresh.workspaceId,scope.projectId]))?.allowed&&fresh.permissions.includes("crm:write")&&fresh.productPermissions.includes("pipeline:write");
  return {contractVersion:websiteSalesStudioContract,workspaceId:fresh.workspaceId,...scope,workflowId:row.id,workflowVersion:row.version,evidenceDigest:row.evidenceDigest,blockedReason:row.blockedReason,canWrite,companyName:row.companyName,locationLabel:row.address,contactId:row.contactId,validUntil:qualifyWebsiteProspect(row.prospect,new Date().toISOString()).validUntil,sourceFacts:row.prospect.evidence.map(({evidenceId,finding,sourceUrl,validUntil})=>({evidenceId,finding,sourceUrl,validUntil})),canContact:false,artifacts,previews};
 },options);
}
export function websiteSalesStudioCommandInput(session:AppSession,raw:WebsiteSalesStudioCommand){
 const input=parseWebsiteSalesStudioCommand(raw);
 const authority=websiteSalesActorAuthority(session,input,input.operation,"studio");
 if(session.serviceIdentity&&["submit_qa","create_preview","revoke_preview"].includes(input.operation))fail("STUDIO_STAFF_REQUIRED",403);
 return {operation:`website_sales.studio.${input.operation}`,projectId:input.projectId,resourceId:input.locationId,idempotencyKey:input.idempotencyKey,correlationId:input.correlationId,capability:"pipeline:write" as const,payload:{...input,machineAuthority:authority}};
}
export async function reconcileWebsiteSalesStudioCommand(session:AppSession,raw:WebsiteSalesStudioCommand,options:TenantTransactionOptions={}){const input=parseWebsiteSalesStudioCommand(raw);return reconcileCrmCommand(session,websiteSalesStudioCommandInput(session,input),options);}
export async function executeWebsiteSalesStudioCommand(session:AppSession,raw:WebsiteSalesStudioCommand,options:TenantTransactionOptions={}){
 const input=parseWebsiteSalesStudioCommand(raw),command=websiteSalesStudioCommandInput(session,input);let issuedSecret:string|null=null;
 const result=await executeCrmCommand(session,command,async(tx,context)=>{
  const row=await current(tx,context.session,input,true);
  if(row.id!==input.workflowId||row.version!==input.expectedWorkflowVersion||row.evidenceDigest!==input.expectedEvidenceDigest)fail("STUDIO_WORKFLOW_VERSION_CONFLICT");
  // Revocation remains available even after evidence expires or a contact stops.
  if(input.operation!=="revoke_preview"&&row.blockedReason)fail(row.blockedReason);
  const p=input.payload,now=new Date().toISOString();
  if(input.operation==="revoke_preview"){
   const changed=await tx.queryOne(`update crm_website_studio_preview_grants set revoked_at=now(),revoked_by=$4,version=version+1 where workspace_id=$1 and workflow_id=$2 and id=$3 and version=$5 and revoked_at is null returning id`,[context.workspaceId,row.id,p.grantId,context.actorId,p.expectedVersion]);if(!changed)fail("STUDIO_PREVIEW_VERSION_CONFLICT");return {grantId:p.grantId,revoked:true,canContact:false};
  }
  if(input.operation==="accept_concept"||input.operation==="submit_qa"||input.operation==="create_preview"){
   const record=await artifactBy(tx,context.workspaceId,row.id,p.artifactId as string),artifact=verifyWebsiteStudioArtifact(record.artifact,row.prospect,now);
   const top=await latest(tx,context.workspaceId,row.id,artifact.kind);if(top?.digest!==artifact.artifactDigest)fail("STUDIO_LATEST_ARTIFACT_REQUIRED");
   if(input.operation==="accept_concept"){
    if(artifact.kind!=="CONCEPT")fail("STUDIO_CONCEPT_REQUIRED");
    const parent=await latest(tx,context.workspaceId,row.id,"DIAGNOSIS");if(parent?.digest!==artifact.parentArtifactDigest)fail("STUDIO_PARENT_CHANGED");
    const id=randomUUID();await tx.execute("insert into crm_website_studio_acceptances(id,workspace_id,project_id,artifact_id,accepted_by) values($1,$2,$3,$4,$5)",[id,context.workspaceId,input.projectId,record.id,context.actorId]);return {artifactId:record.id,acceptanceId:id,canContact:false};
   }
   if(artifact.kind!=="DEMO")fail("STUDIO_DEMO_REQUIRED");
   await assertCurrentDemoParent(tx,context.workspaceId,row.id,artifact);
   if(input.operation==="submit_qa"){
    const cert=verifyWebsiteStudioQaCertificate(p.certificate,artifact,row.id,record.createdBy);
    const qaActor=await tx.queryOne("select id from workspace_users where workspace_id=$1 and id=$2 and status='active'",[context.workspaceId,cert.payload.qaActorId]);if(!qaActor)fail("QA_ACTOR_UNAVAILABLE",403);
    await tx.execute("insert into crm_website_studio_qa(id,workspace_id,project_id,artifact_id,qa_actor_id,certificate,checked_at,expires_at) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",[cert.payload.certificateId,context.workspaceId,input.projectId,record.id,cert.payload.qaActorId,JSON.stringify(cert),cert.payload.checkedAt,cert.payload.expiresAt]);return {artifactId:record.id,certificateId:cert.payload.certificateId,canContact:false};
   }
   if(!row.contactId||p.contactId!==row.contactId||!["QUALIFIED","OFFER_DRAFT"].includes(row.status))fail("STUDIO_CANONICAL_CONTACT_REQUIRED");
   const qa=await qaFor(tx,context.session,record,row.id),expires=Date.parse(p.expiresAt as string);
   if(expires<=Date.parse(now)||expires>Date.parse(now)+86400000||expires>Date.parse(artifact.validUntil)||expires>Date.parse(qa.certificate.payload.expiresAt))fail("STUDIO_INVALID_PREVIEW_EXPIRY",400);
   const id=randomUUID();issuedSecret=randomBytes(32).toString("hex");await tx.execute(`insert into crm_website_studio_preview_grants(id,workspace_id,project_id,company_id,location_id,workflow_id,artifact_id,qa_id,contact_id,invitation_hash,expires_at,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,context.workspaceId,input.projectId,input.companyId,input.locationId,row.id,record.id,qa.id,row.contactId,secretHash(issuedSecret),p.expiresAt,context.actorId]);
   return {grantId:id,artifactId:record.id,expiresAt:p.expiresAt,canContact:false};
  }
  const kind=input.operation==="create_diagnosis"?"DIAGNOSIS":input.operation==="create_concept"?"CONCEPT":"DEMO",top=await latest(tx,context.workspaceId,row.id,kind);
  if(p.version!==(top?Number(top.version)+1:1)||p.previousArtifactDigest!==(top?.digest??null))fail("STUDIO_ARTIFACT_VERSION_CONFLICT");
  const revision={version:p.version as number,previousArtifactDigest:p.previousArtifactDigest as string|null};
  // Stage completion is constructed exclusively from current stored parents.
  const plan={...(p.investmentPlan as object),requestedStage:kind,completedStage:"NONE",completedStageEvidence:null} as WebsiteInvestmentInput;
  let artifact:WebsiteStudioArtifact;
  if(kind==="DIAGNOSIS")artifact=createWebsiteDiagnosis({prospect:row.prospect,companyName:row.companyName,locationLabel:row.address,recommendations:p.recommendations as z.infer<typeof claim>[],scope:p.scope as z.infer<typeof scopeSchema>,investmentPlan:plan,revision},now);
  else {
   const digest=(kind==="CONCEPT"?p.diagnosisDigest:p.conceptDigest) as string,parentRecord=await artifactBy(tx,context.workspaceId,row.id,digest,true),parent=verifyWebsiteStudioArtifact(parentRecord.artifact,row.prospect,now);
   if((await latest(tx,context.workspaceId,row.id,parent.kind))?.digest!==digest||parent.kind!==(kind==="CONCEPT"?"DIAGNOSIS":"CONCEPT"))fail("STUDIO_CURRENT_PARENT_REQUIRED");
   if(kind==="CONCEPT")artifact=createWebsiteConcept({prospect:row.prospect,diagnosis:parent as WebsiteDiagnosisArtifact,objective:p.objective as string,hero:p.hero as z.infer<typeof claim>,sections:p.sections as {title:string;body:z.infer<typeof claim>}[],visualDirection:p.visualDirection as "STUDIO_BLUE",scope:p.scope as z.infer<typeof scopeSchema>,investmentPlan:plan,revision},now);
   else artifact=await buildWebsiteDemo({prospect:row.prospect,concept:parent as WebsiteConceptArtifact,investmentPlan:plan,revision},{resolveAcceptedConcept:async()=>{
    if((await latest(tx,context.workspaceId,row.id,"DIAGNOSIS"))?.digest!==parent.parentArtifactDigest)fail("STUDIO_PARENT_CHANGED");
    const a=await tx.queryOne<{id:string;acceptedAt:string}>("select id,accepted_at::text as \"acceptedAt\" from crm_website_studio_acceptances where workspace_id=$1 and artifact_id=$2",[context.workspaceId,parentRecord.id]);if(!a)fail("STUDIO_CONCEPT_ACCEPTANCE_REQUIRED");return {identity:parent.identity,artifactDigest:parent.artifactDigest,acceptanceId:a.id,acceptedAt:new Date(a.acceptedAt).toISOString()};
   }},now);
  }
  verifyWebsiteStudioArtifact(artifact,row.prospect,now);if(Buffer.byteLength(JSON.stringify(artifact))>120000)fail("STUDIO_ARTIFACT_TOO_LARGE",413);
  const id=randomUUID();await tx.execute(`insert into crm_website_studio_artifacts(id,workspace_id,project_id,company_id,location_id,workflow_id,kind,version,artifact_digest,evidence_digest,artifact,created_by,created_at,valid_until) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,[id,context.workspaceId,input.projectId,input.companyId,input.locationId,row.id,artifact.kind,artifact.version,artifact.artifactDigest,artifact.evidenceDigest,JSON.stringify(artifact),context.actorId,artifact.createdAt,artifact.validUntil]);return {artifactId:id,artifactDigest:artifact.artifactDigest,kind,version:artifact.version,canContact:false};
 },options).catch(error=>{if(error instanceof WebsiteStudioError)throw new CrmCommandError(error.code,error.code,409);if(error instanceof z.ZodError)throw new CrmCommandError("INVALID_STUDIO_CONTENT","Invalid studio content",400);throw error;});
 // The one-time invitation is deliberately absent from the persisted receipt and audit.
 return {...result,contractVersion:websiteSalesStudioContract,persisted:true as const,correlationId:input.correlationId,...(issuedSecret?{invitation:{grantId:result.data.grantId,token:issuedSecret}}:{})};
}
async function assertCurrentDemoParent(tx:TenantTransaction,workspaceId:string,workflowId:string,artifact:Extract<WebsiteStudioArtifact,{kind:"DEMO"}>) {
 if((await latest(tx,workspaceId,workflowId,"CONCEPT"))?.digest!==artifact.parentArtifactDigest||(await latest(tx,workspaceId,workflowId,"DIAGNOSIS"))?.digest!==artifact.content.concept.parentArtifactDigest)fail("STUDIO_PARENT_CHANGED");
 const accepted=await tx.queryOne("select id from crm_website_studio_acceptances where workspace_id=$1 and id=$2",[workspaceId,artifact.content.acceptanceId]);if(!accepted)fail("STUDIO_ACCEPTANCE_REQUIRED");
}
export async function websiteStudioQaRender(session:AppSession,scope:StudioScope|null,artifactId:string,options:TenantTransactionOptions={}){
 if(session.serviceIdentity)fail("STUDIO_STAFF_REQUIRED",403);
 return withCrmRead(session,async(tx,fresh)=>{const resolved=scope??await tx.queryOne<StudioScope>('select project_id as "projectId",company_id as "companyId",location_id as "locationId" from crm_website_studio_artifacts where workspace_id=$1 and id=$2',[fresh.workspaceId,assertCrmUuid(artifactId)]);if(!resolved)fail("STUDIO_ARTIFACT_NOT_FOUND",404);assertWebsiteStudioQaActor(fresh.workspaceId,resolved.projectId,fresh.userId);const row=await current(tx,fresh,resolved);if(row.blockedReason)fail(row.blockedReason);const stored=await artifactBy(tx,fresh.workspaceId,row.id,assertCrmUuid(artifactId));const artifact=verifyWebsiteStudioArtifact(stored.artifact,row.prospect,new Date().toISOString());if(artifact.kind!=="DEMO"||stored.createdBy===fresh.userId)fail("INDEPENDENT_QA_REQUIRED",403);await assertCurrentDemoParent(tx,fresh.workspaceId,row.id,artifact);return artifact;},options);
}
export function secretHash(value:string){return createHash("sha256").update(value).digest("hex");}
export function websiteStudioCookieName(grantId:string){return `novalure_studio_${grantId.replaceAll("-","")}`;}
export async function websiteStudioPublicPreview(grantId:string,secret:string,exchange:boolean,options:TenantTransactionOptions={}){
 if(!uuid.safeParse(grantId).success||!/^[a-f0-9]{64}$/.test(secret))return null;
 const cookie=exchange?randomBytes(32).toString("hex"):null;
 const rows=await queryAuthenticationRows<{artifact:WebsiteStudioArtifact;prospect:WebsiteProspectInput;certificate:WebsiteStudioQaCertificate;builder_id:string;expires_at:string|Date}>("select * from crm_website_studio_preview_access($1::uuid,$2,$3,$4)",[grantId,secretHash(secret),exchange,cookie?secretHash(cookie):null],options),row=rows[0];if(!row)return null;
 try {const artifact=verifyWebsiteStudioArtifact(row.artifact,row.prospect,new Date().toISOString());if(artifact.kind!=="DEMO")return null;verifyWebsiteStudioQaCertificate(row.certificate,artifact,row.certificate.payload.workflowId,row.builder_id);return {artifact,cookie,expiresAt:new Date(row.expires_at).toISOString()};}catch{return null;}
}
