import "server-only";

import type { AppSession } from "@/lib/auth/session";
import {
  canManageBrokerFinancials,
  canUseBrokerProjectEditScope,
} from "@/lib/broker-flow/access-policy";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import { buildCrmEntityDeepLink } from "@/lib/list-query-state";
import { canPersist, writeAuditLog } from "@/lib/db/runtime-repositories";
import { withTenantTransaction, type TenantTransaction } from "@/lib/db/tenant-client";
import {
  canManageContent,
  claimSafeMutation,
  completeSafeMutation,
  contentDocumentReadAccessSql,
  ContentRepositoryError,
} from "@/lib/db/content-library-repositories";

export const globalSearchEntityTypes = [
  "contact",
  "organization",
  "lead",
  "project",
  "property",
  "unit",
  "deal",
  "task",
  "document",
  "closing",
] as const;

export type GlobalSearchEntityType = (typeof globalSearchEntityTypes)[number];

type SearchRow = {
  entityType: GlobalSearchEntityType;
  id: string;
  title: string;
  subtitle: string;
  projectId: string | null;
  updatedAt: Date | string;
};

type RecentSearchRow = SearchRow & {
  openedAt: Date | string;
};

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function searchUrl(session: AppSession, row: Pick<SearchRow, "entityType" | "id" | "projectId">) {
  const section: Record<GlobalSearchEntityType, string> = {
    contact: "contacts",
    organization: "contacts",
    lead: "leadInbox",
    project: "projects",
    property: "properties",
    unit: "units",
    deal: "pipelines",
    task: "tasks",
    document: "knowledge",
    closing: "objectsMandates",
  };
  return buildCrmEntityDeepLink({
    currentUrl: "/",
    entityId: row.id,
    entityType: row.entityType,
    workspaceId: session.workspaceId,
    projectId: row.projectId ?? "all",
    section: section[row.entityType],
  });
}

function mapSearchRow(session: AppSession, row: SearchRow) {
  return {
    ...row,
    updatedAt: iso(row.updatedAt),
    url: searchUrl(session, row),
  };
}

const candidatesSql = `
  with visible_projects as (
    select p.id
      from projects p
     where p.workspace_id = $1
       and (
         $3::boolean
         or (
           not $8::boolean
           and exists (
            select 1 from customer_project_access cpa
             where cpa.workspace_id = p.workspace_id and cpa.project_id = p.id
               and cpa.user_id = $2::uuid and cpa.status = 'active' and cpa.can_view_project = true
           )
         )
         or (
           $8::boolean
           and exists (
             select 1 from project_pipeline_permissions ppp
              where ppp.workspace_id = p.workspace_id and ppp.project_id = p.id
                and ppp.user_id = $2::uuid and ppp.can_edit_deals = true
           )
         )
       )
  ), candidates as (
    select 'contact'::text as "entityType", c.id, c.name as title,
           concat_ws(' · ', nullif(c.email, ''), nullif(c.phone, '')) as subtitle,
           c.project_id as "projectId", c.updated_at as "updatedAt"
      from contacts c
     where c.workspace_id = $1 and c.archived_at is null
       and ($3::boolean or c.owner_user_id = $2)
       and ($4::uuid is null or c.project_id = $4)
       and ($6::uuid is null or c.owner_user_id = $6)
       and ($5 = '' or c.name ilike '%' || $5 || '%' or coalesce(c.email, '') ilike '%' || $5 || '%'
            or coalesce(c.phone, '') ilike '%' || $5 || '%')
    union all
    select 'organization', o.id, o.name,
           concat_ws(' · ', nullif(o.domain, ''), nullif(o.city, '')),
           o.project_id, o.updated_at
      from organizations o
     where o.workspace_id = $1 and ($3::boolean or o.owner_user_id = $2)
       and ($4::uuid is null or o.project_id = $4)
       and ($6::uuid is null or o.owner_user_id = $6)
       and ($5 = '' or o.name ilike '%' || $5 || '%' or coalesce(o.domain, '') ilike '%' || $5 || '%')
    union all
    select 'lead', l.id, coalesce(nullif(l.intent, ''), 'Lead ' || left(l.id::text, 8)),
           concat_ws(' · ', nullif(l.status, ''), nullif(l.source, '')),
           l.project_id, l.updated_at
      from leads l
     where l.workspace_id = $1 and ($3::boolean or l.assigned_to_user_id = $2)
       and ($4::uuid is null or l.project_id = $4)
       and ($6::uuid is null or l.assigned_to_user_id = $6)
       and ($5 = '' or coalesce(l.intent, '') ilike '%' || $5 || '%'
            or l.status ilike '%' || $5 || '%' or l.source ilike '%' || $5 || '%')
    union all
    select 'project', p.id, p.name, concat_ws(' · ', p.type, p.status), p.id, p.updated_at
      from projects p
      join visible_projects visible_project on visible_project.id = p.id
     where p.workspace_id = $1 and ($4::uuid is null or p.id = $4) and $6::uuid is null
       and ($5 = '' or p.name ilike '%' || $5 || '%' or p.type ilike '%' || $5 || '%')
    union all
    select 'property', s.id, s.title, concat_ws(' · ', nullif(s.address, ''), nullif(s.region, '')),
           s.project_id, s.updated_at
     from seller_listings s
      left join leads seller_lead on seller_lead.id = s.seller_lead_id and seller_lead.workspace_id = s.workspace_id
     where s.workspace_id = $1 and ($4::uuid is null or s.project_id = $4)
       and (
         $3::boolean or s.owner_user_id = $2 or seller_lead.assigned_to_user_id = $2
         or exists (select 1 from visible_projects visible where visible.id = s.project_id)
       )
       and ($6::uuid is null or s.owner_user_id = $6 or seller_lead.assigned_to_user_id = $6)
       and ($5 = '' or s.title ilike '%' || $5 || '%' or s.address ilike '%' || $5 || '%'
            or s.region ilike '%' || $5 || '%')
    union all
    select 'unit', u.id, 'Einheit ' || u.unit_number,
           concat_ws(' · ', nullif(u.status, ''), u.area_sqm::text || ' m²'), u.project_id, u.updated_at
      from property_units u
     left join contacts buyer on buyer.id = u.buyer_contact_id and buyer.workspace_id = u.workspace_id
      left join deals unit_deal on unit_deal.id = u.deal_id and unit_deal.workspace_id = u.workspace_id
     where u.workspace_id = $1 and ($4::uuid is null or u.project_id = $4)
       and (
         $3::boolean or buyer.owner_user_id = $2 or unit_deal.owner_user_id = $2
         or exists (select 1 from visible_projects visible where visible.id = u.project_id)
       )
       and ($6::uuid is null or buyer.owner_user_id = $6 or unit_deal.owner_user_id = $6)
       and ($5 = '' or u.unit_number ilike '%' || $5 || '%' or u.status ilike '%' || $5 || '%')
    union all
    select 'deal', d.id, d.name, concat_ws(' · ', nullif(d.stage, ''), nullif(d.next_action, '')),
           d.project_id, d.updated_at
      from deals d
     where d.workspace_id = $1 and ($3::boolean or d.owner_user_id = $2)
       and ($4::uuid is null or d.project_id = $4)
       and ($6::uuid is null or d.owner_user_id = $6)
       and ($5 = '' or d.name ilike '%' || $5 || '%' or d.stage ilike '%' || $5 || '%')
    union all
    select 'task', task.id, task.title, concat_ws(' · ', nullif(task.status, ''), nullif(task.priority, '')),
           task.project_id, task.updated_at
      from tasks task
     where task.workspace_id = $1 and ($3::boolean or task.owner_user_id = $2)
       and ($4::uuid is null or task.project_id = $4)
       and ($6::uuid is null or task.owner_user_id = $6)
       and ($5 = '' or task.title ilike '%' || $5 || '%' or task.status ilike '%' || $5 || '%')
    union all
    select 'document', doc.id, doc.title,
           concat_ws(' · ', nullif(doc.category, ''), nullif(doc.approval_status, '')),
           doc.project_id, doc.updated_at
      from crm_content_documents doc
     where doc.workspace_id = $1 and doc.archived_at is null
       and ${contentDocumentReadAccessSql("doc", "$2", "$7")}
       and ($4::uuid is null or doc.project_id = $4)
       and ($6::uuid is null or doc.owner_user_id = $6)
       and ($5 = '' or doc.title ilike '%' || $5 || '%' or doc.category ilike '%' || $5 || '%'
            or $5 = any(doc.tags))
    union all
    select 'closing', closing.id,
           concat_ws(' · ', closing.contract_type, left(closing.id::text, 8)),
           concat_ws(
             ' · ',
             closing.status,
             case when $9::boolean then closing.payment_status end,
             case when $9::boolean then closing.currency end
           ),
           closing.project_id, closing.updated_at
      from broker_closings closing
     where closing.workspace_id = $1
       and (
         $3::boolean or closing.owner_user_id = $2
         or (
           $8::boolean
           and exists (
             select 1 from project_pipeline_permissions closing_permission
              where closing_permission.workspace_id = closing.workspace_id
                and closing_permission.project_id = closing.project_id
                and closing_permission.user_id = $2::uuid
                and closing_permission.can_edit_deals = true
           )
         )
       )
       and ($4::uuid is null or closing.project_id = $4)
       and ($6::uuid is null or closing.owner_user_id = $6)
       and ($5 = '' or closing.contract_type ilike '%' || $5 || '%'
             or closing.status ilike '%' || $5 || '%'
             or ($9::boolean and closing.payment_status ilike '%' || $5 || '%'))
  )`;

function searchParams(input: {
  session: AppSession;
  query: string;
  projectId?: string | null;
  ownerUserId?: string | null;
}) {
  const manager = canViewAllWorkspaceContacts(input.session);
  const contentManager = canManageContent(input.session);
  const projectEditVisibility = canUseBrokerProjectEditScope(input.session);
  const financialsVisible = canManageBrokerFinancials(input.session);
  const requestedOwner = input.ownerUserId ?? null;
  const owner = requestedOwner ? (manager ? requestedOwner : input.session.userId) : null;
  return [
    input.session.workspaceId,
    input.session.userId,
    manager,
    input.projectId ?? null,
    input.query,
    owner,
    contentManager,
    projectEditVisibility,
    financialsVisible,
  ];
}

export async function searchWorkspaceRecords(input: {
  session: AppSession;
  query: string;
  projectId?: string | null;
  ownerUserId?: string | null;
  page: number;
  pageSize: number;
  offset: number;
}) {
  if (!canPersist()) {
    throw new ContentRepositoryError("PERSISTENCE_UNAVAILABLE", "Global search requires database persistence");
  }
  const query = input.query.trim().slice(0, 160);
  if (query.length < 2) {
    return { items: [], page: input.page, pageSize: input.pageSize, total: 0 };
  }
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const params = searchParams({ ...input, query });
      const [rows, count] = await Promise.all([
        transaction.query<SearchRow>(
          `${candidatesSql}
           select * from candidates
            order by case when lower(title) = lower($5) then 0
                          when lower(title) like lower($5) || '%' then 1 else 2 end,
                     "updatedAt" desc, "entityType", id
             limit $10 offset $11`,
          [...params, input.pageSize, input.offset],
        ),
        transaction.queryOne<{ total: string }>(
          `${candidatesSql} select count(*)::text as total from candidates`,
          params,
        ),
      ]);
      return {
        items: rows.map((row) => mapSearchRow(input.session, row)),
        page: input.page,
        pageSize: input.pageSize,
        total: Number(count?.total ?? 0),
      };
    },
  );
}

async function findAccessibleRecord(input: {
  transaction: TenantTransaction;
  session: AppSession;
  entityType: GlobalSearchEntityType;
  entityId: string;
  projectId?: string | null;
}) {
  const params = searchParams({
    session: input.session,
    query: "",
    projectId: input.projectId,
    ownerUserId: null,
  });
  return input.transaction.queryOne<SearchRow>(
    `${candidatesSql}
     select * from candidates where "entityType" = $10 and id = $11 limit 1`,
    [...params, input.entityType, input.entityId],
  );
}

export async function recordGlobalSearchRecent(input: {
  session: AppSession;
  idempotencyKey: string;
  entityType: GlobalSearchEntityType;
  entityId: string;
  projectId?: string | null;
}) {
  if (!canPersist()) {
    throw new ContentRepositoryError("PERSISTENCE_UNAVAILABLE", "Search recents require database persistence");
  }
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "search.recent.record";
      const payload = { entityType: input.entityType, entityId: input.entityId, projectId: input.projectId ?? null };
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const row = await findAccessibleRecord({ transaction, session: input.session,
        entityType: input.entityType, entityId: input.entityId, projectId: input.projectId });
      if (!row) throw new ContentRepositoryError("NOT_FOUND", "Search record is not accessible");
      const mapped = mapSearchRow(input.session, row);
      await transaction.execute(
        `insert into crm_recent_records (
           workspace_id, user_id, entity_type, entity_id, project_id, label, href, opened_at
         ) values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (workspace_id, user_id, entity_type, entity_id)
         do update set project_id = excluded.project_id, label = excluded.label,
           href = excluded.href, opened_at = now()`,
        [input.session.workspaceId, input.session.userId, row.entityType, row.id, row.projectId,
          row.title, mapped.url],
      );
      const response = { recent: mapped, replayed: false };
      await writeAuditLog({ session: input.session, action: "search.recent.recorded",
        entityType: row.entityType, entityId: row.id, projectId: row.projectId,
        after: { source: "global_search" }, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function listGlobalSearchRecents(input: {
  session: AppSession;
  projectId?: string | null;
  limit?: number;
}) {
  if (!canPersist()) {
    throw new ContentRepositoryError("PERSISTENCE_UNAVAILABLE", "Search recents require database persistence");
  }
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const params = searchParams({ session: input.session, query: "", projectId: input.projectId, ownerUserId: null });
      const rows = await transaction.query<RecentSearchRow>(
        `${candidatesSql}
         select candidate.*, recent.opened_at as "openedAt"
           from crm_recent_records recent
           join candidates candidate
             on candidate."entityType" = recent.entity_type and candidate.id = recent.entity_id
          where recent.workspace_id = $1 and recent.user_id = $2
          order by recent.opened_at desc
           limit $10`,
        [...params, Math.max(1, Math.min(20, input.limit ?? 8))],
      );
      return rows.map((row) => ({
        ...mapSearchRow(input.session, row),
        openedAt: iso(row.openedAt),
      }));
    },
  );
}
