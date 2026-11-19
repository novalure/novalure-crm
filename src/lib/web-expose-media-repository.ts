import "server-only";
import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { canWritePropertyExpose } from "@/lib/db/property-expose-repositories";
import { discardUncommittedPropertyMarketingFile, findWorkspaceMediaAsset, readMediaAssetContent, savePropertyMarketingFile, type MediaAsset } from "@/lib/media-store";
import { parseWebExposeResourceInput, webExposeResourceMimeTypes, type WebExposeResource, type WebExposeResourceInput, type WebExposeResourceKind } from "@/lib/web-expose-media";
import { validateWebExposeUpload } from "@/lib/web-expose-media-validation";
import { readLimitedMediaBytes } from "@/lib/property-expose-service";
import { validatePropertyExposePdf } from "@/lib/property-expose-pdf-validation";
import { validateRasterMediaContent } from "@/lib/media-raster-validation";

const resourceSelect = `r.id,r.kind,r.asset_id::text as "assetId",r.url,r.title,r.position,r.visibility,r.status,r.revision,a.mime_type as "mimeType",a.size_bytes::integer as "sizeBytes",r.content_hash as "contentHash",r.updated_at::text as "updatedAt"`;
export const webExposeMediaHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
async function scope(tx: TenantTransaction, session: AppSession, propertyId: string, write = false) {
  assertCrmUuid(propertyId);
  const property = await tx.queryOne<{ projectId: string | null }>(`select project_id::text as "projectId" from seller_listings where id=$1::uuid and workspace_id=$2::uuid${write ? " for update" : ""}`, [propertyId, session.workspaceId]);
  if (!property) throw new CrmCommandError("NOT_FOUND", "Immobilie nicht verfügbar", 404);
  if (property.projectId) await assertProjectGrant(tx, session, property.projectId, write);
  if (write && !canWritePropertyExpose(session)) throw new CrmCommandError("FORBIDDEN", "Medien-Schreibrechte fehlen", 403);
  return property;
}
export async function loadWebExposeMedia(tx: TenantTransaction, session: AppSession, propertyId: string) {
  await scope(tx, session, propertyId);
  const resources = await tx.query<WebExposeResource>(`select ${resourceSelect} from web_expose_resources r left join media_assets a on a.id=r.asset_id and a.workspace_id=r.workspace_id::text where r.workspace_id=$1::uuid and r.property_id=$2::uuid and not r.archived order by r.position,r.created_at,r.id`, [session.workspaceId, propertyId]);
  const library = await tx.query<{ assetId: string; title: string; mimeType: string; sizeBytes: number; kind: "image" | "floorplan" | "document" | "video" }>(`select distinct a.id::text as "assetId",a.name as title,a.mime_type as "mimeType",a.size_bytes::integer as "sizeBytes",case when a.mime_type like 'video/%' then 'video' when pm.media_type='floorplan' or d.category='floorplan' then 'floorplan' when a.mime_type='application/pdf' then 'document' else 'image' end as kind
    from media_assets a left join property_media pm on pm.media_asset_id=a.id and pm.workspace_id=$1::uuid and pm.property_id=$2::uuid and pm.unit_id is null and lower(pm.category) not in('proof','internal','contract','funding')
    left join property_documents d on d.media_asset_id=a.id and d.workspace_id=$1::uuid and d.property_id=$2::uuid and d.unit_id is null and d.category in('expose','novalure_expose','floorplan','energy_certificate') and d.status<>'archived'
    where a.workspace_id=$1::text and(a.folder not ilike 'properties/%' or lower(a.folder)='properties/'||$2::text) and(pm.id is not null or d.id is not null) and a.folder not ilike 'lead-proof-private-%' and a.folder not ilike 'knowledge-private-%'
      and a.storage_access='private' and not a.is_public and a.public_token is null and a.mime_type in('image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','video/mp4','video/webm')
      and not exists(select 1 from property_media protected where protected.media_asset_id=a.id and protected.workspace_id=$1::uuid and lower(protected.category) in('proof','internal','contract','funding')) and not exists(select 1 from property_documents blocked where blocked.media_asset_id=a.id and blocked.workspace_id=$1::uuid and blocked.category not in('expose','novalure_expose','floorplan','energy_certificate')) order by title,"assetId" limit 100`, [session.workspaceId, propertyId]);
  const rights = await tx.queryOne<{ allowed: boolean }>(`select crm_web_expose_access($1::uuid,$2::uuid,true) as allowed`, [session.workspaceId, propertyId]);
  return { resources, library, canEdit: canWritePropertyExpose(session) && rights?.allowed === true, directUploadLimitBytes: 4194304 };
}
async function verifiedAsset(tx: TenantTransaction, session: AppSession, propertyId: string, input: WebExposeResourceInput, validatedHash?: string) {
  if (!input.assetId) return null;
  const asset = await findWorkspaceMediaAsset(input.assetId, session.workspaceId);
  if (!asset || asset.storageAccess !== "private" || asset.isPublic || asset.hasActivePublicShare || asset.publicToken || !(webExposeResourceMimeTypes[input.kind] as readonly string[]).includes(asset.mimeType)) throw new CrmCommandError("INVALID_RESOURCE_FILE", "Eine private Marketingdatei des passenden Typs auswählen");
  const belongs = await tx.queryOne<{ allowed: boolean }>(`select(a.folder='properties/'||$2::text or exists(select 1 from property_media pm where pm.workspace_id=$1::uuid and pm.property_id=$2::uuid and pm.media_asset_id=a.id and lower(pm.category) not in('proof','internal','contract','funding')) or exists(select 1 from property_documents d where d.workspace_id=$1::uuid and d.property_id=$2::uuid and d.media_asset_id=a.id and d.category in('expose','novalure_expose','floorplan','energy_certificate') and d.status<>'archived')) and not exists(select 1 from property_media protected where protected.media_asset_id=a.id and protected.workspace_id=$1::uuid and lower(protected.category) in('proof','internal','contract','funding')) and not exists(select 1 from property_documents blocked where blocked.workspace_id=$1::uuid and blocked.media_asset_id=a.id and blocked.category not in('expose','novalure_expose','floorplan','energy_certificate')) as allowed from media_assets a where a.id=$3::uuid and a.workspace_id=$1::text`, [session.workspaceId, propertyId, input.assetId]);
  if (!belongs?.allowed || asset.folder.toLowerCase().startsWith("properties/") && asset.folder.toLowerCase() !== `properties/${propertyId}`) throw new CrmCommandError("PROTECTED_RESOURCE", "Datei gehört nicht zu den Marketingunterlagen dieses Objekts", 403);
  if (validatedHash) return validatedHash;
  const bytes = await readLimitedMediaBytes(asset, 10 * 1024 * 1024);
  if (asset.mimeType === "application/pdf") await validatePropertyExposePdf(bytes);
  else if (asset.mimeType.startsWith("image/")) { const result = await validateRasterMediaContent(Buffer.from(bytes), asset.mimeType); if (!result.ok) throw new CrmCommandError("INVALID_IMAGE", "Bildinhalt konnte nicht bestätigt werden"); }
  else { const file = new File([Uint8Array.from(bytes)], asset.originalName, { type: asset.mimeType }); await validateWebExposeUpload(file, input.kind); }
  return createHash("sha256").update(bytes).digest("hex");
}
export async function saveWebExposeResource(tx: TenantTransaction, session: AppSession, propertyId: string, value: unknown, options: { resourceId?: string; expectedRevision?: number; reviewed?: boolean; validatedHash?: string } = {}) {
  await scope(tx, session, propertyId, true);
  let input: WebExposeResourceInput; try { input = parseWebExposeResourceInput(value); } catch { throw new CrmCommandError("INVALID_RESOURCE", "Ressourcentyp, Titel, Link und Freigabe prüfen"); }
  if (input.status === "approved" && options.reviewed !== true) throw new CrmCommandError("RESOURCE_REVIEW", "Inhalt vor der Freigabe ausdrücklich prüfen", 409);
  const contentHash = await verifiedAsset(tx, session, propertyId, input, options.validatedHash);
  let id: string;
  if (options.resourceId) {
    assertCrmUuid(options.resourceId);
    if (!Number.isSafeInteger(options.expectedRevision) || Number(options.expectedRevision) < 1) throw new CrmCommandError("INVALID_REVISION", "Ressourcenversion fehlt");
    const updated = await tx.queryOne<{ id: string }>(`update web_expose_resources set kind=$4,asset_id=$5::uuid,url=$6,title=$7,position=$8,visibility=$9,status=$10,content_hash=$11,approved_by=case when $10='approved' then $12::uuid else null end,approved_at=case when $10='approved' then now() else null end,revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and property_id=$3::uuid and not archived and revision=$13 returning id`, [options.resourceId, session.workspaceId, propertyId, input.kind, input.assetId, input.url, input.title, input.position, input.visibility, input.status, contentHash, session.userId, options.expectedRevision]);
    if (!updated) throw new CrmCommandError("RESOURCE_CONFLICT", "Datei oder Link wurde geändert. Bitte neu laden.", 409); id = updated.id;
  } else {
    const created = await tx.queryOne<{ id: string }>(`insert into web_expose_resources(workspace_id,property_id,kind,asset_id,url,title,position,visibility,status,content_hash,approved_by,approved_at,created_by) values($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9,$10,case when $9='approved' then $11::uuid else null end,case when $9='approved' then now() else null end,$11::uuid) returning id`, [session.workspaceId, propertyId, input.kind, input.assetId, input.url, input.title, input.position, input.visibility, input.status, contentHash, session.userId]);
    if (!created) throw new CrmCommandError("SAVE_UNCONFIRMED", "Datei oder Link nicht bestätigt", 503); id = created.id;
  }
  const row = await tx.queryOne<WebExposeResource>(`select ${resourceSelect} from web_expose_resources r left join media_assets a on a.id=r.asset_id and a.workspace_id=r.workspace_id::text where r.id=$1::uuid and r.workspace_id=$2::uuid`, [id, session.workspaceId]);
  if (!row) throw new CrmCommandError("SAVE_UNCONFIRMED", "Ressource nicht bestätigt", 503);
  return row;
}
export async function archiveWebExposeResource(tx: TenantTransaction, session: AppSession, propertyId: string, resourceId: string, expectedRevision: number) {
  await scope(tx, session, propertyId, true); assertCrmUuid(resourceId);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new CrmCommandError("INVALID_REVISION", "Ressourcenversion fehlt");
  const row = await tx.queryOne(`update web_expose_resources set archived=true,status='draft',visibility='private',approved_at=null,approved_by=null,revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and property_id=$3::uuid and revision=$4 returning id`, [resourceId, session.workspaceId, propertyId, expectedRevision]);
  if (!row) throw new CrmCommandError("RESOURCE_CONFLICT", "Datei oder Link wurde geändert. Bitte neu laden.", 409);
  return row;
}
export async function getWebExposeResourceFile(tx: TenantTransaction, session: AppSession, propertyId: string, resourceId: string) {
  await scope(tx, session, propertyId); assertCrmUuid(resourceId);
  const resource = await tx.queryOne<{ assetId: string }>(`select asset_id::text as "assetId" from web_expose_resources where id=$1::uuid and workspace_id=$2::uuid and property_id=$3::uuid and not archived and asset_id is not null`, [resourceId, session.workspaceId, propertyId]);
  const asset = resource ? await findWorkspaceMediaAsset(resource.assetId, session.workspaceId) : null;
  if (!asset || asset.storageAccess !== "private" || asset.isPublic || asset.publicToken) throw new CrmCommandError("NOT_FOUND", "Datei nicht verfügbar", 404);
  const content = await readMediaAssetContent(asset); if (!content) throw new CrmCommandError("NOT_FOUND", "Datei nicht verfügbar", 404);
  return { asset, content };
}
export async function uploadWebExposeResource(session: AppSession, input: { propertyId: string; kind: WebExposeResourceKind; title: string; file: File; idempotencyKey: string; correlationId: string }, options?: TenantTransactionOptions) {
  const bytes = await validateWebExposeUpload(input.file, input.kind), contentHash = createHash("sha256").update(bytes).digest("hex");
  let uploaded: MediaAsset | null = null;
  try {
    return await executeCrmCommand(session, { operation: "web_expose.resource_upload", resourceId: input.propertyId, capability: "workspace:operate", idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, payload: { propertyId: input.propertyId, kind: input.kind, title: input.title, contentHash, size: input.file.size, type: input.file.type, name: input.file.name } }, async (tx, context) => {
      await scope(tx, context.session, input.propertyId, true);
      uploaded = await savePropertyMarketingFile({ actorId: context.actorId, workspaceId: context.workspaceId, propertyId: input.propertyId, file: input.file });
      const position = await tx.queryOne<{ next: number }>(`select least(coalesce(max(position),-1)+1,1000)::int as next from web_expose_resources where workspace_id=$1::uuid and property_id=$2::uuid and not archived`, [context.workspaceId, input.propertyId]);
      return saveWebExposeResource(tx, context.session, input.propertyId, { kind: input.kind, assetId: uploaded.id, url: null, title: input.title || input.file.name, position: position?.next ?? 0, visibility: "private", status: "draft" }, { validatedHash: contentHash });
    }, options);
  } catch (error) { if (uploaded) await withCrmRead(session, () => discardUncommittedPropertyMarketingFile(uploaded!), options).catch(() => false); throw error; }
}
