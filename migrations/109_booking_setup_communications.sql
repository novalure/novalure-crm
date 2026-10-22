-- Package 5, Auftrag 2: additive settings and durable transactional messages.
-- This migration does not enable sending, a scheduler, Maps, or any product module.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create table public.booking_setup_sets (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 user_id uuid,
 kind text not null default '*' check(kind in ('*','phone','teams','meet','office','onsite')),
 travel jsonb not null default '{}' check(jsonb_typeof(travel)='object'),
 communication jsonb not null default '{}' check(jsonb_typeof(communication)='object'),
 company_resets jsonb not null default '{}' check(jsonb_typeof(company_resets)='object'),
 revision bigint not null default 1 check(revision>0),
 updated_at timestamptz not null default now(),
 unique nulls not distinct(workspace_id,user_id,kind),
 foreign key(workspace_id,user_id) references public.workspace_users(workspace_id,id)
);
alter table public.booking_setup_sets enable row level security;
alter table public.booking_setup_sets force row level security;
create policy booking_setup_read on public.booking_setup_sets for select to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid)
 and (user_id is null or user_id=nullif(current_setting('app.actor_id',true),'')::uuid));
create policy booking_setup_write on public.booking_setup_sets for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,coalesce(user_id,nullif(current_setting('app.actor_id',true),'')::uuid))
 and (user_id is not null or public.crm_workspace_manager(workspace_id)))
 with check(public.booking_actor_allowed(workspace_id,coalesce(user_id,nullif(current_setting('app.actor_id',true),'')::uuid))
 and (user_id is not null or public.crm_workspace_manager(workspace_id)));
revoke all on public.booking_setup_sets from public,novalure_app,novalure_tenant_app;
grant select,insert,update on public.booking_setup_sets to novalure_tenant_app;

alter table public.booking_reservations
 add column recipient_email text,
 add column recipient_name text not null default '',
 add column communication_language text not null default 'de' check(communication_language in ('de','en')),
 add column message_version integer not null default 0 check(message_version>=0),
 add column message_snapshot jsonb not null default '{}' check(jsonb_typeof(message_snapshot)='object');
alter table public.booking_reservations add constraint booking_recipient_bounds
 check((recipient_email is null or length(recipient_email) between 3 and 254)
 and length(recipient_name)<=200);
alter table public.booking_reservations add constraint booking_reservation_organizer_identity unique(workspace_id,organizer_id,id);

create table public.booking_message_jobs (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 organizer_id uuid not null,
 booking_id uuid not null,
 booking_version integer not null check(booking_version>=0),
 kind text not null check(kind in ('confirmation','reminder','reschedule','cancellation','test')),
 template_kind text not null check(template_kind in ('confirmation','reminder','reschedule','cancellation')),
 language text not null check(language in ('de','en')),
 reminder_id text,
 scheduled_for timestamptz not null,
 status text not null default 'planned' check(status in ('planned','sending','accepted','delivered','failed','uncertain','cancelled','skipped')),
 recipient_email text not null check(length(recipient_email) between 3 and 254),
 reply_to text not null default '',
 template jsonb not null check(jsonb_typeof(template)='object'),
 rendered jsonb check(rendered is null or jsonb_typeof(rendered)='object'),
 provider_message_id text,
 first_attempt_at timestamptz,
 last_attempt_at timestamptz,
 lease_until timestamptz,
 next_attempt_at timestamptz,
 last_event_at timestamptz,
 lease_owner text,
 attempt_count integer not null default 0 check(attempt_count>=0),
 last_error text,
 event_ids text[] not null default '{}',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(workspace_id,organizer_id) references public.workspace_users(workspace_id,id),
 foreign key(workspace_id,organizer_id,booking_id) references public.booking_reservations(workspace_id,organizer_id,id),
 unique nulls not distinct(workspace_id,booking_id,booking_version,kind,reminder_id)
);
create index booking_message_jobs_due on public.booking_message_jobs(workspace_id,organizer_id,scheduled_for)
 where status in ('planned','sending','uncertain');
create unique index booking_message_provider_id on public.booking_message_jobs(provider_message_id)
 where provider_message_id is not null;
alter table public.booking_message_jobs enable row level security;
alter table public.booking_message_jobs force row level security;
create policy booking_message_jobs_actor on public.booking_message_jobs for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,organizer_id))
 with check(public.booking_actor_allowed(workspace_id,organizer_id));
revoke all on public.booking_message_jobs from public,novalure_app,novalure_tenant_app;
grant select,insert,update on public.booking_message_jobs to novalure_tenant_app;
