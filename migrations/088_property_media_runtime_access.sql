-- U1-C05: allow the safe tenant runtime role to execute the existing private
-- media workflows. Every application call must run inside withCrmRead so these
-- policies receive transaction-local tenant and actor context.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table media_assets enable row level security;
alter table media_assets force row level security;

drop policy if exists crm_media_metadata_read on media_assets;
drop policy if exists crm_media_workspace_read on media_assets;
drop policy if exists crm_media_workspace_insert on media_assets;
drop policy if exists crm_media_workspace_update on media_assets;
drop policy if exists crm_media_workspace_delete on media_assets;

create policy crm_media_workspace_read on media_assets
  for select to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')
    and exists (
      select 1 from workspace_users actor
      where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
    )
  );

create policy crm_media_workspace_insert on media_assets
  for insert to novalure_tenant_app
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')
    and exists (
      select 1 from workspace_users actor
      where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
        and actor.role in ('owner', 'admin', 'agent')
    )
  );

create policy crm_media_workspace_update on media_assets
  for update to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')
    and exists (
      select 1 from workspace_users actor
      where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
        and actor.role in ('owner', 'admin', 'agent')
    )
  )
  with check (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')
    and exists (
      select 1 from workspace_users actor
      where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
        and actor.role in ('owner', 'admin', 'agent')
    )
  );

create policy crm_media_workspace_delete on media_assets
  for delete to novalure_tenant_app
  using (
    workspace_id = nullif(current_setting('app.tenant_id', true), '')
    and exists (
      select 1 from workspace_users actor
      where actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
        and actor.status = 'active'
        and actor.role in ('owner', 'admin', 'agent')
    )
  );

grant select, insert, update, delete on table media_assets to novalure_tenant_app;
