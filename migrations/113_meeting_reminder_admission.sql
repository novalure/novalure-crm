-- Preserve the existing hourly meeting-notification admission when the shared
-- reminder endpoint is called every minute. No customer jobs are created here.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create table public.meeting_reminder_admission (
 worker_key text primary key check(worker_key='meeting-notifications-hourly'),
 bucket_at timestamptz not null,
 job_ids uuid[] not null check(cardinality(job_ids)<=25),
 lease_owner uuid,
 lease_until timestamptz,
 completed_at timestamptz,
 updated_at timestamptz not null default now(),
 check((lease_owner is null)=(lease_until is null))
);
alter table public.meeting_reminder_admission enable row level security;
alter table public.meeting_reminder_admission force row level security;
create policy meeting_reminder_admission_runtime on public.meeting_reminder_admission
 for all to novalure_tenant_app
 using(worker_key='meeting-notifications-hourly')
 with check(worker_key='meeting-notifications-hourly');
revoke all on public.meeting_reminder_admission from public,novalure_app,novalure_tenant_app;
grant select,insert,update on public.meeting_reminder_admission to novalure_tenant_app;
