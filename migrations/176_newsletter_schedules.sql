-- Narrow, explicitly delegated scheduled mailing jobs; never retry an unknown provider claim.
create function crm_newsletter_mfa_proof(w uuid,a uuid,i uuid,s uuid default null) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare bound uuid;begin
 if w is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or a is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then return false;end if;
 select auth_identity_id into bound from crm_lock_active_member(w,a);if bound is distinct from i then return false;end if;
 perform id from auth_identities where id=i and credential_state='active' and disabled_at is null and mfa_enabled_at is not null for share;if not found then return false;end if;
 if s is not null then perform id from auth_sessions where id=s and auth_identity_id=i and workspace_id=w and workspace_user_id=a and revoked_at is null and expires_at>clock_timestamp() and mfa_verified_at is not null for share;return found;end if;return true;
end $$;
revoke all on function crm_newsletter_mfa_proof(uuid,uuid,uuid,uuid) from public;
grant execute on function crm_newsletter_mfa_proof(uuid,uuid,uuid,uuid) to novalure_tenant_app;
create function crm_newsletter_job_access(w uuid,p uuid,writing boolean default false) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select crm_project_access(w,p,writing) and exists(select 1 from workspace_users u where u.workspace_id=w and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active' and (not writing or (u.role in('owner','admin') and u.product_role in('platform_admin','novalureGrowth','novalureAdmin','customer_owner','workspace_admin','broker_agent'))))
$$;
revoke all on function crm_newsletter_job_access(uuid,uuid,boolean) from public;grant execute on function crm_newsletter_job_access(uuid,uuid,boolean) to novalure_tenant_app;
create table crm_newsletter_schedules (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,campaign_id uuid not null,revision integer not null,
 actor_id uuid not null,identity_id uuid not null references auth_identities(id),auth_session_id uuid not null,execute_at timestamptz not null,
 status text not null default 'queued' check(status in('queued','running','completed','cancelled','blocked')),version integer not null default 1 check(version>0),
 lease_token uuid,lease_until timestamptz,run_count integer not null default 0 check(run_count>=0),last_error text,finished_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 foreign key(workspace_id,campaign_id,revision) references crm_newsletter_versions(workspace_id,campaign_id,revision),
 check((status='running' and lease_token is not null and lease_until is not null) or(status<>'running' and lease_token is null and lease_until is null)),check(last_error is null or length(last_error)<=100)
);
create unique index newsletter_one_active_schedule on crm_newsletter_schedules(workspace_id,campaign_id) where status in('queued','running');
create index newsletter_schedule_due on crm_newsletter_schedules(workspace_id,project_id,actor_id,execute_at) where status in('queued','running');
create function crm_newsletter_schedule_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then raise exception using errcode='23514',message='Newsletter schedule history is retained';end if;
 if not crm_newsletter_job_access(new.workspace_id,new.project_id,true) then raise exception using errcode='42501',message='Newsletter schedule denied';end if;
 if tg_op='INSERT' then
  if new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not crm_newsletter_mfa_proof(new.workspace_id,new.actor_id,new.identity_id,new.auth_session_id) or new.version<>1 or new.status<>'queued' or new.run_count<>0 or new.execute_at<clock_timestamp()-interval '5 seconds' or new.execute_at>clock_timestamp()+interval '366 days' then raise exception using errcode='23514',message='Explicit current MFA delegation and valid schedule required';end if;
  if not exists(select 1 from crm_newsletter_drafts d where d.workspace_id=new.workspace_id and d.project_id=new.project_id and d.campaign_id=new.campaign_id and d.revision=new.revision and d.approved_revision=d.revision) or exists(select 1 from crm_newsletter_deliveries d where d.workspace_id=new.workspace_id and d.campaign_id=new.campaign_id and d.status in('claimed','uncertain')) then raise exception using errcode='23514',message='Current approval and resolved deliveries required';end if;
 else
  if (to_jsonb(new)-array['status','version','lease_token','lease_until','run_count','last_error','finished_at','updated_at']) is distinct from (to_jsonb(old)-array['status','version','lease_token','lease_until','run_count','last_error','finished_at','updated_at']) or new.version<>old.version+1 or old.status in('completed','cancelled') or(old.status='blocked' and new.status<>'cancelled') then raise exception using errcode='23514',message='Newsletter schedule scope or terminal state is immutable';end if;
  if new.status='running' and (new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or new.run_count<>old.run_count+1 or new.lease_until<=clock_timestamp() or new.lease_until>clock_timestamp()+interval '15 minutes' or(old.status='running' and old.lease_until>clock_timestamp())) then raise exception using errcode='23514',message='Invalid newsletter job lease';end if;
  if new.status<>'running' and new.run_count<>old.run_count then raise exception using errcode='23514',message='Newsletter run count is immutable without claim';end if;
 end if;new.updated_at:=clock_timestamp();return new;
end $$;
create trigger a_newsletter_schedule_classification before insert or update on crm_newsletter_schedules for each row execute function crm_set_sales_classification();
create trigger b_newsletter_schedule_guard before insert or update or delete on crm_newsletter_schedules for each row execute function crm_newsletter_schedule_guard();
alter table crm_newsletter_schedules enable row level security;alter table crm_newsletter_schedules force row level security;
create policy newsletter_schedule_read on crm_newsletter_schedules for select to novalure_tenant_app using(crm_newsletter_job_access(workspace_id,project_id,false) and (actor_id=nullif(current_setting('app.actor_id',true),'')::uuid or crm_workspace_manager(workspace_id)) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy newsletter_schedule_write on crm_newsletter_schedules for all to novalure_tenant_app using(crm_newsletter_job_access(workspace_id,project_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_newsletter_job_access(workspace_id,project_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
revoke all on crm_newsletter_schedules from public,novalure_tenant_app;grant select,insert,update on crm_newsletter_schedules to novalure_tenant_app;
create table crm_newsletter_legacy_migrations (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,campaign_id uuid not null references newsletter_campaigns(id),actor_id uuid not null,
 source_snapshot jsonb not null,reset_segment boolean not null,reason text not null check(length(trim(reason)) between 10 and 1000),created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,campaign_id),foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id)
);
alter table crm_newsletter_legacy_migrations enable row level security;alter table crm_newsletter_legacy_migrations force row level security;
create trigger newsletter_migration_classification before insert on crm_newsletter_legacy_migrations for each row execute function crm_set_sales_classification();
create function crm_newsletter_legacy_source_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare actual jsonb;begin
 select to_jsonb(c) into actual from newsletter_campaigns c where c.workspace_id=new.workspace_id and c.id=new.campaign_id and c.project_id is null for update;
 if not found or actual is distinct from new.source_snapshot or not crm_workspace_manager(new.workspace_id) or not crm_newsletter_job_access(new.workspace_id,new.project_id,true) or new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='23514',message='Legacy migration must retain the actual unassigned source';end if;
 new.created_at:=clock_timestamp();return new;
end $$;
create trigger newsletter_migration_source before insert on crm_newsletter_legacy_migrations for each row execute function crm_newsletter_legacy_source_guard();
create trigger newsletter_migration_immutable before update or delete or truncate on crm_newsletter_legacy_migrations for each statement execute function crm_reject_immutable_mutation();
create policy newsletter_migration_read on crm_newsletter_legacy_migrations for select to novalure_tenant_app using(crm_workspace_manager(workspace_id) and crm_newsletter_job_access(workspace_id,project_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
create policy newsletter_migration_insert on crm_newsletter_legacy_migrations for insert to novalure_tenant_app with check(crm_workspace_manager(workspace_id) and crm_newsletter_job_access(workspace_id,project_id,true) and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose));
revoke all on crm_newsletter_legacy_migrations from public,novalure_tenant_app;grant select,insert on crm_newsletter_legacy_migrations to novalure_tenant_app;
revoke all on function crm_newsletter_schedule_guard(),crm_newsletter_legacy_source_guard() from public;
