import "server-only";
import { createPublicKey,randomUUID,verify } from "node:crypto";
import policy from "../../config/crm-department-access-policy.json";
import type { AppSession } from "./auth/session";
import { getRolePermissions } from "./auth/permissions";
import { getProductRoleCapabilities } from "./product-model";
import { queryAuthenticationRows } from "./db/tenant-client";
import { assertProjectGrant,CrmCommandError,crmPayloadDigest,executeCrmCommand,reconcileCrmCommand,withCrmRead,withCrmCommandPreflight,
 type CrmCommandInput,type TenantTransaction,type TenantTransactionOptions } from "./crm-command";
import { CrmMachineAuthError,getCrmMachineBearer,verifyCrmMachineToken,type CrmMachineAuthOptions } from "./crm-machine-auth";
import { CRM_PERSONAL_SOURCE,verifyPersonalAutonomousCrmToken } from "./crm-autonomous-personal-auth";
import { autonomousAccessPath } from "./crm-autonomous-access";
import { readKnowledgeJson } from "./knowledge-center/http";
import { KnowledgeCenterError } from "./knowledge-center/policy";
import { autonomousModuleContract,autonomousModuleMaximumBytes,autonomousModuleOperations,autonomousModuleFields,
 autonomousModuleWriteFields,autonomousModuleScope,parseAutonomousModuleRequest,validateAutonomousModulePatch,
 type AutonomousModuleOperation,type AutonomousModuleRequest } from "./crm-autonomous-module-contract";
import { readAutonomousModule,writeAutonomousModule,autonomousModuleExists,assertAutonomousModuleRelations,type AutonomousModuleGrant } from "./crm-autonomous-module-storage";
import { assertAndConsumeAutonomousBusinessAuthority } from "./crm-autonomous-business-authority";

export const autonomousModuleDelegationDomain=`${autonomousModuleContract}.POST.${autonomousAccessPath}`;
export const autonomousModuleReconciliationDomain=`${autonomousModuleContract}-reconcile.POST.${autonomousAccessPath}`;
type Options=TenantTransactionOptions&{machineAuth?:CrmMachineAuthOptions};
const grantSql="select * from public.crm_lock_autonomous_access_grant($1::uuid,$2::uuid)";
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function denied(code="ACCESS_DENIED",status=403):never{throw new CrmCommandError(code,"CRM module access is not granted",status);}
const readOnly=(op:string)=>op==="Read"||op==="DescribeAssignment";
const guarded=new Set(["SendOffer","ConfirmReservation","ConfirmSale"]);
function delegation(value:string|null){
 const p=value?.split(".");if(!p||p.length!==4||p[0]!=="v1"||!uuid.test(p[1]!)||!/^[a-z0-9_-]+$/i.test(p[2]!)||p[2]!.length>1400||!/^[a-z0-9_-]{86}$/i.test(p[3]!))denied("DELEGATION_INVALID",401);
 return {grantId:p[1]!,payload:p[2]!,signature:p[3]!};
}
function verifyDelegation(d:ReturnType<typeof delegation>,grant:AutonomousModuleGrant,body:AutonomousModuleRequest,now:Date,reconcileOnly=false){
 let p:Record<string,unknown>;
 try{const key=createPublicKey({key:Buffer.from(grant.delegation_public_key,"base64url"),format:"der",type:"spki"});
  const domain=reconcileOnly?autonomousModuleReconciliationDomain:autonomousModuleDelegationDomain;
  if(key.asymmetricKeyType!=="ed25519"||!verify(null,Buffer.from(`${domain}.${d.grantId}.${d.payload}`),key,Buffer.from(d.signature,"base64url")))denied("DELEGATION_INVALID",401);
  p=JSON.parse(Buffer.from(d.payload,"base64url").toString("utf8")) as Record<string,unknown>;
 }catch{denied("DELEGATION_INVALID",401);}
 const t=Math.floor(now.valueOf()/1000);
 if(!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).sort().join(",")!=="expiresAt,issuedAt,nonce,requestHash"||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||Number(p.issuedAt)>t+30||Number(p.expiresAt)<=t||Number(p.expiresAt)<=Number(p.issuedAt)||Number(p.expiresAt)-Number(p.issuedAt)>300||!uuid.test(String(p.nonce))||p.requestHash!==crmPayloadDigest(body))denied("DELEGATION_INVALID",401);
 return String(p.nonce);
}
type Rule={entity:string;operation:string;fields:string[];purpose:string;approval:string|null;evidence:string|null};
function rules(grant:AutonomousModuleGrant){return (policy.departments as Record<string,Rule[]>)[grant.department_id]?.filter(r=>r.entity===grant.entity)??[];}
function fields(grant:AutonomousModuleGrant,operation:AutonomousModuleOperation){const rule=rules(grant).find(r=>r.operation===operation);if(!rule)return [];
 return (operation==="Read"?grant.read_fields:grant.write_fields).filter(f=>rule.fields.includes(f));}
function operations(grant:AutonomousModuleGrant){return autonomousModuleOperations.filter(op=>rules(grant).some(r=>r.operation===op)&&
 (op==="DescribeAssignment"||grant.scopes.includes(autonomousModuleScope(grant.entity,op)))&&
 (op!=="Create"||grant.lifecycle_mode==="CREATE")&&
 (op!=="Read"||fields(grant,op).length>0)&&
 (!(["Create","Update","PrepareOffer","PrepareReservation"] as string[]).includes(op)||fields(grant,op).length>0));}
function assertPolicy(grant:AutonomousModuleGrant,body:AutonomousModuleRequest){
 if(!rules(grant).some(r=>r.operation===body.operation))denied("DEPARTMENT_POLICY_DENIED");
 if(!operations(grant).includes(body.operation))denied("GRANT_OPERATION_DENIED");
 if(!readOnly(body.operation)&&Object.keys(body.patch).some(f=>!fields(grant,body.operation).includes(f)))denied("FIELDS_DENIED");
 if(body.operation==="Create"&&grant.lifecycle_mode!=="CREATE")denied();
 validateAutonomousModulePatch(grant.entity,body);
}
function grantDigest(g:AutonomousModuleGrant){return crmPayloadDigest({id:g.id,workloadId:g.workload_id,workspaceId:g.workspace_id,actorId:g.actor_user_id,
 projectId:g.project_id,sourceId:g.source_id,entity:g.entity,departmentId:g.department_id,agentId:g.agent_id,taskId:g.task_id,scopes:g.scopes,
 publicKey:g.delegation_public_key,contractVersion:g.contract_version,readFields:g.read_fields,writeFields:g.write_fields,relatedResources:g.related_resources,lifecycleMode:g.lifecycle_mode,parentGrantId:g.parent_grant_id,delegationKind:g.delegation_kind});}
function validateGrant(grant:AutonomousModuleGrant|null|undefined,workspace:string):asserts grant is AutonomousModuleGrant{
 if(!grant||grant.workspace_id!==workspace||grant.contract_version!==autonomousModuleContract||!autonomousModuleFields[grant.entity]||
  !Array.isArray(grant.read_fields)||!Array.isArray(grant.write_fields)||!grant.related_resources||
  grant.read_fields.some(f=>!autonomousModuleFields[grant.entity].includes(f))||grant.write_fields.some(f=>!autonomousModuleWriteFields[grant.entity].includes(f)))denied();
}
/** Fresh OIDC establishes a native workload; registered Ed25519 delegation,
 * canonical department policy, field masks and current CRM/RLS establish scope. */
export async function handleAutonomousCrmModules(request:Request,options:Options={}):Promise<Response>{
 try{
  const url=new URL(request.url);if(request.method!=="POST"||url.pathname!==autonomousAccessPath||url.search||request.headers.has("cookie")||request.headers.has("origin"))denied("ACCESS_DENIED",401);
  const reconciliationHeader=request.headers.get("x-evelyn-reconcile-only");
  if(reconciliationHeader!==null&&reconciliationHeader!=="1")denied("INVALID_REQUEST",400);
  const reconcileOnly=reconciliationHeader==="1";
  const token=getCrmMachineBearer(request.headers);if(!token)denied("ACCESS_DENIED",401);
  const claims=await verifyCrmMachineToken(token,options.machineAuth).catch(error=>{const env=options.machineAuth?.env??process.env;
   if(env.CRM_MACHINE_AUTH_ENABLED!=="1"||env.CRM_AUTONOMOUS_PERSONAL_SOURCE_ENABLED!=="1")throw error;return verifyPersonalAutonomousCrmToken(token,options.machineAuth);});
  const personal=claims.identityId===CRM_PERSONAL_SOURCE.identityId;
  const params=[claims.issuer,claims.audience,claims.projectId,claims.ownerId,claims.subject,claims.workspaceId,claims.environment];
  const principal=(await queryAuthenticationRows<{id:string;workspace_id:string;identity_id:string}>(personal?"select * from public.crm_authenticate_personal_autonomous_workload($1,$2,$3,$4,$5,$6::uuid,$7,$8)":"select * from public.crm_authenticate_autonomous_workload($1,$2,$3,$4,$5,$6::uuid,$7)",personal?[...params,claims.customEnvironmentId]:params,options))[0];
  if(!principal||principal.workspace_id!==claims.workspaceId||principal.identity_id!==(personal?CRM_PERSONAL_SOURCE.identityId:"EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY"))denied();
  const d=delegation(request.headers.get("x-evelyn-delegation"));
  const body=parseAutonomousModuleRequest(await readKnowledgeJson(request,["contractVersion","operation","correlationId","idempotencyKey","expectedVersion","patch"],autonomousModuleMaximumBytes));
  if(reconcileOnly&&readOnly(body.operation))denied("INVALID_REQUEST",400);
  const grant=(await queryAuthenticationRows<AutonomousModuleGrant>(grantSql,[principal.id,d.grantId],options))[0];validateGrant(grant,claims.workspaceId);
  const now=()=>options.machineAuth?.now??new Date();const nonce=verifyDelegation(d,grant,body,now(),reconcileOnly);assertPolicy(grant,body);
  const session:AppSession={authenticated:true,source:"database",workspaceId:grant.workspace_id,userId:grant.actor_user_id,workspaceName:"Registered internal operations",name:"Registered CRM department agent",email:"delegated-agent@service.invalid",role:"agent",productRole:"novalure_operator",permissions:getRolePermissions("agent"),productPermissions:getProductRoleCapabilities("novalure_operator"),
   serviceIdentity:claims.environment==="franz-personal"
    ?{identityId:CRM_PERSONAL_SOURCE.identityId,role:claims.role,consumer:claims.consumer,environment:claims.environment,jtiHash:claims.jtiHash}
    :{identityId:principal.identity_id,role:claims.role,consumer:claims.consumer,environment:claims.environment,jtiHash:claims.jtiHash}};
  const attribution={grantId:grant.id,departmentId:grant.department_id,agentId:grant.agent_id,taskId:grant.task_id};
  const command:CrmCommandInput={operation:`autonomous.module.${grant.entity.toLowerCase()}.${body.operation.toLowerCase()}`,resourceId:grant.source_id,projectId:grant.project_id,expectedVersion:body.expectedVersion??undefined,idempotencyKey:body.idempotencyKey,correlationId:body.correlationId,capability:["Unit","Viewing","Reservation","Sale"].includes(grant.entity)?"reservations:write":"workspace:operate",payload:{...attribution,policyVersion:policy.policyVersion,request:body}};
  const access=async(tx:TenantTransaction,fresh:AppSession)=>{
   const revalidate=async()=>{const current=await tx.queryOne<AutonomousModuleGrant>(grantSql,[principal.id,grant.id]);validateGrant(current,claims.workspaceId);
    if(grantDigest(current)!==grantDigest(grant))denied();verifyDelegation(d,current,body,now(),reconcileOnly);if(claims.expiresAt<=Math.floor(now().valueOf()/1000))denied("ACCESS_DENIED",401);assertPolicy(current,body);return current;};
   await revalidate();await assertProjectGrant(tx,fresh,grant.project_id,!readOnly(body.operation));
   await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`autonomous-access:${grant.id}:${nonce}`]);await revalidate();
   if(await tx.queryOne("select nonce from crm_autonomous_access_events where grant_id=$1 and nonce=$2",[grant.id,nonce]))denied("NONCE_REPLAY",409);
   let data:Record<string,unknown>,auditReference:string=randomUUID(),replayed=false;
   const readFields=fields(grant,"Read");
   if(body.operation==="DescribeAssignment"){
    if(grant.lifecycle_mode!=="CREATE"||await autonomousModuleExists(tx,grant))await readAutonomousModule(tx,grant,[]);
    const current=await revalidate(),seconds=Math.floor(now().valueOf()/1000),expiresAt=Math.min(seconds+60,claims.expiresAt,current.expires_at===null?seconds+60:Math.floor(new Date(current.expires_at).valueOf()/1000));
    if(expiresAt<=seconds)denied();data={operations:operations(grant),expiresAt,readFields,writeFields:grant.write_fields.filter(f=>rules(grant).some(r=>r.operation!=="Read"&&r.fields.includes(f))),contractVersion:autonomousModuleContract,parentGrantId:grant.parent_grant_id,delegationKind:grant.delegation_kind};
   }else if(body.operation==="Read")data=await readAutonomousModule(tx,grant,readFields);
   else{
    await assertAutonomousModuleRelations(tx,grant,body.patch);await revalidate();
    let result:{data:Record<string,unknown>;auditReference:string;replayed:boolean};
    if(reconcileOnly){
     const stored=await reconcileCrmCommand<Record<string,unknown>>(fresh,command,options);
     if(stored.status==="NOT_FOUND")denied("RECEIPT_NOT_FOUND",404);
     result=stored;
    }else result=await executeCrmCommand(fresh,command,async commandTx=>{await revalidate();if(guarded.has(body.operation))await assertAndConsumeAutonomousBusinessAuthority(commandTx,fresh,grant,body);await writeAutonomousModule(commandTx,fresh,grant,body);await revalidate();return readAutonomousModule(commandTx,grant,readFields);},options);
    if(guarded.has(body.operation))await assertAndConsumeAutonomousBusinessAuthority(tx,fresh,grant,body);
    // A stored receipt never bypasses current source scope or field policy.
    await readAutonomousModule(tx,grant,readFields);
    if(!result.data||typeof result.data!=="object"||Array.isArray(result.data))denied("INVALID_CRM_RESPONSE",502);
    data=Object.fromEntries(Object.entries(result.data).filter(([field])=>field==="version"||field==="updatedAt"||readFields.includes(field)));
    auditReference=result.auditReference;replayed=result.replayed;
   }
   if(!readOnly(body.operation))await assertAutonomousModuleRelations(tx,grant,body.patch,true);
   await revalidate();
   await tx.execute(`insert into crm_autonomous_access_events(grant_id,nonce,workspace_id,actor_user_id,department_id,agent_id,task_id,project_id,source_id,action,request_hash,oidc_jti_hash,audit_reference,outcome) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'SUCCESS')`,[grant.id,nonce,grant.workspace_id,grant.actor_user_id,grant.department_id,grant.agent_id,grant.task_id,grant.project_id,grant.source_id,autonomousModuleScope(grant.entity,body.operation),crmPayloadDigest(body),claims.jtiHash,auditReference]);
   return {...attribution,workspaceId:grant.workspace_id,projectId:grant.project_id,sourceId:grant.source_id,entity:grant.entity,data,auditReference,replayed};
  };
  const result=readOnly(body.operation)?await withCrmRead(session,access,options):await withCrmCommandPreflight(session,command,access,options);
  return Response.json({contractVersion:autonomousModuleContract,correlationId:body.correlationId,...result},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){const known=error instanceof CrmCommandError||error instanceof CrmMachineAuthError;
  return Response.json({contractVersion:autonomousModuleContract,code:error instanceof KnowledgeCenterError?"INVALID_REQUEST":known?error.code:"ACCESS_UNAVAILABLE"},{status:error instanceof KnowledgeCenterError?400:known?error.status:503,headers:{"Cache-Control":"private, no-store"}});}
}
