alter table contacts
  add column if not exists owner_user_id uuid references workspace_users(id) on delete set null;

with owner_backfill as (
  select
    c.id,
    coalesce(
      c.owner_user_id,
      lead_owner.assigned_to_user_id,
      deal_owner.owner_user_id,
      org.owner_user_id,
      workspace_owner.id
    ) as owner_user_id
  from contacts c
  left join organizations org
    on org.id = c.organization_id
   and org.workspace_id = c.workspace_id
  left join lateral (
    select l.assigned_to_user_id
    from leads l
    where l.workspace_id = c.workspace_id
      and l.contact_id = c.id
      and l.assigned_to_user_id is not null
    order by l.updated_at desc
    limit 1
  ) lead_owner on true
  left join lateral (
    select d.owner_user_id
    from deals d
    where d.workspace_id = c.workspace_id
      and d.contact_id = c.id
      and d.owner_user_id is not null
    order by d.updated_at desc
    limit 1
  ) deal_owner on true
  left join lateral (
    select wu.id
    from workspace_users wu
    where wu.workspace_id = c.workspace_id
      and wu.status = 'active'
      and wu.role in ('owner', 'admin')
    order by case wu.role when 'owner' then 0 else 1 end, wu.created_at asc
    limit 1
  ) workspace_owner on true
)
update contacts c
set
  owner_user_id = owner_backfill.owner_user_id,
  updated_at = now()
from owner_backfill
where c.id = owner_backfill.id
  and c.owner_user_id is null
  and owner_backfill.owner_user_id is not null;

create index if not exists contacts_workspace_owner_active_idx
  on contacts(workspace_id, owner_user_id, updated_at desc)
  where archived_at is null;
