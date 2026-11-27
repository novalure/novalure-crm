-- Personal count-only transactional digests. Independent from campaign/newsletter jobs.
create policy notification_email_identity_owner on workspace_users for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.workspace_users'::regclass)) and workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and id=nullif(current_setting('app.actor_id',true),'')::uuid);
create function crm_notification_email_identity(w uuid,a uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;begin
 if w is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or a is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then return null;end if;
 select jsonb_build_object('identityId',i.id,'email',i.normalized_email) into result from workspace_users u join auth_identities i on i.id=u.auth_identity_id
 where u.workspace_id=w and u.id=a and u.status='active' and u.product_role<>'external_partner' and i.credential_state='active' and i.disabled_at is null and i.normalized_email=lower(btrim(u.email));
 return result;
end $$;
revoke all on function crm_notification_email_identity(uuid,uuid) from public;grant execute on function crm_notification_email_identity(uuid,uuid) to novalure_tenant_app;
create table crm_notification_email_settings (
 workspace_id uuid not null references workspaces(id),user_id uuid not null,identity_id uuid references auth_identities(id),recipient_email text,
 preferences jsonb not null check(jsonb_typeof(preferences)='object' and preferences->>'version'='1'),revision integer not null default 1 check(revision>0),
 next_run_at timestamptz,last_request_id uuid not null,last_request_hash text not null,updated_at timestamptz not null default now(),
 primary key(workspace_id,user_id),foreign key(workspace_id,user_id) references workspace_users(workspace_id,id),
 check(coalesce((preferences->>'enabled')::boolean,false)=false or (identity_id is not null and recipient_email is not null and next_run_at is not null))
);
create table crm_notification_email_jobs (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),user_id uuid not null,project_id uuid,
 identity_id uuid not null references auth_identities(id),recipient_email text not null,preference_revision integer not null,
 notification_keys jsonb not null check(jsonb_typeof(notification_keys)='array' and jsonb_array_length(notification_keys) between 1 and 100),
 counts jsonb not null check(jsonb_typeof(counts)='object'),payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16000),
 status text not null default 'queued' check(status in('queued','dispatching','accepted','failed','uncertain','suppressed')),
 revision integer not null default 1 check(revision>0),attempt_count integer not null default 0 check(attempt_count between 0 and 3),
 lease_token uuid,lease_until timestamptz,provider_message_id text,accepted_at timestamptz,error text check(error is null or length(error)<=100),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,user_id,id),foreign key(workspace_id,user_id) references workspace_users(workspace_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id),
 check((status='dispatching' and lease_token is not null and lease_until is not null) or (status<>'dispatching' and lease_token is null and lease_until is null)),
 check((status='accepted')=(provider_message_id is not null and accepted_at is not null))
);
create unique index crm_notification_email_one_active on crm_notification_email_jobs(workspace_id,user_id) where status in('queued','dispatching');
create table crm_notification_email_coverage (
 workspace_id uuid not null,user_id uuid not null,notification_key text not null check(length(notification_key) between 1 and 180),job_id uuid not null,
 primary key(workspace_id,user_id,notification_key),foreign key(workspace_id,user_id,job_id) references crm_notification_email_jobs(workspace_id,user_id,id)
);
do $$ declare target text;begin
 foreach target in array array['crm_notification_email_settings','crm_notification_email_jobs','crm_notification_email_coverage'] loop
 execute format('alter table %I enable row level security',target);execute format('alter table %I force row level security',target);
 execute format('create policy notification_email_self on %1$I to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid and exists(select 1 from workspace_users u where u.id=%1$I.user_id and u.workspace_id=%1$I.workspace_id and u.status=''active'' and u.product_role<>''external_partner'')) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid and exists(select 1 from workspace_users u where u.id=%1$I.user_id and u.workspace_id=%1$I.workspace_id and u.status=''active'' and u.product_role<>''external_partner''))',target);
 execute format('grant select,insert,update on %I to novalure_tenant_app',target);
 end loop;
end $$;
grant delete on crm_notification_email_coverage to novalure_tenant_app;
create function crm_notification_email_job_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if TG_OP='INSERT' then if new.status<>'queued' or new.revision<>1 or new.attempt_count<>0 then raise exception 'Invalid initial notification email job' using errcode='23514';end if;
 else
  if (to_jsonb(new)-array['status','revision','attempt_count','lease_token','lease_until','provider_message_id','accepted_at','error','updated_at']) is distinct from (to_jsonb(old)-array['status','revision','attempt_count','lease_token','lease_until','provider_message_id','accepted_at','error','updated_at']) or new.revision<>old.revision+1 then raise exception 'Immutable notification email payload' using errcode='23514';end if;
  if not ((old.status='queued' and new.status in('dispatching','suppressed')) or (old.status='dispatching' and new.status in('accepted','failed','uncertain','suppressed')) or (old.status='failed' and new.status='queued' and old.attempt_count<3 and old.created_at>clock_timestamp()-interval '23 hours')) then raise exception 'Invalid notification email transition' using errcode='23514';end if;
  if new.attempt_count<>old.attempt_count+(case when new.status='dispatching' then 1 else 0 end) then raise exception 'Invalid email attempt counter' using errcode='23514';end if;
 end if;return new;
end $$;
create trigger crm_notification_email_job_guard before insert or update on crm_notification_email_jobs for each row execute function crm_notification_email_job_guard();
create function crm_notification_email_settings_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare person jsonb;begin
 if TG_OP='UPDATE' then
  if new.workspace_id<>old.workspace_id or new.user_id<>old.user_id then raise exception 'Immutable digest account' using errcode='23514';end if;
  if (to_jsonb(new)-array['next_run_at','updated_at']) is not distinct from (to_jsonb(old)-array['next_run_at','updated_at']) then return new;end if;
  if new.revision<>old.revision+1 then raise exception 'Digest settings revision must advance' using errcode='23514';end if;
 elsif new.revision<>1 then raise exception 'Invalid digest settings revision' using errcode='23514';end if;
 if coalesce((new.preferences->>'enabled')::boolean,false) then
  person:=crm_notification_email_identity(new.workspace_id,new.user_id);
  if person is null or new.identity_id is distinct from (person->>'identityId')::uuid or new.recipient_email is distinct from person->>'email' then raise exception 'Digest recipient must be the current personal login account' using errcode='23514';end if;
 end if;return new;
end $$;
create trigger crm_notification_email_settings_guard before insert or update on crm_notification_email_settings for each row execute function crm_notification_email_settings_guard();
create function crm_notification_email_coverage_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if TG_OP='DELETE' and exists(select 1 from crm_notification_email_jobs j where j.workspace_id=old.workspace_id and j.user_id=old.user_id and j.id=old.job_id and j.status='suppressed') then return old;end if;
 raise exception 'Durable digest coverage cannot be rewritten or removed after possible submission' using errcode='23514';
end $$;
create trigger crm_notification_email_coverage_guard before update or delete on crm_notification_email_coverage for each row execute function crm_notification_email_coverage_guard();
