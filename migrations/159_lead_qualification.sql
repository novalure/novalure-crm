-- Private manually reviewed funding evidence + objective, explainable property fit.
create function public.crm_lead_qualification_access(w uuid,p uuid,l uuid,writing boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select w=nullif(current_setting('app.tenant_id',true),'')::uuid and p is not null and crm_project_access(w,p,writing)
 and exists(select 1 from leads lead where lead.workspace_id=w and lead.id=l and lead.project_id=p
   and crm_classification_allowed(lead.workspace_id,lead.data_classification,lead.data_purpose)
   and (crm_workspace_manager(w) or lead.assigned_to_user_id=nullif(current_setting('app.actor_id',true),'')::uuid))
 and exists(select 1 from workspace_users u where u.workspace_id=w and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active' and u.role in('owner','admin','agent') and u.product_role not in('external_partner','viewer'))
$$;
revoke all on function public.crm_lead_qualification_access(uuid,uuid,uuid,boolean) from public;
grant execute on function public.crm_lead_qualification_access(uuid,uuid,uuid,boolean) to novalure_tenant_app;

create table public.lead_qualification_proofs (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,media_asset_id uuid not null references media_assets(id),
 kind text not null check(kind in('financing_confirmation','funds_evidence','other')),purpose text not null check(length(purpose) between 10 and 1000),
 content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),uploaded_by uuid not null,uploaded_at timestamptz not null default now(),
 status text not null default 'pending' check(status in('pending','accepted','rejected','revoked')),usable_until timestamptz not null,
 review_reason text,reviewed_by uuid,reviewed_at timestamptz,version integer not null default 1 check(version>0),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(workspace_id,lead_id,content_hash),foreign key(workspace_id,lead_id) references leads(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,uploaded_by) references workspace_users(workspace_id,id),foreign key(workspace_id,reviewed_by) references workspace_users(workspace_id,id)
);
create table public.lead_qualification_proof_reviews (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,proof_id uuid not null,
 status text not null check(status in('accepted','rejected','revoked')),reason text not null,actor_id uuid not null,proof_version integer not null,created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 foreign key(workspace_id,proof_id) references lead_qualification_proofs(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id)
);
create table public.lead_property_matches (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,property_id uuid not null,
 profile_id uuid not null references buyer_search_profiles(id),algorithm_version text not null,source_fingerprint text not null,
 score integer not null check(score between 0 and 100),coverage integer not null check(coverage between 0 and 100),eligible boolean not null,
 reasons jsonb not null,criteria_snapshot jsonb not null,property_snapshot jsonb not null,
 profile_updated_at timestamptz not null,property_updated_at timestamptz not null,computed_at timestamptz not null default now(),version integer not null default 1,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(workspace_id,lead_id,property_id),foreign key(workspace_id,lead_id) references leads(workspace_id,id),foreign key(workspace_id,property_id) references seller_listings(workspace_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id)
);
create table public.lead_match_refresh_jobs (
 workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,requested_at timestamptz not null default now(),processed_at timestamptz,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,lead_id),foreign key(workspace_id,lead_id) references leads(workspace_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id)
);
create table public.lead_property_match_history (
 workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,match_id uuid not null,match_version integer not null,
 algorithm_version text not null,source_fingerprint text not null,result_snapshot jsonb not null,criteria_snapshot jsonb not null,property_snapshot jsonb not null,actor_id uuid not null,created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,match_id,match_version),foreign key(workspace_id,match_id) references lead_property_matches(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id)
);
create function public.crm_lead_proof_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not crm_lead_qualification_access(new.workspace_id,new.project_id,new.lead_id,true) then raise exception using errcode='42501',message='Lead proof access denied'; end if;
 if tg_op='INSERT' then
  if new.uploaded_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or new.status<>'pending' or new.usable_until<=clock_timestamp() or new.usable_until>clock_timestamp()+interval '365 days' then raise exception using errcode='23514',message='Invalid lead proof intake'; end if;
 else
  if (to_jsonb(new)-array['status','review_reason','reviewed_by','reviewed_at','version']) is distinct from (to_jsonb(old)-array['status','review_reason','reviewed_by','reviewed_at','version']) or new.version<>old.version+1 or old.status='revoked' then raise exception using errcode='23514',message='Proof contents and scope are immutable'; end if;
  if new.reviewed_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or new.status='pending' or length(trim(coalesce(new.review_reason,'')))<10 then raise exception using errcode='23514',message='Documented manual review required'; end if;
 end if;
 perform m.id from media_assets m where m.id=new.media_asset_id and m.workspace_id=new.workspace_id::text and m.folder='lead-proof-private-'||new.lead_id::text and m.storage_access='private' and not m.is_public and m.public_token is null and m.size_bytes>0 and m.size_bytes<=4194304 and m.mime_type in('application/pdf','image/jpeg','image/png') and not exists(select 1 from media_asset_shares s where s.asset_id=m.id) for update of m;
 if not found then raise exception using errcode='23514',message='Private unshared lead proof file required'; end if;
 return new;
end $$;
create trigger lead_proof_guard before insert or update on lead_qualification_proofs for each row execute function crm_lead_proof_guard();
create function public.crm_lead_proof_media_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare f text;lid uuid;
begin
 if tg_table_name='media_assets' then
  if tg_op='UPDATE' and old.folder like 'lead-proof-private-%' and new.folder is distinct from old.folder then raise exception using errcode='23514',message='Private proof folder is permanent'; end if;
  if new.folder not like 'lead-proof-private-%' then return new; end if;
  lid:=substring(new.folder from length('lead-proof-private-')+1)::uuid;
  if new.storage_access<>'private' or new.is_public or new.public_token is not null or not exists(select 1 from leads l where l.id=lid and l.workspace_id::text=new.workspace_id and crm_lead_qualification_access(l.workspace_id,l.project_id,l.id,true)) then raise exception using errcode='23514',message='Lead proof storage must remain private'; end if;
 else
  if tg_table_name='media_asset_shares' then select folder into f from media_assets where id=new.asset_id;
  else select folder into f from media_assets where id=new.media_asset_id; end if;
  if f like 'lead-proof-private-%' then raise exception using errcode='23514',message='Lead proof files cannot be shared or attached to property marketing'; end if;
 end if;
 return new;
end $$;
create trigger lead_proof_media_private before insert or update on media_assets for each row execute function crm_lead_proof_media_guard();
create trigger lead_proof_share_private before insert or update on media_asset_shares for each row execute function crm_lead_proof_media_guard();
create trigger lead_proof_property_media_private before insert or update on property_media for each row execute function crm_lead_proof_media_guard();
create trigger lead_proof_property_document_private before insert or update on property_documents for each row execute function crm_lead_proof_media_guard();
do $$ declare t text; begin
 foreach t in array array['lead_qualification_proofs','lead_qualification_proof_reviews','lead_property_matches','lead_match_refresh_jobs','lead_property_match_history'] loop
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',t);
  execute format('alter table %I enable row level security',t);execute format('alter table %I force row level security',t);
  execute format('create policy lead_qualification_scope on %I to novalure_tenant_app using(crm_lead_qualification_access(workspace_id,project_id,lead_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_lead_qualification_access(workspace_id,project_id,lead_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose))',t);
  execute format('revoke all on %I from public,novalure_app',t);execute format('grant select,insert on %I to novalure_tenant_app',t);
 end loop;
end $$;
grant update on lead_qualification_proofs,lead_property_matches,lead_match_refresh_jobs to novalure_tenant_app;
create trigger lead_proof_reviews_immutable before update or delete or truncate on lead_qualification_proof_reviews for each statement execute function crm_reject_immutable_mutation();
create trigger lead_match_history_immutable before update or delete or truncate on lead_property_match_history for each statement execute function crm_reject_immutable_mutation();
revoke all on function crm_lead_proof_guard(),crm_lead_proof_media_guard() from public;

create function crm_lead_qualification_scope_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id or new.lead_id is distinct from old.lead_id) then raise exception using errcode='23514',message='Lead qualification scope is immutable'; end if;
 if not exists(select 1 from leads l where l.workspace_id=new.workspace_id and l.id=new.lead_id and l.project_id=new.project_id) then raise exception using errcode='23514',message='Lead qualification project mismatch'; end if;
 if tg_table_name='lead_property_matches' then
  if not exists(select 1 from seller_listings p where p.workspace_id=new.workspace_id and p.id=new.property_id and p.project_id=new.project_id) or not exists(select 1 from buyer_search_profiles b where b.workspace_id=new.workspace_id and b.id=new.profile_id and b.buyer_lead_id=new.lead_id and b.project_id=new.project_id) then raise exception using errcode='23514',message='Matching source scope mismatch'; end if;
 end if;
 if tg_table_name='lead_qualification_proof_reviews' then
  if new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not exists(select 1 from lead_qualification_proofs p where p.workspace_id=new.workspace_id and p.id=new.proof_id and p.lead_id=new.lead_id and p.project_id=new.project_id and p.version=new.proof_version and p.status=new.status) then raise exception using errcode='23514',message='Proof review scope mismatch'; end if;
 end if;
 if tg_table_name='lead_property_match_history' then
  if new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not exists(select 1 from lead_property_matches m where m.workspace_id=new.workspace_id and m.id=new.match_id and m.lead_id=new.lead_id and m.project_id=new.project_id and m.version=new.match_version and m.source_fingerprint=new.source_fingerprint and m.criteria_snapshot=new.criteria_snapshot and m.property_snapshot=new.property_snapshot) then raise exception using errcode='23514',message='Match history scope mismatch'; end if;
 end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['lead_qualification_proofs','lead_qualification_proof_reviews','lead_property_matches','lead_match_refresh_jobs','lead_property_match_history'] loop
 execute format('create trigger qualification_scope_guard before insert or update on %I for each row execute function crm_lead_qualification_scope_guard()',t);
 end loop;
 -- Narrow definer for source-change fan-out: no caller-selected identifiers or returned data.
 foreach t in array array['leads','buyer_search_profiles','lead_match_refresh_jobs'] loop
 execute format('create policy matching_refresh_owner_read on %I for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t,current_user);
 end loop;
 execute format('create policy matching_refresh_owner_write on lead_match_refresh_jobs for all to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',current_user);
end $$;
create function crm_queue_lead_matching_source_change() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.workspace_id is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or new.project_id is null or not crm_project_access(new.workspace_id,new.project_id,true) then return new; end if;
 if tg_table_name='buyer_search_profiles' then
  if new.buyer_lead_id is not null then insert into lead_match_refresh_jobs(workspace_id,project_id,lead_id) values(new.workspace_id,new.project_id,new.buyer_lead_id) on conflict(workspace_id,lead_id) do update set requested_at=clock_timestamp(),processed_at=null; end if;
 else
  insert into lead_match_refresh_jobs(workspace_id,project_id,lead_id) select b.workspace_id,b.project_id,b.buyer_lead_id from buyer_search_profiles b where b.workspace_id=new.workspace_id and b.project_id=new.project_id and b.buyer_lead_id is not null on conflict(workspace_id,lead_id) do update set requested_at=clock_timestamp(),processed_at=null;
 end if;
 return new;
end $$;
create trigger matching_profile_changed after insert or update on buyer_search_profiles for each row execute function crm_queue_lead_matching_source_change();
create trigger matching_property_changed after insert or update on seller_listings for each row execute function crm_queue_lead_matching_source_change();
create trigger matching_unit_changed after insert or update on property_units for each row execute function crm_queue_lead_matching_source_change();
revoke all on function crm_queue_lead_matching_source_change(),crm_lead_qualification_scope_guard() from public;
