import 'server-only';
import {createHash} from 'node:crypto';
import type {AppSession} from '@/lib/auth/session';
import {assertCrmUuid,CrmCommandError,executeCrmCommand,withCrmRead,type TenantTransaction,type TenantTransactionOptions} from '@/lib/crm-command';
import {saveCompanyBrandFile,discardUncommittedCompanyBrandFile,type MediaAsset} from '@/lib/media-store';
import {validateRasterMediaContent} from '@/lib/media-raster-validation';
import type {WebExposeBrandAsset,WebExposeBrandAssetRecord,WebExposeTemplateConfiguration} from '@/lib/web-expose-templates';
export async function readWebExposeBrandAssets(session:AppSession,options:TenantTransactionOptions={}){return withCrmRead(session,(tx,fresh)=>tx.query<WebExposeBrandAssetRecord>(`select asset_id as "assetId",purpose,title,content_hash as "contentHash",approved,revision from web_expose_brand_assets where workspace_id=$1::uuid order by created_at desc limit 100`,[fresh.workspaceId]),options);}
export async function freezeWebExposeBrandAssets(tx:TenantTransaction,workspaceId:string,configuration:WebExposeTemplateConfiguration):Promise<WebExposeBrandAsset[]>{
 const assets:WebExposeBrandAsset[]=[];
 for(const[purpose,id]of[['logo',configuration.logoAssetId],['letterhead',configuration.letterheadAssetId]] as const){if(!id)continue;const row=await tx.queryOne<WebExposeBrandAsset>(`select asset_id as "assetId",purpose,content_hash as "contentHash" from web_expose_brand_assets where workspace_id=$1::uuid and asset_id=$2::uuid and purpose=$3 and approved and crm_lock_brand_asset(workspace_id,asset_id,purpose,content_hash)`,[workspaceId,id,purpose]);if(!row)throw new CrmCommandError('BRAND_ASSET_REVOKED','Ein Firmenasset ist nicht mehr freigegeben. Bitte Vorlage und Vorschau aktualisieren.',409);assets.push(row);}
 return assets;
}
export async function uploadWebExposeBrandAsset(session:AppSession,input:{file:File;purpose:'logo'|'letterhead';reviewed:boolean},metadata:{idempotencyKey:string;correlationId:string},options:TenantTransactionOptions={}){
 if(!input.reviewed||!['logo','letterhead'].includes(input.purpose)||!['image/png','image/jpeg','image/webp'].includes(input.file.type)||input.file.size<1||input.file.size>4*1024*1024)throw new CrmCommandError('INVALID_ARTWORK','Ein freigegebenes Firmenlogo oder Briefpapier als PNG, JPG oder WebP bis 4 MB ist erforderlich.');
 const bytes=Buffer.from(await input.file.arrayBuffer());if(!(await validateRasterMediaContent(bytes,input.file.type)).ok)throw new CrmCommandError('INVALID_ARTWORK','Die Bilddatei ist beschädigt oder zu groß.');
 const contentHash=createHash('sha256').update(bytes).digest('hex');let uploaded:MediaAsset|null=null;
 try{return await executeCrmCommand(session,{operation:'crm.expose-brand.upload',capability:'settings:manage',payload:{purpose:input.purpose,name:input.file.name,size:input.file.size,mimeType:input.file.type,contentHash,reviewed:true},...metadata},async(tx,context)=>{
  const count=await tx.queryOne<{n:number}>('select count(*)::int as n from web_expose_brand_assets where workspace_id=$1::uuid',[context.workspaceId]);if(Number(count?.n)>=100)throw new CrmCommandError('BRAND_LIMIT','Es sind bereits 100 Firmenassets gespeichert.');
  uploaded=await saveCompanyBrandFile({file:input.file,workspaceId:context.workspaceId,actorId:context.actorId});
  await tx.execute('insert into web_expose_brand_assets(asset_id,workspace_id,purpose,title,content_hash,approved,created_by,updated_by) values($1::uuid,$2::uuid,$3,$4,$5,true,$6::uuid,$6::uuid)',[uploaded.id,context.workspaceId,input.purpose,input.file.name.slice(0,150),contentHash,context.actorId]);return {id:uploaded.id};
 },options);}catch(error){if(uploaded)await withCrmRead(session,()=>discardUncommittedCompanyBrandFile(uploaded!),options).catch(()=>false);throw error;}
}
export async function revokeWebExposeBrandAsset(session:AppSession,id:string,expectedRevision:number,metadata:{idempotencyKey:string;correlationId:string},options:TenantTransactionOptions={}){
 assertCrmUuid(id);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new CrmCommandError('REVISION_REQUIRED','Assetansicht aktualisieren.',409);
 return executeCrmCommand(session,{operation:'crm.expose-brand.revoke',capability:'settings:manage',resourceId:id,payload:{id,expectedRevision},...metadata},async(tx,context)=>{const row=await tx.queryOne('update web_expose_brand_assets set approved=false,revision=revision+1 where workspace_id=$1::uuid and asset_id=$2::uuid and revision=$3 and approved returning asset_id',[context.workspaceId,id,expectedRevision]);if(!row)throw new CrmCommandError('BRAND_CHANGED','Assetfreigabe wurde geändert. Ansicht aktualisieren.',409);return {id};},options);
}
