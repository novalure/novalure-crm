-- Scoped Sales advisory. No active grant, provider, customer identity or legal authority is seeded.
begin;
set local lock_timeout='5s';
set local statement_timeout='2min';

create table crm_website_sales_advisory (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 version integer not null check(version>0),last_command_id uuid not null,created_by uuid not null,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,workflow_id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,last_command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred
);
create table crm_website_sales_advisory_records (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,advisory_id uuid not null,
 aggregate_version integer not null check(aggregate_version>0),entity_id uuid not null,version integer not null check(version>0),kind text not null,
 workflow_version integer not null check(workflow_version>0),evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=120000),
 canonical_bindings jsonb not null default '{}' check(jsonb_typeof(canonical_bindings)='object' and octet_length(canonical_bindings::text)<=16000),
 record_digest text not null check(record_digest ~ '^[a-f0-9]{64}$'),previous_digest text check(previous_digest ~ '^[a-f0-9]{64}$'),
 source_confidence text not null check(source_confidence in('OPERATOR_RECORDED','SERVER_DERIVED','MODEL_DRAFT')),
 created_by uuid not null,command_id uuid not null,created_at timestamptz not null default clock_timestamp(),valid_until timestamptz not null,
 unique(workspace_id,id),unique(workspace_id,project_id,id),unique(workspace_id,advisory_id,aggregate_version),unique(workspace_id,advisory_id,entity_id,version),
 unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,advisory_id) references crm_website_sales_advisory(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check((version=1)=(previous_digest is null)),check(valid_until>created_at),
 check(kind in('VALUE_BASIS','VALUE_CASE','DISCOVERY_ANSWER','DISCOVERY_PLAN','TRANSCRIPT','TRANSCRIPT_ASSERTIONS','TRANSCRIPT_REVIEW','KNOWLEDGE','KNOWLEDGE_APPROVAL','EXPERIMENT_PLAN','EXPERIMENT_ASSIGNMENT','EXPERIMENT_STOP','FORECAST_POLICY','FORECAST','BUYER_PACKET','BUYER_PACKET_APPROVAL','ADVICE_REQUEST','ADVICE','ADVICE_REVIEW','COACHING','ROLEPLAY','VIDEO_STORYBOARD','VIDEO_APPROVAL','BUYER_GRANT','BUYER_GRANT_REVOCATION'))
);
create index website_sales_advisory_latest on crm_website_sales_advisory_records(workspace_id,workflow_id,kind,aggregate_version desc);

create table crm_website_sales_advisory_assignments (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 experiment_record_id uuid not null,variant_id text not null check(length(variant_id) between 1 and 80),assignment_digest text not null check(assignment_digest ~ '^[a-f0-9]{64}$'),
 origin_digest text not null check(origin_digest ~ '^[a-f0-9]{64}$'),workflow_version integer not null check(workflow_version>0),evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 assigned_by uuid not null,command_id uuid not null,assigned_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,experiment_record_id,workflow_id),unique(workspace_id,experiment_record_id,company_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,project_id,experiment_record_id) references crm_website_sales_advisory_records(workspace_id,project_id,id),
 foreign key(workspace_id,assigned_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred
);
create table crm_website_sales_advisory_buyer_grants (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 packet_record_id uuid not null,token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),principal_user_id uuid,
 public_snapshot jsonb not null check(jsonb_typeof(public_snapshot)='object' and octet_length(public_snapshot::text)<=100000),
 principal_email text,created_by uuid not null,created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,command_id uuid not null,
 unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,packet_record_id) references crm_website_sales_advisory_records(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,principal_user_id) references workspace_users(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check((principal_user_id is null)=(principal_email is null)),check(expires_at>created_at)
);
create table crm_website_sales_advisory_buyer_events (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 grant_id uuid not null,packet_record_id uuid not null,step_id uuid,version integer not null check(version>0),
 actor_id uuid not null,auth_identity_id uuid not null,auth_session_id uuid not null,
 idempotency_key uuid not null,correlation_id uuid not null,audit_reference uuid not null,request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),response jsonb not null check(jsonb_typeof(response)='object' and octet_length(response::text)<=12000),
 disposition text not null check(disposition in('CONFIRMED','DECLINED','QUESTION')),comment text not null check(length(comment)<=1000),
 created_at timestamptz not null default clock_timestamp(),auth_assurance text not null default 'AUTHENTICATED_ACCOUNT' check(auth_assurance='AUTHENTICATED_ACCOUNT'),
 unique(workspace_id,id),unique(workspace_id,grant_id,idempotency_key),unique(workspace_id,grant_id,step_id,version),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,grant_id) references crm_website_sales_advisory_buyer_grants(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,packet_record_id) references crm_website_sales_advisory_records(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 foreign key(auth_session_id) references auth_sessions(id),foreign key(auth_identity_id) references auth_identities(id)
);

create function crm_website_sales_advisory_update_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if (new.id,new.workspace_id,new.project_id,new.company_id,new.location_id,new.workflow_id,new.created_by,new.created_at)
 is distinct from(old.id,old.workspace_id,old.project_id,old.company_id,old.location_id,old.workflow_id,old.created_by,old.created_at)
 or new.version<>old.version+1 then raise exception using errcode='23514',message='Advisory scope is immutable and version must advance';end if;return new;
end $$;
revoke all on function crm_website_sales_advisory_update_guard() from public;
create trigger website_sales_advisory_version before update on crm_website_sales_advisory for each row execute function crm_website_sales_advisory_update_guard();
create trigger website_sales_advisory_no_delete before delete or truncate on crm_website_sales_advisory for each statement execute function crm_reject_immutable_mutation();
do $$declare relation text;begin
 foreach relation in array array['crm_website_sales_advisory','crm_website_sales_advisory_records','crm_website_sales_advisory_assignments','crm_website_sales_advisory_buyer_grants','crm_website_sales_advisory_buyer_events'] loop
  execute format('alter table %I add column data_classification text not null default ''UNCLASSIFIED'',add column data_purpose text not null default ''crm_sales''',relation);
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('create policy advisory_scope on %I for all to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
  execute format('revoke all on %I from public',relation);
  if relation<>'crm_website_sales_advisory_buyer_events' then execute format('grant select,insert on %I to novalure_tenant_app',relation);end if;
  if relation<>'crm_website_sales_advisory' then execute format('create trigger advisory_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);end if;
 end loop;
end $$;
grant update on crm_website_sales_advisory to novalure_tenant_app;
create policy advisory_actor on crm_website_sales_advisory as restrictive for insert to novalure_tenant_app with check(created_by=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy advisory_record_actor on crm_website_sales_advisory_records as restrictive for insert to novalure_tenant_app with check(created_by=nullif(current_setting('app.actor_id',true),'')::uuid and
 ((kind in('VALUE_BASIS','DISCOVERY_ANSWER','TRANSCRIPT','TRANSCRIPT_REVIEW','KNOWLEDGE','KNOWLEDGE_APPROVAL','EXPERIMENT_PLAN','EXPERIMENT_STOP','FORECAST_POLICY','BUYER_PACKET_APPROVAL','ADVICE_REVIEW','VIDEO_APPROVAL','BUYER_GRANT','BUYER_GRANT_REVOCATION') and source_confidence='OPERATOR_RECORDED' and crm_sales_ops_owner(workspace_id))
 or(kind in('VALUE_CASE','DISCOVERY_PLAN','TRANSCRIPT_ASSERTIONS','EXPERIMENT_ASSIGNMENT','FORECAST','BUYER_PACKET','ADVICE_REQUEST','COACHING','ROLEPLAY','VIDEO_STORYBOARD') and source_confidence='SERVER_DERIVED')
 or(kind='ADVICE' and source_confidence='MODEL_DRAFT')));
create policy advisory_assignment_actor on crm_website_sales_advisory_assignments as restrictive for insert to novalure_tenant_app with check(assigned_by=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy advisory_buyer_owner on crm_website_sales_advisory_buyer_grants as restrictive for insert to novalure_tenant_app with check(created_by=nullif(current_setting('app.actor_id',true),'')::uuid and crm_sales_ops_owner(workspace_id));

create table crm_website_sales_advisory_buyer_revocations (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 grant_id uuid not null,revoked_by uuid not null,reason text not null check(length(reason) between 1 and 2000),command_id uuid not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,grant_id) references crm_website_sales_advisory_buyer_grants(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,revoked_by) references workspace_users(workspace_id,id),foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred
);
alter table crm_website_sales_advisory_buyer_revocations enable row level security;alter table crm_website_sales_advisory_buyer_revocations force row level security;
create policy advisory_revoke_read on crm_website_sales_advisory_buyer_revocations for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy advisory_revoke_owner on crm_website_sales_advisory_buyer_revocations for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and revoked_by=nullif(current_setting('app.actor_id',true),'')::uuid and crm_sales_ops_owner(workspace_id) and crm_project_access(workspace_id,project_id,true));
grant select,insert on crm_website_sales_advisory_buyer_revocations to novalure_tenant_app;
create trigger advisory_revoke_immutable before update or delete or truncate on crm_website_sales_advisory_buyer_revocations for each statement execute function crm_reject_immutable_mutation();

create table crm_website_sales_advisory_jobs (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 kind text not null check(kind in('ADVICE','TRANSCRIPT_ANALYSIS','ROLEPLAY','VIDEO')),record_id uuid not null,version integer not null default 1 check(version>0),
 status text not null default 'READY' check(status in('READY','CLAIMED','SUCCEEDED','UNKNOWN','FAILED','CANCELLED')),
 frozen_context jsonb not null check(jsonb_typeof(frozen_context)='object' and octet_length(frozen_context::text)<=524288),
 context_digest text not null check(context_digest ~ '^[a-f0-9]{64}$'),source_refs jsonb not null check(jsonb_typeof(source_refs)='array' and octet_length(source_refs::text)<=12000),
 workflow_version integer not null check(workflow_version>0),evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 lease_token uuid,lease_expires_at timestamptz,result_record_id uuid,provider_reference text check(length(provider_reference)<=250),result_digest text check(result_digest ~ '^[a-f0-9]{64}$'),error_code text check(error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
 execution_authority jsonb check(execution_authority is null or(jsonb_typeof(execution_authority)='object' and octet_length(execution_authority::text)<=2000)),
 created_by uuid not null,command_id uuid not null,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,record_id,kind),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,record_id) references crm_website_sales_advisory_records(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,result_record_id) references crm_website_sales_advisory_records(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check((status='CLAIMED')=(lease_token is not null and lease_expires_at is not null))
);
create table crm_website_sales_advisory_job_events (
 id uuid primary key,workspace_id uuid not null,job_id uuid not null,version integer not null,from_status text not null,to_status text not null,
 execution_authority jsonb not null check(jsonb_typeof(execution_authority)='object' and octet_length(execution_authority::text)<=2000),
 result_digest text check(result_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,job_id,version),foreign key(workspace_id,job_id) references crm_website_sales_advisory_jobs(workspace_id,id)
);
alter table crm_website_sales_advisory_jobs add column data_classification text not null default 'UNCLASSIFIED',add column data_purpose text not null default 'crm_sales';
create trigger crm_sales_classification_guard before insert or update on crm_website_sales_advisory_jobs for each row execute function crm_set_sales_classification();
alter table crm_website_sales_advisory_jobs enable row level security;alter table crm_website_sales_advisory_jobs force row level security;
create policy advisory_job_scope on crm_website_sales_advisory_jobs for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and data_classification='NOVALURE_INTERNAL' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false));
create policy advisory_job_insert on crm_website_sales_advisory_jobs for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and created_by=nullif(current_setting('app.actor_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));
create policy advisory_job_cancel on crm_website_sales_advisory_jobs for update to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_sales_ops_owner(workspace_id)) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and status='CANCELLED' and crm_sales_ops_owner(workspace_id));
grant select,insert on crm_website_sales_advisory_jobs to novalure_tenant_app;
grant update(status,version,lease_token,lease_expires_at,error_code,updated_at) on crm_website_sales_advisory_jobs to novalure_tenant_app;
alter table crm_website_sales_advisory_job_events enable row level security;alter table crm_website_sales_advisory_job_events force row level security;
revoke all on crm_website_sales_advisory_job_events from public;
create trigger advisory_job_event_immutable before update or delete or truncate on crm_website_sales_advisory_job_events for each statement execute function crm_reject_immutable_mutation();
create function crm_website_sales_advisory_job_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if(new.id,new.workspace_id,new.project_id,new.company_id,new.location_id,new.workflow_id,new.kind,new.record_id,new.frozen_context,new.context_digest,new.source_refs,new.workflow_version,new.evidence_digest,new.created_by,new.command_id,new.created_at)
 is distinct from(old.id,old.workspace_id,old.project_id,old.company_id,old.location_id,old.workflow_id,old.kind,old.record_id,old.frozen_context,old.context_digest,old.source_refs,old.workflow_version,old.evidence_digest,old.created_by,old.command_id,old.created_at)
 or new.version<>old.version+1 or old.status in('SUCCEEDED','CANCELLED') then raise exception using errcode='23514',message='Immutable advisory job context or terminal result';end if;
 return new;
end $$;
revoke all on function crm_website_sales_advisory_job_guard() from public;
create trigger advisory_job_guard before update on crm_website_sales_advisory_jobs for each row execute function crm_website_sales_advisory_job_guard();
create trigger advisory_job_no_delete before delete or truncate on crm_website_sales_advisory_jobs for each statement execute function crm_reject_immutable_mutation();

create table crm_website_sales_advisory_video_assets (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 job_id uuid not null,storyboard_record_id uuid not null,mime text not null check(mime='video/webm'),bytes_bytea bytea not null check(octet_length(bytes_bytea) between 5 and 25000000),
 byte_sha256 text not null check(byte_sha256 ~ '^[a-f0-9]{64}$' and byte_sha256=encode(sha256(bytes_bytea),'hex')),
 duration_seconds numeric not null check(duration_seconds>0 and duration_seconds<=180),width integer not null check(width between 320 and 3840),height integer not null check(height between 240 and 2160),
 capture_proof jsonb not null check(jsonb_typeof(capture_proof)='object' and octet_length(capture_proof::text)<=12000),
 created_by uuid not null,execution_authority jsonb not null check(jsonb_typeof(execution_authority)='object' and octet_length(execution_authority::text)<=2000),
 created_at timestamptz not null default clock_timestamp(),valid_until timestamptz not null,
 unique(workspace_id,id),unique(workspace_id,job_id),
 foreign key(workspace_id,job_id) references crm_website_sales_advisory_jobs(workspace_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,storyboard_record_id) references crm_website_sales_advisory_records(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),check(valid_until>created_at),check(substring(bytes_bytea from 1 for 4)=decode('1a45dfa3','hex'))
);
alter table crm_website_sales_advisory_video_assets enable row level security;alter table crm_website_sales_advisory_video_assets force row level security;
revoke all on crm_website_sales_advisory_video_assets from public;
create policy advisory_video_metadata on crm_website_sales_advisory_video_assets for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
grant select(id,workspace_id,project_id,company_id,location_id,workflow_id,job_id,storyboard_record_id,mime,byte_sha256,duration_seconds,width,height,created_by,created_at,valid_until) on crm_website_sales_advisory_video_assets to novalure_tenant_app;
create trigger advisory_video_immutable before update or delete or truncate on crm_website_sales_advisory_video_assets for each statement execute function crm_reject_immutable_mutation();

-- Dedicated capabilities remain explicit opt-in; no saved grant or default registration is changed.
alter table crm_website_sales_machine_grants drop constraint crm_website_sales_machine_grants_scopes_check;
alter table crm_website_sales_machine_grants add constraint crm_website_sales_machine_grants_scopes_check check(cardinality(scopes)>0 and scopes <@ array['crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile','crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo','crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff','crm.website-sales.autonomy.read','crm.website-sales.autonomy.plan-portfolio','crm.website-sales.autonomy.claim-allocation','crm.website-sales.autonomy.settle-allocation','crm.website-sales.autonomy.propose-price','crm.website-sales.autonomy.apply-quote','crm.website-sales.autonomy.record-outcome','crm.website-sales.autonomy.propose-improvement','crm.website-sales.autonomy.promote-improvement','crm.website-sales.conversation.read','crm.website-sales.conversation.record-topic','crm.website-sales.conversation.draft-answer','crm.website-sales.conversation.advance-conversation','crm.website-sales.conversation.stop-conversation','crm.website-sales.enablement.read','crm.website-sales.enablement.propose-next-step','crm.website-sales.enablement.propose-care','crm.website-sales.enablement.prepare-care-offer','crm.website-sales.enablement.scan-hygiene','crm.website-sales.commerce.read','crm.website-sales.commerce.reconcile','crm.website-sales.commerce.prepare-contract','crm.website-sales.commerce.queue-offer-delivery','crm.website-sales.commerce.queue-contract-delivery','crm.website-sales.commerce.request-signature','crm.website-sales.commerce.prepare-invoice-request','crm.website-sales.commerce.propose-renewal','crm.website-sales.commerce.ingest-source','crm.website-sales.advisory.read','crm.website-sales.advisory.reconcile','crm.website-sales.advisory.prepare-value-case','crm.website-sales.advisory.prepare-discovery','crm.website-sales.advisory.prepare-buyer-packet','crm.website-sales.advisory.prepare-advice','crm.website-sales.advisory.assess-coaching','crm.website-sales.advisory.assign-experiment','crm.website-sales.advisory.prepare-forecast','crm.website-sales.advisory.prepare-roleplay','crm.website-sales.advisory.prepare-video-storyboard','crm.website-sales.advisory.process-job']::text[]);
alter table crm_website_sales_machine_events drop constraint crm_website_sales_machine_events_action_check;
alter table crm_website_sales_machine_events add constraint crm_website_sales_machine_events_action_check check(action in('crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile','crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo','crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff','crm.website-sales.autonomy.read','crm.website-sales.autonomy.plan-portfolio','crm.website-sales.autonomy.claim-allocation','crm.website-sales.autonomy.settle-allocation','crm.website-sales.autonomy.propose-price','crm.website-sales.autonomy.apply-quote','crm.website-sales.autonomy.record-outcome','crm.website-sales.autonomy.propose-improvement','crm.website-sales.autonomy.promote-improvement','crm.website-sales.conversation.read','crm.website-sales.conversation.record-topic','crm.website-sales.conversation.draft-answer','crm.website-sales.conversation.advance-conversation','crm.website-sales.conversation.stop-conversation','crm.website-sales.enablement.read','crm.website-sales.enablement.propose-next-step','crm.website-sales.enablement.propose-care','crm.website-sales.enablement.prepare-care-offer','crm.website-sales.enablement.scan-hygiene','crm.website-sales.commerce.read','crm.website-sales.commerce.reconcile','crm.website-sales.commerce.prepare-contract','crm.website-sales.commerce.queue-offer-delivery','crm.website-sales.commerce.queue-contract-delivery','crm.website-sales.commerce.request-signature','crm.website-sales.commerce.prepare-invoice-request','crm.website-sales.commerce.propose-renewal','crm.website-sales.commerce.ingest-source','crm.website-sales.advisory.read','crm.website-sales.advisory.reconcile','crm.website-sales.advisory.prepare-value-case','crm.website-sales.advisory.prepare-discovery','crm.website-sales.advisory.prepare-buyer-packet','crm.website-sales.advisory.prepare-advice','crm.website-sales.advisory.assess-coaching','crm.website-sales.advisory.assign-experiment','crm.website-sales.advisory.prepare-forecast','crm.website-sales.advisory.prepare-roleplay','crm.website-sales.advisory.prepare-video-storyboard','crm.website-sales.advisory.process-job'));
create or replace function public.crm_lock_website_sales_machine_grant(p_workload uuid,p_grant uuid)
returns setof public.crm_website_sales_machine_grants
language sql volatile security definer set search_path=pg_catalog,public as $function$
 select g.* from public.crm_website_sales_machine_grants g
 join public.crm_website_sales_machine_workloads p on p.id=g.workload_id and p.workspace_id=g.workspace_id
 join public.workspace_users source_actor on source_actor.id=p.actor_user_id and source_actor.workspace_id=p.workspace_id
 join public.workspace_users actor on actor.id=g.actor_user_id and actor.workspace_id=g.workspace_id
 join public.workspaces w on w.id=g.workspace_id
 join public.project_pipeline_permissions project_grant on project_grant.workspace_id=g.workspace_id and project_grant.project_id=g.project_id and project_grant.user_id=g.actor_user_id
 where g.id=p_grant and p.id=p_workload and not g.disabled and g.revoked_at is null
  and g.not_before<=clock_timestamp() and(g.expires_at is null or g.expires_at>clock_timestamp())
  and not p.disabled and not p.kill_switch_active and p.revoked_at is null and p.not_before<=clock_timestamp() and(p.expires_at is null or p.expires_at>clock_timestamp())
  and source_actor.status='active' and source_actor.role='agent' and source_actor.product_role='novalure_operator'
  and actor.status='active' and actor.role='agent' and actor.product_role in('novalure_operator','novalure_sales')
  and w.operating_model='novalure_internal' and project_grant.can_read
  and(g.scopes <@ array['crm.website-sales.read','crm.website-sales.studio.read','crm.website-sales.lifecycle.read','crm.website-sales.autonomy.read','crm.website-sales.conversation.read','crm.website-sales.enablement.read','crm.website-sales.commerce.read','crm.website-sales.commerce.reconcile','crm.website-sales.advisory.read','crm.website-sales.advisory.reconcile']::text[] or project_grant.can_edit_deals)
  and exists(select 1 from public.projects project join public.organizations company on company.workspace_id=project.workspace_id and company.project_id=project.id
    where project.workspace_id=g.workspace_id and project.id=g.project_id and company.id=g.company_id and project.division='WEB_DESIGN'
     and project.data_classification='NOVALURE_INTERNAL' and project.data_purpose='crm_sales' and company.data_classification='NOVALURE_INTERNAL' and company.data_purpose='crm_sales')
  and(g.location_id is null or exists(select 1 from public.crm_company_locations location where location.workspace_id=g.workspace_id and location.project_id=g.project_id and location.company_id=g.company_id and location.id=g.location_id))
 for share of g,p,source_actor,actor,w,project_grant
$function$;

-- The access role cannot log in, bypass RLS or change business objects. Only
-- fixed capability functions below can disclose a reviewed snapshot or append a buyer statement.
do $$begin
 if not exists(select 1 from pg_roles where rolname='novalure_website_sales_advisory_access_owner') then create role novalure_website_sales_advisory_access_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;
 if not exists(select 1 from pg_roles where rolname='novalure_website_sales_advisory_executor') then create role novalure_website_sales_advisory_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;
end $$;
grant usage on schema public to novalure_website_sales_advisory_access_owner,novalure_website_sales_advisory_executor;
do $$declare relation text;begin
 foreach relation in array array['crm_website_sales_advisory','crm_website_sales_advisory_records','crm_website_sales_advisory_buyer_grants','crm_website_sales_advisory_buyer_revocations','crm_website_sales_advisory_buyer_events','crm_website_sales_advisory_video_assets','crm_website_sales_workflows','crm_website_sales_observations','crm_company_locations','contacts','consent_records','newsletter_suppressions','crm_website_sales_enablement_records','crm_website_sales_enablement_assets','crm_website_studio_artifacts','crm_website_studio_qa','crm_offers','crm_offer_revisions','crm_offer_approvals','workspaces','projects'] loop
  execute format('grant select on %I to novalure_website_sales_advisory_access_owner',relation);
  execute format('create policy advisory_access_reader on %I for select to novalure_website_sales_advisory_access_owner using(true)',relation);
 end loop;
end $$;
grant select(id,workspace_id,auth_identity_id,status,role,email) on workspace_users to novalure_website_sales_advisory_access_owner;
create policy advisory_access_reader on workspace_users for select to novalure_website_sales_advisory_access_owner using(true);
grant select(id,normalized_email,disabled_at) on auth_identities to novalure_website_sales_advisory_access_owner;
grant select(id,auth_identity_id,workspace_user_id,workspace_id,revoked_at,expires_at) on auth_sessions to novalure_website_sales_advisory_access_owner;
grant update(id) on workspace_users,workspaces,auth_sessions,auth_identities to novalure_website_sales_advisory_access_owner;
-- UPDATE is only a PostgreSQL row-lock prerequisite; no function below updates these relations.
grant insert on crm_website_sales_advisory_buyer_events,audit_logs to novalure_website_sales_advisory_access_owner;
create policy advisory_buyer_append on crm_website_sales_advisory_buyer_events for insert to novalure_website_sales_advisory_access_owner with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy advisory_buyer_audit on audit_logs for insert to novalure_website_sales_advisory_access_owner with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid and action='website_sales.advisory.buyer_statement');
grant execute on function crm_website_sales_demo_profile_current(jsonb) to novalure_website_sales_advisory_access_owner;

create function crm_website_sales_advisory_record_current(p_id uuid,p_depth integer default 0) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $current$
declare r public.crm_website_sales_advisory_records%rowtype;w public.crm_website_sales_workflows%rowtype;observation_record public.crm_website_sales_observations%rowtype;parent jsonb;source jsonb;child uuid;ok boolean;
begin
 if p_depth>8 then return false;end if;
 select * into r from public.crm_website_sales_advisory_records where id=p_id;
 if not found or r.valid_until<=clock_timestamp() then return false;end if;
 if r.kind in('KNOWLEDGE_APPROVAL','BUYER_PACKET_APPROVAL','VIDEO_APPROVAL','ADVICE_REVIEW') and not exists(select 1 from public.workspace_users u where u.workspace_id=r.workspace_id and u.id=r.created_by and u.role='owner' and u.status='active') then return false;end if;
 select * into w from public.crm_website_sales_workflows where workspace_id=r.workspace_id and project_id=r.project_id and company_id=r.company_id and location_id=r.location_id and id=r.workflow_id;
 if not found then return false;end if;
 select * into observation_record from public.crm_website_sales_observations where workspace_id=w.workspace_id and project_id=w.project_id and company_id=w.company_id and location_id=w.location_id and id=w.observation_id;
 if not found or r.workflow_version>w.version or r.evidence_digest<>observation_record.evidence_digest or exists(select 1 from public.crm_website_sales_advisory_records n where n.workspace_id=r.workspace_id and n.workflow_id=r.workflow_id and n.entity_id=r.entity_id and n.version>r.version) then return false;end if;
 if exists(select 1 from public.crm_website_sales_workflows other where other.workspace_id=w.workspace_id and other.contact_id=w.contact_id and other.status='STOPPED' and other.stop_reason in('OPT_OUT','UNKNOWN_DELIVERY')) then return false;end if;
 if not exists(select 1 from public.crm_company_locations l where l.workspace_id=w.workspace_id and l.project_id=w.project_id and l.company_id=w.company_id and l.id=w.location_id and l.version=w.location_version) then return false;end if;
 for source in select value from jsonb_path_query(r.payload,'$.** ? (@.observedAt != null && @.validUntil != null)') as q(value) loop
  if (source->>'observedAt')::timestamptz>clock_timestamp() or(source->>'validUntil')::timestamptz<=clock_timestamp() then return false;end if;
 end loop;
 for parent in select value from jsonb_array_elements(coalesce(r.canonical_bindings->'parentRefs','[]'::jsonb)) loop
  child:=null;select a.id into child from public.crm_website_sales_advisory_records a where a.workspace_id=r.workspace_id and a.project_id=r.project_id and a.company_id=r.company_id and a.location_id=r.location_id and a.workflow_id=r.workflow_id and a.entity_id=(parent->>'id')::uuid and a.version=(parent->>'version')::integer and a.record_digest=parent->>'digest';
  if child is not null then if not public.crm_website_sales_advisory_record_current(child,p_depth+1) then return false;end if;continue;end if;
  select exists(select 1 from public.crm_website_sales_enablement_records e where e.workspace_id=r.workspace_id and e.project_id=r.project_id and e.company_id=r.company_id and e.location_id=r.location_id and e.workflow_id=r.workflow_id and e.entity_id=(parent->>'id')::uuid and e.version=(parent->>'version')::integer and e.record_digest=parent->>'digest' and e.valid_until>clock_timestamp() and not exists(select 1 from public.crm_website_sales_enablement_records n where n.workspace_id=e.workspace_id and n.workflow_id=e.workflow_id and n.kind=e.kind and n.aggregate_version>e.aggregate_version and(e.kind in('BRIEF','CLOSE_PLAN','DEMO_PROFILE') or n.entity_id=e.entity_id))) into ok;
  if ok then continue;end if;
  select exists(select 1 from public.crm_website_studio_artifacts a where a.workspace_id=r.workspace_id and a.project_id=r.project_id and a.company_id=r.company_id and a.location_id=r.location_id and a.workflow_id=r.workflow_id and a.id=(parent->>'id')::uuid and a.version=(parent->>'version')::integer and a.artifact_digest=parent->>'digest' and a.evidence_digest=observation_record.evidence_digest and a.valid_until>clock_timestamp() and not exists(select 1 from public.crm_website_studio_artifacts n where n.workspace_id=a.workspace_id and n.workflow_id=a.workflow_id and n.kind=a.kind and n.version>a.version) and public.crm_website_sales_demo_profile_current(a.artifact)) into ok;
  if ok then continue;end if;
  select exists(select 1 from public.crm_website_sales_enablement_assets a where a.workspace_id=r.workspace_id and a.project_id=r.project_id and a.company_id=r.company_id and a.location_id=r.location_id and a.workflow_id=r.workflow_id and a.id=(parent->>'id')::uuid and a.version=(parent->>'version')::integer and a.valid_until>clock_timestamp() and not exists(select 1 from public.crm_website_sales_enablement_records v where v.workspace_id=a.workspace_id and v.workflow_id=a.workflow_id and v.kind='ASSET_REVOCATION' and v.payload->>'assetId'=a.id::text)) into ok;
  if ok then continue;end if;
  select exists(select 1 from public.crm_offers o join public.crm_offer_revisions v on v.workspace_id=o.workspace_id and v.offer_id=o.id and v.revision=o.revision where o.workspace_id=r.workspace_id and o.project_id=r.project_id and o.organization_id=r.company_id and o.id=(parent->>'id')::uuid and o.revision=(parent->>'version')::integer and v.content_digest=parent->>'digest' and(v.content->>'validUntil')::timestamptz>clock_timestamp()) into ok;
  if not ok then return false;end if;
 end loop;
 return true;
exception when invalid_text_representation or datetime_field_overflow then return false;
end $current$;

create function crm_website_sales_advisory_current_for_actor(p_workspace uuid,p_project uuid,p_company uuid,p_location uuid,p_workflow uuid,p_record uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or not public.crm_lock_project_access(p_workspace,p_project,false) then raise exception using errcode='42501',message='Scoped current actor required';end if;
 if not exists(select 1 from public.crm_website_sales_advisory_records r where r.workspace_id=p_workspace and r.project_id=p_project and r.company_id=p_company and r.location_id=p_location and r.workflow_id=p_workflow and r.id=p_record) then return false;end if;
 return public.crm_website_sales_advisory_record_current(p_record,0);
end $$;

create function crm_website_sales_advisory_buyer_access(p_hash text,p_actor uuid default null,p_identity uuid default null,p_session uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $access$
declare g public.crm_website_sales_advisory_buyer_grants%rowtype;r public.crm_website_sales_advisory_records%rowtype;w public.crm_website_sales_workflows%rowtype;c public.contacts%rowtype;can_write boolean:=false;snapshot jsonb;packet_ref jsonb;binding text;proofs jsonb;video_row record;
begin
 if p_hash is null or p_hash!~'^[a-f0-9]{64}$' then return null;end if;
 select * into g from public.crm_website_sales_advisory_buyer_grants where token_hash=p_hash;
 if not found then return null;end if;
 perform pg_advisory_xact_lock(hashtextextended('website-sales-operations:'||g.workspace_id::text||':'||g.project_id::text,0));
 select * into g from public.crm_website_sales_advisory_buyer_grants where id=g.id;
 if g.expires_at<=clock_timestamp() or exists(select 1 from public.crm_website_sales_advisory_buyer_revocations v where v.workspace_id=g.workspace_id and v.grant_id=g.id) then return null;end if;
 select * into r from public.crm_website_sales_advisory_records where workspace_id=g.workspace_id and id=g.packet_record_id;
 if r.kind<>'BUYER_PACKET' or r.payload->>'status'<>'READY' or not public.crm_website_sales_advisory_record_current(r.id,0) then return null;end if;
 packet_ref:=jsonb_build_object('id',r.entity_id,'version',r.version,'digest',r.record_digest);
 if not exists(select 1 from public.crm_website_sales_advisory_records a join public.workspace_users u on u.workspace_id=a.workspace_id and u.id=a.created_by and u.role='owner' and u.status='active' where a.workspace_id=r.workspace_id and a.workflow_id=r.workflow_id and a.kind='BUYER_PACKET_APPROVAL' and a.payload->'recordRef'=packet_ref and a.valid_until>clock_timestamp()) then return null;end if;
 select * into w from public.crm_website_sales_workflows where workspace_id=g.workspace_id and project_id=g.project_id and company_id=g.company_id and location_id=g.location_id and id=g.workflow_id;
 if w.status='STOPPED' and w.stop_reason<>'REPLY_RECEIVED' then return null;end if;
 select * into c from public.contacts where workspace_id=g.workspace_id and project_id=g.project_id and organization_id=g.company_id and id=w.contact_id;
 if not found or c.archived_at is not null then return null;end if;
 perform pg_advisory_xact_lock(hashtextextended('website-sales-commerce-email:'||g.workspace_id::text||':'||lower(c.email),0));
 if c.consent_label ~* '(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)' or exists(select 1 from public.newsletter_suppressions n where n.workspace_id=g.workspace_id and lower(n.email)=lower(c.email)) or exists(select 1 from public.consent_records n where n.workspace_id=g.workspace_id and n.contact_id=c.id and n.status ~* '(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)') or exists(select 1 from public.crm_website_sales_workflows n where n.workspace_id=g.workspace_id and n.contact_id=c.id and n.stop_reason in('OPT_OUT','UNKNOWN_DELIVERY')) then return null;end if;
 if p_actor is not null and p_identity is not null and p_session is not null and p_actor=g.principal_user_id then
  perform u.id from public.workspace_users u join public.auth_identities i on i.id=u.auth_identity_id join public.auth_sessions a on a.auth_identity_id=i.id and a.workspace_user_id=u.id and a.workspace_id=u.workspace_id join public.workspaces ws on ws.id=u.workspace_id where u.workspace_id=g.workspace_id and u.id=p_actor and u.status='active' and i.id=p_identity and i.disabled_at is null and lower(i.normalized_email)=g.principal_email and lower(trim(u.email))=g.principal_email and a.id=p_session and a.revoked_at is null and a.expires_at>clock_timestamp() for share of u,i,a,ws;
  can_write:=found;
 end if;
 -- Byte-identical canonical payload to advisoryBuyerActorBindingHash; all interpolated fields are native UUID/hex/integer values.
 binding:=case when can_write then encode(sha256(convert_to(format('{"authIdentityId":"%s","domain":"website-sales-advisory-buyer-actor-v1","grantId":"%s","packetRef":{"digest":"%s","id":"%s","version":%s},"principalUserId":"%s","workspaceId":"%s"}',p_identity,g.id,r.record_digest,r.entity_id,r.version,g.principal_user_id,g.workspace_id),'UTF8')),'hex') else null end;
 snapshot:=g.public_snapshot||jsonb_build_object('contractVersion','website-sales-advisory-buyer-v1','grantId',g.id,'expiresAt',g.expires_at,'grantVersion',1,'actorUserId',case when can_write then p_actor else null end,'authAssurance',case when can_write then 'AUTHENTICATED_ACCOUNT' else 'READ_ONLY_LINK' end,'actorBindingHash',binding,'canWrite',can_write,'blockers',case when can_write then '[]'::jsonb else '["AUTHENTICATED_BOUND_ACCOUNT_REQUIRED"]'::jsonb end,'packetRef',packet_ref);
 select jsonb_agg(jsonb_build_object('artifact',a.artifact,'prospect',(select observation.prospect from public.crm_website_sales_observations observation where observation.workspace_id=w.workspace_id and observation.id=w.observation_id),'certificate',q.certificate,'builderId',a.created_by,'workflowId',a.workflow_id)) into proofs from jsonb_array_elements(coalesce(r.payload#>'{value,demoRefs}','[]'::jsonb)) d join public.crm_website_studio_artifacts a on a.workspace_id=g.workspace_id and a.project_id=g.project_id and a.company_id=g.company_id and a.location_id=g.location_id and a.workflow_id=g.workflow_id and a.id=(d->>'id')::uuid and a.version=(d->>'version')::integer and a.artifact_digest=d->>'digest' join lateral(select certificate from public.crm_website_studio_qa q where q.workspace_id=a.workspace_id and q.project_id=a.project_id and q.company_id=a.company_id and q.location_id=a.location_id and q.workflow_id=a.workflow_id and q.artifact_id=a.id and q.expires_at>clock_timestamp() order by q.expires_at desc limit 1)q on true;
 if coalesce(jsonb_array_length(proofs),0)<>jsonb_array_length(coalesce(r.payload#>'{value,demoRefs}','[]'::jsonb)) then return null;end if;
 select v.*,story.payload#>>'{value,title}' as title,(select string_agg(shot->>'narration',E'\n' order by (shot->>'index')::int) from jsonb_array_elements(story.payload#>'{value,shots}')shot) as caption_text into video_row from public.crm_website_sales_advisory_video_assets v join public.crm_website_sales_advisory_records story on story.workspace_id=v.workspace_id and story.id=v.storyboard_record_id where v.workspace_id=g.workspace_id and v.project_id=g.project_id and v.company_id=g.company_id and v.location_id=g.location_id and v.workflow_id=g.workflow_id and story.payload#>'{value,packetRef}'=packet_ref and v.valid_until>clock_timestamp() and public.crm_website_sales_advisory_record_current(story.id,0) and exists(select 1 from public.crm_website_sales_advisory_records approval join public.workspace_users u on u.workspace_id=approval.workspace_id and u.id=approval.created_by and u.status='active' and u.role='owner' where approval.workspace_id=g.workspace_id and approval.workflow_id=g.workflow_id and approval.kind='VIDEO_APPROVAL' and approval.payload->'recordRef'=jsonb_build_object('id',story.entity_id,'version',story.version,'digest',story.record_digest) and approval.valid_until>clock_timestamp()) order by v.created_at desc,v.id limit 1;
 if found then snapshot:=jsonb_set(snapshot,'{video}',jsonb_strip_nulls(jsonb_build_object('id',video_row.id,'title',coalesce(video_row.title,'Website demo explanation'),'mediaPath','/api/public/website-sales/advisory/assets/'||video_row.id::text,'durationSeconds',video_row.duration_seconds,'sha256',video_row.byte_sha256,'captionText',video_row.caption_text)));end if;
 if snapshot->'valueCase' is not null and snapshot->'valueCase'<>'null'::jsonb and not exists(select 1 from public.crm_offers offer join public.crm_offer_revisions revision on revision.workspace_id=offer.workspace_id and revision.offer_id=offer.id and revision.revision=offer.revision join public.crm_offer_approvals approval on approval.workspace_id=offer.workspace_id and approval.id=offer.approval_id and approval.offer_id=offer.id and approval.revision=offer.revision and approval.content_digest=revision.content_digest and approval.decision='APPROVED' join public.workspace_users u on u.workspace_id=approval.workspace_id and u.id=approval.actor_id and u.status='active' and u.role='owner' where offer.workspace_id=g.workspace_id and offer.project_id=g.project_id and offer.organization_id=g.company_id and offer.id=(snapshot#>>'{valueCase,approvedOfferRef,id}')::uuid and offer.revision=(snapshot#>>'{valueCase,approvedOfferRef,version}')::integer and revision.content_digest=snapshot#>>'{valueCase,approvedOfferRef,digest}' and offer.status in('APPROVED','QUEUED','SENT','ACCEPTED') and approval.expires_at>clock_timestamp()) then return null;end if;
 if can_write then
  snapshot:=jsonb_set(snapshot,'{steps}',coalesce((select jsonb_agg(step||jsonb_build_object('version',coalesce((select max(e.version) from public.crm_website_sales_advisory_buyer_events e where e.workspace_id=g.workspace_id and e.grant_id=g.id and e.step_id=(step->>'id')::uuid),1),'status',coalesce((select case e.disposition when 'CONFIRMED' then 'CONFIRMED' else 'DECLINED' end from public.crm_website_sales_advisory_buyer_events e where e.workspace_id=g.workspace_id and e.grant_id=g.id and e.step_id=(step->>'id')::uuid and e.disposition<>'QUESTION' order by e.version desc limit 1),'PROPOSED')) order by ordinal) from jsonb_array_elements(snapshot->'steps') with ordinality as v(step,ordinal)),'[]'::jsonb));
  snapshot:=jsonb_set(snapshot,'{questions}',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'text',e.comment,'answer',(select advice.payload#>>'{value,summary}' from public.crm_website_sales_advisory_records review join public.workspace_users reviewer on reviewer.workspace_id=review.workspace_id and reviewer.id=review.created_by and reviewer.role='owner' and reviewer.status='active' join public.crm_website_sales_advisory_records advice on advice.workspace_id=review.workspace_id and advice.workflow_id=review.workflow_id and advice.entity_id=(review.payload#>>'{recordRef,id}')::uuid and advice.version=(review.payload#>>'{recordRef,version}')::integer and advice.record_digest=review.payload#>>'{recordRef,digest}' where review.workspace_id=g.workspace_id and review.workflow_id=g.workflow_id and review.kind='ADVICE_REVIEW' and review.payload->>'buyerQuestionId'=e.id::text and review.payload->>'publishToBuyer'='true' and review.payload->>'decision'='ACCEPTED' and public.crm_website_sales_advisory_record_current(review.id,0) order by review.created_at desc,review.id limit 1)) order by e.created_at,e.id) from (select * from public.crm_website_sales_advisory_buyer_events where workspace_id=g.workspace_id and grant_id=g.id and disposition='QUESTION' order by created_at desc,id desc limit 30)e),'[]'::jsonb));
 end if;
 return jsonb_build_object('public',snapshot,'identity',jsonb_build_object('workspaceId',g.workspace_id,'projectId',g.project_id,'companyId',g.company_id,'locationId',g.location_id),'workflowId',g.workflow_id,'packetRowId',r.id,'renderProofs',coalesce(proofs,'[]'::jsonb));
end $access$;

create function crm_website_sales_advisory_buyer_asset(p_hash text,p_asset uuid) returns table(bytes bytea,sha256 text)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare access jsonb;begin
 access:=public.crm_website_sales_advisory_buyer_access(p_hash,null,null,null);
 if access is null or access#>>'{public,video,id}' is distinct from p_asset::text then return;end if;
 return query select v.bytes_bytea,v.byte_sha256 from public.crm_website_sales_advisory_video_assets v where v.id=p_asset and v.workspace_id=(access#>>'{identity,workspaceId}')::uuid and v.project_id=(access#>>'{identity,projectId}')::uuid and v.company_id=(access#>>'{identity,companyId}')::uuid and v.location_id=(access#>>'{identity,locationId}')::uuid and v.workflow_id=(access->>'workflowId')::uuid and v.valid_until>clock_timestamp();
end $$;

create function crm_website_sales_advisory_questions(p_workspace uuid,p_project uuid,p_company uuid,p_location uuid,p_workflow uuid)
returns table(id uuid,"grantId" uuid,"packetId" uuid,"packetVersion" integer,"packetDigest" text,question text,"createdAt" timestamptz)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or not public.crm_lock_project_access(p_workspace,p_project,false) then raise exception using errcode='42501',message='Scoped current actor required';end if;
 return query select e.id,e.grant_id,r.entity_id,r.version,r.record_digest,e.comment,e.created_at from public.crm_website_sales_advisory_buyer_events e join public.crm_website_sales_advisory_records r on r.workspace_id=e.workspace_id and r.id=e.packet_record_id where e.workspace_id=p_workspace and e.project_id=p_project and e.company_id=p_company and e.location_id=p_location and e.workflow_id=p_workflow and e.disposition='QUESTION' order by e.created_at desc,e.id limit 100;
end $$;

create function crm_website_sales_advisory_buyer_command(p_hash text,p_actor uuid,p_identity uuid,p_session uuid,p_command jsonb,p_reconcile boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $command$
declare access jsonb;pub jsonb;ident jsonb;g public.crm_website_sales_advisory_buyer_grants%rowtype;e public.crm_website_sales_advisory_buyer_events%rowtype;request_digest text;next_version integer;event_id uuid:=gen_random_uuid();audit_id uuid:=gen_random_uuid();response jsonb;step uuid:=(p_command->>'stepId')::uuid;
begin
 access:=public.crm_website_sales_advisory_buyer_access(p_hash,p_actor,p_identity,p_session);pub:=access->'public';ident:=access->'identity';
 if access is null or(pub->>'canWrite')::boolean is distinct from true or p_actor is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or(ident->>'workspaceId')::uuid is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid then raise exception using errcode='42501',message='Current bound buyer account required';end if;
 if p_command->>'actorBindingHash' is distinct from pub->>'actorBindingHash' or p_command->>'grantId' is distinct from pub->>'grantId' or p_command->'packetRef' is distinct from pub->'packetRef' or(p_command->>'expectedGrantVersion')::integer<>1 then raise exception using errcode='40001',message='Buyer binding changed';end if;
 select * into g from public.crm_website_sales_advisory_buyer_grants where id=(pub->>'grantId')::uuid;
 request_digest:=encode(sha256(convert_to(jsonb_build_array(p_actor,p_identity,g.id,p_command)::text,'UTF8')),'hex');
 select * into e from public.crm_website_sales_advisory_buyer_events where workspace_id=g.workspace_id and grant_id=g.id and idempotency_key=(p_command->>'idempotencyKey')::uuid;
 if found then if e.request_hash<>request_digest then raise exception using errcode='23505',message='Buyer idempotency conflict';end if;response:=e.response||jsonb_build_object('replayed',true);return jsonb_build_object('status','COMMITTED','receipt',response,'currentData',pub);end if;
 if p_reconcile then return jsonb_build_object('status','NOT_FOUND');end if;
 if step is not null then
  if not exists(select 1 from jsonb_array_elements(pub->'steps') q where q->>'id'=step::text) then raise exception using errcode='42501',message='Step outside approved packet';end if;
  select coalesce(max(version),1) into next_version from public.crm_website_sales_advisory_buyer_events where workspace_id=g.workspace_id and grant_id=g.id and step_id=step;
  if next_version<>(p_command->>'expectedStepVersion')::integer then raise exception using errcode='40001',message='Buyer step version changed';end if;next_version:=next_version+1;
 else next_version:=1;end if;
 response:=jsonb_build_object('contractVersion','website-sales-advisory-buyer-v1','persisted',true,'commandId',event_id,'auditReference',audit_id::text,'correlationId',p_command->>'correlationId','replayed',false,'data',jsonb_build_object('grantId',g.id,'packetRef',pub->'packetRef','actorUserId',p_actor,'actorBindingHash',pub->>'actorBindingHash','grantVersion',1,'stepId',step,'stepVersion',case when step is not null then next_version else null end,'questionId',case when p_command->>'disposition'='QUESTION' then event_id else null end));
 insert into public.crm_website_sales_advisory_buyer_events(id,workspace_id,project_id,company_id,location_id,workflow_id,grant_id,packet_record_id,step_id,version,actor_id,auth_identity_id,auth_session_id,idempotency_key,correlation_id,audit_reference,request_hash,response,disposition,comment) values(event_id,g.workspace_id,g.project_id,g.company_id,g.location_id,g.workflow_id,g.id,g.packet_record_id,step,next_version,p_actor,p_identity,p_session,(p_command->>'idempotencyKey')::uuid,(p_command->>'correlationId')::uuid,audit_id,request_digest,response,p_command->>'disposition',coalesce(p_command->>'comment',''));
 insert into public.audit_logs(id,workspace_id,actor_user_id,project_id,action,entity_type,entity_id,after) values(audit_id,g.workspace_id,p_actor,g.project_id,'website_sales.advisory.buyer_statement','website_sales_buyer',g.id,jsonb_build_object('eventId',event_id,'requestHash',request_digest,'authSessionId',p_session,'authIdentityId',p_identity,'assurance','AUTHENTICATED_ACCOUNT','legalSignature',false));
 return jsonb_build_object('status','COMMITTED','receipt',response,'currentData',(public.crm_website_sales_advisory_buyer_access(p_hash,p_actor,p_identity,p_session))->'public');
end $command$;

-- Only this separately provisioned NOLOGIN executor may process non-authoritative jobs.
grant execute on function crm_lock_website_sales_machine_grant(uuid,uuid),crm_lock_project_access(uuid,uuid,boolean),crm_website_sales_has_reply(uuid,uuid,uuid,timestamptz) to novalure_website_sales_advisory_executor;
do $$declare relation text;begin
 foreach relation in array array['crm_website_sales_advisory','crm_website_sales_advisory_records','crm_website_sales_advisory_assignments','crm_website_sales_advisory_buyer_grants','crm_website_sales_advisory_buyer_revocations','crm_website_sales_advisory_buyer_events','crm_website_sales_advisory_jobs','crm_website_sales_advisory_video_assets','crm_website_sales_enablement_records','crm_website_sales_enablement_assets','crm_website_studio_artifacts','crm_website_studio_qa'] loop
  execute format('grant select on %I to novalure_website_sales_advisory_executor',relation);
  execute format('create policy advisory_executor_read on %I for select to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and project_id=nullif(current_setting(''app.advisory_project_id'',true),'''')::uuid and company_id=nullif(current_setting(''app.advisory_company_id'',true),'''')::uuid and location_id=nullif(current_setting(''app.advisory_location_id'',true),'''')::uuid and workflow_id=nullif(current_setting(''app.advisory_workflow_id'',true),'''')::uuid)',relation);
 end loop;
 foreach relation in array array['workspaces','projects','organizations','contacts','consent_records','newsletter_suppressions','crm_offers','crm_offer_revisions','crm_offer_approvals'] loop
  execute format('grant select on %I to novalure_website_sales_advisory_executor',relation);
  if relation='workspaces' then execute 'create policy advisory_executor_read on workspaces for select to novalure_website_sales_advisory_executor using(id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)';
  else execute format('create policy advisory_executor_read on %I for select to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);end if;
 end loop;
end $$;
grant select(id,workspace_id,auth_identity_id,status,role,product_role,email,name) on workspace_users to novalure_website_sales_advisory_executor;
create policy advisory_executor_read on workspace_users for select to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_website_sales_workflows,crm_website_sales_observations,crm_company_locations to novalure_website_sales_advisory_executor;
create policy advisory_executor_read on crm_website_sales_workflows for select to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid);
create policy advisory_executor_read on crm_website_sales_observations for select to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and project_id=nullif(current_setting('app.advisory_project_id',true),'')::uuid and company_id=nullif(current_setting('app.advisory_company_id',true),'')::uuid and location_id=nullif(current_setting('app.advisory_location_id',true),'')::uuid);
create policy advisory_executor_read on crm_company_locations for select to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and id=nullif(current_setting('app.advisory_location_id',true),'')::uuid);
grant insert on crm_website_sales_advisory_records,crm_website_sales_advisory_video_assets,crm_website_sales_advisory_job_events to novalure_website_sales_advisory_executor;
grant update on crm_website_sales_advisory,crm_website_sales_advisory_jobs to novalure_website_sales_advisory_executor;
create policy advisory_executor_aggregate on crm_website_sales_advisory for update to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and workflow_id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and workflow_id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid);
create policy advisory_executor_record on crm_website_sales_advisory_records for insert to novalure_website_sales_advisory_executor with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and workflow_id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid and created_by=nullif(current_setting('app.actor_id',true),'')::uuid and kind in('ADVICE','TRANSCRIPT_ASSERTIONS','ROLEPLAY') and source_confidence='MODEL_DRAFT');
create policy advisory_executor_job on crm_website_sales_advisory_jobs for update to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and workflow_id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and workflow_id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid);
create policy advisory_executor_video on crm_website_sales_advisory_video_assets for insert to novalure_website_sales_advisory_executor with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and workflow_id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid and created_by=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy advisory_executor_job_event on crm_website_sales_advisory_job_events for insert to novalure_website_sales_advisory_executor with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(select 1 from crm_website_sales_advisory_jobs j where j.workspace_id=workspace_id and j.id=job_id and j.workflow_id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid));
grant update(id) on crm_company_locations,crm_website_sales_workflows to novalure_website_sales_advisory_executor;
create policy advisory_executor_location_lock on crm_company_locations for update to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and id=nullif(current_setting('app.advisory_location_id',true),'')::uuid) with check(false);
create policy advisory_executor_workflow_lock on crm_website_sales_workflows for update to novalure_website_sales_advisory_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and id=nullif(current_setting('app.advisory_workflow_id',true),'')::uuid) with check(false);

-- Exact installer-owned temporary membership is removed/restored transactionally.
-- PostgreSQL's automatic creator ADMIN-only membership remains SET=false/INHERIT=false.
do $$declare previous_membership record;had_previous boolean;begin
 select m.admin_option,m.inherit_option,m.set_option into previous_membership from pg_auth_members m where m.roleid=(select oid from pg_roles where rolname='novalure_website_sales_advisory_access_owner') and m.member=(select oid from pg_roles where rolname=current_user) and m.grantor=(select oid from pg_roles where rolname=current_user);had_previous:=found;
 execute format('grant novalure_website_sales_advisory_access_owner to %I with set true,inherit true',current_user);
 grant create on schema public to novalure_website_sales_advisory_access_owner;
 alter function crm_website_sales_advisory_record_current(uuid,integer) owner to novalure_website_sales_advisory_access_owner;
 alter function crm_website_sales_advisory_current_for_actor(uuid,uuid,uuid,uuid,uuid,uuid) owner to novalure_website_sales_advisory_access_owner;
 alter function crm_website_sales_advisory_buyer_access(text,uuid,uuid,uuid) owner to novalure_website_sales_advisory_access_owner;
 alter function crm_website_sales_advisory_buyer_asset(text,uuid) owner to novalure_website_sales_advisory_access_owner;
 alter function crm_website_sales_advisory_questions(uuid,uuid,uuid,uuid,uuid) owner to novalure_website_sales_advisory_access_owner;
 alter function crm_website_sales_advisory_buyer_command(text,uuid,uuid,uuid,jsonb,boolean) owner to novalure_website_sales_advisory_access_owner;
 revoke create on schema public from novalure_website_sales_advisory_access_owner;
 revoke all on function crm_website_sales_advisory_record_current(uuid,integer),crm_website_sales_advisory_buyer_access(text,uuid,uuid,uuid),crm_website_sales_advisory_buyer_command(text,uuid,uuid,uuid,jsonb,boolean) from public;
 revoke all on function crm_website_sales_advisory_questions(uuid,uuid,uuid,uuid,uuid) from public;
 grant execute on function crm_website_sales_advisory_questions(uuid,uuid,uuid,uuid,uuid) to novalure_tenant_app;
 revoke all on function crm_website_sales_advisory_buyer_asset(text,uuid) from public;
 grant execute on function crm_website_sales_advisory_buyer_asset(text,uuid) to novalure_tenant_app;
 revoke all on function crm_website_sales_advisory_current_for_actor(uuid,uuid,uuid,uuid,uuid,uuid) from public;
 grant execute on function crm_website_sales_advisory_current_for_actor(uuid,uuid,uuid,uuid,uuid,uuid) to novalure_tenant_app;
 grant execute on function crm_lock_project_access(uuid,uuid,boolean) to novalure_website_sales_advisory_access_owner;
 grant execute on function crm_website_sales_advisory_buyer_access(text,uuid,uuid,uuid),crm_website_sales_advisory_buyer_command(text,uuid,uuid,uuid,jsonb,boolean) to novalure_tenant_app;
 grant execute on function crm_website_sales_advisory_record_current(uuid,integer) to novalure_website_sales_advisory_executor;
 if had_previous then execute format('grant novalure_website_sales_advisory_access_owner to %I with admin %s,inherit %s,set %s',current_user,case when previous_membership.admin_option then 'true' else 'false' end,case when previous_membership.inherit_option then 'true' else 'false' end,case when previous_membership.set_option then 'true' else 'false' end);
 else execute format('revoke novalure_website_sales_advisory_access_owner from %I',current_user);end if;
end $$;
commit;
