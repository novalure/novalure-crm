-- Immutable source-bound studio artifacts. No publication, delivery, provider or spend authority.
set local lock_timeout='5s';
set local statement_timeout='14min';
create unique index crm_website_studio_workflow_scope on crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id);
create table crm_website_studio_artifacts (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid not null,
 company_id uuid not null, location_id uuid not null, workflow_id uuid not null,
 kind text not null check(kind in('DIAGNOSIS','CONCEPT','DEMO')), version integer not null check(version>0),
 artifact_digest text not null check(artifact_digest ~ '^[0-9a-f]{64}$'), evidence_digest text not null check(evidence_digest ~ '^[0-9a-f]{64}$'),
 artifact jsonb not null check(jsonb_typeof(artifact)='object' and octet_length(artifact::text)<=250000),
 created_by uuid not null, created_at timestamptz not null default now(), valid_until timestamptz not null,
 unique(workspace_id,id), unique(workspace_id,workflow_id,kind,version), unique(workspace_id,workflow_id,artifact_digest),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 check(artifact->>'kind'=kind and (artifact->>'version')::integer=version and artifact->>'artifactDigest'=artifact_digest and artifact->>'evidenceDigest'=evidence_digest),
 check(valid_until>created_at)
);
create table crm_website_studio_acceptances (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid not null,
 artifact_id uuid not null, accepted_by uuid not null, accepted_at timestamptz not null default now(),
 unique(workspace_id,artifact_id), foreign key(workspace_id,artifact_id) references crm_website_studio_artifacts(workspace_id,id),
 foreign key(workspace_id,accepted_by) references workspace_users(workspace_id,id)
);
create table crm_website_studio_qa (
 id uuid primary key, workspace_id uuid not null, project_id uuid not null, artifact_id uuid not null,
 qa_actor_id uuid not null, certificate jsonb not null check(jsonb_typeof(certificate)='object' and octet_length(certificate::text)<16000),
 checked_at timestamptz not null, expires_at timestamptz not null, created_at timestamptz not null default now(),
 unique(workspace_id,id), foreign key(workspace_id,artifact_id) references crm_website_studio_artifacts(workspace_id,id),
 foreign key(workspace_id,qa_actor_id) references workspace_users(workspace_id,id), check(expires_at>checked_at)
);
create table crm_website_studio_preview_grants (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid not null,
 company_id uuid not null, location_id uuid not null, workflow_id uuid not null, artifact_id uuid not null,
 qa_id uuid not null, contact_id uuid not null, invitation_hash text not null check(invitation_hash ~ '^[0-9a-f]{64}$'),
 cookie_hash text check(cookie_hash ~ '^[0-9a-f]{64}$'), exchanged_at timestamptz,
 expires_at timestamptz not null, created_by uuid not null, created_at timestamptz not null default now(),
 revoked_at timestamptz, revoked_by uuid, version integer not null default 1 check(version>0),
 unique(workspace_id,id), foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,artifact_id) references crm_website_studio_artifacts(workspace_id,id),
 foreign key(workspace_id,qa_id) references crm_website_studio_qa(workspace_id,id),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,revoked_by) references workspace_users(workspace_id,id),
 check(expires_at>created_at and expires_at<=created_at+interval '24 hours'),
 check((cookie_hash is null)=(exchanged_at is null)), check((revoked_at is null)=(revoked_by is null))
);
create index crm_website_studio_artifact_scope on crm_website_studio_artifacts(workspace_id,project_id,workflow_id,kind,version desc);
create index crm_website_studio_qa_artifact on crm_website_studio_qa(workspace_id,artifact_id,expires_at desc);
create index crm_website_studio_preview_scope on crm_website_studio_preview_grants(workspace_id,project_id,workflow_id,created_at desc);
do $$ declare relation text; begin
 foreach relation in array array['crm_website_studio_artifacts','crm_website_studio_acceptances','crm_website_studio_qa','crm_website_studio_preview_grants'] loop
  execute format('alter table %I add column data_classification text not null default ''UNCLASSIFIED'',add column data_purpose text not null default ''crm_sales''',relation);
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('alter table %I enable row level security',relation);
  execute format('alter table %I force row level security',relation);
  execute format('create policy website_studio_scope on %I for all to novalure_tenant_app using (workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check (workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
  execute format('revoke all on %I from public',relation);
  execute format('grant select,insert on %I to novalure_tenant_app',relation);
 end loop;
 foreach relation in array array['crm_website_studio_artifacts','crm_website_studio_acceptances','crm_website_studio_qa'] loop
  execute format('create trigger website_studio_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);
 end loop;
end $$;
-- Runtime may revoke a grant, never change its recipient, artifact, invitation, cookie or expiry.
grant update(revoked_at,revoked_by,version) on crm_website_studio_preview_grants to novalure_tenant_app;
create function crm_website_studio_grant_guard() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
 if current_user='novalure_tenant_app' and (new.revoked_at is null or old.revoked_at is not null or new.revoked_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or new.version<>old.version+1
  or (to_jsonb(new)-array['revoked_at','revoked_by','version']) is distinct from (to_jsonb(old)-array['revoked_at','revoked_by','version']))
 then raise exception using errcode='42501',message='Preview grant may only be revoked once'; end if;
 return new;
end $$;
create trigger website_studio_grant_guard before update on crm_website_studio_preview_grants for each row execute function crm_website_studio_grant_guard();
-- Narrow public capability lookup. No generic business SELECT privilege is granted.
-- A returned artifact remains untrusted until host signature+deterministic renderer verification.
create function crm_website_studio_preview_access(p_grant uuid,p_hash text,p_exchange boolean,p_cookie_hash text default null)
returns table(artifact jsonb,prospect jsonb,certificate jsonb,builder_id uuid,expires_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp set row_security=off as $$
declare g public.crm_website_studio_preview_grants%rowtype;
begin
 if p_hash !~ '^[0-9a-f]{64}$' or (p_exchange and (p_cookie_hash is null or p_cookie_hash !~ '^[0-9a-f]{64}$')) then return; end if;
 select * into g from public.crm_website_studio_preview_grants where id=p_grant for update;
 if not found or g.revoked_at is not null or g.expires_at<=clock_timestamp()
  or (p_exchange and (g.invitation_hash<>p_hash or g.exchanged_at is not null))
  or (not p_exchange and (g.cookie_hash is null or g.cookie_hash<>p_hash)) then return; end if;
 return query select a.artifact,o.prospect,q.certificate,a.created_by,g.expires_at
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
 and not exists(select 1 from public.conversations cv where cv.workspace_id=g.workspace_id and cv.project_id=g.project_id and cv.contact_id=g.contact_id and lower(cv.direction) in('inbound','incoming','eingehend') and cv.last_message_at>=w.created_at);
 if found and p_exchange then
  update public.crm_website_studio_preview_grants set cookie_hash=p_cookie_hash,exchanged_at=clock_timestamp() where id=g.id;
 end if;
end $$;
revoke all on function crm_website_studio_preview_access(uuid,text,boolean,text) from public;
grant execute on function crm_website_studio_preview_access(uuid,text,boolean,text) to novalure_tenant_app;
