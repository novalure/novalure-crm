import "server-only";
import {createHash,createPublicKey} from "node:crypto";
import {assertCrmUuid,crmPayloadDigest} from "./crm-command";
import {CRM_MACHINE_ISSUER,CRM_MACHINE_OWNER_ID,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_WORKSPACE_ID} from "./crm-machine-auth";
import {autonomousCrmDepartments,type AutonomousCrmRegistration} from "./crm-autonomous-registration";
import {autonomousModuleContract} from "./crm-autonomous-module-contract";
import {autonomousPreviewIdentity,autonomousPreviewAudience,autonomousPreviewSubject} from "./crm-autonomous-preview-auth";
import {isWebsiteSalesPreviewTarget} from "./website-sales-preview-auth";
import policy from "../../config/crm-department-access-policy.json";

export type AutonomousPreviewRegistration=Omit<AutonomousCrmRegistration,"sourceProfile"|"entity"|"expiresAt"|"module">&Readonly<{
 entity:"Task";expiresAt:string;
 preview:Readonly<{origin:string;deploymentId:string;revision:string;qaRunId:string}>;
 module:NonNullable<AutonomousCrmRegistration["module"]>;
}>;
type Connection={query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
function need(ok:unknown,code:string):asserts ok{if(!ok)throw new Error(code);}
const iso=(v:unknown)=>v instanceof Date?v.toISOString():typeof v==="string"?new Date(v).toISOString():null;

/** Only the assigned protected original Task-reader/operator can invoke this.
 * One transaction holds the actual own Task SHARE lock through grant commit.
 * There is no HTTP registrar, supplied proof callback or privilege management. */
export async function registerAutonomousCrmPreviewAccess(connection:Connection,raw:AutonomousPreviewRegistration){
 const a=structuredClone(raw),m=a.module,p=a.preview;
 for(const id of [a.workloadId,a.workloadActorId,a.grantId,a.actorId,a.projectId,a.sourceId,a.taskId,p?.qaRunId])assertCrmUuid(id);
 const rules=(policy.departments as Record<string,Array<{entity:string;operation:string;fields:string[]}>>)[a.departmentId]?.filter(r=>r.entity==="Task")??[];
 need(!Object.hasOwn(a,"sourceProfile")&&a.entity==="Task"&&autonomousCrmDepartments.includes(a.departmentId)&&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(p.qaRunId)&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(a.grantId)&&isWebsiteSalesPreviewTarget(p)&&/^https:\/\/novalure-[a-z0-9-]+-novalure\.vercel\.app$/.test(p.origin)&&!p.origin.includes('-git-')&&p.origin!=="https://novalure-crm-novalure.vercel.app"&&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(a.agentId)&&a.authorityReference.trim()&&a.authorityReference.length<=200&&
  a.scopes.includes('crm.tasks.read')&&new Set(a.scopes).size===a.scopes.length&&a.scopes.every(s=>['crm.tasks.read','crm.tasks.write'].includes(s))&&
  Number.isFinite(Date.parse(a.expiresAt))&&Date.parse(a.expiresAt)>Date.now()&&m?.contractVersion===autonomousModuleContract&&m.lifecycleMode==='EXISTING'&&
  m.readFields.length===1&&m.readFields[0]==='title'&&m.writeFields.length===(a.scopes.includes('crm.tasks.write')?1:0)&&m.writeFields.every(f=>f==='title')&&
  Object.keys(m.relatedResources).length===0&&rules.some(r=>r.operation==='Read'&&r.fields.includes('title'))&&
  (!a.scopes.includes('crm.tasks.write')||rules.some(r=>r.operation==='Update'&&r.fields.includes('title'))),'AUTONOMOUS_PREVIEW_REGISTRATION_INVALID');
 const kind=m.delegationKind??'DEPARTMENT',parent=m.parentGrantId??null;
 need(kind==='SUBAGENT'?parent&&parent!==a.grantId:kind==='DEPARTMENT'&&parent===null,'AUTONOMOUS_PREVIEW_REGISTRATION_INVALID');if(parent)assertCrmUuid(parent);
 const key=createPublicKey({key:Buffer.from(a.publicKey,'base64url'),format:'der',type:'spki'}),spki=key.export({format:'der',type:'spki'});
 need(key.asymmetricKeyType==='ed25519'&&spki.toString('base64url')===a.publicKey&&a.publicKey.length===59,'AUTONOMOUS_PREVIEW_REGISTRATION_INVALID');
 await connection.query('begin');
 try{
  const reader=(await connection.query("select current_user::text as actor,session_user::text as original,c.relowner=r.oid as owns_task from pg_roles r join pg_class c on c.oid='public.tasks'::regclass where r.rolname=current_user")).rows[0];
  need(reader?.actor===reader?.original&&reader?.owns_task&&!['public','novalure_app','novalure_tenant_app'].includes(String(reader.actor)),'AUTONOMOUS_PREVIEW_OPERATOR_READER_REQUIRED');
  need((await connection.query('select public.crm_autonomous_preview_long_fog() as matches')).rows[0]?.matches===true,'AUTONOMOUS_PREVIEW_TARGET_DENIED');
  const source=(await connection.query("select id from public.tasks where id=$1::uuid and workspace_id=$2::uuid and project_id=$3::uuid and owner_user_id=$4::uuid and title like 'SYNTHETIC:%' and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' and metadata @> $5::jsonb for share",[a.sourceId,CRM_MACHINE_WORKSPACE_ID,a.projectId,a.actorId,JSON.stringify({syntheticTest:true,qaRunId:p.qaRunId,scope:'autonomous-v2-preview-task'})])).rows[0];
  need(source?.id===a.sourceId,'AUTONOMOUS_PREVIEW_OWN_TASK_REQUIRED');
  const owner=(await connection.query("select r.rolname,r.rolsuper,r.rolbypassrls,r.rolcanlogin,count(*)::int as relations from pg_roles r join pg_class c on c.relowner=r.oid where c.oid=any(array['public.crm_autonomous_workloads'::regclass,'public.crm_autonomous_access_grants'::regclass]) group by r.rolname,r.rolsuper,r.rolbypassrls,r.rolcanlogin")).rows[0];
  need(owner?.relations===2&&!owner.rolsuper&&!owner.rolbypassrls&&!owner.rolcanlogin&&/^[a-z_][a-z0-9_]{0,62}$/.test(String(owner.rolname))&&!['public','novalure_app','novalure_tenant_app'].includes(String(owner.rolname)),'AUTONOMOUS_BOOTSTRAP_OWNER_REQUIRED');
  need((await connection.query("select pg_has_role(session_user,$1::name,'SET') as allowed",[owner.rolname])).rows[0]?.allowed===true,'AUTONOMOUS_REGISTRAR_ROLE_UNAVAILABLE');
  await connection.query(`set local role "${owner.rolname}"`);
  const actor=(await connection.query('select current_user::text as actor,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  need(actor?.actor===owner.rolname&&!actor.rolsuper&&!actor.rolbypassrls,'AUTONOMOUS_BOOTSTRAP_OWNER_REQUIRED');
  const instance=`${autonomousPreviewIdentity}:${p.qaRunId.toLowerCase()}:${p.deploymentId}`;
  await connection.query(`insert into public.crm_autonomous_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,authority_reference,
   preview_identity_id,receiver_deployment_id,receiver_revision,receiver_origin,qa_run_id,expires_at)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,'preview',$10,$11,$12,$13,$14,$15,$16) on conflict(id) do nothing`,
  [a.workloadId,instance,CRM_MACHINE_WORKSPACE_ID,a.workloadActorId,CRM_MACHINE_ISSUER,autonomousPreviewAudience,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_OWNER_ID,autonomousPreviewSubject,a.authorityReference,autonomousPreviewIdentity,p.deploymentId,p.revision,p.origin,p.qaRunId,a.expiresAt]);
  const saved=(await connection.query('select * from public.crm_autonomous_workloads where id=$1',[a.workloadId])).rows[0];
  need(saved&&saved.identity_id===instance&&saved.preview_identity_id===autonomousPreviewIdentity&&saved.workspace_id===CRM_MACHINE_WORKSPACE_ID&&saved.actor_user_id===a.workloadActorId&&saved.authority_reference===a.authorityReference&&
   saved.issuer===CRM_MACHINE_ISSUER&&saved.audience===autonomousPreviewAudience&&saved.project_id===CRM_MACHINE_PROJECT_ID&&saved.owner_id===CRM_MACHINE_OWNER_ID&&saved.subject===autonomousPreviewSubject&&saved.environment==='preview'&&saved.custom_environment_id===null&&
   saved.receiver_deployment_id===p.deploymentId&&saved.receiver_revision===p.revision&&saved.receiver_origin===p.origin&&saved.qa_run_id===p.qaRunId.toLowerCase()&&iso(saved.expires_at)===new Date(a.expiresAt).toISOString()&&!saved.disabled&&!saved.kill_switch_active&&!saved.revoked_at,'AUTONOMOUS_WORKLOAD_CONFLICT');
  await connection.query(`insert into public.crm_autonomous_access_grants(id,workload_id,workspace_id,actor_user_id,project_id,source_id,entity,department_id,agent_id,task_id,authority_class,authority_reference,delegation_public_key,scopes,not_before,expires_at,
   contract_version,read_fields,write_fields,related_resources,lifecycle_mode,parent_grant_id,delegation_kind)
   values($1,$2,$3,$4,$5,$6,'Task',$7,$8,$9,'REAL_INTERNAL_OPERATIONS',$10,$11,$12,clock_timestamp(),$13,$14,$15,$16,'{}','EXISTING',$17,$18) on conflict(id) do nothing`,
  [a.grantId,a.workloadId,CRM_MACHINE_WORKSPACE_ID,a.actorId,a.projectId,a.sourceId,a.departmentId,a.agentId,a.taskId,a.authorityReference,a.publicKey,[...a.scopes],a.expiresAt,autonomousModuleContract,[...m.readFields],[...m.writeFields],parent,kind]);
  const g=(await connection.query('select * from public.crm_autonomous_access_grants where id=$1',[a.grantId])).rows[0];
  const expected={workload_id:a.workloadId,workspace_id:CRM_MACHINE_WORKSPACE_ID,actor_user_id:a.actorId,project_id:a.projectId,source_id:a.sourceId,entity:'Task',department_id:a.departmentId,agent_id:a.agentId,task_id:a.taskId,authority_class:'REAL_INTERNAL_OPERATIONS',authority_reference:a.authorityReference,delegation_public_key:a.publicKey,scopes:[...a.scopes],expires_at:new Date(a.expiresAt).toISOString(),contract_version:autonomousModuleContract,read_fields:[...m.readFields],write_fields:[...m.writeFields],related_resources:{},lifecycle_mode:'EXISTING',parent_grant_id:parent,delegation_kind:kind,disabled:false,revoked_at:null};
  const observed=Object.fromEntries(Object.keys(expected).map(k=>[k,k==='expires_at'?iso(g?.[k]):g?.[k]]));
  need(g&&crmPayloadDigest(observed)===crmPayloadDigest(expected),'AUTONOMOUS_GRANT_CONFLICT');
  need((await connection.query('select id from public.crm_lock_autonomous_access_grant($1,$2)',[a.workloadId,a.grantId])).rows[0]?.id===a.grantId,'AUTONOMOUS_SCOPE_NOT_GRANTED');
  await connection.query('commit');
  return Object.freeze({status:'REGISTERED' as const,workloadId:a.workloadId,qaRunId:p.qaRunId,receiver:{origin:p.origin,deploymentId:p.deploymentId,gitSha:p.revision},
   grant:{grantId:a.grantId,workspaceId:CRM_MACHINE_WORKSPACE_ID,projectId:a.projectId,sourceId:a.sourceId,taskId:a.taskId,departmentId:a.departmentId,agentId:a.agentId,entity:'Task' as const,
    publicKeyDigest:createHash('sha256').update(spki).digest('hex'),delegationKind:kind,parentGrantId:parent,operations:['DescribeAssignment','Read',...(a.scopes.includes('crm.tasks.write')?['Update']:[])],readFields:[...m.readFields],writeFields:[...m.writeFields],expiresAt:Math.floor(Date.parse(a.expiresAt)/1000)}});
 }catch(e){await connection.query('rollback');throw e;}
}
