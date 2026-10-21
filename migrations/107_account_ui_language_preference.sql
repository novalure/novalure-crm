-- Personal UI language is shared by an authentication identity's memberships.
-- No business language, entitlement, tenant policy, geo or credential is changed.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.account_ui_preferences (
  auth_identity_id uuid primary key references public.auth_identities(id),
  language_preference text not null default 'auto'
    check (language_preference in ('auto', 'de', 'en')),
  updated_at timestamptz not null default now()
);

alter table public.account_ui_preferences enable row level security;
alter table public.account_ui_preferences force row level security;

-- All roles can edit their own personal choice. The active actor and tenant
-- context must identify an active membership of that exact central identity.
create policy account_ui_preferences_own_identity on public.account_ui_preferences
  for all to novalure_tenant_app
  using (exists (
    select 1 from public.workspace_users actor
    where actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
      and actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and actor.status = 'active'
      and actor.auth_identity_id = account_ui_preferences.auth_identity_id
  ))
  with check (exists (
    select 1 from public.workspace_users actor
    where actor.id = nullif(current_setting('app.actor_id', true), '')::uuid
      and actor.workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and actor.status = 'active'
      and actor.auth_identity_id = account_ui_preferences.auth_identity_id
  ));

revoke all on public.account_ui_preferences from public, novalure_app, novalure_tenant_app;
grant select, insert, update on public.account_ui_preferences to novalure_tenant_app;
