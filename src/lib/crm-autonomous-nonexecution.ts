import "server-only";
import {createPublicKey,verify} from "node:crypto";
import {queryAuthenticationRows,withTenantTransaction,type TenantTransactionOptions} from "./db/tenant-client";
import {getCrmMachineBearer,verifyCrmMachineToken,type CrmMachineAuthOptions} from "./crm-machine-auth";
import {CrmCommandError,crmPayloadDigest} from "./crm-command";
import {autonomousModuleContract,autonomousModuleMaximumBytes,parseAutonomousModuleRequest} from "./crm-autonomous-module-contract";
import {readKnowledgeJson} from "./knowledge-center/http";

export const autonomousNonexecutionDomain=`${autonomousModuleContract}-close.POST./api/integrations/evelyn/access`;
export const autonomousRecoveryVersion="evelyn.crm-native-recovery.v1";
const bindingFields=["grantId","workspaceId","sourceId","taskId","departmentId","agentId","entity","crmProjectId","controlProjectId","missionId","attemptId","effectId","registryVersion","targetDigest","artifactDigest","requestDigest"] as const;
type Binding=Record<typeof bindingFields[number],string>;
type Authority={authority_id:string;workload_id:string;recovery_key:string;grant_id:string;workspace_id:string;actor_user_id:string;project_id:string;source_id:string;entity:string;department_id:string;agent_id:string;task_id:string;control_project_id:string};
type Options=TenantTransactionOptions&{machineAuth?:CrmMachineAuthOptions};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=/^[a-f0-9]{64}$/;
function deny(code="RECOVERY_BINDING_INVALID",status=403):never{throw new CrmCommandError(code,"Recovery request denied",status);}
function sameKeys(value:Record<string,unknown>,keys:readonly string[]){return Object.keys(value).sort().join(",")===Array.from(keys).sort().join(",");}
function parseProof(request:Request,now:number){
 const parts=request.headers.get("x-evelyn-recovery")?.split(".");
 if(!parts||parts.length!==4||parts[0]!=="v1"||!uuid.test(parts[1]!)||!/^[A-Za-z0-9_-]{1,4096}$/.test(parts[2]!)||!/^[A-Za-z0-9_-]{86}$/.test(parts[3]!))deny("RECOVERY_SIGNATURE_INVALID",401);
 let p:Record<string,unknown>;
 try{p=JSON.parse(Buffer.from(parts[2]!,"base64url").toString("utf8"));}catch{deny("RECOVERY_SIGNATURE_INVALID",401);}
 if(!p||typeof p!=="object"||Array.isArray(p)||!sameKeys(p,[...bindingFields,"issuedAt","expiresAt","nonce"]))deny();
 if(!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||Number(p.issuedAt)>now+30||Number(p.expiresAt)<=now||Number(p.expiresAt)<=Number(p.issuedAt)||Number(p.expiresAt)-Number(p.issuedAt)>60||typeof p.nonce!=="string"||!uuid.test(p.nonce))deny("RECOVERY_SIGNATURE_INVALID",401);
 const binding=Object.fromEntries(bindingFields.map(f=>[f,p[f]])) as Binding;
 for(const f of ["grantId","workspaceId","sourceId","taskId","crmProjectId","controlProjectId","missionId","attemptId","effectId"] as const)if(typeof binding[f]!=="string"||!uuid.test(binding[f]))deny();
 if(!digest.test(binding.targetDigest)||!digest.test(binding.artifactDigest)||!digest.test(binding.requestDigest)||!/^[1-9][0-9]{0,17}$/.test(binding.registryVersion)||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(binding.agentId)||typeof binding.departmentId!=="string"||typeof binding.entity!=="string")deny();
 return {authorityId:parts[1]!,encoded:parts[2]!,signature:parts[3]!,nonce:p.nonce,expiresAt:Number(p.expiresAt),binding};
}
function assertAuthority(a:Authority|undefined,b:Binding){
 if(!a||a.grant_id!==b.grantId||a.workspace_id!==b.workspaceId||a.project_id!==b.crmProjectId||a.source_id!==b.sourceId||a.task_id!==b.taskId||a.department_id!==b.departmentId||a.agent_id!==b.agentId||a.entity!==b.entity||a.control_project_id!==b.controlProjectId)deny();
 return a;
}

/** Separate technical recovery capability. No department signer, current
 * business record read, CAS, approval consumption or business callback exists. */
export async function handleAutonomousCrmNonexecution(request:Request,options:Options={}):Promise<Response>{
 try{
  const env=options.machineAuth?.env??process.env;
  if(env.CRM_AUTONOMOUS_NONEXECUTION_ENABLED!=="1")deny("RECOVERY_AUTHORITY_DENIED");
  const url=new URL(request.url);
  if(request.method!=="POST"||url.pathname!=="/api/integrations/evelyn/access"||url.search)deny("INVALID_REQUEST",400);
  if(request.headers.get("x-evelyn-close-without-effect")!=="1"||request.headers.has("x-evelyn-delegation")||request.headers.has("x-evelyn-reconcile-only")||request.headers.has("cookie")||request.headers.has("origin"))deny("INVALID_REQUEST",400);
  let body:ReturnType<typeof parseAutonomousModuleRequest>;
  try{body=parseAutonomousModuleRequest(await readKnowledgeJson(request,["contractVersion","operation","correlationId","idempotencyKey","expectedVersion","patch"],autonomousModuleMaximumBytes));}
  catch{deny("INVALID_REQUEST",400);}
  if(body.operation==="Read"||body.operation==="DescribeAssignment")deny("INVALID_REQUEST",400);
  const token=getCrmMachineBearer(request.headers);if(!token)deny("ACCESS_DENIED",401);
  const claims=await verifyCrmMachineToken(token,options.machineAuth).catch(()=>deny("ACCESS_DENIED",401));
  const principal=(await queryAuthenticationRows<{id:string;workspace_id:string;identity_id:string}>("select * from public.crm_authenticate_autonomous_workload($1,$2,$3,$4,$5,$6::uuid,$7)",[claims.issuer,claims.audience,claims.projectId,claims.ownerId,claims.subject,claims.workspaceId,claims.environment],options))[0];
  if(!principal||principal.workspace_id!==claims.workspaceId||principal.identity_id!=="EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY")deny("ACCESS_DENIED",401);
  const now=Math.floor((options.machineAuth?.now??new Date()).valueOf()/1000),proof=parseProof(request,now),b=proof.binding;
  if(b.workspaceId!==claims.workspaceId||b.requestDigest!==crmPayloadDigest(body))deny();
  const authority=assertAuthority((await queryAuthenticationRows<Authority>("select * from public.crm_lookup_autonomous_recovery($1::uuid,$2::uuid,$3::uuid,$4::uuid)",[principal.id,proof.authorityId,b.grantId,b.controlProjectId],options))[0],b);
  try{
   const key=createPublicKey({key:Buffer.from(authority.recovery_key,"base64url"),format:"der",type:"spki"});
   if(key.asymmetricKeyType!=="ed25519"||!verify(null,Buffer.from(`${autonomousNonexecutionDomain}.${proof.authorityId}.${proof.encoded}`),key,Buffer.from(proof.signature,"base64url")))deny("RECOVERY_SIGNATURE_INVALID",401);
  }catch{deny("RECOVERY_SIGNATURE_INVALID",401);}
  const data=await withTenantTransaction({workspaceId:b.workspaceId,actorId:authority.actor_user_id},async tx=>{
   const current=await tx.queryOne<{permitted:boolean}>("select public.crm_lock_autonomous_recovery($1::uuid,$2::uuid,$3::uuid,$4::uuid) as permitted",[principal.id,proof.authorityId,b.grantId,b.controlProjectId]);
   if(!current?.permitted)deny("RECOVERY_AUTHORITY_DENIED");
   await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`crm-command:${b.workspaceId}:${body.idempotencyKey}`]);
   const lockedNow=Math.floor((options.machineAuth?.now??new Date()).valueOf()/1000);
   if(proof.expiresAt<=lockedNow)deny("RECOVERY_SIGNATURE_INVALID",401);
   if(claims.expiresAt<=lockedNow)deny("ACCESS_DENIED",401);
   const row=await tx.queryOne<{receipt:Record<string,unknown>}>("select public.crm_close_autonomous_nonexecution($1::uuid,$2::uuid,$3::jsonb,$4::jsonb,$5,$6::uuid,$7) as receipt",[principal.id,proof.authorityId,JSON.stringify(b),JSON.stringify(body),b.requestDigest,proof.nonce,claims.jtiHash]);
   if(!row?.receipt)deny("RECOVERY_AUTHORITY_DENIED");return row.receipt;
  },options);
  return Response.json(data,{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){
  const sql=error&&typeof error==="object"&&"message" in error?String(error.message):"";
  const known=error instanceof CrmCommandError||["IDEMPOTENCY_CONFLICT","NONCE_REPLAY","RECOVERY_AUTHORITY_DENIED","RECOVERY_BINDING_INVALID"].includes(sql);
  const code=error instanceof CrmCommandError?error.code:known?sql:"RECOVERY_UNAVAILABLE";
  const status=error instanceof CrmCommandError?error.status:!known?503:["IDEMPOTENCY_CONFLICT","NONCE_REPLAY"].includes(code)?409:403;
  return Response.json({contractVersion:autonomousModuleContract,code},{status,headers:{"Cache-Control":"private, no-store"}});
 }
}
