-- Internal Sales enablement. No active grant, business claim, external effect or price rule is seeded.
begin;
set local lock_timeout='5s';
set local statement_timeout='2min';

-- Binary artifacts remain bounded. The historical limit is retained for unbound legacy artifacts.
alter table crm_website_studio_artifacts drop constraint crm_website_studio_artifacts_artifact_check;
alter table crm_website_studio_artifacts add constraint crm_website_studio_artifacts_artifact_check check(jsonb_typeof(artifact)='object' and
 (octet_length(artifact::text)<=250000 or (octet_length(artifact::text)<=1500000 and
  (jsonb_typeof(artifact->'content'->'demoProfile')='object' or jsonb_typeof(artifact->'content'->'customerBrief')='object' or jsonb_typeof(artifact->'content'->'concept'->'content'->'customerBrief')='object'))));

create table crm_website_sales_enablement (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 version integer not null check(version>0),last_command_id uuid not null,created_by uuid not null,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,workflow_id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,last_command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred
);
create table crm_website_sales_enablement_records (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,enablement_id uuid not null,
 aggregate_version integer not null check(aggregate_version>0),entity_id uuid not null,version integer not null check(version>0),kind text not null,
 workflow_version integer not null check(workflow_version>0),evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=60000),
 record_digest text not null check(record_digest ~ '^[a-f0-9]{64}$'),previous_digest text check(previous_digest ~ '^[a-f0-9]{64}$'),
 source_confidence text not null check(source_confidence in('OPERATOR_RECORDED','SERVER_DERIVED')),
 created_by uuid not null,command_id uuid not null,created_at timestamptz not null default clock_timestamp(),valid_until timestamptz not null,
 unique(workspace_id,id),unique(workspace_id,enablement_id,aggregate_version),unique(workspace_id,enablement_id,entity_id,version),
 unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,enablement_id) references crm_website_sales_enablement(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check((version=1)=(previous_digest is null)),
 check(kind in('BRIEF','CLOSE_PLAN','REFERENCE','REFERENCE_APPROVAL','REFERENCE_REVOCATION','DEMO_PROFILE','CLOSURE_REASON','NEXT_STEP','CARE_BASIS','CARE_PROPOSAL','CARE_OFFER','HYGIENE_SCAN','HYGIENE_ANNOTATION','ASSET_UPLOAD','ASSET_REVOCATION'))
);
create index website_sales_enablement_latest on crm_website_sales_enablement_records(workspace_id,workflow_id,kind,aggregate_version desc);
create table crm_website_sales_enablement_assets (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 version integer not null check(version=1),role text not null check(role in('LOGO','HERO')),title text not null check(length(title) between 1 and 200),alt text not null check(length(alt) between 1 and 500),
 mime text not null check(mime in('image/png','image/jpeg','image/webp')),width integer not null check(width between 1 and 4096),height integer not null check(height between 1 and 4096),
 original_sha256 text not null check(original_sha256 ~ '^[a-f0-9]{64}$'),original_size_bytes integer not null check(original_size_bytes between 1 and 4194304),
 byte_sha256 text not null check(byte_sha256 ~ '^[a-f0-9]{64}$'),bytes_bytea bytea not null check(octet_length(bytes_bytea) between 1 and 262144),
 rights_reference text not null check(length(rights_reference) between 1 and 2000),approved_by uuid not null,approved_at timestamptz not null default clock_timestamp(),valid_until timestamptz not null,
 command_id uuid not null,unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,approved_by) references workspace_users(workspace_id,id),foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check(encode(sha256(bytes_bytea),'hex')=byte_sha256),check(valid_until>approved_at)
);

create function crm_website_sales_enablement_update_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if (new.id,new.workspace_id,new.project_id,new.company_id,new.location_id,new.workflow_id,new.created_by,new.created_at)
 is distinct from(old.id,old.workspace_id,old.project_id,old.company_id,old.location_id,old.workflow_id,old.created_by,old.created_at)
 or new.version<>old.version+1 then raise exception using errcode='23514',message='Enablement scope is immutable and version must advance';end if;
 return new;
end $$;
revoke all on function crm_website_sales_enablement_update_guard() from public;
create trigger website_sales_enablement_version before update on crm_website_sales_enablement for each row execute function crm_website_sales_enablement_update_guard();
create trigger website_sales_enablement_no_delete before delete or truncate on crm_website_sales_enablement for each statement execute function crm_reject_immutable_mutation();
do $$ declare relation text;begin
 foreach relation in array array['crm_website_sales_enablement','crm_website_sales_enablement_records','crm_website_sales_enablement_assets'] loop
  execute format('alter table %I add column data_classification text not null default ''UNCLASSIFIED'',add column data_purpose text not null default ''crm_sales''',relation);
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('create policy website_sales_enablement_scope on %I for all to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
  execute format('revoke all on %I from public',relation);execute format('grant select,insert on %I to novalure_tenant_app',relation);
  if relation<>'crm_website_sales_enablement' then execute format('create trigger website_sales_enablement_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);end if;
 end loop;
end $$;
grant update on crm_website_sales_enablement to novalure_tenant_app;
create policy website_sales_enablement_actor on crm_website_sales_enablement as restrictive for insert to novalure_tenant_app with check(created_by=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy website_sales_enablement_record_actor on crm_website_sales_enablement_records as restrictive for insert to novalure_tenant_app
 with check(created_by=nullif(current_setting('app.actor_id',true),'')::uuid and
  ((kind in('BRIEF','CLOSE_PLAN','REFERENCE','REFERENCE_APPROVAL','REFERENCE_REVOCATION','DEMO_PROFILE','CLOSURE_REASON','CARE_BASIS','HYGIENE_ANNOTATION','ASSET_UPLOAD','ASSET_REVOCATION')
    and source_confidence='OPERATOR_RECORDED' and crm_sales_ops_owner(workspace_id))
   or(kind in('NEXT_STEP','CARE_PROPOSAL','CARE_OFFER','HYGIENE_SCAN') and source_confidence='SERVER_DERIVED')));
create policy website_sales_enablement_asset_owner on crm_website_sales_enablement_assets as restrictive for insert to novalure_tenant_app
 with check(approved_by=nullif(current_setting('app.actor_id',true),'')::uuid and crm_sales_ops_owner(workspace_id));

-- Additional exact Sales machine scopes are admitted separately; no row or registration is activated.
alter table crm_website_sales_machine_grants drop constraint crm_website_sales_machine_grants_scopes_check;
alter table crm_website_sales_machine_grants add constraint crm_website_sales_machine_grants_scopes_check check(cardinality(scopes)>0 and scopes <@ array['crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile','crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo','crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff','crm.website-sales.autonomy.read','crm.website-sales.autonomy.plan-portfolio','crm.website-sales.autonomy.claim-allocation','crm.website-sales.autonomy.settle-allocation','crm.website-sales.autonomy.propose-price','crm.website-sales.autonomy.apply-quote','crm.website-sales.autonomy.record-outcome','crm.website-sales.autonomy.propose-improvement','crm.website-sales.autonomy.promote-improvement','crm.website-sales.conversation.read','crm.website-sales.conversation.record-topic','crm.website-sales.conversation.draft-answer','crm.website-sales.conversation.advance-conversation','crm.website-sales.conversation.stop-conversation','crm.website-sales.enablement.read','crm.website-sales.enablement.propose-next-step','crm.website-sales.enablement.propose-care','crm.website-sales.enablement.prepare-care-offer','crm.website-sales.enablement.scan-hygiene']::text[]);
alter table crm_website_sales_machine_events drop constraint crm_website_sales_machine_events_action_check;
alter table crm_website_sales_machine_events add constraint crm_website_sales_machine_events_action_check check(action in('crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile','crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo','crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff','crm.website-sales.autonomy.read','crm.website-sales.autonomy.plan-portfolio','crm.website-sales.autonomy.claim-allocation','crm.website-sales.autonomy.settle-allocation','crm.website-sales.autonomy.propose-price','crm.website-sales.autonomy.apply-quote','crm.website-sales.autonomy.record-outcome','crm.website-sales.autonomy.propose-improvement','crm.website-sales.autonomy.promote-improvement','crm.website-sales.conversation.read','crm.website-sales.conversation.record-topic','crm.website-sales.conversation.draft-answer','crm.website-sales.conversation.advance-conversation','crm.website-sales.conversation.stop-conversation','crm.website-sales.enablement.read','crm.website-sales.enablement.propose-next-step','crm.website-sales.enablement.propose-care','crm.website-sales.enablement.prepare-care-offer','crm.website-sales.enablement.scan-hygiene'));


-- Used only inside the existing signed preview capability lookup, never as a public business reader.
create function public.crm_website_sales_demo_profile_current(p_artifact jsonb) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp set row_security=off as $guard$
declare ident jsonb:=p_artifact->'identity'; profile jsonb:=p_artifact->'content'->'demoProfile';
 brief jsonb:=coalesce(p_artifact->'content'->'customerBrief',p_artifact->'content'->'concept'->'content'->'customerBrief');
 bound jsonb; entry jsonb; r public.crm_website_sales_enablement_records%rowtype; review public.crm_website_sales_enablement_records%rowtype;
 asset public.crm_website_sales_enablement_assets%rowtype; source jsonb;
begin
 if (profile is null or profile='null'::jsonb) and(brief is null or brief='null'::jsonb) then return true;end if;
 if jsonb_typeof(ident) is distinct from 'object' then return false;end if;
 if profile is not null and profile<>'null'::jsonb and
  (jsonb_typeof(profile) is distinct from 'object' or jsonb_typeof(profile->'profile') is distinct from 'object'
   or jsonb_typeof(profile->'references') is distinct from 'array' or jsonb_typeof(profile->'assets') is distinct from 'array') then return false;end if;
 if profile is not null and profile<>'null'::jsonb and
  (coalesce((select jsonb_agg(value order by value) from jsonb_array_elements(profile->'profile'->'payload'->'referenceCaseIds')), '[]')
   is distinct from coalesce((select jsonb_agg(value->'record'->'id' order by value->'record'->'id') from jsonb_array_elements(profile->'references')), '[]')
   or coalesce((select jsonb_agg(value order by value) from jsonb_array_elements(profile->'profile'->'payload'->'assetIds')), '[]')
   is distinct from coalesce((select jsonb_agg(value->'assetId' order by value->'assetId') from jsonb_array_elements(profile->'assets')), '[]')) then return false;end if;
 foreach bound in array array[profile->'profile',brief] loop
  if bound is null or bound='null'::jsonb then continue;end if;
  select * into r from public.crm_website_sales_enablement_records x
   where x.workspace_id=(ident->>'workspaceId')::uuid and x.project_id=(ident->>'projectId')::uuid and x.company_id=(ident->>'companyId')::uuid and x.location_id=(ident->>'locationId')::uuid
   and x.entity_id=(bound->>'id')::uuid and x.kind=case when bound=brief then 'BRIEF' else 'DEMO_PROFILE' end order by x.version desc limit 1;
  if not found or r.version<>(bound->>'version')::integer or r.record_digest is distinct from bound->>'digest' or r.payload is distinct from bound->'payload' or bound->'identity' is distinct from ident or r.valid_until<=clock_timestamp() then return false;end if;
  for source in select value from jsonb_array_elements(r.payload->'sourceReferences') loop
   if (source->>'validUntil')::timestamptz<=clock_timestamp() or(source->>'observedAt')::timestamptz>clock_timestamp() then return false;end if;
  end loop;
 end loop;
 if profile is not null and profile<>'null'::jsonb then
  for entry in select value from jsonb_array_elements(profile->'references') loop
   bound:=entry->'record';
   select * into r from public.crm_website_sales_enablement_records x where x.workspace_id=(ident->>'workspaceId')::uuid and x.project_id=(ident->>'projectId')::uuid and x.company_id=(ident->>'companyId')::uuid and x.location_id=(ident->>'locationId')::uuid and x.entity_id=(bound->>'id')::uuid and x.kind='REFERENCE' order by x.version desc limit 1;
   if not found or r.version<>(bound->>'version')::integer or r.record_digest is distinct from bound->>'digest' or r.payload is distinct from bound->'payload' or bound->'identity' is distinct from ident or r.valid_until<=clock_timestamp() or r.payload->>'disclosure'<>'APPROVED_CUSTOMER_PRESENTATION' then return false;end if;
   for source in select value from jsonb_array_elements(r.payload->'sourceReferences') union all select sv.value from jsonb_array_elements(r.payload->'claims') claims cross join lateral jsonb_array_elements(claims.value->'sourceReferences') sv loop
    if (source->>'validUntil')::timestamptz<=clock_timestamp() or(source->>'observedAt')::timestamptz>clock_timestamp() then return false;end if;
   end loop;
   select * into review from public.crm_website_sales_enablement_records x where x.workspace_id=r.workspace_id and x.workflow_id=r.workflow_id and x.kind='REFERENCE_APPROVAL' and x.payload->>'referenceId'=r.entity_id::text and x.payload->>'approvalId'=entry->'review'->>'approvalId' order by x.aggregate_version desc limit 1;
   if not found or review.payload->>'referenceDigest' is distinct from r.record_digest or(review.payload->>'referenceVersion')::integer<>r.version or(review.payload->>'validUntil')::timestamptz<=clock_timestamp() or(review.payload->>'approvedAt')::timestamptz>clock_timestamp() then return false;end if;
   if exists(select 1 from public.crm_website_sales_enablement_records x where x.workspace_id=r.workspace_id and x.workflow_id=r.workflow_id and x.kind='REFERENCE_REVOCATION' and x.payload->>'referenceId'=r.entity_id::text and x.aggregate_version>review.aggregate_version) then return false;end if;
  end loop;
  for entry in select value from jsonb_array_elements(profile->'assets') loop
   select * into asset from public.crm_website_sales_enablement_assets x where x.workspace_id=(ident->>'workspaceId')::uuid and x.project_id=(ident->>'projectId')::uuid and x.company_id=(ident->>'companyId')::uuid and x.location_id=(ident->>'locationId')::uuid and x.id=(entry->>'assetId')::uuid;
   if not found or asset.version<>(entry->>'version')::integer or entry->'identity' is distinct from ident or asset.byte_sha256 is distinct from entry->>'sha256' or asset.valid_until<=clock_timestamp() then return false;end if;
   if exists(select 1 from public.crm_website_sales_enablement_records x where x.workspace_id=asset.workspace_id and x.workflow_id=asset.workflow_id and x.kind='ASSET_REVOCATION' and x.payload->>'assetId'=asset.id::text) then return false;end if;
  end loop;
 end if;
 return true;
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then return false;
end $guard$;
revoke all on function public.crm_website_sales_demo_profile_current(jsonb) from public;

create or replace function crm_website_studio_preview_access(p_grant uuid,p_hash text,p_exchange boolean,p_cookie_hash text default null)
returns table(artifact jsonb,prospect jsonb,certificate jsonb,builder_id uuid,workflow_id uuid,expires_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp set row_security=off as $$
declare g public.crm_website_studio_preview_grants%rowtype;
begin
 if p_hash !~ '^[0-9a-f]{64}$' or (p_exchange and (p_cookie_hash is null or p_cookie_hash !~ '^[0-9a-f]{64}$')) then return; end if;
 select * into g from public.crm_website_studio_preview_grants where id=p_grant for update;
 if not found or g.revoked_at is not null or g.expires_at<=clock_timestamp()
  or (p_exchange and (g.invitation_hash<>p_hash or g.exchanged_at is not null))
  or (not p_exchange and (g.cookie_hash is null or g.cookie_hash<>p_hash)) then return; end if;
 return query select a.artifact,o.prospect,q.certificate,a.created_by,w.id,g.expires_at
 from public.crm_website_studio_artifacts a
 join public.crm_website_sales_workflows w on w.workspace_id=g.workspace_id and w.id=g.workflow_id and w.project_id=g.project_id and w.company_id=g.company_id and w.location_id=g.location_id
 join public.crm_company_locations l on l.workspace_id=w.workspace_id and l.id=w.location_id and l.version=w.location_version
 join public.crm_website_sales_observations o on o.workspace_id=w.workspace_id and o.id=w.observation_id
 join public.crm_website_studio_qa q on q.workspace_id=g.workspace_id and q.id=g.qa_id and q.artifact_id=a.id
 join public.contacts c on c.workspace_id=g.workspace_id and c.id=g.contact_id and c.project_id=g.project_id and c.organization_id=g.company_id
 join public.projects p on p.workspace_id=g.workspace_id and p.id=g.project_id and p.division='WEB_DESIGN'
 join public.workspaces ws on ws.id=g.workspace_id and ws.operating_model='novalure_internal'
 where a.workspace_id=g.workspace_id and a.id=g.artifact_id and a.workflow_id=w.id and a.project_id=g.project_id and a.company_id=g.company_id and a.location_id=g.location_id
 and a.kind='DEMO' and a.valid_until>clock_timestamp() and o.valid_until>clock_timestamp() and q.expires_at>clock_timestamp()
 and a.evidence_digest=o.evidence_digest and w.status in('QUALIFIED','OFFER_DRAFT') and w.contact_id=g.contact_id
 and exists(select 1 from public.crm_website_studio_artifacts concept
   join public.crm_website_studio_artifacts diagnosis on diagnosis.workspace_id=concept.workspace_id and diagnosis.workflow_id=concept.workflow_id and diagnosis.kind='DIAGNOSIS' and diagnosis.artifact_digest=concept.artifact->>'parentArtifactDigest'
   join public.crm_website_studio_acceptances accepted on accepted.workspace_id=concept.workspace_id and accepted.artifact_id=concept.id and accepted.id=(a.artifact->'content'->>'acceptanceId')::uuid
   where concept.workspace_id=a.workspace_id and concept.workflow_id=a.workflow_id and concept.kind='CONCEPT' and concept.artifact_digest=a.artifact->>'parentArtifactDigest'
   and not exists(select 1 from public.crm_website_studio_artifacts newer where newer.workspace_id=a.workspace_id and newer.workflow_id=a.workflow_id and ((newer.kind='DEMO' and newer.version>a.version) or (newer.kind='CONCEPT' and newer.version>concept.version) or (newer.kind='DIAGNOSIS' and newer.version>diagnosis.version))))
 and c.archived_at is null and coalesce(c.consent_label,'') !~* '(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)'
 and a.data_classification='NOVALURE_INTERNAL' and w.data_classification='NOVALURE_INTERNAL' and o.data_classification='NOVALURE_INTERNAL' and c.data_classification='NOVALURE_INTERNAL'
 and not exists(select 1 from public.crm_website_sales_workflows sw where sw.workspace_id=g.workspace_id and sw.contact_id=g.contact_id and sw.status='STOPPED' and sw.stop_reason in('OPT_OUT','REPLY_RECEIVED','UNKNOWN_DELIVERY'))
 and not exists(select 1 from public.consent_records cr where cr.workspace_id=g.workspace_id and cr.contact_id=g.contact_id and cr.status ~* '(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)')
 and not exists(select 1 from public.newsletter_suppressions ns where ns.workspace_id=g.workspace_id and lower(ns.email)=lower(c.email))
 and not exists(select 1 from public.conversations cv where cv.workspace_id=g.workspace_id and cv.project_id=g.project_id and cv.contact_id=g.contact_id and lower(cv.direction) in('inbound','incoming','eingehend') and cv.last_message_at>=w.created_at)
 and public.crm_website_sales_demo_profile_current(a.artifact);
 if found and p_exchange then
  update public.crm_website_studio_preview_grants set cookie_hash=p_cookie_hash,exchanged_at=clock_timestamp() where id=g.id;
 end if;
end $$;
revoke all on function crm_website_studio_preview_access(uuid,text,boolean,text) from public;
grant execute on function crm_website_studio_preview_access(uuid,text,boolean,text) to novalure_tenant_app;

commit;
