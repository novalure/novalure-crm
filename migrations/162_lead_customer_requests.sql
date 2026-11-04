-- One-purpose customer intake. A link permits new self-reported data, never reads of the lead or old files.
create table lead_customer_request_settings(
 workspace_id uuid primary key references workspaces(id),controller text not null check(length(controller) between 2 and 300),privacy_url text not null check(privacy_url~'^https://[^[:space:]]+$'),updated_by uuid not null,updated_at timestamptz not null default now(),
 foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create table lead_customer_requests(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,created_by uuid not null,draft_id uuid,
 purpose text not null check(purpose in('contact_details','search_profile','purchasing_power')),language text not null check(language in('de','en','es')),
 token_hash text not null unique check(token_hash~'^[a-f0-9]{64}$'),token_ciphertext text not null,controller text not null,privacy_url text not null,
 expires_at timestamptz not null,revoked_at timestamptz,created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(workspace_id,id,project_id,lead_id),unique(workspace_id,draft_id),foreign key(workspace_id,lead_id) references leads(workspace_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,draft_id) references crm_automation_drafts(workspace_id,id)
);
create table lead_customer_request_submissions(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,request_id uuid not null,
 request_key text not null check(length(request_key) between 16 and 128),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),payload jsonb not null,file jsonb,
 status text not null default 'pending' check(status in('pending','accepted','rejected')),review_reason text,reviewed_by uuid,reviewed_at timestamptz,adopted_proof_id uuid,
 version integer not null default 1,created_at timestamptz not null default now(),file_purged_at timestamptz,file_purge_started_at timestamptz,file_purge_reason text,file_purge_actor uuid,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(request_id),foreign key(workspace_id,request_id,project_id,lead_id) references lead_customer_requests(workspace_id,id,project_id,lead_id),foreign key(workspace_id,reviewed_by) references workspace_users(workspace_id,id),foreign key(workspace_id,adopted_proof_id) references lead_qualification_proofs(workspace_id,id)
);
alter table lead_customer_request_settings enable row level security;alter table lead_customer_request_settings force row level security;
create policy request_settings_staff on lead_customer_request_settings to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(crm_workspace_manager(workspace_id) and updated_by=nullif(current_setting('app.actor_id',true),'')::uuid);
grant select,insert,update on lead_customer_request_settings to novalure_tenant_app;
create function crm_lead_request_staff_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_table_name='lead_customer_requests' then
  if tg_op='INSERT' then
   if not crm_lead_qualification_access(new.workspace_id,new.project_id,new.lead_id,true) or new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or new.expires_at<=clock_timestamp() or new.expires_at>clock_timestamp()+interval '30 days' then raise exception using errcode='42501',message='Request creation denied'; end if;
   if new.draft_id is not null and not exists(select 1 from crm_automation_drafts d join crm_automation_enrollments e on e.id=d.enrollment_id and e.workspace_id=d.workspace_id where d.workspace_id=new.workspace_id and d.id=new.draft_id and e.lead_id=new.lead_id and e.project_id=new.project_id and d.request_type=new.purpose) then raise exception using errcode='23514',message='Request draft scope mismatch'; end if;
  elsif (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at') or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then raise exception using errcode='23514',message='Request capability and scope are immutable'; end if;
 else
  if tg_op='UPDATE' then
   if new.file_purge_started_at is not null then
    if old.adopted_proof_id is not null or old.file is null or old.file_purged_at is not null or (old.status<>'rejected' and not(old.status='pending' and old.created_at<clock_timestamp()-interval '30 days')) or new.file_purge_actor is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or length(coalesce(new.file_purge_reason,''))<10 then raise exception using errcode='23514',message='Only unadopted rejected or old pending files may be purged';end if;
    if (to_jsonb(new)-array['file_purge_started_at','file_purge_reason','file_purge_actor','file_purged_at','version']) is distinct from (to_jsonb(old)-array['file_purge_started_at','file_purge_reason','file_purge_actor','file_purged_at','version']) or new.version<>old.version+1 or (old.file_purge_started_at is not null and new.file_purge_started_at is distinct from old.file_purge_started_at) then raise exception using errcode='23514',message='Purge cannot change the self-report or adoption state';end if;
    return new;
   end if;
   if (to_jsonb(new)-array['status','review_reason','reviewed_by','reviewed_at','adopted_proof_id','version']) is distinct from (to_jsonb(old)-array['status','review_reason','reviewed_by','reviewed_at','adopted_proof_id','version']) then raise exception using errcode='23514',message='Self-report and source are immutable'; end if;
   if old.status<>'pending' or new.status not in('accepted','rejected') or new.reviewed_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or new.reviewed_at is null or new.version<>old.version+1 or length(coalesce(new.review_reason,''))<10 then raise exception using errcode='23514',message='Documented staff review required'; end if;
   if new.adopted_proof_id is not null and (new.status<>'accepted' or not exists(select 1 from lead_qualification_proofs p where p.workspace_id=new.workspace_id and p.id=new.adopted_proof_id and p.lead_id=new.lead_id and p.content_hash=new.file->>'hash')) then raise exception using errcode='23514',message='Adopted proof must match submission';end if;
  end if;
 end if;return new;
end $$;
create trigger request_staff_guard before insert or update on lead_customer_requests for each row execute function crm_lead_request_staff_guard();
create trigger request_submission_guard before update on lead_customer_request_submissions for each row execute function crm_lead_request_staff_guard();
do $$ declare t text;begin foreach t in array array['lead_customer_requests','lead_customer_request_submissions'] loop
 execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',t);
 execute format('alter table %I enable row level security',t);execute format('alter table %I force row level security',t);
 execute format('create policy request_staff_scope on %I to novalure_tenant_app using(crm_lead_qualification_access(workspace_id,project_id,lead_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_lead_qualification_access(workspace_id,project_id,lead_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose))',t);
 execute format('grant select,insert,update on %I to novalure_tenant_app',t);
end loop;end $$;
revoke insert on lead_customer_request_submissions from novalure_tenant_app;

-- Public definer access is additionally bound to a capability hash for its duration.
-- No tenant/actor identity is installed or returned to a browser.
do $$ begin
 execute format('create policy request_capability_owner on lead_customer_requests to %I using(token_hash=nullif(current_setting(''app.lead_request_hash'',true),'''')) with check(token_hash=nullif(current_setting(''app.lead_request_hash'',true),''''))',current_user);
 execute format('create policy request_submission_capability_owner on lead_customer_request_submissions to %I using(exists(select 1 from lead_customer_requests r where r.id=request_id and r.workspace_id=lead_customer_request_submissions.workspace_id and r.token_hash=nullif(current_setting(''app.lead_request_hash'',true),''''))) with check(exists(select 1 from lead_customer_requests r where r.id=request_id and r.workspace_id=lead_customer_request_submissions.workspace_id and r.token_hash=nullif(current_setting(''app.lead_request_hash'',true),'''')))',current_user);
 execute format('create policy request_capability_lead_owner on leads for select to %I using(exists(select 1 from lead_customer_requests r where r.lead_id=leads.id and r.workspace_id=leads.workspace_id and r.token_hash=nullif(current_setting(''app.lead_request_hash'',true),'''')))',current_user);
 execute format('create policy request_capability_actor_owner on workspace_users for select to %I using(exists(select 1 from lead_customer_requests r where r.created_by=workspace_users.id and r.workspace_id=workspace_users.workspace_id and r.token_hash=nullif(current_setting(''app.lead_request_hash'',true),'''')))',current_user);
 execute format('create policy request_capability_project_owner on projects for select to %I using(exists(select 1 from lead_customer_requests r where r.project_id=projects.id and r.workspace_id=projects.workspace_id and r.token_hash=nullif(current_setting(''app.lead_request_hash'',true),'''')))',current_user);
 execute format('create policy request_capability_grant_owner on project_pipeline_permissions for select to %I using(exists(select 1 from lead_customer_requests r where r.created_by=project_pipeline_permissions.user_id and r.project_id=project_pipeline_permissions.project_id and r.workspace_id=project_pipeline_permissions.workspace_id and r.token_hash=nullif(current_setting(''app.lead_request_hash'',true),'''')))',current_user);
end $$;
create function crm_lead_request_lookup(p_hash text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous_hash text:=current_setting('app.lead_request_hash',true);r lead_customer_requests;result jsonb;
begin
 if coalesce(p_hash,'')!~'^[a-f0-9]{64}$' then return null; end if;
 perform set_config('app.lead_request_hash',p_hash,true);
 select * into r from lead_customer_requests where token_hash=p_hash and revoked_at is null and expires_at>clock_timestamp();
 if r.id is not null and exists(select 1 from leads l join workspace_users u on u.workspace_id=l.workspace_id and u.id=r.created_by where l.id=r.lead_id and l.project_id=r.project_id and l.workspace_id=r.workspace_id and coalesce(l.metadata#>>'{onboardingExample,synthetic}','false')<>'true' and u.status='active' and u.role in('owner','admin','agent') and u.product_role not in('external_partner','viewer') and (u.role in('owner','admin') or (l.assigned_to_user_id=u.id and exists(select 1 from project_pipeline_permissions g where g.workspace_id=r.workspace_id and g.project_id=r.project_id and g.user_id=u.id and g.can_read and g.can_edit_deals)))) then
 result:=jsonb_build_object('id',r.id,'workspaceId',r.workspace_id,'leadId',r.lead_id,'purpose',r.purpose,'language',r.language,'controller',r.controller,'privacyUrl',r.privacy_url,'submitted',exists(select 1 from lead_customer_request_submissions s where s.request_id=r.id));
 end if;
 perform set_config('app.lead_request_hash',coalesce(previous_hash,''),true);return result;
exception when others then perform set_config('app.lead_request_hash',coalesce(previous_hash,''),true);raise;
end $$;
create function crm_lead_request_submit(p_hash text,p_key text,p_digest text,p_payload jsonb,p_file jsonb default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous_hash text:=current_setting('app.lead_request_hash',true);info jsonb;r lead_customer_requests;s lead_customer_request_submissions;result jsonb;
begin
 perform set_config('app.lead_request_hash',p_hash,true);info:=crm_lead_request_lookup(p_hash);
 if info is null then result:=jsonb_build_object('error','unavailable');else
 select * into r from lead_customer_requests where token_hash=p_hash for update;
 if r.revoked_at is not null or r.expires_at<=clock_timestamp() then result:=jsonb_build_object('error','unavailable');else
 select * into s from lead_customer_request_submissions where request_id=r.id;
 if found then if s.request_key=p_key and s.request_hash=p_digest then result:=jsonb_build_object('accepted',true,'reference',s.id);else result:=jsonb_build_object('error','already_submitted');end if;
 elsif length(coalesce(p_key,'')) not between 16 and 128 or coalesce(p_digest,'')!~'^[a-f0-9]{64}$' or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>20000 or p_payload->>'privacyRead' is distinct from 'true' then result:=jsonb_build_object('error','invalid');
 elsif r.purpose='purchasing_power' and (jsonb_typeof(p_file) is distinct from 'object' or p_file->>'workspaceId' is distinct from r.workspace_id::text or p_file->>'leadId' is distinct from r.lead_id::text or p_file->>'requestId' is distinct from r.id::text or coalesce(p_file->>'id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' or coalesce(p_file->>'hash','')!~'^[a-f0-9]{64}$' or coalesce(p_file->>'size','')!~'^[0-9]{1,7}$' or (p_file->>'size')::bigint not between 1 and 4194304 or coalesce(p_file->>'mime','') not in('application/pdf','image/jpeg','image/png') or coalesce(p_file->>'provider','') not in('local','vercel-blob') or length(coalesce(p_file->>'name','')) not between 1 and 180 or coalesce(p_file->>'pathname','')!~('^'||r.workspace_id::text||'/lead-proof-private-'||r.lead_id::text||'/pending-'||r.id::text||'-'||(p_file->>'id')||'\.(pdf|jpg|png)$')) then result:=jsonb_build_object('error','invalid_file');
 elsif r.purpose<>'purchasing_power' and p_file is not null then result:=jsonb_build_object('error','invalid_file');
 else
 insert into lead_customer_request_submissions(workspace_id,project_id,lead_id,request_id,request_key,request_hash,payload,file,data_classification)
 select r.workspace_id,r.project_id,r.lead_id,r.id,p_key,p_digest,p_payload,p_file,l.data_classification from leads l where l.id=r.lead_id and l.workspace_id=r.workspace_id returning * into s;
 result:=jsonb_build_object('accepted',true,'reference',s.id);
 end if;end if;end if;
 perform set_config('app.lead_request_hash',coalesce(previous_hash,''),true);return result;
exception when others then perform set_config('app.lead_request_hash',coalesce(previous_hash,''),true);raise;
end $$;
create function crm_lead_request_upload_retained(p_hash text,p_upload uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous_hash text:=current_setting('app.lead_request_hash',true);rid uuid;result boolean;
begin
 perform set_config('app.lead_request_hash',p_hash,true);select id into rid from lead_customer_requests where token_hash=p_hash for update;
 if rid is null then result:=true;else select exists(select 1 from lead_customer_request_submissions s where s.request_id=rid and s.file->>'id'=p_upload::text) into result;end if;
 perform set_config('app.lead_request_hash',coalesce(previous_hash,''),true);return result;
exception when others then perform set_config('app.lead_request_hash',coalesce(previous_hash,''),true);raise;
end $$;
revoke all on lead_customer_request_settings,lead_customer_requests,lead_customer_request_submissions from public,novalure_app;
revoke all on function crm_lead_request_staff_guard(),crm_lead_request_lookup(text),crm_lead_request_submit(text,text,text,jsonb,jsonb),crm_lead_request_upload_retained(text,uuid) from public;
grant execute on function crm_lead_request_lookup(text),crm_lead_request_submit(text,text,text,jsonb,jsonb),crm_lead_request_upload_retained(text,uuid) to novalure_app;
