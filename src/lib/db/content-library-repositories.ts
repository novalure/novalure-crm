import "server-only";

import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import {
  canonicalJson,
  type AddDocumentVersionInput,
  type AddTemplateVersionInput,
  type ApprovalStatus,
  type CreateDocumentInput,
  type CreateTemplateInput,
  type DocumentLinkInput,
  type DocumentVisibility,
} from "@/lib/content-library";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { withTenantTransaction, type TenantTransaction } from "@/lib/db/tenant-client";
import { findWorkspaceMediaAsset, listWorkspaceMedia } from "@/lib/media-store";
import { hasProductCapability } from "@/lib/product-model";

export type ContentRepositoryErrorCode =
  | "CONFLICT"
  | "FORBIDDEN"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "PERSISTENCE_UNAVAILABLE"
  | "REFERENCE_BLOCKED";

export class ContentRepositoryError extends Error {
  constructor(readonly code: ContentRepositoryErrorCode, message: string) {
    super(message);
    this.name = "ContentRepositoryError";
  }
}

type DateValue = Date | string;

type DocumentRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  title: string;
  category: string;
  tags: string[];
  visibility: DocumentVisibility;
  approvalStatus: ApprovalStatus;
  approvedByUserId: string | null;
  approvedAt: DateValue | null;
  currentVersionNumber: number;
  archivedAt: DateValue | null;
  archiveReason: string | null;
  retentionReviewAt: DateValue | null;
  createdAt: DateValue;
  updatedAt: DateValue;
};

type DocumentVersionRow = {
  id: string;
  versionNumber: number;
  mediaAssetId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | string;
  checksumSha256: string | null;
  changeNote: string;
  createdByUserId: string | null;
  createdAt: DateValue;
};

type ContentLinkRow = {
  id: string;
  targetType: string;
  targetId: string;
  projectId: string | null;
  createdAt: DateValue;
};

type TemplateRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  name: string;
  channel: string;
  purpose: string;
  defaultLanguage: string;
  approvalStatus: ApprovalStatus;
  approvedByUserId: string | null;
  approvedAt: DateValue | null;
  currentVersionNumber: number;
  archivedAt: DateValue | null;
  archiveReason: string | null;
  createdAt: DateValue;
  updatedAt: DateValue;
};

type TemplateVersionRow = {
  id: string;
  versionNumber: number;
  language: string;
  subject: string;
  body: string;
  allowedVariables: string[];
  variableFallbacks: Record<string, string>;
  structuredContent: Record<string, unknown>;
  changeNote: string;
  createdByUserId: string | null;
  createdAt: DateValue;
};

type MediaAssetRow = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string | number;
};

type MutationRequestRow = {
  requestHash: string;
  responsePayload: unknown;
};

export type SafeMutationClaim =
  | Readonly<{ kind: "claimed"; requestHash: string }>
  | Readonly<{ kind: "replayed"; response: unknown }>;

function iso(value: DateValue | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberValue(value: number | string) {
  return typeof value === "number" ? value : Number(value);
}

function mapDocument(row: DocumentRow) {
  return {
    ...row,
    archivedAt: iso(row.archivedAt),
    approvedAt: iso(row.approvedAt),
    retentionReviewAt: iso(row.retentionReviewAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function mapDocumentVersion(row: DocumentVersionRow) {
  return {
    ...row,
    sizeBytes: numberValue(row.sizeBytes),
    createdAt: iso(row.createdAt)!,
  };
}

function mapTemplate(row: TemplateRow) {
  return {
    ...row,
    archivedAt: iso(row.archivedAt),
    approvedAt: iso(row.approvedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function mapTemplateVersion(row: TemplateVersionRow) {
  return { ...row, createdAt: iso(row.createdAt)! };
}

function assertPersistence() {
  if (!canPersist()) {
    throw new ContentRepositoryError("PERSISTENCE_UNAVAILABLE", "Content persistence is unavailable");
  }
}

export function canManageContent(session: AppSession) {
  return session.role === "owner"
    || session.role === "admin"
    || hasProductCapability(session.productRole, "settings:manage");
}

function projectPipelineEditGrantSql(
  workspaceExpression: string,
  projectExpression: string,
  actorParameter: string,
) {
  return `exists (
    select 1
      from project_pipeline_permissions project_grant
      join workspace_users project_actor
        on project_actor.workspace_id = project_grant.workspace_id
       and project_actor.id = project_grant.user_id
     where project_grant.workspace_id = ${workspaceExpression}
       and project_grant.project_id = ${projectExpression}
       and project_grant.user_id = ${actorParameter}::uuid
       and project_grant.can_edit_deals = true
       and project_actor.status = 'active'
       and project_actor.product_role in ('developer_sales', 'project_sales_member')
  )`;
}

function activeWorkspaceActorSql(workspaceExpression: string, actorParameter: string) {
  return `exists (
    select 1
      from workspace_users content_actor
     where content_actor.workspace_id = ${workspaceExpression}
       and content_actor.id = ${actorParameter}::uuid
       and content_actor.status = 'active'
  )`;
}

function activeInternalActorSql(workspaceExpression: string, actorParameter: string) {
  return `exists (
    select 1
      from workspace_users internal_actor
     where internal_actor.workspace_id = ${workspaceExpression}
       and internal_actor.id = ${actorParameter}::uuid
       and internal_actor.status = 'active'
       and internal_actor.product_role not in ('external_partner', 'viewer')
  )`;
}

function activeCustomerProjectAccessSql(
  workspaceExpression: string,
  projectExpression: string,
  actorParameter: string,
) {
  return `exists (
    select 1
      from customer_project_access customer_access
      join workspace_users customer_actor
        on customer_actor.workspace_id = customer_access.workspace_id
       and customer_actor.id = customer_access.user_id
       and customer_actor.status = 'active'
     where customer_access.workspace_id = ${workspaceExpression}
       and customer_access.project_id = ${projectExpression}
       and customer_access.user_id = ${actorParameter}::uuid
       and customer_access.status = 'active'
       and customer_access.can_view_project = true
  )`;
}

/**
 * Canonical server-side document visibility policy. Keep this shared with
 * global search and media-reference authorization so metadata and file bytes
 * cannot drift into different access scopes.
 */
export function contentDocumentReadAccessSql(
  alias: string,
  actorParameter: string,
  managerParameter: string,
) {
  const projectGrant = projectPipelineEditGrantSql(`${alias}.workspace_id`, `${alias}.project_id`, actorParameter);
  const customerGrant = activeCustomerProjectAccessSql(
    `${alias}.workspace_id`,
    `${alias}.project_id`,
    actorParameter,
  );
  return `(
    ${activeWorkspaceActorSql(`${alias}.workspace_id`, actorParameter)}
    and (
      ${managerParameter}::boolean
      or ${alias}.owner_user_id = ${actorParameter}::uuid
      or (
        ${alias}.approval_status = 'approved'
        and (
          (
            ${alias}.visibility = 'internal'
            and ${alias}.project_id is not null
            and ${projectGrant}
          )
          or (
            ${alias}.visibility = 'customer'
            and ${alias}.project_id is not null
            and (${projectGrant} or ${customerGrant})
          )
          or (
            ${alias}.visibility = 'public'
            and (
              ${alias}.project_id is null
              or ${projectGrant}
              or ${customerGrant}
            )
          )
        )
      )
    )
  )`;
}

export function communicationTemplateReadAccessSql(
  alias: string,
  actorParameter: string,
  managerParameter: string,
) {
  return `(
    ${activeWorkspaceActorSql(`${alias}.workspace_id`, actorParameter)}
    and (
      ${managerParameter}::boolean
      or ${alias}.owner_user_id = ${actorParameter}::uuid
      or (
        ${alias}.approval_status = 'approved'
        and ${activeInternalActorSql(`${alias}.workspace_id`, actorParameter)}
        and (
          ${alias}.project_id is null
          or ${projectPipelineEditGrantSql(`${alias}.workspace_id`, `${alias}.project_id`, actorParameter)}
        )
      )
    )
  )`;
}

type ContentMediaAccessRow = Readonly<{
  accessible: boolean;
  mediaAssetId: string;
  mutable?: boolean;
  reusable?: boolean;
}>;

function mediaReferenceAccessSql(assetFilter: string) {
  return `
    with media_references as (
      select v.media_asset_id as "mediaAssetId",
             ${contentDocumentReadAccessSql("d", "$2", "$3")} as readable,
             $3::boolean as mutable,
             ($3::boolean or d.owner_user_id = $2::uuid) as reusable
        from crm_content_document_versions v
        join crm_content_documents d
          on d.workspace_id = v.workspace_id and d.id = v.document_id
       where v.workspace_id = $1::uuid and ${assetFilter.replaceAll("ref.media_asset_id", "v.media_asset_id")}
      union all
      select media.media_asset_id,
             (
               $5::boolean
               or (
                 listing.owner_user_id = $2::uuid
                 or seller_lead.assigned_to_user_id = $2::uuid
                 or buyer.owner_user_id = $2::uuid
                 or unit_deal.owner_user_id = $2::uuid
               )
               or ${projectPipelineEditGrantSql("media.workspace_id", "coalesce(listing.project_id, unit.project_id)", "$2")}
               or (
                 media.visibility in ('public', 'channel')
                 and media.status in ('approved', 'published')
                 and ${activeCustomerProjectAccessSql(
                   "media.workspace_id",
                   "coalesce(listing.project_id, unit.project_id)",
                   "$2",
                 )}
               )
             ),
             (
               $5::boolean
               or listing.owner_user_id = $2::uuid
               or seller_lead.assigned_to_user_id = $2::uuid
               or buyer.owner_user_id = $2::uuid
               or unit_deal.owner_user_id = $2::uuid
               or ${projectPipelineEditGrantSql("media.workspace_id", "coalesce(listing.project_id, unit.project_id)", "$2")}
             ),
             (
               $5::boolean
               or listing.owner_user_id = $2::uuid
               or seller_lead.assigned_to_user_id = $2::uuid
               or buyer.owner_user_id = $2::uuid
               or unit_deal.owner_user_id = $2::uuid
               or ${projectPipelineEditGrantSql("media.workspace_id", "coalesce(listing.project_id, unit.project_id)", "$2")}
             )
        from property_media media
        left join seller_listings listing
          on listing.workspace_id = media.workspace_id and listing.id = media.property_id
        left join leads seller_lead
          on seller_lead.workspace_id = listing.workspace_id and seller_lead.id = listing.seller_lead_id
        left join property_units unit
          on unit.workspace_id = media.workspace_id and unit.id = media.unit_id
        left join contacts buyer
          on buyer.workspace_id = unit.workspace_id and buyer.id = unit.buyer_contact_id
        left join deals unit_deal
          on unit_deal.workspace_id = unit.workspace_id and unit_deal.id = unit.deal_id
       where media.workspace_id = $1::uuid and media.media_asset_id is not null
         and ${assetFilter.replaceAll("ref.media_asset_id", "media.media_asset_id")}
      union all
      select document.media_asset_id,
             (
               $5::boolean
               or (
                 listing.owner_user_id = $2::uuid
                 or seller_lead.assigned_to_user_id = $2::uuid
                 or buyer.owner_user_id = $2::uuid
                 or unit_deal.owner_user_id = $2::uuid
               )
               or ${projectPipelineEditGrantSql("document.workspace_id", "coalesce(listing.project_id, unit.project_id)", "$2")}
               or (
                 document.visibility in ('public', 'channel')
                 and document.status in ('approved', 'sent')
                 and ${activeCustomerProjectAccessSql(
                   "document.workspace_id",
                   "coalesce(listing.project_id, unit.project_id)",
                   "$2",
                 )}
               )
             ),
             (
               $5::boolean
               or listing.owner_user_id = $2::uuid
               or seller_lead.assigned_to_user_id = $2::uuid
               or buyer.owner_user_id = $2::uuid
               or unit_deal.owner_user_id = $2::uuid
               or ${projectPipelineEditGrantSql("document.workspace_id", "coalesce(listing.project_id, unit.project_id)", "$2")}
             ),
             (
               $5::boolean
               or listing.owner_user_id = $2::uuid
               or seller_lead.assigned_to_user_id = $2::uuid
               or buyer.owner_user_id = $2::uuid
               or unit_deal.owner_user_id = $2::uuid
               or ${projectPipelineEditGrantSql("document.workspace_id", "coalesce(listing.project_id, unit.project_id)", "$2")}
             )
        from property_documents document
        left join seller_listings listing
          on listing.workspace_id = document.workspace_id and listing.id = document.property_id
        left join leads seller_lead
          on seller_lead.workspace_id = listing.workspace_id and seller_lead.id = listing.seller_lead_id
        left join property_units unit
          on unit.workspace_id = document.workspace_id and unit.id = document.unit_id
        left join contacts buyer
          on buyer.workspace_id = unit.workspace_id and buyer.id = unit.buyer_contact_id
        left join deals unit_deal
          on unit_deal.workspace_id = unit.workspace_id and unit_deal.id = unit.deal_id
       where document.workspace_id = $1::uuid and document.media_asset_id is not null
         and ${assetFilter.replaceAll("ref.media_asset_id", "document.media_asset_id")}
      union all
      select send.media_asset_id,
             ($5::boolean or recipient.owner_user_id = $2::uuid),
             $5::boolean,
             $5::boolean
        from bot_document_sends send
        left join contacts recipient
          on recipient.workspace_id = send.workspace_id and recipient.id = send.contact_id
       where send.workspace_id = $1::uuid and send.media_asset_id is not null
         and ${assetFilter.replaceAll("ref.media_asset_id", "send.media_asset_id")}
    )
  `;
}

/**
 * Applies the same draft/approval ownership boundary to the shared media store
 * that the document catalogue applies to its metadata. Unlinked media is
 * creator-scoped; legacy rows without creator evidence are manager-only.
 */
export async function filterAccessibleContentMediaAssetIds(input: {
  assetIds: readonly string[];
  session: AppSession;
}) {
  const assetIds = [...new Set(input.assetIds.filter(isUuid))];
  if (assetIds.length === 0 || !isUuid(input.session.workspaceId) || !isUuid(input.session.userId)) {
    return new Set<string>();
  }
  const manager = canManageContent(input.session);
  const workspaceMediaManager = manager || canViewAllWorkspaceContacts(input.session);
  if (!canPersist()) {
    const media = await listWorkspaceMedia(input.session.workspaceId);
    return new Set(media.assets.filter((asset) => (
      assetIds.includes(asset.id)
      && (workspaceMediaManager || asset.createdByUserId === input.session.userId)
    )).map((asset) => asset.id));
  }
  const rows = await withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    (transaction) => transaction.query<ContentMediaAccessRow>(
      `${mediaReferenceAccessSql("ref.media_asset_id = any($4::uuid[])")},
       reference_access as (
         select "mediaAssetId", count(*)::text as "referenceCount",
                coalesce(bool_or(readable), false) as accessible
           from media_references
          group by "mediaAssetId"
       )
       select asset.id as "mediaAssetId",
              case
                when coalesce(reference_access."referenceCount"::integer, 0) > 0
                  then coalesce(reference_access.accessible, false)
                else ($5::boolean or asset.created_by_user_id = $2::uuid)
              end as accessible
         from media_assets asset
         left join reference_access on reference_access."mediaAssetId" = asset.id
        where asset.workspace_id = $1
          and asset.deletion_state = 'active'
          and asset.id = any($4::uuid[])`,
      [input.session.workspaceId, input.session.userId, manager, assetIds, workspaceMediaManager],
    ),
  );
  return new Set(rows.filter((row) => row.accessible).map((row) => row.mediaAssetId));
}

export async function canAccessContentMediaAsset(input: {
  assetId: string;
  mutation?: boolean;
  reuse?: boolean;
  session: AppSession;
}) {
  if (!isUuid(input.assetId) || !isUuid(input.session.workspaceId) || !isUuid(input.session.userId)) return false;
  const manager = canManageContent(input.session);
  const workspaceMediaManager = manager || canViewAllWorkspaceContacts(input.session);
  if (!canPersist()) {
    const asset = await findWorkspaceMediaAsset(input.assetId, input.session.workspaceId);
    return Boolean(asset && (workspaceMediaManager || asset.createdByUserId === input.session.userId));
  }
  const row = await withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    (transaction) => transaction.queryOne<ContentMediaAccessRow & { referenceCount: number | string }>(
      `${mediaReferenceAccessSql("ref.media_asset_id = $4::uuid")},
       reference_access as (
         select count(*)::text as "referenceCount",
                coalesce(bool_or(readable), false) as accessible,
                coalesce(bool_and(mutable), false) as mutable,
                coalesce(bool_and(reusable), false) as reusable
           from media_references
       )
       select asset.id as "mediaAssetId", reference_access."referenceCount",
              case when reference_access."referenceCount"::integer > 0
                then reference_access.accessible
                else ($5::boolean or asset.created_by_user_id = $2::uuid)
              end as accessible,
              case when asset.deletion_state = 'pending'
                then ($3::boolean or asset.deletion_requested_by_user_id = $2::uuid)
                when reference_access."referenceCount"::integer > 0
                then reference_access.mutable
                else ($5::boolean or asset.created_by_user_id = $2::uuid)
              end as mutable,
              case when reference_access."referenceCount"::integer > 0
                then reference_access.reusable
                else ($5::boolean or asset.created_by_user_id = $2::uuid)
              end as reusable
         from media_assets asset
         cross join reference_access
        where asset.id = $4::uuid and asset.workspace_id = $1
          and (
            asset.deletion_state = 'active'
            or (
              $6::boolean
              and asset.deletion_state = 'pending'
              and ($3::boolean or asset.deletion_requested_by_user_id = $2::uuid)
            )
          )`,
      [
        input.session.workspaceId,
        input.session.userId,
        manager,
        input.assetId,
        workspaceMediaManager,
        input.mutation === true,
      ],
    ),
  );
  if (input.mutation === true) return row?.mutable === true;
  if (input.reuse === true) return row?.reusable === true;
  return row?.accessible === true;
}

function requestHash(payload: unknown) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export async function claimSafeMutation(input: {
  transaction: TenantTransaction;
  session: AppSession;
  operation: string;
  idempotencyKey: string;
  payload: unknown;
}): Promise<SafeMutationClaim> {
  const hash = requestHash(input.payload);
  const claimed = await input.transaction.queryOne<{ id: string }>(
    `insert into crm_safe_mutation_requests (
       workspace_id, actor_user_id, idempotency_key, operation, request_hash
     ) values ($1, $2, $3, $4, $5)
     on conflict (workspace_id, actor_user_id, operation, idempotency_key) do nothing
     returning id`,
    [input.session.workspaceId, input.session.userId, input.idempotencyKey, input.operation, hash],
  );
  if (claimed) return { kind: "claimed", requestHash: hash };

  const existing = await input.transaction.queryOne<MutationRequestRow>(
    `select request_hash as "requestHash", response_payload as "responsePayload"
       from crm_safe_mutation_requests
      where workspace_id = $1 and actor_user_id = $2 and operation = $3 and idempotency_key = $4`,
    [input.session.workspaceId, input.session.userId, input.operation, input.idempotencyKey],
  );
  if (!existing || existing.requestHash !== hash) {
    throw new ContentRepositoryError(
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used for a different request",
    );
  }
  if (existing.responsePayload === null) {
    throw new ContentRepositoryError("CONFLICT", "The matching mutation is still being finalized");
  }
  return { kind: "replayed", response: existing.responsePayload };
}

export async function completeSafeMutation(input: {
  transaction: TenantTransaction;
  session: AppSession;
  operation: string;
  idempotencyKey: string;
  response: unknown;
}) {
  await input.transaction.execute(
    `update crm_safe_mutation_requests
        set response_payload = $5::jsonb, completed_at = now()
      where workspace_id = $1 and actor_user_id = $2 and operation = $3 and idempotency_key = $4`,
    [
      input.session.workspaceId,
      input.session.userId,
      input.operation,
      input.idempotencyKey,
      JSON.stringify(input.response),
    ],
  );
}

async function requireProject(
  transaction: TenantTransaction,
  session: AppSession,
  projectId: string | null | undefined,
  mode: "read" | "write" = "read",
) {
  if (!projectId) return;
  const manager = canManageContent(session) || canViewAllWorkspaceContacts(session);
  const row = await transaction.queryOne<{ id: string }>(
    `select project.id
       from projects project
      where project.workspace_id = $1::uuid and project.id = $2::uuid
        and (
          $3::boolean
          or ${projectPipelineEditGrantSql("project.workspace_id", "project.id", "$4")}
          or (
            $5::boolean = false
            and (
              exists (
                select 1 from contacts owned_contact
                 where owned_contact.workspace_id = project.workspace_id
                   and owned_contact.project_id = project.id
                   and owned_contact.owner_user_id = $4::uuid
              )
              or exists (
                select 1 from leads owned_lead
                 where owned_lead.workspace_id = project.workspace_id
                   and owned_lead.project_id = project.id
                   and owned_lead.assigned_to_user_id = $4::uuid
              )
              or exists (
                select 1 from deals owned_deal
                 where owned_deal.workspace_id = project.workspace_id
                   and owned_deal.project_id = project.id
                   and owned_deal.owner_user_id = $4::uuid
              )
              or exists (
                select 1 from tasks owned_task
                 where owned_task.workspace_id = project.workspace_id
                   and owned_task.project_id = project.id
                   and owned_task.owner_user_id = $4::uuid
              )
              or exists (
                select 1 from seller_listings owned_listing
                 where owned_listing.workspace_id = project.workspace_id
                   and owned_listing.project_id = project.id
                   and owned_listing.owner_user_id = $4::uuid
              )
            )
          )
          or (
            $5::boolean = false
            and exists (
              select 1 from customer_project_access customer_access
               where customer_access.workspace_id = project.workspace_id
                 and customer_access.project_id = project.id
                 and customer_access.user_id = $4::uuid
                 and customer_access.status = 'active'
                 and customer_access.can_view_project = true
            )
          )
        )`,
    [session.workspaceId, projectId, manager, session.userId, mode === "write"],
  );
  if (!row) throw new ContentRepositoryError("NOT_FOUND", "Project was not found or is outside your access scope");
}

const linkTargetSources = Object.freeze({
  closing: { ownerColumn: "owner_user_id", projectColumn: "project_id", table: "broker_closings" },
  contact: { ownerColumn: "owner_user_id", projectColumn: "project_id", table: "contacts" },
  deal: { ownerColumn: "owner_user_id", projectColumn: "project_id", table: "deals" },
  lead: { ownerColumn: "assigned_to_user_id", projectColumn: "project_id", table: "leads" },
  organization: { ownerColumn: "owner_user_id", projectColumn: "project_id", table: "organizations" },
  project: { ownerColumn: null, projectColumn: "id", table: "projects" },
  property: { ownerColumn: "owner_user_id", projectColumn: "project_id", table: "seller_listings" },
  task: { ownerColumn: "owner_user_id", projectColumn: "project_id", table: "tasks" },
  unit: { ownerColumn: null, projectColumn: "project_id", table: "property_units" },
} satisfies Record<DocumentLinkInput["targetType"], {
  ownerColumn: string | null;
  projectColumn: string;
  table: string;
}>);

async function requireContentLinkTarget(
  transaction: TenantTransaction,
  session: AppSession,
  link: DocumentLinkInput,
) {
  const source = linkTargetSources[link.targetType];
  const ownerAccess = source.ownerColumn
    ? `or target.${source.ownerColumn} = $3::uuid`
    : "";
  const projectExpression = `target.${source.projectColumn}`;
  const manager = canManageContent(session) || canViewAllWorkspaceContacts(session);
  const target = await transaction.queryOne<{ id: string; projectId: string | null }>(
    `select target.id, ${projectExpression} as "projectId"
       from ${source.table} target
      where target.workspace_id = $1::uuid and target.id = $2::uuid
        and (
          $4::boolean
          ${ownerAccess}
          or ${projectPipelineEditGrantSql("target.workspace_id", projectExpression, "$3")}
        )`,
    [session.workspaceId, link.targetId, session.userId, manager],
  );
  if (!target) {
    throw new ContentRepositoryError("NOT_FOUND", "Document link target was not found or is outside your access scope");
  }
  if (link.projectId && link.projectId !== target.projectId) {
    throw new ContentRepositoryError("CONFLICT", "Document link project does not match its target");
  }
  return target;
}

async function canReadContentLinkTarget(
  transaction: TenantTransaction,
  session: AppSession,
  link: ContentLinkRow,
) {
  const source = linkTargetSources[link.targetType as keyof typeof linkTargetSources];
  if (!source) return false;
  const ownerAccess = source.ownerColumn
    ? `or target.${source.ownerColumn} = $3::uuid`
    : "";
  const projectExpression = `target.${source.projectColumn}`;
  const manager = canManageContent(session) || canViewAllWorkspaceContacts(session);
  const target = await transaction.queryOne<{ id: string }>(
    `select target.id
       from ${source.table} target
      where target.workspace_id = $1::uuid
        and target.id = $2::uuid
        and ($5::uuid is null or ${projectExpression} = $5::uuid)
        and (
          $4::boolean
          ${ownerAccess}
          or ${projectPipelineEditGrantSql("target.workspace_id", projectExpression, "$3")}
          or exists (
            select 1 from customer_project_access target_access
             where target_access.workspace_id = target.workspace_id
               and target_access.project_id = ${projectExpression}
               and target_access.user_id = $3::uuid
               and target_access.status = 'active'
               and target_access.can_view_project = true
          )
        )`,
    [session.workspaceId, link.targetId, session.userId, manager, link.projectId],
  );
  return Boolean(target);
}

async function filterReadableContentLinks(
  transaction: TenantTransaction,
  session: AppSession,
  links: ContentLinkRow[],
) {
  const readable: ContentLinkRow[] = [];
  for (const link of links) {
    if (await canReadContentLinkTarget(transaction, session, link)) readable.push(link);
  }
  return readable;
}

async function requireMediaAsset(transaction: TenantTransaction, session: AppSession, mediaAssetId: string) {
  const manager = canManageContent(session);
  const workspaceMediaManager = manager || canViewAllWorkspaceContacts(session);
  const asset = await transaction.queryOne<MediaAssetRow>(
    `${mediaReferenceAccessSql("ref.media_asset_id = $4::uuid")}
     select asset.id, asset.original_name as "originalName", asset.mime_type as "mimeType",
            asset.size_bytes as "sizeBytes"
       from media_assets asset
      where asset.id = $4::uuid and asset.workspace_id = $1
        and asset.deletion_state = 'active'
        and (
          (
            exists (select 1 from media_references)
            and (select coalesce(bool_and(reusable), false) from media_references)
          )
          or (
            not exists (select 1 from media_references)
            and ($5::boolean or asset.created_by_user_id = $2::uuid)
          )
        )`,
    [session.workspaceId, session.userId, manager, mediaAssetId, workspaceMediaManager],
  );
  if (!asset) throw new ContentRepositoryError("NOT_FOUND", "Media asset was not found or is outside your access scope");
  return asset;
}

const documentSelect = `
  select d.id, d.workspace_id as "workspaceId", d.project_id as "projectId",
         d.owner_user_id as "ownerUserId", owner.name as "ownerName", d.title,
         d.category, d.tags, d.visibility, d.approval_status as "approvalStatus",
         d.approved_by_user_id as "approvedByUserId", d.approved_at as "approvedAt",
         d.current_version_number as "currentVersionNumber", d.archived_at as "archivedAt",
         d.archive_reason as "archiveReason", d.retention_review_at as "retentionReviewAt",
         d.created_at as "createdAt", d.updated_at as "updatedAt"
    from crm_content_documents d
    left join workspace_users owner on owner.id = d.owner_user_id and owner.workspace_id = d.workspace_id`;

const templateSelect = `
  select t.id, t.workspace_id as "workspaceId", t.project_id as "projectId",
         t.owner_user_id as "ownerUserId", owner.name as "ownerName", t.name, t.channel,
         t.purpose, t.default_language as "defaultLanguage", t.approval_status as "approvalStatus",
         t.approved_by_user_id as "approvedByUserId", t.approved_at as "approvedAt",
         t.current_version_number as "currentVersionNumber", t.archived_at as "archivedAt",
         t.archive_reason as "archiveReason", t.created_at as "createdAt", t.updated_at as "updatedAt"
    from crm_communication_templates t
    left join workspace_users owner on owner.id = t.owner_user_id and owner.workspace_id = t.workspace_id`;

export async function listContentDocuments(input: {
  session: AppSession;
  page: number;
  pageSize: number;
  offset: number;
  projectId?: string | null;
  includeArchived?: boolean;
  query?: string;
}) {
  assertPersistence();
  const manager = canManageContent(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      await requireProject(transaction, input.session, input.projectId);
      const search = input.query?.trim().slice(0, 200) ?? "";
      const params = [
        input.session.workspaceId,
        input.session.userId,
        manager,
        input.projectId ?? null,
        input.includeArchived === true,
        search,
        input.pageSize,
        input.offset,
      ];
      const access = contentDocumentReadAccessSql("d", "$2", "$3");
      const where = `d.workspace_id = $1
        and ${access}
        and ($4::uuid is null or d.project_id = $4)
        and ($5::boolean or d.archived_at is null)
        and ($6 = '' or d.title ilike '%' || $6 || '%' or d.category ilike '%' || $6 || '%' or $6 = any(d.tags))`;
      const [rows, count] = await Promise.all([
        transaction.query<DocumentRow>(
          `${documentSelect} where ${where} order by d.updated_at desc, d.id limit $7 offset $8`,
          params,
        ),
        transaction.queryOne<{ total: string }>(
          `select count(*)::text as total from crm_content_documents d where ${where}`,
          params.slice(0, 6),
        ),
      ]);
      return {
        items: rows.map(mapDocument),
        page: input.page,
        pageSize: input.pageSize,
        total: Number(count?.total ?? 0),
      };
    },
  );
}

export async function getContentDocument(input: { session: AppSession; documentId: string }) {
  assertPersistence();
  const manager = canManageContent(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const document = await transaction.queryOne<DocumentRow>(
        `${documentSelect}
          where d.workspace_id = $1 and d.id = $2
            and ${contentDocumentReadAccessSql("d", "$4", "$3")}`,
        [input.session.workspaceId, input.documentId, manager, input.session.userId],
      );
      if (!document) return null;
      const [versions, links] = await Promise.all([
        transaction.query<DocumentVersionRow>(
          `select id, version_number as "versionNumber", media_asset_id as "mediaAssetId",
                  file_name as "fileName", mime_type as "mimeType", size_bytes as "sizeBytes",
                  checksum_sha256 as "checksumSha256", change_note as "changeNote",
                  created_by_user_id as "createdByUserId", created_at as "createdAt"
             from crm_content_document_versions
            where workspace_id = $1 and document_id = $2
            order by version_number desc`,
          [input.session.workspaceId, input.documentId],
        ),
        transaction.query<ContentLinkRow>(
          `select id, target_type as "targetType", target_id as "targetId", project_id as "projectId",
                  created_at as "createdAt"
             from crm_content_links where workspace_id = $1 and document_id = $2
            order by created_at, id`,
          [input.session.workspaceId, input.documentId],
        ),
      ]);
      const readableLinks = await filterReadableContentLinks(transaction, input.session, links);
      return {
        ...mapDocument(document),
        versions: versions.map(mapDocumentVersion),
        links: readableLinks.map((link) => ({ ...link, createdAt: iso(link.createdAt)! })),
      };
    },
  );
}

export async function createContentDocument(input: {
  session: AppSession;
  idempotencyKey: string;
  document: CreateDocumentInput;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "content.document.create";
      const claim = await claimSafeMutation({
        transaction,
        session: input.session,
        operation,
        idempotencyKey: input.idempotencyKey,
        payload: input.document,
      });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };

      await requireProject(transaction, input.session, input.document.projectId, "write");
      const asset = await requireMediaAsset(transaction, input.session, input.document.mediaAssetId);
      const document = await transaction.queryOne<DocumentRow>(
        `insert into crm_content_documents (
           workspace_id, project_id, owner_user_id, title, category, tags, visibility
         ) values ($1, $2, $3, $4, $5, $6::text[], $7)
         returning id, workspace_id as "workspaceId", project_id as "projectId",
           owner_user_id as "ownerUserId", null::text as "ownerName", title, category, tags,
           visibility, approval_status as "approvalStatus", approved_by_user_id as "approvedByUserId",
           approved_at as "approvedAt", current_version_number as "currentVersionNumber",
           archived_at as "archivedAt", archive_reason as "archiveReason",
           retention_review_at as "retentionReviewAt", created_at as "createdAt", updated_at as "updatedAt"`,
        [
          input.session.workspaceId,
          input.document.projectId ?? null,
          input.session.userId,
          input.document.title,
          input.document.category ?? "document",
          input.document.tags ?? [],
          input.document.visibility ?? "internal",
        ],
      );
      if (!document) throw new ContentRepositoryError("CONFLICT", "Document could not be created");
      await transaction.execute(
        `insert into crm_content_document_versions (
           workspace_id, document_id, version_number, media_asset_id, file_name, mime_type,
           size_bytes, checksum_sha256, change_note, created_by_user_id
         ) values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.session.workspaceId,
          document.id,
          asset.id,
          asset.originalName,
          asset.mimeType,
          asset.sizeBytes,
          input.document.checksumSha256 ?? null,
          input.document.changeNote ?? "",
          input.session.userId,
        ],
      );
      for (const link of input.document.links ?? []) {
        const target = await requireContentLinkTarget(transaction, input.session, link);
        if (!input.document.projectId && target.projectId) {
          throw new ContentRepositoryError("CONFLICT", "Projectless documents cannot link to project-scoped targets");
        }
        if (input.document.projectId && target.projectId !== input.document.projectId) {
          throw new ContentRepositoryError("CONFLICT", "Document project does not match its link target");
        }
        await transaction.execute(
          `insert into crm_content_links (
             workspace_id, document_id, target_type, target_id, project_id, created_by_user_id
           ) values ($1, $2, $3, $4, $5, $6)`,
          [
            input.session.workspaceId,
            document.id,
            link.targetType,
            link.targetId,
            link.projectId ?? input.document.projectId ?? target.projectId,
            input.session.userId,
          ],
        );
      }
      const response = { document: mapDocument(document), replayed: false };
      await writeAuditLog({
        session: input.session,
        action: "content.document.created",
        entityType: "content_document",
        entityId: document.id,
        projectId: document.projectId,
        after: response.document,
        transaction,
      });
      await completeSafeMutation({
        transaction,
        session: input.session,
        operation,
        idempotencyKey: input.idempotencyKey,
        response,
      });
      return response;
    },
  );
}

async function documentForMutation(input: {
  transaction: TenantTransaction;
  session: AppSession;
  documentId: string;
  expectedUpdatedAt: string;
  managerOnly?: boolean;
}) {
  const document = await input.transaction.queryOne<DocumentRow>(
    `${documentSelect} where d.workspace_id = $1 and d.id = $2 for update of d`,
    [input.session.workspaceId, input.documentId],
  );
  if (!document) throw new ContentRepositoryError("NOT_FOUND", "Document was not found");
  await requireProject(input.transaction, input.session, document.projectId, "write");
  const manager = canManageContent(input.session);
  if (input.managerOnly ? !manager : (!manager && document.ownerUserId !== input.session.userId)) {
    throw new ContentRepositoryError("FORBIDDEN", "Document access is not permitted");
  }
  if (iso(document.updatedAt) !== iso(input.expectedUpdatedAt)) {
    throw new ContentRepositoryError("CONFLICT", "Document changed since it was loaded");
  }
  return document;
}

export async function addContentDocumentVersion(input: {
  session: AppSession;
  documentId: string;
  idempotencyKey: string;
  version: AddDocumentVersionInput;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "content.document.version.create";
      const claim = await claimSafeMutation({
        transaction, session: input.session, operation, idempotencyKey: input.idempotencyKey,
        payload: { documentId: input.documentId, ...input.version },
      });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await documentForMutation({
        transaction, session: input.session, documentId: input.documentId,
        expectedUpdatedAt: input.version.expectedUpdatedAt,
      });
      const asset = await requireMediaAsset(transaction, input.session, input.version.mediaAssetId);
      const nextVersion = before.currentVersionNumber + 1;
      await transaction.execute(
        `insert into crm_content_document_versions (
           workspace_id, document_id, version_number, media_asset_id, file_name, mime_type,
           size_bytes, checksum_sha256, change_note, created_by_user_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [input.session.workspaceId, input.documentId, nextVersion, asset.id, asset.originalName,
          asset.mimeType, asset.sizeBytes, input.version.checksumSha256 ?? null,
          input.version.changeNote ?? "", input.session.userId],
      );
      const updated = await transaction.queryOne<DocumentRow>(
        `update crm_content_documents d set current_version_number = $3,
             approval_status = 'draft', approved_by_user_id = null, approved_at = null, updated_at = now()
          where d.workspace_id = $1 and d.id = $2
          returning d.id, d.workspace_id as "workspaceId", d.project_id as "projectId",
            d.owner_user_id as "ownerUserId", null::text as "ownerName", d.title, d.category, d.tags,
            d.visibility, d.approval_status as "approvalStatus",
            d.approved_by_user_id as "approvedByUserId", d.approved_at as "approvedAt",
            d.current_version_number as "currentVersionNumber",
            d.archived_at as "archivedAt", d.archive_reason as "archiveReason",
            d.retention_review_at as "retentionReviewAt", d.created_at as "createdAt", d.updated_at as "updatedAt"`,
        [input.session.workspaceId, input.documentId, nextVersion],
      );
      if (!updated) throw new ContentRepositoryError("CONFLICT", "Document version could not be attached");
      const response = { document: mapDocument(updated), replayed: false };
      await writeAuditLog({ session: input.session, action: "content.document.version_created",
        entityType: "content_document", entityId: input.documentId, projectId: updated.projectId,
        before: mapDocument(before), after: response.document, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export type DocumentUpdate = Readonly<{
  expectedUpdatedAt: string;
  title?: string;
  category?: string;
  tags?: readonly string[];
  visibility?: DocumentVisibility;
  approvalStatus?: ApprovalStatus;
}>;

export async function updateContentDocument(input: {
  session: AppSession;
  documentId: string;
  idempotencyKey: string;
  update: DocumentUpdate;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "content.document.update";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: { documentId: input.documentId, ...input.update } });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await documentForMutation({ transaction, session: input.session,
        documentId: input.documentId, expectedUpdatedAt: input.update.expectedUpdatedAt });
      const manager = canManageContent(input.session);
      const contentChanged = input.update.title !== undefined
        || input.update.category !== undefined
        || input.update.tags !== undefined
        || input.update.visibility !== undefined;
      if (!manager && (input.update.approvalStatus === "approved" || input.update.approvalStatus === "rejected")) {
        throw new ContentRepositoryError("FORBIDDEN", "Only content managers can approve or reject documents");
      }
      const nextApprovalStatus = input.update.approvalStatus
        ?? (contentChanged && before.approvalStatus === "approved" ? "draft" : before.approvalStatus);
      const updated = await transaction.queryOne<DocumentRow>(
        `update crm_content_documents d set
           title = coalesce($3, d.title), category = coalesce($4, d.category),
           tags = coalesce($5::text[], d.tags), visibility = coalesce($6, d.visibility),
           approval_status = $7,
           approved_by_user_id = case when $7 = 'approved' then $8 else null end,
           approved_at = case when $7 = 'approved' then now() else null end,
           updated_at = now()
         where d.workspace_id = $1 and d.id = $2
         returning d.id, d.workspace_id as "workspaceId", d.project_id as "projectId",
           d.owner_user_id as "ownerUserId", null::text as "ownerName", d.title, d.category, d.tags,
           d.visibility, d.approval_status as "approvalStatus",
           d.approved_by_user_id as "approvedByUserId", d.approved_at as "approvedAt",
           d.current_version_number as "currentVersionNumber",
           d.archived_at as "archivedAt", d.archive_reason as "archiveReason",
           d.retention_review_at as "retentionReviewAt", d.created_at as "createdAt", d.updated_at as "updatedAt"`,
        [input.session.workspaceId, input.documentId, input.update.title ?? null,
          input.update.category ?? null, input.update.tags ?? null, input.update.visibility ?? null,
          nextApprovalStatus, input.session.userId],
      );
      if (!updated) throw new ContentRepositoryError("CONFLICT", "Document could not be updated");
      const response = { document: mapDocument(updated), replayed: false };
      await writeAuditLog({ session: input.session, action: "content.document.updated",
        entityType: "content_document", entityId: input.documentId, projectId: updated.projectId,
        before: mapDocument(before), after: response.document, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function setContentDocumentArchived(input: {
  session: AppSession;
  documentId: string;
  idempotencyKey: string;
  expectedUpdatedAt: string;
  archived: boolean;
  reason: string;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = input.archived ? "content.document.archive" : "content.document.restore";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: {
          documentId: input.documentId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          archived: input.archived,
          reason: input.reason,
        } });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await documentForMutation({ transaction, session: input.session,
        documentId: input.documentId, expectedUpdatedAt: input.expectedUpdatedAt });
      const updated = await transaction.queryOne<DocumentRow>(
        `update crm_content_documents d set archived_at = case when $3 then now() else null end,
           archived_by_user_id = case when $3 then $4 else null end,
           archive_reason = case when $3 then $5 else null end, updated_at = now()
         where d.workspace_id = $1 and d.id = $2
         returning d.id, d.workspace_id as "workspaceId", d.project_id as "projectId",
           d.owner_user_id as "ownerUserId", null::text as "ownerName", d.title, d.category, d.tags,
           d.visibility, d.approval_status as "approvalStatus",
           d.approved_by_user_id as "approvedByUserId", d.approved_at as "approvedAt",
           d.current_version_number as "currentVersionNumber",
           d.archived_at as "archivedAt", d.archive_reason as "archiveReason",
           d.retention_review_at as "retentionReviewAt", d.created_at as "createdAt", d.updated_at as "updatedAt"`,
        [input.session.workspaceId, input.documentId, input.archived, input.session.userId, input.reason],
      );
      if (!updated) throw new ContentRepositoryError("CONFLICT", "Document archive state could not be changed");
      const response = { document: mapDocument(updated), replayed: false };
      await writeAuditLog({ session: input.session,
        action: input.archived ? "content.document.archived" : "content.document.restored",
        entityType: "content_document", entityId: input.documentId, projectId: updated.projectId,
        before: mapDocument(before), after: response.document, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

async function documentHasActiveLegalHold(transaction: TenantTransaction, workspaceId: string, documentId: string) {
  return transaction.queryOne<{ id: string }>(
    `select h.id
       from privacy_legal_holds h
      where h.workspace_id = $1 and h.released_at is null
        and (h.expires_at is null or h.expires_at > now())
        and (
          h.entity_type = 'workspace'
          or (h.entity_type = 'document' and h.entity_id = $2)
          or exists (
            select 1 from crm_content_links link
             where link.workspace_id = h.workspace_id and link.document_id = $2
               and link.target_type = h.entity_type and link.target_id = h.entity_id
          )
        )
      limit 1`,
    [workspaceId, documentId],
  );
}

export async function requestContentDocumentDeletionReview(input: {
  session: AppSession;
  documentId: string;
  idempotencyKey: string;
  expectedUpdatedAt: string;
  reason: string;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "content.document.deletion_review.request";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: {
          documentId: input.documentId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          reason: input.reason,
        } });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const document = await documentForMutation({ transaction, session: input.session,
        documentId: input.documentId, expectedUpdatedAt: input.expectedUpdatedAt, managerOnly: true });
      const hold = await documentHasActiveLegalHold(transaction, input.session.workspaceId, input.documentId);
      let reviewId: string | null = null;
      if (!hold) {
        const review = await transaction.queryOne<{ id: string }>(
          `insert into privacy_retention_reviews (
             workspace_id, entity_type, entity_id, proposed_action, rationale, created_by_user_id
           ) values ($1, 'document', $2, 'propose_delete', $3, $4)
           on conflict (workspace_id, entity_type, entity_id)
             where status in ('proposed', 'in_review')
           do update set rationale = excluded.rationale, updated_at = now()
           returning id`,
          [input.session.workspaceId, input.documentId, input.reason, input.session.userId],
        );
        reviewId = review?.id ?? null;
        await transaction.execute(
          "update crm_content_documents set retention_review_at = now(), updated_at = now() where workspace_id = $1 and id = $2",
          [input.session.workspaceId, input.documentId],
        );
      }
      const response = {
        blockedByLegalHold: Boolean(hold),
        hardDeletePerformed: false as const,
        reviewId,
        replayed: false,
      };
      await writeAuditLog({ session: input.session,
        action: hold ? "content.document.deletion_review_blocked" : "content.document.deletion_review_requested",
        entityType: "content_document", entityId: input.documentId, projectId: document.projectId,
        after: response, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function listCommunicationTemplates(input: {
  session: AppSession;
  page: number;
  pageSize: number;
  offset: number;
  projectId?: string | null;
  includeArchived?: boolean;
  query?: string;
}) {
  assertPersistence();
  const manager = canManageContent(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      await requireProject(transaction, input.session, input.projectId);
      const search = input.query?.trim().slice(0, 200) ?? "";
      const params = [input.session.workspaceId, input.session.userId, manager, input.projectId ?? null,
        input.includeArchived === true, search, input.pageSize, input.offset];
      const where = `t.workspace_id = $1
        and ${communicationTemplateReadAccessSql("t", "$2", "$3")}
        and ($4::uuid is null or t.project_id = $4)
        and ($5::boolean or t.archived_at is null)
        and ($6 = '' or t.name ilike '%' || $6 || '%' or t.purpose ilike '%' || $6 || '%')`;
      const [rows, count] = await Promise.all([
        transaction.query<TemplateRow>(`${templateSelect} where ${where} order by t.updated_at desc, t.id limit $7 offset $8`, params),
        transaction.queryOne<{ total: string }>(`select count(*)::text as total from crm_communication_templates t where ${where}`, params.slice(0, 6)),
      ]);
      return { items: rows.map(mapTemplate), page: input.page, pageSize: input.pageSize,
        total: Number(count?.total ?? 0) };
    },
  );
}

export async function getCommunicationTemplate(input: { session: AppSession; templateId: string }) {
  assertPersistence();
  const manager = canManageContent(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const template = await transaction.queryOne<TemplateRow>(
        `${templateSelect} where t.workspace_id = $1 and t.id = $2
          and ${communicationTemplateReadAccessSql("t", "$4", "$3")}`,
        [input.session.workspaceId, input.templateId, manager, input.session.userId],
      );
      if (!template) return null;
      const versions = await transaction.query<TemplateVersionRow>(
        `select id, version_number as "versionNumber", language, subject, body,
                allowed_variables as "allowedVariables", variable_fallbacks as "variableFallbacks",
                structured_content as "structuredContent", change_note as "changeNote",
                created_by_user_id as "createdByUserId", created_at as "createdAt"
           from crm_communication_template_versions
          where workspace_id = $1 and template_id = $2 order by version_number desc`,
        [input.session.workspaceId, input.templateId],
      );
      return { ...mapTemplate(template), versions: versions.map(mapTemplateVersion) };
    },
  );
}

export async function createCommunicationTemplate(input: {
  session: AppSession;
  idempotencyKey: string;
  template: CreateTemplateInput;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "content.template.create";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: input.template });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      await requireProject(transaction, input.session, input.template.projectId, "write");
      const template = await transaction.queryOne<TemplateRow>(
        `insert into crm_communication_templates (
           workspace_id, project_id, owner_user_id, name, channel, purpose, default_language
         ) values ($1, $2, $3, $4, $5, $6, $7)
         returning id, workspace_id as "workspaceId", project_id as "projectId",
           owner_user_id as "ownerUserId", null::text as "ownerName", name, channel, purpose,
           default_language as "defaultLanguage", approval_status as "approvalStatus",
           approved_by_user_id as "approvedByUserId", approved_at as "approvedAt",
           current_version_number as "currentVersionNumber", archived_at as "archivedAt",
           archive_reason as "archiveReason", created_at as "createdAt", updated_at as "updatedAt"`,
        [input.session.workspaceId, input.template.projectId ?? null, input.session.userId,
          input.template.name, input.template.channel, input.template.purpose ?? "general",
          input.template.defaultLanguage ?? "de"],
      );
      if (!template) throw new ContentRepositoryError("CONFLICT", "Template could not be created");
      await transaction.execute(
        `insert into crm_communication_template_versions (
           workspace_id, template_id, version_number, language, subject, body,
           allowed_variables, variable_fallbacks, change_note, created_by_user_id
         ) values ($1, $2, 1, $3, $4, $5, $6::text[], $7::jsonb, $8, $9)`,
        [input.session.workspaceId, template.id, input.template.language ?? input.template.defaultLanguage ?? "de",
          input.template.subject ?? "", input.template.body, input.template.allowedVariables ?? [],
          JSON.stringify(input.template.variableFallbacks ?? {}), input.template.changeNote ?? "", input.session.userId],
      );
      const response = { template: mapTemplate(template), replayed: false };
      await writeAuditLog({ session: input.session, action: "content.template.created",
        entityType: "communication_template", entityId: template.id, projectId: template.projectId,
        after: response.template, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

async function templateForMutation(input: {
  transaction: TenantTransaction;
  session: AppSession;
  templateId: string;
  expectedUpdatedAt: string;
  managerOnly?: boolean;
}) {
  const template = await input.transaction.queryOne<TemplateRow>(
    `${templateSelect} where t.workspace_id = $1 and t.id = $2 for update of t`,
    [input.session.workspaceId, input.templateId],
  );
  if (!template) throw new ContentRepositoryError("NOT_FOUND", "Template was not found");
  await requireProject(input.transaction, input.session, template.projectId, "write");
  const manager = canManageContent(input.session);
  if (input.managerOnly ? !manager : (!manager && template.ownerUserId !== input.session.userId)) {
    throw new ContentRepositoryError("FORBIDDEN", "Template access is not permitted");
  }
  if (iso(template.updatedAt) !== iso(input.expectedUpdatedAt)) {
    throw new ContentRepositoryError("CONFLICT", "Template changed since it was loaded");
  }
  return template;
}

export async function addCommunicationTemplateVersion(input: {
  session: AppSession;
  templateId: string;
  idempotencyKey: string;
  version: AddTemplateVersionInput;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "content.template.version.create";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: { templateId: input.templateId, ...input.version } });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await templateForMutation({ transaction, session: input.session,
        templateId: input.templateId, expectedUpdatedAt: input.version.expectedUpdatedAt });
      const nextVersion = before.currentVersionNumber + 1;
      await transaction.execute(
        `insert into crm_communication_template_versions (
           workspace_id, template_id, version_number, language, subject, body,
           allowed_variables, variable_fallbacks, change_note, created_by_user_id
         ) values ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb, $9, $10)`,
        [input.session.workspaceId, input.templateId, nextVersion, input.version.language,
          input.version.subject ?? "", input.version.body, input.version.allowedVariables ?? [],
          JSON.stringify(input.version.variableFallbacks ?? {}), input.version.changeNote ?? "", input.session.userId],
      );
      const updated = await transaction.queryOne<TemplateRow>(
        `update crm_communication_templates t set current_version_number = $3,
             approval_status = 'draft', approved_by_user_id = null, approved_at = null, updated_at = now()
          where t.workspace_id = $1 and t.id = $2
          returning t.id, t.workspace_id as "workspaceId", t.project_id as "projectId",
            t.owner_user_id as "ownerUserId", null::text as "ownerName", t.name, t.channel, t.purpose,
            t.default_language as "defaultLanguage", t.approval_status as "approvalStatus",
            t.approved_by_user_id as "approvedByUserId", t.approved_at as "approvedAt",
            t.current_version_number as "currentVersionNumber", t.archived_at as "archivedAt",
            t.archive_reason as "archiveReason", t.created_at as "createdAt", t.updated_at as "updatedAt"`,
        [input.session.workspaceId, input.templateId, nextVersion],
      );
      if (!updated) throw new ContentRepositoryError("CONFLICT", "Template version could not be created");
      const response = { template: mapTemplate(updated), replayed: false };
      await writeAuditLog({ session: input.session, action: "content.template.version_created",
        entityType: "communication_template", entityId: input.templateId, projectId: updated.projectId,
        before: mapTemplate(before), after: response.template, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export type TemplateUpdate = Readonly<{
  expectedUpdatedAt: string;
  name?: string;
  purpose?: string;
  defaultLanguage?: string;
  approvalStatus?: ApprovalStatus;
}>;

export async function updateCommunicationTemplate(input: {
  session: AppSession;
  templateId: string;
  idempotencyKey: string;
  update: TemplateUpdate;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "content.template.update";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: { templateId: input.templateId, ...input.update } });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await templateForMutation({ transaction, session: input.session,
        templateId: input.templateId, expectedUpdatedAt: input.update.expectedUpdatedAt });
      const manager = canManageContent(input.session);
      const contentChanged = input.update.name !== undefined
        || input.update.purpose !== undefined
        || input.update.defaultLanguage !== undefined;
      if (!manager && (input.update.approvalStatus === "approved" || input.update.approvalStatus === "rejected")) {
        throw new ContentRepositoryError("FORBIDDEN", "Only content managers can approve or reject templates");
      }
      const nextApprovalStatus = input.update.approvalStatus
        ?? (contentChanged && before.approvalStatus === "approved" ? "draft" : before.approvalStatus);
      const updated = await transaction.queryOne<TemplateRow>(
        `update crm_communication_templates t set name = coalesce($3, t.name),
           purpose = coalesce($4, t.purpose), default_language = coalesce($5, t.default_language),
           approval_status = $6,
           approved_by_user_id = case when $6 = 'approved' then $7 else null end,
           approved_at = case when $6 = 'approved' then now() else null end,
           updated_at = now()
         where t.workspace_id = $1 and t.id = $2
         returning t.id, t.workspace_id as "workspaceId", t.project_id as "projectId",
           t.owner_user_id as "ownerUserId", null::text as "ownerName", t.name, t.channel, t.purpose,
           t.default_language as "defaultLanguage", t.approval_status as "approvalStatus",
           t.approved_by_user_id as "approvedByUserId", t.approved_at as "approvedAt",
           t.current_version_number as "currentVersionNumber", t.archived_at as "archivedAt",
           t.archive_reason as "archiveReason", t.created_at as "createdAt", t.updated_at as "updatedAt"`,
        [input.session.workspaceId, input.templateId, input.update.name ?? null,
          input.update.purpose ?? null, input.update.defaultLanguage ?? null,
          nextApprovalStatus, input.session.userId],
      );
      if (!updated) throw new ContentRepositoryError("CONFLICT", "Template could not be updated");
      const response = { template: mapTemplate(updated), replayed: false };
      await writeAuditLog({ session: input.session, action: "content.template.updated",
        entityType: "communication_template", entityId: input.templateId, projectId: updated.projectId,
        before: mapTemplate(before), after: response.template, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function setCommunicationTemplateArchived(input: {
  session: AppSession;
  templateId: string;
  idempotencyKey: string;
  expectedUpdatedAt: string;
  archived: boolean;
  reason: string;
}) {
  assertPersistence();
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = input.archived ? "content.template.archive" : "content.template.restore";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: {
          templateId: input.templateId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          archived: input.archived,
          reason: input.reason,
        } });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await templateForMutation({ transaction, session: input.session,
        templateId: input.templateId, expectedUpdatedAt: input.expectedUpdatedAt });
      const updated = await transaction.queryOne<TemplateRow>(
        `update crm_communication_templates t set archived_at = case when $3 then now() else null end,
           archived_by_user_id = case when $3 then $4 else null end,
           archive_reason = case when $3 then $5 else null end, updated_at = now()
         where t.workspace_id = $1 and t.id = $2
         returning t.id, t.workspace_id as "workspaceId", t.project_id as "projectId",
           t.owner_user_id as "ownerUserId", null::text as "ownerName", t.name, t.channel, t.purpose,
           t.default_language as "defaultLanguage", t.approval_status as "approvalStatus",
           t.approved_by_user_id as "approvedByUserId", t.approved_at as "approvedAt",
           t.current_version_number as "currentVersionNumber", t.archived_at as "archivedAt",
           t.archive_reason as "archiveReason", t.created_at as "createdAt", t.updated_at as "updatedAt"`,
        [input.session.workspaceId, input.templateId, input.archived, input.session.userId, input.reason],
      );
      if (!updated) throw new ContentRepositoryError("CONFLICT", "Template archive state could not be changed");
      const response = { template: mapTemplate(updated), replayed: false };
      await writeAuditLog({ session: input.session,
        action: input.archived ? "content.template.archived" : "content.template.restored",
        entityType: "communication_template", entityId: input.templateId, projectId: updated.projectId,
        before: mapTemplate(before), after: response.template, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export function contentAccessSummary(session: AppSession) {
  return {
    canApprove: canManageContent(session),
    canViewAll: canViewAllWorkspaceContacts(session),
  };
}
