create table lead_qualification_preferences(
 workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,purchase_from date,purchase_to date,feature_rules jsonb not null default '{}',requirements_reviewed boolean not null default false,
 version integer not null default 1,updated_by uuid not null,updated_at timestamptz not null default now(),data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',primary key(workspace_id,lead_id),
 check((purchase_from is null and purchase_to is null) or (purchase_from is not null and purchase_to is not null and purchase_from<=purchase_to and purchase_from>='2000-01-01' and purchase_to<'2100-01-01')),
 check(jsonb_typeof(feature_rules)='object' and octet_length(feature_rules::text)<=500),foreign key(workspace_id,project_id,lead_id) references leads(workspace_id,project_id,id),foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create unique index if not exists contact_timeline_workspace_id_idx on contact_timeline_items(workspace_id,id);
create table lead_qualification_note_proposals(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,note_id uuid not null,note_hash text not null,profile_revision text not null,
 proposed_fields jsonb not null,evidence jsonb not null,warnings jsonb not null,created_by uuid not null,created_at timestamptz not null default now(),status text not null default 'pending' check(status in('pending','applied','rejected')),review_reason text,reviewed_by uuid,reviewed_at timestamptz,selected_fields jsonb,version integer not null default 1,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',unique(workspace_id,id),foreign key(workspace_id,project_id,lead_id) references leads(workspace_id,project_id,id),foreign key(workspace_id,note_id) references contact_timeline_items(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,reviewed_by) references workspace_users(workspace_id,id),check(note_hash~'^[a-f0-9]{64}$' and profile_revision~'^[a-f0-9]{64}$')
);
create table lead_match_outreach_links(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,lead_id uuid not null,match_id uuid not null,match_version integer not null,property_id uuid not null,expose_link_id uuid not null,created_by uuid not null,created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',unique(workspace_id,expose_link_id),foreign key(workspace_id,project_id,lead_id) references leads(workspace_id,project_id,id),foreign key(workspace_id,match_id) references lead_property_matches(workspace_id,id),foreign key(workspace_id,expose_link_id) references web_expose_links(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create function crm_lead_plan_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare k text;rule jsonb;begin
 if not crm_lead_qualification_access(new.workspace_id,new.project_id,new.lead_id,true) then raise exception using errcode='42501',message='Lead plan access denied';end if;
 if tg_table_name='lead_qualification_preferences' then
  if tg_op='UPDATE' and ((new.workspace_id,new.project_id,new.lead_id) is distinct from (old.workspace_id,old.project_id,old.lead_id) or new.version<>old.version+1) then raise exception using errcode='23514',message='Versioned preferences required';end if;
  if new.updated_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='42501',message='Actual plan actor required';end if;
  for k,rule in select * from jsonb_each(new.feature_rules) loop if k not in('balcony','terrace','garden','garage','cellar') or rule not in('"must"'::jsonb,'"exclude"'::jsonb) then raise exception using errcode='23514',message='Only supported objective property features allowed';end if;end loop;
 elsif tg_table_name='lead_qualification_note_proposals' then
  if tg_op='INSERT' then
   if jsonb_typeof(new.proposed_fields) is distinct from 'object' or octet_length(new.proposed_fields::text)>20000 or jsonb_typeof(new.evidence) is distinct from 'array' or jsonb_typeof(new.warnings) is distinct from 'array' or exists(select 1 from jsonb_object_keys(new.proposed_fields) field where field not in('budgetFromCents','budgetToCents','countryCode','location','propertyType','purchaseWindow','featureRules')) then raise exception using errcode='23514',message='Only supported structured proposal fields allowed';end if;
   if new.status<>'pending' or new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not exists(select 1 from contact_timeline_items t join leads l on l.workspace_id=t.workspace_id and l.contact_id=t.contact_id where l.id=new.lead_id and l.workspace_id=new.workspace_id and (t.project_id=new.project_id or t.project_id is null) and t.id=new.note_id and t.channel='Notiz' and (t.metadata->>'leadId'=l.id::text or nullif(t.metadata->>'leadId','') is null)) then raise exception using errcode='23514',message='Scoped saved CRM note and pending proposal required';end if;
  elsif old.status<>'pending' or new.status not in('applied','rejected') or new.version<>old.version+1 or new.reviewed_at is null or new.reviewed_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or length(coalesce(new.review_reason,''))<10 or (to_jsonb(new)-array['status','review_reason','reviewed_by','reviewed_at','selected_fields','version']) is distinct from (to_jsonb(old)-array['status','review_reason','reviewed_by','reviewed_at','selected_fields','version']) then raise exception using errcode='23514',message='Explicit documented proposal review required';end if;
 else
  if new.created_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not exists(select 1 from lead_property_matches m join web_expose_links l on l.workspace_id=m.workspace_id and l.id=new.expose_link_id join web_expose_versions v on v.workspace_id=l.workspace_id and v.id=l.version_id where m.workspace_id=new.workspace_id and m.id=new.match_id and m.version=new.match_version and m.lead_id=new.lead_id and m.project_id=new.project_id and m.property_id=new.property_id and m.eligible and m.score>=80 and v.property_id=m.property_id and l.intended_lead_id=m.lead_id and l.revoked_at is null and v.active) then raise exception using errcode='23514',message='Actual eligible match and bound reviewed publication required';end if;
 end if;return new;
end $$;
do $$ declare t text;begin foreach t in array array['lead_qualification_preferences','lead_qualification_note_proposals','lead_match_outreach_links'] loop
 execute format('alter table %I enable row level security',t);execute format('alter table %I force row level security',t);
 execute format('create trigger sales_classification before insert or update on %I for each row execute function crm_set_sales_classification()',t);
 execute format('create trigger lead_plan_guard before insert or update on %I for each row execute function crm_lead_plan_guard()',t);
 execute format('create policy lead_plan_scope on %I to novalure_tenant_app using(crm_lead_qualification_access(workspace_id,project_id,lead_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_lead_qualification_access(workspace_id,project_id,lead_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose))',t);
 execute format('revoke all on %I from public,novalure_app',t);execute format('grant select,insert on %I to novalure_tenant_app',t);
end loop;end $$;
grant update on lead_qualification_preferences,lead_qualification_note_proposals to novalure_tenant_app;
create trigger lead_match_outreach_immutable before update or delete or truncate on lead_match_outreach_links for each statement execute function crm_reject_immutable_mutation();
create function crm_lead_plan_refresh() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin update buyer_search_profiles set updated_at=clock_timestamp() where workspace_id=new.workspace_id and buyer_lead_id=new.lead_id;return new;end $$;
create trigger lead_plan_refresh after insert or update on lead_qualification_preferences for each row execute function crm_lead_plan_refresh();
revoke all on function crm_lead_plan_guard(),crm_lead_plan_refresh() from public;
