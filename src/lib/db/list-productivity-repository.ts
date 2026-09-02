import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import type { CrmEntityKind } from "@/lib/list-query-state";
import {
  normalizeTags,
  sanitizeSavedViewState,
  type BulkActionInput,
} from "@/lib/list-productivity";
import { listGlobalSearchRecents } from "@/lib/db/global-search-repository";
import { withTenantTransaction, type TenantTransaction } from "@/lib/db/tenant-client";

type SavedViewRow = {
  archivedAt: string | Date | null;
  columnState: unknown;
  createdAt: string | Date;
  entityType: CrmEntityKind;
  id: string;
  isShared: boolean;
  name: string;
  ownerUserId: string;
  projectId: string | null;
  queryState: unknown;
  rowVersion: number;
  updatedAt: string | Date;
  workspaceId: string;
};

type BatchView = {
  actionType: string;
  blockedCount: number;
  completedAt: string | Date | null;
  failedCount: number;
  id: string;
  requestedCount: number;
  status: string;
  succeededCount: number;
};

type BatchRow = BatchView & { requestSha256: string | null };

type CandidateRow = {
  contactId: string | null;
  id: string;
  projectId: string | null;
};

const entitySources: Readonly<Partial<Record<CrmEntityKind, Readonly<{
  ownerColumn?: string;
  table: string;
}>>>> = Object.freeze({
  contact: Object.freeze({ ownerColumn: "owner_user_id", table: "contacts" }),
  deal: Object.freeze({ ownerColumn: "owner_user_id", table: "deals" }),
  lead: Object.freeze({ ownerColumn: "assigned_to_user_id", table: "leads" }),
  organization: Object.freeze({ ownerColumn: "owner_user_id", table: "organizations" }),
  property: Object.freeze({ ownerColumn: "owner_user_id", table: "seller_listings" }),
  task: Object.freeze({ ownerColumn: "owner_user_id", table: "tasks" }),
});

function canManageWorkspaceRecords(session: AppSession) {
  return canViewAllWorkspaceContacts(session);
}

function hasProjectScopedRecordAccess(session: AppSession) {
  return session.productRole === "developer_sales" || session.productRole === "project_sales_member";
}

function iso(value: string | Date | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toBatchView(row: BatchRow): BatchView {
  return {
    actionType: row.actionType,
    blockedCount: row.blockedCount,
    completedAt: row.completedAt,
    failedCount: row.failedCount,
    id: row.id,
    requestedCount: row.requestedCount,
    status: row.status,
    succeededCount: row.succeededCount,
  };
}

function toSavedView(row: SavedViewRow) {
  return {
    archivedAt: iso(row.archivedAt),
    columnState: Array.isArray(row.columnState) ? row.columnState : [],
    createdAt: iso(row.createdAt),
    entityType: row.entityType,
    id: row.id,
    isShared: row.isShared,
    name: row.name,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    queryState: row.queryState && typeof row.queryState === "object" ? row.queryState : {},
    rowVersion: Number(row.rowVersion),
    updatedAt: iso(row.updatedAt),
    workspaceId: row.workspaceId,
  };
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function cleanName(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 100) : "";
}

function columnState(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map(String)
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(entry))
    .slice(0, 40);
}

export async function listSavedViews(input: {
  entityType: CrmEntityKind;
  page?: number;
  pageSize?: number;
  session: AppSession;
}) {
  const page = positiveInteger(input.page, 1, 10_000);
  const pageSize = positiveInteger(input.pageSize, 25, 100);
  const offset = (page - 1) * pageSize;
  const manager = canManageWorkspaceRecords(input.session);
  const projectEditor = hasProjectScopedRecordAccess(input.session);
  const readScope = `(
    (owner_user_id = $3::uuid and is_shared = false)
    or (
      is_shared = true
      and (
        project_id is null
        or $4::boolean
        or (
          $5::boolean and exists (
            select 1 from project_pipeline_permissions view_permission
             where view_permission.workspace_id = crm_saved_views.workspace_id
               and view_permission.project_id = crm_saved_views.project_id
               and view_permission.user_id = $3::uuid
               and view_permission.can_edit_deals = true
          )
        )
        or exists (
          select 1 from customer_project_access view_access
           where view_access.workspace_id = crm_saved_views.workspace_id
             and view_access.project_id = crm_saved_views.project_id
             and view_access.user_id = $3::uuid
             and view_access.status = 'active'
             and view_access.can_view_project = true
        )
      )
    )
  )`;

  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const [rows, totalRow] = await Promise.all([
        transaction.query<SavedViewRow>(
          `
            select
              id,
              workspace_id as "workspaceId",
              project_id as "projectId",
              owner_user_id as "ownerUserId",
              entity_type as "entityType",
              name,
              query_state as "queryState",
              column_state as "columnState",
              is_shared as "isShared",
              row_version as "rowVersion",
              archived_at as "archivedAt",
              created_at as "createdAt",
              updated_at as "updatedAt"
            from crm_saved_views
            where workspace_id = $1::uuid
              and entity_type = $2
              and archived_at is null
              and ${readScope}
            order by is_shared desc, updated_at desc, id
            limit $6 offset $7
          `,
          [input.session.workspaceId, input.entityType, input.session.userId, manager, projectEditor, pageSize, offset],
        ),
        transaction.queryOne<{ total: number | string }>(
          `
            select count(*)::int as total
            from crm_saved_views
            where workspace_id = $1::uuid
              and entity_type = $2
              and archived_at is null
              and ${readScope}
          `,
          [input.session.workspaceId, input.entityType, input.session.userId, manager, projectEditor],
        ),
      ]);
      return { page, pageSize, total: Number(totalRow?.total ?? 0), views: rows.map(toSavedView) };
    },
  );
}

export async function saveSavedView(input: {
  columnState?: unknown;
  entityType: CrmEntityKind;
  id?: string | null;
  isShared?: boolean;
  name: unknown;
  projectId?: string | null;
  queryState: unknown;
  rowVersion?: number | null;
  session: AppSession;
}) {
  const name = cleanName(input.name);
  if (!name) return { error: "A saved-view name is required.", ok: false as const };

  try {
    const row = await withTenantTransaction(
      { actorId: input.session.userId, workspaceId: input.session.workspaceId },
      async (transaction) => {
        if (input.projectId) await assertProject(transaction, input.session.workspaceId, input.projectId);
        if (input.id) {
          return transaction.queryOne<SavedViewRow>(
            `
              update crm_saved_views
              set
                project_id = $4::uuid,
                name = $5,
                query_state = $6::jsonb,
                column_state = $7::jsonb,
                is_shared = $8,
                row_version = row_version + 1,
                updated_at = now()
              where id = $1::uuid
                and workspace_id = $2::uuid
                and owner_user_id = $3::uuid
                and entity_type = $10
                and archived_at is null
                and row_version = $9
              returning
                id, workspace_id as "workspaceId", project_id as "projectId",
                owner_user_id as "ownerUserId", entity_type as "entityType", name,
                query_state as "queryState", column_state as "columnState",
                is_shared as "isShared", row_version as "rowVersion",
                archived_at as "archivedAt", created_at as "createdAt", updated_at as "updatedAt"
            `,
            [
              input.id,
              input.session.workspaceId,
              input.session.userId,
              input.projectId ?? null,
              name,
              JSON.stringify(sanitizeSavedViewState(input.queryState)),
              JSON.stringify(columnState(input.columnState)),
              input.isShared === true,
              positiveInteger(input.rowVersion, 0, Number.MAX_SAFE_INTEGER),
              input.entityType,
            ],
          );
        }

        return transaction.queryOne<SavedViewRow>(
          `
            insert into crm_saved_views (
              workspace_id, project_id, owner_user_id, entity_type, name,
              query_state, column_state, is_shared
            )
            values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::jsonb, $8)
            returning
              id, workspace_id as "workspaceId", project_id as "projectId",
              owner_user_id as "ownerUserId", entity_type as "entityType", name,
              query_state as "queryState", column_state as "columnState",
              is_shared as "isShared", row_version as "rowVersion",
              archived_at as "archivedAt", created_at as "createdAt", updated_at as "updatedAt"
          `,
          [
            input.session.workspaceId,
            input.projectId ?? null,
            input.session.userId,
            input.entityType,
            name,
            JSON.stringify(sanitizeSavedViewState(input.queryState)),
            JSON.stringify(columnState(input.columnState)),
            input.isShared === true,
          ],
        );
      },
    );
    return row ? { ok: true as const, view: toSavedView(row) } : { error: "Saved view is stale or unavailable.", ok: false as const };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Saved view could not be persisted.", ok: false as const };
  }
}

export async function archiveSavedView(input: {
  id: string;
  rowVersion: number;
  session: AppSession;
}) {
  const row = await withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    (transaction) => transaction.queryOne<{ id: string }>(
      `
        update crm_saved_views
        set archived_at = now(), row_version = row_version + 1, updated_at = now()
        where id = $1::uuid
          and workspace_id = $2::uuid
          and owner_user_id = $3::uuid
          and archived_at is null
          and row_version = $4
        returning id
      `,
      [input.id, input.session.workspaceId, input.session.userId, input.rowVersion],
    ),
  );
  return row ? { id: row.id, ok: true as const } : { error: "Saved view is stale or unavailable.", ok: false as const };
}

export async function listRecentRecords(input: { limit?: number; session: AppSession }) {
  const limit = positiveInteger(input.limit, 8, 20);
  const records = await listGlobalSearchRecents({ limit, session: input.session });
  return records.map((record) => ({
    entityId: record.id,
    entityType: record.entityType,
    href: record.url,
    label: record.title,
    openedAt: record.openedAt,
    projectId: record.projectId,
  }));
}

export async function executeBulkAction(input: {
  action: BulkActionInput;
  idempotencyKey: string;
  session: AppSession;
}) {
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      if (input.action.projectId) await assertProject(transaction, input.session.workspaceId, input.action.projectId);
      if (input.action.action === "assign_owner") {
        await assertActiveOwner(transaction, input.session.workspaceId, String(input.action.payload.ownerUserId));
      }
      const requestSha256 = bulkActionRequestSha256(input.action);

      const batch = await transaction.queryOne<{ id: string }>(
        `
          insert into crm_bulk_runtime_batches (
            workspace_id, project_id, actor_user_id, idempotency_key, request_sha256,
            action_type, entity_type, requested_count, succeeded_count, blocked_count,
            failed_count, status, selection_ids, payload, metadata, updated_at
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 0, 0, 0,
            'running', $9::jsonb, $10::jsonb, $11::jsonb, now()
          )
          on conflict (workspace_id, actor_user_id, idempotency_key)
            where actor_user_id is not null and idempotency_key is not null
          do nothing
          returning id
        `,
        [
          input.session.workspaceId,
          input.action.projectId ?? null,
          input.session.userId,
          input.idempotencyKey,
          requestSha256,
          input.action.action,
          input.action.entityType,
          input.action.entityIds.length,
          JSON.stringify(input.action.entityIds),
          JSON.stringify(normalizedBulkPayload(input.action)),
          JSON.stringify({ confirmationCount: input.action.entityIds.length, source: "list_productivity" }),
        ],
      );

      if (!batch) {
        const existing = await loadBatchByIdempotency(
          transaction,
          input.session.workspaceId,
          input.session.userId,
          input.idempotencyKey,
        );
        if (!existing) throw new Error("Idempotent bulk action could not be resolved.");
        if (existing.requestSha256 !== requestSha256) {
          throw new Error("Idempotency-Key is already bound to a different bulk action payload.");
        }
        return { batch: toBatchView(existing), reused: true };
      }

      const candidates = await loadCandidates(transaction, input.session, input.action);
      const candidateIds = new Set(candidates.map((row) => row.id));
      const updatedIds = await applyBulkMutation(transaction, input.session, batch.id, input.action, candidates);
      const succeeded = new Set(updatedIds);
      const items = input.action.entityIds.map((entityId) => ({
        entityId,
        error: !candidateIds.has(entityId)
          ? "Record is outside the permitted workspace or project scope."
          : succeeded.has(entityId)
            ? null
            : "Record did not satisfy the action precondition.",
        status: succeeded.has(entityId) ? "succeeded" : "blocked",
      }));
      const succeededCount = items.filter((item) => item.status === "succeeded").length;
      const blockedCount = items.length - succeededCount;
      const status = blockedCount === 0 ? "completed" : succeededCount > 0 ? "partially_completed" : "failed";

      await transaction.execute(
        `
          insert into crm_bulk_runtime_batch_items (workspace_id, batch_id, entity_id, status, error)
          select $1::uuid, $2::uuid, item.entity_id::uuid, item.status, item.error
          from jsonb_to_recordset($3::jsonb) as item(entity_id text, status text, error text)
        `,
        [
          input.session.workspaceId,
          batch.id,
          JSON.stringify(items.map((item) => ({ entity_id: item.entityId, error: item.error, status: item.status }))),
        ],
      );
      const completed = await transaction.queryOne<BatchRow>(
        `
          update crm_bulk_runtime_batches
          set
            succeeded_count = $3,
            blocked_count = $4,
            failed_count = 0,
            status = $5,
            completed_at = now(),
            updated_at = now()
          where id = $1::uuid and workspace_id = $2::uuid
          returning id, action_type as "actionType", requested_count as "requestedCount",
            succeeded_count as "succeededCount", blocked_count as "blockedCount",
            failed_count as "failedCount", status, completed_at as "completedAt",
            request_sha256 as "requestSha256"
        `,
        [batch.id, input.session.workspaceId, succeededCount, blockedCount, status],
      );
      await transaction.execute(
        `
          insert into audit_logs (
            workspace_id, actor_user_id, action, entity_type, entity_id,
            project_id, before, after
          ) values ($1::uuid, $2::uuid, $3, 'crm_bulk_runtime_batch', $4::uuid, $5::uuid, null, $6::jsonb)
        `,
        [
          input.session.workspaceId,
          input.session.userId,
          `bulk.${input.action.action}`,
          batch.id,
          input.action.projectId ?? null,
          JSON.stringify({ blockedCount, entityType: input.action.entityType, requestedCount: items.length, succeededCount }),
        ],
      );
      if (!completed) throw new Error("Bulk action ledger could not be completed.");
      return { batch: toBatchView(completed), items, reused: false };
    },
  );
}

async function assertProject(transaction: TenantTransaction, workspaceId: string, projectId: string) {
  const row = await transaction.queryOne<{ id: string }>(
    "select id from projects where workspace_id = $1::uuid and id = $2::uuid limit 1",
    [workspaceId, projectId],
  );
  if (!row) throw new Error("Project is outside the permitted workspace.");
}

async function assertActiveOwner(transaction: TenantTransaction, workspaceId: string, ownerUserId: string) {
  const row = await transaction.queryOne<{ id: string }>(
    "select id from workspace_users where workspace_id = $1::uuid and id = $2::uuid and status = 'active' limit 1",
    [workspaceId, ownerUserId],
  );
  if (!row) throw new Error("Owner is outside the permitted workspace or inactive.");
}

async function loadBatchByIdempotency(
  transaction: TenantTransaction,
  workspaceId: string,
  actorUserId: string,
  idempotencyKey: string,
) {
  return transaction.queryOne<BatchRow>(
    `
      select id, action_type as "actionType", requested_count as "requestedCount",
        succeeded_count as "succeededCount", blocked_count as "blockedCount",
        failed_count as "failedCount", status, completed_at as "completedAt",
        request_sha256 as "requestSha256"
      from crm_bulk_runtime_batches
      where workspace_id = $1::uuid and actor_user_id = $2::uuid and idempotency_key = $3
      limit 1
    `,
    [workspaceId, actorUserId, idempotencyKey],
  );
}

async function loadCandidates(
  transaction: TenantTransaction,
  session: AppSession,
  action: BulkActionInput,
) {
  const source = entitySources[action.entityType];
  if (!source) return [];
  const contactExpression = action.entityType === "contact"
    ? "source.id"
    : action.entityType === "lead" || action.entityType === "deal" || action.entityType === "task"
      ? `(
          select scoped_contact.id
          from contacts scoped_contact
          where scoped_contact.workspace_id = source.workspace_id
            and scoped_contact.id = source.contact_id
          limit 1
        )`
      : "null::uuid";
  const ownerExpression = source.ownerColumn ? `source.${source.ownerColumn}` : "null::uuid";
  return transaction.query<CandidateRow>(
    `
      select
        source.id,
        (
          select scoped_project.id
          from projects scoped_project
          where scoped_project.workspace_id = source.workspace_id
            and scoped_project.id = source.project_id
          limit 1
        ) as "projectId",
        ${contactExpression} as "contactId"
      from ${source.table} source
      where source.workspace_id = $1::uuid
        and source.id = any($2::uuid[])
        and ($3::uuid is null or source.project_id = $3::uuid)
        and (
          $4::boolean
          or ${ownerExpression} = $5::uuid
          or (
            $6::boolean
            and source.project_id is not null
            and exists (
              select 1
              from project_pipeline_permissions bulk_permission
              where bulk_permission.workspace_id = source.workspace_id
                and bulk_permission.project_id = source.project_id
                and bulk_permission.user_id = $5::uuid
                and bulk_permission.can_edit_deals = true
            )
          )
        )
      for update of source
    `,
    [
      session.workspaceId,
      action.entityIds,
      action.projectId ?? null,
      canManageWorkspaceRecords(session),
      session.userId,
      hasProjectScopedRecordAccess(session),
    ],
  );
}

function normalizedBulkPayload(action: BulkActionInput) {
  if (action.action === "assign_owner") return { ownerUserId: action.payload.ownerUserId };
  if (action.action === "add_tags") return { tags: normalizeTags(action.payload.tags) };
  if (action.action === "create_follow_up") {
    return {
      dueAt: String(action.payload.dueAt),
      priority: ["Hoch", "Mittel", "Normal"].includes(String(action.payload.priority)) ? action.payload.priority : "Normal",
      title: String(action.payload.title).trim().slice(0, 160),
    };
  }
  return {};
}

function bulkActionRequestSha256(action: BulkActionInput) {
  const payload = normalizedBulkPayload(action);
  const canonicalPayload = action.action === "add_tags"
    ? { ...payload, tags: [...normalizeTags(action.payload.tags)].sort() }
    : payload;
  return createHash("sha256").update(JSON.stringify({
    action: action.action,
    entityIds: [...action.entityIds].sort(),
    entityType: action.entityType,
    payload: canonicalPayload,
    projectId: action.projectId ?? null,
  }), "utf8").digest("hex");
}

async function applyBulkMutation(
  transaction: TenantTransaction,
  session: AppSession,
  batchId: string,
  action: BulkActionInput,
  candidates: CandidateRow[],
) {
  if (!candidates.length) return [];
  const ids = candidates.map((row) => row.id);
  const source = entitySources[action.entityType];
  if (!source) return [];

  if (action.action === "assign_owner" && source.ownerColumn) {
    const rows = await transaction.query<{ id: string }>(
      `
        update ${source.table}
        set ${source.ownerColumn} = $3::uuid, updated_at = now()
        where workspace_id = $1::uuid and id = any($2::uuid[])
        returning id
      `,
      [session.workspaceId, ids, action.payload.ownerUserId],
    );
    return rows.map((row) => row.id);
  }

  if (action.action === "add_tags") {
    const tags = normalizeTags(action.payload.tags);
    const rows = await transaction.query<{ id: string }>(
      `
        update ${source.table}
        set
          metadata = jsonb_set(
            coalesce(metadata, '{}'::jsonb),
            '{tags}',
            (
              select coalesce(jsonb_agg(distinct tag), '[]'::jsonb)
              from jsonb_array_elements(
                coalesce(metadata->'tags', '[]'::jsonb) || $3::jsonb
              ) as existing(tag)
            ),
            true
          ),
          updated_at = now()
        where workspace_id = $1::uuid and id = any($2::uuid[])
        returning id
      `,
      [session.workspaceId, ids, JSON.stringify(tags)],
    );
    return rows.map((row) => row.id);
  }

  if (action.action === "archive" && action.entityType === "contact") {
    const rows = await transaction.query<{ id: string }>(
      `
        update contacts
        set archived_at = now(), archived_by_user_id = $3::uuid, updated_at = now()
        where workspace_id = $1::uuid and id = any($2::uuid[]) and archived_at is null
        returning id
      `,
      [session.workspaceId, ids, session.userId],
    );
    return rows.map((row) => row.id);
  }

  if (action.action === "pause_portal" && action.entityType === "property") {
    const rows = await transaction.query<{ id: string }>(
      `
        update property_channels
        set status = 'paused', metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb, updated_at = now()
        where workspace_id = $1::uuid
          and property_id = any($2::uuid[])
          and status not in ('paused', 'withdrawn')
        returning property_id as id
      `,
      [session.workspaceId, ids, JSON.stringify({ pausedByBulkBatchId: batchId })],
    );
    return [...new Set(rows.map((row) => row.id))];
  }

  if (action.action === "create_follow_up") {
    const payload = normalizedBulkPayload(action) as { dueAt: string; priority: string; title: string };
    const contactById = new Map(candidates.map((row) => [row.id, row.contactId]));
    const projectById = new Map(candidates.map((row) => [row.id, row.projectId]));
    const succeeded: string[] = [];
    for (const id of ids) {
      const projectId = projectById.get(id);
      if (!projectId) continue;
      const task = await transaction.queryOne<{ id: string }>(
        `
          insert into tasks (
            workspace_id, project_id, contact_id, owner_user_id, title,
            due_at, priority, status, metadata
          ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7, 'open', $8::jsonb)
          returning id
        `,
        [
          session.workspaceId,
          projectId,
          contactById.get(id) ?? null,
          session.userId,
          payload.title,
          payload.dueAt,
          payload.priority,
          JSON.stringify({ bulkBatchId: batchId, sourceEntityId: id, sourceEntityType: action.entityType }),
        ],
      );
      if (task) succeeded.push(id);
    }
    return succeeded;
  }

  return [];
}
