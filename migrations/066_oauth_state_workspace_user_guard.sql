-- Bind each OAuth authorization state to a membership in the same workspace.
-- Migration 053 used independent foreign keys, which did not express this
-- cross-column tenant invariant at the database boundary.

create unique index if not exists workspace_users_workspace_id_id_uidx
  on public.workspace_users(workspace_id, id);

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'oauth_authorization_states_workspace_user_fk'
      and conrelid = 'public.oauth_authorization_states'::regclass
  ) then
    alter table public.oauth_authorization_states
      add constraint oauth_authorization_states_workspace_user_fk
      foreign key (workspace_id, user_id)
      references public.workspace_users(workspace_id, id)
      on delete cascade
      not valid;
  end if;
end
$$;

alter table public.oauth_authorization_states
  validate constraint oauth_authorization_states_workspace_user_fk;
