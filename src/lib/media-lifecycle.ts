import { Pool } from "@neondatabase/serverless";
import { resolveDatabaseUrl } from "@/lib/db/client";
import { withTenantTransaction, type TenantPool } from "@/lib/db/tenant-client";
import type { MediaAsset } from "@/lib/media-store";

export type PropertyMediaDeletionTarget = {
  propertyId: string;
  attachmentKind: "media" | "document";
  attachmentId: string;
  expectedUpdatedAt: string;
};
export type MediaLifecycleErrorCode = "MEDIA_DELETE_INVALID_TARGET" | "MEDIA_DELETE_IN_USE" |
  "MEDIA_DELETE_TARGET_CHANGED" | "MEDIA_DELETE_VISIBILITY_UNCONFIRMED" |
  "MEDIA_FILE_DELETE_UNCONFIRMED" | "MEDIA_RECORD_DELETE_UNCONFIRMED";
export class MediaLifecycleError extends Error {
  constructor(public readonly code: MediaLifecycleErrorCode, message: string) { super(message); }
}
const validId = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function parsePropertyMediaDeletionTarget(value: unknown): PropertyMediaDeletionTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (Object.keys(target).length !== 4 ||
    !Object.keys(target).every(key => ["propertyId", "attachmentKind", "attachmentId", "expectedUpdatedAt"].includes(key)) ||
    !validId(target.propertyId) || !validId(target.attachmentId) ||
    typeof target.attachmentKind !== "string" || !["media", "document"].includes(target.attachmentKind) ||
    typeof target.expectedUpdatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(target.expectedUpdatedAt) ||
    !Number.isFinite(Date.parse(target.expectedUpdatedAt)) || new Date(target.expectedUpdatedAt).toISOString() !== target.expectedUpdatedAt) return null;
  return target as PropertyMediaDeletionTarget;
}

let deletionPool: Pool | null = null;
let deletionPoolUrl = "";
function getDeletionPool() {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString || (deletionPool && deletionPoolUrl !== connectionString)) throw new Error("Media deletion database unavailable");
  if (!deletionPool) {
    deletionPool = new Pool({ connectionString, max: 2, allowExitOnIdle: true, idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000, statement_timeout: 15_000, query_timeout: 20_000,
      idle_in_transaction_session_timeout: 30_000 });
    deletionPoolUrl = connectionString;
  }
  return deletionPool;
}

// These are the ONLY incoming asset FKs supported by this deletion protocol.
// Unknown/changed/deferrable/unvalidated constraints fail before storage IO.
const knownReferences = [
  { table_name: "bot_document_sends", columns: ["media_asset_id"], target_columns: ["id"], delete_action: "n" },
  { table_name: "media_asset_shares", columns: ["asset_id", "workspace_id"], target_columns: ["id", "workspace_id"], delete_action: "c" },
  { table_name: "property_documents", columns: ["media_asset_id"], target_columns: ["id"], delete_action: "n" },
  { table_name: "property_media", columns: ["media_asset_id"], target_columns: ["id"], delete_action: "n" },
];
export function hasCompleteMediaReferenceVisibility(rows: Record<string, unknown>[]) {
  return rows.length === knownReferences.length && knownReferences.every(expected => rows.filter(row =>
    row.schema_name === "public" && row.table_name === expected.table_name && row.validated === true &&
    row.deferrable === false && row.delete_action === expected.delete_action &&
    JSON.stringify(row.columns) === JSON.stringify(expected.columns) &&
    JSON.stringify(row.target_columns) === JSON.stringify(expected.target_columns)).length === 1);
}

const referenceCatalogSql = `select n.nspname as schema_name,t.relname as table_name,
  c.convalidated as validated,c.condeferrable as deferrable,c.confdeltype as delete_action,
  row_security_active(c.conrelid) as rls_active,
  array(select a.attname::text from unnest(c.conkey) with ordinality key(attnum,position)
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=key.attnum order by key.position) as columns,
  array(select a.attname::text from unnest(c.confkey) with ordinality key(attnum,position)
    join pg_attribute a on a.attrelid=c.confrelid and a.attnum=key.attnum order by key.position) as target_columns
  from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
  where c.contype='f' and c.confrelid='public.media_assets'::regclass`;
const referenceCountsSql = `select * from public.crm_media_reference_counts($1::uuid)`;

/**
 * The parent lock serializes normal gallery and deletion writes for the same property.
 * Deletion then locks asset -> attachment; the gallery locks attachment -> asset.
 * The asset FOR UPDATE conflicts with FK key-share locks: new attachments/shares
 * cannot slip between reference validation and COMMIT. Storage is not transactional;
 * its uncertainty and a later DB rollback/unknown commit are never called success.
 */
export async function deleteDatabaseMedia(input: {
  assetId: string; workspaceId: string; actorId: string; target?: PropertyMediaDeletionTarget;
  assetSelect: string; normalizeAsset: (row: Record<string, unknown>) => MediaAsset;
  deleteFile: (asset: MediaAsset) => Promise<void>;
  /** Isolated test override, never selected by requests. */
  pool?: TenantPool;
}): Promise<MediaAsset | null> {
  if (![input.assetId, input.workspaceId, input.actorId].every(validId) ||
    (input.target !== undefined && !parsePropertyMediaDeletionTarget(input.target))) {
    throw new MediaLifecycleError("MEDIA_DELETE_INVALID_TARGET", "Invalid media deletion target.");
  }
  let fileAcknowledged = false;
  try {
    return await withTenantTransaction({ workspaceId: input.workspaceId, actorId: input.actorId }, async transaction => {
      if (input.target) {
        const parent = await transaction.queryOne(`select p.id,p.canonical_payload->'expose'->>'activeDocumentId' as "activeExposeDocumentId" from public.seller_listings p
          where p.id=$1::uuid and p.workspace_id=$2::uuid and (p.project_id is null or exists(
            select 1 from public.projects project where project.id=p.project_id and project.workspace_id=p.workspace_id))
          for update of p`, [input.target.propertyId, input.workspaceId]);
        if (!parent) throw new MediaLifecycleError("MEDIA_DELETE_TARGET_CHANGED", "Property target changed. Reload before deleting.");
        if (input.target.attachmentKind === "document" && parent.activeExposeDocumentId === input.target.attachmentId) {
          throw new MediaLifecycleError("MEDIA_DELETE_IN_USE", "This is the active Exposé. Explicitly remove or replace the active selection before deleting the file.");
        }
      }
      const row = await transaction.queryOne(`select ${input.assetSelect} from public.media_assets ma
        where ma.id = $1 and ma.workspace_id = $2 for update of ma`, [input.assetId, input.workspaceId]);
      if (!row) return null;
      const asset = input.normalizeAsset(row);
      if (!hasCompleteMediaReferenceVisibility(await transaction.query(referenceCatalogSql))) {
        throw new MediaLifecycleError("MEDIA_DELETE_VISIBILITY_UNCONFIRMED", "All media references could not be verified. Nothing was deleted.");
      }
      const references = await transaction.queryOne(referenceCountsSql, [input.assetId]);
      const expectedMedia = input.target?.attachmentKind === "media" ? 1 : 0;
      const expectedDocuments = input.target?.attachmentKind === "document" ? 1 : 0;
      if (!references || references.media_count !== expectedMedia || references.document_count !== expectedDocuments ||
        references.send_count !== 0 || references.share_count !== 0 ||
        asset.storageAccess !== "private" || asset.isPublic || row.publicToken != null) {
        throw new MediaLifecycleError("MEDIA_DELETE_IN_USE", "This file has another use, sharing history or a protected lifecycle and cannot be deleted here.");
      }
      const target = input.target;
      const table = target?.attachmentKind === "media" ? "property_media" : "property_documents";
      const targetParams = target ? [target.attachmentId, input.workspaceId, target.propertyId, input.assetId, target.expectedUpdatedAt] : [];
      if (target) {
        const attachment = await transaction.queryOne(`select attachment.id from public.${table} attachment
          join public.seller_listings p on p.id=attachment.property_id and p.workspace_id=attachment.workspace_id
          where attachment.id=$1::uuid and attachment.workspace_id=$2::uuid and attachment.property_id=$3::uuid
            and attachment.media_asset_id=$4::uuid and date_trunc('milliseconds',attachment.updated_at)=$5::timestamptz
            and attachment.project_id is not distinct from p.project_id and attachment.unit_id is null
            and attachment.visibility='private' and attachment.status in ('draft','needs_review','approved')
            ${target.attachmentKind === "document" ? "and attachment.sent_at is null" : ""}
            and ($6 !~* '^properties/' or lower($6)='properties/' || p.id::text)
          for update of attachment`, [...targetParams, asset.folder]);
        if (!attachment) throw new MediaLifecycleError("MEDIA_DELETE_TARGET_CHANGED", "Attachment changed or has a protected lifecycle. Reload before deleting.");
      }
      try { await input.deleteFile(asset); }
      catch { throw new MediaLifecycleError("MEDIA_FILE_DELETE_UNCONFIRMED", "File deletion could not be confirmed. Database changes were not committed. Reload before any further action."); }
      fileAcknowledged = true;
      if (target) {
        const removed = await transaction.queryOne(`delete from public.${table} where id=$1::uuid and workspace_id=$2::uuid
          and property_id=$3::uuid and media_asset_id=$4::uuid and date_trunc('milliseconds',updated_at)=$5::timestamptz returning id`, targetParams);
        if (removed?.id !== target.attachmentId) throw new Error("Attachment delete not confirmed");
        const remains = await transaction.queryOne(`select id from public.${table} where id=$1::uuid and workspace_id=$2::uuid`,
          [target.attachmentId, input.workspaceId]);
        if (remains) throw new Error("Attachment remains after deletion");
      }
      // The scoped SECURITY DEFINER counter deliberately returns no row when the
      // asset is absent. Verify that all references are gone while the locked,
      // tenant-owned asset still exists, then let the FKs guard the final delete.
      const remainingReferences = await transaction.queryOne(referenceCountsSql, [input.assetId]);
      if (!remainingReferences || Object.values(remainingReferences).some(count => count !== 0)) throw new Error("Asset references remain");
      const removed = await transaction.queryOne(`delete from public.media_assets where id=$1::uuid and workspace_id=$2 returning id`,
        [input.assetId, input.workspaceId]);
      if (removed?.id !== input.assetId) throw new Error("Asset delete not confirmed");
      if (await transaction.queryOne(`select id from public.media_assets where id=$1::uuid and workspace_id=$2`,
        [input.assetId, input.workspaceId])) throw new Error("Asset remains after deletion");
      return asset;
    }, { pool: input.pool ?? getDeletionPool() });
  } catch (error) {
    if (fileAcknowledged) throw new MediaLifecycleError("MEDIA_RECORD_DELETE_UNCONFIRMED",
      "File deletion was acknowledged, but database cleanup or its commit could not be confirmed. Reload; the file may be unavailable. Do not retry automatically.");
    throw error;
  }
}
