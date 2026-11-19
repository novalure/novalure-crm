-- Purpose-specific physical retention for expired financial proof files.
-- Proof/review receipts remain immutable. No generic media deletion or public capability.
create table lead_proof_retention_policies(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,
 enabled boolean not null default false,grace_days integer not null default 30 check(grace_days between 0 and 3650),reason text not null check(length(trim(reason)) between 10 and 1000),
 version integer not null default 1,updated_by uuid not null,updated_at timestamptz not null default now(),
 schedule_actor_id uuid,schedule_identity_id uuid,schedule_version integer,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(workspace_id,project_id),foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id),foreign key(workspace_id,schedule_actor_id) references workspace_users(workspace_id,id),
 check((schedule_actor_id is null and schedule_identity_id is null and schedule_version is null) or (enabled and schedule_actor_id is not null and schedule_identity_id is not null and schedule_version=version))
);
create table lead_proof_retention_holds(
 workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,proof_id uuid not null,active boolean not null,
 reason text not null check(length(trim(reason)) between 10 and 1000),version integer not null default 1,updated_by uuid not null,updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,proof_id),foreign key(workspace_id,proof_id) references lead_qualification_proofs(workspace_id,id),foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create table lead_proof_retention_jobs(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,proof_id uuid not null,policy_id uuid not null,
 policy_version integer not null,asset_id uuid not null,storage_provider text not null check(storage_provider in('local','vercel-blob')),relative_path text not null,content_hash text not null,
 status text not null default 'queued' check(status in('queued','deleted')),created_by uuid not null,created_at timestamptz not null default now(),deleted_at timestamptz,deleted_by uuid,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(workspace_id,proof_id),foreign key(workspace_id,proof_id) references lead_qualification_proofs(workspace_id,id),
 foreign key(workspace_id,policy_id) references lead_proof_retention_policies(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,deleted_by) references workspace_users(workspace_id,id),
 check((status='queued' and deleted_at is null and deleted_by is null) or (status='deleted' and deleted_at is not null and deleted_by is not null))
);
create table lead_proof_retention_changes(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,lead_id uuid,
 subject_kind text not null check(subject_kind in('policy','hold')),subject_id uuid not null,subject_version integer not null check(subject_version>0),
 actor_id uuid not null,created_at timestamptz not null default now(),before_state jsonb,after_state jsonb not null,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 check(jsonb_typeof(after_state)='object' and octet_length(after_state::text)<=6000 and (before_state is null or (jsonb_typeof(before_state)='object' and octet_length(before_state::text)<=6000)))
);
create function crm_lead_proof_retention_change_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not crm_workspace_manager(new.workspace_id) or not crm_project_access(new.workspace_id,new.project_id,true) or new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='42501',message='Private retention change authority required';end if;
 if new.subject_kind='policy' then
  if new.lead_id is not null or not exists(select 1 from lead_proof_retention_policies p where p.workspace_id=new.workspace_id and p.project_id=new.project_id and p.id=new.subject_id and p.version=new.subject_version and p.reason=new.after_state->>'reason') then raise exception using errcode='23514',message='Retention policy change source mismatch';end if;
 else
  if not exists(select 1 from lead_proof_retention_holds h where h.workspace_id=new.workspace_id and h.project_id=new.project_id and h.lead_id=new.lead_id and h.proof_id=new.subject_id and h.version=new.subject_version and h.reason=new.after_state->>'reason') then raise exception using errcode='23514',message='Retention hold change source mismatch';end if;
 end if;return new;
end $$;
create function crm_lead_proof_retention_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare proof lead_qualification_proofs; actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;
begin
 if not crm_workspace_manager(new.workspace_id) or not crm_project_access(new.workspace_id,new.project_id,true) or new.workspace_id is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid then raise exception using errcode='42501',message='Proof retention requires current project management authority';end if;
 if tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id) then raise exception using errcode='23514',message='Retention scope is immutable';end if;
 if tg_table_name='lead_proof_retention_policies' then
  if new.updated_by is distinct from actor or (tg_op='INSERT' and new.version<>1) or (tg_op='UPDATE' and (new.id<>old.id or new.version<>old.version+1)) then raise exception using errcode='23514',message='Versioned retention policy required';end if;
  if new.schedule_actor_id is not null and (new.schedule_actor_id<>actor or not exists(select 1 from auth_identities i join workspace_users u on u.auth_identity_id=i.id where i.id=new.schedule_identity_id and u.id=actor and u.workspace_id=new.workspace_id and i.credential_state='active' and i.disabled_at is null and i.mfa_enabled_at is not null)) then raise exception using errcode='42501',message='Active personal retention delegation required';end if;
 else
  select * into proof from lead_qualification_proofs p where p.workspace_id=new.workspace_id and p.id=new.proof_id and p.lead_id=new.lead_id and p.project_id=new.project_id;
  if proof.id is null or not crm_lead_qualification_access(proof.workspace_id,proof.project_id,proof.lead_id,true) then raise exception using errcode='42501',message='Proof retention source access denied';end if;
  if tg_table_name='lead_proof_retention_holds' then
   if new.updated_by is distinct from actor or (tg_op='UPDATE' and (new.proof_id<>old.proof_id or new.lead_id<>old.lead_id or new.version<>old.version+1)) then raise exception using errcode='23514',message='Versioned documented retention hold required';end if;
  else
   if tg_op='INSERT' then
    if new.created_by is distinct from actor or new.status<>'queued' or proof.kind not in('financing_confirmation','funds_evidence') or proof.content_hash<>new.content_hash or proof.media_asset_id<>new.asset_id or not exists(select 1 from lead_proof_retention_policies p where p.workspace_id=new.workspace_id and p.id=new.policy_id and p.project_id=new.project_id and p.enabled and p.version=new.policy_version and proof.usable_until+make_interval(days=>p.grace_days)<=clock_timestamp()) or exists(select 1 from lead_proof_retention_holds h where h.workspace_id=new.workspace_id and h.proof_id=new.proof_id and h.active) then raise exception using errcode='23514',message='Only expired unheld financial proof files may be queued';end if;
   elsif (to_jsonb(new)-array['status','deleted_at','deleted_by']) is distinct from (to_jsonb(old)-array['status','deleted_at','deleted_by']) or old.status<>'queued' or new.status<>'deleted' or new.deleted_by is distinct from actor or new.deleted_at is null then raise exception using errcode='23514',message='Retention intent is immutable';end if;
  end if;
 end if;return new;
end $$;
do $$ declare t text;begin foreach t in array array['lead_proof_retention_policies','lead_proof_retention_holds','lead_proof_retention_jobs','lead_proof_retention_changes'] loop
 execute format('alter table %I enable row level security',t);execute format('alter table %I force row level security',t);
 execute format('create policy proof_retention_manager on %I to novalure_tenant_app using(crm_workspace_manager(workspace_id) and crm_project_access(workspace_id,project_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_workspace_manager(workspace_id) and crm_project_access(workspace_id,project_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose))',t);
 execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',t);
 if t='lead_proof_retention_changes' then execute format('create trigger proof_retention_guard before insert on %I for each row execute function crm_lead_proof_retention_change_guard()',t);
 else execute format('create trigger proof_retention_guard before insert or update on %I for each row execute function crm_lead_proof_retention_guard()',t);end if;
 execute format('create trigger proof_retention_no_delete before delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',t);
 execute format('revoke all on %I from public,novalure_app',t);execute format('grant select,insert,update on %I to novalure_tenant_app',t);
end loop;end $$;
revoke update on lead_proof_retention_changes from novalure_tenant_app;
create trigger proof_retention_change_immutable before update on lead_proof_retention_changes for each statement execute function crm_reject_immutable_mutation();
revoke all on function crm_lead_proof_retention_change_guard() from public;

-- Definer visibility exists only while these fixed functions inspect one exact file.
-- These GUCs never alter tenant/actor identity or grant the tenant role a policy.
do $$ declare t text;c text;begin
 execute format('create policy proof_retention_owner_file on media_assets for select to %I using(id::text=nullif(current_setting(''app.proof_retention_asset'',true),'''') or (storage_provider=nullif(current_setting(''app.proof_retention_provider'',true),'''') and relative_path=nullif(current_setting(''app.proof_retention_path'',true),'''')))',current_user);
 foreach t in array array['property_media','property_documents','bot_document_sends','media_asset_shares','studio_enquiry_assets','knowledge_source_versions','lead_qualification_proofs','web_expose_resources'] loop
  if to_regclass('public.'||t) is not null then
   c:=case when t in('media_asset_shares','web_expose_resources') then 'asset_id' else 'media_asset_id' end;
   execute format('create policy proof_retention_owner_reference on %I for select to %I using(%I::text=nullif(current_setting(''app.proof_retention_asset'',true),''''))',t,current_user,c);
  end if;
 end loop;
end $$;
create function crm_lead_proof_retention_file_safe(p_asset uuid,p_workspace uuid,p_lead uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a media_assets;previous_asset text:=current_setting('app.proof_retention_asset',true);previous_provider text:=current_setting('app.proof_retention_provider',true);previous_path text:=current_setting('app.proof_retention_path',true);ok boolean;count_refs bigint;
begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or not crm_workspace_manager(p_workspace) then return false;end if;
 perform set_config('app.proof_retention_asset',p_asset::text,true);
 select * into a from media_assets where id=p_asset and workspace_id=p_workspace::text;
 if a.id is null or a.folder is distinct from 'lead-proof-private-'||p_lead::text or a.storage_access<>'private' or a.is_public or a.public_token is not null or a.studio_enquiry_operation_id is not null then ok:=false;
 else
  perform set_config('app.proof_retention_provider',a.storage_provider,true);perform set_config('app.proof_retention_path',a.relative_path,true);
  ok:=(select count(*)=1 from media_assets where storage_provider=a.storage_provider and relative_path=a.relative_path)
   and (select count(*)=1 from lead_qualification_proofs p where p.media_asset_id=p_asset)
   and exists(select 1 from lead_qualification_proofs p where p.media_asset_id=p_asset and p.workspace_id=p_workspace and p.lead_id=p_lead and p.kind in('financing_confirmation','funds_evidence') and crm_lead_qualification_access(p.workspace_id,p.project_id,p.lead_id,true))
   and not exists(select 1 from property_media where media_asset_id=p_asset) and not exists(select 1 from property_documents where media_asset_id=p_asset)
   and not exists(select 1 from bot_document_sends where media_asset_id=p_asset) and not exists(select 1 from media_asset_shares where asset_id=p_asset) and not exists(select 1 from studio_enquiry_assets where media_asset_id=p_asset);
  if to_regclass('public.knowledge_source_versions') is not null then execute 'select count(*) from knowledge_source_versions where media_asset_id=$1' into count_refs using p_asset;ok:=ok and count_refs=0;end if;
  if to_regclass('public.web_expose_resources') is not null then execute 'select count(*) from web_expose_resources where asset_id=$1' into count_refs using p_asset;ok:=ok and count_refs=0;end if;
 end if;
 perform set_config('app.proof_retention_asset',coalesce(previous_asset,''),true);perform set_config('app.proof_retention_provider',coalesce(previous_provider,''),true);perform set_config('app.proof_retention_path',coalesce(previous_path,''),true);return coalesce(ok,false);
exception when others then
 perform set_config('app.proof_retention_asset',coalesce(previous_asset,''),true);perform set_config('app.proof_retention_provider',coalesce(previous_provider,''),true);perform set_config('app.proof_retention_path',coalesce(previous_path,''),true);raise;
end $$;

create function crm_lead_proof_retention_storage_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous_asset text:=current_setting('app.proof_retention_asset',true);previous_provider text:=current_setting('app.proof_retention_provider',true);previous_path text:=current_setting('app.proof_retention_path',true);protected boolean;
begin
 -- A committed proof keeps an immutable storage reference, including after erasure.
 perform set_config('app.proof_retention_asset',new.id::text,true);
 if tg_op='UPDATE' and exists(select 1 from lead_qualification_proofs p where p.media_asset_id=new.id) and (to_jsonb(new)-array['name','original_name','alt']) is distinct from (to_jsonb(old)-array['name','original_name','alt']) then raise exception using errcode='23514',message='Committed proof storage is immutable';end if;
 perform pg_advisory_xact_lock(hashtextextended('lead-proof-path:'||new.storage_provider||':'||new.relative_path,0));
 perform set_config('app.proof_retention_provider',new.storage_provider,true);perform set_config('app.proof_retention_path',new.relative_path,true);
 select exists(select 1 from media_assets a where a.id<>new.id and a.storage_provider=new.storage_provider and a.relative_path=new.relative_path and a.folder like 'lead-proof-private-%') into protected;
 if protected then raise exception using errcode='23514',message='Private proof files cannot be aliased';end if;
 perform set_config('app.proof_retention_asset',coalesce(previous_asset,''),true);perform set_config('app.proof_retention_provider',coalesce(previous_provider,''),true);perform set_config('app.proof_retention_path',coalesce(previous_path,''),true);return new;
exception when others then
 perform set_config('app.proof_retention_asset',coalesce(previous_asset,''),true);perform set_config('app.proof_retention_provider',coalesce(previous_provider,''),true);perform set_config('app.proof_retention_path',coalesce(previous_path,''),true);raise;
end $$;
create trigger proof_retention_storage_guard before insert or update on media_assets for each row execute function crm_lead_proof_retention_storage_guard();
revoke all on function crm_lead_proof_retention_guard(),crm_lead_proof_retention_storage_guard(),crm_lead_proof_retention_file_safe(uuid,uuid,uuid) from public;
grant execute on function crm_lead_proof_retention_file_safe(uuid,uuid,uuid) to novalure_tenant_app;
