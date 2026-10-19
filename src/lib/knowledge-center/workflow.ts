import "server-only";
import { createHash } from "node:crypto";
import type { AppSession } from "../auth/session";
import { withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { knowledgeInternals, listKnowledgeVersions } from "./repository";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision, knowledgeStructured, knowledgeText, requireKnowledgePermission } from "./policy";
import { analyzeKnowledgeMaintenance, type KnowledgeMaintenanceField, type KnowledgeMaintenanceSource } from "./maintenance";
import type { KnowledgeChangeProposal, KnowledgeContentInput, KnowledgeMaintenanceConfiguration, KnowledgeProposalReference, KnowledgePublicationWorkflow, KnowledgeSource, KnowledgeWorkflowEvent } from "./types";

const { lock, enabled, source, area, audit, content, insertVersion, checkStorage, publishInTransaction } = knowledgeInternals;
function fail(code: string, message: string, status = 400): never { throw new KnowledgeCenterError(code, message, status); }
const proposalColumns = `id,source_id as "sourceId",version_id as "versionId",source_revision as "sourceRevision",area_id as "areaId",project_id as "projectId",kind,status,revision,changes,evidence,references_json as references,approval_level as "approvalLevel",reason,created_by as "createdBy",updated_by as "updatedBy",accepted_version_id as "acceptedVersionId",created_at::text as "createdAt",updated_at::text as "updatedAt"`;
const workflowColumns = `version_id as "versionId",source_id as "sourceId",state,submitted_by as "submittedBy",submitted_at::text as "submittedAt",reviewed_by as "reviewedBy",reviewed_at::text as "reviewedAt",approved_by as "approvedBy",approved_at::text as "approvedAt",published_by as "publishedBy",published_at::text as "publishedAt",revoked_by as "revokedBy",revoked_at::text as "revokedAt",reason,updated_at::text as "updatedAt"`;
const configurationColumns = `area_id as "areaId",fields,stale_after_days as "staleAfterDays",updated_by as "updatedBy",updated_at::text as "updatedAt",enabled,next_analysis_at::text as "nextAnalysisAt",last_analyzed_at::text as "lastAnalyzedAt"`;
const eventColumns = `id,source_id as "sourceId",version_id as "versionId",project_id as "projectId",event_type as "eventType",actor_id as "actorId",details,visibility,delivery_state as "deliveryState",created_at::text as "createdAt",(select u.name from workspace_users u where u.id=actor_id and u.workspace_id=knowledge_workflow_events.workspace_id) as "actorName"`;

export const defaultKnowledgeMaintenanceFields: Readonly<Record<"company" | "property", readonly KnowledgeMaintenanceField[]>> = {
  company: [{ fieldPath: "companyName", required: true, sourceTypes: ["structured"] }, { fieldPath: "description", required: true, sourceTypes: ["structured"] }],
  property: [{ fieldPath: "projectName", sourceTypes: ["structured"] }, { fieldPath: "description", required: true, sourceTypes: ["structured"] }, { fieldPath: "priceInformation", required: true, sourceTypes: ["structured"], sensitivity: "price" }, { fieldPath: "availabilityInformation", required: true, sourceTypes: ["structured"], sensitivity: "availability" }],
};

export type KnowledgeWorkflowInput = {
  action: string; sourceId?: string; versionId?: string; expectedVersion?: number; reason?: string;
  confirmCurrentness?: boolean; confirmLegal?: boolean; proposalId?: string; proposalRevision?: number;
  changes?: Partial<Pick<KnowledgeContentInput, "name" | "content" | "structuredData">>;
  areaId?: string; fields?: KnowledgeMaintenanceField[]; staleAfterDays?: number; enabled?: boolean;
};

function changes(value: unknown): KnowledgeChangeProposal["changes"] {
  const input = knowledgeStructured(value);
  if (Object.keys(input).some(key => !["name", "content", "structuredData"].includes(key))) fail("UNKNOWN_FIELD", "Only proposed name, content and structured fields may be edited.");
  return {
    ...(input.name === undefined ? {} : { name: knowledgeText(input.name, "name", 200) }),
    ...(input.content === undefined ? {} : { content: knowledgeText(input.content, "content", 150000, false) }),
    ...(input.structuredData === undefined ? {} : { structuredData: knowledgeStructured(input.structuredData) }),
  };
}
function reference(row: KnowledgeSource): KnowledgeProposalReference {
  return { sourceId: row.id, versionId: row.version!.id, sourceRevision: row.revision, contentVersion: row.version!.version, areaId: row.areaId, projectId: row.projectId };
}
async function workflow(tx: TenantTransaction, session: AppSession, versionId: string) {
  return tx.queryOne<KnowledgePublicationWorkflow>(`select ${workflowColumns} from knowledge_publication_workflows where workspace_id=$1::uuid and version_id=$2::uuid`, [session.workspaceId, versionId]);
}
export async function recordKnowledgeWorkflowEventInTransaction(tx: TenantTransaction, session: AppSession, eventType: string, row: KnowledgeSource | null, versionId: string | null, details: Record<string, unknown>) {
  const targetArea = row ? await area(tx, session, row.areaId) : typeof details.areaId === "string" ? await area(tx, session, details.areaId) : null;
  const assistants = targetArea ? await tx.query<{ id: string }>(`select distinct b.id from knowledge_area_grants g join bots b on b.id=g.bot_id and b.workspace_id=g.workspace_id where g.workspace_id=$1::uuid and g.area_id=$2::uuid`, [session.workspaceId, targetArea.id]) : [];
  const summary = { ...details, ...(targetArea ? { areaId: targetArea.id, affectedAssistantIds: assistants.map(item => item.id) } : {}) };
  await tx.execute(`insert into knowledge_workflow_events(workspace_id,source_id,version_id,project_id,event_type,actor_id,details) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::jsonb)`, [session.workspaceId, row?.id ?? null, versionId, row?.projectId ?? targetArea?.projectId ?? null, eventType, session.userId, JSON.stringify(summary)]);
  await audit(tx, session, eventType, row?.id ?? targetArea?.id ?? session.workspaceId, summary);
}
async function assertReferences(tx: TenantTransaction, session: AppSession, references: readonly KnowledgeProposalReference[]) {
  if (!Array.isArray(references) || !references.length || references.length > 500) fail("VALIDATION_ERROR", "Scoped proposal references are required.");
  const seen = new Set<string>();
  for (const ref of references) {
    if (seen.has(ref.sourceId)) fail("VALIDATION_ERROR", "Duplicate proposal reference.");
    seen.add(ref.sourceId);
    const row = await source(tx, session, knowledgeId(ref.sourceId), true);
    if (row.revision !== ref.sourceRevision || row.version?.id !== ref.versionId || row.version?.version !== ref.contentVersion || row.areaId !== ref.areaId || row.projectId !== ref.projectId) fail("STALE_PROPOSAL", "A referenced source changed. Run the analysis again.", 409);
  }
}

export type CreateKnowledgeProposalInput = {
  source: KnowledgeSource; kind: string; dedupeKey: string; changes?: KnowledgeChangeProposal["changes"]; evidence?: Record<string, unknown>;
  references?: readonly KnowledgeProposalReference[]; approvalLevel?: 1 | 2 | 3; reason?: string;
};
/** Called only inside an authenticated, tenant-bound transaction. Never changes source content or publication. */
export async function createKnowledgeProposalInTransaction(tx: TenantTransaction, session: AppSession, input: CreateKnowledgeProposalInput): Promise<KnowledgeChangeProposal> {
  requireKnowledgePermission(session, "canWrite");
  const row = await source(tx, session, input.source.id, true);
  if (row.revision !== input.source.revision || row.version?.id !== input.source.version?.id) fail("STALE_PROPOSAL", "Source changed before the proposal could be recorded.", 409);
  const proposedChanges = changes(input.changes ?? {});
  const refs = input.references ?? [reference(row)];
  if (refs.some(ref => ref.projectId !== row.projectId)) fail("VALIDATION_ERROR", "Proposal references must share the target project scope.");
  await assertReferences(tx, session, refs);
  if (!refs.some(ref => ref.sourceId === row.id && ref.versionId === row.version!.id)) fail("VALIDATION_ERROR", "Proposal must reference its target version.");
  const key = knowledgeText(input.dedupeKey, "dedupeKey", 240), kind = knowledgeText(input.kind, "kind", 80);
  const evidence = knowledgeStructured(input.evidence ?? {});
  if (JSON.stringify(evidence).length > 10000) fail("VALIDATION_ERROR", "Proposal evidence is too large.");
  const reason = knowledgeText(input.reason ?? "Interne Prüfung erforderlich", "reason", 2000);
  const level = input.approvalLevel ?? 3;
  if (![1, 2, 3].includes(level)) fail("VALIDATION_ERROR", "Invalid proposal approval level.");
  const existing = await tx.queryOne<KnowledgeChangeProposal>(`select ${proposalColumns} from knowledge_change_proposals where workspace_id=$1::uuid and dedupe_key=$2`, [session.workspaceId, key]);
  if (existing) {
    if (existing.sourceId !== row.id) fail("CONFLICT", "Proposal deduplication scope mismatch.", 409);
    return existing;
  }
  const result = await tx.queryOne<KnowledgeChangeProposal>(`insert into knowledge_change_proposals(workspace_id,source_id,version_id,source_revision,area_id,project_id,dedupe_key,kind,changes,evidence,references_json,approval_level,created_by,updated_by,reason) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13::uuid,$13::uuid,$14) returning ${proposalColumns}`, [session.workspaceId, row.id, row.version!.id, row.revision, row.areaId, row.projectId, key, kind, JSON.stringify(proposedChanges), JSON.stringify(evidence), JSON.stringify(refs), level, session.userId, reason]);
  await recordKnowledgeWorkflowEventInTransaction(tx, session, "knowledge.proposal.created", row, row.version!.id, { proposalId: result!.id, kind, approvalLevel: level });
  return result!;
}

export async function loadKnowledgeWorkflow(session: AppSession, input: { sourceId?: string } = {}, options: TenantTransactionOptions = {}) {
  // A nested transaction is avoided for version history; authorization and
  // current read happen again on every request in the tenant transaction.
  const result = await withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await enabled(tx, fresh);
    const row = input.sourceId ? await source(tx, fresh, input.sourceId) : null;
    const proposals = await tx.query<KnowledgeChangeProposal>(`select ${proposalColumns} from knowledge_change_proposals where workspace_id=$1::uuid and ($2::uuid is null or source_id=$2::uuid) order by updated_at desc limit 300`, [fresh.workspaceId, row?.id ?? null]);
    const events = await tx.query<KnowledgeWorkflowEvent>(`select ${eventColumns} from knowledge_workflow_events where workspace_id=$1::uuid and ($2::uuid is null or source_id=$2::uuid) order by created_at desc,id desc limit 100`, [fresh.workspaceId, row?.id ?? null]);
    const configurations = await tx.query<KnowledgeMaintenanceConfiguration>(`select ${configurationColumns} from knowledge_maintenance_configurations where workspace_id=$1::uuid and ($2::uuid is null or area_id=$2::uuid)`, [fresh.workspaceId, row?.areaId ?? null]);
    if (row && !configurations.length) {
      const targetArea = await area(tx, fresh, row.areaId);
      configurations.push({ areaId: row.areaId, fields: [...defaultKnowledgeMaintenanceFields[targetArea.kind === "project" ? "property" : "company"]], staleAfterDays: 90, updatedBy: null, updatedAt: null, enabled: false, nextAnalysisAt: null, lastAnalyzedAt: null, isDefault: true });
    }
    const currentWorkflow = row?.version ? await workflow(tx, fresh, row.version.id) : null;
    const workflowStates = await tx.query<{ sourceId: string; versionId: string; state: string }>(`select w.source_id as "sourceId",w.version_id as "versionId",w.state from knowledge_publication_workflows w join knowledge_sources s on s.id=w.source_id and s.workspace_id=w.workspace_id where w.workspace_id=$1::uuid and w.version_id=coalesce(s.draft_version_id,s.approved_version_id)`, [fresh.workspaceId]);
    if (row) row.workflowState = currentWorkflow?.state ?? (row.draftVersionId ? row.version?.provenance?.kind === "revocation" ? "revoked" : "draft" : "published");
    return { ...(row ? { source: row, workflow: currentWorkflow } : {}), proposals, events, configurations, workflowStates };
  }, options);
  if (input.sourceId) return { ...result, versions: await listKnowledgeVersions(session, { sourceId: input.sourceId }, options) };
  return { ...result, versions: [] };
}

async function newDraft(tx: TenantTransaction, session: AppSession, row: KnowledgeSource, draftChanges: KnowledgeChangeProposal["changes"], reason: string, provenance: Record<string, unknown>, restoreVersionId?: string) {
  const old = restoreVersionId
    ? await tx.queryOne<{ name: string; content: string; structuredData: Record<string,unknown>; url: string | null; mediaAssetId: string | null; processingStatus: "manual" | "ready" | "needs_ocr" | "failed"; processingMessage: string | null; processingFormat: "pdf" | "docx" | "text" | "image" | null; hash: string | null; code: string | null }>(`select name,content,structured_data as "structuredData",source_url as url,media_asset_id as "mediaAssetId",processing_status as "processingStatus",processing_message as "processingMessage",processing_format as "processingFormat",document_sha256 as hash,processing_error_code as code from knowledge_source_versions where id=$1::uuid and source_id=$2::uuid and workspace_id=$3::uuid`, [restoreVersionId, row.id, session.workspaceId])
    : row.version;
  if (!old) fail("NOT_FOUND", "Historical source version is unavailable.", 404);
  const data = await content(tx, session, row.type, { name: draftChanges.name ?? old.name, content: draftChanges.content ?? old.content, structuredData: draftChanges.structuredData ?? old.structuredData, url: old.url, mediaAssetId: old.mediaAssetId }, row.id);
  const parser = old.mediaAssetId ? await tx.queryOne<{ status: "manual" | "ready" | "needs_ocr" | "failed"; message: string | null; format: "pdf" | "docx" | "text" | "image" | null; hash: string | null; code: string | null }>(`select processing_status as status,processing_message as message,processing_format as format,document_sha256 as hash,processing_error_code as code from knowledge_source_versions where id=$1::uuid and source_id=$2::uuid and workspace_id=$3::uuid`, [restoreVersionId ?? row.version!.id, row.id, session.workspaceId]) : undefined;
  const versionNumber = await tx.queryOne<{ next: number }>(`select coalesce(max(version),0)+1 as next from knowledge_source_versions where source_id=$1::uuid and workspace_id=$2::uuid`, [row.id, session.workspaceId]);
  const versionId = await insertVersion(tx, session, row.id, versionNumber!.next, data, parser ?? undefined, { reason, provenance: { ...provenance, trust: "untrusted_source_data" } });
  await tx.execute(`update knowledge_sources set draft_version_id=$1::uuid,kc_revision=kc_revision+1,status='needs-review',updated_at=now() where id=$2::uuid and workspace_id=$3::uuid and kc_revision=$4`, [versionId, row.id, session.workspaceId, row.revision]);
  return source(tx, session, row.id, true);
}

function validatedFields(value: unknown): KnowledgeMaintenanceField[] {
  if (!Array.isArray(value) || value.length > 50 || value.some(field => !field || typeof field !== "object" || Array.isArray(field) || Object.keys(field).some(key => !["fieldPath", "required", "sourceTypes", "sensitivity", "compareAs"].includes(key)))) fail("VALIDATION_ERROR", "Invalid maintenance fields.");
  const fields = JSON.parse(JSON.stringify(value)) as KnowledgeMaintenanceField[];
  try { analyzeKnowledgeMaintenance({ workspaceId: "00000000-0000-4000-8000-000000000000", now: new Date().toISOString(), visibleSources: [], fields, staleAfterDays: 90 }); }
  catch { fail("VALIDATION_ERROR", "Invalid maintenance fields."); }
  return fields;
}

async function analyze(tx: TenantTransaction, session: AppSession, areaId?: string, at?: string) {
  if (areaId) await area(tx, session, areaId, true);
  const ids = await tx.query<{ id: string; areaId: string }>(`select id,knowledge_area_id as "areaId" from knowledge_sources where workspace_id=$1::uuid and knowledge_area_id is not null and archived_at is null and ($2::uuid is null or knowledge_area_id=$2::uuid) order by id limit 500`, [session.workspaceId, areaId ?? null]);
  const groups = new Map<string, KnowledgeSource[]>();
  for (const item of ids) { const row = await source(tx, session, item.id, true); groups.set(row.areaId, [...groups.get(row.areaId) ?? [], row]); }
  const proposals: KnowledgeChangeProposal[] = [];
  const now = at ?? new Date().toISOString();
  for (const [targetId, rows] of groups) {
    const target = await area(tx, session, targetId, true);
    const config = await tx.queryOne<KnowledgeMaintenanceConfiguration>(`select ${configurationColumns} from knowledge_maintenance_configurations where workspace_id=$1::uuid and area_id=$2::uuid`, [session.workspaceId, targetId]);
    const fields = config?.fields ?? [...defaultKnowledgeMaintenanceFields[target.kind === "project" ? "property" : "company"]];
    // Subject identity comes from scoped records, never from imported prose or
    // structured source instructions. Different property sources stay distinct.
    const visibleSources: KnowledgeMaintenanceSource[] = rows.map(row => ({ workspaceId: session.workspaceId, accessConfirmed: true, subjectId: target.kind === "project" ? row.id : session.workspaceId, source: { ...row, version: row.version ? { ...row.version, createdAt: new Date(row.version.createdAt).toISOString(), approvedAt: row.version.approvedAt ? new Date(row.version.approvedAt).toISOString() : null } : null }, provenance: { origin: row.type === "url" ? "website" : row.type === "file" ? "document" : "manual" } }));
    const result = analyzeKnowledgeMaintenance({ workspaceId: session.workspaceId, now, visibleSources, fields, staleAfterDays: config?.staleAfterDays ?? 90 });
    for (const proposed of result.proposals) {
      const row = rows.find(candidate => candidate.id === proposed.references[0].sourceId)!;
      proposals.push(await createKnowledgeProposalInTransaction(tx, session, { source: row, kind: proposed.kind, dedupeKey: proposed.id, references: proposed.references, approvalLevel: proposed.approvalLevel, evidence: { ...proposed.evidence, fieldPaths: proposed.fieldPaths, action: proposed.action, review: proposed.review, evaluatedAt: proposed.evaluatedAt }, reason: "Deterministische Wissensprüfung" }));
    }
  }
  return { proposals, analyzedSourceCount: ids.length, evaluatedAt: now };
}

export async function executeKnowledgeWorkflow(session: AppSession, input: KnowledgeWorkflowInput, options: TenantTransactionOptions = {}) {
  const actions = ["submit", "review", "approve", "publish", "restore", "revoke", "proposal-edit", "proposal-accept", "proposal-reject", "proposal-defer", "analyze", "configure"];
  if (!actions.includes(input.action)) fail("VALIDATION_ERROR", "Unknown knowledge workflow action.");
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite"); await lock(tx, fresh); const contract = await enabled(tx, fresh);
    if (input.action === "analyze") {
      if (contract.features.advancedMaintenance !== true) fail("ENTITLEMENT_REQUIRED", "Advanced knowledge maintenance is not enabled.", 403);
      return analyze(tx, fresh, input.areaId ? knowledgeId(input.areaId, "areaId") : undefined);
    }
    const reason = knowledgeText(input.reason, "reason", 2000);
    if (input.action === "configure") {
      requireKnowledgePermission(fresh, "canPublish");
      const target = await area(tx, fresh, knowledgeId(input.areaId, "areaId"), true);
      const fields = validatedFields(input.fields), days = input.staleAfterDays;
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") fail("VALIDATION_ERROR", "Invalid automation setting.");
      const active = input.enabled ?? false;
      if (!Number.isSafeInteger(days) || days! < 1 || days! > 36500) fail("VALIDATION_ERROR", "Invalid review interval.");
      await tx.execute(`insert into knowledge_maintenance_configurations(workspace_id,area_id,fields,stale_after_days,updated_by,enabled,next_analysis_at) values($1::uuid,$2::uuid,$3::jsonb,$4,$5::uuid,$6,case when $6 then now() else null end) on conflict(area_id) do update set fields=excluded.fields,stale_after_days=excluded.stale_after_days,updated_by=excluded.updated_by,enabled=excluded.enabled,next_analysis_at=excluded.next_analysis_at,updated_at=now()`, [fresh.workspaceId, target.id, JSON.stringify(fields), days, fresh.userId, active]);
      await recordKnowledgeWorkflowEventInTransaction(tx, fresh, "knowledge.maintenance.configured", null, null, { areaId: target.id, reason, fieldCount: fields.length, staleAfterDays: days, enabled: active });
      return { configuration: { areaId: target.id, fields, staleAfterDays: days, enabled: active } };
    }
    if (input.action.startsWith("proposal-")) {
      const proposalId = knowledgeId(input.proposalId, "proposalId"), revision = knowledgeRevision(input.proposalRevision);
      const proposal = await tx.queryOne<KnowledgeChangeProposal>(`select ${proposalColumns} from knowledge_change_proposals where id=$1::uuid and workspace_id=$2::uuid for update`, [proposalId, fresh.workspaceId]);
      if (!proposal) fail("NOT_FOUND", "Knowledge proposal is unavailable.", 404);
      if (proposal.revision !== revision || !["open", "deferred"].includes(proposal.status)) fail("VERSION_CONFLICT", "The proposal changed. Reload before deciding.", 409);
      const row = await source(tx, fresh, proposal.sourceId, true);
      let updatedSource: KnowledgeSource | undefined;
      let proposedChanges = proposal.changes, status = proposal.status;
      if (["proposal-edit", "proposal-accept"].includes(input.action)) await assertReferences(tx, fresh, proposal.references);
      if (input.action === "proposal-edit") proposedChanges = changes(input.changes);
      if (input.action === "proposal-accept") {
        if (row.revision !== proposal.sourceRevision || row.version?.id !== proposal.versionId) fail("STALE_PROPOSAL", "The source changed. Run analysis again.", 409);
        updatedSource = await newDraft(tx, fresh, row, proposedChanges, reason, { kind: "proposal", proposalId: proposal.id, basedOnVersionId: proposal.versionId });
        await checkStorage(tx, fresh, contract); status = "accepted";
      }
      if (input.action === "proposal-reject") status = "rejected";
      if (input.action === "proposal-defer") status = "deferred";
      const updated = await tx.queryOne<KnowledgeChangeProposal>(`update knowledge_change_proposals set status=$1,revision=revision+1,changes=$2::jsonb,reason=$3,updated_by=$4::uuid,accepted_version_id=$5::uuid where id=$6::uuid and workspace_id=$7::uuid and revision=$8 returning ${proposalColumns}`, [status, JSON.stringify(proposedChanges), reason, fresh.userId, updatedSource?.draftVersionId ?? null, proposal.id, fresh.workspaceId, revision]);
      await recordKnowledgeWorkflowEventInTransaction(tx, fresh, `knowledge.${input.action.replaceAll("-", ".")}`, row, proposal.versionId, { proposalId: proposal.id, reason, acceptedVersionId: updatedSource?.draftVersionId ?? null });
      return { proposal: updated!, ...(updatedSource ? { source: updatedSource } : {}) };
    }
    const row = await source(tx, fresh, knowledgeId(input.sourceId, "sourceId"), true);
    const expected = knowledgeRevision(input.expectedVersion), versionId = knowledgeId(input.versionId, "versionId");
    if (row.revision !== expected) fail("VERSION_CONFLICT", "The source changed. Reload before continuing.", 409);
    if (input.action === "restore") {
      if (input.confirmCurrentness !== true || input.confirmLegal !== true) fail("CONFIRMATION_REQUIRED", "Confirm currentness and legal validity before restoring historical content.", 409);
      const restored = await newDraft(tx, fresh, row, {}, reason, { kind: "restoration", restoredVersionId: versionId, confirmedCurrentness: true, confirmedLegal: true }, versionId);
      await checkStorage(tx, fresh, contract);
      await recordKnowledgeWorkflowEventInTransaction(tx, fresh, "knowledge.version.restored", restored, restored.draftVersionId, { reason, restoredVersionId: versionId, newVersionId: restored.draftVersionId });
      return { source: restored };
    }
    if (input.action === "revoke") {
      requireKnowledgePermission(fresh, "canPublish");
      if (row.approvedVersionId !== versionId) fail("VERSION_CONFLICT", "Only the active publication can be revoked.", 409);
      const liveWorkflow = await workflow(tx, fresh, versionId);
      if (liveWorkflow?.state === "published") await tx.execute(`update knowledge_publication_workflows set state='revoked',revoked_by=$1::uuid,reason=$2 where workspace_id=$3::uuid and version_id=$4::uuid`, [fresh.userId, reason, fresh.workspaceId, versionId]);
      // Keep a reviewable draft available to editors when withdrawing a legacy
      // source with no pending draft. All prior versions stay immutable.
      let restored = row;
      if (!row.draftVersionId) restored = await newDraft(tx, fresh, row, {}, reason, { kind: "revocation", basedOnVersionId: versionId });
      await tx.execute(`update knowledge_sources set approved_version_id=null,status='needs-review',item_count=0,kc_revision=kc_revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid`, [row.id, fresh.workspaceId]);
      await tx.execute(`delete from knowledge_chunks where source_id=$1::uuid`, [row.id]);
      await recordKnowledgeWorkflowEventInTransaction(tx, fresh, "knowledge.publication.revoked", row, versionId, { reason, previousApprovedVersionId: versionId, draftVersionId: restored.draftVersionId });
      return { source: await source(tx, fresh, row.id, true) };
    }
    if (row.draftVersionId !== versionId) fail("VERSION_CONFLICT", "Only the current draft may move through review.", 409);
    const current = await workflow(tx, fresh, versionId);
    if (input.action === "submit") {
      if (current) fail("WORKFLOW_CONFLICT", "This draft was already submitted.", 409);
      if (["needs_ocr", "failed"].includes(row.version!.processingStatus)) fail("DOCUMENT_NOT_READY", "Document extraction must finish before review.", 409);
      await tx.execute(`insert into knowledge_publication_workflows(workspace_id,source_id,version_id,state,submitted_by,reason) values($1::uuid,$2::uuid,$3::uuid,'submitted',$4::uuid,$5)`, [fresh.workspaceId, row.id, versionId, fresh.userId, reason]);
    } else if (input.action === "review") {
      if (current?.state !== "submitted") fail("WORKFLOW_CONFLICT", "Submit the current draft before recording review.", 409);
      await tx.execute(`update knowledge_publication_workflows set state='reviewed',reviewed_by=$1::uuid,reason=$2 where workspace_id=$3::uuid and version_id=$4::uuid`, [fresh.userId, reason, fresh.workspaceId, versionId]);
    } else if (input.action === "approve") {
      requireKnowledgePermission(fresh, "canPublish");
      if (current?.state !== "reviewed") fail("WORKFLOW_CONFLICT", "Complete the review before approval.", 409);
      await tx.execute(`update knowledge_publication_workflows set state='approved',approved_by=$1::uuid,reason=$2 where workspace_id=$3::uuid and version_id=$4::uuid`, [fresh.userId, reason, fresh.workspaceId, versionId]);
    } else if (input.action === "publish") {
      requireKnowledgePermission(fresh, "canPublish");
      if (current?.state !== "approved") fail("WORKFLOW_CONFLICT", "Review and approve the current draft before publication.", 409);
      const published = await publishInTransaction(tx, fresh, row, versionId);
      await tx.execute(`update knowledge_publication_workflows set state='published',published_by=$1::uuid,reason=$2 where workspace_id=$3::uuid and version_id=$4::uuid`, [fresh.userId, reason, fresh.workspaceId, versionId]);
      await recordKnowledgeWorkflowEventInTransaction(tx, fresh, "knowledge.publication.published", row, versionId, { reason });
      return { source: published, workflow: await workflow(tx, fresh, versionId) };
    }
    await recordKnowledgeWorkflowEventInTransaction(tx, fresh, `knowledge.publication.${input.action === "submit" ? "submitted" : input.action === "review" ? "reviewed" : "approved"}`, row, versionId, { reason });
    return { source: row, workflow: await workflow(tx, fresh, versionId) };
  }, options);
}

/** Stable content fingerprint for trusted local integrations; source data never controls approval. */
export function knowledgeProposalDigest(value: string) { return createHash("sha256").update(value).digest("hex"); }

/** Explicitly invoked scoped adapter. Installation never activates a production schedule. */
export async function runConfiguredKnowledgeMaintenance(session: AppSession, input: { now?: string } = {}, options: TenantTransactionOptions = {}) {
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) fail("VALIDATION_ERROR", "Invalid maintenance clock.");
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canPublish"); await lock(tx, fresh);
    const contract = await enabled(tx, fresh);
    if (contract.features.advancedMaintenance !== true) return { analyzedAreaCount: 0, proposals: [] };
    const due = await tx.query<{ areaId: string }>(`select area_id as "areaId" from knowledge_maintenance_configurations where workspace_id=$1::uuid and enabled and (next_analysis_at is null or next_analysis_at<=$2::timestamptz) order by next_analysis_at nulls first,area_id limit 20 for update skip locked`, [fresh.workspaceId, now]);
    const proposals: KnowledgeChangeProposal[] = [];
    for (const configuration of due) {
      const target = await area(tx, fresh, configuration.areaId, true);
      const result = await analyze(tx, fresh, target.id, now);
      proposals.push(...result.proposals);
      await tx.execute(`update knowledge_maintenance_configurations set last_analyzed_at=$1::timestamptz,next_analysis_at=$1::timestamptz+interval '1 day',updated_by=$2::uuid where workspace_id=$3::uuid and area_id=$4::uuid and enabled`, [now, fresh.userId, fresh.workspaceId, target.id]);
      await recordKnowledgeWorkflowEventInTransaction(tx, fresh, "knowledge.maintenance.completed", null, null, { areaId: target.id, analyzedSourceCount: result.analyzedSourceCount, proposalCount: result.proposals.length });
    }
    return { analyzedAreaCount: due.length, proposals };
  }, options);
}
