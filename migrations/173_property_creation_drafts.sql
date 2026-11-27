-- Personal unfinished inputs stay outside general CRM command receipts and project read models.
create table crm_property_creation_drafts (
 id uuid primary key,workspace_id uuid not null references workspaces(id),user_id uuid not null,
 project_id uuid,draft jsonb not null check(jsonb_typeof(draft)='object' and draft->>'version'='1' and octet_length(draft::text)<=65536),
 step integer not null default 0 check(step between 0 and 3),revision integer not null default 1 check(revision>0),
 status text not null default 'active' check(status in('active','created','discarded')),
 created_property_id uuid,last_request_id uuid not null,last_request_hash text not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,user_id) references workspace_users(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,created_property_id) references seller_listings(workspace_id,id),
 check((status='created')=(created_property_id is not null)),
 check(coalesce(draft->>'projectId','')=coalesce(project_id::text,''))
);
create index crm_property_creation_drafts_owner on crm_property_creation_drafts(workspace_id,user_id,updated_at desc) where status='active';
alter table crm_property_creation_drafts enable row level security;
alter table crm_property_creation_drafts force row level security;
create policy property_creation_self on crm_property_creation_drafts to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and user_id=nullif(current_setting('app.actor_id',true),'')::uuid
 and exists(select 1 from workspace_users u where u.workspace_id=crm_property_creation_drafts.workspace_id and u.id=crm_property_creation_drafts.user_id and u.status='active' and u.role<>'viewer' and u.product_role<>'external_partner')
 and (project_id is null or crm_project_access(workspace_id,project_id,true)))
 with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and user_id=nullif(current_setting('app.actor_id',true),'')::uuid
 and exists(select 1 from workspace_users u where u.workspace_id=crm_property_creation_drafts.workspace_id and u.id=crm_property_creation_drafts.user_id and u.status='active' and u.role<>'viewer' and u.product_role<>'external_partner')
 and (project_id is null or crm_project_access(workspace_id,project_id,true)));
grant select,insert,update on crm_property_creation_drafts to novalure_tenant_app;
create function crm_property_creation_draft_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if TG_OP='UPDATE' then
  if new.id<>old.id or new.workspace_id<>old.workspace_id or new.user_id<>old.user_id or new.created_at<>old.created_at or new.revision<>old.revision+1 or old.status<>'active' then raise exception 'Immutable or stale property draft' using errcode='23514'; end if;
 elsif new.revision<>1 or new.status<>'active' then raise exception 'Invalid initial property draft' using errcode='23514'; end if;
 if new.created_property_id is not null and not exists(select 1 from seller_listings p where p.id=new.created_property_id and p.workspace_id=new.workspace_id and p.project_id is not distinct from new.project_id) then raise exception 'Created property outside draft project' using errcode='23514'; end if;
 return new;
end $$;
create trigger property_creation_draft_guard before insert or update on crm_property_creation_drafts for each row execute function crm_property_creation_draft_guard();
