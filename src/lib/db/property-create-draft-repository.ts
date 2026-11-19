import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, crmPayloadDigest, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { hasProductCapability } from "@/lib/product-model";
import { parsePropertyCreationDraft, propertyCreationIssues, propertyCreationPayload, type PropertyCreationDraftRecord } from "@/lib/property-create-draft";
import { createSellerListingRecord } from "./property-department-repositories";

const columns = `id,draft,step,revision,status,created_property_id as "propertyId",updated_at::text as "updatedAt"`;
function authority(session: AppSession) { if (session.serviceIdentity || session.productRole === "external_partner" || !session.permissions.includes("crm:write") || !hasProductCapability(session.productRole, "workspace:operate")) throw new CrmCommandError("FORBIDDEN", "Objektanlage ist für diese Mitgliedschaft nicht freigegeben", 403); }
export async function loadPropertyCreationDrafts(tx: TenantTransaction, session: AppSession) {
  authority(session);
  const projects = await tx.query<{ id: string; name: string }>(`select id,name from projects where workspace_id=$1::uuid and crm_project_access(workspace_id,id,true) order by name limit 250`, [session.workspaceId]);
  const drafts = await tx.query<PropertyCreationDraftRecord>(`select ${columns} from crm_property_creation_drafts where workspace_id=$1::uuid and user_id=$2::uuid and status='active' order by updated_at desc limit 25`, [session.workspaceId, session.userId]);
  return { projects, drafts: drafts.map(row => ({ ...row, issues: propertyCreationIssues(row.draft) })) };
}
export async function savePropertyCreationDraft(tx: TenantTransaction, session: AppSession, input: { id: unknown; draft: unknown; step: unknown; expectedRevision: unknown; requestId: unknown; discard?: boolean }) {
  authority(session);
  const id = assertCrmUuid(input.id), requestId = assertCrmUuid(input.requestId);
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || !Number.isSafeInteger(input.step) || Number(input.step) < 0 || Number(input.step) > 3) throw new CrmCommandError("INVALID_DRAFT_VERSION", "Entwurfsversion und Schritt prüfen");
  let draft;
  try { draft = parsePropertyCreationDraft(input.draft); } catch (error) { throw new CrmCommandError("INVALID_DRAFT", error instanceof Error ? error.message : "Objektentwurf prüfen"); }
  if (draft.projectId) await assertProjectGrant(tx, session, draft.projectId, true);
  const hash = crmPayloadDigest({ draft, step: input.step, expectedRevision: input.expectedRevision, discard: input.discard === true });
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`property-drafts:${session.workspaceId}:${session.userId}`]);
  const prior = await tx.queryOne<PropertyCreationDraftRecord & { requestId: string; hash: string }>(`select ${columns},last_request_id as "requestId",last_request_hash as hash from crm_property_creation_drafts where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid for update`, [id, session.workspaceId, session.userId]);
  if (prior?.requestId === requestId) { if (prior.hash !== hash) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Vorgangskennung gehört zu einem anderen Entwurf", 409); return { ...prior, issues: propertyCreationIssues(prior.draft), replayed: true }; }
  if ((prior?.revision ?? 0) !== input.expectedRevision || (prior && prior.status !== "active")) throw new CrmCommandError("DRAFT_CONFLICT", "Der Entwurf wurde geändert oder abgeschlossen. Bitte neu laden.", 409);
  if (!prior && input.discard) throw new CrmCommandError("DRAFT_NOT_FOUND", "Gespeicherter Entwurf fehlt", 404);
  if (!prior && Number((await tx.queryOne<{ count: string }>(`select count(*) from crm_property_creation_drafts where workspace_id=$1::uuid and user_id=$2::uuid and status='active'`, [session.workspaceId, session.userId]))?.count) >= 25) throw new CrmCommandError("DRAFT_LIMIT", "Zuerst einen der 25 offenen Entwürfe abschließen oder verwerfen", 409);
  const params = [id, session.workspaceId, session.userId, draft.projectId || null, JSON.stringify(draft), input.step, requestId, hash, input.discard ? "discarded" : "active"];
  const row = prior ? await tx.queryOne<PropertyCreationDraftRecord>(`update crm_property_creation_drafts set project_id=$4::uuid,draft=$5::jsonb,step=$6,revision=revision+1,last_request_id=$7::uuid,last_request_hash=$8,status=$9,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid returning ${columns}`, params) : await tx.queryOne<PropertyCreationDraftRecord>(`insert into crm_property_creation_drafts(id,workspace_id,user_id,project_id,draft,step,last_request_id,last_request_hash,status) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8,$9) returning ${columns}`, params);
  if (!row) throw new CrmCommandError("DRAFT_UNCONFIRMED", "Entwurfsspeicherung nicht bestätigt", 503);
  return { ...row, issues: propertyCreationIssues(row.draft), replayed: false };
}
export async function completePropertyCreationDraft(session: AppSession, input: { id: unknown; expectedRevision: unknown }, metadata: { idempotencyKey: string; correlationId: string }, options?: TenantTransactionOptions) {
  const id = assertCrmUuid(input.id);
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) throw new CrmCommandError("INVALID_DRAFT_VERSION", "Gespeicherte Entwurfsversion erforderlich");
  return withCrmRead(session, async (tx, fresh) => {
    authority(fresh);
    // Check ownership before the generic command receipt lookup, including every retry.
    const row = await tx.queryOne<PropertyCreationDraftRecord>(`select ${columns} from crm_property_creation_drafts where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid for update`, [id, fresh.workspaceId, fresh.userId]);
    if (!row || row.status === "discarded") throw new CrmCommandError("DRAFT_NOT_FOUND", "Eigener freigegebener Entwurf fehlt", 404);
    if (!row.draft.projectId) throw new CrmCommandError("INVALID_DRAFT", "Projekt auswählen");
    return executeCrmCommand(fresh, { ...metadata, operation: "property.complete_draft", resourceId: id, projectId: row.draft.projectId, capability: "workspace:operate", payload: { draftId: id, expectedRevision: input.expectedRevision } }, async (_tx, context) => {
      if (row.status !== "active" || row.revision !== input.expectedRevision) throw new CrmCommandError("DRAFT_CONFLICT", row.propertyId ? "Objekt bereits angelegt. Bitte Objektliste neu laden." : "Entwurf wurde geändert. Bitte neu laden.", 409);
      let property;
      try { property = propertyCreationPayload(row.draft); } catch (error) { throw new CrmCommandError("DRAFT_INCOMPLETE", error instanceof Error ? error.message : "Pflichtangaben ergänzen"); }
      const result = await createSellerListingRecord({ session: context.session, property });
      if (!result.persisted) throw new CrmCommandError("PROPERTY_CREATE_FAILED", result.reason, 503);
      const saved = await tx.queryOne(`update crm_property_creation_drafts set status='created',created_property_id=$4::uuid,revision=revision+1,step=3,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and status='active' and revision=$5 returning id`, [id, fresh.workspaceId, fresh.userId, result.data.id, row.revision]);
      if (!saved) throw new CrmCommandError("DRAFT_CONFLICT", "Objektanlage nicht bestätigt", 409);
      return result.data;
    });
  }, options);
}
