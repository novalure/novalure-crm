import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { discardUncommittedKnowledgeFile, saveKnowledgeFile, type MediaAsset } from "../media-store";
import { extractKnowledgeDocument } from "./document-extraction";
import type { KnowledgeDocumentUploadMetadata, VerifiedKnowledgeDocumentUpload } from "./document-upload";
import type { AppSession } from "../auth/session";
import { knowledgeMonitoringAuditMetadata } from "./monitoring-delegation";
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
  const row = await tx.queryOne<KnowledgeEntitlement>(`select e.enabled and coalesce(m.enabled,true) as enabled,e.max_sources as "maxSources",e.max_storage_bytes::float8 as "maxStorageBytes",e.max_queries_per_month as "maxQueriesPerMonth",e.contract_reference as "contractReference",e.features,e.limits,coalesce(to_jsonb(e)->'monitoring_intervals','["manual"]'::jsonb) as "allowedMonitoringIntervals" from knowledge_center_entitlements e left join workspace_module_settings m on m.workspace_id=e.workspace_id and m.module_key='knowledge' where e.workspace_id=$1::uuid`, [session.workspaceId]);
  return row ?? { enabled: false, maxSources: 0, maxStorageBytes: 0, maxQueriesPerMonth: 0, contractReference: null, features: { websiteImport: false, monitoring: false, advancedMaintenance: false }, limits: { maxAreas: 0, maxWebsites: 0, maxScansPerMonth: 0, maxUsers: 0, maxAssistants: 0 } };
}
async function enabled(tx: TenantTransaction, session: AppSession) {
  const contract = await entitlement(tx, session);
  if (!contract.enabled || !contract.contractReference?.trim()) fail("ENTITLEMENT_REQUIRED", "Knowledge Center requires an active trusted contract", 403);
  return contract;
}
async function assistantChannelEnabled(tx: TenantTransaction, session: AppSession, contract: KnowledgeEntitlement, targetChannel: KnowledgeChannel) {
  const assistantModule = await tx.queryOne<{ enabled: boolean }>(`select enabled from workspace_module_settings where workspace_id=$1::uuid and module_key='bots'`, [session.workspaceId]);
  if (assistantModule?.enabled === false) fail("ENTITLEMENT_REQUIRED", "KI-Assistenten sind für dieses Unternehmen deaktiviert. Bitte wenden Sie sich an Ihre Verwaltung.", 403);
  const feature = targetChannel === "webchat" ? "webchatAccess" : ["voice", "telephone"].includes(targetChannel) ? "voiceAccess" : null;
  if (feature && contract.features?.[feature] !== true) fail("ENTITLEMENT_REQUIRED", `Der Zugriff für ${feature === "webchatAccess" ? "Webchat" : "Telefonassistent"} ist in Ihrem Vertrag nicht freigeschaltet. Bitte wenden Sie sich an Ihre Verwaltung.`, 403);
}
async function usage(tx: TenantTransaction, session: AppSession): Promise<KnowledgeUsage> {
  const row = await tx.queryOne<KnowledgeUsage>(`select sources,storage_bytes::float8 as "storageBytes",queries_this_month as "queriesThisMonth" from knowledge_center_usage($1::uuid)`, [session.workspaceId]);
  return row ?? { sources: 0, storageBytes: 0, queriesThisMonth: 0 };
}
async function audit(tx: TenantTransaction, session: AppSession, action: string, entityId: string, details: Record<string, unknown> = {}) {
  await tx.execute(`insert into audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3,'knowledge_center',$4::uuid,$5::jsonb)`, [session.workspaceId, session.userId, action, entityId, JSON.stringify({ ...details, ...knowledgeMonitoringAuditMetadata(session) })]);
}
async function area(tx: TenantTransaction, session: AppSession, areaId: string, write = false) {
  const row = await tx.queryOne<KnowledgeArea>(`select id,name,kind,project_id as "projectId",description,archived_at::text as "archivedAt" from knowledge_areas where id=$1::uuid and workspace_id=$2::uuid and archived_at is null`, [knowledgeId(areaId, "areaId"), session.workspaceId]);
  if (!row) fail("NOT_FOUND", "Knowledge area is unavailable", 404);
  if (row.projectId) await assertProjectGrant(tx, session, row.projectId, write);
  return row;
}
const versionJson = `jsonb_build_object('id',v.id,'sourceId',v.source_id,'version',v.version,'name',v.name,'content',v.content,'structuredData',v.structured_data,'url',v.source_url,'mediaAssetId',v.media_asset_id,'status',v.status,'createdAt',v.created_at,'approvedAt',v.approved_at,'processingStatus',coalesce(to_jsonb(v)->>'processing_status',case when v.media_asset_id is null then 'manual' else 'needs_ocr' end),'processingMessage',to_jsonb(v)->>'processing_message','processingFormat',to_jsonb(v)->>'processing_format','createdBy',v.created_by,'approvedBy',v.approved_by,'createdByName',(select u.name from workspace_users u where u.id=v.created_by and u.workspace_id=v.workspace_id),'approvedByName',(select u.name from workspace_users u where u.id=v.approved_by and u.workspace_id=v.workspace_id),'changeReason',coalesce(to_jsonb(v)->>'change_reason','Draft created'),'provenance',coalesce(to_jsonb(v)->'provenance','{}'::jsonb))`;
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
async function insertVersion(tx: TenantTransaction, session: AppSession, sourceId: string, version: number, data: Awaited<ReturnType<typeof content>>, processing?: DocumentProcessing, governance?: { reason: string; provenance: Record<string, unknown> }) {
  const id = randomUUID();
  // Processing evidence is an immutable part of the version. API content inputs
  // never accept these fields; a new attachment cannot claim an old result.
  if (governance) {
    await tx.execute(`insert into knowledge_source_versions(id,workspace_id,source_id,version,name,content,structured_data,source_url,media_asset_id,document_size_bytes,created_by,processing_status,processing_message,processing_format,processing_error_code,document_sha256,change_reason,provenance) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9::uuid,$10,$11::uuid,$12,$13,$14,$15,$16,$17,$18::jsonb)`, [id, session.workspaceId, sourceId, version, data.name, data.content, JSON.stringify(data.structuredData), data.url, data.mediaAssetId, data.documentSizeBytes, session.userId, processing?.status ?? "manual", processing?.message ?? null, processing?.format ?? null, processing?.code ?? null, processing?.hash ?? null, governance.reason, JSON.stringify(governance.provenance)]);
  } else if (processing) {
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
    const available = Boolean(contract.enabled && contract.contractReference?.trim());
    if (!available && !permissions.canAssign) return { workspace, available: false, areas: [], sources: [], projects: [], bots: [], assignments: [], entitlement: contract, usage: { sources: 0, storageBytes: 0, queriesThisMonth: 0 }, permissions };
    // Revocation remains possible after contract/module shutdown. Return only
    // authorized management metadata in that state, never source contents.
    const projects = await tx.query<{ id: string; name: string }>(`select id,name from projects where workspace_id=$1::uuid and crm_project_access(workspace_id,id,false) order by name`, [fresh.workspaceId]);
    const bots = await tx.query<{ id: string; name: string; projectId: string | null }>(`select id,name,project_id as "projectId" from bots where workspace_id=$1::uuid and (project_id is null or crm_project_access(workspace_id,project_id,false)) order by name`, [fresh.workspaceId]);
    // Archived areas still occupy an assistant place until their final grant is
    // explicitly revoked, so their grant identifiers must remain manageable.
    const assignments = await tx.query<{ botId: string; channel: KnowledgeChannel; areaId: string }>(`select g.bot_id as "botId",g.channel,g.area_id as "areaId" from knowledge_area_grants g join knowledge_areas a on a.id=g.area_id and a.workspace_id=g.workspace_id join bots b on b.id=g.bot_id and b.workspace_id=g.workspace_id where g.workspace_id=$1::uuid and (b.project_id is null or crm_project_access(b.workspace_id,b.project_id,false))`, [fresh.workspaceId]);
    const assistantUsage = await tx.queryOne<{ connectedAssistants: number }>(`select public.knowledge_connected_assistant_count($1::uuid) as "connectedAssistants"`, [fresh.workspaceId]);
    const management = { workspace, projects, bots, assignments, entitlement: contract, usage: { ...await usage(tx, fresh), connectedAssistants: assistantUsage?.connectedAssistants ?? 0 }, permissions, assignmentManagementAvailable: permissions.canAssign };
    if (!available) return { ...management, available: false, areas: [], sources: [] };
    const areas = await tx.query<KnowledgeArea>(`select id,name,kind,project_id as "projectId",description,archived_at::text as "archivedAt" from knowledge_areas where workspace_id=$1::uuid and archived_at is null and (project_id is null or crm_project_access(workspace_id,project_id,false)) order by kind,name`, [fresh.workspaceId]);
    const ids = await tx.query<{ id: string }>(`select s.id from knowledge_sources s join knowledge_areas a on a.id=s.knowledge_area_id and a.workspace_id=s.workspace_id where s.workspace_id=$1::uuid and s.archived_at is null and a.archived_at is null and ($2::boolean or s.approved_version_id is not null) order by s.updated_at desc limit 500`, [fresh.workspaceId, permissions.canWrite]);
    const sources: KnowledgeSource[] = [];
    for (const row of ids) sources.push(await source(tx, fresh, row.id));
    const workflowInstalled = await tx.queryOne<{ installed: boolean }>("select to_regclass('public.knowledge_publication_workflows') is not null as installed");
    if (permissions.canWrite && workflowInstalled?.installed) {
      const states = await tx.query<{ sourceId: string; state: NonNullable<KnowledgeSource["workflowState"]> }>(`select w.source_id as "sourceId",w.state from knowledge_publication_workflows w join knowledge_sources s on s.id=w.source_id and s.workspace_id=w.workspace_id where w.workspace_id=$1::uuid and w.version_id=coalesce(s.draft_version_id,s.approved_version_id)`, [fresh.workspaceId]);
      for (const item of sources) item.workflowState = states.find(value => value.sourceId === item.id)?.state ?? (item.draftVersionId ? item.version?.provenance?.kind === "revocation" ? "revoked" : "draft" : "published");
    }
    return { ...management, available: true, areas, sources };
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
    requireKnowledgePermission(fresh, "canAssign"); await lock(tx, fresh);
    const targetBot = await bot(tx, fresh, input.botId, true);
    // Revocation remains available after a contract/module is disabled or its
    // limit is lowered. New connections use the same tenant-wide lock as all
    // assignment writes, so concurrent requests cannot take the last place.
    if (ids.length) {
      const contract = await enabled(tx, fresh);
      await assistantChannelEnabled(tx, fresh, contract, targetChannel);
      const maximum = contract.limits?.maxAssistants;
      if (!Number.isSafeInteger(maximum) || maximum < 0) fail("LIMIT_EXCEEDED", "The connected-assistant limit is unavailable", 409);
      const counts = await tx.queryOne<{ total: number; connected: number }>(`select
        public.knowledge_connected_assistant_count($1::uuid) as total,
        public.knowledge_connected_assistant_count($1::uuid,$2::uuid) as connected`, [fresh.workspaceId, targetBot.id]);
      if (!counts || (counts.connected === 0 && counts.total >= maximum)) {
        fail("LIMIT_EXCEEDED", "The limit for assistants connected to knowledge has been reached", 409);
      }
    }
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
    return tx.query<KnowledgeVersion>(`select id,source_id as "sourceId",version,name,content,structured_data as "structuredData",source_url as url,media_asset_id as "mediaAssetId",status,created_at::text as "createdAt",approved_at::text as "approvedAt",coalesce(to_jsonb(knowledge_source_versions)->>'processing_status',case when media_asset_id is null then 'manual' else 'needs_ocr' end) as "processingStatus",to_jsonb(knowledge_source_versions)->>'processing_message' as "processingMessage",to_jsonb(knowledge_source_versions)->>'processing_format' as "processingFormat",created_by as "createdBy",approved_by as "approvedBy",(select u.name from workspace_users u where u.id=knowledge_source_versions.created_by and u.workspace_id=knowledge_source_versions.workspace_id) as "createdByName",(select u.name from workspace_users u where u.id=knowledge_source_versions.approved_by and u.workspace_id=knowledge_source_versions.workspace_id) as "approvedByName",coalesce(to_jsonb(knowledge_source_versions)->>'change_reason','Draft created') as "changeReason",coalesce(to_jsonb(knowledge_source_versions)->'provenance','{}'::jsonb) as provenance from knowledge_source_versions where source_id=$1::uuid and workspace_id=$2::uuid and ($3::boolean or id=$4::uuid) order by version desc`, [row.id, fresh.workspaceId, knowledgePermissions(fresh).canWrite, row.approvedVersionId]);
  }, options);
}
export async function publishKnowledgeSource(session: AppSession, input: { sourceId: string; versionId: string; expectedVersion: number }, options: TenantTransactionOptions = {}) {
  const expected = knowledgeRevision(input.expectedVersion); const versionId = knowledgeId(input.versionId, "versionId");
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canPublish"); await lock(tx, fresh); await enabled(tx, fresh);
    const row = await source(tx, fresh, input.sourceId, true);
    if (row.revision !== expected || row.draftVersionId !== versionId) fail("VERSION_CONFLICT", "Only the current draft can be approved", 409);
    const published = await publishInTransaction(tx, fresh, row, versionId);
    const workflowInstalled = await tx.queryOne<{ installed: boolean }>("select to_regclass('public.knowledge_publication_workflows') is not null as installed");
    if (workflowInstalled?.installed) {
      // The legacy administrator endpoint shares publication semantics with
      // the explicit workflow endpoint, including its durable internal event.
      await tx.execute(`update knowledge_publication_workflows set state='published',published_by=$1::uuid where workspace_id=$2::uuid and version_id=$3::uuid and state='approved'`, [fresh.userId, fresh.workspaceId, versionId]);
      const { recordKnowledgeWorkflowEventInTransaction } = await import("./workflow");
      await recordKnowledgeWorkflowEventInTransaction(tx, fresh, "knowledge.publication.published", row, versionId, { reason: "Administrator publication", publicationMode: "legacy_administrator" });
    }
    return published;
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
    if (input.botId) { await assistantChannelEnabled(tx, fresh, contract, targetChannel!); await bot(tx, fresh, input.botId, false); }
    for (const id of areaIds ?? []) await area(tx, fresh, id);
    const current = await usage(tx, fresh);
    if (current.queriesThisMonth >= contract.maxQueriesPerMonth) fail("LIMIT_EXCEEDED", "Monthly knowledge query limit reached", 409);
    await tx.execute(`insert into knowledge_query_usage(workspace_id,month,query_count) values($1::uuid,date_trunc('month',now() at time zone 'UTC')::date,1) on conflict(workspace_id,month) do update set query_count=knowledge_query_usage.query_count+1`, [fresh.workspaceId]);
    const matches = await tx.query<KnowledgeQueryResult["matches"][number]>(`select s.id as "sourceId",v.id as "versionId",c.id as "chunkId",a.id as "areaId",v.name as title,left(c.content,1600) as excerpt,
      ts_headline('simple',c.content,websearch_to_tsquery('simple',$2),
        'StartSel="",StopSel="",MaxWords=35,MinWords=10,MaxFragments=3,FragmentDelimiter=" … "') as "relevantExcerpt",
      v.source_url as "citationUrl",ts_rank_cd(to_tsvector('simple',c.content),websearch_to_tsquery('simple',$2))::float8 as score,
      case when exists(select 1 from bots policy_bot join projects policy_project
        on policy_project.id=policy_bot.project_id and policy_project.workspace_id=policy_bot.workspace_id
        where policy_bot.id=$4::uuid and policy_bot.workspace_id=s.workspace_id and policy_project.division='WEB_DESIGN')
        then 'WEB_DESIGN' else 'REAL_ESTATE_GROWTH' end as "projectDivision"
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
export async function getKnowledgeDocument(session: AppSession, input: { sourceId: string; versionId?: string }, options: TenantTransactionOptions = {}): Promise<KnowledgeDocument> {
  const requestedVersionId = input.versionId === undefined ? undefined : knowledgeId(input.versionId, "versionId");
  return withCrmRead(session, async (tx, fresh) => {
    await enabled(tx, fresh); const row = await source(tx, fresh, input.sourceId);
    const versionId = requestedVersionId ?? row.version?.id;
    const version = await tx.queryOne<{ assetId: string | null }>(`select media_asset_id as "assetId" from knowledge_source_versions where id=$1::uuid and source_id=$2::uuid and workspace_id=$3::uuid and ($4::boolean or id=$5::uuid)`, [versionId, row.id, fresh.workspaceId, knowledgePermissions(fresh).canWrite, row.approvedVersionId]);
    const assetId = version?.assetId;
    if (!assetId) fail("NOT_FOUND", "Document is unavailable", 404);
    const asset = await tx.queryOne<{ assetId: string; name: string; mimeType: string; sizeBytes: number }>(`select id as "assetId",original_name as name,mime_type as "mimeType",size_bytes::float8 as "sizeBytes" from media_assets where id=$1::uuid and workspace_id=$2 and storage_access='private' and is_public=false`, [assetId, fresh.workspaceId]);
    if (!asset) fail("NOT_FOUND", "Document is unavailable", 404);
    await audit(tx, fresh, "knowledge.document.authorized", row.id, { assetId, versionId });
    return { ...asset, downloadPath: `/api/knowledge-center/sources/${row.id}/document${requestedVersionId ? `?versionId=${versionId}` : ""}` };
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
export type ImportKnowledgeDocumentInput = { file: File; areaId: string; name?: string; alt?: string; sourceId?: string; expectedVersion?: number; uploadReservationId?: string };
type ImportedAsset = { id: string; name: string; originalName: string; mimeType: string; sizeBytes: number };
export type ImportKnowledgeDocumentResult = { asset: ImportedAsset; source: KnowledgeSource; reused: boolean };
type UploadReservation = { uploadId: string; pathname: string; expiresAt: number; actorId: string; sizeBytes: number; sourceId: string | null; storeFingerprint: string; committed?: boolean };

async function pendingDocumentUploads(tx: TenantTransaction, session: AppSession): Promise<UploadReservation[]> {
  const rows = await tx.query<{ uploadId: string; reservation: Omit<UploadReservation, "uploadId">; committed: boolean }>(`select reserved.entity_id::text as "uploadId",reserved.after as reservation,exists(select 1 from media_assets m where m.workspace_id::text=reserved.workspace_id::text and m.relative_path=(reserved.after->>'pathname') and m.storage_provider='vercel-blob' and m.storage_access='private') as committed from audit_logs reserved where reserved.workspace_id=$1 and reserved.action='knowledge.document.upload_reserved' and not exists(select 1 from audit_logs released where released.workspace_id=reserved.workspace_id and released.entity_id=reserved.entity_id and released.action='knowledge.document.upload_released') order by reserved.created_at limit 101`, [session.workspaceId]);
  return rows.map((row) => ({ ...row.reservation, uploadId: row.uploadId, committed: row.committed }));
}

export async function reserveKnowledgeDocumentUpload(session: AppSession, upload: VerifiedKnowledgeDocumentUpload, fingerprint: string, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh);
    await area(tx, fresh, upload.metadata.areaId, true);
    const previous = upload.metadata.sourceId ? await source(tx, fresh, upload.metadata.sourceId, true) : null;
    if (previous && (previous.areaId !== upload.metadata.areaId || previous.type !== "file")) fail("VALIDATION_ERROR", "The selected source must be a document in this area");
    if (previous && previous.revision !== upload.metadata.expectedVersion) fail("VERSION_CONFLICT", "Knowledge source changed; reload before importing", 409);
    const pending = await pendingDocumentUploads(tx, fresh);
    const totals = await usage(tx, fresh);
    const bytes = pending.reduce((sum, item) => sum + (item.committed ? 0 : item.sizeBytes), 0);
    const newSources = pending.filter((item) => !item.sourceId && !item.committed).length;
    if (pending.length >= 100 || (!previous && totals.sources + newSources >= contract.maxSources) || totals.storageBytes + bytes + upload.metadata.sizeBytes > contract.maxStorageBytes) fail("LIMIT_EXCEEDED", "Knowledge source, storage or pending upload limit reached. Complete or clean up pending uploads before retrying.", 409);
    await audit(tx, fresh, "knowledge.document.upload_reserved", upload.uploadId, { pathname: upload.pathname, expiresAt: upload.expiresAt, actorId: fresh.userId, sizeBytes: upload.metadata.sizeBytes, sourceId: upload.metadata.sourceId ?? null, storeFingerprint: fingerprint });
  }, options);
}

export async function expiredKnowledgeDocumentUploads(session: AppSession, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await enabled(tx, fresh);
    return (await pendingDocumentUploads(tx, fresh)).filter((item) => item.expiresAt + 60_000 < Date.now()).slice(0, 20);
  }, options);
}

export async function releaseKnowledgeDocumentUpload(session: AppSession, uploadId: string, options: TenantTransactionOptions = {}, discard?: (upload: UploadReservation) => Promise<void>) {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); await enabled(tx, fresh);
    const pending = (await pendingDocumentUploads(tx, fresh)).find((item) => item.uploadId === uploadId);
    if (!pending || pending.expiresAt + 60_000 >= Date.now()) return;
    // A finalized object is the immutable media attachment itself. Never delete
    // it during transport cleanup. Missing metadata requires confirmed deletion
    // under the same lock used by the importing transaction.
    if (!pending.committed) {
      if (!discard) fail("DOCUMENT_UNAVAILABLE", "Private upload cleanup requires confirmed storage deletion", 503);
      await discard(pending);
    }
    await audit(tx, fresh, "knowledge.document.upload_released", uploadId);
  }, options);
}

function documentImportKey(session: AppSession, input: Pick<KnowledgeDocumentUploadMetadata, "areaId" | "sourceId" | "expectedVersion" | "sha256" | "fileName" | "mimeType" | "name">) {
  return createHash("sha256").update(JSON.stringify([session.userId, input.areaId, input.sourceId ?? null, input.sourceId ? input.expectedVersion : null, input.sha256, input.fileName, input.mimeType, input.name])).digest("hex");
}

/** Authorize the intended target before granting direct private upload bytes. */
export async function assertKnowledgeDocumentUploadAllowed(session: AppSession, input: KnowledgeDocumentUploadMetadata, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh);
    await area(tx, fresh, input.areaId, true);
    const previous = input.sourceId ? await source(tx, fresh, input.sourceId, true) : null;
    if (previous && (previous.areaId !== input.areaId || previous.type !== "file")) fail("VALIDATION_ERROR", "The selected source must be a document in this area");
    if (previous && previous.revision !== input.expectedVersion) fail("VERSION_CONFLICT", "Knowledge source changed; reload before importing", 409);
    const totals = await usage(tx, fresh);
    if ((!previous && totals.sources >= contract.maxSources) || totals.storageBytes + input.sizeBytes > contract.maxStorageBytes) fail("LIMIT_EXCEEDED", "Knowledge source or storage limit reached", 409);
    return { allowed: true as const };
  }, options);
}

/** A completed exact-byte import is the durable receipt for a retried finalize.
 * It remains authoritative after the temporary transport object is removed. */
export async function findKnowledgeDocumentImport(session: AppSession, input: KnowledgeDocumentUploadMetadata, options: TenantTransactionOptions = {}): Promise<ImportKnowledgeDocumentResult | null> {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await enabled(tx, fresh); await area(tx, fresh, input.areaId, true);
    const imported = await tx.queryOne<{ sourceId: string; versionId: string }>(`select source_id as "sourceId",id as "versionId" from knowledge_source_versions where workspace_id=$1::uuid and document_import_key=$2`, [fresh.workspaceId, documentImportKey(fresh, input)]);
    if (!imported) return null;
    const row = await source(tx, fresh, imported.sourceId, true);
    if (row.areaId !== input.areaId || row.version?.id !== imported.versionId) fail("VERSION_CONFLICT", "Knowledge source changed; reload before importing", 409);
    const asset = await tx.queryOne<ImportedAsset>(`select id,name,original_name as "originalName",mime_type as "mimeType",size_bytes::float8 as "sizeBytes" from media_assets where id=$1::uuid and workspace_id=$2 and storage_access='private' and not is_public and public_token is null`, [row.version.mediaAssetId, fresh.workspaceId]);
    if (!asset) fail("DOCUMENT_UNAVAILABLE", "Private document is unavailable", 404);
    return { asset, source: row, reused: true };
  }, options);
}

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
  const importKey = documentImportKey(session, { areaId, sourceId: sourceId ?? undefined, expectedVersion: expected ?? undefined, sha256: hash, fileName: input.file.name, mimeType: input.file.type, name });
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
    if (repeated) return { target, contract, previous: null, repeated, reservedBytes: 0 };
    const previous = sourceId ? await source(tx, fresh, sourceId, true) : null;
    if (previous && (previous.areaId !== areaId || previous.type !== "file")) fail("VALIDATION_ERROR", "The selected source must be a document in this area");
    if (previous && previous.revision !== expected) fail("VERSION_CONFLICT", "Knowledge source changed; reload before importing", 409);
    const current = await usage(tx, fresh);
    const pending = (await pendingDocumentUploads(tx, fresh)).filter((item) => item.uploadId !== input.uploadReservationId && !item.committed);
    const reservedBytes = pending.reduce((sum, item) => sum + item.sizeBytes, 0);
    if ((!previous && current.sources + pending.filter((item) => !item.sourceId).length >= contract.maxSources) || current.storageBytes + bytes.byteLength + reservedBytes > contract.maxStorageBytes) fail("LIMIT_EXCEEDED", "Knowledge source or storage limit reached", 409);
    return { target, contract, previous, repeated: null, reservedBytes };
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
    if (totals.storageBytes + bytes.byteLength + Buffer.byteLength(text, "utf8") + 2 + current.reservedBytes > current.contract.maxStorageBytes) fail("LIMIT_EXCEEDED", "Knowledge storage limit reached", 409);
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

async function publishInTransaction(tx: TenantTransaction, fresh: AppSession, row: KnowledgeSource, versionId: string) {
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
}

export const knowledgeInternals = { lock, enabled, entitlement, source, area, audit, usage, content, insertVersion, checkStorage, publishInTransaction };
