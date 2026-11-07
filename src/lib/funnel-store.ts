import 'server-only';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {AppSession} from '@/lib/auth/session';
import {assertCrmUuid,assertProjectGrant,CrmCommandError,withCrmRead,type TenantTransactionOptions} from '@/lib/crm-command';
import {queryOne} from '@/lib/db/client';
import {getRolePermissions,isAppRole} from '@/lib/auth/permissions';
import {getProductRoleCapabilities,isProductRole,hasProductCapability} from '@/lib/product-model';
import {buildFunnelBlueprint,type FunnelDraft} from '@/lib/funnel-builder-adapter';
import {funnelPublicationBlockerText} from '@/lib/funnel-publication';
import type {FunnelBlueprint,FunnelVersion} from '@/lib/funnel-schema';
import {parseFunnelBlueprint,runFunnelPreflight} from '@/lib/funnel-validation';
export type StoredFunnel={blueprint:FunnelBlueprint;funnelId:string;ownerUserId:string;projectId:string;source:'database';status:string;tracking:Record<string,unknown>;versions:FunnelVersion[];updatedAt:string;workspaceId:string;workspaceName:string};
type Row={id:string;workspaceId:string;workspaceName:string;ownerUserId:string;projectId:string;status:string;name:string;goal:string;audience:string;entryChannel:string;blueprint:unknown;tracking:Record<string,unknown>;updatedAt:Date|string};
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
function stored(row:Row):StoredFunnel{const envelope=row.blueprint as {blueprint?:unknown;funnel?:FunnelDraft;steps?:Parameters<typeof buildFunnelBlueprint>[0]['steps'];versions?:FunnelVersion[]};const value=envelope?.funnel?buildFunnelBlueprint({funnel:{...envelope.funnel,id:row.id,workspaceId:row.workspaceId,projectId:row.projectId,name:row.name,goal:row.goal,audience:row.audience as FunnelDraft['audience'],entryChannel:row.entryChannel as FunnelDraft['entryChannel'],status:row.status as FunnelDraft['status']},steps:envelope.steps??[]}):envelope?.blueprint??row.blueprint;return {blueprint:parseFunnelBlueprint(value),funnelId:row.id,ownerUserId:row.ownerUserId,projectId:row.projectId,source:'database',status:row.status,tracking:row.tracking??{},versions:Array.isArray(envelope?.versions)?envelope.versions:[],updatedAt:new Date(row.updatedAt).toISOString(),workspaceId:row.workspaceId,workspaceName:row.workspaceName};}
const columns=`f.id,f.workspace_id as "workspaceId",w.name as "workspaceName",f.owner_user_id as "ownerUserId",f.project_id as "projectId",f.status,f.name,f.goal,f.audience,f.entry_channel as "entryChannel",f.blueprint,f.tracking,f.updated_at as "updatedAt"`;
async function find(funnelId:string,workspaceId:string,lock=false){return queryOne<Row>(`select ${columns} from funnels f join workspaces w on w.id=f.workspace_id where f.workspace_id=$1::uuid and (f.id::text=$2 or f.tracking->>'legacyId'=$2) order by f.updated_at desc limit 1${lock?' for update of f':''}`,[workspaceId,funnelId]);}
/** Designer and restore use a current authenticated tenant transaction; no shared local file. */
export async function getStoredFunnel(funnelId:string,session:AppSession,options:TenantTransactionOptions={}){return withCrmRead(session,async(tx,fresh)=>{const row=await find(funnelId,fresh.workspaceId);if(!row)return null;await assertProjectGrant(tx,fresh,row.projectId);return stored(row);},options);}
export async function saveStoredFunnel(input:FunnelBlueprint,label='Designer-Speicherung',session:AppSession,options:TenantTransactionOptions&{unpublish?:boolean}={}){
 const blueprint=parseFunnelBlueprint(input);
 return withCrmRead(session,async(tx,fresh)=>{
  if(!fresh.permissions.includes('funnels:write')||!hasProductCapability(fresh.productRole,'funnels:publish'))throw new CrmCommandError('FORBIDDEN','Funnel-Bearbeitung ist nicht freigegeben.',403);
  if(blueprint.workspaceId!==fresh.workspaceId)throw new CrmCommandError('TENANT_MISMATCH','Der Funnel gehört zu einem anderen Workspace.',403);
  const projectId=assertCrmUuid(blueprint.projectId,'projectId');await assertProjectGrant(tx,fresh,projectId,true);
  const row=await find(blueprint.id,fresh.workspaceId,true),old=row?stored(row):null;
  if(row&&row.projectId!==projectId)throw new CrmCommandError('PROJECT_MISMATCH','Ein bestehender Funnel kann nicht in ein anderes Projekt verschoben werden.',409);
  const id=row?.id??assertCrmUuid(blueprint.id,'funnelId'),now=new Date().toISOString();
  const version:FunnelVersion={id:randomUUID(),label:label.trim().slice(0,160)||'Designer-Speicherung',createdAt:now,blueprint};
  const versions=[version,...(old?.versions??[])].slice(0,25);
  const tracking:Record<string,unknown>={...(row?.tracking??{}),consentMode:blueprint.tracking.consentMode,legacyId:blueprint.id!==id?blueprint.id:undefined};
  if(blueprint.status==='aktiv'){
   const preflight=runFunnelPreflight(blueprint);if(!preflight.ok)throw new CrmCommandError('PUBLISH_BLOCKED',preflight.blockers.map(code=>funnelPublicationBlockerText(code,'de')).join(' '),409);
   const token=randomBytes(32).toString('base64url');tracking.publicToken=token;tracking.publishToken=token;
   tracking.livePublication={schemaVersion:1,tokenHash:hash(token),versionId:version.id,publishedAt:now,blueprint};
  }else if(options.unpublish){delete tracking.livePublication;delete tracking.publicToken;delete tracking.publishToken;}
  const storedStatus=tracking.livePublication?'aktiv':blueprint.status;
  const envelope={blueprint,versions,schemaVersion:1,updatedAt:now,updatedByUserId:fresh.userId};
  const params=[id,fresh.workspaceId,projectId,fresh.userId,blueprint.name,blueprint.goal,blueprint.audience,blueprint.entryChannel,storedStatus,JSON.stringify(envelope),JSON.stringify(tracking)];
  await tx.execute(row?`update funnels set owner_user_id=$4::uuid,name=$5,goal=$6,audience=$7,entry_channel=$8,status=$9,blueprint=$10::jsonb,tracking=$11::jsonb,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and project_id=$3::uuid`:`insert into funnels(id,workspace_id,project_id,owner_user_id,name,goal,audience,entry_channel,status,blueprint,tracking) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,params);
  await tx.execute(`insert into audit_logs(workspace_id,actor_user_id,project_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3::uuid,'funnel.designer.saved','funnel',$4::uuid,$5::jsonb)`,[fresh.workspaceId,fresh.userId,projectId,id,JSON.stringify({versionId:version.id,published:blueprint.status==='aktiv'})]);
  return stored((await find(id,fresh.workspaceId))!);
 },options);
}
export async function restoreStoredFunnelVersion(funnelId:string,versionId:string,session:AppSession,options:TenantTransactionOptions={}){return withCrmRead(session,async(_tx,fresh)=>{const row=await getStoredFunnel(funnelId,fresh),version=row?.versions.find(item=>item.id===versionId);if(!row||!version)return null;return saveStoredFunnel({...version.blueprint,status:'entwurf'},`Restore ${version.label}`,fresh,{unpublish:true});},options);}
type PublicPublication={funnelId:string;workspaceId:string;projectId:string;ownerUserId:string;workspaceName:string;role:string;productRole:string;blueprint:unknown;versionId:string};
export async function getPublishedFunnel(funnelId:string,token:string){
 if(!/^[A-Za-z0-9_-]{40,100}$/.test(token))return null;
 const row=await queryOne<{data:PublicPublication|null}>('select crm_funnel_live_lookup($1,$2) as data',[funnelId,hash(token)]),data=row?.data;
 if(!data||!isAppRole(data.role)||!isProductRole(data.productRole))return null;
 const blueprint=parseFunnelBlueprint(data.blueprint);if(blueprint.workspaceId!==data.workspaceId||blueprint.projectId!==data.projectId||blueprint.status!=='aktiv')return null;
 const session:AppSession={authenticated:true,source:'database',workspaceId:data.workspaceId,workspaceName:data.workspaceName,userId:data.ownerUserId,name:'Public Funnel Runtime',email:'public-funnel@example.invalid',role:data.role,productRole:data.productRole,permissions:getRolePermissions(data.role),productPermissions:getProductRoleCapabilities(data.productRole)};
 return {blueprint,funnelId:data.funnelId,versionId:data.versionId,session};
}
/** Public clients receive no provider credentials or internal handover instructions. */
export function publicFunnelBlueprint(input:FunnelBlueprint):FunnelBlueprint{return {...input,tracking:{consentMode:input.tracking.consentMode},crmHandover:{...input.crmHandover,notificationRecipients:'',qualityRule:'',followUp:''},mediaLibrary:[]};}
