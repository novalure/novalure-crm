-- G08: empty Preview-only allowlist, immutable contract revisions and synthetic
-- execution evidence. This migration installs no credentials and sends nothing.
create table crm_evelyn_preview_targets (
 workspace_id uuid not null references workspaces(id), project_id uuid not null,
 evelyn_tenant_id uuid not null, enabled boolean not null default true,
 primary key(workspace_id,project_id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 check(workspace_id=evelyn_tenant_id)
);
create table crm_evelyn_contract_actions (
 id uuid primary key, workspace_id uuid not null, project_id uuid not null, offer_id uuid not null,
 created_by uuid not null, correlation_id uuid not null, version integer not null default 1 check(version>0),
 offer_version integer not null check(offer_version>0), offer_revision integer not null check(offer_revision>0),
 source_approval_id uuid not null, source_content_digest text not null check(source_content_digest ~ '^[0-9a-f]{64}$'),
 environment text not null default 'preview' check(environment='preview'), synthetic boolean not null default true check(synthetic),
 created_at timestamptz not null default now(), data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(workspace_id,project_id,id),unique(workspace_id,offer_id),
 foreign key(workspace_id,project_id,offer_id) references crm_offers(workspace_id,project_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,source_approval_id) references crm_offer_approvals(workspace_id,id)
);
create table crm_evelyn_contract_revisions (
 workspace_id uuid not null, project_id uuid not null, action_id uuid not null, version integer not null check(version>0),
 created_by uuid not null, action jsonb not null check(jsonb_typeof(action)='object'),
 action_hash text not null check(action_hash ~ '^[0-9a-f]{64}$'), created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,action_id,version), unique(workspace_id,project_id,action_id,version),
 foreign key(workspace_id,project_id,action_id) references crm_evelyn_contract_actions(workspace_id,project_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 check(action->>'tenantId'=workspace_id::text and action->>'actionId'=action_id::text and (action->>'actionVersion')::integer=version and action->>'actionType'='contract.send' and action->>'resourceId'=action_id::text)
);
create table crm_evelyn_contract_approvals (
 workspace_id uuid not null,project_id uuid not null,action_id uuid not null,version integer not null,
 recorded_by uuid not null, approval_reference uuid not null,correlation_id uuid not null,
 created_at timestamptz not null default now(),data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,action_id,version),unique(approval_reference),
 foreign key(workspace_id,project_id,action_id,version) references crm_evelyn_contract_revisions(workspace_id,project_id,action_id,version),
 foreign key(workspace_id,recorded_by) references workspace_users(workspace_id,id)
);
create table crm_evelyn_contract_events (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,action_id uuid not null,version integer not null,
 recorded_by uuid not null,correlation_id uuid not null,stage text not null check(stage in('REQUEST','VERIFY','EXECUTE')),
 result_code text not null check(result_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),approval_reference uuid,
 created_at timestamptz not null default now(),data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 foreign key(workspace_id,project_id,action_id,version) references crm_evelyn_contract_revisions(workspace_id,project_id,action_id,version),
 foreign key(workspace_id,recorded_by) references workspace_users(workspace_id,id)
);
create table crm_evelyn_contract_executions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,action_id uuid not null,version integer not null,
 executed_by uuid not null,approval_reference uuid not null,correlation_id uuid not null,
 effect text not null default 'SYNTHETIC_CONTRACT_SEND' check(effect='SYNTHETIC_CONTRACT_SEND'),
 external_effect boolean not null default false check(not external_effect),
 created_at timestamptz not null default now(),data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,action_id),unique(approval_reference),
 foreign key(workspace_id,project_id,action_id,version) references crm_evelyn_contract_revisions(workspace_id,project_id,action_id,version),
 foreign key(workspace_id,executed_by) references workspace_users(workspace_id,id)
);
create function crm_evelyn_contract_action_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if (to_jsonb(new)-'version') is distinct from (to_jsonb(old)-'version') or new.version<>old.version+1 then raise exception 'EVELYN_ACTION_IMMUTABLE'; end if;
 return new;
end $$;
create trigger crm_evelyn_contract_action_immutable before update on crm_evelyn_contract_actions for each row execute function crm_evelyn_contract_action_immutable();
create trigger crm_evelyn_contract_action_no_delete before delete or truncate on crm_evelyn_contract_actions for each statement execute function crm_reject_immutable_mutation();
do $$ declare relation text; actor_column text; begin
 foreach relation in array array['crm_evelyn_contract_actions','crm_evelyn_contract_revisions','crm_evelyn_contract_approvals','crm_evelyn_contract_events','crm_evelyn_contract_executions'] loop
  actor_column:=case when relation in('crm_evelyn_contract_actions','crm_evelyn_contract_revisions') then 'created_by' when relation='crm_evelyn_contract_executions' then 'executed_by' else 'recorded_by' end;
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('create policy evelyn_contract_scope on %I to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true) and %I=nullif(current_setting(''app.actor_id'',true),'''')::uuid)',relation,actor_column);
  execute format('grant select,insert on %I to novalure_tenant_app',relation);
  if relation<>'crm_evelyn_contract_actions' then execute format('create trigger crm_evelyn_evidence_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);end if;
 end loop;
end $$;
grant update(version) on crm_evelyn_contract_actions to novalure_tenant_app;
alter table crm_evelyn_preview_targets enable row level security;
alter table crm_evelyn_preview_targets force row level security;
create policy evelyn_target_read on crm_evelyn_preview_targets for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
grant select on crm_evelyn_preview_targets to novalure_tenant_app;
-- Row-lock the allowlist without granting runtime actors authority to edit it.
create function crm_lock_evelyn_preview_target(target_workspace uuid,target_project uuid,target_tenant uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if target_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or target_workspace<>target_tenant
    or not crm_project_access(target_workspace,target_project,true) then return false; end if;
 perform 1 from crm_evelyn_preview_targets where workspace_id=target_workspace and project_id=target_project and evelyn_tenant_id=target_tenant and enabled for share;
 return found;
end $$;
revoke all on function crm_lock_evelyn_preview_target(uuid,uuid,uuid) from public;
grant execute on function crm_lock_evelyn_preview_target(uuid,uuid,uuid) to novalure_tenant_app;
