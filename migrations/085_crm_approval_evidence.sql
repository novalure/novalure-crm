-- Local synthetic approval evidence only. No runtime trust roots, users or provider
-- credentials are installed. The repository additionally refuses non-loopback,
-- Vercel and non-test execution. Transactions belong to the migration runner.
create table crm_synthetic_approval_requests (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid not null, offer_id uuid not null,
 actor_id uuid not null, created_by uuid not null, scope jsonb not null check(jsonb_typeof(scope)='object'),
 scope_digest text not null check(scope_digest ~ '^[0-9a-f]{64}$'), action_digest text not null check(action_digest ~ '^[0-9a-f]{64}$'),
 trust_digest text not null check(trust_digest ~ '^[0-9a-f]{64}$'), required_steps integer not null check(required_steps in(1,2)),
 state text not null default 'WAITING_FIRST' check(state in('WAITING_FIRST','WAITING_WEB','APPROVED','REJECTED','CHANGE_REQUIRED','REVOKED','CONSUMED')),
 challenge_id uuid not null default gen_random_uuid(), version integer not null default 1 check(version>0),
 environment text not null default 'simulation' check(environment='simulation'), synthetic boolean not null default true check(synthetic=true),
 expires_at timestamptz not null, created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED', data_purpose text not null default 'crm_sales',
 unique(workspace_id,id), unique(workspace_id,project_id,id), foreign key(workspace_id,project_id,offer_id) references crm_offers(workspace_id,project_id,id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 check(expires_at>created_at)
);
create table crm_synthetic_approval_evidence (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,approval_id uuid not null,recorded_by uuid not null,
 channel text not null check(channel in('evelyn_whatsapp','evelyn_web')),nonce uuid not null, evidence jsonb not null check(jsonb_typeof(evidence)='object'),
 evidence_digest text not null check(evidence_digest ~ '^[0-9a-f]{64}$'),created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,approval_id,channel),unique(workspace_id,nonce),foreign key(workspace_id,project_id,approval_id) references crm_synthetic_approval_requests(workspace_id,project_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,recorded_by) references workspace_users(workspace_id,id)
);
create table crm_synthetic_approval_effects (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,approval_id uuid not null,actor_id uuid not null,
 effect text not null default 'SYNTHETIC_APPROVAL_PROBE' check(effect='SYNTHETIC_APPROVAL_PROBE'),external_effect boolean not null default false check(external_effect=false),
 created_at timestamptz not null default now(),data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,approval_id),foreign key(workspace_id,project_id,approval_id) references crm_synthetic_approval_requests(workspace_id,project_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id)
);
create function crm_synthetic_approval_scope_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if (to_jsonb(new)-array['state','challenge_id','version']) is distinct from (to_jsonb(old)-array['state','challenge_id','version']) or new.version<>old.version+1 then raise exception 'APPROVAL_SCOPE_IMMUTABLE'; end if;
 return new;
end $$;
create trigger crm_synthetic_approval_scope_immutable before update on crm_synthetic_approval_requests for each row execute function crm_synthetic_approval_scope_immutable();
create trigger crm_synthetic_approval_evidence_immutable before update or delete or truncate on crm_synthetic_approval_evidence for each statement execute function crm_reject_immutable_mutation();
create trigger crm_synthetic_approval_effects_immutable before update or delete or truncate on crm_synthetic_approval_effects for each statement execute function crm_reject_immutable_mutation();
do $$ declare relation text; actor_column text; begin
 foreach relation in array array['crm_synthetic_approval_requests','crm_synthetic_approval_evidence','crm_synthetic_approval_effects'] loop
  actor_column:=case relation when 'crm_synthetic_approval_requests' then 'created_by' when 'crm_synthetic_approval_evidence' then 'recorded_by' else 'actor_id' end;
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('create policy synthetic_approval_scope on %I to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true) and %I=nullif(current_setting(''app.actor_id'',true),'''')::uuid)',relation,actor_column);
  execute format('grant select,insert on %I to novalure_tenant_app',relation);
 end loop;
end $$;
grant update on crm_synthetic_approval_requests to novalure_tenant_app;
