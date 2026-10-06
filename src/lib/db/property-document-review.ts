import type { AppSession } from "@/lib/auth/session";
import { queryOne } from "@/lib/db/client";
import { canPersist, isUuid } from "@/lib/db/runtime-repositories";
import { hasProductCapability } from "@/lib/product-model";

export function canReviewPropertyDocuments(session: AppSession): boolean {
  return session.permissions.includes("crm:write") && (session.role === "owner" || session.role === "admin" ||
    hasProductCapability(session.productRole, "settings:manage") ||
    hasProductCapability(session.productRole, "workspace:admin"));
}

type ReviewRow = {
  id: string; workspaceId: string; projectId: string | null; propertyId: string;
  status: "approved" | "needs_review"; visibility: string;
  approvedByUserId: string | null; approvedAt: string | Date | null; updatedAt: string | Date;
};

type ReviewResult =
  | { persisted: true; data: Omit<ReviewRow, "approvedAt" | "updatedAt"> & { approvedAt: string | null; updatedAt: string } }
  | { persisted: false; reason: string; status: 400 | 403 | 409 | 503 };

/** Internal approval only. This operation neither publishes nor revokes public access. */
export async function reviewPropertyDocument(input: {
  session: AppSession;
  propertyId: unknown;
  projectId: unknown;
  documentId: unknown;
  mediaAssetId: unknown;
  expectedStatus: unknown;
  expectedUpdatedAt: unknown;
  action: unknown;
}): Promise<ReviewResult> {
  if (!canReviewPropertyDocuments(input.session)) {
    return { persisted: false, reason: "Document review requires crm:write and an administrator role", status: 403 };
  }
  const validId = (value: unknown): value is string => typeof value === "string" && isUuid(value);
  if (![input.session.workspaceId, input.session.userId, input.propertyId, input.documentId, input.mediaAssetId].every(validId) ||
    (input.projectId !== null && !validId(input.projectId)) ||
    typeof input.expectedUpdatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.expectedUpdatedAt) ||
    !Number.isFinite(Date.parse(input.expectedUpdatedAt)) ||
    new Date(input.expectedUpdatedAt).toISOString() !== input.expectedUpdatedAt ||
    !((input.action === "approve" && (input.expectedStatus === "draft" || input.expectedStatus === "needs_review")) ||
      (input.action === "revoke" && input.expectedStatus === "approved"))) {
    return { persisted: false, reason: "Invalid document review target, version or transition", status: 400 };
  }
  if (!canPersist()) return { persisted: false, reason: "Database persistence is not configured", status: 503 };

  const nextStatus = input.action === "approve" ? "approved" : "needs_review";
  // Scope, version and non-public lifecycle are rechecked in the statement that
  // updates the document. Audit insertion is atomic with the status change.
  const row = await queryOne<ReviewRow>(`
    with reviewed as (
      update property_documents d
      set status = $8,
        approved_by_user_id = case when $8 = 'approved' then $9::uuid else null end,
        approved_at = case when $8 = 'approved' then clock_timestamp() else null end,
        updated_at = greatest(clock_timestamp(), date_trunc('milliseconds', d.updated_at) + interval '1 millisecond')
      from seller_listings p, media_assets ma
      where d.id = $1::uuid and d.workspace_id = $2::uuid
        and d.property_id = $3::uuid and p.id = d.property_id and p.workspace_id = d.workspace_id
        and d.project_id is not distinct from $4::uuid
        and p.project_id is not distinct from d.project_id
        and (p.project_id is null or exists (
          select 1 from projects project where project.id = p.project_id and project.workspace_id = p.workspace_id
        ))
        and d.media_asset_id = $5::uuid and ma.id = d.media_asset_id and ma.workspace_id = d.workspace_id::text
        and (ma.folder !~* '^properties/' or lower(ma.folder) = 'properties/' || p.id::text)
        and d.status = $6 and date_trunc('milliseconds', d.updated_at) = $7::timestamptz
        and d.visibility in ('private', 'internal') and d.sent_at is null
        and ma.is_public = false and ma.storage_access = 'private' and ma.public_token is null
        and not exists (
          select 1 from media_asset_shares share
          where share.asset_id = ma.id and share.workspace_id = ma.workspace_id
            and share.revoked_at is null and share.expires_at > now()
        )
        and exists (select 1 from workspace_users actor where actor.id = $9::uuid and actor.workspace_id = d.workspace_id)
      returning d.id, d.workspace_id, d.project_id, d.property_id, d.title, d.status, d.visibility,
        d.approved_by_user_id, d.approved_at, d.updated_at
    ), activity as (
      insert into property_activity_events (
        workspace_id, project_id, property_id, actor_user_id, event_type, title, detail, metadata
      )
      select workspace_id, project_id, property_id, $9::uuid, $10, $11, title,
        jsonb_build_object('documentId', id, 'previousStatus', $6::text, 'status', status, 'internalOnly', true)
      from reviewed returning id
    )
    select reviewed.id, workspace_id as "workspaceId", project_id as "projectId", property_id as "propertyId",
      status, visibility, approved_by_user_id as "approvedByUserId", approved_at as "approvedAt", updated_at as "updatedAt"
    from reviewed where exists (select 1 from activity)
  `, [
    input.documentId, input.session.workspaceId, input.propertyId, input.projectId, input.mediaAssetId,
    input.expectedStatus, input.expectedUpdatedAt, nextStatus, input.session.userId,
    input.action === "approve" ? "property.document.internally_approved" : "property.document.internal_approval_revoked",
    input.action === "approve" ? "Dokument intern freigegeben" : "Interne Dokumentfreigabe zurückgenommen",
  ]);
  if (!row) return {
    persisted: false, status: 409,
    reason: "Document changed, target is unavailable, or public/sent/archived lifecycle requires separate handling; reload before retrying",
  };
  return {
    persisted: true,
    data: { ...row, updatedAt: new Date(row.updatedAt).toISOString(), approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null },
  };
}
