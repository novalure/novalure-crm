import 'server-only';
import {createHash} from 'node:crypto';
import {lstat,readFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import {del,get} from '@vercel/blob';
import {getPrivateMediaBlobToken,mediaAssetPath} from './media-store';
import {CrmCommandError,type TenantTransaction} from './crm-command';
import {currentTenantTransaction} from './db/transaction-context';
import {hasCompleteMediaReferenceVisibility} from './media-lifecycle';

const references=`select n.nspname as schema_name,t.relname as table_name,
 to_regclass('public.knowledge_source_versions') is not null as knowledge_center_enabled,to_regclass('public.lead_qualification_proofs') is not null as lead_proof_enabled,to_regclass('public.web_expose_resources') is not null as web_resources_enabled,
 c.convalidated as validated,c.condeferrable as deferrable,c.confdeltype as delete_action,
 array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum,position) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum order by k.position) as columns,
 array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum,position) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum order by k.position) as target_columns
 from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where c.contype='f' and c.confrelid='public.media_assets'::regclass`;
export type ProofRetentionTarget={jobId:string;workspaceId:string;leadId:string;assetId:string;provider:'local'|'vercel-blob';pathname:string;hash:string;size:number;mime:string};
/** Only called while the exact proof, asset, policy and durable job are locked. */
export async function deleteExpiredFinancialProofFile(tx:TenantTransaction,target:ProofRetentionTarget){
 const active=currentTenantTransaction();
 const prefix=`${target.workspaceId}/lead-proof-private-${target.leadId}/`;
 if(active?.transaction!==tx||active.scope.workspaceId!==target.workspaceId||!target.pathname.startsWith(prefix)||target.pathname!==path.posix.normalize(target.pathname)||target.pathname.includes('\\')||target.pathname.includes('\0')||!/^\.[a-z]+$/.test(path.posix.extname(target.pathname))||!['.pdf','.jpg','.jpeg','.png'].includes(path.posix.extname(target.pathname).toLowerCase())||target.size<1||target.size>4194304||!/^[a-f0-9]{64}$/.test(target.hash))throw new CrmCommandError('PROOF_RETENTION_TARGET_INVALID','Privater Löschbezug ist ungültig.',409);
 // Storage cannot be used as a general private-file delete: a saved purpose-
 // specific intent and its still-current policy/source must match every field.
 const intent=await tx.queryOne(`select j.id from lead_proof_retention_jobs j join lead_qualification_proofs p on p.id=j.proof_id and p.workspace_id=j.workspace_id join lead_proof_retention_policies r on r.id=j.policy_id and r.workspace_id=j.workspace_id join media_assets m on m.id=p.media_asset_id and m.workspace_id=p.workspace_id::text
  where j.id=$1::uuid and j.workspace_id=$2::uuid and j.lead_id=$3::uuid and p.lead_id=j.lead_id and p.project_id=j.project_id and r.project_id=j.project_id and j.status='queued' and r.enabled and p.kind in('financing_confirmation','funds_evidence') and p.usable_until+make_interval(days=>r.grace_days)<=clock_timestamp()
  and j.asset_id=$4::uuid and m.id=j.asset_id and j.storage_provider=$5 and m.storage_provider=j.storage_provider and j.relative_path=$6 and m.relative_path=j.relative_path and j.content_hash=$7 and p.content_hash=j.content_hash and m.size_bytes=$8 and m.mime_type=$9
  and crm_lead_qualification_access(p.workspace_id,p.project_id,p.lead_id,true) and not exists(select 1 from lead_proof_retention_holds h where h.workspace_id=p.workspace_id and h.proof_id=p.id and h.active)`,[target.jobId,target.workspaceId,target.leadId,target.assetId,target.provider,target.pathname,target.hash,target.size,target.mime]);
 if(!intent)throw new CrmCommandError('PROOF_RETENTION_TARGET_INVALID','Der dauerhafte Löschauftrag ist nicht für diese Datei freigegeben.',409);
 await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`,[`lead-proof-path:${target.provider}:${target.pathname}`]);
 if(!hasCompleteMediaReferenceVisibility(await tx.query(references)))throw new CrmCommandError('PROOF_RETENTION_REFERENCES_UNCONFIRMED','Dateiverweise sind nicht vollständig prüfbar. Die Datei wurde nicht gelöscht.',409);
 if(!(await tx.queryOne<{safe:boolean}>(`select crm_lead_proof_retention_file_safe($1::uuid,$2::uuid,$3::uuid) as safe`,[target.assetId,target.workspaceId,target.leadId]))?.safe)throw new CrmCommandError('PROOF_RETENTION_OTHER_USE','Datei hat eine andere Nutzung. Sie wurde nicht gelöscht.',409);
 let bytes:Uint8Array|null=null;
 if(target.provider==='local'){
  if(process.env.VERCEL!==undefined)throw new CrmCommandError('PROOF_RETENTION_STORAGE_UNAVAILABLE','Die private Dateiablage ist nicht verfügbar.',503);
  const file=mediaAssetPath({workspaceId:target.workspaceId,relativePath:target.pathname});
  try{const details=await lstat(file);if(!details.isFile()||details.isSymbolicLink()||details.size!==target.size)throw new Error('Changed private file');
   const root=await realpath(path.resolve(process.env.NOVALURE_MEDIA_ROOT||path.join(process.cwd(),'.data','media'),'uploads')),parent=await realpath(path.dirname(file));if(!parent.startsWith(root+path.sep))throw new Error('Changed private path');bytes=await readFile(file);
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return;throw new CrmCommandError('PROOF_RETENTION_FILE_CHANGED','Die private Datei kann nicht sicher zugeordnet werden.',409);}
  if(createHash('sha256').update(bytes).digest('hex')!==target.hash)throw new CrmCommandError('PROOF_RETENTION_FILE_CHANGED','Dateiinhalt stimmt nicht mit dem gespeicherten Nachweis überein.',409);
  await rm(file,{force:true});
 }else{
  const token=getPrivateMediaBlobToken();if(!token)throw new CrmCommandError('PROOF_RETENTION_STORAGE_UNAVAILABLE','Die private Dateiablage ist nicht verfügbar.',503);
  const signal=AbortSignal.timeout(15000),file=await get(target.pathname,{access:'private',token,useCache:false,abortSignal:signal});
  if(!file)return;
  if(file.statusCode!==200||file.blob.size!==target.size)throw new CrmCommandError('PROOF_RETENTION_FILE_CHANGED','Die private Datei kann nicht sicher zugeordnet werden.',409);bytes=new Uint8Array(await new Response(file.stream).arrayBuffer());if(bytes.length!==target.size||createHash('sha256').update(bytes).digest('hex')!==target.hash)throw new CrmCommandError('PROOF_RETENTION_FILE_CHANGED','Dateiinhalt wurde geändert.',409);
  await del(target.pathname,{token,abortSignal:signal,ifMatch:file.blob.etag});
 }
}
