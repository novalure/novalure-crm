import { queryRows } from "@/lib/db/client";

export type AdminAuditLogEntry = {
  action: string;
  actorName: string | null;
  createdAt: string;
  entityId: string | null;
  entityType: string;
  id: string;
  projectId: string | null;
};

type AdminAuditLogRow = Omit<AdminAuditLogEntry, "createdAt"> & {
  createdAt: Date | string;
  totalCount: number | string;
};

export async function listAdminAuditLogs(input: {
  action: string;
  entityType: string;
  page: number;
  pageSize: number;
  query: string;
  workspaceId: string;
}) {
  const offset = (input.page - 1) * input.pageSize;
  const rows = await queryRows<AdminAuditLogRow>(
    `
      select
        al.id,
        al.project_id as "projectId",
        al.action,
        al.entity_type as "entityType",
        al.entity_id::text as "entityId",
        al.created_at as "createdAt",
        wu.name as "actorName",
        count(*) over () as "totalCount"
      from audit_logs al
      left join workspace_users wu
        on wu.id = al.actor_user_id
       and wu.workspace_id = al.workspace_id
      where al.workspace_id = $1::uuid
        and ($2::text = '' or al.action ilike '%' || $2 || '%')
        and ($3::text = '' or al.entity_type ilike '%' || $3 || '%')
        and (
          $4::text = ''
          or al.action ilike '%' || $4 || '%'
          or al.entity_type ilike '%' || $4 || '%'
          or coalesce(al.entity_id::text, '') ilike '%' || $4 || '%'
          or coalesce(wu.name, '') ilike '%' || $4 || '%'
        )
      order by al.created_at desc, al.id desc
      limit $5
      offset $6
    `,
    [input.workspaceId, input.action, input.entityType, input.query, input.pageSize, offset],
  );

  return {
    entries: rows.map((row) => ({
      action: row.action,
      actorName: row.actorName,
      createdAt: new Date(row.createdAt).toISOString(),
      entityId: row.entityId,
      entityType: row.entityType,
      id: row.id,
      projectId: row.projectId,
    })),
    total: Number(rows[0]?.totalCount ?? 0),
  };
}
