-- CRM-owned receipts and booking state for the signed Novalure Studio boundary.
-- This migration is source only until the normal QA/Production migration gates pass.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $verify$
begin
  if not exists (select 1 from public.novalure_schema_migrations
                 where version = '096_public_integration_gateway') then
    raise exception 'Migration 096 must precede Studio Sales calendar bridge';
  end if;
end;
$verify$;

create unique index if not exists form_submissions_workspace_id_uidx
  on public.form_submissions(workspace_id, id);

create table public.studio_sales_handoffs (
  reference text primary key check (reference ~ '^NL-[A-F0-9]{8}$'),
  workspace_id uuid not null references public.workspaces(id),
  lead_id uuid not null,
  submission_id uuid not null,
  contact_email text not null,
  idempotency_hash text not null unique,
  status text not null default 'accepted' check (status = 'accepted'),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, id),
  foreign key (workspace_id, submission_id) references public.form_submissions(workspace_id, id)
);

create table public.studio_sales_bookings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  crm_reference text not null references public.studio_sales_handoffs(reference),
  lead_id uuid not null,
  idempotency_hash text not null unique,
  request_hash text not null,
  provider_transaction_id uuid not null unique default gen_random_uuid(),
  organizer_id text not null,
  calendar_id text not null,
  policy_approval_id text not null,
  status text not null check (status in
    ('processing', 'rejected', 'uncertain', 'booked', 'needs_attention')),
  kind text not null check (kind in ('phone', 'teams')),
  visitor_time_zone text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  contact_name text not null,
  contact_email text not null,
  contact_phone text not null default '',
  reason text not null,
  provider_event_id text,
  teams_url text,
  invitation_triggered boolean not null default false,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, id),
  check (ends_at > starts_at)
);
create index studio_sales_bookings_active_slots_idx
  on public.studio_sales_bookings(workspace_id, starts_at, ends_at)
  where status in ('processing', 'uncertain', 'booked', 'needs_attention');

alter table public.studio_sales_handoffs enable row level security;
alter table public.studio_sales_handoffs force row level security;
alter table public.studio_sales_bookings enable row level security;
alter table public.studio_sales_bookings force row level security;

create policy studio_sales_handoffs_actor on public.studio_sales_handoffs
  for all to novalure_tenant_app
  using (workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    and workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and current_setting('app.actor_id', true) = '6122a6da-e7f4-47fa-bc55-e296bb01af62'
    and exists (select 1 from public.workspace_users actor where actor.id =
      '6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid and actor.workspace_id =
      '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
      and actor.status = 'active' and actor.role = 'agent' and actor.product_role = 'novalure_operator'))
  with check (workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    and workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and current_setting('app.actor_id', true) = '6122a6da-e7f4-47fa-bc55-e296bb01af62'
    and exists (select 1 from public.workspace_users actor where actor.id =
      '6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid and actor.workspace_id =
      '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
      and actor.status = 'active' and actor.role = 'agent' and actor.product_role = 'novalure_operator'));
create policy studio_sales_bookings_actor on public.studio_sales_bookings
  for all to novalure_tenant_app
  using (workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    and workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and current_setting('app.actor_id', true) = '6122a6da-e7f4-47fa-bc55-e296bb01af62'
    and exists (select 1 from public.workspace_users actor where actor.id =
      '6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid and actor.workspace_id =
      '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
      and actor.status = 'active' and actor.role = 'agent' and actor.product_role = 'novalure_operator'))
  with check (workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    and workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and current_setting('app.actor_id', true) = '6122a6da-e7f4-47fa-bc55-e296bb01af62'
    and exists (select 1 from public.workspace_users actor where actor.id =
      '6122a6da-e7f4-47fa-bc55-e296bb01af62'::uuid and actor.workspace_id =
      '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
      and actor.status = 'active' and actor.role = 'agent' and actor.product_role = 'novalure_operator'));

revoke all on public.studio_sales_handoffs, public.studio_sales_bookings
  from public, novalure_app, novalure_tenant_app;
grant select, insert on public.studio_sales_handoffs to novalure_tenant_app;
grant select, insert, update on public.studio_sales_bookings to novalure_tenant_app;
