import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { discardUncommittedKnowledgeFile, saveKnowledgeFile, type MediaAsset } from "../media-store";
import { extractKnowledgeDocument } from "./document-extraction";
import type { AppSession } from "../auth/session";
import { assertProjectGrant, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { KnowledgeCenterError, knowledgeId, knowledgePermissions, knowledgeRevision, knowledgeStructured, knowledgeText, knowledgeUrl, requireKnowledgePermission } from "./policy";
import type { AssignKnowledgeAreasInput, CreateKnowledgeAreaInput, CreateKnowledgeSourceInput, KnowledgeArea, KnowledgeCenterSnapshot, KnowledgeChannel, KnowledgeDocument, KnowledgeDocumentFormat, KnowledgeDocumentProcessingStatus, KnowledgeEntitlement, KnowledgeQueryResult, KnowledgeSource, KnowledgeSourceType, KnowledgeUsage, KnowledgeVersion, QueryKnowledgeCenterInput, UpdateKnowledgeSourceInput } from "./types";

export { KnowledgeCenterError } from "./policy";
const channels: readonly string[] = ["webchat", "whatsapp", "instagram", "messenger", "email", "internal", "voice", "telephone"];
const sourceTypes: readonly string[] = ["manual", "faq", "structured", "url", "file"];
const allowedDocumentTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain", "text/csv", "text/markdown", "application/json", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
function fail(code: string, message: string, status = 400): never { throw new KnowledgeCenterError(code, message, status); }
function channel(value: unknown): KnowledgeChannel { if (typeof value !== "string" || !channels.includes(value)) fail("VALIDATION_ERROR", "An explicit valid channel is required"); return value as KnowledgeChannel; }
async function lock(tx: TenantTransaction, session: AppSession) {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`knowledge-center:${session.workspaceId}`]);
}
async function entitlement(tx: TenantTransaction, session: AppSession): Promise<KnowledgeEntitlement> {
  const row = await tx.queryOne<KnowledgeEntitlement>(`select e.enabled and coalesce(m.enabled,true) as enabled,e.max_sources as "maxSources",e.max_storage_bytes::float8 as "maxStorageBytes",e.max_queries_per_month as "maxQueriesPerMonth",e.contract_reference as "contractReference",e.features,e.limits from knowledge_center_entitlements e left join workspace_module_settings m on m.workspace_id=e.workspace_id and m.module_key='knowledge' where e.workspace_id=$1::uuid`, [session.workspaceId]);
  return row ?? { enabled: false, maxSources: 0, maxStorageBytes: 0, maxQueriesPerMonth: 0, contractReference: null, features: { websiteImport: false, monitoring: false, advancedMaintenance: false }, limits: { maxAreas: 0, maxWebsites: 0, maxScansPerMonth: 0, maxUsers: 0, maxAssistants: 0 } };
}
async function enabled(tx: TenantTransaction, session: AppSession) {
  const contract = await entitlement(tx, session);
  if (!contract.enabled || !contract.contractReference?.trim()) fail("ENTITLEMENT_REQUIRED", "Knowledge Center requires an active trusted contract", 403);
  return contract;
}
async function usage(tx: TenantTransaction, session: AppSession): Promise<KnowledgeUsage> {
  const row = await tx.queryOne<KnowledgeUsage>(`select sources,storage_bytes::float8 as "storageBytes",queries_this_month as "queriesThisMonth" from knowledge_center_usage($1::uuid)`, [session.workspaceId]);
  return row ?? { sources: 0, storageBytes: 0, queriesThisMonth: 0 };
}
async function audit(tx: TenantTransaction, session: AppSession, action: string, entityId: string, details: Record<string, unknown> = {}) {
  await tx.execute(`insert into audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3,'knowledge_center',$4::uuid,$5::jsonb)`, [session.workspaceId, session.userId, action, entityId, JSON.stringify(details)]);
}
async function area(tx: TenantTransaction, session: AppSession, areaId: string, write = false) {
  const row = await tx.queryOne<KnowledgeArea>(`select id,name,kind,project_id as "projectId",description,archived_at::text as "archivedAt" from knowledge_areas where id=$1::uuid and workspace_id=$2::uuid and archived_at is null`, [knowledgeId(areaId, "areaId"), session.workspaceId]);
  if (!row) fail("NOT_FOUND", "Knowledge area is unavailable", 404);
  if (row.projectId) await assertProjectGrant(tx, session, row.projectId, write);
  return row;
}
const versionJson = `jsonb_build_object('id',v.id,'sourceId',v.source_id,'version',v.version,'name',v.name,'content',v.content,'structuredData',v.structured_data,'url',v.source_url,'mediaAssetId',v.media_asset_id,'status',v.status,'createdAt',v.created_at,'approvedAt',v.approved_at,'processingStatus',coalesce(to_jsonb(v)->>'processing_status',case when v.media_asset_id is null then 'manual' else 'needs_ocr' end),'processingMessage',to_jsonb(v)->>'processing_message','processingFormat',to_jsonb(v)->>'processing_format')`;
async function source(tx: TenantTransaction, session: AppSession, sourceId: string, write = false): Promise<KnowledgeSource> {
  const canWrite = knowledgePermissions(session).canWrite;
  const row = await tx.queryOne<KnowledgeSource>(`select s.id,s.knowledge_area_id as "areaId",s.project_id as "projectId",v.name,s.source_type as type,
   case when $3::boolean then s.status else 'approved' end as status,s.kc_revision as revision,s.approved_version_id as "approvedVersionId",
   case when $3::boolean then s.draft_version_id else null end as "draftVersionId",s.archived_at::text as "archivedAt",${versionJson} as version
   from knowledge_sources s join knowledge_areas a on a.id=s.knowledge_area_id and a.workspace_id=s.workspace_id
   join knowledge_source_versions v on v.id=case when $3::boolean then coalesce(s.draft_version_id,s.approved_version_id) else s.approved_version_id end and v.source_id=s.id and v.workspace_id=s.workspace_id and ($3::boolean or v.status='approved')
   where s.id=$1::uuid and s.workspace_id=$2::uuid and s.archived_at is null and a.archived_at is null`, [knowledgeId(sourceId, "sourceId"), session.workspaceId, canWrite]);
  if (!row) fail("NOT_FOUND", "Knowledge source is unavailable", 404);
  if (row.projectId) await assertProjectGrant(tx, session, row.projectId, write);
  return row;
}
async function bot(tx: TenantTransaction, session: AppSession, botId: string, write: boolean) {
  const row = await tx.queryOne<{ id: string; projectId: string | null }>(`select id,project_id as "projectId" from bots where id=$1::uuid and workspace_id=$2::uuid`, [knowledgeId(botId, "botId"), session.workspaceId]);
  if (!row) fail("NOT_FOUND", "Bot is unavailable", 404);
  if (row.projectId) await assertProjectGrant(tx, session, row.projectId, write);
  return row;
}
async function content(tx: TenantTransaction, session: AppSession, type: KnowledgeSourceType, input: { name: string; content?: string; structuredData?: Record<string, unknown>; url?: string | null; mediaAssetId?: string | null }, sourceId?: string) {
  const name = knowledgeText(input.name, "name", 200);
  const structuredData = knowledgeStructured(input.structuredData);
  const text = knowledgeText(input.content ?? "", "content", 150_000, false);
  const url = knowledgeUrl(input.url);
  const mediaAssetId = input.mediaAssetId ? knowledgeId(input.mediaAssetId, "mediaAssetId") : null;
  let documentSizeBytes = 0;
  if (type === "url" && !url) fail("VALIDATION_ERROR", "A URL source requires a URL");
  if (type === "file" && !mediaAssetId) fail("VALIDATION_ERROR", "A file source requires a private document");
  if (type !== "file" && mediaAssetId) fail("VALIDATION_ERROR", "Documents require a file source");
  if (["manual", "faq"].includes(type) && !text) fail("VALIDATION_ERROR", "Source content is required");
  if (type === "structured" && !Object.keys(structuredData).length) fail("VALIDATION_ERROR", "Structured content is required");
  if (mediaAssetId) {
    const asset = await tx.queryOne<{ sizeBytes: number; mimeType: string }>(`select size_bytes::float8 as "sizeBytes",mime_type as "mimeType" from media_assets m where id=$1::uuid and workspace_id=$2 and storage_access='private' and is_public=false and public_token is null
      and (folder=$3 or ($4::uuid is not null and exists(select 1 from knowledge_source_versions v where v.source_id=$4::uuid and v.workspace_id=$2::uuid and v.media_asset_id=m.id)))
      and not exists(select 1 from media_asset_shares sh where sh.asset_id=m.id and sh.workspace_id=$2)`, [mediaAssetId, session.workspaceId, `knowledge-private-${session.userId}`, sourceId ?? null]);
    if (!asset || !allowedDocumentTypes.has(asset.mimeType) || asset.sizeBytes <= 0 || asset.sizeBytes > 10 * 1024 * 1024) fail("DOCUMENT_UNAVAILABLE", "A supported private document up to 10 MB is required", 400);
    documentSizeBytes = asset.sizeBytes;
  }
  return { name, content: text, structuredData, url, mediaAssetId, documentSizeBytes };
}
type DocumentProcessing = { status: KnowledgeDocumentProcessingStatus; message: string | null; format: KnowledgeDocumentFormat | null; code?: string | null; hash?: string | null; importKey?: string | null };
async function insertVersion(tx: TenantTransaction, session: AppSession, sourceId: string, version: number, data: Awaited<ReturnType<typeof content>>, processing?: DocumentProcessing) {
  const id = randomUUID();
  // Processing evidence is an immutable part of the version. API content inputs
  // never accept these fields; a new attachment cannot claim an old result.
  if (processing) {
    await tx.execute(`insert into knowledge_source_versions(id,workspace_id,source_id,version,name,content,structured_data,source_url,media_asset_id,document_size_bytes,created_by,processing_status,processing_message,processing_format,processing_error_code,document_sha256,document_import_key) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9::uuid,$10,$11::uuid,$12,$13,$14,$15,$16,$17)`, [id, session.workspaceId, sourceId, version, data.name, data.content, JSON.stringify(data.structuredData), data.url, data.mediaAssetId, data.documentSizeBytes, session.userId, processing.status, processing.message, processing.format, processing.code ?? null, processing.hash ?? null, processing.importKey ?? null]);
  } else {
    await tx.execute(`insert into knowledge_source_versions(id,workspace_id,source_id,version,name,content,structured_data,source_url,media_asset_id,document_size_bytes,created_by) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9::uuid,$10,$11::uuid)`, [id, session.workspaceId, sourceId, version, data.name, data.content, JSON.stringify(data.structuredData), data.url, data.mediaAssetId, data.documentSizeBytes, session.userId]);
  }
  return id;
}
async function checkStorage(tx: TenantTransaction, session: AppSession, contract: KnowledgeEntitlement) {
  const current = await usage(tx, session);
  if (current.sources > contract.maxSources || current.storageBytes > contract.maxStorageBytes) fail("LIMIT_EXCEEDED", "Knowledge source or storage limit reached", 409);
}

export async function loadKnowledgeCenter(session: AppSession, options: TenantTransactionOptions = {}): Promise<KnowledgeCenterSnapshot> {
  return withCrmRead(session, async (tx, fresh) => {
    const contract = await entitlement(tx, fresh);
    const permissions = knowledgePermissions(fresh);
    const workspace = { id: fresh.workspaceId, name: fresh.workspaceName };
    if (!contract.enabled || !contract.contractReference?.trim()) return { workspace, available: false, areas: [], sources: [], projects: [], bots: [], assignments: [], entitlement: contract, usage: { sources: 0, storageBytes: 0, queriesThisMonth: 0 }, permissions };
    const areas = await tx.query<KnowledgeArea>(`select id,name,kind,project_id as "projectId",description,archived_at::text as "archivedAt" from knowledge_areas where workspace_id=$1::uuid and archived_at is null and (project_id is null or crm_project_access(workspace_id,project_id,false)) order by kind,name`, [fresh.workspaceId]);
    const ids = await tx.query<{ id: string }>(`select s.id from knowledge_sources s join knowledge_areas a on a.id=s.knowledge_area_id and a.workspace_id=s.workspace_id where s.workspace_id=$1::uuid and s.archived_at is null and a.archived_at is null and ($2::boolean or s.approved_version_id is not null) order by s.updated_at desc limit 500`, [fresh.workspaceId, permissions.canWrite]);
    const sources: KnowledgeSource[] = [];
    for (const row of ids) sources.push(await source(tx, fresh, row.id));
    const projects = await tx.query<{ id: string; name: string }>(`select id,name from projects where workspace_id=$1::uuid and crm_project_access(workspace_id,id,false) order by name`, [fresh.workspaceId]);
    const bots = await tx.query<{ id: string; name: string; projectId: string | null }>(`select id,name,project_id as "projectId" from bots where workspace_id=$1::uuid and (project_id is null or crm_project_access(workspace_id,project_id,false)) order by name`, [fresh.workspaceId]);
    const assignments = await tx.query<{ botId: string; channel: KnowledgeChannel; areaId: string }>(`select g.bot_id as "botId",g.channel,g.area_id as "areaId" from knowledge_area_grants g join knowledge_areas a on a.id=g.area_id and a.workspace_id=g.workspace_id join bots b on b.id=g.bot_id and b.workspace_id=g.workspace_id where g.workspace_id=$1::uuid and a.archived_at is null and (b.project_id is null or crm_project_access(b.workspace_id,b.project_id,false))`, [fresh.workspaceId]);
    return { workspace, available: true, areas, sources, projects, bots, assignments, entitlement: contract, usage: await usage(tx, fresh), permissions };
  }, options);
}
export async function createKnowledgeArea(session: AppSession, input: CreateKnowledgeAreaInput, options: TenantTransactionOptions = {}) {
  const name = knowledgeText(input.name, "name", 160);
  const description = knowledgeText(input.description ?? "", "description", 2000, false);
  if (!["company", "business", "project"].includes(input.kind)) fail("VALIDATION_ERROR", "Invalid area kind");
  const projectId = input.projectId ? knowledgeId(input.projectId, "projectId") : null;
  if ((input.kind === "project") !== Boolean(projectId)) fail("VALIDATION_ERROR", "Only project areas require a project");
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh);
    const totals = await tx.queryOne<{ areas: number }>(`select areas from knowledge_center_usage($1::uuid)`, [fresh.workspaceId]);
    if (!Number.isSafeInteger(contract.limits?.maxAreas) || (totals?.areas ?? 0) >= contract.limits.maxAreas) fail("LIMIT_EXCEEDED", "Knowledge area limit reached", 409);
    if (projectId) await assertProjectGrant(tx, fresh, projectId, true);
    const id = randomUUID();
    await tx.execute(`insert into knowledge_areas(id,workspace_id,name,kind,project_id,description) values($1::uuid,$2::uuid,$3,$4,$5::uuid,$6)`, [id, fresh.workspaceId, name, input.kind, projectId, description]);
    await audit(tx, fresh, "knowledge.area.created", id, { kind: input.kind, projectId });
    return area(tx, fresh, id);
  }, options);
}
export async function createKnowledgeSource(session: AppSession, input: CreateKnowledgeSourceInput, options: TenantTransactionOptions = {}) {
  if (!sourceTypes.includes(input.type)) fail("VALIDATION_ERROR", "Invalid source type");
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh);
    if (input.type === "url") {
      const totals = await tx.queryOne<{ websites: number }>(`select websites from knowledge_center_usage($1::uuid)`, [fresh.workspaceId]);
      if (!Number.isSafeInteger(contract.limits?.maxWebsites) || (totals?.websites ?? 0) >= contract.limits.maxWebsites) fail("LIMIT_EXCEEDED", "Website source limit reached", 409);
    }
    const target = await area(tx, fresh, input.areaId, true);
    const data = await content(tx, fresh, input.type, input); const id = randomUUID();
    await tx.execute(`insert into knowledge_sources(id,workspace_id,project_id,knowledge_area_id,name,source_type,status,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,'needs-review','{"knowledgeCenter":true,"trust":"untrusted_source_data"}'::jsonb)`, [id, fresh.workspaceId, target.projectId, target.id, data.name, input.type]);
    const versionId = await insertVersion(tx, fresh, id, 1, data);
    await tx.execute(`update knowledge_sources set draft_version_id=$1::uuid where id=$2::uuid and workspace_id=$3::uuid`, [versionId, id, fresh.workspaceId]);
    await checkStorage(tx, fresh, contract); await audit(tx, fresh, "knowledge.source.created", id, { versionId, areaId: target.id, sourceType: input.type });
    return source(tx, fresh, id);
  }, options);
}
export async function updateKnowledgeSource(session: AppSession, input: UpdateKnowledgeSourceInput, options: TenantTransactionOptions = {}) {
  const expected = knowledgeRevision(input.expectedVersion);
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh);
    const previous = await source(tx, fresh, input.sourceId, true);
    if (previous.revision !== expected) fail("VERSION_CONFLICT", "Knowledge source changed; reload before editing", 409);
    const old = previous.version!;
    const data = await content(tx, fresh, previous.type, { name: input.name ?? old.name, content: input.content ?? old.content, structuredData: input.structuredData ?? old.structuredData, url: input.url === undefined ? old.url : input.url, mediaAssetId: input.mediaAssetId === undefined ? old.mediaAssetId : input.mediaAssetId }, previous.id);
    const evidence = previous.type === "file" && data.mediaAssetId === old.mediaAssetId
      ? await tx.queryOne<{ hash: string | null; code: string | null }>(`select to_jsonb(v)->>'document_sha256' as hash,to_jsonb(v)->>'processing_error_code' as code from knowledge_source_versions v where id=$1::uuid and workspace_id=$2::uuid`, [old.id, fresh.workspaceId]) : null;
    const processing = previous.type === "file" ? { status: data.mediaAssetId === old.mediaAssetId ? old.processingStatus : "needs_ocr" as const, message: data.mediaAssetId === old.mediaAssetId ? old.processingMessage : "Dieses Dokument muss über den Dateiimport verarbeitet werden.", format: data.mediaAssetId === old.mediaAssetId ? old.processingFormat : null, hash: evidence?.hash, code: evidence?.code } : undefined;
    const versionId = await insertVersion(tx, fresh, previous.id, old.version + 1, data, processing);
    await tx.execute(`update knowledge_sources set draft_version_id=$1::uuid,kc_revision=kc_revision+1,status='needs-review',updated_at=now() where id=$2::uuid and workspace_id=$3::uuid and kc_revision=$4`, [versionId, previous.id, fresh.workspaceId, expected]);
    await checkStorage(tx, fresh, contract); await audit(tx, fresh, "knowledge.source.draft_created", previous.id, { versionId, previousRevision: expected });
    return source(tx, fresh, previous.id);
  }, options);
}
export async function archiveKnowledgeSource(session: AppSession, input: { sourceId: string; expectedVersion: number }, options: TenantTransactionOptions = {}) {
  const expected = knowledgeRevision(input.expectedVersion);
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); await enabled(tx, fresh);
    const row = await source(tx, fresh, input.sourceId, true);
    if (row.revision !== expected) fail("VERSION_CONFLICT", "Knowledge source changed; reload before archiving", 409);
    await tx.execute(`update knowledge_sources set archived_at=now(),status='archived',kc_revision=kc_revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and kc_revision=$3`, [row.id, fresh.workspaceId, expected]);
    await audit(tx, fresh, "knowledge.source.archived", row.id); return { id: row.id, archived: true };
  }, options);
}
export async function archiveKnowledgeArea(session: AppSession, input: { areaId: string }, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); await enabled(tx, fresh);
    const row = await area(tx, fresh, input.areaId, true);
    await tx.execute(`update knowledge_sources set archived_at=now(),status='archived',kc_revision=kc_revision+1,updated_at=now() where knowledge_area_id=$1::uuid and workspace_id=$2::uuid and archived_at is null`, [row.id, fresh.workspaceId]);
    await tx.execute(`update knowledge_areas set archived_at=now(),updated_at=now() where id=$1::uuid and workspace_id=$2::uuid`, [row.id, fresh.workspaceId]);
    // Grants remain inert while an area is archived; retain the authorization history.
    await audit(tx, fresh, "knowledge.area.archived", row.id); return { id: row.id, archived: true };
  }, options);
}
export async function updateKnowledgeArea(session: AppSession, input: { areaId: string; name: string; description?: string }, options: TenantTransactionOptions = {}) {
  const name = knowledgeText(input.name, "name", 160), description = knowledgeText(input.description ?? "", "description", 2000, false);
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); await enabled(tx, fresh);
    const row = await area(tx, fresh, input.areaId, true);
    await tx.execute(`update knowledge_areas set name=$1,description=$2,updated_at=now() where id=$3::uuid and workspace_id=$4::uuid`, [name, description, row.id, fresh.workspaceId]);
    await audit(tx, fresh, "knowledge.area.updated", row.id); return area(tx, fresh, row.id);
  }, options);
}
export async function assignKnowledgeAreas(session: AppSession, input: AssignKnowledgeAreasInput, options: TenantTransactionOptions = {}) {
  const targetChannel = channel(input.channel);
  if (!Array.isArray(input.areaIds) || input.areaIds.length > 100) fail("VALIDATION_ERROR", "At most 100 explicit areas may be assigned");
  const ids = [...new Set(input.areaIds.map(id => knowledgeId(id, "areaId")))];
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canAssign"); await lock(tx, fresh); await enabled(tx, fresh);
    const targetBot = await bot(tx, fresh, input.botId, true);
    for (const id of ids) {
      const targetArea = await area(tx, fresh, id, true);
      if (targetArea.projectId && targetArea.projectId !== targetBot.projectId) fail("PROJECT_SCOPE_MISMATCH", "A bot may only use its own project areas", 403);
    }
    await tx.execute(`delete from knowledge_area_grants where bot_id=$1::uuid and workspace_id=$2::uuid and channel=$3`, [targetBot.id, fresh.workspaceId, targetChannel]);
    for (const id of ids) await tx.execute(`insert into knowledge_area_grants(workspace_id,bot_id,area_id,channel,created_by) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid)`, [fresh.workspaceId, targetBot.id, id, targetChannel, fresh.userId]);
    await audit(tx, fresh, "knowledge.areas.assigned", targetBot.id, { channel: targetChannel, areaIds: ids }); return { botId: targetBot.id, channel: targetChannel, areaIds: ids };
  }, options);
}
export async function listKnowledgeVersions(session: AppSession, input: { sourceId: string }, options: TenantTransactionOptions = {}): Promise<KnowledgeVersion[]> {
  return withCrmRead(session, async (tx, fresh) => {
    await enabled(tx, fresh); const row = await source(tx, fresh, input.sourceId);
    return tx.query<KnowledgeVersion>(`select id,source_id as "sourceId",version,name,content,structured_data as "structuredData",source_url as url,media_asset_id as "mediaAssetId",status,created_at::text as "createdAt",approved_at::text as "approvedAt",coalesce(to_jsonb(knowledge_source_versions)->>'processing_status',case when media_asset_id is null then 'manual' else 'needs_ocr' end) as "processingStatus",to_jsonb(knowledge_source_versions)->>'processing_message' as "processingMessage",to_jsonb(knowledge_source_versions)->>'processing_format' as "processingFormat" from knowledge_source_versions where source_id=$1::uuid and workspace_id=$2::uuid and ($3::boolean or id=$4::uuid) order by version desc`, [row.id, fresh.workspaceId, knowledgePermissions(fresh).canWrite, row.approvedVersionId]);
  }, options);
}
export async function publishKnowledgeSource(session: AppSession, input: { sourceId: string; versionId: string; expectedVersion: number }, options: TenantTransactionOptions = {}) {
  const expected = knowledgeRevision(input.expectedVersion); const versionId = knowledgeId(input.versionId, "versionId");
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canPublish"); await lock(tx, fresh); await enabled(tx, fresh);
    const row = await source(tx, fresh, input.sourceId, true);
    if (row.revision !== expected || row.draftVersionId !== versionId) fail("VERSION_CONFLICT", "Only the current draft can be approved", 409);
    const version = row.version!;
    if (["needs_ocr", "failed"].includes(version.processingStatus)) fail("DOCUMENT_NOT_READY", version.processingMessage ?? "Das Dokument konnte noch nicht verarbeitet werden.", 409);
    const text = [version.content, Object.keys(version.structuredData).length ? JSON.stringify(version.structuredData) : ""].filter(Boolean).join("\n");
    if (!text.trim()) fail("CONTENT_REQUIRED", "Extract and review document or website content before approval", 409);
    await tx.execute(`update knowledge_source_versions set status='approved',approved_at=now(),approved_by=$1::uuid where id=$2::uuid and source_id=$3::uuid and workspace_id=$4::uuid and status='draft'`, [fresh.userId, versionId, row.id, fresh.workspaceId]);
    await tx.execute(`update knowledge_sources set approved_version_id=$1::uuid,draft_version_id=null,name=$2,status='approved',kc_revision=kc_revision+1,updated_at=now() where id=$3::uuid and workspace_id=$4::uuid`, [versionId, version.name, row.id, fresh.workspaceId]);
    await tx.execute(`delete from knowledge_chunks where source_id=$1::uuid`, [row.id]);
    let index = 0;
    for (let start = 0; start < text.length; start += 1600) {
      await tx.execute(`insert into knowledge_chunks(source_id,knowledge_version_id,chunk_index,content,citation_title,citation_url,metadata) values($1::uuid,$2::uuid,$3,$4,$5,$6,'{"trust":"untrusted_source_data","approved":true}'::jsonb)`, [row.id, versionId, index++, text.slice(start, start + 1600), version.name, version.url]);
    }
    await tx.execute(`update knowledge_sources set item_count=$1 where id=$2::uuid and workspace_id=$3::uuid`, [index, row.id, fresh.workspaceId]);
    await audit(tx, fresh, "knowledge.source.approved", row.id, { versionId, chunks: index }); return source(tx, fresh, row.id);
  }, options);
}
export async function queryKnowledgeCenter(session: AppSession, input: QueryKnowledgeCenterInput, options: TenantTransactionOptions = {}): Promise<KnowledgeQueryResult> {
  const query = knowledgeText(input.query, "query", 2000);
  const limit = input.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail("VALIDATION_ERROR", "Query limit must be between 1 and 20");
  if (input.channel && !input.botId) fail("VALIDATION_ERROR", "Channel retrieval requires an explicit bot");
  const targetChannel = input.botId ? channel(input.channel) : null;
  if (input.areaIds && (!Array.isArray(input.areaIds) || input.areaIds.length > 100)) fail("VALIDATION_ERROR", "Invalid areaIds");
  const areaIds = input.areaIds?.map(id => knowledgeId(id, "areaId")) ?? null;
  return withCrmRead(session, async (tx, fresh) => {
    await lock(tx, fresh); const contract = await enabled(tx, fresh);
    if (input.botId) await bot(tx, fresh, input.botId, false);
    for (const id of areaIds ?? []) await area(tx, fresh, id);
    const current = await usage(tx, fresh);
    if (current.queriesThisMonth >= contract.maxQueriesPerMonth) fail("LIMIT_EXCEEDED", "Monthly knowledge query limit reached", 409);
    await tx.execute(`insert into knowledge_query_usage(workspace_id,month,query_count) values($1::uuid,date_trunc('month',now() at time zone 'UTC')::date,1) on conflict(workspace_id,month) do update set query_count=knowledge_query_usage.query_count+1`, [fresh.workspaceId]);
    const matches = await tx.query<KnowledgeQueryResult["matches"][number]>(`select s.id as "sourceId",v.id as "versionId",c.id as "chunkId",a.id as "areaId",v.name as title,left(c.content,1600) as excerpt,
      v.source_url as "citationUrl",ts_rank_cd(to_tsvector('simple',c.content),websearch_to_tsquery('simple',$2))::float8 as score
      from knowledge_sources s join knowledge_areas a on a.id=s.knowledge_area_id and a.workspace_id=s.workspace_id
      join knowledge_source_versions v on v.id=s.approved_version_id and v.source_id=s.id and v.workspace_id=s.workspace_id
      join knowledge_chunks c on c.source_id=s.id and c.knowledge_version_id=v.id
      where s.workspace_id=$1::uuid and s.archived_at is null and a.archived_at is null and v.status='approved'
       and (s.project_id is null or crm_project_access(s.workspace_id,s.project_id,false))
       and ($3::uuid[] is null or a.id=any($3::uuid[]))
       and ($4::uuid is null or exists(select 1 from knowledge_area_grants g join bots b on b.id=g.bot_id and b.workspace_id=g.workspace_id
        where g.workspace_id=s.workspace_id and g.bot_id=$4::uuid and g.channel=$5 and g.area_id=a.id and (a.project_id is null or a.project_id=b.project_id)))
       and (to_tsvector('simple',c.content) @@ websearch_to_tsquery('simple',$2) or strpos(lower(c.content),lower($2))>0)
      order by score desc,s.id,c.chunk_index limit $6`, [fresh.workspaceId, query, areaIds, input.botId ?? null, targetChannel, limit]);
    await audit(tx, fresh, "knowledge.query.executed", input.botId ?? fresh.userId, { botId: input.botId ?? null, channel: targetChannel, matchedSources: [...new Set(matches.map(item => item.sourceId))] });
    return { matches, grounded: matches.length > 0, usage: await usage(tx, fresh) };
  }, options);
}
export async function getKnowledgeDocument(session: AppSession, input: { sourceId: string }, options: TenantTransactionOptions = {}): Promise<KnowledgeDocument> {
  return withCrmRead(session, async (tx, fresh) => {
    await enabled(tx, fresh); const row = await source(tx, fresh, input.sourceId);
    const assetId = row.version?.mediaAssetId;
    if (!assetId) fail("NOT_FOUND", "Document is unavailable", 404);
    const asset = await tx.queryOne<{ assetId: string; name: string; mimeType: string; sizeBytes: number }>(`select id as "assetId",original_name as name,mime_type as "mimeType",size_bytes::float8 as "sizeBytes" from media_assets where id=$1::uuid and workspace_id=$2 and storage_access='private' and is_public=false`, [assetId, fresh.workspaceId]);
    if (!asset) fail("NOT_FOUND", "Document is unavailable", 404);
    await audit(tx, fresh, "knowledge.document.authorized", row.id, { assetId });
    return { ...asset, downloadPath: `/api/knowledge-center/sources/${row.id}/document` };
  }, options);
}
export async function getKnowledgeScanSource(session: AppSession, input: { sourceId: string; expectedVersion?: number }, options: TenantTransactionOptions = {}) {
  if (input.expectedVersion !== undefined) knowledgeRevision(input.expectedVersion);
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh); const row = await source(tx, fresh, input.sourceId, true);
    if (input.expectedVersion !== undefined && row.revision !== input.expectedVersion) fail("VERSION_CONFLICT", "Knowledge source changed; reload before scanning", 409);
    if (row.type !== "url" || !row.version?.url) fail("VALIDATION_ERROR", "Only URL sources may be scanned");
    if (contract.features?.websiteImport !== true) fail("ENTITLEMENT_REQUIRED", "Website import requires a trusted contract feature", 403);
    const totals = await tx.queryOne<{ scans: number }>(`select scans_this_month as scans from knowledge_center_usage($1::uuid)`, [fresh.workspaceId]);
    if (!Number.isSafeInteger(contract.limits?.maxScansPerMonth) || (totals?.scans ?? 0) >= contract.limits.maxScansPerMonth) fail("LIMIT_EXCEEDED", "Monthly website scan limit reached", 409);
    await tx.execute(`insert into knowledge_query_usage(workspace_id,month,scan_count) values($1::uuid,date_trunc('month',now() at time zone 'UTC')::date,1) on conflict(workspace_id,month) do update set scan_count=knowledge_query_usage.scan_count+1`, [fresh.workspaceId]);
    await audit(tx, fresh, "knowledge.website.scan_reserved", row.id);
    return { sourceId: row.id, type: row.type, url: row.version!.url!, revision: row.revision, contentHash: row.version!.content ? createHash("sha256").update(row.version!.content).digest("hex") : null };
  }, options);
}
export type ImportKnowledgeDocumentInput = { file: File; areaId: string; name?: string; alt?: string; sourceId?: string; expectedVersion?: number };
type ImportedAsset = { id: string; name: string; originalName: string; mimeType: string; sizeBytes: number };
export type ImportKnowledgeDocumentResult = { asset: ImportedAsset; source: KnowledgeSource; reused: boolean };

/** Extract the exact uploaded bytes, then atomically attach a private draft.
 * Neither a client-provided transcript nor a client processing flag is trusted.
 * Expensive parsing happens outside a transaction; all authority is checked again.
 */
export async function importKnowledgeDocument(session: AppSession, input: ImportKnowledgeDocumentInput, options: TenantTransactionOptions = {}): Promise<ImportKnowledgeDocumentResult> {
  const areaId = knowledgeId(input.areaId, "areaId");
  const sourceId = input.sourceId ? knowledgeId(input.sourceId, "sourceId") : null;
  const expected = sourceId ? knowledgeRevision(input.expectedVersion) : null;
  if (!sourceId && input.expectedVersion !== undefined) fail("VALIDATION_ERROR", "expectedVersion requires a sourceId");
  if (!(input.file instanceof File) || input.file.size <= 0 || input.file.size > 10 * 1024 * 1024) fail("VALIDATION_ERROR", "A document up to 10 MB is required");
  const name = knowledgeText(input.name ?? input.file.name, "name", 200);
  const alt = input.alt === undefined ? undefined : knowledgeText(input.alt, "alt", 1000, false);
  // Authorize before reading/parsing bytes. The second check also catches quota,
  // membership, area, entitlement and source revision changes during extraction.
  await withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await enabled(tx, fresh); await area(tx, fresh, areaId, true);
    if (sourceId) { const row = await source(tx, fresh, sourceId, true); if (row.areaId !== areaId || row.type !== "file") fail("VALIDATION_ERROR", "The selected source must be a document in this area"); }
  }, options);
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  const importKey = createHash("sha256").update(JSON.stringify([session.userId, areaId, sourceId, expected, hash, input.file.name, input.file.type, name])).digest("hex");
  const existing = async (tx: TenantTransaction, fresh: AppSession): Promise<ImportKnowledgeDocumentResult | null> => {
    const imported = await tx.queryOne<{ sourceId: string; versionId: string }>(`select source_id as "sourceId",id as "versionId" from knowledge_source_versions where workspace_id=$1::uuid and document_import_key=$2`, [fresh.workspaceId, importKey]);
    if (!imported) return null;
    const row = await source(tx, fresh, imported.sourceId, true);
    if (row.areaId !== areaId || row.version?.id !== imported.versionId) fail("VERSION_CONFLICT", "Knowledge source changed; reload before importing", 409);
    const asset = await tx.queryOne<ImportedAsset>(`select id,name,original_name as "originalName",mime_type as "mimeType",size_bytes::float8 as "sizeBytes" from media_assets where id=$1::uuid and workspace_id=$2 and storage_access='private' and not is_public and public_token is null`, [row.version.mediaAssetId, fresh.workspaceId]);
    if (!asset) fail("DOCUMENT_UNAVAILABLE", "Private document is unavailable", 404);
    return { asset, source: row, reused: true };
  };
  const validate = async (tx: TenantTransaction, fresh: AppSession) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh);
    const target = await area(tx, fresh, areaId, true);
    const repeated = await existing(tx, fresh);
    if (repeated) return { target, contract, previous: null, repeated };
    const previous = sourceId ? await source(tx, fresh, sourceId, true) : null;
    if (previous && (previous.areaId !== areaId || previous.type !== "file")) fail("VALIDATION_ERROR", "The selected source must be a document in this area");
    if (previous && previous.revision !== expected) fail("VERSION_CONFLICT", "Knowledge source changed; reload before importing", 409);
    const current = await usage(tx, fresh);
    if ((!previous && current.sources >= contract.maxSources) || current.storageBytes + bytes.byteLength > contract.maxStorageBytes) fail("LIMIT_EXCEEDED", "Knowledge source or storage limit reached", 409);
    return { target, contract, previous, repeated: null };
  };
  const reservation = await withCrmRead(session, validate, options);
  if (reservation.repeated) return reservation.repeated;
  let text = "";
  let processing: DocumentProcessing;
  try {
    const extracted = await extractKnowledgeDocument({ bytes, fileName: input.file.name, mimeType: input.file.type });
    text = extracted.content;
    processing = { status: extracted.status, message: extracted.message, format: extracted.format, hash, importKey };
  } catch (error) {
    if (!(error instanceof KnowledgeCenterError)) throw error;
    if (["UNSUPPORTED_DOCUMENT", "DOCUMENT_EXTRACTION_BUSY"].includes(error.code)) throw error;
    // A valid private file remains available for review even when its parser
    // rejects corrupt, encrypted, oversized-expanded or otherwise unreadable data.
    processing = { status: "failed", message: error.message.slice(0, 1000), format: null, code: error.code, hash, importKey };
  }
  let uploaded: MediaAsset | null = null;
  try { return await withCrmRead(session, async (tx, fresh) => {
    const current = await validate(tx, fresh);
    if (current.repeated) return current.repeated;
    const totals = await usage(tx, fresh);
    if (totals.storageBytes + bytes.byteLength + Buffer.byteLength(text, "utf8") + 2 > current.contract.maxStorageBytes) fail("LIMIT_EXCEEDED", "Knowledge storage limit reached", 409);
    const asset = await saveKnowledgeFile({ actorId: fresh.userId, workspaceId: fresh.workspaceId, file: input.file, name, alt });
    uploaded = asset;
    const data = await content(tx, fresh, "file", { name, content: text, mediaAssetId: asset.id });
    const id = current.previous?.id ?? randomUUID();
    if (!current.previous) await tx.execute(`insert into knowledge_sources(id,workspace_id,project_id,knowledge_area_id,name,source_type,status,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'file','needs-review','{"knowledgeCenter":true,"trust":"untrusted_source_data"}'::jsonb)`, [id, fresh.workspaceId, current.target.projectId, areaId, name]);
    const versionId = await insertVersion(tx, fresh, id, (current.previous?.version?.version ?? 0) + 1, data, processing);
    const changed = await tx.queryOne<{ id: string }>(`update knowledge_sources set draft_version_id=$1::uuid,kc_revision=kc_revision+$2,status='needs-review',updated_at=now() where id=$3::uuid and workspace_id=$4::uuid and kc_revision=$5 returning id`, [versionId, current.previous ? 1 : 0, id, fresh.workspaceId, current.previous?.revision ?? 1]);
    if (!changed) fail("VERSION_CONFLICT", "Knowledge source changed; reload before importing", 409);
    await checkStorage(tx, fresh, current.contract);
    await audit(tx, fresh, "knowledge.document.imported", id, { versionId, assetId: asset.id, processingStatus: processing.status, errorCode: processing.code ?? null });
    return { asset: { id: asset.id, name: asset.name, originalName: asset.originalName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes }, source: await source(tx, fresh, id, true), reused: false };
  }, options); } catch (error) {
    if (uploaded) await withCrmRead(session, () => discardUncommittedKnowledgeFile(uploaded!), options).catch(() => undefined);
    throw error;
  }
}

export async function assertKnowledgeUploadAllowed(session: AppSession, input: { sizeBytes: number }, options: TenantTransactionOptions = {}) {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > 10 * 1024 * 1024) fail("VALIDATION_ERROR", "A document up to 10 MB is required");
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh);
    const current = await usage(tx, fresh);
    if ((input.sizeBytes > 0 && current.sources >= contract.maxSources) || current.storageBytes + input.sizeBytes > contract.maxStorageBytes) fail("LIMIT_EXCEEDED", "Knowledge source or storage limit reached", 409);
    return { allowed: true as const };
  }, options);
}
export async function revalidateKnowledgeScanSource(session: AppSession, input: { sourceId: string; expectedVersion: number }, options: TenantTransactionOptions = {}) {
  const expected = knowledgeRevision(input.expectedVersion);
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); const contract = await enabled(tx, fresh);
    if (contract.features?.websiteImport !== true) fail("ENTITLEMENT_REQUIRED", "Website import requires a trusted contract feature", 403);
    const row = await source(tx, fresh, input.sourceId, true);
    if (row.revision !== expected) fail("VERSION_CONFLICT", "Knowledge source changed; reload before scanning", 409);
    if (row.type !== "url" || !row.version?.url) fail("VALIDATION_ERROR", "Only URL sources may be scanned");
    return { sourceId: row.id, revision: row.revision };
  }, options);
}
