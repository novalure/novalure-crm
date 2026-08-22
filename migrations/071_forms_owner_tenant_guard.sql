-- Bind every explicit Form owner to an active membership resolved by the
-- application and enforce the tenant relationship at the database boundary.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

create unique index if not exists workspace_users_workspace_id_id_uidx
  on public.workspace_users(workspace_id, id);

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'forms_workspace_owner_fk'
      and conrelid = 'public.forms'::regclass
  ) then
    alter table public.forms
      add constraint forms_workspace_owner_fk
      foreign key (workspace_id, owner_user_id)
      references public.workspace_users(workspace_id, id)
      deferrable initially deferred
      not valid;
  end if;
end;
$migration$;

-- Refuse the release migration when historical cross-tenant owner references
-- exist. They require an explicit, audited data-repair decision; silently
-- nulling or reassigning an owner here would hide corruption.
alter table public.forms
  validate constraint forms_workspace_owner_fk;

create index if not exists forms_workspace_owner_idx
  on public.forms(workspace_id, owner_user_id)
  where owner_user_id is not null;
